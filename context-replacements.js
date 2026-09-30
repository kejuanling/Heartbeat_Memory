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
const { AsyncLocalStorage } = require("async_hooks");
const { nowIso, resolveTimeZone, parseMsgTimestamp } = require("./time_utils");

const DATA_DIR = path.join(__dirname, "data");
const REPLACEMENTS_FILE = path.join(DATA_DIR, "context_replacements.json");
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MEMORY_POOL_CONFIG_FILE = path.join(DATA_DIR, "memory_pool_config.json");

const MAX_MEMORY_CHARS = 100000;

// ========================
// 活跃块上限（compaction_max_active_blocks，存在 data/config.json，属压缩模块配置）。
// 这里不能 require context-compactor（对方已 require 本模块，会循环依赖），直接读单键。
// 带文件 mtime 缓存，每次请求至多一次磁盘读小文件。
// ========================
let _maxActiveCache = { mtime: -1, value: 0 };
function loadMaxActiveBlocks() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    const mtime = st.mtimeMs;
    if (_maxActiveCache.mtime !== mtime) {
      const cfg = readJson(CONFIG_FILE, {});
      const v = Math.max(0, Math.floor(Number(cfg && cfg.compaction_max_active_blocks) || 0));
      _maxActiveCache = { mtime: mtime, value: v };
    }
    return _maxActiveCache.value;
  } catch (e) {
    return 0;
  }
}

// ========================
// 每次请求的替换/压缩记录（供管理台查看；含对话/共影/唤醒等所有来源）
// ========================
const REPLACE_LOG_FILE = path.join(DATA_DIR, "context_replace_log.json");
const REPLACE_LOG_CAP = 10;
const REPLACE_LOG_FLUSH_MS = 5000;
let _replaceLogCache = null;
let _replaceLogDirty = false;
let _replaceLogTimer = null;

function _ensureReplaceLog(force) {
  if (_replaceLogCache === null || force) {
    let v = readJson(REPLACE_LOG_FILE, []);
    _replaceLogCache = Array.isArray(v) ? v : [];
  }
  return _replaceLogCache;
}

// 2026-09-22 审查 R14：原实现每次 append 都同步写整份文件，而「无替换」的请求占大多数
// （applyReplacements 三个分支各调一次 logNoReplace）→ 聊天高峰期每条消息一轮同步写盘。
// 改为内存聚合 + 5s debounce 刷盘；读侧 getReplaceLog 先 flush 保证查询不失真；
// 进程退出（含 pm2 重启）时在 exit 里兜底刷一次，最多丢最后 5s 的日志（日志用途，可接受）。
function flushReplaceLog() {
  if (!_replaceLogDirty) return;
  try {
    writeJsonAtomic(REPLACE_LOG_FILE, _ensureReplaceLog());
    _replaceLogDirty = false;
  } catch (e) {
    console.warn("[context-replacements] 替换日志刷盘失败:", e.message);
  }
}

function appendReplaceLog(entry) {
  try {
    const log = _ensureReplaceLog();
    log.push(entry);
    if (log.length > REPLACE_LOG_CAP) log.splice(0, log.length - REPLACE_LOG_CAP);
    _replaceLogDirty = true;
    if (!_replaceLogTimer) {
      _replaceLogTimer = setTimeout(function () { _replaceLogTimer = null; flushReplaceLog(); }, REPLACE_LOG_FLUSH_MS);
      if (typeof _replaceLogTimer.unref === "function") _replaceLogTimer.unref();   // 不因这个定时器拖住进程退出
    }
  } catch (e) {
    console.warn("[context-replacements] 替换日志记录失败:", e.message);
  }
}

function getReplaceLog(cap) {
  // 读前先把内存里的待写条目落盘，确保查询结果与持久化记录一致
  flushReplaceLog();
  const log = _ensureReplaceLog(true);
  const n = Math.max(0, Math.min(Number(cap) > 0 ? Number(cap) : 50, log.length));
  return log.slice(log.length - n).reverse();
}

// 进程退出兜底（pm2 restart / SIGINT / SIGTERM 均会触发 exit）：把 debounce 窗口内未刷的日志落盘
try { process.on("exit", function () { try { flushReplaceLog(); } catch (e) {} }); } catch (e) {}

// ========================
// 基础工具
// ========================
// mtime 感知文件缓存：文件未变化（mtime+size 相同）时复用内存结果，避免对同一份大盘内容反复读盘
const _readJsonCache = new Map();
const READ_JSON_CACHE_MAX = 50;                     // 条数上限，防止长期运行缓存无限膨胀
// 2026-09-22 审查 R11：原实现只有条数上限、不看体积——时间线单文件可达数 MB，几十个会话全读过后
// 常驻内存轻松上百 MB（解析后的对象通常比磁盘 JSON 大 1.5–3 倍）。改为按「总字节预算」淘汰：
// 单条大文件（如 18MB 的 context_replacements.json）仍可缓存，但累积超预算即按 LRU 丢最旧的。
const READ_JSON_CACHE_BUDGET = 48 * 1024 * 1024;
let _readJsonCacheBytes = 0;
function _readJsonCacheDrop(file) {
  const ev = _readJsonCache.get(file);
  if (ev) { _readJsonCacheBytes -= (Number(ev.size) || 0); _readJsonCache.delete(file); }
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const st = fs.statSync(file);
    const ck = st.mtimeMs + ':' + st.size;
    const hit = _readJsonCache.get(file);
    if (hit && hit.ck === ck) {
      // 命中即刷新热度（删除后重插，把该条移到 Map 尾部当作最近使用），用于后续 LRU 淘汰
      _readJsonCache.delete(file);
      _readJsonCache.set(file, hit);
      return hit.data;
    }
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (hit) _readJsonCacheDrop(file);   // 同文件旧版本先摘掉，避免字节计数重复累加
    _readJsonCache.set(file, { ck: ck, data: data, size: st.size });
    _readJsonCacheBytes += st.size;
    // 超限淘汰：条数超上限 或 总字节超预算 → 删 Map 头部（最久未使用）；至少保留当前这一条
    while ((_readJsonCache.size > READ_JSON_CACHE_MAX || _readJsonCacheBytes > READ_JSON_CACHE_BUDGET) && _readJsonCache.size > 1) {
      const oldest = _readJsonCache.keys().next().value;
      if (oldest === undefined) break;
      _readJsonCacheDrop(oldest);
    }
    return data;
  } catch (err) {
    console.warn("[context-replacements] 读取失败:", file, err.message);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  _readJsonCache.delete(file);
}

// 2026-09-13 轻量缓解（用户拍板）：备份节流——14.5MB 存档每次写都全量 copyFileSync 会卡
// 事件循环；同文件 10 分钟内已备份过则跳过（原子写保证半截文件不会落盘，备份防的是内容
// 写错而非写坏，10 分钟数据窗口可接受；.bak-* 轮转仍保留最近 2 份）。
const _backupLastAt = new Map();
const BACKUP_THROTTLE_MS = 10 * 60 * 1000;
function backupFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    const lastAt = _backupLastAt.get(file) || 0;
    if (Date.now() - lastAt < BACKUP_THROTTLE_MS) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, file + ".bak-" + ts);
    _backupLastAt.set(file, Date.now());
    // 轮转：同一基础文件的 .bak-* 仅保留最近 2 份，避免每次保存全量备份导致 data/ 无限膨胀
    try {
      const dir = path.dirname(file);
      const prefix = path.basename(file) + ".bak-";
      const keep = 2;
      const matches = fs.readdirSync(dir).filter(function (n) { return n.startsWith(prefix); }).sort().reverse();
      matches.slice(keep).forEach(function (n) { try { fs.unlinkSync(path.join(dir, n)); } catch (e) {} });
    } catch (e) {}
  } catch (err) {
    console.warn("[context-replacements] 备份失败:", err.message);
  }
}

// nowIso 已统一到 time_utils 模块（原先本模块与 memory-pool 各有一份相同实现）
const TIME_ZONE = resolveTimeZone();

// 判断消息是否为「替换」生成的占位消息（压缩/唤醒等环节需保护，避免被吞掉）
// 与 routes/chat-context.js isSummaryPlaceholder、server.js token 估算跳过三处同口径，改一处必须同步其余
function isReplacementMemoryMessage(msg) {
  // 2026-09-28 压缩块改为 developer 段后，这里同步放行 developer（assistant 历史格式仍兼容）
  if (!msg || (msg.role !== "assistant" && msg.role !== "developer")) return false;
  const c = String(msg.content || "");
  return c.startsWith("## Historical Summary") || c.startsWith("（回忆 · ") || c.startsWith("（对话摘要");
}

// 解析消息时间（2026-09-30 V4 收敛）：本地两级链已删，统一引 time_utils 标准链。
// 行为增强=修复不一致：原版缺 <current_time> 标签与末尾时间缀分支，同一消息在这里与
// 压缩器（context-compactor）解析出不同时间，压缩块 range_label 与压缩页预览对不上。
const messageTime = parseMsgTimestamp;

// 解析时间范围边界的 parseRangeBound 已删（2026-09-19 统一消息 id 锚点，时间定位入口全清）

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
  const structuredStart = /^（\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|刚刚|自动唤醒|醒来写了日记|自动写了日记|记忆浮现|时间标记|摘要|共影|截图|记忆碎片|容量提醒)/.test(c);
  if (!structuredStart) return false;
  return (
    c.indexOf("刚刚给宝宝发了 Bark") !== -1 ||
    /刚刚给[^：]*发了 Bark/.test(c) ||
    c.indexOf("自动唤醒：本次未发送 Bark") !== -1 ||
    c.indexOf("自动唤醒：本次未发送推送") !== -1 ||
    (/刚刚给[^：]*发了/.test(c) && c.indexOf("推送") !== -1) ||
    (/刚刚给宝宝发了/.test(c) && c.indexOf("推送") !== -1) ||
    c.indexOf("醒来写了日记") !== -1 ||
    c.indexOf("自动写了日记") !== -1 ||
    c.indexOf("记忆浮现）") !== -1 ||
    c.indexOf("时间标记") !== -1 ||
    c.indexOf("摘要）") !== -1 ||
    c.indexOf("共影）") !== -1 ||
    c.indexOf("截图）") !== -1 ||
    c.indexOf("截图唤醒）") !== -1 ||
    c.indexOf("记忆碎片") !== -1 ||
    c.indexOf("（容量提醒）") !== -1
  );
}

function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return isSpecialEvent(msg) && String(msg.content || "").indexOf("记忆浮现") !== -1;
}

// 日记特殊事件：AI 唤醒/后台自主时写的日记，永远不参与压缩，单独保留在上下文
// 事件名 2026-09-12 起「醒来写了日记」，旧数据兼容「自动写了日记」。
// 2026-09-21 补：唤醒 v2 落库改为 {kind:"diary", content:"[DIARY]（…醒来写了日记：…）"}——
// [DIARY] 前缀导致 isSpecialEvent 的 structuredStart（要求以「（」开头）认不出，
// 日记被当普通对话放行进压缩索引（实测 87 条里 77 条被收录）。此处改为不依赖
// isSpecialEvent 独立判定：认 kind 字段 / [DIARY] 前缀 / 旧格式文本三种形态。
// 注意 isSpecialEvent 本身刻意不动：日记当前以普通 assistant 消息内联进上下文，
// 若升格为特殊事件而注入机制不认回，日记会整段从上下文消失。
// 2026-09-29：真日记判定——只保护「AI 实际写的日记内容」（assistant 的 kind=diary / [DIARY] 前缀 /
// 「醒来写了日记/自动写了日记」事件）。developer 的写日记通知提示（[小世界] 涵写了日记（时间），无正文）
// 不算真日记：默认参与压缩，该压就压，避免在上下文里无限堆积。
function isRealDiary(msg) {
  if (!msg || msg.role !== "assistant") return false;
  if (msg.kind === "diary") return true;
  const c = String(msg.content || "");
  if (/^\s*\[DIARY\]/.test(c)) return true;
  return isSpecialEvent(msg) && (c.indexOf("醒来写了日记") !== -1 || c.indexOf("自动写了日记") !== -1);
}

