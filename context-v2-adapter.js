"use strict";

// ========================
// Context V2 词面工具（原 C9 读取旁路适配器）：零依赖分词 + 词面相似度。
// createMemoryV2Reader（读取旁路主功能）已于 2026-09-28 退役——全仓零消费者（仅 S3
// shadow 评估期使用过）；tokenize/similarity 因被 context-v2-builder 与
// memory-v2-vectors 复用而保留。
// 相似度 = max(jaccard, containment)；已知局限：短文本词面相似虚高（S78 同源问题），
// 调用方以阈值兜底（Round 5 实证：硬塞 topK = Noise 0.48 的教训，宁缺毋滥）。
// ========================

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

module.exports = { tokenize, similarity };
