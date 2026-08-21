// dsh-bayes-predict / bayes.js —— 贝叶斯定理个股预测核心
//  1) 多指标信号融合 —— 每个技术指标作为"证据"，似然比 LR 从历史数据经验估计，
//     odds 乘法做贝叶斯更新，得到未来 N 日上涨的后验概率与综合评分；
//  2) 趋势状态识别 —— 三状态（涨/震荡/跌）贝叶斯分类（含经济意义阈值）；
//  3) 持仓风险估计 —— EWMA 波动率 + 经验分位数 VaR/CVaR + 回撤。
// v2 优化点：
//  - 四格表似然比：看多信号用 LR_bull、看空信号用 LR_bear（修复看空信号方向错误）
//  - 时间衰减权重：近期样本权重更高（halfLife 可配），LR/先验均加权
//  - 波动率归一化信号阈值：ROC/近N日收益阈值按滚动 σ 自适应，跨股票可比
//  - 信号强度分级：strength ∈ (0,1]，缩放 log 贡献（弱信号少贡献）
//  - temperature scaling：默认 T=1.5 温和收缩，修正相关信号导致的过度自信
//  - 趋势状态经济阈值：δ = max(0.5·SE, 年化目标日当量)
//  - 风险：EWMA 波动率（RiskMetrics λ=0.94）+ 经验 VaR 为主输出
//  - 多 horizon 对比（2/5/10/20 日）+ 先验 shrink + 后验置信区间
//  - walk-forward 回测与温度校准（backtest 导出）
// 纯 JS 实现，零第三方依赖。

/**
 * 模型版本号：信号定义（signalDirectionsAt）、LR 估计方式、温度/先验等模型默认参数
 * 发生变更时必须递增——评分缓存（scores/h*.json）据此失效重建，避免新旧模型结果混用。
 */
export const MODEL_VERSION = 1;

// ================= 基础统计 =================

export function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs, ddof = 1) {
  const n = xs.length;
  if (n <= ddof) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - ddof);
}

export function stdev(xs, ddof = 1) {
  return Math.sqrt(variance(xs, ddof));
}

/** 简单移动平均，返回与输入等长的数组，前 period-1 位为 null。 */
export function sma(xs, period) {
  const out = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= period) sum -= xs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均（全序列初始化），返回等长数组。 */
export function ema(xs, period) {
  const out = new Array(xs.length).fill(null);
  if (!xs.length) return out;
  const k = 2 / (period + 1);
  let prev = xs[0];
  out[0] = prev;
  for (let i = 1; i < xs.length; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 滚动标准差（样本，ddof=1），前 period-1 位为 null。 */
export function rollingStd(xs, period) {
  const out = new Array(xs.length).fill(null);
  if (period < 2) return out;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    sum += x;
    sumSq += x * x;
    if (i >= period) {
      const old = xs[i - period];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const v = Math.max(0, (sumSq - (sum * sum) / period) / (period - 1));
      out[i] = Math.sqrt(v);
    }
  }
  return out;
}

/** EWMA 波动率（RiskMetrics λ=0.94）：返回序列末尾的日收益波动率（小数）。 */
export function ewmaVolatility(returns, lambda = 0.94) {
  const n = returns.length;
  if (!n) return 0;
  let v = returns[0] * returns[0];
  for (let i = 1; i < n; i++) v = lambda * v + (1 - lambda) * returns[i] * returns[i];
  return Math.sqrt(Math.max(v, 0));
}

/**
 * 时间衰减权重：距 anchor 越远权重越低（指数衰减，半衰期 halfLife）。
 * @returns 与 xs 等长的权重数组
 */
export function timeWeights(n, halfLife = 200, anchor = n - 1) {
  const out = new Array(n).fill(1);
  if (halfLife <= 0) return out;
  const lambda = Math.LN2 / halfLife;
  for (let i = 0; i < n; i++) out[i] = Math.exp(-lambda * Math.max(0, anchor - i));
  return out;
}

// ================= 技术指标 =================

/** MACD：返回 {dif, dea, hist}，均为等长数组。 */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const efast = ema(closes, fast);
  const eslow = ema(closes, slow);
  const dif = closes.map((_, i) => efast[i] - eslow[i]);
  const dea = ema(dif, signal);
  const hist = dif.map((d, i) => d - dea[i]);
  return { dif, dea, hist };
}

/** RSI（Wilder 平滑），返回等长数组，前 period 位为 null。 */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/** 布林带：返回 {mid, upper, lower}，等长数组。 */
export function bollinger(closes, period = 20, k = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const sd = stdev(win, 0);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/** ATR（Wilder），返回等长数组，前 period 位为 null。 */
export function atr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  const trs = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    trs[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  let prev = 0;
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      prev += trs[i];
      if (i === period) {
        prev /= period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + trs[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** 变动率 ROC，返回等长数组（百分比），前 period 位为 null。 */
export function roc(closes, period = 10) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i - period] === 0 ? 0 : ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
  }
  return out;
}

/** 分位数（排序法，线性插值）。 */
export function quantile(xs, q) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 最大回撤（按收盘价序列）：返回 {maxDrawdown(负值), peakIndex, troughIndex, days}。 */
export function maxDrawdown(closes) {
  if (closes.length < 2) return { maxDrawdown: 0, peakIndex: 0, troughIndex: 0, days: 0 };
  let peak = closes[0];
  let peakIdx = 0;
  let mdd = 0;
  let mddPeak = 0;
  let mddPeakIdx = 0;
  let mddTroughIdx = 0;
  let troughIdx = 0;
  let troughDays = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > peak) {
      peak = closes[i];
      peakIdx = i;
    }
    const dd = closes[i] / peak - 1;
    if (dd < mdd) {
      mdd = dd;
      mddPeak = peak;
      mddPeakIdx = peakIdx;
      mddTroughIdx = i;
    }
    if (closes[i] < peak) troughIdx = i;
    troughDays = i - peakIdx;
  }
  return { maxDrawdown: mdd, mddPeak, mddPeakIdx, mddTroughIdx, days: troughDays };
}

