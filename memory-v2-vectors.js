"use strict";

// ========================
// Memory V2 向量旁路：SiliconFlow BAAI/bge-m3 + 旁路缓存 + 相似分组聚类。
// memory_search 只走关键词；向量仅用于 event 相关注入与管理台相似分组。
// 铁律对齐 memory-v2.js：
//   1. 只读集合本体——本模块绝不写 memory_v2.json / memory_review_queue.json；
//   2. 唯一落盘是旁路缓存 data/memory_v2_vectors.json（形状 {id:{h指纹,model:模型名,v向量}}）；
//   3. 嵌入文本 = kind + "：" + text；只有 event 额外带 vibe。
// SiliconFlow Embeddings API 失败：ensureVectors 返回 false，相关注入回落到词面路径；
// 已完成批次已落盘，下次点击从断点续算。
// ========================

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const embedClient = require("./utils/memory-embed-client");

const VECTOR_FILE = path.join(__dirname, "data", "memory_v2_vectors.json");
const VIBE_VECTOR_FILE = path.join(__dirname, "data", "memory_v2_vibe_vectors.json");
const EMBED_BATCH_SIZE = 16; // 小批量请求，降低单次超时和速率限制风险
const EMBED_TIMEOUT_MS = 12000;

let vectorCache = null;
let vibeVectorCache = null;

// event 的 vibe 是注入链语义补充；fact/rule 不依赖 triggers/vibe。
function embedText(r) {
  const base = String(r && r.kind || "") + "：" + String(r && r.text || "");
  const vibe = r && r.kind === "event" && typeof r.vibe === "string" && r.vibe.trim() ? r.vibe.trim() : null;
  return base + (vibe ? "，情景：" + vibe : "");
}

function vecMap() {
  if (!vectorCache) {
    try { vectorCache = fs.readJsonSync(VECTOR_FILE); } catch (e) { vectorCache = {}; }
    if (!vectorCache || typeof vectorCache !== "object" || Array.isArray(vectorCache)) vectorCache = {};
  }
  return vectorCache;
}

function saveVecMap() {
  const tmp = VECTOR_FILE + ".tmp";
  fs.writeJsonSync(tmp, vectorCache);
  fs.renameSync(tmp, VECTOR_FILE);
}

// Separate cache for vibe-only relevance vectors; keep body vectors intact for admin similarity groups.
function vibeVecMap() {
  if (!vibeVectorCache) {
    try { vibeVectorCache = fs.readJsonSync(VIBE_VECTOR_FILE); } catch (_) { vibeVectorCache = {}; }
    if (!vibeVectorCache || typeof vibeVectorCache !== "object" || Array.isArray(vibeVectorCache)) vibeVectorCache = {};
  }
  return vibeVectorCache;
}

function saveVibeVecMap() {
  const tmp = VIBE_VECTOR_FILE + ".tmp";
  fs.writeJsonSync(tmp, vibeVectorCache);
  fs.renameSync(tmp, VIBE_VECTOR_FILE);
}

function vibeText(r) { return String(r && r.vibe || "").trim(); }
function vibeHash(r) {
  return crypto.createHash("sha1").update(String(embedClient.EMBED_MODEL || "unknown") + "\u0000vibe\u0000" + vibeText(r)).digest("hex").slice(0, 16);
}

async function ensureVibeVectors(rows) {
  const cache = vibeVecMap();
  const eligible = (Array.isArray(rows) ? rows : []).filter(r => r && r.kind === "event" && vibeText(r));
  const missing = eligible.filter(r => {
    const c = cache[r.id];
    return !c || c.model !== embedClient.EMBED_MODEL || c.h !== vibeHash(r) || !Array.isArray(c.v) || !c.v.length;
  });
  if (!missing.length) return true;
  if (embedClient.fused()) return false;
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embedClient.embedBatch(batch.map(vibeText), false, EMBED_TIMEOUT_MS);
    if (!vecs || vecs.length !== batch.length) return false;
    for (let j = 0; j < batch.length; j++) {
      if (vecs[j] && vecs[j].length) cache[batch[j].id] = { h: vibeHash(batch[j]), model: embedClient.EMBED_MODEL, v: vecs[j] };
    }
    saveVibeVecMap();
  }
  return true;
}

