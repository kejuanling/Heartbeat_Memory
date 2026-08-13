"use strict";

// 上下文压缩预览（只算不生效）
// 用法: node context-preview.js [--chunk-size 100] [--keep-recent 150] [--min-messages 250] [--gap-minutes 30] [--json]

const compactor = require("./context-compactor");

const args = process.argv.slice(2);
const opts = {};
let jsonMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--chunk-size") opts.compaction_chunk_size = Number(args[++i]);
  else if (args[i] === "--keep-recent") opts.compaction_keep_recent_messages = Number(args[++i]);
  else if (args[i] === "--min-messages") opts.compaction_min_messages = Number(args[++i]);
  else if (args[i] === "--gap-minutes") opts.compaction_gap_minutes = Number(args[++i]);
  else if (args[i] === "--json") jsonMode = true;
}

const plan = compactor.preview(opts);
const t = plan.totals;

if (jsonMode) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

console.log("=== 上下文压缩预览 ===");
console.log("分块目标:", plan.config.compaction_chunk_size, "条 | 浮动范围:", plan.config.compaction_chunk_min, "-", plan.config.compaction_chunk_max);
console.log("保留原文尾部:", plan.config.compaction_keep_recent_messages, "条 | 触发阈值:", plan.config.compaction_min_messages, "条 | 时间边界阈值:", plan.config.compaction_gap_minutes, "分钟");
console.log("真实对话消息:", plan.totalCompressible, "条 | 需压缩:", plan.compactCount, "条 | 保留原文:", plan.keptRawCount, "条");
console.log("块数:", t.chunkCount, "| 已缓存摘要:", t.cachedCount);
console.log("原始体量:", t.totalChars, "字符 -> 压缩后约:", t.estCompressedChars, "字符 (节省约", t.estSavedChars, "字符)");
console.log("");
if (t.chunkCount === 0) {
  console.log("（当前消息数未达到压缩阈值，或全部保留原文，无需压缩）");
} else {
  console.log("块明细:");
  plan.chunks.forEach(function (c) {
    console.log(
      "  #" + String(c.index).padStart(2, " ") +
      " | 第" + (c.firstIdx + 1) + "-" + (c.lastIdx + 1) + "条" +
      " | " + c.count + "条 | " + c.startTime + " ~ " + c.endTime +
      " | " + c.chars + "字" +
      " | " + (c.cached ? "已缓存" : "未生成") +
      " | " + c.head
    );
  });
}
