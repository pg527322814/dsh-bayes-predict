// dsh-plugin-stock-bayes / lib/kalman.js
// 卡尔曼滤波模块（自包含，无外部依赖，与 bayes.js 无循环引用）：
//   1) kalmanLocalLinear   对数价格的局部线性趋势（LLT）状态空间滤波 → 滤波斜率 + 标准化新息
//   2) kalmanFuse          用卡尔曼增益做证据融合，替代手调 temperature
//   3) kalmanFilterSeries  一维随机游走状态的通用递推（多根证据序列用）
//   4) logLrVariance       经验似然比的对数方差（Katz 对数风险比法 + 收缩雅可比修正）
//
// 设计约束（与仓库既有纪律一致）：
//   - 只做前向递推（因果），**绝不使用 RTS 平滑**——平滑器会用到未来观测，
//     把前视泄漏进 estimateLikelihoodRatios 的经验四格表，导致样本外虚高。
//   - 滤波器必须预计算（computeIndicators 里一次 O(n)），不能放进 signalDirectionsAt，
//     因为后者被 LR 估计/审计/回测按每根 K 线调用一次（否则 O(n²)）。
//   - 所有可调参数都有数据驱动的默认值，便于先跑基线再决定是否调参。

const EPS = 1e-12;

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs, ddof = 0) {
  const n = xs.length;
  if (n <= ddof) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - ddof);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampP = (p) => clamp(p, 1e-6, 1 - 1e-6);
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

// ================= 1) 局部线性趋势（LLT）滤波 =================

/**
 * 对数价格的局部线性趋势模型（Harvey 1989 的 local linear trend）：
 *   观测： y_t = level_t + ε_t,        ε ~ N(0, R)          （y = log 收盘价）
 *   状态： level_t = level_{t-1} + slope_{t-1} + η_t,  η ~ N(0, qLevel)
 *          slope_t = slope_{t-1} + ζ_t,                 ζ ~ N(0, qSlope)
 * 转移矩阵 F=[[1,1],[0,1]]，观测矩阵 H=[1,0]。
 *
 * 参数化（默认值由合成数据标定，见 kalman-work/diag-params.mjs）：
 *   R_obs  = obsVarRatio  × base   （base = 因果滚动收益方差；默认比 0.05）
 *   qLevel = qLevelRatio  × base   （默认比 1.0）
 *   qSlope = qLevel / hpLambda     （默认 λ=1600，日频经典值）
 *
 * 为什么不是"HP 等价"（qLevel=0、R_obs=收益方差）：HP 型设定假设收益里有一半是
 * 会回归的观测噪声，而**股票价格的日波动基本是永久性的随机游走步长，观测噪声≈0**。
 * 合成数据标定显示 HP 型设定下标准化新息的 sd 达 1.50（新息方差被低估 50%），
 * 因为它过度平滑；改用"水平为随机游走（qLevel=base）+ 极小观测噪声"后
 * sd 落到 0.985（纯随机游走）/ 0.948（缓慢漂移随机游走），标定正确。
 * 实测 λ 在 100/400/1600 之间对 sd 影响 < 6%，模型对该旋钮稳健。
 *
 * 输出（全部为**滤波**值，非平滑值）：
 *   level[i]      滤波后的对数趋势水平
 *   slope[i]      滤波后的趋势斜率（每日对数收益/天），>0 表示上行趋势
 *   slopeVar[i]   斜率的滤波方差 P_ss
 *   slopeT[i]     斜率 t 值 = slope / sqrt(slopeVar)，量纲无关的显著性度量
 *   innov[i]      新息 v = y - level⁻（实际价格相对一步预测的偏离）
 *   innovVar[i]   新息方差 S = P_ll⁻ + R_obs
 *   innovZ[i]     标准化新息 v / sqrt(S)（标定正确时近似标准正态）
 *   obsVarAt[i]   该根使用的观测噪声 R_obs（随滚动波动率变化，因果）
 * @param {number[]} logPrices 对数价格序列（升序）
 * @param {object} opts {obsVarRatio=0.05, qLevelRatio=1, hpLambda=1600, varWindow=60,
 *                       baseVar, obsVar, qLevel, qSlope, initVar}
 */
