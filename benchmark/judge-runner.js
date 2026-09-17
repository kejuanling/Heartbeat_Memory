"use strict";

// ========================
// Benchmark Harness（C6）——Judge 跑分器
// 用法：node benchmark/judge-runner.js <benchmark.json> [--mode mock|llm]
//   llm 模式需要 --callLLM <module 路径>（导出 async callLLM(prompt, attempt)）；本轮只交付 mock 跑分。
// 数据格式（benchmark_112.json）：[{ gold:"dup|coexist|...", A:{text}, B:{text}, ... }]
//   A=既有，B=候选（Round 2/3 约定：B 为较新/较全一侧）。
// 输出（16.txt §八）：overall accuracy / 各 relation 分布 / confusion matrix（gold × predicted）
// 门槛说明：overall ≥82% 仅对 llm 模式强制（mock 无语义能力，跑分只验证 harness 与给出基线）。
// ========================

const fs = require("fs-extra");
const path = require("path");
const { judge } = require("../judge-adapter");

const GOLD_MAP = {
  dup: "duplicate", duplicate: "duplicate",
  update: "update",
  contradiction: "contradiction",
  coexist: "coexist", co: "coexist",
  need_review: "need_review", review: "need_review",
};
const RELATIONS = ["duplicate", "update", "contradiction", "coexist", "need_review"];

function loadBench(file) {
  const arr = fs.readJsonSync(file);
  if (!Array.isArray(arr)) throw new Error("benchmark 必须是数组: " + file);
  return arr.filter((row) => row && row.gold != null && row.A && row.B);
}

// judgeFn: async (candidateText, existingText) => {relation,...}
async function scoreRun(bench, judgeFn) {
  const matrix = {};
  for (const g of RELATIONS) matrix[g] = {};
  let total = 0, correct = 0;
  const perRelation = {};
  for (const row of bench) {
    const gold = GOLD_MAP[String(row.gold).toLowerCase()] || "need_review";
    const r = await judgeFn(String((row.B || {}).text || ""), String((row.A || {}).text || ""));
    const pred = RELATIONS.includes(r.relation) ? r.relation : "need_review";
    matrix[gold][pred] = (matrix[gold][pred] || 0) + 1;
    perRelation[gold] = perRelation[gold] || { gold: 0, predicted: 0, correct: 0 };
    perRelation[gold].gold++;
    perRelation[pred] = perRelation[pred] || { gold: 0, predicted: 0, correct: 0 };
    perRelation[pred].predicted++;
    total++;
    if (pred === gold) { correct++; perRelation[gold].correct++; }
  }
  const perClass = {};
  for (const g of RELATIONS) {
    if (perRelation[g] && perRelation[g].gold > 0) {
      perClass[g] = perRelation[g].correct / perRelation[g].gold;
    }
  }
  return { total, correct, overall: total ? correct / total : 0, matrix, perRelation, perClass };
}

function printReport(result) {
  console.log(`total=${result.total} correct=${result.correct} overall=${(result.overall * 100).toFixed(1)}%`);
  console.log("\n各 relation 分布（gold 数 / 被判为数该类次数 / 该类正确率）:");
  for (const g of RELATIONS) {
    const p = result.perRelation[g];
    if (!p) continue;
    const acc = p.gold ? ((p.correct / p.gold) * 100).toFixed(1) + "%" : "-";
    console.log(`  ${g.padEnd(13)} gold=${String(p.gold).padStart(3)}  predicted=${String(p.predicted).padStart(3)}  per-class-acc=${acc}`);
  }
  console.log("\nconfusion matrix（行=gold，列=predicted）:");
  const head = "gold\\pred    " + RELATIONS.map((r) => r.slice(0, 8).padStart(9)).join("");
  console.log(head);
  for (const g of RELATIONS) {
    const cells = RELATIONS.map((p) => String(result.matrix[g][p] || 0).padStart(9));
    console.log(g.padEnd(12) + cells.join(""));
  }
  const breaking = (result.matrix.coexist.duplicate || 0) + (result.matrix.coexist.update || 0);
  console.log(`\n破坏性错误（gold=coexist 被判 duplicate/update）: ${breaking} —— llm 模式门槛 ≤2%（${Math.ceil(result.total * 0.02)} 例）`);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "mock";
  if (!file) {
    console.error("用法: node benchmark/judge-runner.js <benchmark.json> [--mode mock|llm] [--callLLM <module>]");
    process.exit(2);
  }
  let judgeFn;
  if (mode === "mock") {
    judgeFn = (c, e) => judge(c, e, { mode: "mock" });
  } else if (mode === "llm") {
    const callIdx = args.indexOf("--callLLM");
    const modPath = callIdx >= 0 ? args[callIdx + 1] : null;
    if (!modPath) { console.error("llm 模式需要 --callLLM <module>（导出 async callLLM(prompt, attempt)）"); process.exit(2); }
    const mod = require(path.resolve(modPath));
    judgeFn = (c, e) => judge(c, e, { mode: "llm", callLLM: mod.callLLM });
  } else {
    console.error("未知 mode: " + mode);
    process.exit(2);
  }
  const bench = loadBench(file);
  console.log(`benchmark: ${file}（${bench.length} 对，mode=${mode}）`);
  const result = await scoreRun(bench, judgeFn);
  printReport(result);
  if (mode === "llm") {
    const pass = result.overall >= 0.82;
    console.log(`\nllm 门槛 overall ≥82%: ${pass ? "达标" : "未达标"}`);
    if (!pass) process.exit(1);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { loadBench, scoreRun, printReport, GOLD_MAP };
