// dsh-bayes-predict / lib/pinyin.js
// 汉字 → 拼音首字母（用于自选股/选股的"拼音首字母"模糊搜索）。
//
// 为什么不用拼音库：本插件坚持零外部依赖。这里用经典的「GB2312 码段法」：
//   GB2312 的汉字按拼音排序，因此一个字的 GB 码落在哪个码段，就决定了它的首字母。
//   char → GB 码 的映射用 Node 内置 TextDecoder("gb2312")（Node 自带 full-icu）在首次使用时
//   现算一次（把 B0A1..F7FE 全部双字节解码一遍，约 6763 个汉字，实测 ~90ms），
//   之后缓存在内存里。若运行环境不支持 gb2312 解码，则降级为空首字母（搜索仍可按代码/名称）。
//
// 多音字：GB2312 一个字只有一个码位，因此「行」固定落在 X（xíng），而股票名里的「银行」读 háng。
//   实测受影响最大的三类：行（银行 → 应为 H）、重（重庆 → 应为 C）、藏（西藏 → 应为 Z）。
//   这里不去猜哪个读音对，而是**生成多个首字母变体**（variants），搜索时任一命中即可：
//     nameInitialsVariants("招商银行") → ["ZSYX", "ZSYH"]  → 搜 ZSYX / ZSYH / YX / YH 都能找到。
//   变体数量按名字里的多音字个数指数增长，故设上限（默认 8）并在超限时只保留主干分支。
//
// 仅供搜索辅助：个别生僻读音可能仍不覆盖，用户可随时改用代码或全名搜索。

// GB2312 汉字区首字母码段边界（码段起点 → 首字母）。I/U/V 不作为拼音首字母。
const BOUNDARIES = [
  ["A", 0xB0A1], ["B", 0xB0C5], ["C", 0xB2C1], ["D", 0xB4EE], ["E", 0xB6EA], ["F", 0xB7A2],
  ["G", 0xB8C1], ["H", 0xB9FE], ["J", 0xBBF7], ["K", 0xBFA6], ["L", 0xC0AC], ["M", 0xC2E8],
  ["N", 0xC4C3], ["O", 0xC5B6], ["P", 0xC5BE], ["Q", 0xC6DA], ["R", 0xC8BB], ["S", 0xC8F6],
  ["T", 0xCBFA], ["W", 0xCDDA], ["X", 0xCEF4], ["Y", 0xD1B9], ["Z", 0xD4D1],
];

// 多音字：字 → 除 GB2312 默认读音外的常见读音首字母（股票名里确实会遇到的）。
// 只列"两种读音都真实出现在 A 股名称里"的字，避免变体无谓膨胀。
const POLYPHONE = {
  行: "H", // 银行 háng（默认 X=xíng）
  重: "C", // 重庆 chóng（默认 Z=zhòng）
  藏: "Z", // 西藏 zàng（默认 C=cáng）
  长: "Z", // 长 zhǎng（默认 C=cháng，名称里多为 cháng）
  参: "S", // 人参 shēn（默认 C=cān）
  会: "K", // 会计 kuài（默认 H=huì）
  厦: "S", // 大厦 shà（默认 X=xià，名称里多为 xià）
  乐: "Y", // 音乐 yuè（默认 L=lè）
  率: "S", // 率领 shuài（默认 L=lǜ）
  便: "P", // 便宜 pián（默认 B=biàn）
  曾: "C", // 曾经 céng（默认 Z=zēng）
  系: "J", // 系鞋带 jì（默认 X=xì）
};

let charToGb = null;      // char -> GB 码（惰性构建）
let decoderBroken = false;

/** 惰性构建 char → GB2312 码映射（一次性 ~90ms）。环境不支持时返回 null 并记住。 */
function gbTable() {
  if (charToGb !== null || decoderBroken) return charToGb;
  try {
    const dec = new TextDecoder("gb2312");
    const map = new Map();
    const buf = new Uint8Array(2);
    for (let hi = 0xb0; hi <= 0xf7; hi++) {
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        buf[0] = hi;
        buf[1] = lo;
        const s = dec.decode(buf);
        // 只收单字汉字（双字节区里混着符号与未定义位，解码结果不是单个汉字就跳过）
        if (s.length === 1 && s >= "\u4e00" && s <= "\u9fff") map.set(s, hi * 256 + lo);
      }
    }
    charToGb = map.size > 3000 ? map : null;
  } catch {
    decoderBroken = true;
    charToGb = null;
  }
  if (charToGb === null) decoderBroken = true;
  return charToGb;
}

/** 单个字符的拼音首字母：汉字返回 A-Z；ASCII 字母/数字原样返回（大写）；其他返回 null。 */
export function initialOf(ch) {
  if (typeof ch !== "string" || ch.length === 0) return null;
  if (/[a-zA-Z0-9]/.test(ch)) return ch.toUpperCase();   // "TCL智家" 里的 TCL 直接可用
  const t = gbTable();
  if (!t) return null;
  const gb = t.get(ch);
  if (gb === undefined) return null;
  let out = null;
  for (const [letter, from] of BOUNDARIES) {
    if (gb >= from) out = letter;
    else break;
  }
  return out;
}

/** 主首字母串（不展开多音字，展示/调试用）："招商银行" → "ZSYX"。 */
export function nameInitials(name) {
  let out = "";
  for (const ch of String(name || "")) {
    const i = initialOf(ch);
    if (i) out += i;
  }
  return out;
}

/**
 * 首字母变体（搜索用）：把多音字的两种读音都展开成候选串。
 * "招商银行" → ["ZSYX", "ZSYH"]；无多音字时只有一个元素。
 * @param {string} name 股票名称
 * @param {number} maxVariants 变体上限（防指数膨胀，默认 8）
 */
export function nameInitialsVariants(name, maxVariants = 8) {
  let variants = [""];
  for (const ch of String(name || "")) {
    const base = initialOf(ch);
    if (base === null) continue;
    const alt = POLYPHONE[ch];
    const opts = alt && alt !== base ? [base, alt] : [base];
    if (variants.length * opts.length <= maxVariants) {
      const next = [];
      for (const v of variants) for (const o of opts) next.push(v + o);
      variants = next;
    } else {
      // 超限：只保留主干（默认读音）分支，宁可少匹配也不让候选串爆炸
      variants = variants.map((v) => v + base);
    }
  }
  return [...new Set(variants.filter((v) => v.length > 0))];
}
