"use strict";
/*
 * context-digest.js
 * 「回看已替换历史摘要」工具核心（context_digest）：
 * AI 给一条明确指令 → 从处于替换中的历史摘要里做 语义+词面 混合检索，召回相关块
 * （每块带时间段）→ 连同指令交给 LLM 整理 → 返回整理文本给 AI 直接使用。
 *
 * 语料口径：context_replacements.json 中 !removed && enabled !== false && !hidden
 * 且正文（text/memory）非空的条目。隐藏/禁用条目自动退出检索范围；新增条目
 * 下次调用自动进入（向量缓存按 id+内容哈希 惰性补算，无任何维护动作）。
 *
 * 降级链（检索/整理都不是单点故障）：
 *  - embed-server 熔断/失败 → 纯词面（bigram Jaccard）打分；
 *  - 指令带时间词但该时间窗内无摘要 → 回退全量语料并在结果里标注；
 *  - 无可用 LLM 供应商或调用失败 → 返回召回块原文列表（带时间段），AI 仍可自行阅读。
 *
 * 提示词：默认内置；data/context_digest_prompt.json（管理台提示词页）可覆盖。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { embedBatch, fused } = require("./utils/embed-client");
const { resolveRerankProvider } = require("./context-rerank");

const REPLACEMENTS_FILE = path.join(__dirname, "data", "context_replacements.json");
const VECTORS_FILE = path.join(__dirname, "data", "context_digest_vectors.json");
const PROMPT_FILE = path.join(__dirname, "data", "context_digest_prompt.json");

const TOP_K = Math.max(1, Math.min(10, Math.floor(Number(process.env.CONTEXT_DIGEST_TOP_K) || 4)));
// 入选门槛分开设（bge 余弦无关对也有 0.43+ 地板，混合门槛会被地板抬过——语义在场时
// 必须卡语义分本身，词面在场时卡词面分；混合分 0.60/0.40 只用于排序）。
// 参考：记忆池 recall_sim_threshold=0.55、Relevant 词面门槛 0.15。
const SEM_MIN = Number(process.env.CONTEXT_DIGEST_SEM_MIN) || 0.50;
const LEX_MIN = Number(process.env.CONTEXT_DIGEST_LEX_MIN) || 0.25;
const W_SEMANTIC = 0.60;   // 语义（bge 余弦）权重
const W_LEXICAL = 0.40;    // 词面（bigram Jaccard）权重
const EMBED_TIMEOUT_MS = 15000;
// 工具壳（tools_server.py）urlopen 硬顶 75s：网关 70s 主动 abort 走降级（返回召回块原文），
// 比 python 侧超时报错更优雅；未来壳侧放宽后可同步调大此处
const DIGEST_TIMEOUT_MS = Math.max(30000, Math.floor(Number(process.env.CONTEXT_DIGEST_TIMEOUT_MS) || 70000));
const DIGEST_MAX_OUTPUT_TOKENS = 4000; // 思考模型（glm-5.3-flash）思考也计入 max_tokens，需留足正文额度
const DEDUP_THRESHOLD = Number(process.env.CONTEXT_DIGEST_DEDUP_THRESHOLD) || 0.9; // 送 LLM 前字面近重复去重

const DEFAULT_PROMPT_TEMPLATE = `你是一段对话历史的整理员。你会收到一条整理指令，以及若干段从历史对话中检索出的摘要（每段开头标注发生时间段）。请严格遵守：

1. 人称规则：摘要里的当事人是两位——发出指令的「谢」（资料中的「我」「他」「谢」都指他本人，整理时一律改用「你」），以及他的伴侣（资料中的「她」，保持「她」）。整理结果以对谢说话的口吻书写，例如「她最近在做前端，你当时帮她理清了需求」。不要出现用「他」指代谢的写法；材料引号内的原话引语保持原样。
2. 只依据给出的摘要材料整理，不编造、不脑补材料之外的细节。材料不足以回答指令时，直接说明"材料里没有关于 XX 的内容"，缺哪块说哪块。
3. 按主题或时间组织，语言连贯自然，保留材料中的关键事实、约定、数字和有分量的话。
4. 涉及具体事件时在句末用括号标注对应时间段，如（08-12 ~ 08-14）。
5. 最终整理结果必须放在 <DIGEST> 与 </DIGEST> 标签之间；标签之外不要输出任何内容，不要开场白，不要解释你的思路。

## 整理指令
\${instruction}

## 历史摘要材料
\${materials}`;

// ---- 语料装载 ----

function loadActiveSummaries() {
  let records = [];
  try {
    const j = JSON.parse(fs.readFileSync(REPLACEMENTS_FILE, "utf-8"));
    records = Array.isArray(j) ? j : [];
  } catch (e) { records = []; }
  const out = [];
  for (const it of records) {
    if (!it || it.removed || it.enabled === false || it.hidden) continue;
    const text = String(it.text || it.memory || "").trim();
    if (!text) continue;
    out.push({
      id: String(it.id || ""),
      text: text,
      rangeLabel: String(it.range_label || "").trim() || null,
      range: parseRangeLabel(it)
    });
  }
  return out;
}

// "2026-08-12 21:41 ~ 2026-08-14 12:30" → {start, end}；解析失败回退 created_at 单点
function parseRangeLabel(it) {
  const m = String(it.range_label || "").match(
    /(\d{4}-\d{1,2}-\d{1,2})\s*(\d{1,2}:\d{2})?\s*~\s*(\d{4}-\d{1,2}-\d{1,2})\s*(\d{1,2}:\d{2})?/
  );
  if (m) {
    const s = new Date(m[1] + " " + (m[2] || "00:00"));
    const e = new Date(m[3] + " " + (m[4] || "23:59"));
    if (!isNaN(s) && !isNaN(e)) return { start: s, end: e };
  }
  const c = new Date(it.created_at || "");
  return isNaN(c) ? null : { start: c, end: c };
}

// ---- 时间词解析（指令含「最近/N天/N周/上周」等时先按时间筛再检索）----

// 中文数字/阿拉伯数字 → 数值（「三天」「两周」「7天」都支持）
function _cnNum(s) {
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { "零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  if (map[s] != null) return map[s];
  const m = s.match(/^(十|([一二两三四五六七八九])?十([一二三四五六七八九])?)$/);
  if (m) {
    const tens = m[2] ? map[m[2]] : 1;
    const ones = m[3] ? map[m[3]] : 0;
    return tens * 10 + ones;
  }
  return NaN;
}

function parseTimeWindow(q) {
  const s = String(q || "");
  const now = new Date();
  const DAY = 86400000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBack = (n) => new Date(startOfToday.getTime() - (n - 1) * DAY); // 含今天共 n 天的窗起点
  let m;

  // 数字 + 单位（「最近三天」「近2周」「这一个月」「7天以来」…）
  if ((m = s.match(/(?:最近|近|这)\s*([0-9一二两三四五六七八九十]+)\s*个?\s*(天|周|星期|月)/)) ||
      (m = s.match(/([0-9一二两三四五六七八九十]+)\s*天[以]?[内来]/))) {
    const n = _cnNum(m[1]);
    if (!isNaN(n) && n >= 1 && n <= 365) {
      const unit = m[2] || "天";
      const days = (unit === "周" || unit === "星期") ? n * 7 : (unit === "月" ? n * 30 : n);
      return { start: daysBack(days), end: now, label: "最近" + m[1] + unit };
    }
  }
  if (/本周|这周|这一周/.test(s)) {
    const dow = (startOfToday.getDay() + 6) % 7; // 周一=0
    return { start: new Date(startOfToday.getTime() - dow * DAY), end: now, label: "本周" };
  }
  if (/上周/.test(s)) {
    const dow = (startOfToday.getDay() + 6) % 7;
    const monday = new Date(startOfToday.getTime() - (dow + 7) * DAY);
    return { start: monday, end: new Date(monday.getTime() + 6 * DAY + 86399000), label: "上周" };
  }
  if (/本月|这个月/.test(s)) {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now, label: "本月" };
  }
  if (/上个月|上月/.test(s)) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const next = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: first, end: new Date(next.getTime() - 1), label: "上个月" };
  }
  if (/前天/.test(s)) return { start: new Date(startOfToday.getTime() - 2 * DAY), end: new Date(startOfToday.getTime() - DAY - 1), label: "前天" };
  if (/昨天/.test(s)) return { start: new Date(startOfToday.getTime() - DAY), end: new Date(startOfToday.getTime() - 1), label: "昨天" };
  if (/今天|今晚|今天.{0,6}(聊|说|讨论|讲)/.test(s)) return { start: startOfToday, end: now, label: "今天" };
  return null;
}

function rangeOverlaps(entry, win) {
  if (!entry.range) return true;
  return entry.range.end >= win.start && entry.range.start <= win.end;
}

// ---- 词面相似（bigram Jaccard）----

function bigrams(s) {
  const t = String(s || "").replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

// ---- 词面相似（内容 bigram 包含度）----
// 查询短、摘要正文长（几百~几千字），Jaccard 会被长文并集稀释恒近 0；
// 改量「查询的内容 gram 有多少出现在正文里」。停用字 gram 先剔（的了是在…），
// 避免「我们/什么/讨论」这类虚词 gram 碰瓷命中。
const _STOP_CHARS = new Set("的了是在我你有和就不这那呢吧吗啊它个很也都说要去会能可以还又已经被把让给跟与或者及什么怎么样式".split(""));

function contentGrams(q) {
  const out = new Set();
  for (const g of bigrams(q)) {
    let stop = false;
    for (const ch of g) { if (_STOP_CHARS.has(ch)) { stop = true; break; } }
    if (!stop) out.add(g);
  }
  return out;
}

// ---- 向量缓存（id + 内容哈希 → 向量；惰性补算增量）----

function _textHash(s) {
  return crypto.createHash("md5").update(String(s), "utf-8").digest("hex").slice(0, 16);
}

function loadVecCache() {
  try {
    const j = JSON.parse(fs.readFileSync(VECTORS_FILE, "utf-8"));
    return (j && typeof j === "object" && !Array.isArray(j)) ? j : {};
  } catch (e) { return {}; }
}

function saveVecCache(cache) {
  const tmp = VECTORS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, VECTORS_FILE);
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// 返回 Map(id→vec)；embed 不可用（熔断/失败）返回 null，调用方降级纯词面
async function ensureVectors(entries) {
  if (fused()) return null;
  const cache = loadVecCache();
  const need = [];
  for (const e of entries) {
    const h = _textHash(e.text);
    const c = cache[e.id];
    if (!c || c.hash !== h) need.push({ e: e, h: h });
  }
  if (need.length) {
    const vecs = await embedBatch(need.map((x) => x.e.text), false, EMBED_TIMEOUT_MS);
    if (!vecs) return null;
    need.forEach(function (x, i) { if (vecs[i]) cache[x.e.id] = { hash: x.h, vec: vecs[i] }; });
    try { saveVecCache(cache); } catch (e) { /* 缓存写失败不影响本次检索 */ }
  }
  const map = new Map();
  for (const e of entries) {
    const c = cache[e.id];
    if (c && Array.isArray(c.vec)) map.set(e.id, c.vec);
  }
  return map;
}