// ================= 标准正态分位数（Beasley–Springer–Moro 近似，精度 ~1e-9） =================

function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** 标准正态密度。 */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** 标准正态 CDF（A&S 7.1.26 有理近似，精度 ~7.5e-8）。 */
function normCdf(x) {
  if (x > 8) return 1;
  if (x < -8) return 0;
  const b0 = 0.2316419;
  const t = 1 / (1 + b0 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - normPdf(x) * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

// ================= 指标预计算 =================

/**
 * 一次性预计算全部指标（信号/LR/趋势/风险共用）。
 * @param {Array<{date,open,close,high,low,volume}>} klines 日 K 线（升序）
 * @returns 指标对象（含 closes/returnsAt/sigma20/sigma60 及各技术指标）
 */
export function computeIndicators(klines) {
  const dates = klines.map((k) => k.date);
  const closes = klines.map((k) => k.close);
  const opens = klines.map((k) => k.open);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const volumes = klines.map((k) => k.volume);
  // returnsAt[i] = closes[i]/closes[i-1]-1（等长，首元素 0 占位）
  const returnsAt = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) returnsAt[i] = closes[i] / closes[i - 1] - 1;
  const sigma20 = rollingStd(returnsAt, 20);
  const sigma60 = rollingStd(returnsAt, 60);
  const m = macd(closes);
  return {
    dates, closes, opens, highs, lows, volumes, returnsAt, sigma20, sigma60,
    dif: m.dif,
    dea: m.dea,
    hist: m.hist,
    rsi14: rsi(closes, 14),
    ma5: sma(closes, 5),
    ma10: sma(closes, 10),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    bb: bollinger(closes, 20, 2),
    atr14: atr(highs, lows, closes, 14),
    roc10: roc(closes, 10),
    volMa20: sma(volumes, 20),
  };
}

// ================= 市场上下文（beta 因子） =================

/**
 * 给指标对象附加市场上下文（用于 market_beta 信号）：
 *  - marketR5：指数 5 日动量（按个股交易日对齐）
 *  - idxRet：指数日收益（对齐）
 *  - beta：个股对指数的滚动 beta（60 日）
 *  - marketSigma：指数日收益滚动 σ（20 日，信号阈值归一化）
 * @param {object} ind computeIndicators 的结果（须含 dates/returnsAt）
 * @param {Array} indexKlines 指数日 K 线 [{date, close}...]
 */
export function attachMarketContext(ind, indexKlines) {
  const { dates, returnsAt } = ind;
  const n = dates.length;
  const idxDates = indexKlines.map((k) => k.date);
  const idxCloses = indexKlines.map((k) => k.close);
  const aligned = new Array(n).fill(null);
  let j = -1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < idxDates.length && idxDates[j + 1] <= dates[i]) j++;
    aligned[i] = j >= 0 ? idxCloses[j] : null;
  }
  const idxRet = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (aligned[i] != null && aligned[i - 1] != null && aligned[i - 1] > 0) idxRet[i] = aligned[i] / aligned[i - 1] - 1;
  }
  const marketR5 = new Array(n).fill(null);
  for (let i = 5; i < n; i++) {
    if (aligned[i] != null && aligned[i - 5] != null && aligned[i - 5] > 0) marketR5[i] = aligned[i] / aligned[i - 5] - 1;
  }
  const beta = new Array(n).fill(null);
  const period = 60;
  for (let i = period; i < n; i++) {
    let mx = 0;
    let my = 0;
    for (let k = i - period + 1; k <= i; k++) { mx += idxRet[k]; my += returnsAt[k]; }
    mx /= period;
    my /= period;
    let cov = 0;
    let vx = 0;
    for (let k = i - period + 1; k <= i; k++) {
      cov += (idxRet[k] - mx) * (returnsAt[k] - my);
      vx += (idxRet[k] - mx) ** 2;
    }
    beta[i] = vx > 1e-12 ? cov / vx : 1;
  }
  ind.marketR5 = marketR5;
  ind.idxRet = idxRet;
  ind.beta = beta;
  ind.marketSigma = rollingStd(idxRet, 20);
  ind.alignedIdx = aligned; // 指数对齐收盘（超额收益标签用）
  return ind;
}

/** 超额收益标签：个股未来 N 日收益 > 指数未来 N 日收益（跑赢大盘）。对齐失败返回 null。 */
function excessUp(closes, alignedIdx, i, horizon) {
  if (closes[i] > 0 && alignedIdx[i] != null && alignedIdx[i] > 0 && alignedIdx[i + horizon] != null) {
    return closes[i + horizon] / closes[i] - 1 > alignedIdx[i + horizon] / alignedIdx[i] - 1;
  }
  return null;
}

