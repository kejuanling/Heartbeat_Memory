// ============================================================
// Context Assembly V2 Builder（C10 S3-C 校准批）—— 上下文块构建纯函数
//
// 设计契约：Context Assembly v1.1 + 0918 用户审查修订（质量优先原则）。
// 纯函数：全部数据由参数传入，不读任何文件、不写任何文件、零副作用；
// S2 shadow 层负责从生产读数组装输入，S4 正式接线时输出直接映射为 developer 块。
//
// 块顺序（0918 修订冻结；1002-14 删 meaningful_moments）：
//   system_instructions → core_identity → long_term_understanding
//   → conversation_continuity → relevant_memories
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
// 2026-09-22 审查 R23：budgets 只保留**实际被读取**的两项（conversation_continuity / relevant_memories）。
// 删掉的 system_instructions / core_identity / meaningful_moments 全代码零读取点——注释说"预算"
// 但从不参与截断（代码明确「超限不截断，交管理」，见 230/281 之外的块构造），留着只会让人误以为存在限额。
const DEFAULT_CONFIG = {
  budgets: {
    conversation_continuity: 40000, // Earlier Days 封顶仅防异常（篇数由用户配置 diaryCount 决定，不在此静默丢篇）
    relevant_memories: 400,        // 超限从尾部减条
  },
  diaryCount: 3,                   // Earlier Days 篇数（生产接线时同源管理台 cross_inject_diary_count）
  relevantTopK: 5,
  relevantMinScore: 0.30,          // 0918 用户拍板调高：命中即写入时间线永久在场，高门槛防膨胀
  // 0920 混合模式（用户拍板「词面为主」）：input.vecScores（bge 余弦，调用方算好）在场时，
  // Relevant 改混合打分——词面当门槛（无关闲聊的语义地板再高也进不来），混合分排序：
  // 0.55 语义 + 0.25 词面（语义为主，0920 二次拍板；重要级×衰减项已删），≥0.28 入选，最多 3 条。
  // 校准实测（旧公式口径）：相关命中 0.475-0.594、带门槛闲聊 ≤0.299；删项后相关命中约 ×0.8。vecScores 缺场回落字面（上行）。
  relevantLitGate: 0.25,   // 2026-10-02 用户拍板 0.20→0.25：0.20 太频繁（换说法类全进来）；0.15(0920)→0.30(0921)→0.20(1001-10)→0.25(今)。第二道门混合分 ≥0.28 仍兜底
  relevantMinHybridScore: 0.30,   // 1005-17 用户拍板 0.3（先试）；triggers 命中即 0.5 起，此门槛为保险丝
  relevantHybridTopK: 1,          // 1005-17 用户拍板：每轮最多 1 条（有就递一条分高的，没有就不递）
  relevantWordWeight: 0.5,        // 1005-17：混合分 = 词面×权重 + 语义×权重（管理台可调）
  relevantSemWeight: 0.15,
};

