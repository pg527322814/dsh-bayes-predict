// dsh-bayes-predict / bayes.js —— 贝叶斯定理股票分析核心（v2 优化版）
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
// v3（卡尔曼增益）：
//  - kalmanLocalLinear：对数价格的局部线性趋势（LLT）状态空间滤波，提供趋势斜率 t 值
//    与标准化新息两个新信号（kalman_slope / kalman_innov）
//  - kalmanFuse：用卡尔曼增益 K=P⁻/(P⁻+R) 融合先验与证据，替代手调 temperature；
//    证据方差 R 由 LR 四格表计数经 Katz 对数风险比近似给出，后验方差有概率意义
// 纯 JS 实现，零第三方依赖。

import { kalmanLocalLinear, kalmanFuse, logLrVariance, priorVarianceOf } from "./kalman.js";

/**
 * 模型版本号：信号定义（signalDirectionsAt）、LR 估计方式、温度/先验等模型默认参数
 * 发生变更时必须递增——评分缓存（scores/h*.json）据此失效重建，避免新旧模型结果混用。
 * 1 → 2：新增卡尔曼滤波信号（kalman_slope / kalman_innov）与卡尔曼增益融合路径（fusion="kalman"）。
 */
export const MODEL_VERSION = 2;

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
export function computeIndicators(klines, opts = {}) {
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
  // 卡尔曼局部线性趋势滤波：一次 O(n) 前向递推，供 kalman_slope / kalman_innov 信号索引。
  // 必须在这里预计算——signalDirectionsAt 会被 LR 估计/审计/回测按每根 K 线各调一次，
  // 若把递推放进信号函数会退化成 O(n²)。
  const kf = kalmanLocalLinear(closes.map((c) => Math.log(Math.max(c, 1e-9))), opts.kalmanFilterOpts ?? {});
  return {
    dates, closes, opens, highs, lows, volumes, returnsAt, sigma20, sigma60, kf,
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
 * 卡尔曼信号默认参数（由 walk-forward 审计/回测标定，见 kalman-slope-config）。
 *  - KF_WARMUP：滤波器的 P 需要若干根 K 线收敛，之前不出信号（与 divergence 的 i>=30 同风格）
 *  - KF_SLOPE_T：斜率 t 值阈值。合成数据标定：无漂移股票 |t| 的 90/99 分位约 1.11/1.59，
 *    缓慢漂移股票约 1.41/2.66，故 ~1.2 是"既不常触发又能分辨趋势"的量级；真实数据审计后定稿。
 *  - KF_INNOV_Z：标准化新息阈值（|z| 超阈值＝价格显著偏离"趋势+随机游走"的一步预测）
 *  - slopeDir / innovDir：信号方向。+1 顺势、−1 反转。由**实盘信号审计**标定，不是拍脑袋：
 *    52 只沪深300 十年数据（12.3 万根 K 线）池化四格表显示——
 *      kalman_slope：看多时未来 5 日上涨率 46.86%、看空时 54.55%，spread = −7.69%（t=−8.21）
 *      kalman_innov：看多时 51.23%、看空时 48.65%，spread = +2.57%（t=+2.91）
 *    前者说明 5 日尺度上"滤波斜率看多"实际偏空（与 trend_recent/ma_align 同为均值回归），
 *    故 slopeDir=−1；后者说明"价格意外上冲"随后偏弱，反转方向成立，故 innovDir=−1。
 *    注意：经验似然比本身是双向的（LR_bull / LR_bear），会自动学到反向关系，
 *    因此方向常量主要影响 strength 的可读性与极端截断，不影响 LR 估计的正确性。
 */
export const KALMAN_PARAMS = {
  warmup: 30,
  slopeT: 1.2,
  innovZ: 1.5,
  slopeDir: -1,
  innovDir: -1,
  /** 证据相关性膨胀因子 γ：R_eff = γ·R（独立假设会低估观测方差）。由 walk-forward 标定。 */
  obsInflate: 2,
  /**
   * 两个卡尔曼信号是否默认参与证据融合。
   *
   * 默认 **false**——依据是 52 只沪深300 十年数据的样本外消融（T=1 口径）：
   *   加卡尔曼信号后 ΔBrier = +0.00026 ±0.00005（改善率仅 15.4%），即略微有害；
   *   进一步检验"是否只是与趋势类信号冗余"：先移除 trend_recent/ma_align 再加它们，
   *   ΔBrier 仍为 +0.00021（改善率 19.2%）→ **不是冗余问题，而是样本外没有边际价值**。
   * 这与仓库既有教训一致（roc20 / streak / beta 都因消融为负被移除）：
   * 全量审计的 spread 大（kalman_slope 在分段审计里 +6%~+14%，t 最高 5.87）
   * ≠ 样本外有边际贡献。需要研究时用 opts.kalmanSignals = true 打开。
   */
  signalsEnabled: false,
};

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

  // 17) 卡尔曼滤波斜率 kalman_slope：局部线性趋势（LLT）状态空间模型估计的趋势速度，
  //     用 t 值 = slope/√Var(slope) 做信噪比归一化。
  //     与 trend_recent（近 5 日收益）的区别：后者是噪声主导的原始动量，阈值虽按 σ 归一化，
  //     但单根收益的信噪比很低；滤波斜率在状态空间里显式建模"趋势 + 噪声"，由卡尔曼增益
  //     自动决定新数据该占多少权重，因此对噪声不敏感、且对趋势拐点响应更平滑。
  //     与 ma_align（均线排列，实测仅弱信息）的区别：斜率带模型内生的不确定性度量，
  //     跨股票、跨波动率可比，不需要额外经验阈值。
  const kf = ind.kf;
  const kalmanSignalsOn = opts.kalmanSignals ?? KALMAN_PARAMS.signalsEnabled;
  if (kf && kalmanSignalsOn && i >= (opts.kalmanWarmup ?? KALMAN_PARAMS.warmup)) {
    const tSlope = kf.slopeT[i];
    if (tSlope != null && Number.isFinite(tSlope)) {
      const thr = opts.kalmanSlopeT ?? KALMAN_PARAMS.slopeT;
      if (Math.abs(tSlope) > thr) {
        const dir = (tSlope > 0 ? 1 : -1) * (opts.kalmanSlopeDir ?? KALMAN_PARAMS.slopeDir);
        sig("kalman_slope", dir, clampStrength(Math.abs(tSlope) / (2 * thr)));
      }
    }

    // 18) 卡尔曼标准化新息 kalman_innov：价格相对"随机游走水平 + 慢变斜率"一步预测的
    //     意外程度 v/√S（S = P⁻ + R 为模型给出的预测方差）。捕捉其他信号未覆盖的维度：
    //     "价格相对自身趋势模型的突发事件"。阈值为无量纲 z 值，可直接跨股票比较。
    const zInnov = kf.innovZ[i];
    if (zInnov != null && Number.isFinite(zInnov)) {
      const thrZ = opts.kalmanInnovZ ?? KALMAN_PARAMS.innovZ;
      if (Math.abs(zInnov) > thrZ) {
        const dir = (zInnov > 0 ? 1 : -1) * (opts.kalmanInnovDir ?? KALMAN_PARAMS.innovDir);
        sig("kalman_innov", dir, clampStrength(Math.abs(zInnov) / (2 * thrZ)));
      }
    }
  }

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
    const rawBull = pBullDown <= 0 ? Infinity : pBullUp / pBullDown;
    const rawBear = pBearDown <= 0 ? Infinity : pBearUp / pBearDown;
    // 收缩/先验混合的实际权重，供对数方差的雅可比修正使用（与下面 shrink/mix 内部一致）
    const shrinkW = nSig > 0 ? nSig / (nSig + shrinkK) : 0;
    const mixW = priorLR ? nSig / (nSig + lrPriorStrength) : 1;
    out.set(key, {
      lrBull: mix(shrink(rawBull, nSig), key, nSig, "lrBull"),
      lrBear: mix(shrink(rawBear, nSig), key, nSig, "lrBear"),
      nUp: s.nUp,
      nDown: s.nDown,
      hit: s.bullUp + s.bullDown + s.bearUp + s.bearDown,
      upRate: s.nUp / (s.nUp + s.nDown),
      // 卡尔曼融合所需的观测方差 Var(log LR)（Katz 对数风险比近似 + 收缩雅可比）
      varBull: logLrVariance({ hitUp: s.bullUp, nUp: s.nUp, hitDown: s.bullDown, nDown: s.nDown, lrRaw: rawBull, shrinkW, mixW }),
      varBear: logLrVariance({ hitUp: s.bearUp, nUp: s.nUp, hitDown: s.bearDown, nDown: s.nDown, lrRaw: rawBear, shrinkW, mixW }),
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

/** 按信号方向组装证据（含 strength 缩放后的 contribution 与卡尔曼融合所需的观测方差）。 */
export function buildEvidence(signals, lrMap, maxLr = 4) {
  return signals.map((sig) => {
    const stat = lrMap.get(sig.key);
    const rawLr = stat ? (sig.direction > 0 ? stat.lrBull : stat.lrBear) : 1;
    const capped = Math.max(1 / maxLr, Math.min(maxLr, rawLr));
    const strength = sig.strength ?? 1;
    // Var(log LR)：由四格表计数给出（见 kalman.js/logLrVariance）。
    // 缺失时置 null，融合端会退回 defaultObsVar（保守：增益偏小、后验贴近先验）。
    const rawVar = stat ? (sig.direction > 0 ? stat.varBull : stat.varBear) : null;
    const varLogLr = Number.isFinite(rawVar) && rawVar > 0 ? Number(rawVar.toFixed(6)) : null;
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
      varLogLr,
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

// ================= 卡尔曼趋势诊断 =================

/**
 * 卡尔曼局部线性趋势滤波的当前状态快照（诊断用）。
 * 信号 kalman_slope / kalman_innov 即由 slopeT / innovZ 产生，故这里把中间量一并暴露，
 * 便于核对"为什么这根 K 线出了/没出信号"。
 * @param {object} ind computeIndicators 的结果
 * @param {number} i 索引（默认最后一根）
 */
export function kalmanSnapshot(ind, i = null) {
  const kf = ind && ind.kf;
  const n = ind && ind.closes ? ind.closes.length : 0;
  if (!kf || !n || !kf.slope) return null;
  const idx = i ?? n - 1;
  // 小量（如 qSlope ~1e-7）用定点会显示成 0，故按量级自动选择定点/科学计数
  const num = (v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const a = Math.abs(v);
    return a !== 0 && a < 1e-4 ? Number(v.toExponential(3)) : Number(v.toFixed(6));
  };
  const slope = kf.slope[idx];
  return {
    slope: num(slope),
    slopeT: num(kf.slopeT[idx]),
    slopeAnnualized: slope == null || !Number.isFinite(slope)
      ? null
      : Number(((Math.exp(slope * 252) - 1) * 100).toFixed(2)),
    innovZ: num(kf.innovZ[idx]),
    obsVar: num(kf.obsVarAt ? kf.obsVarAt[idx] : kf.obsVar),
    qSlope: num(kf.qSlope),
    thresholds: { slopeT: KALMAN_PARAMS.slopeT, innovZ: KALMAN_PARAMS.innovZ, innovDir: KALMAN_PARAMS.innovDir, warmup: KALMAN_PARAMS.warmup },
  };
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

/**
 * 加权窗口胜率先验（shrunk 到 0.5，priorStrength 控制收缩强度）。excess=true 时用跑赢大盘标签。
 * 同时返回有效样本量 nEff，供卡尔曼融合计算先验方差（收缩锚点 0.5 视作 priorStrength 次伪观测）。
 * @returns {{prior:number, rate:number, wTot:number, nEff:number}}
 */
function weightedPriorDetailed(closes, weights, horizon, windowStart, windowEnd, priorStrength = 30, ind = null, excess = false) {
  const useExcess = excess === true && ind && ind.alignedIdx != null;
  let wUp = 0;
  let wTot = 0;
  for (let i = windowStart; i + horizon <= windowEnd; i++) {
    const up = useExcess ? excessUp(closes, ind.alignedIdx, i, horizon) : closes[i + horizon] > closes[i];
    if (up == null) continue;
    wTot += weights[i];
    if (up) wUp += weights[i];
  }
  if (wTot <= 0) return { prior: 0.5, rate: 0.5, wTot: 0, nEff: priorStrength };
  const rate = wUp / wTot;
  return {
    prior: (rate * wTot + 0.5 * priorStrength) / (wTot + priorStrength),
    rate,
    wTot,
    nEff: wTot + priorStrength,
  };
}

/** 兼容旧调用：只取先验概率。 */
function weightedPrior(closes, weights, horizon, windowStart, windowEnd, priorStrength = 30, ind = null, excess = false) {
  return weightedPriorDetailed(closes, weights, horizon, windowStart, windowEnd, priorStrength, ind, excess).prior;
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
  const priorInfo = weightedPriorDetailed(closes, weights, horizon, windowStart, last, priorStrength, ind, useExcess);
  const prior = opts.prior ?? priorInfo.prior;

  // 融合层：默认走卡尔曼增益 K = P⁻/(P⁻+R) —— 观测方差 R 来自 LR 四格表（Katz 对数风险比
  // 近似）× 相关性膨胀 γ，先验方差来自先验有效样本量，因此收缩强度逐股逐日自适应
  // （等价 T_eff = 1/K = 1 + R/P⁻），无需手调常数。
  // 样本外实测（见 README「卡尔曼增益」章）：相对手调 T=3 的 Brier 改善 −0.0020
  // （400 只 2.4 年样本：89% 股票改善；52 只十年样本同向）。fusion="temperature" 可回退旧行为。
  let posterior;
  let logOdds;
  let appliedLogOdds;
  let kalman = null;
  if ((opts.fusion ?? "kalman") === "kalman" && opts.prior === void 0) {
    kalman = kalmanFuse(prior, evidence, {
      maxLr,
      priorVar: opts.priorVar ?? priorVarianceOf(prior, priorInfo.nEff),
      processVar: opts.kalmanProcessVar ?? 0,
      obsVarInflate: opts.kalmanObsInflate ?? KALMAN_PARAMS.obsInflate,
      ...(opts.kalmanDefaultObsVar !== void 0 ? { defaultObsVar: opts.kalmanDefaultObsVar } : {}),
    });
    posterior = kalman.posterior;
    logOdds = kalman.evidenceLogOdds;   // 原始证据和（与 backtest/evalAt 口径一致）
    appliedLogOdds = kalman.logOdds;    // 实际作用于先验的增量 K·y
  } else {
    ({ posterior, logOdds } = bayesianUpdate(prior, evidence, { maxLr, temperature }));
    // 注意：bayesianUpdate 返回的 logOdds 是**未收缩**的原始证据和（backtest 的温度网格依赖此口径），
    // 真正作用于先验的是 logOdds/T。两者都返回，报告层展示"实际增量"，避免把变化量夸大 T 倍。
    appliedLogOdds = logOdds / temperature;
  }

  const score = Math.round(posterior * 100);
  const rating = ratingOf(score);
  let nEff = 0;
  for (let i = windowStart; i + horizon <= last; i++) nEff += weights[i];
  const ci = kalman ? kalman.ci : posteriorCI(posterior, nEff);
  return {
    horizon, prior, posterior, logOdds, appliedLogOdds, score, rating, signalCount: evidence.length,
    evidence, nEff, ci, kalman, priorNEff: priorInfo.nEff,
  };
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
    // logOdds = **实际作用于先验的 log-odds 增量**（温度路径为 Σ/T，卡尔曼路径为 K·Σ）；
    // 未收缩的原始证据和另见 calibration.evidenceLogOdds
    logOdds: Number((main.appliedLogOdds ?? main.logOdds).toFixed(4)),
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
      fusion: main.kalman ? "kalman" : "temperature",
      temperature: Number((opts.temperature ?? 3).toFixed(2)),
      effectiveSamples: Math.round(main.nEff),
      priorNEff: Math.round(main.priorNEff),
      // 原始证据和（未收缩）与实得增量（已收缩）分开暴露，便于核对收缩强度
      evidenceLogOdds: Number(main.logOdds.toFixed(4)),
      appliedLogOdds: Number((main.appliedLogOdds ?? main.logOdds).toFixed(4)),
      posteriorCI: main.ci.map((v) => Number(v.toFixed(4))),
      // 卡尔曼融合诊断：卡尔曼增益 K、等价温度 T_eff=1/K、先验/观测/后验方差
      ...(main.kalman
        ? {
            kalmanGain: Number(main.kalman.K.toFixed(4)),
            effectiveTemperature: Number(Math.min(main.kalman.effectiveTemperature, 9999).toFixed(3)),
            priorVar: Number(main.kalman.priorVar.toFixed(4)),
            obsVar: Number(main.kalman.obsVar.toFixed(4)),
            stateVar: Number(main.kalman.stateVar.toFixed(4)),
          }
        : {}),
    },
    // 卡尔曼趋势滤波的当前状态（诊断用；信号 kalman_slope / kalman_innov 即由此产生）
    kalman: kalmanSnapshot(ind),
    klines: klines.slice(-60).map((k) => [k.date, k.close, k.high, k.low, k.open, k.volume]),
  };
}

// ================= walk-forward 回测与校准 =================

/**
 * 信号方向审计：对历史每个时刻统计每个信号"看多/看空时未来 N 日上涨频率"。
 * spread = 看多信号上涨率 - 看空信号上涨率；spread>0 表示信号方向正确，<0 表示系统性反向。
 * @param {Array} klines 日 K 线
 * @param {object} opts {horizon=5}
 * @returns {Array<{key, bullN, bullRate, bearN, bearRate, spread}>}
 */
export function auditSignals(klines, opts = {}) {
  const ind = computeIndicators(klines);
  if (Array.isArray(opts.marketKlines) && opts.marketKlines.length > 30) attachMarketContext(ind, opts.marketKlines);
  const horizon = opts.horizon ?? 5;
  const warmup = 70;
  const closes = ind.closes;
  const stats = Object.create(null);
  for (let i = warmup; i < closes.length - horizon; i++) {
    const up = closes[i + horizon] > closes[i];
    for (const { key, direction } of signalDirectionsAt(ind, i, opts)) {
      const s = stats[key] ?? (stats[key] = { bullN: 0, bullUp: 0, bearN: 0, bearUp: 0 });
      if (direction > 0) { s.bullN++; if (up) s.bullUp++; }
      else { s.bearN++; if (up) s.bearUp++; }
    }
  }
  return Object.entries(stats).map(([key, s]) => {
    const bullRate = s.bullN ? s.bullUp / s.bullN : null;
    const bearRate = s.bearN ? s.bearUp / s.bearN : null;
    return {
      key,
      bullN: s.bullN,
      bullRate: bullRate == null ? null : Number(bullRate.toFixed(4)),
      bearN: s.bearN,
      bearRate: bearRate == null ? null : Number(bearRate.toFixed(4)),
      spread: Number(((bullRate ?? 0.5) - (bearRate ?? 0.5)).toFixed(4)),
    };
  });
}

/**
 * walk-forward 回测：对每个历史时刻 t，只用 t 之前的数据估计 LR（严格防前视），
 * 计算先验、当前信号、后验，与真实结果对比。
 * 输出：Brier score / log-loss / 方向准确率 / 可靠性表 / 分级命中率 / 最优校准温度。
 * @param {Array<{date,open,close,high,low,volume}>} klines 日 K 线（升序，建议 ≥400 根）
 * @param {object} opts {horizon=5, warmup=90, halfLife=200, maxLr=4, priorStrength=30, sampleWindow=120, temperature=1.5}
 * @returns 回测报告
 */
export function backtest(klines, opts = {}) {
  const ind = computeIndicators(klines);
  if (Array.isArray(opts.marketKlines) && opts.marketKlines.length > 30) attachMarketContext(ind, opts.marketKlines);
  else if (Array.isArray(opts.benchmarkKlines) && opts.benchmarkKlines.length > 30) attachMarketContext(ind, opts.benchmarkKlines);
  const horizon = opts.horizon ?? 5;
  const warmup = Math.max(opts.warmup ?? 90, 70);
  const halfLife = opts.lrHalfLife ?? 200;
  const maxLr = opts.maxLr ?? 4;
  const priorStrength = opts.priorStrength ?? 30;
  const sampleWindow = opts.sampleWindow ?? 120;
  const closes = ind.closes;
  const n = closes.length;

  // 预计算每个历史时刻的信号与结果（一次 O(n)）
  const useExcess = opts.excess === true && ind.alignedIdx != null;
  const sigAt = [];
  const upAt = [];
  for (let i = warmup; i <= n - horizon - 1; i++) {
    sigAt.push(signalDirectionsAt(ind, i, opts));
    const up = useExcess ? excessUp(closes, ind.alignedIdx, i, horizon) : closes[i + horizon] > closes[i];
    upAt.push(up);
  }

  // 增量四格表（时间衰减用全局缩放：每步所有计数 × exp(-λ)，新样本权重 1）
  const lambda = Math.LN2 / halfLife;
  const stats = new Map();
  const touch = (key) => {
    let s = stats.get(key);
    if (!s) {
      s = { nUp: 0, nDown: 0, bullUp: 0, bullDown: 0, bearUp: 0, bearDown: 0 };
      stats.set(key, s);
    }
    return s;
  };
  const buildLRMap = () => {
    const out = new Map();
    const shrinkK = opts.shrink ?? 20;
    const shrink = (lr, m) => (Number.isFinite(lr) && m > 0) ? 1 + (lr - 1) * (m / (m + shrinkK)) : 1;
    const priorLR = opts.priorLR;
    const lrPriorStrength = opts.lrPriorStrength ?? 100;
    const mix = (lr, key, m, which) => {
      if (!priorLR) return lr;
      const pr = priorLR instanceof Map ? priorLR.get(key) : priorLR[key];
      const prLr = pr ? pr[which] : null;
      if (!Number.isFinite(prLr)) return lr;
      const w = m / (m + lrPriorStrength);
      return w * lr + (1 - w) * prLr;
    };
    for (const [key, s] of stats) {
      const m = s.nUp + s.nDown;
      if (m < 2) continue; // 样本太少不输出 LR（evidence 回退 lr=1）
      const pBullUp = (s.bullUp + 1) / (s.nUp + 2);
      const pBullDown = (s.bullDown + 1) / (s.nDown + 2);
      const pBearUp = (s.bearUp + 1) / (s.nUp + 2);
      const pBearDown = (s.bearDown + 1) / (s.nDown + 2);
      const rawBull = pBullDown <= 0 ? Infinity : pBullUp / pBullDown;
      const rawBear = pBearDown <= 0 ? Infinity : pBearUp / pBearDown;
      // 与 estimateLikelihoodRatios 保持一致：同样给出收缩/混合权重与对数方差，
      // 否则后测里的卡尔曼融合会因缺少 varLogLr 而退回兜底方差、增益被无谓压低。
      const shrinkW = m > 0 ? m / (m + shrinkK) : 0;
      const mixW = priorLR ? m / (m + lrPriorStrength) : 1;
      out.set(key, {
        lrBull: mix(shrink(rawBull, m), key, m, "lrBull"),
        lrBear: mix(shrink(rawBear, m), key, m, "lrBear"),
        nUp: s.nUp,
        nDown: s.nDown,
        hit: s.bullUp + s.bullDown + s.bearUp + s.bearDown,
        upRate: s.nUp / m,
        varBull: logLrVariance({ hitUp: s.bullUp, nUp: s.nUp, hitDown: s.bullDown, nDown: s.nDown, lrRaw: rawBull, shrinkW, mixW }),
        varBear: logLrVariance({ hitUp: s.bearUp, nUp: s.nUp, hitDown: s.bearDown, nDown: s.nDown, lrRaw: rawBear, shrinkW, mixW }),
      });
    }
    return out;
  };

  const preds = [];
  // 卡尔曼融合路径（可选用）：与 temperature 路径同源同证据，便于单手回测内做 A/B
  const useKalman = (opts.fusion ?? "kalman") === "kalman";
  const kPosts = [];
  const kGains = [];
  const kTEff = [];
  const kObsVar = [];
  const kPriorVar = [];
  for (let t = warmup; t <= n - horizon - 1; t++) {
    if (t > warmup) {
      const decay = Math.exp(-lambda);
      for (const s of stats.values()) {
        s.nUp *= decay;
        s.nDown *= decay;
        s.bullUp *= decay;
        s.bullDown *= decay;
        s.bearUp *= decay;
        s.bearDown *= decay;
      }
      const i = t - horizon;
      if (i >= warmup) {
        const sIdx = i - warmup;
        const up = upAt[sIdx];
        for (const { key, direction } of sigAt[sIdx]) {
          const st = touch(key);
          if (up) {
            st.nUp += 1;
            if (direction > 0) st.bullUp += 1; else st.bearUp += 1;
          } else {
            st.nDown += 1;
            if (direction > 0) st.bullDown += 1; else st.bearDown += 1;
          }
        }
      }
    }
    const lrMap = buildLRMap();
    const signals = signalDirectionsAt(ind, t, opts);
    const evidence = buildEvidence(signals, lrMap, maxLr);
    const weights = timeWeights(n, halfLife, t);
    const windowStart = Math.max(0, t - sampleWindow);
    const priorInfo = weightedPriorDetailed(closes, weights, horizon, windowStart, t, priorStrength, ind, useExcess);
    const prior = priorInfo.prior;
    const { posterior, logOdds } = bayesianUpdate(prior, evidence, { maxLr, temperature: 1 });
    if (useKalman) {
      const kfz = kalmanFuse(prior, evidence, {
        maxLr,
        priorVar: opts.priorVar ?? priorVarianceOf(prior, priorInfo.nEff),
        processVar: opts.kalmanProcessVar ?? 0,
        obsVarInflate: opts.kalmanObsInflate ?? KALMAN_PARAMS.obsInflate,
        ...(opts.kalmanDefaultObsVar !== void 0 ? { defaultObsVar: opts.kalmanDefaultObsVar } : {}),
      });
      kPosts.push(kfz.posterior);
      kGains.push(kfz.K);
      kTEff.push(kfz.effectiveTemperature);
      kObsVar.push(kfz.obsVar);
      kPriorVar.push(kfz.priorVar);
    }
    const actual = useExcess ? excessUp(closes, ind.alignedIdx, t, horizon) : closes[t + horizon] > closes[t];
    preds.push({ t, prior, posterior, logOdds, evidence, actual, up: actual ?? false, score: Math.round(posterior * 100) });
  }
  const m = preds.length;
  if (m < 20) return { horizon, n: m, note: "样本不足（回测需要更多历史数据）" };

  const baseRate = preds.filter((p) => p.up).length / m;
  const evalAt = (T) => {
    const posts = preds.map((p) => 1 / (1 + Math.exp(-(Math.log(p.prior / (1 - p.prior)) + p.logOdds / T))));
    const brier = mean(posts.map((p, i) => (p - (preds[i].up ? 1 : 0)) ** 2));
    const logLoss = mean(posts.map((p, i) => -(preds[i].up ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9)))));
    const accuracy = posts.filter((p, i) => (p >= 0.5) === preds[i].up).length / m;
    return { brier, logLoss, accuracy };
  };

  const atT1 = evalAt(1);
  // 生产口径：手调 temperature（默认 3）。这是**无前视**的真实对手——
  // atBestTemperature 是事后在这段样本上挑的最优值，生产里拿不到，只能作为上界参考。
  const prodT = opts.productionTemperature ?? 3;
  const atProd = evalAt(prodT);
  // 先验基线：只用先验概率、完全忽略证据。用于回答"模型到底有没有预测力"，
  // 而不是只跟 atTemperature1 比（后者在证据无信息时反而比基准率更差）。
  const upVec = preds.map((p) => (p.up ? 1 : 0));
  const priorOnly = {
    brier: mean(preds.map((p, i) => (p.prior - upVec[i]) ** 2)),
    logLoss: mean(preds.map((p, i) => -(upVec[i] ? Math.log(Math.max(p.prior, 1e-9)) : Math.log(Math.max(1 - p.prior, 1e-9))))),
    accuracy: preds.filter((p) => (p.prior >= 0.5) === p.up).length / m,
  };
  // 温度网格校准（选 log-loss 最小）
  let bestT = 1;
  let bestScore = atT1.logLoss;
  const grid = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5];
  for (const T of grid) {
    const ll = evalAt(T).logLoss;
    if (ll < bestScore) { bestScore = ll; bestT = T; }
  }
  const atBest = evalAt(bestT);

  // 卡尔曼融合路径评估：与 atTemperature1 使用完全相同的 prior 与 evidence，
  // 因此两者的 Brier/logLoss 差异只归因于"融合方式"，可直接比较。
  let kalman = null;
  if (useKalman && kPosts.length === m) {
    const kUp = preds.map((p) => (p.up ? 1 : 0));
    const kBrier = mean(kPosts.map((p, i) => (p - kUp[i]) ** 2));
    const kLogLoss = mean(kPosts.map((p, i) => -(kUp[i] ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9)))));
    const kAcc = kPosts.filter((p, i) => (p >= 0.5) === preds[i].up).length / m;
    kalman = {
      brier: Number(kBrier.toFixed(4)),
      logLoss: Number(kLogLoss.toFixed(4)),
      accuracy: Number(kAcc.toFixed(4)),
      meanGain: Number(mean(kGains).toFixed(4)),
      // T_eff = 1/K 的分布：旧模型把它当成常数 3（即假设 R/P⁻=2）
      effectiveTemperature: {
        p10: Number(quantile(kTEff, 0.1).toFixed(3)),
        p50: Number(quantile(kTEff, 0.5).toFixed(3)),
        p90: Number(quantile(kTEff, 0.9).toFixed(3)),
      },
      // 观测方差 R 与先验方差 P⁻ 的分布：用于核对"增益为什么这么小"
      obsVar: { p10: Number(quantile(kObsVar, 0.1).toFixed(4)), p50: Number(quantile(kObsVar, 0.5).toFixed(4)), p90: Number(quantile(kObsVar, 0.9).toFixed(4)) },
      priorVar: { p10: Number(quantile(kPriorVar, 0.1).toFixed(4)), p50: Number(quantile(kPriorVar, 0.5).toFixed(4)), p90: Number(quantile(kPriorVar, 0.9).toFixed(4)) },
    };
  }

  // 可靠性表（10 桶）
  const buckets = Array.from({ length: 10 }, () => ({ cnt: 0, sum: 0, pos: 0 }));
  for (const p of preds) {
    const b = Math.min(9, Math.floor(p.posterior * 10));
    buckets[b].cnt++;
    buckets[b].sum += p.posterior;
    if (p.up) buckets[b].pos++;
  }
  const reliability = buckets
    .map((bk, i) => ({
      lo: i / 10,
      hi: (i + 1) / 10,
      cnt: bk.cnt,
      avgPred: bk.cnt ? Number((bk.sum / bk.cnt).toFixed(3)) : null,
      actualRate: bk.cnt ? Number((bk.pos / bk.cnt).toFixed(3)) : null,
    }))
    .filter((b) => b.cnt > 0);

  // 分级命中率
  const ratingStats = {};
  for (const p of preds) {
    const r = ratingOf(p.score);
    (ratingStats[r] ??= { cnt: 0, pos: 0 });
    ratingStats[r].cnt++;
    if (p.up) ratingStats[r].pos++;
  }
  for (const r of Object.keys(ratingStats)) {
    ratingStats[r].hitRate = Number((ratingStats[r].pos / ratingStats[r].cnt).toFixed(4));
  }

  return {
    horizon,
    n: m,
    baseRate: Number(baseRate.toFixed(4)),
    atTemperature1: { ...atT1, brier: Number(atT1.brier.toFixed(4)), logLoss: Number(atT1.logLoss.toFixed(4)), accuracy: Number(atT1.accuracy.toFixed(4)) },
    priorOnly: {
      brier: Number(priorOnly.brier.toFixed(4)),
      logLoss: Number(priorOnly.logLoss.toFixed(4)),
      accuracy: Number(priorOnly.accuracy.toFixed(4)),
    },
    productionTemperature: prodT,
    atProductionTemperature: {
      ...atProd,
      brier: Number(atProd.brier.toFixed(4)),
      logLoss: Number(atProd.logLoss.toFixed(4)),
      accuracy: Number(atProd.accuracy.toFixed(4)),
    },
    bestTemperature: bestT,
    atBestTemperature: { ...atBest, brier: Number(atBest.brier.toFixed(4)), logLoss: Number(atBest.logLoss.toFixed(4)), accuracy: Number(atBest.accuracy.toFixed(4)) },
    kalman,
    reliability,
    ratingStats,
  };
}
