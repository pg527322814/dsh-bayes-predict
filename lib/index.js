// dsh-bayes-predict / index.js —— Host 端（node）插件入口
// 1) 向全局工具注册表注册 `bayes_stock_predict` 工具（所有 agent 可见，对话中可直接调用）
// 2) 在 webserver 上注册 GET /bayes-predict/analyze 路由（浏览器端面板同源调用）
// 零外部依赖：只 import 本包内的 market.js / bayes.js。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchMarketData } from "./market.js";
import { analyzeStock, backtest } from "./bayes.js";
import { runBacktest, screenStocks } from "./backtest.js";
import { readWatchlist, addToWatchlist, removeFromWatchlist, clearWatchlist, watchlistReport } from "./watchlist.js";
import { buildProvider, refreshCache, loadUniversePools, prefixed, cacheRoot } from "./backtest-data.js";

export const name = "dsh-bayes-predict";
export const inject = ["tools", "webServer"];

// 全市场横截面先验（分层 LR）：启动时加载 lib/market-prior.json（build-market-prior.mjs 生成）。
// 单股 LR 与通用先验混合：LR_final = w·个股 + (1-w)·通用，w = n/(n+80)。
let MARKET_PRIOR = null;
const MARKET_PRIOR_STRENGTH = 80;
try {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("./market-prior.json", import.meta.url)), "utf8"));
  if (raw && raw.signals && typeof raw.signals === "object") {
    MARKET_PRIOR = new Map(
      Object.entries(raw.signals).map(([k, v]) => [k, { lrBull: Number(v.lrBull), lrBear: Number(v.lrBear) }]),
    );
  }
} catch {
  MARKET_PRIOR = null;
}

/** 信号 key → 中文名（工具报告与 UI 共用文案）。 */
const SIGNAL_NAMES = {
  macd_cross: "MACD 金叉/死叉",
  macd_hist: "MACD 柱体动能",
  rsi: "RSI 超买超卖",
  ma_align: "均线排列",
  price_ma20: "价格 vs MA20",
  bollinger: "布林带位置",
  volume: "量能配合",
  momentum: "动量 ROC(10)",
  trend_recent: "近 5 日走势",
  wicks: "影线形态",
  gap: "跳空缺口",
  divergence: "背驰（缠论）",
  atr: "波动率扩张",
};

const RATING_COLORS = {
  强烈看多: "#16a34a",
  看多: "#22c55e",
  中性偏多: "#84cc16",
  中性偏空: "#eab308",
  看空: "#f97316",
  强烈看空: "#ef4444",
};

/** 递归清洗 NaN/Infinity → null（canonical JSON 需要）。 */
function cleanJson(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(cleanJson);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = cleanJson(v[k]);
    return o;
  }
  return v;
}

