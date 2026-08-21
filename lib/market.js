// dsh-bayes-predict / market.js
// 行情数据获取：腾讯免费接口（A 股，无需 API key），美股代码直接透传给腾讯接口按美股尝试，
// 主接口失败时回退新浪。
// 所有函数在 Node 18+ 环境运行（host 端），依赖内置 fetch / TextDecoder。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * 归一化股票代码。
 * - "600519" / "000001" / "300750" / "688981" → A 股带前缀 sh/sz/bj
 * - "sh600519" / "sz000001" / "bj430047" → 原样
 * - 其他（如 "AAPL"、"BABA"）→ 美股代码（大写原样）
 * @param {string} raw
 * @returns {{ symbol: string, market: 'cn'|'us' }}
 */
export function normalizeSymbol(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/^\d{6}$/.test(s)) {
    if (s.startsWith("6")) return { symbol: `sh${s}`, market: "cn" };
    if (s.startsWith("0") || s.startsWith("2") || s.startsWith("3")) return { symbol: `sz${s}`, market: "cn" };
    if (s.startsWith("4") || s.startsWith("8")) return { symbol: `bj${s}`, market: "cn" };
    return { symbol: `sh${s}`, market: "cn" };
  }
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return { symbol: s, market: "cn" };
  return { symbol: s.toUpperCase(), market: "us" };
}

/**
 * 拉取日 K 线（腾讯前复权接口，JSON，无编码问题）。
 * 返回数组：[{date, open, close, high, low, volume}]，按时间升序。
 * @param {string} prefixed A 股带前缀代码（sh600519 / sz000001）；美股代码走 Yahoo 兜底
 * @param {number} count 需要的根数（含复权后实际可能略多）
 */
/** 腾讯 fqkline 可用域名（主域名若被限流/故障则自动切换备用）。 */
const TENCENT_FQKLINE_HOSTS = ["ifzq.gtimg.cn", "web.ifzq.gtimg.cn"];

export async function fetchKlines(prefixed, count = 120, adjust = "qfq") {
  const fqToken = adjust === "none" ? "" : adjust; // none → 不复权（原始实时股价）
  const param = `${prefixed},day,,,${count},${fqToken}`;
  let lastErr = null;
  for (const host of TENCENT_FQKLINE_HOSTS) {
    try {
      const url = `https://${host}/appstock/app/fqkline/get?param=${encodeURIComponent(param)}`;
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`行情接口失败 HTTP ${res.status} (${host})`);
      const json = await res.json();
      const data = json?.data?.[prefixed];
      const rows = adjust === "none" ? (data?.day ?? data?.qfqday ?? data?.hfqday)
        : adjust === "hfq" ? (data?.hfqday ?? data?.qfqday ?? data?.day)
        : (data?.qfqday ?? data?.day ?? data?.hfqday);
      if (!Array.isArray(rows) || rows.length < 2) throw new Error(`未获取到 ${prefixed} 的 K 线数据 (${host})`);
      const out = rows.map((r) => ({
        date: String(r[0]),
        open: Number(r[1]),
        close: Number(r[2]),
        high: Number(r[3]),
        low: Number(r[4]),
        volume: Number(r[5] ?? 0),
      }));
      // 复权断层检测（仅 hfq）：腾讯后复权的复权基准随最新交易日滚动，新交易日加入时若
      // 发生复权事件，接口返回的最后一天会与前一天"跨基准断裂"（如 2026-08-21 全市场
      // hfq 单日假跳变 -10%~-70%，而不复权真实价完全正常）。检测：最后一天 |单日涨跌| > 8%
      // 时拉不复权序列核对；真实价连续而 hfq 断裂 → 判定为复权断层，丢弃最后一天
      // （宁缺毋滥：宁可少一天，不用脏数据污染评分与回测）。
      if (adjust === "hfq" && out.length >= 3) {
        const a = out[out.length - 2].close, b = out[out.length - 1].close;
        if (a > 0 && Math.abs(b / a - 1) > 0.08) {
          try {
            const raw = await fetchKlines(prefixed, 5, "none");
            const ra = raw[raw.length - 2]?.close, rb = raw[raw.length - 1]?.close;
            if (ra > 0 && Math.abs(rb / ra - 1) < 0.03) out.pop();
          } catch { /* 核对失败则保守保留 */ }
        }
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`获取 ${prefixed} K线失败`);
}

/** 从腾讯 qt.gtimg.cn 拉实时行情（GBK 编码，需 TextDecoder 解码）。 */
export async function fetchTencentQuote(prefixed) {
  const url = `https://qt.gtimg.cn/q=${prefixed}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`实时行情失败 HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("gbk").decode(buf);
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error(`实时行情解析失败: ${prefixed}`);
  const f = m[1].split("~");
  const num = (i) => {
    const v = Number(f[i]);
    return Number.isFinite(v) ? v : NaN;
  };
  return {
    name: f[1] || prefixed,
    code: f[2] || prefixed,
    price: num(3),
    prevClose: num(4),
    open: num(5),
    volume: num(6),
    time: f[30] || "",
    change: num(31),
    changePercent: num(32),
    high: num(33),
    low: num(34),
    amountWan: num(37),
    turnover: num(38),
    pe: num(39),
    amplitude: num(43),
    floatMarketCapYi: num(44),
    totalMarketCapYi: num(45),
    pb: num(46),
    limitUp: num(47),
    limitDown: num(48),
  };
}

/** 新浪实时行情兜底（GBK，需 Referer 头）。 */
export async function fetchSinaQuote(prefixed) {
  const url = `https://hq.sinajs.cn/list=${prefixed}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
  });
  if (!res.ok) throw new Error(`新浪行情失败 HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("gbk").decode(buf);
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) throw new Error(`新浪行情解析失败: ${prefixed}`);
  const f = m[1].split(",");
  const num = (i) => {
    const v = Number(f[i]);
    return Number.isFinite(v) ? v : NaN;
  };
  // 新浪格式：名称,今开,昨收,现价,最高,最低,买一,卖一,成交量,成交额,...
  return {
    name: f[0] || prefixed,
    code: prefixed,
    price: num(3),
    prevClose: num(2),
    open: num(1),
    high: num(4),
    low: num(5),
    volume: num(8),
    amountWan: num(9) / 10000,
    time: f[30] ? `${f[30]} ${f[31]}` : "",
    change: num(3) - num(2),
    changePercent: num(2) ? ((num(3) - num(2)) / num(2)) * 100 : NaN,
  };
}

