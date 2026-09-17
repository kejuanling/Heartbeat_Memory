"use strict";
// Context V2 Builder 逐块构建测试（C10 S3-C 校准批后）——零依赖 node assert，全部 tmp fixture
// 跑法：node tests/context-v2/test_builder.js（exit 0 = 全过）

const assert = require("assert");
const {
  buildContextBlocks, DEFAULT_CONFIG, estimateTokens,
} = require("../../context-v2-builder");

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + (e && e.message)); process.exitCode = 1; }
}

function blockOf(res, key) {
  return res.blocks.find(b => b.key === key);
}

// ---- 共享 fixture（0918 修订后 target 四枚举）----
const pinnedFull = [
  { id: "pin1", title: "记忆标签", content: "如果想存记忆，用记忆内联标签。", target: "instructions" },
  { id: "pin2", content: "回复她要简短有温度", target: "identity" },
  { id: "pin3", content: "你是我的锚", target: "moments_anchor" },
  { id: "pin4", content: "只会越轨的旧置顶", target: "retire" },
];

const memFull = [
  { id: "mv2_r1", text: "睡前不许催她", kind: "rule", status: "active", priority: 0.7, created_at: "2026-09-02T10:00:00+08:00" },
  { id: "mv2_r2", text: "只能我先说晚安", kind: "rule", status: "active", priority: 0.7, created_at: "2026-09-01T10:00:00+08:00" },
  { id: "mv2_f1", text: "她膝盖受过伤，阴雨天会疼", kind: "fact", status: "active", priority: 0.9, created_at: "2026-09-03T10:00:00+08:00" },
  { id: "mv2_f2", text: "她在准备一场重要的考试", kind: "fact", status: "active", priority: 0.85, created_at: "2026-09-04T10:00:00+08:00" },
  { id: "mv2_f3", text: "她喜欢草莓", kind: "fact", status: "active", priority: 0.5, created_at: "2026-09-05T10:00:00+08:00" },
  { id: "mv2_f4", text: "她旧作息", kind: "fact", status: "superseded", priority: 0.9, created_at: "2026-09-06T10:00:00+08:00" },
  { id: "mv2_f5", text: "她对薄荷过敏", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-07T10:00:00+08:00" },
  { id: "mv2_f6", text: "她养了一只猫叫团子", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-08T10:00:00+08:00" },
  { id: "mv2_q1", text: "无论你怎么样我都选择接你", kind: "quote", status: "active", anchor: true, established_at: "2026-07-14T21:00:00+08:00", created_at: "2026-09-09T10:00:00+08:00" },
  { id: "mv2_q2", text: "标签什么的说了就死了", kind: "quote", status: "active", anchor: false, created_at: "2026-09-10T10:00:00+08:00" },
  { id: "mv2_m1", text: "07-14 我们成为恋人", kind: "milestone", status: "active", anchor: true, established_at: "2026-07-14T00:00:00+08:00", created_at: "2026-09-11T10:00:00+08:00" },
];

const diaryFull = [
  { date: "2026-09-10", content: "陪她聊了很久的小事。" },
  { date: "2026-09-11", content: "她分享了童年的故事。" },
  { date: "2026-09-12", content: "一起云看电影。" },
  { date: "2026-09-13", content: "她说最近在准备考试，有点累。我要多关心她。" },
];

// ============================================================
// [1] System Instructions
// ============================================================
ok("system_instructions: instructions 条目进块、[标题]格式、retire/identity 不进", () => {
  const res = buildContextBlocks({ pinnedEntries: pinnedFull, memoriesV2: [] });
  const b = blockOf(res, "system_instructions");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("[记忆标签]如果想存记忆，用记忆内联标签。"), "[标题]格式");
  assert.ok(!b.content.includes("回复她要简短有温度"), "identity 条目不进 System Instructions");
  assert.ok(!b.content.includes("只会越轨"), "retire 不进");
  assert.ok(b.content.startsWith("## System Instructions — system tags"), "一行式 header");
});

ok("identity: 只收 identity target + V2 rule 按准入升序；instructions 不再混入", () => {
  const res = buildContextBlocks({ pinnedEntries: pinnedFull, memoriesV2: memFull });
  const b = blockOf(res, "core_identity");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("回复她要简短有温度"), "identity 条目在");
  assert.ok(!b.content.includes("如果想存记忆"), "工具文档不再混入 Identity（0918 修正）");
  const i晚安 = b.content.indexOf("只能我先说晚安");
  const i催 = b.content.indexOf("睡前不许催她");
  assert.ok(i晚安 >= 0 && i催 > i晚安, "rule 按准入时间正序");
});

