"use strict";

// ========================
// 记忆池（memory pool）
// 8 分类结构化长期记忆：支持重要级、自动衰减、检索计数（反复检索自动 pin）、
// 相似去重、删除/沉底/编辑/查看，以及压缩摘要再解析入库。
// ========================

const fs = require("fs-extra");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { nowIso } = require("./time_utils");

const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(__dirname, "data");
const POOL_FILE = path.join(DATA_DIR, "memory_pool.json");
const POOL_CONFIG_FILE = path.join(DATA_DIR, "memory_pool_config.json");
// 只读模式（wake-up 进程）：与 memory-engine 同款守卫。记忆池是 gateway/wake-up 共享数据，
// 双进程各自整文件覆盖写会互相回滚，只读进程必须拦截一切落盘与内存改写。
const READONLY = process.env.MEMORY_ENGINE_READONLY === "1";

let cache = null;
let flushTimer = null;
let warmTimer = null;
let dirty = false;

// ⑥ 对话碎片：置顶/标星保留的对话关键碎片（2026-09-05 由「心动时刻」改名，用户改为手动置顶管理）
const CATEGORIES = ["关于她", "关于我们", "锚点", "信号", "对话摘要", "对话碎片"];

// 去重阈值：同类目相似度 >= 视为同一条
const DEFAULT_DEDUP_THRESHOLD = 0.78;
const DEFAULT_DEDUP_CROSS_THRESHOLD = 0.92; // 跨类目：相似度 >= 才合并，防跨类误合并
const DEFAULT_DEDUP_ANCHOR_THRESHOLD = 0.96; // 锚点原话：几乎一字不差才合并
const DEFAULT_DEDUP_SEMANTIC_THRESHOLD = 0.80; // 语义近邻：同分类余弦 >= 视为同一条
const DEFAULT_DEDUP_SEMANTIC_CROSS_THRESHOLD = 0.86; // 语义近邻：跨分类（防误合并）
const DEFAULT_DEDUP_SEMANTIC_ANCHOR_THRESHOLD = 0.93; // 语义近邻：锚点原话（近义才合并）
const DEFAULT_MAX_MERGED_FROM = 8;      // merged_from 面包屑上限条数
const DEFAULT_DECAY_DAYS = 30;      // 30 天重要级衰减半衰期

const CONFIG = {
  dedup_threshold: DEFAULT_DEDUP_THRESHOLD,
  dedup_cross_threshold: DEFAULT_DEDUP_CROSS_THRESHOLD,
  dedup_anchor_threshold: DEFAULT_DEDUP_ANCHOR_THRESHOLD,
  dedup_semantic_threshold: DEFAULT_DEDUP_SEMANTIC_THRESHOLD,
  dedup_semantic_cross_threshold: DEFAULT_DEDUP_SEMANTIC_CROSS_THRESHOLD,
  dedup_semantic_anchor_threshold: DEFAULT_DEDUP_SEMANTIC_ANCHOR_THRESHOLD,
  merged_from_max: DEFAULT_MAX_MERGED_FROM,
  decay_days: DEFAULT_DECAY_DAYS,
  retrieval_top_k: 5,
  // 多次检索自动置顶：检索次数达到该阈值即固定为置顶（相关记忆块稳定带上它）
  auto_pin_retrieval_count: 5,
  // 跨窗口注入（日记 / 置顶记忆）；「记忆碎片（标星内容）」注入已于 2026-09-05 移除，改为记忆池「对话碎片」置顶管理
  cross_inject_enabled: true,
  cross_inject_diary: true,
  cross_inject_memory: true,
  cross_inject_diary_count: 3,
  // 压缩摘要再解析入库（LLM）：总开关 + 温暖风格
  reparse_enabled: true,
  reparse_warm: false,
  reparse_system_prompt: "",
  reparse_user_prompt: "",
  reparse_max_chars: 30,
  reparse_max_items: 8,
  reparse_merge_max_chars: 8000,
  // 整理记忆池（全局清洗 LLM）：预览/落地、提示词、数量上限、温度
  clean_enabled: true,
  clean_system_prompt: "",
  clean_user_prompt: "",
  clean_max_items: 500,
  clean_temperature: 0.2,
  clean_ref_topk: 10,
  clean_ref_threshold: 0.4,
  clean_ref_dup_threshold: 0.85
};

// 进程内已解析过的摘要哈希，短时间不重复调用 LLM
const ingestedHashes = new Set();

const STOP_CHARS = new Set("的了我是你他它她这在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到".split(""));

// ---------------- 工具 ----------------
// nowIso 已统一到 time_utils 模块

function newId() { return "mp_" + crypto.randomBytes(6).toString("hex"); }

function atomicWriteJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, file);
}

// 提取中文/英文词元（去停用字），用于相似度与检索
function tokensOf(text) {
  const raw = String(text || "").replace(/<[^>]+>/g, "").toLowerCase();
  const out = new Set();
  const runs = raw.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
  for (const run of runs) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      if (STOP_CHARS.has(run[i])) continue;
      out.add(run[i]);
      if (i + 1 < run.length && !STOP_CHARS.has(run[i + 1])) out.add(run[i] + run[i + 1]);
      if (i + 2 < run.length && !STOP_CHARS.has(run[i + 1]) && !STOP_CHARS.has(run[i + 2])) out.add(run[i] + run[i + 1] + run[i + 2]);
    }
  }
  return out;
}

