"use strict";

// ========================
// Memory V2 C6 单测：Benchmark Harness 评分逻辑（4 对合成数据，不依赖真实 benchmark 文件）
// 运行：node tests/judge/test_benchmark_runner.js
// ========================

const assert = require("assert");
const { scoreRun, GOLD_MAP } = require("../../benchmark/judge-runner");

const BENCH = [
  // gold=duplicate，两文本完全一致 → mock 判对
  { gold: "dup", A: { text: "只能我先说晚安" }, B: { text: "只能我先说晚安" } },
  // gold=coexist，两文本无关 → mock 判 need_review（错，进混淆矩阵 coexist×need_review）
  { gold: "coexist", A: { text: "她喜欢三分糖" }, B: { text: "网关重启完成" } },
  // gold=update，两文本一致 → mock 判 duplicate（错，进矩阵 update×duplicate）
  { gold: "update", A: { text: "她习惯白天睡" }, B: { text: "她习惯白天睡" } },
  // gold=coexist，候选被既有包含 → mock 判 duplicate（错，属破坏性错误口径）
  { gold: "coexist", A: { text: "她吃东西的爱好：奶黄包、蛋挞、三分糖" }, B: { text: "她喝奶茶只要三分糖" } },
];

(async () => {
  const result = await scoreRun(BENCH, (c, e) => require("../../judge-adapter").judge(c, e, { mode: "mock" }));

  assert.strictEqual(result.total, 4);
  // 正确：第 1 对 duplicate ✓；第 2/3/4 对 ✗ → overall 0.25
  assert.strictEqual(result.correct, 1);
  assert.ok(Math.abs(result.overall - 0.25) < 1e-9, "overall=" + result.overall);

  // 混淆矩阵形状与数值（稀疏列 undefined 视作 0）
  const cell = (g, p) => result.matrix[g][p] || 0;
  assert.strictEqual(cell("duplicate", "duplicate"), 1);
  assert.strictEqual(cell("coexist", "need_review"), 2);
  assert.strictEqual(cell("update", "duplicate"), 1);
  assert.strictEqual(cell("coexist", "duplicate"), 0);

  // 分布
  assert.strictEqual(result.perRelation.duplicate.gold, 1);
  assert.strictEqual(result.perRelation.duplicate.predicted, 2);
  assert.strictEqual(result.perRelation.coexist.gold, 2);
  assert.strictEqual(result.perRelation.need_review.predicted, 2);

  // 分项正确率
  assert.strictEqual(result.perClass.duplicate, 1);
  assert.strictEqual(result.perClass.coexist, 0);
  assert.strictEqual(result.perClass.update, 0);

  // GOLD_MAP 口径
  assert.strictEqual(GOLD_MAP.dup, "duplicate");
  assert.strictEqual(GOLD_MAP.review, "need_review");

  console.log(`PASS benchmark runner 评分逻辑（total=${result.total} overall=${result.overall}）`);
  console.log("test_benchmark_runner: 1 passed, 0 failed（含 12 项断言）");
  process.exit(0);
})();
