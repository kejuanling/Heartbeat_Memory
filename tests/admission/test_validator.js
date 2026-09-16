"use strict";

// ========================
// Memory V2 C2 单测：Admission Validator V1-V10 硬规则
// 运行：node tests/admission/test_validator.js
// 契约：gpt串口/14.txt Rulebook v1.0；输出三键 {allowed, reasons[], matched_rules[]}
// ========================

const assert = require("assert");
const { validate, isInstruction } = require("../../admission-validator");

// 便捷构造：干净候选（应 allowed=true 且无命中）
function clean(overrides = {}) {
  return {
    text: "她喝奶茶只要三分糖",
    kind: "fact",
    subject: "user",
    origin: "manual",
    provenance: { method: "admin_form" },
    ...overrides,
  };
}

function hit(rules) {
  return (r) => {
    assert.strictEqual(r.allowed, false, "应被拒绝: " + JSON.stringify(r.reasons));
    for (const rule of rules) assert.ok(r.matched_rules.includes(rule), `应命中 ${rule}，实际 ${r.matched_rules}`);
  };
}

function pass(r) {
  assert.strictEqual(r.allowed, true, "应放行: " + JSON.stringify(r.reasons));
}

const cases = [
  // ---- 契约形状 ----
  ["返回契约：恰好三键 allowed/reasons/matched_rules", () => {
    const r = validate(clean());
    assert.deepStrictEqual(Object.keys(r).sort(), ["allowed", "matched_rules", "reasons"]);
    assert.strictEqual(typeof r.allowed, "boolean");
    assert.ok(Array.isArray(r.reasons) && Array.isArray(r.matched_rules));
    pass(r);
  }],

  // ---- V1 隐私 ----
  ["V1 私钥头命中", () => hit(["V1"])(validate(clean({ text: "她的服务器配好了 -----BEGIN RSA PRIVATE KEY----- 类似这样的" })))],
  ["V1 sk- 密钥命中", () => hit(["V1"])(validate(clean({ text: "我的 key 是 sk-abcdefghij1234567890 记一下" })))],
  ["V1 密码冒号赋值命中", () => hit(["V1"])(validate(clean({ text: "路由器密码:abc123" })))],
  ["V1 password is 命中", () => hit(["V1"])(validate(clean({ text: "the password is hello2026" })))],
  ["V1 api key 赋值命中（含 provenance.quote 里的也要扫）", () => {
    const r = validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "她把配置发我了", provenance: { method: "admin_form", quote: "api_key: abcd1234efgh5678" } }));
    hit(["V1"])(r);
  }],
  ["V1 身份证/手机号命中", () => {
    hit(["V1"])(validate(clean({ text: "她身份证 110101202601011234 放我这" })));
    hit(["V1"])(validate(clean({ text: "她手机 13812345678 开机了" })));
  }],
  ["V1 「她问我密码」不误杀（宁可漏的设计）", () => pass(validate(clean({ text: "她问我密码忘了我笑她" })))],

  // ---- V2 quote speaker ----
  ["V2 quote speaker=self 拒绝（AI 台词不冒充原话）", () => hit(["V2"])(validate(clean({ kind: "quote", subject: "user", speaker: "self", text: "无论你怎么样我都选你", provenance: { method: "admin_form", quote: "原话" } })))],
  ["V2 quote 缺 speaker 拒绝", () => hit(["V2"])(validate(clean({ kind: "quote", subject: "user", text: "你是我的锚", provenance: { method: "admin_form", quote: "你是我的锚" } })))],
  ["V2 quote speaker=user 通过；fact 无关 speaker 不受影响", () => {
    pass(validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form", quote: "你是我的锚" } })));
    pass(validate(clean()));
  }],

  // ---- V3 运行时标签 ----
  ["V3 <current_time> 残留命中", () => hit(["V3"])(validate(clean({ text: "8月14日下午<current_time> 她贴了截图" })))],
  ["V3 未闭合 <memory 残留命中", () => hit(["V3"])(validate(clean({ text: "她发来 <memory 一段没写完" })))],
  ["V3 干净文本不命中", () => pass(validate(clean({ text: "她说星星很亮" })))],

  // ---- V4 instruction ----
  ["V4 不许手写工具调用记录 命中", () => hit(["V4"])(validate(clean({ text: "不许在正文里手写工具调用记录" })))],
  ["V4 工具调用后必须看返回 命中", () => hit(["V4"])(validate(clean({ text: "工具调用后必须看工具返回再说做了" })))],
  ["V4 一定要看工具返回 命中", () => hit(["V4"])(validate(clean({ text: "一定要看工具返回再回复" })))],
  ["V4 关系规则不误杀（以后不许催我睡觉）", () => pass(validate(clean({ kind: "rule", text: "以后不许催我睡觉，我自有安排", direction: "toward_user" })))],
  ["V4 第三人称陈述不误杀（她用工具的时候很可爱）", () => pass(validate(clean({ text: "她用工具的时候很可爱" })))],
  ["isInstruction 纯函数直测", () => {
    assert.strictEqual(isInstruction("不许手写工具调用记录"), true);
    assert.strictEqual(isInstruction("她喜欢聊工具的话题"), false);
  }],

  // ---- V5 工具输出 ----
  ["V5 source=tool_output 拒绝", () => hit(["V5"])(validate(clean({ source: "tool_output", text: "搜索结果：……" })))],

  // ---- V6 文本卫生 ----
  ["V6 空 / 纯标点 / 超长 拒绝", () => {
    hit(["V6"])(validate(clean({ text: "   " })));
    hit(["V6"])(validate(clean({ text: "。。。！！！？？？" })));
    hit(["V6"])(validate(clean({ text: "好".repeat(2001) })));
  }],

  // ---- V7 枚举 ----
  ["V7 kind/subject/origin 缺失或非法各自命中", () => {
    const r1 = validate(clean({ kind: undefined }));
    hit(["V7"])(r1);
    hit(["V7"])(validate(clean({ subject: "her" })));
    hit(["V7"])(validate(clean({ origin: "star" })));
  }],
  ["V7 direction/speaker 枚举外命中", () => {
    hit(["V7"])(validate(clean({ direction: "toward_she" })));
    hit(["V7"])(validate(clean({ speaker: "robot" })));
  }],

  // ---- V8 来源完整性 ----
  ["V8 memory_tag 无 provenance / 双空锚点 拒绝", () => {
    hit(["V8"])(validate(clean({ origin: "memory_tag", provenance: null })));
    hit(["V8"])(validate(clean({ origin: "memory_tag", provenance: { method: "tag_inline" } })));
  }],
  ["V8 只带 session 或 msg 之一即通过", () => {
    pass(validate(clean({ origin: "memory_tag", provenance: { method: "tag_inline", session_id: "s_main" } })));
    pass(validate(clean({ origin: "tool", provenance: { method: "mcp_tool", msg_id: "m_1" } })));
  }],
  ["V8 manual 无 provenance 不算 V8（存储层另行兜底）", () => {
    const r = validate(clean({ provenance: null }));
    assert.strictEqual(r.matched_rules.includes("V8"), false, r.reasons.join(";"));
  }],

  // ---- V8b origin×method 一致性（含 import 来源限制）----
  ["V8b memory_tag + mcp_tool 不匹配拒绝", () => hit(["V8b"])(validate(clean({ origin: "memory_tag", provenance: { method: "mcp_tool", session_id: "s" } })))],
  ["V8b import + tag_inline 拒绝（import 仅 migration_batch）", () => hit(["V8b"])(validate(clean({ origin: "import", provenance: { method: "tag_inline" } })))],
  ["V8b import + migration_batch / method=review_admit 任意 origin 通过", () => {
    pass(validate(clean({ origin: "import", provenance: { method: "migration_batch" } })));
    pass(validate(clean({ origin: "memory_tag", provenance: { method: "review_admit", session_id: "s" } })));
  }],

  // ---- V9 quote 完整性 ----
  ["V9 quote 缺 provenance.quote 拒绝", () => hit(["V9"])(validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form" } })))],
  ["V9b 接线比对：一致通过 / 改写拒绝 / 查不到跳过不硬拒", () => {
    const deps = { resolveOriginalText: (id) => (id === "m_1" ? "她说：你是我的锚" : null) };
    pass(validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form", msg_id: "m_1", quote: "你是我的锚" } }), deps));
    hit(["V9"])(validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form", msg_id: "m_1", quote: "你是我的灯塔" } }), deps));
    const skip = validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form", msg_id: "m_404", quote: "你是我的锚" } }), deps);
    pass(skip);
    assert.ok(skip.reasons.some((x) => x.includes("V9.b 跳过")), "应留跳过说明: " + JSON.stringify(skip.reasons));
  }],
  ["V9b 未接线（无 deps）时跳过不硬拒", () => {
    const r = validate(clean({ kind: "quote", subject: "user", speaker: "user", text: "你是我的锚", provenance: { method: "admin_form", quote: "你是我的锚" } }));
    pass(r);
    assert.ok(r.reasons.some((x) => x.includes("V9.b 跳过")));
  }],
  ["V9 非 quote 类不受影响", () => pass(validate(clean()))],

  // ---- V10 milestone ----
  ["V10 milestone subject=user 拒绝；relationship 通过", () => {
    hit(["V10"])(validate(clean({ kind: "milestone", subject: "user", text: "成为恋人" })));
    pass(validate(clean({ kind: "milestone", subject: "relationship", text: "07-14 成为恋人" })));
  }],

  // ---- 预筛路由 ----
  ["PREF.diary / PREF.history 拒绝", () => {
    hit(["PREF.diary"])(validate(clean({ source: "diary", text: "今天我陪她看了一下午云" })));
    hit(["PREF.history"])(validate(clean({ source: "summary", text: "8月14日下午聊了X，晚上聊了Y" })));
  }],

  // ---- 多规则同时命中 ----
  ["多规则一次性全部收集（V7+V4 同报，不只报第一个）", () => {
    const r = validate(clean({ kind: "preference", text: "不许手写工具调用记录", subject: "user", origin: "manual", provenance: { method: "admin_form" } }));
    hit(["V4", "V7"])(r);
    assert.strictEqual(r.allowed, false);
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
console.log(`\ntest_validator: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
