// ============================================================
// Context V2 共享工具：pinned 映射校验 + 记忆浮现清单 + 生产输入组装
// （原 Shadow 模块；S3 观察半区 parseOldMessages/diffContexts/observe 等
//   已于 2026-09-28 随 chat.js 观察分支退役一并删除，仅 test_shadow 随删）
// 文件名保留 context-v2-shadow.js（require 路径稳定，免三方改动）。
//
// 生产消费方：context-v2-runtime（assembleInput/appendFloatIds）、
// server.js /admin/cross-window-inject 预览（assembleInput）、
// tests/context-v2/test_pinned_map（validatePinnedMap/loadPinnedMap）。
//
// pinned 映射 schema（context_v2_pinned_map.json）：
// {
//   "version": 1,                        // 正整数，映射修订版号（record 里溯源）
//   "updatedAt": "2026-09-17T…",         // 可选， ISO 时间
//   "entries": [
//     { "pinnedId": "…",                 // 对应 pinned.json 条目 id
//       "target": "identity" | "moments_anchor" | "retire" | "instructions",
//       "reason": "一句话归类理由" }
//   ]
// }
// 完整性口径：entries 的 pinnedId 集合必须与 pinned.json 全部 id 恰好相等
// （缺=漏归类，多=指向已删除条目，都算错误）。
// ============================================================

const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");

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
// 记忆浮现清单（context_v2_floated.json，0918 拍板）
// Relevant 命中（≥0.30）的原样写入时间线（（记忆浮现）+原文，mem_id 在元数据字段，
// LLM 清洗自动剥离不进上下文），清单记录「本会话已浮现」的记忆 id，组装时 Relevant
// 剥除防重复。浮现消息是特殊事件（isSpecialEvent 判定列表既有「（记忆浮现」前缀），
// 被压缩保护永不被替换，故清单只增不抹、无「压缩后复注入」场景。
// ============================================================

/** 读整张清单 { <sessionId>: [memId, ...] }；文件缺失/坏→空对象 */
function readFloatMap(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    return m;
  } catch (e) { return {}; }
}

/** 某会话已浮现的记忆 id 数组 */
function floatIdsForSession(file, sessionId) {
  const map = readFloatMap(file);
  const arr = map[String(sessionId || "default")];
  return Array.isArray(arr) ? arr.map(String) : [];
}

/** 追加浮现 id（幂等去重），写回文件（自动建目录）。返回该会话更新后的全量数组 */
function appendFloatIds(file, sessionId, memIds) {
  const map = readFloatMap(file);
  const key = String(sessionId || "default");
  const arr = Array.isArray(map[key]) ? map[key].map(String) : [];
  for (const id of memIds || []) {
    const s = String(id);
    if (s && !arr.includes(s)) arr.push(s);
  }
  map[key] = arr;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 1), "utf8");
  return arr;
}

// ============================================================
// 生产输入组装（2026-09-19 自 routes/chat.js 抽出共享）
// 主聊天（经 context-v2-runtime）与跨窗口注入预览（server.js /admin/cross-window-inject）
// 共用同一组装。全部只读，异常由调用点 try/catch 兜底。
// 未进 context_v2_pinned_map.json 的 pinned 条目按 retire 处理（不进任何注入块，报告可见）。
// ============================================================

/** 扫描 diary/ 全部日记（会话子目录收一层），按日期升序；rel=相对 diary/ 的路径（隐藏清单键） */
function readDiaryEntriesForShadow(baseDir) {
  const out = [];
  const scan = (relBase, depth) => {
    const root = relBase ? path.join(baseDir, 'diary', relBase) : path.join(baseDir, 'diary');
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.isFile() && /^\d{4}-\d{2}-\d{2}(_\d{6})?\.md$/.test(ent.name)) {
        const rel = relBase ? relBase + '/' + ent.name : ent.name;
        try { out.push({ rel, date: ent.name.slice(0, 10), content: fs.readFileSync(path.join(root, ent.name), 'utf8') }); } catch (e) {}
      } else if (ent.isDirectory() && depth < 1) {
        scan(relBase ? relBase + '/' + ent.name : ent.name, depth + 1); // 会话子目录收一层
      }
    }
  };
  scan('', 0);
  return out.sort((a, b) => (a.date === b.date ? (a.rel < b.rel ? -1 : 1) : String(a.date).localeCompare(String(b.date))));
}

// 隐藏清单（data/diary_hidden.json，rel 路径数组）：隐藏篇不注入也不占份数（与旧版 recentDiaryTextBefore 同口径）
function readDiaryHiddenSetForShadow(dataDir) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(dataDir, 'diary_hidden.json'), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter(x => typeof x === 'string' && x));
  } catch (e) {}
  return new Set();
}

