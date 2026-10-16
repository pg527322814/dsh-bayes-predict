// dsh-bayes-predict / test/client-render.test.mjs
// 客户端 bundle 渲染冒烟测试。
//
// 为什么需要它：lib/client.js 是**手写的 UMD bundle**（无 JSX、无构建步骤、无类型检查），
// 一个括号错位或字段名拼错在浏览器里只会表现为"面板整个白掉"，而这台机器上既没有
// react-dom 也没有 jsdom，所以这里用最小代价自建一个迷你 React：
//   - createElement / useState / useEffect / useRef 四个 API 的实现（够 client.js 用）；
//   - 一个遍历式渲染器，能模拟"点击按钮/表格行"、让 effect 执行、并按 state 变化重渲染；
//   - fetch 桩喂 test/client-fixtures.json（真实接口响应体，已裁剪）。
// 于是可以在没有浏览器的前提下，真跑通整条交互链：
//   打开浮层 → 选股筛选页签 → 点「开始筛选」→ 表格渲染 → 点表格行 → 跳「单股分析」并自动分析。
//
// 它**不是**真渲染器：不做 DOM、不做 diff、事件只有点击。局限写在断言里——只保证
// "结构能渲染出来 + 数据接线正确"，不保证浏览器视觉与交互细节。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, "client-fixtures.json"), "utf8"));
let src = readFileSync(join(HERE, "..", "lib", "client.js"), "utf8");

// ---- 机械替换：打开浮层、默认停在「选股筛选」、把内部组件暴露给测试 ----
// 替换目标找不到即报错：源码结构调整时应当显式提醒维护者更新本测试。
const subs = [
  ["var sO = React.useState(false); var open = sO[0];", "var sO = React.useState(true); var open = sO[0];"],
  ['var sT = React.useState("backtest"); var tab = sT[0];', 'var sT = React.useState("screen"); var tab = sT[0];'],
  ["\t\texports.apply = apply;", "\t\texports.__internals = { StockSidebarButton: StockSidebarButton, ScreenTab: ScreenTab, StockBayesTab: StockBayesTab, BacktestTab: BacktestTab, WatchlistTab: WatchlistTab };\n\t\texports.apply = apply;"],
];
for (const [from, to] of subs) {
  assert.ok(src.includes(from), "client.js 结构已变，测试的替换目标未找到：" + from);
  src = src.replace(from, to);
}

// ---- 迷你 React ----
const hookStore = new Map();
let pathStack = ["root"];
let hookCursor = 0;
let dirty = false;
const effectsFailed = [];

function createElement(type, props, ...children) {
  const flat = [];
  for (const c of children) { if (Array.isArray(c)) flat.push(...c); else flat.push(c); }
  return { type, props: props || {}, children: flat };
}
function slot(i) {
  const key = pathStack.join("|");
  let arr = hookStore.get(key);
  if (!arr) { arr = []; hookStore.set(key, arr); }
  if (!(i in arr)) arr[i] = {};
  return arr[i];
}
function useState(init) {
  const i = hookCursor++;
  const s = slot(i);
  if (!("v" in s)) s.v = typeof init === "function" ? init() : init;
  return [s.v, function (nv) {
    const next = typeof nv === "function" ? nv(s.v) : nv;
    if (next !== s.v) { s.v = next; dirty = true; }
  }];
}
// 依赖数组比较：与 React 一致，deps 不变则不重跑（[] = 仅挂载时跑一次）。
// 没有 deps 时按 React 语义"每次渲染都跑"。
function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function useEffect(fn, deps) {
  const i = hookCursor++;
  const s = slot(i);
  const isFirst = !s.ran;
  if (!isFirst && deps !== undefined && sameDeps(s.deps, deps)) return;
  s.ran = true;
  s.deps = deps;
  try {
    if (typeof s.cleanup === "function") s.cleanup();
    s.cleanup = fn();
  } catch (e) {
    s.error = true;
    effectsFailed.push(e.message);
  }
}
function useRef(init) { const i = hookCursor++; const s = slot(i); if (!("v" in s)) s.v = { current: init }; return s.v; }
const React = { createElement, useState, useEffect, useRef };

