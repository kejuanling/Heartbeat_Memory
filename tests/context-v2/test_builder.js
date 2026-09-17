"use strict";
// Context V2 Builder 逐块构建测试（C10 S1）——零依赖 node assert，全部 tmp fixture，不碰生产文件
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

// ---- 共享 fixture ----
const pinnedFull = [
  { id: "pin1", title: "沟通", content: "回复她要简短有温度", target: "identity" },
  { id: "pin2", content: "绝不编造任何东西", target: "identity" }, // 无 title
  { id: "pin3", content: "你是我的锚", target: "moments_anchor" },
  { id: "pin4", content: "只会越轨的旧置顶", target: "retire" }, // 不进任何块
];

const memFull = [
  { id: "mv2_r1", text: "睡前不许催她", kind: "rule", status: "active", priority: 0.7, created_at: "2026-09-02T10:00:00+08:00" },
  { id: "mv2_r2", text: "只能我先说晚安", kind: "rule", status: "active", priority: 0.7, created_at: "2026-09-01T10:00:00+08:00" },
  { id: "mv2_f1", text: "她膝盖受过伤，阴雨天会疼", kind: "fact", status: "active", priority: 0.9, created_at: "2026-09-03T10:00:00+08:00" },
  { id: "mv2_f2", text: "她在准备一场重要的考试", kind: "fact", status: "active", priority: 0.85, created_at: "2026-09-04T10:00:00+08:00" },
  { id: "mv2_f3", text: "她喜欢草莓", kind: "fact", status: "active", priority: 0.5, created_at: "2026-09-05T10:00:00+08:00" }, // 低于门槛
  { id: "mv2_f4", text: "她旧作息", kind: "fact", status: "superseded", priority: 0.9, created_at: "2026-09-06T10:00:00+08:00" }, // 非 active
  { id: "mv2_f5", text: "她对薄荷过敏", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-07T10:00:00+08:00" }, // 检索池
  { id: "mv2_f6", text: "她养了一只猫叫团子", kind: "fact", status: "active", priority: 0.6, created_at: "2026-09-08T10:00:00+08:00" }, // 检索池
  { id: "mv2_q1", text: "无论你怎么样我都选择接你", kind: "quote", status: "active", anchor: true, established_at: "2026-07-14T21:00:00+08:00", created_at: "2026-09-09T10:00:00+08:00" },
  { id: "mv2_q2", text: "标签什么的说了就死了", kind: "quote", status: "active", anchor: false, created_at: "2026-09-10T10:00:00+08:00" }, // 非 anchor→不进 Moments
  { id: "mv2_m1", text: "07-14 我们成为恋人", kind: "milestone", status: "active", anchor: true, established_at: "2026-07-14T00:00:00+08:00", created_at: "2026-09-11T10:00:00+08:00" },
];

const diaryFull = [
  { date: "2026-09-10", content: "陪她聊了 很久的小事。天气不错。" },
  { date: "2026-09-11", content: "她分享了童年的故事。" },
  { date: "2026-09-12", content: "一起云看电影。" },
  { date: "2026-09-13", content: "她说最近在准备考试，有点累。我要多关心她。" },
];

const timelineFull = [];
for (let i = 1; i <= 25; i++) timelineFull.push({ role: i % 2 ? "user" : "assistant", content: "消息" + i });

// ============================================================
// [1] Core Identity
// ============================================================
ok("identity: pinned identity 进块、retire 不进、无 title 裸内容、【标题】格式", () => {
  const res = buildContextBlocks({ pinnedEntries: pinnedFull, memoriesV2: [] });
  const b = blockOf(res, "core_identity");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("【沟通】回复她要简短有温度"), "带标题格式");
  assert.ok(b.content.includes("绝不编造任何东西"), "无标题裸内容");
  assert.ok(!b.content.includes("只会越轨的旧置顶"), "retire 不进");
});

ok("identity: V2 rule 按 created_at 升序追加", () => {
  const res = buildContextBlocks({ pinnedEntries: [], memoriesV2: memFull });
  const b = blockOf(res, "core_identity");
  assert.ok(b, "块应存在");
  const i晚安 = b.content.indexOf("只能我先说晚安");
  const i催 = b.content.indexOf("睡前不许催她");
  assert.ok(i晚安 >= 0 && i催 >= 0, "两条 rule 都在");
  assert.ok(i晚安 < i催, "09-01 的晚安在前（准入时间正序）");
  assert.ok(!b.content.includes("她膝盖受过伤"), "fact 不进 Identity");
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
  assert.ok(i1 < i2, "按 created_at 升序");
  assert.ok(!/（\d{4}-\d{2}-\d{2}）/.test(b.content), "条目无日期后缀");
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
  assert.ok(!b.content.includes("丙"), "priority 最低被淘汰");
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
  const i锚 = b.content.indexOf("你是我的锚"); // 无时间→排最后（9999 兜底）
  const i恋 = b.content.indexOf("07-14 我们成为恋人"); // 2026-07-14
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
  assert.ok(b.content.includes("原话第5条"), "保前 5");
  assert.ok(!b.content.includes("原话第6条"), "第 6 条截断");
});