function contentSimilarity(a, b) {
  const A = tokensOf(a);
  const B = tokensOf(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 0;
  // 包含度：较短内容是否被较长内容覆盖（识别“同一信息/复述/增删”）
  const minSize = Math.min(A.size, B.size);
  const containment = minSize ? inter / minSize : 0;
  // 长度比加权：内容长度差异过大时降低相似，避免误合并短句
  const sa = String(a || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  const sb = String(b || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  const lenRatio = (sa.length > 0 && sb.length > 0) ? Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length) : 1;
  let sim = Math.max(jaccard, containment);
  if (lenRatio < 0.5) sim *= 0.8;
  return Math.min(1, sim);
}

// 时间衰减：越久远重要级越低（指数衰减，半衰期 decay_days 天）
function decayFactor(entry) {
  const base = entry.last_retrieved_at || entry.updated_at || entry.created_at || nowIso();
  const t = new Date(base).getTime();
  if (isNaN(t)) return 1;
  const ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
  const half = Math.max(1, Number(CONFIG.decay_days) || DEFAULT_DECAY_DAYS);
  return Math.pow(0.5, ageDays / half);
}

function scoreOf(entry) {
  const imp = Number(entry.importance) || 0.5;
  const w = Number(entry.weight) || 1;
  return imp * decayFactor(entry) * w;
}

// ---------------- 读写 ----------------
async function init() {
  await fs.ensureDir(DATA_DIR);
  try {
    const arr = await fs.readJson(POOL_FILE);   // 读一次，别对同一文件连读两遍
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    cache = [];
  }
  try {
    Object.assign(CONFIG, await fs.readJson(POOL_CONFIG_FILE));
  } catch (e) {}
  flushTimer = setInterval(flush, 5000);
  // 语义向量后台预热（embed-server 启动 8s 后开始，此后每 10 分钟增量刷新，覆盖新增/编辑）
  setTimeout(() => { warmVectors().catch(() => {}); }, 8000);
  warmTimer = setInterval(() => { warmVectors().catch(() => {}); }, 10 * 60 * 1000);
}

function load() {
  if (cache) return cache;
  try {
    cache = Array.isArray(fs.readJsonSync(POOL_FILE)) ? fs.readJsonSync(POOL_FILE) : [];
  } catch (e) {
    cache = [];
  }
  return cache;
}

function flush() {
  if (!dirty || !cache) return;
  try {
    atomicWriteJson(POOL_FILE, cache);
    dirty = false;
  } catch (e) {
    console.error("[memory-pool] flush 失败:", e.message);
  }
}

async function shutdown() { if (flushTimer) clearInterval(flushTimer); if (warmTimer) clearInterval(warmTimer); flush(); }

// ---------------- 查询 ----------------
function list(opts) {
  opts = opts || {};
  let rows = load();
  if (opts.category) rows = rows.filter(r => r.category === opts.category);
  if (opts.active === true) rows = rows.filter(r => r.active !== false);
  if (opts.active === false) rows = rows.filter(r => r.active === false);
  if (opts.pinned === true) rows = rows.filter(r => r.pinned === true);
  if (opts.pinned === false) rows = rows.filter(r => !r.pinned);
  if (opts.q) {
    const q = String(opts.q).trim().toLowerCase();
    if (q) rows = rows.filter(r => String(r.content || "").toLowerCase().indexOf(q) !== -1);
  }
  rows = rows.map(r => ({ ...r, _score: scoreOf(r) }));
  const sort = opts.sort || "score";
  if (sort === "score") rows.sort((a, b) => b._score - a._score);
  else if (sort === "importance") rows.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
  else if (sort === "recent") rows.sort((a, b) => String(b.updated_at || "") < String(a.updated_at || "") ? -1 : 1);
  return rows;
}

function stats() {
  const rows = load();
  const byCategory = {};
  CATEGORIES.forEach(c => { byCategory[c] = 0; });
  rows.forEach(r => {
    const c = r.category || "其他";
    byCategory[c] = (byCategory[c] || 0) + 1;
  });
  return {
    total: rows.length,
    active: rows.filter(r => r.active !== false).length,
    pinned: rows.filter(r => r.pinned).length,
    sunk: rows.filter(r => r.active === false).length,
    byCategory
  };
}

// ---------------- 写操作 ----------------
function get(id) {
  return load().find(r => r.id === id) || null;
}

async function add(entry) {
  if (READONLY) { console.warn("[memory-pool] 只读模式，忽略新增/合并"); return { entry: null, dup: false }; }
  const rows = load();
  const e = normalizeEntry(entry);
  // 先文本近重复（快、稳），未命中再走语义向量近邻（抓“同义不同词”）
  const dup = findDuplicate(e) || await findSemanticDuplicate(e);
  if (dup) {
    // 完全相同（同分类+同内容）→ 已存在，幂等跳过所有副作用，不重复入库也不提权
    if (entryHash(e) === entryHash(dup)) {
      // findDuplicate/findSemanticDuplicate 内部 mutate 的相似度上浮仅内存，这里按需持久化（避免重启即丢）
      const upgradedPin = e.pinned && !dup.pinned;
      if (upgradedPin) dup.pinned = true;
      const simChanged = dup._simChanged === true;
      delete dup._simChanged;
      if (simChanged || upgradedPin) { dirty = true; flush(); }
      return { entry: dup, dup: true, already: true };
    }
    // 文本/语义近似但不同 → 合并：保留更高重要级，轻微上浮；不新增重复条目
    if (e.pinned || dup.pinned) dup.pinned = true;
    const merged = mergeEntries(dup, e);
    dup.importance = merged.importance;
    dup.content = merged.content;
    dup.category = merged.category;
    dup.similarity = merged.similarity;
    dup.fingerprint = merged.fingerprint;
    dup.merged_from = merged.merged_from;
    dup.updated_at = nowIso();
    dup.source = dup.source || e.source;
    delete dup._simChanged; // 临时字段不落盘
    invalidateVector(dup.id); // 内容/分类可能已变，旧向量作废
    dirty = true; flush();
    return { entry: dup, dup: true, already: false };
  }
  rows.push(e);
  dirty = true; flush();
  return { entry: e, dup: false };
}

function update(id, patch) {
  if (READONLY) { console.warn("[memory-pool] 只读模式，忽略更新"); return null; }
  const rows = load();
  const it = rows.find(r => r.id === id);
  if (!it) return null;
  if (patch.content !== undefined) it.content = String(patch.content).trim();
  if (patch.category !== undefined && CATEGORIES.includes(patch.category)) it.category = patch.category;
  if (patch.importance !== undefined) it.importance = Math.max(0, Math.min(1, Number(patch.importance) || 0));
  if (patch.pinned !== undefined) it.pinned = !!patch.pinned;
  if (patch.active !== undefined) it.active = !!patch.active;
  it.updated_at = nowIso();
  if (patch.content !== undefined || patch.category !== undefined) invalidateVector(id);
  dirty = true; flush();
  return it;
}

function remove(id) {
  if (READONLY) { console.warn("[memory-pool] 只读模式，忽略删除"); return false; }
  const rows = load();
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  dirty = true; flush();
  return true;
}

function sink(id) {
  if (READONLY) return null;
  const it = get(id);
  if (!it) return null;
  it.active = false;
  it.updated_at = nowIso();
  dirty = true; flush();
  return it;
}

function revive(id) {
  if (READONLY) return null;
  const it = get(id);
  if (!it) return null;
  it.active = true;
  it.updated_at = nowIso();
  dirty = true; flush();
  return it;
}

function normalizeEntry(raw) {
  const e = {};
  e.id = raw.id || newId();
  e.content = String(raw.content || "").trim();
  e.category = CATEGORIES.includes(raw.category) ? raw.category : "关于她";
  e.importance = Math.max(0, Math.min(1, Number(raw.importance) || 0.5));
  e.similarity = Number(raw.similarity) || 0;
  e.retrieval_count = Number(raw.retrieval_count) || 0;
  e.last_retrieved_at = raw.last_retrieved_at || null;
  e.created_at = raw.created_at || nowIso();
  e.updated_at = raw.updated_at || nowIso();
  e.pinned = !!raw.pinned;
  e.active = raw.active !== false;
  e.source = raw.source || "manual";
  e.block_id = raw.block_id || null;
  e.fingerprint = raw.fingerprint || entryHash(e);
  e.superseded_by = raw.superseded_by || null;
  e.merged_from = Array.isArray(raw.merged_from) ? raw.merged_from.slice(-DEFAULT_MAX_MERGED_FROM) : [];
  return e;
}

function findDuplicate(e) {
  const rows = load();
  const threshold = Number(CONFIG.dedup_threshold) || DEFAULT_DEDUP_THRESHOLD;
  const crossThreshold = Number(CONFIG.dedup_cross_threshold) || DEFAULT_DEDUP_CROSS_THRESHOLD;
  const anchorThreshold = Number(CONFIG.dedup_anchor_threshold) || DEFAULT_DEDUP_ANCHOR_THRESHOLD;
  let best = null;
  let bestSim = 0;
  for (const r of rows) {
    if (r.active === false) continue;
    if (r.id === e.id) continue;
    const sameCat = r.category === e.category;
    const involveAnchor = e.category === "锚点" || r.category === "锚点";
    // 锚点：跨类绝不合并；同类仅几乎一字不差时才合并，避免改掉原话
    const th = involveAnchor
      ? (sameCat ? anchorThreshold : Infinity)
      : (sameCat ? threshold : crossThreshold);
    const sim = contentSimilarity(r.content, e.content);
    if (sim >= th && sim > bestSim) { best = r; bestSim = sim; }
  }
  if (best) {
    const prevSim = Number(best.similarity) || 0;
    const nextSim = Math.max(bestSim, prevSim);
    best.similarity = nextSim;
    best._simChanged = nextSim > prevSim;  // 供 add() 幂等分支判断是否需要持久化（避免仅内存上浮重启即丢）
  }
  return best;
}

// 语义向量近邻去重：用 bge 余弦抓“同义不同词”的重复（锚点跨类绝不合并）；embed 不可用时回落 null
async function findSemanticDuplicate(e) {
  if (embedClient.fused()) return null;
  const rows = load().filter(r => r.active !== false && r.id !== e.id);
  if (!rows.length) return null;
  const ready = await ensureVectors(rows);
  if (!ready) return null;
  const qv = await embedClient.embedBatch([e.category + "：" + e.content], false, 8000);
  if (!qv || !qv[0]) return null;
  // 短文本 bge 余弦天然偏高，按长度分档提阈值，避免冷启动/短句误并
  const _lenTh = function (base) {
    const len = String(e.content || "").trim().length;
    if (len < 10) return Math.min(1, base + 0.10);
    if (len < 30) return Math.min(1, base + 0.05);
    return base;
  };
  const sameTh = _lenTh(Number(CONFIG.dedup_semantic_threshold) || DEFAULT_DEDUP_SEMANTIC_THRESHOLD);
  const crossTh = _lenTh(Number(CONFIG.dedup_semantic_cross_threshold) || DEFAULT_DEDUP_SEMANTIC_CROSS_THRESHOLD);
  const anchorTh = _lenTh(Number(CONFIG.dedup_semantic_anchor_threshold) || DEFAULT_DEDUP_SEMANTIC_ANCHOR_THRESHOLD);
  const m = vecMap();
  let best = null, bestSim = 0;
  for (const r of rows) {
    const v = (m[r.id] || {}).v;
    if (!Array.isArray(v) || !v.length) continue;
    const cos = dotProduct(qv[0], v); // 均 L2 归一化，点积即余弦
    const sameCat = r.category === e.category;
    const involveAnchor = e.category === "锚点" || r.category === "锚点";
    const th = involveAnchor ? (sameCat ? anchorTh : Infinity) : (sameCat ? sameTh : crossTh);
    if (cos >= th && cos > bestSim) { best = r; bestSim = cos; }
  }
  if (best) {
    const prevSim = Number(best.similarity) || 0;
    const nextSim = Math.max(bestSim, prevSim);
    best.similarity = nextSim;
    best._simChanged = nextSim > prevSim;  // 供 add() 幂等分支判断是否需要持久化（避免仅内存上浮重启即丢）
  }
  return best;
}

// 被折入条目的轻量快照，供 merged_from 回滚/追溯
function mergeSnap(x) {
  return { content: x.content, category: x.category, importance: Number(x.importance) || 0.5, at: nowIso() };
}

function mergeEntries(dup, e) {
  const imp = Math.max(Number(dup.importance) || 0, Number(e.importance) || 0) + 0.02;
  const content = String(e.content || "").length > String(dup.content || "").length ? e.content : dup.content;
  // 被折入条目的面包屑保留下来，供回滚/追溯（限 merged_from_max 条）
  const mf = Array.isArray(dup.merged_from) ? dup.merged_from.slice() : [];
  mf.push(mergeSnap(e));
  const max = Math.max(0, Number(CONFIG.merged_from_max) || DEFAULT_MAX_MERGED_FROM);
  if (mf.length > max) mf.splice(0, mf.length - max);
  return {
    importance: Math.min(1, imp),
    content,
    category: e.category || dup.category,
    similarity: Math.max(Number(dup.similarity) || 0, Number(e.similarity) || 0),
    fingerprint: entryHash({ category: e.category || dup.category, content }),
    merged_from: mf
  };
}

function supersedeBlock(blockId) {
  if (READONLY) return 0;
  if (!blockId || typeof blockId !== "string") return 0;
  const rows = load();
  let n = 0;
  for (const r of rows) {
    if (r.active !== false && r.block_id === blockId) {
      r.active = false;
      r.updated_at = nowIso();
      n++;
    }
  }
  if (n) { dirty = true; flush(); }
  return n;
}

// ---------------- 检索（记忆池工具） ----------------
// 返回 topK 条；检索会计数并按阈值自动置顶（历史行为；管理台也可手动固定置顶）
function retrieve(query, opts) {
  opts = opts || {};
  const topK = Math.max(1, Number(opts.topK) || Number(CONFIG.retrieval_top_k) || 5);
  const rows = load().filter(r => r.active !== false && (!opts.category || String(r.category || "") === String(opts.category)));
  const qt = tokensOf(query);
  let scored = rows.map(r => {
    const sim = query && qt.size ? contentSimilarity(r.content + " " + (r.category || ""), query) : 0;
    const imp = Number(r.importance) || 0.5;
    const decay = decayFactor(r);
    return { r, sim, score: sim * 0.6 + imp * 0.4 * decay };
  });
  scored.sort((a, b) => b.score - a.score || b.sim - a.sim);
  const picked = scored.slice(0, topK);
  const autoPinTh = Math.max(2, Number(CONFIG.auto_pin_retrieval_count) || 5);
  // 只读模式：检索计数/自动置顶也是写，跳过以免覆盖 gateway 侧的 memory_pool.json；
  // 空查询不计数：否则多次空查询测试会把无关记忆顶成置顶，污染跨窗口注入
  const shouldCount = !!(query && String(query).trim());
  if (!READONLY && shouldCount) {
    for (const p of picked) {
      p.r.retrieval_count = Number(p.r.retrieval_count || 0) + 1;
      p.r.last_retrieved_at = nowIso();
      p.r.updated_at = nowIso();
      // 多次检索自动置顶：达到阈值即固定为置顶，让「相关记忆」跨窗口块能稳定带上它
      if (p.r.pinned !== true && p.r.retrieval_count >= autoPinTh) {
        p.r.pinned = true;
      }
      dirty = true;
    }
  }
  // Reads no longer write to disk immediately: batch via the 5s flushTimer to avoid write amplification.
  // 返回精简字段：只要展示/编辑需要的 id/content/category/importance/pinned + 时间戳，
  // 去掉 _score、last_retrieved_at、retrieval_count、cleaned_at、source 等内部噪音字段。
  return picked.map(p => {
    const r = p.r;
    return {
      id: r.id,
      content: r.content,
      category: r.category,
      importance: r.importance,
      pinned: r.pinned === true,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}

// ---------------- 本地语义向量（embed-server，bge-small-zh-v1.5） ----------------
// 向量缓存 data/memory_pool_vectors.json：{ id: { h: 内容指纹, v: 512 维（已 L2 归一化） } }
// embed-server 不可用时（熔断期）自动退化为 retrieve() 原字面公式，主链路不受影响。
const embedClient = require("./utils/embed-client");
const VECTOR_FILE = path.join(DATA_DIR, "memory_pool_vectors.json");
let vectorCache = null;
const VECTOR_WARM_BATCH_SIZE = 4;
const VECTOR_WARM_PAUSE_MS = 5000;
let vectorWarmPromise = null;

function vecMap() {
  if (!vectorCache) {
    try { vectorCache = fs.readJsonSync(VECTOR_FILE); } catch (e) { vectorCache = {}; }
    if (!vectorCache || typeof vectorCache !== "object" || Array.isArray(vectorCache)) vectorCache = {};
  }
  return vectorCache;
}

function saveVecMap() {
  if (READONLY) return;
  try { fs.writeJsonSync(VECTOR_FILE, vectorCache); } catch (e) { /* 缓存写失败只影响下次冷启动 */ }
}

function entryHash(e) {
  return crypto.createHash("sha1").update(String(e.category || "") + "\u0000" + String(e.content || "")).digest("hex").slice(0, 12);
}

function invalidateVector(id) {
  const m = vecMap();
  if (m[id]) { delete m[id]; saveVecMap(); }
}

function missingVectors(rows) {
  const m = vecMap();
  return rows.filter(function (r) {
    const c = m[r.id];
    return !c || c.h !== entryHash(r) || !Array.isArray(c.v) || c.v.length === 0;
  });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 检索与写入主链路不能为补向量等待。缺失时安排后台增量补算，并让调用方走字面回退。
async function ensureVectors(rows) {
  const missing = missingVectors(rows);
  if (!missing.length) return true;
  warmVectors().catch(function () {});
  return false;
}

// 后台预热：每次最多 4 条、每批立即落盘。服务重启或超时时保留已完成批次，
// 下一个定时周期/检索触发会从缓存断点继续，绝不把整池塞进一个请求。
async function warmVectors() {
  if (READONLY || embedClient.fused()) return false;
  if (vectorWarmPromise) return vectorWarmPromise;
  vectorWarmPromise = (async function () {
    let completed = 0;
    while (!embedClient.fused()) {
      const rows = load().filter(function (r) { return r.active !== false; });
      const batch = missingVectors(rows).slice(0, VECTOR_WARM_BATCH_SIZE);
      if (!batch.length) return completed > 0;
      const vecs = await embedClient.embedBatch(batch.map(function (r) { return r.category + "：" + r.content; }), false, 12000);
      if (!vecs || vecs.length !== batch.length) return false;
      const m = vecMap();
      batch.forEach(function (r, i) {
        if (vecs[i] && vecs[i].length) m[r.id] = { h: entryHash(r), v: vecs[i] };
      });
      saveVecMap();
      completed += batch.length;
      await delay(VECTOR_WARM_PAUSE_MS);
    }
    return false;
  })().finally(function () { vectorWarmPromise = null; });
  return vectorWarmPromise;
}

function dotProduct(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 混合检索（memory_search 用）：0.55 语义余弦 + 0.20 字面 + 0.25 重要级×衰减；
// 语义服务不可用 → 原封回落 retrieve() 字面公式。返回结构两者一致。
async function retrieveHybrid(query, opts) {
  opts = opts || {};
  const q = String(query || "").trim();
  // 空查询直接返回空：否则 top-K 全部被计数+可能触发自动置顶，多次空查询测试会污染置顶
  if (!q) return [];
  const rows = load().filter(r => r.active !== false && (!opts.category || String(r.category || "") === String(opts.category)));
  if (!rows.length) return [];
  if (embedClient.fused()) return retrieve(query, opts);
  const ready = await ensureVectors(rows);
  if (!ready) return retrieve(query, opts);
  const qv = await embedClient.embedBatch([q], true, 8000);
  if (!qv) return retrieve(query, opts);
  const m = vecMap();
  const qt = tokensOf(q);
  const scored = rows.map(r => {
    const v = (m[r.id] || {}).v;
    const sem = v ? Math.max(0, dotProduct(qv[0], v)) : 0; // 均已归一化，点积即余弦
    const lit = qt.size ? contentSimilarity(r.content + " " + (r.category || ""), q) : 0;
    const imp = Number(r.importance) || 0.5;
    const decay = decayFactor(r);
    return { r, sem, sim: lit, score: 0.55 * sem + 0.20 * lit + 0.25 * imp * decay };
  });
  const topK = Math.max(1, Number(opts.topK) || Number(CONFIG.retrieval_top_k) || 5);
  scored.sort((a, b) => b.score - a.score || b.sem - a.sem);
  const picked = scored.slice(0, topK);
  const autoPinTh = Math.max(2, Number(CONFIG.auto_pin_retrieval_count) || 5);
  for (const p of picked) {
    if (READONLY) break;
    p.r.retrieval_count = Number(p.r.retrieval_count || 0) + 1;
    p.r.last_retrieved_at = nowIso();
    p.r.updated_at = nowIso();
    if (p.r.pinned !== true && p.r.retrieval_count >= autoPinTh) p.r.pinned = true;
    dirty = true;
  }
  return picked.map(p => {
    const r = p.r;
    return {
      id: r.id,
      content: r.content,
      category: r.category,
      importance: r.importance,
      pinned: r.pinned === true,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}


// 呼吸：浮现最近沉淀的记忆（未沉底，优先置顶 > 重要级 > 最近更新）。用于 memory_search 的 breath 开关。
function breath(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 3, 5));
  const category = opts.category || undefined;
  const rows = load().filter(function (r) {
    if (r.active === false) return false;
    if (category && String(r.category || "") !== String(category)) return false;
    return true;
  });
  rows.sort(function (a, b) {
    const pinA = a.pinned === true ? 1 : 0;
    const pinB = b.pinned === true ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    const impA = Number(a.importance) || 0;
    const impB = Number(b.importance) || 0;
    if (impA !== impB) return impB - impA;
    const upA = String(a.updated_at || "");
    const upB = String(b.updated_at || "");
    return upA < upB ? 1 : (upA > upB ? -1 : 0);
  });
  return rows.slice(0, limit).map(function (r) {
    return {
      id: r.id,
      content: r.content,
      category: r.category,
      importance: r.importance,
      pinned: r.pinned === true,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });
}

// ---------------- 压缩摘要 → 记忆池 ----------------
// 从压缩摘要里提取【分类】标记文本（正则兜底），再调用 LLM 客观再解析 → 结构化记忆
function parseCategoryBlocks(text, opts) {
  opts = opts || {};
  const blocks = [];
  const re = /【([^】]+)】\s*([\s\S]*?)(?=【[^】]+】|$)/g;

  // 摘要条目约定按空行分隔：每个空行隔开的段落独立成一条；兼容旧排版「段内多为 - / • 列表」时再按行拆
  const splitSection = function (body) {
    const segs = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (!segs.length) return [];
    const out = [];
    for (const seg of segs) {
      const lines = seg.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const dashLike = lines.length > 1 && lines.filter((l) => /^[-—–•*]\s*/.test(l)).length >= Math.ceil(lines.length / 2);
      if (dashLike) {
        for (const l of lines) {
          const c = l.replace(/^[-—–•*]\s*/, "").trim();
          if (c) out.push(c);
        }
      } else {
        out.push(seg);
      }
    }
    return out;
  };

  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const cat = m[1].trim();
    const body = m[2].trim();
    if (!CATEGORIES.includes(cat)) continue;
    for (const p of splitSection(body)) {
      if (p) blocks.push({ category: cat, content: p });
    }
  }
  if (blocks.length) return blocks;

  // 无分类标记：默认整段按“对话摘要”兜底；noFallback=true 时返回空（调用方决定不入池）
  if (opts.noFallback) return [];
  const t = String(text || "").trim();
  if (t) return [{ category: "对话摘要", content: t }];
  return [];
}

// 稳健地从 LLM 返回字符串中取出记忆数组（兼容：纯数组 JSON / 对象包数组 {memories:[...]} / 带 ```json 围栏 / 文本里嵌 [] / JSON.parse 失败用正则抓）
function parseLlmArray(cleaned) {
  const tryParse = function (t) { try { return JSON.parse(t); } catch (e) { return null; } };
  let parsed = tryParse(cleaned);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const keys = ["memories", "data", "items", "list", "results", "memory", "entries"];
    for (const k of keys) if (Array.isArray(parsed[k])) return parsed[k];
    for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) return parsed[k];
  }
  const mm = String(cleaned || "").match(/\[[\s\S]*\]/);
  if (mm) {
    parsed = tryParse(mm[0]);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      for (const k of Object.keys(parsed)) if (Array.isArray(parsed[k])) return parsed[k];
    }
  }
  return null;
}

function buildReparsePrompt(warm) {
  const maxChars = Math.max(5, Number(CONFIG.reparse_max_chars) || 30);
  const maxItems = Math.max(1, Number(CONFIG.reparse_max_items) || 8);
  const catEnum = "(关于她|关于我们|锚点|信号|对话摘要)";
  const catNote = "分类含义：关于她=她是谁/她经历过的（稳定特征+过往经历）；关于我们=我们怎么相处（触发场景→我怎么做/不怎么做→她反应→下次想怎么调）；锚点=一字不改的原话；信号=她状态变化的可观察言行；对话摘要=聊过什么话题索引。";
  const system = warm
    ? '你是这段关系的记忆整理者。把压缩记忆提炼成有温度、可长期复用的一条条记忆：既客观，也保留她与“我”之间真实的相处质感。禁止编造、禁止脑补、禁止写成冰冷档案。'
    : '你是记忆整理器。把对话压缩记忆按客观事实提炼成结构化记忆条目，禁止脑补。';
  const user = warm
    ? '下面是一段我用第一人称/零散记录写的压缩记忆。请提炼成若干条能长期记住的关系记忆，每条保留一个明确信息，贴近“我”的视角与语气，有温度但不煽情；既要有明确的相处规律/她的特点，也要保留那些让我觉得真实、会心或心底一动的细节。输出 JSON 数组，每项形如 {"content":"...","category":"' + catEnum + '","importance":0~1}。' + catNote + ' 同一条信息只保留一次，同义合并。只提炼最重要的，尽量不超过 ' + maxItems + ' 条；每条尽量精简，不要超过 ' + maxChars + ' 字。直接输出 JSON，不要额外解释。'
    : '下面是一段压缩记忆（可能含【分类】标记）。请客观提炼出若干条记忆，每条只保留一个明确信息，输出 JSON 数组，每项形如 {"content":"...","category":"' + catEnum + '","importance":0~1}。' + catNote + ' 若多条信息同义则只保留一条。只提炼最重要的，尽量不超过 ' + maxItems + ' 条；每条尽量精简，不要超过 ' + maxChars + ' 字。直接输出 JSON，不要额外解释。';
  return { system, user };
}

async function reparseSummaryViaLLM(text, cfg) {
  const apiUrl = cfg && cfg.api_url || process.env.TARGET_API_URL || "";
  const apiKey = cfg && cfg.api_key || process.env.TARGET_API_KEY || "";
  const model = cfg && cfg.model || process.env.MODEL_NAME || "";
  const warm = cfg && cfg.warm !== undefined ? !!cfg.warm : CONFIG.reparse_warm !== false;
  const maxChars = Math.max(5, Number(CONFIG.reparse_max_chars) || 30);
  const maxItems = Math.max(1, Number(CONFIG.reparse_max_items) || 8);
  const hasCustom = !!(String(CONFIG.reparse_system_prompt || "").trim() || String(CONFIG.reparse_user_prompt || "").trim());
  if (CONFIG.reparse_enabled === false && !(cfg && cfg.forceLlm === true)) {
    const fb = parseCategoryBlocks(text);
    return { ok: true, fallback: true, disabled: true, memories: fb };
  }
  if (!apiUrl || !apiKey || !model) {
    const fb = parseCategoryBlocks(text);
    return { ok: true, fallback: true, memories: fb };
  }
  const def = buildReparsePrompt(warm);
  const defSystem = def.system;
  const defUser = def.user;
  const system = String(CONFIG.reparse_system_prompt || "").trim() || defSystem;
  const user = (String(CONFIG.reparse_user_prompt || "").trim() || defUser) + "\n\n记忆文本：\n" + text;
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) return { ok: false, error: "LLM HTTP " + resp.status };
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return { ok: false, error: "LLM 空响应" };
    const cleaned = String(content).replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const arr = parseLlmArray(cleaned);
    if (!Array.isArray(arr)) return { ok: false, error: "LLM 输出非数组" };
    const out = [];
    for (const it of arr) {
      const cat = CATEGORIES.includes(it.category) ? it.category : "关于她";
      let content2 = String(it.content || it.memory || "").trim();
      content2 = content2.replace(/^(关于她|关于我们|锚点|信号|对话摘要)\s*[：:]\s*/, "");
      if (!hasCustom && content2.length > maxChars) content2 = content2.slice(0, maxChars);
      if (content2) out.push({ category: cat, content: content2, importance: Math.max(0, Math.min(1, Number(it.importance) || 0.5)) });
    }
    out.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    if (!hasCustom && out.length > maxItems) out.length = maxItems;
    return { ok: true, memories: out };
  } catch (e) {
    return { ok: false, error: e.message, fallback: true, memories: parseCategoryBlocks(text) };
  }
}

// 把一段压缩摘要「再解析 + 去重」进入记忆池；返回新增/合并统计
async function ingestSummary(summaryText, opts) {
  opts = opts || {};
  if (READONLY) { console.warn("[memory-pool] 只读模式，忽略摘要入池"); return { ok: true, skipped: true, readonly: true, added: 0, merged: 0, failed: 0 }; }
  const source = opts.source || "compaction";
  const blockId = opts.block_id || null;
  // 直接分类/重要级：memory 标签里写了 {category,importance} 时，跳过 LLM 再解析，直接入库。
  const directCategory = opts.directCategory ? String(opts.directCategory).trim() : "";
  const directPinned = opts.directPinned === true;
  if (directCategory && directCategory !== "" && CATEGORIES.includes(directCategory)) {
    const importance = (opts.directImportance != null && isFinite(opts.directImportance)) ? Number(opts.directImportance) : null;
    const r = await add({
      content: String(summaryText || "").trim(),
      category: directCategory,
      importance: importance != null ? importance : 0.5,
      pinned: directPinned,
      source
    });
    return { ok: true, added: r.dup ? 0 : 1, merged: (r.dup && !r.already) ? 1 : 0, already: r.already ? 1 : 0, failed: 0, fallback: false };
  }
  const mergeBlockIds = Array.isArray(opts.blockIds) ? opts.blockIds.map(String).filter(Boolean) : [];
  const hash = crypto.createHash("sha1").update(String(summaryText || "")).digest("hex");
  if (!opts.force && ingestedHashes.has(hash)) {
    return { ok: true, skipped: true, added: 0, merged: 0, failed: 0 };
  }
  ingestedHashes.add(hash);
  const parsed = await reparseSummaryViaLLM(summaryText, { ...(opts.llm || {}), forceLlm: opts.forceLlm === true });
  // 换版时先沉底旧记忆：合并发批量沉底选中块；单块按 block_id 沉底
  if (mergeBlockIds.length) {
    for (const bid of mergeBlockIds) supersedeBlock(bid);
  } else if (blockId) {
    supersedeBlock(blockId);
  }
  const parsedMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  let added = 0, merged = 0, failed = 0, already = 0;
  for (const m of parsedMemories) {
    // 合并发的条目不挂单一 block_id（它可能同时吸收了多个块）；单块仍精确挂 block_id
    const attachBlock = mergeBlockIds.length ? null : blockId;
    const r = await add({
      content: m.content,
      category: m.category,
      importance: m.importance,
      pinned: directPinned,
      source,
      block_id: attachBlock
    });
    if (r.already) already++; else if (r.dup) merged++; else added++;
  }
  return { ok: true, added, merged, failed, already, fallback: !!parsed.fallback, error: parsed.error || null };
}

// ---------------- 整理记忆池（全局清洗 + 打标记 + 参考去重） ----------------
// 全量清洗：只洗「未清洗过」的记忆（cleaned_at 为空）。已清洗过的记忆作为
// 「参考上下文」参与去重/合并判断：用关键词+语义相似度把与本次内容相近的旧记忆
// 挑出来一起喂给 LLM，从而下次全量不会重复清洗旧部分，又能挡掉与旧记忆重复的新增。
function buildCleanPrompt() {
  const catEnum = "(关于她|关于我们|锚点|信号|对话摘要)";
  const catNote = "分类含义：关于她=她是谁/她经历过的（稳定特征+过往经历）；关于我们=我们怎么相处（触发场景→我怎么做/不怎么做→她反应→下次想怎么调）；锚点=一字不改的原话；信号=她状态变化的可观察言行；对话摘要=聊过什么话题索引。";
  const system = "你是这段关系的记忆整理者，处理要果断、不手软。目标是把记忆池整理得干净、凝练、贴近真实，宁可少而准不要多而杂。对不重要的记忆，把重要级打低到 0.2~0.4；对过时、无效、含糊不清、没用的记忆，直接沉底，别舍不得；对内容相近、同义、重复的记忆，直接合并成一条，不用等完全一样；与【已清洗参考】重复的待清洗记忆，直接沉底。保留真实相处质感，禁止编造、禁止脑补、禁止写成冰冷档案。只输出 JSON。";
  const user = "以下是记忆池中所有待清洗记忆（每条含：编号、原分类、内容、重要级、是否置顶）。请整理成一份新的记忆清单，规则如下（要果断，不要手软）：\n"
    + "1. 合并：内容相近、同义、重复的记忆直接合并为一条，不用等完全一样；宁可合并，不要留多个相似条。\n"
    + "2. 去重：完全相同的只保留一条。\n"
    + "3. 重新分类：按【关于她｜关于我们｜锚点｜信号｜对话摘要】纠正分类。\n"
    + "4. " + catNote + "\n"
    + "5. 重要级：重新评估 importance（0~1），不重要的打低到 0.2~0.4，越重要越接近 1。\n"
    + "6. 沉底：对不重要、不明确、过时、无效、没用，或与【已清洗参考】重复的记忆，直接标记 sunk=true（不是删除，只是不再参与浮现），别舍不得。\n"
    + "7. 置顶的尽量保留置顶状态，除非内容已完全失效。\n"
    + "8. 只输出对【待清洗记忆】的整理结果；【已清洗参考】仅作去重/合并判断，不要重复输出它们。\n"
    + "9. 宁可少而准确，不要多而杂；合并后总条数尽量少，但不要丢失重要事实。\n"
    + "直接输出 JSON 数组，每项格式：\n"
    + "{\"id\":\"保持原 id 或 new\",\"content\":\"...\",\"category\":\"" + catEnum + "\",\"importance\":0~1,\"sunk\":false,\"pin\":false}\n"
    + "不要输出任何解释文字。";
  return { system: system, user: user };
}

async function cleanPoolViaLLM(system, user) {
  const apiUrl = process.env.TARGET_API_URL || "";
  const apiKey = process.env.TARGET_API_KEY || "";
  const model = process.env.MODEL_NAME || "";
  if (!apiUrl || !apiKey || !model) return { ok: false, error: "LLM 未配置（TARGET_API_URL / TARGET_API_KEY / MODEL_NAME）" };
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: Number(CONFIG.clean_temperature) || 0.2,
        response_format: { type: "json_object" }
      })
    });
    if (!resp.ok) return { ok: false, error: "LLM HTTP " + resp.status };
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return { ok: false, error: "LLM 空响应" };
    const cleaned = String(content).replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const arr = parseLlmArray(cleaned);
    if (!Array.isArray(arr)) return { ok: false, error: "LLM 输出非数组" };
    const out = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const content2 = String(it.content || "").trim();
      if (!content2) continue;
      out.push({
        id: it.id ? String(it.id) : null,
        content: content2,
        category: CATEGORIES.includes(it.category) ? it.category : "关于她",
        importance: Math.max(0, Math.min(1, Number(it.importance) || 0.5)),
        sunk: it.sunk === true,
        pin: it.pin === true
      });
    }
    return { ok: true, memories: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function backupPoolFile() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(DATA_DIR, "_fix_backup_" + stamp + ".json");
    await fs.copy(POOL_FILE, dest);
    return dest;
  } catch (e) {
    return null;
  }
}

