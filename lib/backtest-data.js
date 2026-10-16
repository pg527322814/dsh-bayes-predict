// dsh-bayes-predict / lib/backtest-data.js
// 统一缓存数据提供层：缓存根目录 = env DSH_STOCK_CACHE_DIR 或 %USERPROFILE%\.dsh\stock-bayes。
// 结构：
//   universe.json           多档股票池 { pools: { all, sh300, custom } }
//   data/<code>.json        每只股票东财后复权全历史K线
//   csi300.json             沪深300指数日K（择时用）
//   scores/h<horizon>.json  预评分缓存 { horizon, rebalanceDates, rows: {code:{date:{s,r,p,c}}} }
//   meta.json               各文件生成时间
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { fetchKlines } from "./market.js";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

export function cacheRoot() {
  return process.env.DSH_STOCK_CACHE_DIR || join(os.homedir(), ".dsh", "stock-bayes");
}
export function scoresPath(h) { return join(cacheRoot(), "scores", `h${h}.json`); }

// ================= 评分缓存列式紧凑编码 =================
// 行式：rows[code][date] = {s, p}（日期键/属性名/花括号每处重复，大池文件膨胀）
// 列式：rows[code] = { s: number[], p: number[] }，第 i 个元素对应 rebalanceDates[i]；
//       s 为 0-100 整数，p 定点化为 0-65535 整数（精度 ~7.6e-6），缺失日期用 -1 哨兵。
// 实测（2000 只 × 140 日）：体积 12.1MB→2.4MB（5.1×），stringify 8×，parse 16×。
const P_SCALE = 65535;

/** 嵌套行 → 列式（写入磁盘前调用）。 */
export function encodeColumnar(payload) {
  const dates = payload.rebalanceDates;
  const idx = new Map();
  for (let i = 0; i < dates.length; i++) idx.set(dates[i], i);
  const rows = {};
  for (const [code, row] of Object.entries(payload.rows)) {
    const sArr = new Array(dates.length).fill(-1);
    const pArr = new Array(dates.length).fill(-1);
    for (const [d, v] of Object.entries(row)) {
      const i = idx.get(d);
      if (i == null) continue; // 行内日期应 ⊆ rebalanceDates 并集，防御性跳过
      sArr[i] = v.s;
      pArr[i] = Math.round(v.p * P_SCALE);
    }
    rows[code] = { s: sArr, p: pArr };
  }
  return { ...payload, cols: true, rows };
}

/** 列式 → 嵌套行（读入后还原给引擎用）。 */
export function decodeColumnar(raw) {
  const dates = raw.rebalanceDates;
  const rows = {};
  for (const [code, col] of Object.entries(raw.rows)) {
    const row = {};
    const sArr = col.s || [];
    const pArr = col.p || [];
    for (let i = 0; i < dates.length; i++) {
      const s = sArr[i];
      if (s != null && s >= 0) {
        row[dates[i]] = { s, p: pArr[i] != null && pArr[i] >= 0 ? pArr[i] / P_SCALE : 0 };
      }
    }
    rows[code] = row;
  }
  return { ...raw, rows };
}

/** 按代码前缀返回带市场前缀的代码：60/68→sh，00/30→sz，4/8/92→bj。 */
export function prefixed(code) {
  if (/^6/.test(code)) return `sh${code}`;
  if (/^(0|3)/.test(code)) return `sz${code}`;
  return `bj${code}`;
}

/** 多档股票池：读取 universe.json 的 pools；缺失时回退到内置沪深300成分。 */
export async function loadUniversePools() {
  const p = join(cacheRoot(), "universe.json");
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && j.pools && j.pools.all && Array.isArray(j.pools.all.codes)) return j.pools;
    } catch { /* ignore */ }
  }
  // 回退：内置沪深300成分
  const comps = await loadCsi300Components();
  const sh300 = (comps || []).filter((s) => /^sh60[0135]\d{3}$/.test(s)).map((s) => s.slice(2));
  return { all: { label: "沪深300成分(沪市主板)", codes: sh300 }, sh300: { label: "沪深300成分(沪市主板)", codes: sh300 }, custom: { label: "自选", codes: [] } };
}

