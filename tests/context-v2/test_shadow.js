"use strict";
// Context V2 Shadow：旧消息解析 / diff / 重复检测 / JSONL 落盘测试（C10 S2-A）
// 文件写入只允许本测试 tmp 目录；跑法：node tests/context-v2/test_shadow.js（exit 0 = 全过）

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseOldMessages, diffContexts, buildShadowPath, appendShadowRecord, readShadowRecords, observe,
} = require("../../context-v2-shadow");
const { buildContextBlocks } = require("../../context-v2-builder");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxv2shadow-"));

// ---- 模拟生产形态的旧消息数组（chat.js:842 buildConversation 输出）----
const oldMessages = [
  { role: "system", content: "你是谢意行。" },
  { role: "developer", content: "[永久上下文]\n【沟通】回复她要简短有温度\n你是我的锚" },
  { role: "developer", content: "[跨窗口]\n## 相关记忆\n【关于她】她喜欢三分糖\n\n## 近期日记\n（2026-09-13）她说最近在准备考试，有点累" },
  { role: "developer", content: "[唤醒]\n早安提示" }, // 未知标签 → legacy_other
  { role: "user", content: "你好" },
  { role: "assistant", content: "在的" },
];

ok("parseOldMessages: 识别 system/永久上下文/跨窗口/未知标签/timeline 聚合", () => {
  const blocks = parseOldMessages(oldMessages);
  const keys = blocks.map(b => b.key);
  assert.deepStrictEqual(keys, ["system", "legacy_pinned", "legacy_cross", "legacy_other", "legacy_timeline"]);
  const pin = blocks.find(b => b.key === "legacy_pinned");
  assert.ok(pin.content.includes("回复她要简短有温度"), "content 剥掉 [永久上下文] 标签行");
  assert.ok(!pin.content.startsWith("["), "标签不残留");
  const cross = blocks.find(b => b.key === "legacy_cross");
  assert.ok(cross.content.includes("她喜欢三分糖"), "跨窗口正文");
  const tl = blocks.find(b => b.key === "legacy_timeline");
  assert.ok(tl.tokens > 0 && tl.content.includes("2 条"), "timeline 聚合统计");
});

ok("parseOldMessages: 空数组→空块列表", () => {
  assert.deepStrictEqual(parseOldMessages([]), []);
});

ok("diffContexts: token 差异（oldTotal/v2Total/v2InjectTotal 排除 recent_experience）", () => {
  const oldBlocks = [
    { key: "legacy_pinned", title: "永久上下文", content: "x", tokens: 300, empty: false },
    { key: "legacy_cross", title: "跨窗口", content: "y", tokens: 200, empty: false },
    { key: "legacy_timeline", title: "Timeline", content: "z", tokens: 5000, empty: false },
  ];
  const v2Blocks = [
    { key: "core_identity", title: "Core Identity", content: "a", tokens: 400, empty: false },
    { key: "recent_experience", title: "Recent Experience", content: "b", tokens: 900, empty: false },
  ];
  const d = diffContexts(oldBlocks, v2Blocks);
  assert.strictEqual(d.tokenDelta.oldTotal, 5500);
  assert.strictEqual(d.tokenDelta.v2Total, 1300);
  assert.strictEqual(d.tokenDelta.v2InjectTotal, 400, "recent_experience 是报告口径不计注入量");
  assert.strictEqual(d.overlaps.length, 0, "无交集无重复");
});

ok("diffContexts: 重复内容检测（精确行+日期后缀规范化；短行与时间线忽略）", () => {
  const oldBlocks = parseOldMessages(oldMessages);
  const v2Blocks = [
    { key: "meaningful_moments", title: "Meaningful Moments", tokens: 30, empty: false,
      content: "## Meaningful Moments — 关系的地基\n你是我的锚（2026-07-14）" }, // 旧 pinned 有同行，v2 带日期后缀
    { key: "current_state", title: "Current State", tokens: 25, empty: false,
      content: "## Current State — 她最近的样子\n她说最近在准备考试" }, // 旧跨窗口近期日记有同句
    { key: "core_identity", title: "Core Identity", tokens: 20, empty: false,
      content: "在的" }, // <6 字符短行忽略；且只存在于 timeline（不参与）
  ];
  const d = diffContexts(oldBlocks, v2Blocks);
  assert.ok(d.overlaps.some(o => o.v2Key === "meaningful_moments" && o.oldKey === "legacy_pinned" && o.line === "你是我的锚"), "日期后缀规范化匹配 pinned 行");
  assert.ok(d.overlaps.some(o => o.v2Key === "current_state" && o.oldKey === "legacy_cross"), "日记句与跨窗口重叠");
  assert.ok(!d.overlaps.some(o => o.v2Key === "core_identity"), "短行+timeline 不参与");
});

