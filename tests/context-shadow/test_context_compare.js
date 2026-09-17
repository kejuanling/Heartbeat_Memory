"use strict";

// ========================
// Memory V2 C9 单测：新旧检索影子对比（compareQueries 纯函数，注入 fake 检索器）
// 运行：node tests/context-shadow/test_context_compare.js
// ========================

const assert = require("assert");
const { compareQueries, textKey } = require("../../context-v2-compare");

// fake：旧检索器（旧池口径：返回带 category 的条目）
function fakeOld(buckets) {
  return async (q) => buckets[q] || [];
}
// fake：V2 检索器（v2 口径：返回带 kind 的条目）
function fakeV2(buckets) {
  return async (q) => buckets[q] || [];
}

const OLD = {
  "她喜欢什么甜度": [
    { text: "她喝奶茶只要三分糖", category: "关于她" },
    { text: "她怕黑", category: "关于她" },
    { text: "不许手写工具调用记录", category: "认账" },
  ],
  "只能我先说晚安": [
    { text: "只能我先说晚安", category: "拓本" },
  ],
};

const V2 = {
  "她喜欢什么甜度": [
    { text: "她喝奶茶只要三分糖", kind: "fact", subject: "user" },
    { text: "她怕黑", kind: "fact", subject: "user" },
  ],
  "只能我先说晚安": [
    { text: "只能我先说晚安", kind: "quote", subject: "user" },
  ],
};

const cases = [
  ["逐 query：数量/重叠/独有统计正确", async () => {
    const r = await compareQueries(Object.keys(OLD), fakeOld(OLD), fakeV2(V2));
    assert.strictEqual(r.queries, 2);
    const q1 = r.per_query[0];
    assert.strictEqual(q1.old_count, 3);
    assert.strictEqual(q1.v2_count, 2);
    assert.strictEqual(q1.overlap, 2, "「她喝奶茶只要三分糖」「她怕黑」两边都有");
    assert.strictEqual(q1.old_only, 1, "运维条旧有 v2 无（validator 会拦）");
    assert.strictEqual(q1.v2_only, 0);
    const q2 = r.per_query[1];
    assert.strictEqual(q2.overlap, 1);
    assert.strictEqual(q2.old_only, 0);
    assert.strictEqual(q2.v2_only, 0);
  }],

  ["汇总：平均条数/命中差异/类型分布", async () => {
    const r = await compareQueries(Object.keys(OLD), fakeOld(OLD), fakeV2(V2));
    const s = r.summary;
    assert.strictEqual(s.avg_old_count, 2);
    assert.strictEqual(s.avg_v2_count, 1.5);
    assert.strictEqual(s.avg_overlap, 1.5);
    assert.strictEqual(s.total_old_only, 1);
    assert.strictEqual(s.total_v2_only, 0);
    assert.strictEqual(s.v2_type_distribution.fact, 2);
    assert.strictEqual(s.v2_type_distribution.quote, 1);
    assert.strictEqual(s.old_type_distribution["关于她"], 2);
    assert.strictEqual(s.old_type_distribution["拓本"], 1);
    assert.strictEqual(s.old_type_distribution["认账"], 1);
  }],

  ["空结果：两边都空 → 全零且不炸", async () => {
    const r = await compareQueries(["任意"], fakeOld({}), fakeV2({}));
    assert.strictEqual(r.per_query[0].old_count, 0);
    assert.strictEqual(r.per_query[0].v2_count, 0);
    assert.strictEqual(r.summary.avg_overlap, 0);
  }],

  ["textKey：空白差异视为同一文本（对账稳定）", () => {
    assert.strictEqual(textKey("她 喜欢 三分糖"), textKey("她喜欢三分糖"));
    assert.notStrictEqual(textKey("她喜欢三分糖"), textKey("她喜欢半糖"));
  }],
];

(async () => {
  let passN = 0, failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passN++;
      console.log("PASS " + name);
    } catch (err) {
      failed++;
      console.log("FAIL " + name + " :: " + err.message);
    }
  }
  console.log(`\ntest_context_compare: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
  process.exit(failed ? 1 : 0);
})();