function isDiaryEvent(msg) {
  if (!msg) return false;
  if (msg.kind === "diary") return true;
  if (msg.role !== "assistant") return false;
  const c = String(msg.content || "");
  if (!c) return false;
  if (/^\s*\[DIARY\]/.test(c)) return true;
  return isSpecialEvent(msg) && (c.indexOf("醒来写了日记") !== -1 || c.indexOf("自动写了日记") !== -1);
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
  if (c.indexOf("醒来写了日记") !== -1 || c.indexOf("自动写了日记") !== -1) out.push("diary");
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
  // 2026-09-22 审查 R10：缓存键的 stat 必须用「当前活跃会话」自己的时间线文件，
  // 而不是主会话 default 的 enhanced_messages.json。缓存值 collectInjectionVisibleEvents(loadTimeline())
  // 是按 effectiveSession() 加载的当前会话时间线算的，键与值的失效源必须一致。
  const sid = effectiveSession();
  let timelineFile = TIMELINE_FILE;
  if (sid && sid !== "default") {
    const token = require("./lib/session-token").safeSessionToken(sid);
    timelineFile = path.join(__dirname, "enhanced_messages_" + token + ".json");
  }
  let stat;
  try { stat = fs.statSync(timelineFile); } catch (e) { stat = { mtimeMs: 0, size: 0 }; }
  const sidSafe = String(sid || "").replace(/[^A-Za-z0-9_-]/g, "");
  const ck = sidSafe + ":" + JSON.stringify(cfg) + ":" + stat.mtimeMs + ":" + stat.size;
  if (_eventVisCache && _eventVisCache.ck === ck) return _eventVisCache.keys;
  const keys = collectInjectionVisibleEvents(loadTimeline());
  _eventVisCache = { ck: ck, keys: keys };
  return keys;
}

// 该消息是否属于「真实请求会注入」的特殊事件；非特殊事件恒返回 true
function isEventInjectionVisible(msg) {
  if (!isSpecialEvent(msg)) return true;
  // 容量提醒恒视为可见（可被压缩块覆盖）：visibleKeys 基于主会话计算，多会话下会对不上
  if (msg && msg.kind === "ctx_limit") return true;
  return eventInjectionVisibleKeys().has(eventKey(msg));
}

function isCompressible(msg, includeEvents) {
  if (!msg) return false;
  // 2026-09-28 用户拍板：developer 默认参与压缩（判定记录/日记通知/唤醒提示该压就压），
  // 只排除顶部系统注入块与保护类消息；system（人设）仍不压缩。
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "developer") return false;
  // 顶部系统注入块排除：
  if (role === "system") return false;                    // 人设（最顶，永不压缩）
  if (isReplacementMemoryMessage(msg)) return false;      // 压缩块替身（防自压缩）
  if (typeof msg.content === "string") {
    const t = String(msg.content).trim();
    // V2 注入块（## 英文名：Context Assembly / System Instructions / Core Identity / …）
    // 请求时注入不落盘，此处兜底防未来落盘；V1 旧块 [永久上下文]/[跨窗口] 同兜底（V2 已剔除）。
    if (t.startsWith("## ")) return false;
    if (t.startsWith("[永久上下文]") || t.startsWith("[跨窗口]")) return false;
  }
  // 2026-09-13 审查修复：软删除消息不进压缩索引——此前已删除的容量提醒仍占编号、
  // 计入容量估算，且原文被发给摘要模型导致摘要串味（compactor/findContentByKey 等处均已过滤）
  if (msg.deleted) return false;
  if (isRealDiary(msg)) return false; // 真日记永远不压缩（developer 写日记通知提示可压缩，0929）
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
    .replace(/<star\b[^>]*>(?:\s*<\/star\s*>)?/gi, "")
    .replace(/<\s*paper\b[^>]*>(?:[\s\S]*?<\s*\/paper\s*>)?/gi, "")
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

// 2026-09-13 并发约束（实测核实）：本文件所有「loadItems → 改 → saveItems」调用链必须保持
// 纯同步——同步段在事件循环内原子，天然无并发丢块；若未来任何链路中间夹了 await，
// 必须先引入写链（参照 server.js envWriteChain 的 promise 串行化）再动手，否则会产生
// 「后写者整份覆盖前写者」的丢失更新。
function saveItems(items) {
  backupFile(REPLACEMENTS_FILE);
  writeJsonAtomic(REPLACEMENTS_FILE, items);
}

// 取条目的替换正文（text/memory 双字段历史并存，同值读写，兼容旧数据）
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
    enabled: item.enabled !== false,
    hidden: item.hidden === true
  };
}

// listReplacements（loadItems→publicItem 的列表包装）已于 2026-09-28 删除：全仓零调用，server 直接组合两者

// ========================
// 时间线
// ========================
// 多会话：按 sessionId 读对应时间线文件；缺省走主会话（enhanced_messages.json）。
// 另支持"活跃会话"上下文：server.js 在请求入口 setActiveSession/清空，让所有内部 loadTimeline() 自动用对会话。
// 多会话并发安全：改用 AsyncLocalStorage 把"活跃会话"绑定到该请求自己的异步上下文，
// 而不是进程级单例 —— 不同会话的请求跨 await 交错时，各自读到自己的会话，避免跨会话串扰。
const _activeSessionAls = new AsyncLocalStorage();
function setActiveSession(sid) { _activeSessionAls.enterWith(sid || null); }
function getActiveSession() { return _activeSessionAls.getStore() || null; }
function activeSessionOr(sessionId) { return (sessionId !== undefined && sessionId !== null) ? sessionId : getActiveSession(); }

// MCP 工具回调的会话兜底：AI 在聊天中调 context_replace 时，工具服务器(8771)回调 /internal/apply
// 是独立请求，ALS 已丢（此前会错落到 default 会话/主会话时间线）。
// 聊天侧进入工具循环前 noteMcpChatSession(sessionId) 登记，回调 90 秒内用它兜底。
// 已知局限（单例残余面）：多设备并发各自进入工具循环时后登记者覆盖前者，先发起的回调可能拿到错误会话；
// 单用户场景概率极低，彻底修复需回调请求携带会话标识（改工具服务器协议），暂不展开。
let _mcpChatSession = null;
let _mcpChatAt = 0;
function noteMcpChatSession(sid) { _mcpChatSession = sid || null; _mcpChatAt = Date.now(); }
function recentMcpChatSession(maxAgeMs) {
  return (Date.now() - _mcpChatAt <= (maxAgeMs || 90000)) ? _mcpChatSession : null;
}
function effectiveSession(sessionId) { return activeSessionOr(sessionId) || recentMcpChatSession(); }

function loadTimeline(sessionId) {
  const sid = effectiveSession(sessionId);
  if (sid && sid !== "default") {
    // 2026-09-21 审查 R20：token 计算收敛到 lib/session-token.js（与 server.js / diary.js 同一实现）。
    // 原本地副本注释自称"与 safeSessionToken 完全同口径"，实际是第四份手抄，改一处漏三处。
    const token = require("./lib/session-token").safeSessionToken(sid);
    return readJson(path.join(__dirname, "enhanced_messages_" + token + ".json"), []);
  }
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
// 范围解析：只认「消息 id」（2026-09-19 统一锚点：时间/编号定位已删——编号随时间线增删漂移、
// 时间撞车，只有消息自带 id 全库唯一不漂移）。start_id/end_id 来自 context_search 返回的 msg_id。
// ========================
function resolveRange(range) {
  const timeline = nonSystemMessages(loadTimeline());
  const rng = range || {};
  const startId = rng.start_id !== undefined && rng.start_id !== null ? String(rng.start_id).trim() : "";
  const endId = rng.end_id !== undefined && rng.end_id !== null ? String(rng.end_id).trim() : "";
  if (!startId || !endId) {
    return { ok: false, error: "需要提供消息 id（start_id/end_id）：先用 context_search 检索原文，取首尾两条的 msg_id" };
  }
  const idPos = new Map();
  for (let i = 0; i < timeline.length; i++) {
    const id = timeline[i] && timeline[i].id ? String(timeline[i].id) : null;
    if (id && !idPos.has(id)) idPos.set(id, i);
  }
  const s = idPos.get(startId);
  const e = idPos.get(endId);
  if (s === undefined || e === undefined) {
    return { ok: false, error: "消息 id 在当前会话时间线中不存在（可能换了会话或窗口）" };
  }
  if (s > e) {
    return { ok: false, error: "start_id 在时间线中的位置晚于 end_id，请调换" };
  }
  const matched = timeline.slice(s, e + 1);
  return {
    ok: true,
    matched: matched,
    count: matched.length,
    range_label: rangeLabelOf(matched.map(function (m) { return { msg: m }; })),
    start_index: s,
    end_index: e
  };
}

// ========================
// 新增替换（AI 工具）
// ========================
// AI 替换区间保护：不许覆盖最近 N 条近期对话（防 AI 把近期细节压成摘要伤连贯）。
// 读 data/config.json 的 compaction_protect_recent_messages（0=不保护），默认 40。
function loadProtectRecentMessages() {
  try {
    const cfg = readJson(CONFIG_FILE, {});
    const v = Number(cfg && cfg.compaction_protect_recent_messages);
    return isFinite(v) ? Math.max(0, Math.floor(v)) : 40;
  } catch (e) {
    return 40;
  }
}

function addReplacement(options) {
  const text = String((options && (options.text || options.memory)) || "").trim();
  if (!text) return { ok: false, error: "替换正文不能为空" };
  if (text.length > MAX_MEMORY_CHARS) {
    return { ok: false, error: "替换正文太长（" + text.length + " 字，上限 " + MAX_MEMORY_CHARS + "）" };
  }
  const resolved = resolveRange(options && options.range);
  if (!resolved.ok) return resolved;

  // 保护最近 N 条：区间末端进入保护区就拒绝，AI 需选更早的时间段
  const protectN = loadProtectRecentMessages();
  if (protectN > 0) {
    const total = nonSystemMessages(loadTimeline()).length;
    if (resolved.end_index >= total - protectN) {
      return {
        ok: false,
        error: "该范围覆盖到了最近 " + protectN + " 条消息（近期对话受保护，不参与压缩）。请把 end_id 换成更早的消息 id。"
      };
    }
  }

  const item = {
    id: "ctxrep_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
    created_at: nowIso(),
    source: "ai",
    session: effectiveSession() || "default",   // 多会话：记录归属当前会话（ALS / MCP 工具回调兜底），只在该会话内套用
    text: text,
    memory: text,
    range: (options && options.range) || {},
    range_label: resolved.range_label,
    matched: resolved.matched.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
      id: m && m.id ? String(m.id) : undefined
    })),
    count: resolved.count,
    removed: false
  };

  const items = loadItems();
  // 跨会话摘要复用：内容序列与任一已有块完全一致（特殊事件不计入，对齐 makeChunk 签名口径）时，
  // 复用其摘要正文，避免对相同内容重复压缩。新块仍打本会话标签，只在各自会话内套用（不跨会话串扰）。
  const shareSig = matchedShareSig(item.matched);
  if (shareSig) {
    const shared = items.find(function (it) {
      return !it.removed && it.enabled !== false &&
        typeof it.text === "string" && it.text.trim() &&
        it.source === item.source &&
        matchedShareSig(it.matched) === shareSig;
    });
    if (shared && shared.text && shared.text !== item.text) {
      item.text = shared.text;
      console.log("[context-replacements] 跨会话复用摘要：", item.range_label, "<-", shared.id, shared.session);
    }
  }
  items.push(item);
  saveItems(items);
  console.log("[context-replacements] 新增替换（AI）：session=" + item.session, item.range_label, "->", text.slice(0, 40).replace(/\n/g, " "), "...");

  return { ok: true, id: item.id, session: item.session, count: item.count, range_label: item.range_label, message: "已记录替换：" + item.count + " 条消息 → 替换正文" };
}

