# Changelog

## 1.1.0 (2026-10-16)

从实验版 `dsh-plugin-stock-bayes` 分批迁移全部功能：卡尔曼增益融合与趋势滤波、策略回测与全市场选股、
自选股实时口径、拼音首字母搜索，以及四页签浏览器面板。测试从 2 个文件扩到 9 个
（8 个带计数的文件共 **521** 项检查，另有 9 条路由契约与 8 项代码归一化断言）。

> ⚠️ 模型口径变更：默认融合由手调温度 T=3 改为卡尔曼增益，`MODEL_VERSION` 由 1 递增到 **2**，
> 旧评分缓存会失效重建；`opts.fusion = "temperature"` 可回退旧行为。

### 卡尔曼增益融合（模型升级，MODEL_VERSION 1 → 2）

- 新增 `lib/kalman.js`：对数价格的局部线性趋势（LLT）状态空间滤波，提供滤波斜率 t 值与
  标准化新息两个新信号源（`kalman_slope` / `kalman_innov`）；只做前向递推，不含 RTS 平滑，
  以杜绝把未来观测泄漏进经验四格表
- 融合层默认由手调温度 `T=3` 改为**卡尔曼增益** `K = P⁻/(P⁻+R)`：观测方差 R 由 LR 四格表
  经 Katz 对数风险比近似给出（含收缩/混合的雅可比修正），先验方差 P⁻ 由先验有效样本量给出，
  因此收缩强度逐股逐日自适应，等价温度 `T_eff = 1/K` 不再需要手调；
  `opts.fusion = "temperature"` 可回退旧行为
- 卡尔曼信号默认**关闭**（`KALMAN_PARAMS.signalsEnabled = false`）：52 只沪深300 十年样本外
  消融显示加信号后 ΔBrier = +0.00026（且移除趋势类信号后仍为 +0.00021，并非冗余问题），
  研究时可用 `opts.kalmanSignals = true` 打开
- 报告新增融合诊断：`calibration.fusion` / `kalmanGain` / `effectiveTemperature` /
  `priorVar` / `obsVar` / `stateVar`，以及顶层 `kalman` 滤波状态快照；
  `logOdds` 改为**实际作用于先验的增量**（温度路径为 Σ/T，卡尔曼路径为 K·Σ），
  未收缩的原始证据和另见 `calibration.evidenceLogOdds`
- `MODEL_VERSION` 递增到 2：评分缓存（`scores/h*.json`）据此失效重建，避免新旧模型结果混用
- 测试：新增 `test/kalman.test.mjs`（57 项）；`test/smoke.mjs` 扩充到 36 项并保留原有基础覆盖

### 行情层：批量报价与指数数据

- `market.js` 把腾讯 `~` 分隔字段的解析抽成 `parseTencentQuoteFields`（单只与批量共用），
  正式版原有 `fetchTencentQuote` 行为不变
- 新增 `fetchTencentQuotes`：腾讯同一接口支持 `q=a,b,c`，按 60 只分批一次拉多只实时行情
  （自选股页用，避免 N 次往返）；某批失败只丢该批，调用方回退缓存价
- 新增 `quoteDateOf`（时间戳 → 交易日）与 `fetchIndexData`（东财指数日 K，用于市场 beta 信号，带 TTL 缓存）

### 拼音首字母搜索

- 新增 `lib/pinyin.js`：经典 GB2312 码段法实现「汉字 → 拼音首字母」，不引入拼音库以维持零外部依赖；
  含多音字变体展开（招商银行 → ZSYX / ZSYH），供自选股与选股列表的模糊搜索使用

### 回测与全市场筛选

- 新增 `lib/backtest.js`：参数化回测引擎（**严格防前视**——换仓日只用当日为止的数据现场计算评分）、
  单日截面选股 `screenStocks`、多 horizon 评分序列（指标与历史信号跨 horizon 共享，一次 O(n)）、
  大盘择时、交易成本与涨跌停/停牌处理、ST 与价格/市值/上市天数等筛选条件
- 新增 `lib/backtest-data.js`：资源池与行情缓存（`<cacheRoot>`）、列式编码、
  沪深300 成分加载、缓存增量刷新
- 新增 `lib/csi300-components.json`：沪深300 成分快照（供指数池与历史市值推算）
- 新增 `test/screen.test.mjs`（129 项）

### 自选股与实时口径