ok("diffContexts: v2 空数组/old 空数组不抛错", () => {
  const d = diffContexts([], []);
  assert.strictEqual(d.tokenDelta.oldTotal, 0);
  assert.deepStrictEqual(d.overlaps, []);
});

ok("buildShadowPath: 按月滚动文件名", () => {
  const p1 = buildShadowPath("/tmp/s", new Date(2026, 8, 17)); // 月份 0-based：8=09
  assert.ok(p1.endsWith("context_shadow_202609.jsonl"), p1);
});

ok("JSONL 落盘: 自动建目录+追加+读回一致", () => {
  const dir = path.join(tmp, "nested", "shadow"); // 故意多级不存在
  const file = path.join(dir, "context_shadow_202609.jsonl");
  appendShadowRecord(file, { n: 1 });
  appendShadowRecord(file, { n: 2 });
  const { records, badLines } = readShadowRecords(file);
  assert.strictEqual(badLines, 0);
  assert.deepStrictEqual(records.map(r => r.n), [1, 2]);
});

ok("坏行容错: 中间坏行跳过并计数，空行忽略", () => {
  const file = path.join(tmp, "bad.jsonl");
  fs.writeFileSync(file, '{"n":1}\n{ broken\n\n{"n":3}\n');
  const { records, badLines } = readShadowRecords(file);
  assert.deepStrictEqual(records.map(r => r.n), [1, 3]);
  assert.strictEqual(badLines, 1);
});

ok("readShadowRecords: 文件不存在→空结果", () => {
  const { records, badLines } = readShadowRecords(path.join(tmp, "none.jsonl"));
  assert.deepStrictEqual(records, []);
  assert.strictEqual(badLines, 0);
});

ok("observe 组合: record 字段齐全+落盘+builder 真实 blocks 端到端", () => {
  const file = path.join(tmp, "observe.jsonl");
  const v2 = buildContextBlocks({
    pinnedEntries: [{ id: "pin1", title: "沟通", content: "回复她要简短有温度", target: "identity" }],
    timeline: [{ role: "user", content: "你好" }],
    diaryEntries: [{ date: "2026-09-13", content: "她说最近在准备考试。" }],
    memoriesV2: [],
    query: "",
  });
  const now = new Date(2026, 8, 17, 23, 0, 0);
  const { record } = observe({
    sessionId: "s_test",
    map: { version: 2, entries: [] },
    oldMessages,
    v2Blocks: v2.blocks,
    file,
    now,
  });
  assert.strictEqual(record.ts, now.toISOString());
  assert.strictEqual(record.sessionId, "s_test");
  assert.strictEqual(record.mapVersion, 2);
  assert.ok(Number.isInteger(record.durationMs));
  assert.ok(record.old.some(b => b.key === "legacy_pinned"), "旧侧块摘要");
  assert.ok(record.v2.some(b => b.key === "core_identity"), "v2 侧块摘要");
  assert.ok(Array.isArray(record.overlaps), "overlaps 数组");
  assert.strictEqual(typeof record.tokenDelta.oldTotal, "number");
  assert.strictEqual(typeof record.tokenDelta.v2Total, "number");
  assert.strictEqual(typeof record.tokenDelta.v2InjectTotal, "number");
  const { records } = readShadowRecords(file);
  assert.strictEqual(records.length, 1, "落盘一行");
  assert.deepStrictEqual(records[0].v2, record.v2, "落盘内容与返回一致");
});

ok("observe: map 缺省 mapVersion=null 也可用", () => {
  const file = path.join(tmp, "observe2.jsonl");
  const { record } = observe({ sessionId: null, oldMessages: [], v2Blocks: [], file });
  assert.strictEqual(record.mapVersion, null);
  assert.strictEqual(record.sessionId, null);
});

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