// ---- 遍历式渲染器（点击/输入都以"匹配到就调 handler"模拟）----
let pendingClicks = [];
let pendingInputs = [];   // 模拟键入/选择：match(tag, props) → true 时调 onChange({target:{value}})
const clicked = [];
const typed = [];
function walk(node, key) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n, i) => walk(n, key + "." + i)).join("");
  const { type, props, children } = node;
  if (typeof type === "function") {
    const name = type.name || "anon";
    pathStack.push(key + ":" + name);
    const saved = hookCursor;
    hookCursor = 0;
    let out;
    try { out = type(Object.assign({}, props, { children: children.length === 1 ? children[0] : children })); }
    finally { hookCursor = saved; pathStack.pop(); }
    return walk(out, key + ">" + name);
  }
  const inner = children.map((n, i) => walk(n, key + "." + i)).join("");
  const pi = pendingClicks.findIndex((p) => p.match(type, inner, props));
  if (pi >= 0 && typeof props.onClick === "function") {
    const rule = pendingClicks.splice(pi, 1)[0];
    clicked.push(rule.label);
    props.onClick({});
  }
  const ii = pendingInputs.findIndex((p) => p.match(type, props));
  if (ii >= 0 && typeof props.onChange === "function") {
    const rule = pendingInputs.splice(ii, 1)[0];
    typed.push(rule.label);
    props.onChange({ target: { value: rule.value } });
  }
  return inner;
}
async function renderTree(el, rounds = 8) {
  let html = "";
  for (let i = 0; i < rounds; i++) {
    dirty = false;
    pathStack = ["root"];
    html = walk(el, "root");
    await new Promise((r) => setTimeout(r, 0));   // 让 fetch / promise 链落地
    if (!dirty && !pendingClicks.length && !pendingInputs.length) break;
  }
  return html;
}

// ---- 浏览器环境桩（client.js 只用 document 注入样式与挂全局监听，全部有 try/catch）----
const calls = [];
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement() { return { textContent: "", style: {}, appendChild() {} }; },
  head: { appendChild() {} }, documentElement: { appendChild() {} },
  body: { backgroundColor: "rgb(24,24,27)" },
};
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  calls.push(method + " " + u);
  const body =
    u.includes("/bayes-predict/watchlist/add") ? fixtures.watchlistAdd
      : u.includes("/bayes-predict/watchlist/remove") ? { ok: true, action: "remove", removed: true, codes: fixtures.watchlistCodes.codes.slice(1), count: fixtures.watchlistCodes.count - 1 }
        : u.includes("/bayes-predict/watchlist/clear") ? { ok: true, action: "clear", cleared: fixtures.watchlistCodes.count, codes: [], count: 0 }
          : u.includes("codesOnly=1") ? fixtures.watchlistCodes
            : u.includes("/bayes-predict/watchlist") ? fixtures.watchlist
              : u.includes("/bayes-predict/screen") ? fixtures.screen
                : u.includes("/bayes-predict/analyze") ? fixtures.analyze
                  : u.includes("/bayes-predict/pools") ? { ok: true, pools: { all: { label: "A股全量", count: 5211 }, sh300: { label: "沪深300成分", count: 298 }, "cap_小盘": { label: "小盘市值", count: 3405 } } }
                    : { ok: false, error: "未预期的请求 " + u };
  return { ok: true, status: 200, json: async () => body };
};

// ---- 加载 bundle ----
let mod = null;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      assert.equal(reg.id, "dsh-bayes-predict", "bundle 注册 id 应为包名");
      mod = reg.factory((name) => {
        if (name === "react") return React;
        throw new Error("未预期的 require：" + name);
      });
    },
  },
};
new Function("window", src)(globalThis.window);

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq_ = (a, b, m) => { assert.equal(a, b, m); checks++; };
ok(mod !== null, "bundle 应通过 __ModuleLoader__ 注册自身");
ok(typeof mod.apply === "function", "bundle 应导出 apply");
assert.deepEqual(mod.inject, ["slots"], "inject 应为 [slots]");
checks++;
const I = mod.__internals;

// ---- 阶段 0：插件入口注册 ----
const registered = [];
mod.apply({
  slots: {
    inject(name, cb) { registered.push(name); return cb(); },
    register(opt) { registered.push(opt.name + "#" + (opt.id || "")); return null; },
  },
});
ok(registered.includes("sidebar.footer.action"), "入口应注册到 sidebar.footer.action");
ok(registered.includes("sidebar.footer.action#bayes-predict-panel"), "注册项 id 应为 bayes-predict-panel");

