"use strict";
/*
 * 上下文替换模块（统一版）
 *
 * 说明：
 * - 所有「替换」统一为同一种记录：把一段原文对话替换成一段浓缩文字（回忆/摘要）。
 * - 来源只有展示意义：source = "ai"（AI 工具 context_replace 创建）| "manual"（后台手动创建）。
 * - 生效逻辑统一：发送前按内容锚点定位记录范围，替换成占位消息；源时间线不动。
 * - 旧压缩器（context-compactor）的发送路径已停用，由本模块统一处理。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const REPLACEMENTS_FILE = path.join(DATA_DIR, "context_replacements.json");
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");

const MAX_MEMORY_CHARS = 100000;

// ========================
// 每次请求的替换/压缩记录（供管理台查看；含对话/共影/唤醒等所有来源）
// ========================
const REPLACE_LOG_FILE = path.join(DATA_DIR, "context_replace_log.json");
const REPLACE_LOG_CAP = 200;
let _replaceLogCache = null;

function _ensureReplaceLog(force) {
  if (_replaceLogCache === null || force) {
    let v = readJson(REPLACE_LOG_FILE, []);
    _replaceLogCache = Array.isArray(v) ? v : [];
  }
  return _replaceLogCache;
}

function appendReplaceLog(entry) {
  try {
    const log = _ensureReplaceLog();
    log.push(entry);
    if (log.length > REPLACE_LOG_CAP) log.splice(0, log.length - REPLACE_LOG_CAP);
    writeJsonAtomic(REPLACE_LOG_FILE, log);
  } catch (e) {
    console.warn("[context-replacements] 替换日志写入失败:", e.message);
  }
}

function getReplaceLog(cap) {
  // 每次从磁盘重读，确保查询结果与持久化记录一致
  const log = _ensureReplaceLog(true);
  const n = Math.max(0, Math.min(Number(cap) > 0 ? Number(cap) : 50, log.length));
  return log.slice(log.length - n).reverse();
}

// ========================
// 基础工具
// ========================
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    console.warn("[context-replacements] 读取失败:", file, err.message);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function backupFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, file + ".bak-" + ts);
  } catch (err) {
    console.warn("[context-replacements] 备份失败:", err.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

// 判断消息是否为「替换」生成的占位消息（压缩/唤醒等环节需保护，避免被吞掉）
function isReplacementMemoryMessage(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const c = String(msg.content || "");
  return c.startsWith("（回忆 · ") || c.startsWith("（对话摘要");
}

// 归一化内容：剥离内部标签（<memory>/<pin> 等）、压缩空白，用于消息匹配
function normalizeContent(value) {
  return String(value || "")
    .replace(/<\s*memory\b[^>]*>[\s\S]*?<\/\s*memory\s*>/gi, " ")
    .replace(/<\s*pin\b[^>]*>[\s\S]*?<\/\s*pin\s*>/gi, " ")
    .replace(/<\s*(?:memory|pin)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 解析消息时间：优先 m.time，其次内容开头的墙上时间前缀
function messageTime(m) {
  if (m && m.time) {
    const d = new Date(m.time);
    if (!isNaN(d.getTime())) return d;
  }
  if (m && typeof m.content === "string") {
    const match = m.content.match(/^（?\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})?[:：]?(\d{2})?/);
    if (match) {
      const y = Number(match[1]);
      const mo = Number(match[2]);
      const dd = Number(match[3]);
      const hh = match[4] ? Number(match[4]) : 0;
      const mm = match[5] ? Number(match[5]) : 0;
      const d = new Date(y, mo - 1, dd, hh, mm);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// 解析时间范围边界：带 Z 的按 UTC；不带 Z 的按服务器本地墙上时间（Asia/Shanghai）
function parseRangeBound(value) {
  if (value === undefined || value === null || value === "") return null;
  let s = String(value).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2})[:：]?(\d{1,2})?)?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const dd = Number(m[3]);
    const hh = m[4] ? Number(m[4]) : 0;
    const mm = m[5] ? Number(m[5]) : 0;
    const d = new Date(y, mo - 1, dd, hh, mm);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ========================
// 消息判断（与旧压缩器口径一致，发送链路统一后迁到本模块）
// ========================

function contentToText(msg) {
  const c = msg && msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map(function (p) {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return p.text || p.content || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isSpecialEvent(msg) {
  if (!msg || msg.role !== "assistant") return false;
  const c = String(msg.content || "");
  return (
    c.indexOf("自动唤醒") !== -1 ||
    c.indexOf("推送") !== -1 ||
    c.indexOf("自动写了日记") !== -1 ||
    c.indexOf("记忆浮现") !== -1 ||
    c.indexOf("时间标记") !== -1 ||
    c.indexOf("摘要）") !== -1 ||
    c.indexOf("共影）") !== -1
  );
}

function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return String(msg.content || "").indexOf("记忆浮现") !== -1;
}

// 日记特殊事件：AI 唤醒时自动写的日记，永远不参与压缩，单独保留在上下文
function isDiaryEvent(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return String(msg.content || "").indexOf("自动写了日记") !== -1;
}

function isCompressible(msg, includeEvents) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
  if (isDiaryEvent(msg)) return false; // 日记永远不压缩
  if (!includeEvents && msg.role === "assistant" && isSpecialEvent(msg)) return false;
  if (msg.tool_calls || msg.tool_call_id) return false;
  return contentToText(msg).trim().length > 0;
}

// 内容定位锚点：去内部标签 + 去首尾空白，容忍清洗/标签差异
function normalizedCompareKey(msg) {
  const role = (msg && msg.role) || "";
  const c = String(contentToText(msg) || "");
  const stripped = c
    .replace(/<memory>[\s\S]*?<\/memory>/gi, "")
    .replace(/<pin>[\s\S]*?<\/pin>/gi, "")
    .replace(/<current_time>[\s\S]*?<\/current_time>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return role + "\u0000" + stripped;
}

function mergeAdjacentSameRole(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if ((m.role === "user" || m.role === "assistant") &&
        !m.tool_calls && !m.tool_call_id &&
        typeof m.content === "string" && !m._ccSummary && !m._ctxRep) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role && !prev.tool_calls && !prev.tool_call_id &&
          typeof prev.content === "string" && !prev._ccSummary && !prev._ctxRep) {
        prev.content = prev.content + "\n\n" + m.content;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

function fmtWall(d) {
  const p = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

// ========================
// 数据读写
// ========================
function loadItems() {
  const items = readJson(REPLACEMENTS_FILE, []);
  return Array.isArray(items) ? items : [];
}

function saveItems(items) {
  backupFile(REPLACEMENTS_FILE);
  writeJsonAtomic(REPLACEMENTS_FILE, items);
}

function recordText(item) {
  const t = item && (item.text || item.memory);
  return typeof t === "string" ? t : "";
}

// 对外展示用的条目（不含完整 matched 原文，避免响应过大）
function publicItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    created_at: item.created_at,
    source: item.source || "ai",
    text: recordText(item),
    memory: recordText(item),
    range: item.range || {},
    range_label: item.range_label || "",
    count: item.count || 0,
    removed: !!item.removed,
    enabled: item.enabled !== false
  };
}

// 压缩页预览用：额外带一小段被替换原文的预览（最多 2 条、每条截断）
function listReplacementsForPreview() {
  return loadItems().map(item => {
    const pub = publicItem(item);
    pub.original_preview = (item.matched || []).slice(0, 2).map(m => ({
      role: m.role,
      content: String(m.content || "").slice(0, 150)
    }));
    pub.start_time = (item.range && item.range.start_time) || "";
    pub.end_time = (item.range && item.range.end_time) || "";
    pub.messages = (item.matched || []).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : ""
    }));
    // 时间段 -> 时间线编号（0-based，展示时 +1）
    const resolved = resolveRange(item.range);
    if (resolved && resolved.ok) {
      pub.firstIdx = resolved.start_index;
      pub.lastIdx = resolved.end_index;
    } else {
      pub.firstIdx = -1;
      pub.lastIdx = -1;
    }
    return pub;
  });
}

function listReplacements() {
  return loadItems().map(publicItem);
}

// ========================
// 时间线
// ========================
function loadTimeline() {
  return readJson(TIMELINE_FILE, []);
}

function nonSystemMessages(timeline) {
  return (Array.isArray(timeline) ? timeline : []).filter(m => m && m.role !== "system");
}

// 压缩索引空间：非 system 且可压缩的消息（与旧压缩器一致）
function compressibleItems() {
  const timeline = loadTimeline();
  const items = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, true)) items.push({ msg: m, idx: i });
  });
  return items;
}

// ========================
// 范围解析：把「时间范围 / 编号范围」映射到具体消息
// ========================
function resolveRange(range) {
  const timeline = nonSystemMessages(loadTimeline());
  const rng = range || {};
  const hasTime = rng.start_time !== undefined && rng.start_time !== null && rng.start_time !== ""
    || rng.end_time !== undefined && rng.end_time !== null && rng.end_time !== "";
  const hasIndex = rng.start_index !== undefined && rng.start_index !== null
    || rng.end_index !== undefined && rng.end_index !== null;

  let matched = [];
  let rangeLabel = "";

  let firstIdx = -1;
  let lastIdx = -1;
  if (hasIndex) {
    const start = Math.max(0, Math.floor(Number(rng.start_index !== undefined ? rng.start_index : rng.end_index) || 0));
    const end = rng.end_index !== undefined && rng.end_index !== null
      ? Math.floor(Number(rng.end_index))
      : start;
    if (start > end) return { ok: false, error: "start_index 不能大于 end_index" };
    if (end >= timeline.length) {
      return { ok: false, error: "编号越界：当前时间线共 " + timeline.length + " 条非系统消息，end_index 最大 " + (timeline.length - 1) };
    }
    matched = timeline.slice(start, end + 1);
    rangeLabel = "#" + start + " ~ #" + end;
    firstIdx = start;
    lastIdx = end;
  } else if (hasTime) {
    const startD = parseRangeBound(rng.start_time);
    const endD = parseRangeBound(rng.end_time);
    if (!startD && !endD) return { ok: false, error: "时间范围无法解析" };
    if (startD && endD && startD > endD) return { ok: false, error: "start_time 不能晚于 end_time" };
    firstIdx = -1;
    lastIdx = -1;
    timeline.forEach(function (m, i) {
      const t = messageTime(m);
      if (!t) return;
      if (startD && t < startD) return;
      if (endD && t > endD) return;
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    });
    if (firstIdx === -1) {
      return { ok: false, error: "范围内没有匹配到任何消息（可能时间不准，可先用检索工具确认）" };
    }
    matched = timeline.slice(firstIdx, lastIdx + 1);
    rangeLabel = (rng.start_time || "…") + " ~ " + (rng.end_time || "…");
  } else {
    return { ok: false, error: "需要提供时间范围（start_time/end_time）或编号范围（start_index/end_index）" };
  }

  if (matched.length === 0) {
    return { ok: false, error: "范围内没有匹配到任何消息（可能时间/编号不准，可先用检索工具确认）" };
  }
  return { ok: true, matched: matched, count: matched.length, range_label: rangeLabel, start_index: firstIdx, end_index: lastIdx };
}

// ========================
// 新增替换（AI 工具）
// ========================
function addReplacement(options) {
  const text = String((options && (options.text || options.memory)) || "").trim();
  if (!text) return { ok: false, error: "替换正文不能为空" };
  if (text.length > MAX_MEMORY_CHARS) {
    return { ok: false, error: "替换正文太长（" + text.length + " 字，上限 " + MAX_MEMORY_CHARS + "）" };
  }
  const resolved = resolveRange(options && options.range);
  if (!resolved.ok) return resolved;

  const item = {
    id: "ctxrep_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    created_at: nowIso(),
    source: "ai",
    text: text,
    memory: text,
    range: (options && options.range) || {},
    range_label: resolved.range_label,
    matched: resolved.matched.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : ""
    })),
    count: resolved.count,
    removed: false
  };

  const items = loadItems();
  items.push(item);
  saveItems(items);
  console.log("[context-replacements] 新增替换（AI）：", item.range_label, "->", text.slice(0, 40).replace(/\n/g, " "), "...");

  return { ok: true, id: item.id, count: item.count, range_label: item.range_label, message: "已记录替换：" + item.count + " 条消息 → 替换正文" };
}

// ========================
// 手工记录管理（后台）
// ========================

function rangeLabelOf(slice) {
  let minT = null;
  let maxT = null;
  slice.forEach(function (e) {
    const t = messageTime(e.msg);
    if (!t) return;
    const v = t.getTime();
    if (minT === null || v < minT) minT = v;
    if (maxT === null || v > maxT) maxT = v;
  });
  return (minT !== null ? fmtWall(new Date(minT)) : "?") + " ~ " + (maxT !== null ? fmtWall(new Date(maxT)) : "?");
}

function manualStart(it) {
  const s = it && it.range && it.range.start_index;
  return Number.isInteger(s) ? s : Number.MAX_SAFE_INTEGER;
}

function manualRecordsSorted() {
  return loadItems()
    .filter(it => it.source === "manual" && !it.removed)
    .sort((a, b) => manualStart(a) - manualStart(b));
}

function manualRecordAt(index) {
  const list = manualRecordsSorted();
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  return { record: list[index], index: index };
}

function buildManualRecord(start, end, enabled) {
  const items = compressibleItems();
  if (start < 0 || end < start) return { ok: false, message: "无效的范围" };
  if (start >= items.length) return { ok: false, message: "起始编号超出当前消息总数" };
  const ee = Math.min(end, items.length - 1);
  const slice = items.slice(start, ee + 1);
  if (slice.length === 0) return { ok: false, message: "范围内没有可压缩消息" };
  return {
    ok: true,
    record: {
      id: "ctxrep_manual_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      created_at: nowIso(),
      source: "manual",
      text: "",
      memory: "",
      range: { start_index: start, end_index: ee },
      range_label: rangeLabelOf(slice),
      matched: slice.map(e => ({
        role: e.msg.role,
        content: typeof e.msg.content === "string" ? e.msg.content : contentToText(e.msg)
      })),
      count: slice.length,
      enabled: enabled === true,
      removed: false
    },
    slice: slice
  };
}

// 新增手工块（吞并重叠的旧手工块；默认 enabled=false，点「替换」才生效）
function addManualRecord(start, end, enabled) {
  const built = buildManualRecord(start, end, enabled);
  if (!built.ok) return built;
  const items = loadItems();
  const filtered = [];
  let removedCount = 0;
  for (const it of items) {
    if (it.source === "manual") {
      const rs = it.range && it.range.start_index;
      const re = it.range && it.range.end_index;
      if (Number.isInteger(rs) && Number.isInteger(re) && rs <= built.record.range.end_index && re >= built.record.range.start_index) {
        removedCount++;
        continue;
      }
    }
    filtered.push(it);
  }
  filtered.push(built.record);
  saveItems(filtered);
  return { ok: true, record: built.record, removedCount: removedCount };
}

function removeManualRecord(index) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  const items = loadItems();
  const filtered = items.filter(it => it.id !== found.record.id);
  if (filtered.length === items.length) return { ok: false, message: "块不存在" };
  saveItems(filtered);
  return { ok: true };
}

function toggleManualRecord(index, enabled) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  const items = loadItems();
  const it = items.find(x => x.id === found.record.id);
  if (!it) return { ok: false, message: "块不存在" };
  it.enabled = enabled !== false;
  saveItems(items);
  return { ok: true, record: publicItem(it) };
}

function updateManualRecordRange(index, start, end) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  const items = loadItems();
  const cur = items.find(function (x) { return x.id === found.record.id; });
  if (!cur) return { ok: false, message: "块不存在" };
  const compItems = compressibleItems();
  const curRange = recordCompRange(cur, compItems);
  if (!curRange) return { ok: false, message: "无法定位该块的原文范围" };
  // 计算并集范围：吸收所有与 [start,end] 重叠的其他块（手工 + AI）
  let mergedStart = Math.min(start, curRange.start);
  let mergedEnd = Math.max(end, curRange.end);
  const absorbed = [];
  for (const it of items) {
    if (it.id === cur.id || it.removed) continue;
    const r = recordCompRange(it, compItems);
    if (!r) continue;
    if (r.start <= mergedEnd && r.end >= mergedStart) {
      absorbed.push({ it: it, r: r });
      if (r.end > mergedEnd) mergedEnd = r.end;
      if (r.start < mergedStart) mergedStart = r.start;
    }
  }
  const built = buildManualRecord(mergedStart, mergedEnd, cur.enabled !== false);
  if (!built.ok) return built;
  // 摘要拼接：当前块 + 被吸收块（按原文位置顺序）
  absorbed.sort(function (a, b) { return a.r.start - b.r.start; });
  const parts = [recordText(cur)].concat(absorbed.map(function (a) { return recordText(a.it); })).filter(Boolean);
  const mergedText = parts.join("\n\n");
  cur.range = built.record.range;
  cur.range_label = built.record.range_label;
  cur.matched = built.record.matched;
  cur.count = built.record.count;
  cur.enabled = cur.enabled !== false;
  if (mergedText) { cur.text = mergedText; cur.memory = mergedText; }
  cur.updated_at = nowIso();
  const filtered = items.filter(function (it) { return !absorbed.some(function (a) { return a.it.id === it.id; }); });
  saveItems(filtered);
  return { ok: true, record: publicItem(cur), removedCount: absorbed.length, merged: absorbed.map(function (a) { return a.it.id; }) };
}


// AI 块：按编号范围更新覆盖区间（前端管理台用）。编号为 compressibleItems 下标（与手动块一致）。
// 保留 source=ai，时间范围由新编号段内消息的实际时间重算回写；只改自身，不吞并其他块。
function updateAiRecordRange(repId, startIdx, endIdx) {
  const items = compressibleItems();
  if (!repId) return { ok: false, message: '缺少记录 id' };
  const s = Math.floor(Number(startIdx));
  const e = Math.floor(Number(endIdx));
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) return { ok: false, message: '无效的编号范围' };
  if (s >= items.length) return { ok: false, message: '起始编号超出当前消息总数' };
  const ee = Math.min(e, items.length - 1);
  const list = loadItems();
  const idx = list.findIndex(it => it && it.id === repId && !it.removed);
  if (idx < 0) return { ok: false, message: '记录不存在' };
  const rec = list[idx];
  const curRange = recordCompRange(rec, items);
  if (!curRange) return { ok: false, message: '无法定位该块的原文范围' };
  // 计算并集：吸收所有与 [s, ee] 重叠的其他块（手工 + AI）
  let mergedStart = Math.min(s, curRange.start);
  let mergedEnd = Math.max(ee, curRange.end);
  const absorbed = [];
  for (const it of list) {
    if (it.id === repId || it.removed) continue;
    const r = recordCompRange(it, items);
    if (!r) continue;
    if (r.start <= mergedEnd && r.end >= mergedStart) {
      absorbed.push({ it: it, r: r });
      if (r.end > mergedEnd) mergedEnd = r.end;
      if (r.start < mergedStart) mergedStart = r.start;
    }
  }
  const slice = items.slice(mergedStart, mergedEnd + 1);
  if (slice.length === 0) return { ok: false, message: '范围内没有可压缩消息' };
  let minT = null, maxT = null;
  slice.forEach(function (r) {
    const m = r.msg;
    const t = messageTime && typeof messageTime === 'function' ? messageTime(m) : null;
    if (!t) return;
    const v = t.getTime();
    if (minT === null || v < minT) minT = v;
    if (maxT === null || v > maxT) maxT = v;
  });
  if (minT === null) return { ok: false, message: '新范围内消息缺少时间，无法映射时间范围' };
  rec.range = { start_time: fmtWall(new Date(minT)), end_time: fmtWall(new Date(maxT)) };
  rec.range_label = rangeLabelOf(slice);
  rec.matched = slice.map(function (r) {
    return { role: r.msg.role, content: typeof r.msg.content === 'string' ? r.msg.content : contentToText(r.msg) };
  });
  rec.count = slice.length;
  // 摘要拼接：当前块 + 被吸收块（按原文位置顺序）
  absorbed.sort(function (a, b) { return a.r.start - b.r.start; });
  const parts = [recordText(rec)].concat(absorbed.map(function (a) { return recordText(a.it); })).filter(Boolean);
  const mergedText = parts.join("\n\n");
  if (mergedText) { rec.text = mergedText; rec.memory = mergedText; }
  rec.updated_at = nowIso();
  const filtered = list.filter(function (it) { return !absorbed.some(function (a) { return a.it.id === it.id; }); });
  saveItems(filtered);
  return { ok: true, count: slice.length, record: publicItem(rec), removedCount: absorbed.length, merged: absorbed.map(function (a) { return a.it.id; }) };
}

// 按时间间隔自动切分 [start,end]（1-based 转 0-based），生成多个手工块
function splitRangeByGaps(start, end, gapMinutes) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return { ok: false, message: "无效的范围" };
  }
  const items = compressibleItems();
  if (start >= items.length) return { ok: false, message: "起始编号超出当前消息总数" };
  const ee = Math.min(end, items.length - 1);
  const gapMs = (Number(gapMinutes) || 30) * 60 * 1000;
  const segments = [];
  let segStart = start;
  for (let i = start; i <= ee; i++) {
    const t0 = messageTime(items[i].msg);
    const t1 = i + 1 <= ee ? messageTime(items[i + 1].msg) : null;
    if (t0 && t1 && Math.abs(t1.getTime() - t0.getTime()) >= gapMs) {
      segments.push({ start: segStart, end: i });
      segStart = i + 1;
    }
  }
  segments.push({ start: segStart, end: ee });
  const created = [];
  let removedCount = 0;
  let itemsList = loadItems();
  for (const seg of segments) {
    const built = buildManualRecord(seg.start, seg.end, false);
    if (!built.ok) continue;
    const filtered = [];
    for (const it of itemsList) {
      if (it.source === "manual") {
        const rs = it.range && it.range.start_index;
        const re = it.range && it.range.end_index;
        if (Number.isInteger(rs) && Number.isInteger(re) && rs <= seg.end && re >= seg.start) {
          removedCount++;
          continue;
        }
      }
      filtered.push(it);
    }
    filtered.push(built.record);
    itemsList = filtered;
    created.push(built.record);
  }
  saveItems(itemsList);
  return { ok: true, count: created.length, records: created.map(publicItem), removedCount: removedCount };
}

// 给手工记录写入/更新替换正文（摘要生成后调用）
// ========================
// 历史版本（记录内 history 数组；编辑/覆盖前把旧版归档）
// ========================
const MAX_HISTORY_VERSIONS = 8;

function historyEntryOf(it) {
  return {
    summary: recordText(it),
    generatedAt: it.updated_at || it.created_at || nowIso(),
    mode: it.source === "manual" ? "edited" : "ai",
    manual: it.source === "manual"
  };
}

// 更新 newText 之前，把当前正文归档为新的历史版本
function archiveHistory(item, newText) {
  if (!item || newText === undefined) return;
  const cur = recordText(item);
  if (!cur) return; // 首次填写，无旧版可归档
  const hist = Array.isArray(item.history) ? item.history.slice() : [];
  hist.unshift(historyEntryOf(item));
  if (hist.length > MAX_HISTORY_VERSIONS) hist.length = MAX_HISTORY_VERSIONS;
  item.history = hist;
}

// 恢复某历史版本：当前正文推入历史（成为新版），目标版成为当前正文
function restoreHistory(id, historyIndex) {
  const items = loadItems();
  const it = items.find(function (x) { return x && x.id === id; });
  if (!it) return { ok: false, error: "记录不存在" };
  const hist = Array.isArray(it.history) ? it.history : [];
  const idx = Number(historyIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= hist.length) return { ok: false, error: "历史版本不存在" };
  const target = hist[idx];
  const newHistory = [historyEntryOf(it)].concat(hist.filter(function (_, i) { return i !== idx; }));
  if (newHistory.length > MAX_HISTORY_VERSIONS) newHistory.length = MAX_HISTORY_VERSIONS;
  it.history = newHistory;
  it.text = target.summary;
  it.memory = target.summary;
  it.updated_at = nowIso();
  saveItems(items);
  return { ok: true, summary: target.summary, generatedAt: target.generatedAt, mode: target.mode, history: newHistory };
}

// 删除某条历史版本
function removeHistory(id, historyIndex) {
  const items = loadItems();
  const it = items.find(function (x) { return x && x.id === id; });
  if (!it) return { ok: false, error: "记录不存在" };
  const hist = Array.isArray(it.history) ? it.history : [];
  if (!hist.length) return { ok: false, error: "该块没有历史版本" };
  const idx = Number(historyIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= hist.length) return { ok: false, error: "历史版本不存在" };
  it.history = hist.filter(function (_, i) { return i !== idx; });
  saveItems(items);
  return { ok: true, remaining: it.history.length };
}

function setManualRecordText(index, text) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  const t = String(text || "").trim();
  if (!t) return { ok: false, message: "替换正文不能为空" };
  if (t.length > MAX_MEMORY_CHARS) {
    return { ok: false, message: "替换正文太长（" + t.length + " 字，上限 " + MAX_MEMORY_CHARS + "）" };
  }
  const items = loadItems();
  const it = items.find(x => x.id === found.record.id);
  if (!it) return { ok: false, message: "块不存在" };
  archiveHistory(it, t);
  it.text = t;
  it.memory = t;
  it.updated_at = nowIso();
  saveItems(items);
  return { ok: true, length: t.length, record: publicItem(it) };
}

function removeAllManualRecords() {
  const items = loadItems();
  const filtered = items.filter(it => it.source !== "manual");
  saveItems(filtered);
  return { ok: true, removedCount: items.length - filtered.length };
}

// ========================
// 撤销 / 开关 / 编辑（对任意记录，按 id）
// ========================
function removeReplacement(id) {
  const items = loadItems();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: "未找到该记录" };
  const removed = items.splice(idx, 1)[0];
  saveItems(items);
  console.log("[context-replacements] 已撤销替换：", removed.id, removed.range_label || "");
  return { ok: true, removed: publicItem(removed) };
}

function toggleReplacement(id, enabled) {
  const items = loadItems();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: "未找到该记录" };
  items[idx].enabled = enabled !== false;
  saveItems(items);
  console.log("[context-replacements] 已" + (items[idx].enabled ? "启用" : "停用") + "替换：", items[idx].id, items[idx].range_label || "");
  return { ok: true, item: publicItem(items[idx]) };
}

function updateReplacement(id, text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "替换正文不能为空" };
  if (t.length > MAX_MEMORY_CHARS) {
    return { ok: false, error: "替换正文太长（" + t.length + " 字，上限 " + MAX_MEMORY_CHARS + "）" };
  }
  const items = loadItems();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: "未找到该记录" };
  archiveHistory(items[idx], t);
  items[idx].text = t;
  items[idx].memory = t;
  items[idx].updated_at = nowIso();
  saveItems(items);
  console.log("[context-replacements] 已更新替换正文：", id, items[idx].range_label || "", "->", t.slice(0, 40).replace(/\n/g, " "), "...");
  return { ok: true, item: publicItem(items[idx]) };
}

// ========================
// 应用到发送给 AI 的上下文（统一生效逻辑）
// ========================
function buildMemoryMessage(item) {
  const label = item.range_label ? " · " + item.range_label : "";
  return { role: "assistant", _ctxRep: true, content: "（对话摘要" + label + "）\n" + recordText(item) };
}

// ---------------- 重要内容标记（星星） ----------------
// 与 context-compactor 共用 data/context_compaction_marks.json，key 用 contentKey
const MARKS_FILE = path.join(DATA_DIR, "context_compaction_marks.json");
function loadMarks() {
  try {
    const data = JSON.parse(fs.readFileSync(MARKS_FILE, "utf-8"));
    if (data && data.marks && typeof data.marks === "object") return data.marks;
  } catch (err) { /* 无标记 */ }
  return {};
}
function contentKey(msg) {
  const text = contentToText(msg);
  return crypto.createHash("sha256").update((msg && msg.role ? msg.role : "") + "\u0000" + text).digest("hex").slice(0, 32);
}

