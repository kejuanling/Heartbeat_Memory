"use strict";

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(__dirname, "data");
const MEMORIES_FILE = path.join(DATA_DIR, "memories.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const RRF_K = Number(process.env.RRF_K_CONSTANT) || 60;

let memories = [];
let config = {};
let embedder = null;
let embedderLoading = false;
let flushTimer = null;
let dirty = false;
let pendingMessages = [];
let pinnedMemories = [];

// 只读模式：wake-up 与 gateway 共享同一批数据文件，但只允许 gateway 写盘；
// 开启后本进程的内存改动不落盘，避免双进程互相覆盖/丢数据
const READONLY = process.env.MEMORY_ENGINE_READONLY === "1" || process.env.EMBEDDING_MODE === "disabled";

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
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PINNED_FILE = path.join(DATA_DIR, "pinned.json");

async function init() {
  await fs.ensureDir(DATA_DIR);
  try {
    const raw = await fs.readJson(MEMORIES_FILE);
    memories = Array.isArray(raw) ? raw : [];
  } catch { memories = []; }
  const DEFAULT_CONFIG = { idle_threshold_minutes: 5, max_interval_minutes: 30, auto_summary_enabled: true, memory_retrieval_enabled: true, retrieval_top_k: 5, dedup_threshold: 0.9, conflict_threshold: 0.85, min_fact_count: 2, min_summary_count: 2, time_decay_days: 30, keyword_search_enabled: true, embedding_model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", memory_relevance_threshold: 0.3, memory_query_window: 3, memory_cooldown_minutes: 30, memory_item_cooldown_minutes: 120, summary_surfacing_min_age_hours: 24, summary_surfacing_min_age_enabled: true, time_injection_enabled: true, time_tag_interval_minutes: 30, wake_query_window: 3, wake_relevance_threshold: 0.3, wake_repeat_window: 3, memory_persist_on_surface_enabled: false };
  try {
    config = { ...DEFAULT_CONFIG, ...(await fs.readJson(CONFIG_FILE)) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  if (process.env.EMBEDDING_MODE !== "disabled") {
    embedderLoading = true;
    loadEmbeddingModel().catch(err => {
      console.warn("[memory-engine] 嵌入模型加载失败，降级为关键词检索:", err.message);
      embedder = null;
    }).finally(() => { embedderLoading = false; });
  }
  flushTimer = setInterval(flush, 5000);
  if (READONLY) {
    console.log("[memory-engine] 只读模式：记忆/状态由 gateway 进程负责写盘");
  } else {
    restorePendingMessages().catch(() => {});
  }
  try {
    const rawPinned = await fs.readJson(PINNED_FILE);
    pinnedMemories = Array.isArray(rawPinned) ? rawPinned : [];
  } catch { pinnedMemories = []; }
}

async function loadEmbeddingModel() {
  const apiUrl = process.env.EMBEDDING_API_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  if (apiUrl) {
    embedder = { type: "api", url: apiUrl, key: apiKey, dims: 384 };
    console.log("[memory-engine] 使用 API 嵌入服务:", apiUrl);
    return;
  }
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    env.remoteHost = "https://hf-mirror.com/";
    const modelName = config.embedding_model || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
    console.log("[memory-engine] 加载本地嵌入模型:", modelName);
    const pipe = await pipeline("feature-extraction", modelName, { quantized: true });
    embedder = { type: "local", pipe, dims: 384 };
    console.log("[memory-engine] 本地嵌入模型就绪");
  } catch (err) {
    throw new Error("transformers 加载失败: " + err.message);
  }
}

async function getEmbedding(text) {
  if (!embedder) return null;
  try {
    if (embedder.type === "api") {
      const res = await fetch(embedder.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(embedder.key ? { Authorization: "Bearer " + embedder.key } : {})
        },
        body: JSON.stringify({ input: text, model: "text-embedding-ada-002" })
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.data?.[0]?.embedding || data.embedding || null;
    }
    if (embedder.type === "local") {
      const output = await embedder.pipe(text, { pooling: "mean", normalize: true });
      return Array.from(output.data);
    }
  } catch (err) {
    console.warn("[memory-engine] 向量生成失败:", err.message);
  }
  return null;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function tokenize(text) {
  return (text || "").toLowerCase().split(/[\s,，。！？、；：""''（）()\n\r\t]+/).filter(Boolean);
}

function buildBM25Index(docs) {
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + tokenize(d.content).length, 0) / Math.max(N, 1);
  const df = {};
  docs.forEach(d => {
    const terms = new Set(tokenize(d.content));
    terms.forEach(t => { df[t] = (df[t] || 0) + 1; });
  });
  return { N, avgdl, df };
}

function bm25Score(query, docContent, index) {
  const { N, avgdl, df } = index;
  const k1 = 1.5, b = 0.75;
  const docLen = tokenize(docContent).length;
  const qTerms = tokenize(query);
  let score = 0;
  const seen = new Set();
  for (const t of qTerms) {
    if (seen.has(t)) continue;
    seen.add(t);
    const idf = Math.log((N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5) + 1);
    const tf = tokenize(docContent).filter(w => w === t).length;
    score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgdl));
  }
  return score;
}

function rrfMerge(lists, k) {
  if (k === undefined) k = RRF_K;
  const scores = {};
  lists.forEach(list => {
    list.forEach((item, rank) => {
      const id = item.id;
      scores[id] = (scores[id] || 0) + 1 / (k + rank + 1);
    });
  });
  const allItems = {};
  lists.forEach(list => list.forEach(item => { allItems[item.id] = item; }));
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => allItems[id]);
}