// ---- 阶段 1：浮层 + 四个页签的空闲态 ----
const tree = React.createElement(I.StockSidebarButton, null);
let html = await renderTree(tree);
ok(html.includes("股票分析"), "浮层标题应存在");
for (const t of ["策略回测", "选股筛选", "自选股", "单股分析"]) ok(html.includes(t), `页签「${t}」应存在`);
ok(html.includes("开始筛选"), "空闲态应有「开始筛选」按钮");
ok(calls.some((u) => u.includes("watchlist?codesOnly=1")), "挂载时应拉取自选清单（轻量）");
ok(effectsFailed.length === 0, "挂载期 effect 不应抛错：" + effectsFailed.join(" | "));

// ---- 阶段 2：点「开始筛选」→ 结果表格 ----
const first = fixtures.screen.rows[0];
pendingClicks.push({ label: "开始筛选", match: (tag, text) => tag === "button" && text.includes("开始筛选") });
html = await renderTree(tree);
ok(calls.some((u) => u.includes("/bayes-predict/screen")), "应请求 /bayes-predict/screen");
ok(calls.some((u) => u.includes("pool=all")), "默认资源池应为 A股全量");
ok(html.includes("选股结果"), "应渲染选股结果卡片");
ok(html.includes(first.code), `表格应含首行代码 ${first.code}`);
ok(html.includes(first.name), `表格应含首行名称 ${first.name}`);
ok(html.includes(String(first.score)), `表格应含首行评分 ${first.score}`);
for (const h of ["代码", "名称", "板块", "现价", "涨跌幅", "评分", "后验概率", "市值(亿)", "上市(天)"]) ok(html.includes(h), `表头应含「${h}」`);
ok(html.includes("加入或移出自选股"), "应有 ★ 加自选的说明");
ok(html.includes("加自选（当前"), "应有「整批加自选」按钮");
ok(html.includes("点击任意行"), "应有「点行跳单股分析」提示");
ok(html.includes("行情数据截至"), "应展示数据截止信息");
ok(effectsFailed.length === 0, "筛选后不应有 effect 抛错：" + effectsFailed.join(" | "));
// 已在自选里的代码应显示实心 ★，未加入的显示空心 ☆
ok(html.includes("★"), "已自选的股票应显示 ★");
ok(html.includes("☆"), "未自选的股票应显示 ☆");

// ---- 阶段 2b：点星标 → POST 加入自选（且不触发整行的跳转） ----
const notInWl = fixtures.screen.rows.find((r) => !fixtures.watchlistCodes.codes.includes(r.code));
ok(notInWl != null, "夹具里应有一只尚未自选的股票");
const analyzeCallsBefore = calls.filter((u) => u.includes("/bayes-predict/analyze")).length;
pendingClicks.push({
  label: "点 ☆ 加入自选 " + notInWl.code,
  match: (tag, text, props) => tag === "button" && text === "☆" && typeof props.onClick === "function",
});
html = await renderTree(tree);
ok(calls.some((u) => u.startsWith("POST ") && u.includes("/bayes-predict/watchlist/add") && u.includes(notInWl.code)),
  `点 ☆ 应对 ${notInWl.code} 发起 POST 加自选`);
ok(calls.filter((u) => u.includes("/bayes-predict/analyze")).length === analyzeCallsBefore,
  "点星标不应触发整行的单股分析跳转（stopPropagation 生效）");
ok(html.includes("已加入自选"), "应给出加入自选的反馈文案");
ok(html.includes("自选日"), "反馈里应包含自选日");

// ---- 阶段 3：点表格行 → 跳「单股分析」并自动分析 ----
pendingClicks.push({
  label: "点击行 " + first.code,
  match: (tag, text, props) => tag === "tr" && typeof props.onClick === "function" && text.includes(first.code),
});
html = await renderTree(tree);
ok(calls.some((u) => u.includes("/bayes-predict/analyze") && u.includes(first.code)), `点行应对 ${first.code} 发起单股分析`);
ok(html.includes("综合判断"), "应渲染单股分析…综合判断卡片");
ok(html.includes("信号证据明细"), "应渲染信号证据明细");
ok(html.includes("多窗口后验对比"), "应渲染多窗口后验对比");
ok(html.includes(fixtures.analyze.quote.name), "应渲染夹具里的股票名称");
ok(effectsFailed.length === 0, "跳转后不应有 effect 抛错：" + effectsFailed.join(" | "));

