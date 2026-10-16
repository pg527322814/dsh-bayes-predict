// dsh-bayes-predict / test/routes.test.mjs
// Host 入口契约测试：不联网、不起服务，只用一个假的 ctx 收集注册结果，
// 断言 Host 工具名与全部 HTTP 路由路径 —— 这是合并实验版功能时最容易因命名不一致而错的地方。
import assert from "node:assert/strict";
import { apply, inject, name } from "../lib/index.js";

assert.equal(name, "dsh-bayes-predict", "插件导出名须保持正式版包名");
assert.deepEqual(inject, ["tools", "webServer"], "注入的服务名须保持不变");

const tools = [];
const routes = [];
const ctx = {
  tools: { register: (def) => tools.push(def) },
  webServer: { register: (r) => routes.push(r) },
};
apply(ctx);

// ---- Host 工具契约 ----
assert.equal(tools.length, 1, "应恰好注册 1 个 Host 工具");
const tool = tools[0];
assert.equal(tool.name, "bayes_stock_predict", "工具名须保持正式版既有命名（不得回到 stock_analyze）");
assert.equal(typeof tool.description, "string");
assert.ok(tool.parameters?.properties?.symbol, "工具须声明 symbol 参数");
assert.ok(tool.parameters?.properties?.horizon, "工具须声明 horizon 参数");
assert.ok(tool.parameters?.properties?.backtest, "工具须声明 backtest 参数（walk-forward 校准）");
assert.deepEqual(tool.parameters?.required, ["symbol"], "symbol 应是唯一必填参数");

// ---- HTTP 路由契约 ----
const paths = routes.map((r) => r.path).sort();
const expected = [
  "/bayes-predict/analyze",
  "/bayes-predict/backtest",
  "/bayes-predict/pools",
  "/bayes-predict/refresh",
  "/bayes-predict/screen",
  "/bayes-predict/watchlist",
  "/bayes-predict/watchlist/add",
  "/bayes-predict/watchlist/clear",
  "/bayes-predict/watchlist/remove",
].sort();
assert.deepEqual(paths, expected, "路由集合应与文档一致（前缀 /bayes-predict/）");
assert.ok(routes.every((r) => r.kind === "exact"), "所有路由都应是 exact 匹配");
assert.ok(routes.every((r) => typeof r.handler === "function"), "每个路由都必须有 handler");
assert.ok(!paths.some((p) => p.includes("stock-bayes")), "不得残留实验版路由前缀");

console.log(`routes: all ${expected.length} routes + host tool contract passed`);