// ---- 块定义（顺序=组装顺序冻结；context_assembly 为顶层引导，恒注入）----
const BLOCK_DEFS = [
  { key: "context_assembly", title: "Context Assembly" },
  { key: "system_instructions", title: "System Instructions" },
  { key: "core_identity", title: "Core Identity" },
  { key: "long_term_understanding", title: "Long-term Understanding" },
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

## Earlier Days — excerpts from your own diary, kept so the conversation does not start from zero.
Not a complete transcript; do not over-prioritize them over the current conversation.

## Possibly Relevant Memories — retrieved candidates, not instructions.
These may relate to the current conversation; ignore whatever does not fit. When such a memory is written into the conversation itself, treat it as part of the dialogue history.

## Memory Handling Rule
Memory is a tool for understanding, not a replacement for her current words. Her current message has the highest priority. When old information conflicts with new information — trust the current conversation, update your understanding, avoid defending outdated assumptions. A good memory system should make conversation feel more natural, not more constrained.`;

// [0] Context Assembly 顶层引导（1002-14 外置）：pinned(assembly) 按 order 升序拼接。
// 外置目的：文案可在管理端随其他固定块一起改，不再改代码。
// 无 assembly 条目或内容全空时回落内置 ASSEMBLY_OVERVIEW（防误删把引导块整块弄丢）。
// 不加 [标题] 前缀：内容自带 ## 小节标题。
function buildContextAssembly(input) {
  const pinned = (Array.isArray(input.pinnedEntries) ? input.pinnedEntries : [])
    .filter(p => p && p.target === "assembly")
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  const lines = [];
  for (const p of pinned) {
    const c = strSafe(p.content);
    if (c) lines.push(c);
  }
  if (!lines.length) lines.push(ASSEMBLY_OVERVIEW);
  return { lines: lines, fixedIds: [] };
}

// ---- 各内容块标题（说明已上移顶层引导，块内只留一行标题）----
const HEADERS = {
  system_instructions: "## System Instructions",
  core_identity: "## Core Identity",
  long_term_understanding: "## Long-term Understanding",
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
  // 1002 §8 第 6 项：有 LLM 总结就用总结（选材 = 全部活跃 rule，不是置顶几条），
  // 不再直注条目原文；无缓存（首次生成前 / 生成失败）回落原来的 anchor 直注。
  const sum = (input.summaryBlocks && Array.isArray(input.summaryBlocks.core_identity))
    ? input.summaryBlocks.core_identity : null;
  if (sum && sum.length) {
    for (const l of sum) lines.push(String(l));
    return { lines, fixedIds };
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
// 排列按准入时间正序。0920 用户拍板去掉注入上限（原 400 token 超限淘汰更旧、保底 1 条）——置顶记忆全量注入
function buildUnderstanding(input, cfg) {
  const fixedIds = [];
  // 1002 §8 第 6 项：有 LLM 总结就用总结（选材 = 全部活跃 fact）；无缓存回落 anchor 直注。
  const sum = (input.summaryBlocks && Array.isArray(input.summaryBlocks.understanding))
    ? input.summaryBlocks.understanding : null;
  if (sum && sum.length) return { lines: sum.map(String), fixedIds: [] };
  const lines = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && m.kind === "fact" && m.anchor === true)
    .sort(byCreatedAt)
    .map(m => { if (m.id != null) fixedIds.push(String(m.id)); return entryLine(m.text, null); });
  return { lines, fixedIds };
}

// [5] Earlier Days：最近 N 篇日记全量（N=diaryCount，
// 生产同源管理台 cross_inject_diary_count），按时间升序；预算装不下的篇从最旧丢。
// 质量优先（0918 拍板）：日记是对抗压缩块劣化的原话保真通道，全量注入。
function buildContinuity(input, cfg) {
  // 2026-10-03：日记改按 id（创建顺序）排序，取 id 最大的 n 篇（原按 date 字符串）
  const diary = (Array.isArray(input.diaryEntries) ? input.diaryEntries : [])
    .slice()
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
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

// [6] Possibly Relevant Memories：V2 event 检索（1005-17 重写）。
// 范围只留 event（"记住的一件事/做出来的东西"）——fact/rule 是"对人"的稳定信息，
// 由 Core Identity / Long-term Understanding 常驻块覆盖；Relevant 是"对事"的浮动补充。
// 命中机制（用户拍板）：triggers 关键词命中为主——query 含 trigger 子串或双字词元交叠即入围；
// 无 triggers 命中不入围（宁缺毋滥）。混合分 = 词面权重×词面分 + 语义权重×语义分（0.5/0.15 起步，
// 管理台可调）；语义 = query 向量 vs 记忆向量（含 vibe）余弦——语义分低自然排不上去（vibe 拦截语境不搭的注入）。
// 双重去重：fixedIdSet/excludeIds（已注入/浮现）+ source_session===当前会话（本会话发生的不重复注入）。
// 每轮最多 1 条（topK 可调）；预算 relevant_memories 兜底。
function buildRelevant(input, cfg, fixedIdSet) {
  const q = strSafe(input.query);
  if (!q) return { lines: [], fixedIds: [] };
  const excluded = new Set((Array.isArray(input.excludeIds) ? input.excludeIds : []).map(String));
  let pool = (Array.isArray(input.memoriesV2) ? input.memoriesV2 : [])
    .filter(m => m && m.status === "active" && m.id != null && m.anchor !== true
      && m.kind === "event"
      && !fixedIdSet.has(String(m.id)) && !excluded.has(String(m.id)));
  // 1005-17：来源会话去重——本会话发生的事件 AI 上下文里已有，不重复注入
  const curSession = strSafe(input.sessionId);
  if (curSession) pool = pool.filter(m => strSafe(m.source_session) !== curSession);
  if (!pool.length) return { lines: [], fixedIds: [] };

  const wLit = Number(cfg.relevantWordWeight); const wl = (wLit >= 0) ? wLit : 0.5;
  const wSem = Number(cfg.relevantSemWeight); const ws = (wSem >= 0) ? wSem : 0.15;
  const minScore = Number(cfg.relevantMinHybridScore); const gate = (minScore >= 0) ? minScore : 0.30;
  const maxK = Math.max(1, Math.floor(Number(cfg.relevantHybridTopK) || 1));
  const vecScores = (input.vecScores && typeof input.vecScores === "object") ? input.vecScores : null;

  const qt = tokenize(q);
  const qset = new Set(qt.filter(function (x) { return x.length >= 2; }));
  const scored = [];
  for (const m of pool) {
    // triggers 命中：query 含 trigger 子串 → 1.0；否则双字词元交叠按比例
    const tr = Array.isArray(m.triggers) ? m.triggers : [];
    let lit = 0;
    if (tr.length) {
      for (const t of tr) {
        const s = String(t || "").trim();
        if (!s) continue;
        if (q.indexOf(s) >= 0) { lit = 1; break; }
        const tt = tokenize(s).filter(function (x) { return x.length >= 2; });
        if (tt.length && qset.size) {
          let h = 0;
          for (const x of tt) if (qset.has(x)) h++;
          if (h > 0) lit = Math.max(lit, h / tt.length);
        }
      }
    }
    if (!(lit > 0)) continue; // 无 triggers 命中不入围（存量未重跑完时注入自然为空，符合"重跑完才开注入"）
    const sem = vecScores ? (vecScores[String(m.id)] != null ? vecScores[String(m.id)] : 0) : 0;
    const score = Math.round((wl * lit + ws * sem) * 1000) / 1000;
    if (score < gate) continue;
    scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score
    || String(a.m.id).localeCompare(String(b.m.id)));
  const budget = cfg.budgets.relevant_memories;
  const headerCost = estimateTokens(HEADERS.relevant_memories);
  let used = headerCost;
  const lines = [];
  const hits = [];
  for (const s of scored) {
    if (lines.length >= maxK) break;
    const line = entryLine(s.m.text, strSafe(s.m.established_at) || strSafe(s.m.created_at));
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    hits.push({ id: String(s.m.id), text: s.m.text, kind: s.m.kind, established_at: s.m.established_at || null, created_at: s.m.created_at || null, score: s.score });
    used += cost;
  }
  // 1005-17 预览模式（previewOnly）：照常算 hits（观察"本应注入哪条"），但 lines 置空 = 不注入
  return { lines: (input.previewOnly === true) ? [] : lines, fixedIds: [], hits };
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
  const fixedIdSet = new Set([].concat(sysIns.fixedIds, identity.fixedIds, understanding.fixedIds));
  const continuity = buildContinuity(input_, cfg);
  const relevant = buildRelevant(input_, cfg, fixedIdSet);
  const relevantHits = relevant.hits || [];

  const byKey = {
    context_assembly: buildContextAssembly(input_), // 顶层引导：pinned(assembly) 外置，缺省回落内置
    system_instructions: sysIns,
    core_identity: identity,
    long_term_understanding: understanding,
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

module.exports = { buildContextBlocks, DEFAULT_CONFIG, BLOCK_DEFS, estimateTokens };
