// dsh-bayes-predict / test/realtime.test.mjs
// 自选股"实时（真实价）"口径测试 —— 全部离线（provider 注入假报价与假不复权日线，不打网络）。
//
// 为什么这些断言重要：实时价只能拿到**不复权真实价**，而插件的锚点价历史上存的是后复权值
// （茅台 hfq≈9200 vs 真实≈1300）。两者混算会得出 -84% 这种荒唐跌幅，所以：
//   1) liveAnchorStats 必须只吃不复权序列 + 实时报价；
//   2) 锚点价必须从**不复权**序列回读（不能用存储的 hfq anchorClose）；
//   3) 实时报价缺失时必须明确回退（live=false + 原因），而不是拿 hfq 当时的价钱硬顶。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveAnchorStats } from "../lib/realtime.js";

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const near = (a, b, m, tol = 1e-9) => { assert.ok(a != null && Math.abs(a - b) < tol, `${m}（期望 ${b}，实际 ${a}）`); checks++; };

// ---- 1) 纯函数：不复权序列 + 实时价 ----
const raw = [
  { date: "2026-01-05", close: 100 },
  { date: "2026-01-06", close: 110 },
  { date: "2026-01-07", close: 105 },
  { date: "2026-01-08", close: 120 },
];
const st = liveAnchorStats(raw, { anchorDate: "2026-01-05", livePrice: 126, liveTime: "20260108140000", liveDate: "2026-01-08" });
eq(st.anchorClose, 100, "自选价取不复权锚点日收盘");
near(st.returnSinceAdd, 0.26, "自选至今 = 实时价/锚点价 - 1");
eq(st.live, true, "有实时价时应标记 live");
eq(st.lastClose, 126, "最新价应取实时价而不是K线收盘");
eq(st.lastDate, "2026-01-08", "最新日期取实时报价日期");
near(st.changePct, 126 / 105 - 1, "当日涨跌幅与上一根K线比");
eq(st.bars, 3, "自选以来交易日数");
near(st.maxSince, 126, "期间最高（含实时价）");
near(st.minSince, 100, "期间最低");
near(st.maxDrawdownSince, (105 / 110 - 1), "期间最大回撤（峰值 110 → 谷 105）");
eq(st.warning, null, "正常情况无告警");

// 无实时报价 → 用不复权序列最后一根收盘，并标记 live=false
const st2 = liveAnchorStats(raw, { anchorDate: "2026-01-05" });
eq(st2.live, false, "无实时价时 live=false");
eq(st2.lastClose, 120, "无实时价时退回最后一根收盘");
near(st2.returnSinceAdd, 0.20, "退回后按收盘价计算");
eq(st2.livePrice, null, "无实时价时 livePrice 为 null");

// 锚点日停牌（该日无成交）→ 回退到之前最近一根并标注
const gapped = [raw[0], raw[2], raw[3]];
const st3 = liveAnchorStats(gapped, { anchorDate: "2026-01-06", livePrice: 120 });
eq(st3.anchorDate, "2026-01-05", "停牌日锚点回退");
eq(st3.anchorClose, 100, "回退后取该日收盘");
ok(String(st3.warning).includes("回退"), "回退应被标注");

// 锚点早于可取窗口 / 空序列
const st4 = liveAnchorStats([raw[3]], { anchorDate: "2020-01-01", livePrice: 120 });
eq(st4.returnSinceAdd, null, "锚点不可达时不给收益");
ok(String(st4.warning).includes("早于"), "应标注窗口不足");
ok(liveAnchorStats([], { anchorDate: "2026-01-05" }).warning.includes("不复权"), "空序列应给出明确原因");

// ---- 2) 经 provider 注入的整链测试（watchlistReport 的实时分支）----
const TEMP = mkdtempSync(join(tmpdir(), "sb-live-"));
process.env.DSH_STOCK_CACHE_DIR = TEMP;   // 自选表隔离到临时目录，绝不碰真实自选
const { addToWatchlist, watchlistReport } = await import("../lib/watchlist.js");