// 会话合并时复制压缩块到目标会话。目标时间线里的消息 id 与源会话不同，复制后先做一次
// 「内容认亲」：按内容顺序在目标时间线里逐条回找 matched，命中率达 90% 才把 matched 重锚到
// 目标消息 id（含 range 首尾 id）；达不到阈值保留原 matched（后续定位走内容匹配兜底 + 防错闸）。
// 认亲是唯一合法的跨会话内容匹配场景，认完即落回 id 通路。
// 多个源会话存在内容序列完全一致的块时合并为一个（matchedShareSig，与跨会话摘要复用的签名口径一致）。
// 复制语义：源会话的块保留（源会话继续显示摘要），同时复制一份归属到目标会话。
function migrateSessionBlocks(sourceIds, targetId) {
  const src = new Set(Array.isArray(sourceIds) ? sourceIds : []);
  if (src.size === 0 || !targetId) return { migrated: 0, skippedDup: 0, skippedNoMatch: 0 };
  const items = loadItems();
  const out = items.slice();
  const seenSig = new Set();
  let migrated = 0, skippedDup = 0, skippedNoMatch = 0;
  // 目标会话可锚定序列（普通 user/assistant 对话，与分支继承的 real 口径一致）
  const targetTl = loadTimeline(targetId) || [];
  const anchorSeq = [];
  (Array.isArray(targetTl) ? targetTl : []).forEach(function (m) {
    if (!m || m.role === "system") return;
    if (m.tool_calls) return;
    if (isSpecialEvent(m)) return;
    const text = contentToText(m);
    if (m.role === "user" && String(text).trim().startsWith("<system>")) return;
    if (m.role !== "user" && m.role !== "assistant") return;
    anchorSeq.push(m);
  });
  const anchorKeys = anchorSeq.map(function (m) { return normalizedCompareKey(m); });
  items.forEach(function (it) {
    if (!it || it.removed) return;
    if (!it.session || !src.has(it.session)) return;
    const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : [];
    if (matched.length === 0) { skippedNoMatch++; return; }
    const sig = matchedShareSig(matched);
    if (sig) {
      if (seenSig.has(sig)) { skippedDup++; return; }
      seenSig.add(sig);
    }
    // 内容认亲 + 重锚：顺序游标逐条回找，命中不足 90% 则放弃重锚（保留原 matched）
    let cursor = 0, hits = 0, attempts = 0;
    const reanchored = matched.map(function (m) {
      if (!m || isSpecialEvent(m)) return m;
      attempts++;
      const k = normalizedCompareKey(m);
      let p = -1;
      for (let q = cursor; q < anchorKeys.length; q++) {
        if (anchorKeys[q] === k) { p = q; break; }
      }
      if (p < 0) return Object.assign({}, m, { id: undefined });
      cursor = p + 1;
      hits++;
      const nid = anchorSeq[p] && anchorSeq[p].id != null && anchorSeq[p].id !== "" ? String(anchorSeq[p].id) : undefined;
      return Object.assign({}, m, { id: nid });
    });
    const copy = Object.assign({}, it, {
      session: targetId,
      id: "ctxrep_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      created_at: nowIso()
    });
    if (attempts > 0 && hits / attempts >= 0.9) {
      copy.matched = reanchored;
      // 源会话的存储编号在目标时间线无效，清掉走 id/内容定位；range 首尾换成重锚后的 id
      const r = Object.assign({}, copy.range || {});
      delete r.start_index;
      delete r.end_index;
      for (let i = 0; i < reanchored.length; i++) {
        if (reanchored[i] && !isSpecialEvent(reanchored[i]) && reanchored[i].id) { r.start_id = reanchored[i].id; break; }
      }
      for (let i = reanchored.length - 1; i >= 0; i--) {
        if (reanchored[i] && !isSpecialEvent(reanchored[i]) && reanchored[i].id) { r.end_id = reanchored[i].id; break; }
      }
      copy.range = r;
    }
    out.push(copy);
    migrated++;
  });
  saveItems(out);
  console.log("[context-replacements] 会话合并复制压缩块: " + sourceIds.length + " 源会话 -> " + targetId +
    " 复制=" + migrated + " 去重=" + skippedDup + " 无匹配=" + skippedNoMatch);
  return { migrated: migrated, skippedDup: skippedDup, skippedNoMatch: skippedNoMatch };
}

// 会话分支时继承压缩块：把源会话中「完全落在分支点之前」的块复制到新会话。
// 判定：块 matched 最后一条非特殊事件消息在源会话「真实消息」序列里的位置 ≤ 分支点位置。
// 索引空间与前端 msgs 一致（/v1/history 的 isRealMessageForTimeline 口径：排除 system/tool/特殊事件），
// 分支点用前端传入的 msgs 下标 branchIndex 直接定位，块用内容锚点定位。
// 跨边界块不继承（摘要不完整）。源会话块保留（复制语义），新块打新会话标签，只在新会话内套用。
function inheritSessionBlocks(srcSession, newSession, branchIndex, anchorId) {
  if (!srcSession || !newSession || !Number.isInteger(branchIndex) || branchIndex < 0) {
    return { inherited: 0, skippedNoMatch: 0, skippedCross: 0 };
  }
  const items = loadItems();
  const out = items.slice();
  const timeline = loadTimeline(srcSession);
  const real = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (!m || m.role === "system") return;
    if (m.tool_calls) return;
    if (isSpecialEvent(m)) return;
    const text = contentToText(m);
    if (m.role === "user" && String(text).trim().startsWith("<system>")) return;
    if (m.role !== "user" && m.role !== "assistant") return;
    real.push({ msg: m, arrIdx: i });
  });
  // 优先用分支点消息 id 反查真实位置：前端 msgs 与服务端 real 下标空间可能不一致
  //（前端本地新消息/服务端多写消息都会让下标错位），id 反查避免 over/under-inherit；无 id 或未命中回退前端下标。
  let branchPos = branchIndex;
  if (anchorId) {
    const byId = real.findIndex(function(e) { return e.msg && e.msg.id === anchorId; });
    if (byId >= 0) branchPos = byId;
  }
  if (branchPos >= real.length) {
    return { inherited: 0, skippedNoMatch: 0, skippedCross: 0, error: "分支点下标超出源会话消息数" };
  }
  const keyToPos = new Map();
  real.forEach(function (e, p) {
    const k = normalizedCompareKey(e.msg);
    if (!keyToPos.has(k)) keyToPos.set(k, p);
  });
  // id 反查表：分支时间线与源会话同源，消息 id 原样保留。块末条位置优先按 id 反查（唯一不撞键），
  // 「哥哥」这类高频短语按内容首现会低估末条位置，把跨边界块误判成"分支点之前"而过度继承。
  const idToPos = new Map();
  real.forEach(function (e, p) {
    if (e.msg && e.msg.id != null && e.msg.id !== "") idToPos.set(String(e.msg.id), p);
  });
  let inherited = 0, skippedNoMatch = 0, skippedCross = 0;
  items.forEach(function (it) {
    if (!it || it.removed) return;
    if (it.session !== srcSession) return;
    const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : [];
    if (matched.length === 0) { skippedNoMatch++; return; }
    let lastPos = -1;
    for (let i = matched.length - 1; i >= 0; i--) {
      if (isSpecialEvent(matched[i])) continue;
      const mi = matched[i];
      const pi = (mi && mi.id != null && mi.id !== "") ? idToPos.get(String(mi.id)) : undefined;
      if (pi !== undefined) { lastPos = pi; break; }
      const p = keyToPos.get(normalizedCompareKey(mi));
      if (p !== undefined) { lastPos = p; break; }
    }
    if (lastPos < 0) { skippedNoMatch++; return; }
    if (lastPos > branchPos) { skippedCross++; return; }
    out.push(Object.assign({}, it, {
      session: newSession,
      id: "ctxrep_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      created_at: nowIso()
    }));
    inherited++;
  });
  saveItems(out);
  console.log("[context-replacements] 会话分支继承压缩块: " + srcSession + " -> " + newSession +
    " 继承=" + inherited + " 无匹配=" + skippedNoMatch + " 跨边界=" + skippedCross);
  return { inherited: inherited, skippedNoMatch: skippedNoMatch, skippedCross: skippedCross };
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

function manualStart(it, compItems) {
  const r = recordCompRange(it, compItems);
  return r ? r.start : Number.MAX_SAFE_INTEGER;
}

function manualRecordsSorted() {
  // 多会话：手工块序号空间（blockIndex）按会话隔离，与 applyReplacements 套用口径一致
  //（无 session 字段的旧块视为通用，各会话均可见可操作）。不过滤时其他会话的块会占据
  // 全局序号，导致 blocks 路由按 blockIndex 错位命中别的会话的块。
  const cur = activeSessionOr() || "default";
  const compItems = compressibleItems(); // 只算一次：排序比较里复用，避免每次比较重载时间线
  return loadItems()
    .filter(it => it.source === "manual" && !it.removed)
    .filter(it => !it.session || it.session === cur)
    .sort((a, b) => manualStart(a, compItems) - manualStart(b, compItems));
}

function manualRecordAt(index) {
  const list = manualRecordsSorted();
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  return { record: list[index], index: index };
}

// 按记录 id 取当前会话可见的手工块：id 全局唯一，操作不再依赖易变的列表序号
// （预览到点击之间块增删/吞并会让序号错位）。与 manualRecordsSorted 同口径过滤，
// 跨会话的 id 传进来也命中不了，防止误删别会话的块。
function manualRecordById(id) {
  const key = String(id == null ? "" : id);
  if (!key) return null;
  const cur = activeSessionOr() || "default";
  const rec = loadItems().find(it => it && it.source === "manual" && !it.removed && it.id === key && (!it.session || it.session === cur));
  return rec ? { record: rec } : null;
}

// 按 compressible 序号区间构造 range 字段（range/range_label/matched/count）——2026-09-22 审查 R13：
// 此前 buildManualRecord 与 updateAiRecordRange 各写一份逐字相同的「slice → 首尾 id 锚点」构造
// （后者还缩进错位、错误文案不同），已开始漂移。收敛到此单一实现，三处共用。
function buildRangeFields(items, start, end) {
  if (start < 0 || end < start) return { ok: false, message: "无效的范围" };
  if (start >= items.length) return { ok: false, message: "起始编号超出当前消息总数" };
  const ee = Math.min(end, items.length - 1);
  const slice = items.slice(start, ee + 1);
  if (slice.length === 0) return { ok: false, message: "范围内没有可压缩消息" };
  // 锚点=消息 id（2026-09-19 统一）：存储 range 只存首尾消息 id，定位一律由 matched[].id 解析
  const startId = slice[0].msg && slice[0].msg.id ? String(slice[0].msg.id) : "";
  const endId = slice[slice.length - 1].msg && slice[slice.length - 1].msg.id ? String(slice[slice.length - 1].msg.id) : "";
  if (!startId || !endId) return { ok: false, message: "该区间消息缺少 id 字段，无法锚定（需要消息自带 id）" };
  return {
    ok: true,
    range: { start_id: startId, end_id: endId },
    range_label: rangeLabelOf(slice),
    matched: slice.map(function (e) {
      return {
        role: e.msg.role,
        content: typeof e.msg.content === "string" ? e.msg.content : contentToText(e.msg),
        id: e.msg && e.msg.id ? String(e.msg.id) : undefined
      };
    }),
    count: slice.length,
    startIndex: start,
    endIndex: ee,
    slice: slice
  };
}

function buildManualRecord(start, end, enabled) {
  const items = compressibleItems();
  const built = buildRangeFields(items, start, end);
  if (!built.ok) return built;
  return {
    ok: true,
    record: {
      id: "ctxrep_manual_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      created_at: nowIso(),
      source: "manual",
      session: activeSessionOr() || "default",   // 多会话：记录归属当前会话，只在该会话内套用
      text: "",
      memory: "",
      range: built.range,
      range_label: built.range_label,
      matched: built.matched,
      count: built.count,
      enabled: enabled === true,
      removed: false
    },
    startIndex: built.startIndex,
    endIndex: built.endIndex,
    slice: built.slice
  };
}

// 新增手工块（吞并重叠的旧手工块；默认 enabled=false，点「替换」才生效）
function addManualRecord(start, end, enabled) {
  const built = buildManualRecord(start, end, enabled);
  if (!built.ok) return built;
  const items = loadItems();
  const filtered = [];
  let removedCount = 0;
  const compItems = compressibleItems();
  for (const it of items) {
    // 只吞并同会话（或无 session 的通用旧块）的重叠手工块，跨会话块序号互不重叠、不能误吞
    if (it.source === "manual" && (!it.session || it.session === built.record.session)) {
      // 吞并判定用「当前真实覆盖区间」而非存储 range：时间线增删后旧块的存储编号会漂移，
      // 按过期存储编号判断会误吞内容已移动到别处的块，导致被顶块的内容退回未覆盖区（边界被顶）。
      const cur = recordCompRange(it, compItems);
      if (cur && cur.start <= built.endIndex && cur.end >= built.startIndex) {
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
  return removeManualRecordById(found.record.id);
}

function removeManualRecordById(id) {
  const found = manualRecordById(id);
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
  return toggleManualRecordById(found.record.id, enabled);
}

function toggleManualRecordById(id, enabled) {
  const found = manualRecordById(id);
  if (!found) return { ok: false, message: "块不存在" };
  const items = loadItems();
  const it = items.find(x => x.id === found.record.id);
  if (!it) return { ok: false, message: "块不存在" };
  it.enabled = enabled !== false;
  saveItems(items);
  return { ok: true, record: publicItem(it) };
}

// 手动隐藏手工块（入池后归档）：hidden=true 时该块的摘要与区间原文都不再注入上下文（标星原句保留）
function setManualRecordHidden(index, hidden) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  return setManualRecordHiddenById(found.record.id, hidden);
}

function setManualRecordHiddenById(id, hidden) {
  const found = manualRecordById(id);
  if (!found) return { ok: false, message: "块不存在" };
  const items = loadItems();
  const it = items.find(x => x.id === found.record.id);
  if (!it) return { ok: false, message: "块不存在" };
  it.hidden = hidden === true;
  saveItems(items);
  return { ok: true, record: publicItem(it) };
}

function updateManualRecordRange(index, start, end) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  return updateManualRecordRangeById(found.record.id, start, end);
}

function updateManualRecordRangeById(id, start, end) {
  const found = manualRecordById(id);
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
    // 只吞并同会话（或无 session 的通用旧块）的块，跨会话块定位撞上也不能误吞（与 addManualRecord 同口径）
    if (it.session && it.session !== cur.session) continue;
    const r = recordCompRange(it, compItems);
    if (!r) continue;
    if (r.start <= mergedEnd && r.end >= mergedStart) {
      absorbed.push({ it: it, r: r });
      if (r.end > mergedEnd) mergedEnd = r.end;
      if (r.start < mergedStart) mergedStart = r.start;
    }
  }
  const built = buildRangeFields(compItems, mergedStart, mergedEnd);
  if (!built.ok) return built;
  // 摘要拼接：当前块 + 被吸收块（按原文位置顺序）
  absorbed.sort(function (a, b) { return a.r.start - b.r.start; });
  const parts = [recordText(cur)].concat(absorbed.map(function (a) { return recordText(a.it); })).filter(Boolean);
  const mergedText = parts.join("\n\n");
  cur.range = built.range;
  cur.range_label = built.range_label;
  cur.matched = built.matched;
  cur.count = built.count;
  cur.enabled = cur.enabled !== false;
  if (mergedText) { cur.text = mergedText; cur.memory = mergedText; }
  cur.updated_at = nowIso();
  const filtered = items.filter(function (it) { return !absorbed.some(function (a) { return a.it.id === it.id; }); });
  saveItems(filtered);
  return { ok: true, record: publicItem(cur), removedCount: absorbed.length, merged: absorbed.map(function (a) { return a.it.id; }) };
}


