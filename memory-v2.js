"use strict";

// ========================
// Memory V2 存储层（C1）
// 单集合记忆：kind(fact/rule/event)（1002-14 删除 quote/milestone 两类；1007 删 subject 字段）
// × status(active/superseded/archived) × confidence × origin × provenance。（priority/重要级已删，0920 用户拍板）
// Schema v2.0（1005-16）：删 10 字段（priority/speaker/updated_at/action_hint/related_subjects/source/scope/valid_from/valid_to/related_memories——全部死字段或预留无消费），
// 加 4 字段（worth/worth_reason/volatility/volatility_reason——评估标签，judge 判定与离线探针产出，1005-16 用户拍板入库）。
// 设计契约：gpt串口/13.txt（Schema v1.0 冻结稿）、17.txt（MVP Plan C1）。
// 铁律：
//   1. 不 require 旧记忆模块（memory-pool/memory-engine），不写旧池任何文件；
//   2. 对 memory_v2.json / memory_review_queue.json 的写权限只属于本模块；
//   3. 检索路径（未来 retrieve）永远不得写本体（Schema 冻结 8）。
// 风格对齐 memory-pool.js：CommonJS 单文件、fs-extra 原子写、time_utils.nowIso、READONLY 守卫。
// ========================

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { nowIso } = require("./time_utils");

// 只读守卫（与 memory-engine 同款思路）：只读进程禁止一切落盘与内存改写
const READONLY = process.env.MEMORY_V2_READONLY === "1";

// ---- Schema v2.0 常量（冻结：改动任何枚举/语义必须升 schema_ver 并走迁移说明） ----
// 1005-17：kind 扩展 event（向后兼容枚举扩展，fact/rule 语义不变；可选字段 triggers/vibe/source_session
// 同 1005-16 worth/volatility 先例按可选字段模式加，不升版本、不动存量数据）。
const SCHEMA_VER = 2;
const KINDS = ["fact", "rule", "event"];
const SUBJECTS = ["user", "self", "relationship", "external"];
const STATUSES = ["active", "superseded", "archived"]; // pending_review 在队列文件，不在集合
const ORIGINS = ["memory_tag", "tool", "manual", "promotion", "import"];
const DIRECTIONS = ["toward_user", "about_user", "self_discipline"]; // 仅 rule 可选
const PROVENANCE_METHODS = ["tag_inline", "mcp_tool", "admin_form", "summary_promotion", "diary_promotion", "migration_batch", "review_admit"];
const SUPERSEDED_REASONS = ["updated", "merged", "contradiction_resolved", "retracted", "archived", "unknown"];
const TEXT_MAX = 2000;
const PROVENANCE_QUOTE_MAX = 200;
const NOTE_MAX = 200;

// ---- 1005-16：评估标签（worth/volatility）——judge 判定与离线探针产出，1005-16 用户拍板入库 ----
// worth：这条记忆值不值得长期保留（0-1）；volatility：会不会过时（stable/volatile/situational）
const VOLATILITIES = ["stable", "volatile", "situational"];
const WORTH_REASON_MAX = 200;
const VOLATILITY_REASON_MAX = 200;

// ---- 1002 记忆改造 §8 第 4 项：schema 演进新增字段（全部可选，缺按默认值补，向后兼容） ----
// sensitive：高敏（注入前脱敏）；triggers：命中即优先浮现的触发词；last_hit_at：最后被检索命中时间（系统字段，评估用，写入方不可指定）
const TRIGGER_MAX = 40;
  const VIBE_MAX = 60;
const TRIGGERS_MAX = 12;

// 状态机（13.txt 第四节）：非法迁移一律拒绝。
//   active → superseded（原因必填：updated/merged/contradiction_resolved）
//   active → archived（原因必填：retracted/archived）
//   superseded → archived（归档不删除，历史仍可审计）
//   superseded → active 禁止（历史不可复活；要恢复就新建条目）
//   archived → active 允许（revive，清空 superseded_* 字段）
const TRANSITIONS = {
  active: ["superseded", "archived"],
  superseded: ["archived"],
  archived: ["active"],
};
const TRANSITION_REASONS = {
  "active>superseded": ["updated", "merged", "contradiction_resolved"],
  "active>archived": ["retracted", "archived"],
  "superseded>archived": ["archived"],
  "archived>active": [], // revive：无原因语义，清空 superseded_* 字段
};