function pct(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

function pctPt(x, digits = 2) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x.toFixed(digits)}%`;
}

function renderReport(report) {
  // symbol / market 在 report 顶层（quote 对象内没有这两个字段）
  const { symbol, market } = report;
  const { name: stockName, price, changePercent, pe, pb, totalMarketCapYi, turnover } = report.quote;
  const cal = report.calibration ?? {};
  const ci = cal.posteriorCI ?? [];
  const L = [];
  L.push(`## 📊 ${stockName}（${symbol}）贝叶斯分析`);
  L.push(
    `**现价** ${price ?? "—"}（${changePercent != null && Number.isFinite(changePercent) ? `${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%` : "—"}）｜` +
    `**评分 ${report.score}/100（${report.rating}）** ｜ 市场：${market === "cn" ? "A股" : "美股"}｜数据截至 ${report.quote.time || report.klines?.at(-1)?.[0] || "—"}`,
  );
  if (pe != null || pb != null) {
    L.push(
      `- 估值：PE ${pe != null && Number.isFinite(pe) ? pe.toFixed(1) : "—"} ｜ PB ${pb != null && Number.isFinite(pb) ? pb.toFixed(2) : "—"}` +
      (totalMarketCapYi != null && Number.isFinite(totalMarketCapYi) ? ` ｜ 总市值 ${totalMarketCapYi.toFixed(0)} 亿` : "") +
      (turnover != null && Number.isFinite(turnover) ? ` ｜ 换手率 ${turnover.toFixed(2)}%` : ""),
    );
  }
  L.push("");
  L.push(`### 🎯 综合判断（未来 ${report.horizon} 个交易日上涨概率）`);
  // logOdds 是**实际作用于先验**的增量；原始证据和单独展示，避免把收缩前的变化量误读为实得变化
  const rawLo = Number.isFinite(cal.evidenceLogOdds) ? cal.evidenceLogOdds : report.logOdds;
  L.push(
    `- 先验概率（历史胜率）：${pct(report.prior)} → 后验概率：**${pct(report.posterior)}**` +
    (ci.length === 2 && ci.every((v) => v != null && Number.isFinite(v)) ? `（95% 区间 ${pct(ci[0])} ~ ${pct(ci[1])}）` : "") +
    (report.signalCount
      ? `（证据原始 log-odds 和 ${rawLo >= 0 ? "+" : ""}${rawLo.toFixed(3)} → 实际作用于先验 ${report.logOdds >= 0 ? "+" : ""}${report.logOdds.toFixed(3)}，共 ${report.signalCount} 个有效信号）`
      : "（无有效信号，后验≈先验）"),
  );
  if (cal.effectiveSamples) {
    // 默认融合是卡尔曼增益：收缩强度由数据决定（等价 T_eff = 1/K），不再依赖手调常数
    const shrinkTxt = cal.fusion === "kalman" && cal.kalmanGain != null
      ? `卡尔曼增益 K=${cal.kalmanGain.toFixed(3)}｜等价收缩 T_eff=${cal.effectiveTemperature}（按证据样本量与相关性自适应，无需手调）`
      : `证据收缩 T=${cal.temperature ?? 1}（校正相关信号过度自信）`;
    L.push(`- 有效样本：${cal.effectiveSamples} 个交易日 ｜ ${shrinkTxt}`);
  }
  {
    // 先验与后验几乎持平 → 提示"先验主导"，避免"信号弱结论却偏多"的误读
    const shiftPp = (report.posterior - report.prior) * 100;
    if (Math.abs(shiftPp) < 1) {
      L.push(
        `- ℹ️ 解读：信号仅使概率移动 ${shiftPp >= 0 ? "+" : ""}${shiftPp.toFixed(1)} 个百分点，本次结论主要由**先验（近期历史胜率）**主导。` +
        `信号较少或较弱时结论贴近先验是模型预期行为（证据经收缩后温和修正基率，不颠覆基率），并非异常`,
      );
    }
  }
  if (report.kalman && report.kalman.slopeT != null) {
    const kf = report.kalman;
    L.push(
      `- 卡尔曼趋势滤波（LLT 状态空间）：斜率 t=${kf.slopeT.toFixed(2)}（年化 ${kf.slopeAnnualized ?? "—"}%）｜ ` +
      `标准化新息 z=${kf.innovZ != null ? kf.innovZ.toFixed(2) : "—"}（|z|>${kf.thresholds?.innovZ ?? 1.5} 表示价格显著偏离模型一步预测）`,
    );
  }
  L.push("");
  if (report.multiHorizon?.length) {
    L.push("### ⏱ 多窗口后验对比");
    L.push("| 窗口 | 先验 | 后验 | 评分 | 评级 |");
    L.push("|---|---|---|---|---|");
    for (const h of report.multiHorizon) {
      L.push(`| ${h.horizon} 日 | ${pct(h.prior)} | ${pct(h.posterior)} | ${h.score} | ${h.rating} |`);
    }
    L.push("");
  }
  if (report.evidence.length) {
    L.push("### 📈 信号证据明细（双向经验似然比，4 倍截断 + 样本收缩）");
    L.push("| 信号 | 方向 | 强度 | LR | 贡献 | 样本 |");
    L.push("|---|---|---|---|---|---|");
    for (const e of report.evidence) {
      // 标签按实际贡献符号显示：名义方向经实证校准后可能与贡献相反（如 价格vsMA20、量能 的反转计入）
      const dirTxt = e.contribution > 0 ? "看多" : e.contribution < 0 ? "看空" : "中性";
      const contrib = e.contribution >= 0 ? `+${e.contribution.toFixed(3)}` : e.contribution.toFixed(3);
      L.push(`| ${SIGNAL_NAMES[e.key] ?? e.key} | ${dirTxt} | ${(e.strength ?? 1).toFixed(2)} | ${e.lr.toFixed(2)} | ${contrib} | ${e.samples} |`);
    }
    L.push("");
  }
  if (report.attribution?.length) {
    L.push(
      `**信号归因**：` +
      report.attribution
        .map((a) => `${SIGNAL_NAMES[a.key] ?? a.key}（${a.contribution > 0 ? "看多" : a.contribution < 0 ? "看空" : "中性"} ${a.contribution >= 0 ? "+" : ""}${a.contribution.toFixed(3)}）`)
        .join(" ｜ "),
    );
    L.push("");
  }
  const t = report.trend;
  L.push("### 🧭 趋势状态（贝叶斯三状态分类）");
  L.push(
    `- 上涨 ${pct(t.bull)} ｜ 震荡 ${pct(t.flat)} ｜ 下跌 ${pct(t.bear)} → 主导状态：**${t.state === "bull" ? "上涨" : t.state === "bear" ? "下跌" : "震荡"}**`,
  );
  L.push("");
  // 模型历史校准（walk-forward 回测，可选参数 backtest=true 时附带）
  const mq = report.modelQuality;
  if (mq && mq.n && mq.n > 20) {
    L.push("### 📊 模型历史校准（walk-forward 回测，严格防前视）");
    L.push(`- 样本：${mq.n} 个历史预测点 ｜ 基准上涨率 ${pct(mq.baseRate)} ｜ 方向准确率：**${(mq.accuracy * 100).toFixed(1)}%**`);
    L.push(
      `- Brier：${mq.brier.toFixed(3)}（无信息基线 ${mq.brierBaseline.toFixed(3)}）｜ log-loss：${mq.logLoss.toFixed(3)} ｜ 回测最优温度 T=${mq.bestTemperature}`,
    );
    // 口径透明化：卡尔曼路径是生产口径；同时给出未收缩(T=1)、手调(T=3)、只用先验三条参照线
    if (mq.fusion === "kalman" && Number.isFinite(mq.brierTemperature1)) {
      L.push(
        `- 口径对照（Brier）：卡尔曼融合 **${mq.brier.toFixed(3)}** ｜ T=1 未收缩 ${mq.brierTemperature1.toFixed(3)} ｜ 手调 T=3 ${Number(mq.brierProduction).toFixed(3)} ｜ 只用先验忽略证据 ${Number(mq.brierPriorOnly).toFixed(3)}`,
      );
    }
    const ratio = mq.brier / mq.brierBaseline;
    L.push(
      ratio < 1
        ? `- 结论：**优于无信息基线**（Brier 降低 ${((1 - ratio) * 100).toFixed(1)}%，信号有一定预测力）`
        : `- 结论：⚠️ **不优于无信息基线**（当前信号在历史上无统计显著的预测力，本报告仅供参考，不宜作为交易依据）`,
    );
    L.push("");
  }
  const r = report.risk;
  if (r) {
    L.push("### ⚠️ 风险估计（EWMA 波动率 + 经验分位数 VaR）");
    L.push(
      `- 年化波动率：**${pctPt(r.sigmaAnnual * 100)}**（EWMA，日波动 ${pctPt(r.sigmaDaily * 100)}；样本 σ ${pctPt(r.sigmaDailySample * 100)}）`,
    );
    L.push(`- 95% VaR（1 日）：${pctPt(r.var95_1d * 100)}`);
    L.push(
      `- 95% VaR（${report.horizon} 日）：**${pctPt(r.var95_h_emp * 100)}**（经验；正态估计 ${pctPt(r.var95_h * 100)}）`,
    );
    L.push(
      `- 95% CVaR（${report.horizon} 日）：**${pctPt(r.cvar95_h_emp * 100)}**（经验；正态估计 ${pctPt(r.cvar95_h * 100)}）`,
    );
    L.push("");
  }
  L.push(`- 历史最大回撤：**${pctPt(report.drawdown.maxDrawdown * 100)}**（持续 ${report.drawdown.days} 个交易日）`);
  L.push("");
  const s = report.stats;
  L.push("### 📋 技术面快照");
  const macdHistEv = report.evidence.find((e) => e.key === "macd_hist");
  const macdTxt = !macdHistEv
    ? "—"
    : macdHistEv.contribution > 0 ? "多头扩张" : macdHistEv.contribution < 0 ? "空头扩张" : "中性";
  L.push(
    `- 近 5/20/60 日收益：${pctPt(s.ret5d)} / ${pctPt(s.ret20d)} / ${pctPt(s.ret60d)}`,
  );
  L.push(
    `- RSI(14) = ${s.rsi14 != null ? s.rsi14.toFixed(1) : "—"} ｜ MACD 柱 ${macdTxt} ｜ 量比 ${s.volRatio != null ? s.volRatio.toFixed(2) : "—"} ｜ 20 日年化波动 ${s.volatility20 != null ? s.volatility20.toFixed(1) : "—"}%（EWMA ${s.volatilityEwma != null ? s.volatilityEwma.toFixed(1) : "—"}%）`,
  );
  L.push("");
  L.push("> ⚠️ 风险提示：本报告由贝叶斯统计模型基于历史行情生成，仅供参考，不构成投资建议。");
  return L.join("\n");
}

