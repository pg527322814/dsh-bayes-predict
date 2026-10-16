// dsh-bayes-predict / lib/watchlist.js
// 自选股（收藏）持久化 + 报告。
//
// 存储：<cacheRoot>/watchlist.json（与行情/评分缓存同目录 —— 跨会话、跨浏览器持久，
//       且与插件其余状态同一处，备份/迁移只涉及一个目录）。
//
// 锚点语义（关键）：
//   加入自选的那一刻，把该股**最近一根K线的交易日**记为「自选日」、其收盘价记为「自选价」。
//   此后「自选日至今涨跌幅」永远以这个锚点计算 —— 行情数据往后延伸不会让已有自选股的
//   涨跌幅起点漂移（否则每次刷新行情，"自选以来"都会被悄悄重置）。
//   自选日与实际加入时刻是两个字段：行情缓存落后时（例如数据只到上周五）两者会不同，
//   报告里同时给出 addedAt（加入时间）与 anchorDate（自选日），不做隐式混淆。
//
// 价格口径：与插件其余部分一致 —— 腾讯后复权（hfq），含分红再投资，除权日无假跳空。
// 评分：直接复用 screenStocks({codes}) —— 与选股筛选、回测共用同一份评分缓存与同一套模型，
//       自选股页算出的分会被回测/筛选命中，反之亦然（codes 只评这几十只，不读全池）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./backtest-data.js";
import { screenStocks, lastIndexOnOrBefore } from "./backtest.js";
import { nameInitials, nameInitialsVariants } from "./pinyin.js";
import { getLiveQuotes, getRawSeries, liveAnchorStats } from "./realtime.js";

const DAY_MS = 86400000;

export function watchlistPath() {
  return join(cacheRoot(), "watchlist.json");
}

/**
 * 归一化股票代码：剥掉 sh/sz/bj 前缀与分隔符，只接受 A 股 6 位数字。
 * 自选股只支持 A 股——本地K线缓存（data/<code>.json）与评分缓存都只覆盖 A 股；
 * 美股（AAPL 等）走实时接口、不进缓存，无法计算"自选日至今"的后复权收益。
 */
export function normalizeCode(input) {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase().replace(/^(sh|sz|bj)/, "").replace(/[^0-9]/g, "");
  return /^\d{6}$/.test(s) ? s : null;
}

/** 读取自选股文档（缺文件/损坏都回退为空表，不让格式问题阻断面板）。 */
export function readWatchlist() {
  const p = watchlistPath();
  if (!existsSync(p)) return { version: 1, updatedAt: null, items: [] };
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const items = Array.isArray(j && j.items) ? j.items.filter((it) => it && typeof it.code === "string") : [];
    return { version: 1, updatedAt: (j && j.updatedAt) || null, items };
  } catch {
    return { version: 1, updatedAt: null, items: [] };
  }
}

/** 原子写：临时文件 + rename 覆盖，崩溃不会留下截断的自选表。 */
function writeWatchlist(doc, items) {
  mkdirSync(cacheRoot(), { recursive: true });
  const p = watchlistPath();
  const tmp = p + ".tmp";
  const payload = { version: 1, updatedAt: new Date().toISOString(), items };
  writeFileSync(tmp, JSON.stringify(payload, null, 1));
  renameSync(tmp, p);
  return payload;
}

/**
 * 加入自选：锚定该股最近一根K线为「自选日 / 自选价」。
 * 重复加入不重置锚点（只刷新名称），避免"再点一次收藏就把收益起点挪到今天"。
 * @param {string} input 代码（600519 / sh600519 / sz000001）
 * @param {object} data provider（buildProvider 返回值）
 */
