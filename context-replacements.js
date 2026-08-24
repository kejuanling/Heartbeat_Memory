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
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MEMORY_POOL_CONFIG_FILE = path.join(DATA_DIR, "memory_pool_config.json");

const MAX_MEMORY_CHARS = 100000;

// ========================
// 每次请求的替换/压缩记录（供管理台查看；含对话/共影/唤醒等所有来源）
// ========================
const REPLACE_LOG_FILE = path.join(DATA_DIR, "context_replace_log.json");
const REPLACE_LOG_CAP = 10;
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
// mtime 感知文件缓存：文件未变化（mtime+size 相同）时复用内存结果，避免对同一份大盘内容反复读盘
const _readJsonCache = new Map();
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const st = fs.statSync(file);
    const ck = st.mtimeMs + ':' + st.size;
    const hit = _readJsonCache.get(file);
    if (hit && hit.ck === ck) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    _readJsonCache.set(file, { ck: ck, data: data });
    return data;
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
  _readJsonCache.delete(file);
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
  const c = String(msg.content || "").replace(/\s+/g, " ").trim();
  if (!c) return false;
  const structuredStart = /^（\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|刚刚|自动唤醒|自动写了日记|记忆浮现|时间标记|摘要|共影|截图|记忆碎片)/.test(c);
  if (!structuredStart) return false;
  return (
    c.indexOf("刚刚给宝宝发了 Bark") !== -1 ||
    /刚刚给[^：]*发了 Bark/.test(c) ||
    c.indexOf("自动唤醒：本次未发送 Bark") !== -1 ||
    c.indexOf("自动唤醒：本次未发送推送") !== -1 ||
    (/刚刚给[^：]*发了/.test(c) && c.indexOf("推送") !== -1) ||
    (/刚刚给宝宝发了/.test(c) && c.indexOf("推送") !== -1) ||
    c.indexOf("自动写了日记") !== -1 ||
    c.indexOf("记忆浮现）") !== -1 ||
    c.indexOf("时间标记") !== -1 ||
    c.indexOf("摘要）") !== -1 ||
    c.indexOf("共影）") !== -1 ||
    c.indexOf("截图）") !== -1 ||
    c.indexOf("截图唤醒）") !== -1 ||
    c.indexOf("记忆碎片") !== -1
  );
}

function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return isSpecialEvent(msg) && String(msg.content || "").indexOf("记忆浮现") !== -1;
}

// 日记特殊事件：AI 唤醒时自动写的日记，永远不参与压缩，单独保留在上下文
function isDiaryEvent(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return isSpecialEvent(msg) && String(msg.content || "").indexOf("自动写了日记") !== -1;
}

// 记忆碎片特殊事件：跨窗口带走的标星正文，永不压缩
function isStarEvent(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return isSpecialEvent(msg) && String(msg.content || "").indexOf("记忆碎片") !== -1;
}

// 特殊事件注入分类：一个事件可能命中多类，返回命中的所有分类 key（与 server.js 保持一致）
function classifySpecialEvent(msg) {
  if (!isSpecialEvent(msg)) return [];
  const c = String(msg.content || "");
  const out = [];
  if (/自动唤醒|本次未发送/.test(c)) out.push("wake");
  else if (/发了 Bark|推送/.test(c)) out.push("push");
  if (c.indexOf("自动写了日记") !== -1) out.push("diary");
  if (c.indexOf("记忆浮现）") !== -1) out.push("memory");
  if (c.indexOf("时间标记") !== -1) out.push("time");
  if (c.indexOf("摘要）") !== -1) out.push("summary");
  if (c.indexOf("共影）") !== -1) out.push("co");
  if (c.indexOf("截图）") !== -1 || c.indexOf("截图唤醒）") !== -1) out.push("screenshot");
  if (c.indexOf("记忆碎片") !== -1) out.push("star");
  return out;
}

function eventKey(msg) {
  return ((msg && msg.role) || "") + "\u0000" + String((msg && msg.content) || "");
}

