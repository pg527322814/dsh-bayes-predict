// dsh-bayes-predict / test/watchlist.test.mjs
// 自选股（收藏）测试：
//  1) 代码归一化与拒绝（只收 A 股 6 位）
//  2) 锚点语义：自选日 / 自选价 / 自选日至今涨跌幅 / 期间最高最低与最大回撤（含停牌回退、锚点早于K线起点）
//  3) 持久化往返：加入 / 重复加入不重置锚点 / 移出 / 清空（原子写，缓存目录隔离到临时目录）
//  4) 报告：与选股筛选共用同一份评分缓存（第二次应全部命中），汇总统计自洽
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 自选表落在 cacheRoot()/watchlist.json —— 先把缓存根指到临时目录，绝不碰真实缓存
const TMP = mkdtempSync(join(tmpdir(), "sb-watchlist-"));
process.env.DSH_STOCK_CACHE_DIR = TMP;

const {
  normalizeCode, readWatchlist, addToWatchlist, removeFromWatchlist, clearWatchlist,
  watchlistReport, anchorStats, watchlistPath,
} = await import("../lib/watchlist.js");

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const near = (a, b, msg, tol = 1e-9) => { assert.ok(a != null && Math.abs(a - b) < tol, `${msg}（期望 ${b}，实际 ${a}）`); checks++; };