function generateId() {
  return "mem_" + crypto.randomBytes(6).toString("hex");
}

async function addMemory(entry) {
  const { content, type, importance, source, time_range } = entry;
  if (!content || !type) return null;
  const embedPromise = getEmbedding(content);
  const sameTypeActive = memories.filter(m => m.type === type && m.active);
  // Exact text match dedup (before embedding check)
  const contentKey = content.trim();
  const exactDup = sameTypeActive.find(m => m.content.trim() === contentKey);
  if (exactDup) {
    exactDup.importance = Math.min(1.0, (exactDup.importance || 0.5) + 0.05);
    exactDup.timestamp = new Date().toISOString();
    if (source === "inline") exactDup.source = "inline";
    markDirty();
    return exactDup;
  }

  let embedding = await embedPromise;

  // Dedup check - returns early if duplicate found
  if (embedding) {
    for (const old of sameTypeActive) {
      if (!old.embedding) continue;
      const sim = cosineSimilarity(embedding, old.embedding);
      if (sim > (config.dedup_threshold || 0.9)) {
        old.importance = Math.min(1.0, (old.importance || 0.5) + 0.05);
        old.timestamp = new Date().toISOString();
        if (source === "inline") old.source = "inline";
        markDirty();
        return old;
      }
    }
  }

  // Define newMem BEFORE conflict/resolved checks that reference newMem.id
  const newMem = {
    id: generateId(),
    content,
    type,
    importance: Math.min(1, Math.max(0, importance || 0.5)),
    embedding: embedding || null,
    active: true,
    superseded_by: null,
    timestamp: new Date().toISOString(),
    source: source || "inline",
    time_range: time_range || null
  };

  // Conflict coverage (old memories get superseded)
  if (embedding && type !== "summary") {
    for (const old of sameTypeActive) {
      if (!old.embedding) continue;
      const sim = cosineSimilarity(embedding, old.embedding);
      if (sim > (config.conflict_threshold || 0.85)) {
        old.active = false;
        old.superseded_by = newMem.id;
        markDirty();
      }
    }
  }

  // Resolved coverage
  if (type === "resolved" && embedding) {
    const unresolved = memories.filter(m => m.type === "unresolved" && m.active);
    for (const old of unresolved) {
      if (!old.embedding) continue;
      const sim = cosineSimilarity(embedding, old.embedding);
      if (sim > 0.8) {
        old.active = false;
        old.superseded_by = newMem.id;
        markDirty();
      }
    }
  }

  memories.push(newMem);
  markDirty();
  return newMem;
}

