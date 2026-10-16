// dsh-bayes-predict / lib/realtime.js
// 自选股的**实时**收益：把"自选日 → 现在"的口径从"本地缓存日线收盘"升级为"实时价"。
//
// 为什么用**不复权（真实价）**口径：
//   插件的评分/回测用后复权（hfq），因为 hfq 收益序列含分红再投资、除权日无假跳空，适合做收益研究。
//   但实时价只能拿到**真实价**（腾讯 qt.gtimg.cn 现价），而腾讯的 hfq 日线有两个坑：
//     1) hfq 日线常常**不含当日 bar**（实测 2026-10-16 盘中：不复权序列有当日实时 bar，hfq 序列止于前一日）；
//     2) hfq 的复权基准会随最新交易日滚动，新交易日的 bar 可能与历史"跨基准断裂"
//        （实测 601988 前一日→当日因子跳 6.98%）。
//   把 hfq 锚点价与真实实时价混着算，会得出 -84% 这种荒唐跌幅（茅台 hfq≈9200 vs 真实≈1317）。
//   因此自选股页单独采用**真实价口径**：自选价 = 自选日的不复权收盘，最新价 = 实时现价，
//   涨跌幅 = 现价/自选日收盘 - 1 —— 与你在券商 App 里看到的数字一致，且不受复权基准漂移影响。
//   （差异只在分红：真实价口径不含分红再投资，年度量级通常 0~3%，面板会在提示里注明。）
//
// 数据源与开销：
//   - 实时报价：腾讯批量接口一次请求最多 60 只（见 market.fetchTencentQuotes），14 只自选 = 1 次往返；
//   - 不复权日线：每只 1 次请求（取到自选日那天为止，根数按天数估算，上限 700），用来拿"自选日收盘价"
//     与期间最高/最低/最大回撤。两处都有短 TTL 内存缓存（默认 60s），面板反复刷新不会重复打接口。
import { fetchKlines, fetchTencentQuotes, quoteDateOf } from "./market.js";

const DAY_MS = 86400000;
const LIVE_TTL_MS = 60 * 1000;      // 实时报价缓存：60 秒内重复打开面板不重复请求
const RAW_TTL_MS = 5 * 60 * 1000;   // 不复权日线缓存：5 分钟（盘中当日 bar 会更新，故比报价 TTL 长、比行情缓存短）

const quoteCache = new Map();       // code -> { ts, quote }
const rawCache = new Map();         // code -> { ts, key, klines }

/** 带前缀代码（600519 → sh600519）。与 backtest-data.prefixed 同规则，这里避免跨模块耦合。 */
export function prefixedCode(code) {
  const c = String(code);
  if (/^6/.test(c)) return `sh${c}`;
  if (/^(0|3|2)/.test(c)) return `sz${c}`;
  return `bj${c}`;
}

/**
 * 批量实时报价（带 TTL 缓存）。
 * @param {string[]} codes 6 位代码
 * @param {object} [opts] { force: true 绕过缓存（面板「刷新」按钮用） }
 * @returns {Promise<Map<string, object>>} code → quote（含 price / time / date）
 */
export async function getLiveQuotes(codes, opts = {}) {
  const now = Date.now();
  const need = [];
  const out = new Map();
  for (const code of codes) {
    const hit = quoteCache.get(code);
    if (!opts.force && hit && now - hit.ts < LIVE_TTL_MS) out.set(code, hit.quote);
    else need.push(code);
  }
  if (need.length) {
    const fetched = await fetchTencentQuotes(need.map(prefixedCode));
    for (const code of need) {
      const q = fetched.get(code);
      if (q) {
        const rec = { ts: now, quote: { ...q, date: quoteDateOf(q) } };
        quoteCache.set(code, rec);
        out.set(code, rec.quote);
      }
    }
  }
  return out;
}

/**
 * 不复权日线（带 TTL 缓存）。根数按"自选日距今天数"估算，保证覆盖自选日、又不浪费带宽。
 * @param {string} code 6 位代码
 * @param {string|null} sinceDate 需要覆盖到的最早日期（通常是自选日）
 * @param {object} [opts] { force }
 */