// 读取特殊事件注入所需配置（与 server.js 注入逻辑共用同一套口径）
function loadEventInjectConfig() {
  let cfg = {};
  try { cfg = readJson(CONFIG_FILE, {}); } catch (e) {}
  let pool = {};
  try { pool = readJson(MEMORY_POOL_CONFIG_FILE, {}); } catch (e) {}
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) pool = {};
  const injectTypes = Array.isArray(cfg.event_inject_types) ? cfg.event_inject_types : null;
  const coEventInjectEnabled = cfg.co_event_inject_enabled !== false;
  const pushEnabled = pool.cross_inject_push !== false;
  return { injectTypes: injectTypes, coEventInjectEnabled: coEventInjectEnabled, pushEnabled: pushEnabled };
}

// 当前窗口起点：最新一次重建时间线里第一条真实 user 消息的时间。
// 「当前窗口」之后（含）的特殊事件才是本次会话真正相关的；更早的属于旧窗口，不注入、不进压缩页。
function currentWindowStartMs(timeline) {
  let ms = null;
  (Array.isArray(timeline) ? timeline : []).forEach(function (m) {
    if (ms !== null) return;
    if (!m || m.role !== "user") return;
    if (m._ctxRep || m._ccSummary || m.tool_calls) return;
    if (isSpecialEvent(m)) return;
    const t = messageTime(m);
    if (t) ms = t.getTime();
  });
  if (ms !== null) return ms;
  // 兜底：没有 user 时退到最早真实 assistant 消息
  (Array.isArray(timeline) ? timeline : []).forEach(function (m) {
    if (ms !== null) return;
    if (!m || m.role !== "assistant") return;
    if (m._ctxRep || m._ccSummary || m.tool_calls) return;
    if (isSpecialEvent(m)) return;
    const t = messageTime(m);
    if (t) ms = t.getTime();
  });
  return ms;
}

// 计算「真实请求会注入」的特殊事件集合（按内容键去重）。口径与 server.js 完全一致：
// 仅取当前窗口（第一条真实 user 消息之后）内的特殊事件，窗口内不限条数；按 event_inject_types 过滤，共影等见 co_event_inject_enabled。
function collectInjectionVisibleEvents(timeline) {
  const cfg = loadEventInjectConfig();
  const vis = new Set();
  const pushEnabled = cfg.pushEnabled;
  const injectTypes = cfg.injectTypes;
  const coEnabled = cfg.coEventInjectEnabled;
  const windowStartMs = currentWindowStartMs(timeline);
  (Array.isArray(timeline) ? timeline : []).forEach(function (m) {
    if (!isSpecialEvent(m)) return;
    if (windowStartMs !== null) {
      const t = messageTime(m);
      if (t && t.getTime() < windowStartMs) return;
    }
    if (!pushEnabled) {
      const cats = classifySpecialEvent(m) || [];
      if (cats.indexOf("push") >= 0) return;
    }
    if (!coEnabled && typeof m.content === "string" && m.content.indexOf("共影）") !== -1) return;
    if (Array.isArray(injectTypes) && injectTypes.length > 0) {
      const cats = classifySpecialEvent(m);
      if (cats.length && !cats.some(function (k) { return injectTypes.indexOf(k) >= 0; })) return;
    }
    vis.add(eventKey(m));
  });
  return vis;
}

let _eventVisCache = null;
function eventInjectionVisibleKeys() {
  const cfg = loadEventInjectConfig();
  let stat;
  try { stat = fs.statSync(TIMELINE_FILE); } catch (e) { stat = { mtimeMs: 0, size: 0 }; }
  const ck = JSON.stringify(cfg) + ":" + stat.mtimeMs + ":" + stat.size;
  if (_eventVisCache && _eventVisCache.ck === ck) return _eventVisCache.keys;
  const keys = collectInjectionVisibleEvents(loadTimeline());
  _eventVisCache = { ck: ck, keys: keys };
  return keys;
}

