# dsh-bayes-predict

[![CI](https://github.com/pg527322814/dsh-bayes-predict/actions/workflows/ci.yml/badge.svg)](https://github.com/pg527322814/dsh-bayes-predict/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

基于 **贝叶斯定理** 的 DeepSeek Harness 个股预测插件（dual-face：Host 工具 + 浏览器面板）。

> ⚠️ **平台依赖**：本插件是 DeepSeek Harness（dsh）平台的扩展插件，依赖其宿主环境（`dsh web`、cordis 插件系统、`window.__ModuleLoader__` 等）。该平台目前未随本仓库公开，**单独克隆本仓库无法直接运行**，代码仅供学习、参考与移植。

## 功能

| 模块 | 说明 |
|---|---|
| **多指标信号融合评分** | 假设 H =「未来 N 日上涨」。先验取加权历史胜率（shrunk）；MACD 金叉、RSI、均线排列、布林带位置、量能、动量、近 5 日走势等信号作为证据，**双向经验似然比**（看多信号用 LR_bull、看空信号用 LR_bear，时间衰减加权 + 样本收缩），odds 乘法贝叶斯更新 → 后验上涨概率（含 95% 置信区间）+ 0-100 评分与评级 |
| **多窗口对比** | 同时输出 2/5/10/20 日后验对比表 |
| **趋势状态识别** | 贝叶斯 t 检验风格的三状态分类：P(上涨)=P(μ>+δ)、P(下跌)=P(μ<-δ)、P(震荡)，阈值 δ = max(0.5·SE, 年化 5% 经济当量)，防大样本下微小趋势误判 |
| **持仓风险估计** | EWMA 波动率（RiskMetrics λ=0.94）+ **经验分位数 VaR/CVaR 为主**（正态估计对照）、历史最大回撤 |
| **信号归因** | 输出贡献绝对值 Top3 的信号，解释"为什么看多/看空" |

## 安装

1. 插件包拷贝至 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-bayes-predict`
   （该目录不存在时先创建；profile 的 baseUrl 锚定在 `profiles\web`，node 解析会向上逐级查找 node_modules）
2. `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: bayes-predict
      name: 'dsh-bayes-predict'
```

3. 重启 `dsh web`（插件集变更需重启生效；client bundle 的 HMR 仅在 `pnpm run dev:web` 重建时可用）。

> ⚠️ 客户端契约：`lib/client.js` 的 factory **必须导出 `inject` 数组**（如 `exports.inject = ["slots"]`）。
> cordis 依据模块导出的 `inject` 决定注入哪些服务；缺失时 `apply(ctx)` 里访问 `ctx.slots`
> 会直接抛 `cannot get property "slots" without inject`（`package.json` 的 `dsh.client.inject`
> 只影响 boot 清单，不替代模块导出）。

## 使用

**对话中**（重启后开新会话，让 agent 看到新工具）：

```
分析一下 600519
用贝叶斯方法评估一下 300750 未来 5 天的上涨概率
```

**可视化面板**：侧边栏底部「📊 贝叶斯股票分析」快捷按钮（点击弹出居中面板）。输入代码（600519 / sh600519 / 000001 / AAPL），点「贝叶斯分析」。

## 代码结构

```
lib/
├── index.js         Host 端：bayes_stock_predict 工具（全局工具层）+ GET /bayes-predict/analyze 路由 + markdown 报告
├── bayes.js         贝叶斯核心：指标 / 双向信号 / 时间衰减四格表 LR / odds 更新 + 温度收缩 / 趋势 / EWMA-经验风险 / 多窗口
├── market.js        行情获取：代码归一化、腾讯 K 线、腾讯/新浪实时、内存 TTL 缓存
├── market-prior.json 全市场横截面先验（10 只代表性股票聚合的通用 LR 表，启动时自动加载）
└── client.js        浏览器端：React 面板（侧边栏 → 📊 贝叶斯股票分析），SVG 自绘仪表/走势图
```

## 模型要点

- 后验更新：`logit(H) += Σ strength_i·log(LR_i)`，证据贡献经 temperature（默认 **3**）收缩后加回先验 logit
- **双向 LR**：LR_bull = P(看多信号|涨)/P(看多信号|跌)，LR_bear = P(看空信号|涨)/P(看空信号|跌)；四格表统计 + 拉普拉斯平滑 + 向 1 的样本收缩（k=20）+ 单信号截断 [1/4, 4]
- **信号方向实证校准**：
  - 方向正确保留：MACD 金叉/死叉、MACD 柱、近 5 日走势、影线形态 wicks、跳空 gap、缠论背驰 divergence
  - 反转方向：价格 vs MA20（追高后回归）、量能（放量冲高回落/恐慌见底）
  - 弱信号弱化：RSI、均线排列、布林带、动量、ATR（强度打折）
- **时间衰减**：LR 与先验均按指数衰减加权（半衰期 200 交易日），近期样本权重更高
- **波动率归一化**：动量/近 5 日收益信号阈值按滚动 σ 自适应（|x| > 0.5·σ·√k），跨股票可比
- **信号强度**：每个信号输出 strength ∈ (0,1]，弱信号（如 RSI 50 附近）贡献打折
- **分层先验（默认启用）**：启动时加载 `market-prior.json` 通用 LR 表，单股 LR 与之混合（w = n/(n+80)）
- 先验：近 `sampleWindow` 日加权胜率 shrunk 到 0.5（强度 30），`horizon` 默认 5 日
- 风险：EWMA σ（λ=0.94）为主，VaR/CVaR 以经验分位数为主输出、正态近似对照

## 数据源

免费、无需 key：

- **A 股日 K**：腾讯 fqkline 后复权 hfq（最多约 700 根 ≈2023-12 至今；主/备用域名自动切换规避限流），东财后复权兜底
- **实时快照**：腾讯（A 股）/ 腾讯 `us` 前缀（美股）；美股日 K 用新浪全历史
- 内存 TTL 缓存 30 分钟

> ⚠️ 数据口径：评分与单股分析均使用**后复权（hfq）**——收益序列含分红再投资，除权日无假跳空，信号干净；但价格非真实股价。若需真实股价口径请改用不复权。

> ⚠️ **腾讯 hfq 复权断层防护**：腾讯后复权的复权基准随最新交易日滚动，接口返回的最后一天可能发生"跨基准断裂"（假跳变）。`fetchKlines` 已内置断层检测：hfq 最后一天 |单日涨跌| > 8% 时拉不复权序列核对，判定复权断层则丢弃最后一天（宁缺毋滥）。

## 开发

零第三方依赖，Node 18+。

```sh
npm test
```

运行 `test/smoke.mjs`（贝叶斯核心 + 合成 K 线端到端）与 `test/normalize.test.mjs`（代码归一化单测）。

## 卸载

- 删除 `cordis.patch.yml` 中 `bayes-predict` 的 insert 行
- 删除 `node_modules\dsh-bayes-predict`
- 重启 `dsh web`

## 许可证

[MIT](./LICENSE) © pg

> ⚠️ 本插件输出由贝叶斯统计模型基于历史行情生成，仅供参考，不构成投资建议。
