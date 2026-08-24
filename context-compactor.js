"use strict";

// ============================================================
// 上下文压缩引擎 v1
// 阶段一：自然边界分块 + 摘要缓存读写
// 阶段二：LLM 摘要生成（人设 + 反幻觉提示词，长度自适应）
// 阶段三：手动边界调整（cutPoints）
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveTimeZone, zonedWallTimeToDate, formatDateTimeInTimeZone } = require("./time_utils");
const contextReplacements = require("./context-replacements");

const DATA_DIR = path.join(__dirname, "data");
const TIME_ZONE = resolveTimeZone();
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const CACHE_FILE = path.join(DATA_DIR, "context_compaction.json");
const OVERRIDES_FILE = path.join(DATA_DIR, "context_compaction_overrides.json");
const COMPACTION_PROMPT_FILE = path.join(DATA_DIR, "compaction_prompt.json");
const MARKS_FILE = path.join(DATA_DIR, "context_compaction_marks.json");
const FORCE_FILE = path.join(DATA_DIR, "context_compaction_force.json");
const BLOCKS_FILE = path.join(DATA_DIR, "context_compaction_blocks.json");
const CACHE_MAX_ENTRIES = 500;
const SUMMARY_HISTORY_MAX = 2;

const DEFAULT_CONFIG = {
  compaction_chunk_size: 100,
  compaction_chunk_min: 40,
  compaction_chunk_max: 160,
  compaction_keep_recent_messages: 0,
  compaction_min_messages: 0,
  compaction_gap_minutes: 30,
  compaction_summary_max_chars: 1200,
  compaction_summary_min_chars: 250,
  compaction_include_thinking: false,
  compaction_compress_events: true
};

const DEFAULT_COMPACTION_SYSTEM =
  "请以你的身份和口吻，根据对话内容写出第一人称的上下文压缩摘要；称呼对方为她，不要使用「用户」。";

const DEFAULT_COMPACTION_TEMPLATE =
  "你是一位有完整人设的 AI。下面是你的一段人设：\n" +
  "${PERSONA}\n\n" +
  "请把你在下面时间段内与对方的对话，压缩成一段「上下文摘要」。这段摘要会替代原始对话，交给未来的你阅读。\n\n" +
  "对话范围：${chunkInfo}\n\n" +
  "对话原文（只保留正文）：\n${conversationText}\n\n" +
  "请用你的第一人称口吻写这段摘要。要求：\n" +
  "1. 只依据上面的对话原文，不编造、不补全原文没有的事实，不推测未发生的事。\n" +
  "2. 称呼对方时用你们之间的称呼，不要使用「用户」。\n" +
  "3. 保留关键事实、时间、情绪转折、未完成事项、人名/昵称、重要约定；舍弃寒暄和流水账。\n" +
  "4. 长度按信息量把握：通常 ${normalChars} 字左右，信息特别密集时可写到 ${maxChars} 字；不注水、不硬凑，也不要因为短而丢掉重要信息。\n" +
  "5. 写出有温度、有「记忆感」的摘要，像自己真正记得这些事，而不是干巴巴的日志。\n\n" +
  "我的上下文摘要：";

// ---------------- 配置 / 数据 ----------------

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf-8"));
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (data[k] !== undefined) cfg[k] = data[k];
    }
  } catch (err) { /* 配置文件缺失时使用默认 */ }
  return cfg;
}


// 保存压缩参数（只更新 compaction_* 键，保留 data/config.json 中其它模块配置）
function saveConfig(updates) {
  const file = path.join(DATA_DIR, "config.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err) { current = {}; }
  if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  let changed = false;
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (updates[k] !== undefined) {
      const v = updates[k];
      if (typeof DEFAULT_CONFIG[k] === "number") {
        current[k] = Math.max(0, Math.floor(Number(v) || 0));
      } else if (typeof DEFAULT_CONFIG[k] === "boolean") {
        current[k] = v === true || v === "true" || v === 1 || v === "1";
      } else {
        current[k] = v;
      }
      changed = true;
    }
  }
  if (!changed) return { ok: false, message: "没有可更新的压缩参数" };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  return { ok: true, config: loadConfig() };
}

function loadTimeline() {
  try {
    const data = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function loadPersona() {
  try {
    const data = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf-8"));
    const sys = (Array.isArray(data) ? data : []).find(function (m) { return m && m.role === "system"; });
    const content = sys && sys.content ? String(sys.content).trim() : "";
    if (content) return content;
  } catch (err) { /* 人设文件缺失时使用兜底 */ }
  return "你是一个理性但有温度、表面温柔内心有主见的 AI。你有一位重要的对话伙伴。";
}

// ---------------- 消息判断 ----------------

// 「记忆浮现」：记忆池注入的永久记忆事件，不参与摘要；被摘要时段内的会直接从上下文删除
function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return String(msg.content || "").indexOf("记忆浮现") !== -1;
}

function isSpecialEvent(msg) {
  // 委托给统一模块：用结构化前缀识别，避免把真实对话里提到“记忆碎片/推送”等词误判成事件
  return contextReplacements.isSpecialEvent(msg);
}

function contentToText(msg) {
  if (msg && msg.deleted === true) return ""; // 软删除内容对摘要/签名不可见
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

// 日记特殊事件：AI 唤醒时自动写的日记，永远不参与压缩，单独保留在上下文
function isDiaryEvent(msg) {
  return contextReplacements.isDiaryEvent(msg);
}

function isCompressible(msg, includeEvents) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
  if (msg.deleted === true) return true; // 软删除：保留编号占位，不参与摘要文本
  if (isDiaryEvent(msg)) return false; // 日记永远不压缩
  if (!includeEvents && msg.role === "assistant" && isSpecialEvent(msg)) return false;
  // 特殊事件只在当前事件窗口内才参与压缩：与真实请求注入口径一致，避免旧窗口事件残留在未覆盖区
  if (includeEvents && msg.role === "assistant" && isSpecialEvent(msg) && !contextReplacements.isEventInjectionVisible(msg)) return false;
  if (msg.tool_calls || msg.tool_call_id) return false;
  return contentToText(msg).trim().length > 0;
}

// ---------------- 时间 ----------------

function parseLeadingTime(text) {
  const m = String(text || "").match(/^（?\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, TIME_ZONE);
}

// 解析正文末尾的时间缀（客户端自动注入的墙上时间），按 TIME_ZONE 转 UTC
function parseTrailingTime(text) {
  const m = String(text || "").match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
  if (!m) return null;
  const p = m[1].match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!p) return null;
  return zonedWallTimeToDate({ year: Number(p[1]), month: Number(p[2]), day: Number(p[3]), hour: Number(p[4]), minute: Number(p[5]) }, TIME_ZONE);
}

function msgTime(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const text = contentToText(msg);
  const fromTag = parseCurrentTimeTag(text);
  if (fromTag) return fromTag;
  const fromTrailing = parseTrailingTime(text);
  if (fromTrailing) return fromTrailing;
  return parseLeadingTime(text);
}

// 解析 <current_time>Sat 26-08-15 12:37:16</current_time> 里的时间（两位年份补全）
function parseCurrentTimeTag(text) {
  const m = String(text || "").match(/<current_time>[\s\S]*?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: 2000 + Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, TIME_ZONE);
}

function formatTime(d) {
  if (!d) return "";
  return formatDateTimeInTimeZone(d, TIME_ZONE);
}

