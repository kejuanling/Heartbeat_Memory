"use strict";

// ========================
// Memory V2 向量旁路（0919 管理台「相似」分组用）
// 职责单一：给 V2 活跃条目补算语义向量（embed-server bge-small-zh）+ 旁路缓存 + 相似分组聚类。
// 铁律对齐 memory-v2.js：
//   1. 只读集合本体——本模块绝不写 memory_v2.json / memory_review_queue.json；
//   2. 唯一落盘是旁路缓存 data/memory_v2_vectors.json（形状同旧池 {id:{h指纹,v向量}}）；
//   3. 嵌入文本 = kind + "：" + text（对齐旧池 category+"："+content 口径）。
// embed-server 熔断/失败：ensureVectors 返回 false，路由向前端报「向量服务不可用」；
// 已完成批次已落盘，下次点击从断点续算。
// ========================

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const embedClient = require("./utils/embed-client");

const VECTOR_FILE = path.join(__dirname, "data", "memory_v2_vectors.json");
const EMBED_BATCH_SIZE = 16; // 单次 embed 请求条数上限（50 条全量 4 批内完成）
const EMBED_TIMEOUT_MS = 12000;

let vectorCache = null;

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

// 内容指纹：kind/text 任一变化即视为失效（同旧池 entryHash 思路）
function entryHash(e) {
  return crypto.createHash("sha1").update(String(e.kind || "") + "\u0000" + String(e.text || "")).digest("hex").slice(0, 12);
}

function missingVectors(rows) {
  const m = vecMap();
  return rows.filter(function (r) {
    const c = m[r.id];
    return !c || c.h !== entryHash(r) || !Array.isArray(c.v) || c.v.length === 0;
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
    const vecs = await embedClient.embedBatch(batch.map(function (r) { return r.kind + "：" + r.text; }), false, EMBED_TIMEOUT_MS);
    if (!vecs || vecs.length !== batch.length) return false;
    const m = vecMap();
    batch.forEach(function (r, j) {
      if (vecs[j] && vecs[j].length) m[r.id] = { h: entryHash(r), v: vecs[j] };
    });
    saveVecMap();
  }
  return true;
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
    .map(function (r) { return { id: r.id, vec: (m[r.id] || {}).v }; })
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

// ---------------- 检索（0919 memory_search 数据源切 V2：公式沿用旧池，数据换新池） ----------------
// 权重对齐旧池 retrieveHybrid：0.55 语义余弦(bge) + 0.20 字面 + 0.25 重要级×时间衰减（半衰期30天）；
// embed 不可用回落旧池 retrieve 字面公式（0.6 字面 + 0.4 重要级）。字面分词用 V2 自有 adapter
// （铁律：V2 不 require 旧池模块，故不直接复用旧池 contentSimilarity）。恒只读集合：不计数、不自动置顶。

const { tokenize, similarity } = require("./context-v2-adapter");

function decayFactor(e) {
  const t = new Date(e.content_updated_at || e.created_at || "").getTime();
  if (isNaN(t)) return 1;
  const ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / 30);
}

// 输出形状对齐旧池接口（memory_search 工具契约：id/content/category/importance/pinned）
function toItem(r) {
  return {
    id: r.id,
    content: r.text,
    category: r.kind,
    importance: r.priority,
    pinned: r.anchor === true,
    created_at: r.created_at,
    updated_at: r.content_updated_at || r.created_at,
  };
}

async function retrieveHybrid(rows, query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const topK = Math.max(1, Number(opts.topK) || 5);
  const pool = rows.filter(r => (!opts.pinnedOnly || r.anchor === true) && (!opts.kind || r.kind === opts.kind));
  if (!pool.length) return [];
  const qt = tokenize(q);
  const ready = await ensureVectors(pool);
  let qv = null;
  if (ready) {
    const v = await embedClient.embedBatch([q], true, 8000); // 查询侧按 BGE 约定加指令前缀
    if (v && v[0] && v[0].length) qv = v[0];
  }
  const m = vecMap();
  const scored = pool.map(r => {
    const vec = (m[r.id] || {}).v;
    const sem = qv && vec ? Math.max(0, cosine(qv, vec)) : 0; // 均已归一化，点积即余弦
    const lit = qt.size ? similarity(qt, r.text + " " + (r.kind || "")) : 0;
    const imp = Number(r.priority) || 0.5;
    const decay = decayFactor(r);
    const score = qv ? (0.55 * sem + 0.20 * lit + 0.25 * imp * decay) : (0.6 * lit + 0.4 * imp * decay);
    return { r, sem, score };
  });
  scored.sort((a, b) => b.score - a.score || b.sem - a.sem);
  return scored.slice(0, topK).map(p => toItem(p.r));
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

// 呼吸：浮现记忆（未沉底，优先置顶 > 重要级 > 最近更新）。用于 memory_search 的 breath 开关。
function breath(rows, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 3, 5));
  const pool = rows.filter(r => !opts.kind || r.kind === opts.kind);
  pool.sort((a, b) => {
    const pinA = a.anchor === true ? 1 : 0, pinB = b.anchor === true ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    const impA = Number(a.priority) || 0, impB = Number(b.priority) || 0;
    if (impA !== impB) return impB - impA;
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
  const qv = await embedClient.embedBatch([q], true, 8000); // 查询侧按 BGE 约定加指令前缀
  if (!qv || !qv[0] || !qv[0].length) return { ok: false, scores: null };
  const m = vecMap();
  const scores = {};
  for (const r of rows) {
    const v = (m[r.id] || {}).v;
    if (!Array.isArray(v) || !v.length) continue; // 无向量条目不参与语义注入（宁缺毋滥）
    scores[r.id] = Math.round(Math.max(0, cosine(qv[0], v)) * 1000) / 1000;
  }
  return { ok: true, scores };
}

module.exports = { ensureVectors, pruneVectors, similarGroups, retrieveHybrid, recent, breath, relevantScores, entryHash, decayFactor, VECTOR_FILE };
