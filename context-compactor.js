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

const DATA_DIR = path.join(__dirname, "data");
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const CACHE_FILE = path.join(DATA_DIR, "context_compaction.json");
const OVERRIDES_FILE = path.join(DATA_DIR, "context_compaction_overrides.json");
const COMPACTION_PROMPT_FILE = path.join(DATA_DIR, "compaction_prompt.json");
const MARKS_FILE = path.join(DATA_DIR, "context_compaction_marks.json");
const FORCE_FILE = path.join(DATA_DIR, "context_compaction_force.json");
const CACHE_MAX_ENTRIES = 500;
const SUMMARY_HISTORY_MAX = 8;

const DEFAULT_CONFIG = {
  compaction_chunk_size: 100,
  compaction_chunk_min: 40,
  compaction_chunk_max: 160,
  compaction_keep_recent_messages: 150,
  compaction_min_messages: 250,
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
  if (!msg || msg.role !== "assistant") return false;
  const c = String(msg.content || "");
  return (
    c.indexOf("自动唤醒") !== -1 ||
    c.indexOf("推送") !== -1 ||
    c.indexOf("自动写了日记") !== -1 ||
    c.indexOf("记忆浮现") !== -1 ||
    c.indexOf("时间标记") !== -1 ||
    c.indexOf("摘要）") !== -1
  );
}

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

function isCompressible(msg, includeEvents) {
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return false;
  if (!includeEvents && msg.role === "assistant" && isSpecialEvent(msg)) return false;
  if (msg.tool_calls || msg.tool_call_id) return false;
  return contentToText(msg).trim().length > 0;
}

// ---------------- 时间 ----------------

