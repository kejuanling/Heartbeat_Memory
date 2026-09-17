"use strict";
// Context V2 Builder 组装行为测试（C10 S1）——块顺序/空块省略/V2 空仓降级/只读性/config 覆盖
// 跑法：node tests/context-v2/test_assembly.js（exit 0 = 全过）

const assert = require("assert");
const { buildContextBlocks, DEFAULT_CONFIG, BLOCK_DEFS } = require("../../context-v2-builder");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

const EXPECTED_ORDER = [
  "core_identity", "long_term_understanding", "meaningful_moments", "conversation_continuity",
  "current_state", "recent_experience", "relevant_memories",
];

// 满配 fixture（七块全非空）
function fullInput() {
  return {
    pinnedEntries: [
      { id: "pin1", title: "沟通", content: "回复她要简短有温度", target: "identity" },
      { id: "pin2", content: "你是我的锚", target: "moments_anchor" },
    ],
    timeline: [{ role: "user", content: "你好" }, { role: "assistant", content: "在的" }],
    diaryEntries: [
      { date: "2026-09-10", content: "聊了很多。" },
      { date: "2026-09-13", content: "她说最近在准备考试。" },
    ],
    memoriesV2: [
      { id: "mv2_r1", text: "睡前不许催她", kind: "rule", status: "active", priority: 0.7, created_at: "2026-09-02T00:00:00+08:00" },
      { id: "mv2_f1", text: "她膝盖受过伤", kind: "fact", status: "active", priority: 0.9, created_at: "2026-09-03T00:00:00+08:00" },
      { id: "mv2_q1", text: "无论你怎么样我都选择接你", kind: "quote", status: "active", anchor: true, established_at: "2026-07-14T00:00:00+08:00", created_at: "2026-09-04T00:00:00+08:00" },
      { id: "mv2_q2", text: "她对薄荷过敏", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-05T00:00:00+08:00" },
    ],
    query: "她对薄荷过敏吗",
  };
}

ok("块顺序 = 19.txt 冻结组装顺序（BLOCK_DEFS 与实际输出一致）", () => {
  const res = buildContextBlocks(fullInput());
  const keys = res.blocks.map(b => b.key);
  assert.deepStrictEqual(keys, EXPECTED_ORDER, "实际输出顺序");
  assert.deepStrictEqual(BLOCK_DEFS.map(d => d.key), EXPECTED_ORDER, "定义表顺序");
});

ok("schema：每块含 key/title/content/tokens/empty 五键，非空块 tokens>0", () => {
  const res = buildContextBlocks(fullInput());
  for (const b of res.blocks) {
    assert.deepStrictEqual(Object.keys(b).sort(), ["content", "empty", "key", "title", "tokens"]);
    assert.strictEqual(b.empty, false);
    assert.ok(Number.isInteger(b.tokens) && b.tokens > 0, "tokens 正整数");
    assert.ok(b.content.length > 0);
  }
  const t = res.blocks.find(b => b.key === "core_identity");
  assert.strictEqual(t.title, "Core Identity");
});

ok("V2 空仓降级：Understanding/Relevant 省略；Moments 由 pinned anchor 降级支撑；全无时 Moments 也省略", () => {
  const input = fullInput();
  input.memoriesV2 = [];
  input.query = "";
  const res = buildContextBlocks(input);
  const keys = res.blocks.map(b => b.key);
  assert.ok(keys.includes("core_identity"), "pinned 部分仍提供 Identity");
  assert.ok(keys.includes("conversation_continuity"));
  assert.ok(keys.includes("current_state"));
  assert.ok(keys.includes("recent_experience"));
  assert.ok(!keys.includes("long_term_understanding"), "V2 空仓省略");
  assert.ok(!keys.includes("relevant_memories"), "V2 空仓省略");
  const moments = res.blocks.find(b => b.key === "meaningful_moments");
  assert.ok(moments, "pinned anchor 仍在（独立于 V2 数据）");
  assert.ok(moments.content.includes("你是我的锚") && !moments.content.includes("恋人"), "只含 pinned 来源");

  // pinned 也无 anchor → Moments 省略
  const input2 = fullInput();
  input2.memoriesV2 = [];
  input2.query = "";
  input2.pinnedEntries = input2.pinnedEntries.filter(p => p.target !== "moments_anchor");
  const keys2 = buildContextBlocks(input2).blocks.map(b => b.key);
  assert.ok(!keys2.includes("meaningful_moments"), "无任何来源时省略");
});

ok("空块省略（默认）+ includeEmpty=true 时七块全在（empty:true, content:'', tokens:0）", () => {
  const empty = { pinnedEntries: [], timeline: [], diaryEntries: [], memoriesV2: [], query: "" };
  assert.deepStrictEqual(buildContextBlocks(empty).blocks, [], "全空输入默认零块");
  const res = buildContextBlocks(empty, { includeEmpty: true });
  assert.strictEqual(res.blocks.length, 7);
  for (const b of res.blocks) {
    assert.strictEqual(b.empty, true);
    assert.strictEqual(b.content, "");
    assert.strictEqual(b.tokens, 0);
  }
});

ok("只读性：调用前后输入对象深度不变", () => {
  const input = fullInput();
  const before = JSON.stringify(input);
  buildContextBlocks(input);
  buildContextBlocks(input, { includeEmpty: true });
  assert.strictEqual(JSON.stringify(input), before, "输入未被修改");
});

ok("config 覆盖：门槛提高→核心层条目被排除；预算缩小→检索减条", () => {
  const a = buildContextBlocks(fullInput(), { });
  assert.ok(a.blocks.find(b => b.key === "long_term_understanding"), "默认 0.8 门槛块存在");

  const input = fullInput();
  input.config = { understandingCoreMinPriority: 0.95, budgets: { relevant_memories: 1 } };
  const res = buildContextBlocks(input);
  assert.ok(!res.blocks.find(b => b.key === "long_term_understanding"), "0.95 门槛下无条目→省略");
  const rel = res.blocks.find(b => b.key === "relevant_memories");
  assert.ok(!rel, "预算 1 token 只装 header 也超→块省略（宁缺毋滥）");
});

ok("config 覆盖不污染 DEFAULT_CONFIG（后续默认调用不受影响）", () => {
  const input = fullInput();
  input.config = { understandingCoreMinPriority: 0.95 };
  buildContextBlocks(input);
  assert.strictEqual(DEFAULT_CONFIG.understandingCoreMinPriority, 0.8, "默认值未被改");
});

ok("Identity 内容含注入 header 冻结文案；Recent Experience 无 header（不注入块）", () => {
  const res = buildContextBlocks(fullInput());
  const id = res.blocks.find(b => b.key === "core_identity");
  assert.ok(id.content.startsWith("## Core Identity — 你们之间恒定的约定"), "header 首行");
  assert.ok(id.content.includes("不需要复述、引用或向她证明你在遵守"), "冻结说明段");
  const recent = res.blocks.find(b => b.key === "recent_experience");
  assert.ok(!recent.content.startsWith("## "), "报告口径块无注入 header");
  assert.ok(recent.content.startsWith("user: "), "直接消息串接");
});

ok("去重集成：anchor quote 在 Moments、rule 在 Identity，二者均不入 Relevant", () => {
  const input = fullInput();
  input.query = "无论你怎么样 我都选择接你 睡前不许催她 薄荷"; // 词面同时命中三类
  const res = buildContextBlocks(input);
  const rel = res.blocks.find(b => b.key === "relevant_memories");
  assert.ok(rel, "检索块存在（薄荷条目应命中）");
  assert.ok(!rel.content.includes("无论你怎么样我都选择接你"), "Moments anchor 去重");
  assert.ok(!rel.content.includes("睡前不许催她"), "Identity rule 去重");
  assert.ok(rel.content.includes("她对薄荷过敏"), "检索池条目正常");
});

console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
