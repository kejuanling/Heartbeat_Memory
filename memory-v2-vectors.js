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

// 同步补齐缺失向量（管理台点击触发，条目量小可等待）；分批请求，每批立即落盘
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
  // 清理集合里已不存在的 id（归档条目 revive 后会重算，量小无妨）
  const ids = new Set(rows.map(function (r) { return r.id; }));
  const m = vecMap();
  let pruned = false;
  for (const k of Object.keys(m)) {
    if (!ids.has(k)) { delete m[k]; pruned = true; }
  }
  if (pruned) saveVecMap();
  return true;
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

module.exports = { ensureVectors, similarGroups, entryHash, VECTOR_FILE };
