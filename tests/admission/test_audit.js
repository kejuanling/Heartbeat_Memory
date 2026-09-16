"use strict";

// ========================
// Memory V2 C2 单测：Admission Audit（JSONL 落盘 / 按月滚动 / 哈希 / 只读）
// 运行：node tests/admission/test_audit.js
// 纪律：全部落在 os.tmpdir() 随机目录，不碰生产 data/
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createAuditLogger, hashText } = require("../../admission-audit");

function makeTmpLogger(tag, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-audit-" + tag + "-"));
  const logger = createAuditLogger({ rootDir: tmpDir, dir: "audit", ...opts });
  return { logger, tmpDir, dir: path.join(tmpDir, "audit") };
}

const cases = [
  ["hashText：确定性 + 前缀 + 不同输入不同哈希", () => {
    const h1 = hashText("她喝奶茶只要三分糖");
    const h2 = hashText("她喝奶茶只要三分糖");
    const h3 = hashText("她喜欢半糖");
    assert.strictEqual(h1, h2, "同输入同哈希");
    assert.notStrictEqual(h1, h3);
    assert.ok(h1.startsWith("sha256:") && h1.length === "sha256:".length + 64, "sha256 全长十六进制");
  }],

  ["append：自动建目录建文件、逐行 JSON、含 ts/action", () => {
    const { logger, tmpDir } = makeTmpLogger("append");
    const rec = logger.buildRecord({
      candidateText: "以后不许催我睡觉",
      origin: "manual",
      validator: { allowed: true, matched_rules: [], reasons: [] },
      action: "admit_new",
    });
    const r = logger.append(rec);
    assert.strictEqual(r.ok, true, r.error);
    const f = logger.monthFile();
    assert.ok(fs.existsSync(f), "审计文件已生成");
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.ts, "有时间戳");
    assert.strictEqual(parsed.action, "admit_new");
    assert.ok(parsed.candidate_hash.startsWith("sha256:"));
    assert.strictEqual(parsed.origin, "manual");
    assert.deepStrictEqual(parsed.validator.matched_rules, []);
    assert.ok(!("candidate_text" in parsed), "原始正文不落审计（只留 hash+head）");
    assert.strictEqual(parsed.text_head, "以后不许催我睡觉");
    fs.removeSync(tmpDir);
  }],

  ["append 缺 action 拒绝；多条顺序追加", () => {
    const { logger, tmpDir } = makeTmpLogger("multi");
    assert.strictEqual(logger.append({ candidate_text: "x" }).ok, false, "缺 action 拒绝");
    logger.append(logger.buildRecord({ candidateText: "甲", action: "admit_new" }));
    logger.append(logger.buildRecord({ candidateText: "乙", action: "reject", validator: { allowed: false, matched_rules: ["V1"], reasons: ["隐私"] } }));
    const recent = logger.readRecent(10);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].candidate_text_head_check || recent[0].text_head, "甲");
    assert.strictEqual(recent[1].action, "reject");
    assert.deepStrictEqual(recent[1].validator.matched_rules, ["V1"]);
    fs.removeSync(tmpDir);
  }],

  ["readRecent 容错：坏行不炸、保留 raw 截断", () => {
    const { logger, tmpDir } = makeTmpLogger("badline");
    logger.append(logger.buildRecord({ candidateText: "好的", action: "admit_new" }));
    fs.appendFileSync(logger.monthFile(), "{ 这一行是坏的\n", "utf8");
    const recent = logger.readRecent(10);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[1].unparseable, true);
    assert.ok(recent[1].raw.length <= 200);
    fs.removeSync(tmpDir);
  }],

  ["按月滚动：不同月份落到不同文件", () => {
    const { logger, tmpDir } = makeTmpLogger("roll");
    const fAug = logger.monthFile(new Date("2026-08-15T10:00:00"));
    const fSep = logger.monthFile(new Date("2026-09-15T10:00:00"));
    assert.notStrictEqual(fAug, fSep, "月份不同文件不同");
    assert.ok(fAug.includes("memory_audit_202608.jsonl"), fAug);
    assert.ok(fSep.includes("memory_audit_202609.jsonl"), fSep);
    fs.removeSync(tmpDir);
  }],

  ["readonly：拒绝写入且不产生文件", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-audit-ro-"));
    const logger = createAuditLogger({ rootDir: tmpDir, dir: "audit", readonly: true });
    assert.strictEqual(logger.readonly, true);
    const r = logger.append(logger.buildRecord({ candidateText: "x", action: "admit_new" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, "audit")), false, "只读不产生目录");
    fs.removeSync(tmpDir);
  }],

  ["candidate_hash 与模块级 hashText 一致（跨模块可对账）", () => {
    const { logger, tmpDir } = makeTmpLogger("hash");
    logger.append(logger.buildRecord({ candidateText: "对账文本", action: "review" }));
    const rec = logger.readRecent(1)[0];
    assert.strictEqual(rec.candidate_hash, hashText("对账文本"));
    fs.removeSync(tmpDir);
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
console.log(`\ntest_audit: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