// AI 块：按消息 id 范围更新覆盖区间（前端管理台用，编号入参由路由层换算）。
// 保留 source=ai；只改自身，不吞并其他块。
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
    // 只吞并同会话（或无 session 的通用旧块）的块，跨会话块定位撞上也不能误吞（与 addManualRecord 同口径）
    if (it.session && it.session !== rec.session) continue;
    const r = recordCompRange(it, items);
    if (!r) continue;
    if (r.start <= mergedEnd && r.end >= mergedStart) {
      absorbed.push({ it: it, r: r });
      if (r.end > mergedEnd) mergedEnd = r.end;
      if (r.start < mergedStart) mergedStart = r.start;
    }
  }
  // 2026-09-22 审查 R13：与手工块共用 buildRangeFields 单一实现（原为逐字重复的第二份，
  // 且此处额外保留了「至少 1 条」与 id 锚点校验，语义与 helper 完全一致）
  const built = buildRangeFields(items, mergedStart, mergedEnd);
  if (!built.ok) return built;
  rec.range = built.range;
  rec.range_label = built.range_label;
  rec.matched = built.matched;
  rec.count = built.count;
  // 摘要拼接：当前块 + 被吸收块（按原文位置顺序）
  absorbed.sort(function (a, b) { return a.r.start - b.r.start; });
  const parts = [recordText(rec)].concat(absorbed.map(function (a) { return recordText(a.it); })).filter(Boolean);
  const mergedText = parts.join("\n\n");
  if (mergedText) { rec.text = mergedText; rec.memory = mergedText; }
  rec.updated_at = nowIso();
  const filtered = list.filter(function (it) { return !absorbed.some(function (a) { return a.it.id === it.id; }); });
  saveItems(filtered);
  return { ok: true, count: built.count, record: publicItem(rec), removedCount: absorbed.length, merged: absorbed.map(function (a) { return a.it.id; }) };
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
      // 只吞并同会话（或无 session 的通用旧块）的重叠手工块，与 addManualRecord 同口径：
      // 跨会话块序号空间互相独立，重叠很正常，不加过滤会把其他会话的块整批误删
      if (it.source === "manual" && (!it.session || it.session === built.record.session)) {
        // 吞并判定用「当前真实覆盖区间」（id 解析）而非存储 range：与 addManualRecord 同口径
        const cur = recordCompRange(it, items);
        if (cur && cur.start <= seg.end && cur.end >= seg.start) {
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

// 给手工记录写入/更新替换正文（摘要生成后调用；markPending=true 时置 enabled=false 回到待替换）
function setManualRecordText(index, text, markPending) {
  const found = manualRecordAt(index);
  if (!found) return { ok: false, message: "块不存在" };
  return setManualRecordTextById(found.record.id, text, markPending);
}

function setManualRecordTextById(id, text, markPending) {
  const found = manualRecordById(id);
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
  if (markPending === true) it.enabled = false; // 手写保存：新摘要待确认，需手动替换
  saveItems(items);
  return { ok: true, length: t.length, record: publicItem(it) };
}

// 批量导入摘要（2026-09-27 压缩页「批量导入」：按记录 id 定位 manual/AI 通用；
// 旧正文自动归档历史，正文覆盖写，置 enabled=false 回到「待替换/已停用」需手动替换）
function importSummariesByItems(items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: "导入列表为空" };
  const list = loadItems();
  const results = [];
  items.forEach(function (it) {
    const id = String(it && it.id || "").trim();
    const t = String(it && it.summary || "").trim();
    if (!id) { results.push({ ok: false, id: "", error: "缺少记录 id" }); return; }
    const found = list.find(function (x) { return x && x.id === id && !x.removed; });
    if (!found) { results.push({ ok: false, id: id, error: "块不存在（记录已删除或不在当前会话）" }); return; }
    if (!t) { results.push({ ok: false, id: id, error: "摘要内容为空" }); return; }
    if (t.length > MAX_MEMORY_CHARS) { results.push({ ok: false, id: id, error: "摘要超长（" + t.length + " 字，上限 " + MAX_MEMORY_CHARS + "）" }); return; }
    archiveHistory(found, t);
    found.text = t;
    found.memory = t;
    found.updated_at = nowIso();
    found.enabled = false;
    results.push({ ok: true, id: id, length: t.length });
  });
  if (results.some(function (r) { return r.ok; })) saveItems(list);
  const okCount = results.filter(function (r) { return r.ok; }).length;
  return { ok: true, okCount: okCount, failCount: results.length - okCount, results: results };
}

// 清空全部手工块（压缩页 blocks 路由 reset 动作用）
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

// 手动隐藏 AI 块（入池后归档）：hidden=true 时该块的摘要与区间原文都不再注入上下文（标星原句保留）
function setReplacementHidden(id, hidden) {
  const items = loadItems();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: "未找到该记录" };
  items[idx].hidden = hidden === true;
  saveItems(items);
  console.log("[context-replacements] 已" + (items[idx].hidden ? "隐藏" : "取消隐藏") + "块：", items[idx].id, items[idx].range_label || "");
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
  // 占位头 0919 起改英文块头（Context Assembly 0918 定稿命名），时间段紧跟一个空格；旧「（对话摘要」头仅存在于历史会话
  // 2026-09-28 用户拍板：压缩替换块在上下文中显示为 developer 段（与其他 V2 注入块同层）；
  // 出口经 role-mapper default 映射为 system 发给上游。
  const label = item.range_label ? " " + item.range_label : "";
  return { role: "developer", _ctxRep: true, content: "## Historical Summary" + label + "\n" + recordText(item) };
}

// ---------------- 重要内容标记（星星） ----------------
// 与 context-compactor 共用 data/context_compaction_marks.json，key 用 contentKey
const MARKS_FILE = path.join(DATA_DIR, "context_compaction_marks.json");
// 走 readJson 的 mtime 缓存：该函数在压缩页预览/容量提醒的消息级循环里被高频调用，
// 之前的裸 readFileSync 在 matched 数百条时放大成数百次全量读盘
function loadMarks() {
  try {
    const data = readJson(MARKS_FILE, null);
    if (data && data.marks && typeof data.marks === "object") return data.marks;
  } catch (err) { /* 无标记 */ }
  return {};
}
function contentKey(msg) {
  const text = contentToText(msg);
  return crypto.createHash("sha256").update((msg && msg.role ? msg.role : "") + "\u0000" + text).digest("hex").slice(0, 32);
}

// 块内容共享签名：对齐 makeChunk 口径，只统计普通对话（role+content），特殊事件不计入，
// 用于判定「不同会话里内容序列完全一致」的块，从而跨会话复用摘要正文。
function matchedShareSig(matched) {
  const hash = crypto.createHash("sha256");
  (Array.isArray(matched) ? matched : []).forEach(function (m) {
    if (!m) return;
    try { if (isSpecialEvent(m)) return; } catch (e) { /* 单条失败不阻断 */ }
    hash.update(String(m.role || "") + "\u0000" + contentToText(m));
    hash.update("\u0001");
  });
  return hash.digest("hex").slice(0, 32);
}

function saveMarks(marks) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 2026-09-13 审查修复：tmp 名加进程/随机后缀（批注时 gateway 与 wake-up 双进程都会写 marks，
    // 固定共享 tmp 名会同写交错；2026-09-15 起 wake-up 退役为单进程，后缀机制保留作防御）
    const tmp = MARKS_FILE + ".tmp." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, marks: marks }, null, 2), "utf-8");
    fs.renameSync(tmp, MARKS_FILE);
  } catch (err) {
    console.error("[context-replacements] 标记保存失败:", err.message);
  }
}

function findContentByKey(key) {
  try {
    const timeline = loadTimeline();
    for (const m of timeline) {
      if (!m || m.role === "system") continue;
      if (m.deleted === true) continue;
      try {
        if (contentKey(m) === key) {
          const c = contentToText(m);
          if (c) return { content: c, role: m.role || "", time: m.time || "" };
        }
      } catch (e) { /* 单条失败忽略 */ }
    }
  } catch (err) { /* 反查失败不阻断标星 */ }
  return null;
}

function setMark(key, marked, opt) {
  const marks = loadMarks();
  if (marked) {
    const entry = { markedAt: new Date().toISOString() };
    if (opt && opt.content) entry.content = opt.content;
    if (opt && opt.role) entry.role = opt.role;
    // 原消息时间（跨窗口注入按"会话创建时间之前"过滤用）：优先显式传 msg_time，其次时间线反查补
    if (opt && opt.msg_time) entry.time = String(opt.msg_time || "").trim();
    if (!entry.content || !entry.time) {
      const orig = findContentByKey(key);
      if (orig) {
        if (!entry.content && orig.content) { entry.content = orig.content; entry.role = entry.role || orig.role; }
        if (!entry.time && orig.time) entry.time = orig.time;
      }
    }
    if (!entry.content) {
      console.warn("[context-replacements] 标星失败：无法回溯到原文 key=" + key);
      return { ok: false, error: "无法回溯到这条消息的原文，标星失败（请刷新后重试）" };
    }
    marks[key] = entry;
  } else {
    delete marks[key];
  }
  saveMarks(marks);
  return { ok: true, marked: !!marked };
}

function updateMark(key, opt) {
  const marks = loadMarks();
  if (!marks[key]) return { ok: false, error: "该标星消息不存在，可能已被取消" };
  const content = String((opt && opt.content) || "").trim();
  if (!content) return { ok: false, error: "正文内容不能为空" };
  marks[key].content = content;
  saveMarks(marks);
  return { ok: true, content: content };
}

// setMarkPoolId/getMarkPoolId（标星→记忆池联动 poolId 通道）已于 2026-09-28 删除：
// 写入方从未被接通（全仓零调用，marks 里从不存在 poolId 字段）。

// 按 会话id+消息id 批量取消息（AI 标星 context_star 用）：
// 返回 found=[{msg_id,key,content,role,time}]（key=contentKey，可直接进 setMark）、missing=没找到的编号。
// sessionId 传 "current"/空 = 当前会话。
function findMessagesByIds(sessionId, msgIds) {
  const ids = (Array.isArray(msgIds) ? msgIds : []).map(function(x) { return String(x || "").trim(); }).filter(Boolean);
  const found = [];
  const missing = [];
  if (ids.length === 0) return { found: found, missing: missing };
  let timeline = null;
  try {
    const sid = (!sessionId || sessionId === "current") ? undefined : sessionId;
    timeline = loadTimeline(sid);
  } catch (e) { timeline = null; }
  const byId = new Map();
  (Array.isArray(timeline) ? timeline : []).forEach(function(m) {
    if (!m || m.role === "system" || m.deleted === true) return;
    if (m.id) byId.set(String(m.id), m);
  });
  ids.forEach(function(mid) {
    const m = byId.get(mid);
    if (!m) { missing.push(mid); return; }
    let c = null;
    let key = null;
    try { c = contentToText(m); key = c ? contentKey(m) : null; } catch (e) { c = null; }
    if (!c || !key) { missing.push(mid); return; }
    found.push({ msg_id: mid, key: key, content: c, role: m.role || "", time: m.time || "" });
  });
  return { found: found, missing: missing };
}