// 未发生替换时统一留痕：让每次请求都有记录，便于了解哪些请求没触发上下文替换
function logNoReplace(count, source) {
  try {
    appendReplaceLog({
      time: nowIso(),
      source: source || "对话",
      before: count,
      after: count,
      replaced: 0,
      applied: []
    });
  } catch (e) {
    console.warn("[context-replacements] 记录未替换留痕失败:", e.message);
  }
}

function applyReplacements(messages, source) {
  let items = loadItems().filter(it => !it.removed && it.enabled !== false && recordText(it));
  if (items.length === 0) { logNoReplace(messages.length, source); return messages; }

  const out = Array.isArray(messages) ? messages.slice() : [];
  const marks = loadMarks();

  // 锚点视图：请求里只有「纯对话」消息参与定位（工具/特殊事件/已替换占位全部排除）
  const srcAnchorIdx = [];
  const srcAnchorKeys = [];
  out.forEach(function (m, i) {
    if (!m) return;
    if (m.role === "system") return;
    if (m.role === "tool" || m.tool_calls || m.tool_call_id) return;
    if (isSpecialEvent(m)) return;
    if (isReplacementMemoryMessage(m)) return;
    if (!String(contentToText(m)).trim()) return;
    srcAnchorIdx.push(i);
    srcAnchorKeys.push(normalizedCompareKey(m));
  });
  if (srcAnchorIdx.length === 0) { logNoReplace(messages.length, source); return messages; }

  // 时间线纯对话序列（内容锚点失败时做位置近似兜底）
  const timeline = loadTimeline();
  const tlEntries = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, true)) tlEntries.push({ msg: m, arrIdx: i });
  });
  const tlPurePos = [];
  tlEntries.forEach(function (e, i) { if (!isSpecialEvent(e.msg)) tlPurePos.push(i); });

  // 特殊事件精确时间：优先用时间线保存的精确时间，避免事件落在块起点前几秒被误判为块外
  const tlEventTimeByKey = new Map();
  tlEntries.forEach(function (e) {
    if (!isSpecialEvent(e.msg)) return;
    const t = e.msg && e.msg.time ? new Date(e.msg.time) : null;
    if (t && !isNaN(t.getTime()) && !tlEventTimeByKey.has(normalizedCompareKey(e.msg))) {
      tlEventTimeByKey.set(normalizedCompareKey(e.msg), t);
    }
  });

  // 按时间线位置给记录排序（文件顺序 ≠ 时间线顺序，AI 记录可能排在手工块之后/之前），
  // 保证处理顺序与对话位置一致，搜索起点单调推进
  const tlPos = new Map(); // record.id -> 首条非特殊事件消息在 tlEntries 中的位置
  items.forEach(function (item) {
    const matched = (Array.isArray(item.matched) && item.matched.length > 0) ? item.matched : null;
    if (!matched || matched.length === 0) return;
    let pos = -1;
    for (const m of matched) {
      if (isSpecialEvent(m)) continue;
      const key2 = normalizedCompareKey(m);
      for (let j = 0; j < tlEntries.length; j++) {
        if (!isSpecialEvent(tlEntries[j].msg) && normalizedCompareKey(tlEntries[j].msg) === key2) {
          pos = j;
          break;
        }
      }
      if (pos >= 0) break;
    }
    tlPos.set(item.id, pos);
  });
  items = items
    .filter(function (it) { return tlPos.has(it.id); })
    .sort(function (a, b) { return tlPos.get(a.id) - tlPos.get(b.id); });
  if (items.length === 0) return messages;

  const replacements = [];
  let searchStart = 0;
  items.forEach(function (item) {
    const matched = (Array.isArray(item.matched) && item.matched.length > 0) ? item.matched : null;
    if (!matched || matched.length === 0) return;

    let aStart = null;
    let aEnd = null;
    for (const m of matched) {
      if (!isSpecialEvent(m)) { aStart = m; break; }
    }
    for (let i = matched.length - 1; i >= 0; i--) {
      if (!isSpecialEvent(matched[i])) { aEnd = matched[i]; break; }
    }
    if (!aStart || !aEnd) return;
    const startKey = normalizedCompareKey(aStart);
    const endKey = normalizedCompareKey(aEnd);

    let si = srcAnchorKeys.indexOf(startKey, searchStart);
    if (si === -1) {
      let firstNonSpecialTlIdx = -1;
      for (const m of matched) {
        if (isSpecialEvent(m)) continue;
        const key2 = normalizedCompareKey(m);
        for (let j = 0; j < tlEntries.length; j++) {
          if (!isSpecialEvent(tlEntries[j].msg) && normalizedCompareKey(tlEntries[j].msg) === key2) {
            firstNonSpecialTlIdx = j;
            break;
          }
        }
        if (firstNonSpecialTlIdx >= 0) break;
      }
      const purePos = firstNonSpecialTlIdx >= 0 ? tlPurePos.indexOf(firstNonSpecialTlIdx) : -1;
      if (purePos >= searchStart && purePos < srcAnchorIdx.length) si = purePos;
      else return;
    }

    let ei = srcAnchorKeys.indexOf(endKey, si + 1);
    if (ei === -1) ei = srcAnchorKeys.lastIndexOf(endKey);
    if (ei === -1 || ei < si) {
      let found = -1;
      let tried = 0;
      for (let k = matched.length - 2; k >= 0 && tried < 8; k--) {
        if (isSpecialEvent(matched[k])) continue;
        tried++;
        const alt = normalizedCompareKey(matched[k]);
        let ae = srcAnchorKeys.indexOf(alt, si + 1);
        if (ae === -1) ae = srcAnchorKeys.lastIndexOf(alt);
        if (ae >= si) { found = ae; break; }
      }
      if (found === -1) return;
      ei = found;
    }

    const srcStart = srcAnchorIdx[si];
    let srcEnd = srcAnchorIdx[ei];
    // 块尾常跟着工具调用链（tool_calls + tool 返回），属于机械痕迹，一并纳入替换区间
    while (srcEnd + 1 < out.length) {
      const nxt = out[srcEnd + 1];
      if (!nxt) break;
      if (nxt.role === "tool") { srcEnd++; continue; }
      if (nxt.role === "assistant" && nxt.tool_calls && !String(nxt.content || "").trim()) { srcEnd++; continue; }
      break;
    }

    let blkMin = null;
    let blkMax = null;
    matched.forEach(function (m) {
      const t = messageTime(m);
      if (!t) return;
      const v = t.getTime();
      if (blkMin === null || v < blkMin) blkMin = v;
      if (blkMax === null || v > blkMax) blkMax = v;
    });

    const curMsg = buildMemoryMessage(item);
    const curSer = String(item.created_at || "") + "|" + (item.id || "");
    const dup = replacements.find(function (rp) {
      return !(rp.endIdx < srcStart || rp.startIdx > srcEnd);
    });
    if (dup) {
      const curNewer = String(item.created_at || "") >= String(dup.itemSer || "|");
      if (curNewer) {
        dup.message = curMsg;
        dup.minT = blkMin;
        dup.maxT = blkMax;
        dup.itemSer = curSer;
      }
    } else {
      replacements.push({
        startIdx: srcStart,
        endIdx: srcEnd,
        message: curMsg,
        minT: blkMin,
        maxT: blkMax,
        itemSer: curSer
      });
    }
    searchStart = ei + 1;
  });

  if (replacements.length === 0) { logNoReplace(out.length, source); return messages; }
  replacements.sort(function (a, b) { return a.startIdx - b.startIdx; });

  const final = [];
  let r = 0;
  for (let i = 0; i < out.length; i++) {
    // 特殊事件时间落在已替换范围内 → 一并清掉
    const m0 = out[i];
    if (m0 && !isDiaryEvent(m0) && !marks[contentKey(m0)] && isSpecialEvent(m0)) {
      let t0 = null;
      if (m0.time) { const d = new Date(m0.time); if (!isNaN(d.getTime())) t0 = d; }
      if (!t0) t0 = tlEventTimeByKey.get(normalizedCompareKey(m0)) || null;
      if (!t0) t0 = messageTime(m0);
      if (t0) {
        const tv = t0.getTime();
        const inBlock = replacements.some(function (rp) {
          return rp.minT !== null && rp.maxT !== null && tv >= rp.minT && tv <= rp.maxT;
        });
        if (inBlock) continue;
      }
    }
    if (r < replacements.length && replacements[r].startIdx === i) {
      // 标星原句先收集，放到摘要前面
      const starred = [];
      for (let j = replacements[r].startIdx; j <= replacements[r].endIdx; j++) {
        const sm = out[j];
        if (!sm) continue;
        if (sm.role === "tool" || sm.tool_calls) continue;
        // 标星优先：标星的记忆浮现/特殊事件也以原句保留（与特殊事件清理口径一致）
        if (marks[contentKey(sm)]) starred.push(sm);
      }
      starred.forEach(function (sm) { final.push(sm); });
      final.push(replacements[r].message);
      // 区间内：记忆浮现与工具痕迹直接删除；替换占位消息保留；其余不可压缩消息保留
      for (let j = replacements[r].startIdx; j <= replacements[r].endIdx; j++) {
        const m = out[j];
        if (!m) continue;
        if (isMemoryFlash(m)) continue;
        if (m.role === "tool" || m.tool_calls) continue;
        if (isReplacementMemoryMessage(m)) { final.push(m); continue; }
        if (marks[contentKey(m)]) continue; // 标星原句已放到摘要前
        if (!isCompressible(m, true)) final.push(m);
      }
      i = replacements[r].endIdx;
      r++;
    } else {
      final.push(out[i]);
    }
  }
  const result = mergeAdjacentSameRole(final);
  try {
    const itemById = new Map((loadItems() || []).map(function (it) { return [it.id, it]; }));
    const applied = replacements.map(function (rp) {
      const rid = String(rp.itemSer || "").split("|").pop();
      const it = rid ? itemById.get(rid) : null;
      return {
        id: it ? it.id : rid,
        title: (it && it.title) || "",
        startIdx: rp.startIdx,
        endIdx: rp.endIdx,
        contentLen: String((rp.message && rp.message.content) || "").length
      };
    });
    appendReplaceLog({
      time: nowIso(),
      source: source || "对话",
      before: out.length,
      after: result.length,
      replaced: replacements.length,
      applied: applied
    });
  } catch (e) {
    console.warn("[context-replacements] 记录替换日志失败:", e.message);
  }
  return result;
}

