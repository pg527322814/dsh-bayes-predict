// dsh-bayes-predict / test/screen.test.mjs
// 单日截面选股（screenStocks）测试：
//  1) 筛选条件（评分门槛/价格/ST/方向）与排序、limit 截断、非交易日回退
//  2) 与 runBacktest 在同一基准日的候选集逐只一致（把回测网格收敛到恰好一天来对照）
//  3) 评分缓存复用：第二次同日期筛选全部命中缓存，且结果与现场计算逐只相同
import assert from "node:assert/strict";
import { screenStocks, runBacktest } from "../lib/backtest.js";

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ---- 合成行情：确定性伪随机，含 ST / 价格 / 市值分层，便于验证筛选条件 ----
let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { const u1 = Math.max(rand(), 1e-12), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };

const N_BARS = 650;
const SHORT_BARS = 60;
function tradingDates(n) {
  const out = [];
  const d = new Date(Date.UTC(2023, 0, 2));
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const DATES = tradingDates(N_BARS);
const D = DATES[500];              // 基准日（区间中段，避免贴在数据末尾）

function makeKlines(bars, price0) {
  let px = price0;
  let drift = 0;
  const out = [];
  for (let i = 0; i < bars; i++) {
    if (i % 120 === 0) drift = (rand() - 0.45) * 0.003;
    const open = px;
    px = Math.max(px * (1 + drift + gauss() * 0.018), 0.5);
    out.push({
      date: DATES[i], open, close: px,
      high: Math.max(open, px) * (1 + rand() * 0.01),
      low: Math.min(open, px) * (1 - rand() * 0.01),
      volume: Math.round(1e6 * (0.5 + rand())),
    });
  }
  return out;
}

const N_STOCKS = 80;
const N_SHORT = 3;                 // 末尾 3 只只有 60 根K线 → 应被跳过
const universe = [];
const tags = {};
const klMap = new Map();
for (let i = 0; i < N_STOCKS; i++) {
  const code = i === 0 ? "600519"
    : (i % 3 === 0 ? "60" : i % 3 === 1 ? "00" : "30") + String(1000 + i).slice(-4);
  const short = i >= N_STOCKS - N_SHORT;
  const bars = short ? SHORT_BARS : N_BARS;
  universe.push(code);
  klMap.set(code, makeKlines(bars, 3 + (i % 25) * 11));   // 起始价 3 ~ 267 元，价格过滤能明显生效
  tags[code] = {
    name: "股票" + code,
    market: i % 3 === 0 ? "沪主板" : i % 3 === 1 ? "深主板" : "创业板",
    cap: i % 4 === 0 ? "大盘" : "小盘",
    mktcapYi: 10 + i * 37,                                // 10 ~ 2900 亿
    sh300: i % 5 === 0,
    st: i % 11 === 0 && i > 0,
  };
}

/** 与 buildProvider 同形状的数据层（内存评分缓存，模拟磁盘往返：进出都走深拷贝）。 */
function makeProvider() {
  let store = null;
  return {
    universe,
    snapshotDate: DATES[N_BARS - 1],
    getKlines: async (code) => klMap.get(code) ?? null,
    getTags: (code) => tags[code] || {},
    getStamp: () => 1,                 // 数据未变 → 缓存行有效
    getDataStamp: () => 12345,
    getScores: (h) => (h === 5 && store ? JSON.parse(JSON.stringify(store)) : null),
    saveScores: (h, payload) => { if (h === 5) store = JSON.parse(JSON.stringify(payload)); },
  };
}

const BASE = { horizon: 5, threshold: 0, date: D, limit: 5000 };

// ---- 1) 基本形态：候选集完整性 + 降序 + 字段 ----
const p1 = makeProvider();
const r1 = await screenStocks(BASE, p1);
ok(r1.ok === true, "筛选应返回 ok");
eq(r1.date, D, "基准日应等于请求日");
eq(r1.dateFallback, false, "交易日不应触发回退");
ok(r1.rows.length === r1.candidates, "limit 足够大时应返回全部候选");
ok(r1.candidates > 20, `候选数应可观（实际 ${r1.candidates}）`);
eq(r1.scored + r1.insufficient, universe.length, "评分数 + 数据不足数应等于股票池大小");
eq(r1.insufficient, N_SHORT, "只有 60 根K线的股票应计入 insufficient");
eq(r1.computed, r1.scored, "首次筛选无缓存可用，应全部现场计算");
eq(r1.cacheSaved, true, "首次筛选应把基准日写回评分缓存");
for (let i = 1; i < r1.rows.length; i++) ok(r1.rows[i - 1].score >= r1.rows[i].score, "默认应按评分降序");
ok(r1.rows.every((r) => r.score > 0 && r.posterior > 0 && r.posterior < 1), "评分与后验应在合法区间");
ok(r1.rows.every((r) => r.close > 0 && typeof r.name === "string" && r.name.length > 0), "每行应有现价与名称（来自 tags）");
ok(r1.rows.every((r) => r.mktcapYi != null && r.listDays != null && r.changePct != null), "每行应有市值/上市天数/涨跌幅");
ok(r1.summary.medianScore != null && r1.summary.p90Score >= r1.summary.medianScore, "分布摘要应自洽");

// ---- 2) 与回测同一基准日的候选集逐只一致 ----
// 把回测网格收敛到恰好一天（step=1 + startDate=endDate=基准日），其买入列表即"该日全部候选按评分排序"。
const p2 = makeProvider();
const bt = await runBacktest(
  { horizon: 5, step: 1, startDate: D, endDate: D, topN: N_STOCKS * 2, initial: 1e10, threshold: 0, warmHorizons: [] },
  p2,
);
eq(bt.periods.length, 1, "单日网格应只有一期");
eq(bt.periods[0].date, D, "该期换仓日应等于基准日");
const btCodes = bt.periods[0].buys.map((b) => b.code);
const r2 = await screenStocks(BASE, makeProvider());
eq(r2.rows.map((r) => r.code), btCodes, "筛选结果应与回测同一天的候选逐只一致（含排序）");
eq(r2.rows.map((r) => r.score), bt.periods[0].buys.map((b) => b.score), "评分应与回测内部评分逐只一致");

// ---- 3) 缓存复用：第二次同日期筛选零计算且结果相同 ----
const p3 = makeProvider();
const a3 = await screenStocks(BASE, p3);
const b3 = await screenStocks(BASE, p3);
eq(b3.computed, 0, "第二次同日期筛选不应再现场计算");
eq(b3.reused, b3.scored, "第二次应全部命中缓存");
eq(b3.rows.map((r) => `${r.code}:${r.score}`), a3.rows.map((r) => `${r.code}:${r.score}`), "缓存命中结果应与现场计算逐只一致");

// ---- 4) 筛选条件 ----
const p4 = makeProvider();
const noST = await screenStocks({ ...BASE, excludeST: true }, p4);
ok(noST.rows.length > 0 && noST.rows.every((r) => r.st === false), "排除 ST 后不应出现 ST 股");
ok(noST.candidates < r1.candidates, "排除 ST 应减少候选数");

const banded = await screenStocks({ ...BASE, minPrice: 10, maxPrice: 50 }, p4);
ok(banded.rows.length > 0 && banded.rows.every((r) => r.close >= 10 && r.close <= 50), "价格区间应生效");

const capped = await screenStocks({ ...BASE, maxScore: 45 }, p4);
ok(capped.rows.length > 0 && capped.rows.every((r) => r.score <= 45), "评分上限应生效");

const rich = await screenStocks({ ...BASE, minMktcap: 500 }, p4);
ok(rich.rows.length > 0 && rich.rows.every((r) => r.mktcapYi >= 500), "市值下限应生效");

const old = await screenStocks({ ...BASE, minListDays: 400 }, p4);
ok(old.rows.length > 0 && old.rows.every((r) => r.listDays >= 400), "次新过滤应生效");

const thresholded = await screenStocks({ ...BASE, threshold: 55 }, p4);
ok(thresholded.rows.length > 0 && thresholded.rows.every((r) => r.score > 55), "评分下限应生效");
ok(thresholded.candidates < r1.candidates, "评分下限应减少候选数");

const bottom = await screenStocks({ ...BASE, selectMode: "bottom", limit: 5 }, p4);
eq(bottom.rows.length, 5, "低分方向同样受 limit 约束");
for (let i = 1; i < bottom.rows.length; i++) ok(bottom.rows[i - 1].score <= bottom.rows[i].score, "低分方向应按评分升序");
ok(bottom.rows[0].score < r1.rows[0].score, "低分方向的首位应显著低于高分方向");

// ---- 5) limit 只截断返回，不影响候选统计与排序 ----
const p5 = makeProvider();
const limited = await screenStocks({ ...BASE, limit: 5 }, p5);
eq(limited.rows.length, 5, "limit 应截断返回行数");
eq(limited.candidates, r1.candidates, "limit 不应影响候选统计");
eq(limited.params.limit, 5, "返回体应回显 limit");

// ---- 6) 非交易日回退 ----
// 取一个周五（它的下一个自然日不在交易日历里）→ 请求周六应回退到该周五
const friIdx = DATES.findIndex((d, i) => i > 100 && i < N_BARS - 20 && !DATES.includes(new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10)));
const fri = DATES[friIdx];
const sat = new Date(Date.parse(fri) + 86400000).toISOString().slice(0, 10);
const fb = await screenStocks({ ...BASE, date: sat, limit: 5 }, makeProvider());
eq(fb.date, fri, "非交易日应回退到之前最近的交易日");
eq(fb.dateFallback, true, "回退应被标记");
eq(fb.requestedDate, sat, "应回显原始请求日");