function parseLeadingTime(text) {
  const m = String(text || "").match(/^（?\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return isNaN(dt.getTime()) ? null : dt;
}

function msgTime(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  return parseLeadingTime(contentToText(msg));
}

function formatTime(d) {
  if (!d) return "";
  const p = function (n) { return String(n).padStart(2, "0"); };
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes())
  );
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
  const texts = items.map(function (it) { return contentToText(it.msg); });
  const sig = crypto.createHash("sha256").update(texts.join("\u0001")).digest("hex").slice(0, 32);
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
    history: history
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
function updateSummary(signature, summary) {
  const text = String(summary || "").trim();
  if (!text) throw new Error("摘要内容不能为空");
  const cache = loadCache();
  const prev = cache[signature];
  if (!prev || !prev.summary) throw new Error("该块没有缓存摘要，请先生成摘要再编辑");
  let history = [];
  if (prev.summary) {
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
    range: prev.range || null,
    timeRange: prev.timeRange || null,
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

function loadCutPoints() {
  try {
    const data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf-8"));
    if (data && Array.isArray(data.cutPoints)) {
      return data.cutPoints.map(Number).filter(function (v) { return Number.isInteger(v) && v >= 0; });
    }
  } catch (err) { /* 无边界配置 */ }
  return [];
}

function saveCutPoints(points) {
  const list = (Array.isArray(points) ? points : [])
    .map(Number)
    .filter(function (v) { return Number.isInteger(v) && v >= 0; });
  const uniq = Array.from(new Set(list)).sort(function (a, b) { return a - b; });
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = OVERRIDES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, cutPoints: uniq }, null, 2), "utf-8");
    fs.renameSync(tmp, OVERRIDES_FILE);
  } catch (err) {
    console.error("[context-compactor] 边界保存失败:", err.message);
  }
  return uniq;
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
  const marks = loadMarks();
  // 浮现的记忆不参与摘要（它们是记忆池注入内容，不是对话本身）；整块只有记忆浮现时退回原文保底
  const usable = msgs.filter(function (m) { return !isMemoryFlash(m); });
  const targetMsgs = usable.length > 0 ? usable : msgs;
  const lines = targetMsgs.map(function (m) {
    const role = m.role === "user" ? (process.env.USER_DISPLAY_NAME || "对方") : "我";
    const body = contentToText(m);
    const think = cfg.compaction_include_thinking && m.thinking ? "\n（内心活动）" + String(m.thinking) : "";
    const line = "[" + role + "] " + body + think;
    return marks[contentKey(m)] ? "【重要·务必完整保留】" + line + "【/重要】" : line;
  });
  let conversationText = lines.join("\n\n");
  if (usable.length > 0 && usable.length !== msgs.length) {
    conversationText += "\n\n（注：本段内有 " + (msgs.length - usable.length) + " 条「记忆浮现」系统事件，属于记忆池注入内容，未纳入摘要；被摘要时它们会直接从上下文中移除。）";
  }
  if (msgs.some(function (m) { return marks[contentKey(m)]; })) {
    conversationText += "\n\n注意：对话原文中带有【重要·务必完整保留】标记的部分，是你标记过的重要内容，写摘要时必须逐条完整保留其中的关键细节、数字、约定和情绪转折，重点提炼，不能遗漏、不能简化成一句话。";
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

async function generateSummary(chunk, meta) {
  const cfg = loadConfig();
  if (!chunk.msgs || chunk.msgs.length === 0) throw new Error("块内没有可摘要的消息");
  const targetUrl = process.env.TARGET_API_URL;
  const targetKey = process.env.TARGET_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!targetUrl || !targetKey || !model) {
    throw new Error("TARGET_API_URL / TARGET_API_KEY / MODEL_NAME 未配置");
  }
  const built = buildCompactionPrompt(chunk, cfg);
  const outputBudgets = [8000, 16000];
  let lastErr = null;
  for (let attempt = 0; attempt < outputBudgets.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 180 * 1000);
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
        console.warn("[context-compactor] 块 #" + chunk.index + " " + why + "，增大输出预算重试");
        lastErr = new Error(why);
        continue;
      }
      storeSummary(chunk.signature, summary, {
        mode: (meta && meta.mode) || "manual",
        manual: !!(meta && meta.manual),
        range: { start: chunk.firstIdx + 1, end: chunk.lastIdx + 1 },
        timeRange: (chunk.startTime || "") + " ~ " + (chunk.endTime || "")
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
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error("摘要生成失败");
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

function setMark(key, marked) {
  const marks = loadMarks();
  if (marked) marks[key] = { markedAt: new Date().toISOString() };
  else delete marks[key];
  saveMarks(marks);
  return !!marked;
}

// ---------------- 转发前压缩（替换缓存摘要） ----------------

function isEnabled() {
  return loadForceReplace().length > 0;
}

function chunkSignatureOf(entries) {
  const texts = entries.map(function (e) { return contentToText(e.msg); });
  return crypto.createHash("sha256").update(texts.join("\u0001")).digest("hex").slice(0, 32);
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
        typeof m.content === "string" && !m._ccSummary) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role && !prev.tool_calls && !prev.tool_call_id &&
          typeof prev.content === "string" && !prev._ccSummary) {
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
    .trim();
  return role + "\u0000" + stripped;
}

function compactMessages(messages, opts) {
  const cfg = Object.assign(loadConfig(), (opts && opts.config) || {});
  const forceReplace = new Set(loadForceReplace());
  if (forceReplace.size === 0) return messages;
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
  if (total < minMessages && forceReplace.size === 0) return messages;
  const compactCount = Math.max(0, total - keepRecent);
  if (compactCount === 0 && forceReplace.size === 0) return messages;
  const compactEntries = tlEntries.slice(0, compactCount);

  let groups = [];
  const cutPoints = loadCutPoints().filter(function (cp) { return cp < compactCount; });
  if (cutPoints.length > 0) {
    let s = 0;
    for (const cp of cutPoints) {
      if (cp >= s) {
        groups.push(compactEntries.slice(s, cp + 1));
        s = cp + 1;
      }
    }
    // 最后一个已定块之后的内容保持原文，作为「未覆盖内容」等待用户点「添加一块」再切
  } else {
    groups = naturalGroups(compactEntries, cfg);
  }

  const cache = loadCache();
  const replacements = [];
  const srcKeys = src.map(normalizedCompareKey);
  let searchStart = 0;
  groups.forEach(function (g, gi) {
    if (!g || g.length === 0) return;
    const sig = chunkSignatureOf(g);
    const entry = cache[sig];
    const hit = !!(entry && entry.summary && forceReplace.has(sig));
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
    const si = srcKeys.indexOf(startKey, searchStart);
    if (si === -1) return;
    let ei = srcKeys.indexOf(endKey, si + 1);
    if (ei === -1) ei = srcKeys.lastIndexOf(endKey);
    if (ei === -1 || ei < si) return;
    // 块尾常跟着工具调用链（tool_calls + tool 返回），属于机械痕迹，一并纳入替换区间
    while (ei + 1 < src.length) {
      const nxt = src[ei + 1];
      if (!nxt) break;
      if (nxt.role === "tool") { ei++; continue; }
      if (nxt.role === "assistant" && nxt.tool_calls && !String(nxt.content || "").trim()) { ei++; continue; }
      break;
    }
    replacements.push({
      startIdx: si,
      endIdx: ei,
      message: buildSummaryMessage(g, entry.summary)
    });
    searchStart = ei + 1;
  });
  if (replacements.length === 0) return messages;
  replacements.sort(function (a, b) { return a.startIdx - b.startIdx; });

  const out = [];
  let r = 0;
  for (let i = 0; i < src.length; i++) {
    if (r < replacements.length && replacements[r].startIdx === i) {
      out.push(replacements[r].message);
      // 被摘要区间内：记忆浮现与工具痕迹（调用/返回）直接删除，由摘要覆盖；
      // 其余不可压缩消息（如罕见的内嵌系统消息）保留，避免永久事件被摘要吞掉
      for (let j = replacements[r].startIdx + 1; j <= replacements[r].endIdx; j++) {
        const m = src[j];
        if (!m) continue;
        if (isMemoryFlash(m)) continue; // 浮现的记忆：被摘要时段内直接删除
        if (m.role === "tool" || m.tool_calls) continue; // 工具痕迹：被摘要覆盖，删除
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
  let cutPointsActive = false;
  let uncovered = null;
  if (compactCount > 0) {
    const compactItems = items.slice(0, compactCount);
    const cutPoints = loadCutPoints().filter(function (cp) { return cp < compactCount; });
    if (cutPoints.length > 0) {
      cutPointsActive = true;
      let s = 0;
      for (const cp of cutPoints) {
        if (cp >= s) {
          chunks.push(makeChunk(compactItems.slice(s, cp + 1), 0, includeMsgs, true));
          s = cp + 1;
        }
      }
      if (s < compactCount) {
        // 最后一个已定块之后的内容保持原文，作为「未覆盖内容」展示，等待用户点「添加一块」
        const uc = makeChunk(compactItems.slice(s), 0, includeMsgs, true);
        uncovered = {
          startIdx: uc.firstIdx + 1,
          endIdx: uc.lastIdx + 1,
          count: uc.count,
          chars: uc.chars,
          startTime: uc.startTime,
          endTime: uc.endTime,
          head: uc.head,
          tail: uc.tail
        };
      }
    } else {
      chunks = computeChunks(compactItems, cfg, includeMsgs);
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
    enabled: loadForceReplace().length > 0,
    config: cfg,
    totalCompressible: total,
    compactCount: compactCount,
    keptRawCount: keptRawCount,
    cutPointsActive: cutPointsActive,
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

module.exports = {
  loadConfig,
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
  getCachedSummary,
  storeSummary,
  loadCutPoints,
  saveCutPoints,
  buildCompactionPrompt,
  generateSummary,
  isEnabled,
  compactMessages,
  removeSummaries,
  restoreSummary,
  updateSummary,
  removeHistoryVersion,
  loadForceReplace,
  setForceReplace,
  contentKey,
  loadMarks,
  setMark,
  getCompactionPromptForDisplay,
  saveCompactionPromptConfig,
  resetCompactionPromptConfig
};