// ========================
// 检索完整上下文文件（时间线）
// ========================
const CONTEXT_SEARCH_MERGE_GAP = 10;
const CONTEXT_SEARCH_DENSITY_FLOOR = 0.4;
const CONTEXT_SEARCH_FILTER_MIN_HITS = 5;
const CONTEXT_SEARCH_MIN_KEEP = 3;
const CONTEXT_SEARCH_RECENT_EXCLUDE_MINUTES = 5;
const CONTEXT_SEARCH_REPEAT_WINDOW_MINUTES = 10;

const recentlyShown = new Map();

function loadSearchableMessages() {
  const timeline = nonSystemMessages(loadTimeline());
  let imported = [];
  try {
    const mod = require("./imported-conversations");
    imported = mod.getMessages ? mod.getMessages() : [];
  } catch (e) { /* 导入模块不可用时忽略 */ }
  return { timeline: timeline, imported: imported };
}

function searchTimeline(query, limit) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "查询不能为空" };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { ok: false, error: "查询不能为空" };
  const src = loadSearchableMessages();
  const maxReturn = Math.max(1, Math.min(50, Math.floor(Number(limit) || 5)));

  const now = Date.now();
  const recentCutoff = now - CONTEXT_SEARCH_RECENT_EXCLUDE_MINUTES * 60000;
  const repeatCutoff = now - CONTEXT_SEARCH_REPEAT_WINDOW_MINUTES * 60000;
  for (const key of recentlyShown.keys()) {
    if (recentlyShown.get(key) < repeatCutoff) recentlyShown.delete(key);
  }

  const scored = [];
  let ord = 0;
  const scan = function (m, isImported) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) return;
    if (m.time) {
      const t = new Date(m.time).getTime();
      if (!isNaN(t) && t > recentCutoff) return;
    }
    const low = content.toLowerCase();
    const hitTerms = [];
    let totalHits = 0;
    for (const t of terms) {
      let c = 0;
      let pos = 0;
      while ((pos = low.indexOf(t, pos)) !== -1) {
        c++;
        totalHits++;
        pos += t.length;
      }
      if (c > 0) hitTerms.push(t);
    }
    // 交集：所有关键词都必须命中才出现
    if (hitTerms.length !== terms.length) return;
    const coverage = hitTerms.length;
    const density = (totalHits / content.length) * 100;
    const sortIndex = ord++;
    scored.push({
      index: isImported ? -1 : sortIndex,
      sortIndex: sortIndex,
      source: isImported ? "imported" : "timeline",
      record_id: isImported ? m.record_id : undefined,
      msg_id: isImported ? m.msg_id : undefined,
      role: m.role,
      time: m.time || null,
      score: Math.round((coverage * 100 + Math.min(density * 20, 40) + Math.min(totalHits, 10)) * 10) / 10,
      coverage: coverage,
      density: Math.round(density * 10) / 10,
      hits: totalHits,
      hit_terms: hitTerms,
      content: content
    });
  };
  for (const m of src.timeline) scan(m, false);
  for (const m of src.imported) scan(m, true);

  let kept = scored;
  if (scored.length > CONTEXT_SEARCH_FILTER_MIN_HITS) {
    const filtered = scored.filter(function (x) { return x.density >= CONTEXT_SEARCH_DENSITY_FLOOR; });
    kept = filtered.length >= CONTEXT_SEARCH_MIN_KEEP ? filtered : scored.slice(0, CONTEXT_SEARCH_MIN_KEEP);
  }

  kept.sort(function (a, b) {
    return b.coverage - a.coverage || b.density - a.density || b.hits - a.hits || a.sortIndex - b.sortIndex;
  });

  const groups = [];
  const used = new Array(kept.length).fill(false);
  for (let i = 0; i < kept.length; i++) {
    if (used[i]) continue;
    const group = [kept[i]];
    used[i] = true;
    for (let j = i + 1; j < kept.length; j++) {
      if (used[j]) continue;
      const lastIdx = group[group.length - 1].sortIndex;
      if (Math.abs(kept[j].sortIndex - lastIdx) <= CONTEXT_SEARCH_MERGE_GAP) {
        group.push(kept[j]);
        used[j] = true;
      }
    }
    groups.push(group);
  }

  const fresh = groups.filter(function (g) {
    return !g.some(function (x) {
      const key = x.msg_id || ("tl:" + x.index);
      const ts = recentlyShown.get(key);
      return ts !== undefined && ts >= repeatCutoff;
    });
  });

  const matches = fresh.map(function (g) {
    const rep = g[0];
    const content = rep.content;
    const low = content.toLowerCase();
    let snippet = content;
    if (content.length > 500) {
      let firstHit = -1;
      for (const t of rep.hit_terms) {
        const pos = low.indexOf(t);
        if (pos >= 0 && (firstHit < 0 || pos < firstHit)) firstHit = pos;
      }
      const sliceStart = Math.max(0, Math.min(firstHit - 100, content.length - 500));
      snippet = (sliceStart > 0 ? "…" : "") + content.slice(sliceStart, sliceStart + 500) + (content.length > sliceStart + 500 ? "…" : "");
    }
    const indices = g.map(function (x) { return x.index; });
    const out = {
      index: rep.index,
      role: rep.role,
      time: rep.time,
      score: rep.score,
      hit_terms: rep.hit_terms,
      hits: g.reduce(function (s, x) { return s + x.hits; }, 0),
      count: g.length,
      end_index: Math.max.apply(null, indices),
      content: snippet
    };
    if (rep.source === "imported") {
      out.source = "imported";
      out.record_id = rep.record_id;
      out.msg_id = rep.msg_id;
    }
    return out;
  });

  for (const m of matches) {
    recentlyShown.set(m.msg_id || ("tl:" + m.index), now);
  }

  return { ok: true, total: scored.length, matches: matches.slice(0, maxReturn) };
}

