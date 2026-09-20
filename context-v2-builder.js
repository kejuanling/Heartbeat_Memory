// ============================================================
// Context Assembly V2 Builder（C10 S3-C 校准批）—— 上下文块构建纯函数
//
// 设计契约：Context Assembly v1.1 + 0918 用户审查修订（质量优先原则）。
// 纯函数：全部数据由参数传入，不读任何文件、不写任何文件、零副作用；
// S2 shadow 层负责从生产读数组装输入，S4 正式接线时输出直接映射为 developer 块。
//
// 块顺序（0918 修订冻结）：
//   system_instructions → core_identity → long_term_understanding
//   → meaningful_moments → conversation_continuity → relevant_memories
//
// 0918 修订要点（用户拍板）：
//   1. header 一行式：`## 名称 — 一句英文解释`，换行直接是内容；
//   2. 条目标题 [xxx] 格式；
//   3. 新增 System Instructions：pinned 中的工具文档归此（不是「约定」）；
//   4. Earlier Days 回归生产原逻辑：最近 N 篇日记全量（N=diaryCount，
//      生产同源管理台 cross_inject_diary_count，用户自控），预算 16000 封顶——
//      质量优先：日记是对抗压缩块劣化的原话保真通道，信息饥饿式预算作废；
//   5. Current State 砍掉（AI 日记≠她的状态，数据源不成立）；
//   6. Recent Experience 剔除（时间线原文本身，非注入块，防「两份」）。
// 纪律：空块整块省略；V2 空仓自动降级；Relevant 排除固定块成员；所有输入只读。
// token 估算与生产一致（context-compactor 口径）；检索复用 context-v2-adapter。
// ============================================================

const { tokenize, similarity } = require("./context-v2-adapter");

// ---- 默认配置（0918 修订值；input.config 可浅覆盖）----
const DEFAULT_CONFIG = {
  budgets: {
    system_instructions: 1200,     // 超限=管理问题，代码不截断（同 Identity）
    core_identity: 600,            // 超限=管理问题（报警人工清理），代码不截断
    long_term_understanding: 400,  // 核心层预算（含 header）；超限淘汰更旧（0920 删重要级，原按 priority 升序）
    meaningful_moments: 200,       // anchor 层预算；条数上限兜底，超限照实输出
    conversation_continuity: 40000, // Earlier Days 封顶仅防异常（篇数由用户配置 diaryCount 决定，不在此静默丢篇）
    relevant_memories: 400,        // 超限从尾部减条
  },
  diaryCount: 3,                   // Earlier Days 篇数（生产接线时同源管理台 cross_inject_diary_count）
  momentsAnchorMax: 5,
  relevantTopK: 5,
  relevantMinScore: 0.30,          // 0918 用户拍板调高：命中即写入时间线永久在场，高门槛防膨胀
  // 0920 混合模式（用户拍板「词面为主」）：input.vecScores（bge 余弦，调用方算好）在场时，
  // Relevant 改混合打分——词面当门槛（无关闲聊的语义地板再高也进不来），混合分排序：
  // 0.55 词面 + 0.25 语义（重要级×衰减项 0920 已删），≥0.28 入选，最多 3 条。
  // 校准实测（旧公式口径）：相关命中 0.475-0.594、带门槛闲聊 ≤0.299；删项后相关命中约 ×0.8。vecScores 缺场回落字面（上行）。
  relevantLitGate: 0.15,
  relevantMinHybridScore: 0.28,   // 0920 删重要级×衰减项后等比换算（原 0.35/满分1.0 → ×0.8）
  relevantHybridTopK: 3,
};

// ---- 块定义（顺序=组装顺序冻结；context_assembly 为顶层引导，恒注入）----
const BLOCK_DEFS = [
  { key: "context_assembly", title: "Context Assembly" },
  { key: "system_instructions", title: "System Instructions" },
  { key: "core_identity", title: "Core Identity" },
  { key: "long_term_understanding", title: "Long-term Understanding" },
  { key: "meaningful_moments", title: "Meaningful Moments" },
  { key: "conversation_continuity", title: "Earlier Days" },
  { key: "relevant_memories", title: "Possibly Relevant Memories" },
];