// ---- 提示词 ----

function loadPromptTemplate() {
  try {
    const j = JSON.parse(fs.readFileSync(PROMPT_FILE, "utf-8"));
    if (j && typeof j.template === "string" && j.template.trim()) return j.template;
  } catch (e) { /* 无自定义模板，走默认 */ }
  return DEFAULT_PROMPT_TEMPLATE;
}

// ---- LLM 整理（供应商复用 ai-providers.json 统一配置）----

function _extractText(msg) {
  const raws = [];
  if (msg && typeof msg.content === "string" && msg.content.trim()) raws.push(msg.content);
  if (msg && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) raws.push(msg.reasoning_content);
  return raws.length ? raws[0].trim() : null;
}

// 思考模型（glm-5.3-flash）会把推理混进 content：<DIGEST> 标签是唯一可信正文锚点；
// 无标签（守约的模型）才回退用全文
function extractDigest(raw) {
  const s = String(raw || "");
  const m = s.match(/<DIGEST>([\s\S]*?)<\/DIGEST>/i);
  if (m) return m[1].trim();
  const i = s.indexOf("<DIGEST>");
  if (i >= 0) return s.slice(i + 8).trim(); // 闭合标签被 max_tokens 截断：取标签后残余正文
  return s.trim();
}

async function callDigestLLM(provider, prompt, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, DIGEST_TIMEOUT_MS);
  try {
    const resp = await fetchFn(provider.api_url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + provider.api_key },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: DIGEST_MAX_OUTPUT_TOKENS,
        stream: false
      }),
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = _extractText(msg);
    if (!text) throw new Error("响应没有可解析的 content/reasoning_content");
    return extractDigest(text);
  } finally {
    clearTimeout(timer);
  }
}