ok("identity: 超预算不截断（管理问题报警，代码不删约定）", () => {
  const many = [];
  for (let i = 0; i < 80; i++) many.push({ id: "pin" + i, content: "规训条目" + i + "的内容占位文本", target: "identity" });
  const res = buildContextBlocks({ pinnedEntries: many, memoriesV2: [] });
  const b = blockOf(res, "core_identity");
  assert.ok(b.tokens > DEFAULT_CONFIG.budgets.core_identity, "如实超预算");
  assert.ok(b.content.includes("规训条目79"), "条目不删");
});

// ============================================================
// [2] Long-term Understanding
// ============================================================
ok("understanding: 只收 fact+active+priority≥0.8；created_at 升序；无日期后缀", () => {
  const res = buildContextBlocks({ memoriesV2: memFull });
  const b = blockOf(res, "long_term_understanding");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("她膝盖受过伤"), "f1 进");
  assert.ok(b.content.includes("她在准备一场重要的考试"), "f2 进");
  assert.ok(!b.content.includes("她喜欢草莓"), "priority 0.5 不进");
  assert.ok(!b.content.includes("她旧作息"), "superseded 不进");
  const i1 = b.content.indexOf("她膝盖受过伤");
  const i2 = b.content.indexOf("她在准备一场重要的考试");
  assert.ok(i1 < i2, "created_at 升序");
});

ok("understanding: 超预算按 priority 升序淘汰（保高 priority，保底 1 条）", () => {
  const mems = [
    { id: "a", text: "甲".repeat(150), kind: "fact", status: "active", priority: 0.9, created_at: "2026-09-01T00:00:00+08:00" },
    { id: "b", text: "乙".repeat(150), kind: "fact", status: "active", priority: 0.82, created_at: "2026-09-02T00:00:00+08:00" },
    { id: "c", text: "丙".repeat(150), kind: "fact", status: "active", priority: 0.81, created_at: "2026-09-03T00:00:00+08:00" },
  ];
  const res = buildContextBlocks({ memoriesV2: mems });
  const b = blockOf(res, "long_term_understanding");
  assert.ok(b.tokens <= DEFAULT_CONFIG.budgets.long_term_understanding, "整块（含 header）预算内");
  assert.ok(b.content.includes("甲"), "priority 最高保留");
  assert.ok(!b.content.includes("丙"), "priority 最低淘汰");
});

// ============================================================
// [3] Meaningful Moments
// ============================================================
ok("moments: pinned anchor+V2 anchor(milestone/quote) 进；非 anchor 不进；事件时间升序；日期后缀", () => {
  const res = buildContextBlocks({ pinnedEntries: pinnedFull, memoriesV2: memFull });
  const b = blockOf(res, "meaningful_moments");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("你是我的锚"), "pinned anchor 进");
  assert.ok(b.content.includes("07-14 我们成为恋人"), "V2 milestone anchor 进");
  assert.ok(!b.content.includes("标签什么的说了就死了"), "非 anchor quote 不进");
  const i恋 = b.content.indexOf("07-14 我们成为恋人");
  const i锚 = b.content.indexOf("你是我的锚");
  assert.ok(i恋 < i锚, "事件时间升序，无时间者排尾");
  assert.ok(/07-14 我们成为恋人（2026-07-14）/.test(b.content), "established_at 日期后缀");
});

ok("moments: 超过 max=5 条按事件时间升序截断保前 5", () => {
  const mems = [];
  for (let i = 1; i <= 7; i++) {
    mems.push({ id: "q" + i, text: "原话第" + i + "条", kind: "quote", status: "active", anchor: true, established_at: "2026-08-0" + i + "T00:00:00+08:00" });
  }
  const res = buildContextBlocks({ memoriesV2: mems });
  const b = blockOf(res, "meaningful_moments");
  assert.ok(b.content.includes("原话第5条") && !b.content.includes("原话第6条"), "保前 5");
});