// 指纹包含模型版本与实际嵌入文本；切模型/改正文/改 event vibe 都会自动失效。
function entryHash(e) {
  return crypto.createHash("sha1").update(String(embedClient.EMBED_MODEL || "unknown") + "\u0000" + embedText(e)).digest("hex").slice(0, 16);
}

function missingVectors(rows) {
  const m = vecMap();
  return rows.filter(function (r) {
    const c = m[r.id];
    return !c || c.model !== embedClient.EMBED_MODEL || c.h !== entryHash(r) || !Array.isArray(c.v) || c.v.length === 0;
  });
}

// 同步补齐缺失向量（调用方可等待，条目量小可接受）；分批请求，每批立即落盘。
// 注意：本函数不做缓存清理——检索场景传入的是过滤子集，按子集清理会误删全量缓存；
// 清理请显式调 pruneVectors(全量rows)。
async function ensureVectors(rows) {
  const missing = missingVectors(rows);
  if (!missing.length) return true;
  if (embedClient.fused()) return false;
  for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embedClient.embedBatch(batch.map(function (r) { return embedText(r); }), false, EMBED_TIMEOUT_MS);
    if (!vecs || vecs.length !== batch.length) return false;
    const m = vecMap();
    batch.forEach(function (r, j) {
      if (vecs[j] && vecs[j].length) m[r.id] = { h: entryHash(r), model: embedClient.EMBED_MODEL, v: vecs[j] };
    });
    saveVecMap();
  }
  return true;
}

// ---- 后台预热（2026-09-28 用户拍板，对齐旧池机制）----
// 启动 8s 后 + 每 10 分钟增量兜底：补齐全量 active 条目的缺失向量（含历史存量/漏算），
// 让首次检索不必现场补算。embed 熔断时自动停，恢复后下一周期续跑；批次断点续算，绝不全量塞进一个请求。
const WARM_BATCH_SIZE = 16;
const WARM_PAUSE_MS = 2000;
let warmPromise = null;

async function warmVectors() {
  if (embedClient.fused()) return false;
  if (warmPromise) return warmPromise;
  warmPromise = (async function () {
    let completed = 0;
    while (!embedClient.fused()) {
      const { createStore } = require("./memory-v2"); // 动态 require：避免与 memory-v2 的即时向量产生循环依赖
      const rows = createStore({ config: {} }).list({ status: "active" });
      const missing = missingVectors(rows);
      if (!missing.length) break;
      const batch = missing.slice(0, WARM_BATCH_SIZE);
      const vecs = await embedClient.embedBatch(batch.map(function (r) { return embedText(r); }), false, EMBED_TIMEOUT_MS);
      if (!vecs || vecs.length !== batch.length) return completed > 0;
      const m = vecMap();
      batch.forEach(function (r, i) {
        if (vecs[i] && vecs[i].length) m[r.id] = { h: entryHash(r), model: embedClient.EMBED_MODEL, v: vecs[i] };
      });
      saveVecMap();
      completed += batch.length;
      if (batch.length < WARM_BATCH_SIZE) break;
      await new Promise(function (res) { setTimeout(res, WARM_PAUSE_MS); });
    }
    return completed > 0;
  })().finally(function () { warmPromise = null; });
  return warmPromise;
}

// 启动调度：8s 首轮预热 + 每 10 分钟增量（由 server.js 启动时调用一次）
function startWarmup() {
  setTimeout(function () { warmVectors().catch(function () {}); }, 8000);
  setInterval(function () { warmVectors().catch(function () {}); }, 10 * 60 * 1000);
}