function snippet(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ---------------- 分块（软目标 + 自然边界） ----------------

// 在 [start+minSize-1, start+maxSize-1] 内选一个最接近 idealSize、
// 且尽量落在自然边界（时间间隔 / 对方发言）上的切分点，返回该点下标。
function pickBestCut(items, start, idealSize, cfg, minSize, maxSize) {
  const gapMs = (Number(cfg.compaction_gap_minutes) || 30) * 60 * 1000;
  const remaining = items.length - start;
  const lo = Math.min(minSize, remaining);
  const hi = Math.min(maxSize, remaining);
  let best = start + Math.min(idealSize, remaining) - 1;
  let bestScore = -Infinity;
  for (let i = start + lo - 1; i <= start + hi - 1; i++) {
    const next = items[i + 1];
    if (!next) { best = i; bestScore = Infinity; break; }
    if (next.msg.role === "tool" || next.msg.tool_call_id) continue;
    let score = 0;
    const tCur = msgTime(items[i].msg);
    const tNext = msgTime(next.msg);
    if (tCur && tNext) {
      const diff = Math.abs(tNext.getTime() - tCur.getTime());
      if (diff >= gapMs) score += 4;
    }
    if (next.msg.role === "user") score += 5;
    score -= Math.abs((i - start + 1) - idealSize) * 0.05;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function computeChunks(items, cfg, includeMsgs) {
  const target = Math.max(10, Math.floor(Number(cfg.compaction_chunk_size) || 100));
  const minSize = Math.max(5, Math.floor(Number(cfg.compaction_chunk_min) || Math.floor(target / 2)));
  const maxSize = Math.max(minSize + 5, Math.floor(Number(cfg.compaction_chunk_max) || target * 2));
  const chunks = [];
  let start = 0;
  while (start < items.length) {
    const remaining = items.length - start;
    const end = pickBestCut(items, start, Math.min(target, remaining), cfg, minSize, maxSize);
    chunks.push(makeChunk(items.slice(start, end + 1), chunks.length + 1, includeMsgs, false));
    start = end + 1;
  }
  return chunks;
}

function makeChunk(items, index, includeMsgs, manual) {
  // 签名只统计普通对话内容：特殊事件（记忆浮现/推送/共影/唤醒等）会被后台流程增删移动，
  // 若计入签名会导致块签名漂移、缓存摘要全部失配。
  const sigTexts = items.filter(function (it) { return !isSpecialEvent(it.msg); }).map(function (it) { return contentToText(it.msg); });
  const texts = items.map(function (it) { return contentToText(it.msg); });
  const sig = crypto.createHash("sha256").update(sigTexts.join("\u0001")).digest("hex").slice(0, 32);
  const times = items.map(function (it) { return msgTime(it.msg); }).filter(Boolean);
  let minT = null;
  let maxT = null;
  times.forEach(function (d) {
    const t = d.getTime();
    if (minT === null || t < minT) minT = t;
    if (maxT === null || t > maxT) maxT = t;
  });
  const chars = texts.reduce(function (s, t) { return s + t.length; }, 0);
  const chunk = {
    index: index,
    firstIdx: items[0].idx,
    lastIdx: items[items.length - 1].idx,
    count: items.length,
    chars: chars,
    startTime: minT !== null ? formatTime(new Date(minT)) : "",
    endTime: maxT !== null ? formatTime(new Date(maxT)) : "",
    head: snippet(texts[0], 40),
    tail: snippet(texts[texts.length - 1], 40),
    signature: sig,
    cached: false,
    summary: null,
    generatedAt: null,
    mode: null,
    manual: !!manual
  };
  if (includeMsgs) {
    const marks = loadMarks();
    chunk.msgs = items.map(function (it) {
      const m = it.msg;
      const t = msgTime(m);
      return {
        role: m.role,
        content: contentToText(m),
        thinking: m.thinking,
        time: t ? formatTime(t) : "",
        key: contentKey(m),
        marked: !!marks[contentKey(m)]
      };
    });
  }
  return chunk;
}

// ---------------- 缓存（内容寻址） ----------------

function loadCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (data && data.chunks && typeof data.chunks === "object") return data.chunks;
  } catch (err) { /* 无缓存或损坏时视为空 */ }
  return {};
}

function saveCache(chunksMap) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, chunks: chunksMap }, null, 2), "utf-8");
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    console.error("[context-compactor] 缓存写入失败:", err.message);
  }
}

// 单块强制替换：记录被标记「替换上下文」的块签名
function loadForceReplace() {
  try {
    const data = JSON.parse(fs.readFileSync(FORCE_FILE, "utf-8"));
    if (data && Array.isArray(data.signatures)) {
      return data.signatures.map(String).filter(Boolean);
    }
  } catch (err) { /* 无配置时为空 */ }
  return [];
}

function setForceReplace(signature, on) {
  const set = new Set(loadForceReplace());
  if (on) set.add(String(signature)); else set.delete(String(signature));
  const arr = Array.from(set);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FORCE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, signatures: arr }, null, 2), "utf-8");
  fs.renameSync(tmp, FORCE_FILE);
  return arr;
}

// =============================================================
// 块存储（v2）：独立起止范围，取代旧 cutPoints 连续边界
// =============================================================

function loadBlocks() {
  // 1) 尝试加载新格式
  try {
    const data = JSON.parse(fs.readFileSync(BLOCKS_FILE, "utf-8"));
    if (data && data.version === 2 && Array.isArray(data.blocks)) {
      return data.blocks.map(function(b, i) {
        return {
          start: Math.max(0, Math.floor(Number(b.start) || 0)),
          end: Math.max(0, Math.floor(Number(b.end) || 0)),
          enabled: b.enabled !== false
        };
      }).filter(function(b) { return b.start <= b.end; });
    }
  } catch (err) { /* 无新格式文件 */ }

  // 2) 从旧 cutPoints + forceReplace 迁移
  try {
    const oldCutPoints = loadCutPoints();
    const forceSet = new Set(loadForceReplace());
    if (Array.isArray(oldCutPoints) && oldCutPoints.length > 0) {
      const blocks = [];
      let prev = -1;
      const cfg2 = loadConfig();
      const timeline = loadTimeline();
      const entries = [];
      (Array.isArray(timeline) ? timeline : []).forEach(function(m, i) {
        if (m && m.role !== "system" && isCompressible(m, cfg2.compaction_compress_events !== false)) {
          entries.push({ msg: m, idx: i });
        }
      });
      const compactCount = Math.max(0, entries.length - Math.max(0, Number(cfg2.compaction_keep_recent_messages) || 0));
      oldCutPoints.forEach(function(cp) {
        if (cp <= prev) return;
        const s = prev + 1;
        const e = Math.min(cp, compactCount - 1);
        if (s <= e && s < entries.length) {
          const group = entries.slice(s, e + 1);
          const sig = chunkSignatureOf(group);
          blocks.push({ start: s, end: e, enabled: forceSet.has(sig) });
        }
        prev = cp;
      });
      if (blocks.length > 0) {
        saveBlocks(blocks);
        console.log("[context-compactor] 已从旧 cutPoints 迁移 " + blocks.length + " 个块到新格式");
      }
      return blocks;
    }
  } catch (err) {
    console.warn("[context-compactor] 旧 cutPoints 迁移失败:", err.message);
  }
  return [];
}

function saveBlocks(blocks) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = BLOCKS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      version: 2,
      blocks: blocks.map(function(b) {
        return { start: b.start, end: b.end, enabled: b.enabled !== false };
      })
    }, null, 2), "utf-8");
    fs.renameSync(tmp, BLOCKS_FILE);
  } catch (err) {
    console.error("[context-compactor] 块保存失败:", err.message);
  }
}

function removeBlock(index) {
  const blocks = loadBlocks();
  if (index < 0 || index >= blocks.length) return { ok: false, message: "块不存在" };
  blocks.splice(index, 1);
  saveBlocks(blocks);
  return { ok: true, blocks: blocks };
}

// 新增块：与已有块重叠的部分，旧块会被移除（被新块吞并或拆出未覆盖区）
function addBlockRange(start, end, enabled) {
  if (start < 0 || end < 0 || start > end) return { ok: false, message: "无效的范围" };
  const blocks = loadBlocks();
  const filtered = [];
  let removedCount = 0;
  for (const b of blocks) {
    if (b.start <= end && b.end >= start) {
      removedCount++;
    } else {
      filtered.push(b);
    }
  }
  // enabled 默认 false：新块不自动替换，用户点「替换」后才生效
  filtered.push({ start: start, end: end, enabled: enabled === true });
  filtered.sort(function(a, b) { return a.start - b.start; });
  saveBlocks(filtered);
  return { ok: true, blocks: filtered, removedCount: removedCount };
}

function toggleBlock(index, enabled) {
  const blocks = loadBlocks();
  if (index < 0 || index >= blocks.length) return { ok: false, message: "块不存在" };
  blocks[index].enabled = enabled !== false;
  saveBlocks(blocks);
  return { ok: true, block: blocks[index] };
}

function getBlockGaps(blocks, compactCount) {
  if (!blocks || blocks.length === 0) return [{ start: 0, end: compactCount - 1 }];
  const gaps = [];
  let prevEnd = -1;
  for (const b of blocks) {
    if (b.start > prevEnd + 1) gaps.push({ start: prevEnd + 1, end: b.start - 1 });
    prevEnd = Math.max(prevEnd, b.end);
  }
  if (prevEnd < compactCount - 1) gaps.push({ start: prevEnd + 1, end: compactCount - 1 });
  return gaps.filter(g => g.start <= g.end);
}

// 更新某块的起止范围；被新范围覆盖（重叠）的旧块自动移除/吞并
function updateBlockRange(index, start, end) {
  if (start < 0 || end < 0 || start > end) return { ok: false, message: "无效的范围" };
  const blocks = loadBlocks();
  if (index < 0 || index >= blocks.length) return { ok: false, message: "块不存在" };
  const filtered = [];
  let removedCount = 0;
  for (let k = 0; k < blocks.length; k++) {
    if (k === index) continue;
    const b = blocks[k];
    if (b.start <= end && b.end >= start) {
      removedCount++; // 重叠：吞并/移除
    } else {
      filtered.push(b);
    }
  }
  filtered.push({ start: start, end: end, enabled: blocks[index].enabled !== false });
  filtered.sort(function(a, b) { return a.start - b.start; });
  saveBlocks(filtered);
  return { ok: true, blocks: filtered, removedCount: removedCount };
}


function attachCache(chunks) {
  const cache = loadCache();
  const forceSet = new Set(loadForceReplace());
  chunks.forEach(function (c) {
    const entry = cache[c.signature];
    c.forceReplaced = forceSet.has(c.signature);
    if (entry && entry.summary) {
      c.cached = true;
      c.summary = entry.summary;
      c.generatedAt = entry.generatedAt || null;
      c.mode = entry.mode || null;
      c.history = (entry.history || []).map(function (h, i) {
        return {
          index: i,
          summary: h.summary,
          generatedAt: h.generatedAt,
          mode: h.mode,
          manual: h.manual
        };
      });
    }
  });
  return chunks;
}