/** 腾讯时间戳 yyyyMMddHHmmss → yyyy-MM-dd HH:mm:ss（其他形式原样返回）。 */
function fmtTencentTime(t) {
  if (typeof t !== "string") return t || "";
  const m = t.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : t;
}

/**
 * 分析入口：拉取行情 → 贝叶斯分析 → 组装带行情信息的报告。
 * @param {string} symbol 用户输入代码
 * @param {object} opts {horizon, backtest:boolean}
 */
async function runAnalysis(symbol, opts = {}) {
  const horizon = Number.isInteger(opts.horizon) && opts.horizon >= 2 && opts.horizon <= 30 ? opts.horizon : 5;
  const { meta, quote, klines } = await fetchMarketData(symbol);
  const analysis = analyzeStock(klines, quote, {
    horizon,
    ...(MARKET_PRIOR ? { priorLR: MARKET_PRIOR, lrPriorStrength: MARKET_PRIOR_STRENGTH } : {}),
  });
  const report = {
    ok: true,
    symbol: meta.symbol,
    market: meta.market,
    raw: meta.raw,
    quote: {
      name: quote.name || symbol,
      price: quote.price,
      changePercent: quote.changePercent,
      time: fmtTencentTime(quote.time) || "",
      pe: quote.pe,
      pb: quote.pb,
      totalMarketCapYi: quote.totalMarketCapYi,
      turnover: quote.turnover,
    },
    ...analysis,
  };
  if (opts.backtest === true) {
    try {
      const bt = backtest(klines, {
        horizon,
        ...(MARKET_PRIOR ? { priorLR: MARKET_PRIOR, lrPriorStrength: MARKET_PRIOR_STRENGTH } : {}),
      });
      if (bt.n && bt.n > 20) {
        // 校准口径必须与生产一致：默认走卡尔曼融合时报卡尔曼路径的指标，
        // 否则会拿 T=1（未收缩、明显过度自信）的数去代表用户实际拿到的模型。
        const useKalman = bt.kalman != null;
        const m = useKalman ? bt.kalman : bt.atTemperature1;
        report.modelQuality = {
          n: bt.n,
          baseRate: bt.baseRate,
          accuracy: m.accuracy,
          brier: m.brier,
          brierBaseline: bt.baseRate * (1 - bt.baseRate),
          logLoss: m.logLoss,
          bestTemperature: bt.bestTemperature,
          fusion: useKalman ? "kalman" : "temperature",
          // 对照：未收缩口径与手调生产温度口径，便于看清收缩带来的差异
          brierTemperature1: bt.atTemperature1.brier,
          brierProduction: bt.atProductionTemperature.brier,
          brierPriorOnly: bt.priorOnly.brier,
          ...(useKalman ? { kalmanGainMean: bt.kalman.meanGain } : {}),
        };
      }
    } catch (err) {
      report.modelQuality = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return report;
}

/** 注册 `bayes_stock_predict` 工具（raw ToolDefinition，参数 schema 为 JSON Schema 子集）。 */
function registerStockAnalyzeTool(ctx) {
  const definition = {
    name: "bayes_stock_predict",
    description:
      "用贝叶斯定理分析一只股票：基于多技术指标信号（MACD/RSI/均线/布林带/量能/动量/影线/跳空/缠论背驰）的双向经验似然比做贝叶斯更新，" +
      "输出未来 N 个交易日的上涨后验概率（含 95% 置信区间）与 0-100 综合评分，并给出多窗口（2/5/10/20 日）后验对比、趋势状态（上涨/震荡/下跌）与持仓风险（EWMA 波动率、经验 VaR/CVaR、最大回撤）。" +
      "支持 A 股（输入 600519 或 sh600519/sz000001）与美股（输入 AAPL）。",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "股票代码：A 股 6 位数字（如 600519、000001、300750）或带市场前缀（sh600519/sz000001/bj430047），美股用字母代码（如 AAPL、BABA）",
        },
        horizon: {
          type: "integer",
          description: "预测上涨的时间窗口（交易日，2-30），默认 5",
        },
        backtest: {
          type: "boolean",
          description: "是否附带 walk-forward 历史回测（模型校准评估：方向准确率/Brier/log-loss），默认 false",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [{ type: "text", text: renderReport(value) }],
      presentationMeta: (args, value) => ({
        symbol: value.symbol,
        name: value.quote?.name,
        score: value.score,
        rating: value.rating,
        posterior: value.posterior,
      }),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
      if (!symbol) throw new Error("缺少股票代码参数 symbol");
      const report = await runAnalysis(symbol, { horizon: args.horizon, backtest: args.backtest === true });
      return cleanJson(report);
    },
  };
  ctx.tools.register(definition);
}

/** 注册 GET /bayes-predict/analyze 路由（浏览器面板同源调用）。 */
function registerHttpRoute(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/analyze",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const symbol = url.searchParams.get("symbol") ?? "";
      const horizonRaw = Number(url.searchParams.get("horizon") ?? "5");
      if (!symbol.trim()) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "缺少 symbol 参数，例如 /bayes-predict/analyze?symbol=600519" }));
        return;
      }
      try {
        const report = await runAnalysis(symbol.trim(), { horizon: horizonRaw });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(cleanJson(report)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    },
  });
}

