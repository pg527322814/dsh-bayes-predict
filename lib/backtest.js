// dsh-bayes-predict / lib/backtest.js
// 参数化回测引擎（严格防前视）：对股票池逐换仓日用 bayes.js 现场计算评分（只用到当日为止的数据），
// 按评分门槛与持有个数选股、等分资金模拟换仓，支持大盘择时叠加。
// 数据通过注入的 provider { getKlines(code), universe, getIndexKlines() } 提供。
import {
  computeIndicators, signalDirectionsAt,
  buildEvidence, bayesianUpdate, timeWeights,
  MODEL_VERSION,
} from "./bayes.js";

const DEFAULT = {
  horizon: 5,        // 评分窗口（交易日）——指"未来 N 日上涨"
  warmHorizons: [],  // 同时评分并缓存的其他 horizon（如 [2, 5, 10, 20]；共享指标/信号计算）
  step: 5,           // 每期持有交易日数（换仓网格步长）
  topN: 10,          // 同时持有个数（资金等分 topN 份）
  threshold: 0,      // 评分门槛下限：score > threshold 才买入
  maxScore: null,    // 评分门槛上限：score <= maxScore 才买入（null=不限）
  selectMode: "top", // 选股方向："top" 选评分最高 TopN；"bottom" 选评分最低 TopN（反向策略研究）
  initial: 1000000,  // 初始资金
  startDate: "2024-01-01",
  endDate: null,     // 默认取数据最后交易日
  maxLr: 4,
  temperature: 3,
  halfLife: 200,
  priorStrength: 30,
  sampleWindow: 120,
  warmup: 71,
  lrPriorStrength: 80,
  marketTiming: false,
  timingRule: "R0",  // R0 无
  // ---- 新增可选条件 ----
  excludeST: false,        // 排除 ST/*ST
  minPrice: null,          // 价格下限（元）
  maxPrice: null,          // 价格上限（元）
  minMktcap: null,         // 市值下限（亿元；默认按换仓日历史推算市值过滤，见 marketCapAt）
  historicalCap: true,     // false 时用 universe.json 当前市值快照过滤（研究对比，含前视偏差）
  minListDays: null,       // 排除上市不满 N 天的新股
  stopLossPct: null,       // 个股止损：持有期内跌破买入价 X% 卖出（如 15 = -15%）
  maxPositionPct: null,    // 单只最大仓位：占总资金百分比（如 20 = 20%）
  maxPerBoard: null,       // 同板块最多同时持有 N 只
  commissionRate: 0,       // 佣金费率（单边，如 0.00025 = 万2.5）
  stampTax: 0,             // 卖出印花税（如 0.0005 = 千0.5）
};

