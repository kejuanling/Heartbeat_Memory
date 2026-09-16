"use strict";

// ========================
// Admission Audit（C2）——准入审计（append-only JSONL，按月滚动）
// 职责（15.txt）：记录 candidate hash/id、规则结果、judge 结果、最终动作、时间戳。
// 纪律（14.txt）：审计断链视同 P0——写失败重试+告警，但绝不静默丢；审计文件永不清理。
// 本模块只写审计文件（memory_audit_YYYYMM.jsonl），不触碰任何 Memory 集合。
// ========================

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { nowIso } = require("./time_utils");
// 候选正文指纹（候选还不是 memory 时以此作为身份锚点；同一 text 恒同哈希，可跨月追查）
function hashText(text) {
  return "sha256:" + crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// opts: { rootDir?, dir?（相对 rootDir，默认 data）, readonly? }
function createAuditLogger(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const dir = path.resolve(rootDir, opts.dir || "data");
  const readonly = !!opts.readonly;

  function monthFile(d) {
    const date = d || new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return path.join(dir, `memory_audit_${y}${m}.jsonl`);
  }

  // append 一条审计。字段约定（15.txt）：
  //   candidate_id?（写入后有）, candidate_text（内部转 hash+head）, origin?,
  //   validator?: {allowed, matched_rules, reasons}, judge?, action（最终动作，必填）, notes?
  function append(record) {
    if (readonly) return { ok: false, error: "readonly" };
    if (!record || record.action == null) return { ok: false, error: "audit 缺少 action" };
    const id = "aud_" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
    const { candidate_text, ...rest } = record;
    const line = JSON.stringify({
      id,
      ts: nowIso(),
      candidate_hash: hashText(candidate_text),
      text_head: String(candidate_text || "").slice(0, 50),
      ...rest,
    });
    fs.ensureDirSync(dir);
    fs.appendFileSync(monthFile(), line + "\n", "utf8");
    return { ok: true, id };
  }

  // 组装标准审计记录（不含时间戳——append 落笔时统一打）
  function buildRecord({ candidateId = null, candidateText = "", origin = null, validator = null, judge = null, action, notes = null }) {
    return {
      candidate_id: candidateId,
      candidate_text: candidateText,
      origin,
      validator: validator
        ? { allowed: validator.allowed, matched_rules: validator.matched_rules, reasons: validator.reasons }
        : null,
      judge: judge || null,
      action,
      notes,
    };
  }

  // 读当月最近 N 条（管理台预览/测试用；坏行容错保留原文截断，不丢证据）
  function readRecent(limit = 20) {
    const f = monthFile();
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return { ts: null, unparseable: true, raw: l.slice(0, 200) };
      }
    });
  }

  return { append, buildRecord, readRecent, hashText, monthFile, dir, readonly };
}

module.exports = { createAuditLogger, hashText };