/** 注册 POST /bayes-predict/backtest 路由（浏览器面板策略回测）。 */
function registerBacktestRoute(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/backtest",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pool = url.searchParams.get("pool") ?? "all";
      const num = (k, d) => { const v = url.searchParams.get(k); return v === null || v === "" ? d : Number(v); };
      const params = {
        horizon: num("horizon", 5),
        // 同时预热面板标准评分窗口（2/5/10/20 日）的缓存，切换窗口零等待；
        // 共享指标/信号计算，已热的 horizon 自动跳过。warm=0 可关闭。
        warmHorizons: url.searchParams.get("warm") === "0" ? [] : [2, 5, 10, 20],
        step: num("step", 5),
        topN: num("topN", 10),
        threshold: num("threshold", 0),
        selectMode: url.searchParams.get("selectMode") === "bottom" ? "bottom" : "top",
        initial: num("initial", 1000000),
        startDate: url.searchParams.get("startDate") ?? "2024-01-01",
        endDate: url.searchParams.get("endDate") || null,
        marketTiming: url.searchParams.get("marketTiming") === "1",
        timingRule: url.searchParams.get("timingRule") ?? "R0",
        // 新增可选条件
        excludeST: url.searchParams.get("excludeST") === "1",
        minPrice: num("minPrice", null),
        maxPrice: num("maxPrice", null),
        minMktcap: num("minMktcap", null),
        // 市值过滤默认用"截至换仓日的历史推算市值"（消除前视偏差）；historicalCap=0 退回快照市值
        historicalCap: url.searchParams.get("historicalCap") === "0" ? false : true,
        minListDays: num("minListDays", null),
        stopLossPct: num("stopLossPct", null),
        maxPositionPct: num("maxPositionPct", null),
        maxPerBoard: num("maxPerBoard", null),
        maxScore: num("maxScore", null),
        commissionRate: num("commissionRate", null),
        stampTax: num("stampTax", null),
        ...(MARKET_PRIOR ? { priorLR: MARKET_PRIOR, lrPriorStrength: MARKET_PRIOR_STRENGTH } : {}),
      };
      try {
        const provider = await buildProvider({ pool });
        const report = await runBacktest(params, provider);
        // 同时计算"低分 Top"方向（同一评分缓存，秒级；模拟层跑两遍），图表上并排展示
        try {
          const low = await runBacktest({ ...params, selectMode: "bottom" }, provider);
          report.lowCurve = {
            selectMode: "bottom",
            label: "低分 Top",
            equity: low.periods.map((p) => p.equity),
            totalReturn: low.totalReturn,
            finalEquity: low.finalEquity,
          };
        } catch { report.lowCurve = null; }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(cleanJson(report)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    },
  });
}

