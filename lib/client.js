// dsh-bayes-predict / client.js —— 浏览器端（client half）React 插件
// 手写 bundle（UMD/CJS factory 格式），挂载到侧边栏「📊 贝叶斯股票分析」按钮。
// 数据通过同源路由 GET /bayes-predict/analyze 获取（host 插件提供）。
window.__ModuleLoader__.load({
	id: "dsh-bayes-predict",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		// 注意：手写代码按 `createElement(type, props, ...children)` 风格调用 h(...)，
		// 因此必须绑定 React.createElement —— jsx-runtime 的 `jsx(type, config, key)`
		// 第 3 参是 key 而非 children（子元素需放入 config.children），会把子节点全部丢弃。
		var h = React.createElement;

		// ---------- 样式（内联 + DSH 主题变量） ----------
		var S = {
			wrap: { display: "flex", flexDirection: "column", gap: "16px", padding: "4px 2px", maxWidth: "860px" },
			row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			input: {
				// boxSizing: border-box 让 minWidth 含 padding/边框，避免输入框比外层 div 宽而溢出
				flex: "1 1 220px", minWidth: "180px", padding: "8px 12px", borderRadius: "8px", boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)", fontSize: "14px", outline: "none",
			},
			button: {
				padding: "8px 18px", borderRadius: "8px", border: "none", cursor: "pointer",
				// 固定深紫品牌色：不依赖主题别名（深色主题下 brand-primary 可能被映射为浅色，白字会看不清）
				background: "#7c5cff", color: "#fff", fontSize: "14px", fontWeight: 600,
			},
			buttonDisabled: { opacity: 0.6, cursor: "default" },
			card: {
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px",
				background: "var(--dsw-alias-bg-layer-1)", padding: "14px 16px",
			},
			title: { fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", marginBottom: "10px" },
			muted: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" },
			stat: { background: "var(--dsw-alias-bg-layer-2)", borderRadius: "10px", padding: "10px 12px" },
			statLabel: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginBottom: "4px" },
			statValue: { fontSize: "16px", fontWeight: 700, color: "var(--dsw-alias-label-primary)" },
			table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
			th: { textAlign: "left", padding: "6px 8px", color: "var(--dsw-alias-label-secondary)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l2)" },
			td: { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-primary)" },
			bar: { height: "8px", borderRadius: "4px", background: "var(--dsw-alias-border-l2)", overflow: "hidden" },
			barFill: { height: "100%", borderRadius: "4px" },
			error: { color: "#ef4444", fontSize: "13px", padding: "10px 2px" },
			hint: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", marginTop: "6px" },
		};

		// ---------- 全局 UI 微样式（注入 <style>：按钮反馈 / 动画 / 滚动条，突破内联样式限制） ----------
		(function () {
			try {
				var css = [
					".dsh-sb-root button { transition: filter .15s, transform .05s; }",
					".dsh-sb-root button:hover { filter: brightness(1.08); }",
					".dsh-sb-root button:active { transform: scale(0.97); }",
					".dsh-sb-root tbody tr { transition: background .12s; }",
					".dsh-sb-root tbody tr:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }",
					".dsh-sb-spinner { width: 16px; height: 16px; border: 2.5px solid rgba(124,92,255,.25); border-top-color: #7c5cff; border-radius: 50%; display: inline-block; vertical-align: -3px; margin-right: 8px; animation: dsh-sb-spin .8s linear infinite; }",
					"@keyframes dsh-sb-spin { to { transform: rotate(360deg); } }",
					".dsh-sb-pop { animation: dsh-sb-pop .18s ease-out; transform-origin: center; }",
					"@keyframes dsh-sb-pop { from { opacity: 0; transform: translate(-50%, -47%) scale(.96); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }",
					".dsh-sb-scroll::-webkit-scrollbar { width: 8px; height: 8px; }",
					".dsh-sb-scroll::-webkit-scrollbar-thumb { background: rgba(128,128,128,.35); border-radius: 4px; }",
					".dsh-sb-scroll::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.55); }",
					".dsh-sb-scroll::-webkit-scrollbar-track { background: transparent; }",
					".dsh-sb-sidebtn:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }",
					// 关闭按钮：圆形图标幽灵样式（内嵌 SVG，不依赖字体），hover 浮现底色并加深图标
					".dsh-sb-close { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; padding: 0; border-radius: 50%; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; transition: background .15s ease, color .15s ease, transform .15s ease; }",
					".dsh-sb-close:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, #1f2937); }",
					".dsh-sb-close:active { transform: scale(.92); }",
					".dsh-sb-root input:focus, .dsh-sb-root select:focus { border-color: #7c5cff !important; box-shadow: 0 0 0 2px rgba(124,92,255,.16) !important; outline: none; }",
					// 占位符弱化 + 数字输入去 spinner（更整洁，键盘仍可步进）
					".dsh-sb-root ::placeholder { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); opacity: 1; }",
					".dsh-sb-root input[type=number]::-webkit-outer-spin-button, .dsh-sb-root input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }",
					".dsh-sb-root input[type=number] { -moz-appearance: textfield; appearance: textfield; }",
				].join("\n");
				var el = document.createElement("style");
				el.textContent = css;
				(document.head || document.documentElement).appendChild(el);
			} catch (e) { /* 样式注入失败不影响功能 */ }
		})();

		function fmtPct(x, digits) {
			if (x == null || !Number.isFinite(x)) return "—";
			return (x * 100).toFixed(digits == null ? 1 : digits) + "%";
		}
		function fmtNum(x, digits) {
			if (x == null || !Number.isFinite(x)) return "—";
			return Number(x).toFixed(digits == null ? 2 : digits);
		}
		function fmtPrice(x) {
			if (x == null || !Number.isFinite(x)) return "—";
			return x >= 1000 ? x.toFixed(0) : x.toFixed(2);
		}

		var SIGNAL_NAMES = {
			macd_cross: "MACD 金叉/死叉",
			macd_hist: "MACD 柱体动能",
			rsi: "RSI 超买超卖",
			ma_align: "均线排列",
			price_ma20: "价格 vs MA20",
			bollinger: "布林带位置",
			volume: "量能配合",
			momentum: "动量 ROC",
			trend_recent: "近 5 日走势",
			wicks: "影线形态",
			gap: "跳空缺口",
			divergence: "背驰（缠论）",
			atr: "波动率扩张",
		};

		function scoreColor(score) {
			if (score >= 75) return "#16a34a";
			if (score >= 60) return "#22c55e";
			if (score >= 50) return "#84cc16";
			if (score >= 40) return "#eab308";
			if (score >= 25) return "#f97316";
			return "#ef4444";
		}

		// ---------- 子组件 ----------
		function ScoreGauge(props) {
			var score = Math.max(0, Math.min(100, props.score));
			var r = 40;
			var c = 2 * Math.PI * r;
			var color = scoreColor(score);
			return h("svg", { viewBox: "0 0 100 100", width: 116, height: 116 },
				h("circle", { cx: 50, cy: 50, r: r, fill: "none", stroke: "var(--dsw-alias-border-l2)", strokeWidth: 9 }),
				h("circle", {
					cx: 50, cy: 50, r: r, fill: "none", stroke: color, strokeWidth: 9, strokeLinecap: "round",
					strokeDasharray: (c * score / 100) + " " + c, transform: "rotate(-90 50 50)",
				}),
				h("text", { x: 50, y: 49, textAnchor: "middle", fontSize: 24, fontWeight: 700, fill: color }, String(Math.round(score))),
				h("text", { x: 50, y: 67, textAnchor: "middle", fontSize: 10, fill: "var(--dsw-alias-label-secondary)" }, "/ 100"),
			);
		}

		function ProbBar(props) {
			var p = Math.max(0, Math.min(100, (props.value || 0) * 100));
			var color = props.color || "#7c5cff";
			return h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
				h("div", { style: { width: "64px", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", flexShrink: 0 } }, props.label),
				h("div", { style: Object.assign({}, S.bar, { flex: 1 }) },
					h("div", { style: Object.assign({}, S.barFill, { width: p + "%", background: color }) })),
				h("div", { style: { width: "52px", textAlign: "right", fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", flexShrink: 0 } }, p.toFixed(0) + "%"),
			);
		}

		function MiniChart(props) {
			var rows = props.rows;
			if (!rows || rows.length < 2) return h("div", { style: S.muted }, "K 线数据不足");
			var w = 100, hgt = 40;
			var min = Infinity, max = -Infinity;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i][2] < min) min = rows[i][2];
				if (rows[i][2] > max) max = rows[i][2];
			}
			var span = max - min || 1;
			var pts = [];
			for (var j = 0; j < rows.length; j++) {
				var x = (j / (rows.length - 1)) * w;
				var y = hgt - ((rows[j][2] - min) / span) * (hgt - 4) - 2;
				pts.push(x.toFixed(2) + "," + y.toFixed(2));
			}
			var color = rows[rows.length - 1][2] >= rows[0][2] ? "#22c55e" : "#ef4444";
			var areaPts = "0," + hgt + " " + pts.join(" ") + " " + w + "," + hgt;
			return h("svg", { viewBox: "0 0 " + w + " " + hgt, preserveAspectRatio: "none", style: { width: "100%", height: "120px", display: "block" } },
				h("polygon", { points: areaPts, fill: color, opacity: 0.12 }),
				h("polyline", { points: pts.join(" "), fill: "none", stroke: color, strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" }),
			);
		}

		function TrendRow(props) {
			var t = props.trend;
			var labels = [
				{ key: "bull", text: "上涨", color: "#22c55e" },
				{ key: "flat", text: "震荡", color: "#eab308" },
				{ key: "bear", text: "下跌", color: "#ef4444" },
			];
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
				labels.map(function (lb) {
					return h(ProbBar, { key: lb.key, label: lb.text, value: t[lb.key], color: lb.color });
				}),
				h("div", { style: S.hint },
					"主导状态：" + (t.state === "bull" ? "上涨" : t.state === "bear" ? "下跌" : "震荡") +
					"（μ=" + fmtPct(t.mu, 3) + "，σ=" + fmtPct(t.sigma, 3) + "）"),
			);
		}

		function RiskGrid(props) {
			var r = props.risk;
			var dd = props.drawdown;
			var emp = function (v, fb) { return v != null && Number.isFinite(v) ? v : fb; };
			var items = [
				{ label: "年化波动率 (EWMA)", value: fmtPct(r ? r.sigmaAnnual : null, 1) },
				{ label: "95% VaR（1 日）", value: fmtPct(r ? r.var95_1d : null, 2) },
				{ label: "95% VaR（" + (props.horizon || 5) + " 日）", value: fmtPct(r ? emp(r.var95_h_emp, r.var95_h) : null, 2) },
				{ label: "95% CVaR（" + (props.horizon || 5) + " 日）", value: fmtPct(r ? emp(r.cvar95_h_emp, r.cvar95_h) : null, 2) },
				{ label: "历史最大回撤", value: fmtPct(dd ? dd.maxDrawdown : null, 1) },
				{ label: "回撤持续天数", value: dd && dd.days != null ? String(dd.days) + " 日" : "—" },
			];
			return h("div", { style: S.grid },
				items.map(function (it) {
					return h("div", { key: it.label, style: S.stat },
						h("div", { style: S.statLabel }, it.label),
						h("div", { style: S.statValue }, it.value));
				}));
		}

		function SignalsTable(props) {
			var ev = props.evidence;
			if (!ev || !ev.length) return h("div", { style: S.muted }, "当前无有效信号（后验≈先验）");
			return h("table", { style: S.table },
				h("thead", null, h("tr", null,
					h("th", { style: S.th }, "信号"),
					h("th", { style: S.th }, "方向"),
					h("th", { style: S.th }, "强度"),
					h("th", { style: S.th }, "似然比 LR"),
					h("th", { style: S.th }, "样本数"),
					h("th", { style: S.th }, "log 贡献"))),
				h("tbody", null, ev.map(function (e) {
					// 标签按实际贡献符号显示：名义方向经实证校准后可能与贡献相反（如 价格vsMA20、量能 的反转计入）
					var pos = e.contribution > 0;
					var neu = e.contribution === 0;
					return h("tr", { key: e.key },
						h("td", { style: S.td }, SIGNAL_NAMES[e.key] || e.key),
						h("td", { style: Object.assign({}, S.td, { color: neu ? "var(--dsw-alias-label-secondary)" : pos ? "#22c55e" : "#ef4444", fontWeight: 600 }) }, neu ? "中性" : pos ? "看多" : "看空"),
						h("td", { style: S.td }, fmtNum(e.strength != null ? e.strength : 1, 2)),
						h("td", { style: S.td }, fmtNum(e.lr, 2)),
						h("td", { style: S.td }, String(e.samples)),
						h("td", { style: S.td }, (e.contribution >= 0 ? "+" : "") + e.contribution.toFixed(3)));
				})));
		}

		function MultiHorizonTable(props) {
			var rows = props.rows;
			if (!rows || !rows.length) return null;
			return h("div", { style: S.card },
				h("div", { style: S.title }, "⏱ 多窗口后验对比"),
				h("table", { style: S.table },
					h("thead", null, h("tr", null,
						h("th", { style: S.th }, "窗口"),
						h("th", { style: S.th }, "先验"),
						h("th", { style: S.th }, "后验"),
						h("th", { style: S.th }, "评分"),
						h("th", { style: S.th }, "评级"))),
					h("tbody", null, rows.map(function (rw) {
						var up = rw.posterior >= 0.5;
						return h("tr", { key: String(rw.horizon) },
							h("td", { style: S.td }, String(rw.horizon) + " 日"),
							h("td", { style: S.td }, fmtPct(rw.prior, 1)),
							h("td", { style: Object.assign({}, S.td, { color: up ? "#22c55e" : "#ef4444", fontWeight: 600 }) }, fmtPct(rw.posterior, 1)),
							h("td", { style: S.td }, String(rw.score)),
							h("td", { style: S.td }, rw.rating));
					}))));
		}

		function StatsGrid(props) {
			var s = props.stats;
			var items = [
				{ label: "近 5 日收益", value: fmtPct(s.ret5d / 100, 1) },
				{ label: "近 20 日收益", value: fmtPct(s.ret20d / 100, 1) },
				{ label: "近 60 日收益", value: fmtPct(s.ret60d / 100, 1) },
				{ label: "RSI(14)", value: s.rsi14 != null ? s.rsi14.toFixed(1) : "—" },
				{ label: "量比", value: s.volRatio != null ? s.volRatio.toFixed(2) : "—" },
				{ label: "20 日年化波动", value: s.volatility20 != null ? s.volatility20.toFixed(1) + "%" : "—" },
				{ label: "MA20", value: fmtPrice(s.ma20) },
				{ label: "MA60", value: fmtPrice(s.ma60) },
			];
			return h("div", { style: S.grid },
				items.map(function (it) {
					return h("div", { key: it.label, style: S.stat },
						h("div", { style: S.statLabel }, it.label),
						h("div", { style: S.statValue }, it.value));
				}));
		}

		function QuoteHeader(props) {
			var q = props.quote;
			var chg = q.changePercent;
			var up = chg != null && Number.isFinite(chg) && chg >= 0;
			var val = [];
			if (q.pe != null && Number.isFinite(q.pe)) val.push("PE " + Number(q.pe).toFixed(1));
			if (q.pb != null && Number.isFinite(q.pb)) val.push("PB " + Number(q.pb).toFixed(2));
			if (q.totalMarketCapYi != null && Number.isFinite(q.totalMarketCapYi)) val.push("市值 " + Number(q.totalMarketCapYi).toFixed(0) + " 亿");
			if (q.turnover != null && Number.isFinite(q.turnover)) val.push("换手 " + Number(q.turnover).toFixed(2) + "%");
			return h("div", { style: Object.assign({}, S.row, { justifyContent: "space-between" }) },
				h("div", null,
					h("div", { style: { fontSize: "18px", fontWeight: 700, color: "var(--dsw-alias-label-primary)" } },
						q.name || props.symbol,
						h("span", { style: Object.assign({}, S.muted, { marginLeft: "8px", fontWeight: 400 }) }, props.symbol)),
					h("div", { style: S.muted }, "数据截至 " + (q.time || "—")),
					val.length ? h("div", { style: Object.assign({}, S.muted, { marginTop: "4px" }) }, val.join(" ｜ ")) : null,
				),
				h("div", { style: { textAlign: "right" } },
					h("div", { style: { fontSize: "22px", fontWeight: 700, color: up ? "#22c55e" : "#ef4444" } }, fmtPrice(q.price)),
					h("div", { style: { fontSize: "13px", color: up ? "#22c55e" : "#ef4444" } },
						(chg != null && Number.isFinite(chg) ? (up ? "+" : "") + chg.toFixed(2) + "%" : "—"))));
		}

		// ---------- 算法说明（未发起分析时的空态填充） ----------
		function AlgorithmIntro() {
			var blocks = [
				["🔀", "双向经验似然比", "看多/看空信号分别统计历史条件频率（四格表），拉普拉斯平滑后按样本量向 1 收缩（k=20），单条 LR 截断于 [1/4, 4]，防止单信号暴走。"],
				["⏳", "时间衰减加权", "全部统计按指数衰减加权（半衰期 200 个交易日），近期市场行为权重更高，陈旧样本自动淡出。"],
				["📏", "波动率归一化", "动量、近 5 日走势等信号的触发阈值按滚动波动率 σ 自适应（|x| > 0.5·σ·√k），高波动与低波动股票之间可比。"],
				["🌡️", "温度收缩", "各信号的 log-odds 贡献经温度 T=3 收缩后再叠加，抑制小样本过拟合，结论更保守稳健。"],
				["🧬", "分层先验", "单股似然比与全市场横截面通用表（market-prior.json）混合，权重 w = n/(n+80)：样本少时更信全局规律，样本充足时更信个股特性。"],
				["🛡️", "风险估计", "EWMA 波动率（λ=0.94）为主；VaR/CVaR 以历史经验分位数为主输出（正态近似对照），并附区间内最大回撤。"],
			];
			// 分块底色：品牌紫淡染 + 紫色细边框。浅色主题下 layer-1/layer-2 几乎同色，
			// 半透明品牌紫在白底/暗底上都能形成清晰分区，且与插件主色 #7c5cff 呼应。
			var blockStyle = {
				borderRadius: "10px", padding: "10px 12px",
				background: "rgba(124,92,255,.06)", border: "1px solid rgba(124,92,255,.18)",
			};
			return h("div", { style: S.card },
				h("div", { style: S.title }, "🧮 算法说明：贝叶斯信号融合"),
				h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.7 }) },
					"假设 H =「未来 N 个交易日上涨」。先验取近期加权历史胜率（向 50% 收缩），再将 MACD、RSI、均线、布林带、量能、动量、影线、跳空、缠论背驰等技术信号作为证据，逐条做 log-odds 更新："),
				h("div", {
					style: {
						margin: "10px 0", padding: "10px 14px", borderRadius: "8px",
						background: "rgba(124,92,255,.08)", border: "1px solid rgba(124,92,255,.18)",
						fontFamily: "Consolas, Menlo, monospace",
						fontSize: "12.5px", color: "var(--dsw-alias-label-primary)", textAlign: "center",
					},
				}, "logit P(H | 证据) = logit P(H) + Σ strengthᵢ · log(LRᵢ)"),
				h("div", { style: Object.assign({}, S.grid, { gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }) },
					blocks.map(function (b) {
						return h("div", { style: blockStyle },
							h("div", { style: { fontSize: "13px", fontWeight: 600, color: "#7c5cff", marginBottom: "4px" } }, b[0] + " " + b[1]),
							h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.55 }) }, b[2]));
					})),
				h("div", { style: Object.assign({}, S.hint, { marginTop: "10px", lineHeight: 1.6 }) },
					"信号方向均经历史实证校准：MACD 金叉/死叉、近 5 日走势、影线形态、跳空、缠论背驰保留原方向；价格 vs MA20、量能按反转方向计入；RSI、均线排列、布林带、动量作弱化处理。分析结果为统计估计，仅供参考，不构成投资建议。"));
		}

		// ---------- 主组件 ----------
		function StockBayesTab() {
			var state = React.useState("");
			var symbol = state[0];
			var setSymbol = state[1];
			var hz = React.useState("5");
			var horizon = hz[0];
			var setHorizon = hz[1];
			var load = React.useState({ status: "idle", data: null, error: null });
			var view = load[0];
			var setView = load[1];

			function run() {
				var sym = symbol.trim();
				if (!sym) return;
				setView({ status: "loading", data: null, error: null });
				fetch("/bayes-predict/analyze?symbol=" + encodeURIComponent(sym) + "&horizon=" + encodeURIComponent(horizon))
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setView({ status: "done", data: r.json, error: null });
					})
					.catch(function (err) {
						setView({ status: "error", data: null, error: String((err && err.message) || err) });
					});
			}

			var header;
			if (view.status === "done" && view.data) {
				var d = view.data;
				var postPct = Math.max(0, Math.min(100, d.posterior * 100));
				var ci = d.calibration && d.calibration.posteriorCI;
				var hintParts = [
					"log-odds 变化 " + (d.logOdds >= 0 ? "+" : "") + d.logOdds.toFixed(3) +
					"（" + d.signalCount + " 个有效信号）",
				];
				if (ci && ci.length === 2) hintParts.push("95% 区间 " + fmtPct(ci[0], 1) + " ~ " + fmtPct(ci[1], 1));
				if (d.calibration && d.calibration.effectiveSamples) hintParts.push("有效样本 " + d.calibration.effectiveSamples);
				if (d.calibration && d.calibration.temperature != null) hintParts.push("收缩 T=" + d.calibration.temperature);
				// 结论驱动因素解读：先验与后验几乎持平 → 提示"先验主导"，避免"信号弱结论却偏多"的困惑
				var shiftPp = (d.posterior - d.prior) * 100;
				if (Math.abs(shiftPp) < 1) {
					hintParts.push("ℹ️ 信号仅使概率移动 " + (shiftPp >= 0 ? "+" : "") + shiftPp.toFixed(1) + " 个百分点，本次结论主要由先验（近期历史胜率 " + fmtPct(d.prior, 1) + "）主导");
				}
				header = h("div", { style: S.wrap },
					h(QuoteHeader, { quote: d.quote, symbol: d.symbol }),
					h("div", { style: Object.assign({}, S.card, { display: "flex", gap: "20px", alignItems: "center", flexWrap: "wrap" }) },
						h(ScoreGauge, { score: d.score }),
						h("div", { style: { flex: "1 1 260px", display: "flex", flexDirection: "column", gap: "10px" } },
							h("div", { style: Object.assign({}, S.title, { marginBottom: 0 }) },
								"综合判断（未来 " + d.horizon + " 个交易日）",
								h("span", { style: { display: "inline-block", padding: "2px 10px", borderRadius: "999px", fontSize: "12px", fontWeight: 700, color: "#ffffff", background: scoreColor(d.score), marginLeft: "8px", verticalAlign: "2px" } }, d.rating)),
							h(ProbBar, { label: "先验", value: d.prior, color: "#94a3b8" }),
							h(ProbBar, { label: "后验", value: d.posterior, color: scoreColor(d.score) }),
							h("div", { style: S.hint }, hintParts.join(" ｜ ")),
							h("div", { style: Object.assign({}, S.hint, { marginTop: "4px", opacity: 0.85, lineHeight: 1.6 }) },
								"评分 = 后验上涨概率 × 100。先验取近期加权历史胜率，技术信号经温度收缩（T=3）后温和修正基率而非颠覆基率——因此触发信号少或信号弱时，结论贴近先验是模型的预期行为，不代表分析失效。"),
						)),
					h(MultiHorizonTable, { rows: d.multiHorizon }),
					h("div", { style: Object.assign({}, S.card, { display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }) },
						h("div", { style: { flex: "1 1 300px", minWidth: "260px" } },
							h("div", { style: S.title }, "近 60 日走势"),
							h(MiniChart, { rows: d.klines })),
						h("div", { style: { flex: "1 1 240px", minWidth: "220px" } },
							h("div", { style: S.title }, "趋势状态（贝叶斯三状态）"),
							h(TrendRow, { trend: d.trend }))),
					h("div", { style: S.card },
						h("div", { style: S.title }, "⚠️ 风险估计（EWMA 波动率 / 经验 VaR）"),
						h(RiskGrid, { risk: d.risk, drawdown: d.drawdown, horizon: d.horizon })),
					h("div", { style: S.card },
						h("div", { style: S.title }, "📈 信号证据明细"),
						h(SignalsTable, { evidence: d.evidence }),
						d.attribution && d.attribution.length
							? h("div", { style: Object.assign({}, S.hint, { marginTop: "8px" }) },
								"信号归因：" + d.attribution.map(function (a) {
									var lbl = a.contribution > 0 ? "看多" : a.contribution < 0 ? "看空" : "中性";
									return (SIGNAL_NAMES[a.key] || a.key) + "（" + lbl + " " + (a.contribution >= 0 ? "+" : "") + a.contribution.toFixed(3) + "）";
								}).join(" ｜ "))
							: null),
					h("div", { style: S.card },
						h("div", { style: S.title }, "📋 技术面快照"),
						h(StatsGrid, { stats: d.stats })),
					h("div", { style: S.hint }, "⚠️ 本面板由贝叶斯统计模型基于历史行情生成，仅供参考，不构成投资建议。"));
			} else if (view.status === "loading") {
				header = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "32px" }) },
					h("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
						h("span", { className: "dsh-sb-spinner" }), "正在拉取行情并运行贝叶斯分析…"));
			} else if (view.status === "error") {
				header = h("div", { style: S.error }, "分析失败：" + view.error);
			}

			return h("div", { className: "dsh-sb-root", style: S.wrap },
				h("div", { style: S.row },
					h("input", {
						style: Object.assign({}, S.input, { flex: "1 1 180px", minWidth: "150px" }),
						value: symbol, placeholder: "输入股票代码，如 600519 / 000001 / AAPL（暂只支持 A 股、美股）",
						onChange: function (e) { setSymbol(e.target.value); },
						onKeyDown: function (e) { if (e.key === "Enter") run(); },
					}),
					h("select", {
						style: {
							padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2)",
							background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: "14px", outline: "none",
						},
						value: horizon,
						onChange: function (e) { setHorizon(e.target.value); },
						title: "预测窗口（交易日）",
					},
						h("option", { value: "2" }, "2 日"),
						h("option", { value: "5" }, "5 日"),
						h("option", { value: "10" }, "10 日"),
						h("option", { value: "20" }, "20 日")),
					h("button", {
						style: Object.assign({}, S.button, view.status === "loading" ? S.buttonDisabled : {}),
						disabled: view.status === "loading",
						onClick: run,
					}, view.status === "loading" ? "分析中…" : "贝叶斯分析"),
				),
				h("div", { style: S.hint }, "示例：600519（贵州茅台）、000001（平安银行）、300750（宁德时代）、688981（中芯国际）、AAPL（苹果）"),
				header,
				view.status === "idle" ? h(AlgorithmIntro) : null);
		}

		// ---------- 侧边栏快捷入口：📊 贝叶斯股票分析（点击弹出居中的固定大小浮层） ----------
		function StockSidebarButton() {
			var sO = React.useState(false); var open = sO[0]; var setOpen = sO[1];
			var ref = React.useRef(null);
			React.useEffect(function () {
				if (!open) return;
				function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
				document.addEventListener("mousedown", onDoc);
				return function () { document.removeEventListener("mousedown", onDoc); };
			}, [open]);
			return h("div", { ref: ref, style: { position: "relative" } },
				h("button", {
					className: "dsh-sb-sidebtn",
					style: { display: "flex", alignItems: "center", gap: "6px", width: "100%", padding: "8px 10px", borderRadius: "8px", border: "none", background: "transparent", color: "var(--dsw-alias-label-primary)", cursor: "pointer", fontSize: "13px", fontWeight: 600, textAlign: "left", transition: "background .15s" },
					onClick: function () { setOpen(!open); },
				},
					h("span", { style: { fontSize: "14px" } }, "📊"),
					h("span", { style: { flex: 1 } }, "贝叶斯股票分析")),
				open ? h("div", {
					className: "dsh-sb-pop dsh-sb-scroll",
					style: { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", zIndex: 1200, width: "880px", height: "min(88vh, 760px)", maxWidth: "calc(100vw - 24px)", overflow: "auto", background: "var(--dsw-alias-bg-overlay, #ffffff)", color: "var(--dsw-alias-label-primary, #1f2937)", border: "1px solid var(--dsw-alias-border-l2, #e5e7eb)", borderRadius: "12px", boxShadow: "0 12px 40px rgba(0,0,0,0.3)" },
				},
					h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px 0" } },
						h("div", { style: { fontSize: "14px", fontWeight: 700, color: "var(--dsw-alias-label-primary)" } }, "📊 贝叶斯股票分析"),
						h("button", {
							className: "dsh-sb-close",
							onClick: function () { setOpen(false); },
						},
							h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", "aria-hidden": true },
								h("path", { d: "M6 6 L18 18 M18 6 L6 18" })))),
					h("div", { style: { padding: "10px 14px 14px" } }, h(StockBayesTab))) : null);
		}

		// ---------- 插件入口 ----------
		// cordis 依据模块导出的 `inject` 决定注入哪些服务：
		// 缺少该声明时 fiber 不注入任何服务，apply 中访问 ctx.slots 会抛
		// `cannot get property "slots" without inject`。
		var inject = ["slots"];

		function apply(ctx) {
			// 唯一入口：侧边栏底部「📊 贝叶斯股票分析」（弹层为单股贝叶斯分析面板）
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "bayes-predict-panel",
					order: 60,
				}, StockSidebarButton);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