// 未发生替换时统一留痕：让每次请求都有记录，便于了解哪些请求没触发上下文替换
function logNoReplace(count, source) {
  try {
    appendReplaceLog({
      time: nowIso(),
      source: source || "对话",
      session: activeSessionOr(),
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
  // 多会话隔离：只套用"属于当前会话"的替换记录。
  // 兼容旧数据：没有 session 字段的记录是历史遗留（所有会话通用，维持旧行为）；
  // 新记录在创建时都会打上 session，只在该会话内套用，避免跨会话串扰。
  const curSession = activeSessionOr() || "default";
  let items = loadItems().filter(it => !it.removed && it.enabled !== false && recordText(it));
  items = items.filter(it => !it.session || it.session === curSession);
  if (items.length === 0) { logNoReplace(messages.length, source); return messages; }

  const out = Array.isArray(messages) ? messages.slice() : [];
  const marks = loadMarks();

  // 锚点视图：请求里只有「纯对话」消息参与定位（工具/特殊事件/已替换占位全部排除）
  const srcAnchorIdx = [];
  const srcAnchorKeys = [];
  const srcIdToAnchor = new Map(); // 消息id -> 锚点序位（id 与时间线同源，精确且不受内容编辑影响）
  out.forEach(function (m, i) {
    if (!m) return;
    if (m.role === "system") return;
    if (m.role === "tool" || m.tool_calls || m.tool_call_id) return;
    if (isSpecialEvent(m)) return;
    if (isReplacementMemoryMessage(m)) return;
    if (!String(contentToText(m)).trim()) return;
    srcAnchorIdx.push(i);
    srcAnchorKeys.push(normalizedCompareKey(m));
    if (m.id) srcIdToAnchor.set(String(m.id), srcAnchorIdx.length - 1);
  });
  // 性能：预构建「内容锚点键 -> 出现的索引列表」，把 indexOf/lastIndexOf 的 O(n) 扫降为 O(log n) 查表。
  // srcAnchorKeys 允许重复键，列表按索引升序；查表语义与 Array.indexOf/lastIndexOf 完全一致。
  const srcKeyToIdx = new Map();
  srcAnchorKeys.forEach(function (k, i) {
    if (!srcKeyToIdx.has(k)) srcKeyToIdx.set(k, []);
    srcKeyToIdx.get(k).push(i);
  });
  const anchorFirst = function (key, from) {
    const arr = srcKeyToIdx.get(key);
    if (!arr || arr.length === 0) return -1;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < arr.length ? arr[lo] : -1;
  };
  const anchorLast = function (key) {
    const arr = srcKeyToIdx.get(key);
    return (arr && arr.length) ? arr[arr.length - 1] : -1;
  };
  if (srcAnchorIdx.length === 0) { logNoReplace(messages.length, source); return messages; }

  // 时间线纯对话序列（内容锚点失败时做位置近似兜底）
  const timeline = loadTimeline();
  const tlEntries = [];
  (Array.isArray(timeline) ? timeline : []).forEach(function (m, i) {
    if (m && m.role !== "system" && isCompressible(m, true)) tlEntries.push({ msg: m, arrIdx: i });
  });
  const tlPurePos = [];
  tlEntries.forEach(function (e, i) { if (!isSpecialEvent(e.msg)) tlPurePos.push(i); });
  // 当前窗口起点：仅当前窗口内的块参与替换（旧窗口块按内容锚点匹配到新窗口时不注入、不显示）
  const windowStartMs = currentWindowStartMs(timeline);

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
  // 跳过块收集：随替换日志落盘（skipped 字段）；异常跳过同时 console.warn，不再静默
  const skipped = [];
  items = items
    .filter(function (it) {
      if (!tlPos.has(it.id)) {
        skipped.push({ id: it.id, reason: "首条锚点不在时间线" });
        console.warn("[context-replacements] 块跳过 id=" + it.id + " 原因=首条锚点在时间线中找不到");
        return false;
      }
      return true;
    })
    .sort(function (a, b) { return tlPos.get(a.id) - tlPos.get(b.id); });
  // 活跃块上限：手动+AI 块合计只保留时间线上最近的 N 个（0=不限）。
  // 超限的最早块与手动隐藏块（hidden=true）同样处理：区间仍按锚点定位校验，但摘要不注入、
  // 区间原文也从上下文剔除（2026-09-15 与预览统计统一口径——此前截断块原文会漏进上下文）；
  // 块的 enabled/摘要数据不动，调大上限或取消隐藏即恢复。
  const manualHiddenItems = items.filter(function (it) { return it.hidden === true; });
  items = items.filter(function (it) { return it.hidden !== true; });
  const maxActiveBlocks = loadMaxActiveBlocks();
  let truncatedItems = [];
  if (maxActiveBlocks > 0 && items.length > maxActiveBlocks) {
    truncatedItems = items.slice(0, items.length - maxActiveBlocks);
    truncatedItems.forEach(function (it) {
      skipped.push({ id: it.id, reason: "活跃块上限截断(" + maxActiveBlocks + ")" });
    });
    items = items.slice(items.length - maxActiveBlocks);
  }
  // 删除型块（手动隐藏/超限截断）：重新并入处理队列走同一套锚点校验，锚点失配则照常 skipped 兜底（原文保留）
  const omitIds = new Set(manualHiddenItems.concat(truncatedItems).map(function (it) { return it.id; }));
  items = items.concat(manualHiddenItems, truncatedItems);
  if (items.length === 0) return messages;

  const replacements = [];
  let searchStart = 0;
  items.forEach(function (item) {
    const matched = (Array.isArray(item.matched) && item.matched.length > 0) ? item.matched : null;
    if (!matched || matched.length === 0) {
      skipped.push({ id: item.id, reason: "matched为空" });
      console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=matched为空");
      return;
    }
    // 窗口隔离：块首条锚点消息在当前时间线里的实际时间早于窗口起点 → 旧窗口块，跳过
    const firstTlPos = tlPos.get(item.id);
    if (firstTlPos >= 0 && windowStartMs !== null) {
      const firstMsg = tlEntries[firstTlPos].msg;
      const t = messageTime(firstMsg);
      if (t && t.getTime() < windowStartMs) {
        skipped.push({ id: item.id, reason: "旧窗口块" });
        return;
      }
    }

    let aStart = null;
    let aEnd = null;
    for (const m of matched) {
      if (!isSpecialEvent(m)) { aStart = m; break; }
    }
    for (let i = matched.length - 1; i >= 0; i--) {
      if (!isSpecialEvent(matched[i])) { aEnd = matched[i]; break; }
    }
    if (!aStart || !aEnd) {
      skipped.push({ id: item.id, reason: "无首尾锚点" });
      console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=matched里取非特殊事件首尾失败");
      return;
    }
    const startKey = normalizedCompareKey(aStart);
    const endKey = normalizedCompareKey(aEnd);

    // ID 精确匹配优先：matched 存有消息 id（浏览器/时间线同源、唯一、不受内容编辑与位置漂移影响），
    // 请求里能按 id 查到首尾时直接定位区间，内容搜索跳过——「哥哥」等高频短语误匹配从根上消失。
    // id 缺失（第三方客户端不带 id / 消息已删 / 旧记录未迁移）时回退内容匹配，下方三道闸全部保留。
    let si = -1;
    let ei = -1;
    let idPath = false;
    const startId = aStart && aStart.id ? String(aStart.id) : "";
    const endId = aEnd && aEnd.id ? String(aEnd.id) : "";
    if (startId && endId) {
      const siById = srcIdToAnchor.get(startId);
      const eiById = srcIdToAnchor.get(endId);
      if (siById !== undefined && eiById !== undefined && eiById >= siById) {
        si = siById;
        ei = eiById;
        idPath = true;
      }
    }

    if (!idPath) {
      si = anchorFirst(startKey, searchStart);
      // 兜底：相邻块在时间线里被重复内容错位、把“搜索起点”推到本块起点之后时，仍从序列开头重新找起点，避免该块被静默跳过
      if (si === -1) si = anchorFirst(startKey, 0);
      if (si === -1) {
        let firstNonSpecialTlIdx = -1;
        for (const m of matched) {
          if (isSpecialEvent(m)) continue;
          const k = tlKeyToPos.get(normalizedCompareKey(m));
          if (k !== undefined) { firstNonSpecialTlIdx = k; break; }
        }
        const purePos = firstNonSpecialTlIdx >= 0 ? tlPurePos.indexOf(firstNonSpecialTlIdx) : -1;
        if (purePos >= searchStart && purePos < srcAnchorIdx.length) si = purePos;
        else {
          skipped.push({ id: item.id, reason: "起点锚点匹配失败" });
          console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=起点锚点在请求中找不到");
          return;
        }
      }

      // 起点先验校验（仅内容路径：id 路径身份即真相，无需位置先验）。内容匹配到的起点换算回时间线
      // 锚点位置，与块真实首条位置（tlPos）偏差过大 → 拒绝。典型场景：首条是「哥哥」这类高频短语，
      // 内容匹配落到别的出现位置，区间整体错位并吞并相邻块。
      // 阈值 30：请求视图与时间线的正常漂移实测 ≤ 约 16（跨窗口注入/事件插入所致），远小于误匹配动辄数百的偏移。
      if (firstTlPos >= 0) {
        const expectedAnchor = tlPurePos.indexOf(firstTlPos);
        if (expectedAnchor >= 0 && Math.abs(si - expectedAnchor) > 30) {
          skipped.push({ id: item.id, reason: "起点偏移过大(si=" + si + ",期望=" + expectedAnchor + ")" });
          console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=起点锚点偏移过大 si=" + si + " 期望≈" + expectedAnchor + "（疑似高频短语误匹配）");
          return;
        }
      }

      ei = anchorFirst(endKey, si + 1);
      if (ei === -1) ei = anchorLast(endKey);
      if (ei === -1 || ei < si) {
        let found = -1;
        let tried = 0;
        for (let k = matched.length - 2; k >= 0 && tried < 8; k--) {
          if (isSpecialEvent(matched[k])) continue;
          tried++;
          const alt = normalizedCompareKey(matched[k]);
          let ae = anchorFirst(alt, si + 1);
          if (ae === -1) ae = anchorLast(alt);
          if (ae >= si) { found = ae; break; }
        }
        if (found === -1) {
          skipped.push({ id: item.id, reason: "尾锚点及备选全失败" });
          console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=尾锚点及备选在请求中找不到");
          return;
        }
        ei = found;
      }
    }

    // 区间膨胀校验：匹配区间远大于块自身消息数 → 首尾锚点之一误匹配到远处重复内容，
    // 会把相邻块的地盘整段吞进本块（重叠去重还会按创建时间丢弃被吞的邻块），直接拒绝。
    if (matched.length > 0 && (ei - si + 1) > matched.length * 1.5 + 20) {
      skipped.push({ id: item.id, reason: "区间膨胀(" + (ei - si + 1) + "条>块" + matched.length + "条上限)" });
      console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=区间膨胀 ei-si+1=" + (ei - si + 1) + " 远超块消息数 " + matched.length);
      return;
    }

    // 块内多锚点校验（"钥匙"）：除首尾外，再从 matched 块内均匀取若干条非特殊事件消息校验在块区间内命中。
    // 内容路径：10 把钥匙必须全中（防仅靠首尾短通用消息跨会话误命中），缺一即拒。
    // id 路径：身份唯一不可能误命中，钥匙降为「缺失仅告警」——消息被编辑/客户端缺条不再误伤整块。
    const INNER_ANCHOR_COUNT = 10;
    const _innerCandidates = [];
    for (const m of matched) {
      if (isSpecialEvent(m)) continue;
      _innerCandidates.push(m);
    }
    if (_innerCandidates.length > 2) {
      const _mid = _innerCandidates.slice(1, _innerCandidates.length - 1);
      const _take = Math.min(INNER_ANCHOR_COUNT, _mid.length);
      let _idMiss = 0;
      for (let _s = 0; _s < _take; _s++) {
        const _idx = Math.floor(_s * _mid.length / _take);
        const _m = _mid[_idx];
        if (idPath) {
          const _midId = _m && _m.id ? String(_m.id) : "";
          const _ai = _midId ? srcIdToAnchor.get(_midId) : undefined;
          if (_ai === undefined || _ai < si || _ai > ei) _idMiss++;
          continue;
        }
        const _ai = anchorFirst(normalizedCompareKey(_m), si);
        if (_ai === -1 || _ai > ei) {
          skipped.push({ id: item.id, reason: "内部钥匙缺失 idx=" + _idx });
          console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=内部钥匙缺失/越界 idx=" + _idx + " ai=" + _ai + " ei=" + ei + " 内容=" + String(contentToText(_m) || "").slice(0, 30));
          return; // 块内锚点缺失/越界 -> 不命中，跳过该块
        }
      }
      if (idPath && _idMiss > 0) {
        console.warn("[context-replacements] id路径内部钥匙缺失(仅告警不拒绝) id=" + item.id + " 缺失 " + _idMiss + "/" + _take);
      }
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

    // 删除型块（手动隐藏/超限截断）：不注入摘要；标星原句与不可压缩消息仍在终循环保留
    const curMsg = omitIds.has(item.id) ? null : buildMemoryMessage(item);
    const curSer = String(item.created_at || "") + "|" + (item.id || "");
    const dup = replacements.find(function (rp) {
      return !(rp.endIdx < srcStart || rp.startIdx > srcEnd);
    });
    if (dup) {
      // dup.itemSer 形如 "created_at|id"，比较时只取 created_at 部分；
      // 否则拿纯 created_at 与含 id 的整串比较，同秒创建时短串恒小，后块永远替换不掉先块
      const dupCreatedAt = String(dup.itemSer || "|").split("|")[0];
      const curNewer = String(item.created_at || "") >= dupCreatedAt;
      if (curNewer) {
        console.warn("[context-replacements] 区间重叠接管 id=" + item.id + " 接管 " + (dup.id || "") + " 区间[" + dup.startIdx + "-" + dup.endIdx + "]，旧块摘要被覆盖");
        dup.message = curMsg;
        dup.minT = blkMin;
        dup.maxT = blkMax;
        dup.itemSer = curSer;
        dup.id = item.id;
      } else {
        skipped.push({ id: item.id, reason: "区间重叠且更旧被丢弃(重叠块" + (dup.id || "?") + ")" });
        console.warn("[context-replacements] 块跳过 id=" + item.id + " 原因=区间[" + srcStart + "-" + srcEnd + "]与 " + (dup.id || "?") + " 重叠且创建更旧，被丢弃");
      }
    } else {
      replacements.push({
        id: item.id,
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
      // 删除型替换（message=null）不注入：该块区间从上下文消失，只剩标星句/不可压缩消息
      if (replacements[r].message) final.push(replacements[r].message);
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
      session: activeSessionOr(),
      before: out.length,
      after: result.length,
      replaced: replacements.length,
      applied: applied,
      skipped: skipped
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
// 2026-09-13 死代码清理：CONTEXT_SEARCH_REPEAT_WINDOW_MINUTES / CONTEXT_SEARCH_IMPORTED_POS_OFFSET /
// recentlyShown 已删——声明后全仓无引用（loadSearchableMessages 的 imported 恒为空数组）

function loadSearchableMessages() {
  const timeline = nonSystemMessages(loadTimeline());
  return { timeline: timeline, imported: [] };
}


// ── 跨会话加载 ──
function loadAllSessionTimelines() {
  const fs = require("fs");
  const path = require("path");
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter(function(f) {
    return f.startsWith("enhanced_messages_") && f.endsWith(".json") && f !== "enhanced_messages___diag__.json";
  });
  const all = [];
  for (const f of files) {
    const sid = f.slice("enhanced_messages_".length, -".json".length);
    try {
      const data = readJson(path.join(dir, f), []);
      // 必须拷贝后再打标记：readJson 命中缓存时返回的是缓存里的原对象，直接改会污染进程级缓存，
      // 让 loadTimeline 等其他链路读到的消息莫名带上 _session/_sidx
      const nonSys = (Array.isArray(data) ? data : []).filter(function(m) {
        return m && m.role !== "system";
      }).map(function(m, i) {
        return Object.assign({}, m, { _session: sid, _sidx: i });
      });
      all.push.apply(all, nonSys);
    } catch(e) { /* skip */ }
  }
  return all;
}

// 取当前会话（或指定会话）时间线里最新一条有正文的 user 消息，供 /internal/context-search
// 在「MCP 工具未提供 q」时当作检索查询。会话解析复用 loadTimeline 的 effectiveSession 链
//（请求入口 setActiveSession 的 ALS → MCP 工具回调 90 秒兜底 recentMcpChatSession → default）。
// loaders 参数供测试注入假的 loadTimeline。
function getLatestUserMessage(opts, loaders) {
  const o = opts || {};
  const ld = loaders || {};
  const raw = ld.loadTimeline ? ld.loadTimeline(o.session) : loadTimeline(o.session);
  const timeline = nonSystemMessages(raw);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const m = timeline[i];
    if (!m || m.role !== "user") continue;
    const text = contentToText(m);
    if (!text || !String(text).trim()) continue;
    return {
      session: m._session || (o.session ? String(o.session) : null),
      msg_id: m.id || null,
      time: m.time || null,
      content: text
    };
  }
  return null;
}

// ── LLM 精排（可选增强层）：模块缺失/异常时精排自动停用，检索回退基线排序 ──
let _contextRerank = null;
try { _contextRerank = require("./context-rerank"); } catch (e) { _contextRerank = null; }

// ── 语义搜索：TF-IDF + 字符 bigram + 余弦相似度 ──
const SEMANTIC_CACHE = { version: null, vocab: null, tfidfRows: null, ids: null, messages: null };

function _charBigrams(text) {
  if (!text) return [];
  var t = String(text).toLowerCase();
  t = t.replace(/[^\w一-龥]/g, " ");
  var chars = [];
  for (var i = 0; i < t.length; i++) {
    if (t[i] !== " ") chars.push(t[i]);
  }
  if (chars.length < 2) return chars;
  var result = [];
  for (var i = 0; i < chars.length - 1; i++) {
    result.push(chars[i] + chars[i+1]);
  }
  return result;
}

function _msgSearchText(m) {
  var parts = [];
  if (m.content) parts.push(String(m.content));
  return parts.join(" ");
}

function _buildSemanticCache(messages) {
  // 版本标记：用消息数量 + 第一条+最后一条的时间/内容指纹
  var version = messages.length;
  if (messages.length > 0) {
    version += "_" + (messages[0].time || "") + "_" + (messages[messages.length-1].time || "");
  }
  if (SEMANTIC_CACHE.version === version && SEMANTIC_CACHE.tfidfRows !== null) {
    return SEMANTIC_CACHE;
  }
  var vocab = {};      // term -> index
  var docFreq = [];    // index -> count of docs containing term
  var docs = [];       // array of token arrays
  
  for (var i = 0; i < messages.length; i++) {
    var tokens = _charBigrams(_msgSearchText(messages[i]));
    docs.push(tokens);
    var seen = {};
    for (var j = 0; j < tokens.length; j++) {
      var tok = tokens[j];
      if (seen[tok]) continue;
      seen[tok] = true;
      if (vocab[tok] === undefined) {
        vocab[tok] = docFreq.length;
        docFreq.push(1);
      } else {
        docFreq[vocab[tok]]++;
      }
    }
  }
  
  var nDocs = docs.length;
  var vocabSize = docFreq.length;
  // 用数组的数组存储稀疏矩阵（每条消息只存非零项）
  var tfidfRows = new Array(nDocs);
  
  for (var i = 0; i < nDocs; i++) {
    var tokens = docs[i];
    if (tokens.length === 0) { tfidfRows[i] = { indices: [], values: [] }; continue; }
    var tf = {};
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j];
      tf[t] = (tf[t] || 0) + 1;
    }
    var total = tokens.length;
    var indices = [];
    var values = [];
    var normSq = 0;
    for (var t in tf) {
      var idx = vocab[t];
      var tfVal = tf[t] / total;
      var idfVal = Math.log((nDocs + 1) / (docFreq[idx] + 1)) + 1;
      var tfidf = tfVal * idfVal;
      indices.push(idx);
      values.push(tfidf);
      normSq += tfidf * tfidf;
    }
    // 归一化
    var norm = Math.sqrt(normSq);
    if (norm > 0) {
      for (var k = 0; k < values.length; k++) values[k] /= norm;
    }
    tfidfRows[i] = { indices: indices, values: values };
  }
  
  SEMANTIC_CACHE.version = version;
  SEMANTIC_CACHE.vocab = vocab;
  SEMANTIC_CACHE.tfidfRows = tfidfRows;
  SEMANTIC_CACHE.messages = messages;
  return SEMANTIC_CACHE;
}

// ── 字符 bigram TF-IDF 余弦（旧版伪语义，保留为 embed-server 不可用时的降级路径） ──
function _tfidfSearchMessages(messages, query, limit, threshold) {
  if (!threshold) threshold = 0.05;
  if (!limit) limit = 20;
  var cache = _buildSemanticCache(messages);
  var vocab = cache.vocab;
  var tfidfRows = cache.tfidfRows;
  
  var qTokens = _charBigrams(query);
  if (qTokens.length === 0) return [];
  
  // 构建查询向量
  var qTf = {};
  for (var i = 0; i < qTokens.length; i++) {
    var t = qTokens[i];
    qTf[t] = (qTf[t] || 0) + 1;
  }
  var qTotal = qTokens.length;
  var qIndices = [];
  var qValues = [];
  var qNormSq = 0;
  for (var t in qTf) {
    if (vocab[t] === undefined) continue;
    var idx = vocab[t];
    var val = qTf[t] / qTotal;
    qIndices.push(idx);
    qValues.push(val);
    qNormSq += val * val;
  }
  if (qIndices.length === 0) return [];
  var qNorm = Math.sqrt(qNormSq);
  for (var k = 0; k < qValues.length; k++) qValues[k] /= qNorm;
  
  // 计算余弦相似度（只遍历查询向量中非零维度的文档，加速）
  // 先建倒排：term -> list of doc indices
  // 由于 vocab 很大，我们用另一种方式：遍历所有文档算点积
  // 6000+ 条不多，直接遍历即可
  var scores = new Float32Array(messages.length);
  for (var i = 0; i < messages.length; i++) {
    var row = tfidfRows[i];
    if (!row || row.indices.length === 0) continue;
    // 计算点积：用双指针？文档向量和查询向量都按索引排序的话可以
    // 查询向量的 indices 不一定有序，先排序
    var dot = 0;
    // 简单做法：对于小查询，遍历查询项在文档里找
    for (var qi = 0; qi < qIndices.length; qi++) {
      var qIdx = qIndices[qi];
      // 在 row.indices 中查找 qIdx
      // 因为 row.indices 是按 vocab 插入顺序的，不一定有序
      // 用 Set 加速？每条消息存一个 termSet？
      // 先线性搜，消息不多应该没问题
      for (var di = 0; di < row.indices.length; di++) {
        if (row.indices[di] === qIdx) {
          dot += row.values[di] * qValues[qi];
          break;
        }
      }
    }
    scores[i] = dot;
  }
  
  // 取 top N
  var results = [];
  for (var i = 0; i < messages.length; i++) {
    if (scores[i] >= threshold) {
      results.push({ idx: i, score: scores[i] });
    }
  }
  results.sort(function(a, b) { return b.score - a.score; });
  return results.slice(0, limit);
}

// ── 本地语义向量检索（embed-server，bge-small-zh-v1.5） ──
// sig = sha1(检索文本) 前 16 位，内容不变即可复用。
// 批注 2026-09-13（阶段4）：缓存从 38MB JSON 全量 stringify 落盘（即使 D1 防抖+原子写，
// 每次落盘仍阻塞事件循环）改为 node:sqlite（lib/msg-vector-store.js，零新依赖）：sig 主键
// upsert、点积按需取行 + L1 小缓存、超 2 万条 SQL 淘汰；首次启动自动迁移旧 JSON（成功后
// 改名 .migrated 保留，回滚=代码改回旧版+把 .migrated 改回原名）。
// 服务不可用（熔断）/超时 → 自动回退 _tfidfSearchMessages（旧字面逻辑），主链路不受影响。
const embedClient = require("./utils/embed-client");
const msgVecStore = require("./lib/msg-vector-store");
const MSG_VECTOR_EMBED_CAP = 32;    // 单次检索最多补算条数（长文单条 100-300ms，32 条 ~5s 内；全量靠 warmup）

function _sigOfText(t) {
  return crypto.createHash("sha1").update(String(t || "")).digest("hex").slice(0, 16);
}

// 核心补算：给一组文本补缺失向量（无上限，调用方自己分批）；返回 false = embed 不可用
// 嵌入输入统一截前 256 字符：长消息全量嵌入单条要 100-300ms 且稀释主题；前 256 字（2-3 句）主题表征足够，吞吐翻倍
const MSG_TEXT_CLIP = 256;
async function _ensureMsgVectorsRaw(texts, timeoutMs) {
  const cands = [];
  const seen = new Set();
  for (const t of texts) {
    const sig = _sigOfText(t);
    if (!seen.has(sig)) { seen.add(sig); cands.push({ sig: sig, text: String(t).slice(0, MSG_TEXT_CLIP) }); }
  }
  const known = msgVecStore.getMany(cands.map(function (x) { return x.sig; }));
  const missing = cands.filter(function (x) { return !known.has(x.sig); });
  if (!missing.length) return true;
  const vecs = await embedClient.embedBatch(missing.map(function (x) { return x.text; }), false, timeoutMs || 15000);
  if (!vecs) return false;
  missing.forEach(function (x, i) { if (vecs[i] && vecs[i].length) msgVecStore.set(x.sig, vecs[i]); });
  return true;
}

// 语义检索消息（async）：BGE 真语义余弦；不可用/向量补算失败 → 降级 TF-IDF（阈值沿用旧 0.08）
async function semanticSearchMessages(messages, query, limit, threshold) {
  if (!threshold) threshold = 0.45; // BGE 余弦分布：同义 ~0.5-0.8，无关底噪 ~0.30-0.36，0.45 起步较稳
  if (!limit) limit = 20;
  if (embedClient.fused()) return _tfidfSearchMessages(messages, query, limit, 0.08);
  const texts = messages.map(function (m) { return _msgSearchText(m); });
  const items = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i]) items.push({ idx: i, text: texts[i] });
  }
  if (!items.length) return [];
  // 单次补算设上限：超限部分本轮跳过（由 warmup 兜底），不阻塞检索
  const capped = items.slice(0, MSG_VECTOR_EMBED_CAP);
  const ready = await _ensureMsgVectorsRaw(capped.map(function (x) { return x.text; }), 20000);
  if (!ready) return _tfidfSearchMessages(messages, query, limit, 0.08);
  const qv = await embedClient.embedBatch([String(query || "")], true, 8000);
  if (!qv) return _tfidfSearchMessages(messages, query, limit, 0.08);
  const q = Float32Array.from(qv[0]);
  const m = msgVecStore.getMany(items.map(function (x) { return _sigOfText(x.text); }));
  const results = [];
  for (const it of items) {
    const v = m.get(_sigOfText(it.text));
    if (!v) continue;
    let dot = 0;
    for (let k = 0; k < q.length; k++) dot += q[k] * v[k];
    if (dot >= threshold) results.push({ idx: it.idx, score: dot });
  }
  results.sort(function (a, b) { return b.score - a.score; });
  return results.slice(0, limit);
}

// 后台预热：全部会话时间线 + 导入对话的消息向量分批补算（server 启动后调用一次）
let _warmBusy = false;
async function startMsgVectorWarmup() {
  if (_warmBusy) return;
  _warmBusy = true;
  try {
    const texts = new Set();
    for (const mm of loadAllSessionTimelines()) {
      const t = _msgSearchText(mm);
      if (t) texts.add(t);
    }
    const arr = Array.from(texts);
    let done = 0;
    const CH = 12;                  // 长文单条 100-300ms，12 条批 ~2-4s 稳在超时内
    const deadline = Date.now() + 30 * 60 * 1000; // 总时长上限 30 分钟
    for (let i = 0; i < arr.length; i += CH) {
      if (Date.now() > deadline) break;
      if (embedClient.fused()) {
        // 熔断期（60s）：等它结束再继续，而不是放弃——否则中断后无自动恢复
        await new Promise(function (r) { setTimeout(r, 65000); });
        if (embedClient.fused()) break; // 等完仍在熔断 = embed-server 真挂了，停
        continue;
      }
      const ok = await _ensureMsgVectorsRaw(arr.slice(i, i + CH), 60000);
      if (!ok) continue; // 本批失败（已进熔断）：下轮循环会等熔断结束再试
      done += Math.min(CH, arr.length - i);
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    console.log("[context-search] 消息向量预热:", done, "/", arr.length);
  } catch (e) {
    console.log("[context-search] 消息向量预热中断:", e.message);
  } finally {
    _warmBusy = false;
  }
}


// ── 增强版上下文搜索：支持跨会话 + 语义检索（embed-server 真语义，降级 TF-IDF） ──
async function searchContextEnhanced(query, options) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "查询不能为空" };
  const opts = options || {};
  const mode = opts.mode === "keyword" ? "keyword" : "semantic";
  const allSessions = !!opts.allSessions;
  const maxReturn = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 10)));
  // semantic 阈值含义随引擎变化：BGE 余弦默认 0.45（旧 TF-IDF 0.08 仅作降级时用）
  const threshold = opts.threshold !== undefined ? Number(opts.threshold) : (mode === "semantic" ? 0.45 : 0);
  
  var allMsgs = [];
  if (allSessions) {
    allMsgs = loadAllSessionTimelines().map(function(m, i) {
      return {
        content: contentToText(m),
        role: m.role,
        time: m.time || null,
        source: "timeline",
        session: m._session,
        sidx: m._sidx,
        msg_id: m.id,
        _gidx: i
      };
    });
  } else {
    const src = loadSearchableMessages();
    for (let i = 0; i < src.timeline.length; i++) {
      allMsgs.push({
        content: contentToText(src.timeline[i]),
        role: src.timeline[i].role,
        time: src.timeline[i].time || null,
        source: "timeline",
        session: "current",
        sidx: i,
        msg_id: src.timeline[i].id,
        _gidx: i
      });
    }
    const baseIdx = allMsgs.length;
    for (let i = 0; i < src.imported.length; i++) {
      allMsgs.push({
        content: contentToText(src.imported[i]),
        role: src.imported[i].role,
        time: src.imported[i].time || null,
        source: "imported",
        record_id: src.imported[i].record_id,
        msg_id: src.imported[i].msg_id,
        _gidx: baseIdx + i
      });
    }
  }
  
  const now = Date.now();
  const recentCutoff = now - CONTEXT_SEARCH_RECENT_EXCLUDE_MINUTES * 60000;
  var scored = [];
  
  if (mode === "semantic") {
    const results = await semanticSearchMessages(allMsgs, q, Math.min(maxReturn * 10, 200), threshold);
    for (let r = 0; r < results.length; r++) {
      const m = allMsgs[results[r].idx];
      if (!allSessions && m.source === "timeline" && m.time) {
        const t = new Date(m.time).getTime();
        if (!isNaN(t) && t > recentCutoff) continue;
      }
      if (!m.content) continue;
      scored.push({
        pos: m._gidx,
        source: m.source,
        session: m.session,
        sidx: m.sidx,
        record_id: m.record_id,
        msg_id: m.msg_id,
        role: m.role,
        time: m.time,
        score: Math.round(results[r].score * 10000) / 100,
        coverage: 1,
        hits: 1,
        hit_terms: [],
        content: m.content
      });
    }
  } else {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { ok: false, error: "查询不能为空" };
    for (let i = 0; i < allMsgs.length; i++) {
      const m = allMsgs[i];
      if (!m.content) continue;
      if (!allSessions && m.source === "timeline" && m.time) {
        const t = new Date(m.time).getTime();
        if (!isNaN(t) && t > recentCutoff) continue;
      }
      const low = m.content.toLowerCase();
      const hitTerms = [];
      let totalHits = 0;
      for (let ti = 0; ti < terms.length; ti++) {
        const t = terms[ti];
        let c = 0;
        let pos = 0;
        while ((pos = low.indexOf(t, pos)) !== -1) { c++; totalHits++; pos += t.length; }
        if (c > 0) hitTerms.push(t);
      }
      if (hitTerms.length === 0) continue;
      const coverage = hitTerms.length;
      const density = (totalHits / m.content.length) * 100;
      scored.push({
        pos: m._gidx, source: m.source, session: m.session, sidx: m.sidx,
        record_id: m.record_id, msg_id: m.msg_id, role: m.role, time: m.time,
        score: Math.round((coverage * 100 + Math.min(density * 20, 40) + Math.min(totalHits, 10)) * 10) / 10,
        coverage: coverage, density: Math.round(density * 10) / 10,
        hits: totalHits, hit_terms: hitTerms, content: m.content
      });
    }
    if (scored.length > CONTEXT_SEARCH_FILTER_MIN_HITS) {
      const filtered = scored.filter(function(x) { return (x.density||0) >= CONTEXT_SEARCH_DENSITY_FLOOR; });
      if (filtered.length >= CONTEXT_SEARCH_MIN_KEEP) scored = filtered;
      else scored = scored.slice(0, CONTEXT_SEARCH_MIN_KEEP);
    }
    scored.sort(function(a, b) { return b.coverage - a.coverage || b.density - a.density || b.hits - a.hits || a.pos - b.pos; });
  }
  
  const groups = [];
  const used = new Array(scored.length).fill(false);
  for (let i = 0; i < scored.length; i++) {
    if (used[i]) continue;
    const group = [scored[i]];
    used[i] = true;
    for (let j = i + 1; j < scored.length; j++) {
      if (used[j]) continue;
      if (scored[j].session !== scored[i].session) continue;
      if (scored[j].source !== scored[i].source) continue;
      const gap = Math.abs(scored[j].sidx - group[group.length-1].sidx);
      if (gap <= CONTEXT_SEARCH_MERGE_GAP) { group.push(scored[j]); used[j] = true; }
    }
    groups.push(group);
  }
  
  // LLM 精排（增强层）：只要粗检索出了候选组就交给 LLM 挑真正相关的（含剔除碰巧词面
  // 相似的模糊命中）；picked 只保留 LLM 选中的组，不拿基线结果凑数。任何失败/空选择
  // 保持原排序回退——LLM 挂了工具行为与升级前完全一致。
  let orderedGroups = groups;
  let rerankMeta = null;
  if (_contextRerank && groups.length > 0) {
    try {
      const rr = await _contextRerank.rerankGroupsWithLLM(q, groups, { pickMax: maxReturn });
      rerankMeta = rr && rr.meta ? rr.meta : null;
      if (rr && Array.isArray(rr.picked) && rr.picked.length > 0) {
        orderedGroups = rr.picked.map(function (gi) { return groups[gi]; });
      }
    } catch (e) {
      rerankMeta = { reranked: false, reranker: "baseline", reason: "精排异常: " + ((e && e.message) || e) };
    }
  }

  const matches = orderedGroups.slice(0, maxReturn).map(function(g) {
    const rep = g[0];
    const content = rep.content;
    let snippet = content;
    if (content.length > 500) {
      if (mode === "keyword" && rep.hit_terms && rep.hit_terms.length > 0) {
        const low = content.toLowerCase();
        let firstHit = -1;
        for (let ti = 0; ti < rep.hit_terms.length; ti++) {
          const pos = low.indexOf(rep.hit_terms[ti]);
          if (pos >= 0 && (firstHit < 0 || pos < firstHit)) firstHit = pos;
        }
        const sliceStart = Math.max(0, Math.min(firstHit - 100, content.length - 500));
        snippet = (sliceStart > 0 ? "…" : "") + content.slice(sliceStart, sliceStart + 500) + (content.length > sliceStart + 500 ? "…" : "");
      } else {
        snippet = content.slice(0, 500) + (content.length > 500 ? "…" : "");
      }
    }
    const out = {
      role: rep.role, time: rep.time, score: rep.score,
      hit_terms: rep.hit_terms || [], hits: g.reduce(function(s, x) { return s + (x.hits||0); }, 0),
      count: g.length, content: snippet, source: rep.source
    };
    if (rep.source === "timeline") {
      out.session = rep.session;
      out.msg_id = rep.msg_id;
      out.start_index = rep.sidx;
      out.end_index = g[g.length-1].sidx;
    } else if (rep.source === "imported") {
      out.record_id = rep.record_id;
      out.msg_id = rep.msg_id;
    }
    return out;
  });
  
  const out = { ok: true, total: scored.length, matches: matches, mode: mode, all_sessions: allSessions };
  if (rerankMeta) {
    out.reranked = !!rerankMeta.reranked;
    out.reranker = rerankMeta.reranker || "baseline";
    if (rerankMeta.reason) out.rerank_reason = rerankMeta.reason;
    if (rerankMeta.model) out.rerank_model = rerankMeta.model;
  }
  return out;
}

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
// compactionKeyOf / locateCompIdx 内容锚点已删（2026-09-19 统一消息 id 锚点，见 recordCompRange）