async function search(query, topK, filters) {
  if (topK === undefined) topK = config.retrieval_top_k || 5;
  if (!filters) filters = {};
  const active = memories.filter(m => m.active !== false);
  let filtered = active;
  if (filters.types) filtered = filtered.filter(m => filters.types.includes(m.type));
  if (filters.source) filtered = filtered.filter(m => m.source === filters.source);
  if (filters.minImportance) filtered = filtered.filter(m => (m.importance || 0) >= filters.minImportance);
  if (filtered.length === 0) return [];
  let semanticResults = [];
  const queryEmbedding = await getEmbedding(query);
  if (queryEmbedding && embedder) {
    const scored = filtered
      .filter(m => m.embedding)
      .map(m => ({ ...m, _score: cosineSimilarity(queryEmbedding, m.embedding) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);
    semanticResults = scored;
  }
  let keywordResults = [];
  if (config.keyword_search_enabled !== false) {
    const index = buildBM25Index(filtered);
    const scored = filtered
      .map(m => ({ ...m, _score: bm25Score(query, m.content, index) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 10);
    keywordResults = scored;
  }
  const lists = [];
  if (semanticResults.length > 0) lists.push(semanticResults);
  if (keywordResults.length > 0) lists.push(keywordResults);
  let results;
  if (lists.length >= 2) {
    results = rrfMerge(lists);
  } else if (lists.length === 1) {
    results = lists[0];
  } else {
    results = filtered.sort(() => Math.random() - 0.5).slice(0, topK);
  }
  const now = Date.now();
  const decayDays = config.time_decay_days || 30;
  const decayMs = decayDays * 24 * 60 * 60 * 1000;
  results = results.map(m => {
    let score = m._score || 0.5;
    if (m.type === "summary" && m.timestamp) {
      const age = now - new Date(m.timestamp).getTime();
      if (age > decayMs) score *= 0.7;
    }
    return { ...m, _score: score };
  });
  return results.slice(0, topK);
}

async function buildContext(query, opts = {}) {
  const topK = opts.topK || config.retrieval_top_k || 5;
  const totalLimit = opts.totalLimit || topK;
  const randomCount = opts.randomCount || 0;
  const minImportance = opts.minImportance || 0;
  const threshold = opts.threshold || 0;
  const excludeIds = opts.excludeIds || null;
  
  // 并行检索所有类型，不做硬性配额
  const allTypes = opts.types || ["fact", "preference", "emotion", "unresolved", "summary", "moment", "trace", "note"];
  const searchPromises = allTypes.map(type => search(query, topK, { types: [type], minImportance }));
  const resultsByType = await Promise.all(searchPromises);
  
  // 合并所有候选并去重
  const seen = new Set();
  let allCandidates = [];
  for (const typeResults of resultsByType) {
    for (const m of typeResults) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        allCandidates.push(m);
      }
    }
  }
  
  // 按相关性得分排序
  allCandidates.sort((a, b) => (b._score || 0) - (a._score || 0));
  // 可选阈值过滤：只过滤检索结果（随机记忆在阈值过滤后追加，不受影响）
  if (threshold > 0) {
    allCandidates = allCandidates.filter(mm => (mm._score || 0) >= threshold);
  }
  // 排除指定记忆（如最近几次唤醒已看过的），避免同一批反复出现
  if (excludeIds) {
    allCandidates = allCandidates.filter(mm => !excludeIds.has(mm.id));
  }
  // 近期摘要覆盖的对话通常还在上下文窗口中，聊天时再浮现属于重复。
  // 通过 minSummaryAgeHours（小时）排除"太新"的摘要；唤醒等无上下文场景不传该参数，不受影响。
  if (opts.minSummaryAgeHours > 0) {
    const cutoff = Date.now() - opts.minSummaryAgeHours * 3600 * 1000;
    allCandidates = allCandidates.filter(mm => {
      if (mm.type !== "summary") return true;
      if (!mm.timestamp) return true;
      return new Date(mm.timestamp).getTime() < cutoff;
    });
  }
  let result = allCandidates.slice(0, totalLimit);
  
  // 注入随机记忆（用于唤醒等场景，拓宽视野）
  if (randomCount > 0 && memories.length > 0) {
    const existingIds = new Set(result.map(m => m.id));
    const candidates = memories.filter(m => !existingIds.has(m.id) && m.active !== false && (!excludeIds || !excludeIds.has(m.id)));
    const shuffled = candidates.sort(() => Math.random() - 0.5);
    const randomPicks = shuffled.slice(0, randomCount).map(m => ({
      ...m,
      _score: Math.max(0.1, m._score || 0.1)
    }));
    result = result.concat(randomPicks);
  }
  
  return result;
}

function formatContext(memories) {
  if (!memories || memories.length === 0) return "";
  const lines = memories.map(m => {
    // 时间标签已移除：记忆内容本身自带日期时间，避免冗余的动态相对时间
    const prefixMap = { fact: "此刻想起", preference: "此刻想起", emotion: "此刻想起", unresolved: "此刻想起", resolved: "此刻想起", summary: "此刻想起", moment: "那些时刻", trace: "走过的路", note: "走过的路" };
    const prefix = prefixMap[m.type] || "此刻想起";
    return "[" + prefix + "] " + m.content;
  });
  return lines.join("\n");
}

function markDirty() { dirty = true; }


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
    await atomicWriteJson(MEMORIES_FILE, memories);
    dirty = false;
  } catch (err) {
    console.error("[memory-engine] 刷盘失败:", err.message);
  }
}