// 该消息是否属于「真实请求会注入」的特殊事件；非特殊事件恒返回 true
function isEventInjectionVisible(msg) {
  if (!isSpecialEvent(msg)) return true;
  return eventInjectionVisibleKeys().has(eventKey(msg));
}

function isCompressible(msg, includeEvents) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
  if (isDiaryEvent(msg)) return false; // 日记永远不压缩
  if (isStarEvent(msg)) return false; // 记忆碎片永远不压缩（与日记同级，跨窗口带走的标星正文）
  if (!includeEvents && msg.role === "assistant" && isSpecialEvent(msg)) return false;
  // 特殊事件只在当前事件窗口内才计入压缩索引：与真实请求注入口径一致，避免旧窗口事件残留在未覆盖区
  if (includeEvents && msg.role === "assistant" && isSpecialEvent(msg) && !isEventInjectionVisible(msg)) return false;
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
  // 收缩支持：新范围端点即目标边界（改小结尾 = 尾部让出，退回未覆盖区）；
  // 再吸收所有与 [start,end] 真正重叠的其他块（手工 + AI）
  let mergedStart = start;
  let mergedEnd = end;
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
  // 收缩支持：新范围端点即目标边界（改小结尾 = 尾部让出，退回未覆盖区）；
  // 再吸收所有与 [s, ee] 真正重叠的其他块（手工 + AI）
  let mergedStart = s;
  let mergedEnd = ee;
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
// ---- 自动分块评分：时间间隔 + 话题切换 + 说话人切换 ----
const TOPIC_STOP_CHARS = new Set("的了我是你他它她这在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到".split(""));

function contentTopicTokens(msg) {
  const raw = String(contentToText(msg) || "").replace(/<[^>]+>/g, "").toLowerCase();
  const out = new Set();
  const runs = raw.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      if (TOPIC_STOP_CHARS.has(run[i])) continue;
      out.add(run[i]);
      if (i + 1 < run.length && !TOPIC_STOP_CHARS.has(run[i + 1])) out.add(run[i] + run[i + 1]);
    }
  }
  return out;
}