/** 沪深300成分（内置静态文件优先，其次新浪拉取）。 */
async function loadCsi300Components() {
  const builtin = join(PLUGIN_DIR, "csi300-components.json");
  try {
    if (existsSync(builtin)) {
      const arr = JSON.parse(readFileSync(builtin, "utf8"));
      if (Array.isArray(arr) && arr.length >= 100) return arr.map((c) => String(c.symbol || c.code || c));
    }
  } catch { /* ignore */ }
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    const all = [];
    for (let pg = 1; pg <= 6; pg++) {
      const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${pg}&num=300&sort=symbol&asc=1&node=hs300&symbol=&_s_r_a=page`;
      const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" } });
      const t = await r.text();
      if (!t || !t.startsWith("[")) break;
      const arr = JSON.parse(t);
      if (!arr.length) break;
      for (const x of arr) all.push(String(x.symbol));
    }
    if (all.length >= 100) return all;
  } catch { /* ignore */ }
  return null;
}

/**
 * 组装 provider。
 * @param {object} opts { pool: 'all'|'sh300'|'custom', customCodes: string[] }
 * @returns {{getKlines, universe, getIndexKlines, getScores, saveScores}}
 */
export async function buildProvider(opts = {}) {
  const pools = await loadUniversePools();
  const poolKey = opts.pool || "all";
  let universe;
  if (poolKey === "custom" && Array.isArray(opts.customCodes) && opts.customCodes.length) {
    universe = opts.customCodes;
  } else {
    const pool = pools[poolKey] || pools.all;
    universe = (pool && pool.codes) || [];
  }
  if (!universe.length) throw new Error("股票池为空（pool=" + poolKey + "）");

  // 标签（ST/板块/市值/名称）：读 universe.json 的 tags；
  // snapshotDate = 快照生成日（市值/ST/成分标记的时点），历史市值推算以此为基准价锚点
  let tags = {};
  let snapshotDate = null;
  try {
    const u = JSON.parse(readFileSync(join(cacheRoot(), "universe.json"), "utf8"));
    if (u && u.tags) tags = u.tags;
    if (u && typeof u.generatedAt === "string") snapshotDate = u.generatedAt.slice(0, 10);
  } catch { tags = {}; }
  const getTags = (code) => tags[code] || {};

  // K线读取：优先缓存目录 data/，缺失则现场拉取并落盘
  const dataDir = join(cacheRoot(), "data");
  const kc = new Map();
  // 数据指纹：data/ 目录内最新文件的 mtime（毫秒）。评分缓存据此判断底层数据是否
  // 被追加/重写（刷新行情、换复权口径），指纹变化 → 评分缓存失效重算。
  // 现场拉取落盘的新文件同样更新指纹，避免"冷拉取后必重算一次"的抖动。
  let dataStamp = null;
  try {
    let max = 0;
    for (const n of readdirSync(dataDir)) {
      if (!n.endsWith(".json")) continue;
      const st = statSync(join(dataDir, n));
      if (st.mtimeMs > max) max = st.mtimeMs;
    }
    if (max > 0) dataStamp = Math.round(max);
  } catch { dataStamp = null; }
  const getKlines = async (code) => {
    if (!kc.has(code)) {
      const p = join(dataDir, `${code}.json`);
      if (existsSync(p)) {
        try { kc.set(code, JSON.parse(readFileSync(p, "utf8")).klines); } catch { kc.set(code, null); }
      } else {
        try {
          const kl = await fetchKlines(prefixed(code), 700, "hfq"); // 腾讯后复权
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(p, JSON.stringify({ code, klines: kl, source: "tencent-hfq" }));
          kc.set(code, kl);
          // 指纹用文件自身的 mtime（statSync），与后续扫描读到的值严格一致——
          // 若用 Date.now() 可能差 1ms，导致下一次请求误判"数据已变"而重复重算。
          const st = statSync(p).mtimeMs;
          if (dataStamp == null || st > dataStamp) dataStamp = Math.round(st);
        } catch { kc.set(code, null); }
      }
    }
    return kc.get(code);
  };

  // 逐股数据指纹：data/<code>.json 的 mtime（惰性 stat，memo 缓存）。
  // 评分缓存据此逐股判定"数据未变/追加/整体替换"（见 backtest.js rowInfoValid）。
  const stampCache = new Map();
  const getStamp = (code) => {
    if (stampCache.has(code)) return stampCache.get(code);
    let v = null;
    try {
      const p = join(dataDir, `${code}.json`);
      if (existsSync(p)) v = Math.round(statSync(p).mtimeMs);
    } catch { v = null; }
    stampCache.set(code, v);
    return v;
  };

  // 指数（择时）
  let getIndexKlines = null;
  const idxP = join(cacheRoot(), "csi300.json");
  if (existsSync(idxP)) {
    try { getIndexKlines = () => JSON.parse(readFileSync(idxP, "utf8")); } catch { getIndexKlines = null; }
  }
  if (!getIndexKlines) {
    try {
      const ik = await fetchKlines("sh000300", 700, "hfq");
      mkdirSync(cacheRoot(), { recursive: true });
      writeFileSync(idxP, JSON.stringify(ik));
      getIndexKlines = () => ik;
    } catch { getIndexKlines = null; }
  }

  // 评分缓存读写
  const getScores = (h) => {
    const p = scoresPath(h);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      // 列式（cols:true）解码回嵌套行给引擎用；旧格式（行式）直接使用（下次保存自动迁移为列式）
      return raw && raw.cols === true ? decodeColumnar(raw) : raw;
    } catch { return null; }
  };
  const saveScores = (h, payload) => {
    mkdirSync(join(cacheRoot(), "scores"), { recursive: true });
    const p = scoresPath(h);
    const tmp = p + ".tmp";
    // 原子写：先写临时文件再 rename 覆盖——进程崩溃时正式文件要么是旧版要么是新版，
    // 绝不出现截断损坏（截断会让下次请求全量重算，大池代价几分钟）。
    writeFileSync(tmp, JSON.stringify(encodeColumnar(payload)));
    renameSync(tmp, p);
  };

  return { getKlines, universe, getIndexKlines, getScores, saveScores, getTags, cacheRoot: cacheRoot(), getDataStamp: () => dataStamp, getStamp, snapshotDate };
}

/** 腾讯后复权拉取：fetchKlines 内部自动切换主/备用域名，均失败则放弃。code 为 6 位代码。 */
async function fetchHfq(code, count = 700) {
  return fetchKlines(prefixed(code), count, "hfq");
}

/**
 * 手动刷新：增量拉取并追加（腾讯后复权）——
 * 读每只股票缓存最后日期，腾讯 hfq 拉最近 ~700 根窗口，去重（date > lastDate）后追加写回；
 * 无缓存则全量初始化 ~700 根。指数同样增量追加。
 * @param {string} poolKey 股票池 key
 * @returns {{pool, total, ok, updated, noChange, fail, indexUpdated, cacheRoot}}
 */
export async function refreshCache(poolKey = "all", opts = {}) {
  const pools = await loadUniversePools();
  const pool = pools[poolKey] || pools.all;
  const codes = pool.codes || [];
  const dataDir = join(cacheRoot(), "data");
  mkdirSync(dataDir, { recursive: true });
  let ok = 0, updated = 0, noChange = 0, fail = 0;
  const CONC = 8;
  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      const p = join(dataDir, `${code}.json`);
      let hasCache = false;
      let lastDate = null;
      try {
        if (existsSync(p)) {
          const old = JSON.parse(readFileSync(p, "utf8"));
          const arr = Array.isArray(old.klines) ? old.klines : [];
          if (arr.length) { hasCache = true; lastDate = arr[arr.length - 1].date; }
        }
        ok++;
        const kl = await fetchHfq(code, 700); // fetchHfq 内部已剔除复权断层日（见 market.js）
        if (hasCache) {
          // 若新序列最后日期比缓存还短（复权断层被剔除 / 源数据回退）→ 全量替换，
          // 修复缓存末尾的断层脏数据（如 2026-08-21 腾讯 hfq 基准切换导致的假跳变）
          const freshLast = kl.length ? kl[kl.length - 1].date : null;
          if (freshLast == null || freshLast < lastDate) {
            writeFileSync(p, JSON.stringify({ code, klines: kl, source: "tencent-hfq" }));
            updated++;
            continue;
          }
          const fresh = kl.filter((r) => r.date > lastDate);
          if (!fresh.length) { noChange++; continue; }
          const old = JSON.parse(readFileSync(p, "utf8")).klines || [];
          writeFileSync(p, JSON.stringify({ code, klines: old.concat(fresh), source: "tencent-hfq" }));
          updated++;
        } else {
          writeFileSync(p, JSON.stringify({ code, klines: kl, source: "tencent-hfq" }));
          updated++;
        }
      } catch { fail++; }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // 指数增量追加（腾讯 hfq；指数无分红复权差异）
  let idxUpdated = false;
  const idxP = join(cacheRoot(), "csi300.json");
  try {
    if (existsSync(idxP)) {
      const old = JSON.parse(readFileSync(idxP, "utf8"));
      const arr = Array.isArray(old) ? old : (Array.isArray(old.klines) ? old.klines : []);
      const lastDate = arr.length ? arr[arr.length - 1].date : null;
      if (lastDate) {
        const ik = await fetchKlines("sh000300", 700, "hfq"); // 指数固定 sh 前缀
        const fresh = ik.filter((r) => r.date > lastDate);
        if (fresh.length) {
          writeFileSync(idxP, JSON.stringify(arr.concat(fresh)));
          idxUpdated = true;
        }
      }
    }
  } catch { /* 指数刷新失败不影响个股结果 */ }

  return { pool: poolKey, total: codes.length, ok, updated, noChange, fail, indexUpdated: idxUpdated, cacheRoot: cacheRoot() };
}
