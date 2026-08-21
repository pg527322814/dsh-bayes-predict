import assert from "node:assert/strict";
import {
  sma,
  quantile,
  maxDrawdown,
  ewmaVolatility,
  timeWeights,
  computeIndicators,
  signalDirectionsAt,
  estimateLikelihoodRatios,
  buildEvidence,
  bayesianUpdate,
  ratingOf,
  trendState,
  bayesianRisk,
  analyzeStock,
} from "../lib/bayes.js";

let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function synthKlines(n) {
  const out = [];
  let price = 100;
  let d = new Date(Date.UTC(2025, 0, 1));
  for (let i = 0; i < n; i++) {
    d = new Date(d.getTime() + 86400000);
    const ret = Math.sin(i / 15) * 0.004 + (rand() - 0.5) * 0.03;
    const open = price;
    price = Math.max(price * (1 + ret), 1);
    out.push({
      date: d.toISOString().slice(0, 10),
      open,
      close: price,
      high: Math.max(open, price) * (1 + rand() * 0.01),
      low: Math.min(open, price) * (1 - rand() * 0.01),
      volume: 1e6 * (0.5 + rand()),
    });
  }
  return out;
}

const s = sma([1, 2, 3, 4, 5], 3);
assert.equal(s[2], 2);
assert.equal(s[3], 3);
assert.equal(s[4], 4);
assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
assert.equal(maxDrawdown([10, 12, 9, 11]).maxDrawdown < 0, true);
assert.ok(ewmaVolatility([0.01, -0.02, 0.03]) > 0);
const w = timeWeights(10, 200);
assert.ok(w[0] < w[9]);

assert.equal(bayesianUpdate(0.5, []).posterior, 0.5);
assert.equal(bayesianUpdate(0.5, [{ lr: 1 }]).posterior, 0.5);
assert.ok(bayesianUpdate(0.5, [{ lr: 4 }]).posterior > 0.5);
assert.equal(ratingOf(75), "强烈看多");
assert.equal(ratingOf(60), "看多");
assert.equal(ratingOf(59), "中性偏多");
assert.equal(ratingOf(49), "中性偏空");

assert.equal(trendState([0.01]).state, "flat");
const t = trendState(Array.from({ length: 60 }, () => (rand() - 0.5) * 0.02));
assert.ok(["bull", "flat", "bear"].includes(t.state));

assert.equal(bayesianRisk([0.01, -0.01]), null);
const risk = bayesianRisk(
  Array.from({ length: 60 }, () => (rand() - 0.5) * 0.02),
  { horizon: 5 },
);
assert.ok(risk && Number.isFinite(risk.var95_h_emp));

const klines = synthKlines(300);
const report = analyzeStock(klines, {}, { horizon: 5 });
assert.equal(report.ok, true);
assert.ok(report.posterior > 0 && report.posterior < 1);
assert.ok(report.score >= 0 && report.score <= 100);
assert.equal(report.multiHorizon.length, 4);
assert.ok(report.risk);
assert.ok(Array.isArray(report.evidence));
assert.ok(["bull", "flat", "bear"].includes(report.trend.state));

const ind = computeIndicators(klines);
const sigs = signalDirectionsAt(ind, klines.length - 1);
assert.ok(Array.isArray(sigs));
const lrMap = estimateLikelihoodRatios(ind, 5);
assert.ok(lrMap instanceof Map);
if (sigs.length) assert.equal(buildEvidence(sigs, lrMap).length, sigs.length);

console.log("smoke: all passed");