// 解析记录在压缩索引空间(compressibleItems)中的覆盖范围
function recordCompRange(it, items) {
  const compItems = items || compressibleItems();
  // 2026-09-19 统一 id 锚点定位：块的真实覆盖区间由 matched[].id（消息自带 UUID，全库唯一、
  // 随时间线增删不漂移）解析——首条有 id 的 matched 定起点，末条有 id 的定终点。
  // 旧的时间/编号存储定位与内容锚点已删；matched 全无 id 的极老块视为不可定位（不显示不注入）。
  const matched = (Array.isArray(it && it.matched) && it.matched.length > 0) ? it.matched : [];
  if (!matched.length) return null;
  const idPos = new Map();
  for (let i = 0; i < compItems.length; i++) {
    const id = compItems[i].msg && compItems[i].msg.id ? String(compItems[i].msg.id) : null;
    if (id && !idPos.has(id)) idPos.set(id, i);
  }
  let s = -1;
  for (const m of matched) {
    const id = m && m.id ? String(m.id) : null;
    if (id && idPos.has(id)) { s = idPos.get(id); break; }
  }
  let e = -1;
  for (let k = matched.length - 1; k >= 0; k--) {
    const id = matched[k] && matched[k].id ? String(matched[k].id) : null;
    if (id && idPos.has(id)) { e = idPos.get(id); break; }
  }
  if (s < 0 || e < 0 || e < s) return null;
  return windowFilteredRange(s, e, compItems);
}

