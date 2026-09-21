"use strict";

// ========================
// 记忆池（memory pool）
// 五类结构化长期记忆：支持重要级、自动衰减、检索计数（反复检索自动 pin）、
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
// 只读守卫（MEMORY_ENGINE_READONLY，与 memory-engine 同款）：原为 wake-up 双进程设计——
// 双进程各自整文件覆盖写会互相回滚，只读进程必须拦截一切落盘与内存改写；
// 2026-09-15 wake-up 退役后 gateway 单进程，机制保留作多进程部署防御。
const READONLY = process.env.MEMORY_ENGINE_READONLY === "1";
// 2026-09-13 审查修复：记忆池旁路 LLM 调用（重解析/清理）统一超时——上游挂起不再拖住聊天回复链路
const LLM_CALL_TIMEOUT_MS = Number(process.env.MEMORY_POOL_LLM_TIMEOUT_MS) || 60000;

let cache = null;
let flushTimer = null;
let warmTimer = null;
let dirty = false;

// ⑥ 对话碎片：用户侧入池的对话关键碎片（聊天页「入池」按钮 / 管理台手动）
// 2026-09-12 五类改造：关于她/认账/拓本 来源于 AI（memory_add 工具 / <memory> 内联标签），
// 压缩摘要 来源于压缩替换入池，对话碎片 来源于用户侧。旧四类（关于我们/锚点/信号/对话摘要）
// 取消——存量条目在清洗导入完成前仍带旧类名，读取/编辑放行（LEGACY_CATEGORIES），但不再新增。
const CATEGORIES = ["关于她", "认账", "拓本", "压缩摘要", "对话碎片"];
const LEGACY_CATEGORIES = ["关于我们", "锚点", "信号", "对话摘要"];
// AI 写入侧（memory_add / <memory> 标签）只允许前三类
const AI_CATEGORIES = ["关于她", "认账", "拓本"];
// 压缩替换入池的固定分类
const COMPACTION_CATEGORY = "压缩摘要";

// 去重阈值：同类目相似度 >= 视为同一条
const DEFAULT_DEDUP_THRESHOLD = 0.78;
const DEFAULT_DEDUP_CROSS_THRESHOLD = 0.92; // 跨类目：相似度 >= 才合并，防跨类误合并
const DEFAULT_DEDUP_ANCHOR_THRESHOLD = 0.96; // 拓本原话：几乎一字不差才合并
const DEFAULT_DEDUP_SEMANTIC_THRESHOLD = 0.80; // 语义近邻：同分类余弦 >= 视为同一条
const DEFAULT_DEDUP_SEMANTIC_CROSS_THRESHOLD = 0.86; // 语义近邻：跨分类（防误合并）
const DEFAULT_DEDUP_SEMANTIC_ANCHOR_THRESHOLD = 0.93; // 语义近邻：拓本原话（近义才合并）
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
  // ⚠️ 2026-09-21（审查 R17，用户拍板删除）起，下面 reparse_enabled / reparse_warm /
  // reparse_max_chars / reparse_max_items 四个键**已无任何功能性读取点**，仅为管理台表单
  // 往返兼容而保留。LLM 再解析分支已从 reparseSummaryViaLLM 删除；管理台「解析原文进 review」
  // 实际走 server.js 的 extractMemoryCandidates() → memoryV2Admission.submitPromotion（全落 review），
  // 其提示词由 reparse_system_prompt / reparse_user_prompt 驱动（这两个仍在用）。
  // 调这个功能请改 extractMemoryCandidates，不要改上面四个开关——改了不起作用。
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