function getCachedSummary(signature) {
  const cache = loadCache();
  const e = cache[signature];
  return e && e.summary ? e.summary : null;
}

function storeSummary(signature, summary, meta) {
  const cache = loadCache();
  const prev = cache[signature];
  let history = [];
  if (prev && prev.summary) {
    history = [{
      summary: prev.summary,
      generatedAt: prev.generatedAt,
      mode: prev.mode,
      manual: prev.manual
    }].concat(prev.history || []);
  }
  if (history.length > SUMMARY_HISTORY_MAX) history = history.slice(0, SUMMARY_HISTORY_MAX);
  cache[signature] = {
    summary: summary,
    generatedAt: new Date().toISOString(),
    mode: (meta && meta.mode) || "auto",
    manual: !!(meta && meta.manual),
    range: (meta && meta.range) || null,
    timeRange: (meta && meta.timeRange) || null,
    history: history,
    normKeys: (meta && meta.normKeys) || null
  };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys.sort(function (a, b) {
      return String(cache[a].generatedAt || "").localeCompare(String(cache[b].generatedAt || ""));
    });
    keys.slice(0, keys.length - CACHE_MAX_ENTRIES).forEach(function (k) { delete cache[k]; });
  }
  saveCache(cache);
  return cache[signature];
}

// 手动编辑摘要：旧版压入历史，写入编辑后的内容
function updateSummary(signature, summary, meta) {
  const text = String(summary || "").trim();
  if (!text) throw new Error("摘要内容不能为空");
  const cache = loadCache();
  const prev = cache[signature];
  let history = [];
  if (prev && prev.summary) {
    history = [{
      summary: prev.summary,
      generatedAt: prev.generatedAt,
      mode: prev.mode,
      manual: prev.manual
    }].concat(prev.history || []);
  }
  if (history.length > SUMMARY_HISTORY_MAX) history = history.slice(0, SUMMARY_HISTORY_MAX);
  cache[signature] = {
    summary: text,
    generatedAt: new Date().toISOString(),
    mode: "edited",
    manual: true,
    range: (prev && prev.range) || (meta && meta.range) || null,
    timeRange: (prev && prev.timeRange) || (meta && meta.timeRange) || null,
    history: history
  };
  saveCache(cache);
  return cache[signature];
}

// 手动「添加摘要」：已有摘要时新增一个历史版本（不覆盖当前生效摘要）；无摘要时直接创建
function addSummaryVersion(signature, summary, meta) {
  const text = String(summary || "").trim();
  if (!text) throw new Error("摘要内容不能为空");
  const cache = loadCache();
  const prev = cache[signature];
  if (!prev || !prev.summary) {
    return updateSummary(signature, text, meta);
  }
  const history = [{
    summary: text,
    generatedAt: new Date().toISOString(),
    mode: "manual",
    manual: true
  }].concat(Array.isArray(prev.history) ? prev.history : []);
  if (history.length > SUMMARY_HISTORY_MAX) history.length = SUMMARY_HISTORY_MAX;
  cache[signature] = {
    summary: prev.summary,
    generatedAt: prev.generatedAt,
    mode: prev.mode,
    manual: prev.manual,
    range: prev.range || (meta && meta.range) || null,
    timeRange: prev.timeRange || (meta && meta.timeRange) || null,
    history: history
  };
  saveCache(cache);
  return cache[signature];
}

// 恢复某块的历史版本：当前版本压入历史，目标版本成为当前摘要
function restoreSummary(signature, historyIndex) {
  const cache = loadCache();
  const entry = cache[signature];
  if (!entry || !entry.summary) throw new Error("该块没有缓存摘要");
  const history = entry.history || [];
  const idx = Number(historyIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= history.length) throw new Error("历史版本不存在");
  const target = history[idx];
  const newHistory = [{
    summary: entry.summary,
    generatedAt: entry.generatedAt,
    mode: entry.mode,
    manual: entry.manual
  }].concat(history.filter(function (_, i) { return i !== idx; }));
  if (newHistory.length > SUMMARY_HISTORY_MAX) newHistory.length = SUMMARY_HISTORY_MAX;
  entry.summary = target.summary;
  entry.generatedAt = target.generatedAt;
  entry.mode = target.mode;
  entry.manual = target.manual;
  entry.history = newHistory;
  saveCache(cache);
  return {
    summary: entry.summary,
    generatedAt: entry.generatedAt,
    mode: entry.mode,
    manual: entry.manual,
    history: entry.history
  };
}

// 删除某块的一条历史版本
function removeHistoryVersion(signature, historyIndex) {
  const cache = loadCache();
  const entry = cache[signature];
  if (!entry || !entry.history || !entry.history.length) throw new Error("该块没有历史版本");
  const idx = Number(historyIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= entry.history.length) throw new Error("历史版本不存在");
  entry.history.splice(idx, 1);
  saveCache(cache);
  return { remaining: entry.history.length };
}

// ---------------- 手动边界（追加式分块） ----------------

// 「添加一块」：在最后一个已定块之后，从未覆盖内容开头动态切一块（约 chunk_size 条，
// 落在自然边界上，有多少切多少），旧块边界完全不动，新边界追加到 cutPoints 末尾。
// 自动分块模式下第一次点击会先把当前自动分块「固定」成手动边界（不影响已生成摘要）。
function addCutPoint() {
  const cfg = loadConfig();
  const dialog = loadTimeline().filter(function (m) { return m && m.role !== "system"; });
  const items = [];
  dialog.forEach(function (m, idx) {
    if (isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });
  const total = items.length;
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = total >= minMessages ? Math.max(0, total - keepRecent) : 0;
  if (compactCount === 0) return { ok: false, message: "当前消息数不足，还没有可压缩的内容。" };
  const compactItems = items.slice(0, compactCount);
  let cutPoints = loadCutPoints().filter(function (cp) { return cp < compactCount; });
  if (cutPoints.length === 0) {
    // 自动分块模式：先固定当前自动分块，避免后续边界被重排
    const natural = computeChunks(compactItems, cfg, false);
    const pts = natural.map(function (c) { return c.lastIdx; });
    saveCutPoints(pts);
    return { ok: true, fixed: true, cutPoints: pts, message: "已把自动分块固定为手动边界（旧块边界不再变化）。" };
  }
  let s = 0;
  for (const cp of cutPoints) { if (cp >= s) s = cp + 1; }
  if (s >= compactCount) {
    return { ok: false, message: "最后一块之后还没有未覆盖内容，等新消息进来后再添加。" };
  }
  const target = Math.max(10, Math.floor(Number(cfg.compaction_chunk_size) || 100));
  const minSize = Math.max(5, Math.floor(Number(cfg.compaction_chunk_min) || Math.floor(target / 2)));
  const maxSize = Math.max(minSize + 5, Math.floor(Number(cfg.compaction_chunk_max) || target * 2));
  const remaining = compactCount - s;
  const ideal = Math.min(target, remaining);
  const end = pickBestCut(compactItems, s, ideal, cfg, minSize, maxSize);
  const newCutPoints = cutPoints.concat(end);
  saveCutPoints(newCutPoints);
  return { ok: true, cutPoints: newCutPoints, addedCount: end - s + 1 };
}

// 「移除一块」：删除最后一个已定块，该块内容退回未覆盖区（取消摘要覆盖）
function removeCutPoint() {
  const cutPoints = loadCutPoints();
  if (cutPoints.length === 0) return { ok: false, message: "当前没有手动分块可移除。" };
  const newCutPoints = cutPoints.slice(0, -1);
  saveCutPoints(newCutPoints);
  return { ok: true, cutPoints: newCutPoints };
}

// ---------------- 多套边界配置（分窗口） ----------------
// 每套配置对应一个窗口的边界；请求/预览时自动选用「命中缓存摘要最多」的那套，
// 避免换窗口生成新摘要时把另一窗口的边界覆盖掉。

let ACTIVE_CUTPOINT_CONFIG_ID = null;

function normalizeCutPoints(points) {
  return Array.from(new Set((Array.isArray(points) ? points : [])
    .map(Number)
    .filter(function (v) { return Number.isInteger(v) && v >= 0; })))
    .sort(function (a, b) { return a - b; });
}

function loadCutPointConfigs() {
  try {
    const data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf-8"));
    if (data && data.version === 2 && Array.isArray(data.configs)) {
      return data.configs
        .filter(function (c) { return c && Array.isArray(c.cutPoints); })
        .map(function (c) {
          return {
            id: String(c.id || ("cfg-" + Math.random().toString(36).slice(2, 8))),
            cutPoints: c.cutPoints.map(Number).filter(function (v) { return Number.isInteger(v) && v >= 0; }),
            updatedAt: String(c.updatedAt || ""),
            blockAnchors: Array.isArray(c.blockAnchors) ? c.blockAnchors : null
          };
        });
    }
    if (data && Array.isArray(data.cutPoints)) {
      // v1 单套配置 → 迁移为 v2
      return [{
        id: "cfg-default",
        cutPoints: data.cutPoints.map(Number).filter(function (v) { return Number.isInteger(v) && v >= 0; }),
        updatedAt: ""
      }];
    }
  } catch (err) { /* 无边界配置 */ }
  return [];
}

function saveCutPointConfigs(configs) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = OVERRIDES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 2, configs: configs }, null, 2), "utf-8");
    fs.renameSync(tmp, OVERRIDES_FILE);
  } catch (err) {
    console.error("[context-compactor] 边界配置保存失败:", err.message);
  }
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 给一套边界打分：在当前时间线下能命中多少块「有摘要且被强制替换」的块
function scoreCutPointConfig(config, timeline, cfg, cache, forceSet) {
  const compressEvents = cfg.compaction_compress_events !== false;
  const entries = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, compressEvents)) entries.push({ msg: m, arrIdx: i });
  });
  const total = entries.length;
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = total >= minMessages ? Math.max(0, total - keepRecent) : 0;
  let matched = 0;
  let totalBlocks = 0;
  if (compactCount > 0) {
    const compactEntries = entries.slice(0, compactCount);
    const cutPoints = (Array.isArray(config.cutPoints) ? config.cutPoints : [])
      .filter(function (cp) { return cp < compactCount; });
    const anchors = (config.blockAnchors || []).slice(0, cutPoints.length);
    const blocks = contentAnchoredBlocks(compactEntries, cutPoints, anchors);
    for (const b of blocks) {
      const g = b.group;
      if (g.length === 0) continue;
      totalBlocks++;
      const sig = chunkSignatureOf(g);
      if (cache[sig] && cache[sig].summary && forceSet.has(sig)) matched++;
    }
  }
  return { matched: matched, totalBlocks: totalBlocks };
}

