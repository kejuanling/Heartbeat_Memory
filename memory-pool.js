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

const DATA_DIR = process.env.MEMORY_DATA_DIR || path.join(__dirname, "data");
const POOL_FILE = path.join(DATA_DIR, "memory_pool.json");
const POOL_CONFIG_FILE = path.join(DATA_DIR, "memory_pool_config.json");

let cache = null;
let flushTimer = null;
let dirty = false;

const CATEGORIES = ["关于她", "关于我们", "锚点", "信号", "对话摘要"];
const CATEGORY_LABELS = {
  关于她: "关于她（她是谁）",
  关于我们: "关于我们（怎么相处）",
  锚点: "锚点（原话）",
  信号: "信号（状态变化）",
  对话摘要: "对话摘要（聊过什么）"
};

// 去重阈值：同类目相似度 >= 视为同一条
const DEFAULT_DEDUP_THRESHOLD = 0.78;
const DEFAULT_DEDUP_CROSS_THRESHOLD = 0.92; // 跨类目：相似度 >= 才合并，防跨类误合并
const DEFAULT_DEDUP_ANCHOR_THRESHOLD = 0.96; // 锚点原话：几乎一字不差才合并
const DEFAULT_DECAY_DAYS = 30;      // 30 天重要级衰减半衰期

const CONFIG = {
  dedup_threshold: DEFAULT_DEDUP_THRESHOLD,
  dedup_cross_threshold: DEFAULT_DEDUP_CROSS_THRESHOLD,
  dedup_anchor_threshold: DEFAULT_DEDUP_ANCHOR_THRESHOLD,
  decay_days: DEFAULT_DECAY_DAYS,
  retrieval_top_k: 5,
  // 跨窗口注入（日记 / 高重要级记忆 / 标星内容）
  cross_inject_enabled: true,
  cross_inject_diary: true,
  cross_inject_memory: true,
  cross_inject_starred: true,
  cross_inject_diary_days: 3,
  cross_inject_memory_per_category: 2,
  cross_inject_summary_days: 7,
  cross_inject_starred_topk: 10,
  cross_inject_max_msgs: 2,
  cross_inject_always: false,
  // 压缩摘要再解析入库（LLM）：总开关 + 温暖风格
  reparse_enabled: true,
  reparse_warm: false,
  reparse_system_prompt: "",
  reparse_user_prompt: "",
  reparse_max_chars: 30,
  reparse_max_items: 8
};

// 进程内已解析过的摘要哈希，短时间不重复调用 LLM
const ingestedHashes = new Set();

const STOP_CHARS = new Set("的了我是你他它她这在在有也就说都还被把让跟和与或但而而且还再不没这那们个种些去来到上下前后时次天点会能要想觉得自己什么怎么这样那样现在然后因为所以但是如果感觉时候东西应该可以已经知道看到听到想到".split(""));

// ---------------- 工具 ----------------
function nowIso() { return new Date().toISOString(); }

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
    cache = Array.isArray(await fs.readJson(POOL_FILE)) ? await fs.readJson(POOL_FILE) : [];
  } catch (e) {
    cache = [];
  }
  try {
    Object.assign(CONFIG, await fs.readJson(POOL_CONFIG_FILE));
  } catch (e) {}
  flushTimer = setInterval(flush, 5000);
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

async function shutdown() { if (flushTimer) clearInterval(flushTimer); flush(); }

function saveNow() { atomicWriteJson(POOL_FILE, cache); dirty = false; }

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

function add(entry) {
  const rows = load();
  const e = normalizeEntry(entry);
  const dup = findDuplicate(e);
  if (dup) {
    // 合并：保留更高重要级，轻微上浮；不新增重复条目
    const merged = mergeEntries(dup, e);
    dup.importance = merged.importance;
    dup.content = merged.content;
    dup.category = merged.category;
    dup.similarity = merged.similarity;
    dup.updated_at = nowIso();
    dup.source = dup.source || e.source;
    dirty = true; flush();
    return { entry: dup, dup: true };
  }
  rows.push(e);
  dirty = true; flush();
  return { entry: e, dup: false };
}

function update(id, patch) {
  const rows = load();
  const it = rows.find(r => r.id === id);
  if (!it) return null;
  if (patch.content !== undefined) it.content = String(patch.content).trim();
  if (patch.category !== undefined && CATEGORIES.includes(patch.category)) it.category = patch.category;
  if (patch.importance !== undefined) it.importance = Math.max(0, Math.min(1, Number(patch.importance) || 0));
  if (patch.pinned !== undefined) it.pinned = !!patch.pinned;
  if (patch.active !== undefined) it.active = !!patch.active;
  it.updated_at = nowIso();
  dirty = true; flush();
  return it;
}

