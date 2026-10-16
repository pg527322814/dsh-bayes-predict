# Changelog

## Unreleased

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

## 1.0.0 (2026-08-22)

- 贝叶斯核心：双向经验似然比（四格表 + 时间衰减 + 样本收缩）、odds 乘法更新、温度收缩 T=3
- 13 类技术信号（MACD/RSI/均线/布林带/量能/动量/影线/跳空/缠论背驰等），方向经历史实证校准
- 分层先验：单股 LR 与全市场横截面通用表（market-prior.json）混合
- 多窗口后验对比（2/5/10/20 日）、贝叶斯三状态趋势分类
- 风险估计：EWMA 波动率（λ=0.94）+ 经验分位数 VaR/CVaR + 最大回撤
- 数据源：腾讯 hfq 日 K（含复权断层检测）、东财兜底、腾讯/新浪实时、美股新浪全历史，30 分钟 TTL 缓存
- Host 工具 `bayes_stock_predict` + 浏览器面板（侧边栏 📊 入口）