// ================= 信号定义 =================
// 每个信号在索引 i 处给出 {key, direction: ±1, strength: (0,1]}。
// direction：+1 看多证据 / -1 看空证据；strength：信号强度（缩放 log 贡献）。
// 历史时刻同样计算，用于经验似然比估计（仅 direction 参与计数）。

const clampStrength = (v) => Math.max(0.3, Math.min(1, v));

/**
 * 在索引 i 处计算全部信号。
 * @param {object} ind 预计算指标对象（含 sigma20/sigma60）
 * @param {number} i 索引
 * @param {object} opts {normK=0.5 波动率归一化倍数}
 * @returns {Array<{key: string, direction: -1|1, strength: number}>}
 */
export function signalDirectionsAt(ind, i, opts = {}) {
  const { closes, opens, highs, lows, returnsAt, dif, dea, hist, rsi14, ma5, ma10, ma20, ma60, bb, atr14, roc10, volumes, volMa20, sigma20, sigma60 } = ind;
  const out = [];
  const c = closes[i];
  const skip = opts.skipSignals; // 可选：跳过指定信号（调试/消融）
  const sig = (key, direction, strength = 1) => { if (!skip || !skip.has(key)) out.push({ key, direction, strength }); };
  const s = sigma20[i] ?? sigma60[i] ?? 0.01; // 波动率归一化基准（小数）
  const normK = opts.normK ?? 0.5;

  // 1) MACD 金叉/死叉：dif 上穿/下穿 dea（最近 3 根内）
  let macdCross = 0;
  for (let k = 1; k <= 3 && i - k >= 1; k++) {
    if (dif[i - k] != null && dea[i - k] != null && dif[i - k - 1] != null && dea[i - k - 1] != null) {
      if (dif[i - k] > dea[i - k] && dif[i - k - 1] <= dea[i - k - 1]) { macdCross = 1; break; }
      if (dif[i - k] < dea[i - k] && dif[i - k - 1] >= dea[i - k - 1]) { macdCross = -1; break; }
    }
  }
  if (macdCross !== 0) sig("macd_cross", macdCross, 1);

  // 2) MACD 柱体：正且扩张 → 看多；负且收缩 → 看空
  if (hist[i] != null) {
    const prevH = i > 0 ? hist[i - 1] : hist[i];
    if (hist[i] > 0 && hist[i] > prevH) sig("macd_hist", 1, 1);
    else if (hist[i] < 0 && hist[i] < prevH) sig("macd_hist", -1, 1);
  }

  // 3) RSI：极值回升/回落看反转，50 上下看强弱（实证弱信息，强度整体弱化）
  if (rsi14[i] != null) {
    const r = rsi14[i];
    const prevR = i > 0 ? rsi14[i - 1] : r;
    if (r < 20) sig("rsi", 1, 0.5);
    else if (r < 30 && r >= prevR) sig("rsi", 1, 0.4);
    else if (r > 80) sig("rsi", -1, 0.5);
    else if (r > 70 && r <= prevR) sig("rsi", -1, 0.4);
    else if (r >= 50 && r < 70) sig("rsi", 1, 0.3);
    else if (r > 30 && r < 50) sig("rsi", -1, 0.3);
  }

  // 4) 均线排列：MA5>MA10>MA20 多头；反之空头（实证弱信息，强度弱化）
  if (ma5[i] != null && ma10[i] != null && ma20[i] != null && ma10[i] > 0) {
    const gap = Math.abs(ma5[i] / ma10[i] - 1);
    if (gap > 0.002) {
      if (ma5[i] > ma10[i] && ma10[i] > ma20[i]) sig("ma_align", 1, gap > 0.005 ? 0.6 : 0.4);
      else if (ma5[i] < ma10[i] && ma10[i] < ma20[i]) sig("ma_align", -1, gap > 0.005 ? 0.6 : 0.4);
    }
  }

  // 5) 价格 vs MA20（实证反向：追高后 5 日偏跌、超跌后偏涨 → 均值回归逻辑）
  if (ma20[i] != null && ma60[i] != null) {
    if (c > ma20[i] && ma20[i] > ma60[i]) sig("price_ma20", -1, clampStrength((c / ma20[i] - 1) / 0.01));
    else if (c < ma20[i] && ma20[i] < ma60[i]) sig("price_ma20", 1, clampStrength((1 - c / ma20[i]) / 0.01));
  }

  // 6) 布林带：触及下轨（看多反转）/ 上轨（看空反转）（实证弱信息，强度弱化）
  if (bb.upper[i] != null && bb.lower[i] != null && bb.mid[i] != null) {
    if (c <= bb.lower[i] * 1.005) sig("bollinger", 1, 0.6);
    else if (c >= bb.upper[i] * 0.995) sig("bollinger", -1, 0.6);
    else if (c > bb.mid[i]) sig("bollinger", 1, 0.4);
    else sig("bollinger", -1, 0.4);
  }

  // 7) 量能（实证反向：放量上涨后偏跌、放量下跌后偏涨 → 冲高回落/恐慌见底）
  if (volMa20[i] != null && volumes[i] != null) {
    const vr = volMa20[i] > 0 ? volumes[i] / volMa20[i] : 1;
    const chg = i > 0 ? closes[i] / closes[i - 1] - 1 : 0;
    if (vr > 1.5 && chg > 0.005) sig("volume", -1, vr > 2 ? 0.8 : 0.6);
    else if (vr > 1.5 && chg < -0.005) sig("volume", 1, vr > 2 ? 0.8 : 0.6);
  }

  // 8) 动量 ROC(10)：阈值按波动率归一化（实证弱信息，强度弱化）
  if (roc10[i] != null) {
    const thr = normK * s * Math.sqrt(10);
    const v = roc10[i] / 100; // 百分比 → 小数
    if (v > thr) sig("momentum", 1, clampStrength(0.6 * (v / (2 * thr))));
    else if (v < -thr) sig("momentum", -1, clampStrength(0.6 * (-v / (2 * thr))));
  }

  // 9) 近 5 日走势：阈值按波动率归一化（实证方向正确，趋势延续）
  if (i >= 5) {
    const thr = normK * s * Math.sqrt(5);
    const r5 = closes[i] / closes[i - 5] - 1;
    if (r5 > thr) sig("trend_recent", 1, clampStrength(r5 / (2 * thr)));
    else if (r5 < -thr) sig("trend_recent", -1, clampStrength(-r5 / (2 * thr)));
  }

  // 10) ATR 波动状态（实证弱信息，强度弱化；方向仍跟随近期走势）
  if (atr14[i] != null && i >= 60) {
    const atr60 = mean(atr14.slice(i - 60, i + 1).filter((v) => v != null));
    if (atr60 > 0 && atr14[i] > atr60 * 1.2) {
      const r5 = i >= 5 ? closes[i] / closes[i - 5] - 1 : 0;
      sig("atr", r5 >= 0 ? 1 : -1, 0.6);
    }
  }

  // 11) 20 日动量 ROC(20)（曾按审计反向加入，但 walk-forward 回测证实无样本外贡献且与
  //     momentum/trend_recent 冗余，已移除——教训：全量审计≠样本外有效）

  // 12) 跳空 gap：开盘 vs 昨收（审计方向正确 spread +10%：跳空延续）
  if (i >= 1 && opens[i] > 0) {
    const gap = opens[i] / closes[i - 1] - 1;
    const thr = normK * s;
    if (gap > thr) sig("gap", 1, clampStrength(gap / (2 * thr)));
    else if (gap < -thr) sig("gap", -1, clampStrength(-gap / (2 * thr)));
  }

  // 13) 影线 wicks：长上影收跌（射击之星→看空）/ 长下影收涨（锤子线→看多）
  //     （审计方向正确 spread +13%：反转形态有效）
  if (opens[i] > 0 && highs[i] > lows[i]) {
    const range = highs[i] - lows[i];
    const body = closes[i] - opens[i];
    const upperWick = (highs[i] - Math.max(closes[i], opens[i])) / range;
    const lowerWick = (Math.min(closes[i], opens[i]) - lows[i]) / range;
    if (upperWick > 0.5 && body < 0) sig("wicks", -1, clampStrength((upperWick - 0.5) * 2));
    else if (lowerWick > 0.5 && body > 0) sig("wicks", 1, clampStrength((lowerWick - 0.5) * 2));
  }

  // 14) 连阳/连阴 streak（全量审计曾显示反向，反转后加入；但消融实验证实样本外为负贡献
  //     Brier 0.2780→0.2788，与 trend_recent 冗余，已移除）

  // 15) 缠论背驰：价格创 window 日新高但 DIF 动能低于前一高点 → 顶背驰（看空）；
  //     价格创新低但 DIF 高于前一低点 → 底背驰（看多）。捕捉其他信号未覆盖的"动能衰竭"维度。
  if (i >= 30 && dif[i] != null) {
    // 顶背驰
    let newHigh = true;
    for (let k = i - 30; k < i; k++) {
      if (closes[k] >= closes[i]) { newHigh = false; break; }
    }
    if (newHigh) {
      let si = -1;
      let sv = -Infinity;
      for (let k = i - 30; k < i; k++) {
        if (closes[k] > sv) { sv = closes[k]; si = k; }
      }
      if (si >= 0 && dif[si] != null && dif[i] < dif[si]) sig("divergence", -1, 1);
    } else {
      // 底背驰
      let newLow = true;
      for (let k = i - 30; k < i; k++) {
        if (closes[k] <= closes[i]) { newLow = false; break; }
      }
      if (newLow) {
        let si = -1;
        let sv = Infinity;
        for (let k = i - 30; k < i; k++) {
          if (closes[k] < sv) { sv = closes[k]; si = k; }
        }
        if (si >= 0 && dif[si] != null && dif[i] > dif[si]) sig("divergence", 1, 1);
      }
    }
  }

  // 16) 市场 beta 信号（已移除）：曾用"指数 5 日动量 × 个股 beta"预测个股方向，
  //     但 10 年消融证实样本外拖累（ΔBrier +0.0010，审计 spread -3.7% 反向）。
  //     教训：beta 反映的是同期共动（同一周内同涨跌），不等于"过去指数动量可预测未来个股方向"；
  //     5 日尺度上动量本身是反转的（与 streak/roc20 一致）。beta 因子的正确用法是
  //     预测"相对大盘的超额收益"（attachMarketContext 保留供该研究方向使用）。

  return out;
}

