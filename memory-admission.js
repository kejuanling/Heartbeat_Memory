"use strict";

// ========================
// Memory Admission Pipeline（C4/C5）——流程编排，不含业务规则
// 流程（17.txt）：input → candidate_detector → provenance_builder → validator
//   → 决策 → state_executor（唯一写手）→ audit（记最终动作）
// C5 门控语义（v2_enabled × v2_shadow）：
//   v2_enabled=true  → 正式路径：旧池继续写（旧路由恒写，兼容承诺），V2 写主集合/主队列
//   v2_enabled=false + v2_shadow=true → 影子观察：V2 只写影子集合/队列，旧池照旧
//   两者皆 false     → V2 完全跳过（skipped_v2_off），旧池行为不变
// 决策策略（2026-09-19 起 LLM judge 正式启用，业务语义见 14.txt）：
//   detector 非候选 → reject；validator 硬规则命中 → reject；
//   找到相似既有记忆 → judge LLM 判关系：duplicate→reject、update/need_review→review、
//   coexist→admit（quote 亦然——「quote 无 judge 复核」的前提已消除）；
//   没有相似既有 → 无需判定，quote→review、其余 admit（原保守路径）；
//   judge 失败/非法输出 → 回退上述保守路径并在 why 标注。
//   promotion/manual_review 通道 R7 不变：judge 只注解进 review 队列，不改变首入 review。
//   judge_mode 配置（memory_v2_config.json）：llm（默认）/ mock / off。
// 输出契约：{ action, candidate, validation, audit_id }（异步：调用方须 await）
// ========================

const fs = require("fs-extra");
const path = require("path");
const { detect } = require("./candidate-detector");
const { buildProvenance } = require("./provenance-builder");
const { validate } = require("./admission-validator");
const { createAuditLogger } = require("./admission-audit");
const { createStore, DEFAULT_CONFIG } = require("./memory-v2");
const { createStateExecutor } = require("./state-executor");
const { buildPrompt, parseJudgeOutput, normalizeText } = require("./judge-adapter");

// ---- 相似既有检索（0920 混合打分，用户拍板「关键词为主」）----
// 词面门槛 0.10（放宽，用户拍板「不用太严」）先挡无关条目；混合分 = 0.55 词面 + 0.25 语义(bge 余弦)
// （重要级×衰减项已于 0920 删除，满分 0.8），阈值 0.28=原 0.35 等比换算（0.35×0.8），取最高分交 judge 判关系。
// 语义通道复用 memory-v2-vectors.relevantScores（embed-server 熔断/失败 → ok:false 自动降级纯词面）。
// 原纯字面 bigram Jaccard 版的漏判（换个说法就够不到阈值 → judge 拿不到 existing → 重复记忆漏进待审）由语义项补齐。
const JUDGE_SIM_THRESHOLD = 0.28;
const JUDGE_LIT_GATE = 0.1;
async function findBestExisting(store, text) {
  const key = normalizeText(text);
  if (!key) return null;
  const rows = store.list({ status: "active" }).filter(e => normalizeText(e.text));
  if (!rows.length) return null;
  const vectors = require("./memory-v2-vectors");
  const rs = await vectors.relevantScores(rows, key);
  const semById = rs && rs.ok ? rs.scores : null;
  const { tokenize, similarity } = require("./context-v2-adapter");
  const qt = tokenize(key);
  let best = null, bestScore = 0;
  for (const e of rows) {
    const lit = similarity(qt, normalizeText(e.text));
    if (lit < JUDGE_LIT_GATE) continue; // 词面门槛（关键词为主第一层）
    const score = semById
      ? 0.55 * lit + 0.25 * (semById[e.id] || 0)
      : lit;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= JUDGE_SIM_THRESHOLD ? { entry: best, score: Math.round(bestScore * 100) / 100 } : null;
}

// ---- 内置 LLM 通道（judgeLLM 的 callLLM 注入实现；测试可经 opts.callLLM 覆盖）----
// .env 直读（与 server.js readEnvValue 同口径；judge 在 admission 模块内，不走 server 助手）
let _envCache = null;
function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  if (_envCache === null) {
    _envCache = {};
    try {
      const lines = fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/);
      for (const l of lines) { const i = l.indexOf("="); if (i > 0) _envCache[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"(.*)"$/, "$1"); }
    } catch (_) { /* .env 缺失用空 */ }
  }
  return _envCache[key] || "";
}

