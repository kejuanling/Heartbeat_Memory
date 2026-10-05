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
//       "target": "assembly" | "identity" | "retire" | "instructions",
//       "reason": "一句话归类理由" }
//   ]
// }
// 完整性口径：entries 的 pinnedId 集合必须与 pinned.json 全部 id 恰好相等
// （缺=漏归类，多=指向已删除条目，都算错误）。
// ============================================================

const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const { safeSessionToken } = require("./lib/session-token"); // 1003-12：排除本会话写的日记
const diaryStore = require("./lib/diary-store");

const TARGETS = ["assembly", "identity", "retire", "instructions"];

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

/** 读 data/diary.json 全部日记（diary-store）；id 升序=创建顺序；date=created_at 的本地日期；hidden 为字段 */
function readDiaryEntriesForShadow(baseDir) {
  // 2026-10-03：日记改 JSON 单存储；输出字段 id/date/content/hidden/session
  const tz = resolveTimeZone();
  return diaryStore.listEntries(baseDir).map(e => {
    const p = getDatePartsInTimeZone(new Date(e.created_at), tz);
    return { id: e.id, date: `${p.year}-${p.month}-${p.day}`, content: e.content, hidden: e.hidden, session: e.session };
  });
}

// 会话创建日期（2026-10-03：原注释所指的 server.js sessionCreatedAtOf / recentDiaryTextBefore 已随 V1 删除，
// 本函数是唯一实现，以下口径即当前口径）：
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
// 1002 §8 第 6 项：两块 LLM 总结缓存（每晚定时按记忆池指纹更新）。
// 缓存为空/不存在 → 返回 null，builder 自动回落「直注条目原文」的老逻辑（降级链最底一档）。
function readSummaryBlocks(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory_summary_cache.json'), 'utf8'));
    const ci = (c && c.core_identity && Array.isArray(c.core_identity.lines)) ? c.core_identity.lines : [];
    const un = (c && c.understanding && Array.isArray(c.understanding.lines)) ? c.understanding.lines : [];
    return (ci.length || un.length) ? { core_identity: ci, understanding: un } : null;
  } catch (e) { return null; }
}

// 固定块来源（pinned.json + 目标映射）。快照模式的 minimal 输入也要用它，故抽出并导出。
function readPinnedEntries(dataDir) {
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
      order: p && p.order,
      target: byId.get(p && p.id) || 'retire',
    }));
    // 1002-14：按 pinned.order 升序（与 memory-engine.getPinnedMemories 同口径），缺省 0
    pinnedEntries.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  } catch (e) {}
  return { pinnedEntries, map: shadowMap };
}

function assembleInput(opts) {
  const dataDir = path.join(opts.baseDir, 'data');
  const pinnedData = readPinnedEntries(dataDir);
  const pinnedEntries = pinnedData.pinnedEntries;
  const shadowMap = pinnedData.map;
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
  // 0928：V1 memory_pool_config.json 已归档，篇数配置迁 data/cross_inject_config.json（管理台配置页可调）
  let diaryCount = 3;
  try { diaryCount = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'cross_inject_config.json'), 'utf8')).cross_inject_diary_count) || 3; } catch (e) {}
  // map 挂在 v2Input 上供溯源（builder 只读已知字段，多余键无害）
  // 日记过滤（1003-12 用户拍板）：注入「创建日当天及之前」（date <= 会话创建日）且未被隐藏的篇；
  // 本会话自己写的日记（session === 本会话）由时间线 [DIARY] 事件自然覆盖，跨窗口不重复注入。
  // 当天日记里旧窗口写的注入、本会话写的不注入；之后的日记不注入。边界缺失时不注入任何日记。
  const cutoffDate = sessionDiaryCutoffDate(opts.sessionId, opts.loadTimeline);
  const selfSession = (function () { const t = safeSessionToken(opts.sessionId || "default"); return t === "default" ? null : t; })();
  // 2026-10-03：hidden 用日记字段（不再读 diary_hidden.json）
  const diaryEntries = cutoffDate
    ? readDiaryEntriesForShadow(opts.baseDir).filter(e => e.date <= cutoffDate && !e.hidden && e.session !== selfSession)
    : [];
  return { pinnedEntries, timeline, diaryEntries, memoriesV2, query, excludeIds, map: shadowMap, config: { diaryCount }, summaryBlocks: readSummaryBlocks(dataDir), sessionId: opts.sessionId || null };
}

module.exports = {
  validatePinnedMap,
  loadPinnedMap,
  appendFloatIds,
  assembleInput,
  readPinnedEntries,
  readSummaryBlocks,
};