// ========================
// 导出
// ========================

// ========================
// 词云关键词：从检索池（时间线 + 导入对话）提取高频重点词
// ========================
const POOL_KEYWORDS_CACHE_MS = 60000;
let poolKeywordsCache = { at: 0, data: null };

function extractPoolKeywords(limit) {
  if (limit === undefined) limit = 80;
  const now = Date.now();
  if (poolKeywordsCache.data && now - poolKeywordsCache.at < POOL_KEYWORDS_CACHE_MS) {
    return poolKeywordsCache.data.slice(0, limit);
  }
  let engine = null;
  try { engine = require("./memory-engine"); } catch (e) { /* 记忆引擎不可用时忽略 */ }
  const extract = (engine && engine.extractKeywordsFromText) || function () { return []; };
  const stop = (engine && engine.KEYWORD_STOP_WORDS) || new Set();

  const src = loadSearchableMessages();
  const docFreq = new Map();
  const termFreq = new Map();
  let docCount = 0;
  const scan = function (m) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content.trim()) return;
    docCount++;
    const seen = new Set();
    for (const w of extract(content)) {
      if (w.length < 2 || stop.has(w)) continue;
      termFreq.set(w, (termFreq.get(w) || 0) + 1);
      if (!seen.has(w)) { seen.add(w); docFreq.set(w, (docFreq.get(w) || 0) + 1); }
    }
  };
  for (const m of src.timeline) scan(m);
  for (const m of src.imported) scan(m);

  const N = Math.max(2, docCount);
  const out = Array.from(termFreq.entries())
    .filter(function (e) { return docFreq.get(e[0]) >= 2; })
    .map(function (e) {
      const word = e[0];
      const df = docFreq.get(word);
      return {
        word: word,
        count: df,
        weight: Math.round(e[1] * Math.log(N / df) * 10) / 10
      };
    })
    .filter(function (x) { return x.weight >= 0.5; })
    .sort(function (a, b) { return b.weight - a.weight || b.count - a.count; })
    .slice(0, Math.max(10, Math.min(200, Math.floor(Number(limit) || 80))));
  poolKeywordsCache = { at: now, data: out };
  return out;
}