export async function addToWatchlist(input, data) {
  const code = normalizeCode(input);
  if (!code) throw new Error(`无法识别的代码「${input}」：自选股只支持 A 股 6 位代码（如 600519 / sz000001）`);
  const kl = await data.getKlines(code);
  if (!kl || !kl.length) throw new Error(`取不到 ${code} 的K线（该代码可能不存在或未上市）`);
  const last = kl[kl.length - 1];
  const tag = (data.getTags ? data.getTags(code) : null) || {};
  const doc = readWatchlist();
  const exist = doc.items.find((it) => it.code === code);
  const now = new Date().toISOString();
  if (exist) {
    exist.name = tag.name || exist.name || code;
    exist.lastTouchedAt = now;
    const saved = writeWatchlist(doc, doc.items);
    return { created: false, item: exist, count: doc.items.length, updatedAt: saved.updatedAt };
  }
  const item = {
    code,
    name: tag.name || code,
    addedAt: now,             // 实际点击收藏的时刻
    anchorDate: last.date,    // 自选日：参与涨跌幅计算的锚定交易日（取本地缓存最新交易日）
    anchorClose: last.close,  // 自选价：该日后复权收盘（缓存口径，保留作参考/回退）
  };
  // 自选价同时记一份**不复权真实价**：自选股页的实时涨跌幅走真实价口径
  // （实时价只能拿到真实价；详见 lib/realtime.js 顶部说明）。
  try {
    const raw = await fetchRawCloseAt(code, last.date, data);
    if (raw != null) item.anchorRawClose = raw;
  } catch { /* 拿不到就算了：报告时会用不复权日线回读锚点价 */ }
  doc.items.push(item);
  const saved = writeWatchlist(doc, doc.items);
  return { created: true, item, count: doc.items.length, updatedAt: saved.updatedAt };
}

/**
 * 取某只股票在指定交易日的不复权收盘价（自选时记录"真实价的自选价"用）。
 * 拿不到返回 null（不抛：自选动作不该因为行情接口抖动而失败）。
 * provider 上若带了 getRawSeries（测试注入用）优先使用，与报告侧保持一致。
 */
async function fetchRawCloseAt(code, date, data) {
  const getRaw = (data && typeof data.getRawSeries === "function") ? data.getRawSeries : getRawSeries;
  try {
    const kl = await getRaw(code, date);
    if (!Array.isArray(kl) || !kl.length) return null;
    for (let i = kl.length - 1; i >= 0; i--) if (kl[i].date === date) return kl[i].close;
    const idx = lastIndexOnOrBefore(kl, date);
    return idx >= 0 ? kl[idx].close : null;
  } catch {
    return null;
  }
}

/** 移出自选。 */
export function removeFromWatchlist(input) {
  const code = normalizeCode(input);
  if (!code) throw new Error(`无法识别的代码「${input}」`);
  const doc = readWatchlist();
  const before = doc.items.length;
  const items = doc.items.filter((it) => it.code !== code);
  if (items.length === before) return { removed: false, code, count: before, updatedAt: doc.updatedAt };
  const saved = writeWatchlist(doc, items);
  return { removed: true, code, count: items.length, updatedAt: saved.updatedAt };
}

/** 清空自选。 */
export function clearWatchlist() {
  const doc = readWatchlist();
  const cleared = doc.items.length;
  const saved = writeWatchlist(doc, []);
  return { cleared, count: 0, updatedAt: saved.updatedAt };
}

