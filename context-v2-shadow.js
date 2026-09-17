// ============================================================
// Context V2 Shadow（C10 S2-A）—— pinned 映射校验 + 新旧上下文 diff + JSONL 落盘
//
// 设计契约：接入分析（gpt串口\21.txt 第四节 Shadow 模式）＋ v1.1（19.txt）。
// S2-A 范围：纯模块，不被任何生产链路调用；文件写入路径完全由调用方参数指定
// （测试一律 tmp 目录，生产落点 data/context_shadow/ 由 S2-B 接线时传入）。
//
// pinned 映射 schema（context_v2_pinned_map.json）：
// {
//   "version": 1,                        // 正整数，映射修订版号（record 里溯源）
//   "updatedAt": "2026-09-17T…",         // 可选， ISO 时间
//   "entries": [
//     { "pinnedId": "…",                 // 对应 pinned.json 条目 id
//       "target": "identity" | "moments_anchor" | "retire",
//       "reason": "一句话归类理由" }      // 人工归类可追溯（12.txt 风险 4：拆分逐条打钩）
//   ]
// }
// 完整性口径：entries 的 pinnedId 集合必须与 pinned.json 全部 id 恰好相等
// （缺=漏归类，多=指向已删除条目，都算错误）。
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { estimateTokens, buildContextBlocks } = require("./context-v2-builder");

const TARGETS = ["identity", "moments_anchor", "retire", "instructions"];

// ============================================================
// pinned 映射校验
// ============================================================

/**
 * 校验 pinned 映射。全量收集错误（不只第一条）。
 * @param map 待校验对象（已 JSON.parse）
 * @param opts { expectedIds?: string[] } 传入时做完整性校验（恰好覆盖）
 * @returns {ok, errors: [{code, message, ids?}]}
 * codes: BAD_STRUCTURE / BAD_VERSION / BAD_ENTRY / EMPTY_ID / BAD_TARGET / DUPLICATE_ID / MISSING_IDS / UNKNOWN_IDS
 */
function validatePinnedMap(map, opts) {
  const errors = [];
  const options = opts || {};
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, errors: [{ code: "BAD_STRUCTURE", message: "映射必须是对象" }] };
  }
  if (map.version != null && (!Number.isInteger(map.version) || map.version < 1)) {
    errors.push({ code: "BAD_VERSION", message: "version 必须是正整数，实际: " + JSON.stringify(map.version) });
  }
  if (!Array.isArray(map.entries)) {
    errors.push({ code: "BAD_STRUCTURE", message: "entries 必须是数组" });
    return { ok: false, errors };
  }
  const seen = new Set();
  for (let i = 0; i < map.entries.length; i++) {
    const e = map.entries[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      errors.push({ code: "BAD_ENTRY", message: `entries[${i}] 不是对象` });
      continue;
    }
    const id = e.pinnedId;
    const idOk = typeof id === "string" && !!id.trim();
    if (!idOk) {
      errors.push({ code: "EMPTY_ID", message: `entries[${i}].pinnedId 空或非字符串` });
    } else {
      if (seen.has(id)) errors.push({ code: "DUPLICATE_ID", message: `pinnedId 重复: ${id}`, ids: [id] });
      seen.add(id);
    }
    if (!TARGETS.includes(e.target)) {
      errors.push({ code: "BAD_TARGET", message: `entries[${i}].target 非法: ${JSON.stringify(e.target)}（允许 ${TARGETS.join("/")}）`, ids: idOk ? [id] : undefined });
    }
  }
  if (Array.isArray(options.expectedIds)) {
    const expected = new Set(options.expectedIds.map(String));
    const missing = [...expected].filter(id => !seen.has(id));
    const unknown = [...seen].filter(id => !expected.has(id));
    if (missing.length) errors.push({ code: "MISSING_IDS", message: "以下 pinned id 未归类: " + missing.join(","), ids: missing });
    if (unknown.length) errors.push({ code: "UNKNOWN_IDS", message: "映射指向不存在的 pinned id: " + unknown.join(","), ids: unknown });
  }
  return { ok: errors.length === 0, errors };
}

/** 读映射文件并校验基本结构（完整性校验由调用方持 expectedIds 时另行传入）。文件不存在/JSON 坏/结构非法 → throw */
function loadPinnedMap(file) {
  const raw = fs.readFileSync(file, "utf8");
  const map = JSON.parse(raw);
  const v = validatePinnedMap(map);
  if (!v.ok) {
    const err = new Error("pinned 映射非法: " + v.errors.map(e => `[${e.code}] ${e.message}`).join("; "));
    err.code = "BAD_PINNED_MAP";
    err.errors = v.errors;
    throw err;
  }
  if (map.version == null) map.version = 1;
  return map;
}

// ============================================================
// 旧上下文解析（llmMessages → 块视角，供与 v2 blocks 对比）
// ============================================================

