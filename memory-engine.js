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
  const DEFAULT_CONFIG = { idle_threshold_minutes: 5, max_interval_minutes: 30, auto_summary_enabled: true, memory_retrieval_enabled: true, retrieval_top_k: 5, dedup_threshold: 0.9, conflict_threshold: 0.85, time_decay_days: 30, keyword_search_enabled: true, embedding_model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", memory_relevance_threshold: 0.3, memory_query_window: 3, memory_retrieval_window_days: 0, context_injection_types: ["fact", "preference", "emotion", "summary", "moment"], memory_cooldown_minutes: 30, memory_item_cooldown_minutes: 120, summary_surfacing_min_age_hours: 24, summary_surfacing_min_age_enabled: true, summary_event_injection_enabled: false, summary_event_inject_enabled: true, summary_event_short_ctx_msgs: 20, time_injection_enabled: true, time_tag_interval_minutes: 30, time_event_injection_enabled: false, timeline_event_window_days: 7, wake_query_window: 3, wake_relevance_threshold: 0.3, wake_repeat_window: 3, memory_persist_on_surface_enabled: false, summary_enabled: true, moment_sync_enabled: true };
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
  const { content, type, importance, source, time_range, skipDedup } = entry;
  if (!content || !type) return null;
  const embedPromise = getEmbedding(content);
  const sameTypeActive = memories.filter(m => m.type === type && m.active);
  // Exact text match dedup (before embedding check)
  const contentKey = content.trim();
  const exactDup = sameTypeActive.find(m => m.content.trim() === contentKey);
  if (exactDup && !skipDedup) {
    exactDup.importance = Math.min(1.0, (exactDup.importance || 0.5) + 0.05);
    exactDup.timestamp = new Date().toISOString();
    if (source === "inline") exactDup.source = "inline";
    markDirty();
    return exactDup;
  }

  let embedding = await embedPromise;

  // Dedup check - returns early if duplicate found
  if (embedding && !skipDedup) {
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
    timestamp: entry.timestamp || new Date().toISOString(),
    source: source || "inline",
    time_range: time_range || null,
    ...(entry.source_moment_id !== undefined ? { source_moment_id: entry.source_moment_id } : {}),
    ...(entry.source_decision_id !== undefined ? { source_decision_id: entry.source_decision_id } : {})
  };

  // Conflict coverage (old memories get superseded)
  if (embedding && type !== "summary" && !skipDedup) {
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
  // 记忆只看最近 N 天：只对「日常分类」生效（决策痕迹 emotion 不受时间窗口限制）
  const retrievalWindowDays = Number(config.memory_retrieval_window_days) || 0;
  const inRetrievalWindow = (mm) => {
    if (retrievalWindowDays <= 0) return true;
    if (mm.type === "emotion") return true;
    if (!mm.timestamp) return true;
    return new Date(mm.timestamp).getTime() >= Date.now() - retrievalWindowDays * 24 * 60 * 60 * 1000;
  };
  
  // 并行检索所有类型，不做硬性配额
  const allTypes = opts.types || ["fact", "preference", "emotion", "summary", "moment"];
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
  // 记忆检索时间窗口：超期「日常」记忆不注入（决策痕迹除外）
  allCandidates = allCandidates.filter(inRetrievalWindow);
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
    const typeSet = new Set(allTypes);
    const candidates = memories.filter(m => !existingIds.has(m.id) && m.active !== false && (!excludeIds || !excludeIds.has(m.id)) && typeSet.has(m.type) && inRetrievalWindow(m));
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
    const prefixMap = { fact: "此刻想起", preference: "此刻想起", emotion: "那些选择", summary: "此刻想起", moment: "那些时刻" };
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
  if (updates.active !== undefined) {
    mem.active = updates.active;
    // 恢复为活跃时清除“被覆盖”标记，避免数据状态自相矛盾
    if (updates.active === true && mem.superseded_by) mem.superseded_by = null;
  }
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

// 物理删除：直接从记忆池移除（不可恢复）
function purgeMemory(id) {
  const idx = memories.findIndex(m => m.id === id);
  if (idx === -1) return false;
  memories.splice(idx, 1);
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

// ========================
// 词云关键词提取（管理台词云卡片用；按关键词+重要度加权统计活跃记忆）
// ========================
const KEYWORD_SPLIT = "[的了我是你他它她在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到]";

// 决策痕迹五段式模板前缀与结构性用词：不进入词云
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
  // 引号/书名号内的短语整体作为关键词
  const quoted = raw.match(/[\u300a\u300c\u201c\u201c\u3010\u300e]([^\u300b\u300d\u201d\u201d\u3011\u300f]{2,14})[\u300b\u300d\u201d\u201d\u3011\u300f]/g) || [];
  for (const q of quoted) {
    const w = q.replace(/[\u300a\u300c\u201c\u201c\u3010\u300e\u300b\u300d\u201d\u201d\u3011\u300f]/g, "").trim();
    if (w.length >= 2 && w.length <= 8) words.push(w);
  }
  // 连续汉字串按停用字切分，取 2-4 字词；长段取相邻两字
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

// 单条记忆的关键词标签提取：比词云版更收敛，避免长串切成大量无意义双字碎片
function extractKeywordsForTags(text) {
  const words = [];
  const raw = String(text || "").replace(KEYWORD_LABEL_RE, "");
  // 引号/书名号内的短语整体作为关键词（最可信）
  const quoted = raw.match(/[\u300a\u300c\u201c\u3010\u300e]([^\u300b\u300d\u201d\u3011\u300f]{2,10})[\u300b\u300d\u201d\u3011\u300f]/g) || [];
  for (const q of quoted) {
    const w = q.replace(/[\u300a\u300c\u201c\u3010\u300e\u300b\u300d\u201d\u3011\u300f]/g, "").trim();
    if (w.length >= 2) words.push(w);
  }
  const runs = raw.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    const parts = run.split(new RegExp(KEYWORD_SPLIT)).filter(p => p.length >= 2);
    for (const part of parts) {
      if (part.length <= 4) { words.push(part); continue; }
      // 长串：先按连接词二次切分，仍过长则只取首尾各 4 字核心
      const subs = part.split(/[与和或及以及并且]/).filter(p => p.length >= 2);
      for (const sub of subs) {
        if (sub.length <= 4) words.push(sub);
        else {
          words.push(sub.slice(0, 4));
          words.push(sub.slice(-4));
        }
      }
    }
  }
  return words;
}

function getMemoryKeywords(limit) {
  if (limit === undefined) limit = 80;
  // 只统计活跃记忆：沉底的记忆不参与词云
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
      // 词频 × 重要度 × IDF：泛词（很多记忆都有）降权，话题词（少数记忆反复出现）浮出
      weight: Math.round(c.weight * Math.log(N / c.count) * 10) / 10
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count)
    .slice(0, limit);
}

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
  getMemories, getMemoryById, updateMemory, deleteMemory, purgeMemory, getStats, findSimilarMemories, getMemoryKeywords,
  extractKeywordsFromText, extractKeywordsForTags, KEYWORD_STOP_WORDS,
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