async function shutdown() {
  if (flushTimer) clearInterval(flushTimer);
  await flush();
}

function getMemories(filters) {
  if (!filters) filters = {};
  let result = [...memories];
  if (filters.types) result = result.filter(m => filters.types.includes(m.type));
  if (filters.active !== undefined) result = result.filter(m => m.active === filters.active);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(m => m.content.toLowerCase().includes(q));
  }
  // Sorting
  const sortBy = filters.sortBy || "newest";
  if (sortBy === "newest") {
    result.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  } else if (sortBy === "oldest") {
    result.sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime());
  } else if (sortBy === "importance") {
    result.sort((a, b) => (b.importance || 0) - (a.importance || 0));
  }
  if (filters.page && filters.pageSize) {
    const start = (filters.page - 1) * filters.pageSize;
    result = result.slice(start, start + filters.pageSize);
  }
  return result;
}

function getMemoryById(id) { return memories.find(m => m.id === id) || null; }

async function updateMemory(id, updates) {
  const mem = memories.find(m => m.id === id);
  if (!mem) return false;
  if (updates.content !== undefined) {
    mem.content = updates.content;
    // 内容变更后重新生成向量，避免语义检索继续使用旧向量
    try {
      const emb = await getEmbedding(updates.content);
      if (emb) mem.embedding = emb;
    } catch (err) {
      console.warn("[memory-engine] 更新向量失败:", err.message);
    }
  }
  if (updates.importance !== undefined) mem.importance = updates.importance;
  if (updates.type !== undefined) mem.type = updates.type;
  if (updates.active !== undefined) mem.active = updates.active;
  markDirty();
  return true;
}

function deleteMemory(id) {
  const mem = memories.find(m => m.id === id);
  if (!mem) return false;
  mem.active = false;
  markDirty();
  return true;
}

function getStats() {
  const active = memories.filter(m => m.active);
  const total = memories.length;
  const typeCount = {};
  memories.forEach(m => { typeCount[m.type] = (typeCount[m.type] || 0) + 1; });
  // Compute similar group count (threshold 0.6)
  const similarClusters = findSimilarMemories(0.6);
  const similarCount = similarClusters.reduce((sum, c) => sum + c.count, 0);
  return { total, active: active.length, byType: typeCount, similarCount, similarGroups: similarClusters.length };
}

// ========================
// 状态管理（供 summary-engine 使用）
// ========================

function addPendingMessage(msg) {
  pendingMessages.push(msg);
  persistPendingMessages();
}

function getPendingMessages() {
  return pendingMessages;
}

function setLastSummaryTime(time) {
  lastSummaryTime = time;
  if (READONLY) return;
  // 持久化到 state.json
  try {
    const state = fs.readJsonSync(STATE_FILE, { throws: false }) || {};
    state.last_summary_time = time;
    atomicWriteJsonSync(STATE_FILE, state);
  } catch (err) {
    console.warn("[memory-engine] 持久化 last_summary_time 失败:", err.message);
  }
}