// 字面近重复：双向 bigram 包含度取大——整段替换与近似重复（含子集型）都能抓到；
// 长文本对长文本不能用 Jaccard（并集稀释），与检索词面分同理
const _GRAMS_CACHE = new Map();
function _gramsOf(text) {
  let g = _GRAMS_CACHE.get(text);
  if (!g) { g = bigrams(text); if (_GRAMS_CACHE.size > 500) _GRAMS_CACHE.clear(); _GRAMS_CACHE.set(text, g); }
  return g;
}

function _literalSim(a, b) {
  const ga = _gramsOf(String(a));
  const gb = _gramsOf(String(b));
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  const [small, big] = ga.size <= gb.size ? [ga, gb] : [gb, ga];
  for (const g of small) if (big.has(g)) inter++;
  return Math.max(inter / ga.size, inter / gb.size);
}

// 送 LLM 前去重：字面相似 ≥ 阈值只保留一篇，正文更长者胜（信息更全）
function dedupByLiteral(scored) {
  const kept = [];
  for (const it of scored) {
    let merged = false;
    for (let i = 0; i < kept.length; i++) {
      if (_literalSim(it.entry.text, kept[i].entry.text) >= DEDUP_THRESHOLD) {
        merged = true;
        if (it.entry.text.length > kept[i].entry.text.length) kept[i] = it;
        break;
      }
    }
    if (!merged) kept.push(it);
  }
  return kept;
}

