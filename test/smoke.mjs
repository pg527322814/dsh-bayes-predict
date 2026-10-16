// dsh-bayes-predict / test/smoke.mjs
// 插件级冒烟：默认路径（卡尔曼融合 + 卡尔曼信号关闭）、回退路径、回测新字段、报告结构完整性。
// 运行：npm test（或 node test/kalman.test.mjs && node test/smoke.mjs）
import assert from "node:assert/strict";
import {
  sma,
  quantile,
  maxDrawdown,
  ewmaVolatility,
  timeWeights,
  ratingOf,
  bayesianRisk,
  aggregateLikelihoods,
  computeIndicators,
  signalDirectionsAt,
  estimateLikelihoodRatios,
  buildEvidence,
  bayesianUpdate,
  trendState,
  analyzeStock,
  auditSignals,
  backtest,
  kalmanSnapshot,
  KALMAN_PARAMS,
  MODEL_VERSION,
} from "../lib/bayes.js";

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { const u1 = Math.max(rand(), 1e-12), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };

function synthKlines(n) {
  const out = [];
  let price = 100;
  let drift = 0;
  let d = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    if (i % 150 === 0) drift = (rand() - 0.45) * 0.004;
    d += 86400000;
    const ret = drift + gauss() * 0.02;
    const open = price;
    price = Math.max(price * (1 + ret), 1);
    out.push({
      date: new Date(d).toISOString().slice(0, 10),
      open,
      close: price,
      high: Math.max(open, price) * (1 + rand() * 0.01),
      low: Math.min(open, price) * (1 - rand() * 0.01),
      volume: 1e6 * (0.5 + rand()),
    });
  }
  return out;
}

// ---- 基础工具 ----
const s = sma([1, 2, 3, 4, 5], 3);
assert.equal(s[2], 2);
assert.equal(s[3], 3);
assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
ok(maxDrawdown([10, 12, 9, 11]).maxDrawdown < 0, "最大回撤应为负值");
assert.equal(bayesianUpdate(0.5, []).posterior, 0.5);
assert.equal(bayesianUpdate(0.5, [{ lr: 1 }]).posterior, 0.5);
ok(bayesianUpdate(0.5, [{ lr: 4 }]).posterior > 0.5, "LR>1 应抬高后验");
assert.equal(trendState([0.01]).state, "flat");

// ---- 模型默认口径 ----
assert.equal(MODEL_VERSION, 2);
assert.equal(KALMAN_PARAMS.signalsEnabled, false, "卡尔曼信号应默认关闭（样本外消融为负）");
assert.equal(KALMAN_PARAMS.obsInflate, 2, "默认相关性膨胀因子 γ=2");

const klines = synthKlines(700);
const ind = computeIndicators(klines);
ok(Array.isArray(ind.kf.slope) && ind.kf.slope.length === klines.length, "computeIndicators 应预计算卡尔曼数组");
ok(ind.kf.slopeT.at(-1) != null && Number.isFinite(ind.kf.slopeT.at(-1)), "卡尔曼斜率 t 值应为有限数");
ok(kalmanSnapshot(ind)?.thresholds != null, "kalmanSnapshot 应返回阈值信息");

// 信号：默认关闭卡尔曼信号，显式打开后可见
const sigsDefault = signalDirectionsAt(ind, klines.length - 1);
ok(!sigsDefault.some((x) => x.key.startsWith("kalman")), "默认不应出现卡尔曼信号");
const sigsOn = signalDirectionsAt(ind, klines.length - 1, { kalmanSignals: true });
ok(Array.isArray(sigsOn), "打开卡尔曼信号后应正常返回数组");

const lrMap = estimateLikelihoodRatios(ind, 5);
ok(lrMap instanceof Map, "LR 表应为 Map");
if (sigsDefault.length) assert.equal(buildEvidence(sigsDefault, lrMap).length, sigsDefault.length);
for (const [, stat] of lrMap) {
  ok(stat.varBull > 0 && stat.varBear > 0, "LR 表应带观测方差 varBull/varBear（供卡尔曼融合用）");
  break;
}

// ---- 报告：默认卡尔曼融合 ----
const report = analyzeStock(klines, {}, { horizon: 5 });
assert.equal(report.ok, true);
ok(report.posterior > 0 && report.posterior < 1, "后验应为概率");
ok(report.score >= 0 && report.score <= 100, "评分应在 0-100");
assert.equal(report.multiHorizon.length, 4);
ok(report.risk && Number.isFinite(report.risk.var95_h_emp), "风险块应完整");
assert.equal(report.calibration.fusion, "kalman", "默认融合应为卡尔曼");
ok(report.calibration.kalmanGain > 0 && report.calibration.kalmanGain < 1, "卡尔曼增益应在 (0,1)");
ok(report.calibration.effectiveTemperature > 1, "等价温度应大于 1");
ok(report.calibration.posteriorCI[0] <= report.posterior && report.posterior <= report.calibration.posteriorCI[1], "后验应落在区间内");
ok(report.kalman && report.kalman.slopeT != null, "报告应含卡尔曼趋势快照");
ok(["bull", "flat", "bear"].includes(report.trend.state), "趋势状态应合法");

