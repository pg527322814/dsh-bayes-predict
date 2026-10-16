// dsh-bayes-predict / client.js —— 浏览器端（client half）React 插件
// 手写 bundle（UMD/CJS factory 格式）：挂载侧边栏底部「📊 贝叶斯股票分析」按钮，
// 点击弹出浮层，内含 策略回测 / 选股筛选 / 自选股 / 单股分析 四个页签。
// 数据全部走 host 插件的同源路由（/bayes-predict/analyze|screen|backtest|watchlist|pools|refresh）。
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
					// 分组头（可折叠）：箭头 + 标题 + 已设徽标 + 延伸分隔线
					".dsh-sb-sec-h { display: flex; align-items: center; gap: 8px; margin: 16px 0 10px; }",
					".dsh-sb-sec-t { font-size: 12px; font-weight: 700; letter-spacing: .4px; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; user-select: none; }",
					".dsh-sb-sec-line { flex: 1; height: 1px; background: var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }",
					".dsh-sb-badge { font-size: 10px; line-height: 1; padding: 3px 8px; border-radius: 999px; background: rgba(124,92,255,.14); color: #7c5cff; font-weight: 700; white-space: nowrap; }",
					".dsh-sb-chev { display: inline-block; font-size: 9px; color: var(--dsw-alias-label-secondary, #6b7280); transition: transform .18s ease; cursor: pointer; }",
					".dsh-sb-chev.open { transform: rotate(90deg); }",
					// 占位符弱化 + 数字输入去 spinner（更整洁，键盘仍可步进）
					".dsh-sb-root ::placeholder { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); opacity: 1; }",
					".dsh-sb-root input[type=number]::-webkit-outer-spin-button, .dsh-sb-root input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }",
					".dsh-sb-root input[type=number] { -moz-appearance: textfield; appearance: textfield; }",
					// 次级按钮（幽灵样式）：hover 只变背景不变亮度
					".dsh-sb-root button.dsh-sb-ghost:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); filter: none; }",
					// 自选星标：本行内的小按钮，hover 只放大不发亮（避免整行都像按钮）
					".dsh-sb-root button.dsh-sb-star { background: transparent; border: none; padding: 1px 3px; cursor: pointer; font-size: 15px; line-height: 1; transition: transform .1s; }",
					".dsh-sb-root button.dsh-sb-star:hover { filter: none; transform: scale(1.25); }",
					".dsh-sb-root tr.dsh-sb-rowlink { cursor: pointer; }",
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
		// 带符号百分比（涨跌幅/收益率）：正数显式 +，避免"1.23%"看不出方向
		function fmtSignedPct(x, digits) {
			if (x == null || !Number.isFinite(x)) return "—";
			return (x >= 0 ? "+" : "") + (x * 100).toFixed(digits == null ? 2 : digits) + "%";
		}
		function retColor(x) {
			if (x == null || !Number.isFinite(x)) return "inherit";
			return x >= 0 ? "#22c55e" : "#ef4444";
		}
		// ISO 时间戳 → 本地 "YYYY-MM-DD HH:mm"
		function fmtDateTime(iso) {
			if (!iso) return "—";
			var d = new Date(iso);
			if (isNaN(d.getTime())) return String(iso);
			var p = function (n) { return (n < 10 ? "0" : "") + n; };
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		// 腾讯行情时间戳 yyyyMMddHHmmss → "MM-DD HH:mm"（实时报价的"现在几点"）
		function fmtQuoteTime(ts) {
			var m = String(ts || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
			return m ? (m[2] + "-" + m[3] + " " + m[4] + ":" + m[5]) : "—";
		}

		// ---------- 自选股（收藏）客户端接口 ----------
		// 只读清单（轻量：不评分），供选股筛选页渲染 ★ 状态
		function wlFetchCodes() {
			return fetch("/bayes-predict/watchlist?codesOnly=1")
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { if (!j || j.ok === false) throw new Error((j && j.error) || "自选股接口不可用"); return j; });
		}
		// add / remove / clear —— 一律 POST（见 host 端路由注释）
		function wlMutate(action, symbol) {
			var url = "/bayes-predict/watchlist/" + action + (symbol ? "?symbol=" + encodeURIComponent(symbol) : "");
			return fetch(url, { method: "POST" })
				.then(function (r) { return r.json().catch(function () { return null; }).then(function (j) { return { res: r, json: j }; }); })
				.then(function (r) {
					if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
					return r.json;
				});
		}
		function wlCodesToMap(codes) {
			var m = {};
			(codes || []).forEach(function (c) { m[c] = true; });
			return m;
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

		// ---------- 表单共享样式（回测参数区统一控件规格） ----------
		// 控件：统一高度/内边距，layer-2 底色与卡片(layer-1)形成对比；width:100% 填满网格单元
		var CTL = {
			height: "34px", padding: "5px 10px", borderRadius: "8px", boxSizing: "border-box",
			border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)", fontSize: "13px", outline: "none",
			width: "100%", minWidth: "0",
		};
		var FIELD = { display: "flex", flexDirection: "column", gap: "5px", minWidth: "0" };
		var LABEL = { fontSize: "11.5px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.3 };
		// 原生 <option> 不继承 select 的 color/background，需显式设置（跟随主题变量）
		var OPT = { color: "var(--dsw-alias-label-primary, #1f2937)", background: "var(--dsw-alias-bg-layer-1, #ffffff)" };
		// 表头筛选行：比正文控件更矮更小，避免把表头做得比数据还重
		var FILTER_TH = { padding: "3px 6px", borderBottom: "1px solid var(--dsw-alias-border-l1)", fontWeight: 400, verticalAlign: "middle" };
		var FILTER_CTL = {
			width: "100%", minWidth: "0", height: "24px", padding: "1px 6px", boxSizing: "border-box",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)", fontSize: "11.5px", outline: "none",
		};
		// 日期输入的 colorScheme 跟随宿主主题亮度（硬编码 light 在深色主题下日历图标不可见）
		var DATE_SCHEME = (function () {
			try {
				var bg = getComputedStyle(document.body).backgroundColor;
				var m = bg && bg.match(/\d+/g);
				if (m && m.length >= 3) {
					var lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
					return lum < 140 ? "dark" : "light";
				}
			} catch (e) { /* 非浏览器环境忽略 */ }
			return "light";
		})();

		// 可折叠分组头：▶ 箭头 + 标题 + 「N 项已设」徽标 + 分隔线
		function SecHeader(props) {
			return h("div", { className: "dsh-sb-sec-h" },
				h("span", { className: "dsh-sb-chev" + (props.open ? " open" : ""), onClick: props.onToggle }, "▶"),
				h("span", { className: "dsh-sb-sec-t", onClick: props.onToggle }, props.title),
				props.count > 0 ? h("span", { className: "dsh-sb-badge" }, props.count + " 项已设") : null,
				h("div", { className: "dsh-sb-sec-line" }));
		}

		// 表单字段：标签在上、控件在下（children），可传 style 覆盖（如 gridColumn span）
		function Field(props) {
			return h("div", { style: Object.assign({}, FIELD, props.style || null) },
				h("div", { style: LABEL, title: props.title || null }, props.label),
				props.children);
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
			// rows 的行结构为 [date, close, high, low, open, volume]：走势图必须用**收盘价**（索引 1）绘制，
			// 用错列（如 high/low）会让图形与"近 60 日走势"标题不符。
			var min = Infinity, max = -Infinity;
			for (var i = 0; i < rows.length; i++) {
				if (rows[i][1] < min) min = rows[i][1];
				if (rows[i][1] > max) max = rows[i][1];
			}
			var span = max - min || 1;
			var pts = [];
			for (var j = 0; j < rows.length; j++) {
				var x = (j / (rows.length - 1)) * w;
				var y = hgt - ((rows[j][1] - min) / span) * (hgt - 4) - 2;
				pts.push(x.toFixed(2) + "," + y.toFixed(2));
			}
			var color = rows[rows.length - 1][1] >= rows[0][1] ? "#22c55e" : "#ef4444";
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
					// 方向标签按实际贡献符号显示：名义方向经实证校准后可能与贡献相反（如 价格vsMA20、量能 的反转计入）
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

		// ---------- 算法说明（单股分析页未发起分析时的空态填充） ----------
		function AlgorithmIntro() {
			var blocks = [
				["🔀", "双向经验似然比", "看多/看空信号分别统计历史条件频率（四格表），拉普拉斯平滑后按样本量向 1 收缩（k=20），单条 LR 截断于 [1/4, 4]，防止单信号暴走。"],
				["⏳", "时间衰减加权", "全部统计按指数衰减加权（半衰期 200 个交易日），近期市场行为权重更高，陈旧样本自动淡出。"],
				["📏", "波动率归一化", "动量、近 5 日走势等信号的触发阈值按滚动波动率 σ 自适应（|x| > 0.5·σ·√k），高波动与低波动股票之间可比。"],
				["🎛️", "卡尔曼增益融合", "各信号的 log-odds 贡献不再统一按手调温度收缩，而由卡尔曼增益 K = P⁻/(P⁻+R) 融合：观测方差 R 由 LR 四格表计数估计、先验方差 P⁻ 由先验有效样本量给出，收缩强度逐股逐日自适应（等价温度 T_eff = 1/K）。"],
				["🧬", "分层先验", "单股似然比与全市场横截面通用表（market-prior.json）混合，权重 w = n/(n+80)：样本少时更信全局规律，样本充足时更信个股特性。"],
				["📐", "卡尔曼趋势滤波", "对数价格上的局部线性趋势（LLT）状态空间滤波给出斜率 t 值与标准化新息，是 kalman_slope / kalman_innov 两个信号的来源；两者默认关闭——沪深300 十年样本外消融显示其边际贡献为负，仅在显式打开 opts.kalmanSignals 时参与融合。"],
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
				}, "logit P(H | 证据) = logit P(H) + K · Σ strengthᵢ · log(LRᵢ)"),
				h("div", { style: Object.assign({}, S.grid, { gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }) },
					blocks.map(function (b) {
						return h("div", { style: blockStyle },
							h("div", { style: { fontSize: "13px", fontWeight: 600, color: "#7c5cff", marginBottom: "4px" } }, b[0] + " " + b[1]),
							h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.55 }) }, b[2]));
					})),
				h("div", { style: Object.assign({}, S.hint, { marginTop: "10px", lineHeight: 1.6 }) },
					"信号方向均经历史实证校准：MACD 金叉/死叉、近 5 日走势、影线形态、跳空、缠论背驰保留原方向；价格 vs MA20、量能按反转方向计入；RSI、均线排列、布林带、动量作弱化处理。其余三个页签提供策略回测、选股筛选与自选股（自选页采用实时真实价口径）。分析结果为统计估计，仅供参考，不构成投资建议。"));
		}

		// ---------- 主组件 ----------
		function StockBayesTab(props) {
			var state = React.useState("600519");
			var symbol = state[0];
			var setSymbol = state[1];
			var hz = React.useState("5");
			var horizon = hz[0];
			var setHorizon = hz[1];
			var load = React.useState({ status: "idle", data: null, error: null });
			var view = load[0];
			var setView = load[1];

			// override：外部（选股筛选表格点行）传入的代码，优先于输入框当前值
			function run(override) {
				var sym = String(override != null && typeof override === "string" ? override : symbol).trim();
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

			// 从「选股筛选」表格点行跳转：{symbol, n}，n 自增保证每次点击都触发一次分析
			var pick = props && props.pick ? props.pick : null;
			var pickN = pick ? pick.n : 0;
			var pickSym = pick ? pick.symbol : null;
			React.useEffect(function () {
				if (!pickSym) return;
				setSymbol(pickSym);
				run(pickSym);
				// 依赖 pickN：同一只股票再次点击也会重新分析
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [pickN]);

			var header;
			if (view.status === "done" && view.data) {
				var d = view.data;
				var postPct = Math.max(0, Math.min(100, d.posterior * 100));
				var ci = d.calibration && d.calibration.posteriorCI;
				// logOdds 是**实际作用于先验**的增量；原始证据和单独展示，避免把收缩前的变化量误读为实得变化
				var rawLo = d.calibration && Number.isFinite(d.calibration.evidenceLogOdds) ? d.calibration.evidenceLogOdds : d.logOdds;
				var hintParts = [
					"证据原始 log-odds 和 " + (rawLo >= 0 ? "+" : "") + rawLo.toFixed(3) +
					" → 实际作用于先验 " + (d.logOdds >= 0 ? "+" : "") + d.logOdds.toFixed(3) +
					"（" + d.signalCount + " 个有效信号）",
				];
				if (ci && ci.length === 2) hintParts.push("95% 区间 " + fmtPct(ci[0], 1) + " ~ " + fmtPct(ci[1], 1));
				if (d.calibration && d.calibration.effectiveSamples) hintParts.push("有效样本 " + d.calibration.effectiveSamples);
				if (d.calibration && d.calibration.fusion === "kalman" && d.calibration.kalmanGain != null) hintParts.push("卡尔曼增益 K=" + d.calibration.kalmanGain.toFixed(3) + " → T_eff=" + d.calibration.effectiveTemperature);
				else if (d.calibration && d.calibration.temperature != null) hintParts.push("收缩 T=" + d.calibration.temperature);
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
								"评分 = 后验上涨概率 × 100。先验取近期加权历史胜率，技术信号经卡尔曼增益（等价收缩 T_eff = 1/K）温和修正基率而非颠覆基率——因此触发信号少或信号弱时，结论贴近先验是模型的预期行为，不代表分析失效。"),
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
									return (SIGNAL_NAMES[a.key] || a.key) + "（" + (a.contribution > 0 ? "看多" : a.contribution < 0 ? "看空" : "中性") + " " + (a.contribution >= 0 ? "+" : "") + a.contribution.toFixed(3) + "）";
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
			} else {
				// 未发起分析时的空态：算法说明（正式版既有内容，口径已随卡尔曼融合更新）
				header = h(AlgorithmIntro);
			}

			return h("div", { className: "dsh-sb-root", style: S.wrap },
				h("div", { style: S.row },
					h("input", {
						style: Object.assign({}, S.input, { flex: "1 1 180px", minWidth: "150px" }),
						value: symbol, placeholder: "输入股票代码，如 600519 / 000001 / AAPL",
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
						onClick: function () { run(); },
					}, view.status === "loading" ? "分析中…" : "贝叶斯分析"),
				),
				h("div", { style: S.hint }, "示例：600519（贵州茅台）、000001（平安银行）、300750（宁德时代）、688981（中芯国际）、AAPL（苹果）"),
				header);
		}

		// ---------- 策略回测 Tab ----------
		function BacktestTab() {
			var sH = React.useState("5"); var horizon = sH[0]; var setHorizon = sH[1];
			var sS = React.useState("5"); var step = sS[0]; var setStep = sS[1];
			var sN = React.useState("10"); var topN = sN[0]; var setTopN = sN[1];
			var sT = React.useState("0"); var threshold = sT[0]; var setThreshold = sT[1];
			var sI = React.useState("1000000"); var initial = sI[0]; var setInitial = sI[1];
			var sD = React.useState("2026-01-04"); var startDate = sD[0]; var setStartDate = sD[1];
			var sM = React.useState("0"); var marketTiming = sM[0]; var setMarketTiming = sM[1];
			var sR = React.useState("R0"); var timingRule = sR[0]; var setTimingRule = sR[1];
			var sP = React.useState("all"); var pool = sP[0]; var setPool = sP[1];
			var sE = React.useState("2026-08-20"); var endDate = sE[0]; var setEndDate = sE[1];
			var sST = React.useState("0"); var excludeST = sST[0]; var setExcludeST = sST[1];
			var sMinP = React.useState(""); var minPrice = sMinP[0]; var setMinPrice = sMinP[1];
			var sMaxP = React.useState(""); var maxPrice = sMaxP[0]; var setMaxPrice = sMaxP[1];
			var sMC = React.useState(""); var minMktcap = sMC[0]; var setMinMktcap = sMC[1];
			var sLD = React.useState(""); var minListDays = sLD[0]; var setMinListDays = sLD[1];
			var sSL = React.useState(""); var stopLossPct = sSL[0]; var setStopLossPct = sSL[1];
			var sMP = React.useState(""); var maxPositionPct = sMP[0]; var setMaxPositionPct = sMP[1];
			var sMB = React.useState(""); var maxPerBoard = sMB[0]; var setMaxPerBoard = sMB[1];
			var sMX = React.useState(""); var maxScore = sMX[0]; var setMaxScore = sMX[1];
			var sCR = React.useState("0"); var commissionRate = sCR[0]; var setCommissionRate = sCR[1];
			var sSta = React.useState("0"); var stampTax = sSta[0]; var setStampTax = sSta[1];
			var sPL = React.useState({}); var poolsInfo = sPL[0]; var setPoolsInfo = sPL[1];
			var sDl = React.useState(false); var showDetails = sDl[0]; var setShowDetails = sDl[1];
			var sV = React.useState({ status: "idle", data: null, error: null });
			var view = sV[0]; var setView = sV[1];
			var sRf = React.useState(""); var refreshMsg = sRf[0]; var setRefreshMsg = sRf[1];
			var sHv = React.useState(null); var hover = sHv[0]; var setHover = sHv[1]; // 曲线 hover：{line, i}

			// 折叠分组：默认收起减少视觉噪音；已设非默认值时自动展开（首次渲染生效）
			var filterActive = (excludeST === "1" ? 1 : 0)
				+ [minPrice, maxPrice, minMktcap, minListDays].filter(function (v) { return v !== ""; }).length;
			var riskActive = (timingRule !== "R0" ? 1 : 0)
				+ [stopLossPct, maxPositionPct, maxPerBoard].filter(function (v) { return v !== ""; }).length
				+ (commissionRate !== "" && commissionRate !== "0" ? 1 : 0)
				+ (stampTax !== "" && stampTax !== "0" ? 1 : 0);
			var sFO = React.useState(filterActive > 0); var filterOpen = sFO[0]; var setFilterOpen = sFO[1];
			var sRO = React.useState(riskActive > 0); var riskOpen = sRO[0]; var setRiskOpen = sRO[1];

			React.useEffect(function () {
				fetch("/bayes-predict/pools")
					.then(function (r) { return r.json().catch(function () { return null; }); })
					.then(function (j) { if (j && j.ok && j.pools) setPoolsInfo(j.pools); })
					.catch(function () { /* 忽略，回退到静态选项 */ });
			}, []);

			function refresh() {
				setRefreshMsg("正在增量刷新缓存（只拉最后日期以来的新K线）…");
				fetch("/bayes-predict/refresh?pool=" + encodeURIComponent(pool))
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setRefreshMsg("缓存刷新完成：新增 " + (r.json.updated ?? 0) + " 只，无变化 " + (r.json.noChange ?? 0) + " 只，失败 " + (r.json.fail ?? 0) + " 只（共 " + r.json.total + "）" + (r.json.indexUpdated ? "，指数已更新。" : "。"));
					})
					.catch(function (err) { setRefreshMsg("刷新失败：" + String((err && err.message) || err)); });
			}

			function run() {
				setView({ status: "loading", data: null, error: null });
				// 费率单位换算：佣金"万X"→小数，印花税"千X"→小数
				var comm = commissionRate === "" ? "" : (Number(commissionRate) / 10000);
				var stamp = stampTax === "" ? "" : (Number(stampTax) / 1000);
				var qs = new URLSearchParams({
					horizon: horizon, step: step, topN: topN, threshold: threshold,
					initial: initial, startDate: startDate, endDate: endDate, marketTiming: marketTiming, timingRule: timingRule, pool: pool,
					excludeST: excludeST, minPrice: minPrice, maxPrice: maxPrice, minMktcap: minMktcap, minListDays: minListDays,
					stopLossPct: stopLossPct, maxPositionPct: maxPositionPct, maxPerBoard: maxPerBoard, maxScore: maxScore,
					commissionRate: comm, stampTax: stamp,
				});
				fetch("/bayes-predict/backtest?" + qs.toString())
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setView({ status: "done", data: r.json, error: null });
					})
					.catch(function (err) { setView({ status: "error", data: null, error: String((err && err.message) || err) }); });
			}

			function fmtMoney(x) { if (x == null || !Number.isFinite(x)) return "—"; return Number(x).toLocaleString("zh-CN", { maximumFractionDigits: 0 }); }

			// 控件/选项样式已提升为模块级 CTL / OPT（与筛选、风控分组共用同一规格）

			var result = null;
			if (view.status === "done" && view.data) {
				var d = view.data;
				var up = d.totalReturn >= 0;
				var color = up ? "#22c55e" : "#ef4444";
				var eqs = d.periods.map(function (p) { return p.equity; });
				var nPts = d.periods.length;
				// 低分 Top 曲线（后端 lowCurve 提供）
				var lowEqs = d.lowCurve && d.lowCurve.equity && d.lowCurve.equity.length === nPts ? d.lowCurve.equity : null;
				// y 轴范围覆盖三条线：高分策略 + 低分策略 + 池基准
				var allVals = eqs.concat(d.poolBenchmark || []).concat(lowEqs || []);
				var minE = Math.min.apply(null, allVals), maxE = Math.max.apply(null, allVals);
				var span = (maxE - minE) || 1;
				var ptX = function (i) { return (i / (nPts - 1)) * 100; };
				var ptY = function (v) { return ((40 - ((v - minE) / span) * 36 - 2) / 40) * 100; };
				var lineOf = function (arr) { return arr ? arr.map(function (v, i) { return ptX(i).toFixed(2) + "," + (40 - ((v - minE) / span) * 36 - 2).toFixed(2); }).join(" ") : null; };
				var pts = lineOf(eqs);
				var poolBenchPts = d.poolBenchmark && d.poolBenchmark.length === nPts ? lineOf(d.poolBenchmark) : null;
				var poolBenchFinal = poolBenchPts ? d.poolBenchmark[d.poolBenchmark.length - 1] : null;
				var lowPts = lowEqs ? lineOf(lowEqs) : null;
				var lowFinal = lowEqs ? lowEqs[lowEqs.length - 1] : null;
				var retTxt = function (v) { var x = (v / d.params.initial - 1) * 100; return (x >= 0 ? "+" : "") + x.toFixed(2) + "%"; };
				// 三条线的元信息（hover 命中判定与 tooltip 共用）
				var LINES = [
					{ key: "eq", name: "策略·高分", color: color, arr: eqs, pts: pts, width: 1.5, hoverWidth: 2.5 },
					{ key: "low", name: "策略·低分", color: "#f97316", arr: lowEqs, pts: lowPts, width: 1.2, hoverWidth: 2, dash: "4 2" },
					{ key: "pool", name: "池基准", color: "#3b82f6", arr: d.poolBenchmark || null, pts: poolBenchPts, width: 1.2, hoverWidth: 2, dash: "5 3" },
				];
				// hover：鼠标移动 → 按最近 x 取索引，再按 y 距离选择最近的线（阈值 6% 高度内）
				function onChartMove(e) {
					var r = e.currentTarget.getBoundingClientRect();
					var xPct = (e.clientX - r.left) / r.width * 100;
					var ySvg = (e.clientY - r.top) / r.height * 40;
					var i = Math.max(0, Math.min(nPts - 1, Math.round(xPct / 100 * (nPts - 1))));
					var best = null, bestD = 1e9;
					LINES.forEach(function (ln) {
						if (!ln.arr || ln.arr[i] == null) return;
						var ly = 40 - ((ln.arr[i] - minE) / span) * 36 - 2;
						var dd = Math.abs(ly - ySvg);
						if (dd < bestD && dd < 6) { bestD = dd; best = ln; }
					});
					setHover(best ? { line: best.key, i: i } : null);
				}
				// hover tooltip：该线在 hover 点的值 + 整线最高/最低/最终收益率
				var hv = null;
				if (hover) {
					var ln = LINES.filter(function (l) { return l.key === hover.line; })[0];
					if (ln && ln.arr && ln.arr[hover.i] != null) {
						var vals = ln.arr.filter(function (v) { return v != null && Number.isFinite(v); });
						if (vals.length) {
							var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
							hv = {
								ln: ln, cur: ln.arr[hover.i],
								mx: mx, mn: mn, fin: ln.arr[ln.arr.length - 1],
								mxI: ln.arr.indexOf(mx), mnI: ln.arr.indexOf(mn),
							};
						}
					}
				}
				result = h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
					h("div", { style: S.card },
						h("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
							h("div", { style: Object.assign({}, S.stat, { flex: "1 1 140px" }) }, h("div", { style: S.statLabel }, "最终账户"),
								h("div", { style: Object.assign({}, S.statValue, { color: color }) }, fmtMoney(d.finalEquity))),
							h("div", { style: Object.assign({}, S.stat, { flex: "1 1 140px" }) }, h("div", { style: S.statLabel }, "收益率"),
								h("div", { style: Object.assign({}, S.statValue, { color: color }) }, (d.totalReturn * 100).toFixed(2) + "%")),
							h("div", { style: Object.assign({}, S.stat, { flex: "1 1 140px" }) }, h("div", { style: S.statLabel }, "绝对盈亏"),
								h("div", { style: Object.assign({}, S.statValue, { color: color }) }, (d.absPnL >= 0 ? "+" : "") + fmtMoney(d.absPnL))),
							h("div", { style: Object.assign({}, S.stat, { flex: "1 1 140px" }) }, h("div", { style: S.statLabel }, "换仓期数 / 股票池"),
								h("div", { style: S.statValue }, String(d.periods.length) + " / " + d.universeSize)),
							h("div", { style: Object.assign({}, S.stat, { flex: "1 1 140px" }) }, h("div", { style: S.statLabel }, "超额收益 vs 池基准"),
								h("div", { style: Object.assign({}, S.statValue, { color: d.poolBenchmarkReturn != null && d.totalReturn >= d.poolBenchmarkReturn ? "#22c55e" : "#ef4444" }) },
									d.poolBenchmarkReturn != null ? (((d.totalReturn - d.poolBenchmarkReturn) * 100 >= 0 ? "+" : "") + ((d.totalReturn - d.poolBenchmarkReturn) * 100).toFixed(2) + "%") : "—"))),
					h("div", { style: S.card },
						h("div", { style: S.title }, "📈 权益曲线（" + d.periods[0].date + " ~ " + d.periods.at(-1).date + "）"),
						h("div", { style: { position: "relative" } },
							h("svg", { viewBox: "0 0 100 40", preserveAspectRatio: "none", style: { width: "100%", height: "140px", display: "block", cursor: "crosshair" }, onMouseMove: onChartMove, onMouseLeave: function () { setHover(null); } },
								[8, 18, 28, 38].map(function (gy) {
									return h("line", { key: "grid" + gy, x1: 0, y1: gy, x2: 100, y2: gy, stroke: "var(--dsw-alias-border-l1, #f3f4f6)", strokeWidth: 0.6, strokeDasharray: "2 3", vectorEffect: "non-scaling-stroke" });
								}),
								LINES.map(function (ln) {									if (!ln.pts) return null;
									if (hover && hover.line !== ln.key) {
										// 非 hover 线淡化，突出当前关注的线
										return h("polyline", { key: ln.key, points: ln.pts, fill: "none", stroke: ln.color, strokeWidth: ln.width, strokeDasharray: ln.dash || null, opacity: 0.3, vectorEffect: "non-scaling-stroke", style: { transition: "opacity 0.15s" } });
									}
									if (hover && hover.line === ln.key) {
										// hover 线：同色光晕层（加粗半透明）+ 加粗主线
										return h("g", { key: ln.key },
											h("polyline", { points: ln.pts, fill: "none", stroke: ln.color, strokeWidth: ln.hoverWidth + 4, opacity: 0.25, vectorEffect: "non-scaling-stroke" }),
											h("polyline", { points: ln.pts, fill: "none", stroke: ln.color, strokeWidth: ln.hoverWidth, strokeDasharray: ln.dash || null, vectorEffect: "non-scaling-stroke" }));
									}
									return h("polyline", { key: ln.key, points: ln.pts, fill: "none", stroke: ln.color, strokeWidth: ln.width, strokeDasharray: ln.dash || null, vectorEffect: "non-scaling-stroke" });
								})),
							// 常显角标：三条线的 y 轴范围（最高/最低收益率）
							h("div", { style: { position: "absolute", top: "4px", right: "8px", fontSize: "10px", color: "var(--dsw-alias-label-secondary, #6b7280)", background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))", padding: "2px 7px", borderRadius: "6px", zIndex: 2, pointerEvents: "none" } }, "最高 " + retTxt(maxE) + " ｜ 最低 " + retTxt(minE)),
							// hover：垂直参考线（贯穿全图）+ 数据点圆点（HTML 覆盖层，避免 SVG 非等比缩放变形）
							hv ? h("div", { key: "vline", style: { position: "absolute", left: ptX(hover.i).toFixed(2) + "%", top: 0, bottom: 0, width: "1px", background: "rgba(148,163,184,0.55)", zIndex: 1, pointerEvents: "none" } }) : null,
							hv ? h("div", { key: "dot", style: { position: "absolute", left: ptX(hover.i).toFixed(2) + "%", top: ptY(hv.cur).toFixed(2) + "%", width: "9px", height: "9px", borderRadius: "50%", background: hv.ln.color, border: "2px solid #ffffff", transform: "translate(-50%, -50%)", boxShadow: "0 0 4px rgba(0,0,0,0.45)", zIndex: 2, pointerEvents: "none" } }) : null,
							hv ? h("div", { style: { position: "absolute", left: ptX(hover.i).toFixed(2) + "%", top: (ptY(hv.cur) - 4).toFixed(2) + "%", transform: "translate(" + (ptX(hover.i) > 85 ? "-100%" : ptX(hover.i) < 15 ? "0%" : "-50%") + ", -135%)", background: "var(--dsw-alias-bg-overlay, rgba(255,255,255,0.96))", border: "1px solid " + hv.ln.color, borderRadius: "6px", padding: "5px 8px", fontSize: "11px", lineHeight: "1.5", color: "var(--dsw-alias-label-primary, #1f2937)", whiteSpace: "nowrap", zIndex: 3, boxShadow: "0 2px 10px rgba(0,0,0,0.18)", pointerEvents: "none" } },
								h("div", { style: { fontWeight: 700, color: hv.ln.color } }, hv.ln.name + " @" + d.periods[hover.i].date),
								h("div", null, "当前 " + retTxt(hv.cur) + "（" + fmtMoney(hv.cur) + "）"),
								h("div", null, "最高 " + retTxt(hv.mx) + " @" + d.periods[hv.mxI].date),
								h("div", null, "最低 " + retTxt(hv.mn) + " @" + d.periods[hv.mnI].date),
								h("div", { style: { borderTop: "1px solid #e5e7eb", marginTop: "3px", paddingTop: "3px" } }, "最终 " + retTxt(hv.fin))) : null),
						lowPts ? h("div", { style: Object.assign({}, S.hint, { marginTop: "2px" }) }, "橙色虚线 = 策略·低分 Top（期末 " + fmtMoney(lowFinal) + "，收益 " + retTxt(lowFinal) + "）") : null,
						poolBenchPts ? h("div", { style: Object.assign({}, S.hint, { marginTop: "2px" }) }, "蓝色点划线 = 池基准：符合条件股票池等权综合指数（期末 " + fmtMoney(poolBenchFinal) + "，收益 " + retTxt(poolBenchFinal) + "）") : null,
						h("div", { style: Object.assign({}, S.hint, { marginTop: "2px" }) }, "💡 鼠标悬停曲线查看该线的当前/最高/最低/最终收益率")),
					h("div", { style: S.card },
						h("div", { style: Object.assign({}, S.title, { cursor: "pointer", userSelect: "none" }), onClick: function () { setShowDetails(!showDetails); } },
							"📋 逐期换仓明细", showDetails ? "  ▼" : "  ▶"),
						showDetails ? h("table", { style: S.table },
							h("thead", null, h("tr", null,
								h("th", { style: S.th }, "期"), h("th", { style: S.th }, "换仓日"),
								h("th", { style: S.th }, "买入只数"), h("th", { style: S.th }, "买入额"),
								h("th", { style: S.th }, "期末权益"), h("th", { style: S.th }, "评分"))),
							h("tbody", null, d.periods.map(function (p, i) {
								return h("tr", { key: p.date },
									h("td", { style: S.td }, String(i + 1)),
									h("td", { style: S.td }, p.date),
									h("td", { style: S.td }, String(p.nBuy)),
									h("td", { style: S.td }, fmtMoney(p.spent)),
									h("td", { style: S.td }, fmtMoney(p.equity)),
									h("td", { style: S.td, fontSize: "11px" }, p.buys.map(function (b) { return b.code + "(" + b.score + ")"; }).join(" ")));
							}))) : null)),
					h("div", { style: S.hint }, "⚠️ 回测基于历史行情与贝叶斯评分（严格防前视），未计佣金/印花税/滑点，仅供参考，不构成投资建议。"));
			} else if (view.status === "loading") {
				result = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "32px" }) },
					h("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
						h("span", { className: "dsh-sb-spinner" }), "正在全股票池评分并模拟换仓，可能需要几十秒到数分钟…"));
			} else if (view.status === "idle") {
				result = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "28px", borderStyle: "dashed" }) },
					h("div", { style: { fontSize: "24px", marginBottom: "6px" } }, "📊"),
					h("div", { style: { fontWeight: 600, marginBottom: "6px", color: "var(--dsw-alias-label-primary)" } }, "策略回测"),
					h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.9, maxWidth: "480px", margin: "0 auto" }) },
						"配置上方参数后点击「运行回测」：按贝叶斯评分排序取 TopN 等分买入，同时给出高分 / 低分两条策略曲线与符合条件的股票池等权综合指数（池基准）对比。评分按 horizon 预缓存，参数调整秒级复用。"));
			} else if (view.status === "error") {
				result = h("div", { style: S.error }, "回测失败：" + view.error);
			}

			var GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px 10px" };
			var dateCtl = Object.assign({}, CTL, { colorScheme: DATE_SCHEME });

			return h("div", { className: "dsh-sb-root", style: S.wrap },
				h("div", { style: S.card },
					// —— 卡片标题行 ——
					h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
						h("div", { style: Object.assign({}, S.title, { marginBottom: 0 }) }, "⚙️ 回测参数"),
						h("span", { style: S.muted }, "贝叶斯评分选股 · 严格防前视")),
					// —— 基础参数（常显）——
					h("div", { style: GRID },
						h(Field, { label: "股票资源池", style: { gridColumn: "span 2" } },
							h("select", { style: CTL, value: pool, onChange: function (e) { setPool(e.target.value); } },
								h("option", { style: OPT, value: "all" }, poolsInfo.all ? "A股全量（" + poolsInfo.all.count + " 只）" : "A股全量"),
								h("option", { style: OPT, value: "sh300" }, poolsInfo.sh300 ? "沪深300成分（" + poolsInfo.sh300.count + " 只）" : "沪深300成分"),
								h("option", { style: OPT, value: "m_沪主板" }, poolsInfo.m_沪主板 ? "沪主板（" + poolsInfo.m_沪主板.count + "）" : "沪主板"),
								h("option", { style: OPT, value: "m_深主板" }, poolsInfo.m_深主板 ? "深主板（" + poolsInfo.m_深主板.count + "）" : "深主板"),
								h("option", { style: OPT, value: "m_创业板" }, poolsInfo.m_创业板 ? "创业板（" + poolsInfo.m_创业板.count + "）" : "创业板"),
								h("option", { style: OPT, value: "m_科创板" }, poolsInfo.m_科创板 ? "科创板（" + poolsInfo.m_科创板.count + "）" : "科创板"),
								h("option", { style: OPT, value: "m_北交所" }, poolsInfo.m_北交所 ? "北交所（" + poolsInfo.m_北交所.count + "）" : "北交所"),
								h("option", { style: OPT, value: "cap_大盘" }, poolsInfo.cap_大盘 ? "大盘股（" + poolsInfo.cap_大盘.count + "）" : "大盘股"),
								h("option", { style: OPT, value: "cap_中盘" }, poolsInfo.cap_中盘 ? "中盘股（" + poolsInfo.cap_中盘.count + "）" : "中盘股"),
								h("option", { style: OPT, value: "cap_小盘" }, poolsInfo.cap_小盘 ? "小盘股（" + poolsInfo.cap_小盘.count + "）" : "小盘股"))),
						h(Field, { label: "评分窗口 horizon" },
							h("select", { style: CTL, value: horizon, onChange: function (e) { setHorizon(e.target.value); } },
								h("option", { style: OPT, value: "2" }, "2 日"), h("option", { style: OPT, value: "5" }, "5 日"), h("option", { style: OPT, value: "10" }, "10 日"), h("option", { style: OPT, value: "20" }, "20 日"))),
						h(Field, { label: "每期持有交易日" },
							h("input", { style: CTL, type: "number", min: "1", value: step, onChange: function (e) { setStep(e.target.value); } })),
						h(Field, { label: "同时持有个数" },
							h("input", { style: CTL, type: "number", min: "1", max: "20", value: topN, onChange: function (e) { setTopN(e.target.value); } })),
						h(Field, { label: "评分门槛（下限 ~ 上限）", title: "下限：只买评分 > 下限 的股票（0=全部）；上限：只买评分 ≤ 上限 的股票（留空=不限）" },
							h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
								h("input", { style: Object.assign({}, CTL, { width: "auto", flex: "1 1 0" }), type: "number", min: "0", max: "100", placeholder: "下限", value: threshold, onChange: function (e) { setThreshold(e.target.value); } }),
								h("span", { style: Object.assign({}, S.muted, { flexShrink: 0 }) }, "~"),
								h("input", { style: Object.assign({}, CTL, { width: "auto", flex: "1 1 0" }), type: "number", min: "0", max: "100", placeholder: "上限", value: maxScore, onChange: function (e) { setMaxScore(e.target.value); } }))),
						h(Field, { label: "初始资金（元）" },
							h("input", { style: CTL, type: "number", min: "1000", value: initial, onChange: function (e) { setInitial(e.target.value); } })),
						h(Field, { label: "起始日期" },
							h("input", { style: dateCtl, type: "date", min: "2023-05-01", value: startDate, onChange: function (e) { setStartDate(e.target.value); } })),
						h(Field, { label: "结束日期" },
							h("input", { style: dateCtl, type: "date", value: endDate, onChange: function (e) { setEndDate(e.target.value); } }))),
					// —— 筛选条件（可折叠）——
					h(SecHeader, { title: "筛选条件", open: filterOpen, count: filterActive, onToggle: function () { setFilterOpen(!filterOpen); } }),
					filterOpen ? h("div", { style: GRID },
						h(Field, { label: "排除 ST 股" },
							h("select", { style: CTL, value: excludeST, onChange: function (e) { setExcludeST(e.target.value); } },
								h("option", { style: OPT, value: "0" }, "否"), h("option", { style: OPT, value: "1" }, "是"))),
						h(Field, { label: "价格下限（元）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minPrice, onChange: function (e) { setMinPrice(e.target.value); } })),
						h(Field, { label: "价格上限（元）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: maxPrice, onChange: function (e) { setMaxPrice(e.target.value); } })),
						h(Field, { label: "市值下限（亿）", title: "按截至换仓日的历史推算市值过滤（消除前视偏差）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minMktcap, onChange: function (e) { setMinMktcap(e.target.value); } })),
						h(Field, { label: "排除次新股（上市 ≥ N 天）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minListDays, onChange: function (e) { setMinListDays(e.target.value); } }))) : null,
					// —— 风控与费用（可折叠）——
					h(SecHeader, { title: "风控与费用", open: riskOpen, count: riskActive, onToggle: function () { setRiskOpen(!riskOpen); } }),
					riskOpen ? h("div", { style: GRID },
						h(Field, { label: "大盘择时规则", title: "选「关闭」=不择时；选 R1-R4 自动开启大盘择时" },
							h("select", { style: CTL, value: timingRule, onChange: function (e) { var v = e.target.value; setTimingRule(v); setMarketTiming(v === "R0" ? "0" : "1"); } },
								h("option", { style: OPT, value: "R0" }, "关闭"),
								h("option", { style: OPT, value: "R1" }, "R1 · 跌破MA20空仓"),
								h("option", { style: OPT, value: "R2" }, "R2 · 跌破MA20且回撤>3%"),
								h("option", { style: OPT, value: "R3" }, "R3 · 回撤>5%半仓"),
								h("option", { style: OPT, value: "R4" }, "R4 · 双跌破空仓"))),
						h(Field, { label: "个股止损（跌 X% 卖出）", title: "持有期内最低价跌破买入价 X% 时提前卖出" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: stopLossPct, onChange: function (e) { setStopLossPct(e.target.value); } })),
						h(Field, { label: "单只最大仓位（%）" },
							h("input", { style: CTL, type: "number", min: "1", max: "100", placeholder: "不限", value: maxPositionPct, onChange: function (e) { setMaxPositionPct(e.target.value); } })),
						h(Field, { label: "同板块最多持有（只）" },
							h("input", { style: CTL, type: "number", min: "1", placeholder: "不限", value: maxPerBoard, onChange: function (e) { setMaxPerBoard(e.target.value); } })),
						h(Field, { label: "佣金费率（‱）", title: "单边佣金：填 2.5 表示万 2.5（0.025%）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "0", value: commissionRate, onChange: function (e) { setCommissionRate(e.target.value); } })),
						h(Field, { label: "印花税（‰，卖出）", title: "卖出印花税：填 0.5 表示千 0.5（0.05%）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "0", value: stampTax, onChange: function (e) { setStampTax(e.target.value); } }))) : null,
					// —— 操作栏（卡片底部分隔）——
					h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "18px", paddingTop: "14px", borderTop: "1px solid var(--dsw-alias-border-l1)", flexWrap: "wrap" } },
						h("button", { style: Object.assign({}, S.button, view.status === "loading" ? S.buttonDisabled : {}), disabled: view.status === "loading", onClick: run },
							view.status === "loading" ? "回测中…" : "▶ 运行回测"),
						h("button", { className: "dsh-sb-ghost", style: Object.assign({}, S.button, { background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }), onClick: refresh },
							"🔄 刷新行情缓存"),
						refreshMsg ? h("span", { style: Object.assign({}, S.muted, { flex: "1 1 200px", minWidth: "0" }) }, refreshMsg) : null),
					h("div", { style: Object.assign({}, S.hint, { marginTop: "8px" }) },
						"资源池：A股全量 / 沪深300 / 各板块 / 市值档。评分 = 贝叶斯未来 " + horizon + " 日上涨概率 × 100（防前视，已缓存则秒级）。")),

				result);
			}

		// ---------- 选股筛选 Tab ----------
		// 与「策略回测」共用同一套输入条件，但不做换仓模拟：只对基准日做一次截面评分，
		// 把符合条件（并按评分排序）的股票直接列成表格——回答"按这些条件今天选出的股票"。
		// 评分读写与服务端回测同一份缓存：已回测/已筛选过的日期秒级命中，新日期现场补算并写回。
		function ScreenTab(props) {
			var sP = React.useState("all"); var pool = sP[0]; var setPool = sP[1];
			var sH = React.useState("5"); var horizon = sH[0]; var setHorizon = sH[1];
			var sD = React.useState(""); var date = sD[0]; var setDate = sD[1];
			var sT = React.useState("0"); var threshold = sT[0]; var setThreshold = sT[1];
			var sMX = React.useState(""); var maxScore = sMX[0]; var setMaxScore = sMX[1];
			var sSM = React.useState("top"); var selectMode = sSM[0]; var setSelectMode = sSM[1];
			var sL = React.useState("50"); var limit = sL[0]; var setLimit = sL[1];
			var sST = React.useState("0"); var excludeST = sST[0]; var setExcludeST = sST[1];
			var sMinP = React.useState(""); var minPrice = sMinP[0]; var setMinPrice = sMinP[1];
			var sMaxP = React.useState(""); var maxPrice = sMaxP[0]; var setMaxPrice = sMaxP[1];
			var sMC = React.useState(""); var minMktcap = sMC[0]; var setMinMktcap = sMC[1];
			var sLD = React.useState(""); var minListDays = sLD[0]; var setMinListDays = sLD[1];
			var sPL = React.useState({}); var poolsInfo = sPL[0]; var setPoolsInfo = sPL[1];
			var sV = React.useState({ status: "idle", data: null, error: null });
			var view = sV[0]; var setView = sV[1];
			var sRf = React.useState(""); var refreshMsg = sRf[0]; var setRefreshMsg = sRf[1];
			var sSort = React.useState({ key: "score", dir: -1 });
			var sort = sSort[0]; var setSort = sSort[1];
			// 自选股：codes 映射（code -> true），用于渲染 ★ 状态；与「自选股」页签共用同一份 host 存储
			var sW = React.useState({}); var wl = sW[0]; var setWl = sW[1];
			var sWm = React.useState(""); var wlMsg = sWm[0]; var setWlMsg = sWm[1];
			var sWb = React.useState(false); var wlBusy = sWb[0]; var setWlBusy = sWb[1];

			// 筛选条件折叠：与回测页同一套「已设 N 项」徽标逻辑
			var filterActive = (excludeST === "1" ? 1 : 0)
				+ [minPrice, maxPrice, minMktcap, minListDays].filter(function (v) { return v !== ""; }).length
				+ (maxScore !== "" ? 1 : 0);
			var sFO = React.useState(false); var filterOpen = sFO[0]; var setFilterOpen = sFO[1];

			React.useEffect(function () {
				fetch("/bayes-predict/pools")
					.then(function (r) { return r.json().catch(function () { return null; }); })
					.then(function (j) { if (j && j.ok && j.pools) setPoolsInfo(j.pools); })
					.catch(function () { /* 忽略，回退到静态选项 */ });
				// 自选清单（轻量：只取代码，不评分）
				wlFetchCodes()
					.then(function (j) { setWl(wlCodesToMap(j.codes)); })
					.catch(function (err) { setWlMsg("自选股清单不可用：" + String((err && err.message) || err)); });
			}, []);

			// 单只加/移出自选
			function toggleWatch(row) {
				var inWl = !!wl[row.code];
				setWlMsg((inWl ? "正在移出 " : "正在加入 ") + row.code + "…");
				wlMutate(inWl ? "remove" : "add", row.code)
					.then(function (r) {
						setWl(wlCodesToMap(r.codes));
						setWlMsg(inWl
							? row.code + "（" + (row.name || "") + "）已移出自选"
							: row.code + "（" + (row.name || "") + "）已加入自选：自选日 " + ((r.item && r.item.anchorDate) || "—") + "，自选价 " + fmtPrice(r.item && r.item.anchorClose));
					})
					.catch(function (err) { setWlMsg("操作失败：" + String((err && err.message) || err)); });
			}

			// 把当前结果整批加自选（串行，避免几十个 POST 同时打上去）
			function addAllVisible(rows) {
				var todo = (rows || []).map(function (r) { return r.code; }).filter(function (c) { return !wl[c]; });
				if (!todo.length) { setWlMsg("当前显示的股票都已在自选里。"); return; }
				if (todo.length > 5 && typeof window !== "undefined" && typeof window.confirm === "function"
					&& !window.confirm("将把当前显示的 " + todo.length + " 只股票加入自选股，继续？（自选日 = 各自最新交易日）")) return;
				setWlBusy(true);
				var added = 0, failed = 0;
				var chain = Promise.resolve();
				todo.forEach(function (code) {
					chain = chain.then(function () {
						return wlMutate("add", code).then(function (r) {
							added++;
							setWl(wlCodesToMap(r.codes));
							setWlMsg("已加入 " + added + " / " + todo.length + " 只…");
						}).catch(function () { failed++; });
					});
				});
				chain.then(function () {
					setWlBusy(false);
					setWlMsg("批量加自选完成：成功 " + added + " 只" + (failed ? "，失败 " + failed + " 只" : "") + "。到「自选股」页签查看自选日至今涨跌幅。");
				});
			}

			function refresh() {
				setRefreshMsg("正在增量刷新缓存（只拉最后日期以来的新K线）…");
				fetch("/bayes-predict/refresh?pool=" + encodeURIComponent(pool))
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setRefreshMsg("缓存刷新完成：新增 " + (r.json.updated ?? 0) + " 只，无变化 " + (r.json.noChange ?? 0) + " 只，失败 " + (r.json.fail ?? 0) + " 只（共 " + r.json.total + "）。重新筛选即可用上新数据。");
					})
					.catch(function (err) { setRefreshMsg("刷新失败：" + String((err && err.message) || err)); });
			}

			function run() {
				setView({ status: "loading", data: null, error: null });
				var qs = new URLSearchParams({
					pool: pool, horizon: horizon, date: date, limit: limit,
					threshold: threshold, maxScore: maxScore, selectMode: selectMode,
					excludeST: excludeST, minPrice: minPrice, maxPrice: maxPrice,
					minMktcap: minMktcap, minListDays: minListDays,
				});
				fetch("/bayes-predict/screen?" + qs.toString())
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setView({ status: "done", data: r.json, error: null });
					})
					.catch(function (err) { setView({ status: "error", data: null, error: String((err && err.message) || err) }); });
			}

			// 点表头排序：同列再点一次反向；数值列默认降序，文本列默认升序
			function toggleSort(key, numeric) {
				if (sort.key === key) { setSort({ key: key, dir: -sort.dir }); return; }
				setSort({ key: key, dir: numeric === false ? 1 : -1 });
			}

			var COLS = [
				{ key: "star", label: "★", sortable: false, align: "center" },
				{ key: "idx", label: "#", sortable: false },
				{ key: "code", label: "代码", align: "left", text: true },
				{ key: "name", label: "名称", align: "left", text: true },
				{ key: "market", label: "板块", align: "left", text: true },
				{ key: "close", label: "现价" },
				{ key: "changePct", label: "涨跌幅" },
				{ key: "score", label: "评分" },
				{ key: "posterior", label: "后验概率" },
				{ key: "mktcapYi", label: "市值(亿)" },
				{ key: "listDays", label: "上市(天)" },
			];

			var result = null;
			if (view.status === "done" && view.data) {
				var d = view.data;
				var rows = d.rows || [];
				var sorted = rows.slice();
				if (sort.key !== "idx") {
					sorted.sort(function (a, b) {
						var x = a[sort.key], y = b[sort.key];
						if (x == null && y == null) return 0;
						if (x == null) return 1;   // 空值恒排最后
						if (y == null) return -1;
						if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "zh") * sort.dir;
						return (x - y) * sort.dir;
					});
				}
				var chips = [
					{ label: "基准日", value: d.date + (d.dateFallback ? "（请求日非交易日）" : "") },
					{ label: "行情数据截至", value: d.dataLastDate },
					{ label: "评分窗口", value: d.horizon + " 日" },
					{ label: "池中可评分", value: d.scored + " / " + d.universeSize },
					{ label: "通过筛选", value: d.candidates + " 只" },
					{ label: "评分缓存命中 / 新算", value: d.reused + " / " + d.computed + (d.cacheSaved ? "（已写回缓存）" : "") },
					{ label: "评分中位 / P90", value: (d.summary && d.summary.medianScore != null ? d.summary.medianScore : "—") + " / " + (d.summary && d.summary.p90Score != null ? d.summary.p90Score : "—") },
					{ label: "耗时", value: (d.elapsedMs / 1000).toFixed(1) + " 秒" },
				];
				result = h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
					h("div", { style: S.card },
						h("div", { style: S.grid },
							chips.map(function (c) {
								return h("div", { key: c.label, style: S.stat },
									h("div", { style: S.statLabel }, c.label),
									h("div", { style: Object.assign({}, S.statValue, { fontSize: "14px" }) }, c.value));
							}))),
					sorted.length
						? h("div", { style: S.card },
							h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", marginBottom: "8px" } },
								h("div", { style: Object.assign({}, S.title, { marginBottom: 0 }) }, "📋 选股结果"),
								h("span", { style: S.muted }, d.params.selectMode === "bottom" ? "按评分由低到高" : "按评分由高到低"),
								h("span", { style: S.muted }, "显示 " + sorted.length + " / " + d.candidates + " 只"),
								props.onPick ? h("span", { style: S.muted }, "｜ 点击任意行 → 跳到「单股分析」") : null,
								h("span", { style: { flex: "1 1 0" } }),
								h("button", {
									className: "dsh-sb-ghost",
									style: Object.assign({}, S.button, { padding: "5px 12px", fontSize: "12px", background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }, wlBusy ? S.buttonDisabled : {}),
									disabled: wlBusy,
									title: "把当前显示的这批股票全部加入自选股",
									onClick: function () { addAllVisible(sorted); },
								}, wlBusy ? "加入中…" : "☆ 加自选（当前 " + sorted.filter(function (x) { return !wl[x.code]; }).length + " 只未加）")),
							wlMsg ? h("div", { style: Object.assign({}, S.hint, { marginTop: "0", marginBottom: "6px" }) }, wlMsg) : null,
							h("div", { style: { overflowX: "auto" } },
								h("table", { style: Object.assign({}, S.table, { minWidth: "760px" }) },
									h("thead", null, h("tr", null, COLS.map(function (c) {
										var active = sort.key === c.key;
										return h("th", {
											key: c.key,
											style: Object.assign({}, S.th, {
												textAlign: c.align || "right", whiteSpace: "nowrap",
												cursor: c.sortable === false ? "default" : "pointer",
												userSelect: "none",
												color: active ? "#7c5cff" : "var(--dsw-alias-label-secondary)",
											}),
											onClick: c.sortable === false ? null : function () { toggleSort(c.key, c.text !== true); },
											title: c.sortable === false ? null : "点击排序",
										}, c.label + (active ? (sort.dir < 0 ? " ↓" : " ↑") : ""));
									}))),
									h("tbody", null, sorted.map(function (rw, i) {
										var up = rw.changePct != null && rw.changePct >= 0;
										var cells = {
											idx: h("span", { style: S.muted }, String(i + 1)),
											code: h("span", { style: { fontFamily: "ui-monospace, Consolas, monospace" } }, rw.code),
											name: rw.name || "—",
											market: h("span", { style: S.muted }, rw.market || "—"),
											close: fmtPrice(rw.close),
											changePct: h("span", { style: { color: rw.changePct == null ? "inherit" : (up ? "#22c55e" : "#ef4444"), fontWeight: 600 } },
												rw.changePct == null ? "—" : ((up ? "+" : "") + (rw.changePct * 100).toFixed(2) + "%")),
											score: h("span", { style: { color: scoreColor(rw.score), fontWeight: 700 } }, String(rw.score)),
											posterior: fmtPct(rw.posterior, 1),
											mktcapYi: rw.mktcapYi == null ? "—" : String(rw.mktcapYi),
											listDays: rw.listDays == null ? "—" : String(rw.listDays),
											// ★ 自选开关：stopPropagation 避免触发整行的"跳单股分析"
											star: (function () {
												var inWl = !!wl[rw.code];
												return h("button", {
													className: "dsh-sb-star",
													style: { color: inWl ? "#f59e0b" : "var(--dsw-alias-label-secondary)" },
													title: inWl ? "已自选（点击移出）" : "加入自选（自选日 = 该股最新交易日）",
													onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); toggleWatch(rw); },
												}, inWl ? "★" : "☆");
											})(),
										};
										return h("tr", {
											key: rw.code,
											className: props.onPick ? "dsh-sb-rowlink" : null,
											style: { cursor: props.onPick ? "pointer" : "default" },
											title: props.onPick ? "点击查看 " + rw.code + " 的单股贝叶斯分析" : null,
											onClick: props.onPick ? function () { props.onPick(rw.code); } : null,
										}, COLS.map(function (c) {
											return h("td", { key: c.key, style: Object.assign({}, S.td, { textAlign: c.align || "right", whiteSpace: "nowrap" }) }, cells[c.key]);
										}));
									})))),
						h("div", { style: Object.assign({}, S.hint, { marginTop: "0" }) },
							"☆ / ★ = 加入或移出自选股；加自选时会锚定该股最新交易日为「自选日」，之后在「自选股」页签看自选日至今涨跌幅。"),
						h("div", { style: S.hint },
							"评分 = 贝叶斯未来 " + d.horizon + " 日上涨概率 × 100（防前视：只用到 " + d.date + " 当日为止的数据）。" +
							"筛选条件与「策略回测」完全同源，只是不做换仓模拟。"))
					: h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "28px", borderStyle: "dashed" }) },
						h("div", { style: { fontSize: "24px", marginBottom: "6px" } }, "🔍"),
						h("div", { style: { fontWeight: 600, marginBottom: "6px", color: "var(--dsw-alias-label-primary)" } }, "没有符合条件的股票"),
						h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.9, maxWidth: "480px", margin: "0 auto" }) },
							"基准日 " + d.date + " 全池评分 " + d.scored + " 只，但没有一只通过当前筛选条件。" +
							"可尝试下调评分门槛、放宽价格/市值区间，或关闭部分筛选条件。")),
					h("div", { style: S.hint }, "⚠️ 选股结果由贝叶斯统计模型基于历史行情生成，仅供参考，不构成投资建议。"));
			} else if (view.status === "loading") {
				result = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "32px" }) },
					h("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
						h("span", { className: "dsh-sb-spinner" }), "正在为全池评分并套用筛选条件，可能需要几十秒到数分钟…"),
					h("div", { style: Object.assign({}, S.hint, { marginTop: "8px" }) },
						"首次筛选某个基准日需要现场评分全池；该日期随后写入缓存，再次筛选与回测都秒级命中。"));
			} else if (view.status === "idle") {
				result = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "28px", borderStyle: "dashed" }) },
					h("div", { style: { fontSize: "24px", marginBottom: "6px" } }, "🔍"),
					h("div", { style: { fontWeight: 600, marginBottom: "6px", color: "var(--dsw-alias-label-primary)" } }, "选股筛选"),
					h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.9, maxWidth: "500px", margin: "0 auto" }) },
						"用与「策略回测」相同的条件（资源池 / 评分窗口 / 评分门槛 / 价格·市值·ST·次新过滤），" +
						"但只做基准日的截面选股，直接列出符合条件的股票，不模拟换仓、不画净值曲线。"));
			} else if (view.status === "error") {
				result = h("div", { style: S.error }, "筛选失败：" + view.error);
			}

			var dateCtl2 = Object.assign({}, CTL, { colorScheme: DATE_SCHEME });
			var GRID2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "12px 10px" };

			return h("div", { className: "dsh-sb-root", style: S.wrap },
				h("div", { style: S.card },
					h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
						h("div", { style: Object.assign({}, S.title, { marginBottom: 0 }) }, "🔍 筛选条件"),
						h("span", { style: S.muted }, "与回测同一套条件 · 只选股不回测")),
					h("div", { style: GRID2 },
						h(Field, { label: "股票资源池", style: { gridColumn: "span 2" } },
							h("select", { style: CTL, value: pool, onChange: function (e) { setPool(e.target.value); } },
								h("option", { style: OPT, value: "all" }, poolsInfo.all ? "A股全量（" + poolsInfo.all.count + " 只）" : "A股全量"),
								h("option", { style: OPT, value: "sh300" }, poolsInfo.sh300 ? "沪深300成分（" + poolsInfo.sh300.count + " 只）" : "沪深300成分"),
								h("option", { style: OPT, value: "m_沪主板" }, poolsInfo.m_沪主板 ? "沪主板（" + poolsInfo.m_沪主板.count + "）" : "沪主板"),
								h("option", { style: OPT, value: "m_深主板" }, poolsInfo.m_深主板 ? "深主板（" + poolsInfo.m_深主板.count + "）" : "深主板"),
								h("option", { style: OPT, value: "m_创业板" }, poolsInfo.m_创业板 ? "创业板（" + poolsInfo.m_创业板.count + "）" : "创业板"),
								h("option", { style: OPT, value: "m_科创板" }, poolsInfo.m_科创板 ? "科创板（" + poolsInfo.m_科创板.count + "）" : "科创板"),
								h("option", { style: OPT, value: "m_北交所" }, poolsInfo.m_北交所 ? "北交所（" + poolsInfo.m_北交所.count + "）" : "北交所"),
								h("option", { style: OPT, value: "cap_大盘" }, poolsInfo.cap_大盘 ? "大盘股（" + poolsInfo.cap_大盘.count + "）" : "大盘股"),
								h("option", { style: OPT, value: "cap_中盘" }, poolsInfo.cap_中盘 ? "中盘股（" + poolsInfo.cap_中盘.count + "）" : "中盘股"),
								h("option", { style: OPT, value: "cap_小盘" }, poolsInfo.cap_小盘 ? "小盘股（" + poolsInfo.cap_小盘.count + "）" : "小盘股"))),
						h(Field, { label: "评分窗口 horizon" },
							h("select", { style: CTL, value: horizon, onChange: function (e) { setHorizon(e.target.value); } },
								h("option", { style: OPT, value: "2" }, "2 日"), h("option", { style: OPT, value: "5" }, "5 日"),
								h("option", { style: OPT, value: "10" }, "10 日"), h("option", { style: OPT, value: "20" }, "20 日"))),
						h(Field, { label: "基准日", title: "留空 = 行情数据最新交易日；非交易日自动回退到之前最近的交易日" },
							h("input", { style: dateCtl2, type: "date", value: date, onChange: function (e) { setDate(e.target.value); } })),
						h(Field, { label: "选股方向", title: "高分 = 后验上涨概率最高的 TopN；低分 = 概率最低的 TopN（反向研究）" },
							h("select", { style: CTL, value: selectMode, onChange: function (e) { setSelectMode(e.target.value); } },
								h("option", { style: OPT, value: "top" }, "评分最高（看多）"),
								h("option", { style: OPT, value: "bottom" }, "评分最低（看空）"))),
						h(Field, { label: "显示条数" },
							h("input", { style: CTL, type: "number", min: "1", max: "1000", value: limit, onChange: function (e) { setLimit(e.target.value); } })),
						h(Field, { label: "评分门槛（下限 ~ 上限）", title: "下限：只留评分 > 下限 的股票（0=全部）；上限：只留评分 ≤ 上限 的股票（留空=不限）" },
							h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
								h("input", { style: Object.assign({}, CTL, { width: "auto", flex: "1 1 0" }), type: "number", min: "0", max: "100", placeholder: "下限", value: threshold, onChange: function (e) { setThreshold(e.target.value); } }),
								h("span", { style: Object.assign({}, S.muted, { flexShrink: 0 }) }, "~"),
								h("input", { style: Object.assign({}, CTL, { width: "auto", flex: "1 1 0" }), type: "number", min: "0", max: "100", placeholder: "上限", value: maxScore, onChange: function (e) { setMaxScore(e.target.value); } })))),
					h(SecHeader, { title: "筛选条件", open: filterOpen, count: filterActive, onToggle: function () { setFilterOpen(!filterOpen); } }),
					filterOpen ? h("div", { style: GRID2 },
						h(Field, { label: "排除 ST 股" },
							h("select", { style: CTL, value: excludeST, onChange: function (e) { setExcludeST(e.target.value); } },
								h("option", { style: OPT, value: "0" }, "否"), h("option", { style: OPT, value: "1" }, "是"))),
						h(Field, { label: "价格下限（元）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minPrice, onChange: function (e) { setMinPrice(e.target.value); } })),
						h(Field, { label: "价格上限（元）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: maxPrice, onChange: function (e) { setMaxPrice(e.target.value); } })),
						h(Field, { label: "市值下限（亿）", title: "按截至基准日的历史推算市值过滤（与回测同口径，消除前视偏差）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minMktcap, onChange: function (e) { setMinMktcap(e.target.value); } })),
						h(Field, { label: "排除次新股（上市 ≥ N 天）" },
							h("input", { style: CTL, type: "number", min: "0", placeholder: "不限", value: minListDays, onChange: function (e) { setMinListDays(e.target.value); } }))) : null,
					h("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "18px", paddingTop: "14px", borderTop: "1px solid var(--dsw-alias-border-l1)", flexWrap: "wrap" } },
						h("button", { style: Object.assign({}, S.button, view.status === "loading" ? S.buttonDisabled : {}), disabled: view.status === "loading", onClick: function () { run(); } },
							view.status === "loading" ? "筛选中…" : "🔍 开始筛选"),
						h("button", { className: "dsh-sb-ghost", style: Object.assign({}, S.button, { background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }), onClick: refresh },
							"🔄 刷新行情缓存"),
						refreshMsg ? h("span", { style: Object.assign({}, S.muted, { flex: "1 1 200px", minWidth: "0" }) }, refreshMsg) : null),
					h("div", { style: Object.assign({}, S.hint, { marginTop: "8px" }) },
						"影响选股的条件（资源池 / 评分窗口 / 评分门槛 / 价格·市值·ST·次新过滤）与「策略回测」逐条一致；" +
						"回测里只作用于模拟的参数（初始资金 / 每期持有交易日 / 大盘择时 / 止损 / 仓位 / 费用）对截面选股没有影响，故不在此列出。")),
				result);
		}

		// ---------- 自选股（收藏）Tab ----------
		// 与「选股筛选」联动：筛选结果行首点 ☆ 即加入自选。加入时 host 端锚定该股"最新一根K线"
		// 为「自选日」、其收盘价为「自选价」——此后"自选日至今涨跌幅"以此锚点计算，不随行情刷新漂移。
		// 本页表格把两个时间都摊开：自选日（锚定交易日，参与涨跌幅计算）+ 加入时间（实际点击时刻）。
		function WatchlistTab(props) {
			var sV = React.useState({ status: "idle", data: null, error: null });
			var view = sV[0]; var setView = sV[1];
			var sH = React.useState("5"); var horizon = sH[0]; var setHorizon = sH[1];
			var sIn = React.useState(""); var codeInput = sIn[0]; var setCodeInput = sIn[1];
			var sMsg = React.useState(""); var msg = sMsg[0]; var setMsg = sMsg[1];
			var sBusy = React.useState(false); var busy = sBusy[0]; var setBusy = sBusy[1];
			var sSort = React.useState({ key: "returnSinceAdd", dir: -1 });
			var sort = sSort[0]; var setSort = sSort[1];
			// 表头筛选条件：搜索（代码/拼音首字母/名称）+ 自选日区间 + 盈亏状态 + 评分下限
			var sF = React.useState({ q: "", from: "", to: "", state: "all", minScore: "" });
			var flt = sF[0]; var setFlt = sF[1];
			function setF(key, val) { setFlt(Object.assign({}, flt, { [key]: val })); }
			var fltActive = !!(flt.q.trim() || flt.from || flt.to || (flt.state && flt.state !== "all") || flt.minScore !== "");
			function resetFlt() { setFlt({ q: "", from: "", to: "", state: "all", minScore: "" }); }

			// 单行匹配：代码子串 / 名称子串（中文模糊）/ 拼音首字母变体子串（含多音字变体）
			function matchRow(rw) {
				var q = flt.q.trim().toLowerCase();
				if (q) {
					var hit = rw.code.toLowerCase().indexOf(q) >= 0 || String(rw.name || "").toLowerCase().indexOf(q) >= 0;
					if (!hit) {
						var vars = rw.initialsVariants && rw.initialsVariants.length ? rw.initialsVariants : [rw.initials || ""];
						for (var i = 0; i < vars.length; i++) {
							if (String(vars[i]).toLowerCase().indexOf(q) >= 0) { hit = true; break; }
						}
					}
					if (!hit) return false;
				}
				// 自选日按时间筛：ISO 日期串可直接比较大小
				if (flt.from && (!rw.anchorDate || rw.anchorDate < flt.from)) return false;
				if (flt.to && (!rw.anchorDate || rw.anchorDate > flt.to)) return false;
				if (flt.state === "win" && !(rw.returnSinceAdd > 0)) return false;
				if (flt.state === "loss" && !(rw.returnSinceAdd < 0)) return false;
				if (flt.state === "flat" && rw.returnSinceAdd !== 0) return false;
				if (flt.minScore !== "") {
					var ms = Number(flt.minScore);
					if (Number.isFinite(ms) && (rw.score == null || rw.score < ms)) return false;
				}
				return true;
			}

			function load(force) {
				setView({ status: "loading", data: null, error: null });
				// force=1 绕过 host 端实时报价的 60 秒 TTL（「刷新」按钮用），保证点一下就真的重拉行情
				fetch("/bayes-predict/watchlist?horizon=" + encodeURIComponent(horizon) + (force ? "&force=1" : ""))
					.then(function (res) { return res.json().catch(function () { return null; }).then(function (j) { return { res: res, json: j }; }); })
					.then(function (r) {
						if (!r.json || r.json.ok === false) throw new Error((r.json && r.json.error) || ("HTTP " + r.res.status));
						setView({ status: "done", data: r.json, error: null });
					})
					.catch(function (err) { setView({ status: "error", data: null, error: String((err && err.message) || err) }); });
			}
			React.useEffect(function () { load(); }, []);

			function addByCode() {
				var c = codeInput.trim();
				if (!c) { setMsg("请输入 A 股 6 位代码，例如 600519 / sz000001"); return; }
				setBusy(true);
				setMsg("正在加入 " + c + "…");
				wlMutate("add", c)
					.then(function (r) {
						var it = r.item || {};
						setCodeInput("");
						setMsg((r.created ? "已加入自选：" : "已在自选中（锚点保持不变）：") +
							(it.name || c) + "（" + (it.code || c) + "）｜ 自选日 " + (it.anchorDate || "—") + " ｜ 自选价 " + fmtPrice(it.anchorClose));
						load();
					})
					.catch(function (err) { setMsg("加入失败：" + String((err && err.message) || err)); })
					.then(function () { setBusy(false); });
			}

			function removeOne(row) {
				setBusy(true);
				setMsg("正在移出 " + row.code + "…");
				wlMutate("remove", row.code)
					.then(function () { setMsg(row.code + "（" + (row.name || "") + "）已移出自选"); load(); })
					.catch(function (err) { setMsg("移出失败：" + String((err && err.message) || err)); })
					.then(function () { setBusy(false); });
			}

			function clearAll() {
				var n = view.data ? (view.data.items || []).length : 0;
				if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm("清空全部 " + n + " 只自选股？该操作不可撤销。")) return;
				setBusy(true);
				wlMutate("clear")
					.then(function (r) { setMsg("已清空 " + ((r && r.cleared) ?? 0) + " 只自选股"); load(); })
					.catch(function (err) { setMsg("清空失败：" + String((err && err.message) || err)); })
					.then(function () { setBusy(false); });
			}

			function toggleSort(key, numeric) {
				if (sort.key === key) { setSort({ key: key, dir: -sort.dir }); return; }
				setSort({ key: key, dir: numeric === false ? 1 : -1 });
			}

			// 精简列：只留"看收藏"必需的信息，其余（板块/期间高低/回撤/后验/加入时间/持有天数）
			// 全部收进单元格 title tooltip —— 880px 宽的浮层里 11 列必然要横向滚动，那不是"收藏页"。
			var COLS = [
				{ key: "name", label: "名称", align: "left", text: true },
				{ key: "anchorDate", label: "自选日", align: "left", text: true },
				{ key: "anchorClose", label: "自选价" },
				{ key: "lastClose", label: "最新价" },
				{ key: "returnSinceAdd", label: "自选日至今" },
				{ key: "score", label: "评分" },
				{ key: "act", label: "", sortable: false, align: "center" },
			];

			var result = null;
			if (view.status === "done" && view.data) {
				var d = view.data;
				var items = (d.items || []).filter(matchRow);
				items.sort(function (a, b) {
					var x = a[sort.key], y = b[sort.key];
					if (x == null && y == null) return 0;
					if (x == null) return 1;
					if (y == null) return -1;
					if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "zh") * sort.dir;
					return (x - y) * sort.dir;
				});
				var s = d.summary || {};
				var sm = d.scoreMeta || {};
				// 报告是否带拼音首字母索引（Host 端生成；老进程没有该字段时搜索会落空，需要提示重启）
				var hasInitialsIndex = (d.items || []).some(function (x) { return x.initialsVariants && x.initialsVariants.length; });
				// 本次有多少只真的用上了实时价（其余为缓存价回退）
				var liveUsedCount = (d.items || []).filter(function (x) { return x.live; }).length;
				// 老进程（未重启）的响应里没有 liveMeta 字段 —— 此时整页回落缓存价，明确提示原因
				var hasLiveFields = d.liveMeta !== undefined;
				// 汇总压成一行 muted 文本；明细（最佳/最差/评分基准日/缓存命中/清单路径）进 tooltip
				var detailTitle = [
					"涨跌幅口径：真实价（不复权），实时计算 —— 与券商 App 一致",
					"实时报价 " + (liveUsedCount > 0 ? liveUsedCount + "/" + (d.items || []).length + " 只，行情时间 " + fmtQuoteTime(d.asOf) : "不可用，已回退本地缓存收盘价"),
					"评分基准日 " + (sm.date || "—"),
					"行情数据截至 " + (sm.dataLastDate || "—"),
					s.best ? "最佳 " + s.best.name + " " + fmtSignedPct(s.best.returnSinceAdd, 2) : null,
					s.worst ? "最差 " + s.worst.name + " " + fmtSignedPct(s.worst.returnSinceAdd, 2) : null,
					"评分缓存命中 " + (sm.reused ?? 0) + " / 新算 " + (sm.computed ?? 0),
					"清单文件 " + (d.watchlistPath || "—"),
				].filter(Boolean).join("\n");
				var summaryLine = h("div", { style: Object.assign({}, S.muted, { lineHeight: 1.9 }), title: detailTitle },
					fltActive ? "匹配 " + items.length + " / 共 " + (d.items || []).length + " 只" : ((s.count != null ? s.count : items.length) + " 只"),
					" ｜ 平均 ",
					h("span", { style: { color: retColor(s.avgReturn), fontWeight: 600 } }, s.avgReturn == null ? "—" : fmtSignedPct(s.avgReturn, 2)),
					" ｜ 盈 " + (s.winCount ?? 0) + " · 亏 " + (s.lossCount ?? 0) + " · 平 " + (s.flatCount ?? 0),
					liveUsedCount > 0
						? h("span", { style: { color: "#22c55e" } }, " ｜ 实时 " + liveUsedCount + "/" + items.length + " 只 @" + fmtQuoteTime(d.asOf))
						: h("span", null, " ｜ 缓存价（实时不可用）截至 " + (sm.dataLastDate || "—")));
				result = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
					// 注意用"未筛选总数"判断：筛选到空结果时仍要保留表格与筛选行（否则连"重置"都没了）
					(d.items || []).length
						? h("div", { style: S.card },
							summaryLine,
							!hasLiveFields
								? h("div", { style: S.hint }, "提示：实时行情由 Host 端拉取，需要重启 dsh web 后生效；当前显示的是本地缓存收盘价（后复权口径）。")
								: null,
							sm.error ? h("div", { style: S.hint }, "评分不可用：" + sm.error) : null,
							// 7 列本来就能装下；留 overflowX 只是防止超长名称把卡片撑破（不滚动时无视觉成本）
							h("div", { style: { overflowX: "auto" } },
								h("table", { style: Object.assign({}, S.table, { marginTop: "6px" }) },
								h("thead", null, h("tr", null, COLS.map(function (c) {
									var active = sort.key === c.key;
									return h("th", {
										key: c.key,
										style: Object.assign({}, S.th, {
											textAlign: c.align || "right", whiteSpace: "nowrap",
											cursor: c.sortable === false ? "default" : "pointer", userSelect: "none",
											color: active ? "#7c5cff" : "var(--dsw-alias-label-secondary)",
										}),
										onClick: c.sortable === false ? null : function () { toggleSort(c.key, c.text !== true); },
										title: c.key === "anchorDate" ? "自选日 = 加入自选时锚定的交易日，也是收益起点" : (c.sortable === false ? null : "点击排序"),
									}, c.label + (active ? (sort.dir < 0 ? " ↓" : " ↑") : ""));
								}))),
								// —— 表头筛选行：搜索框跨"名称"列，日期区间在"自选日"列，盈亏与评分各一格 ——
								h("tr", null,
									h("th", { style: Object.assign({}, FILTER_TH, { textAlign: "left" }) },
										h("input", {
											style: FILTER_CTL, value: flt.q, placeholder: "🔍 代码 / 拼音 / 名称",
											title: "模糊搜索：股票代码、中文名称、拼音首字母（多音字已展开，如 ZSYH 或 ZSYX 都能搜到招商银行）",
											onChange: function (e) { setF("q", e.target.value); },
										})),
									h("th", { style: FILTER_TH },
										h("div", { style: { display: "flex", gap: "4px", alignItems: "center" } },
											h("input", {
												style: Object.assign({}, FILTER_CTL, { colorScheme: DATE_SCHEME }), type: "date", value: flt.from,
												title: "自选日 ≥ 该日期", onChange: function (e) { setF("from", e.target.value); },
											}),
											h("span", { style: Object.assign({}, S.muted, { fontSize: "10px" }) }, "~"),
											h("input", {
												style: Object.assign({}, FILTER_CTL, { colorScheme: DATE_SCHEME }), type: "date", value: flt.to,
												title: "自选日 ≤ 该日期", onChange: function (e) { setF("to", e.target.value); },
											}))),
									h("th", { style: FILTER_TH }),
									h("th", { style: FILTER_TH }),
									h("th", { style: FILTER_TH },
										h("select", {
											style: FILTER_CTL, value: flt.state, title: "按自选日至今的盈亏状态筛选",
											onChange: function (e) { setF("state", e.target.value); },
										},
											h("option", { style: OPT, value: "all" }, "全部"),
											h("option", { style: OPT, value: "win" }, "盈利"),
											h("option", { style: OPT, value: "loss" }, "亏损"),
											h("option", { style: OPT, value: "flat" }, "持平"))),
									h("th", { style: FILTER_TH },
										h("input", {
											style: FILTER_CTL, type: "number", min: "0", max: "100", placeholder: "≥", value: flt.minScore,
											title: "评分下限（留空=不限）", onChange: function (e) { setF("minScore", e.target.value); },
										})),
									h("th", { style: FILTER_TH },
										fltActive ? h("button", {
											className: "dsh-sb-star", style: { fontSize: "11px", color: "#7c5cff" },
											title: "清空全部筛选条件", onClick: resetFlt,
										}, "重置") : null)),
								h("tbody", null, items.length ? items.map(function (rw) {
									var cells = {
										// 名称 + 代码一行；板块/市值/上市天数进 tooltip
										name: h("div", {
											title: [rw.name || rw.code, rw.code, rw.market, rw.mktcapYi != null ? "市值 " + rw.mktcapYi + " 亿" : null, rw.listDays != null ? "上市 " + rw.listDays + " 天" : null, rw.warning].filter(Boolean).join(" ｜ "),
										},
											h("span", { style: { fontWeight: 600 } }, rw.name || rw.code),
											h("span", { style: Object.assign({}, S.muted, { marginLeft: "6px", fontFamily: "ui-monospace, Consolas, monospace" }) }, rw.code)),
										anchorDate: h("span", {
											style: { fontFamily: "ui-monospace, Consolas, monospace" },
											title: "自选日 " + (rw.anchorDate || "—") + "\n加入时间 " + fmtDateTime(rw.addedAt) +
												(rw.bars != null ? "\n持有 " + rw.bars + " 个交易日（" + (rw.calendarDays ?? "—") + " 自然日）" : ""),
										}, rw.anchorDate || "—"),
										anchorClose: h("span", {
											title: "自选价（" + (rw.live ? "真实价，不复权" : "本地缓存价（实时不可用）") + "）\n自选日 " + (rw.anchorDate || "—") +
												"\n自选股页用真实价口径，与券商 App 显示一致（不含分红再投资）",
										}, fmtPrice(rw.anchorClose)),
										lastClose: h("span", {
											title: (rw.live
												? "实时现价（真实价）\n行情时间 " + fmtQuoteTime(rw.liveTime) + "\n当日 " + fmtSignedPct(rw.changePct, 2)
												: "本地缓存收盘价（实时行情不可用" + (rw.liveError ? "：" + rw.liveError : "") + "）\n该股数据截至 " + (rw.lastDate || "—")) +
												(rw.stale ? "\n落后于评分基准日 " + (rw.scoreDate || "—") : ""),
										},
											fmtPrice(rw.lastClose),
											rw.live
												? h("span", { style: { marginLeft: "4px", fontSize: "10px", color: "#22c55e", fontWeight: 600 } }, "实时")
												: h("span", { style: Object.assign({}, S.muted, { fontSize: "10px" }) }, " ⚠︎"),
											rw.stale ? h("span", { style: Object.assign({}, S.muted, { fontSize: "10px" }) }, " 旧") : null),
										returnSinceAdd: h("span", {
											style: { color: retColor(rw.returnSinceAdd), fontWeight: 700, fontSize: "14px" },
											title: "期间最高 " + fmtPrice(rw.maxSince) + " ｜ 最低 " + fmtPrice(rw.minSince) +
												" ｜ 最大回撤 " + (rw.maxDrawdownSince == null ? "—" : fmtPct(rw.maxDrawdownSince, 1)) +
												"\n口径：后复权收盘（含分红再投资）",
										}, fmtSignedPct(rw.returnSinceAdd, 2)),
										score: rw.score == null
											? h("span", { style: S.muted, title: "该股数据不足，暂无法评分" }, "—")
											: h("span", {
												style: { color: scoreColor(rw.score), fontWeight: 700 },
												title: "未来 " + (d.horizon || 5) + " 日上涨后验概率 " + fmtPct(rw.posterior, 1) + "（截至 " + (rw.scoreDate || "—") + "）",
											}, String(rw.score)),
										act: h("button", {
											className: "dsh-sb-star", title: "移出自选", style: { fontSize: "12px", color: "#ef4444" },
											onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); removeOne(rw); },
										}, "✕"),
									};
									return h("tr", {
										key: rw.code,
										className: props.onPick ? "dsh-sb-rowlink" : null,
										onClick: props.onPick ? function () { props.onPick(rw.code); } : null,
									}, COLS.map(function (c) {
										return h("td", { key: c.key, style: Object.assign({}, S.td, { textAlign: c.align || "right", whiteSpace: "nowrap" }) }, cells[c.key]);
									}));
								}) : h("tr", null,
									h("td", { colSpan: COLS.length, style: Object.assign({}, S.td, { textAlign: "center", padding: "18px", color: "var(--dsw-alias-label-secondary)" }) },
										"没有匹配的自选股（共 " + (d.items || []).length + " 只）—— 放宽筛选条件，或点「重置」",
										fltActive ? h("button", {
											className: "dsh-sb-star", style: { marginLeft: "8px", fontSize: "11px", color: "#7c5cff" },
											onClick: resetFlt,
										}, "重置") : null,
										// 拼音索引由 Host 端生成：老进程（未重启）的响应里没有该字段，
										// 此时纯字母查询必然落空——明确提示原因，而不是让人以为搜错了
										!hasInitialsIndex && /^[a-z0-9]+$/i.test(flt.q.trim())
											? h("div", { style: Object.assign({}, S.hint, { marginTop: "6px" }) },
												"提示：拼音首字母索引由 Host 端生成，需要重启 dsh web 后生效；当前可按代码或中文名称搜索。")
											: null))),
								)),
							h("div", { style: Object.assign({}, S.hint, { marginTop: "4px" }) },
								"自选日 = 收益起点（加入时该股最近交易日）｜ 真实价口径，实时刷新（不含分红）" + (props.onPick ? " ｜ 点行看单股分析" : "") + " ｜ 鼠标悬停单元格看明细"))
						: h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "26px", borderStyle: "dashed" }) },
							h("div", { style: { fontSize: "22px", marginBottom: "6px" } }, "⭐"),
							h("div", { style: { fontWeight: 600, marginBottom: "4px", color: "var(--dsw-alias-label-primary)" } }, "还没有自选股"),
							h("div", { style: S.muted }, "在「选股筛选」结果里点行首 ☆，或在上方输入代码点「加入」。")));
			} else if (view.status === "loading") {
				result = h("div", { style: Object.assign({}, S.card, { textAlign: "center", padding: "28px" }) },
					h("div", { style: { color: "var(--dsw-alias-label-secondary)" } },
						h("span", { className: "dsh-sb-spinner" }), "正在计算自选股…"));
			} else if (view.status === "error") {
				result = h("div", { style: S.error }, "自选股加载失败：" + view.error);
			}

			// 工具条压成一行：标题 + 代码输入 + 加入 + 评分窗口 + 刷新 + 清空（不再用带标签的表单网格）
			var hasItems = view.status === "done" && (view.data.items || []).length > 0;
			var barBtn = Object.assign({}, CTL, { width: "auto", padding: "5px 12px", fontSize: "13px", cursor: "pointer", color: "var(--dsw-alias-label-primary)" });

			return h("div", { className: "dsh-sb-root", style: S.wrap },
				h("div", { style: S.card },
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
						h("div", { style: Object.assign({}, S.title, { marginBottom: 0, marginRight: "2px" }) }, "⭐ 自选股"),
						h("input", {
							style: Object.assign({}, CTL, { flex: "1 1 140px", maxWidth: "200px" }),
							value: codeInput, placeholder: "输入 A 股代码",
							title: "加入自选：锚定该股最近交易日为自选日（600519 / sz000001 / 300750）",
							onChange: function (e) { setCodeInput(e.target.value); },
							onKeyDown: function (e) { if (e.key === "Enter") addByCode(); },
						}),
						h("button", { style: Object.assign({}, S.button, { padding: "5px 14px", fontSize: "13px" }, busy ? S.buttonDisabled : {}), disabled: busy, onClick: addByCode }, "加入"),
						h("select", {
							style: Object.assign({}, CTL, { width: "auto" }),
							value: horizon, title: "评分窗口（未来 N 日上涨概率）；切换后点刷新",
							onChange: function (e) { setHorizon(e.target.value); },
						},
							h("option", { style: OPT, value: "2" }, "评分 2 日"), h("option", { style: OPT, value: "5" }, "评分 5 日"),
							h("option", { style: OPT, value: "10" }, "评分 10 日"), h("option", { style: OPT, value: "20" }, "评分 20 日")),
						h("button", {
							className: "dsh-sb-ghost", style: barBtn, disabled: view.status === "loading",
							title: "重拉实时行情 + 重算自选日至今涨跌幅与最新评分（绕过实时报价的 60 秒缓存）",
							onClick: function () { load(true); },
						}, view.status === "loading" ? "刷新中…" : "🔄 刷新"),
						hasItems ? h("button", {
							className: "dsh-sb-ghost", style: Object.assign({}, barBtn, { color: "#ef4444" }), disabled: busy,
							title: "清空全部自选股", onClick: clearAll,
						}, "🗑 清空") : null),
					msg ? h("div", { style: Object.assign({}, S.hint, { marginTop: "6px" }) }, msg) : null),
				result);
		}

		// ---------- 侧边栏快捷入口：📊 股票分析（点击弹出居中的固定大小浮层，复用上方四个 Tab） ----------
		function StockSidebarButton() {
			var sO = React.useState(false); var open = sO[0]; var setOpen = sO[1];
			var sT = React.useState("backtest"); var tab = sT[0]; var setTab = sT[1];
			// 选股筛选表格点行 → 跳到「单股分析」：n 自增，保证重复点同一只也会重新分析
			var sJ = React.useState(null); var pick = sJ[0]; var setPick = sJ[1];
			var ref = React.useRef(null);
			function onPick(code) {
				setPick({ symbol: code, n: (pick ? pick.n : 0) + 1 });
				setTab("analyze");
			}
			React.useEffect(function () {
				if (!open) return;
				function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
				document.addEventListener("mousedown", onDoc);
				return function () { document.removeEventListener("mousedown", onDoc); };
			}, [open]);
			function tabBtn(key) {
				var active = tab === key;
				return {
					padding: "7px 14px", borderRadius: "8px 8px 0 0", border: "none", cursor: "pointer", fontSize: "13px",
					fontWeight: active ? 700 : 500, color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
					background: active ? "var(--dsw-alias-bg-layer-2, #f3f4f6)" : "transparent",
					borderBottom: active ? "2px solid #7c5cff" : "2px solid transparent",
				};
			}
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
						h("button", { className: "dsh-sb-close", title: "关闭", "aria-label": "关闭",
							onClick: function () { setOpen(false); } },
							h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", "aria-hidden": "true" },
								h("path", { d: "M6 6 L18 18 M18 6 L6 18" })))),
					h("div", { style: { display: "flex", gap: "2px", padding: "6px 14px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, #f3f4f6)" } },
						h("button", { style: tabBtn("backtest"), onClick: function () { setTab("backtest"); } }, "策略回测"),
						h("button", { style: tabBtn("screen"), onClick: function () { setTab("screen"); } }, "选股筛选"),
						h("button", { style: tabBtn("watchlist"), onClick: function () { setTab("watchlist"); } }, "自选股"),
						h("button", { style: tabBtn("analyze"), onClick: function () { setTab("analyze"); } }, "单股分析")),
					h("div", { style: { padding: "10px 14px 14px" } },
						tab === "backtest" ? h(BacktestTab)
							: tab === "screen" ? h(ScreenTab, { onPick: onPick })
								: tab === "watchlist" ? h(WatchlistTab, { onPick: onPick })
									: h(StockBayesTab, { pick: pick }))) : null);
		}

		// ---------- 插件入口 ----------
		// cordis 依据模块导出的 `inject` 决定注入哪些服务：
		// 缺少该声明时 fiber 不注入任何服务，apply 中访问 ctx.slots 会抛
		// `cannot get property "slots" without inject`。
		var inject = ["slots"];

		function apply(ctx) {
			// 唯一入口：侧边栏底部「📊 股票分析」（弹层内含 策略回测 / 选股筛选 / 自选股 / 单股分析 四个页签）
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