// 选出与 chunk 最相似的一批「已清洗记忆」，作为 LLM 去重参考上下文
function selectReferenceContext(chunk, refPool, topk, th) {
  const ctx = [];
  for (const ref of refPool) {
    let bestSim = 0;
    for (const ci of chunk) {
      const sim = contentSimilarity(ref.content, ci.content);
      if (sim > bestSim) bestSim = sim;
    }
    if (bestSim >= th) ctx.push({ ref: ref, sim: bestSim });
  }
  ctx.sort(function (a, b) { return b.sim - a.sim; });
  return ctx.slice(0, topk);
}

async function cleanPool(opts) {
  opts = opts || {};
  if (READONLY) return { ok: false, error: "只读模式（wake-up）不执行记忆池整理" };
  const preview = opts.preview !== false;
  const rows = load();
  const active = rows.filter(function (r) { return r.active !== false; });
  const found = active.length;
  if (!found) return { ok: true, preview: preview, found: 0, to_clean: 0, added: 0, merged: 0, recategorized: 0, rescored: 0, sunk: 0, changes: [] };
  if (CONFIG.clean_enabled === false) return { ok: false, error: "整理记忆池已关闭（clean_enabled=false）" };

  const maxItems = Math.max(1, Number(CONFIG.clean_max_items) || 500);
  const refTopk = Math.max(1, Number(CONFIG.clean_ref_topk) || 10);
  const refTh = Number(CONFIG.clean_ref_threshold) || 0.4;
  const dupTh = Number(CONFIG.clean_ref_dup_threshold) || 0.85;
  const MATCH_TH = 0.5;
  const MERGE_SINK_TH = 0.6;  // 与保留条目相近度>=此值，视为被合并，沉底

  // 待清洗 = 还没打标记（cleaned_at 为空）；已清洗 = 已有 cleaned_at
  // force=true 时忽略标记、强制重洗全部活跃记忆
  const toClean = active.filter(function (r) { return opts.force === true || !r.cleaned_at; });
  const toCleanCount = toClean.length;
  if (!toCleanCount) return { ok: true, preview: preview, found: found, to_clean: 0, added: 0, merged: 0, recategorized: 0, rescored: 0, sunk: 0, changes: [], message: "没有新的待清洗记忆" };

  const sortedToClean = toClean.slice().sort(function (a, b) { return (Number(b.importance) || 0) - (Number(a.importance) || 0); });
  const priorRef = active.filter(function (r) { return !!r.cleaned_at; }).slice();
  const contextPool = priorRef.slice();

  const def = buildCleanPrompt();
  const system = String(CONFIG.clean_system_prompt || "").trim() || def.system;
  const userBase = (String(CONFIG.clean_user_prompt || "").trim() || def.user);

  const changes = [];
  let added = 0, merged = 0, recategorized = 0, rescored = 0, sunkCount = 0;
  let llmError = null;

  // 按批分块（LLM 容量限制），每块处理一部分待清洗记忆
  for (let i = 0; i < sortedToClean.length; i += maxItems) {
    const chunk = sortedToClean.slice(i, i + maxItems);
    const refContext = selectReferenceContext(chunk, contextPool, refTopk, refTh);

    const snapshot = chunk.map(function (r, j) {
      return (j + 1) + ". [id=" + r.id + "]（分类=" + r.category + "，重要级=" + (Number(r.importance) || 0.5) + "，置顶=" + (r.pinned ? "是" : "否") + "）内容：" + r.content;
    }).join("\n");
    const refText = refContext.map(function (c, j) {
      return "[" + c.ref.id + "]（分类=" + c.ref.category + "，重要级=" + (Number(c.ref.importance) || 0.5) + "）内容：" + c.ref.content;
    }).join("\n");
    let user = userBase + "\n\n【待清洗记忆】\n" + snapshot;
    if (refText) user += "\n\n【已清洗参考（仅作去重/合并判断，勿作为本次输出重新创建）】\n" + refText;

    const llm = await cleanPoolViaLLM(system, user);
    if (!llm.ok) { llmError = llm.error; break; }
    const items = llm.memories || [];
    const byId = new Map();
    for (const r of chunk) byId.set(r.id, r);
    const matchedIds = new Set();

    for (const it of items) {
      let target = null;
      if (it.id && byId.has(it.id)) target = byId.get(it.id);
      else {
        let best = null, bestSim = 0;
        for (const r of chunk) {
          const sim = contentSimilarity(r.content, it.content);
          if (sim > bestSim) { bestSim = sim; best = r; }
        }
        if (best && bestSim >= MATCH_TH) target = best;
      }
      if (!target) { changes.push({ id: null, type: "add", content: it.content, category: it.category, importance: it.importance, sink: false }); added++; continue; }
      matchedIds.add(target.id);
      const isAnchor = target.category === "锚点";
      const newCat = CATEGORIES.includes(it.category) ? it.category : target.category;
      const newImp = Math.max(0, Math.min(1, Number(it.importance) || (Number(target.importance) || 0)));
      const newContent = isAnchor ? target.content : String(it.content || target.content).trim();
      const sinkIt = it.sunk === true;
      const diffs = [];
      if (newContent !== target.content) diffs.push("content");
      if (newCat !== target.category) diffs.push("category");
      if (Math.abs(newImp - (Number(target.importance) || 0)) > 0.01) diffs.push("importance");
      if (sinkIt) diffs.push("sink");
      if (!diffs.length) continue;
      if (diffs.indexOf("content") !== -1) merged++;
      if (diffs.indexOf("category") !== -1) recategorized++;
      if (diffs.indexOf("importance") !== -1) rescored++;
      if (sinkIt) sunkCount++;
      let type = "edit";
      if (diffs.length === 1) {
        if (diffs[0] === "category") type = "recat";
        else if (diffs[0] === "importance") type = "rescore";
        else if (diffs[0] === "sink") type = "sink";
      }
      changes.push({ id: target.id, type: type, from: { content: target.content, category: target.category, importance: Number(target.importance) || 0.5 }, to: { content: newContent, category: newCat, importance: newImp }, sink: sinkIt });
    }

    // 被 LLM 漏掉的待清洗条目：分成两种情况对待（激进）
    // a) 与「已清洗参考」高度相似(重复) → 沉底
    // b) 与「本次 LLM 保留的某条」高度相近 → 说明它已被合并进那条，也沉底，让合并不干净的情况也清掉
    for (const r of chunk) {
      if (matchedIds.has(r.id)) continue;
      let bestPriorSim = 0;
      for (const ref of priorRef) {
        const sim = contentSimilarity(ref.content, r.content);
        if (sim > bestPriorSim) bestPriorSim = sim;
      }
      let bestAliveSim = 0;
      let bestAliveId = null;
      for (const rid of matchedIds) {
        const alive = byId.get(rid);
        if (!alive) continue;
        const sim = contentSimilarity(alive.content, r.content);
        if (sim > bestAliveSim) { bestAliveSim = sim; bestAliveId = rid; }
      }
      if (bestPriorSim >= dupTh || bestAliveSim >= MERGE_SINK_TH) {
        // b) 被合并进某条保留记忆而沉底 → 记 superseded_by 指向合并目标，可回滚/追溯
        const superseded_by = bestAliveSim >= MERGE_SINK_TH ? bestAliveId : undefined;
        changes.push({ id: r.id, type: "sink", from: { content: r.content, category: r.category, importance: Number(r.importance) || 0.5 }, to: null, sink: true, superseded_by });
        sunkCount++;
      }
    }

    // 本块处理过的条目加入上下文池，供后续块去重参考
    for (const r of chunk) contextPool.push(r);
  }

  const summarized = { added: added, merged: merged, recategorized: recategorized, rescored: rescored, sunk: sunkCount };
  if (preview) {
    return { ok: true, preview: true, found: found, to_clean: toCleanCount, ...summarized, changes: changes, error: llmError };
  }
  if (llmError) return { ok: false, error: llmError };

  const backup = await backupPoolFile();
  const toCleanIds = new Set();
  for (const r of sortedToClean) toCleanIds.add(r.id);
  let appliedAdd = 0;
  for (const ch of changes) {
    if (ch.type === "add") {
      const rr = await add({ content: ch.content, category: ch.category, importance: ch.importance, source: "clean" });
      if (!rr.dup) appliedAdd++;
    } else if (ch.type === "sink") {
      sink(ch.id);
      if (ch.superseded_by) { const it = get(ch.id); if (it) { it.superseded_by = ch.superseded_by; dirty = true; } }
    } else {
      update(ch.id, { content: ch.to.content, category: ch.to.category, importance: ch.to.importance, active: ch.sink ? false : undefined });
    }
  }
  // 打标记：本次全量处理过的待清洗记忆，下次不再重复清洗
  for (const r of rows) {
    if (toCleanIds.has(r.id)) { r.cleaned_at = nowIso(); r.updated_at = nowIso(); }
  }
  dirty = true;
  flush();
  return { ok: true, preview: false, found: found, to_clean: toCleanCount, added: appliedAdd, merged: merged, recategorized: recategorized, rescored: rescored, sunk: sunkCount, backup: backup, changes: changes };
}

