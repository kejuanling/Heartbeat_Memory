"use strict";

// ========================
// Memory Admission Pipeline（C4）——流程编排，不含业务规则
// 流程（17.txt）：input → candidate_detector → provenance_builder → validator
//   → 决策 → state_executor（唯一写手）→ audit（记最终动作）
// C4 范围：只接 manual 入口（shadow 影子写入，旧池完全不动）；
//   memory_tag / mcp / compaction / 注入层 一律未接。
// 决策策略（无 judge 的保守默认，业务语义见 14.txt）：
//   detector 非候选 → reject；validator 硬规则命中 → reject；
//   quote 候选 → review（原话无复核不自动入库）；其余通过 → admit。
// 输出契约：{ action, candidate, validation, audit_id }
// ========================

const fs = require("fs-extra");
const path = require("path");
const { detect } = require("./candidate-detector");
const { buildProvenance } = require("./provenance-builder");
const { validate } = require("./admission-validator");
const { createAuditLogger } = require("./admission-audit");
const { createStore, DEFAULT_CONFIG } = require("./memory-v2");
const { createStateExecutor } = require("./state-executor");

// 旧池 category → V2 kind/subject 翻译（manual 兼容层专用；未映射类别交 detector 自判）
const CATEGORY_MAP = {
  "关于她": { kind: "fact", subject: "user" },
  "认账": { kind: "rule", subject: "self", direction: "self_discipline" },
  "拓本": { kind: "quote", subject: "user", speaker: "user" },
};

function readConfigFile(file) {
  try {
    return fs.readJsonSync(file);
  } catch (_) {
    return null; // 配置缺失/坏损回退默认；坏损不该阻塞（与存储层数据不同级）
  }
}

function mergeCfg(base, overrides) {
  const out = { ...base };
  if (!overrides) return out;
  for (const k of Object.keys(overrides)) {
    if (k === "paths" && overrides.paths && typeof overrides.paths === "object") {
      out.paths = { ...(base.paths || {}), ...overrides.paths };
    } else if (k === "defaults" && overrides.defaults && typeof overrides.defaults === "object") {
      out.defaults = { ...(base.defaults || {}), ...overrides.defaults };
    } else {
      out[k] = overrides[k];
    }
  }
  return out;
}

// opts: { rootDir?, config?, shadow? }（shadow=true 强制影子模式，测试用；默认读配置 v2_shadow）
function createAdmission(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const fileCfg = readConfigFile(path.join(rootDir, "data", "memory_v2_config.json"));
  const cfg = mergeCfg(mergeCfg(DEFAULT_CONFIG, fileCfg), opts.config || null);
  const shadowForced = opts.shadow != null ? !!opts.shadow : null;
  const shadowOn = shadowForced != null ? shadowForced : cfg.v2_shadow === true;

  // 主集合：本阶段不写（旧池+旧路由照旧）；实例仅用于守卫/读侧预留
  const mainStore = createStore({ rootDir, config: { paths: cfg.paths } });
  // 影子集合/队列：shadow 模式的全部落点
  const shadowStore = createStore({
    rootDir,
    config: { paths: { collection: cfg.paths.shadow_collection, review_queue: cfg.paths.shadow_queue } },
  });
  const executor = createStateExecutor({ store: shadowStore, queuePath: shadowStore.paths.review_queue });
  const audit = createAuditLogger({ rootDir, dir: "data" });

  // manual 适配器：兼容旧 POST /admin/memory-pool body {content, category, importance}
  // 兼容策略（17.txt §5.1）：旧路由一行不动，本适配器只做影子写入——单轨制之下旧池零接触。
  function submitManual(body, ctx = {}) {
    if (!shadowOn) {
      // C4 只做影子写入；v2_shadow 关闭时整条链路跳过（正式 admit 通道属 C5/C7 的 v2_enabled 门）
      return { action: "skipped_shadow_off", candidate: null, validation: null, audit_id: null };
    }
    const b = body || {};
    const text = strSafe(b.content || b.text);
    if (!text) {
      return { action: "reject", candidate: null, validation: { allowed: false, matched_rules: ["V6"], reasons: ["V6 text 为空"] }, audit_id: null, notes: "content 为空" };
    }
    const mapped = CATEGORY_MAP[b.category] || null;

    // [1] candidate_detector（manual 显式类别优先，否则自动粗分）
    const detection = detect({ text, source: "manual", explicitKind: mapped ? mapped.kind : b.kind, explicitSubject: mapped ? mapped.subject : b.subject });

    // [2] provenance_builder（manual：无 session/msg → null，不伪造）
    const provenance = buildProvenance({
      origin: "manual",
      method: "admin_form",
      sessionId: strSafe(ctx.sessionId),
      msgId: strSafe(ctx.msgId),
    });
    if (strSafe(b.quote)) provenance.quote = String(b.quote).slice(0, 200);

    // [3] validator（仅真实候选类别需要校验；非候选直接走拒绝）
    let validation = null;
    if (detection.candidate) {
      validation = validate({
        text,
        kind: detection.kind_guess,
        subject: detection.subject_guess,
        origin: "manual",
        speaker: mapped ? mapped.speaker || null : null,
        direction: mapped ? mapped.direction || null : null,
        provenance,
        source: "manual",
      });
    } else {
      validation = { allowed: false, matched_rules: ["DET.not_candidate"], reasons: detection.reasons.slice() };
    }

    // [4] 决策（纯编排策略，无业务规则）
    const { action, why } = decide(detection, validation);

    // [5] state_executor（shadow 模式全部落在影子集合/队列）
    let execResult;
    const draft = {
      text,
      kind: detection.kind_guess,
      subject: detection.subject_guess,
      direction: mapped ? mapped.direction || null : null,
      speaker: mapped ? mapped.speaker || null : null,
      origin: "manual",
      provenance,
    };
    if (b.importance != null && Number.isFinite(Number(b.importance))) {
      draft.confidence = Math.max(0, Math.min(1, Number(b.importance)));
    }
    if (b.established_at) draft.established_at = String(b.established_at);

    if (action === "admit") execResult = executor.admit(draft);
    else if (action === "review") execResult = executor.review(draft, why);
    else execResult = executor.reject(draft, why);

    // [6] audit（记最终动作；shadow 标记在场）
    const finalAction = execResult.ok ? action : "error";
    const auditRec = audit.append(audit.buildRecord({
      candidateText: text,
      origin: "manual",
      validator: validation,
      action: finalAction,
      notes: { shadow: true, detector_kind: detection.kind_guess, why, queue_id: execResult.queue_id || null, entry_id: execResult.entry ? execResult.entry.id : null },
    }));

    return {
      action: finalAction,
      candidate: { text, kind: detection.kind_guess, subject: detection.subject_guess, detector: detection, provenance },
      validation,
      audit_id: auditRec.ok ? auditRec.id : null,
      entry_id: execResult.entry ? execResult.entry.id : null,
      queue_id: execResult.queue_id || null,
    };
  }

  return { cfg, shadowOn, submitManual, executor, audit, paths: { main: mainStore.paths, shadow: shadowStore.paths } };
}

function decide(detection, validation) {
  if (!detection.candidate) return { action: "reject", why: "detector 非候选（" + detection.kind_guess + "）" };
  if (!validation.allowed) return { action: "reject", why: "validator 硬规则命中: " + validation.matched_rules.join("/") };
  if (detection.kind_guess === "quote") return { action: "review", why: "quote 无 judge 复核，保守进人工" };
  return { action: "admit", why: "校验通过" };
}

function strSafe(v) { return v == null ? null : String(v); }

module.exports = { createAdmission, decide, CATEGORY_MAP };
