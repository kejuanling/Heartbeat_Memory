"use strict";

// ========================
// Memory V2 C1 单测：Schema 校验（纯函数，不触盘）
// 运行：node tests/memory-v2/test_schema.js
// 契约：gpt串口/13.txt Schema v1.0
// ========================

const assert = require("assert");
const mv2 = require("../../memory-v2");

const C = mv2.CONSTANTS;

// 便捷构造：最小合法 fact（manual）
function baseFact(overrides = {}) {
  return {
    text: "她喝奶茶只要三分糖",
    kind: "fact",
    subject: "user",
    origin: "manual",
    provenance: { method: "admin_form" },
    ...overrides,
  };
}

const cases = [
  ["合法最小 fact：通过且默认值正确", () => {
    const r = mv2.validateEntry(baseFact());
    assert.strictEqual(r.ok, true, r.error);
    const e = r.entry;
    assert.strictEqual(e.schema_ver, C.SCHEMA_VER);
    assert.ok(e.id.startsWith("mv2_") && e.id.length === "mv2_".length + 12, "id 形如 mv2_+12hex");
    assert.strictEqual(e.status, "active");
    assert.strictEqual(e.confidence, 0.8, "manual 默认 confidence 0.8");
    assert.strictEqual(e.speaker, null);
    assert.strictEqual(e.direction, null);
    assert.strictEqual(e.created_at, e.content_updated_at, "创建时两时间戳相等");
    assert.ok(e.created_at.includes("T"), "时间戳为 ISO 形态");
    assert.deepStrictEqual(e.related_subjects, []);
    assert.deepStrictEqual(e.related_memories, []);
    assert.strictEqual(e.supersedes, null);
    assert.strictEqual(e.superseded_by, null);
    assert.strictEqual(e.superseded_reason, null);
    assert.strictEqual(e.superseded_at, null);
    // provenance 子字段补齐
    assert.strictEqual(e.provenance.session_id, null);
    assert.strictEqual(e.provenance.msg_id, null);
    assert.strictEqual(e.provenance.quote, null);
    assert.strictEqual(e.provenance.block_id, null);
    assert.strictEqual(e.provenance.method, "admin_form");
  }],

  ["缺 text 拒绝", () => {
    const r = mv2.validateEntry({ kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("text"), r.error);
  }],

  ["空白 text 拒绝", () => {
    const r = mv2.validateEntry(baseFact({ text: "   " }));
    assert.strictEqual(r.ok, false);
  }],

  ["text 超长（2001）拒绝 / 恰好 2000 通过", () => {
    const r1 = mv2.validateEntry(baseFact({ text: "好".repeat(C.TEXT_MAX + 1) }));
    assert.strictEqual(r1.ok, false);
    const r2 = mv2.validateEntry(baseFact({ text: "好".repeat(C.TEXT_MAX) }));
    assert.strictEqual(r2.ok, true, r2.error);
  }],

  ["枚举非法：kind / subject / origin 各自拒绝", () => {
    for (const [field, value] of [["kind", "preference"], ["subject", "her"], ["origin", "star"]]) {
      const r = mv2.validateEntry(baseFact({ [field]: value }));
      assert.strictEqual(r.ok, false, `${field}=${value} 应被拒`);
      assert.ok(r.error.includes(field), r.error);
    }
  }],

  ["quote 联动：subject 非 user / speaker=self / 缺 speaker 均拒绝", () => {
    const r1 = mv2.validateEntry(baseFact({ kind: "quote", subject: "self", speaker: "user", text: "你是我的锚" }));
    assert.strictEqual(r1.ok, false, "quote subject 必须 user");
    const r2 = mv2.validateEntry(baseFact({ kind: "quote", subject: "user", speaker: "self", text: "AI 台词" }));
    assert.strictEqual(r2.ok, false, "AI 台词禁止冒充原话");
    const r3 = mv2.validateEntry(baseFact({ kind: "quote", subject: "user", text: "缺 speaker" }));
    assert.strictEqual(r3.ok, false, "缺 speaker 必须拒绝");
    const r4 = mv2.validateEntry(baseFact({ kind: "quote", subject: "user", speaker: "user", text: "只能我先说晚安" }));
    assert.strictEqual(r4.ok, true, r4.error);
    assert.strictEqual(r4.entry.speaker, "user");
  }],

  ["milestone 联动：subject 必须 relationship 且 established_at 必填", () => {
    const r1 = mv2.validateEntry(baseFact({ kind: "milestone", subject: "user", established_at: "2026-07-14", text: "成为恋人" }));
    assert.strictEqual(r1.ok, false, "milestone subject 必须 relationship");
    const r2 = mv2.validateEntry(baseFact({ kind: "milestone", subject: "relationship", text: "成为恋人" }));
    assert.strictEqual(r2.ok, false, "milestone 必须 established_at");
    const r3 = mv2.validateEntry(baseFact({ kind: "milestone", subject: "relationship", established_at: "2026-07-14", text: "成为恋人" }));
    assert.strictEqual(r3.ok, true, r3.error);
    assert.strictEqual(r3.entry.established_at, "2026-07-14");
  }],

  ["rule 的 direction：缺省通过 / 非法拒绝 / 合法保留", () => {
    const r1 = mv2.validateEntry(baseFact({ kind: "rule", text: "以后不许催我睡觉" }));
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.entry.direction, null);
    const r2 = mv2.validateEntry(baseFact({ kind: "rule", text: "以后不许催我睡觉", direction: "toward_she" }));
    assert.strictEqual(r2.ok, false, "direction 枚举外拒绝");
    const r3 = mv2.validateEntry(baseFact({ kind: "rule", text: "我保证不编造", direction: "self_discipline" }));
    assert.strictEqual(r3.ok, true, r3.error);
    assert.strictEqual(r3.entry.direction, "self_discipline");
  }],

  ["direction 仅 rule 可用（fact 带 direction 拒绝）", () => {
    const r = mv2.validateEntry(baseFact({ direction: "toward_user" }));
    assert.strictEqual(r.ok, false);
  }],

  ["confidence 显式传非法值拒绝（缺省才走默认）；priority 已删（0920）", () => {
    assert.strictEqual(mv2.validateEntry(baseFact({ confidence: 1.5 })).ok, false);
    assert.strictEqual(mv2.validateEntry(baseFact({ confidence: "高" })).ok, false);
    const r = mv2.validateEntry(baseFact({ confidence: 0.95 }));
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.entry.confidence, 0.95);
    assert.strictEqual("priority" in r.entry, false, "priority 字段已删除");
  }],

  ["import 封顶：confidence 0.9 → 0.6；memory_tag 默认 0.7", () => {
    const r1 = mv2.validateEntry(baseFact({ origin: "import", confidence: 0.9, provenance: { method: "migration_batch" } }));
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.entry.confidence, 0.6, "import 封顶 0.6");
    const r2 = mv2.validateEntry(baseFact({ origin: "memory_tag", provenance: { method: "tag_inline" } }));
    assert.strictEqual(r2.entry.confidence, 0.7, "memory_tag 默认 0.7");
  }],

  ["related_subjects：含主 subject / 非法枚举拒绝，合法通过且去重", () => {
    const r1 = mv2.validateEntry(baseFact({ related_subjects: ["user"] }));
    assert.strictEqual(r1.ok, false, "不得含主 subject");
    const r2 = mv2.validateEntry(baseFact({ related_subjects: ["her"] }));
    assert.strictEqual(r2.ok, false, "枚举外拒绝");
    const r3 = mv2.validateEntry(baseFact({ related_subjects: ["self", "self", "relationship"] }));
    assert.strictEqual(r3.ok, true, r3.error);
    assert.deepStrictEqual(r3.entry.related_subjects, ["self", "relationship"]);
  }],

  ["related_memories：rel 非法拒绝，合法 {id,rel} 通过", () => {
    const r1 = mv2.validateEntry(baseFact({ related_memories: [{ id: "mv2_x", rel: "likes" }] }));
    assert.strictEqual(r1.ok, false);
    const r2 = mv2.validateEntry(baseFact({ related_memories: [{ id: "mv2_x", rel: "pairs_with" }] }));
    assert.strictEqual(r2.ok, true, r2.error);
    assert.deepStrictEqual(r2.entry.related_memories, [{ id: "mv2_x", rel: "pairs_with" }]);
  }],

  ["provenance：缺失 / method 非法 / quote 超长 拒绝；合法通过", () => {
    const r1 = mv2.validateEntry(baseFact({ provenance: undefined }));
    assert.strictEqual(r1.ok, false, "provenance 必填");
    const r2 = mv2.validateEntry(baseFact({ provenance: { method: "guess" } }));
    assert.strictEqual(r2.ok, false, "method 枚举外拒绝");
    const r3 = mv2.validateEntry(baseFact({ provenance: { method: "tag_inline", quote: "原".repeat(C.PROVENANCE_QUOTE_MAX + 1) } }));
    assert.strictEqual(r3.ok, false, "quote 超长拒绝");
    const r4 = mv2.validateEntry(baseFact({ provenance: { method: "tag_inline", session_id: "s_main", msg_id: "m_1", quote: "她只要三分糖" } }));
    assert.strictEqual(r4.ok, true, r4.error);
    assert.strictEqual(r4.entry.provenance.session_id, "s_main");
    assert.strictEqual(r4.entry.provenance.quote, "她只要三分糖");
  }],

  ["note 超长拒绝；system 字段传入被忽略（schema_ver/status 不可指定）", () => {
    const r1 = mv2.validateEntry(baseFact({ note: "x".repeat(C.NOTE_MAX + 1) }));
    assert.strictEqual(r1.ok, false, "note 超长拒绝");
    const r2 = mv2.validateEntry(baseFact({ schema_ver: 99, status: "archived" }));
    assert.strictEqual(r2.ok, true, r2.error);
    assert.strictEqual(r2.entry.schema_ver, 1, "schema_ver 系统生成");
    assert.strictEqual(r2.entry.status, "active", "创建恒为 active，归档只能走状态机");
  }],
];

let pass = 0, failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log("PASS " + name);
  } catch (err) {
    failed++;
    console.log("FAIL " + name + " :: " + err.message);
  }
}
console.log(`\ntest_schema: ${pass} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