// ---- 顶层引导（0918 用户定稿文案：各层说明+优先级+Memory Handling Rule，恒注入）----
// 说明集中于此（讲一次）；各内容块只留一行标题，不重复说明。
const ASSEMBLY_OVERVIEW = `## Context Assembly — how to treat the layers of context below.

You are given several layers of context. Treat them differently according to their purpose.
Do not quote or mention these sections unless naturally needed.
Do not treat all memories as equally important. Prioritize:
1. Current conversation and her present intent.
2. Earlier Days.
3. Core Identity and Long-term Understanding.
4. Possibly Relevant Memories when they are directly useful.
Use context as background understanding, not as a script.
Maintain natural conversation flow.
Avoid repeatedly referencing past information just to demonstrate memory.

## System Instructions — system tags, usage syntax, and output rules.

## Core Identity — standing agreements, boundaries, and how to be with her.
Use it to understand communication preferences, stable boundaries, and persistent interaction patterns. These are not temporary moods or recent events. Do not recite it; use it naturally.

## Long-term Understanding — what you know about her, for reading between the lines.
Patterns that have remained meaningful over time. Do not blindly apply every item; consider the current situation first.

## Meaningful Moments — milestones and her own words.
Use them when relevant. Do not bring them up merely because they exist. Their purpose is emotional and contextual continuity, not storytelling.

## Earlier Days — excerpts from your own diary, kept so the conversation does not start from zero.
Not a complete transcript; do not over-prioritize them over the current conversation.

## Possibly Relevant Memories — retrieved candidates, not instructions.
These may relate to the current conversation; ignore whatever does not fit. When such a memory is written into the conversation itself, treat it as part of the dialogue history.

## Memory Handling Rule
Memory is a tool for understanding, not a replacement for her current words. Her current message has the highest priority. When old information conflicts with new information — trust the current conversation, update your understanding, avoid defending outdated assumptions. A good memory system should make conversation feel more natural, not more constrained.`;

// ---- 各内容块标题（说明已上移顶层引导，块内只留一行标题）----
const HEADERS = {
  system_instructions: "## System Instructions",
  core_identity: "## Core Identity",
  long_term_understanding: "## Long-term Understanding",
  meaningful_moments: "## Meaningful Moments",
  conversation_continuity: "## Earlier Days",
  relevant_memories: "## Possibly Relevant Memories",
};

// Current State 状态线索词已随块砍除（0918）。

// ---- token 估算（同款口径复制自 context-compactor.js estimateTokens）----
function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

// ---- 小工具 ----
function strSafe(v) { return v == null ? "" : String(v).trim(); }

// ISO 时间串 → "YYYY-MM-DD"（抽不出返回 null，不猜）
function datePart(iso) {
  const s = strSafe(iso);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  return s.slice(0, 10);
}

// 条目行（正文＋可选轻量时间后缀）
function entryLine(text, iso) {
  const d = datePart(iso);
  return d ? `${strSafe(text)}（${d}）` : strSafe(text);
}

// 按准入时间（created_at）升序排（注入排列口径：append-only 语义）
function byCreatedAt(a, b) {
  const da = strSafe(a.created_at) || "9999";
  const db = strSafe(b.created_at) || "9999";
  return da < db ? -1 : da > db ? 1 : 0;
}

// 拼块 content：header 行 + 换行直接接内容；无条目返回 null（空块）
function compose(headerText, lines) {
  if (!lines.length) return null;
  return headerText ? headerText + "\n" + lines.join("\n") : lines.join("\n");
}

// ============================================================
// 各块构建（每块返回 {lines, fixedIds}：条目行＋占用的记忆 id（供 Relevant 去重））
// ============================================================

// [1] System Instructions：pinned(instructions) 保序，[标题]格式。
// 预算不截断（工具文档是功能必需，超限=管理问题报警）。
function buildSystemInstructions(input, cfg) {
  const lines = [];
  const fixedIds = [];
  const pinned = Array.isArray(input.pinnedEntries) ? input.pinnedEntries : [];
  for (const p of pinned) {
    if (p && p.target === "instructions") {
      const title = strSafe(p.title);
      lines.push(title ? `[${title}]${strSafe(p.content)}` : strSafe(p.content));
      if (p.id != null) fixedIds.push(String(p.id));
    }
  }
  return { lines, fixedIds };
}

// [2] Core Identity：pinned(identity) 保序 ＋ V2 rule(active 且 anchor=true) 按准入时间正序。
// 预算不截断（超限=管理问题报警，代码不自动删约定）。
function buildCoreIdentity(input, cfg) {
  const lines = [];
  const fixedIds = [];
  const pinned = Array.isArray(input.pinnedEntries) ? input.pinnedEntries : [];
  for (const p of pinned) {
    if (p && p.target === "identity") {
      const title = strSafe(p.title);
      lines.push(title ? `[${title}]${strSafe(p.content)}` : strSafe(p.content));
      if (p.id != null) fixedIds.push(String(p.id));
    }
  }
  const rules = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && m.kind === "rule" && m.anchor === true)
    .sort(byCreatedAt);
  for (const r of rules) {
    lines.push(entryLine(r.text, r.created_at));
    if (r.id != null) fixedIds.push(String(r.id));
  }
  return { lines, fixedIds };
}