const CODES = ["600519", "000001"];
const CACHE_KL = new Map([
  ["600519", [{ date: "2026-01-05", close: 8888 }, { date: "2026-01-06", close: 9000 }]],   // 后复权缓存价（数值故意夸张）
  ["000001", [{ date: "2026-01-05", close: 2000 }, { date: "2026-01-06", close: 2050 }]],
]);
const RAW_KL = new Map([
  ["600519", [{ date: "2026-01-05", close: 1300 }, { date: "2026-01-06", close: 1310 }, { date: "2026-01-07", close: 1330 }]],
  ["000001", [{ date: "2026-01-05", close: 11.0 }, { date: "2026-01-06", close: 11.2 }, { date: "2026-01-07", close: 11.1 }]],
]);
const QUOTES = new Map([
  ["600519", { price: 1332.5, time: "20260107140000", date: "2026-01-07", name: "贵州茅台" }],
  // 000001 故意不给报价，验证回退
]);
const provider = {
  universe: CODES,
  getKlines: async (c) => CACHE_KL.get(c) ?? null,
  getTags: (c) => ({ 600519: { name: "贵州茅台" }, "000001": { name: "平安银行" } }[c] || {}),
  getStamp: () => 1, getDataStamp: () => 1,
  getScores: () => null, saveScores: () => {},
  getLiveQuotes: async (codes) => new Map([...QUOTES].filter(([c]) => codes.includes(c))),
  getRawSeries: async (c) => RAW_KL.get(c) || [],
};

await addToWatchlist("600519", provider);
await addToWatchlist("000001", provider);
// 把锚点固定到 2026-01-05（真实价 1300 / 11.0），模拟"早前加入"
const path = join(TEMP, "watchlist.json");
const doc = JSON.parse(readFileSync(path, "utf8"));
for (const it of doc.items) it.anchorDate = "2026-01-05";
writeFileSync(path, JSON.stringify(doc, null, 1));

const rep = await watchlistReport({ horizon: 5, live: true, withScore: false }, provider);
eq(rep.basis, "raw", "报告应声明真实价口径");
eq(rep.liveMeta.used, 1, "只有 1 只拿到实时报价");
const mt = rep.items.find((x) => x.code === "600519");
const pab = rep.items.find((x) => x.code === "000001");

eq(mt.live, true, "茅台应走实时");
near(mt.anchorClose, 1300, "自选价必须是**不复权**锚点价（不是缓存里的 8888）");
near(mt.lastClose, 1332.5, "最新价取实时报价");
near(mt.returnSinceAdd, 1332.5 / 1300 - 1, "自选至今按真实价实时计算");
near(mt.anchorRawClose, 1310, "加入自选时记录的是**缓存最新交易日**（01-06）的不复权收盘 1310");
ok(mt.returnSinceAdd > -0.1 && mt.returnSinceAdd < 0.1, `绝不能出现 hfq/真实价混算的荒唐跌幅（实际 ${(mt.returnSinceAdd * 100).toFixed(2)}%）`);

eq(pab.live, false, "无实时报价的股票应标记 live=false");
eq(pab.lastDate, "2026-01-07", "回退时用不复权序列最后一根");
near(pab.returnSinceAdd, 11.1 / 11.0 - 1, "回退时仍按不复权口径计算（不是缓存的 2000）");
ok(String(pab.liveError).length > 0, "回退应带原因");

// live:false 时完全不碰实时接口（离线可用）
const offline = await watchlistReport({ horizon: 5, live: false, withScore: false }, provider);
eq(offline.liveMeta, null, "关闭实时时不应有 liveMeta");
ok(offline.items.every((x) => x.live === false), "关闭实时时不应标记 live");
near(offline.items.find((x) => x.code === "600519").anchorClose, 8888, "关闭实时时回退到缓存（后复权）口径");

rmSync(TEMP, { recursive: true, force: true });
console.log(`realtime: all ${checks} checks passed`);