// ---- 7) 参数校验 ----
await assert.rejects(() => screenStocks({ ...BASE, horizon: 1 }, makeProvider()), /horizon/, "非法评分窗口应报错");
checks++;

// ---- 8) codes 子集：只评分指定名单（自选股页复用），且与全池评分逐只一致 ----
const subset = ["600519", universe[1], universe[2], universe[3]];
const p8 = makeProvider();
const sub = await screenStocks({ ...BASE, codes: subset }, p8);
eq(sub.universeSize, subset.length, "codes 应把评分范围限制在该名单");
eq(sub.params.codesCount, subset.length, "返回体应回显 codes 数量");
ok(sub.rows.length > 0 && sub.rows.every((r) => subset.includes(r.code)), "结果只应包含名单内代码");
eq(sub.computed, sub.scored, "首次跑子集名单应全部现场计算");
const fullScores = new Map(r1.rows.map((r) => [r.code, r.score]));
for (const r of sub.rows) ok(fullScores.get(r.code) === r.score, `${r.code} 子集评分应与全池筛选一致`);
// 子集评分同样写回缓存：第二次全池筛选应命中这批代码
const p8b = makeProvider();
await screenStocks({ ...BASE, codes: subset }, p8b);
const fullAfter = await screenStocks(BASE, p8b);
ok(fullAfter.reused >= subset.length, "子集算过的分应被全池筛选命中（同一份缓存）");

// 名单里没有长历史股（全是 60 根K线的新股）时，参考日历应回退到固定参考股，而不是报错
const shortOnly = universe.slice(N_STOCKS - N_SHORT);
const r9 = await screenStocks({ ...BASE, codes: shortOnly }, makeProvider());
eq(r9.scored, 0, "全是短K线股时应全部计入 insufficient");
eq(r9.insufficient, N_SHORT, "短K线股应被跳过而非抛错");
eq(r9.rows.length, 0, "无可用评分时结果为空");

console.log(`screen: all ${checks} checks passed`);
