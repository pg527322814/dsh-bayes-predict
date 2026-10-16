// dsh-bayes-predict / test/pinyin.test.mjs
// 汉字 → 拼音首字母单测（供自选股"代码 / 拼音首字母 / 名称"模糊搜索用）。
// 重点不在"覆盖多少字"，而在钉住三类容易出错的输入：
//   1) 普通名字的首字母正确（贵州茅台 GZMT、中国电信 ZGDX）
//   2) 多音字必须给出**多个变体**（银行类：行 = X 与 H 都要在；重庆 = Z 与 C 都要在）
//   3) 非汉字混排（TCL智家 / *ST利源 / 空串 / 纯数字）不能崩、不能产出垃圾串
import assert from "node:assert/strict";
import { initialOf, nameInitials, nameInitialsVariants } from "../lib/pinyin.js";

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

// ---- 1) 基础映射 ----
eq(initialOf("贵"), "G", "贵 → G");
eq(initialOf("安"), "A", "安 → A");
eq(initialOf("中"), "Z", "中 → Z");
eq(initialOf("A"), "A", "ASCII 字母原样（大写）");
eq(initialOf("7"), "7", "数字原样");
eq(initialOf("、"), null, "标点无首字母");
eq(initialOf(""), null, "空串无首字母");
eq(initialOf(null), null, "null 不崩");

eq(nameInitials("贵州茅台"), "GZMT", "贵州茅台 → GZMT");
eq(nameInitials("中国电信"), "ZGDX", "中国电信 → ZGDX");
eq(nameInitials("宁德时代"), "NDSD", "宁德时代 → NDSD");
eq(nameInitials("比亚迪"), "BYD", "比亚迪 → BYD");
eq(nameInitials("埃科光电"), "AKGD", "埃科光电 → AKGD");

// ---- 2) 多音字：必须同时给出两种读音的变体 ----
const bank = nameInitialsVariants("招商银行");
ok(bank.includes("ZSYX"), "招商银行 应含 ZSYX（xíng 读法）");
ok(bank.includes("ZSYH"), "招商银行 应含 ZSYH（háng 读法，银行）");
const payh = nameInitialsVariants("平安银行");
ok(payh.includes("PAYH"), "平安银行 应含 PAYH");
const cq = nameInitialsVariants("重庆银行");
for (const v of ["ZQYX", "ZQYH", "CQYX", "CQYH"]) ok(cq.includes(v), `重庆银行 应含 ${v}（重 chóng/zhòng × 行 xíng/háng）`);
const xz = nameInitialsVariants("西藏矿业");
ok(xz.includes("XZKY"), "西藏矿业 应含 XZKY（藏 zàng）");
ok(xz.includes("XCKY"), "西藏矿业 应含 XCKY（藏 cáng）");
const dsl = nameInitialsVariants("大参林");
ok(dsl.includes("DSL") && dsl.includes("DCL"), "大参林 应含 DSL 与 DCL（参 shēn/cān）");

// 变体必须去重、且都在上限内
ok(bank.length === new Set(bank).size, "变体应去重");
const many = nameInitialsVariants("重庆银行", 4);
ok(many.length <= 4, `变体应受上限约束（实际 ${many.length}）`);
ok(many.every((v) => v.length === 4), "超限时也只保留主干分支，长度仍等于汉字数");

// ---- 3) 非汉字混排与边界 ----
eq(nameInitials("TCL智家"), "TCLZJ", "TCL智家 → TCLZJ");
eq(nameInitials("*ST利源"), "STLY", "* 与空格应跳过");
eq(nameInitials("1234"), "1234", "纯数字原名保留（可直接按代码搜）");
eq(nameInitialsVariants(""), [], "空名 → 空数组");
eq(nameInitials(""), "", "空名 → 空串");
ok(nameInitialsVariants("贵州茅台").length === 1, "无多音字时只有一个变体");

// ---- 4) 搜索语义：变体串做子串匹配必须能命中 ----
const wl = [["601728", "中国电信"], ["601988", "中国银行"], ["600519", "贵州茅台"], ["601939", "建设银行"]];
const hit = (q) => wl.filter(([code, name]) => {
  const s = q.toLowerCase();
  return code.includes(s) || name.includes(q) || nameInitialsVariants(name).some((v) => v.toLowerCase().includes(s));
}).map(([c]) => c);
eq(hit("6019"), ["601988", "601939"], "按代码前缀模糊搜索");
eq(hit("GZMT"), ["600519"], "按拼音首字母搜贵州茅台");
eq(hit("YH"), ["601988", "601939"], "按 YH（银行）应能搜到两家银行");
eq(hit("ZGYH"), ["601988"], "按 ZGYH 应命中中国银行（多音字变体）");
eq(hit("茅台"), ["600519"], "按中文名称模糊搜索");
eq(hit("zgyh"), ["601988"], "搜索应大小写不敏感");

console.log(`pinyin: all ${checks} checks passed`);