/**
 * 获取实时行情（A 股：腾讯优先，新浪兜底）。
 * @returns 统一行情对象（缺失字段为 NaN）
 */
export async function fetchQuote(prefixed) {
  try {
    const q = await fetchTencentQuote(prefixed);
    if (Number.isFinite(q.price) && q.price > 0) return q;
    throw new Error("腾讯实时行情字段缺失");
  } catch {
    const q = await fetchSinaQuote(prefixed);
    if (Number.isFinite(q.price) && q.price > 0) return q;
    throw new Error(`无法获取 ${prefixed} 实时行情`);
  }
}

/**
 * 拉取美股日 K 线（新浪 US_MinKService JSONP，1984 年至今全历史，免费无需 key）。
 * 响应为 `var _data=([...])` 形式，字段 d=日期 o=开 h=高 l=低 c=收 v=量。
 * @param {string} symbol 美股代码（如 AAPL）
 * @param {number} count 需要的根数
 */
export async function fetchUsKlines(symbol, count = 120) {
  const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_data=/US_MinKService.getDailyK?symbol=${symbol.toLowerCase()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
  });
  if (!res.ok) throw new Error(`新浪美股行情失败 HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("gbk").decode(buf);
  const m = text.match(/\[([\s\S]*)\]/);
  if (!m) throw new Error(`新浪美股 K 线解析失败: ${symbol}`);
  let arr;
  try {
    arr = JSON.parse(`[${m[1]}]`);
  } catch {
    throw new Error(`新浪美股 K 线 JSON 解析失败: ${symbol}`);
  }
  if (!Array.isArray(arr) || arr.length < 2) throw new Error(`新浪美股数据不足: ${symbol}`);
  const rows = arr
    .filter((r) => r && r.d && r.c)
    .map((r) => ({
      date: String(r.d),
      open: Number(r.o),
      close: Number(r.c),
      high: Number(r.h),
      low: Number(r.l),
      volume: Number(r.v ?? 0),
    }))
    .filter((r) => Number.isFinite(r.close) && r.close > 0);
  if (rows.length < 2) throw new Error(`新浪美股有效数据不足: ${symbol}`);
  return rows.slice(-count);
}

/**
 * 拉取 A 股日 K 线（新浪 CN_MarketDataService，**不复权真实价**，最多约 800 根≈2023 至今）。
 * 返回 [{date, open, close, high, low, volume}]（升序）。腾讯 fqkline 已下线，此为 A 股不复权主源。
 * @param {string} prefixed A 股带前缀代码（sh600519 / sz000001）
 * @param {number} count 需要的根数（新浪上限约 800）
 */
export async function fetchSinaDailyKlines(prefixed, count = 800) {
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20t=/CN_MarketDataService.getKLineData?symbol=${prefixed}&scale=240&ma=no&datalen=${Math.min(count, 800)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
  });
  if (!res.ok) throw new Error(`新浪日 K 失败 HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/\((\[[\s\S]*\])\)/);
  if (!m) throw new Error(`新浪日 K 解析失败: ${prefixed}`);
  let arr;
  try {
    arr = JSON.parse(m[1]);
  } catch {
    throw new Error(`新浪日 K JSON 解析失败: ${prefixed}`);
  }
  if (!Array.isArray(arr) || arr.length < 2) throw new Error(`新浪日 K 数据不足: ${prefixed}`);
  const rows = arr
    .filter((r) => r && r.day && r.close)
    .map((r) => ({
      date: String(r.day),
      open: Number(r.open),
      close: Number(r.close),
      high: Number(r.high),
      low: Number(r.low),
      volume: Number(r.volume ?? 0),
    }))
    .filter((r) => Number.isFinite(r.close) && r.close > 0);
  if (rows.length < 2) throw new Error(`新浪日 K 有效数据不足: ${prefixed}`);
  return rows.slice(-count);
}