function remove(id) {
  const rows = load();
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return false;
  rows.splice(i, 1);
  dirty = true; flush();
  return true;
}

function sink(id) {
  const it = get(id);
  if (!it) return null;
  it.active = false;
  it.updated_at = nowIso();
  dirty = true; flush();
  return it;
}

function revive(id) {
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
  if (best) best.similarity = Math.max(bestSim, best.similarity || 0);
  return best;
}

function mergeEntries(dup, e) {
  const imp = Math.max(Number(dup.importance) || 0, Number(e.importance) || 0) + 0.02;
  const content = String(e.content || "").length > String(dup.content || "").length ? e.content : dup.content;
  return {
    importance: Math.min(1, imp),
    content,
    category: e.category || dup.category,
    similarity: Math.max(Number(dup.similarity) || 0, Number(e.similarity) || 0)
  };
}

function supersedeBlock(blockId) {
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
// 返回 topK 条；仅统计检索次数，不自动置顶（置顶由管理台手动固定）
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
  for (const p of picked) {
    p.r.retrieval_count = Number(p.r.retrieval_count || 0) + 1;
    p.r.last_retrieved_at = nowIso();
    p.r.updated_at = nowIso();
    dirty = true;
  }
  if (picked.length) flush();
  return picked.map(p => ({ ...p.r, _score: Math.round(p.score * 1000) / 1000 }));
}

// ---------------- 压缩摘要 → 记忆池 ----------------
// 从压缩摘要里提取【分类】标记文本（正则兜底），再调用 LLM 客观再解析 → 结构化记忆
function parseCategoryBlocks(text) {
  const blocks = [];
  const re = /【([^】]+)】\s*([\s\S]*?)(?=【[^】]+】|$)/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const cat = m[1].trim();
    const body = m[2].trim();
    if (!CATEGORIES.includes(cat)) continue;
    // 按条目拆（行首破折号/短横线）；没有则整段当作一条
    const parts = body.split(/\n\s*(?:[—–-]\s*|•\s*)/).map(s => s.trim()).filter(Boolean);
    for (const p of parts.length ? parts : [body]) {
      if (p) blocks.push({ category: cat, content: p });
    }
  }
  if (blocks.length) return blocks;

  // 无分类标记：整段按“对话摘要”兜底
  const t = String(text || "").trim();
  if (t) return [{ category: "对话摘要", content: t }];
  return [];
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
  if (CONFIG.reparse_enabled === false) {
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
    let arr = null;
    try { arr = JSON.parse(cleaned); } catch (e) {
      const mm = cleaned.match(/\[[\s\S]*\]/);
      if (mm) { try { arr = JSON.parse(mm[0]); } catch (e2) {} }
    }
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
  const source = opts.source || "compaction";
  const blockId = opts.block_id || null;
  const hash = crypto.createHash("sha1").update(String(summaryText || "")).digest("hex");
  if (!opts.force && ingestedHashes.has(hash)) {
    return { ok: true, skipped: true, added: 0, merged: 0, failed: 0 };
  }
  ingestedHashes.add(hash);
  const parsed = await reparseSummaryViaLLM(summaryText, opts.llm);
  // 同一来源块的新版摘要入库时，先把旧版该块的记忆沉底，避免“同块换摘要留两条”
  supersedeBlock(blockId);
  const parsedMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  let added = 0, merged = 0, failed = 0;
  for (const m of parsedMemories) {
    const r = add({
      content: m.content,
      category: m.category,
      importance: m.importance,
      source,
      block_id: blockId
    });
    if (r.dup) merged++; else added++;
  }
  return { ok: true, added, merged, failed, fallback: !!parsed.fallback, error: parsed.error || null };
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
  Object.assign(CONFIG, updates || {});
  try { atomicWriteJson(POOL_CONFIG_FILE, CONFIG); } catch (e) {}
  return CONFIG;
}

function getConfig() { return { ...CONFIG }; }

module.exports = {
  init, shutdown, flush,
  CATEGORIES, CATEGORY_LABELS,
  list, stats, get, add, update, remove, sink, revive,
  retrieve, ingestSummary, parseCategoryBlocks, reparseSummaryViaLLM, buildReparsePrompt,
  contentSimilarity, tokensOf, decayFactor, scoreOf,
  setConfig, getConfig, poolKeywords,
  get file() { return POOL_FILE; }
};