// 选出当前时间线最匹配的一套边界；返回 { id, cutPoints, matched, configCount }
function resolveCutPointConfig(opts) {
  const configs = loadCutPointConfigs();
  if (configs.length === 0) {
    ACTIVE_CUTPOINT_CONFIG_ID = null;
    return { id: null, cutPoints: [], matched: 0, configCount: 0 };
  }
  const o = opts || {};
  const timeline = o.timeline || loadTimeline();
  const cfg = o.cfg || loadConfig();
  const cache = o.cache || loadCache();
  const force = o.forceReplace || new Set(loadForceReplace());
  // 当前时间线可压缩消息数，用来判断一套边界是否仍适配当前窗口
  const compressEvents = cfg.compaction_compress_events !== false;
  const entries = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, compressEvents)) entries.push(m);
  });
  const total = entries.length;
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = total >= minMessages ? Math.max(0, total - keepRecent) : 0;
  function fitCountOf(cps) {
    return (Array.isArray(cps) ? cps : []).filter(function (cp) { return cp < compactCount; }).length;
  }
  if (configs.length === 1) {
    ACTIVE_CUTPOINT_CONFIG_ID = configs[0].id;
    return { id: configs[0].id, cutPoints: configs[0].cutPoints, matched: 0, configCount: 1, blockAnchors: configs[0].blockAnchors || null };
  }
  let best = configs[0];
  let bestScore = -1;
  let bestFit = -1;
  const scored = [];
  for (const c of configs) {
    const r = scoreCutPointConfig(c, timeline, cfg, cache, force);
    const fit = fitCountOf(c.cutPoints);
    scored.push({ id: c.id, score: r.matched, fit: fit });
    if (r.matched > bestScore || (r.matched === bestScore && fit > bestFit)) {
      bestScore = r.matched;
      bestFit = fit;
      best = c;
    }
  }
  // 平分（包括 force 为空时全部 0 分）优先上一次活动的配置，避免窗口来回跳
  if (ACTIVE_CUTPOINT_CONFIG_ID) {
    const activeScore = scored.find(function (s) { return s.id === ACTIVE_CUTPOINT_CONFIG_ID; });
    const activeCfg = configs.find(function (c) { return c.id === ACTIVE_CUTPOINT_CONFIG_ID; });
    if (activeScore && activeCfg && activeScore.score === bestScore && activeScore.fit > 0) {
      best = activeCfg;
    }
  }
  ACTIVE_CUTPOINT_CONFIG_ID = best.id;
  return { id: best.id, cutPoints: best.cutPoints, matched: bestScore, configCount: configs.length, blockAnchors: best.blockAnchors || null };
}

function listCutPointConfigs() {
  return loadCutPointConfigs().map(function (c) {
    return { id: c.id, cutPoints: c.cutPoints, updatedAt: c.updatedAt };
  });
}

function loadCutPoints() {
  return resolveCutPointConfig().cutPoints;
}


function deriveAnchorsForConfig(cutPointList) {
  try {
    const cfg = loadConfig();
    const entries = [];
    loadTimeline().forEach(function (m, i) {
      if (m && m.role !== "system" && isCompressible(m, cfg.compaction_compress_events !== false)) entries.push({ msg: m, arrIdx: i });
    });
    const list = normalizeCutPoints(cutPointList);
    const cache = loadCache();
    const forceSet = new Set(loadForceReplace());
    return deriveBlockAnchors(entries, list, cache, forceSet);
  } catch (err) {
    console.error("[context-compactor] 边界锚点派生失败:", err.message);
    return null;
  }
}

function saveCutPoints(points, configId) {
  const list = normalizeCutPoints(points);
  const configs = loadCutPointConfigs();
  const now = new Date().toISOString();
  // 0) 前端显式指定当前窗口的配置（预览里展示的那套）→ 直接更新它
  if (configId) {
    const byId = configs.find(function (c) { return c.id === configId; });
    if (byId) {
      byId.cutPoints = list;
      byId.updatedAt = now;
      byId.blockAnchors = deriveAnchorsForConfig(list);
      saveCutPointConfigs(configs);
      ACTIVE_CUTPOINT_CONFIG_ID = byId.id;
      return list;
    }
  }
  // 1) 与某套已有配置完全相同 → 只更新时间戳
  const exact = configs.find(function (c) { return arraysEqual(c.cutPoints, list); });
  if (exact) {
    exact.updatedAt = now;
    saveCutPointConfigs(configs);
    ACTIVE_CUTPOINT_CONFIG_ID = exact.id;
    return list;
  }
  // 2) 当前时间线选中的配置（命中或按适配度/活动状态选出的）→ 视为在编辑该窗口的边界
  const resolved = resolveCutPointConfig();
  if (resolved.id) {
    const target = configs.find(function (c) { return c.id === resolved.id; });
    if (target) {
      target.cutPoints = list;
      target.updatedAt = now;
      target.blockAnchors = deriveAnchorsForConfig(list);
      saveCutPointConfigs(configs);
      ACTIVE_CUTPOINT_CONFIG_ID = target.id;
      return list;
    }
  }
  // 3) 新窗口（没有可编辑的配置）→ 新建一套，绝不覆盖旧窗口
  const id = "cfg-" + Date.now().toString(36);
  configs.push({ id: id, cutPoints: list, updatedAt: now, blockAnchors: deriveAnchorsForConfig(list) });
  saveCutPointConfigs(configs);
  ACTIVE_CUTPOINT_CONFIG_ID = id;
  return list;
}

// ---------------- 摘要长度（自适应） ----------------

function estimatedSummaryChars(chunk, cfg) {
  if (chunk.cached && chunk.summary) return chunk.summary.length;
  const minChars = Number(cfg.compaction_summary_min_chars) || 250;
  const maxChars = Number(cfg.compaction_summary_max_chars) || 1200;
  const est = Math.round((chunk.chars || 0) / 50);
  return Math.max(minChars, Math.min(maxChars, est));
}

// ---------------- 摘要提示词（人设 + 反幻觉） ----------------

function loadCompactionPromptConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(COMPACTION_PROMPT_FILE, "utf-8"));
    if (cfg && typeof cfg.template === "string" && cfg.template.trim()) {
      return {
        system: typeof cfg.system === "string" && cfg.system.trim() ? cfg.system : DEFAULT_COMPACTION_SYSTEM,
        template: cfg.template
      };
    }
  } catch (err) { /* 缺失时使用默认 */ }
  return { system: DEFAULT_COMPACTION_SYSTEM, template: DEFAULT_COMPACTION_TEMPLATE };
}