// ---- 主入口 ----

/*
 * digest(q, opts)
 * @returns {Promise<Object>}
 *  成功整理：{ ok:true, digest, sources:[{id,range}], model, time_filtered, matches_count }
 *  没找到：  { ok:true, digest:null, message:"没找到相关历史摘要", matches:[], time_filtered }
 *  降级：    { ok:true, digest:null, fallback:true, reason, matches:[{id,range,score,text}] }
 *  参数错：  { ok:false, error }
 */
async function digest(q, opts) {
  const o = opts || {};
  const query = String(q || "").trim();
  if (!query) {
    return { ok: false, error: "q 必填：一条明确的整理指令（可含时间词，如「整理我们最近两周关于她找工作的讨论」）" };
  }

  const entries = loadActiveSummaries();
  if (!entries.length) {
    return { ok: true, digest: null, message: "当前没有任何处于替换中的历史摘要", matches: [] };
  }

  // 时间词先筛；筛完全空则回退全量（防时间词误判导致全灭）
  let pool = entries;
  const win = parseTimeWindow(query);
  let timeFiltered = false;
  if (win) {
    const filtered = pool.filter(function (e) { return rangeOverlaps(e, win); });
    if (filtered.length) { pool = filtered; timeFiltered = true; }
  }

  // 混合打分：0.60 语义（embed 可用时）+ 0.40 词面；embed 不可用自动纯词面
  let vecMap = null;
  try { vecMap = await ensureVectors(pool); } catch (e) { vecMap = null; }
  let qvec = null;
  if (vecMap && vecMap.size) {
    try {
      const qv = await embedBatch([query], true, EMBED_TIMEOUT_MS);
      if (qv && qv[0]) qvec = qv[0];
    } catch (e) { qvec = null; }
  }
  const qGrams = contentGrams(query);
  const scored = pool.map(function (e) {
    let sem = null, inter = 0;
    const ev = vecMap ? vecMap.get(e.id) : null;
    if (qvec && ev) sem = Math.max(0, dot(qvec, ev));
    const eg = e._grams || (e._grams = bigrams(e.text));
    for (const g of qGrams) if (eg.has(g)) inter++;
    const lex = qGrams.size ? inter / qGrams.size : 0;
    return { entry: e, score: (sem != null ? W_SEMANTIC * sem : 0) + W_LEXICAL * lex, sem: sem, lex: lex, inter: inter };
  });

  // 入选：语义过硬门槛，或词面包含度过硬门槛且至少命中 1 个内容 gram；按混合分排序取 top K
  const ranked = scored.filter(function (x) {
    return (x.sem != null && x.sem >= SEM_MIN) || (x.lex >= LEX_MIN && x.inter >= 1);
  }).sort(function (a, b) { return b.score - a.score; });
  // 近重复去重后再截 top K（否则 K 个名额可能被同一内容的多个变体占满）
  const top = dedupByLiteral(ranked).slice(0, TOP_K);
  if (!top.length) {
    return { ok: true, digest: null, message: "没找到相关历史摘要", matches: [], time_filtered: timeFiltered };
  }
  const matches = top.map(function (x) {
    return { id: x.entry.id, range: x.entry.rangeLabel, score: Math.round(x.score * 1000) / 1000, text: x.entry.text };
  });

  // LLM 整理；失败降级返回召回块原文列表
  // 2026-09-24：优先按用途路由（设置里给「回看摘要」指定的模型），未指定回退原 rerank 供应商
  let provider = null;
  try {
    const rp = require("./model-router").resolveRoleModel("digest");
    if (rp.provider && rp.model) {
      provider = { api_url: (rp.provider.api_url || rp.provider.base_url || "").trim(), api_key: rp.provider.api_key || "", model: rp.model };
    }
  } catch (e) {}
  if (!provider) provider = resolveRerankProvider();
  if (!provider) {
    return { ok: true, digest: null, fallback: true, reason: "无可用供应商（ai-providers.json）", matches: matches };
  }
  const materials = matches.map(function (m) {
    return "【" + (m.range || "时间未知") + "】\n" + m.text;
  }).join("\n\n");
  const prompt = loadPromptTemplate()
    .replace(/\$\{instruction\}/g, query)
    .replace(/\$\{materials\}/g, materials);
  try {
    const text = await callDigestLLM(provider, prompt, o.fetchFn || fetch);
    return {
      ok: true,
      digest: text,
      sources: matches.map(function (m) { return { id: m.id, range: m.range }; }),
      model: provider.model,
      time_filtered: timeFiltered,
      matches_count: matches.length
    };
  } catch (e) {
    return { ok: true, digest: null, fallback: true, reason: (e && e.message) || "LLM 调用失败", matches: matches };
  }
}

module.exports = {
  digest,
  loadActiveSummaries,
  parseTimeWindow,
  parseRangeLabel,
  loadPromptTemplate,
  dedupByLiteral,
  _literalSim,
  DEFAULT_PROMPT_TEMPLATE,
  PROMPT_FILE
};
