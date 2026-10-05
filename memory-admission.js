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
//   coexist→admit（1002-14：quote 类已删，此注同步）；
//   没有相似既有 → 无需判定，直接 admit（原 quote→review 保守路径随分类删除）；
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

// ---- 相似既有检索（1004-04 改造：取全部候选，不再只取最高分一条）----
//
// 1004-04 用户拍板：
//  · 权重从 0.55词面+0.25语义（满分 0.8）降到 0.4词面+0.1语义（满分 0.5）——语义只占 20%，让它当辅助
//  · 门槛 0.28 是旧满分口径下的值（相对 35%），新权重下等于相对 56%，
//    离线校准（probe-similarity-calibration，177 条真实数据）实测：0.28 下召回 0.0 条（完全失效），
//    噪声基线（库内任意两条的中位混合分）= 0.098，p99 = 0.184。
//    0.18 实测平均召回 2.1 条 / 中位 1 条 / 最多 18 条，且抽样确认高分对全是真重复 → 定为 0.18。
//  · 候选上限 20 条（用户拍板），超出的按分数截断
//
// 语义通道复用 memory-v2-vectors.relevantScores（embed 熔断/失败 → ok:false 自动降级纯词面）。
const JUDGE_SIM_THRESHOLD = 0.18;
const JUDGE_LIT_GATE = 0.1;
const JUDGE_SIM_MAX = 20;
const JUDGE_W_LIT = 0.4;
const JUDGE_W_SEM = 0.1;
// 返回全部达门槛的候选（分数降序，最多 20 条）；无相似返回 []
async function findSimilarExisting(store, text) {
  const key = normalizeText(text);
  if (!key) return [];
  const rows = store.list({ status: "active" }).filter(e => normalizeText(e.text));
  if (!rows.length) return [];
  const vectors = require("./memory-v2-vectors");
  const rs = await vectors.relevantScores(rows, key);
  const semById = rs && rs.ok ? rs.scores : null;
  const { tokenize, similarity } = require("./context-v2-adapter");
  const qt = tokenize(key);
  const hits = [];
  for (const e of rows) {
    const lit = similarity(qt, normalizeText(e.text));
    if (lit < JUDGE_LIT_GATE) continue; // 词面硬门槛先挡无关条目
    const sem = semById ? (semById[e.id] || 0) : 0;
    const score = semById ? (JUDGE_W_LIT * lit + JUDGE_W_SEM * sem) : (JUDGE_W_LIT * lit);
    if (score < JUDGE_SIM_THRESHOLD) continue;
    hits.push({ entry: e, score: Math.round(score * 1000) / 1000, lit: Math.round(lit * 1000) / 1000,
                sem: Math.round(sem * 1000) / 1000 });
  }
  hits.sort((a, b) => b.score - a.score || String(a.entry.id).localeCompare(String(b.entry.id)));
  return hits.slice(0, JUDGE_SIM_MAX);
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

// 1004-04：worth 显示用（null → "-"，否则百分比整数）
function fmtW(w) { return (w == null) ? "-" : Math.round(w * 100) + "%"; }

// 1004-04：单次 judge 调用（existing 为 null 表示"无相似对照"，只取 worth/volatility）。
// 返回 {ok:true, relation, relation_reason, worth, worth_reason, volatility, volatility_reason}
// 或 {ok:false, error}。
async function runJudge(candidateText, existingEntry, detection, opts) {
  try {
    const prompt = buildPrompt(candidateText, existingEntry ? existingEntry.text : "（无相似记忆）", {
      candidateKind: detection.kind_guess, candidateSubject: detection.subject_guess,
      existingKind: existingEntry ? (existingEntry.kind + "/" + (existingEntry.subject || "") + "/" + (existingEntry.status || "")) : "none",
    });
    const raw = await (typeof opts.callLLM === "function" ? opts.callLLM : defaultCallLLM)(prompt, 1);
    const parsed = parseJudgeOutput(raw);
    return parsed.ok ? parsed : { ok: false, error: parsed.error };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
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
  "拓本": { kind: "fact", subject: "user" },
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
    // 2026-10-01：聊天页入池显式携带说话人（user=涵 / ai=谢），优先于分类映射
    const explicitSpeaker = strSafe(b.speaker) || null;
    const speakerVal = explicitSpeaker || (mapped ? mapped.speaker || null : null);

    // [1] candidate_detector（manual 显式类别优先，否则自动粗分）
    const detection = detect({ text, source: originVal, explicitKind: mapped ? mapped.kind : b.kind, explicitSubject: mapped ? mapped.subject : b.subject });

    // [2] provenance_builder（manual：无 session/msg → null，不伪造；promotion：block_id 必带（压缩块溯源），msg_id=null）
    // method 一律用契约内合法值（2026-09-28 拍板方案B：原 chat_manual_pick 不在 LEGAL_METHODS 会被静默置 null）
    const provenance = buildProvenance({
      origin: originVal,
      method: isPromo ? "summary_promotion" : "admin_form",
      sessionId: strSafe(ctx.sessionId),
      msgId: strSafe(ctx.msgId),
    });
    if (strSafe(b.quote)) provenance.quote = String(b.quote).slice(0, 200);
    // 人工入池（聊天页/管理台）：整条消息即原文摘录，自动补 provenance.quote 供溯源
    // （1002-14：原 V9 强制「quote 必须附原文」已废，改为无条件补，溯源信息不丢）
    if (!isPromo && !strSafe(provenance.quote)) {
      provenance.quote = text.slice(0, 200);
    }
    // 消息时间（待审可见；入库时 _buildEntry 只保留 schema 五字段，msg_time 自然丢弃）
    if (strSafe(b.msg_time)) provenance.msg_time = String(b.msg_time).trim();
    if (isPromo && strSafe(b.block_id)) provenance.block_id = strSafe(b.block_id);

    // [3] validator（仅真实候选类别需要校验；非候选直接走拒绝）
    let validation = null;
    if (detection.candidate) {
      validation = validate({
        text,
        kind: detection.kind_guess,
        subject: detection.subject_guess,
        origin: originVal,
        speaker: speakerVal,
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
    let mergeDraft = null; // 1004-04 起恒为 null（judge 不再生成合并草稿，保留变量供返回契约兼容）
    let judgeMeta = null; // 1004-04：{worth, worth_reason, volatility, volatility_reason, similar[]}
    // 1004-04：judge 退化为「只提供信息的人」——无条件跑、只打标、不做任何自动决策。
    // 有相似：逐条判关系（有上限，几条就调几次）；无相似：也跑一次只拿 worth/volatility。
    const judgeApplies = (formal || isManualReviewGate) && detection.candidate && validation.allowed && judgeMode !== "off";
    const similarList = [];   // 待审页展示用：[{id,text,kind,score,relation,relation_reason}]
    if (judgeApplies) {
      let hits = [];
      try { hits = await findSimilarExisting(mainStore, text); }
      catch (e) { judgeNote = "相似检索失败(" + ((e && e.message) || e) + ")"; }
      let worth = null, worthReason = null, volatility = null, volatilityReason = null;
      if (!hits.length) {
        // 无相似：仍跑一次 judge，只为拿 worth / volatility（用户 1004-04 拍板：没有相似也跑）
        const jr = await runJudge(text, null, detection, opts);
        if (jr && jr.ok) {
          worth = jr.worth; worthReason = jr.worth_reason;
          volatility = jr.volatility; volatilityReason = jr.volatility_reason;
          judgeNote = "judge(无相似):worth=" + fmtW(worth) + "/" + (volatility || "-");
        } else if (jr) judgeNote = "judge 失败(" + jr.error + ")";
      } else {
        for (const h of hits) {
          const jr = await runJudge(text, h.entry, detection, opts);
          const item = { id: h.entry.id, text: h.entry.text, kind: h.entry.kind,
                         score: h.score, lit: h.lit, sem: h.sem,
                         relation: null, relation_reason: null, judge_error: null };
          if (jr && jr.ok) {
            item.relation = jr.relation;
            item.relation_reason = jr.relation_reason;
            item.judge_confidence = jr.confidence;
            // worth/volatility 是「候选记忆本身」的属性，取第一条成功判定的即可（同一候选，多个对照）
            if (worth == null && jr.worth != null) { worth = jr.worth; worthReason = jr.worth_reason; volatility = jr.volatility; volatilityReason = jr.volatility_reason; }
          } else if (jr) {
            item.judge_error = jr.error;
          }
          similarList.push(item);
        }
        judgeNote = "judge:" + similarList.length + "条相似("
          + similarList.map(x => x.relation || "?").join("/") + ")/worth=" + fmtW(worth);
      }
      judgeMeta = { worth, worth_reason: worthReason, volatility, volatility_reason: volatilityReason,
                    similar: similarList };
      // 1004-04：命中相似一律进 review（不再 duplicate→reject、不再 coexist→admit、不再生成合并草稿）
      if (similarList.length) {
        action = "review";
        why = "命中 " + similarList.length + " 条相似记忆，交人工裁决（judge 不做自动决策）";
      } else if (worth != null && worth < 0.35) {
        // 无相似但 judge 判定"不值得记"：1004 起同样交人工（不自动 reject），只提示
        action = "review";
        why = "judge 判定值得记 " + fmtW(worth) + "（低），交人工裁决";
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
      speaker: speakerVal,
      origin: originVal,
      provenance,
    };
    // 0920：重要级（importance）设定整体删除，不再映射 confidence（两者语义不同轴，历史映射一并移除）
    if (b.established_at) draft.established_at = String(b.established_at);
    // 1002 第 4 项：schema 新字段透传（可选）。上游（蒸馏 / 老数据重跑 / 管理台）可带 triggers 等，
    // 校验交给 memory-v2._buildEntry，非法值明确报错而非静默丢弃。
    // 1005-16：schema v2 已删 source/scope/valid_from/valid_to/action_hint——不再透传（_buildEntry 对已删字段宽容忽略，传了也无害）。
    for (const k of ["sensitive", "triggers", "vibe"]) {
      if (b[k] !== undefined) draft[k] = b[k];
    }
    // 1005-17：来源会话（蒸馏取证后 c.session 反查；独立字段供相关注入"本会话不重复注入"排除）
    if (strSafe(ctx.sessionId)) draft.source_session = strSafe(ctx.sessionId);
    // 1002 第 5 项：老数据重跑的动作元信息（{action,target_id,merge_ids,old_text,reason,evidence}）。
    // 只供待审队列展示「改前改后对照 / 由哪几条合并 / 为什么」——入库时 _buildEntry 忽略未知字段，不进 schema。
    if (b.backfill !== undefined) draft.backfill = b.backfill;
    // 1004-04：judge 的纯信息输出（worth/volatility/similar[]）。draft.judge 只供待审展示；
    // 1005-16：用户拍板评估标签入库（schema v2），worth 四字段随 draft 透传给 _buildEntry。
    if (judgeMeta) {
      draft.judge = judgeMeta;
      draft.worth = judgeMeta.worth;
      draft.worth_reason = judgeMeta.worth_reason;
      draft.volatility = judgeMeta.volatility;
      draft.volatility_reason = judgeMeta.volatility_reason;
    }

    let execResult, auditRec;
    if (action === "review") {
      auditRec = audit.append(audit.buildRecord({
        candidateText: text, origin: originVal, validator: validation, action: "review",
        notes: { shadow: !formal && !isPromo, detector_kind: detection.kind_guess, why, judge: judgeNote,
                 judge_meta: judgeMeta ? { worth: judgeMeta.worth, volatility: judgeMeta.volatility, similar_count: (judgeMeta.similar || []).length } : null },
      }));
      execResult = exec.review(draft, why, {
        auditId: auditRec.ok ? auditRec.id : null,
        details: validation.reasons.concat(judgeNote ? [judgeNote] : []),
        merge: mergeDraft || null,
        judge: judgeMeta || null,
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
      judge_meta: judgeMeta || null,
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

  // 1002-09 待审草稿编辑（review 路由用）：改 draft 不裁决，动作进审计
  function editQueue(queueId, patch = {}) {
    const r = mainExecutor.editQueue(queueId, patch);
    if (r.ok) {
      audit.append(audit.buildRecord({
        candidateText: r.draft && r.draft.text ? r.draft.text : "",
        origin: "manual",
        action: "review_edited",
        notes: { queue_id: queueId, fields: r.fields || null },
      }));
    }
    return r;
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
    editQueue,
    executor: shadowExecutor,
    executorMain: mainExecutor,
    audit,
    paths: { main: mainStore.paths, shadow: shadowStore.paths },
    // 1002 第 4 项：检索命中打点（评估用）。两个集合都打（影子库命中同样计），
    // 复用本实例持有的 store（不新建），避免多实例并发写覆盖。
    markHit: (ids) => {
      try { return (mainStore.markHit(ids) || 0) + (shadowStore.markHit(ids) || 0); }
      catch (_) { return 0; }
    },
  };
  _lastAdmission = inst; // 模块级缓存最新实例：tag-parser 等轻量写者复用 executorMain（唯一写手）
  return inst;
}

// 1004-04：safeMerged 已随「judge 不再生成合并文本」整体下线——合并改为人工在待审页对照决定。
// （原 0928 逻辑：LLM 合并产物安检，隐私命中/超长即丢弃。现零调用，删除避免误当活代码。）

function decide(detection, validation) {
  if (!detection.candidate) return { action: "reject", why: "detector 非候选（" + detection.kind_guess + "）" };
  if (!validation.allowed) return { action: "reject", why: "validator 硬规则命中: " + validation.matched_rules.join("/") };
  return { action: "admit", why: "校验通过" };
}

function strSafe(v) { return v == null ? null : String(v); }

let _lastAdmission = null;
function getAdmission() { return _lastAdmission; }
module.exports = { createAdmission, getAdmission };