/** 注册 GET /bayes-predict/screen 路由（单日截面选股：同一套回测条件，不做换仓模拟）。 */
function registerScreenRoute(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/screen",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pool = url.searchParams.get("pool") ?? "all";
      const num = (k, d) => { const v = url.searchParams.get(k); return v === null || v === "" ? d : Number(v); };
      // 参数名与 /bayes-predict/backtest 对齐（同一套筛选条件），另加 date / limit
      const params = {
        pool,
        horizon: num("horizon", 5),
        threshold: num("threshold", 0),
        maxScore: num("maxScore", null),
        selectMode: url.searchParams.get("selectMode") === "bottom" ? "bottom" : "top",
        excludeST: url.searchParams.get("excludeST") === "1",
        minPrice: num("minPrice", null),
        maxPrice: num("maxPrice", null),
        minMktcap: num("minMktcap", null),
        minListDays: num("minListDays", null),
        // 市值过滤默认用"截至基准日的历史推算市值"（消除前视偏差）；historicalCap=0 退回快照市值
        historicalCap: url.searchParams.get("historicalCap") === "0" ? false : true,
        date: url.searchParams.get("date") || null,
        limit: num("limit", 100),
        ...(MARKET_PRIOR ? { priorLR: MARKET_PRIOR, lrPriorStrength: MARKET_PRIOR_STRENGTH } : {}),
      };
      try {
        const provider = await buildProvider({ pool });
        const report = await screenStocks(params, provider);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(cleanJson(report)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    },
  });
}