// ================= 经验似然比（四格表 + 时间衰减） =================

/**
 * 对历史窗口（截至 upToIndex）估计每个信号的双向似然比：
 *   LR_bull = P(看多信号|涨) / P(看多信号|跌)   —— 当前信号看多时使用
 *   LR_bear = P(看空信号|涨) / P(看空信号|跌)   —— 当前信号看空时使用
 * 时间衰减加权；拉普拉斯平滑。
 * @param {object} ind 预计算指标
 * @param {number} horizon 预测窗口（交易日）
 * @param {object} opts {warmup=70, halfLife=200, upToIndex}
 * @returns {Map<string, {lrBull, lrBear, nUp, nDown, hit, upRate}>}
 */
export function estimateLikelihoodRatios(ind, horizon, opts = {}) {
  const { closes } = ind;
  const warmup = opts.warmup ?? 70;
  const halfLife = opts.halfLife ?? 200;
  const maxI = Math.min(opts.upToIndex ?? closes.length - horizon - 1, closes.length - horizon - 1);
  const weights = timeWeights(closes.length, halfLife, maxI);
  const useExcess = opts.excess === true && ind.alignedIdx != null;
  const stats = new Map(); // key -> 四格表（加权）
  for (let i = warmup; i <= maxI; i++) {
    const up = useExcess ? excessUp(closes, ind.alignedIdx, i, horizon) : closes[i + horizon] > closes[i];
    if (up == null) continue; // 超额标签下指数对齐失败则跳过
    const w = weights[i];
    for (const { key, direction } of signalDirectionsAt(ind, i, opts)) {
      if (direction === 0) continue;
      let s = stats.get(key);
      if (!s) { s = { nUp: 0, nDown: 0, bullUp: 0, bullDown: 0, bearUp: 0, bearDown: 0 }; stats.set(key, s); }
      if (up) {
        s.nUp += w;
        if (direction > 0) s.bullUp += w; else s.bearUp += w;
      } else {
        s.nDown += w;
        if (direction > 0) s.bullDown += w; else s.bearDown += w;
      }
    }
  }
  const out = new Map();
  const shrinkK = opts.shrink ?? 20; // LR 向 1 的收缩强度（压制小样本噪声）
  const shrink = (lr, n) => (Number.isFinite(lr) && n > 0) ? 1 + (lr - 1) * (n / (n + shrinkK)) : 1;
  // 分层先验混合：LR_final = w·LR_个体 + (1-w)·LR_通用，w = n/(n+lrPriorStrength)
  const priorLR = opts.priorLR;
  const lrPriorStrength = opts.lrPriorStrength ?? 100;
  const mix = (lr, key, nSig, which) => {
    if (!priorLR) return lr;
    const pr = priorLR instanceof Map ? priorLR.get(key) : priorLR[key];
    const prLr = pr ? pr[which] : null;
    if (!Number.isFinite(prLr)) return lr;
    const w = nSig / (nSig + lrPriorStrength);
    return w * lr + (1 - w) * prLr;
  };
  for (const [key, s] of stats) {
    const nSig = s.nUp + s.nDown;
    const pBullUp = (s.bullUp + 1) / (s.nUp + 2);
    const pBullDown = (s.bullDown + 1) / (s.nDown + 2);
    const pBearUp = (s.bearUp + 1) / (s.nUp + 2);
    const pBearDown = (s.bearDown + 1) / (s.nDown + 2);
    out.set(key, {
      lrBull: mix(shrink(pBullDown <= 0 ? Infinity : pBullUp / pBullDown, nSig), key, nSig, "lrBull"),
      lrBear: mix(shrink(pBearDown <= 0 ? Infinity : pBearUp / pBearDown, nSig), key, nSig, "lrBear"),
      nUp: s.nUp,
      nDown: s.nDown,
      hit: s.bullUp + s.bullDown + s.bearUp + s.bearDown,
      upRate: s.nUp / (s.nUp + s.nDown),
    });
  }
  return out;
}