// 原话类条目（拓本 + 旧「锚点」存量）：去重阈值最高、跨类绝不合并、内容绝不改写
function isVerbatimCat(cat) { return cat === "拓本" || cat === "锚点"; }

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
// 批注 2026-09-13（审查 D2）：池文件解析失败时先备份坏文件再置空，并拒绝用空池覆盖
// 原文件——此前 catch 里静默 cache=[]，之后任意一次写操作会把全量记忆覆盖成 []。
let corruptPoolBackup = null;
let corruptWarned = false;
function quarantineCorruptPoolFile(err) {
  try {
    if (!fs.existsSync(POOL_FILE)) return;
    const bak = POOL_FILE + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copySync(POOL_FILE, bak);
    corruptPoolBackup = bak;
    console.error("[memory-pool] memory_pool.json 解析失败（" + (err && err.message) + "），坏文件已备份到 " + bak + "；池置空运行，空池状态下拒绝写回覆盖");
  } catch (e2) {
    console.error("[memory-pool] 备份损坏池文件失败:", e2.message);
    cache = [];
  }
}
async function init() {
  await fs.ensureDir(DATA_DIR);
  try {
    const arr = await fs.readJson(POOL_FILE);   // 读一次，别对同一文件连读两遍
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    quarantineCorruptPoolFile(e);
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
    const arr = fs.readJsonSync(POOL_FILE);
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    quarantineCorruptPoolFile(e);
    cache = [];
  }
  return cache;
}

// 2026-09-13 审查修复（性能节流）：向量文件（8.1MB）此前每次调用都全量同步重写——
// warmVectors 每 4 条一批批批落盘，预热期约每 5s 写一次。改为 60 秒节流：
// 节流窗口内置脏标记，由 5s flush 定时器统一落盘；shutdown 的 flush 兜底。
let _vecDirty = false;
let _vecLastSaveAt = 0;
const VEC_SAVE_THROTTLE_MS = 60 * 1000;