function setSummaryRunning(val) {
  isSummaryRunning = val;
  if (READONLY) return;
  // 持久化到 state.json
  try {
    const state = fs.readJsonSync(STATE_FILE, { throws: false }) || {};
    state.is_summary_running = val;
    atomicWriteJsonSync(STATE_FILE, state);
  } catch (err) {
    console.warn("[memory-engine] 持久化 is_summary_running 失败:", err.message);
  }
}

// 持久化 pending_messages 到 state.json
function persistPendingMessages() {
  if (READONLY) return;
  try {
    const state = fs.readJsonSync(STATE_FILE, { throws: false }) || {};
    state.pending_messages = pendingMessages;
    atomicWriteJsonSync(STATE_FILE, state);
  } catch (err) {
    console.warn("[memory-engine] 持久化 pending_messages 失败:", err.message);
  }
}

// 在 init 中恢复 pending_messages
async function restorePendingMessages() {
  try {
    const state = await fs.readJson(STATE_FILE);
    if (Array.isArray(state.pending_messages)) {
      pendingMessages = state.pending_messages;
      console.log("[memory-engine] 恢复 pending_messages:", pendingMessages.length, "条");
    }
  } catch {}
}

// 添加变量
let lastSummaryTime = null;
let isSummaryRunning = false;


// 查找相似记忆 - 基于 embedding 余弦相似度聚类
function findSimilarMemories(threshold = 0.6) {
  const active = memories.filter(m => m.active);
  const charSets = active.map(m => ({
    id: m.id,
    chars: new Set(m.content.split('')),
    mem: m
  }));

  // Phase 1: 基于字符重叠度的聚类
  const clusters = [];
  const used = new Set();

  for (let i = 0; i < charSets.length; i++) {
    if (used.has(charSets[i].id)) continue;
    const cluster = [charSets[i]];
    used.add(charSets[i].id);
    const baseChars = charSets[i].chars;

    for (let j = i + 1; j < charSets.length; j++) {
      if (used.has(charSets[j].id)) continue;
      const intersection = [...baseChars].filter(c => charSets[j].chars.has(c));
      const overlap = intersection.length / Math.min(baseChars.size, charSets[j].chars.size);
      if (overlap >= threshold) {
        cluster.push(charSets[j]);
        used.add(charSets[j].id);
      }
    }

    if (cluster.length >= 2) {
      const members = cluster.map(cs => ({
        id: cs.mem.id,
        content: cs.mem.content,
        type: cs.mem.type,
        importance: cs.mem.importance,
        timestamp: cs.mem.timestamp,
        active: cs.mem.active
      }));
      const allContents = members.map(m => m.content.trim());
      const uniqueContents = new Set(allContents);
      clusters.push({
        members,
        count: cluster.length,
        type: cluster[0].mem.type,
        exact: uniqueContents.size === 1
      });
    }
  }

  // Phase 2: 检测纯文本完全相同的重复（不依赖字符重叠度）
  const textMap = {};
  for (const m of active) {
    const key = m.content.trim();
    if (!textMap[key]) textMap[key] = [];
    textMap[key].push(m);
  }
  const exactClusters = [];
  for (const [text, group] of Object.entries(textMap)) {
    if (group.length >= 2) {
      const alreadyCaptured = clusters.some(c =>
        c.members.some(m => m.content.trim() === text)
      );
      if (!alreadyCaptured) {
        exactClusters.push({
          members: group.map(m => ({
            id: m.id,
            content: m.content,
            type: m.type,
            importance: m.importance,
            timestamp: m.timestamp,
            active: m.active
          })),
          count: group.length,
          type: group[0].type,
          exact: true
        });
      }
    }
  }

  return [...exactClusters, ...clusters];
}





module.exports = {
  init, shutdown, addMemory, search, buildContext, formatContext,
  markDirty,
  getMemories, getMemoryById, updateMemory, deleteMemory, getStats, findSimilarMemories,
  get config() { return config; },
  addPendingMessage,
  getPendingMessages,
  persistPendingMessages,
  setLastSummaryTime,
  setSummaryRunning,
  getConfig() { return config; },
  get memories() { return memories; },
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