// 窗口隔离：范围首条消息早于当前窗口起点 → 旧窗口块，视为不在当前时间线（不显示、不注入）
function windowFilteredRange(s, e, compItems) {
  const windowStartMs = currentWindowStartMs(loadTimeline());
  if (windowStartMs !== null) {
    const firstMsg = compItems[s] && compItems[s].msg;
    const t = firstMsg ? messageTime(firstMsg) : null;
    if (t && t.getTime() < windowStartMs) return null;
  }
  return { start: s, end: e };
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
    const t = entry.time || entry.markedAt;
    results.push({
      index: displayIndex,
      role: entry.role || "assistant",
      time: t ? fmtWall(new Date(t)) : "",
      content: entry.content,
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
        content: content,
        key: key,
        markedAt: (marks[key] && marks[key].markedAt) || "",
        chunk: info
      });
    });
  });

  // 按标记时间倒序：最新标记在最前面；无标记时间的存量条目排最后，保证稳定
  results.sort(function (a, b) {
    const ta = a.markedAt ? (Number(new Date(a.markedAt)) || -Infinity) : -Infinity;
    const tb = b.markedAt ? (Number(new Date(b.markedAt)) || -Infinity) : -Infinity;
    return tb - ta;
  });
  // 排序后重新分配连续编号（1-based），保证前端「第 X 条」序号连续
  results.forEach(function (r, i) { r.index = i + 1; });
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
  const _loopMarks = loadMarks();   // 提到循环外：命中数百条时逐条 loadMarks 是重复开销
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
      marked: !!_loopMarks[key],
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