// ---- 合成行情 ----
let seed = 11;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { const u1 = Math.max(rand(), 1e-12), u2 = rand(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
function tradingDates(n) {
  const out = []; const d = new Date(Date.UTC(2023, 0, 2));
  while (out.length < n) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const DATES = tradingDates(650);
function makeKlines(bars, price0) {
  let px = price0; let drift = 0; const out = [];
  for (let i = 0; i < bars; i++) {
    if (i % 120 === 0) drift = (rand() - 0.45) * 0.003;
    const open = px;
    px = Math.max(px * (1 + drift + gauss() * 0.018), 0.5);
    out.push({ date: DATES[i], open, close: px, high: Math.max(open, px) * 1.005, low: Math.min(open, px) * 0.995, volume: 1e6 });
  }
  return out;
}

const WATCH = ["600519", "000001", "300750", "002594"];
const klMap = new Map(WATCH.map((c, i) => [c, makeKlines(650, 20 + i * 60)]));
const NAMES = { 600519: "贵州茅台", "000001": "平安银行", 300750: "宁德时代", "002594": "比亚迪" };
const tags = {};
for (const [i, c] of WATCH.entries()) tags[c] = { name: NAMES[c], market: i % 2 ? "深主板" : "沪主板", cap: "大盘", mktcapYi: 1000 + i * 500, sh300: true, st: false };

function makeProvider() {
  let store = null;
  return {
    universe: WATCH,
    snapshotDate: DATES[DATES.length - 1],
    getKlines: async (c) => klMap.get(c) ?? null,
    getTags: (c) => tags[c] || {},
    getStamp: () => 1,
    getDataStamp: () => 1,
    getScores: (h) => (h === 5 && store ? JSON.parse(JSON.stringify(store)) : null),
    saveScores: (h, p) => { if (h === 5) store = JSON.parse(JSON.stringify(p)); },
  };
}

// ---- 1) 代码归一化 ----
eq(normalizeCode("600519"), "600519", "纯数字应通过");
eq(normalizeCode("sh600519"), "600519", "sh 前缀应剥离");
eq(normalizeCode("SZ000001"), "000001", "大写前缀 + 小写化应通过");
eq(normalizeCode("bj430047"), "430047", "北交所前缀应剥离");
eq(normalizeCode("600519.SH"), "600519", "点号后缀应剥离");
eq(normalizeCode("AAPL"), null, "美股不入自选（本地缓存只有 A 股）");
eq(normalizeCode("60051"), null, "5 位数字应拒绝");
eq(normalizeCode(""), null, "空串应拒绝");
eq(normalizeCode(undefined), null, "undefined 应拒绝");

// ---- 2) 锚点统计（纯函数）----
const bars = [
  { date: "2026-01-05", close: 100 },
  { date: "2026-01-06", close: 120 },
  { date: "2026-01-07", close: 90 },
  { date: "2026-01-08", close: 110 },
];
const st = anchorStats(bars, { anchorDate: "2026-01-05", anchorClose: 100 });
eq(st.anchorDate, "2026-01-05", "自选日应命中");
near(st.returnSinceAdd, 0.10, "自选日至今涨跌幅 = 110/100 - 1");
near(st.changePct, 110 / 90 - 1, "最新一日涨跌幅");
eq(st.bars, 3, "自选以来交易日数应为 3");
eq(st.calendarDays, 3, "自然日数应为 3");
near(st.maxSince, 120, "期间最高收盘");
near(st.minSince, 90, "期间最低收盘");
near(st.maxDrawdownSince, 90 / 120 - 1, "期间最大回撤（峰值 120 → 谷 90）");
eq(st.warning, null, "正常情况不应有告警");

// 自选日非交易日（停牌）→ 回退到之前最近一根并标注
const st2 = anchorStats(bars, { anchorDate: "2026-01-06b", anchorClose: 100 });
eq(st2.anchorDate, "2026-01-06", "无法精确匹配的日期应回退到之前最近的一根，而不是抛错");
near(st2.returnSinceAdd, 110 / 120 - 1, "回退后应按回退日的收盘价重算收益");
ok(String(st2.warning).includes("回退"), "回退应被标注");
const st3 = anchorStats([bars[0], bars[2], bars[3]], { anchorDate: "2026-01-06", anchorClose: 100 });
eq(st3.anchorDate, "2026-01-05", "停牌日应回退到之前最近的交易日");
eq(st3.anchorClose, 100, "回退后自选价应取该日收盘");
ok(String(st3.warning).includes("回退"), "回退应被标注");

// 锚点早于K线起点 / 无数据
const st4 = anchorStats([bars[3]], { anchorDate: "2020-01-01", anchorClose: 50 });
eq(st4.returnSinceAdd, null, "锚点早于K线起点时无法计算收益");
ok(String(st4.warning).includes("早于"), "应标注早于K线起点");
const st5 = anchorStats([], { anchorDate: "2026-01-05", anchorClose: 1 });
eq(st5.warning, "无K线数据", "空K线应给出提示");

// ---- 3) 持久化往返 ----
eq(readWatchlist().items.length, 0, "初始应为空自选");
eq(watchlistPath(), join(TMP, "watchlist.json"), "自选表应落在 cacheRoot 下");

const provider = makeProvider();
const added = await addToWatchlist("sh600519", provider);
eq(added.created, true, "首次加入应创建");
eq(added.count, 1, "加入后应有 1 只");
const refBars = klMap.get("600519");
eq(added.item.anchorDate, refBars[refBars.length - 1].date, "自选日应锚定该股最新交易日");
near(added.item.anchorClose, refBars[refBars.length - 1].close, "自选价应锚定该日收盘");
ok(existsSync(watchlistPath()), "自选表文件应已写入");
ok(typeof added.item.addedAt === "string" && added.item.addedAt.includes("T"), "应记录加入时间");

// 重复加入：不重置锚点（否则"再点一次收藏"会把收益起点挪到今天）
const again = await addToWatchlist("600519", provider);
eq(again.created, false, "重复加入不应新建条目");
eq(again.item.anchorDate, added.item.anchorDate, "重复加入不应改动自选日");
eq(again.count, 1, "重复加入不应增加数量");

await addToWatchlist("000001", provider);
await addToWatchlist("300750", provider);
eq(readWatchlist().items.length, 3, "应累计 3 只");

await assert.rejects(() => addToWatchlist("AAPL", provider), /只支持 A 股/, "美股应被拒绝");
checks++;
await assert.rejects(() => addToWatchlist("0000001", provider), /无法识别/, "非法代码应被拒绝");
checks++;

const removed = removeFromWatchlist("sz300750");
eq(removed.removed, true, "移出应成功");
eq(removed.count, 2, "移出后应为 2 只");
eq(removeFromWatchlist("300750").removed, false, "重复移出应报未命中");
eq(readWatchlist().items.length, 2, "移出应落盘");

// ---- 4) 报告：与选股筛选共用同一份评分缓存 ----
const r1 = await watchlistReport({ horizon: 5, live: false }, provider);
eq(r1.ok, true, "报告应成功");
eq(r1.items.length, 2, "应报告 2 只自选");
ok(r1.items.every((x) => x.anchorDate && x.lastDate && x.returnSinceAdd != null), "每只都应有自选日/最新日/自选至今涨跌幅");
ok(r1.items.every((x) => x.score != null && x.posterior > 0 && x.posterior < 1), "每只都应有最新评分与后验");
ok(r1.items.every((x) => x.name && x.name !== x.code), "名称应来自 tags");
// 拼音首字母（供"代码/拼音/名称"模糊搜索）：主串 + 多音字变体都要给
const mt = r1.items.find((x) => x.code === "600519");
eq(mt.initials, "GZMT", "贵州茅台 主首字母应为 GZMT");
const pab = r1.items.find((x) => x.code === "000001");
ok(pab.initialsVariants.includes("PAYX") && pab.initialsVariants.includes("PAYH"), "平安银行 应同时给出 PAYX 与 PAYH（多音字 行）");
eq(r1.summary.count, 2, "汇总只数");
ok(r1.summary.best && r1.summary.worst, "应给出最佳/最差");
ok(r1.scoreMeta && r1.scoreMeta.computed > 0, "首次报告应现场计算评分");
// 刚加入的自选：锚点就是最新一根K线，所以"自选日至今"必然恰好为 0
ok(r1.items.every((x) => Math.abs(x.returnSinceAdd) < 1e-12), "刚加入时自选日至今涨跌幅应恰好为 0");
eq(r1.summary.winCount + r1.summary.lossCount, 0, "刚加入时既非盈利也非亏损");
eq(r1.summary.flatCount, 2, "刚加入的应计入持平");
eq(r1.summary.withReturn, 2, "两只都应可计算收益");

// 模拟"早前加入"：把锚点改到更早的一根K线 —— 报告必须用**存储的锚点**，而不是自己重算
const doc = JSON.parse(readFileSync(watchlistPath(), "utf8"));
const bars600519 = klMap.get("600519");
const olderIdx = 600;
const older = bars600519[olderIdx];
const lastBar = bars600519[bars600519.length - 1];
doc.items.find((x) => x.code === "600519").anchorDate = older.date;
doc.items.find((x) => x.code === "600519").anchorClose = older.close;
writeFileSync(watchlistPath(), JSON.stringify(doc, null, 1));
const r1b = await watchlistReport({ horizon: 5, live: false }, provider);
const it0 = r1b.items.find((x) => x.code === "600519");
eq(it0.anchorDate, older.date, "报告应使用存储的自选日");
near(it0.anchorClose, older.close, "报告应使用存储的自选价");
near(it0.returnSinceAdd, lastBar.close / older.close - 1, "自选日至今涨跌幅应按存储锚点计算");
eq(it0.bars, bars600519.length - 1 - olderIdx, "自选以来交易日数应按锚点索引计算");
eq(r1b.summary.winCount + r1b.summary.lossCount + r1b.summary.flatCount, r1b.summary.withReturn, "盈利+亏损+持平应等于可计算收益的只数");
ok(r1b.summary.best.returnSinceAdd >= r1b.summary.worst.returnSinceAdd, "最佳收益应不低于最差");

// 第二次：评分应全部命中缓存（与选股筛选/回测共用 scores/h5.json）
const r2 = await watchlistReport({ horizon: 5, live: false }, provider);
eq(r2.scoreMeta.computed, 0, "第二次报告不应再现场计算");
eq(r2.scoreMeta.reused, r2.scoreMeta.scored, "第二次应全部命中评分缓存");
eq(r2.items.map((x) => `${x.code}:${x.score}`), r1b.items.map((x) => `${x.code}:${x.score}`), "缓存命中结果应与首次一致");
eq(r1.items[0].addedAt, r2.items[0].addedAt, "加入时间应稳定不变");
eq(r1b.items[0].anchorDate, r2.items[0].anchorDate, "两次报告的自选日应一致（锚点不漂移）");

// withScore=false：跳过评分链路
const r3 = await watchlistReport({ horizon: 5, live: false, withScore: false }, provider);
eq(r3.scoreMeta, null, "关闭评分时不应有 scoreMeta");
ok(r3.items.every((x) => x.score === null), "关闭评分时 score 应为 null");
ok(r3.items.every((x) => x.returnSinceAdd != null), "关闭评分不应影响自选至今涨跌幅");

// ---- 5) 清空 ----
const cleared = clearWatchlist();
eq(cleared.cleared, 2, "清空应报告删除数量");
eq(readWatchlist().items.length, 0, "清空后应为空");
const r4 = await watchlistReport({ horizon: 5, live: false }, provider);
eq(r4.items.length, 0, "空自选报告应无条目");
eq(r4.scoreMeta, null, "空自选不应触发评分");
ok(JSON.parse(readFileSync(watchlistPath(), "utf8")).version === 1, "自选表应带版本号");

rmSync(TMP, { recursive: true, force: true });
console.log(`watchlist: all ${checks} checks passed`);