export function kalmanLocalLinear(logPrices, opts = {}) {
  const n = logPrices.length;
  const out = {
    level: new Array(n).fill(null),
    slope: new Array(n).fill(null),
    slopeVar: new Array(n).fill(null),
    slopeT: new Array(n).fill(null),
    innov: new Array(n).fill(null),
    innovVar: new Array(n).fill(null),
    innovZ: new Array(n).fill(null),
    obsVarAt: new Array(n).fill(null),
    obsVar: 0,
    qSlope: 0,
    qLevel: 0,
  };
  if (n < 3) return out;

  const diffs = new Array(n - 1);
  for (let i = 1; i < n; i++) diffs[i - 1] = logPrices[i] - logPrices[i - 1];

  const explicitObsVar = Number.isFinite(opts.obsVar) && opts.obsVar > 0 ? opts.obsVar : null;
  const explicitQLevel = Number.isFinite(opts.qLevel) && opts.qLevel >= 0 ? opts.qLevel : null;
  const explicitQSlope = Number.isFinite(opts.qSlope) && opts.qSlope >= 0 ? opts.qSlope : null;
  const baseVarOpt = Number.isFinite(opts.baseVar) && opts.baseVar > 0 ? opts.baseVar : null;
  const obsVarRatio = opts.obsVarRatio ?? 0.05;
  const qLevelRatio = opts.qLevelRatio ?? 1;
  const varWindow = Math.max(opts.varWindow ?? 60, 5);
  const hpLambda = Math.max(opts.hpLambda ?? 1600, 1);

  // 因果滚动方差（滑动窗口增量维护，O(1)/步）
  let winSum = 0;
  let winSumSq = 0;
  let winCnt = 0;
  const rollingVar = (i) => {
    if (i > 0) {
      const d = diffs[i - 1];
      winSum += d;
      winSumSq += d * d;
      winCnt++;
      if (winCnt > varWindow) {
        const old = diffs[i - 1 - varWindow];
        winSum -= old;
        winSumSq -= old * old;
        winCnt--;
      }
    }
    if (winCnt < 5) return null;
    const m = winSum / winCnt;
    return Math.max(winSumSq / winCnt - m * m, EPS);
  };

  // 初始状态：水平取首观测，斜率取首个差分；初始方差按观测噪声量级（P 随递推迅速收敛）
  const scale0 = baseVarOpt ?? Math.max(diffs[0] * diffs[0], EPS);
  let level = logPrices[0];
  let slope = diffs[0];
  let p11 = opts.initVar ?? Math.max(obsVarRatio * scale0, EPS);
  let p12 = 0;
  let p22 = Math.max(qLevelRatio * scale0, EPS);
  let lastBase = scale0;
  let lastObsVar = explicitObsVar ?? obsVarRatio * scale0;
  let lastQLevel = explicitQLevel ?? qLevelRatio * scale0;
  let lastQSlope = explicitQSlope ?? lastQLevel / hpLambda;

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // 因果尺度：只用截至 i 的滚动窗口估计波动水平
      const rv = rollingVar(i);
      const base = baseVarOpt ?? rv ?? lastBase;
      const obsVar = explicitObsVar ?? obsVarRatio * base;
      const qLevel = explicitQLevel ?? qLevelRatio * base;
      const qSlope = explicitQSlope ?? qLevel / hpLambda;
      lastBase = base;
      lastObsVar = obsVar;
      lastQLevel = qLevel;
      lastQSlope = qSlope;

      // ---- 预测 ----
      const levelMinus = level + slope;
      const slopeMinus = slope;
      const p11Minus = p11 + 2 * p12 + p22 + qLevel;
      const p12Minus = p12 + p22;
      const p22Minus = p22 + qSlope;

      // ---- 更新（观测 y_i，H=[1,0]） ----
      const y = logPrices[i];
      const v = y - levelMinus;                   // 新息
      const S = Math.max(p11Minus + obsVar, EPS);  // 新息方差
      const k1 = p11Minus / S;                    // 水平增益
      const k2 = p12Minus / S;                    // 斜率增益（卡尔曼增益的第二分量）
      level = levelMinus + k1 * v;
      slope = slopeMinus + k2 * v;
      // P = (I - K H) P⁻，该结构下仍对称
      const p11New = (1 - k1) * p11Minus;
      const p12New = p12Minus - k2 * p11Minus;
      const p22New = p22Minus - k2 * p12Minus;
      p11 = Math.max(p11New, EPS);
      p12 = p12New;
      p22 = Math.max(p22New, EPS);

      out.innov[i] = v;
      out.innovVar[i] = S;
      out.innovZ[i] = v / Math.sqrt(S);
      out.obsVarAt[i] = obsVar;
    }
    out.level[i] = level;
    out.slope[i] = slope;
    out.slopeVar[i] = p22;
    out.slopeT[i] = p22 > EPS ? slope / Math.sqrt(p22) : 0;
  }
  out.obsVar = lastObsVar;
  out.qSlope = lastQSlope;
  out.qLevel = lastQLevel;
  return out;
}

// ================= 2) 卡尔曼增益证据融合 =================