/**
 * 跨股票聚合经验似然比（横截面先验）：把多只股票的信号-收益四格表按时间衰减加权合并，
 * 得到比单股更稳定的通用 LR 表，可作为 analyzeStock 的 priorLR 传入（分层先验）。
 * @param {Array<Array>} klinesArray 多只股票的日 K 线数组
 * @param {object} opts {horizon=5, warmup=70, halfLife=200, shrink=20}
 * @returns {Map<string, {lrBull, lrBear, nUp, nDown, hit}>}
 */
export function aggregateLikelihoods(klinesArray, opts = {}) {
  const horizon = opts.horizon ?? 5;
  const warmup = opts.warmup ?? 70;
  const halfLife = opts.halfLife ?? 200;
  const shrinkK = opts.shrink ?? 20;
  const stats = new Map();
  for (const klines of klinesArray) {
    if (!Array.isArray(klines) || klines.length < warmup + horizon + 2) continue;
    const ind = computeIndicators(klines);
    const closes = ind.closes;
    const maxI = closes.length - horizon - 1;
    const weights = timeWeights(closes.length, halfLife, maxI);
    for (let i = warmup; i <= maxI; i++) {
      const up = closes[i + horizon] > closes[i];
      const w = weights[i];
      for (const { key, direction } of signalDirectionsAt(ind, i, opts)) {
        if (direction === 0) continue;
        let s = stats.get(key);
        if (!s) { s = { nUp: 0, nDown: 0, bullUp: 0, bullDown: 0, bearUp: 0, bearDown: 0 }; stats.set(key, s); }
        if (up) {
          s.nUp += w;
          if (direction > 0) s.bullUp += w; else s.bearUp += w;
        } else {
          s.nDown += w;
          if (direction > 0) s.bullDown += w; else s.bearDown += w;
        }
      }
    }
  }
  const out = new Map();
  const shrink = (lr, n) => (Number.isFinite(lr) && n > 0) ? 1 + (lr - 1) * (n / (n + shrinkK)) : 1;
  for (const [key, s] of stats) {
    const nSig = s.nUp + s.nDown;
    const pBullUp = (s.bullUp + 1) / (s.nUp + 2);
    const pBullDown = (s.bullDown + 1) / (s.nDown + 2);
    const pBearUp = (s.bearUp + 1) / (s.nUp + 2);
    const pBearDown = (s.bearDown + 1) / (s.nDown + 2);
    out.set(key, {
      lrBull: shrink(pBullDown <= 0 ? Infinity : pBullUp / pBullDown, nSig),
      lrBear: shrink(pBearDown <= 0 ? Infinity : pBearUp / pBearDown, nSig),
      nUp: s.nUp,
      nDown: s.nDown,
      hit: s.bullUp + s.bullDown + s.bearUp + s.bearDown,
    });
  }
  return out;
}