// ---- 阶段 3b：切到「自选股」页签 → 自选日 / 自选日至今涨跌幅（精简布局） ----
pendingClicks.push({ label: "切到自选股页签", match: (tag, text) => tag === "button" && text === "自选股" });
html = await renderTree(tree);
ok(calls.some((u) => u.includes("/bayes-predict/watchlist?horizon")), "切页签应请求自选股报告");
ok(html.includes("⭐ 自选股"), "应渲染自选股卡片");
// 核心列必须都在
for (const h of ["名称", "自选日", "自选价", "最新价", "自选日至今", "评分"]) ok(html.includes(h), `自选表头应含「${h}」`);
for (const it of fixtures.watchlist.items) {
  ok(html.includes(it.code), `自选表应含 ${it.code}`);
  ok(html.includes(it.name), `自选表应含 ${it.name}`);
  ok(html.includes(it.anchorDate), `自选表应含自选日 ${it.anchorDate}（${it.code}）`);
}
// 汇总压成一行而不是一堆卡片，且必须显示实时行情状态
ok(html.includes("只 ｜ 平均"), "汇总应为一行文本（只数 ｜ 平均）");
ok(html.includes("盈 ") && html.includes("亏 ") && html.includes("平 "), "汇总应含盈亏平统计");
ok(html.includes("实时") && html.includes("只 @"), "汇总应显示实时只数与行情时间（实时 N/M 只 @MM-DD HH:mm）");
// 实时价必须真的渲染出来（夹具里 live=true，现价取实时报价而非缓存收盘）
// 注意：面板的 fmtPrice 对 ≥1000 的价格不保留小数，断言要跟它一致
const fmtPriceLike = (x) => (Number(x) >= 1000 ? Number(x).toFixed(0) : Number(x).toFixed(2));
const liveItem = fixtures.watchlist.items.find((x) => x.live);
ok(liveItem != null, "夹具里应有 live=true 的自选股");
ok(html.includes(fmtPriceLike(liveItem.lastClose)), `应渲染实时现价 ${fmtPriceLike(liveItem.lastClose)}`);
ok(html.includes(fmtPriceLike(liveItem.anchorClose)), `应渲染真实价自选价 ${fmtPriceLike(liveItem.anchorClose)}`);
ok((html.match(/实时/g) || []).length >= 2, "每行实时价上应有「实时」标记");
// 工具条压成一行
for (const t of ["加入", "🔄 刷新", "🗑 清空"]) ok(html.includes(t), `工具条应含「${t}」`);
ok(html.includes("自选日 = 收益起点"), "应保留一句话口径说明");
ok(html.includes("真实价口径"), "说明里应点明涨跌幅用真实价（不复权）口径");
// 精简守卫：明细字段必须留在 tooltip 里，不能再回到表头（否则 880px 浮层又要横向滚动）
for (const gone of ["期间最高/最低", "期间最大回撤", "最新评分", "板块"]) ok(!html.includes(gone), `表头不应再出现「${gone}」（应留在 tooltip）`);
ok(!html.includes("正在计算自选股的锚点收益与最新评分…"), "加载文案也应保持简短");
ok(effectsFailed.length === 0, "自选股页不应有 effect 抛错：" + effectsFailed.join(" | "));

// ---- 阶段 3c：点自选股行 → 同样跳「单股分析」 ----
const wlFirst = fixtures.watchlist.items[0];
pendingClicks.push({
  label: "点击自选行 " + wlFirst.code,
  match: (tag, text, props) => tag === "tr" && typeof props.onClick === "function" && text.includes(wlFirst.code),
});
html = await renderTree(tree);
ok(calls.some((u) => u.includes("/bayes-predict/analyze") && u.includes(wlFirst.code)), `点自选行应对 ${wlFirst.code} 发起单股分析`);
ok(html.includes("综合判断"), "自选行跳转后应渲染单股分析");

// ---- 阶段 3d：在「列表栏」上用筛选条件过滤（自选日区间 / 代码 / 拼音首字母 / 名称 / 盈亏 / 评分）----
// 夹具：600519 贵州茅台(2026-08-05, -8.31%, 46) / 601728 中国电信(2026-09-08, +7.14%, 58)
//       601988 中国银行(2026-10-15, 0%, 62) / 601939 建设银行(2026-10-14, 0%, 58)
const CODES = fixtures.watchlist.items.map((x) => x.code);
const rowsShown = (h2) => CODES.filter((c) => h2.includes(c)).length;
const SEARCH = { label: "搜索框", match: (tag, props) => tag === "input" && String(props.placeholder || "").includes("代码 / 拼音 / 名称") };
const pickSearch = (q) => pendingInputs.push(Object.assign({}, SEARCH, { value: q, label: `搜索「${q}」` }));