function buildCompactionPrompt(chunk, cfg) {
  const persona = loadPersona();
  const maxChars = Number(cfg.compaction_summary_max_chars) || 1200;
  const minChars = Number(cfg.compaction_summary_min_chars) || 250;
  const normalChars = Math.max(minChars, Math.min(maxChars, Math.round((chunk.chars || 0) / 50)));
  const promptCfg = loadCompactionPromptConfig();
  const msgs = chunk.msgs || [];
  // 浮现的记忆不参与摘要（它们是记忆池注入内容，不是对话本身）；整块只有记忆浮现时退回原文保底
  const usable = msgs.filter(function (m) { return !isMemoryFlash(m); });
  const targetMsgs = usable.length > 0 ? usable : msgs;
  const lines = targetMsgs.map(function (m) {
    const role = m.role === "user" ? (process.env.USER_DISPLAY_NAME || "对方") : "我";
    const body = contentToText(m);
    const think = cfg.compaction_include_thinking && m.thinking ? "\n（内心活动）" + String(m.thinking) : "";
    const line = "[" + role + "] " + body + think;
    return line;
  });
  let conversationText = lines.join("\n\n");
  if (usable.length > 0 && usable.length !== msgs.length) {
    conversationText += "\n\n（注：本段内有 " + (msgs.length - usable.length) + " 条「记忆浮现」系统事件，属于记忆池注入内容，未纳入摘要；被摘要时它们会直接从上下文中移除。）";
  }
  const chunkInfo = (chunk.startTime || "未知") + " ~ " + (chunk.endTime || "未知") + "，共 " + chunk.count + " 条";
  return {
    system: promptCfg.system,
    prompt: promptCfg.template
      .replace("${PERSONA}", persona)
      .replace("${chunkInfo}", chunkInfo)
      .replace("${conversationText}", conversationText)
      .replace("${normalChars}", String(normalChars))
      .replace("${maxChars}", String(maxChars))
  };
}

// ---------------- 压缩提示词（管理台编辑） ----------------

function getCompactionPromptForDisplay() {
  const cfg = loadCompactionPromptConfig();
  return {
    system: cfg.system,
    template: cfg.template,
    prompt: cfg.template
      .replace("${PERSONA}", loadPersona())
      .replace("${chunkInfo}", "2026-07-27 00:00 ~ 2026-08-01 23:59，共 100 条")
      .replace("${conversationText}", "【此处为待摘要的对话原文】")
      .replace("${normalChars}", "300")
      .replace("${maxChars}", "1200")
  };
}

function saveCompactionPromptConfig(system, template) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = {
    system: String(system || "").trim(),
    template: String(template || "")
  };
  if (!cfg.template.trim()) throw new Error("模板不能为空");
  const tmp = COMPACTION_PROMPT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  fs.renameSync(tmp, COMPACTION_PROMPT_FILE);
  return cfg;
}

function resetCompactionPromptConfig() {
  if (fs.existsSync(COMPACTION_PROMPT_FILE)) fs.unlinkSync(COMPACTION_PROMPT_FILE);
  return { system: DEFAULT_COMPACTION_SYSTEM, template: DEFAULT_COMPACTION_TEMPLATE };
}

// ---------------- 摘要生成（调用上游模型） ----------------

// 调用上游模型生成摘要文本（不含落盘）：手动块与未覆盖区生成共用
async function callCompactionLLM(built, label) {
  const targetUrl = process.env.TARGET_API_URL;
  const targetKey = process.env.TARGET_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!targetUrl || !targetKey || !model) {
    throw new Error("TARGET_API_URL / TARGET_API_KEY / MODEL_NAME 未配置");
  }
  const outputBudgets = [16000, 32000, 50000];
  let lastErr = null;
  for (let attempt = 0; attempt < outputBudgets.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 300 * 1000);
    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + targetKey
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: built.system },
            { role: "user", content: built.prompt }
          ],
          temperature: 0.4,
          max_tokens: outputBudgets[attempt],
          stream: false
        }),
        signal: controller.signal
      });
      if (!resp.ok) throw new Error("上游返回 HTTP " + resp.status);
      const data = await resp.json();
      const finishReason = data.choices && data.choices[0] && data.choices[0].finish_reason;
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const summary = raw ? String(raw).trim() : "";
      if (!summary || finishReason === "length") {
        const why = !summary ? "上游返回空摘要" : "摘要被截断（finish_reason=length）";
        if (attempt >= outputBudgets.length - 1) {
          throw new Error(why);
        }
        console.warn("[context-compactor] " + (label || "摘要") + " " + why + "，增大输出预算重试");
        lastErr = new Error(why);
        continue;
      }
      return summary;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error("摘要生成失败");
}

async function generateSummary(chunk, meta) {
  const cfg = loadConfig();
  if (!chunk.msgs || chunk.msgs.length === 0) throw new Error("块内没有可摘要的消息");
  const built = buildCompactionPrompt(chunk, cfg);
  const summary = await callCompactionLLM(built, "块 #" + chunk.index);
  storeSummary(chunk.signature, summary, {
    mode: (meta && meta.mode) || "manual",
    manual: !!(meta && meta.manual),
    range: { start: chunk.firstIdx + 1, end: chunk.lastIdx + 1 },
    timeRange: (chunk.startTime || "") + " ~ " + (chunk.endTime || ""),
    normKeys: blockNormKeys(chunk.msgs.map(function (it) { return { msg: it.msg }; }))
  });
  console.log("[context-compactor] 块 #" + chunk.index + " 摘要已生成（" + summary.length + " 字）");
  return {
    index: chunk.index,
    signature: chunk.signature,
    summary: summary,
    cached: true,
    length: summary.length,
    truncated: false
  };
}

// 已有手动块（0-based index）重新生成摘要：按块范围取消息 → 压缩提示词生成 → 覆盖写入摘要缓存（旧摘要进历史）
async function generateBlockSummary(blockIndex) {
  const cfg = loadConfig();
  const blocks = loadBlocks();
  if (blockIndex < 0 || blockIndex >= blocks.length) return { ok: false, message: "块不存在" };
  const b = blocks[blockIndex];
  const timeline = loadTimeline();
  const dialog = (Array.isArray(timeline) ? timeline : []).filter(function (m) { return m && m.role !== "system"; });
  const items = [];
  dialog.forEach(function (m, idx) {
    if (isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = items.length >= minMessages ? Math.max(0, items.length - keepRecent) : 0;
  if (compactCount <= 0) return { ok: false, message: "当前没有可压缩内容" };
  if (b.start >= compactCount) return { ok: false, message: "该块超出当前可压缩范围" };
  const end = Math.min(b.end, compactCount - 1);
  const chunk = makeChunk(items.slice(b.start, end + 1), 0, true, true);
  const built = buildCompactionPrompt(chunk, cfg);
  const summary = await callCompactionLLM(built, "块 #" + (blockIndex + 1));
  storeSummary(chunk.signature, summary, {
    mode: "manual",
    manual: true,
    range: { start: chunk.firstIdx + 1, end: chunk.lastIdx + 1 },
    timeRange: (chunk.startTime || "") + " ~ " + (chunk.endTime || ""),
    normKeys: blockNormKeys(chunk.msgs.map(function (it) { return { msg: it.msg }; }))
  });
  console.log("[context-compactor] 手动块 #" + (blockIndex + 1) + " 摘要已生成（" + summary.length + " 字）");
  return { ok: true, blockIndex: blockIndex, length: summary.length };
}

// 按压缩索引范围直接生成摘要文字（统一替换用：不写块、不写缓存，只返回文字）
async function generateSummaryForRange(start, end) {
  const cfg = loadConfig();
  const timeline = loadTimeline();
  const items = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, idx) {
    if (m && m.role !== "system" && isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = items.length >= minMessages ? Math.max(0, items.length - keepRecent) : 0;
  if (compactCount <= 0) return { ok: false, message: "当前没有可压缩内容" };
  const s = Math.max(0, Math.floor(Number(start) || 0));
  let e = Math.floor(Number(end));
  if (!Number.isInteger(e) || e < s) e = s;
  if (s >= compactCount) return { ok: false, message: "起始编号超出当前可压缩范围" };
  e = Math.min(e, compactCount - 1);
  const chunk = makeChunk(items.slice(s, e + 1), 0, true, true);
  const built = buildCompactionPrompt(chunk, cfg);
  const summary = await callCompactionLLM(built, "块");
  return { ok: true, summary: summary, length: summary.length, count: chunk.count };
}

function removeSummaries(signatures) {
  const cache = loadCache();
  const sigSet = new Set((signatures || []).filter(Boolean));
  let removed = 0;
  for (const sig of sigSet) {
    if (cache[sig]) { delete cache[sig]; removed++; }
  }
  if (removed > 0) saveCache(cache);
  return removed;
}

// ---------------- 重要内容标记 ----------------

function contentKey(msg) {
  const text = contentToText(msg);
  return crypto.createHash("sha256").update((msg && msg.role ? msg.role : "") + "\u0000" + text).digest("hex").slice(0, 32);
}

function loadMarks() {
  try {
    const data = JSON.parse(fs.readFileSync(MARKS_FILE, "utf-8"));
    if (data && data.marks && typeof data.marks === "object") return data.marks;
  } catch (err) { /* 无标记 */ }
  return {};
}

function saveMarks(marks) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = MARKS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, marks: marks }, null, 2), "utf-8");
    fs.renameSync(tmp, MARKS_FILE);
  } catch (err) {
    console.error("[context-compactor] 标记保存失败:", err.message);
  }
}