/** 注册 POST /bayes-predict/refresh 路由（手动刷新缓存）。 */
function registerRefreshRoute(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/refresh",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pool = url.searchParams.get("pool") ?? "all";
      try {
        const result = await refreshCache(pool);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(cleanJson({ ok: true, ...result })));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    },
  });
}

/** 注册 GET /bayes-predict/pools 路由（返回可选资源池 + 标签信息，供面板动态渲染）。 */
function registerPoolsRoute(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/pools",
    handler: async (req, res) => {
      try {
        const pools = await loadUniversePools();
        const summary = {};
        for (const [k, v] of Object.entries(pools)) {
          summary[k] = { label: v.label, count: (v.codes || []).length };
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(cleanJson({ ok: true, cacheRoot: cacheRoot(), pools: summary })));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    },
  });
}

/** JSON 应答小工具（自选股路由共用）。 */
function sendJson(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(cleanJson(payload)));
}
function failJson(res, err) {
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 502, { ok: false, error: message });
}

/**
 * 自选股（收藏）路由：
 *   GET  /bayes-predict/watchlist            自选股报告（自选日 / 自选价 / 自选日至今涨跌幅 / 最新评分）
 *   GET  /bayes-predict/watchlist?codesOnly=1 只要代码清单（选股筛选页渲染 ★ 状态用的轻量调用）
 *   POST /bayes-predict/watchlist/add?symbol= 加入自选（锚定该股最近一根K线为自选日/自选价）
 *   POST /bayes-predict/watchlist/remove?symbol=
 *   POST /bayes-predict/watchlist/clear
 * 持久化在 <cacheRoot>/watchlist.json；变更接口一律 POST（防止预取/缓存把 GET 当副作用请求打进来）。
 */
