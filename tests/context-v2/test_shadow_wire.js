"use strict";
// Context V2 Shadow 接线测试（C10 S2-B1）——maybeObserve 行为四验证 + chat.js 静态接线检查
// 文件写入只允许本测试 tmp 目录；跑法：node tests/context-v2/test_shadow_wire.js（exit 0 = 全过）

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { maybeObserve, maskSessionId, buildShadowPath } = require("../../context-v2-shadow");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctxv2wire-"));

const fakeV2Input = {
  pinnedEntries: [{ id: "p1", title: "沟通", content: "回复她要简短有温度", target: "identity" }],
  timeline: [{ role: "user", content: "你好" }, { role: "assistant", content: "在的" }],
  diaryEntries: [{ date: "2026-09-13", content: "她说最近在准备考试。" }],
  memoriesV2: [],
  query: "你好",
  map: { version: 7, entries: [] }, // chat 侧组装挂在 v2Input 上，供 mapVersion 溯源
};
const fakeOldMessages = [
  { role: "system", content: "你是谢意行。" },
  { role: "developer", content: "[永久上下文]\n【沟通】回复她要简短有温度" },
  { role: "user", content: "你好" },
];

ok("flag off：skipped 直返，不读数据不落盘（文件未被创建）", () => {
  const file = path.join(tmp, "off.jsonl");
  const r = maybeObserve({ flag: false, sessionId: "s1", oldMessages: fakeOldMessages, v2Input: fakeV2Input, file });
  assert.deepStrictEqual(r, { skipped: true });
  assert.ok(!fs.existsSync(file), "flag off 零落盘");
});

ok("flag on：调用 shadow，record 落盘，sessionId 已脱敏", () => {
  const file = path.join(tmp, "on.jsonl");
  const r = maybeObserve({ flag: true, sessionId: "真实会话id-abc123", oldMessages: fakeOldMessages, v2Input: fakeV2Input, file });
  assert.ok(r.record, "返回 record");
  assert.ok(!fs.existsSync(path.join(tmp, "真实会话id-abc123")), "原文 id 不落任何文件名");
  assert.ok(/^s_[0-9a-f]{8}$/.test(r.record.sessionId), "sessionId 脱敏为 s_+8位hex: " + r.record.sessionId);
  assert.ok(!JSON.stringify(r.record).includes("真实会话id"), "记录全文不含原文 id");
  assert.strictEqual(r.record.old.length, 3, "旧侧块解析（system+pinned+timeline）");
  assert.ok(r.record.v2.some(b => b.key === "core_identity"), "v2 侧 Identity 块");
  assert.strictEqual(typeof r.record.tokenDelta.v2InjectTotal, "number");
  assert.strictEqual(r.record.mapVersion, 7, "v2Input.map 透传为 mapVersion");
});

ok("shadow 异常：吞掉返回 error，不向主链抛出", () => {
  const dirAsFile = path.join(tmp, "adir"); // 目录当文件→append 必然失败
  fs.mkdirSync(dirAsFile);
  const r = maybeObserve({ flag: true, sessionId: "s2", oldMessages: fakeOldMessages, v2Input: fakeV2Input, file: dirAsFile });
  assert.ok(r.error, "返回 error: " + (r.error || ""));
  assert.strictEqual(r.record, undefined);
});

ok("messages 完全一致：maybeObserve 前后 oldMessages 深度不变", () => {
  const input = JSON.parse(JSON.stringify(fakeOldMessages));
  const before = JSON.stringify(input);
  maybeObserve({ flag: true, sessionId: "s3", oldMessages: input, v2Input: fakeV2Input, file: path.join(tmp, "ro.jsonl") });
  assert.strictEqual(JSON.stringify(input), before, "llmMessages 未被 shadow 触碰");
  // v2Input 同样只读
  const v2 = JSON.parse(JSON.stringify(fakeV2Input));
  const beforeV2 = JSON.stringify(v2);
  maybeObserve({ flag: true, sessionId: "s3", oldMessages: fakeOldMessages, v2Input: v2, file: path.join(tmp, "ro2.jsonl") });
  assert.strictEqual(JSON.stringify(v2), beforeV2, "v2Input 未被修改");
});

ok("maskSessionId: 空值给占位、稳定可复现", () => {
  assert.strictEqual(maskSessionId(""), "s_none");
  assert.strictEqual(maskSessionId(null), "s_none");
  assert.strictEqual(maskSessionId("abc"), maskSessionId("abc"));
  assert.notStrictEqual(maskSessionId("abc"), maskSessionId("abd"));
});

ok("chat.js 静态接线检查：调用在位、开关判断在位、原构建行未被改动", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../routes/chat.js"), "utf8");
  assert.ok(src.includes("llmMessages = buildConversation(sessionId);"), "原构建调用原样保留");
  assert.ok(src.includes("ctxV2Shadow.maybeObserve("), "shadow 调用已接线");
  assert.ok(src.includes("shadowCfg.ctx_v2_shadow === true"), "ctx_v2_shadow 开关判断（严格 === true）");
  assert.ok(src.includes("buildCtxV2ShadowInput(sessionId, llmMessages)"), "v2 输入组装在位");
  assert.ok(src.includes("buildConversation(sessionId);\n"), "构建行后紧跟 shadow（发送前执行）");
  // 顺序：shadow 调用必须位于 buildConversation 之后、applyReplacements 之前（只观察组装结果）
  const iBuild = src.indexOf("llmMessages = buildConversation(sessionId);");
  const iShadow = src.indexOf("ctxV2Shadow.maybeObserve(");
  const iApply = src.indexOf("contextReplacements.applyReplacements(llmMessages)");
  assert.ok(iBuild > 0 && iShadow > iBuild && iApply > iShadow, "组装→shadow→替换 的顺序");
});

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
