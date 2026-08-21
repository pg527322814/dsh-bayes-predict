import assert from "node:assert/strict";
import { normalizeSymbol } from "../lib/market.js";

assert.deepEqual(normalizeSymbol("600519"), { symbol: "sh600519", market: "cn" });
assert.deepEqual(normalizeSymbol("000001"), { symbol: "sz000001", market: "cn" });
assert.deepEqual(normalizeSymbol("300750"), { symbol: "sz300750", market: "cn" });
assert.deepEqual(normalizeSymbol("688981"), { symbol: "sh688981", market: "cn" });
assert.deepEqual(normalizeSymbol("430047"), { symbol: "bj430047", market: "cn" });
assert.deepEqual(normalizeSymbol("830799"), { symbol: "bj830799", market: "cn" });
assert.deepEqual(normalizeSymbol(" sh600519 "), { symbol: "sh600519", market: "cn" });
assert.deepEqual(normalizeSymbol("aapl"), { symbol: "AAPL", market: "us" });

console.log("normalize: all passed");