// 清理集合里已不存在的 id（调用方须传全量行；归档条目 revive 后会重算，量小无妨）
function pruneVectors(rows) {
  const ids = new Set(rows.map(function (r) { return r.id; }));
  const m = vecMap();
  let pruned = false;
  for (const k of Object.keys(m)) {
    if (!ids.has(k)) { delete m[k]; pruned = true; }
  }
  if (pruned) saveVecMap();
}

// 向量均已 L2 归一化，点积即余弦
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

// 相似分组：两两余弦过阈值 → 并查集贪心聚类，只保留 ≥2 条的组，组间按最高相似度降序
function similarGroups(rows, threshold) {
  const m = vecMap();
  const items = rows
    .map(function (r) { const c = m[r.id] || {}; return { id: r.id, vec: c.model === embedClient.EMBED_MODEL ? c.v : null }; })
    .filter(function (x) { return Array.isArray(x.vec) && x.vec.length; });
  const parent = new Map(items.map(function (x) { return [x.id, x.id]; }));
  function find(x) {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  }
  const pairSim = new Map();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = Math.round(cosine(items[i].vec, items[j].vec) * 1000) / 1000;
      if (s >= threshold) {
        pairSim.set(pairKey(items[i].id, items[j].id), s);
        parent.set(find(items[i].id), find(items[j].id));
      }
    }
  }
  const clusters = new Map();
  for (const it of items) {
    const root = find(it.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(it.id);
  }
  const groups = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    let maxSim = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const s = pairSim.get(pairKey(members[i], members[j]));
        if (s != null && s > maxSim) maxSim = s;
      }
    }
    groups.push({ max_sim: maxSim, ids: members });
  }
  groups.sort(function (a, b) { return b.max_sim - a.max_sim; });
  return groups;
}

// ---------------- memory_search：纯关键词检索 ----------------
// 不调用向量模型，也不读取 triggers/vibe；默认跨 fact/rule/event 全分类检索。
// 使用关键词覆盖率 + 词频逆权重，降低常见中文双字词带来的误命中；完整短语命中优先。
const { tokenize } = require("./context-v2-adapter");

function toItem(r) {
  return {
    id: r.id,
    content: r.text,
    category: r.kind,
    pinned: r.anchor === true,
    created_at: r.created_at,
    updated_at: r.content_updated_at || r.created_at,
  };
}