// 阶段 3c 结束时停在「单股分析」，先切回自选股页再测筛选
pendingClicks.push({ label: "切回自选股页签", match: (tag, text) => tag === "button" && text === "自选股" });
html = await renderTree(tree);
// 初始：4 只全在
eq_(rowsShown(html), 4, "未筛选时应显示全部 4 只");
ok(html.includes("4 只 ｜ 平均"), "未筛选时汇总显示总数而不是匹配数");
// 按中文名称模糊搜索
pickSearch("茅台");
html = await renderTree(tree);
eq_(rowsShown(html), 1, "搜「茅台」应只剩 1 只");
ok(html.includes("600519") && !html.includes("601728"), "搜「茅台」应命中贵州茅台且排除其他");
ok(html.includes("匹配 1 / 共 4 只"), "汇总应显示 匹配 1 / 共 4");

// 按拼音首字母搜索（多音字变体：ZGYH 是中国银行"银行"读 háng 的变体）
pickSearch("ZGYH");
html = await renderTree(tree);
eq_(rowsShown(html), 1, "搜拼音首字母 ZGYH 应只剩 1 只");
ok(html.includes("601988"), "ZGYH 应命中中国银行（多音字变体生效）");

// 按 YY 前缀搜不到，改搜 YH（两家银行）
pickSearch("YH");
html = await renderTree(tree);
eq_(rowsShown(html), 2, "搜 YH 应命中两家银行");
ok(html.includes("601988") && html.includes("601939"), "YH 应命中中国银行 + 建设银行");
ok(!html.includes("600519") && !html.includes("601728"), "YH 不应命中非银行股");

// 按代码前缀
pickSearch("6019");
html = await renderTree(tree);
eq_(rowsShown(html), 2, "搜 6019 应命中 601988 / 601939");
ok(!html.includes("600519"), "代码搜索不应带出 600519");

// 搜不到 → 空结果提示 + 保留筛选行（否则连重置都没了）
pickSearch("ZZZZ");
html = await renderTree(tree);
eq_(rowsShown(html), 0, "无匹配时不应显示任何行");
ok(html.includes("没有匹配的自选股"), "应给出空结果提示");
ok(html.includes("重置"), "空结果时仍应能重置（筛选行保留）");

// 重置恢复全部
pendingClicks.push({ label: "重置筛选", match: (tag, text) => tag === "button" && text === "重置" });
html = await renderTree(tree);
eq_(rowsShown(html), 4, "重置后应恢复 4 只");

// 自选日区间：用夹具里真实的自选日算期望值（夹具每次重生成日期会变，不能写死）
const anchors = fixtures.watchlist.items.map((x) => x.anchorDate).sort();
const dFrom = anchors[0];                     // 最早自选日
const dTo = anchors[anchors.length - 2];      // 次晚自选日
const expectFrom = fixtures.watchlist.items.filter((x) => x.anchorDate >= dFrom).map((x) => x.code);
const expectRange = fixtures.watchlist.items.filter((x) => x.anchorDate >= dFrom && x.anchorDate <= dTo).map((x) => x.code);
pendingInputs.push({ label: "自选日起始 " + dFrom, value: dFrom, match: (tag, props) => tag === "input" && props.type === "date" && String(props.title || "").includes("自选日 ≥") });
html = await renderTree(tree);
eq_(rowsShown(html), expectFrom.length, `自选日 ≥ ${dFrom} 应剩 ${expectFrom.length} 只`);
for (const c of expectFrom) ok(html.includes(c), `${c} 应保留`);
ok(html.includes(`匹配 ${expectFrom.length} / 共 ${CODES.length} 只`), `汇总应显示 匹配 ${expectFrom.length} / 共 ${CODES.length}`);

// 叠加结束日期：区间应收窄到 dFrom..dTo
pendingInputs.push({ label: "自选日截止 " + dTo, value: dTo, match: (tag, props) => tag === "input" && props.type === "date" && String(props.title || "").includes("自选日 ≤") });
html = await renderTree(tree);
eq_(rowsShown(html), expectRange.length, `区间 ${dFrom}~${dTo} 应剩 ${expectRange.length} 只`);
for (const c of expectRange) ok(html.includes(c), `${c} 应在区间内`);
for (const c of CODES.filter((x) => !expectRange.includes(x))) ok(!html.includes(c), `${c} 应在区间外被排除`);