/**
 * 用卡尔曼增益融合先验与证据，替代手调 temperature。
 *
 * 模型：把潜在 log-odds（对数几率）z 视为待估状态，先验给出 z 的先验分布
 *       z ~ N(logit(prior), priorVar)，证据给出对 z 的一次含噪观测
 *       y = Σ_k log(LR_k)·strength_k，观测方差 R = Σ_k strength_k²·Var(log LR_k)。
 * 递推：P⁻ = priorVar + q；K = P⁻/(P⁻ + R)；z = logit(prior) + K·y；P = (1−K)·P⁻。
 *
 * 与旧实现的关系（等价性，便于对照）：
 *   旧式 posterior = sigmoid(logit(prior) + y/T)，即对证据做 1/T 的固定收缩；
 *   卡尔曼形式等价于 **T_eff = 1/K = 1 + R/P⁻**，即"观测方差 / 先验方差"——由数据决定，
 *   逐股逐日自适应：证据样本少或分散（R 大）→ K 小 → 后验贴住先验；
 *   先验弱（priorVar 大）→ K→1 → 退化为 T=1 的纯证据模型。
 *   当 R = 2·P⁻ 时 K = 1/3，T_eff = 3 —— 正好是代码里手调的 T=3 所隐含的假设。
 *
 * 相比 posteriorCI(p, nEff)：这里的证据方差来自四格表计数的 Katz 对数风险比近似，
 * 后验方差 P 是滤波器给出的真实状态方差，因此置信区间有概率意义（logit 正态近似）。
 *
 * @param {number} prior 先验概率 P(H)
 * @param {Array<{lr:number, strength?:number, varLogLr?:number}>} entries 证据
 * @param {object} opts {maxLr=4, priorVar, priorN, processVar=0, defaultObsVar=0.25}
 * @returns {{posterior, logOdds, prior, K, effectiveTemperature, priorVar, stateVar, obsVar, innovation, ci}}
 */
export function kalmanFuse(prior, entries, opts = {}) {
  const maxLr = opts.maxLr ?? 4;
  const p = clampP(prior);
  const zPrior = logit(p);

  // 先验状态方差：优先显式给，其次由先验的有效样本量经 delta 方法给出
  // Var(logit(p̂)) ≈ 1/(n·p(1−p))（p̂ 为 n 次独立试验的胜率）
  let priorVar = opts.priorVar;
  if (!Number.isFinite(priorVar) || priorVar <= 0) {
    const nPrior = opts.priorN ?? 0;
    priorVar = nPrior > 0 ? 1 / Math.max(nPrior * p * (1 - p), EPS) : (opts.defaultPriorVar ?? 1);
  }

  // 证据：观测值 y 与观测方差 R
  let y = 0;
  let r = 0;
  const fallbackVar = opts.defaultObsVar ?? 0.25; // 无四格表信息时的兜底方差（LR≈1.65 的尺度）
  // 证据相关性膨胀因子：各信号彼此相关（同源价格、同一时间段），独立假设会**低估**观测方差、
  // 从而高估证据精度（增益偏大）。用 γ 把 R 放大 γ 倍来修正，γ 由 walk-forward 标定。
  const inflate = Number.isFinite(opts.obsVarInflate) && opts.obsVarInflate > 0 ? opts.obsVarInflate : 1;
  for (const e of entries) {
    const capped = clamp(e.lr, 1 / maxLr, maxLr);
    const s = e.strength ?? 1;
    const logLr = Math.log(capped);
    // 零信息证据（LR=1：历史样本不足、或该信号与本股无关）既不加观测值、也不加观测方差。
    // 若把它们的方差也算进去，等于凭空注入不确定性，会把卡尔曼增益无谓压向 0——
    // 实测在后测里会把 T_eff 中位数从 ~2.5 抬到 ~22（即几乎完全忽略所有证据）。
    if (Math.abs(logLr) < 1e-9) continue;
    y += logLr * s;
    const v = Number.isFinite(e.varLogLr) && e.varLogLr > 0 ? e.varLogLr : fallbackVar;
    r += s * s * v * inflate;
  }
  if (!Number.isFinite(y)) y = 0;
  if (!Number.isFinite(r) || r <= 0) r = fallbackVar * inflate;

  const processVar = opts.processVar ?? 0; // 单快照无时间流逝 → 过程噪声 0
  const pMinus = priorVar + processVar;
  const K = pMinus / (pMinus + r); // ← 卡尔曼增益

  const z = zPrior + K * y;
  const stateVar = (1 - K) * pMinus;
  const posterior = sigmoid(z);

  const se = Math.sqrt(Math.max(stateVar, 0));
  return {
    posterior,
    logOdds: z - zPrior,      // 与旧 logOdds 字段口径一致：证据带来的 log-odds 增量
    evidenceLogOdds: y,
    prior: p,
    K,
    effectiveTemperature: K > EPS ? 1 / K : Infinity,
    priorVar,
    stateVar,
    obsVar: r,
    obsVarInflate: inflate,
    innovation: y,
    ci: [sigmoid(z - 1.96 * se), sigmoid(z + 1.96 * se)],
  };
}

