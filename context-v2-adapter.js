"use strict";

// ========================
// Context V2 Adapter（C9）——V2 读取旁路适配器（只读评估用）
// 铁律：
//   1. 只读取 Memory V2 集合（active 条目）；不 require 旧池，不读旧池任何文件；
//   2. 不替换旧 context builder、不改最终 prompt、不影响生产回答——本模块不被任何
//      生产链路调用，仅供 shadow 对比与评估；
//   3. 检索恒只读（Schema 冻结 8）。
// 输出契约（冻结）：{ memories[], source, score, reason }
// 评分（C9 简版）：自含分词器（零依赖）词面相似 = max(jaccard, containment)；
//   排序：score desc → priority desc（priority 只做并列打破，不进分数——Round 5 实证）；
//   minScore 默认 0.15：宁缺毋滥，允许空结果（硬塞 topK = Noise 0.48 的教训）。
// 已知局限：短文本词面相似虚高（S78 同源问题），评估口径下用阈值兜底；语义排序等
//   judge/检索升级后再补。
// ========================

const { createStore } = require("./memory-v2");

function tokenize(s) {
  const t = String(s || "").toLowerCase().replace(/<[^>]+>/g, "");
  const out = new Set();
  for (const run of t.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || []) {
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      out.add(run[i]);
      if (i + 1 < run.length) out.add(run[i] + run[i + 1]);
    }
  }
  return out;
}

function similarity(queryTokens, text) {
  const t = tokenize(text);
  if (!queryTokens.size || !t.size) return 0;
  let inter = 0;
  for (const x of queryTokens) if (t.has(x)) inter++;
  const union = queryTokens.size + t.size - inter;
  const jaccard = union ? inter / union : 0;
  const containment = inter / Math.min(queryTokens.size, t.size);
  return Math.max(jaccard, containment);
}

function strSafe(v) { return v == null ? null : String(v).trim(); }

// opts: { rootDir?, paths?（覆盖 collection 路径，如指向影子集合做实验）, readonly? 恒 true }
function createMemoryV2Reader(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const store = createStore({
    rootDir,
    readonly: true, // 读取旁路恒只读
    config: { paths: opts.paths || {} },
  });

  // 返回（冻结）：{ memories[], source, score, reason }
  // memories[]：{ id, text, kind, subject, confidence, priority, score, created_at }
  function retrieve(query, ropts = {}) {
    const topK = ropts.topK != null ? Number(ropts.topK) : 5;
    const minScore = ropts.minScore != null ? Number(ropts.minScore) : 0.15;
    const q = strSafe(query);
    if (!q) return { memories: [], source: "memory_v2", score: 0, reason: "空查询" };

    const rows = store.list({ status: "active" });
    if (!rows.length) {
      return { memories: [], source: "memory_v2", score: 0, reason: `Memory V2 为空（${store.paths.collection}）` };
    }

    const qt = tokenize(q);
    let passed = 0;
    const scored = [];
    for (const r of rows) {
      const score = Math.round(similarity(qt, r.text) * 1000) / 1000;
      if (score < minScore) continue;
      passed++;
      scored.push({
        id: r.id,
        text: r.text,
        kind: r.kind,
        subject: r.subject,
        confidence: r.confidence,
        priority: r.priority,
        score,
        created_at: r.created_at,
      });
    }
    scored.sort((a, b) => b.score - a.score || (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)));
    const top = scored.slice(0, topK);
    const topScore = top.length ? top[0].score : 0;
    const filteredNote = `active ${rows.length} 条，过阈值(${minScore}) ${passed} 条，取 top${topK}`;
    if (!top.length) {
      return { memories: [], source: "memory_v2", score: 0, reason: `无命中——${filteredNote}（宁缺毋滥，允许空结果）` };
    }
    return {
      memories: top,
      source: "memory_v2",
      score: topScore,
      reason: `${filteredNote}；排序：score desc → priority desc`,
    };
  }

  return { retrieve, store, paths: store.paths };
}

module.exports = { createMemoryV2Reader, tokenize, similarity };
