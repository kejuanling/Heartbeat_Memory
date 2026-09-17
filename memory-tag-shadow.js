"use strict";

// ========================
// memory_tag Shadow 旁路（C7）——真实 tag 流量的 V2 全链路观察
// 铁律：tagParser.extractAndStore() 原样不动；旧池写入逻辑完全不动；
//       本模块只产审计行与统计报告，禁止正式写 Memory V2（不 require 存储层）。
// 链路：tag 内容 → candidate_detector → provenance_builder → validator → judge(mock) → audit
// would_action 决策沿用 C4 编排策略（非候选/硬规则→would_reject；quote→would_review；其余→would_admit）。
// judge 在 shadow 中是「观察项」不参与决策——shadow 无检索通道，mock judge 以空既有跑链路
// （relation 恒 need_review），其价值是验证 judge 环路与产出 relation 分布基线。
// 门控：读 data/memory_v2_config.json 的 v2_shadow；关闭时 observe 直接 skipped，零写入。
// ========================

const fs = require("fs-extra");
const path = require("path");
const { detect } = require("./candidate-detector");
const { buildProvenance } = require("./provenance-builder");
const { validate } = require("./admission-validator");
const { judge } = require("./judge-adapter");
const { createAuditLogger } = require("./admission-audit");
const { CATEGORY_MAP } = require("./memory-admission");

const MEMORY_TAG_RE = /<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi;