/** 返回 date 之前（含当日）最后一根K线的下标；无则 -1。K线须按日期升序。 */
export function lastIndexOnOrBefore(klines, date) {
  let lo = 0, hi = klines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function closeAt(klines, date) {
  const i = lastIndexOnOrBefore(klines, date);
  return i >= 0 ? klines[i].close : null;
}

/**
 * 历史市值估计（消除前视偏差）：
 *   cap(d) ≈ 当前市值快照 × hfq 收盘价(d) / 快照基准价
 * 后复权价格已含分红送转（除权日无跳变），hfq(d)/基准价 即"考虑送转后的市值倍数"，
 * 因此分红送转不影响推算精度；局限：增发/配股导致股本变化时历史市值被高估。
 * 基准价锚定在市值快照日（universe.generatedAt，provider.snapshotDate），数据延伸后仍与快照对齐；
 * 无快照日时回退到数据最后一日收盘。
 */
function marketCapAt(k, lastCap, date, snapshotDate) {
  if (lastCap == null || !k || !k.length) return null;
  let basePx = snapshotDate ? closeAt(k, snapshotDate) : null;
  if (!(basePx > 0)) basePx = k[k.length - 1].close;
  if (!(basePx > 0)) return null;
  const i = lastIndexOnOrBefore(k, date);
  if (i < 0 || !(k[i].close > 0)) return null;
  return lastCap * (k[i].close / basePx);
}
function maAtIdx(idxC, i, p) {
  if (i < p - 1) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += idxC[k]; return s / p;
}

// ---- 单股在一系列换仓日索引上的评分（复用已缓存指标，防前视）----
/**
 * 多 horizon 评分（共享指标与信号序列，各 horizon 独立维护四格表/先验/更新）。
 * 指标与历史日信号只计算一次（horizon 无关），每个额外 horizon 只增加
 * 涨跌标签、四格表推进与先验/更新——4 个 horizon 约 2~2.5 倍单 horizon 成本，而非 4 倍。
 * cutIdxOf(h) 返回该 horizon 需要计算的换仓日索引（通常只传"缺失日期"的索引——
 * 四格表只推进到最后一个缺失日，部分复用场景不重复扫描全历史）。
 * @param {object} ind computeIndicators 结果
 * @param {object} o 模型参数（warmup/maxLr/temperature/...）
 * @param {number[]} horizons 需要评分的窗口列表（如 [5, 10]）
 * @param {(h:number)=>number[]} cutIdxOf 每个 horizon 的换仓日索引（递增）
 * @returns {Map<number, Array<{score, posterior}|null>>} 与各 horizon 的 cut 列表对齐
 */
function scoreSeriesMulti(ind, o, horizons, cutIdxOf) {
  const { maxLr, temperature, warmup, halfLife, priorStrength, sampleWindow, priorLR, lrPriorStrength } = o;
  const closes = ind.closes;
  const n = closes.length;
  const out = new Map();
  if (!horizons.length) return out;
  const maxH = Math.max(...horizons);

  // 共享：全部历史日的信号（一次 O(n)；信号与 horizon 无关）
  const sigAt = new Array(n).fill(null);
  for (let k = warmup; k <= n - maxH - 1; k++) sigAt[k] = signalDirectionsAt(ind, k, o);

  for (const h of horizons) {
    const cutIdxs = cutIdxOf(h);
    if (!cutIdxs.length) { out.set(h, []); continue; }
    // 涨跌标签（每 horizon 一次 O(n)）：未来 h 日上涨
    const upAt = new Array(n).fill(null);
    for (let k = warmup; k <= n - h - 1; k++) upAt[k] = closes[k + h] > closes[k];

    // 增量四格表（时间衰减全局缩放）
    const lambda = Math.LN2 / halfLife;
    const stats = new Map();
    const touch = (key) => {
      let s = stats.get(key);
      if (!s) { s = { nUp: 0, nDown: 0, bullUp: 0, bullDown: 0, bearUp: 0, bearDown: 0 }; stats.set(key, s); }
      return s;
    };
    const buildLRMap = () => {
      const map = new Map();
      const shrinkK = 20;
      const shrink = (lr, m) => (Number.isFinite(lr) && m > 0) ? 1 + (lr - 1) * (m / (m + shrinkK)) : 1;
      const mix = (lr, key, m, which) => {
        if (!priorLR) return lr;
        const pr = priorLR instanceof Map ? priorLR.get(key) : priorLR[key];
        const prLr = pr ? pr[which] : null;
        if (!Number.isFinite(prLr)) return lr;
        const w = m / (m + (lrPriorStrength ?? 100));
        return w * lr + (1 - w) * prLr;
      };
      for (const [key, s] of stats) {
        const m = s.nUp + s.nDown;
        if (m < 2) continue;
        const pBullUp = (s.bullUp + 1) / (s.nUp + 2);
        const pBullDown = (s.bullDown + 1) / (s.nDown + 2);
        const pBearUp = (s.bearUp + 1) / (s.nUp + 2);
        const pBearDown = (s.bearDown + 1) / (s.nDown + 2);
        map.set(key, {
          lrBull: mix(shrink(pBullDown <= 0 ? Infinity : pBullUp / pBullDown, m), key, m, "lrBull"),
          lrBear: mix(shrink(pBearDown <= 0 ? Infinity : pBearUp / pBearDown, m), key, m, "lrBear"),
          nUp: s.nUp, nDown: s.nDown,
          hit: s.bullUp + s.bullDown + s.bearUp + s.bearDown,
          upRate: s.nUp / m,
        });
      }
      return map;
    };

    // 主循环：从 warmup 推进到每个换仓日
    const res = [];
    let cur = warmup;
    for (const i of cutIdxs) {
      if (i < warmup + h + 2 || i >= n) { res.push(null); continue; }
      // 推进四格表：把 (cur, i-1] 的历史样本累加（含时间衰减）
      for (let t = cur; t < i; t++) {
        if (t >= warmup) {
          const decay = Math.exp(-lambda);
          for (const s of stats.values()) {
            s.nUp *= decay; s.nDown *= decay;
            s.bullUp *= decay; s.bullDown *= decay;
            s.bearUp *= decay; s.bearDown *= decay;
          }
          const lab = upAt[t];
          if (lab != null) {
            for (const { key, direction } of sigAt[t] || []) {
              if (direction === 0) continue;
              const s = touch(key);
              if (lab) { s.nUp += 1; if (direction > 0) s.bullUp += 1; else s.bearUp += 1; }
              else { s.nDown += 1; if (direction > 0) s.bullDown += 1; else s.bearDown += 1; }
            }
          }
        }
      }
      cur = i;
      // 当前日评分
      const lrMap = buildLRMap();
      const signals = signalDirectionsAt(ind, i, o);
      const evidence = buildEvidence(signals, lrMap, maxLr);
      const weights = timeWeights(n, halfLife, i);
      const windowStart = Math.max(0, i - Math.min(sampleWindow, i));
      let wUp = 0, wTot = 0;
      for (let k = windowStart; k + h <= i; k++) {
        wTot += weights[k];
        if (closes[k + h] > closes[k]) wUp += weights[k];
      }
      const prior = wTot > 0 ? (wUp + 0.5 * priorStrength) / (wTot + priorStrength) : 0.5;
      const { posterior } = bayesianUpdate(prior, evidence, { maxLr, temperature });
      res.push({ score: Math.round(posterior * 100), posterior });
    }
    out.set(h, res);
  }
  return out;
}

// ---- 大盘择时信号（idxC 为指数收盘序列，i 为索引）----
function timingWeight(rule, idxC, i) {
  if (i < 0 || idxC[i] == null) return 1;
  const c = idxC[i];
  const m20 = maAtIdx(idxC, i, 20);
  if (rule === "R1") return (m20 != null && c < m20) ? 0 : 1;
  if (rule === "R2") {
    let peak = -Infinity; for (let k = 0; k <= i; k++) if (idxC[k] > peak) peak = idxC[k];
    const dd = (c / peak - 1) * 100;
    return (m20 != null && c < m20 && dd < -3) ? 0 : 1;
  }
  if (rule === "R3") {
    let peak = -Infinity; for (let k = 0; k <= i; k++) if (idxC[k] > peak) peak = idxC[k];
    const dd = (c / peak - 1) * 100;
    return dd < -5 ? 0.5 : 1;
  }
  if (rule === "R4") { const m10 = maAtIdx(idxC, i, 10); return (m10 != null && m20 != null && c < m20 && c < m10) ? 0 : 1; }
  return 1;
}

// ---- 主回测 ----

/**
 * 模型参数指纹：这些参数直接改变评分本身（LR 估计 / 先验 / 温度 / 证据收缩），
 * 变化时缓存必须失效——与 horizon 一起构成评分缓存的有效 key。
 */
function paramsFingerprint(o) {
  return JSON.stringify({
    temperature: o.temperature,
    maxLr: o.maxLr,
    halfLife: o.halfLife,
    priorStrength: o.priorStrength,
    sampleWindow: o.sampleWindow,
    warmup: o.warmup,
    lrPriorStrength: o.lrPriorStrength,
    priorLR: !!o.priorLR,
  });
}

export async function runBacktest(params, data) {
  const o = Object.assign({}, DEFAULT, params);
  const { getKlines, universe } = data;

  // 预加载所有股票K线（provider 可能为 async）
  const klMap = new Map();
  for (const code of universe) {
    try { klMap.set(code, await getKlines(code)); } catch { klMap.set(code, null); }
  }
  const kl = (code) => klMap.get(code);

  // 标签（ST/板块/市值）：provider 提供 getTags(code) 或 tags 对象
  const tagOf = (code) => {
    if (data.getTags && typeof data.getTags === "function") return data.getTags(code) || {};
    if (data.tags) return data.tags[code] || {};
    return {};
  };

  // 参考日历：固定参考股 600519（在 universe 中则优先），否则 universe 第一只长K线股票。
  // 网格始终按"当前数据"的参考日历构造——数据更新后网格自然延伸（修复旧实现
  // "窗口冻结在缓存末日"的问题），再与缓存并集比对判定哪些日期需要重算。
  let refDates = null;
  if (universe.includes("600519")) {
    const k = kl("600519");
    if (k && k.length > 500) refDates = k.map((x) => x.date);
  }
  if (!refDates) {
    for (const code of universe) {
      const k = kl(code);
      if (k && k.length > 500) { refDates = k.map((x) => x.date); break; }
    }
  }
  if (!refDates) throw new Error("股票池缺少完整参考日历（无 >500 根K线的股票）");
  const refEnd = o.endDate || refDates[refDates.length - 1];
  const startI = Math.max(0, refDates.findIndex((d) => d >= o.startDate));
  // 网格相位锚定在参考日历原点（索引 0，即"每 step 个交易日固定取一个"），再按 startDate 过滤：
  // 同一 step 下任意 startDate 共享同一套换仓日，相位不再随 startDate 漂移——
  // 缓存并集因此对"改起始日期"直接可用：改晚 = 网格子集命中（零重算），
  // 改早 = 只补算前段新增日期（真正的逐股部分复用），不会出现"同 step 不同起始日
  // 网格几乎不相交、缓存攒了也白攒"的情况。
  // （行为变化：换仓日从"startDate 起算"变为"日历原点起算后过滤"，具体日期平移 0~step-1 天。）
  const gridDates = [];
  for (let i = 0; i < refDates.length && refDates[i] <= refEnd; i += o.step) {
    if (i >= startI) gridDates.push(refDates[i]);
  }
  if (!gridDates.length) throw new Error("回测区间为空（startDate/endDate 范围内无交易日）");
  const grid = gridDates.map((date) => ({ date }));
  const endDate = o.endDate || gridDates[gridDates.length - 1];

  // 评分缓存加载：模型版本 + 模型参数指纹校验（逐 horizon 独立文件）。
  //  - modelVersion：信号、LR 估计、温度等模型定义变化后旧评分作废，避免新旧模型结果混用；
  //  - paramsFingerprint：temperature/maxLr/先验强度等直接影响评分的参数变化也作废。
  //  数据是否变化不做全局判断（任何一只股票更新就全池重算代价太大）——改为逐股判定（见下），
  //  只有"数据被整体替换"的股票才整段重算；追加/未变的股票直接复用旧行。
  //  warmHorizons：本次运行同时评分并缓存的其他 horizon（共享指标与信号序列，
  //  每多一个 horizon 只增加约 30-40% 成本）——面板切换评分窗口零等待；已热的 horizon 自动跳过。
  const dataStamp = (data.getDataStamp && typeof data.getDataStamp === "function") ? await data.getDataStamp() : null;
  const stampOf = (data.getStamp && typeof data.getStamp === "function") ? (code) => data.getStamp(code) : () => null;
  const horizonsToRun = [o.horizon, ...(o.warmHorizons || [])]
    .filter((h, i, a) => Number.isInteger(h) && h >= 2 && h <= 30 && a.indexOf(h) === i);
  const caches = new Map(); // h -> 通过版本+指纹校验的缓存（null=无效/无）
  for (const h of horizonsToRun) {
    const raw = (data.getScores && typeof data.getScores === "function") ? data.getScores(h) : null;
    caches.set(h, raw && Array.isArray(raw.rebalanceDates) && raw.rebalanceDates.length > 1
      && raw.modelVersion === MODEL_VERSION && raw.paramsFingerprint === paramsFingerprint(o) ? raw : null);
  }

  // 指数数据（择时）
  let idxC = null, idxDates = null;
  if (o.marketTiming) {
    const ik = data.getIndexKlines ? data.getIndexKlines() : null;
    if (!ik || !ik.length) throw new Error("启用大盘择时但无指数数据（getIndexKlines 返回空）");
    idxDates = ik.map((k) => k.date);
    idxC = ik.map((k) => k.close);
  }

  // 逐股缓存有效性（stamps 记录评分时的数据形状与 mtime）：
  //  - mtime 相同 → 数据未变，旧行直接有效；
  //  - mtime 变化但形状严格"追加"（首日相同、条数或末日增长）→ 旧行因果有效
  //    （d 日的分只用 ≤d 的数据，新数据不影响旧日期评分的正确性）；
  //  - 其他（整体替换：换复权口径重写、换数据源、形状回退）→ 该股旧行作废，整段重算并替换。
  const shapeOf = (k) => (k && k.length ? { firstDate: k[0].date, lastDate: k[k.length - 1].date, count: k.length } : null);
  const rowInfoValid = (rec, cur) => {
    if (!rec || !cur) return false;
    if (rec.mtime != null && rec.mtime === cur.mtime) return true;
    return rec.firstDate === cur.firstDate && (rec.count < cur.count || rec.lastDate < cur.lastDate);
  };

  // 每只股票：对每个 horizon——旧行有效且覆盖该换仓日 → 直接查表；缺失日期 → 只算缺失日期
  // （逐股部分复用），旧行保留合并；旧行无效 → 该 horizon 的所有换仓日现算，写回时整段替换。
  // computeIndicators 与历史日信号跨 horizon 共享（scoreSeriesMulti），不重复计算。
  const stocks = [];
  const keepPrev = new Map(); // `${h}:${code}` -> 该股在该 horizon 的旧行是否有效
  for (const code of universe) {
    const k = kl(code);
    if (!k || k.length < 71) continue;
    const shape = shapeOf(k);
    const perH = new Map(); // h -> {scores, missing, rowOk}
    let anyMissing = false;
    for (const h of horizonsToRun) {
      const cached = caches.get(h);
      const row = cached && cached.rows ? cached.rows[code] : null;
      const rec = cached && cached.stamps ? cached.stamps[code] : null;
      const rowOk = rowInfoValid(rec, shape ? { mtime: stampOf(code), ...shape } : null);
      keepPrev.set(`${h}:${code}`, rowOk);
      const scores = new Array(gridDates.length).fill(null);
      if (rowOk && row) {
        gridDates.forEach((d, gi) => {
          const e = row[d];
          if (e && Number.isFinite(e.s)) scores[gi] = { score: e.s, posterior: e.p };
        });
      }
      // 缺失日期判定：跳过"历史不足、永远算不出分"的日期（索引 < warmup+h+2），
      // 否则起始日早于数据窗口的网格会让每只股票每次都带着这些死日期重算（永久 miss）。
      const minScoreIdx = o.warmup + h + 2;
      const missing = [];
      scores.forEach((sc, gi) => {
        if (!sc) {
          const idx = lastIndexOnOrBefore(k, gridDates[gi]);
          if (idx >= minScoreIdx) missing.push({ gi, idx });
        }
      });
      perH.set(h, { scores, missing, rowOk });
      if (missing.length) anyMissing = true;
    }
    if (anyMissing) {
      // 共享指标：一次 computeIndicators 供全部 horizon 使用；
      // 每 horizon 只算自己的缺失日期（四格表只推进到各自最后缺失日，部分复用不扫全历史）
      const ind = computeIndicators(k);
      const need = horizonsToRun.filter((h) => perH.get(h).missing.length > 0);
      const byH = scoreSeriesMulti(ind, o, need, (h) => perH.get(h).missing.map((m) => m.idx));
      for (const h of need) {
        const { scores, missing } = perH.get(h);
        const computed = byH.get(h); // 与 missing 对齐
        missing.forEach((m, i) => { const v = computed[i]; if (v) scores[m.gi] = v; });
      }
    }
    stocks.push({ code, kl: k, perH });
  }
  if (!stocks.length) throw new Error("股票池无可用数据");

  // 计算后合并写回（逐 horizon 独立文件，只增不覆盖）：
  //  - 逐股：旧行有效 → 保留旧行并并入本次新算日期；旧行无效 → 该股整段替换为新算结果；
  //  - 仅当旧缓存模型版本与参数指纹都一致时才合并旧行（任一不一致 → 旧行全部作废、全新写入，
  //    否则新旧参数的结果会混在同一份缓存里被后续请求静默复用——正确性要求）；
  //  - stamps 记录每只股票评分时的数据形状与 mtime，供下次请求逐股判定有效性。
  for (const h of horizonsToRun) {
    const cached = caches.get(h);
    const anyComputed = stocks.some((s) => s.perH.get(h).missing.length > 0);
    if (!anyComputed || !data.saveScores || typeof data.saveScores !== "function") continue;
    try {
      const rows = {};
      const stamps = {};
      for (const s of stocks) {
        const { scores, rowOk } = s.perH.get(h);
        const shape = shapeOf(s.kl);
        stamps[s.code] = { mtime: stampOf(s.code), ...shape };
        const curRow = {};
        scores.forEach((sc, gi) => { if (sc) curRow[gridDates[gi]] = { s: sc.score, p: sc.posterior }; });
        if (rowOk && cached && cached.rows && cached.rows[s.code]) {
          // 旧行有效：保留旧行并并入本次新算日期
          rows[s.code] = { ...cached.rows[s.code], ...curRow };
        } else {
          // 旧行无效/无记录：整段替换
          rows[s.code] = curRow;
        }
      }
      const merged = {
        generatedAt: new Date().toISOString(),
        modelVersion: MODEL_VERSION,
        paramsFingerprint: paramsFingerprint(o),
        dataStamp,
        horizon: h,
        rebalanceDates: [...gridDates],
        universe: stocks.length,
        rows,
        stamps,
      };
      // 合并旧缓存中"本次未触碰"的股票行/日期（版本+参数指纹一致时旧行才可并入）
      if (cached) {
        const dateSet = new Set(gridDates);
        for (const d of cached.rebalanceDates) if (!dateSet.has(d)) merged.rebalanceDates.push(d);
        merged.rebalanceDates.sort();
        for (const [code, prevRow] of Object.entries(cached.rows)) {
          const key = `${h}:${code}`;
          if (keepPrev.has(key) && !keepPrev.get(key)) continue; // 该股旧行本次判定无效 → 丢弃
          const curRow = merged.rows[code];
          if (curRow) {
            for (const [d, v] of Object.entries(prevRow)) if (!(d in curRow)) curRow[d] = v;
          } else {
            merged.rows[code] = prevRow;
          }
        }
        for (const [code, prevStamp] of Object.entries(cached.stamps || {})) {
          if (!merged.stamps[code]) merged.stamps[code] = prevStamp;
        }
      }
      data.saveScores(h, merged);
    } catch { /* 缓存写失败不影响回测 */ }
  }

  // ---- 模拟 ----
  const COMM = o.commissionRate || 0;   // 佣金（单边）
  const STAMP = o.stampTax || 0;        // 卖出印花税
  const stopLoss = o.stopLossPct ? o.stopLossPct / 100 : 0; // 止损幅度（小数）
  let cash = o.initial;
  let positions = []; // {code, shares, buyPrice, buyDate}
  const periods = [];
  let prevWeight = 1;

  // ---- 池基准线：符合条件的股票池"综合指数"（等权，与策略同调仓日买卖）----
  // 池 = 每期"符合条件的股票池"（cands：通过评分门槛与全部筛选条件的全部股票）；
  // 调仓日 D 收盘等权买入 → 下一调仓日 sellDate 收盘卖出，等权平均收益复利；
  // 每期更新候选集。与策略的唯一差异 = 评分排序 + TopN（策略）vs 全候选等权（基准）。
  let benchNav = o.initial;
  const benchNavs = [];

  // 股票上市日索引（排除次新用）：取每只股票K线第一根日期
  const listDate = new Map();
  for (const s of stocks) listDate.set(s.code, s.kl[0]?.date || null);

  for (let g = 0; g < grid.length; g++) {
    const D = grid[g].date;
    const sellDate = grid[g + 1] ? grid[g + 1].date : endDate;

    // 1) 平仓（含止损：持有期内跌破买入价 X% 则提前在触发日卖出）
    let proceeds = 0;
    for (const p of positions) {
      let sellPx = closeAt(kl(p.code), sellDate) ?? p.buyPrice;
      let stopHit = null;
      if (stopLoss > 0) {
        // 检查 D 到 sellDate 之间是否触发止损（用该股K线逐日，防前视：只看已发生的日子）
        const k = kl(p.code);
        if (k) {
          const i0 = lastIndexOnOrBefore(k, p.buyDate); // 买入日索引
          const i1 = lastIndexOnOrBefore(k, sellDate);  // 卖出日索引
          for (let ii = i0 + 1; ii <= i1; ii++) {
            const low = k[ii].low != null ? k[ii].low : k[ii].close;
            if (low <= p.buyPrice * (1 - stopLoss)) { stopHit = k[ii].date; sellPx = p.buyPrice * (1 - stopLoss); break; }
          }
        }
      }
      const gross = p.shares * sellPx;
      proceeds += gross * (1 - COMM - STAMP); // 卖出扣佣金+印花税
      if (stopHit) p.stopDate = stopHit;
    }
    positions = [];
    cash += proceeds;

    // 2) 大盘择时权重（滞后 1 期）
    const weight = prevWeight;

    // 3) 选股（评分 + 新增筛选条件）——只用主 horizon（o.horizon）的评分
    const cands = [];
    const mainScores = s => s.perH.get(o.horizon).scores;
    for (const s of stocks) {
      const sc = mainScores(s)[g];
      if (!sc || !Number.isFinite(sc.score)) continue;
      if (sc.score <= o.threshold) continue; // 评分下限
      if (o.maxScore != null && sc.score > o.maxScore) continue; // 评分上限
      const px = closeAt(s.kl, D);
      if (!px || px <= 0) continue;
      // 价格区间
      if (o.minPrice != null && px < o.minPrice) continue;
      if (o.maxPrice != null && px > o.maxPrice) continue;
      // 排除ST（标签 st）
      if (o.excludeST) { const tg = tagOf(s.code); if (tg.st) continue; }
      // 市值下限：默认用历史推算市值（当前市值快照 × hfq 价格比例，截至换仓日——避免前视偏差）；
      // historicalCap=false 退回快照市值（研究对比用）
      if (o.minMktcap != null) {
        const cap = o.historicalCap === false
          ? tagOf(s.code).mktcapYi
          : marketCapAt(s.kl, tagOf(s.code).mktcapYi, D, data.snapshotDate);
        if (cap == null || cap < o.minMktcap) continue;
      }
      // 排除次新：上市不满 N 天（用K线首日到 D 的自然日天数近似）
      if (o.minListDays != null) {
        const ld = listDate.get(s.code);
        if (!ld) continue;
        const days = Math.round((new Date(D) - new Date(ld)) / 86400000);
        if (days < o.minListDays) continue;
      }
      cands.push({ code: s.code, score: sc.score, posterior: sc.posterior, close: px, tag: tagOf(s.code) });
    }
    // 池基准线：符合条件的股票池"综合指数"（等权），与策略同调仓日买入卖出——
    // 调仓日 D 收盘等权买入当期候选集（通过评分门槛+全部筛选条件的股票），
    // 持有到下一调仓日 sellDate 收盘卖出，等权平均收益复利；每期更新候选集。
    // 无候选的期净值不动。与策略的唯一差异 = 评分排序 + TopN（策略），vs 全候选等权（基准）。
    if (cands.length) {
      let bSum = 0, bN = 0;
      for (const c of cands) {
        const pxEnd = closeAt(kl(c.code), sellDate);
        if (pxEnd != null && pxEnd > 0 && c.close > 0) { bSum += pxEnd / c.close - 1; bN++; }
      }
      if (bN) benchNav *= (1 + bSum / bN);
    }
    benchNavs.push(Math.round(benchNav));
    // 按评分排序：selectMode="top" 降序取前 N（最高分）；"bottom" 升序取前 N（最低分）
    const dir = o.selectMode === "bottom" ? 1 : -1;
    cands.sort((a, b) => (a.score - b.score) * dir || (a.code < b.code ? -1 : 1));
    const top = cands.slice(0, o.topN);

    // 4) 买入（含单只最大仓位 + 板块分散）
    const buys = [];
    let spent = 0;
    const boardCount = new Map(); // 板块 -> 持仓数
    for (const t of top) {
      // 板块分散：同板块最多 maxPerBoard 只
      if (o.maxPerBoard != null) {
        const board = t.tag.market || "";
        if ((boardCount.get(board) || 0) >= o.maxPerBoard) continue;
      }
      // 预算：等分；若设单只最大仓位则取 min(等分, 总资金×maxPositionPct)
      let budget = cash / o.topN * weight;
      if (o.maxPositionPct != null) {
        const cap = o.initial * (o.maxPositionPct / 100);
        budget = Math.min(budget, cap);
      }
      let sh = Math.floor(budget / t.close);
      if (sh <= 0) continue;
      const cost = sh * t.close;
      // 防超支
      if (cash - spent < cost * (1 + COMM)) {
        sh = Math.floor((cash - spent) / (t.close * (1 + COMM)));
        if (sh <= 0) continue;
      }
      const grossCost = sh * t.close;
      const fee = grossCost * COMM;
      spent += grossCost + fee;
      positions.push({ code: t.code, shares: sh, buyPrice: t.close, buyDate: D });
      buys.push({ code: t.code, shares: sh, price: t.close, score: t.score, value: grossCost, fee });
      if (o.maxPerBoard != null) {
        const board = t.tag.market || "";
        boardCount.set(board, (boardCount.get(board) || 0) + 1);
      }
    }
    cash -= spent;
    const posVal = positions.reduce((sum, p) => sum + p.shares * closeAt(kl(p.code), D), 0);
    periods.push({ date: D, sellDate, cash, spent, nBuy: buys.length, buys, equity: cash + posVal, weight });

    // 更新下一期 weight
    if (o.marketTiming && idxC) {
      const idxI = lastIndexOnOrBefore(idxDates.map((d) => ({ date: d })), D);
      prevWeight = idxI >= 0 ? timingWeight(o.timingRule, idxC, idxI) : 1;
    } else {
      prevWeight = 1;
    }
  }

  // ---- 期末平仓 ----
  let finalHold = 0;
  const lastHold = [];
  for (const p of positions) {
    const price = closeAt(kl(p.code), endDate) ?? p.buyPrice;
    finalHold += p.shares * price;
    lastHold.push({ code: p.code, shares: p.shares, price });
  }
  const finalEquity = cash + finalHold;

  // 池基准线已在模拟循环内逐期计算（候选集等权再平衡，复利累积）
  const poolBenchmark = benchNavs.length ? benchNavs : null;
  const poolBenchmarkReturn = benchNavs.length ? benchNavs[benchNavs.length - 1] / o.initial - 1 : null;

  return {
    ok: true,
    params: {
      horizon: o.horizon, step: o.step, topN: o.topN, threshold: o.threshold,
      selectMode: o.selectMode,
      initial: o.initial, startDate: grid[0]?.date, endDate,
      marketTiming: o.marketTiming, timingRule: o.timingRule,
      excludeST: o.excludeST, minPrice: o.minPrice, maxPrice: o.maxPrice,
      minMktcap: o.minMktcap, minListDays: o.minListDays,
      stopLossPct: o.stopLossPct, maxPositionPct: o.maxPositionPct, maxPerBoard: o.maxPerBoard,
      maxScore: o.maxScore, commissionRate: o.commissionRate, stampTax: o.stampTax,
    },
    universeSize: stocks.length,
    periods,
    poolBenchmark,
    poolBenchmarkReturn,
    finalEquity, cash, finalHold, lastHold,
    totalReturn: finalEquity / o.initial - 1,
    absPnL: finalEquity - o.initial,
  };
}

// ---- 单日截面选股（不模拟换仓）----

/**
 * 用回测的同一套条件做"单日截面选股"：只对基准日评分并套用全部筛选条件，
 * 不做换仓模拟、不计算净值曲线——回答"按这些条件，今天该买哪些股票"。
 *
 * 与 runBacktest 的一致性保证：
 *  - 评分复用同一份缓存文件（scores/h<horizon>.json）与同一套模型校验
 *    （MODEL_VERSION + 参数指纹），命中缓存的行直接查表；缺失的基准日
 *    用同一个 scoreSeriesMulti 现场补算——同日期同参数的评分与回测内部逐位一致；
 *  - 筛选条件（评分门槛/价格区间/ST/历史推算市值/次新）与回测选股分支逐条对齐；
 *  - 本次新算的日期写回同一份缓存，之后回测与再次筛选都直接命中。
 *
 * @param {object} params 与 runBacktest 同名参数 + { date, limit, selectMode }
 *   date  基准日（缺省=参考日历最后一个交易日；非交易日自动回退到之前最近交易日）
 *   limit 返回条数上限（默认 100；评分与筛选始终跑全池）
 * @param {object} data buildProvider 的返回值
 */
export async function screenStocks(params, data) {
  const t0 = Date.now();
  const o = Object.assign({}, DEFAULT, params);
  const h = o.horizon;
  if (!Number.isInteger(h) || h < 2 || h > 30) throw new Error("评分窗口 horizon 需为 2-30 的整数");
  const limit = Number.isFinite(o.limit) && o.limit > 0 ? Math.min(Math.floor(o.limit), 5000) : 100;

  const { getKlines, universe } = data;

  // 目标代码表：默认 = 整个股票池；传了 o.codes 就只评分这些代码（自选股等小名单用，
  // 避免为了几十只股票把全池 5000+ 只K线都读一遍）。参考日历仍与回测同源，
  // 保证同一个基准日的评分缓存 key 完全对齐（自选股页算出的分能直接被回测/筛选命中）。
  const targets = Array.isArray(o.codes) && o.codes.length ? o.codes : universe;

  // 预加载目标股票K线（provider 可能为 async）
  const klMap = new Map();
  for (const code of targets) {
    try { klMap.set(code, await getKlines(code)); } catch { klMap.set(code, null); }
  }

  const tagOf = (code) => {
    if (data.getTags && typeof data.getTags === "function") return data.getTags(code) || {};
    if (data.tags) return data.tags[code] || {};
    return {};
  };

  // 参考日历：与回测完全同源（固定参考股 600519 优先，否则首只长K线股票）。
  // 小名单（自选股）里往往没有长历史股，此时按固定参考股顺序单独补读几只——
  // 逐只读文件，不触发全池预加载。
  let refDates = null;
  const longCal = (k) => (k && k.length > 500 ? k.map((x) => x.date) : null);
  if (targets.includes("600519")) refDates = longCal(klMap.get("600519"));
  if (!refDates) {
    for (const code of targets) {
      refDates = longCal(klMap.get(code));
      if (refDates) break;
    }
  }
  if (!refDates) {
    for (const code of ["600519", "000001", "600000"]) {
      if (targets.includes(code)) continue;
      try { refDates = longCal(await getKlines(code)); } catch { refDates = null; }
      if (refDates) break;
    }
  }
  if (!refDates) throw new Error("缺少完整参考日历（无 >500 根K线的股票）");
  const dataLastDate = refDates[refDates.length - 1];
  const want = typeof o.date === "string" && o.date ? o.date : dataLastDate;
  const ti = lastIndexOnOrBefore(refDates.map((d) => ({ date: d })), want);
  if (ti < 0) throw new Error(`基准日期 ${want} 早于参考日历起点 ${refDates[0]}`);
  const date = refDates[ti];

  // 评分缓存：与回测同一份文件、同一套有效性校验。
  // 日期条数放宽到 ≥1：只筛选过、没跑过回测时缓存里可能只有一个基准日，
  // 这种缓存按"逐日期键 + 逐股 stamps"校验后依然是完全可信的（回测侧要求 >1 是它自己的保守门槛）。
  const raw = (data.getScores && typeof data.getScores === "function") ? data.getScores(h) : null;
  const cached = raw && Array.isArray(raw.rebalanceDates) && raw.rebalanceDates.length >= 1
    && raw.modelVersion === MODEL_VERSION && raw.paramsFingerprint === paramsFingerprint(o) ? raw : null;

  const stampOf = (data.getStamp && typeof data.getStamp === "function") ? (code) => data.getStamp(code) : () => null;
  const shapeOf = (k) => (k && k.length ? { firstDate: k[0].date, lastDate: k[k.length - 1].date, count: k.length } : null);
  const rowInfoValid = (rec, cur) => {
    if (!rec || !cur) return false;
    if (rec.mtime != null && rec.mtime === cur.mtime) return true;
    return rec.firstDate === cur.firstDate && (rec.count < cur.count || rec.lastDate < cur.lastDate);
  };
  const minScoreIdx = o.warmup + h + 2;

  const cands = [];
  const keepPrev = new Map();     // code -> 旧行是否仍有效（有效才可与本次新算合并）
  const fresh = new Map();        // code -> {s, p} 本次新算（写回缓存用）
  const freshReplace = new Set(); // code -> 旧行整体作废（只保留本次新算的基准日）
  let scored = 0, reused = 0, computed = 0, insufficient = 0;

  for (const code of targets) {
    const k = klMap.get(code);
    if (!k || k.length < 71) { insufficient++; continue; }
    const idx = lastIndexOnOrBefore(k, date);
    if (idx < minScoreIdx) { insufficient++; continue; } // 历史不足，永远算不出分

    const shape = shapeOf(k);
    const rec = cached && cached.stamps ? cached.stamps[code] : null;
    const rowOk = rowInfoValid(rec, { mtime: stampOf(code), ...shape });
    keepPrev.set(code, rowOk);
    const oldRow = cached && cached.rows ? cached.rows[code] : null;

    let sc = null;
    let reusedThis = false;
    if (rowOk && oldRow && oldRow[date] && Number.isFinite(oldRow[date].s)) {
      sc = { score: oldRow[date].s, posterior: oldRow[date].p };
      reusedThis = true;
    } else {
      // 只算基准日这一天：指标算一次，四格表推进到 idx（与回测同一函数、同一 cut）
      const ind = computeIndicators(k);
      const byH = scoreSeriesMulti(ind, o, [h], () => [idx]);
      const v = (byH.get(h) || [])[0];
      if (v) {
        sc = v;
        fresh.set(code, { s: v.score, p: v.posterior });
        if (!rowOk) freshReplace.add(code);
      }
    }
    if (!sc) { insufficient++; continue; }
    scored++;
    if (reusedThis) reused++; else computed++;

    // ---- 筛选条件：与 runBacktest 选股分支逐条对齐 ----
    if (sc.score <= o.threshold) continue;                    // 评分下限
    if (o.maxScore != null && sc.score > o.maxScore) continue; // 评分上限
    const px = closeAt(k, date);
    if (!px || px <= 0) continue;
    if (o.minPrice != null && px < o.minPrice) continue;
    if (o.maxPrice != null && px > o.maxPrice) continue;
    const tg = tagOf(code);
    if (o.excludeST && tg.st) continue;                        // 排除 ST/*ST
    // 市值：默认用"截至基准日的历史推算市值"（与回测同口径，消除前视偏差）；
    // historicalCap=false 退回 universe.json 的快照市值
    const capAtDate = o.historicalCap === false ? tg.mktcapYi : marketCapAt(k, tg.mktcapYi, date, data.snapshotDate);
    if (o.minMktcap != null && (capAtDate == null || capAtDate < o.minMktcap)) continue;
    const listDate = k[0] ? k[0].date : null;
    const listDays = listDate ? Math.round((new Date(date) - new Date(listDate)) / 86400000) : null;
    if (o.minListDays != null && (listDays == null || listDays < o.minListDays)) continue;

    const prevClose = idx > 0 ? k[idx - 1].close : null;
    cands.push({
      code,
      name: tg.name || "",
      market: tg.market || "",
      capBucket: tg.cap || "",
      sh300: tg.sh300 === true,
      st: tg.st === true,
      score: sc.score,
      posterior: sc.posterior,
      close: px,
      changePct: prevClose && prevClose > 0 ? px / prevClose - 1 : null,
      mktcapYi: capAtDate != null && Number.isFinite(capAtDate) ? Math.round(capAtDate) : (Number.isFinite(tg.mktcapYi) ? tg.mktcapYi : null),
      listDays,
    });
  }

  // 排序：与回测一致的 selectMode 方向，再按代码稳定次序
  const dir = o.selectMode === "bottom" ? 1 : -1;
  cands.sort((a, b) => (a.score - b.score) * dir || (a.code < b.code ? -1 : 1));
  const rows = cands.slice(0, limit);

  // 评分分布（榜单头部展示用）
  const scores = cands.map((c) => c.score).sort((a, b) => a - b);
  const at = (p) => (scores.length ? scores[Math.min(scores.length - 1, Math.max(0, Math.round((scores.length - 1) * p)))] : null);
  const summary = {
    maxScore: scores.length ? scores[scores.length - 1] : null,
    minScore: scores.length ? scores[0] : null,
    medianScore: at(0.5),
    p90Score: at(0.9),
    avgScore: scores.length ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10 : null,
  };

  // ---- 评分缓存写回：新算的基准日并入同一份文件（回测/再次筛选直接命中）----
  let cacheSaved = false;
  if (fresh.size && typeof data.saveScores === "function") {
    try {
      const dateSet = new Set(cached ? cached.rebalanceDates : []);
      dateSet.add(date);
      const rowEntries = {};
      if (cached) {
        for (const [code, row] of Object.entries(cached.rows)) {
          if (keepPrev.get(code) === false) continue; // 旧行判废：不保留，待后续请求整段重算
          rowEntries[code] = { ...row };
        }
      }
      for (const [code, v] of fresh) {
        const prevRow = freshReplace.has(code) ? null : rowEntries[code];
        rowEntries[code] = prevRow ? { ...prevRow, [date]: v } : { [date]: v };
      }
      const stamps = cached && cached.stamps ? { ...cached.stamps } : {};
      for (const code of fresh.keys()) {
        const k = klMap.get(code);
        if (k) stamps[code] = { mtime: stampOf(code), ...shapeOf(k) };
      }
      data.saveScores(h, {
        generatedAt: new Date().toISOString(),
        modelVersion: MODEL_VERSION,
        paramsFingerprint: paramsFingerprint(o),
        dataStamp: (data.getDataStamp && typeof data.getDataStamp === "function") ? await data.getDataStamp() : (cached ? cached.dataStamp : null),
        horizon: h,
        rebalanceDates: [...dateSet].sort(),
        universe: Object.keys(rowEntries).length,
        rows: rowEntries,
        stamps,
      });
      cacheSaved = true;
    } catch { /* 缓存写失败不影响本次结果 */ }
  }

  return {
    ok: true,
    date,
    requestedDate: want,
    dateFallback: date !== want,   // 请求日非交易日 → 已回退
    dataLastDate,                  // 行情数据最新交易日（缓存刷新后可前进）
    horizon: h,
    params: {
      pool: o.pool ?? null,
      horizon: h,
      threshold: o.threshold,
      maxScore: o.maxScore,
      selectMode: o.selectMode,
      excludeST: o.excludeST,
      minPrice: o.minPrice,
      maxPrice: o.maxPrice,
      minMktcap: o.minMktcap,
      minListDays: o.minListDays,
      historicalCap: o.historicalCap !== false,
      limit,
      codesCount: Array.isArray(o.codes) && o.codes.length ? targets.length : null,
    },
    universeSize: targets.length,
    scored,        // 基准日有评分的股票数
    reused,        // 命中缓存
    computed,      // 本次新算
    insufficient,  // K线不足 / 历史不足，无法评分
    candidates: cands.length, // 通过全部筛选的股票数（未截断）
    cacheSaved,
    elapsedMs: Date.now() - t0,
    summary,
    rows,
  };
}