function registerWatchlistRoutes(ctx) {
  ctx.webServer.register({
    kind: "exact",
    path: "/bayes-predict/watchlist",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pool = url.searchParams.get("pool") ?? "all";
      const codesOnly = url.searchParams.get("codesOnly") === "1";
      try {
        if (codesOnly) {
          const doc = readWatchlist();
          sendJson(res, 200, { ok: true, codes: doc.items.map((it) => it.code), count: doc.items.length, updatedAt: doc.updatedAt, watchlistPath: watchlistPathSafe() });
          return;
        }
        const provider = await buildProvider({ pool });
        const report = await watchlistReport({
          horizon: numParam(url, "horizon", 5),
          date: url.searchParams.get("date") || null,
          // 默认实时（真实价/不复权）口径：自选价与最新价都取真实价，涨跌幅实时计算；
          // live=0 回退本地缓存（后复权）收盘价 —— 离线或行情接口故障时用。
          live: url.searchParams.get("live") !== "0",
          // force=1 绕过实时报价的短 TTL（面板「刷新」按钮用）
          force: url.searchParams.get("force") === "1",
          ...(MARKET_PRIOR ? { priorLR: MARKET_PRIOR, lrPriorStrength: MARKET_PRIOR_STRENGTH } : {}),
        }, provider);
        sendJson(res, 200, report);
      } catch (err) {
        failJson(res, err);
      }
    },
  });

  // 三个变更接口：结构相同，只差执行体
  const mutations = [
    { path: "/bayes-predict/watchlist/add", run: async (url) => {
      const symbol = url.searchParams.get("symbol") ?? "";
      const provider = await buildProvider({ pool: "all" });
      const r = await addToWatchlist(symbol, provider);
      const doc = readWatchlist();
      return { ok: true, action: "add", codes: doc.items.map((it) => it.code), ...r };
    } },
    { path: "/bayes-predict/watchlist/remove", run: async (url) => {
      const r = removeFromWatchlist(url.searchParams.get("symbol") ?? "");
      const doc = readWatchlist();
      return { ok: true, action: "remove", codes: doc.items.map((it) => it.code), ...r };
    } },
    { path: "/bayes-predict/watchlist/clear", run: async () => {
      const r = clearWatchlist();
      return { ok: true, action: "clear", codes: [], ...r };
    } },
  ];
  for (const m of mutations) {
    ctx.webServer.register({
      kind: "exact",
      path: m.path,
      handler: async (req, res) => {
        if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: `${m.path} 只接受 POST` }); return; }
        try {
          sendJson(res, 200, await m.run(new URL(req.url ?? "/", "http://localhost")));
        } catch (err) {
          failJson(res, err);
        }
      },
    });
  }
}

/** 自选表路径（避免为了一个字符串把 watchlist.js 的更多内部暴露出去）。 */
function watchlistPathSafe() {
  try {
    return `${cacheRoot()}\\watchlist.json`;
  } catch {
    return null;
  }
}

/** 查询参数取数字（空串/null 走默认值）。 */
function numParam(url, key, dflt) {
  const v = url.searchParams.get(key);
  return v === null || v === "" ? dflt : Number(v);
}

export function apply(ctx) {
  registerStockAnalyzeTool(ctx);
  registerHttpRoute(ctx);
  registerBacktestRoute(ctx);
  registerScreenRoute(ctx);
  registerWatchlistRoutes(ctx);
  registerRefreshRoute(ctx);
  registerPoolsRoute(ctx);
}