// 解析标签体：头部 {kv} JSON 或 k:v 行式元信息 + 正文（宽容解析，解析失败按纯正文）
function parseTagBody(inner) {
  let meta = {};
  let body = String(inner || "").trim();
  const brace = body.match(/^\s*\{([\s\S]*?)\}\s*/);
  if (brace) {
    try {
      meta = JSON.parse("{" + brace[1] + "}");
      body = body.slice(brace[0].length);
    } catch (_) {
      for (const m of brace[1].matchAll(/(category|importance|pinned)\s*[:=]\s*([^,}\n]+)/g)) {
        // 值可能带引号（{category:"关于她"} 非标准 JSON）：剥引号后再入映射
        meta[m[1]] = m[2].trim().replace(/^["']+|["']+$/g, "");
      }
      const close = body.indexOf("}");
      body = close >= 0 ? body.slice(close + 1) : body;
    }
  }
  if (typeof meta.importance === "string") {
    const n = Number(meta.importance);
    meta.importance = Number.isFinite(n) ? n : meta.importance;
  }
  return { meta, body: body.trim() };
}

// opts: { rootDir?, shadowOn? }（shadowOn 缺省读配置文件 v2_shadow）
function createTagShadow(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  let shadowOn = opts.shadowOn;
  if (shadowOn == null) {
    const cfgFile = path.join(rootDir, "data", "memory_v2_config.json");
    const fileCfg = fs.existsSync(cfgFile) ? fs.readJsonSync(cfgFile) : null;
    shadowOn = !!(fileCfg && fileCfg.v2_shadow === true);
  }
  const audit = createAuditLogger({ rootDir, dir: "data" });

  const stats = {
    total_tags: 0,
    candidates: 0,
    rejects: 0,
    reviews: 0,
    would_admit: 0,
    judge_relations: {},
  };

  // 单条 tag payload 观察（payload = {text, category?, importance?, pinned?}；ctx = {sessionId?, msgId?}）
  async function observe(payload, ctx = {}) {
    if (!shadowOn) return { skipped: true, would_action: null };
    const text = strSafe(payload.text);
    if (!text) {
      stats.total_tags++;
      stats.rejects++;
      return { skipped: false, would_action: "would_reject", detect: null, validation: { allowed: false, matched_rules: ["V6"], reasons: ["V6 tag 正文为空"] }, judge: null };
    }
    stats.total_tags++;

    // [1] detector（tag 类别映射与 tag-parser 同款：关于她/认账/拓本 三类显式）
    const mapped = CATEGORY_MAP[payload.category] || null;
    const detection = detect({
      text,
      source: "chat_ai",
      explicitKind: mapped ? mapped.kind : null,
      explicitSubject: mapped ? mapped.subject : null,
    });

    // [2] provenance（保持 sessionId；msg_id 现阶段拿不到，必须 null——不伪造）
    const provenance = buildProvenance({
      origin: "memory_tag",
      method: "tag_inline",
      sessionId: ctx.sessionId,
      msgId: ctx.msgId, // 无则 null
    });
    // quote 类（拓本语义=她的原话）：speaker 恒 user、正文即原话摘录——否则 V2/V9 必拒，
    // 旧系统拓本本就按此语义写入（14.txt：拓本=一字不改的原话，写明谁说的）
    if (mapped && mapped.kind === "quote") {
      provenance.quote = text.slice(0, 200);
    }

    // [3] validator（仅真实候选类别；非候选走拒绝）
    let validation;
    if (detection.candidate) {
      validation = validate({
        text,
        kind: detection.kind_guess,
        subject: detection.subject_guess,
        origin: "memory_tag",
        speaker: mapped ? (mapped.kind === "quote" ? "user" : null) : null,
        direction: mapped ? mapped.direction || null : null,
        provenance,
        source: "chat_ai",
      });
    } else {
      validation = { allowed: false, matched_rules: ["DET.not_candidate"], reasons: detection.reasons.slice() };
    }

    // [4] judge（mock，观察项不参与决策；shadow 无检索通道 → 既有为 null）
    const judgeResult = await judge(text, null, { mode: "mock" });
    stats.judge_relations[judgeResult.relation] = (stats.judge_relations[judgeResult.relation] || 0) + 1;

    // [5] would_action（C4 编排策略镜像）
    let wouldAction;
    if (!detection.candidate) wouldAction = "would_reject";
    else if (!validation.allowed) wouldAction = "would_reject";
    else if (detection.kind_guess === "quote") wouldAction = "would_review";
    else wouldAction = "would_admit";

    if (wouldAction === "would_admit") stats.would_admit++;
    else if (wouldAction === "would_review") stats.reviews++;
    else stats.rejects++;
    if (detection.candidate) stats.candidates++;

    // [6] audit（shadow 持久记录）
    audit.append(audit.buildRecord({
      candidateText: text,
      origin: "memory_tag",
      validator: validation,
      judge: { relation: judgeResult.relation, confidence: judgeResult.confidence },
      action: wouldAction,
      notes: { shadow: true, tag: true, detector_kind: detection.kind_guess, session_id: strSafe(ctx.sessionId), importance: payload.importance == null ? null : payload.importance },
    }));

    return {
      skipped: false,
      would_action: wouldAction,
      detect: detection,
      validation,
      judge: judgeResult,
    };
  }

  // 整条 AI 回复的旁路：扫描全部 <memory> 标签逐条观察
  async function observeReply(replyText, ctx = {}) {
    const results = [];
    const tags = String(replyText || "").match(MEMORY_TAG_RE) || [];
    for (const raw of tags) {
      const inner = raw.replace(/^<\s*memory\b[^>]*>/i, "").replace(/<\s*\/memory\s*>$/i, "");
      const { meta, body } = parseTagBody(inner);
      if (!body) { stats.total_tags++; stats.rejects++; results.push({ skipped: false, would_action: "would_reject", empty: true }); continue; }
      results.push(await observe({ text: body, category: meta.category, importance: meta.importance, pinned: meta.pinned }, ctx));
    }
    return results;
  }

  function report() {
    return {
      total_tags: stats.total_tags,
      candidates: stats.candidates,
      rejects: stats.rejects,
      reviews: stats.reviews,
      would_admit: stats.would_admit,
      judge_relations: { ...stats.judge_relations },
      shadow_on: shadowOn,
      updated_at: nowIsoSafe(),
    };
  }

  return { observe, observeReply, report, audit, isShadowOn: () => shadowOn };
}

function strSafe(v) { return v == null ? null : String(v); }
function nowIsoSafe() {
  try { return require("./time_utils").nowIso(); } catch (_) { return new Date().toISOString(); }
}

module.exports = { createTagShadow, parseTagBody, MEMORY_TAG_RE };