// 词云点词：检索池里包含该词的相关对话片段（相邻命中聚成段）
const RELATED_SEGMENT_GAP = 4;

function searchRelatedSegments(word, maxSegments) {
  const w = String(word || "").trim().toLowerCase();
  if (!w) return { ok: false, error: "关键词不能为空", total: 0, segments: [] };
  const src = loadSearchableMessages();
  const hits = [];
  let ord = 0;
  const scan = function (m, isImported) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) return;
    if (content.toLowerCase().indexOf(w) === -1) return;
    hits.push({ sortIndex: ord++, source: isImported ? "imported" : "timeline", time: m.time || null, content: content });
  };
  for (const m of src.timeline) scan(m, false);
  for (const m of src.imported) scan(m, true);

  const groups = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    if (last && h.sortIndex - last.lastSort <= RELATED_SEGMENT_GAP) {
      last.items.push(h);
      last.lastSort = h.sortIndex;
    } else {
      groups.push({ items: [h], lastSort: h.sortIndex });
    }
  }
  const segments = groups.map(function (g) {
    const times = g.items.map(function (x) { return messageTime(x); }).filter(Boolean);
    const first = g.items[0];
    const preview = first.content.length > 300 ? first.content.slice(0, 300) + "…" : first.content;
    return {
      startTime: times.length ? fmtWall(times[0]) : "",
      endTime: times.length ? fmtWall(times[times.length - 1]) : "",
      count: g.items.length,
      preview: preview,
      source: first.source
    };
  });
  segments.sort(function (a, b) { return b.count - a.count || (a.startTime < b.startTime ? -1 : 1); });
  return {
    ok: true,
    total: hits.length,
    segments: segments.slice(0, Math.max(1, Math.min(50, Math.floor(Number(maxSegments) || 20))))
  };
}