/** 按信号方向组装证据（含 strength 缩放后的 contribution）。 */
export function buildEvidence(signals, lrMap, maxLr = 4) {
  return signals.map((sig) => {
    const stat = lrMap.get(sig.key);
    const rawLr = stat ? (sig.direction > 0 ? stat.lrBull : stat.lrBear) : 1;
    const capped = Math.max(1 / maxLr, Math.min(maxLr, rawLr));
    const strength = sig.strength ?? 1;
    return {
      key: sig.key,
      direction: sig.direction,
      strength: Number(strength.toFixed(3)),
      lr: Number.isFinite(rawLr) ? Number(rawLr.toFixed(4)) : Number(capped.toFixed(4)),
      cappedLr: Number(capped.toFixed(4)),
      contribution: Number((Math.log(capped) * strength).toFixed(4)),
      samples: stat ? Math.round(stat.hit) : 0,
      upRate: stat ? stat.upRate : null,
      nUp: stat ? Math.round(stat.nUp) : 0,
      nDown: stat ? Math.round(stat.nDown) : 0,
      lrBull: stat && Number.isFinite(stat.lrBull) ? Number(stat.lrBull.toFixed(4)) : null,
      lrBear: stat && Number.isFinite(stat.lrBear) ? Number(stat.lrBear.toFixed(4)) : null,
    };
  });
}

// ================= 贝叶斯更新 =================

/**
 * odds 乘法贝叶斯更新（含信号强度缩放与 temperature scaling）。
 * temperature 只收缩证据贡献（修正相关信号过度自信），先验不被收缩。
 * @param {number} prior 先验概率 P(H)
 * @param {Array<{lr: number, strength?: number}>} entries 证据（lr 为当前方向的经验似然比）
 * @param {object} opts {maxLr=4, temperature=1}
 * @returns {{posterior: number, logOdds: number}}
 */
export function bayesianUpdate(prior, entries, opts = {}) {
  const maxLr = opts.maxLr ?? 4;
  const temperature = opts.temperature ?? 1;
  const logitPrior = Math.log(prior / (1 - prior));
  let total = 0;
  for (const e of entries) {
    const capped = Math.max(1 / maxLr, Math.min(maxLr, e.lr));
    total += Math.log(capped) * (e.strength ?? 1);
  }
  const posterior = 1 / (1 + Math.exp(-(logitPrior + total / temperature)));
  return { posterior, logOdds: total };
}

/** 后验的近似 95% 置信区间（正态近似，nEff 为有效样本量）。 */
function posteriorCI(p, nEff) {
  if (!nEff || nEff <= 0 || p <= 0 || p >= 1) return [p, p];
  const se = Math.sqrt(Math.max(p * (1 - p), 1e-9) / nEff);
  return [Math.max(0, p - 1.96 * se), Math.min(1, p + 1.96 * se)];
}

/** 评分 → 评级。 */
export function ratingOf(score) {
  return score >= 75 ? "强烈看多" : score >= 60 ? "看多" : score >= 50 ? "中性偏多" : score >= 40 ? "中性偏空" : score >= 25 ? "看空" : "强烈看空";
}

// ================= 趋势状态（贝叶斯三状态分类） =================

/**
 * 三状态贝叶斯趋势分类（贝叶斯 t 检验风格）：
 * 日收益 μ 的无信息先验后验为 μ|data ~ t_{n-1}(m, SE²)，SE = σ/√n（大样本正态近似）。
 * 有意义趋势阈值 δ = max(0.5·SE, 经济阈值)，经济阈值 = 年化目标收益的日当量，
 * 防止大样本下把微小 μ 判为显著趋势。
 * @param {number[]} returns 日收益序列（小数）
 * @param {object} opts {annualTrendThreshold=0.05}
 * @returns {{bull, flat, bear, state, mu, sigma, t}}
 */