// 会话创建日期（与旧版 server.js sessionCreatedAtOf + recentDiaryTextBefore 同口径）：
// 创建时刻=时间线首条非 system 且带 time 的消息 → 时区化日期；无时间线=当前时刻；解析失败=空串（不注入日记）。
function sessionDiaryCutoffDate(sessionId, loadTimeline) {
  let createdIso = '';
  try {
    const tl = loadTimeline(sessionId || 'default') || [];
    for (const m of tl) { if (m && m.role !== 'system' && m.time) { createdIso = m.time; break; } }
  } catch (e) {}
  if (!createdIso) createdIso = new Date().toISOString();
  try {
    const d = new Date(createdIso);
    if (!isNaN(d.getTime())) {
      const p = getDatePartsInTimeZone(d, resolveTimeZone());
      return p.year + '-' + p.month + '-' + p.day;
    }
  } catch (e) {}
  return '';
}

/**
 * 组装 buildContextBlocks 的输入（原 buildCtxV2ShadowInput，逻辑零变化）。
 * opts: { baseDir, sessionId, llmMessages, loadTimeline, normalizeContentToText }
 * llmMessages 仅用于提取 query（Relevant 检索用），预览场景传 [] 即可。
 */
function assembleInput(opts) {
  const dataDir = path.join(opts.baseDir, 'data');
  let pinnedEntries = [];
  let shadowMap = null;
  try {
    const pinned = JSON.parse(fs.readFileSync(path.join(dataDir, 'pinned.json'), 'utf8'));
    try {
      shadowMap = JSON.parse(fs.readFileSync(path.join(dataDir, 'context_v2_pinned_map.json'), 'utf8'));
      if (!shadowMap || !Array.isArray(shadowMap.entries)) shadowMap = null;
    } catch (e) { shadowMap = null; }
    const byId = new Map((shadowMap && Array.isArray(shadowMap.entries) ? shadowMap.entries : []).map(e => [e.pinnedId, e.target]));
    pinnedEntries = (Array.isArray(pinned) ? pinned : []).map(p => ({
      id: p && p.id, title: p && p.title, content: p && p.content,
      target: byId.get(p && p.id) || 'retire',
    }));
  } catch (e) {}
  let timeline = [];
  try {
    timeline = (opts.loadTimeline(opts.sessionId) || []).map(m => ({
      role: m && m.role,
      content: typeof (m && m.content) === 'string' ? m.content : '',
    }));
  } catch (e) {}
  let memoriesV2 = [];
  try { memoriesV2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory_v2.json'), 'utf8')); } catch (e) {}
  let query = '';
  try {
    const llmMessages = Array.isArray(opts.llmMessages) ? opts.llmMessages : [];
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      const m = llmMessages[i];
      if (m && m.role === 'user') { query = opts.normalizeContentToText(m.content) || ''; break; }
    }
  } catch (e) {}
  // 记忆浮现清单：本会话已写入时间线的记忆 id，Relevant 检索剥除防重复（0918 拍板）
  let excludeIds = [];
  try {
    excludeIds = floatIdsForSession(path.join(dataDir, 'context_v2_floated.json'), opts.sessionId);
  } catch (e) {}
  // 日记篇数跟随管理台配置（0919 用户拍板：按我设定的数量来）
  let diaryCount = 3;
  try { diaryCount = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'memory_pool_config.json'), 'utf8')).cross_inject_diary_count) || 3; } catch (e) {}
  // map 挂在 v2Input 上供溯源（builder 只读已知字段，多余键无害）
  // 日记过滤（2026-09-20 恢复旧注入边界，用户拍板）：只留「严格早于会话创建日期」且未被隐藏的篇，
  // 创建之后写的日记由本会话时间线的日记特殊事件自然覆盖，不再跨窗口重复注入；边界缺失时不注入任何日记。
  const hiddenDiary = readDiaryHiddenSetForShadow(dataDir);
  const cutoffDate = sessionDiaryCutoffDate(opts.sessionId, opts.loadTimeline);
  const diaryEntries = cutoffDate
    ? readDiaryEntriesForShadow(opts.baseDir).filter(e => e.date < cutoffDate && !hiddenDiary.has(e.rel))
    : [];
  return { pinnedEntries, timeline, diaryEntries, memoriesV2, query, excludeIds, map: shadowMap, config: { diaryCount } };
}

module.exports = {
  validatePinnedMap,
  loadPinnedMap,
  appendFloatIds,
  assembleInput,
};
