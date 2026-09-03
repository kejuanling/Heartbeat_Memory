"use strict";

const fs = require("fs-extra");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(__dirname, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PINNED_FILE = path.join(DATA_DIR, "pinned.json");
const DELETED_PINS_FILE = path.join(DATA_DIR, "deleted_pins.json");

let config = {};
let pinnedMemories = [];
let deletedPinSignatures = new Set();

// 只读模式：wake-up 与 gateway 共享同一批数据文件，但只允许 gateway 写盘
const READONLY = process.env.MEMORY_ENGINE_READONLY === "1";

function atomicWriteJsonSync(file, data) {
  const tmp = file + ".tmp";
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, file);
}

async function atomicWriteJson(file, data) {
  const tmp = file + ".tmp";
  await fs.writeJson(tmp, data, { spaces: 2 });
  await fs.rename(tmp, file);
}

const DEFAULT_CONFIG = { idle_threshold_minutes: 5, max_interval_minutes: 30, auto_summary_enabled: true, summary_max_messages: 50, memory_retrieval_enabled: true, retrieval_top_k: 5, dedup_threshold: 0.9, conflict_threshold: 0.85, time_decay_days: 30, keyword_search_enabled: true, embedding_enabled: false, embedding_model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", co_vision_api_url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", co_vision_api_key: "", co_vision_model: "glm-4v-flash", co_frame_interval: 30, memory_relevance_threshold: 0.3, memory_query_window: 3, memory_retrieval_window_days: 0, context_injection_types: ["fact", "preference", "emotion", "summary", "moment"], memory_cooldown_minutes: 30, memory_item_cooldown_minutes: 120, summary_surfacing_min_age_hours: 24, summary_surfacing_min_age_enabled: true, summary_event_injection_enabled: false, summary_event_inject_enabled: true, summary_event_short_ctx_msgs: 20, time_event_injection_enabled: false, wake_query_window: 3, wake_relevance_threshold: 0.3, wake_repeat_window: 3, wake_history_max_messages: 100, wake_context_compaction_enabled: false, memory_persist_on_surface_enabled: false, summary_enabled: true, moment_sync_enabled: true, screenshot_wake_enabled: false, vision_models: [], co_vision_model_id: "", screenshot_vision_model_id: "", keep_recent_image_turns: 8, event_inject_types: ["wake","diary","push","summary","co","screenshot"] };