// log-odds 语义锁定：报告里的 logOdds 必须是"实际作用于先验"的增量，可由 prior/posterior 反推。
// （旧实现返回的是未收缩的原始证据和，会把实得变化夸大 T 倍。）
const implied = (r) => Math.log(r.posterior / (1 - r.posterior)) - Math.log(r.prior / (1 - r.prior));
ok(Math.abs(implied(report) - report.logOdds) < 2e-3, `卡尔曼路径 logOdds 应等于实际增量（期望 ${implied(report).toFixed(4)}，实际 ${report.logOdds}）`);
ok(Number.isFinite(report.calibration.evidenceLogOdds), "应同时给出未收缩的原始证据和 evidenceLogOdds");

// ---- 回退路径：fusion="temperature" ----
const repT = analyzeStock(klines, {}, { horizon: 5, fusion: "temperature" });
assert.equal(repT.calibration.fusion, "temperature");
assert.equal(repT.calibration.temperature, 3);
ok(repT.calibration.kalmanGain === void 0, "温度路径不应输出卡尔曼增益");
ok(repT.posterior > 0 && repT.posterior < 1, "回退路径后验应为概率");
// 温度路径同样要满足"logOdds = 实际增量"（即 evidenceLogOdds / T）
ok(Math.abs(implied(repT) - repT.logOdds) < 2e-3, `温度路径 logOdds 应等于实际增量（期望 ${implied(repT).toFixed(4)}，实际 ${repT.logOdds}）`);
ok(Math.abs(repT.calibration.evidenceLogOdds / 3 - repT.logOdds) < 2e-3, "温度路径 evidenceLogOdds/T 应等于 logOdds");

// ---- 审计与回测 ----
const audit = auditSignals(klines, { horizon: 5 });
ok(Array.isArray(audit) && audit.length > 0, "auditSignals 应返回信号审计行");
ok(audit.every((r) => r.spread == null || Number.isFinite(r.spread)), "spread 应为有限数");

const bt = backtest(klines, { horizon: 5, fusion: "kalman" });
ok(bt.n > 50, "回测样本量应充足");
ok(bt.priorOnly && Number.isFinite(bt.priorOnly.brier), "回测应给出 priorOnly 参照");
assert.equal(bt.productionTemperature, 3);
ok(Number.isFinite(bt.atProductionTemperature.brier), "回测应给出生产温度口径 Brier");
ok(bt.kalman && Number.isFinite(bt.kalman.brier), "回测应给出卡尔曼口径 Brier");
ok(bt.kalman.effectiveTemperature.p50 > 1, "卡尔曼等价温度中位数应大于 1");
ok(bt.kalman.obsVar.p50 > 0 && bt.kalman.priorVar.p50 > 0, "应输出观测方差与先验方差分布");
ok(Number.isFinite(bt.atBestTemperature.brier) && Number.isFinite(bt.atTemperature1.brier), "温度网格结果应完整");

// 温度路径回测不应带卡尔曼块
const btT = backtest(klines, { horizon: 5, fusion: "temperature" });
assert.equal(btT.kalman, null);

// ---- 保留迁移前正式版 smoke 的基础覆盖（避免换成实验版用例后覆盖回退）----
assert.equal(sma([1, 2, 3, 4, 5], 3)[4], 4);
ok(ewmaVolatility([0.01, -0.02, 0.03]) > 0, "EWMA 波动率应为正");
const tw = timeWeights(10, 200);
ok(tw[0] < tw[9], "时间衰减权重应近期更高");
assert.equal(ratingOf(75), "强烈看多");
assert.equal(ratingOf(60), "看多");
assert.equal(ratingOf(59), "中性偏多");
assert.equal(ratingOf(49), "中性偏空");
assert.equal(bayesianRisk([0.01, -0.01]), null);
const risk = bayesianRisk(Array.from({ length: 60 }, () => (rand() - 0.5) * 0.02), { horizon: 5 });
ok(risk && Number.isFinite(risk.var95_h_emp), "风险估计应给出经验 VaR");
ok(aggregateLikelihoods([klines, klines], { horizon: 5 }) instanceof Map, "多股池化应返回 LR Map");

console.log(`smoke: all ${checks} checks passed`);
