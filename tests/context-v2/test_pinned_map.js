"use strict";
// Context V2 Shadow：pinned 映射 schema 校验测试（C10 S2-A）——全部用 tmp 文件，不碰生产 data
// 跑法：node tests/context-v2/test_pinned_map.js（exit 0 = 全过）

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validatePinnedMap, loadPinnedMap } = require("../../context-v2-shadow");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxv2map-"));
function codes(v) { return v.errors.map(e => e.code); }

ok("合法映射通过（version/reason 齐全，target 四枚举：1002-14 删 moments_anchor、增 assembly）", () => {
  const v = validatePinnedMap({
    version: 3,
    entries: [
      { pinnedId: "a", target: "identity", reason: "沟通规训" },
      { pinnedId: "b", target: "assembly", reason: "顶层引导" },
      { pinnedId: "c", target: "retire", reason: "琐碎置顶" },
    ],
  });
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
});

ok("version 缺失可过（load 时补默认 1）", () => {
  const v = validatePinnedMap({ entries: [{ pinnedId: "a", target: "identity" }] });
  assert.strictEqual(v.ok, true);
});

ok("BAD_STRUCTURE: 非对象 / entries 非数组", () => {
  assert.deepStrictEqual(codes(validatePinnedMap(null)), ["BAD_STRUCTURE"]);
  assert.deepStrictEqual(codes(validatePinnedMap([1, 2])), ["BAD_STRUCTURE"]);
  assert.deepStrictEqual(codes(validatePinnedMap({})), ["BAD_STRUCTURE"]);
  assert.deepStrictEqual(codes(validatePinnedMap({ entries: "x" })), ["BAD_STRUCTURE"]);
});

ok("BAD_VERSION: version 非正整数", () => {
  assert.ok(codes(validatePinnedMap({ version: 0, entries: [] })).includes("BAD_VERSION"));
  assert.ok(codes(validatePinnedMap({ version: "1", entries: [] })).includes("BAD_VERSION"));
  assert.ok(codes(validatePinnedMap({ version: 1.5, entries: [] })).includes("BAD_VERSION"));
});

ok("BAD_ENTRY: 条目非对象；EMPTY_ID: pinnedId 空或非字符串", () => {
  const v = validatePinnedMap({ entries: [null, "x", { pinnedId: "", target: "identity" }, { pinnedId: 42, target: "identity" }] });
  assert.ok(codes(v).filter(c => c === "BAD_ENTRY").length >= 2, "两个非对象条目");
  assert.ok(codes(v).filter(c => c === "EMPTY_ID").length >= 2, "两个空 id");
});

ok("BAD_TARGET: 枚举外值被拒", () => {
  const v = validatePinnedMap({ entries: [{ pinnedId: "a", target: "Identity" }, { pinnedId: "b", target: "core" }] });
  assert.strictEqual(codes(v).filter(c => c === "BAD_TARGET").length, 2);
});

ok("DUPLICATE_ID: 重复 id", () => {
  const v = validatePinnedMap({ entries: [{ pinnedId: "a", target: "identity" }, { pinnedId: "a", target: "retire" }] });
  assert.strictEqual(codes(v).filter(c => c === "DUPLICATE_ID").length, 1);
});

ok("完整性: MISSING_IDS（漏归类）与 UNKNOWN_IDS（指向不存在条目）", () => {
  const v = validatePinnedMap(
    { entries: [{ pinnedId: "a", target: "identity" }, { pinnedId: "ghost", target: "retire" }] },
    { expectedIds: ["a", "b", "c"] },
  );
  assert.ok(codes(v).includes("MISSING_IDS"));
  assert.deepStrictEqual(v.errors.find(e => e.code === "MISSING_IDS").ids.sort(), ["b", "c"]);
  assert.ok(codes(v).includes("UNKNOWN_IDS"));
  assert.deepStrictEqual(v.errors.find(e => e.code === "UNKNOWN_IDS").ids, ["ghost"]);
});

ok("完整性: 恰好覆盖时无错误", () => {
  const v = validatePinnedMap(
    { entries: [{ pinnedId: "a", target: "identity" }, { pinnedId: "b", target: "retire" }] },
    { expectedIds: ["a", "b"] },
  );
  assert.strictEqual(v.ok, true);
});

ok("多错误全收集（不只第一条）", () => {
  const v = validatePinnedMap({ version: 0, entries: [{ pinnedId: "", target: "x" }, { pinnedId: "a", target: "identity" }] });
  const c = codes(v);
  assert.ok(c.includes("BAD_VERSION") && c.includes("BAD_TARGET") && c.includes("EMPTY_ID"), c.join(","));
});

ok("loadPinnedMap: tmp 合法文件读回+补 version；非法 throw；文件缺失 throw", () => {
  const good = path.join(tmp, "good.json");
  fs.writeFileSync(good, JSON.stringify({ entries: [{ pinnedId: "a", target: "identity" }] }));
  const map = loadPinnedMap(good);
  assert.strictEqual(map.version, 1, "缺省补 1");

  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ entries: [{ pinnedId: "a", target: "identity" }, { pinnedId: "a", target: "identity" }] }));
  assert.throws(() => loadPinnedMap(bad), /DUPLICATE_ID/, "重复 id throw 且带 code");

  assert.throws(() => loadPinnedMap(path.join(tmp, "nope.json")));
});

ok("loadPinnedMap: 坏 JSON throw", () => {
  const f = path.join(tmp, "broken.json");
  fs.writeFileSync(f, "{ not json");
  assert.throws(() => loadPinnedMap(f));
});

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
