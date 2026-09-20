"use strict";
// Context V2 Builder 组装行为测试（C10 S3-C 校准批后）——顺序/空块/V2 空仓降级/只读/config
// 跑法：node tests/context-v2/test_assembly.js（exit 0 = 全过）

const assert = require("assert");
const { buildContextBlocks, DEFAULT_CONFIG, BLOCK_DEFS } = require("../../context-v2-builder");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

const EXPECTED_ORDER = [
  "context_assembly", "system_instructions", "core_identity", "long_term_understanding",
  "meaningful_moments", "conversation_continuity", "relevant_memories",
];

// 满配 fixture（六块全非空）
function fullInput() {
  return {
    pinnedEntries: [
      { id: "pin1", title: "记忆标签", content: "如果想存记忆，用记忆内联标签。", target: "instructions" },
      { id: "pin2", content: "回复她要简短有温度", target: "identity" },
      { id: "pin3", content: "你是我的锚", target: "moments_anchor" },
    ],
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

ok("块顺序 = 0918 修订冻结顺序（六块）", () => {
  const res = buildContextBlocks(fullInput());
  const keys = res.blocks.map(b => b.key);
  assert.deepStrictEqual(keys, EXPECTED_ORDER, "实际输出顺序");
  assert.deepStrictEqual(BLOCK_DEFS.map(d => d.key), EXPECTED_ORDER, "定义表顺序");
});

ok("schema：每块五键，非空块 tokens>0；current_state/recent_experience 已不存在", () => {
  const res = buildContextBlocks(fullInput(), { includeEmpty: true });
  const keys = res.blocks.map(b => b.key);
  assert.ok(!keys.includes("current_state"), "0918 砍除");
  assert.ok(!keys.includes("recent_experience"), "0918 剔除");
  for (const b of res.blocks) {
    assert.deepStrictEqual(Object.keys(b).sort(), ["content", "empty", "key", "title", "tokens"]);
    assert.strictEqual(b.empty, false);
    assert.ok(Number.isInteger(b.tokens) && b.tokens > 0);
  }
});

ok("V2 空仓降级：Understanding/Moments/Relevant 省略；System Instructions/Identity/Continuity 由 pinned+diary 支撑", () => {
  const input = fullInput();
  input.memoriesV2 = [];
  input.query = "";
  input.pinnedEntries = input.pinnedEntries.filter(p => p.target !== "moments_anchor"); // 无 anchor 来源
  const res = buildContextBlocks(input);
  const keys = res.blocks.map(b => b.key);
  assert.ok(keys.includes("system_instructions"), "pinned 工具文档仍提供");
  assert.ok(keys.includes("core_identity"), "pinned 规训仍提供");
  assert.ok(keys.includes("conversation_continuity"));
  assert.ok(!keys.includes("long_term_understanding"), "V2 空仓省略");
  assert.ok(!keys.includes("meaningful_moments"), "无任何 anchor 来源省略");
  assert.ok(!keys.includes("relevant_memories"), "V2 空仓省略");

  // pinned 有 anchor 时：V2 空仓 Moments 仍由 pinned anchor 支撑
  const res2 = buildContextBlocks({ ...input, pinnedEntries: fullInput().pinnedEntries });
  const m2 = res2.blocks.find(b => b.key === "meaningful_moments");
  assert.ok(m2 && m2.content.includes("你是我的锚"), "pinned anchor 降级支撑");
});

ok("空块省略（默认，仅剩顶层引导）+ includeEmpty=true 时七块全在（empty:true, content:'', tokens:0）", () => {
  const empty = { pinnedEntries: [], diaryEntries: [], memoriesV2: [], query: "" };
  const def = buildContextBlocks(empty).blocks;
  assert.strictEqual(def.length, 1, "全空输入仅剩恒注入的顶层引导");
  assert.strictEqual(def[0].key, "context_assembly");
  const res = buildContextBlocks(empty, { includeEmpty: true });
  assert.strictEqual(res.blocks.length, 7);
  for (const b of res.blocks) {
    if (b.key === "context_assembly") { assert.strictEqual(b.empty, false); continue; }
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

ok("config 覆盖：门槛提高→核心层省略；diaryCount=1→只最新一篇；不污染 DEFAULT_CONFIG", () => {
  const input = fullInput();
  input.config = { understandingCoreMinPriority: 0.95, diaryCount: 1 };
  const res = buildContextBlocks(input);
  // 0920 核心层 priority 门槛已删（仅 anchor），传入的 understandingCoreMinPriority 被忽略
  assert.strictEqual(DEFAULT_CONFIG.understandingCoreMinPriority, undefined, "核心层 priority 门槛配置已删");
  const cont = res.blocks.find(b => b.key === "conversation_continuity");
  assert.ok(cont.content.includes("2026-09-13") && !cont.content.includes("2026-09-10"), "diaryCount=1 只最新一篇");
  assert.strictEqual(DEFAULT_CONFIG.diaryCount, 3, "默认篇数未被改");
});

ok("内容块标题仅一行（说明已上移顶层引导）；顶层块恒注入且含 Handling Rule", () => {
  const res = buildContextBlocks(fullInput());
  const id = res.blocks.find(b => b.key === "core_identity");
  const lines = id.content.split("\n");
  assert.strictEqual(lines[0], "## Core Identity", "标题恰一行");
  assert.ok(lines[1].length > 0, "换行即内容");
  assert.ok(!id.content.includes("standing agreements"), "说明段不再重复（已上移）");
  const top = res.blocks.find(b => b.key === "context_assembly");
  assert.ok(top, "顶层引导恒注入");
  assert.ok(top.content.includes("## Memory Handling Rule"), "Handling Rule 并入顶层尾部");
  assert.ok(top.content.includes("her present intent"), "优先级总纲在");
});

ok("条目标题 [xxx] 格式（0918：【】→[]）", () => {
  const res = buildContextBlocks(fullInput());
  const sys = res.blocks.find(b => b.key === "system_instructions");
  assert.ok(sys.content.includes("[记忆标签]如果想存记忆"), "[标题]格式");
  assert.ok(!sys.content.includes("【记忆标签】"), "旧【】格式已废");
});

ok("去重集成：anchor quote 在 Moments、rule 在 Identity、工具文档在 Instructions，均不入 Relevant", () => {
  const input = fullInput();
  input.query = "无论你怎么样 我都选择接你 睡前不许催她 薄荷 如果想存记忆";
  const res = buildContextBlocks(input);
  const rel = res.blocks.find(b => b.key === "relevant_memories");
  assert.ok(rel, "检索块存在（薄荷条目应命中）");
  assert.ok(!rel.content.includes("无论你怎么样我都选择接你"), "Moments anchor 去重");
  assert.ok(!rel.content.includes("睡前不许催她"), "Identity rule 去重");
  assert.ok(!rel.content.includes("如果想存记忆"), "Instructions 去重");
  assert.ok(rel.content.includes("她对薄荷过敏"), "检索池条目正常");
});

console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