const DEFAULT_CONFIG = {
  v2_enabled: false, // 按入口独立开关在 C4/C5 落地，此处为总闸预留
  v2_shadow: false,
  judge_mode: "mock", // mock | llm；llm 需 benchmark_v2 达标才允许配置
  confidence_threshold: 0.7,
  recall_sim_threshold: 0.55,
  defaults: {
    confidence: { manual: 0.8, memory_tag: 0.7, tool: 0.5, promotion: 0.5, import: 0.4 },
  },
  import_confidence_cap: 0.6, // 迁移/导入条目 confidence 封顶（Round 6/8 决策）
  paths: { collection: "data/memory_v2.json", review_queue: "data/memory_review_queue.json" },
};

// ---------------- 工具 ----------------

function newId() { return "mv2_" + crypto.randomBytes(6).toString("hex"); }

function atomicWriteJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, file);
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readJsonSync(file);
}

function mergeConfig(base, overrides) {
  const out = { ...base };
  if (!overrides) return out;
  for (const k of Object.keys(overrides)) {
    if (k === "defaults" && overrides.defaults && typeof overrides.defaults === "object") {
      out.defaults = {
        confidence: { ...(base.defaults || {}).confidence, ...(overrides.defaults.confidence || {}) },
      };
    } else if (k === "paths" && overrides.paths && typeof overrides.paths === "object") {
      out.paths = { ...(base.paths || {}), ...overrides.paths };
    } else {
      out[k] = overrides[k];
    }
  }
  return out;
}

function fail(error) { return { ok: false, error }; }

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// 显式传入的 0-1 数值：缺省返回 null（由调用方取默认），传了但非法视为错误
function pick01(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`confidence 必须是 0-1 的数字，got: ${v}`);
  return n;
}

function idArrayOrNull(v, field) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new Error(`${field} 必须是 id 数组`);
  for (const x of v) {
    if (typeof x !== "string" || !x.trim()) throw new Error(`${field} 含非法 id`);
  }
  return v.map((x) => String(x).trim());
}

// ---------------- Schema 校验（纯函数，可独立单测） ----------------
// 输入：写入方提交的 partial entry；输出：{ok, entry} 或 {ok:false, error}
// 职责：枚举校验、默认值补齐、字段规范化。（1002-14：quote/milestone 分类与其联动铁律已删）
// 注意：status 在创建时恒为 active；schema_ver/id/时间戳由系统生成，传入值一律忽略。

function validateEntry(input, cfg) {
  try {
    const entry = _buildEntry(input, cfg || DEFAULT_CONFIG);
    return { ok: true, entry };
  } catch (err) {
    return fail(err && err.message ? err.message : String(err));
  }
}