async function init() {
  await fs.ensureDir(DATA_DIR);
  try {
    config = { ...DEFAULT_CONFIG, ...(await fs.readJson(CONFIG_FILE)) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  try {
    const rawPinned = await fs.readJson(PINNED_FILE);
    pinnedMemories = Array.isArray(rawPinned) ? rawPinned : [];
  } catch { pinnedMemories = []; }
  await loadDeletedSignatures();
  if (READONLY) {
    console.log("[memory-engine] 只读模式：pin/状态由 gateway 进程负责写盘");
    // 只读进程（wake_up）周期性从磁盘重载 pinned，避免 gateway 更新 pinned.json 后本进程长期用旧缓存
    setInterval(async function () {
      try {
        const rawPinned = await fs.readJson(PINNED_FILE);
        pinnedMemories = Array.isArray(rawPinned) ? rawPinned : [];
      } catch (e) { /* 文件暂时不可读则保持现状 */ }
    }, 30000).unref();
  }
}

// ========================
// Pinned Memories (永久注入上下文)
// ========================

function contentSignature(content) {
  return String(content || "").trim();
}

function withPinnedLock(fn, timeoutMs) {
  if (timeoutMs === undefined) timeoutMs = 8000;
  const lockFile = PINNED_FILE + ".lock";
  const start = Date.now();
  return (async () => {
    for (;;) {
      let fd = null;
      try {
        try { fd = await fsp.open(lockFile, "wx"); } catch (e) { if (e.code !== "EEXIST") throw e; }
        if (fd) { await fd.close(); break; }
        if (Date.now() - start > timeoutMs) {
          try { await fsp.unlink(lockFile); } catch (e) {}
          continue;
        }
        await new Promise(r => setTimeout(r, 40));
      } catch (err) { throw err; }
    }
    try { return await fn(); } finally { try { await fsp.unlink(lockFile); } catch (e) {} }
  })();
}

async function loadPinnedFromDisk() {
  try {
    const raw = await fs.readJson(PINNED_FILE);
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

async function loadDeletedSignatures() {
  try {
    const raw = await fs.readJson(DELETED_PINS_FILE);
    deletedPinSignatures = new Set(Array.isArray(raw) ? raw : []);
  } catch (e) { deletedPinSignatures = new Set(); }
}

async function saveDeletedSignatures() {
  await atomicWriteJson(DELETED_PINS_FILE, Array.from(deletedPinSignatures).slice(-400));
}

async function addPinnedMemory(entry, opts) {
  if (READONLY) { console.warn("[memory-engine] 只读模式，忽略新增 pin"); return null; }
  const { title, content } = entry;
  if (!content) return null;
  const sig = contentSignature(content);
  const allowDeleted = !!(opts && opts.allowDeleted);
  return withPinnedLock(async () => {
    const fresh = await loadPinnedFromDisk();
    pinnedMemories = fresh;
    const dup = fresh.some(function(m) { return contentSignature(m.content) === sig; });
    if (dup) return null;
    if (!allowDeleted && deletedPinSignatures.has(sig)) { return null; }
    if (allowDeleted && deletedPinSignatures.delete(sig)) { await saveDeletedSignatures(); }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const ord = (entry.order !== undefined && entry.order !== null) ? entry.order : fresh.length;
    const mem = { id: id, title: title || '', content: content, order: ord, created_at: now, updated_at: now };
    fresh.push(mem);
    pinnedMemories = fresh;
    await atomicWriteJson(PINNED_FILE, fresh);
    return mem;
  });
}

async function updatePinnedMemory(id, updates) {
  if (READONLY) { console.warn("[memory-engine] 只读模式，忽略更新 pin"); return null; }
  return withPinnedLock(async () => {
    const fresh = await loadPinnedFromDisk();
    pinnedMemories = fresh;
    const idx = fresh.findIndex(function(m) { return m.id === id; });
    if (idx === -1) return null;
    fresh[idx] = Object.assign({}, fresh[idx], updates, { updated_at: new Date().toISOString() });
    pinnedMemories = fresh;
    await atomicWriteJson(PINNED_FILE, fresh);
    return fresh[idx];
  });
}

async function deletePinnedMemory(id) {
  if (READONLY) { console.warn("[memory-engine] 只读模式，忽略删除 pin"); return false; }
  return withPinnedLock(async () => {
    const fresh = await loadPinnedFromDisk();
    pinnedMemories = fresh;
    const before = fresh.length;
    const removed = fresh.filter(function(m) { return m.id === id; });
    pinnedMemories = fresh.filter(function(m) { return m.id !== id; });
    if (pinnedMemories.length < before) {
      removed.forEach(function(m) { deletedPinSignatures.add(contentSignature(m.content || '')); });
      await atomicWriteJson(PINNED_FILE, pinnedMemories);
      await saveDeletedSignatures();
      return true;
    }
    return false;
  });
}
async function reorderPinnedMemory(ids) {
  if (READONLY) { console.warn("[memory-engine] 只读模式，忽略重排 pin"); return null; }
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return withPinnedLock(async () => {
    const fresh = await loadPinnedFromDisk();
    const byId = new Map();
    fresh.forEach(function(m) { byId.set(m.id, m); });
    const next = [];
    const seen = new Set();
    // 优先按传入顺序排列已存在 id
    ids.forEach(function(id) {
      if (byId.has(id) && !seen.has(id)) { next.push(byId.get(id)); seen.add(id); }
    });
    // 追加未在 ids 中的条目（保证不丢数据）
    fresh.forEach(function(m) { if (!seen.has(m.id)) { next.push(m); seen.add(m.id); } });
    next.forEach(function(m, i) { m.order = i; });
    pinnedMemories = next;
    await atomicWriteJson(PINNED_FILE, next);
    return next;
  });
}

function getPinnedMemories() {
  return pinnedMemories.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}

function buildPinnedContext() {
  if (!pinnedMemories.length) return '';
  const sorted = pinnedMemories.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  return sorted.map(m => {
    const title = m.title ? `【${m.title}】` : '';
    return `${title}${m.content}`;
  }).join('\n');
}

// 旧 flush/flushTimer 刷盘机制已移除：pin 写盘均为即时 atomicWriteJson，无延迟刷盘需求。
async function shutdown() {
}

// ========================
// 词云关键词提取（管理台词云卡片用）
// 第二阶段：改为按上下文源文件匹配关键词；当前暂用旧记忆池备份数据
// ========================
const KEYWORD_SPLIT = "[的了我是你他它她在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到]";

const KEYWORD_LABEL_RE = /^(?:触发|分叉|我的选择|我的判断|我的感受|她的反应|感受|回响|依据)[：:]\s*/gm;
const KEYWORD_STOP_WORDS = new Set([
  "触发", "判断", "选择", "分叉", "感受", "回响", "依据",
  "其实", "继续", "告诉", "回答", "答案", "问题", "任何", "开始", "变成", "证明",
  "本身", "之间", "每一", "直接", "真正", "愿意", "定义", "完整", "理由", "一步",
  "瞬间", "顺着", "条件", "分析", "事情", "句话", "带着", "指出", "反复", "决定",
  "话题", "模式", "记住", "希望", "立刻", "位置", "期待", "慢慢", "形状", "回避",
  "否认", "否定", "动作", "人类", "即使", "第一", "第三", "具体", "意继", "那个",
  "这样", "那样", "什么", "怎么", "时候", "东西", "知道", "觉得", "应该", "可以",
  "已经", "看到", "听到", "想到", "没有", "不是", "就是", "不会", "不能", "还有",
  "一直", "刚才", "一句", "确实", "地方", "方式", "开口", "重新"
]);

function extractKeywordsFromText(text) {
  const words = [];
  const raw = String(text || "").replace(KEYWORD_LABEL_RE, "");
  const quoted = raw.match(/[\u300a\u300c\u201c\u201c\u3010\u300e]([^\u300b\u300d\u201d\u201d\u3011\u300f]{2,14})[\u300b\u300d\u201d\u201d\u3011\u300f]/g) || [];
  for (const q of quoted) {
    const w = q.replace(/[\u300a\u300c\u201c\u201c\u3010\u300e\u300b\u300d\u201d\u201d\u3011\u300f]/g, "").trim();
    if (w.length >= 2 && w.length <= 8) words.push(w);
  }
  const runs = raw.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    const parts = run.split(new RegExp(KEYWORD_SPLIT)).filter(p => p.length >= 2);
    for (const part of parts) {
      if (part.length <= 4) words.push(part);
      else {
        for (let i = 0; i <= part.length - 2; i++) words.push(part.slice(i, i + 2));
      }
    }
  }
  return words;
}

module.exports = {
  init, shutdown,
  extractKeywordsFromText, KEYWORD_STOP_WORDS,
  get config() { return config; },
  getConfig() { return config; },
  addPinnedMemory, updatePinnedMemory, deletePinnedMemory, reorderPinnedMemory, getPinnedMemories, buildPinnedContext,
  async updateConfig(updates) {
    Object.assign(config, updates);
    await atomicWriteJson(CONFIG_FILE, config);
  }
};