function setMark(key, marked, opt) {
  const marks = loadMarks();
  if (marked) {
    const entry = { markedAt: new Date().toISOString() };
    // 标星时把原文一并存下（若传入），跨窗口注入无需再回查时间线/替换池
    if (opt && opt.content) entry.content = opt.content;
    if (opt && opt.role) entry.role = opt.role;
    // 兜底：若前端/matched 反查没拿到原文，直接去时间线原文件按指纹反查，
    // 保证标星一定带原文（藏于时间线原始记录，比 matched 存档更可靠）
    if (!entry.content) {
      const orig = findContentByKey(key);
      if (orig && orig.content) { entry.content = orig.content; entry.role = entry.role || orig.role; }
    }
    // 标星必须落库完整原文：否则跨窗口注入/已标星列表会因原文丢失而失效。
    // 找不到原文时明确失败，绝不写入空壳 mark。
    if (!entry.content) {
      console.warn("[context-compactor] 标星失败：无法回溯到原文 key=" + key);
      return { ok: false, error: "无法回溯到这条消息的原文，标星失败（请刷新后重试）" };
    }
    marks[key] = entry;
  } else {
    delete marks[key];
  }
  saveMarks(marks);
  return { ok: true, marked: !!marked };
}

// 从时间线原文件（enhanced_messages.json）按内容指纹反查原文。
// 时间线是对话原始记录，比替换池 matched 更完整；仅在标星未带原文时兜底调用。
function findContentByKey(key) {
  try {
    const timeline = loadTimeline();
    for (const m of timeline) {
      if (!m || m.role === "system") continue;
      if (m.deleted === true) continue;
      try {
        if (contentKey(m) === key) {
          const c = contentToText(m);
          if (c) return { content: c, role: m.role || "" };
        }
      } catch (e) { /* 单条失败忽略 */ }
    }
  } catch (err) { /* 反查失败不阻断标星 */ }
  return null;
}


// ---------------- 转发前压缩（替换缓存摘要） ----------------

function isEnabled() {
  // 手动块（新模型）有启用替换的，或旧 forceReplace 存在 → 启用
  const blocks = loadBlocks();
  return blocks.some(function (b) { return b.enabled !== false; }) || loadForceReplace().length > 0;
}

function chunkSignatureOf(entries) {
  // 与 makeChunk 一致：签名只统计普通对话内容，特殊事件不计入，避免后台增删特殊事件导致签名漂移
  const texts = entries.filter(function (e) { return !isSpecialEvent(e.msg); }).map(function (e) { return contentToText(e.msg); });
  return crypto.createHash("sha256").update(texts.join("\u0001")).digest("hex").slice(0, 32);
}


// ---------------- 内容锚定分块 ----------------
// 块边界以「内容 key」锚定而非固定索引：时间线里特殊事件/客户端历史组合变化
// 会让固定索引切片漂移，导致块签名失配、缓存摘要整块失效。
// 锚定后块的纯对话跨度稳定，签名只随真实对话内容变化。

function deriveBlockAnchors(entries, cutPoints, cache, forceSet) {
  const anchors = [];
  let s = 0;
  for (const cp of cutPoints) {
    if (cp < s) continue;
    const slice = entries.slice(s, cp + 1);
    const nonSpecial = [];
    for (let i = slice.length - 1; i >= 0 && nonSpecial.length < 6; i--) {
      if (!isSpecialEvent(slice[i].msg)) nonSpecial.push(slice[i]);
    }
    let chosen = null;
    if (cache && forceSet && nonSpecial.length > 0) {
      for (const cand of nonSpecial) {
        const key = normalizedCompareKey(cand.msg);
        let endIdx = -1;
        for (let j = s; j < entries.length; j++) {
          if (!isSpecialEvent(entries[j].msg) && normalizedCompareKey(entries[j].msg) === key) { endIdx = j; break; }
        }
        if (endIdx === -1) continue;
        const sig = chunkSignatureOf(entries.slice(s, endIdx + 1));
        if (cache[sig] && cache[sig].summary && forceSet.has(sig)) { chosen = key; break; }
      }
    }
    if (!chosen && nonSpecial.length > 0) chosen = normalizedCompareKey(nonSpecial[0].msg);
    anchors.push(chosen ? { end: chosen } : null);
    s = cp + 1;
  }
  return anchors;
}

function contentAnchoredBlocks(entries, cutPoints, blockAnchors) {
  const blocks = [];
  let s = 0;
  cutPoints.forEach(function (cp, i) {
    if (cp < s) return;
    const anchor = blockAnchors && blockAnchors[i];
    let endIdx = -1;
    if (anchor && anchor.end) {
      for (let j = s; j < entries.length; j++) {
        if (!isSpecialEvent(entries[j].msg) && normalizedCompareKey(entries[j].msg) === anchor.end) { endIdx = j; break; }
      }
    }
    if (endIdx === -1) endIdx = Math.min(cp, entries.length - 1);
    if (endIdx < s) { s = cp + 1; return; }
    blocks.push({ startIdx: s, endIdx: endIdx, group: entries.slice(s, endIdx + 1) });
    s = endIdx + 1;
  });
  return blocks;
}


// 序列相似度：允许少量跳过（客户端合并/拆分消息、边界微漂移），
// 用于「签名失配但内容基本一致」时仍能命中缓存摘要。
function sequenceSimilarity(keys, refKeys) {
  if (keys.length === 0 || refKeys.length === 0) return 0;
  let j = 0;
  let matched = 0;
  for (const key of keys) {
    const limit = Math.min(refKeys.length, j + 8);
    let found = -1;
    for (let k = j; k < limit; k++) {
      if (refKeys[k] === key) { found = k; break; }
    }
    if (found >= 0) { matched++; j = found + 1; }
  }
  return matched / keys.length;
}

// 块的纯对话归一化键序列（与摘要生成时缓存的口径一致）
function blockNormKeys(group) {
  return group.filter(function (e) { return !isSpecialEvent(e.msg); }).map(function (e) { return normalizedCompareKey(e.msg); });
}

// 精确签名未命中时，在 force 集合里找内容高度相似的缓存摘要
function findFuzzySummary(group, cache, forceSet) {
  const keys = blockNormKeys(group);
  if (keys.length === 0) return null;
  let best = null;
  let bestSim = 0;
  forceSet.forEach(function (s) {
    const e = cache[s];
    if (!e || !e.summary || !Array.isArray(e.normKeys) || e.normKeys.length === 0) return;
    const sim = sequenceSimilarity(keys, e.normKeys);
    if (sim > bestSim) { bestSim = sim; best = s; }
  });
  if (best && bestSim >= 0.93) return { sig: best, similarity: bestSim };
  return null;
}