const OLD_TAG_KEYS = { "永久上下文": "legacy_pinned", "跨窗口": "legacy_cross" };

function estMessageTokens(content) {
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let t = 0;
    for (const p of content) {
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") t += estimateTokens(p.text);
      else if (p.type === "image" || p.type === "image_url") t += 1000; // 与 context-compactor EST_IMAGE_TOKENS 同口径
      else t += 1;
    }
    return t;
  }
  return 1;
}

/**
 * 生产旧消息数组 → 块视角（与 v2 blocks 同构）。
 * system → "system"；developer[标签] → legacy_pinned / legacy_cross / legacy_other_<标签>；
 * 其余全部消息 → 聚合 "legacy_timeline"（只计 token，不参与行级重复检测——时间线原文 vs v2
 * 条目的共存是设计内行为（Recent Experience），不是「同一信息两处注入」）。
 * @returns [{key, title, content, tokens, empty}]（保持出现顺序）
 */
function parseOldMessages(messages) {
  const blocks = [];
  let timelineTokens = 0;
  let timelineCount = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === "system") {
      const content = typeof m.content === "string" ? m.content : "[非文本人设]";
      blocks.push({ key: "system", title: "System Persona", content, tokens: estimateTokens(content), empty: !content.trim() });
      continue;
    }
    if (m.role === "developer") {
      const c = typeof m.content === "string" ? m.content : "";
      const tagm = c.match(/^\[(.+?)\][ \t]*\n?/);
      const tag = tagm ? tagm[1] : "";
      const key = OLD_TAG_KEYS[tag] || "legacy_other";
      const content = tagm ? c.slice(tagm[0].length) : c;
      blocks.push({
        key,
        title: tag || "Developer",
        content,
        tokens: estimateTokens(content),
        empty: !content.trim(),
      });
      continue;
    }
    timelineTokens += estMessageTokens(m.content);
    timelineCount++;
  }
  if (timelineCount > 0) {
    blocks.push({
      key: "legacy_timeline",
      title: "Timeline",
      content: `（时间线 ${timelineCount} 条消息，token 估算 ${timelineTokens}）`,
      tokens: timelineTokens,
      empty: false,
    });
  }
  return blocks;
}

// ============================================================
// 新旧 diff
// ============================================================

// 参与行级重复检测的块（固定注入块之间；时间线/报告口径块排除）
const OVERLAP_OLD_KEYS = new Set(["legacy_pinned", "legacy_cross", "legacy_other"]);
const OVERLAP_V2_EXCLUDE = new Set(["recent_experience"]);

// 行规范化：trim、合并空白、剥尾部日期后缀「（YYYY-MM-DD）」（v2 条目带轻量时间标注，属同一条目）
function normalizeLine(line) {
  return String(line || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/（\d{4}-\d{2}-\d{2}）$/u, "");
}

/**
 * 对比新旧块。
 * @returns {
 *   old: [{key,title,tokens,empty}], v2: 同,
 *   tokenDelta: {oldTotal, v2Total, v2InjectTotal},   // v2InjectTotal=排除 recent_experience（真正注入量）
 *   overlaps: [{v2Key, oldKey, line}]                  // 行级重复（规范化后精确匹配，行 <6 字符忽略）
 * }
 */
function diffContexts(oldBlocks, v2Blocks) {
  const olds = Array.isArray(oldBlocks) ? oldBlocks : [];
  const v2s = Array.isArray(v2Blocks) ? v2Blocks : [];
  const sum = arr => arr.reduce((s, b) => s + (b.tokens || 0), 0);
  const v2InjectTotal = v2s.filter(b => !OVERLAP_V2_EXCLUDE.has(b.key)).reduce((s, b) => s + (b.tokens || 0), 0);

  // 旧固定块行索引：精确 Set + 原始行数组（供子串包含扫描——v2 截取句常是旧行的子串，
  // 如 Current State 句 ⊂ 跨窗口日记行「（YYYY-MM-DD）日记正文」）
  const oldLineSet = new Map(); // normLine → oldKey（首个）
  const oldLineArr = [];        // [{line, key}]
  for (const b of olds) {
    if (!OVERLAP_OLD_KEYS.has(b.key) || !b.content) continue;
    for (const raw of String(b.content).split("\n")) {
      const n = normalizeLine(raw);
      if (n.length < 4) continue;
      if (!oldLineSet.has(n)) oldLineSet.set(n, b.key);
      oldLineArr.push({ line: n, key: b.key });
    }
  }
  const overlaps = [];
  for (const b of v2s) {
    if (OVERLAP_V2_EXCLUDE.has(b.key) || !b.content) continue;
    const seen = new Set();
    for (const raw of String(b.content).split("\n")) {
      const n = normalizeLine(raw);
      if (n.length < 4 || seen.has(n)) continue;
      seen.add(n);
      if (oldLineSet.has(n)) { overlaps.push({ v2Key: b.key, oldKey: oldLineSet.get(n), line: n }); continue; }
      const sup = oldLineArr.find(o => o.line.includes(n)); // v2 行是旧行子串→旧行为更完整版本
      if (sup) overlaps.push({ v2Key: b.key, oldKey: sup.key, line: n });
    }
  }
  return {
    old: olds.map(b => ({ key: b.key, title: b.title, tokens: b.tokens || 0, empty: !!b.empty })),
    v2: v2s.map(b => ({ key: b.key, title: b.title, tokens: b.tokens || 0, empty: !!b.empty })),
    tokenDelta: { oldTotal: sum(olds), v2Total: sum(v2s), v2InjectTotal },
    overlaps,
  };
}