function topicOverlap(a, b) {
  const A = contentTopicTokens(a);
  const B = contentTopicTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function boundarySplitScore(prev, next, gapMs) {
  let score = 0;
  const t0 = messageTime(prev.msg);
  const t1 = messageTime(next.msg);
  if (t0 && t1 && Math.abs(t1.getTime() - t0.getTime()) >= gapMs) score += 5;
  const sim = topicOverlap(prev.msg, next.msg);
  const nextIsUser = next.msg.role === "user";
  if (sim < 0.12) score += 4;
  else if (sim < 0.3) score += 2;
  if (nextIsUser && sim < 0.35) score += 2;
  return score;
}

function splitRangeByGaps(start, end, cfg) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return { ok: false, message: "无效的范围" };
  }
  const items = compressibleItems();
  if (start >= items.length) return { ok: false, message: "起始编号超出当前消息总数" };
  const ee = Math.min(end, items.length - 1);
  const isObj = cfg && typeof cfg === "object";
  const gapMinutes = (isObj ? Number(cfg.gapMinutes) : Number(cfg)) || 30;
  const chunkSize = isObj ? Number(cfg.chunkSize) : NaN;
  const chunkMin = isObj ? Number(cfg.chunkMin) : NaN;
  const chunkMax = isObj ? Number(cfg.chunkMax) : NaN;
  const target = Math.max(10, Math.floor(chunkSize || 100));
  const minSize = Math.max(5, Math.floor(chunkMin || Math.floor(target / 2)));
  const maxSize = Math.max(minSize + 5, Math.floor(chunkMax || target * 2));
  const tgt = Math.max(minSize, Math.min(maxSize, target));
  const gapMs = gapMinutes * 60 * 1000;
  const CUT_THRESHOLD = 4;
  const segments = [];
  let segStart = start;
  while (segStart <= ee) {
    const remaining = ee - segStart + 1;
    const lo = Math.min(minSize, remaining);
    const hi = Math.min(maxSize, remaining);
    const loIdx = segStart + lo - 1;
    const hiIdx = segStart + hi - 1;
    let best = -1, bestScore = -Infinity;
    for (let i = loIdx; i <= hiIdx; i++) {
      const tail = ee - i;
      if (i >= ee) {
        if (0 > bestScore) { bestScore = 0; best = ee; }
        break;
      }
      const next = items[i + 1];
      if (!next) continue;
      if (next.msg && (next.msg.role === "tool" || next.msg.tool_call_id)) continue;
      const bs = boundarySplitScore(items[i], items[i + 1], gapMs);
      let score = bs >= CUT_THRESHOLD ? bs : 0;
      score -= Math.abs((i - segStart + 1) - tgt) * 0.05;
      if (tail > 0 && tail < minSize) score -= 9999;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) best = Math.min(segStart + lo - 1, ee);
    if (best > ee) best = ee;
    segments.push({ start: segStart, end: best });
    segStart = best + 1;
  }
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

  // 性能：预构建时间线位置索引，把「块首条 → tlEntries 位置」的全扫降为 O(1) 查表
  const tlKeyToPos = new Map();
  tlEntries.forEach(function (e, idx) {
    if (isSpecialEvent(e.msg)) return;
    const k = normalizedCompareKey(e.msg);
    if (!tlKeyToPos.has(k)) tlKeyToPos.set(k, idx);
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
      const k = tlKeyToPos.get(normalizedCompareKey(m));
      if (k !== undefined) { pos = k; break; }
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
    // 兜底：相邻块在时间线里被重复内容错位、把“搜索起点”推到本块起点之后时，仍从序列开头重新找起点，避免该块被静默跳过
    if (si === -1) si = srcAnchorKeys.indexOf(startKey);
    if (si === -1) {
      let firstNonSpecialTlIdx = -1;
      for (const m of matched) {
        if (isSpecialEvent(m)) continue;
        const k = tlKeyToPos.get(normalizedCompareKey(m));
        if (k !== undefined) { firstNonSpecialTlIdx = k; break; }
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
// 导入对话没有时间线位置：用大偏移 + 序号作为位置，避免与时间线消息混排/错并
const CONTEXT_SEARCH_IMPORTED_POS_OFFSET = 100000000;

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
  const scan = function (m, isImported, ord) {
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
    // 部分命中即返回：至少命中一个关键词；命中越多越靠前（与工具描述一致）
    if (hitTerms.length === 0) return;
    const coverage = hitTerms.length;
    const density = (totalHits / content.length) * 100;
    // pos = 消息真实位置：时间线用非系统数组下标，导入对话用大偏移 + 序号
    const pos = isImported ? CONTEXT_SEARCH_IMPORTED_POS_OFFSET + ord : ord;
    scored.push({
      pos: pos,
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
  src.timeline.forEach(function (m, i) { scan(m, false, i); });
  src.imported.forEach(function (m, i) { scan(m, true, i); });

  let kept = scored;
  if (scored.length > CONTEXT_SEARCH_FILTER_MIN_HITS) {
    const filtered = scored.filter(function (x) { return x.density >= CONTEXT_SEARCH_DENSITY_FLOOR; });
    kept = filtered.length >= CONTEXT_SEARCH_MIN_KEEP ? filtered : scored.slice(0, CONTEXT_SEARCH_MIN_KEEP);
  }

  kept.sort(function (a, b) {
    return b.coverage - a.coverage || b.density - a.density || b.hits - a.hits || a.pos - b.pos;
  });

  const groups = [];
  const used = new Array(kept.length).fill(false);
  for (let i = 0; i < kept.length; i++) {
    if (used[i]) continue;
    const group = [kept[i]];
    used[i] = true;
    for (let j = i + 1; j < kept.length; j++) {
      if (used[j]) continue;
      const lastPos = group[group.length - 1].pos;
      if (Math.abs(kept[j].pos - lastPos) <= CONTEXT_SEARCH_MERGE_GAP) {
        group.push(kept[j]);
        used[j] = true;
      }
    }
    groups.push(group);
  }

  const fresh = groups.filter(function (g) {
    return !g.some(function (x) {
      const key = x.msg_id || x.record_id || ("tl:" + x.pos);
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
    const out = {
      role: rep.role,
      time: rep.time,
      score: rep.score,
      hit_terms: rep.hit_terms,
      hits: g.reduce(function (s, x) { return s + x.hits; }, 0),
      count: g.length,
      content: snippet
    };
    if (rep.source === "imported") {
      out.source = "imported";
      out.record_id = rep.record_id;
      out.msg_id = rep.msg_id;
    }
    return out;
  });

  for (const g of fresh) {
    const rep = g[0];
    recentlyShown.set(rep.msg_id || rep.record_id || ("tl:" + rep.pos), now);
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
  // 手工块等带精确压缩索引的记录：直接信任存储范围（锚点定位遇重复内容/特殊事件会漂移）
  const rng = it && it.range;
  if (rng && Number.isInteger(rng.start_index) && Number.isInteger(rng.end_index)) {
    const s = Math.max(0, rng.start_index);
    const e = Math.min(rng.end_index, compItems.length - 1);
    if (s >= compItems.length || e < s) return null;
    return { start: s, end: e };
  }
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
  // 与跨窗口注入保持一致：优先用标星时已存的原生原文（marks[key].content），
  // 保证即使原文已被替换/删除也能显示；读不到再回落 matched 存档。
  // 时间线经压缩后，历史消息已移入 matched 存档，当前时间线里找不到，
  // 若只用 compressibleItems（当前时间线），大量标星会因原文不在时间线而显示不出来。
  const marks = loadMarks();
  const results = [];
  const seenKeys = new Set();
  let displayIndex = 0;

  // 第一遍：优先用 marks[key].content（标星时刻存的原文）——不依赖 matched 是否还在
  Object.keys(marks || {}).forEach(function (key) {
    const entry = marks[key];
    if (!entry || typeof entry.content !== "string" || !entry.content) return;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    displayIndex++;
    const t = entry.markedAt;
    results.push({
      index: displayIndex,
      role: entry.role || "assistant",
      time: t ? fmtWall(new Date(t)) : "",
      content: entry.content.length > 300 ? entry.content.slice(0, 300) + "…" : entry.content,
      key: key,
      markedAt: t || "",
      // 无对应块信息，标记为"已存原文"
      chunk: null
    });
  });

  // 第二遍：已存原文的已处理，剩下的从 matched 档里补（对应标星时没存原文的存量）
  const records = (loadItems() || []).filter(function (it) { return !it.removed; });
  records.forEach(function (it) {
    const matched = Array.isArray(it.matched) ? it.matched : [];
    if (!matched.length) return;
    const info = {
      chunkIndex: 0,
      chunkId: it.id,
      source: it.source || "ai",
      enabled: it.enabled !== false,
      summary: recordText(it).slice(0, 80)
    };
    matched.forEach(function (m) {
      if (!m || m.role === "system") return;
      const key = contentKey(m);
      if (!marks[key]) return;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      const content = typeof m.content === "string" ? m.content : contentToText(m);
      if (!content) return;
      displayIndex++;
      const t = messageTime(m);
      results.push({
        index: displayIndex,
        role: m.role || "",
        time: t ? fmtWall(t) : "",
        content: content.length > 300 ? content.slice(0, 300) + "…" : content,
        key: key,
        markedAt: (marks[key] && marks[key].markedAt) || "",
        chunk: info
      });
    });
  });

  // 按消息在对话中的位置（编号）升序，编号从小到大连续
  results.sort(function (a, b) { return a.index - b.index; });
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
  listMarked,
  // 特殊事件结构化识别与注入窗口过滤（供 context-compactor / server 复用同一口径）
  isSpecialEvent,
  isDiaryEvent,
  isEventInjectionVisible,
  classifySpecialEvent
};