export function trendState(returns, opts = {}) {
  const n = returns.length;
  if (n < 5) return { bull: 1 / 3, flat: 1 / 3, bear: 1 / 3, state: "flat", mu: 0, sigma: 0, t: 0 };
  const mu = mean(returns);
  const sigma = Math.max(stdev(returns, 0), 1e-9);
  const se = sigma / Math.sqrt(n);
  const annualTarget = opts.annualTrendThreshold ?? 0.05;
  const ecoDelta = Math.pow(1 + annualTarget, 1 / 252) - 1;
  const delta = Math.max(0.5 * se, ecoDelta);
  const pBull = 1 - normCdf((delta - mu) / se);
  const pBear = normCdf((-delta - mu) / se);
  const pFlat = 1 - pBull - pBear;
  const state = pBull >= pBear && pBull >= pFlat ? "bull" : pBear >= pFlat ? "bear" : "flat";
  return { bull: pBull, flat: pFlat, bear: pBear, state, mu, sigma, t: mu / se, delta };
}

// ================= 贝叶斯风险 =================

/**
 * 风险估计：EWMA 波动率（RiskMetrics λ=0.94）+ 经验分位数 VaR/CVaR（主）+ 正态近似（对照）。
 * @param {number[]} returns 日收益（小数）
 * @param {object} opts {horizon=1, alpha=0.95, lambda=0.94}
 */
export function bayesianRisk(returns, opts = {}) {
  const horizon = opts.horizon ?? 1;
  const alpha = opts.alpha ?? 0.95;
  const n = returns.length;
  if (n < 10) return null;
  const mu = mean(returns);
  const sigmaHat = stdev(returns, 1);
  const sigmaEwma = ewmaVolatility(returns, opts.lambda ?? 0.94);
  const s = Math.max(sigmaEwma, sigmaHat * 0.5) * Math.sqrt((n + 1) / n); // 预测尺度（EWMA 为主，防退化）
  const z = normInv(alpha);
  const muH = horizon * mu;
  const sH = Math.sqrt(horizon) * s;
  const varNormal = -(muH - z * sH);
  const cvarNormal = -(muH - sH * normPdf(z) / (1 - alpha));
  // 经验分位数（horizon 日滚动加总）
  const emp = [];
  if (returns.length >= horizon + 1) {
    for (let i = 0; i + horizon < returns.length; i++) {
      let acc = 1;
      for (let k = 0; k < horizon; k++) acc *= 1 + returns[i + k];
      emp.push(acc - 1);
    }
  }
  const varEmp = emp.length ? -quantile(emp, 1 - alpha) : NaN;
  const cvarEmp = emp.length
    ? -mean(emp.filter((r) => r <= quantile(emp, 1 - alpha)))
    : NaN;
  return {
    n,
    muDaily: mu,
    sigmaDaily: sigmaEwma,          // EWMA 波动率（主）
    sigmaDailySample: sigmaHat,     // 样本 σ（对照）
    sigmaAnnual: sigmaEwma * Math.sqrt(252),
    scale: s,
    var95_1d: -(mu - z * s),
    cvar95_1d: -(mu - s * normPdf(z) / (1 - alpha)),
    var95_h: varNormal,             // 正态近似（对照）
    cvar95_h: cvarNormal,
    var95_h_emp: varEmp,            // 经验分位数（主）
    cvar95_h_emp: cvarEmp,
    alpha,
    horizon,
  };
}

// ================= 加权先验 =================

/** 加权窗口胜率先验（shrunk 到 0.5，priorStrength 控制收缩强度）。excess=true 时用跑赢大盘标签。 */
function weightedPrior(closes, weights, horizon, windowStart, windowEnd, priorStrength = 30, ind = null, excess = false) {
  const useExcess = excess === true && ind && ind.alignedIdx != null;
  let wUp = 0;
  let wTot = 0;
  for (let i = windowStart; i + horizon <= windowEnd; i++) {
    const up = useExcess ? excessUp(closes, ind.alignedIdx, i, horizon) : closes[i + horizon] > closes[i];
    if (up == null) continue;
    wTot += weights[i];
    if (up) wUp += weights[i];
  }
  if (wTot <= 0) return 0.5;
  const rate = wUp / wTot;
  return (rate * wTot + 0.5 * priorStrength) / (wTot + priorStrength);
}

// ================= 单 horizon 分析 =================

/** 对单个 horizon 运行完整贝叶斯更新，返回该窗口的结果。 */
function runSingleHorizon(ind, opts, horizon) {
  const sampleWindow = opts.sampleWindow ?? Math.min(120, ind.closes.length);
  const maxLr = opts.maxLr ?? 4;
  const halfLife = opts.lrHalfLife ?? 200;
  const priorStrength = opts.priorStrength ?? 30;
  // 默认 T=3：回测校准显示 T=5 最优、T=1.5 过度自信，取折中保守值（证据贡献 /3）
  const temperature = opts.temperature ?? 3;
  const warmup = 70;
  const closes = ind.closes;
  const last = closes.length - 1;

  const useExcess = opts.excess === true && ind.alignedIdx != null;
  const lrMap = estimateLikelihoodRatios(ind, horizon, {
    warmup,
    halfLife,
    maxLr,
    ...(useExcess ? { excess: true } : {}),
    ...(opts.priorLR !== void 0 ? { priorLR: opts.priorLR } : {}),
    ...(opts.lrPriorStrength !== void 0 ? { lrPriorStrength: opts.lrPriorStrength } : {}),
  });
  const signals = signalDirectionsAt(ind, last, opts);
  const evidence = buildEvidence(signals, lrMap, maxLr);
  const weights = timeWeights(closes.length, halfLife, last);
  const windowStart = Math.max(0, last - Math.min(sampleWindow, last));
  const prior = opts.prior ?? weightedPrior(closes, weights, horizon, windowStart, last, priorStrength, ind, useExcess);
  const { posterior, logOdds } = bayesianUpdate(prior, evidence, { maxLr, temperature });
  const score = Math.round(posterior * 100);
  const rating = ratingOf(score);
  let nEff = 0;
  for (let i = windowStart; i + horizon <= last; i++) nEff += weights[i];
  const ci = posteriorCI(posterior, nEff);
  return { horizon, prior, posterior, logOdds, score, rating, signalCount: evidence.length, evidence, nEff, ci };
}