// ============================================================
// JSONL 落盘
// ============================================================

/** 按月滚动文件名：dir/context_shadow_YYYYMM.jsonl */
function buildShadowPath(dir, now) {
  const d = now instanceof Date ? now : new Date();
  const ym = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0");
  return path.join(dir, `context_shadow_${ym}.jsonl`);
}

/** 追加一条记录（自动建目录；单行 JSON + \n）。返回 record（含补齐的 ts） */
function appendShadowRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  return record;
}

/** 读回 JSONL：坏行跳过并计数（审计断链视为 P0 的反向要求——读取端容错，统计坏行数） */
function readShadowRecords(file) {
  if (!fs.existsSync(file)) return { records: [], badLines: 0 };
  const records = [];
  let badLines = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s));
    } catch (e) {
      badLines++;
    }
  }
  return { records, badLines };
}

// ============================================================
// 组合入口（S2-B 接线时一行调用）
// ============================================================

/** 从 v2 块提取观察样本（截断存 JSONL，控体积）：Current State 截取与 Relevant 检索的实际文本 */
function extractSamples(v2Blocks) {
  const get = (key, max) => {
    const b = (Array.isArray(v2Blocks) ? v2Blocks : []).find(x => x && x.key === key);
    return b && b.content ? String(b.content).slice(0, max) : "";
  };
  return { current_state: get("current_state", 200), relevant_memories: get("relevant_memories", 400) };
}

/**
 * 一次 shadow 观察：解析旧消息 → diff → 组 record（ts/sessionId/mapVersion/durationMs）→ 追加落盘。
 * @param p { sessionId, map?, oldMessages, v2Blocks, file, now? }
 * @returns { record, file }
 */
function observe(p) {
  const started = Date.now();
  const params = p || {};
  const diff = diffContexts(parseOldMessages(params.oldMessages), params.v2Blocks);
  const record = {
    ts: params.now instanceof Date ? params.now.toISOString() : new Date().toISOString(),
    sessionId: params.sessionId == null ? null : String(params.sessionId),
    mapVersion: params.map && params.map.version != null ? params.map.version : null,
    old: diff.old,
    v2: diff.v2,
    tokenDelta: diff.tokenDelta,
    overlaps: diff.overlaps,
    samples: extractSamples(params.v2Blocks),
    durationMs: Date.now() - started,
  };
  appendShadowRecord(params.file, record);
  return { record, file: params.file };
}

/** sessionId 脱敏：md5 前 8 位（记录不落原文会话 id） */
function maskSessionId(sessionId) {
  const s = String(sessionId == null ? "" : sessionId);
  if (!s) return "s_none";
  return "s_" + crypto.createHash("md5").update(s).digest("hex").slice(0, 8);
}

/**
 * 接线包装（chat.js S2-B1 调用点）：flag 关=零开销直返（不读数据不落盘）；
 * flag 开=构建 V2 块→observe 落盘；任何异常只记 error 返回，绝不向主聊天抛出。
 * @param o { flag, sessionId, oldMessages, v2Input, file, now? }
 * @returns {skipped:true} | {record, file} | {error}
 */
function maybeObserve(o) {
  const p = o || {};
  if (p.flag !== true) return { skipped: true };
  try {
    const input = p.v2Input || {};
    const built = buildContextBlocks(input);
    const { record } = observe({
      sessionId: maskSessionId(p.sessionId),
      oldMessages: p.oldMessages,
      v2Blocks: built.blocks,
      map: input.map, // chat 侧组装时挂在 v2Input 上（mapVersion 溯源）
      file: p.file,
      now: p.now,
    });
    return { record, file: p.file };
  } catch (e) {
    console.error("[ctx-v2-shadow] shadow 失败（不影响主聊天）:", e && e.message);
    return { error: e && e.message };
  }
}

module.exports = {
  TARGETS,
  validatePinnedMap,
  loadPinnedMap,
  parseOldMessages,
  diffContexts,
  buildShadowPath,
  appendShadowRecord,
  readShadowRecords,
  observe,
  maskSessionId,
  maybeObserve,
};
