"use strict";

// ========================
// Memory V2 C3 单测：Provenance Builder（11 例）
// 运行：node tests/candidate/test_provenance.js
// 铁律：缺就 null，绝不伪造；不接收正文参数（结构性禁止从文本推断 msg_id）
// ========================

const assert = require("assert");
const { buildProvenance, ORIGIN_METHOD } = require("../../provenance-builder");

const cases = [
  ["memory_tag + ctx：method=tag_inline，ids 透传", () => {
    const p = buildProvenance({ origin: "memory_tag", sessionId: "s_main", msgId: "3f2a9c88-1b2c-4d5e-8f90-a1b2c3d4e5f6" });
    assert.strictEqual(p.origin, "memory_tag");
    assert.strictEqual(p.method, "tag_inline");
    assert.strictEqual(p.session_id, "s_main");
    assert.strictEqual(p.msg_id, "3f2a9c88-1b2c-4d5e-8f90-a1b2c3d4e5f6");
  }],

  ["manual 无 ctx：method=admin_form，session/msg 明确 null（不伪造）", () => {
    const p = buildProvenance({ origin: "manual" });
    assert.strictEqual(p.method, "admin_form");
    assert.strictEqual(p.session_id, null);
    assert.strictEqual(p.msg_id, null);
    assert.strictEqual(p.quote, null);
    assert.strictEqual(p.block_id, null);
  }],

  ["tool → method=mcp_tool", () => {
    const p = buildProvenance({ origin: "tool", sessionId: "s_main" });
    assert.strictEqual(p.method, "mcp_tool");
  }],

  ["import → method=migration_batch（import 来源限制）", () => {
    const p = buildProvenance({ origin: "import" });
    assert.strictEqual(p.method, "migration_batch");
  }],

  ["promotion → 默认 summary_promotion", () => {
    const p = buildProvenance({ origin: "promotion", sessionId: "s_main" });
    assert.strictEqual(p.method, "summary_promotion");
  }],

  ["ids 空串/空白 → null（trim 后为空即缺）", () => {
    const p = buildProvenance({ origin: "manual", sessionId: "   ", msgId: "" });
    assert.strictEqual(p.session_id, null);
    assert.strictEqual(p.msg_id, null);
  }],

  ["ids 带空白 → trim 透传", () => {
    const p = buildProvenance({ origin: "manual", sessionId: "  s_main  " });
    assert.strictEqual(p.session_id, "s_main");
  }],

  ["未知 origin → method=null（不硬造）", () => {
    const p = buildProvenance({ origin: "chat_gpt" });
    assert.strictEqual(p.origin, "chat_gpt");
    assert.strictEqual(p.method, null);
  }],

  ["显式合法 method 覆盖默认（review_admit 可落任意 origin）", () => {
    const p = buildProvenance({ origin: "memory_tag", method: "review_admit" });
    assert.strictEqual(p.method, "review_admit");
  }],

  ["显式非法 method → null，且不静默回退默认", () => {
    const p = buildProvenance({ origin: "memory_tag", method: "guess" });
    assert.strictEqual(p.method, null);
  }],

  ["created_at 存在（生成时刻）；无 text 参数——结构性不可能从正文推断 msg_id", () => {
    const p = buildProvenance({ origin: "manual" });
    assert.ok(p.created_at && p.created_at.includes("T"), "created_at 为 ISO 形态");
    // 故意传入伪装成 id 的文本：builder 签名根本没有 text 字段，msg_id 只能来自显式 ctx
    const sneaky = buildProvenance({ origin: "manual", text: "msg_id 是 m_12345 哦" });
    assert.strictEqual(sneaky.msg_id, null);
    assert.strictEqual(sneaky.quote, null);
    assert.strictEqual(sneaky.block_id, null);
  }],
];

let passN = 0, failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passN++;
    console.log("PASS " + name);
  } catch (err) {
    failed++;
    console.log("FAIL " + name + " :: " + err.message);
  }
}
console.log(`\ntest_provenance: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