// ================= 主分析 =================

/**
 * 对一只股票做完整贝叶斯分析。
 * @param {Array<{date,open,close,high,low,volume}>} klines 日 K 线（升序）
 * @param {object} quote 实时行情（可选）
 * @param {object} opts {horizon=5, sampleWindow=120, maxLr=4, lrHalfLife=200, priorStrength=30,
 *   temperature=1.5, horizons=[2,5,10,20], normK=0.5, prior?}
 * @returns 结构化分析报告
 */
export function analyzeStock(klines, quote = {}, opts = {}) {
  const ind = computeIndicators(klines);
  if (Array.isArray(opts.marketKlines) && opts.marketKlines.length > 30) attachMarketContext(ind, opts.marketKlines);
  else if (Array.isArray(opts.benchmarkKlines) && opts.benchmarkKlines.length > 30) attachMarketContext(ind, opts.benchmarkKlines);
  const closes = ind.closes;
  if (closes.length < 10) throw new Error("K 线数据不足（少于 10 根）");
  const horizon = opts.horizon ?? 5;
  const main = runSingleHorizon(ind, opts, horizon);
  const sampleWindow = opts.sampleWindow ?? Math.min(120, closes.length);
  const returns = ind.returnsAt.slice(1).slice(-sampleWindow);

  // 多 horizon 对比
  const horizons = (opts.horizons ?? [2, 5, 10, 20]).filter((h) => Number.isInteger(h) && h >= 2 && h <= 30);
  const multiHorizon = horizons
    .map((h) => runSingleHorizon(ind, opts, h))
    .map((r) => ({
      horizon: r.horizon,
      prior: Number(r.prior.toFixed(4)),
      posterior: Number(r.posterior.toFixed(4)),
      score: r.score,
      rating: r.rating,
      signalCount: r.signalCount,
    }))
    .sort((a, b) => a.horizon - b.horizon);

  // 趋势与风险
  const trend = trendState(returns, opts);
  const risk = bayesianRisk(returns, { horizon, alpha: 0.95 });
  const mdd = maxDrawdown(closes.slice(-Math.min(250, closes.length)));

  // 归因（贡献绝对值 Top3）
  const attribution = [...main.evidence]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map((e) => ({ key: e.key, direction: e.direction, contribution: e.contribution }));

  // 基础统计
  const last = closes.length - 1;
  const lastPrice = closes[last];
  const px = (n) => (n >= 0 && n < closes.length ? closes[n] : null);
  const stats = {
    price: lastPrice,
    changePercent: quote && Number.isFinite(quote.changePercent) ? quote.changePercent : (closes[last] / closes[last - 1] - 1) * 100,
    ret5d: px(last - 5) ? (lastPrice / px(last - 5) - 1) * 100 : null,
    ret20d: px(last - 20) ? (lastPrice / px(last - 20) - 1) * 100 : null,
    ret60d: px(last - 60) ? (lastPrice / px(last - 60) - 1) * 100 : null,
    ma5: ind.ma5[last],
    ma10: ind.ma10[last],
    ma20: ind.ma20[last],
    ma60: ind.ma60[last],
    rsi14: ind.rsi14[last],
    roc10: ind.roc10[last],
    volRatio: ind.volMa20[last] && ind.volumes[last] ? ind.volumes[last] / ind.volMa20[last] : null,
    volatility20: returns.length >= 20 ? stdev(returns.slice(-20)) * Math.sqrt(252) * 100 : null,
    volatilityEwma: ewmaVolatility(returns) * Math.sqrt(252) * 100,
  };

  const excess = opts.excess === true && ind.alignedIdx != null;

  return {
    ok: true,
    horizon,
    label: excess ? "excess" : "abs",
    benchmark: excess ? "sh000300" : null,
    prior: Number(main.prior.toFixed(4)),
    posterior: Number(main.posterior.toFixed(4)),
    logOdds: Number(main.logOdds.toFixed(4)),
    score: main.score,
    rating: main.rating,
    signalCount: main.signalCount,
    evidence: main.evidence,
    multiHorizon,
    trend,
    risk,
    drawdown: { maxDrawdown: mdd.maxDrawdown, days: mdd.days },
    stats,
    attribution,
    calibration: {
      temperature: Number((opts.temperature ?? 3).toFixed(2)),
      effectiveSamples: Math.round(main.nEff),
      posteriorCI: main.ci.map((v) => Number(v.toFixed(4))),
    },
    klines: klines.slice(-60).map((k) => [k.date, k.close, k.high, k.low, k.open, k.volume]),
  };
}