// 清掉日期，按盈亏状态筛（盈利）—— 期望值同样从夹具算
pendingClicks.push({ label: "重置筛选", match: (tag, text) => tag === "button" && text === "重置" });
html = await renderTree(tree);
eq_(rowsShown(html), CODES.length, "重置后恢复全部");
const winners = fixtures.watchlist.items.filter((x) => x.returnSinceAdd > 0).map((x) => x.code);
pendingInputs.push({ label: "只看盈利", value: "win", match: (tag, props) => tag === "select" && String(props.title || "").includes("盈亏状态") });
html = await renderTree(tree);
eq_(rowsShown(html), winners.length, `只看盈利应剩 ${winners.length} 只`);
for (const c of winners) ok(html.includes(c), `盈利的 ${c} 应留下`);

// 评分下限：取夹具里最高评分的一半，期望留下评分 ≥ 该值的那些
pendingClicks.push({ label: "重置筛选", match: (tag, text) => tag === "button" && text === "重置" });
html = await renderTree(tree);
const scores = fixtures.watchlist.items.map((x) => x.score).filter((v) => v != null);
ok(scores.length > 0, "夹具应带评分（否则评分列与评分筛选无从验证）");
const minScore = Math.max(...scores) - 3;
const expectScore = fixtures.watchlist.items.filter((x) => x.score != null && x.score >= minScore).map((x) => x.code);
pendingInputs.push({ label: `评分 ≥ ${minScore}`, value: String(minScore), match: (tag, props) => tag === "input" && String(props.title || "").includes("评分下限") });
html = await renderTree(tree);
eq_(rowsShown(html), expectScore.length, `评分 ≥ ${minScore} 应剩 ${expectScore.length} 只`);
for (const c of expectScore) ok(html.includes(c), `${c} 应留下`);

// 老响应（没有拼音索引字段）时，纯字母查询落空必须给出"需要重启"的提示，而不是静默无结果
pendingClicks.push({ label: "重置筛选(清评分)", match: (tag, text) => tag === "button" && text === "重置" });
html = await renderTree(tree);
eq_(rowsShown(html), 4, "清空评分筛选后应恢复 4 只");
const savedInit = fixtures.watchlist.items.map((x) => ({ v: x.initialsVariants, i: x.initials }));
for (const x of fixtures.watchlist.items) { delete x.initialsVariants; delete x.initials; }
pickSearch("GZMT");
html = await renderTree(tree);
ok(html.includes("没有匹配的自选股"), "缺索引时仍是空结果提示");
ok(html.includes("需要重启 dsh web"), "缺索引时应提示重启 dsh web 才能用拼音首字母搜索");
// 复原夹具，避免影响后续断言
fixtures.watchlist.items.forEach((x, i) => { x.initialsVariants = savedInit[i].v; x.initials = savedInit[i].i; });
pickSearch("GZMT");
html = await renderTree(tree);
eq_(rowsShown(html), 1, "索引恢复后 GZMT 应命中贵州茅台");
ok(!html.includes("需要重启 dsh web"), "有索引时不应再显示重启提示");
ok(effectsFailed.length === 0, "筛选交互不应有 effect 抛错：" + effectsFailed.join(" | "));

// ---- 阶段 4：各页签单独渲染也不应崩 ----
// （渲染器只回传文本节点，"长度"不是有效指标——断言各自的关键文案。）
const standalone = [
  ["ScreenTab", I.ScreenTab, ["选股筛选", "开始筛选", "评分门槛"]],
  ["BacktestTab", I.BacktestTab, ["回测参数", "运行回测", "评分窗口 horizon"]],
  ["StockBayesTab", I.StockBayesTab, ["贝叶斯分析", "示例：600519"]],
  ["WatchlistTab", I.WatchlistTab, ["⭐ 自选股", "加入", "自选日 = 收益起点"]],
];
for (const [name, Comp, needles] of standalone) {
  const out = await renderTree(React.createElement(Comp, { onPick: () => {} }), 3);
  for (const n of needles) ok(out.includes(n), `${name} 应包含「${n}」`);
}
ok(effectsFailed.length === 0, "各页签单独渲染后不应有 effect 抛错：" + effectsFailed.join(" | "));

console.log(`client-render: all ${checks} checks passed（交互：${clicked.join(" → ")}｜输入：${typed.join(" → ")}）`);