export async function getRawSeries(code, sinceDate, opts = {}) {
  const need = (() => {
    if (!sinceDate) return 60;
    const days = Math.max(0, Math.round((Date.now() - Date.parse(`${sinceDate}T00:00:00Z`)) / DAY_MS));
    return Math.min(700, Math.max(30, Math.round(days * 0.75) + 30)); // 0.75 ≈ 交易日/自然日
  })();
  const hit = rawCache.get(code);
  const now = Date.now();
  // 缓存命中条件：未过期 且 上次取的根数不少于本次需要（否则窗口不够，回读不到自选日）
  if (!opts.force && hit && now - hit.ts < RAW_TTL_MS && hit.need >= need) return hit.klines;
  try {
    const kl = await fetchKlines(prefixedCode(code), need, "none");
    rawCache.set(code, { ts: now, need, klines: kl });
    return kl;
  } catch (err) {
    if (hit) return hit.klines;    // 拉取失败：退回上一次的序列（哪怕是旧的，也比没有强）
    throw err;
  }
}

/** 二分：返回 date 之前（含当日）最后一根的下标，无则 -1。 */
function lastIndexOnOrBefore(klines, date) {
  let lo = 0, hi = klines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * 真实价口径的"自选日至今"实时统计（纯函数，便于单测）。
 * @param {Array} rawSeries 不复权日线（升序；腾讯盘中会含当日实时 bar）
 * @param {object} o { anchorDate, livePrice?, liveTime?, liveDate? }
 */
export function liveAnchorStats(rawSeries, o) {
  const out = {
    basis: "raw", live: false,
    anchorDate: o.anchorDate, anchorClose: null,
    lastDate: null, lastClose: null, livePrice: null, liveTime: null,
    returnSinceAdd: null, changePct: null,
    maxSince: null, minSince: null, maxDrawdownSince: null,
    bars: 0, calendarDays: null, warning: null,
  };
  if (!Array.isArray(rawSeries) || !rawSeries.length) { out.warning = "拿不到不复权日线（无法定位自选日价格）"; return out; }

  // 锚点：精确命中自选日；该日无成交（停牌）则回退到之前最近一根
  let ai = -1;
  for (let i = rawSeries.length - 1; i >= 0; i--) { if (rawSeries[i].date === o.anchorDate) { ai = i; break; } }
  if (ai < 0) {
    ai = lastIndexOnOrBefore(rawSeries, o.anchorDate);
    if (ai >= 0) out.warning = `自选日 ${o.anchorDate} 无成交，锚点回退到 ${rawSeries[ai].date}`;
  }
  if (ai < 0) { out.warning = `自选日 ${o.anchorDate} 早于可取的日线窗口（>700 交易日）`; return out; }
  out.anchorDate = rawSeries[ai].date;
  out.anchorClose = rawSeries[ai].close;

  // 最新价：优先实时报价（权威现价 + 时间戳），否则退回复权日线最后一根
  const lastBar = rawSeries[rawSeries.length - 1];
  const liveOk = Number.isFinite(o.livePrice) && o.livePrice > 0;
  out.live = liveOk;
  out.livePrice = liveOk ? o.livePrice : null;
  out.liveTime = liveOk ? (o.liveTime || null) : null;
  out.lastDate = liveOk ? (o.liveDate || lastBar.date) : lastBar.date;
  out.lastClose = liveOk ? o.livePrice : lastBar.close;

  // 当日涨跌幅：与"最后一根K线之前的那个交易日收盘"比
  const prevBar = rawSeries.length >= 2 ? rawSeries[rawSeries.length - 2] : null;
  if (prevBar && prevBar.close > 0) out.changePct = out.lastClose / prevBar.close - 1;

  out.bars = Math.max(0, rawSeries.length - 1 - ai);
  if (out.anchorDate && out.lastDate) out.calendarDays = Math.round((Date.parse(out.lastDate) - Date.parse(out.anchorDate)) / DAY_MS);
  if (out.anchorClose > 0) out.returnSinceAdd = out.lastClose / out.anchorClose - 1;

  // 期间最高/最低/最大回撤：自选日收盘 → 之后逐日收盘 →（若为实时）当前价
  let hi = out.anchorClose, lo = out.anchorClose, peak = out.anchorClose, mdd = 0;
  const feed = (c) => {
    if (!Number.isFinite(c) || c <= 0) return;
    if (c > hi) hi = c;
    if (c < lo) lo = c;
    if (c > peak) peak = c;
    const dd = c / peak - 1;
    if (dd < mdd) mdd = dd;
  };
  for (let i = ai + 1; i < rawSeries.length; i++) feed(rawSeries[i].close);
  if (liveOk && lastBar.close !== o.livePrice) feed(o.livePrice);   // 盘中实时价作为最后一个观测点
  out.maxSince = hi;
  out.minSince = lo;
  out.maxDrawdownSince = mdd;
  return out;
}