// 记忆池词云关键词：从池内 active 记忆内容提取高频重点词（复用 memory-engine 分词/停用词）
// 旧实现读取已废弃的 memories.json，这里改为读 memory_pool.json，符合数据源统一策略
function poolKeywords(limit) {
  if (limit === undefined) limit = 80;
  let extract = null;
  let stop = null;
  try {
    const me = require("./memory-engine");
    extract = me.extractKeywordsFromText;
    stop = me.KEYWORD_STOP_WORDS;
  } catch (e) { /* 不可用时返回空 */ }
  if (typeof extract !== "function") return [];
  const rows = load().filter(function (r) { return r.active !== false; });
  const counts = new Map();
  let total = 0;
  for (const m of rows) {
    total++;
    const imp = Math.max(0.3, Number(m.importance) || 0.5);
    const seen = new Set();
    for (const w of extract(m.content)) {
      if (seen.has(w)) continue;
      seen.add(w);
      const cur = counts.get(w) || { count: 0, weight: 0 };
      cur.count += 1;
      cur.weight += imp;
      counts.set(w, cur);
    }
  }
  const N = Math.max(2, total);
  return Array.from(counts.entries())
    .filter(function (e) { return e[1].count >= 2 && e[0].length >= 2 && !(stop && stop.has(e[0])); })
    .map(function (e) {
      return { word: e[0], count: e[1].count, weight: Math.round(e[1].weight * Math.log(N / e[1].count) * 10) / 10 };
    })
    .sort(function (a, b) { return b.weight - a.weight || b.count - a.count; })
    .slice(0, Math.max(1, Number(limit) || 80));
}

function setConfig(updates) {
  if (READONLY) return getConfig();
  Object.assign(CONFIG, updates || {});
  try { atomicWriteJson(POOL_CONFIG_FILE, CONFIG); } catch (e) {}
  return CONFIG;
}

function getConfig() { return { ...CONFIG }; }

module.exports = {
  init, shutdown, flush,
  CATEGORIES,
  list, stats, get, add, update, remove, sink, revive,
  retrieve, retrieveHybrid, breath, warmVectors, ingestSummary, parseCategoryBlocks, reparseSummaryViaLLM, buildReparsePrompt,
  contentSimilarity, tokensOf, decayFactor, scoreOf,
  buildCleanPrompt, cleanPool,
  setConfig, getConfig, poolKeywords
};