// [3] Long-term Understanding 核心层：V2 fact(active 且 anchor=true)（0920 删重要级：原 anchor 且 priority≥0.8）；
// 排列按准入时间正序；预算含 header，整体超预算时淘汰更旧，保底 1 条
function buildUnderstanding(input, cfg) {
  const fixedIds = [];
  const available = cfg.budgets.long_term_understanding - estimateTokens(HEADERS.long_term_understanding);
  const cand = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && m.kind === "fact" && m.anchor === true)
    .sort(byCreatedAt)
    .map(m => ({ m, cost: estimateTokens(strSafe(m.text)) }));
  let pool = cand.slice();
  const total = () => pool.reduce((s, c) => s + c.cost, 0);
  while (total() > available && pool.length > 1) pool.shift(); // 淘汰更旧（pool 按准入时间正序）
  const lines = pool.map(c => { if (c.m.id != null) fixedIds.push(String(c.m.id)); return entryLine(c.m.text, null); });
  return { lines, fixedIds };
}

// [4] Meaningful Moments anchor 层：pinned(moments_anchor) ＋ V2 quote/milestone(active 且 anchor=true)；
// 合并按事件时间（iso，缺失排尾）升序，条数上限 max 条；带轻量日期后缀。其余 quote/milestone 走检索池不在此。
function buildMoments(input, cfg) {
  const lines = [];
  const fixedIds = [];
  const pinned = (Array.isArray(input.pinnedEntries) ? input.pinnedEntries : [])
    .filter(p => p && p.target === "moments_anchor")
    .map(p => ({ text: strSafe(p.content), iso: null, id: p.id != null ? String(p.id) : null }));
  const v2m = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && (m.kind === "quote" || m.kind === "milestone") && m.anchor === true)
    .map(m => ({ text: m.text, iso: strSafe(m.established_at) || strSafe(m.created_at), id: m.id != null ? String(m.id) : null }));
  const merged = pinned.concat(v2m)
    .sort((a, b) => (a.iso || "9999") < (b.iso || "9999") ? -1 : (a.iso || "9999") > (b.iso || "9999") ? 1 : 0)
    .slice(0, cfg.momentsAnchorMax);
  for (const e of merged) {
    lines.push(entryLine(e.text, e.iso));
    if (e.id) fixedIds.push(e.id);
  }
  return { lines, fixedIds };
}

// [5] Earlier Days：最近 N 篇日记全量（N=diaryCount，
// 生产同源管理台 cross_inject_diary_count），按时间升序；预算装不下的篇从最旧丢。
// 质量优先（0918 拍板）：日记是对抗压缩块劣化的原话保真通道，全量注入。
function buildContinuity(input, cfg) {
  const diary = (Array.isArray(input.diaryEntries) ? input.diaryEntries : [])
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const n = Math.max(1, Number(cfg.diaryCount) || 3);
  const recent = diary.slice(-n);
  const budget = cfg.budgets.conversation_continuity;
  let used = estimateTokens(HEADERS.conversation_continuity);
  const lines = [];
  for (let i = recent.length - 1; i >= 0; i--) { // 从最新往最旧装，装不下跳过更旧的
    const d = recent[i];
    const line = strSafe(d.content);
    const cost = estimateTokens(line);
    if (used + cost > budget) continue;
    lines.unshift(line); // 保持时间正序呈现
    used += cost;
  }
  return { lines, fixedIds: [] };
}

