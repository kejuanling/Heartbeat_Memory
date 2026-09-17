"use strict";

// ========================
// Memory V2 C8 前置单测：Shadow Observation Report（合成审计数据，tmp 目录）
// 运行：node tests/shadow-report/test_shadow_report.js
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { buildReport } = require("../../shadow-report");

function makeTmp(tag) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-shadowreport-" + tag + "-"));
  const auditDir = path.join(tmpDir, "data");
  fs.ensureDirSync(auditDir);
  return { tmpDir, auditDir };
}

function line(over = {}) {
  return JSON.stringify({
    id: "aud_" + Math.random().toString(36).slice(2, 8),
    ts: over.ts || "2026-09-17T12:00:00+08:00",
    candidate_hash: "sha256:deadbeef",
    text_head: over.text_head || "样本",
    origin: over.origin || "memory_tag",
    validator: over.validator || { allowed: true, matched_rules: [], reasons: [] },
    judge: over.judge || null,
    action: over.action || "would_admit",
    notes: { shadow: true, tag: true, detector_kind: over.kind || "fact", ...(over.notes || {}) },
  });
}

// 合成数据：3 天 10 条
const ROWS = [
  // 09-16：admit ×2（含一条 manual shadow）、reject ×1（V1 隐私）
  line({ ts: "2026-09-16T10:00:00+08:00", action: "would_admit", text_head: "她喜欢三分糖", kind: "fact" }),
  line({ ts: "2026-09-16T11:00:00+08:00", origin: "manual", action: "admit", text_head: "她习惯睡前看书", kind: "fact" }),
  line({ ts: "2026-09-16T12:00:00+08:00", action: "would_reject", text_head: "她手机13812345678开机", validator: { allowed: false, matched_rules: ["V1"], reasons: ["V1 隐私"] } }),
  // 09-17：review（quote）×1、reject（非候选）×2、admit ×1、judge need_review
  line({ ts: "2026-09-17T08:00:00+08:00", action: "would_review", text_head: "涵：「只能我先说晚安」", kind: "quote", judge: { relation: "need_review", confidence: 0.5 } }),
  line({ ts: "2026-09-17T09:00:00+08:00", action: "would_reject", text_head: "今天好累", validator: { allowed: false, matched_rules: ["DET.not_candidate"], reasons: ["非候选"] } }),
  line({ ts: "2026-09-17T10:00:00+08:00", action: "would_reject", text_head: "去超市", validator: { allowed: false, matched_rules: ["DET.not_candidate"], reasons: ["非候选"] } }),
  line({ ts: "2026-09-17T11:00:00+08:00", action: "would_admit", text_head: "她怕黑", kind: "fact", judge: { relation: "need_review", confidence: 0.5 } }),
  // 非 shadow 记录（不应计入）
  { ...JSON.parse(line({ ts: "2026-09-17T12:00:00+08:00", action: "admit", text_head: "正式非影子" })), notes: { shadow: false } },
  // 坏行（不应中断）
];

(async () => {
  const { tmpDir, auditDir } = makeTmp("build");
  const f = path.join(auditDir, "memory_audit_202609.jsonl");
  // ROWS 里既有 line() 产出的 JSON 字符串、也有对象行：字符串原样写入，对象才序列化
  const content = ROWS.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n" + "{ broken line\n";
  fs.writeFileSync(f, content, "utf8");

  const report = buildReport({ rootDir: tmpDir, dir: "data", days: 7 });

  // 总量：非 shadow 与坏行不计
  assert.strictEqual(report.total_shadow, 7, "total_shadow=" + report.total_shadow);

  // 每日统计
  assert.strictEqual(report.daily.length, 2);
  const d16 = report.daily.find((x) => x.date === "2026-09-16");
  const d17 = report.daily.find((x) => x.date === "2026-09-17");
  assert.ok(d16 && d17, "两天都有聚合");
  assert.strictEqual(d16.total, 3);
  assert.strictEqual(d16.would_admit, 2, "manual admit 计入 admit 口径");
  assert.strictEqual(d16.would_reject, 1);
  assert.strictEqual(d17.would_review, 1);
  assert.strictEqual(d17.would_reject, 2);
  assert.strictEqual(d17.candidates, 2, "09-17 两条 validator allowed");

  // 规则命中排行：DET.not_candidate ×2 > V1 ×1
  assert.strictEqual(report.rule_hits[0].rule, "DET.not_candidate");
  assert.strictEqual(report.rule_hits[0].count, 2);
  assert.ok(report.rule_hits.some((h) => h.rule === "V1" && h.count === 1));

  // 拒绝原因分布：3 条拒绝（DET×2 + V1×1）
  assert.strictEqual(report.rejected, 3);
  assert.strictEqual(report.reject_reasons[0].reason, "DET.not_candidate");
  assert.strictEqual(report.reject_reasons[0].count, 2);

  // 示例
  assert.strictEqual(report.would_admit_examples.length, 3, "admit 示例（含 manual admit）");
  assert.strictEqual(report.would_admit_examples[report.would_admit_examples.length - 1].text_head, "她怕黑");
  assert.strictEqual(report.review_examples.length, 1);
  assert.strictEqual(report.review_examples[0].text_head, "涵：「只能我先说晚安」");

  // judge 分布
  assert.strictEqual(report.judge_relations.need_review, 2);

  // 空数据
  const empty = buildReport({ rootDir: tmpDir, dir: "nope", days: 7 });
  assert.strictEqual(empty.total_shadow, 0);
  assert.deepStrictEqual(empty.daily, []);

  console.log("PASS buildReport：每日聚合/规则排行/拒绝分布/示例/judge 分布/空数据/坏行容错（16 断言组）");
  console.log("test_shadow_report: 1 passed, 0 failed");
  fs.removeSync(tmpDir);
  process.exit(0);
})();
