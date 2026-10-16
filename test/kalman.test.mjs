// dsh-plugin-stock-bayes / test/kalman.test.mjs
// 卡尔曼模块数值单测：覆盖零噪声极限、因果性（无前视）不变式、标准化新息、
// 增益等价性（T_eff = 1/K）、观测方差单调性。运行：node test/kalman.test.mjs
import assert from "node:assert/strict";
import {
  kalmanLocalLinear,
  kalmanFuse,
  kalmanFilterSeries,
  logLrVariance,
  priorVarianceOf,
} from "../lib/kalman.js";

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const near = (a, b, tol, msg) => {
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} 期望 ${b}，实际 ${a}（容差 ${tol}）`);
  checks++;
};

// 确定性伪随机，避免测试抖动
let seed = 20260821;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const gauss = () => {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// ---------- 1) LLT：零噪声极限（观测噪声越小，滤波水平越贴合观测） ----------
{
  const n = 200;
  const y = new Array(n);
  let v = Math.log(100);
  for (let i = 0; i < n; i++) { v += 0.001; y[i] = v + gauss() * 0.03; } // 强噪声：滤波与观测的差异才可分辨
  const tight = kalmanLocalLinear(y, { obsVar: 1e-10, qLevel: 0, qSlope: 1e-10, initVar: 1e-10 });
  const loose = kalmanLocalLinear(y, { obsVar: 0.03 ** 2, qLevel: 0, qSlope: 0.03 ** 2 / 1600 });
  const gapTight = Math.abs(tight.level[n - 1] - y[n - 1]);
  const gapLoose = Math.abs(loose.level[n - 1] - y[n - 1]);
  ok(gapTight < 1e-3, `零噪声极限下 level 应几乎等于观测，实际偏差 ${gapTight}`);
  ok(gapLoose > gapTight * 10, `观测噪声大时应显著滞后于观测（${gapLoose} vs ${gapTight}）`);
  ok(tight.slope[n - 1] > 0, "持续上行序列的滤波斜率应为正");
}

// ---------- 2) LLT：因果性（续接未来 K 线不得改变历史滤波状态） ----------
{
  const n = 200;
  const full = new Array(n);
  let v = Math.log(50);
  for (let i = 0; i < n; i++) { v += gauss() * 0.02; full[i] = v; }
  const truncated = full.slice(0, 120);
  // 两条路径都要守：显式常数参数、以及生产默认的滚动自适应参数
  for (const [label, opts] of [["显式 obsVar", { obsVar: 4e-4 }], ["默认滚动窗口", {}]]) {
    const a = kalmanLocalLinear(full, opts);
    const b = kalmanLocalLinear(truncated, opts);
    let maxDiff = 0;
    for (let i = 0; i < truncated.length; i++) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(a.level[i] - b.level[i]),
        Math.abs(a.slope[i] - b.slope[i]),
        Math.abs(a.slopeVar[i] - b.slopeVar[i]),
        Math.abs((a.innovZ[i] ?? 0) - (b.innovZ[i] ?? 0)),
      );
    }
    assert.equal(maxDiff, 0, `[${label}] 历史滤波状态受未来数据影响（最大差 ${maxDiff}）——存在前视泄漏`);
    checks++;
    // 默认路径必须真的用上了滚动估计，而不是退化常数
    const obsVars = a.obsVarAt.slice(60).filter((x) => x != null);
    ok(new Set(obsVars.map((x) => x.toFixed(12))).size > 1 || label === "显式 obsVar", `[${label}] 观测噪声应随时间变化`);
  }
}

// ---------- 3) LLT：已知漂移的斜率恢复与单调性 ----------
{
  const n = 400;
  const noise = 0.01;
  const mk = (drift) => {
    const y = new Array(n);
    for (let i = 0; i < n; i++) y[i] = Math.log(20) + drift * i + gauss() * noise;
    return kalmanLocalLinear(y, { obsVar: noise ** 2 });
  };
  const strong = mk(0.0015);
  const mid = mk(0.0008);
  const flat = mk(0);
  const est = strong.slope[n - 1];
  // 单边 HP 滤波对"当前瞬时斜率"的估计天然滞后且保守：允许低估，但不应跑偏
  ok(est > 0 && est < 0.0015, `斜率估计应接近真实漂移 0.0015 且偏保守，实际 ${est}`);
  ok(est > 0.0008, `斜率估计不应严重低估，实际 ${est}`);
  // 关键性质：漂移越强，斜率与其 t 值越大（阈值可据此标定）
  ok(strong.slopeT[n - 1] > mid.slopeT[n - 1], "更强漂移应给出更大的斜率 t 值");
  ok(mid.slopeT[n - 1] > flat.slopeT[n - 1], "漂移越弱斜率 t 值越小");
  ok(Math.abs(flat.slope[n - 1]) < 0.0005, `无漂移序列的斜率应接近 0，实际 ${flat.slope[n - 1]}`);
  ok(strong.slopeT[n - 1] > flat.slopeT[n - 1] * 3, "强趋势的 t 值应显著高于无趋势");
}

// ---------- 4) LLT：标准化新息的正态性（先验证数学，再验证默认参数标定） ----------
{
  const n = 2000;
  const R = 0.015 ** 2;
  const stat = (zs) => {
    const m = zs.reduce((a, b) => a + b, 0) / zs.length;
    const sd = Math.sqrt(zs.reduce((a, b) => a + (b - m) ** 2, 0) / zs.length);
    return { m, sd };
  };

  // 4a) 数学正确性：数据与设定一致（随机游走水平 q=R + 观测噪声 R，qSlope=0）
  //     → S = P⁻ + R 必须恰好等于实际新息方差，标准差应≈1
  const yMatched = [];
  let x = Math.log(30);
  for (let i = 0; i < n; i++) { x += gauss() * 0.015; yMatched.push(x + gauss() * 0.015); }
  const matched = kalmanLocalLinear(yMatched, { obsVar: R, qLevel: R, qSlope: 0 });
  const a = stat(matched.innovZ.slice(300).filter((z) => z != null));
  ok(Math.abs(a.m) < 0.1, `设定与数据一致时新息均值应≈0，实际 ${a.m.toFixed(3)}`);
  ok(a.sd > 0.92 && a.sd < 1.08, `设定与数据一致时新息标准差应≈1，实际 ${a.sd.toFixed(3)}`);

  // 4b) 默认参数在"真实股价"式的纯随机游走（无观测噪声）上必须同样标定正确。
  //     这是对默认参数（qLevel=base, R_obs=0.05·base）的回归保护：
  //     HP 等价设定（qLevel=0, R_obs=base）在这里会得到 sd≈1.50（新息方差被低估 50%）。
  const yRW = [];
  let v = Math.log(30);
  for (let i = 0; i < n; i++) { v += gauss() * 0.015; yRW.push(v); }
  const dflt = kalmanLocalLinear(yRW, { baseVar: R });
  const b = stat(dflt.innovZ.slice(300).filter((z) => z != null));
  ok(b.sd > 0.85 && b.sd < 1.15, `默认参数在纯随机游走上应标定正确，实际 sd=${b.sd.toFixed(3)}`);
  const hpLike = kalmanLocalLinear(yRW, { obsVar: R, qLevel: 0, qSlope: R / 1600 });
  const c = stat(hpLike.innovZ.slice(300).filter((z) => z != null));
  ok(c.sd > 1.3, `HP 型设定应显著高估新息（记录该性格），实际 sd=${c.sd.toFixed(3)}`);
}

// ---------- 5) kalmanFuse：边界与等价性 ----------
{
  // 无证据：后验 = 先验
  const r0 = kalmanFuse(0.6, [], { priorVar: 0.5 });
  near(r0.posterior, 0.6, 1e-12, "无证据时后验应等于先验");
  near(r0.logOdds, 0, 1e-12, "无证据时 log-odds 增量应为 0");

  // 观测方差极大 → K→0 → 后验≈先验（等价于旧式 T→∞）
  const rBig = kalmanFuse(0.6, [{ lr: 4, strength: 1, varLogLr: 1e6 }], { priorVar: 0.5 });
  ok(Math.abs(rBig.posterior - 0.6) < 1e-3, `巨大观测方差下后验应贴住先验，实际 ${rBig.posterior}`);
  ok(rBig.K < 1e-4, "巨大观测方差下卡尔曼增益应趋 0");

  // 先验方差极大 → K→1 → 退化为旧式 T=1 的纯证据模型
  const ev = [{ lr: 3, strength: 0.8, varLogLr: 0.2 }];
  const y = Math.log(3) * 0.8;
  const rNoPrior = kalmanFuse(0.4, ev, { priorVar: 1e12 });
  const expectT1 = 1 / (1 + Math.exp(-(Math.log(0.4 / 0.6) + y)));
  near(rNoPrior.posterior, expectT1, 1e-6, "先验无信息时应退化为 T=1 模型");
  ok(rNoPrior.K > 1 - 1e-6, "先验无信息时增益应趋 1");

  // R = 2·P⁻ → K = 1/3 → T_eff = 3（与代码中手调 temperature=3 的隐含假设一致）
  const rEq = kalmanFuse(0.5, [{ lr: 4, strength: 1, varLogLr: 2 }], { priorVar: 1 });
  near(rEq.K, 1 / 3, 1e-12, "R=2P 时增益应为 1/3");
  near(rEq.effectiveTemperature, 3, 1e-12, "R=2P 时应等价于 temperature=3");
  const legacy = 1 / (1 + Math.exp(-(Math.log(0.5 / 0.5) + Math.log(4) / 3)));
  near(rEq.posterior, legacy, 1e-12, "R=2P 的卡尔曼后验应等于 T=3 的旧式后验");

  // 后验方差与区间一致性
  for (const r of [r0, rBig, rNoPrior, rEq]) {
    ok(r.K > 0 && r.K < 1, "增益应严格落在 (0,1)");
    ok(r.stateVar > 0 && r.stateVar <= r.priorVar + 1e-12, "后验状态方差应不大于先验方差");
    ok(r.ci[0] <= r.posterior && r.posterior <= r.ci[1], "后验应落在置信区间内");
    ok(r.ci[0] >= 0 && r.ci[1] <= 1, "置信区间应落在 [0,1]");
  }

  // 证据越强（LR 越大），后验越高
  const weak = kalmanFuse(0.5, [{ lr: 1.5, strength: 1, varLogLr: 0.2 }], { priorVar: 1 });
  const strong = kalmanFuse(0.5, [{ lr: 4, strength: 1, varLogLr: 0.2 }], { priorVar: 1 });
  ok(strong.posterior > weak.posterior, "更强证据应给出更高后验");

  // 证据方差越大（样本越少），同一个 LR 给出的后验越保守（单调性）
  const thin = kalmanFuse(0.5, [{ lr: 4, strength: 1, varLogLr: 2.0 }], { priorVar: 0.5 });
  const rich = kalmanFuse(0.5, [{ lr: 4, strength: 1, varLogLr: 0.05 }], { priorVar: 0.5 });
  ok(rich.posterior > thin.posterior, "样本充分（方差小）的证据应给出更强后验");
}

// ---------- 6) kalmanFilterSeries：递推收敛与增益衰减 ----------
{
  // q=0 时增益几何衰减，收敛较慢：给足步数
  const obs = new Array(400).fill(0).map(() => ({ y: 1.2, r: 0.25 }));
  const s = kalmanFilterSeries(obs, { z0: 0, p0: 1, q: 0 });
  near(s.z[399], 1.2, 1e-3, "重复观测应收敛到观测值");
  ok(s.K[0] > s.K[200] && s.K[200] > s.K[399], "增益应随不确定性下降而单调衰减");
  ok(s.P[399] < s.P[0], "状态方差应随观测累积下降");
  // 过程噪声 q>0 时增益不会衰减到 0，且状态持续跟踪
  const sq = kalmanFilterSeries(obs, { z0: 0, p0: 1, q: 0.05 });
  ok(sq.K[399] > s.K[399], "存在过程噪声时增益应保持更大");
  ok(sq.P[399] > s.P[399], "存在过程噪声时状态方差应保持更大");
  // k=1 特殊情况：观测方差为 0 → 完全信任观测
  const exact = kalmanFilterSeries([{ y: 3, r: 0 }], { z0: 0, p0: 1, q: 0 });
  near(exact.z[0], 3, 1e-9, "观测方差为 0 时应完全跟随观测");
}

// ---------- 7) logLrVariance：样本量与单调性 ----------
{
  const small = logLrVariance({ hitUp: 12, nUp: 30, hitDown: 6, nDown: 28, lrRaw: 1.87 });
  const large = logLrVariance({ hitUp: 300, nUp: 620, hitDown: 150, nDown: 600, lrRaw: 1.87 });
  ok(small > large, "样本越多，LR 的对数方差越小");
  ok(large > 0, "对数方差应为正");
  // 收缩修正：收缩越强，方差越小
  const shrunk = logLrVariance({ hitUp: 12, nUp: 30, hitDown: 6, nDown: 28, lrRaw: 1.87, shrinkW: 0.3 });
  ok(shrunk < small, "soft 收缩应降低对数方差");
  // 下限保护
  const degenerate = logLrVariance({ hitUp: 1e6, nUp: 1e6, hitDown: 1e6, nDown: 1e6, lrRaw: 1 });
  ok(degenerate >= 1e-3, "对数方差应有下限，避免增益恒为 1");
}

// ---------- 8) priorVarianceOf ----------
{
  const vThin = priorVarianceOf(0.5, 10);
  const vRich = priorVarianceOf(0.5, 1000);
  ok(vThin > vRich, "先验样本越少，先验方差越大");
  near(priorVarianceOf(0.5, 10), 1 / (10 * 0.25), 1e-9, "p=0.5,n=10 时先验方差应为 0.4");
  ok(priorVarianceOf(0, 0) > 0, "无样本时应返回兜底方差");
}

console.log(`kalman: all ${checks} checks passed`);