function _buildEntry(input, cfg) {
  if (!input || typeof input !== "object") throw new Error("输入必须为对象");
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error("text 必填");
  if (text.length > TEXT_MAX) throw new Error(`text 超长（>${TEXT_MAX} 字符）`);

  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new Error(`kind 非法: ${kind}（允许 ${KINDS.join("/")}）`);
  // 1007：subject 字段删除——传入值宽容忽略，不再写入新条目
  void input.subject;
  const origin = input.origin;
  if (!ORIGINS.includes(origin)) throw new Error(`origin 非法: ${origin}（允许 ${ORIGINS.join("/")}）`);

  // 1002-14：kind=quote/milestone 已删除（用户拍板），两条联动铁律随之取消。
  // 1005-16：speaker 字段删除（历史残留，无注入消费）——传入值忽略（宽容，不报错）。

  let direction = null;
  if (input.direction != null) {
    if (kind !== "rule") throw new Error("direction 仅 kind=rule 可用");
    if (!DIRECTIONS.includes(input.direction)) throw new Error(`direction 非法: ${input.direction}`);
    direction = input.direction;
  }

  // confidence：显式传值必须合法，缺省按 origin 取默认；import 封顶
  let confidence = pick01(input.confidence);
  if (confidence == null) {
    const byOrigin = (cfg.defaults.confidence || {})[origin];
    confidence = byOrigin != null ? byOrigin : 0.5;
  }
  if (origin === "import") confidence = Math.min(confidence, Number(cfg.import_confidence_cap) || 0.6);
  const established_at = strOrNull(input.established_at);

  // provenance：必需对象；session/msg 由系统生成（写入方传了也被丢弃），quote 是唯一允许 AI 提供的子字段
  const prov = input.provenance;
  if (!prov || typeof prov !== "object") throw new Error("provenance 必填（对象，至少含 method）");
  if (!PROVENANCE_METHODS.includes(prov.method)) throw new Error(`provenance.method 非法: ${prov.method}`);
  const provQuote = strOrNull(prov.quote);
  if (provQuote && provQuote.length > PROVENANCE_QUOTE_MAX) throw new Error(`provenance.quote 超长（>${PROVENANCE_QUOTE_MAX}）`);
  const provenance = {
    session_id: strOrNull(prov.session_id), // C1 阶段允许写入方携带；C4 起 tag/tool 入口由系统强制覆盖
    msg_id: strOrNull(prov.msg_id),
    quote: provQuote,
    block_id: strOrNull(prov.block_id),
    method: prov.method,
  };

  const supersedes = idArrayOrNull(input.supersedes, "supersedes");

  let note = null;
  if (input.note != null) {
    note = strOrNull(input.note);
    if (note && note.length > NOTE_MAX) throw new Error(`note 超长（>${NOTE_MAX}）`);
  }

  // 1005-16：以下原 schema 演进字段已删（预留无消费），传入值一律忽略（宽容）：related_subjects/source/scope/valid_from/valid_to/action_hint/related_memories
  const sensitive = !!input.sensitive;

  let triggers = [];
  if (input.triggers != null) {
    if (!Array.isArray(input.triggers)) throw new Error("triggers 必须是字符串数组");
    const arr = input.triggers.map((t) => strOrNull(t)).filter(Boolean);
    for (const t of arr) if (t.length > TRIGGER_MAX) throw new Error(`triggers 项超长（>${TRIGGER_MAX}）`);
    triggers = [...new Set(arr)].slice(0, TRIGGERS_MAX);
  }

  // 1005-16：评估标签（可选；传了必须合法，非法报错而非静默丢弃；judge/探针已做降级，这里兜底校验）
  let worth = null;
  if (input.worth != null) {
    const n = Number(input.worth);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`worth 必须是 0-1 的数字，got: ${input.worth}`);
    worth = Math.round(n * 100) / 100;
  }
  let worth_reason = null;
  if (input.worth_reason != null) {
    worth_reason = strOrNull(input.worth_reason);
    if (worth_reason && worth_reason.length > WORTH_REASON_MAX) throw new Error(`worth_reason 超长（>${WORTH_REASON_MAX}）`);
  }
  let volatility = null;
  if (input.volatility != null) {
    const v = String(input.volatility).trim();
    if (!VOLATILITIES.includes(v)) throw new Error(`volatility 非法: ${v}（允许 ${VOLATILITIES.join("/")}）`);
    volatility = v;
  }
  let volatility_reason = null;
  if (input.volatility_reason != null) {
    volatility_reason = strOrNull(input.volatility_reason);
    if (volatility_reason && volatility_reason.length > VOLATILITY_REASON_MAX) throw new Error(`volatility_reason 超长（>${VOLATILITY_REASON_MAX}）`);
  }
  // 1005-17：vibe（可选，蒸馏产出，LLM 感受到的氛围质感）/ source_session（来源会话，蒸馏落库时反查）
  let vibe = null;
  if (input.vibe != null) {
    vibe = strOrNull(input.vibe);
    if (vibe && vibe.length > VIBE_MAX) throw new Error(`vibe 超长（>${VIBE_MAX}）`);
  }
  let source_session = null;
  if (input.source_session != null) source_session = strOrNull(input.source_session);

  const now = nowIso();
  return {
    id: newId(),
    schema_ver: SCHEMA_VER,
    text,
    kind,
    direction,
    status: "active", // 创建恒为 active；superseded/archived 只能经 updateStatus 状态机到达
    confidence,
    origin,
    provenance,
    created_at: now,
    content_updated_at: now, // 仅正文变化时更新（旧池 updated_at 被检索污染的根治）
    established_at: established_at,
    supersedes,
    superseded_by: null,
    superseded_reason: null,
    superseded_at: null,
    note,
    sensitive,
    triggers,
    vibe,
    source_session,
    worth,
    worth_reason,
    volatility,
    volatility_reason,
    last_hit_at: null, // 系统字段：检索命中时由 markHit 更新，写入方不可指定
    last_decay_at: null, // 1005-17 系统字段：event 衰减时间戳（幂等：每次衰减后置 now），写入方不可指定
  };
}