/**
 * 顶层入口：输入任意代码，返回 {meta, quote, klines}。
 * 带内存 TTL 缓存（日线数据在 TTL 内只拉取一次）。
 * A 股 K 线：东财长历史（2016 至今，后复权）；美股 K 线：新浪全历史。
 * @param {string} raw 用户输入（600519 / sh600519 / AAPL）
 * @param {number} count 回退数据源的根数（默认 800）
 */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const cache = new Map();

export async function fetchMarketData(raw, count = 800) {
  const key = `${String(raw).trim()}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const { symbol, market } = normalizeSymbol(raw);
  let result;
  if (market === "cn") {
    // A 股：腾讯后复权（hfq）为主；东财后复权兜底（接口恢复时可用）
    const [klines, quote] = await Promise.all([
      fetchKlines(symbol, Math.min(count, 700), "hfq").catch(() => fetchEastMoneyKlines(symbol)),
      fetchQuote(symbol),
    ]);
    result = { meta: { symbol, market: "cn", raw: String(raw).trim() }, quote, klines };
  } else {
    // 美股：K 线走新浪；实时快照优先腾讯 us 前缀，失败用新浪 gb_ 或 K 线推算
    const klines = await fetchUsKlines(symbol, count);
    let quote;
    try {
      const tq = await fetchTencentQuote(`us${symbol}`);
      if (Number.isFinite(tq.price) && tq.price > 0) quote = tq;
      else throw new Error("腾讯美股字段缺失");
    } catch {
      const last = klines[klines.length - 1];
      const prev = klines[klines.length - 2];
      quote = {
        name: symbol,
        code: symbol,
        price: last.close,
        prevClose: prev.close,
        open: last.open,
        high: last.high,
        low: last.low,
        volume: last.volume,
        time: last.date,
        change: last.close - prev.close,
        changePercent: prev.close ? ((last.close - prev.close) / prev.close) * 100 : NaN,
      };
    }
    result = { meta: { symbol, market: "us", raw: String(raw).trim() }, quote, klines };
  }
  cache.set(key, { ts: Date.now(), data: result });
  return result;
}

/**
 * 拉取 A 股日 K 线（东方财富，后复权 fqt=2）。
 * 现作为"腾讯不复权"的兜底源（腾讯 day 接口失败时使用）；
 * 后复权收益序列含分红再投资，但价格非真实股价。
 * @param {string} prefixed A 股带前缀代码（sh600519 / sz000001）
 * @param {number} startYear 起始年份（默认 2016）
 * @param {string} [begDate] 可选：起始日期 yyyy-MM-dd（增量拉取用；缺省用 startYear-01-01）
 */
export async function fetchEastMoneyKlines(prefixed, startYear = 2016, begDate = null) {
  const market = prefixed.slice(0, 2);
  const code = prefixed.slice(2);
  const secid = `${market === "sh" ? "1" : "0"}.${code}`;
  const beg = begDate ? begDate.replace(/-/g, "") : `${startYear}0101`;
  const end = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=2&beg=${beg}&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" } });
  if (!res.ok) throw new Error(`东财行情失败 HTTP ${res.status}`);
  const json = await res.json();
  const kl = json?.data?.klines;
  if (!Array.isArray(kl) || kl.length < 2) throw new Error(`未获取到 ${prefixed} 的长历史 K 线`);
  return kl.map((row) => {
    const f = row.split(",");
    return { date: f[0], open: Number(f[1]), close: Number(f[2]), high: Number(f[3]), low: Number(f[4]), volume: Number(f[5] ?? 0) };
  });
}