function flush() {
  // 2026-09-13：向量缓存的节流滞留写也挂在这里（saveVecMap 60 秒窗口内的脏标记统一落盘）
  if (_vecDirty) {
    try {
      fs.writeJsonSync(VECTOR_FILE, vectorCache);
      _vecDirty = false;
      _vecLastSaveAt = Date.now();
    } catch (e) { console.error("[memory-pool] 向量 flush 失败:", e.message); }
  }
  if (!dirty || !cache) return;
  // 批注 2026-09-13（审查 D2）：池文件此前损坏且当前仍是空池时，拒绝写回——
  // 否则一次普通的 add/flush 就把全量记忆覆盖成 []。新写入暂存内存（dirty 保持），
  // 人工核对备份文件并恢复数据后重启进程即可正常落盘。
  if (corruptPoolBackup && cache.length === 0) {
    if (!corruptWarned) {
      corruptWarned = true;
      console.error("[memory-pool] 池文件损坏未恢复，flush 拒绝用空池覆盖（备份: " + corruptPoolBackup + "）");
    }
    return;
  }
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
  if (patch.pinned !== undefined) {
    it.pinned = !!patch.pinned;
    if (it.pinned) it.pinned_at = nowIso();
    else delete it.pinned_at;
  }
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
    const involveVerbatim = isVerbatimCat(e.category) || isVerbatimCat(r.category);
    // 拓本（含旧「锚点」）：跨类绝不合并；同类仅几乎一字不差时才合并，避免改掉原话
    const th = involveVerbatim
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

// 语义向量近邻去重：用 bge 余弦抓“同义不同词”的重复（拓本跨类绝不合并）；embed 不可用时回落 null
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
    const involveVerbatim = isVerbatimCat(e.category) || isVerbatimCat(r.category);
    const th = involveVerbatim ? (sameCat ? anchorTh : Infinity) : (sameCat ? sameTh : crossTh);
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
  const rows = load().filter(r => r.active !== false && (!opts.pinnedOnly || r.pinned === true) && (!opts.category || String(r.category || "") === String(opts.category)));
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

// 节流状态见 flush() 上方声明（_vecDirty/_vecLastSaveAt/VEC_SAVE_THROTTLE_MS）
function saveVecMap() {
  if (READONLY) return;
  if (Date.now() - _vecLastSaveAt < VEC_SAVE_THROTTLE_MS) { _vecDirty = true; return; }
  try {
    fs.writeJsonSync(VECTOR_FILE, vectorCache);
    _vecDirty = false;
    _vecLastSaveAt = Date.now();
  } catch (e) { /* 缓存写失败只影响下次冷启动 */ }
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
  const rows = load().filter(r => r.active !== false && (!opts.pinnedOnly || r.pinned === true) && (!opts.category || String(r.category || "") === String(opts.category)));
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

// 最近列表：按更新时间倒序直接取 N 条（memory_search 的「最近」分类用）。
// 不做相关性打分、不计检索数——浏览式查看不能给记忆刷检索数，否则会把最近记忆顶成置顶污染注入。
function recent(opts) {
  opts = opts || {};
  const topK = Math.max(1, Number(opts.topK) || Number(CONFIG.retrieval_top_k) || 5);
  const rows = load().filter(r => r.active !== false && (!opts.pinnedOnly || r.pinned === true));
  rows.sort((a, b) => {
    const ua = String(a.updated_at || ""), ub = String(b.updated_at || "");
    return ua < ub ? 1 : (ua > ub ? -1 : 0);
  });
  return rows.slice(0, topK).map(r => ({
    id: r.id,
    content: r.content,
    category: r.category,
    importance: r.importance,
    pinned: r.pinned === true,
    created_at: r.created_at,
    updated_at: r.updated_at
  }));
}

// 一键清空全部记忆的检索计数（管理台按钮用）：计数归零、清掉最近检索时间；置顶状态不动。
function clearRetrievalStats() {
  const rows = load();
  let n = 0;
  for (const r of rows) {
    if (Number(r.retrieval_count) > 0) { r.retrieval_count = 0; n++; }
    if (r.last_retrieved_at) delete r.last_retrieved_at;
  }
  if (n) dirty = true;
  return { cleared: n };
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
  // 一键入池按摘要里现成的【分类】标签映射到新记忆分类；未知标签跳过（不入池）
  const CATEGORY_ALIAS = {
    "关于她": "关于她",
    "认账": "认账",
    "拓本": "拓本",
    "压缩摘要": COMPACTION_CATEGORY,
    "对话碎片": "对话碎片",
    "对话摘要": COMPACTION_CATEGORY
  };
  while ((m = re.exec(String(text || ""))) !== null) {
    const cat = CATEGORY_ALIAS[m[1] ? m[1].trim() : ""];
    const body = m[2].trim();
    for (const p of splitSection(body)) {
      if (p && cat) blocks.push({ category: cat, content: p });
    }
  }
  if (blocks.length) return blocks;

  // 无分类标记：默认整段按“压缩摘要”兜底；noFallback=true 时返回空（调用方决定不入池）
  if (opts.noFallback) return [];
  const t = String(text || "").trim();
  if (t) return [{ category: COMPACTION_CATEGORY, content: t }];
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

function buildReparsePrompt() {
  const system = "你是长期记忆提取器。你的任务不是总结对话，而是从对话原文中找出那些在未来再次交流时仍然有用、并且会改变你理解用户或处理方式的信息。宁可少记，也不要把聊天流水账写进长期记忆。\n" +
    "只提取有证据支持的信息，不要根据一次行为猜测人格、心理、动机或身份；不要把你自己的解释当成用户事实。区分一次性事件与稳定倾向：‘今天吃了什么’通常不记，‘长期偏好什么’才记。\n" +
    "优先提取：稳定偏好/习惯；用户明确要求以后遵守的交互规则；用户反复纠正并希望以后避免的行为；长期目标、项目背景和持续有效的约束；重要关系规则；只有在未来确实有用时才保留重要原话或里程碑。\n" +
    "不要提取：当天情绪、一次性事件、普通寒暄、玩笑调侃、聊天流水账、已经明显过期的信息、单次行为推导出的性格标签、心理分析、模型自我叙事。\n" +
    "特别注意：用户对助手的纠正、明确的‘以后不要……/以后要……/记住……’、以及会改变未来回应方式的要求，优先视为高价值规则。不要把这些规则写成对用户人格的判断。\n" +
    "每条记忆必须独立、简洁、可执行或可验证；不要复述上下文，不要加入未出现的因果关系。quote 只有在原话本身具有长期价值时才保留，而且必须逐字来自原文，不能改写。";
  const user = "从下面的对话原文中提取长期记忆候选。只输出 JSON 数组，不要输出解释。每项格式为 {\"text\":\"记忆内容\",\"kind\":\"fact|rule|quote|milestone\",\"importance\":0到1之间的小数}。没有真正值得长期记住的信息就输出 []。\n\n判断标准：如果删掉这条信息，未来再次与她交流时基本不会改变你的理解或行为，就不要提取。";
  return { system, user };
}

// 2026-09-21 审查 R17 + 用户拍板 (c)：本函数内的「LLM 再解析」分支已整段删除。
// 删除依据（三条同时成立才敢删）：
//   ① 线上 data/memory_pool_config.json 的 reparse_enabled=false，原第 854 行即提前返回，
//      下面整段 LLM 调用与结果解析在生产中从未执行；
//   ② 管理台「解析原文进 review」走的是 server.js 的 extractMemoryCandidates()——另一份实现，
//      按提示词约定的 {text,kind} 正确解析，产出经 memoryV2Admission.submitPromotion 全落 review
//      队列人工把关（server.js:3801 路由；b.direct 直接入池已于 2026-09-18 停用并返回 403）；
//   ③ 被删分支内的解析器读 it.content/it.category，而提示词 buildReparsePrompt 约定的字段是
//      {text,kind}——两者对不上使该分支恒产出 0 条却仍返回 ok:true（R17 的根因）。
// 保留函数名与调用签名（模块导出 reparseSummaryViaLLM 供外部引用），
// 行为与「删除前线上的实际行为」逐字一致：直接按【分类】块解析。
async function reparseSummaryViaLLM(text) {
  return { ok: true, fallback: true, memories: parseCategoryBlocks(text) };
}

// 把一段压缩摘要「再解析 + 去重」进入记忆池；返回新增/合并统计
async function ingestSummary(summaryText, opts) {
  opts = opts || {};
  if (READONLY) { console.warn("[memory-pool] 只读模式，忽略摘要入池"); return { ok: true, skipped: true, readonly: true, added: 0, merged: 0, failed: 0 }; }
  const source = opts.source || "compaction";
  const blockId = opts.block_id || null;
  // 五类改造后按来源绑定分类：压缩链路（解析入池/一键入池/合并）固定「压缩摘要」；
  // AI 标签路径（memory_tag）限前三类——directCategory 写了别的类一律视为没写，交给 LLM 从三类里判
  const isCompactionSource = source === "compaction" || source === "compaction-direct";
  const fixedCategory = isCompactionSource ? COMPACTION_CATEGORY : null;
  // 一键入池(compaction-direct)按摘要【分类】标签落真实类别；批量解析(compaction)仍固定压缩摘要
  // 0919：memory_tag 额外接受 V2 枚举名（fact/rule/quote/milestone）——AI 按新分类写标签直接落池，迁移时 category 即 kind
  const allowedCats = source === "compaction-direct" ? CATEGORIES : (fixedCategory ? [fixedCategory] : (source === "memory_tag" ? AI_CATEGORIES.concat(["fact", "rule", "quote", "milestone"]) : AI_CATEGORIES));
  // 直接分类/重要级：memory 标签里写了 {category,importance} 时，跳过 LLM 再解析，直接入库。
  const directCategory = opts.directCategory ? String(opts.directCategory).trim() : "";
  const directPinned = opts.directPinned === true;
  // 模型显式写的重要级：两条路径都以它为准（LLM 重解析路径此前会把它丢掉，导致标签里写的数字失效变 0.5）
  const directImportance = (opts.directImportance != null && isFinite(Number(opts.directImportance))) ? Number(opts.directImportance) : null;
  if (directCategory && directCategory !== "" && allowedCats.includes(directCategory)) {
    const r = await add({
      content: String(summaryText || "").trim(),
      category: directCategory,
      importance: directImportance != null ? directImportance : 0.5,
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
  const parsed = await reparseSummaryViaLLM(summaryText, { ...(opts.llm || {}), forceLlm: opts.forceLlm === true }, fixedCategory);
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
    // 压缩链路分类已固定；AI 标签路径取 LLM 判的前三类（fallback 条目带「压缩摘要」类名时兜底「关于她」）
    const mCat = fixedCategory || (AI_CATEGORIES.includes(m.category) ? m.category : "关于她");
    const r = await add({
      content: m.content,
      category: mCat,
      importance: directImportance != null ? directImportance : m.importance,
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
  const catEnum = "(" + CATEGORIES.join("|") + ")";
  const catNote = "分类含义：关于她=她是谁的静态部分（偏好/习惯/身体状况/作息/家人/经历里反复起作用的部分，只收稳定、反复成立的事实，一条一个事实短句）；认账=我认下的账（答应过她的事、欠着还没做的、被她纠正后认下的毛病，每条都必须能回答\"那我该干什么\"，写清欠什么、什么状态下兑现）；拓本=一字不改的原话（引号里原样照抄，不修标点不补主语，写明谁说的、日期）；压缩摘要=压缩替换产出的聊过什么记录；对话碎片=用户侧入池的对话关键碎片。";
  const system = "你是这段关系的记忆整理者，处理要果断、不手软。目标是把记忆池整理得干净、凝练、贴近真实，宁可少而准不要多而杂。对不重要的记忆，把重要级打低到 0.2~0.4；对过时、无效、含糊不清、没用的记忆，直接沉底，别舍不得；对内容相近、同义、重复的记忆，直接合并成一条，不用等完全一样；与【已清洗参考】重复的待清洗记忆，直接沉底。拓本类条目内容一字不改。保留真实相处质感，禁止编造、禁止脑补、禁止写成冰冷档案。只输出 JSON。";
  const user = "以下是记忆池中所有待清洗记忆（每条含：编号、原分类、内容、重要级、是否置顶）。请整理成一份新的记忆清单，规则如下（要果断，不要手软）：\n"
    + "1. 合并：内容相近、同义、重复的记忆直接合并为一条，不用等完全一样；宁可合并，不要留多个相似条。\n"
    + "2. 去重：完全相同的只保留一条。\n"
    + "3. 重新分类：按【关于她｜认账｜拓本｜压缩摘要｜对话碎片】纠正分类。\n"
    + "4. " + catNote + "\n"
    + "5. 重要级：重新评估 importance（0~1），不重要的打低到 0.2~0.4，越重要越接近 1。\n"
    + "6. 沉底：对不重要、不明确、过时、无效、没用，或与【已清洗参考】重复的记忆，直接标记 sunk=true（不是删除，只是不再参与浮现），别舍不得。\n"
    + "7. 置顶的尽量保留置顶状态，除非内容已完全失效。\n"
    + "8. 拓本类（含旧「锚点」类）条目是原话，内容一字不改，只允许改分类和重要级。\n"
    + "9. 只输出对【待清洗记忆】的整理结果；【已清洗参考】仅作去重/合并判断，不要重复输出它们。\n"
    + "10. 宁可少而准确，不要多而杂；合并后总条数尽量少，但不要丢失重要事实。\n"
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
    // 2026-09-13 审查修复：加超时（同 reparseSummaryViaLLM），上游挂起不再无限等待
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
    let resp, data;
    try {
      resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: Number(CONFIG.clean_temperature) || 0.2,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });
      if (!resp.ok) return { ok: false, error: "LLM HTTP " + resp.status };
      data = await resp.json();
    } finally { clearTimeout(timer); }
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
      // 拓本（含旧「锚点」）是原话：内容一字不改，只允许改分类和重要级
      const isVerbatim = isVerbatimCat(target.category);
      const newCat = CATEGORIES.includes(it.category) ? it.category : target.category;
      const newImp = Math.max(0, Math.min(1, Number(it.importance) || (Number(target.importance) || 0)));
      const newContent = isVerbatim ? target.content : String(it.content || target.content).trim();
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

// ---------------- 清洗结果导入（管理台「导入清洗结果」） ----------------
// 吃外部清洗方产出的变更清单并应用；条目 id 不变，标星 poolId 关联不受影响。
// 变更格式：{id, op:"update", category?, importance?, content?, pinned?, sunk?}
//          {id, op:"delete"}
//          {id, op:"merge", into, content?, category?, importance?}  → 被并条目沉底+superseded_by 留痕，
//            content/category/importance 若给出则先应用到目标条目（即合并后的内容写在目标上）
// 分类只接受新五类（旧类名是待清洗对象，不允许作为导入目标）；preview=true 只校验+预览不落盘。
function buildImportPlan(changes) {
  const rows = load();
  const byId = new Map(rows.map(r => [r.id, r]));
  const valid = [];
  const errors = [];
  const seen = new Set();
  const parseFields = function (c, plan) {
    const to = {};
    if (c.category !== undefined) {
      if (!CATEGORIES.includes(c.category)) { errors.push({ id: c.id, error: "分类必须是：" + CATEGORIES.join("、") }); return null; }
      to.category = c.category;
    }
    if (c.importance !== undefined) {
      const n = Number(c.importance);
      if (!isFinite(n) || n < 0 || n > 1) { errors.push({ id: c.id, error: "importance 须在 0~1" }); return null; }
      to.importance = Math.round(n * 100) / 100;
    }
    if (c.content !== undefined) {
      const s = String(c.content).trim();
      if (!s) { errors.push({ id: c.id, error: "content 不能为空" }); return null; }
      to.content = s;
    }
    if (c.pinned !== undefined) to.pinned = !!c.pinned;
    if (c.sunk !== undefined) to.sunk = !!c.sunk;
    if (Object.keys(to).length) plan.to = to;
    return plan;
  };
  for (const c of (Array.isArray(changes) ? changes : [])) {
    if (!c || typeof c !== "object") { errors.push({ error: "存在非对象条目" }); continue; }
    const id = String(c.id || "").trim();
    const op = String(c.op || "update").trim();
    if (!byId.has(id)) { errors.push({ id: id || "(空)", op, error: "id 不存在于记忆池" }); continue; }
    if (["update", "delete", "merge"].indexOf(op) < 0) { errors.push({ id, op, error: "op 只支持 update/delete/merge" }); continue; }
    if (seen.has(id)) { errors.push({ id, op, error: "同一 id 出现多次" }); continue; }
    const it = byId.get(id);
    const plan = { id, op, from: { content: it.content, category: it.category, importance: Math.round((Number(it.importance) || 0.5) * 100) / 100 } };
    if (op === "update") {
      if (!parseFields(c, plan)) continue;
    } else if (op === "merge") {
      const into = String(c.into || "").trim();
      if (!byId.has(into)) { errors.push({ id, op, error: "merge 目标 " + (into || "(空)") + " 不存在" }); continue; }
      if (into === id) { errors.push({ id, op, error: "不能并入自己" }); continue; }
      plan.into = into;
      // 变更里的 content/category/importance 语义=合并后目标条目的内容，应用到目标条目
      if (c.category !== undefined || c.importance !== undefined || c.content !== undefined) {
        const targetPlan = {};
        if (!parseFields({ id: into, category: c.category, importance: c.importance, content: c.content }, targetPlan)) continue;
        plan.targetTo = targetPlan.to || {};
      }
    }
    seen.add(id);
    valid.push(plan);
  }
  return { valid, errors };
}

// 把导入变更的字段应用到单条条目；分类/内容变更时重算指纹（否则幂等去重判断失效）并作废旧向量。
// 返回是否有实际变更。
function applyImportFields(it, to) {
  let changed = false;
  let contentOrCatChanged = false;
  if (to.category !== undefined && to.category !== it.category) { it.category = to.category; changed = true; contentOrCatChanged = true; }
  if (to.content !== undefined && to.content !== it.content) { it.content = to.content; changed = true; contentOrCatChanged = true; }
  if (to.importance !== undefined && Math.abs(to.importance - (Number(it.importance) || 0)) > 0.001) { it.importance = to.importance; changed = true; }
  if (to.pinned !== undefined && to.pinned !== (it.pinned === true)) {
    it.pinned = to.pinned;
    if (it.pinned) it.pinned_at = nowIso(); else delete it.pinned_at;
    changed = true;
  }
  if (to.sunk !== undefined) {
    const targetActive = !to.sunk;
    if ((it.active !== false) !== targetActive) { it.active = targetActive; changed = true; }
  }
  if (!changed) return false;
  it.updated_at = nowIso();
  if (contentOrCatChanged) it.fingerprint = entryHash(it);
  invalidateVector(it.id);
  return true;
}

async function importChanges(changes, opts) {
  opts = opts || {};
  if (READONLY) return { ok: false, error: "只读模式（wake-up）不执行导入" };
  const { valid, errors } = buildImportPlan(changes);
  const stat = { update: 0, delete: 0, merge: 0, noop: 0 };
  for (const p of valid) stat[p.op === "update" ? "update" : p.op]++;
  if (opts.preview) {
    return { ok: true, preview: true, total: valid.length, ...stat, errors, plan: valid };
  }
  if (!valid.length) return { ok: false, error: "没有可应用的变更", errors };
  const backup = await backupPoolFile();
  let updated = 0, deleted = 0, merged = 0, unchanged = 0;
  for (const p of valid) {
    if (p.op === "delete") { if (remove(p.id)) deleted++; continue; }
    if (p.op === "merge") {
      const it = get(p.id);
      const target = get(p.into);
      if (!it || !target) continue;
      if (p.targetTo) applyImportFields(target, p.targetTo);
      // 被并条目沉底留痕，目标记 merged_from 面包屑
      const mf = Array.isArray(target.merged_from) ? target.merged_from.slice() : [];
      mf.push(mergeSnap(it));
      const max = Math.max(0, Number(CONFIG.merged_from_max) || DEFAULT_MAX_MERGED_FROM);
      if (mf.length > max) mf.splice(0, mf.length - max);
      target.merged_from = mf;
      target.updated_at = nowIso();
      it.active = false;
      it.superseded_by = p.into;
      it.updated_at = nowIso();
      invalidateVector(it.id);
      merged++;
      continue;
    }
    // update
    const it = get(p.id);
    if (!it) continue;
    if (applyImportFields(it, p.to || {})) updated++; else unchanged++;
  }
  dirty = true; flush();
  return { ok: true, preview: false, updated, deleted, merged, unchanged, errors, backup, stat };
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
  CATEGORIES, LEGACY_CATEGORIES, AI_CATEGORIES, COMPACTION_CATEGORY,
  list, stats, get, add, update, remove, sink, revive,
  retrieve, retrieveHybrid, breath, recent, clearRetrievalStats, warmVectors, ingestSummary, parseCategoryBlocks, reparseSummaryViaLLM, buildReparsePrompt,
  contentSimilarity, tokensOf, decayFactor, scoreOf,
  buildCleanPrompt, cleanPool,
  buildImportPlan, importChanges,
  setConfig, getConfig, poolKeywords
};