// ========================
// 压缩页搜索：搜全部原文，返回命中消息的原文编号(第X条) + 所属块
// ========================
function compactionKeyOf(m) {
  return String(m.role || "") + "\u0000" + String(m.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function locateCompIdx(target, items) {
  const k = compactionKeyOf(target);
  for (let i = 0; i < items.length; i++) {
    if (compactionKeyOf(items[i].msg) === k) return i;
  }
  return -1;
}

// 解析记录在压缩索引空间(compressibleItems)中的覆盖范围
function recordCompRange(it, items) {
  const compItems = items || compressibleItems();
  const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : [];
  if (matched.length === 0) return null;
  const fl = locateCompIdx(matched[0], compItems);
  if (fl < 0) return null;
  let ll = locateCompIdx(matched[matched.length - 1], compItems);
  if (ll < 0) {
    for (let k = matched.length - 2; k >= 0; k--) {
      const ck = locateCompIdx(matched[k], compItems);
      if (ck >= 0) { ll = ck; break; }
    }
  }
  if (ll < 0 || ll < fl) return null;
  return { start: fl, end: ll };
}

// 构建「原文编号(1-based) -> 所属块」映射，编号与压缩页显示一致
function buildCompactionChunkMap() {
  const items = compressibleItems();
  const records = loadItems().filter(function (it) { return !it.removed; });
  const map = new Array(items.length).fill(null);
  const positioned = [];
  records.forEach(function (it) {
    const r = recordCompRange(it, items);
    if (!r) return;
    positioned.push({ it: it, r: r });
  });
  positioned.sort(function (a, b) { return a.r.start - b.r.start; });
  let displayIndex = 0;
  positioned.forEach(function (p) {
    displayIndex++;
    const text = recordText(p.it);
    const info = {
      chunkIndex: displayIndex,
      chunkId: p.it.id,
      source: p.it.source || "ai",
      enabled: p.it.enabled !== false,
      summary: text.slice(0, 80)
    };
    for (let i = p.r.start; i <= p.r.end; i++) map[i] = info;
  });
  return { items: items, map: map };
}

// 已标星消息列表：遍历原文池，返回所有被标星（marks 命中）的消息，统一管理、便于取消
function listMarked() {
  const { items, map } = buildCompactionChunkMap();
  const marks = loadMarks();
  const results = [];
  items.forEach(function (e, i) {
    const key = contentKey(e.msg);
    if (!marks[key]) return;
    const content = typeof e.msg.content === "string" ? e.msg.content : contentToText(e.msg);
    if (!content) return;
    const t = messageTime(e.msg);
    const info = map[i];
    results.push({
      index: i + 1,
      role: e.msg.role || "",
      time: t ? fmtWall(t) : "",
      content: content.length > 300 ? content.slice(0, 300) + "…" : content,
      key: key,
      markedAt: (marks[key] && marks[key].markedAt) || "",
      chunk: info ? {
        chunkIndex: info.chunkIndex,
        chunkId: info.chunkId,
        source: info.source,
        enabled: info.enabled,
        summary: info.summary
      } : null
    });
  });
  // 按星时间倒序，最新标的在前
  results.sort(function (a, b) { return String(b.markedAt || "").localeCompare(String(a.markedAt || "")); });
  return { ok: true, total: results.length, results: results };
}

// 压缩页搜索：搜全部原文，返回命中消息的原文编号(第X条) + 所属块
function searchCompactionOriginal(keyword, maxResults) {
  const q = String(keyword || "").trim();
  if (!q) return { ok: false, error: "关键词不能为空", total: 0, results: [] };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { ok: false, error: "关键词不能为空", total: 0, results: [] };
  const { items, map } = buildCompactionChunkMap();
  const maxReturn = Math.max(1, Math.min(200, Math.floor(Number(maxResults) || 50)));
  const results = [];
  items.forEach(function (e, i) {
    const content = typeof e.msg.content === "string" ? e.msg.content : contentToText(e.msg);
    if (!content) return;
    const low = content.toLowerCase();
    let allHit = true;
    for (const t of terms) {
      if (low.indexOf(t) === -1) { allHit = false; break; }
    }
    if (!allHit) return;
    const t = messageTime(e.msg);
    const info = map[i];
    const key = contentKey(e.msg);
    results.push({
      index: i + 1,
      role: e.msg.role || "",
      time: t ? fmtWall(t) : "",
      content: content.length > 300 ? content.slice(0, 300) + "…" : content,
      key: key,
      marked: !!loadMarks()[key],
      chunk: info ? {
        chunkIndex: info.chunkIndex,
        chunkId: info.chunkId,
        source: info.source,
        enabled: info.enabled,
        summary: info.summary
      } : null
    });
  });
  return { ok: true, total: results.length, results: results.slice(0, maxReturn) };
}

module.exports = {
  isReplacementMemoryMessage,
  addReplacement,
  removeReplacement,
  toggleReplacement,
  updateReplacement,
  listReplacements,
  listReplacementsForPreview,
  applyReplacements,
  getReplaceLog,
  searchTimeline,
  resolveRange,
  loadItems,
  recordText,
  // 手工记录管理
  addManualRecord,
  removeManualRecord,
  toggleManualRecord,
  updateManualRecordRange,
  updateAiRecordRange,
  splitRangeByGaps,
  setManualRecordText,
  restoreHistory,
  removeHistory,
  manualRecordsSorted,
  compressibleItems,
  removeAllManualRecords,
  loadTimeline,
  extractPoolKeywords,
  searchRelatedSegments,
  searchCompactionOriginal,
  listMarked
};