// ========================
// 计算渲染起点（2026-09-29 前端"纯显示器"）：最后一个参与处理块的结束位置。
// 与 buildIncrementalContext 的定位/窗口/隐藏口径完全一致（matched id 锚点、窗口内、
// 含隐藏块——隐藏块区间同样不显示原文，因此其 end 计入 lastEnd）。
// 返回 { tailIndex, lastEndId, blockFp }：tailIndex = 时间线索引 lastEnd+1（其后的
// 未覆盖消息即前端要显示的未压缩原文起点）；lastEndId = 最后一块 end 消息 id
// （供 /v1/history 在过滤后可见序列中定位起点）；无块/无定位 → tailIndex=0, lastEndId=null。
// ========================
function computeTailStart(sessionId, timeline) {
  const tl = Array.isArray(timeline) ? timeline : [];
  if (!tl.length) return { tailIndex: 0, lastEndId: null, blockFp: "" };
  let blockFp = "";
  try {
    const st = fs.statSync(REPLACEMENTS_FILE);
    blockFp = String(st.mtimeMs) + ":" + String(st.size);
  } catch (e) { blockFp = ""; }
  const curSession = activeSessionOr() || sessionId || "default";
  let items = loadItems().filter(function (it) {
    if (it.removed || it.enabled === false) return false;
    if (!recordText(it)) return false;
    if (it.session && it.session !== curSession) return false;
    return true;
  });
  if (!items.length) return { tailIndex: 0, lastEndId: null, blockFp: blockFp };
  const idPos = new Map();
  for (let i = 0; i < tl.length; i++) {
    const m = tl[i];
    if (!m || m.role === "system" || m.deleted) continue;
    const id = m.id ? String(m.id) : "";
    if (id && !idPos.has(id)) idPos.set(id, i);
  }
  const windowStartMs = currentWindowStartMs(tl);
  let lastEnd = -1;
  let lastEndId = null;
  for (const it of items) {
    const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : null;
    if (!matched || matched.length === 0) continue;
    let aStart = null;
    let aEnd = null;
    for (const m of matched) { if (!isSpecialEvent(m)) { aStart = m; break; } }
    for (let i = matched.length - 1; i >= 0; i--) { if (!isSpecialEvent(matched[i])) { aEnd = matched[i]; break; } }
    if (!aStart || !aEnd) continue;
    const sId = aStart && aStart.id ? String(aStart.id) : "";
    const eId = aEnd && aEnd.id ? String(aEnd.id) : "";
    if (!sId || !eId) continue;
    const s = idPos.get(sId);
    const e = idPos.get(eId);
    if (s === undefined || e === undefined || e < s) continue;
    if (windowStartMs !== null) {
      let anchorM = null;
      for (let i = s; i <= e; i++) { if (!isSpecialEvent(tl[i])) { anchorM = tl[i]; break; } }
      if (anchorM) {
        const t = messageTime(anchorM);
        if (t && t.getTime() < windowStartMs) continue;
      }
    }
    if (e > lastEnd) { lastEnd = e; lastEndId = eId; }
  }
  return { tailIndex: lastEnd + 1, lastEndId: lastEndId, blockFp: blockFp };
}

// ========================
// 增量上下文构建（2026-09-29）：keh3 5000+ 条会话提速——每请求只 prepare 尾部未覆盖对话
// 只摘要化「id 可定位 + 窗口内 + 非隐藏 + 非截断」的块区间；其余（窗口外/定位失败）区间原文透传，
// 由后续 applyReplacements 兜底（窗口外/定位失败跳过、隐藏/截断剔除），结果与全量路径一致。
// 区间内保留语义与 applyReplacements 同款：记忆浮现/工具剔除、标星前置、不可压缩（真日记等）保留。
// 返回 { head, tailStart, blockFp }：head = 原始消息引用（调用方 prepare；_ctxRep 摘要直接透传）；
// tailStart = 最后一个参与处理块 end+1（其后的尾部未覆盖消息由调用方现算）。
// blockFp = context_replacements.json 指纹（整体缓存键用，块记录未变时 head 稳定）。
// ========================
function buildIncrementalContext(sessionId, timeline) {
  const tl = Array.isArray(timeline) ? timeline : [];
  const out = { head: [], tailStart: tl.length, blockFp: "" };
  if (!tl.length) return out;
  try {
    const st = fs.statSync(REPLACEMENTS_FILE);
    out.blockFp = String(st.mtimeMs) + ":" + String(st.size);
  } catch (e) { out.blockFp = ""; }

  const curSession = activeSessionOr() || sessionId || "default";
  let items = loadItems().filter(function (it) {
    if (it.removed || it.enabled === false) return false;
    if (!recordText(it)) return false;
    if (it.session && it.session !== curSession) return false;
    return true;
  });
  if (!items.length) return out;

  // id → idx 映射（非 system、未删除）
  const idPos = new Map();
  for (let i = 0; i < tl.length; i++) {
    const m = tl[i];
    if (!m || m.role === "system" || m.deleted) continue;
    const id = m.id ? String(m.id) : "";
    if (id && !idPos.has(id)) idPos.set(id, i);
  }

  const windowStartMs = currentWindowStartMs(tl);
  const maxActive = loadMaxActiveBlocks();

  // 定位区间：优先用 matched 首尾非特殊事件消息的 id（与 applyReplacements 完全同口径——
  // 块记录里 range 是创建时快照，matched 会随消息编辑/边界微调更新，两者可能不一致）；
  // matched 缺 id / 查不到 → 该块整体透传，applyReplacements 兜底。
  const located = [];
  for (const it of items) {
    const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : null;
    if (!matched || matched.length === 0) continue;
    let aStart = null;
    let aEnd = null;
    for (const m of matched) { if (!isSpecialEvent(m)) { aStart = m; break; } }
    for (let i = matched.length - 1; i >= 0; i--) { if (!isSpecialEvent(matched[i])) { aEnd = matched[i]; break; } }
    if (!aStart || !aEnd) continue;
    const sId = aStart && aStart.id ? String(aStart.id) : "";
    const eId = aEnd && aEnd.id ? String(aEnd.id) : "";
    if (!sId || !eId) continue;
    const s = idPos.get(sId);
    const e = idPos.get(eId);
    if (s === undefined || e === undefined || e < s) continue;
    // 窗口隔离（与 applyReplacements 同口径：首条非特殊事件锚点早于窗口起点 → 旧窗口块，原文透传）
    if (windowStartMs !== null) {
      let anchorM = null;
      for (let i = s; i <= e; i++) { if (!isSpecialEvent(tl[i])) { anchorM = tl[i]; break; } }
      if (anchorM) {
        const t = messageTime(anchorM);
        if (t && t.getTime() < windowStartMs) continue;
      }
    }
    located.push({ it: it, s: s, e: e });
  }
  if (!located.length) return out;
  located.sort(function (a, b) { return a.s - b.s; });

  // 隐藏块/超限截断块（区间原文从上下文剔除，与 applyReplacements 同口径）
  const hiddenIds = new Set(items.filter(function (it) { return it.hidden === true; }).map(function (it) { return it.id; }));
  let activeLocs = located.filter(function (l) { return !hiddenIds.has(l.it.id); });
  let truncatedIds = new Set();
  if (maxActive > 0 && activeLocs.length > maxActive) {
    const drop = activeLocs.slice(0, activeLocs.length - maxActive);
    truncatedIds = new Set(drop.map(function (l) { return l.it.id; }));
  }

  const marks = loadMarks();
  let cur = 0;
  let lastEnd = -1;
  for (const loc of located) {
    // 前缀/间隙：未覆盖消息透传（调用方 prepare）
    for (let i = cur; i < loc.s; i++) {
      const m = tl[i];
      if (!m || m.role === "system" || m.deleted) continue;
      out.head.push(m);
    }
    if (!hiddenIds.has(loc.it.id) && !truncatedIds.has(loc.it.id)) {
      // 正常块：标星前置 + 摘要 + 区间保留（记忆浮现/工具剔除、标星跳过、不可压缩保留）
      const starred = [];
      for (let i = loc.s; i <= loc.e; i++) {
        const m = tl[i];
        if (!m || m.role === "system" || m.deleted) continue;
        if (m.role === "tool" || m.tool_calls) continue;
        if (marks[contentKey(m)]) starred.push(m);
      }
      starred.forEach(function (sm) { out.head.push(sm); });
      out.head.push(buildMemoryMessage(loc.it));
      for (let i = loc.s; i <= loc.e; i++) {
        const m = tl[i];
        if (!m || m.role === "system" || m.deleted) continue;
        if (isMemoryFlash(m)) continue;
        if (m.role === "tool" || m.tool_calls) continue;
        if (isReplacementMemoryMessage(m)) { out.head.push(m); continue; }
        if (marks[contentKey(m)]) continue;
        if (!isCompressible(m, true)) out.head.push(m);
      }
    }
    // 隐藏/截断块：区间原文剔除（不输出）
    cur = loc.e + 1;
    if (loc.e > lastEnd) lastEnd = loc.e;
  }
  out.tailStart = lastEnd + 1;
  return out;
}

module.exports = {
  addReplacement,
  migrateSessionBlocks,
  inheritSessionBlocks,
  removeReplacement,
  toggleReplacement,
  setReplacementHidden,
  updateReplacement,
  applyReplacements,
  getReplaceLog,
  searchContextEnhanced,
  getLatestUserMessage,
  startMsgVectorWarmup,
  // 2026-09-28 收窄：isReplacementMemoryMessage/resolveRange/loadAllSessionTimelines/findContentByKey/
  // isEventInjectionVisible/classifySpecialEvent（均内部调用）；listReplacements/setMarkPoolId/getMarkPoolId 整函数删除
  loadItems,
  recordText,
  buildIncrementalContext,
  computeTailStart,
  buildMemoryMessage,
  // 手工记录管理
  addManualRecord,
  removeManualRecord,
  removeManualRecordById,
  toggleManualRecord,
  toggleManualRecordById,
  setManualRecordHidden,
  setManualRecordHiddenById,
  updateManualRecordRange,
  updateManualRecordRangeById,
  updateAiRecordRange,
  splitRangeByGaps,
  setManualRecordText,
  setManualRecordTextById,
  importSummariesByItems,
  restoreHistory,
  removeHistory,
  manualRecordsSorted,
  compressibleItems,
  removeAllManualRecords,
  loadTimeline,
  setActiveSession,
  getActiveSession,
  noteMcpChatSession,
  extractPoolKeywords,
  searchRelatedSegments,
  searchCompactionOriginal,
  listMarked,
  loadMarks,
  setMark,
  updateMark,
  findMessagesByIds,
  contentKey,
  // 特殊事件结构化识别与注入窗口过滤（供 context-compactor / server 复用同一口径）
  messageTime,
  currentWindowStartMs,
  isSpecialEvent,
  isDiaryEvent
};
