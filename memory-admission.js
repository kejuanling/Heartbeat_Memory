"use strict";

// ========================
// Memory Admission Pipeline（C4/C5）——流程编排，不含业务规则
// 流程（17.txt）：input → candidate_detector → provenance_builder → validator
//   → 决策 → state_executor（唯一写手）→ audit（记最终动作）
// C5 门控语义（v2_enabled × v2_shadow）：
//   v2_enabled=true  → 正式路径：旧池继续写（旧路由恒写，兼容承诺），V2 写主集合/主队列
//   v2_enabled=false + v2_shadow=true → 影子观察：V2 只写影子集合/队列，旧池照旧
//   两者皆 false     → V2 完全跳过（skipped_v2_off），旧池行为不变
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

  // 主集合/主队列：v2_enabled=true 的正式落点（本阶段默认关闭）
  const mainStore = createStore({ rootDir, config: { paths: cfg.paths } });
  const mainExecutor = createStateExecutor({ store: mainStore, queuePath: mainStore.paths.review_queue });
  // 影子集合/队列：shadow 观察模式的全部落点
  const shadowStore = createStore({
    rootDir,
    config: { paths: { collection: cfg.paths.shadow_collection, review_queue: cfg.paths.shadow_queue } },
  });
  const shadowExecutor = createStateExecutor({ store: shadowStore, queuePath: shadowStore.paths.review_queue });
  const audit = createAuditLogger({ rootDir, dir: "data" });

  // manual 适配器：兼容旧 POST /admin/memory-pool body {content, category, importance}
  // 兼容策略：旧路由恒写旧池（v2_enabled=true 也不停）；本适配器只负责 V2 侧落点。
  function submitManual(body, ctx = {}, mode = "shadow") {
    const formal = mode === "formal";
    if (!formal && !shadowOn) {
      // 影子观察未开启时跳过（正式 admit 通道只经 submitV2 的 v2_enabled 门进入）
      return { action: "skipped_shadow_off", candidate: null, validation: null, audit_id: null };
    }
    const exec = formal ? mainExecutor : shadowExecutor;
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

    // [5] state_executor（唯一写手）+ audit
    //     review 路径先落审计拿 audit_id（队列记录要回链）；admit/reject 执行后记最终动作
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

    let execResult, auditRec;
    if (action === "review") {
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: "manual", validator: validation, action: "review",
        notes: { shadow: !formal, detector_kind: detection.kind_guess, why },
      }));
      execResult = exec.review(draft, why, {
        auditId: auditRec.ok ? auditRec.id : null,
        details: validation.reasons,
      });
    } else if (action === "admit") {
      execResult = exec.admit(draft);
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: "manual", validator: validation,
        action: execResult.ok ? "admit" : "error",
        notes: { shadow: !formal, detector_kind: detection.kind_guess, why, entry_id: execResult.entry ? execResult.entry.id : null, error: execResult.error || null },
      }));
    } else {
      execResult = exec.reject(draft, why);
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: "manual", validator: validation, action: "reject",
        notes: { shadow: !formal, detector_kind: detection.kind_guess, why },
      }));
    }

    return {
      action: execResult.ok ? action : "error",
      candidate: { text, kind: detection.kind_guess, subject: detection.subject_guess, detector: detection, provenance },
      validation,
      audit_id: auditRec.ok ? auditRec.id : null,
      entry_id: execResult.entry ? execResult.entry.id : null,
      queue_id: execResult.queue_id || null,
      mode: formal ? "formal" : "shadow",
    };
  }

  // V2 门控（挂旧路由钩子用）：enabled → 正式；shadow → 观察；皆关 → 跳过
  function submitV2(body, ctx = {}) {
    if (cfg.v2_enabled === true) return submitManual(body, ctx, "formal");
    if (cfg.v2_shadow === true) return submitManual(body, ctx, "shadow");
    return { action: "skipped_v2_off", candidate: null, validation: null, audit_id: null };
  }

  // 人工裁决回流（review 路由用）：裁决动作本身也进审计
  function resolveReview(queueId, decision, opts2 = {}) {
    const r = mainExecutor.resolveQueue(queueId, decision, opts2);
    const candidateText = r.resolved && r.resolved.draft ? r.resolved.draft.text : "";
    audit.append(audit.buildRecord({
      candidateText,
      origin: "manual",
      action: r.ok ? (decision === "approve" ? "review_approved" : "review_rejected") : "error",
      notes: { queue_id: queueId, decision, note: strSafe(opts2.note), error: r.error || null },
    }));
    return r;
  }

  return {
    cfg,
    shadowOn,
    submitManual,
    submitV2,
    resolveReview,
    executor: shadowExecutor,
    executorMain: mainExecutor,
    audit,
    paths: { main: mainStore.paths, shadow: shadowStore.paths },
  };
}

function decide(detection, validation) {
  if (!detection.candidate) return { action: "reject", why: "detector 非候选（" + detection.kind_guess + "）" };
  if (!validation.allowed) return { action: "reject", why: "validator 硬规则命中: " + validation.matched_rules.join("/") };
  if (detection.kind_guess === "quote") return { action: "review", why: "quote 无 judge 复核，保守进人工" };
  return { action: "admit", why: "校验通过" };
}

function strSafe(v) { return v == null ? null : String(v); }

module.exports = { createAdmission, decide, CATEGORY_MAP };