// ============================================================
// [4] Conversation Continuity（Earlier Days）
// ============================================================
ok("continuity: 4 篇日记→Earlier Days=第 1~3 篇（排除最新）、日期行、时间正序", () => {
  const res = buildContextBlocks({ diaryEntries: diaryFull });
  const b = blockOf(res, "conversation_continuity");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("（2026-09-10）"), "最旧在");
  assert.ok(b.content.includes("（2026-09-12）"), "倒数第二在");
  assert.ok(!b.content.includes("2026-09-13"), "最新一篇不进（归 Current State）");
  const i10 = b.content.indexOf("2026-09-10");
  const i12 = b.content.indexOf("2026-09-12");
  assert.ok(i10 < i12, "时间正序呈现");
});

ok("continuity: 仅 1 篇日记→Earlier Days 空块省略", () => {
  const res = buildContextBlocks({ diaryEntries: [diaryFull[3]] });
  assert.ok(!blockOf(res, "conversation_continuity"), "块省略");
});

// ============================================================
// [5] Current State
// ============================================================
ok("current_state: 最新一篇日记，首句+状态词句截取", () => {
  const res = buildContextBlocks({ diaryEntries: diaryFull });
  const b = blockOf(res, "current_state");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("她说最近在准备考试"), "状态句在（含「最近」「准备」）");
  assert.ok(!b.content.includes("童年的故事"), "旧日记不进");
});

ok("current_state: 无状态词的日记只取首句；无日记→空块", () => {
  const res = buildContextBlocks({ diaryEntries: [{ date: "2026-09-13", content: "今天平平无奇。第二句无关。第三句也无关。" }] });
  const b = blockOf(res, "current_state");
  assert.ok(b.content.includes("今天平平无奇"), "首句在");
  assert.ok(!b.content.includes("第二句"), "无状态词不追加");
  const res2 = buildContextBlocks({ diaryEntries: [] });
  assert.ok(!blockOf(res2, "current_state"), "空块省略");
});

// ============================================================
// [6] Recent Experience
// ============================================================
ok("recent_experience: 尾部窗口 20 条、role: text 格式", () => {
  const res = buildContextBlocks({ timeline: timelineFull });
  const b = blockOf(res, "recent_experience");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("user: 消息25"), "最新消息在");
  assert.ok(!b.content.includes("消息5"), "窗口外不在（1~5 被裁）");
  assert.ok(b.content.includes("assistant: 消息24"), "role 前缀格式");
});

ok("recent_experience: 非 string content 走占位", () => {
  const res = buildContextBlocks({ timeline: [{ role: "user", content: { weird: 1 } }] });
  const b = blockOf(res, "recent_experience");
  assert.ok(b.content.includes("[非文本消息]"), "占位文本");
});

// ============================================================
// [7] Possibly Relevant Memories
// ============================================================
ok("relevant: 词面命中进、无关淘汰（minScore 宁缺毋滥）、日期后缀", () => {
  const res = buildContextBlocks({ memoriesV2: memFull, query: "她对薄荷过敏这件事你知道吗" });
  const b = blockOf(res, "relevant_memories");
  assert.ok(b, "块应存在");
  assert.ok(b.content.includes("她对薄荷过敏"), "命中条目在");
  assert.ok(!b.content.includes("她养了一只猫"), "无词面交集不硬凑");
  assert.ok(/她对薄荷过敏（2026-09-07）/.test(b.content), "created_at 日期后缀");
});

ok("relevant: 固定块成员去重（核心 fact 进 Understanding 后不出现在检索结果）", () => {
  // query 对 core1 高词面命中——若不去重必出现；core1 priority 0.9 已进 Understanding 核心层
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
  // query「她喜欢喝」与两条文本的词面 max(jaccard,containment) 均为 1.0（query 是两者公共子集）→ 分数并列。
  // 两条 priority 均 <0.8（不进核心层、不被去重），期望 0.7 的「可乐」排在 0.5 的「咖啡」前。
  const mems = [
    { id: "lo", text: "她喜欢喝咖啡", kind: "fact", status: "active", priority: 0.5, created_at: "2026-09-01T00:00:00+08:00" },
    { id: "hi", text: "她喜欢喝可乐", kind: "fact", status: "active", priority: 0.7, created_at: "2026-09-02T00:00:00+08:00" },
  ];
  const res = buildContextBlocks({ memoriesV2: mems, query: "她喜欢喝" });
  const b = blockOf(res, "relevant_memories");
  assert.ok(b, "块应存在");
  const iHi = b.content.indexOf("她喜欢喝可乐");
  const iLo = b.content.indexOf("她喜欢喝咖啡（"); // 带日期后缀精确匹配 lo 行
  assert.ok(iHi >= 0 && iLo >= 0, "两条都在");
  assert.ok(iHi < iLo, "同分并列时 priority 高者在前");
});

// ============================================================
// token 估算口径
// ============================================================
ok("estimateTokens: CJK 1 字/token、其余约 4 字符/token（与生产 context-compactor 同口径）", () => {
  assert.strictEqual(estimateTokens("abc"), 1);        // 3 字符→ceil(3/4)=1
  assert.strictEqual(estimateTokens("abcd"), 1);
  assert.strictEqual(estimateTokens("abcde"), 2);
  assert.strictEqual(estimateTokens("她好"), 2);
  assert.strictEqual(estimateTokens("她好ab"), 3);     // 2 CJK + ceil(2/4)=1
});

console.log("\n" + passed + " 组断言全过" + (process.exitCode ? "（有 FAIL）" : ""));