function buildSummaryMessage(entries, summary) {
  const times = entries.map(function (e) { return msgTime(e.msg); }).filter(Boolean);
  let minT = null;
  let maxT = null;
  times.forEach(function (d) {
    const t = d.getTime();
    if (minT === null || t < minT) minT = t;
    if (maxT === null || t > maxT) maxT = t;
  });
  const range = (entries[0].arrIdx + 1) + "-" + (entries[entries.length - 1].arrIdx + 1);
  const timeRange = minT !== null
    ? " · " + formatTime(new Date(minT)) + " ~ " + formatTime(new Date(maxT))
    : "";
  return {
    role: "assistant",
    _ccSummary: true,
    content: "（早期对话摘要 · 第" + range + "条" + timeRange + "）\n" + summary
  };
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

function naturalGroups(entries, cfg) {
  const positioned = entries.map(function (e, i) { return { msg: e.msg, idx: i }; });
  return computeChunks(positioned, cfg, false).map(function (c) {
    return entries.slice(c.firstIdx, c.lastIdx + 1);
  });
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

function compactMessages(messages, opts) {
  const cfg = Object.assign(loadConfig(), (opts && opts.config) || {});
  const compressEvents = cfg.compaction_compress_events !== false;
  const src = Array.isArray(messages) ? messages : [];
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);

  // 与「生成摘要 / 预览」同源：用时间线计算块与签名，
  // 避免真实请求（注入事件、客户端重复消息等）与生成时内容不一致导致签名失配、摘要全部失效。
  const timeline = loadTimeline();
  const tlEntries = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, compressEvents)) {
      tlEntries.push({ msg: m, arrIdx: i });
    }
  });
  const total = tlEntries.length;
  if (total < minMessages) return messages;
  const compactCount = Math.max(0, total - keepRecent);
  if (compactCount === 0) return messages;
  const compactEntries = tlEntries.slice(0, compactCount);

  // 手动块（独立起止范围）：只处理开启了 enabled 的块
  const cache = loadCache();
  const forceReplace = new Set(loadForceReplace());
  const blocks = loadBlocks().filter(function(b) { return b.enabled !== false; });
  let groups = [];
  if (blocks.length > 0) {
    for (const b of blocks) {
      if (b.start < compactCount) {
        const end = Math.min(b.end, compactCount - 1);
        if (b.start <= end) {
          const slice = compactEntries.slice(b.start, end + 1);
          if (slice.length > 0) groups.push(slice);
        }
      }
    }
  }
  // 没有启用了替换的手动块 → 不压缩（块只来自手动划分，没有自动分块）
  // 兼容旧 forceReplace：若旧签名仍存在且有缓存摘要，用自然分块匹配（迁移过渡期）
  if (groups.length === 0 && forceReplace.size > 0) {
    groups = naturalGroups(compactEntries, cfg);
  }
  if (groups.length === 0) return messages;

  // 锚点视图：请求里只有「纯对话」消息参与定位（与时间线块签名口径一致），
  // 工具消息 / 空消息 / 按时间重排的特殊事件全部排除，避免它们干扰块边界定位
  const srcAnchorIdx = [];
  const srcAnchorKeys = [];
  src.forEach(function (m, i) {
    if (!m) return;
    if (m.role === "system") return;
    if (m.role === "tool" || m.tool_calls || m.tool_call_id) return;
    if (isSpecialEvent(m)) return;
    if (contextReplacements.isReplacementMemoryMessage(m)) return;
    if (!String(contentToText(m)).trim()) return;
    srcAnchorIdx.push(i);
    srcAnchorKeys.push(normalizedCompareKey(m));
  });
  if (srcAnchorIdx.length === 0) return messages;

  // 时间线纯对话序列（内容锚点失败时做位置近似兜底）
  const tlPurePos = [];
  tlEntries.forEach(function (e, i) { if (!isSpecialEvent(e.msg)) tlPurePos.push(i); });

  // 特殊事件精确时间：客户端请求不带 time 字段，正文时间只有分钟粒度，
  // 优先用时间线保存的精确时间（带秒），避免事件落在块起点前几秒被误判为块外
  const tlEventTimeByKey = new Map();
  tlEntries.forEach(function (e) {
    if (!isSpecialEvent(e.msg)) return;
    const t = e.msg && e.msg.time ? new Date(e.msg.time) : null;
    if (t && !isNaN(t.getTime()) && !tlEventTimeByKey.has(normalizedCompareKey(e.msg))) {
      tlEventTimeByKey.set(normalizedCompareKey(e.msg), t);
    }
  });

  const replacements = [];
  let searchStart = 0;
  groups.forEach(function (g, gi) {
    if (!g || g.length === 0) return;
    const sig = chunkSignatureOf(g);
    let entry = cache[sig];
    // 手动块：enabled 即替换（无需再查 forceReplace）；自然分块：需 forceReplace（旧逻辑）
    let hit = blocks.length > 0
      ? !!(entry && entry.summary)
      : !!(entry && entry.summary && forceReplace.has(sig));

    if (!hit) {
      const fuzzy = findFuzzySummary(g, cache, forceReplace);
      if (fuzzy && fuzzy.sig !== sig) {
        entry = cache[fuzzy.sig];
        hit = true;
        if (process.env.CC_DEBUG === '1') console.log('[CC-DEBUG]   fuzzy hit gi', gi, 'sig', sig, '->', fuzzy.sig, 'sim', fuzzy.similarity.toFixed(3));
      }
    }
    if (process.env.CC_DEBUG === '1') {
      console.log('[CC-DEBUG] group', gi, 'size', g.length, 'sig', sig, 'cache', !!(entry && entry.summary),'hit', hit);
    }
    if (!hit) return;

    // 用内容锚点把时间线块映射到本次请求消息中的位置（容忍重复消息/注入事件造成的偏移）
    let aStart = null, aEnd = null;
    for (const e of g) {
      if (!isSpecialEvent(e.msg)) { aStart = e; break; }
    }
    for (let i = g.length - 1; i >= 0; i--) {
      if (!isSpecialEvent(g[i].msg)) { aEnd = g[i]; break; }
    }
    if (!aStart || !aEnd) return;
    const startKey = normalizedCompareKey(aStart.msg);
    const endKey = normalizedCompareKey(aEnd.msg);

    let si = srcAnchorKeys.indexOf(startKey, searchStart);
    if (si === -1) {
      // 兜底：块首条纯对话在时间线纯对话序列中的位置 → 近似映射到请求锚点视图
      let firstNonSpecialTlIdx = -1;
      for (const e of g) {
        if (!isSpecialEvent(e.msg)) { firstNonSpecialTlIdx = tlEntries.indexOf(e); break; }
      }
      const purePos = firstNonSpecialTlIdx >= 0 ? tlPurePos.indexOf(firstNonSpecialTlIdx) : -1;
      if (purePos >= searchStart && purePos < srcAnchorIdx.length) si = purePos;
      else return;
    }

    let ei = srcAnchorKeys.indexOf(endKey, si + 1);
    if (ei === -1) ei = srcAnchorKeys.lastIndexOf(endKey);

    if (ei === -1 || ei < si) {
      // 兜底：块尾锚点在请求里可能被过滤/变形，向前找替代锚点（最多 8 条非特殊事件）
      let found = -1;
      let tried = 0;
      for (let k = g.length - 2; k >= 0 && tried < 8; k--) {
        if (isSpecialEvent(g[k].msg)) continue;
        tried++;
        const alt = normalizedCompareKey(g[k].msg);
        let ae = srcAnchorKeys.indexOf(alt, si + 1);
        if (ae === -1) ae = srcAnchorKeys.lastIndexOf(alt);
        if (ae >= si) { found = ae; break; }
      }
      if (found === -1) return;
      ei = found;
    }

    // 映射回请求原始索引
    const srcStart = srcAnchorIdx[si];
    let srcEnd = srcAnchorIdx[ei];
    // 块尾常跟着工具调用链（tool_calls + tool 返回），属于机械痕迹，一并纳入替换区间
    while (srcEnd + 1 < src.length) {
      const nxt = src[srcEnd + 1];
      if (!nxt) break;
      if (nxt.role === "tool") { srcEnd++; continue; }
      if (nxt.role === "assistant" && nxt.tool_calls && !String(nxt.content || "").trim()) { srcEnd++; continue; }
      break;
    }
    let blkMin = null, blkMax = null;
    g.forEach(function (e) {
      const t = msgTime(e.msg);
      if (!t) return;
      const v = t.getTime();
      if (blkMin === null || v < blkMin) blkMin = v;
      if (blkMax === null || v > blkMax) blkMax = v;
    });
    replacements.push({
      startIdx: srcStart,
      endIdx: srcEnd,
      message: buildSummaryMessage(g, entry.summary),
      minT: blkMin,
      maxT: blkMax
    });
    searchStart = ei + 1;
  });
  if (replacements.length === 0) return messages;
  replacements.sort(function (a, b) { return a.startIdx - b.startIdx; });

  const out = [];
  let r = 0;
  for (let i = 0; i < src.length; i++) {
    // 块时间范围清理：只要特殊事件的时间落在已被摘要覆盖的块范围内，一并清掉
    const m0 = src[i];
    if (m0 && !isDiaryEvent(m0) && isSpecialEvent(m0)) {
      let t0 = null;
      if (m0.time) { const d = new Date(m0.time); if (!isNaN(d.getTime())) t0 = d; }
      if (!t0) t0 = tlEventTimeByKey.get(normalizedCompareKey(m0)) || null;
      if (!t0) t0 = msgTime(m0);
      if (t0) {
        const tv = t0.getTime();
        const inBlock = replacements.some(function (rp) {
          return rp.minT !== null && rp.maxT !== null && tv >= rp.minT && tv <= rp.maxT;
        });
        if (inBlock) continue; // 特殊事件在块范围内 → 与对话一起被压缩掉
      }
    }
    if (r < replacements.length && replacements[r].startIdx === i) {
      out.push(replacements[r].message);
      // 被摘要区间内：记忆浮现与工具痕迹（调用/返回）直接删除，由摘要覆盖；
      // 其余不可压缩消息（如罕见的内嵌系统消息）保留，避免永久事件被摘要吞掉
      for (let j = replacements[r].startIdx; j <= replacements[r].endIdx; j++) {
        const m = src[j];
        if (!m) continue;
        if (isMemoryFlash(m)) continue; // 浮现的记忆：被摘要时段内直接删除
        if (m.role === "tool" || m.tool_calls) continue; // 工具痕迹：被摘要覆盖，删除
        if (contextReplacements.isReplacementMemoryMessage(m)) { out.push(m); continue; } // 记忆替换：保留在摘要之后，避免被吞
        if (!isCompressible(m, compressEvents)) out.push(m);
      }
      i = replacements[r].endIdx;
      r++;
    } else {
      out.push(src[i]);
    }
  }
  return mergeAdjacentSameRole(out);
}

// ---------------- 计划 / 预览 ----------------

