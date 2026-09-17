"use strict";

// ========================
// Shadow Observation Report（C8 前置）——把 shadow 审计/统计转成可阅读报告
// 只读：扫描 memory_audit_YYYYMM.jsonl，聚合 notes.shadow===true 的记录。
// 零写入、不 require admission/judge/存储层——纯报表。
// 输出（为正式启用 V2 提供观察依据）：
//   1. 每日统计（总数/would_admit/would_reject/would_review/候选数）
//   2. 规则命中排行（validator.matched_rules 聚合）
//   3. would_admit 示例
//   4. review 示例
//   5. 拒绝原因分布
// 用法：node shadow-report.js [--days 7] [--dir data] [--examples 5]
// ========================

const fs = require("fs-extra");
const path = require("path");

function listAuditFiles(dir, days) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("memory_audit_") && f.endsWith(".jsonl"))
    .sort();
  if (days != null) {
    // 取最近 N 天：按文件名月份粗筛（跨月时多取一份当月文件即可覆盖）
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(days));
    const keep = new Set([
      "memory_audit_" + cutoff.getFullYear() + String(cutoff.getMonth() + 1).padStart(2, "0") + ".jsonl",
      "memory_audit_" + new Date().getFullYear() + String(new Date().getMonth() + 1).padStart(2, "0") + ".jsonl",
    ]);
    return files.filter((f) => keep.has(f));
  }
  return files;
}

function loadRecords(dir, files) {
  const records = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.notes && r.notes.shadow === true) records.push(r);
      } catch (_) { /* 坏行容错：报表不因单行损坏中断 */ }
    }
  }
  return records;
}

function dayOf(ts) { return String(ts || "").slice(0, 10); }

// opts: { rootDir?, dir?, days?, examples? }
function buildReport(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const dir = path.resolve(rootDir, opts.dir || "data");
  const days = opts.days != null ? Number(opts.days) : 7;
  const exampleLimit = opts.examples != null ? Number(opts.examples) : 5;

  const files = listAuditFiles(dir, days);
  const all = loadRecords(dir, files);
  // days 过滤（按 ts 日期精确截取）
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);
  const records = all.filter((r) => dayOf(r.ts) >= cutoffStr);
  records.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  // 1. 每日统计
  const dailyMap = new Map();
  for (const r of records) {
    const d = dayOf(r.ts);
    const row = dailyMap.get(d) || { date: d, total: 0, would_admit: 0, would_reject: 0, would_review: 0, other: 0, candidates: 0 };
    row.total++;
    if (r.action === "would_admit" || r.action === "admit") row.would_admit++;
    else if (r.action === "would_reject" || r.action === "reject") row.would_reject++;
    else if (r.action === "would_review" || r.action === "review") row.would_review++;
    else row.other++;
    if (r.validator && r.validator.allowed) row.candidates++;
    dailyMap.set(d, row);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 2. 规则命中排行
  const ruleCount = new Map();
  for (const r of records) {
    const rules = (r.validator && r.validator.matched_rules) || [];
    for (const rule of rules) ruleCount.set(rule, (ruleCount.get(rule) || 0) + 1);
  }
  const rule_hits = [...ruleCount.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);

  // 3/4. 示例
  const would_admit_examples = records.filter((r) => r.action === "would_admit" || r.action === "admit")
    .slice(-exampleLimit)
    .map((r) => ({ ts: r.ts, text_head: r.text_head, kind: (r.notes && r.notes.detector_kind) || null, origin: r.origin, audit_id: r.id }));
  const review_examples = records.filter((r) => r.action === "would_review" || r.action === "review")
    .slice(-exampleLimit)
    .map((r) => ({ ts: r.ts, text_head: r.text_head, kind: (r.notes && r.notes.detector_kind) || null, judge: r.judge ? r.judge.relation : null, audit_id: r.id }));

  // 5. 拒绝原因分布（按规则键聚合计数；DET.not_candidate 单列）
  const rejectMap = new Map();
  let rejected = 0;
  for (const r of records) {
    if (!(r.action === "would_reject" || r.action === "reject")) continue;
    rejected++;
    const rules = (r.validator && r.validator.matched_rules) || [];
    if (!rules.length) { rejectMap.set("(无规则命中)", (rejectMap.get("(无规则命中)") || 0) + 1); continue; }
    for (const rule of rules) rejectMap.set(rule, (rejectMap.get(rule) || 0) + 1);
  }
  const reject_reasons = [...rejectMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // 附加：judge relation 分布（shadow 观察项）
  const judge_relations = {};
  for (const r of records) {
    if (r.judge && r.judge.relation) judge_relations[r.judge.relation] = (judge_relations[r.judge.relation] || 0) + 1;
  }

  return {
    range: { days, from: records.length ? dayOf(records[0].ts) : null, to: records.length ? dayOf(records[records.length - 1].ts) : null },
    total_shadow: records.length,
    daily,
    rule_hits,
    rejected,
    reject_reasons,
    would_admit_examples,
    review_examples,
    judge_relations,
    audit_files: files,
  };
}

function printReport(report) {
  if (!report.total_shadow) {
    console.log("shadow 报告：观察期内暂无 shadow 记录（v2_shadow 未开启或尚无 tag/manual 流量）");
    return;
  }
  console.log(`=== Shadow 观察报告（${report.range.days} 天：${report.range.from} ~ ${report.range.to}，共 ${report.total_shadow} 条）===`);
  console.log("\n[每日统计]");
  console.log("date        total  admit  reject  review  candidates");
  for (const d of report.daily) {
    console.log(`${d.date}  ${String(d.total).padStart(5)}  ${String(d.would_admit).padStart(5)}  ${String(d.would_reject).padStart(6)}  ${String(d.would_review).padStart(6)}  ${String(d.candidates).padStart(10)}`);
  }
  console.log("\n[规则命中排行]");
  for (const h of report.rule_hits) console.log(`  ${h.rule.padEnd(20)} × ${h.count}`);
  console.log("\n[拒绝原因分布]");
  if (!report.reject_reasons.length) console.log("  （无拒绝）");
  for (const r of report.reject_reasons) console.log(`  ${r.reason.padEnd(20)} × ${r.count}`);
  console.log("\n[would_admit 示例]（最近 " + report.would_admit_examples.length + " 条）");
  for (const e of report.would_admit_examples) console.log(`  ${e.ts} [${e.kind || "?"}] ${e.text_head} (${e.audit_id})`);
  console.log("\n[review 示例]（最近 " + report.review_examples.length + " 条）");
  for (const e of report.review_examples) console.log(`  ${e.ts} [${e.kind || "?"}] judge=${e.judge || "?"} ${e.text_head} (${e.audit_id})`);
  const jr = Object.entries(report.judge_relations).map(([k, v]) => `${k}=${v}`).join(", ") || "（无）";
  console.log(`\n[judge relation 分布] ${jr}`);
}

module.exports = { buildReport, printReport, listAuditFiles, loadRecords };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);
  const report = buildReport({
    rootDir: __dirname,
    dir: get("--dir", "data"),
    days: Number(get("--days", 7)),
    examples: Number(get("--examples", 5)),
  });
  printReport(report);
}
