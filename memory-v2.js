"use strict";

// ========================
// Memory V2 存储层（C1）
// 六轴单集合记忆：kind(fact/rule/quote/milestone) × subject(user/self/relationship/external)
// × status(active/superseded/archived) × confidence/priority × origin × provenance。
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

// ---- Schema v1.0 常量（冻结：改动任何枚举/语义必须升 schema_ver 并走迁移说明） ----
const SCHEMA_VER = 1;
const KINDS = ["fact", "rule", "quote", "milestone"];
const SUBJECTS = ["user", "self", "relationship", "external"];
const STATUSES = ["active", "superseded", "archived"]; // pending_review 在队列文件，不在集合
const ORIGINS = ["memory_tag", "tool", "manual", "promotion", "import"];
const DIRECTIONS = ["toward_user", "about_user", "self_discipline"]; // 仅 rule 可选
const SPEAKERS = ["user", "self"]; // 仅 quote；speaker=self 在准入层已被拒，存储层兜底
const PROVENANCE_METHODS = ["tag_inline", "mcp_tool", "admin_form", "summary_promotion", "diary_promotion", "migration_batch", "review_admit"];
const SUPERSEDED_REASONS = ["updated", "merged", "contradiction_resolved", "retracted", "archived", "unknown"];
const RELATED_RELS = ["derived_from", "pairs_with"];
const TEXT_MAX = 2000;
const PROVENANCE_QUOTE_MAX = 200;
const NOTE_MAX = 200;

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
    priority: 0.5,
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
        priority: overrides.defaults.priority != null ? overrides.defaults.priority : (base.defaults || {}).priority,
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
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`confidence/priority 必须是 0-1 的数字，got: ${v}`);
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
// 职责：枚举校验、kind 联动铁律（quote/milestone）、默认值补齐、字段规范化。
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
  const subject = input.subject;
  if (!SUBJECTS.includes(subject)) throw new Error(`subject 非法: ${subject}（允许 ${SUBJECTS.join("/")}）`);
  const origin = input.origin;
  if (!ORIGINS.includes(origin)) throw new Error(`origin 非法: ${origin}（允许 ${ORIGINS.join("/")}）`);

  // kind 联动铁律（Schema 冻结 4：AI 台词不得冒充原话；里程碑属于关系）
  let speaker = null;
  if (kind === "quote") {
    if (subject !== "user") throw new Error("kind=quote 必须 subject=user");
    if (input.speaker !== "user") throw new Error("kind=quote 必须 speaker=user");
    speaker = "user";
  }
  if (kind === "milestone") {
    if (subject !== "relationship") throw new Error("kind=milestone 必须 subject=relationship");
    if (!strOrNull(input.established_at)) throw new Error("kind=milestone 必须提供 established_at");
  }

  let direction = null;
  if (input.direction != null) {
    if (kind !== "rule") throw new Error("direction 仅 kind=rule 可用");
    if (!DIRECTIONS.includes(input.direction)) throw new Error(`direction 非法: ${input.direction}`);
    direction = input.direction;
  }

  // confidence/priority：显式传值必须合法，缺省按 origin 取默认；import 封顶
  let confidence = pick01(input.confidence);
  if (confidence == null) {
    const byOrigin = (cfg.defaults.confidence || {})[origin];
    confidence = byOrigin != null ? byOrigin : 0.5;
  }
  if (origin === "import") confidence = Math.min(confidence, Number(cfg.import_confidence_cap) || 0.6);
  let priority = pick01(input.priority);
  if (priority == null) priority = Number(cfg.defaults.priority) || 0.5;

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

  let related_subjects = [];
  if (input.related_subjects != null) {
    if (!Array.isArray(input.related_subjects)) throw new Error("related_subjects 必须是数组");
    for (const s of input.related_subjects) {
      if (!SUBJECTS.includes(s)) throw new Error(`related_subjects 非法: ${s}`);
      if (s === subject) throw new Error("related_subjects 不得包含主 subject");
    }
    related_subjects = [...new Set(input.related_subjects)];
  }

  let related_memories = [];
  if (input.related_memories != null) {
    if (!Array.isArray(input.related_memories)) throw new Error("related_memories 必须是数组");
    for (const r of input.related_memories) {
      if (!r || typeof r !== "object" || !strOrNull(r.id) || !RELATED_RELS.includes(r.rel)) {
        throw new Error(`related_memories 项非法（需 {id, rel ∈ ${RELATED_RELS.join("/")}}）`);
      }
    }
    related_memories = input.related_memories.map((r) => ({ id: String(r.id).trim(), rel: r.rel }));
  }

  const supersedes = idArrayOrNull(input.supersedes, "supersedes");

  let note = null;
  if (input.note != null) {
    note = strOrNull(input.note);
    if (note && note.length > NOTE_MAX) throw new Error(`note 超长（>${NOTE_MAX}）`);
  }

  const now = nowIso();
  return {
    id: newId(),
    schema_ver: SCHEMA_VER,
    text,
    kind,
    subject,
    related_subjects,
    direction,
    speaker,
    status: "active", // 创建恒为 active；superseded/archived 只能经 updateStatus 状态机到达
    confidence,
    priority,
    origin,
    provenance,
    created_at: now,
    content_updated_at: now, // 仅正文变化时更新（旧池 updated_at 被检索污染的根治）
    established_at: established_at,
    supersedes,
    superseded_by: null,
    superseded_reason: null,
    superseded_at: null,
    related_memories,
    note,
  };
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
    return rows;
  }

  function flush() {
    if (readonly) return;
    atomicWriteJson(collectionPath, rows);
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

  return {
    cfg,
    paths: { collection: collectionPath, review_queue: queuePath },
    readonly,
    init: ensureFiles,
    create,
    get,
    list,
    updateStatus,
    stats,
    flush,
    validate: (input) => validateEntry(input, cfg),
  };
}

// 默认生产实例（惰性：不 require 即不触盘；init() 才确保文件存在）
let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = createStore();
  return defaultStore;
}

module.exports = {
  createStore,
  getDefaultStore,
  validateEntry,
  DEFAULT_CONFIG,
  CONSTANTS: {
    SCHEMA_VER, KINDS, SUBJECTS, STATUSES, ORIGINS, DIRECTIONS, SPEAKERS,
    PROVENANCE_METHODS, SUPERSEDED_REASONS, RELATED_RELS,
    TRANSITIONS, TRANSITION_REASONS, TEXT_MAX, PROVENANCE_QUOTE_MAX, NOTE_MAX,
  },
};