// 写入即算向量（2026-09-28 用户拍板）：新增/编辑 active 条目后异步补算并缓存，
// 让向量在写入完成时即可用，不再等首次检索现场补算。动态 require 规避循环依赖
// （memory-v2-vectors 预热会 require 本模块）；失败/熔断静默，不影响写入。
function scheduleVector(id) {
  try {
    const vv = require("./memory-v2-vectors");
    const e = id != null ? getById(id) : null;
    if (!e || e.status !== "active") return;
    Promise.resolve(vv.ensureVectors([e])).catch(function () {});
  } catch (e) { /* 向量旁路失败不影响写入 */ }
}

// 供 scheduleVector 用的单条查询（createStore 内部 get 依赖闭包，这里用轻量直读）
function getById(id) {
  try {
    const { createStore } = module.exports;
    return createStore({ config: {} }).get(id);
  } catch (e) { return null; }
}

// ---------------- 存储工厂 ----------------
// 生产用默认实例之外的独立实例（测试指向 tmp 目录）：
//   createStore({ rootDir, config, readonly })

function createStore(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const fileConfig = opts.configPath ? readJsonIfExists(opts.configPath) : null;
  const cfg = mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), opts.config || null);
  const collectionPath = path.resolve(rootDir, cfg.paths.collection);
  const queuePath = path.resolve(rootDir, cfg.paths.review_queue);
  const readonly = opts.readonly != null ? !!opts.readonly : READONLY;

  let rows = null; // 惰性加载；加载后为唯一内存真身，写穿透落盘

  function load() {
    if (rows) return rows;
    if (!fs.existsSync(collectionPath)) {
      rows = [];
      return rows;
    }
    try {
      rows = fs.readJsonSync(collectionPath);
    } catch (err) {
      // 损坏隔离：备份坏文件后大声失败，拒绝静默从空库起步（旧池 quarantine 同款思路）
      const backup = collectionPath + ".corrupt-" + Date.now();
      try { fs.renameSync(collectionPath, backup); } catch (_) { /* 隔离失败也要抛原始错误 */ }
      rows = null;
      throw new Error(`memory_v2 集合损坏，已隔离到 ${backup}：${err.message}`);
    }
    if (!Array.isArray(rows)) {
      throw new Error(`memory_v2 集合格式非法（应为数组）: ${collectionPath}`);
    }
    // 1002 第 4 项：存量条目补齐新增字段默认值（缺字段不报错），补齐后延迟落盘一次
    if (hydrateRows(rows) > 0) scheduleFlush();
    return rows;
  }

  function flush() {
    if (readonly) return;
    atomicWriteJson(collectionPath, rows);
  }

  // 延迟合并落盘：2s 内的多次变更只写一次盘。用于 last_hit_at 打点与存量补字段迁移，
  // 避免高频检索触发全量 flush。（进程内 timer 丢失最多丢一次打点，评估字段无伤）
  let flushTimer = null;
  function scheduleFlush() {
    if (readonly || !rows) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { flush(); } catch (_) { /* 打点落盘失败不影响主链路 */ }
    }, 2000);
    if (flushTimer.unref) flushTimer.unref();
  }

  // 向后兼容：老条目缺新增字段时在内存补齐默认值；返回补齐的字段数
  function hydrateRows(arr) {
    let missing = 0;
    for (const e of arr) {
      if (!e || typeof e !== "object") continue;
      if (e.sensitive === undefined) { e.sensitive = false; missing++; }
      if (!Array.isArray(e.triggers)) { e.triggers = []; missing++; }
      // 1005-16：评估标签缺省补 null（存量由迁移脚本从探针回填，这里是兜底）
      if (e.worth === undefined) { e.worth = null; missing++; }
      if (e.worth_reason === undefined) { e.worth_reason = null; missing++; }
      if (e.volatility === undefined) { e.volatility = null; missing++; }
      if (e.volatility_reason === undefined) { e.volatility_reason = null; missing++; }
      if (e.last_hit_at === undefined) { e.last_hit_at = null; missing++; }
    }
    return missing;
  }

  function ensureFiles() {
    if (!fs.existsSync(collectionPath)) atomicWriteJson(collectionPath, []);
    if (!fs.existsSync(queuePath)) atomicWriteJson(queuePath, []);
  }

  function create(input) {
    if (readonly) return fail("readonly 模式拒绝写入");
    const v = validateEntry(input, cfg);
    if (!v.ok) return v;
    const rows2 = load();
    rows2.push(v.entry);
    flush(); // 写穿透：V2 数据量小（个位数/天），安全优先于批量
    scheduleVector(v.entry.id); // 2026-09-28：新增即算向量（异步，不阻塞写入）
    return { ok: true, entry: v.entry };
  }

  function get(id) {
    const idStr = strOrNull(id);
    if (!idStr) return null;
    const r = load();
    return r.find((e) => e.id === idStr) || null;
  }

  // 过滤项全部可选；排序恒为「最新在前」（数组倒序=插入序倒序，同秒创建也稳定）
  function list(filter = {}) {
    const r = load();
    const out = [];
    for (let i = r.length - 1; i >= 0; i--) {
      const e = r[i];
      if (filter.kind != null && e.kind !== filter.kind) continue;
      if (filter.subject != null && e.subject !== filter.subject) continue;
      if (filter.status != null && e.status !== filter.status) continue;
      if (filter.origin != null && e.origin !== filter.origin) continue;
      out.push(e);
      if (filter.limit != null && out.length >= filter.limit) break;
    }
    return out;
  }

  function updateStatus(id, toStatus, opts2 = {}) {
    if (readonly) return fail("readonly 模式拒绝写入");
    const e = get(id);
    if (!e) return fail("not_found: " + id);
    if (!STATUSES.includes(toStatus)) return fail(`status 非法: ${toStatus}（允许 ${STATUSES.join("/")}）`);
    if (toStatus === e.status) return fail(`same_status: ${toStatus}`);
    const allowed = TRANSITIONS[e.status] || [];
    if (!allowed.includes(toStatus)) return fail(`illegal_transition: ${e.status} → ${toStatus}`);

    if (toStatus === "active") {
      // archived → active（revive）：清空 superseded_* 字段；content_updated_at 不动（正文没变）
      e.superseded_reason = null;
      e.superseded_at = null;
      e.superseded_by = null;
    } else {
      const key = e.status + ">" + toStatus;
      const reasons = TRANSITION_REASONS[key] || [];
      const reason = strOrNull(opts2.reason);
      if (!reasons.includes(reason)) {
        return fail(`${key} 需要 reason ∈ [${reasons.join("/")}]，got: ${reason}`);
      }
      e.superseded_reason = reason;
      e.superseded_at = nowIso();
      if (opts2.supersededBy != null) {
        const by = idArrayOrNull(opts2.supersededBy, "supersededBy");
        if (by) e.superseded_by = by;
      }
    }
    e.status = toStatus;
    flush();
    return { ok: true, entry: e };
  }

  // 管理台人工编辑（0919）：白名单字段直改；text 变化刷 content_updated_at；枚举与 kind 联动铁律同 create
  // 1005-16：白名单随 schema v2 精简（删 speaker/related_subjects/source/scope/valid_from/valid_to/action_hint），加评估标签 4 字段
  // last_hit_at 为系统字段，不开放编辑
  const UPDATABLE_FIELDS = ["text", "note", "kind", "direction", "established_at", "anchor",
    "sensitive", "triggers", "vibe", "source_session", "worth", "worth_reason", "volatility", "volatility_reason", "last_decay_at"];
  function updateFields(id, patch) {
    if (readonly) return fail("readonly 模式拒绝写入");
    const e = get(id);
    if (!e) return fail("not_found: " + id);
    if (!patch || typeof patch !== "object") return fail("patch 必须为对象");
    const now = nowIso();
    let textChanged = false;
    for (const k of Object.keys(patch)) {
      if (!UPDATABLE_FIELDS.includes(k)) return fail("字段不可编辑: " + k);
      const v = patch[k];
      if (k === "text") {
        const t = typeof v === "string" ? v.trim() : "";
        if (!t || t.length > TEXT_MAX) return fail("text 非法");
        if (e.text !== t) { e.text = t; e.content_updated_at = now; textChanged = true; }
      } else if (k === "note") {
        const n = strOrNull(v);
        if (n && n.length > NOTE_MAX) return fail("note 超长");
        e.note = n;
      } else if (k === "kind") {
        if (!KINDS.includes(v)) return fail("kind 非法: " + v);
        // 1002-14：quote/milestone 分类已删，kind 仅 fact/rule（speaker 字段 1005-16 已删）
        e.kind = v;
      } else if (k === "direction") {
        if (e.kind !== "rule") return fail("direction 仅 rule 可用");
        if (v != null && !DIRECTIONS.includes(v)) return fail("direction 非法: " + v);
        e.direction = v == null ? null : v;
      } else if (k === "established_at") {
        e.established_at = strOrNull(v);
      } else if (k === "anchor") {
        e.anchor = !!v; // 注入层扩展字段（anchor 表待办）：true=常驻 Meaningful Moments/Identity 分层
      } else if (k === "sensitive") {
        e.sensitive = !!v;
      } else if (k === "triggers") {
        if (v == null) { e.triggers = []; }
        else {
          if (!Array.isArray(v)) return fail("triggers 必须是字符串数组");
          const arr = v.map((x) => strOrNull(x)).filter(Boolean);
          for (const x of arr) if (x.length > TRIGGER_MAX) return fail("triggers 项超长");
          e.triggers = [...new Set(arr)].slice(0, TRIGGERS_MAX);
        }
      } else if (k === "vibe") {
        const vb = strOrNull(v);
        if (vb && vb.length > VIBE_MAX) return fail("vibe 超长");
        e.vibe = vb;
      } else if (k === "source_session") {
        e.source_session = strOrNull(v);
      } else if (k === "worth") {
        if (v == null) { e.worth = null; }
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1) return fail("worth 必须是 0-1 的数字");
          e.worth = Math.round(n * 100) / 100;
        }
      } else if (k === "worth_reason") {
        const w = strOrNull(v);
        if (w && w.length > WORTH_REASON_MAX) return fail("worth_reason 超长");
        e.worth_reason = w;
      } else if (k === "volatility") {
        if (v == null) { e.volatility = null; }
        else {
          const sv = String(v).trim();
          if (!VOLATILITIES.includes(sv)) return fail("volatility 非法: " + sv);
          e.volatility = sv;
        }
      } else if (k === "volatility_reason") {
        const vr = strOrNull(v);
        if (vr && vr.length > VOLATILITY_REASON_MAX) return fail("volatility_reason 超长");
        e.volatility_reason = vr;
      }
    }
    flush();
    if (textChanged) scheduleVector(id); // 2026-09-28：正文变化即重算向量（异步）
    return { ok: true, entry: e };
  }

  // 1002 第 4 项：检索命中打点（评估用）。ids 可为单个 id 或数组；返回实际打点条数。
  // 只改内存 + 延迟合并落盘，不阻塞检索。
  function markHit(ids) {
    if (readonly) return 0;
    const arr = Array.isArray(ids) ? ids : [ids];
    const set = new Set(arr.filter(Boolean).map(String));
    if (!set.size) return 0;
    const now = nowIso();
    let n = 0;
    for (const e of load()) {
      if (e && set.has(e.id)) { e.last_hit_at = now; n++; }
    }
    if (n) scheduleFlush();
    return n;
  }

  function stats() {
    const r = load();
    const byStatus = { active: 0, superseded: 0, archived: 0 };
    const byKind = {};
    for (const e of r) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    }
    return { total: r.length, byStatus, byKind, collectionPath, queuePath };
  }

  // 0920 加：硬删除（管理台专用，不可恢复；区别于 archive 软沉底）。向量缓存由 pruneVectors 在下次检索时清孤儿
  function hardDelete(id) {
    const arr = load();
    const idx = arr.findIndex(e => e && e.id === id);
    if (idx === -1) return { ok: false, error: "找不到条目: " + id };
    arr.splice(idx, 1);
    flush();
    return { ok: true };
  }

  return {
    cfg,
    paths: { collection: collectionPath, review_queue: queuePath },
    readonly,
    init: ensureFiles,
    create,
    get,
    list, updateFields,
    updateStatus,
    hardDelete,
    stats,
    flush,
    markHit,
    validate: (input) => validateEntry(input, cfg),
  };
}

module.exports = {
  createStore,
  validateEntry,
  DEFAULT_CONFIG,
  CONSTANTS: {
    SCHEMA_VER, KINDS, SUBJECTS, STATUSES, ORIGINS, DIRECTIONS,
    PROVENANCE_METHODS, SUPERSEDED_REASONS,
    TRANSITIONS, TRANSITION_REASONS, TEXT_MAX, PROVENANCE_QUOTE_MAX, NOTE_MAX,
    VOLATILITIES, WORTH_REASON_MAX, VOLATILITY_REASON_MAX, TRIGGER_MAX, TRIGGERS_MAX,
  },
};
