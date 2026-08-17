"use strict";

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(__dirname, "data");
const MEMORIES_FILE = path.join(DATA_DIR, "memories.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PINNED_FILE = path.join(DATA_DIR, "pinned.json");

let config = {};
let pinnedMemories = [];
let flushTimer = null;
let dirty = false;

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

const DEFAULT_CONFIG = { idle_threshold_minutes: 5, max_interval_minutes: 30, auto_summary_enabled: true, summary_max_messages: 50, memory_retrieval_enabled: true, retrieval_top_k: 5, dedup_threshold: 0.9, conflict_threshold: 0.85, time_decay_days: 30, keyword_search_enabled: true, embedding_enabled: false, embedding_model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", co_vision_api_url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", co_vision_api_key: "", co_vision_model: "glm-4v-flash", co_frame_interval: 30, memory_relevance_threshold: 0.3, memory_query_window: 3, memory_retrieval_window_days: 0, context_injection_types: ["fact", "preference", "emotion", "summary", "moment"], memory_cooldown_minutes: 30, memory_item_cooldown_minutes: 120, summary_surfacing_min_age_hours: 24, summary_surfacing_min_age_enabled: true, summary_event_injection_enabled: false, summary_event_inject_enabled: true, summary_event_short_ctx_msgs: 20, time_injection_enabled: true, time_tag_interval_minutes: 30, time_event_injection_enabled: false, timeline_event_window_days: 7, wake_query_window: 3, wake_relevance_threshold: 0.3, wake_repeat_window: 3, wake_history_max_messages: 500, wake_context_compaction_enabled: false, memory_persist_on_surface_enabled: false, summary_enabled: true, moment_sync_enabled: true, screenshot_wake_enabled: false, vision_models: [], co_vision_model_id: "", screenshot_vision_model_id: "" };

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
  flushTimer = setInterval(flush, 5000);
  if (READONLY) {
    console.log("[memory-engine] 只读模式：pin/状态由 gateway 进程负责写盘");
  }
}

// ========================
// Pinned Memories (永久注入上下文)
// ========================

async function addPinnedMemory(entry) {
  const { title, content, order } = entry;
  if (!content) return null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const mem = {
    id,
    title: title || '',
    content,
    order: order || pinnedMemories.length,
    created_at: now,
    updated_at: now
  };
  pinnedMemories.push(mem);
  await fs.writeJson(PINNED_FILE, pinnedMemories, { spaces: 2 });
  return mem;
}

async function updatePinnedMemory(id, updates) {
  const idx = pinnedMemories.findIndex(m => m.id === id);
  if (idx === -1) return null;
  pinnedMemories[idx] = { ...pinnedMemories[idx], ...updates, updated_at: new Date().toISOString() };
  await atomicWriteJson(PINNED_FILE, pinnedMemories);
  return pinnedMemories[idx];
}

async function deletePinnedMemory(id) {
  const before = pinnedMemories.length;
  pinnedMemories = pinnedMemories.filter(m => m.id !== id);
  if (pinnedMemories.length < before) {
    await atomicWriteJson(PINNED_FILE, pinnedMemories);
    return true;
  }
  return false;
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

async function flush() {
  if (READONLY) return;
  if (!dirty) return;
  try {
    await atomicWriteJson(PINNED_FILE, pinnedMemories);
    dirty = false;
  } catch (err) {
    console.error("[memory-engine] 刷盘失败:", err.message);
  }
}

async function shutdown() {
  if (flushTimer) clearInterval(flushTimer);
  await flush();
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

function loadLegacyMemories() {
  try {
    const raw = fs.readJsonSync(MEMORIES_FILE);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function getMemoryKeywords(limit) {
  if (limit === undefined) limit = 80;
  const memories = loadLegacyMemories();
  const counts = new Map();
  let totalMem = 0;
  for (const m of memories) {
    if (m.active === false) continue;
    totalMem++;
    const imp = Math.max(0.3, m.importance || 0.5);
    const seen = new Set();
    for (const w of extractKeywordsFromText(m.content)) {
      if (seen.has(w)) continue;
      seen.add(w);
      const cur = counts.get(w) || { count: 0, weight: 0 };
      cur.count += 1;
      cur.weight += imp;
      counts.set(w, cur);
    }
  }
  const N = Math.max(2, totalMem);
  return Array.from(counts.entries())
    .filter(([w, c]) => c.count >= 2 && w.length >= 2 && !KEYWORD_STOP_WORDS.has(w))
    .map(([word, c]) => ({
      word,
      count: c.count,
      weight: Math.round(c.weight * Math.log(N / c.count) * 10) / 10
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count)
    .slice(0, limit);
}

function getStats() {
  const memories = loadLegacyMemories();
  const active = memories.filter(m => m.active);
  const typeCount = {};
  memories.forEach(m => { typeCount[m.type] = (typeCount[m.type] || 0) + 1; });
  return { total: memories.length, active: active.length, byType: typeCount, similarCount: 0, similarGroups: 0 };
}

module.exports = {
  init, shutdown, getStats, getMemoryKeywords,
  extractKeywordsFromText, KEYWORD_STOP_WORDS,
  get config() { return config; },
  getConfig() { return config; },
  get memories() { return loadLegacyMemories(); },
  addPinnedMemory, updatePinnedMemory, deletePinnedMemory, getPinnedMemories, buildPinnedContext,
  async updateConfig(updates) {
    Object.assign(config, updates);
    await atomicWriteJson(CONFIG_FILE, config);
  },
  async refreshConfig() {
    try {
      Object.assign(config, await fs.readJson(CONFIG_FILE));
    } catch (err) {
      // 读取失败时保持现有配置
    }
  }
};