async function retrieveHybrid(rows, query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const qset = new Set([...tokenize(q)].filter(x => x.length >= 2));
  if (!qset.size) return [];
  const topK = Math.max(1, Number(opts.topK) || 5);
  const pool = (Array.isArray(rows) ? rows : []).filter(r =>
    r && (!opts.pinnedOnly || r.anchor === true) && (!opts.kind || r.kind === opts.kind)
  );
  if (!pool.length) return [];

  const tokenSets = new Map();
  const documentFrequency = new Map();
  for (const r of pool) {
    const words = new Set([...tokenize(r.text || "")].filter(x => x.length >= 2));
    tokenSets.set(r.id, words);
    for (const token of words) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const weight = token => Math.log(1 + pool.length / ((documentFrequency.get(token) || 0) + 1));
  let totalWeight = 0;
  for (const token of qset) totalWeight += weight(token);
  if (!totalWeight) return [];

  const scored = [];
  for (const r of pool) {
    const text = String(r.text || "");
    const phraseHit = text.toLowerCase().includes(q.toLowerCase());
    const words = tokenSets.get(r.id) || new Set();
    let hits = 0, matchedWeight = 0;
    for (const token of qset) {
      if (words.has(token)) { hits++; matchedWeight += weight(token); }
    }
    const coverage = matchedWeight / totalWeight;
    // 对非短语匹配要求至少命中两个词元（单词元查询除外），且覆盖至少一半查询权重；
    // 避免“服务器重启”仅命中“服务器”就误召回学校服务器相关记忆。
    if (!phraseHit && (hits < Math.min(2, qset.size) || coverage < 0.5)) continue;
    scored.push({ r, score: phraseHit ? 1 + coverage : coverage, hits });
  }
  scored.sort((a, b) => b.score - a.score || b.hits - a.hits ||
    String(b.r.content_updated_at || b.r.created_at || "").localeCompare(String(a.r.content_updated_at || a.r.created_at || "")));
  return scored.slice(0, topK).map(s => ({ id: s.r.id, content: s.r.text }));
}

// 最近列表：按正文更新时间倒序（V2 无检索计数污染，content_updated_at 只在正文变化时刷）
function recent(rows, opts = {}) {
  const topK = Math.max(1, Number(opts.topK) || 5);
  const out = rows.filter(r => !opts.pinnedOnly || r.anchor === true);
  out.sort((a, b) => {
    const ua = String(a.content_updated_at || a.created_at || ""), ub = String(b.content_updated_at || b.created_at || "");
    return ua < ub ? 1 : (ua > ub ? -1 : 0);
  });
  return out.slice(0, topK).map(r => toItem(r));
}

// 呼吸：浮现记忆（未沉底，优先置顶 > 最近更新）。用于 memory_search 的 breath 开关。
function breath(rows, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 3, 5));
  const pool = rows.filter(r => !opts.kind || r.kind === opts.kind);
  pool.sort((a, b) => {
    const pinA = a.anchor === true ? 1 : 0, pinB = b.anchor === true ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    const ua = String(a.content_updated_at || a.created_at || ""), ub = String(b.content_updated_at || b.created_at || "");
    return ua < ub ? 1 : (ua > ub ? -1 : 0);
  });
  return pool.slice(0, limit).map(r => toItem(r));
}

// 注入用语义打分（0919 自动注入 Relevant 升级）：给全量行算与 query 的 bge 余弦。
// builder 是纯函数禁网络 I/O，故由调用方（chat/wake）先调本函数，把 scores 挂到 input.vecScores。
// 返回 { ok, scores }；ok=false（embed 熔断/失败/空查询）时调用方不传 vecScores，builder 回落字面。
async function relevantScores(rows, query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, scores: null };
  const ready = await ensureVectors(rows);
  if (!ready) return { ok: false, scores: null };
  const qv = await embedClient.embedBatch([q], true, EMBED_TIMEOUT_MS);
  if (!qv || !qv[0] || !qv[0].length) return { ok: false, scores: null };
  const m = vecMap();
  const scores = {};
  for (const r of rows) {
    const c = m[r.id] || {};
    const v = c.model === embedClient.EMBED_MODEL ? c.v : null;
    if (!Array.isArray(v) || !v.length) continue;
    scores[r.id] = Math.round(Math.max(0, cosine(qv[0], v)) * 1000) / 1000;
  }
  return { ok: true, scores };
}

async function relevantVibeScores(rows, query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, scores: null };
  const eligible = (Array.isArray(rows) ? rows : []).filter(r => r && r.kind === "event" && vibeText(r));
  if (!eligible.length) return { ok: true, scores: {} };
  const ready = await ensureVibeVectors(eligible);
  if (!ready) return { ok: false, scores: null };
  const qv = await embedClient.embedBatch([q], true, EMBED_TIMEOUT_MS);
  if (!qv || !qv[0] || !qv[0].length) return { ok: false, scores: null };
  const cache = vibeVecMap();
  const scores = {};
  for (const r of eligible) {
    const c = cache[r.id] || {};
    const v = c.model === embedClient.EMBED_MODEL && c.h === vibeHash(r) ? c.v : null;
    if (!Array.isArray(v) || !v.length) continue;
    scores[r.id] = Math.round(Math.max(0, cosine(qv[0], v)) * 1000) / 1000;
  }
  return { ok: true, scores };
}

module.exports = { ensureVectors, ensureVibeVectors, warmVectors, startWarmup, pruneVectors, similarGroups, retrieveHybrid, recent, breath, relevantScores, relevantVibeScores };