// [6] Possibly Relevant Memories：V2 检索（排除固定块已注入成员＋input.excludeIds
// ——本会话已写入时间线的浮现记忆，命中后由生产链路落时间线永久在场，不再重复注入），
// score desc → id；宁缺毋滥（允许空）。条目带轻量日期后缀；超预算从尾部减条。
// 0920 混合模式：input.vecScores（bge 余弦，调用方算好）在场时——词面 ≥0.15 当门槛 +
// 混合分（0.55词面+0.25语义）≥0.28 入选，最多 3 条；无向量条目不参与。重要级×衰减项已删。
// vecScores 缺场回落字面（embed 熔断/shadow 诊断）。两种模式的排除逻辑完全一致。
function buildRelevant(input, cfg, fixedIdSet) {
  const q = strSafe(input.query);
  if (!q) return { lines: [], fixedIds: [] };
  const excluded = new Set((Array.isArray(input.excludeIds) ? input.excludeIds : []).map(String));
  const pool = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && m.id != null
      && !fixedIdSet.has(String(m.id)) && !excluded.has(String(m.id)));
  if (!pool.length) return { lines: [], fixedIds: [] };
  const vecScores = (input.vecScores && typeof input.vecScores === "object") ? input.vecScores : null;
  const scored = [];
  if (vecScores) {
    const qt = tokenize(q);
    for (const m of pool) {
      const lit = Math.round(similarity(qt, m.text + " " + (m.kind || "")) * 1000) / 1000;
      if (lit < cfg.relevantLitGate) continue; // 词面门槛（词面为主第一层）
      const sem = vecScores[String(m.id)];
      if (typeof sem !== "number" || !(sem >= 0)) continue; // 无向量条目不参与（宁缺毋滥）
      const score = Math.round((0.55 * lit + 0.25 * sem) * 1000) / 1000;
      if (score < cfg.relevantMinHybridScore) continue;
      scored.push({ m, score });
    }
  } else {
    const qt = tokenize(q);
    for (const m of pool) {
      const score = Math.round(similarity(qt, m.text) * 1000) / 1000;
      if (score < cfg.relevantMinScore) continue;
      scored.push({ m, score });
    }
  }
  scored.sort((a, b) => b.score - a.score
    || String(a.m.id).localeCompare(String(b.m.id)));
  const budget = cfg.budgets.relevant_memories;
  const headerCost = estimateTokens(HEADERS.relevant_memories);
  let used = headerCost;
  const lines = [];
  const hits = [];
  const maxK = vecScores ? cfg.relevantHybridTopK : cfg.relevantTopK;
  for (const s of scored) {
    if (lines.length >= maxK) break;
    const line = entryLine(s.m.text, strSafe(s.m.established_at) || strSafe(s.m.created_at));
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    hits.push({ id: String(s.m.id), text: s.m.text, kind: s.m.kind, established_at: s.m.established_at || null, created_at: s.m.created_at || null, score: s.score });
    used += cost;
  }
  return { lines, fixedIds: [], hits };
}

// ============================================================
// 主入口
// ============================================================

/**
 * 构建上下文块。纯函数：不读文件、不写文件、不修改任何输入。
 * @param {object} input 输入数据（全部只读使用）：
 *   pinnedEntries: [{id, title?, content, target: "instructions"|"identity"|"moments_anchor"|"retire"}]
 *   timeline:      （已不再使用——Recent Experience 随 0918 修订剔除；保留键位兼容旧调用）
 *   diaryEntries:  [{date:"YYYY-MM-DD", content}]（任意序，内部按日期排）
 *   memoriesV2:    [{id, text, kind, subject, status, created_at?, established_at?, anchor?}]（priority 已删）
 *   query:         string（本轮 user 消息文本；空则 Relevant 块为空）
 *   config:        object（可选，浅合并覆盖 DEFAULT_CONFIG）
 * @param {object} opts 可选：{ includeEmpty: boolean }——true 时空块也返回（empty:true，content:""，shadow 诊断用）
 * @returns {{blocks: Array<{key,title,content,tokens,empty}>}}
 */
function buildContextBlocks(input, opts) {
  const mergedCfg = Object.assign({}, DEFAULT_CONFIG, input && input.config ? input.config : {});
  mergedCfg.budgets = Object.assign({}, DEFAULT_CONFIG.budgets, input && input.config && input.config.budgets ? input.config.budgets : {});
  const cfg = mergedCfg;
  const options = opts || {};
  const input_ = input || {};

  // 逐块构建（顺序=BLOCK_DEFS）；先固定块收集成员 id，Relevant 去重
  const sysIns = buildSystemInstructions(input_, cfg);
  const identity = buildCoreIdentity(input_, cfg);
  const understanding = buildUnderstanding(input_, cfg);
  const moments = buildMoments(input_, cfg);
  const fixedIdSet = new Set([].concat(sysIns.fixedIds, identity.fixedIds, understanding.fixedIds, moments.fixedIds));
  const continuity = buildContinuity(input_, cfg);
  const relevant = buildRelevant(input_, cfg, fixedIdSet);
  const relevantHits = relevant.hits || [];

  const byKey = {
    context_assembly: { lines: [ASSEMBLY_OVERVIEW], fixedIds: [] }, // 顶层引导：静态全文，恒注入
    system_instructions: sysIns,
    core_identity: identity,
    long_term_understanding: understanding,
    meaningful_moments: moments,
    conversation_continuity: continuity,
    relevant_memories: relevant,
  };

  const blocks = [];
  for (const def of BLOCK_DEFS) {
    const b = byKey[def.key];
    const isEmpty = !b.lines.length;
    if (isEmpty && !options.includeEmpty) continue;
    const content = isEmpty ? "" : compose(HEADERS[def.key] || null, b.lines);
    blocks.push({
      key: def.key,
      title: def.title,
      content,
      tokens: isEmpty ? 0 : estimateTokens(content),
      empty: isEmpty,
    });
  }
  return { blocks, relevantHits };
}

module.exports = { buildContextBlocks, DEFAULT_CONFIG, BLOCK_DEFS, HEADERS, estimateTokens };