function buildPlan(messages, opts) {
  const cfg = Object.assign(loadConfig(), opts || {});
  const includeMsgs = !!(opts && opts.includeMessages);
  const dialog = (Array.isArray(messages) ? messages : []).filter(function (m) {
    return m && m.role !== "system";
  });
  const items = [];
  dialog.forEach(function (m, idx) {
    if (isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });

  const total = items.length;
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = total >= minMessages ? Math.max(0, total - keepRecent) : 0;

  let chunks = [];
  let hasManualBlocks = false;
  let uncovered = null;
  let cutPointConfig = { id: null, matched: 0, configCount: 0 };
  if (compactCount > 0) {
    const compactItems = items.slice(0, compactCount);
    const blocks = loadBlocks();
    hasManualBlocks = blocks.length > 0;
    // 手动块：只在用户/AI 明确划分的位置生成块，不再自动分块
    for (const b of blocks) {
      if (b.start < compactCount) {
        const end = Math.min(b.end, compactCount - 1);
        if (b.start <= end) {
          const group = compactItems.slice(b.start, end + 1);
          if (group.length > 0) {
            const chunk = makeChunk(group, 0, includeMsgs, true);
            chunk.blockStart = b.start;
            chunk.blockEnd = b.end;
            chunk.enabled = b.enabled !== false;
            chunks.push(chunk);
          }
        }
      }
    }
    // 未覆盖区：块与块之间的所有间隙 + 尾部（无块时整个 compactCount 都是未覆盖区）
    const gaps = getBlockGaps(blocks, compactCount);
    if (gaps.length > 0) {
      const g = gaps[0];
      const ucGroup = compactItems.slice(g.start, g.end + 1);
      if (ucGroup.length > 0) {
        const uc = makeChunk(ucGroup, 0, includeMsgs, true);
        uncovered = {
          startIdx: uc.firstIdx + 1,
          endIdx: uc.lastIdx + 1,
          count: uc.count,
          chars: uc.chars,
          startTime: uc.startTime,
          endTime: uc.endTime,
          head: uc.head,
          tail: uc.tail,
          gaps: gaps.map(function(gg) {
            const ggGroup = compactItems.slice(gg.start, gg.end + 1);
            const ggc = makeChunk(ggGroup, 0, false, true);
            return {
              startIdx: gg.start + 1,
              endIdx: gg.end + 1,
              count: ggc.count,
              chars: ggc.chars,
              startTime: ggc.startTime,
              endTime: ggc.endTime
            };
          })
        };
      }
    }
    chunks.forEach(function (c, i) { c.index = i + 1; });
    chunks = attachCache(chunks);
  }

  const chunkCount = chunks.length;
  const cachedCount = chunks.filter(function (c) { return c.cached; }).length;
  const totalChars = items.reduce(function (s, it) { return s + contentToText(it.msg).length; }, 0);
  const compressedChars = chunks.reduce(function (s, c) {
    return s + estimatedSummaryChars(c, cfg);
  }, 0);
  const keptRawCount = total - chunks.reduce(function (s, c) { return s + c.count; }, 0);

  return {
    enabled: hasManualBlocks || loadForceReplace().length > 0,
    config: cfg,
    totalCompressible: total,
    compactCount: compactCount,
    keptRawCount: keptRawCount,
    cutPointsActive: hasManualBlocks,
    cutPointConfig: cutPointConfig,
    uncovered: uncovered,
    chunks: chunks,
    totals: {
      chunkCount: chunkCount,
      cachedCount: cachedCount,
      totalChars: totalChars,
      estCompressedChars: compressedChars,
      estSavedChars: Math.max(0, totalChars - compressedChars)
    }
  };
}

function preview(opts) {
  return buildPlan(loadTimeline(), opts);
}


// 编号范围预览（1-based）：返回范围内每条消息（编号/角色/时间/内容/标记），供未覆盖区滚动窗使用
function rangePreview(start, end, opts) {
  const cfg = loadConfig();
  const timeline = loadTimeline();
  const dialog = (Array.isArray(timeline) ? timeline : []).filter(function (m) { return m && m.role !== "system"; });
  const items = [];
  dialog.forEach(function (m, idx) {
    if (isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });
  // 预览展示完整压缩区间：keepRecent/minMessages 属于实际替换语义，不在此截断
  const compactCount = items.length;
  let s = Math.max(1, Math.floor(Number(start) || 1));
  let e = Math.max(s, Math.floor(Number(end) || s));
  if (compactCount <= 0) return { start: 0, end: 0, count: 0, compactCount: 0, items: [] };
  e = Math.min(e, compactCount);
  s = Math.min(s, e);
  const marks = loadMarks();
  const pageLimit = opts ? (Math.max(0, Math.floor(Number(opts.limit) || 0)) || 0) : 0;
  const pageOffset = opts ? (Math.max(0, Math.floor(Number(opts.offset) || 0)) || 0) : 0;
  const total = e - s + 1;
  let ps = s - 1 + pageOffset;          // 起始压缩下标（0-based 偏移后的绝对位）
  let pe = e;
  const hasMore = pageLimit > 0 && (pageOffset + pageLimit) < total;
  if (pageLimit > 0) pe = Math.min(pe, ps + pageLimit);
  if (ps >= pe) return { start: s, end: e, count: 0, compactCount: total, items: [], hasMore: false };
  const slice = items.slice(ps, pe);
  const out = slice.map(function (it, i) {
    const m = it.msg;
    const t = msgTime(m);
    return {
      num: ps + i + 1,
      role: m.role,
      content: contentToText(m),
      thinking: m.thinking,
      time: t ? formatTime(t) : "",
      key: contentKey(m),
      marked: !!marks[contentKey(m)]
    };
  });
  let minT = null;
  let maxT = null;
  slice.forEach(function (it) {
    const t = msgTime(it.msg);
    if (t) {
      if (minT === null || t < minT) minT = t;
      if (maxT === null || t > maxT) maxT = t;
    }
  });
  return {
    start: s,
    end: e,
    count: out.length,
    compactCount: compactCount,
    startTime: minT ? formatTime(minT) : "",
    endTime: maxT ? formatTime(maxT) : "",
    items: out,
    hasMore: hasMore
  };
}

// 按时间间隔自动分块：在 [start,end]（1-based）范围内，相邻消息时间间隔超过 gapMinutes 分钟即自然切分，
// 切成多块并落成手动块（可再改范围/加摘要/替换）
function splitRangeByGaps(start, end, gapMinutes) {
  const cfg = loadConfig();
  const gapMin = Math.max(1, Number(gapMinutes) || 30);
  const timeline = loadTimeline();
  const dialog = (Array.isArray(timeline) ? timeline : []).filter(function (m) { return m && m.role !== "system"; });
  const items = [];
  dialog.forEach(function (m, idx) {
    if (isCompressible(m, cfg.compaction_compress_events !== false)) items.push({ msg: m, idx: idx });
  });
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  const keepRecent = Math.max(0, Number(cfg.compaction_keep_recent_messages) || 0);
  const compactCount = items.length >= minMessages ? Math.max(0, items.length - keepRecent) : 0;
  if (compactCount <= 0) return { ok: false, message: "当前没有可压缩内容" };
  let s = Math.max(1, Math.floor(Number(start) || 1));
  let e = Math.max(s, Math.floor(Number(end) || s));
  e = Math.min(e, compactCount);
  s = Math.min(s, e);
  if (s > e) return { ok: false, message: "无效的范围" };
  const slice = items.slice(s - 1, e);
  const cuts = [];
  let lastT = null;
  for (let i = 0; i < slice.length; i++) {
    const t = msgTime(slice[i].msg);
    if (t) {
      if (lastT) {
        const deltaMin = (t - lastT) / 60000;
        if (deltaMin > gapMin) cuts.push(s - 1 + i);
      }
      lastT = t;
    }
  }
  const subRanges = [];
  let rangeStart = s - 1;
  cuts.forEach(function (c) {
    subRanges.push({ start: rangeStart, end: c - 1 });
    rangeStart = c;
  });
  subRanges.push({ start: rangeStart, end: e - 1 });
  const created = [];
  subRanges.forEach(function (r) {
    if (r.start > r.end) return;
    const res = addBlockRange(r.start, r.end);
    if (res.ok) {
      const g = items.slice(r.start, r.end + 1);
      let minT = null;
      let maxT = null;
      g.forEach(function (it) {
        const t = msgTime(it.msg);
        if (t) {
          if (minT === null || t < minT) minT = t;
          if (maxT === null || t > maxT) maxT = t;
        }
      });
      created.push({
        start: items[r.start].idx + 1,
        end: items[r.end].idx + 1,
        count: r.end - r.start + 1,
        startTime: minT ? formatTime(minT) : "",
        endTime: maxT ? formatTime(maxT) : ""
      });
    }
  });
  return { ok: true, count: created.length, blocks: created, gapMinutes: gapMin };
}

module.exports = {
  loadConfig,
  saveConfig,
  loadTimeline,
  loadPersona,
  contentToText,
  isCompressible,
  isSpecialEvent,
  isMemoryFlash,
  computeChunks,
  pickBestCut,
  addCutPoint,
  removeCutPoint,
  buildPlan,
  preview,
  rangePreview,
  splitRangeByGaps,
  getCachedSummary,
  storeSummary,
  loadCutPoints,
  saveCutPoints,
  resolveCutPointConfig,
  listCutPointConfigs,
  buildCompactionPrompt,
  generateSummary,
  generateBlockSummary,
  generateSummaryForRange,
  isEnabled,
  compactMessages,
  removeSummaries,
  restoreSummary,
  updateSummary,
  addSummaryVersion,
  removeHistoryVersion,
  loadBlocks,
  saveBlocks,
  removeBlock,
  addBlockRange,
  toggleBlock,
  getBlockGaps,
  updateBlockRange,
  loadForceReplace,
  setForceReplace,
  contentKey,
  loadMarks,
  setMark,
  getCompactionPromptForDisplay,
  saveCompactionPromptConfig,
  resetCompactionPromptConfig
};
