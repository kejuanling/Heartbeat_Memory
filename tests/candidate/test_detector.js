"use strict";

// ========================
// Memory V2 C3 单测：Candidate Detector（36 例）
// 运行：node tests/candidate/test_detector.js
// 边界契约：detector 只发现候选，不决定入库；diary_only/history_only/unknown → candidate=false
// ========================

const assert = require("assert");
const { detect } = require("../../candidate-detector");

function d(text, source, extra = {}) {
  return detect({ text, source, ...extra });
}

const cases = [
  // ---- fact（6）----
  ["fact：chat_user「我喜欢猫」→ fact·user", () => {
    const r = d("我喜欢猫", "chat_user");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
    assert.strictEqual(r.subject_guess, "user");
  }],
  ["fact：chat_ai「她喜欢吃辣」→ fact·user", () => {
    const r = d("她喜欢吃辣", "chat_ai");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
    assert.strictEqual(r.subject_guess, "user");
  }],
  ["fact：chat_user「我住在杭州」→ fact·user", () => {
    const r = d("我住在杭州", "chat_user");
    assert.strictEqual(r.kind_guess, "fact");
    assert.strictEqual(r.subject_guess, "user");
  }],
  ["fact：chat_ai「她怕黑」→ fact·user", () => {
    const r = d("她怕黑", "chat_ai");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
  }],
  ["fact：chat_user「我对芒果过敏」→ fact·user", () => {
    const r = d("我对芒果过敏", "chat_user");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
  }],
  ["fact：chat_ai「她妈是老师，从小对她很严」→ fact·user（亲属+是）", () => {
    const r = d("她妈是老师，从小对她很严", "chat_ai");
    assert.strictEqual(r.candidate, true, JSON.stringify(r));
    assert.strictEqual(r.kind_guess, "fact");
    assert.strictEqual(r.subject_guess, "user");
  }],

  // ---- rule（5）----
  ["rule：chat_user「以后不许催我睡觉」→ rule·user", () => {
    const r = d("以后不许催我睡觉", "chat_user");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "rule");
    assert.strictEqual(r.subject_guess, "user");
  }],
  ["rule：chat_user「以后不要这样回答」→ rule·user", () => {
    const r = d("以后不要这样回答", "chat_user");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "rule");
    assert.strictEqual(r.subject_guess, "user");
  }],
  ["rule：chat_user「我保证再也不编造了」→ rule·self（自承诺）", () => {
    const r = d("我保证再也不编造了", "chat_user");
    assert.strictEqual(r.kind_guess, "rule");
    assert.strictEqual(r.subject_guess, "self");
  }],
  ["rule：chat_ai「以后我要少写废话」→ rule·self", () => {
    const r = d("以后我要少写废话", "chat_ai");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "rule");
    assert.strictEqual(r.subject_guess, "self");
  }],
  ["rule：chat_user「每次都要先跟我确认」→ rule·user", () => {
    const r = d("每次都要先跟我确认", "chat_user");
    assert.strictEqual(r.kind_guess, "rule");
    assert.strictEqual(r.subject_guess, "user");
  }],

  // ---- 1002-14：quote / milestone 两类已删，原话与里程碑信号不再产出这两类 ----
  ["1002-14：「记住我说过：我是你的锚」不再判 quote", () => {
    const r = d("记住我说过：我是你的锚", "chat_user");
    assert.notStrictEqual(r.kind_guess, "quote", "quote 分类已删");
    assert.notStrictEqual(r.kind_guess, "milestone", "milestone 分类已删");
  }],
  ["1002-14：chat_ai 引文「她说「标签什么的，说了就死了」」不再判 quote", () => {
    const r = d("她说「标签什么的，说了就死了」", "chat_ai");
    assert.notStrictEqual(r.kind_guess, "quote");
  }],
  ["1002-14：「记住这句话：无论你怎么样我都接你」不再判 quote", () => {
    const r = d("记住这句话：无论你怎么样我都接你", "chat_user");
    assert.notStrictEqual(r.kind_guess, "quote");
  }],
  ["1002-14：「今天是我们第一次视频通话」不再判 milestone", () => {
    const r = d("今天是我们第一次视频通话", "chat_ai");
    assert.notStrictEqual(r.kind_guess, "milestone");
    assert.notStrictEqual(r.kind_guess, "quote");
  }],
  ["1002-14：「7月14号我们正式在一起了」不再判 milestone", () => {
    const r = d("7月14号我们正式在一起了", "chat_ai");
    assert.notStrictEqual(r.kind_guess, "milestone");
  }],
  ["1002-14：「今天是我们的两个月纪念日」不再判 milestone", () => {
    const r = d("今天是我们的两个月纪念日", "chat_user");
    assert.notStrictEqual(r.kind_guess, "milestone");
  }],

  // ---- diary_only（3）----
  ["diary_only：chat_user「今天好累啊」→ 不产候选", () => {
    const r = d("今天好累啊", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "diary_only");
  }],
  ["diary_only：chat_user「我现在有点困」→ 不产候选", () => {
    const r = d("我现在有点困", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "diary_only");
  }],
  ["diary_only：chat_user「今天心情不好，不想说话」→ 不产候选", () => {
    const r = d("今天心情不好，不想说话", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "diary_only");
  }],

  // ---- history_only（2）----
  ["history_only：source=summary 直达历史层", () => {
    const r = d("8月14日下午聊了X", "summary");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "history_only");
  }],
  ["history_only：多日期罗列正文 → 不产候选", () => {
    const r = d("8月14日下午她发了截图，8月15日早上又聊了哲学", "chat_ai");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "history_only");
  }],

  // ---- 普通闲聊 / 玩笑（3）----
  ["闲聊：「哈哈哈你是笨蛋」→ 不产候选", () => {
    const r = d("哈哈哈你是笨蛋", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "unknown");
  }],
  ["闲聊：「晚安」→ 不产候选", () => {
    const r = d("晚安", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "unknown");
  }],
  ["闲聊：「哈哈哈哈哈」→ 不产候选", () => {
    const r = d("哈哈哈哈哈", "chat_user");
    assert.strictEqual(r.candidate, false);
  }],

  // ---- 边界（9）----
  ["边界：source=tool_output 不产候选（与 V5 同源）", () => {
    const r = d("她喜欢猫", "tool_output");
    assert.strictEqual(r.candidate, false);
  }],
  ["边界：source=diary → diary_only", () => {
    const r = d("我陪她看了一下午云", "diary");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "diary_only");
  }],
  ["边界：manual 显式 kind 直通（0.95）", () => {
    const r = d("她叫涵", "manual", { explicitKind: "fact" });
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
    assert.strictEqual(r.confidence, 0.95);
  }],
  ["边界：空文本 → false/unknown", () => {
    const r = d("", "chat_user");
    assert.strictEqual(r.candidate, false);
    assert.strictEqual(r.kind_guess, "unknown");
  }],
  ["边界：弱确定性「她好像喜欢拍照」→ fact 候选但置信 ≤0.5", () => {
    const r = d("她好像喜欢拍照", "chat_ai");
    assert.strictEqual(r.candidate, true);
    assert.strictEqual(r.kind_guess, "fact");
    assert.ok(r.confidence <= 0.5, "hedge 应降置信: " + r.confidence);
  }],
  ["边界：裸「第一次吃日料」无关系上下文 → 不当里程碑", () => {
    const r = d("第一次吃日料", "chat_user");
    assert.notStrictEqual(r.kind_guess, "milestone", "裸第一次不该成里程碑");
  }],
  ["边界：长篇第一人称叙事 → diary_only 不产候选", () => {
    const t = "我想记下此刻的心情，我不想再把我关起来。".repeat(11);
    assert.ok(t.length >= 200);
    const r = d(t, "chat_ai");
    assert.strictEqual(r.candidate, false, JSON.stringify(r));
    assert.strictEqual(r.kind_guess, "diary_only");
  }],
  ["边界：输出契约五键齐备且枚举合法", () => {
    const r = d("她喜欢猫", "chat_ai");
    assert.deepStrictEqual(Object.keys(r).sort(), ["candidate", "confidence", "kind_guess", "reasons", "subject_guess"]);
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }],
  ["边界：reasons 有内容（信号可解释）", () => {
    const r = d("她习惯睡前看书", "chat_ai");
    assert.ok(r.reasons.some((x) => x.includes("稳定谓词")), JSON.stringify(r.reasons));
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
console.log(`\ntest_detector: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