- 新增 `lib/watchlist.js`：自选股持久化（`<cacheRoot>/watchlist.json`，跨会话、跨浏览器）、自选日锚定价
  与「自选日至今」统计；评分直接复用 `screenStocks`，与筛选/回测共用同一份评分缓存与同一套模型；
  每条自选同时记录后复权价与不复权真实价两套口径
- 新增 `lib/realtime.js`：把「自选日 → 现在」的口径从本地缓存日线升级为**实时现价**。
  实时接口只能拿到真实价，而腾讯 hfq 日线常不含当日 bar、且与真实价之间存在复权断层
  （茅台 hfq≈9200 vs 真实≈1317），混算会得出 -84% 这类荒唐跌幅，因此自选页单独采用真实价口径
  （锚点取不复权收盘、最新价取实时报价）；只有真的拿到报价才标记 `live=true`，否则回退缓存价而不谎称实时
- 新增 `test/watchlist.test.mjs`（78 项）、`test/realtime.test.mjs`（36 项）

### Host 层：回测 / 筛选 / 自选路由与报告增强

- 新增 7 条同源路由：`/bayes-predict/backtest`（含「低分 Top」对照曲线、多窗口缓存预热）、
  `/bayes-predict/screen`（单日截面选股）、`/bayes-predict/refresh`（手动刷新缓存）、
  `/bayes-predict/pools`（资源池与标签）、`/bayes-predict/watchlist`（自选报告，`codesOnly=1` 轻量取代码），
  以及 `/bayes-predict/watchlist/add|remove|clear`（一律 POST，避免预取/缓存把 GET 当副作用请求）
- `bayes_stock_predict` 工具新增 `backtest` 参数；报告新增「模型历史校准」段（walk-forward 方向准确率、
  Brier 与无信息基线对比、卡尔曼/T=1/手调 T=3/只用先验四条口径对照）与卡尔曼趋势滤波诊断行
- 报告措辞澄清：区分「证据原始 log-odds 和」与「实际作用于先验的增量」，
  避免把收缩前的变化量误读为实得变化
- 保留正式版既有行为：方向标签按**实际贡献**符号显示、MACD 柱按贡献显示多头/空头扩张、先验主导提示；
  工具名保持 `bayes_stock_predict`，全部路由统一前缀 `/bayes-predict/`
- 新增 `test/routes.test.mjs`：用假 ctx 收集注册结果，锁定「1 个 Host 工具 + 9 条路由」的命名契约

### 浏览器面板：策略回测 / 选股筛选 / 自选股 / 单股分析 四页签

- 侧边栏入口（📊 贝叶斯股票分析）改为浮层 + 四个页签：**策略回测**（净值曲线、低分 Top 对照、参数表单）、
  **选股筛选**（筛选条件 + 排序 + 拼音首字母搜索 + 一键加自选）、**自选股**（自选日至今实时统计、只看盈利筛选）、
  **单股分析**（原有报告）；选股表/自选表点行可直接跳转到单股分析
- 保留正式版既有行为：未发起分析时的「**算法说明**」空态（口径已更新为卡尔曼增益融合，并补充卡尔曼趋势滤波
  及其默认关闭的原因）、方向标签按**实际贡献符号**显示、近 60 日走势图用**收盘价**绘制（原用错列）、
  关闭按钮的圆形幽灵样式（`.dsh-sb-close`）
- 面板文案与报告口径对齐：区分「证据原始 log-odds 和」与「实际作用于先验的增量」；
  先验与后验持平时给出「先验主导」解读
- 命名统一：包注册 id `dsh-bayes-predict`、面板 id `bayes-predict-panel`、全部请求路径 `/bayes-predict/*`
- 新增 `test/client-render.test.mjs`（138 项：四页签交互链路 + 拼音搜索 + 注册契约）

## 1.0.0 (2026-08-22)

- 贝叶斯核心：双向经验似然比（四格表 + 时间衰减 + 样本收缩）、odds 乘法更新、温度收缩 T=3
- 13 类技术信号（MACD/RSI/均线/布林带/量能/动量/影线/跳空/缠论背驰等），方向经历史实证校准
- 分层先验：单股 LR 与全市场横截面通用表（market-prior.json）混合
- 多窗口后验对比（2/5/10/20 日）、贝叶斯三状态趋势分类
- 风险估计：EWMA 波动率（λ=0.94）+ 经验分位数 VaR/CVaR + 最大回撤
- 数据源：腾讯 hfq 日 K（含复权断层检测）、东财兜底、腾讯/新浪实时、美股新浪全历史，30 分钟 TTL 缓存
- Host 工具 `bayes_stock_predict` + 浏览器面板（侧边栏 📊 入口）
