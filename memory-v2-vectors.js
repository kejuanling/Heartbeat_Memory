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

// 1005-17：embed 文本拼 vibe（kind：text，情景：vibe）——语义向量带上氛围质感；
// 注意：存量向量未含 vibe，重跑补标签后需重算向量才生效（改法：memory_v2_vectors.json 删除后自动补算）。
function embedText(r) {
  const vibe = r && typeof r.vibe === "string" && r.vibe.trim() ? r.vibe.trim() : null;
  return r.kind + "：" + r.text + (vibe ? "，情景：" + vibe : "");
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
    const vecs = await embedClient.embedBatch(batch.map(function (r) { return embedText(r); }), false, EMBED_TIMEOUT_MS);
    if (!vecs || vecs.length !== batch.length) return false;
    const m = vecMap();
    batch.forEach(function (r, j) {
      if (vecs[j] && vecs[j].length) m[r.id] = { h: entryHash(r), v: vecs[j] };
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
        if (vecs[i] && vecs[i].length) m[r.id] = { h: entryHash(r), v: vecs[i] };
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

// ---------------- 检索（0919 memory_search 数据源切 V2；0920 删重要级/时间衰减，用户拍板） ----------------
// 权重：0.55 语义余弦(bge) + 0.20 字面；embed 不可用回落纯字面。字面分词用 V2 自有 adapter
// （铁律：V2 不 require 旧池模块，故不直接复用旧池 contentSimilarity）。恒只读集合：不计数、不自动置顶。

const { tokenize, similarity } = require("./context-v2-adapter");

// 输出形状对齐旧池接口（memory_search 工具契约：id/content/category/pinned；importance 已删）
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

// 1003-08 用户拍板：memory_search 完全按关键词命中（去语义余弦）：
// q 分词后逐条统计命中词元数（hits），0 命中不返回；排序 = 命中数降序，同级按最新在前。
// 返回只保留 {id, content}（id 供 memory_pin/update；其余字段工具不再透传）。
// 1005-19：检索工具独立配置（memory_search 段，默认词面0.5/语义0.3/无门槛/最多5条）
function readMemorySearchCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "memory_v2_config.json"), "utf-8"));
    return (c && c.memory_search && typeof c.memory_search === "object") ? c.memory_search : {};
  } catch (e) { return {}; }
}

async function retrieveHybrid(rows, query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  // 1005-19 检索工具混合分升级（memory_search 主路径）：原实现是纯字面词元命中计数，名不副实。
  // 现与相关注入同款混合分：词面分 = max(triggers 命中分, 全文双字词元交叠比例)（无标签存量记忆也能搜到），
  // 语义分 = bge 余弦（复用 relevantScores，embed 不可用则纯词面），混合 = wordWeight×词面 + semWeight×语义。
  const cfg = readMemorySearchCfg();
  const wl = (cfg.wordWeight >= 0) ? cfg.wordWeight : 0.5;
  const ws = (cfg.semWeight >= 0) ? cfg.semWeight : 0.3;
  const gate = (cfg.minScore >= 0) ? cfg.minScore : 0;
  const topK = Math.max(1, Number(opts.topK) || 5); // 返回条数由调用方指定，不设固定上限
  const pool = rows.filter(r => (!opts.pinnedOnly || r.anchor === true) && (!opts.kind || r.kind === opts.kind));
  if (!pool.length) return [];
  let semScores = null;
  try {
    const sr = await relevantScores(pool, q);
    if (sr && sr.ok) semScores = sr.scores;
  } catch (e) { semScores = null; }
  const qset = new Set([...tokenize(q)].filter(function (x) { return x.length >= 2; }));
  const scored = [];
  for (const r of pool) {
    let lit = 0;
    const tr = Array.isArray(r.triggers) ? r.triggers : [];
    if (tr.length) {
      for (const t of tr) {
        const s = String(t || "").trim();
        if (!s) continue;
        if (q.indexOf(s) >= 0) { lit = 1; break; }
        const tt = [...tokenize(s)].filter(function (x) { return x.length >= 2; });
        if (tt.length && qset.size) {
          let h = 0;
          for (const x of tt) if (qset.has(x)) h++;
          if (h > 0) lit = Math.max(lit, h / tt.length);
        }
      }
    }
    if (!(lit > 0) && qset.size) {
      const tw = new Set([...tokenize(r.text)].filter(function (x) { return x.length >= 2; }));
      if (tw.size) {
        let h = 0;
        for (const x of qset) if (tw.has(x)) h++;
        lit = Math.max(lit, h / qset.size);
      }
    }
    if (!(lit > 0) && !semScores) continue; // 词面语义都拿不到分的不返回
    const sem = semScores ? (semScores[r.id] != null ? semScores[r.id] : 0) : 0;
    const score = Math.round((wl * lit + ws * sem) * 1000) / 1000;
    if (score < gate) continue;
    scored.push({ r, score });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
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

module.exports = { ensureVectors, warmVectors, startWarmup, pruneVectors, similarGroups, retrieveHybrid, recent, breath, relevantScores };