async function defaultCallLLM(prompt) {
  const { provider, model } = require("./model-router").resolveRoleModel("memory_admit");
  const apiUrl = provider && (provider.api_url || provider.base_url);
  const apiKey = provider && provider.api_key;
  if (!apiUrl || !apiKey || !model) throw new Error("模型未配置（role=memory_admit：请在设置里给「记忆准入」选模型或启用默认供应商）");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, max_tokens: 2048, response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("LLM HTTP " + resp.status);
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("LLM 空响应");
    return String(content);
  } finally { clearTimeout(timer); }
}

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

  const judgeMode = cfg.judge_mode != null ? String(cfg.judge_mode) : "llm";

  // manual 适配器：兼容旧 POST /admin/memory-pool body {content, category, importance}
  // 兼容策略：旧路由恒写旧池（v2_enabled=true 也不停）；本适配器只负责 V2 侧落点。
  // 异步（2026-09-19）：judge LLM 判定，调用方须 await。
  async function submitManual(body, ctx = {}, mode = "shadow") {
    const formal = mode === "formal";
    const isPromo = mode === "promotion";
    const isManualReview = mode === "manual_review"; // 0918：promotion 通道（压缩块原文提炼候选），R7 全落 review，不受双闸门控（按钮即人工授权）
    const isManualReviewGate = isPromo || isManualReview;
    if (!formal && !isManualReviewGate && !shadowOn) {
      // 影子观察未开启时跳过（正式 admit 通道只经 submitV2 的 v2_enabled 门进入）
      return { action: "skipped_shadow_off", candidate: null, validation: null, audit_id: null };
    }
    const exec = (formal || isManualReviewGate) ? mainExecutor : shadowExecutor;
    const originVal = isPromo ? "promotion" : "manual";
    const b = body || {};
    const text = strSafe(b.content || b.text);
    if (!text) {
      return { action: "reject", candidate: null, validation: { allowed: false, matched_rules: ["V6"], reasons: ["V6 text 为空"] }, audit_id: null, notes: "content 为空" };
    }
    const mapped = CATEGORY_MAP[b.category] || null;

    // [1] candidate_detector（manual 显式类别优先，否则自动粗分）
    const detection = detect({ text, source: originVal, explicitKind: mapped ? mapped.kind : b.kind, explicitSubject: mapped ? mapped.subject : b.subject });

    // [2] provenance_builder（manual：无 session/msg → null，不伪造；promotion：block_id 必带（压缩块溯源），msg_id=null）
    const provenance = buildProvenance({
      origin: originVal,
      method: isPromo ? "summary_promotion" : (isManualReview ? "chat_manual_pick" : "admin_form"),
      sessionId: strSafe(ctx.sessionId),
      msgId: strSafe(ctx.msgId),
    });
    if (strSafe(b.quote)) provenance.quote = String(b.quote).slice(0, 200);
    if (isPromo && strSafe(b.block_id)) provenance.block_id = strSafe(b.block_id);

    // [3] validator（仅真实候选类别需要校验；非候选直接走拒绝）
    let validation = null;
    if (detection.candidate) {
      validation = validate({
        text,
        kind: detection.kind_guess,
        subject: detection.subject_guess,
        origin: originVal,
        speaker: mapped ? mapped.speaker || null : null,
        direction: mapped ? mapped.direction || null : null,
        provenance,
        source: originVal,
      });
    } else {
      validation = { allowed: false, matched_rules: ["DET.not_candidate"], reasons: detection.reasons.slice() };
    }

    // [4] 决策（judge LLM 判定 + 保守回退）
    let { action, why } = decide(detection, validation);
    let judgeNote = null;
    const judgeApplies = (formal || isManualReviewGate) && detection.candidate && validation.allowed && judgeMode !== "off";
    if (judgeApplies) {
      const existing = await findBestExisting(mainStore, text);
      if (existing) {
        let jr = null;
        try {
          const prompt = buildPrompt(text, existing.entry.text, {
            candidateKind: detection.kind_guess, candidateSubject: detection.subject_guess,
            existingKind: existing.entry.kind, existingSubject: existing.entry.subject, existingStatus: existing.entry.status,
          });
          const raw = await (typeof opts.callLLM === "function" ? opts.callLLM : defaultCallLLM)(prompt, 1);
          const parsed = parseJudgeOutput(raw);
          if (parsed.ok) jr = parsed; else jr = { ok: false, error: parsed.error };
        } catch (e) {
          jr = { ok: false, error: e && e.message ? e.message : String(e) };
        }
        if (jr.ok) {
          judgeNote = "judge:" + jr.relation + "(" + jr.confidence + "," + existing.score + ")/" + jr.reason;
          if (!isManualReviewGate) {
            // 正式路径：按 judge 关系改写动作；R7 通道保持首入 review，judge 只做注解
            if (jr.relation === "duplicate") { action = "reject"; why = "judge duplicate: " + jr.reason; }
            else if (jr.relation === "update" || jr.relation === "need_review") { action = "review"; why = "judge " + jr.relation + ": " + jr.reason; }
            else if (jr.relation === "coexist") { action = "admit"; why = "judge coexist: " + jr.reason; }
          }
        } else {
          judgeNote = "judge 失败回退保守路径(" + jr.error + ")";
        }
      }
    }
    if (isManualReviewGate && action === "admit") {
      // R7：promotion 来源首入一律人工把关（提炼是二次加工，judge/mock 认准也不自动入库）
      action = "review";
      why = why + " +R7(" + (isPromo ? "promotion" : "manual_review") + " 人工发起一律 review)";
    }

    // [5] state_executor（唯一写手）+ audit
    //     review 路径先落审计拿 audit_id（队列记录要回链）；admit/reject 执行后记最终动作
    const draft = {
      text,
      kind: detection.kind_guess,
      subject: detection.subject_guess,
      direction: mapped ? mapped.direction || null : null,
      speaker: mapped ? mapped.speaker || null : null,
      origin: originVal,
      provenance,
    };
    // 0920：重要级（importance）设定整体删除，不再映射 confidence（两者语义不同轴，历史映射一并移除）
    if (b.established_at) draft.established_at = String(b.established_at);

    let execResult, auditRec;
    if (action === "review") {
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: originVal, validator: validation, action: "review",
        notes: { shadow: !formal && !isPromo, detector_kind: detection.kind_guess, why, judge: judgeNote },
      }));
      execResult = exec.review(draft, why, {
        auditId: auditRec.ok ? auditRec.id : null,
        details: validation.reasons.concat(judgeNote ? [judgeNote] : []),
      });
    } else if (action === "admit") {
      execResult = exec.admit(draft);
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: originVal, validator: validation,
        action: execResult.ok ? "admit" : "error",
        notes: { shadow: !formal && !isPromo, detector_kind: detection.kind_guess, why, judge: judgeNote, entry_id: execResult.entry ? execResult.entry.id : null, error: execResult.error || null },
      }));
    } else {
      execResult = exec.reject(draft, why);
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: originVal, validator: validation, action: "reject",
        notes: { shadow: !formal && !isPromo, detector_kind: detection.kind_guess, why, judge: judgeNote },
      }));
    }

    return {
      action: execResult.ok ? action : "error",
      candidate: { text, kind: detection.kind_guess, subject: detection.subject_guess, detector: detection, provenance },
      validation,
      judge: judgeNote,
      audit_id: auditRec.ok ? auditRec.id : null,
      entry_id: execResult.entry ? execResult.entry.id : null,
      queue_id: execResult.queue_id || null,
      mode: isPromo ? "promotion" : (isManualReview ? "manual_review" : (formal ? "formal" : "shadow")),
    };
  }

  // promotion 通道（0918）：压缩块原文提炼的候选入口，走完整流水线但 R7 强制 review。
  // 不受 v2_enabled/v2_shadow 门控——管理台按钮点击即人工授权，候选只进 review 队列，入库仍需人工 approve。
  function submitPromotion(body, ctx = {}) {
    return submitManual(body, ctx, "promotion");
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
    judgeMode,
    submitManual,
    submitPromotion,
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