/** 单只自选股的锚点收益与期间统计（纯函数，便于单测）。 */
export function anchorStats(kl, item) {
  const out = {
    anchorDate: item.anchorDate, anchorClose: item.anchorClose,
    lastDate: null, lastClose: null, bars: 0, calendarDays: null,
    returnSinceAdd: null, changePct: null,
    maxSince: null, minSince: null, maxDrawdownSince: null,
    warning: null,
  };
  if (!kl || !kl.length) { out.warning = "无K线数据"; return out; }
  const last = kl[kl.length - 1];
  out.lastDate = last.date;
  out.lastClose = last.close;
  if (kl.length >= 2) out.changePct = last.close / kl[kl.length - 2].close - 1;

  // 锚点索引：优先精确命中自选日；该日无成交（停牌/停市）则回退到之前最近一根
  let ai = -1;
  for (let i = kl.length - 1; i >= 0; i--) { if (kl[i].date === item.anchorDate) { ai = i; break; } }
  if (ai < 0) {
    ai = lastIndexOnOrBefore(kl, item.anchorDate);
    if (ai >= 0) {
      out.anchorDate = kl[ai].date;
      out.anchorClose = kl[ai].close;
      out.warning = `自选日 ${item.anchorDate} 无成交，锚点回退到 ${out.anchorDate}`;
    }
  }
  if (ai < 0) { out.warning = `自选日 ${item.anchorDate} 早于该股K线起点，无法计算自选以来收益`; return out; }

  out.anchorDate = kl[ai].date;
  out.anchorClose = kl[ai].close;
  out.bars = kl.length - 1 - ai;                       // 自选以来经过的交易日数
  out.calendarDays = Math.round((Date.parse(last.date) - Date.parse(out.anchorDate)) / DAY_MS);
  if (out.anchorClose > 0) out.returnSinceAdd = last.close / out.anchorClose - 1;

  // 期间最高/最低收盘 + 最大回撤（含自选日收盘作为起点）
  let hi = out.anchorClose, lo = out.anchorClose, peak = out.anchorClose, mdd = 0;
  for (let i = ai + 1; i < kl.length; i++) {
    const c = kl[i].close;
    if (c > hi) hi = c;
    if (c < lo) lo = c;
    if (c > peak) peak = c;
    const dd = c / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  out.maxSince = hi;
  out.minSince = lo;
  out.maxDrawdownSince = mdd;
  return out;
}

/**
 * 自选股报告：每只给出 自选日 / 加入时间 / 自选价 / 最新价 / 自选日至今涨跌幅 /
 * 期间最高最低与最大回撤 / 最新评分与后验。
 * @param {object} opts { horizon, date, withScore, priorLR, lrPriorStrength }
 * @param {object} data provider
 */
export async function watchlistReport(opts, data) {
  const o = opts || {};
  const doc = readWatchlist();
  const codes = doc.items.map((it) => it.code);

  // 评分：复用 screenStocks({codes})，与选股筛选/回测同一份缓存（只评这几只，不读全池）
  const scoreRows = new Map();
  let scoreMeta = null;
  if (o.withScore !== false && codes.length) {
    try {
      const sc = await screenStocks({
        codes,
        horizon: o.horizon,
        date: o.date ?? null,
        threshold: -1,            // 关闭评分门槛：自选股一律要显示评分（-1 不影响参数指纹/缓存）
        maxScore: null,
        selectMode: "top",
        excludeST: false,
        minPrice: null, maxPrice: null, minMktcap: null, minListDays: null,
        limit: 5000,
        ...(o.priorLR ? { priorLR: o.priorLR, lrPriorStrength: o.lrPriorStrength } : {}),
      }, data);
      for (const r of sc.rows) scoreRows.set(r.code, r);
      scoreMeta = {
        date: sc.date, dataLastDate: sc.dataLastDate, horizon: sc.horizon,
        scored: sc.scored, reused: sc.reused, computed: sc.computed,
        insufficient: sc.insufficient, elapsedMs: sc.elapsedMs, cacheSaved: sc.cacheSaved,
      };
    } catch (err) {
      scoreMeta = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 实时行情：批量报价 1 次往返拿全部自选股的现价（force 由面板「刷新」按钮触发）。
  // provider 上若带了 getLiveQuotes / getRawSeries（测试注入用），优先用它 —— 与 K线/评分同样走 provider 抽象。
  const getQuotes = (typeof data.getLiveQuotes === "function") ? data.getLiveQuotes : getLiveQuotes;
  const getRaw = (typeof data.getRawSeries === "function") ? data.getRawSeries : getRawSeries;
  const liveWanted = o.live !== false && codes.length > 0;
  let quotes = new Map();
  let liveMeta = null;
  if (liveWanted) {
    const t0 = Date.now();
    try {
      quotes = await getQuotes(codes, { force: o.force === true });
      liveMeta = { quoted: quotes.size, requested: codes.length, elapsedMs: Date.now() - t0, ttlMs: 60000 };
    } catch (err) {
      liveMeta = { quoted: 0, requested: codes.length, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - t0 };
    }
  }

  const items = [];
  for (const it of doc.items) {
    const tag = (data.getTags ? data.getTags(it.code) : null) || {};
    let kl = null;
    try { kl = await data.getKlines(it.code); } catch { kl = null; }
    const cached = anchorStats(kl, it);   // 后复权缓存口径（实时拿不到时的回退）
    // 实时口径：真实价（不复权）。锚点价从"不复权日线"回读，现价取实时报价。
    let st = cached;
    let liveUsed = false;
    let liveError = null;
    if (liveWanted) {
      try {
        const rawKl = await getRaw(it.code, it.anchorDate, { force: o.force === true });
        const q = quotes.get(it.code) || null;
        const live = liveAnchorStats(rawKl, {
          anchorDate: it.anchorDate,
          livePrice: q ? q.price : NaN,
          liveTime: q ? q.time : null,
          liveDate: q ? q.date : null,
        });
        if (live.returnSinceAdd != null) {
          st = live;
          // 注意：口径切到"真实价"不等于"拿到了实时报价"。只有真有报价才算 live=true（面板据此显示「实时」标记）；
          // 没有报价时仍用不复权口径（比 hfq 缓存价更贴近现在），但明确标记为回退并给出原因。
          liveUsed = live.live === true;
          if (!liveUsed) liveError = q ? "实时报价无有效价格" : "实时报价缺失，用不复权日线最后一根收盘";
        } else {
          liveError = live.warning || "实时口径不可用";
        }
      } catch (err) {
        liveError = err instanceof Error ? err.message : String(err);
      }
    }
    const row = scoreRows.get(it.code) || null;
    const displayName = tag.name || it.name || it.code;
    items.push({
      code: it.code,
      name: displayName,
      market: tag.market || "",
      capBucket: tag.cap || "",
      st: tag.st === true,
      sh300: tag.sh300 === true,
      addedAt: it.addedAt || null,          // 加入时间（实际时刻）
      lastTouchedAt: it.lastTouchedAt || null,
      live: liveUsed,                       // 本次是否用上了实时价
      liveError: liveError,
      livePrice: st.livePrice,              // 实时现价（真实价）
      liveTime: st.liveTime,                // 行情时间戳（yyyyMMddHHmmss）
      basis: st.basis,                      // "raw" = 真实价口径；回退时为 undefined
      anchorRawClose: it.anchorRawClose != null ? it.anchorRawClose : null,
      anchorDate: st.anchorDate,            // 自选日（锚定交易日）
      anchorClose: st.anchorClose,          // 自选价（实时口径下=不复权真实价）
      lastDate: st.lastDate,
      lastClose: st.lastClose,
      returnSinceAdd: st.returnSinceAdd,    // 自选日至今涨跌幅
      changePct: st.changePct,
      maxSince: st.maxSince,
      minSince: st.minSince,
      maxDrawdownSince: st.maxDrawdownSince,
      bars: st.bars,
      calendarDays: st.calendarDays,
      warning: st.warning,
      score: row ? row.score : null,        // 最新评分（缓存不可用时为 null）
      posterior: row ? row.posterior : null,
      mktcapYi: row && row.mktcapYi != null ? row.mktcapYi : (Number.isFinite(tag.mktcapYi) ? tag.mktcapYi : null),
      listDays: row ? row.listDays : null,
      // 该股行情是否落后于评分基准日（各股数据末日可能不同：刚刷新过的会更新，停牌/未刷新的更旧）。
      // 注意用 < 而不是 !==：数据比基准日更新的股票不算"旧"。
      stale: row && scoreMeta && scoreMeta.date ? (st.lastDate != null && st.lastDate < scoreMeta.date) : null,
      // 该股自身行情末日与评分基准日的关系（面板展示用）
      scoreDate: row && scoreMeta ? scoreMeta.date : null,
      // 拼音首字母（客户端"拼音首字母搜索"用；变体已展开多音字，如 招商银行 → ZSYX / ZSYH）
      initials: nameInitials(displayName),
      initialsVariants: nameInitialsVariants(displayName),
    });
  }

  const withRet = items.filter((x) => x.returnSinceAdd != null);
  const sorted = withRet.slice().sort((a, b) => b.returnSinceAdd - a.returnSinceAdd);
  const avg = withRet.length ? withRet.reduce((s, x) => s + x.returnSinceAdd, 0) / withRet.length : null;
  const summary = {
    count: items.length,
    withReturn: withRet.length,
    winCount: withRet.filter((x) => x.returnSinceAdd > 0).length,
    lossCount: withRet.filter((x) => x.returnSinceAdd < 0).length,
    // 持平单列：刚加入的自选，锚点就是最新一根K线，收益恰好为 0，不该被算进盈利
    flatCount: withRet.filter((x) => x.returnSinceAdd === 0).length,
    avgReturn: avg,
    best: sorted.length ? { code: sorted[0].code, name: sorted[0].name, returnSinceAdd: sorted[0].returnSinceAdd } : null,
    worst: sorted.length ? { code: sorted[sorted.length - 1].code, name: sorted[sorted.length - 1].name, returnSinceAdd: sorted[sorted.length - 1].returnSinceAdd } : null,
    earliestAnchorDate: items.reduce((m, x) => (x.anchorDate && (m == null || x.anchorDate < m) ? x.anchorDate : m), null),
  };

  return {
    ok: true,
    updatedAt: doc.updatedAt,
    scoreMeta,
    liveMeta: liveWanted ? { ...liveMeta, used: items.filter((x) => x.live).length } : null,
    basis: "raw",                             // 自选股页的涨跌幅口径：真实价（不复权）
    asOf: items.reduce((m, x) => (x.liveTime && (m == null || x.liveTime > m) ? x.liveTime : m), null),
    horizon: o.horizon,
    items,
    summary,
    watchlistPath: watchlistPath(),
    cacheRoot: cacheRoot(),
  };
}