/**
 * 一维随机游走状态的通用卡尔曼递推（把"逐根 K 线的证据"当观测序列）：
 *   状态 z_t = z_{t-1} + w, w ~ N(0, q)；观测 y_t = z_t + v, v ~ N(0, r_t)
 * 用途：多根证据累积（kalmanBars>1）时把散乱的单根证据平滑成稳定的后验轨迹。
 * @param {Array<{y:number, r:number}>} obs 观测序列
 * @param {object} opts {z0, p0, q}
 * @returns {{z:number[], P:number[], K:number[]}}
 */
export function kalmanFilterSeries(obs, opts = {}) {
  const q = opts.q ?? 0;
  let z = opts.z0 ?? 0;
  let P = opts.p0 ?? 1;
  const out = { z: [], P: [], K: [] };
  for (const o of obs) {
    const pMinus = P + q;
    const r = Number.isFinite(o.r) && o.r > 0 ? o.r : EPS;
    const K = pMinus / (pMinus + r);
    z = z + K * (o.y - z);
    P = (1 - K) * pMinus;
    out.z.push(z);
    out.P.push(P);
    out.K.push(K);
  }
  return out;
}

// ================= 3) 似然比的对数方差 =================

/**
 * 经验似然比的对数方差：Katz 对数风险比（log risk ratio）近似 + 收缩/先验混合的雅可比修正。
 *
 * 四格表：某方向信号出现 n 次，其中未来上涨 hitUp 次、下跌 hitDown 次（均带时间衰减权重），
 * 拉普拉斯平滑后 p1=(hitUp+1)/(nUp+2)、p2=(hitDown+1)/(nDown+2)，LR = p1/p2，
 *   Var(log LR) ≈ (1−p1)/((nUp+2)·p1) + (1−p2)/((nDown+2)·p2)
 * 该式在小样本时自然放大（LR 不可信 → 观测方差大 → 卡尔曼增益小），正是需要的性质。
 *
 * 仓库里的 LR 还会经过 soft 收缩 LR_s = 1+(LR−1)·w 与分层先验混合 LR_m = w_m·LR_s+(1−w_m)·LR_p，
 * 两者都改变了对数尺度上的方差，按链式法则各乘一个雅可比：
 *   d log(LR_s)/d log(LR) = w·LR / LR_s
 *   d log(LR_m)/d log(LR_s) = w_m·LR_s / LR_m
 * @param {object} c {hitUp, nUp, hitDown, nDown, lrRaw, shrinkW=1, mixW=1}
 * @returns {number} Var(log LR)（下限 1e-3，避免零方差导致增益恒为 1）
 */
export function logLrVariance(c) {
  const nUp = Math.max(c.nUp ?? 0, 0) + 2;
  const nDown = Math.max(c.nDown ?? 0, 0) + 2;
  const p1 = (Math.max(c.hitUp ?? 0, 0) + 1) / nUp;
  const p2 = (Math.max(c.hitDown ?? 0, 0) + 1) / nDown;
  let v = (1 - p1) / (nUp * p1) + (1 - p2) / (nDown * p2);
  if (!Number.isFinite(v) || v < 0) v = 1;
  const lrRaw = c.lrRaw;
  const shrinkW = clamp(c.shrinkW ?? 1, 0, 1);
  if (Number.isFinite(lrRaw) && lrRaw > 0 && shrinkW < 1) {
    const lrS = 1 + (lrRaw - 1) * shrinkW;
    if (lrS > EPS) v *= (shrinkW * lrRaw / lrS) ** 2;
  }
  const mixW = clamp(c.mixW ?? 1, 0, 1);
  if (mixW < 1 && Number.isFinite(lrRaw) && lrRaw > 0) {
    // 混合后 LR 落在 [1, LR_s] 区间内；用 w_m 作为对数尺度导数的近似（保守：不下调过多）
    v *= mixW ** 2 + (1 - mixW) ** 2;
  }
  return Math.max(v, 1e-3);
}

// ================= 4) 先验方差工具 =================

/** 由胜率先验的有效试验次数 n 计算 logit 尺度先验方差（delta 方法）。 */
export function priorVarianceOf(prior, nEff) {
  const p = clampP(prior);
  if (!(nEff > 0)) return 1;
  return 1 / Math.max(nEff * p * (1 - p), EPS);
}

export const kalmanInternals = { mean, variance, logit, sigmoid, clamp };