// ============================================================
// [4] Conversation Continuity（Earlier Days，0918 回归原逻辑）
// ============================================================
ok("continuity: 最近 N=3 篇全量（含最新，不再排除）、时间正序、日期行", () => {
  const res = buildContextBlocks({ diaryEntries: diaryFull });
  const b = blockOf(res, "conversation_continuity");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("（2026-09-11）"), "倒数第 3 篇在");
  assert.ok(b.content.includes("（2026-09-13）"), "最新一篇也注入（0918 回归原逻辑）");
  const i11 = b.content.indexOf("2026-09-11");
  const i13 = b.content.indexOf("2026-09-13");
  assert.ok(i11 < i13, "时间正序呈现");
});

ok("continuity: diaryCount 可配置（=2 时只取最近 2 篇）", () => {
  const res = buildContextBlocks({ diaryEntries: diaryFull, config: { diaryCount: 2 } });
  const b = blockOf(res, "conversation_continuity");
  assert.ok(b.content.includes("2026-09-12") && b.content.includes("2026-09-13"), "最近 2 篇");
  assert.ok(!b.content.includes("2026-09-11"), "更早的不进");
});

ok("continuity: 无日记→空块省略", () => {
  assert.ok(!blockOf(buildContextBlocks({ diaryEntries: [] }), "conversation_continuity"), "空省略");
});

// ============================================================
// [5] Possibly Relevant Memories
// ============================================================
ok("relevant: 词面命中进、无关淘汰（minScore 宁缺毋滥）、日期后缀", () => {
  const res = buildContextBlocks({ memoriesV2: memFull, query: "她对薄荷过敏这件事你知道吗" });
  const b = blockOf(res, "relevant_memories");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("她对薄荷过敏"), "命中条目在");
  assert.ok(!b.content.includes("她养了一只猫"), "无词面交集不硬凑");
  assert.ok(/她对薄荷过敏（2026-09-07）/.test(b.content), "created_at 日期后缀");
});

ok("relevant: 固定块成员去重（核心 fact/rule/anchor/instructions 均不入检索结果）", () => {
  const mems = [
    { id: "core1", text: "她膝盖受过伤", kind: "fact", status: "active", priority: 0.9, created_at: "2026-09-01T00:00:00+08:00" },
    { id: "pool1", text: "她膝盖受伤后的康复训练", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-02T00:00:00+08:00" },
  ];
  const res = buildContextBlocks({ pinnedEntries: [], memoriesV2: mems, query: "她膝盖受伤怎么样了" });
  const u = blockOf(res, "long_term_understanding");
  assert.ok(u && u.content.includes("她膝盖受过伤"), "核心层正常收录");
  const b = blockOf(res, "relevant_memories");
  assert.ok(b, "检索块存在");
  assert.ok(!b.content.includes("她膝盖受过伤"), "固定块成员被去重");
  assert.ok(b.content.includes("康复训练"), "池内条目正常检索");
});

ok("relevant: 空 query→空块；全部无关→空块省略", () => {
  assert.ok(!blockOf(buildContextBlocks({ memoriesV2: memFull }), "relevant_memories"), "无 query 省略");
  assert.ok(!blockOf(buildContextBlocks({ memoriesV2: memFull, query: "xyzabc" }), "relevant_memories"), "全无交集省略");
});

ok("relevant: 排序 score desc → priority 打破并列（同分时 priority 高者前）", () => {
  const mems = [
    { id: "lo", text: "她喜欢喝咖啡", kind: "fact", status: "active", priority: 0.5, created_at: "2026-09-01T00:00:00+08:00" },
    { id: "hi", text: "她喜欢喝可乐", kind: "fact", status: "active", priority: 0.7, created_at: "2026-09-02T00:00:00+08:00" },
  ];
  const res = buildContextBlocks({ memoriesV2: mems, query: "她喜欢喝" });
  const b = blockOf(res, "relevant_memories");
  assert.ok(b, "块应存在");
  const iHi = b.content.indexOf("她喜欢喝可乐");
  const iLo = b.content.indexOf("她喜欢喝咖啡（");
  assert.ok(iHi >= 0 && iLo >= 0, "两条都在");
  assert.ok(iHi < iLo, "同分并列时 priority 高者在前");
});

// ============================================================
// token 估算口径
// ============================================================
ok("estimateTokens: CJK 1 字/token、其余约 4 字符/token（与生产 context-compactor 同口径）", () => {
  assert.strictEqual(estimateTokens("abc"), 1);
  assert.strictEqual(estimateTokens("abcd"), 1);
  assert.strictEqual(estimateTokens("abcde"), 2);
  assert.strictEqual(estimateTokens("她好"), 2);
  assert.strictEqual(estimateTokens("她好ab"), 3);
});

console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
