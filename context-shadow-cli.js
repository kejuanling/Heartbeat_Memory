#!/usr/bin/env node
"use strict";
// ============================================================
// Context Shadow CLI（C10 S3）—— shadow JSONL 只读汇总报表
// 用法：node context-shadow-cli.js [--days 1] [--dir data/context_shadow]
// 零生产写入；只读 data/context_shadow/context_shadow_YYYYMM.jsonl。
// ============================================================

const fs = require("fs");
const path = require("path");

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseDir = __dirname;
const dir = path.resolve(baseDir, argVal("--dir", "data/context_shadow"));
const days = Math.max(1, Number(argVal("--days", 1)) || 1);
const since = Date.now() - days * 86400000;

// ---- 读全部按月文件 ----
let files = [];
try { files = fs.readdirSync(dir).filter(f => /^context_shadow_\d{6}\.jsonl$/.test(f)).sort(); } catch (e) { /* 目录不存在 */ }
let records = [];
let badLines = 0;
for (const f of files) {
  const { records: rs, badLines: bad } = (() => {
    try {
      const recs = [];
      let bad0 = 0;
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try { recs.push(JSON.parse(s)); } catch (e) { bad0++; }
      }
      return { records: recs, badLines: bad0 };
    } catch (e) { return { records: [], badLines: 0 }; }
  })();
  records = records.concat(rs);
  badLines += bad;
}
const inRange = records.filter(r => r && r.ts && Date.parse(r.ts) >= since);
inRange.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

const fmt = n => Number(n || 0).toLocaleString("zh-CN");
console.log("== Context V2 Shadow 报告 ==");
console.log(`范围：最近 ${days} 天｜记录 ${inRange.length} 条｜坏行 ${badLines}｜文件 ${files.length} 个`);
if (inRange.length) {
  console.log(`时间：${inRange[0].ts} ~ ${inRange[inRange.length - 1].ts}`);
  const sessions = new Set(inRange.map(r => r.sessionId));
  console.log(`会话（脱敏）：${[...sessions].join(", ")}`);
} else {
  console.log("（暂无记录——开关未开或尚无主聊天流量）");
  process.exit(0);
}

// ---- v2 块分布 ----
const BLOCK_ORDER = ["context_assembly", "system_instructions", "core_identity", "long_term_understanding", "meaningful_moments", "conversation_continuity", "relevant_memories"];
const stat = {};
for (const r of inRange) {
  for (const b of r.v2 || []) {
    const s = stat[b.key] || (stat[b.key] = { n: 0, tok: 0, empty: 0 });
    s.n++;
    s.tok += b.tokens || 0;
    if (b.empty) s.empty++;
  }
}
console.log("\n== 块分布（v2 侧，" + inRange.length + " 轮） ==");
for (const key of BLOCK_ORDER) {
  const s = stat[key];
  if (!s) { console.log(`  ${key.padEnd(26)} 从未出现`); continue; }
  console.log(`  ${key.padEnd(26)} 出现 ${String(s.n).padStart(4)}  avg ${String(Math.round(s.tok / s.n)).padStart(5)} tok  empty ${s.empty}`);
}
const missing = BLOCK_ORDER.filter(k => !stat[k]);
if (missing.length) console.log(`  未出现块：${missing.join(", ")}`);

// ---- Token ----
const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
const oT = inRange.map(r => r.tokenDelta && r.tokenDelta.oldTotal);
const vT = inRange.map(r => r.tokenDelta && r.tokenDelta.v2Total);
const viT = inRange.map(r => r.tokenDelta && r.tokenDelta.v2InjectTotal);
console.log("\n== Token（avg/轮） ==");
console.log(`  old 全量 ${fmt(avg(oT))}｜v2 全量 ${fmt(avg(vT))}｜v2 注入口径 ${fmt(avg(viT))}｜差（v2注入-old全量） ${fmt(avg(viT) - avg(oT))}`);

// ---- 重复 ----
const oc = inRange.reduce((s, r) => s + ((r.overlaps || []).length), 0);
console.log(`\n== 重复（overlaps，固定块间行级） ==`);
console.log(`  总计 ${oc} 条（avg ${Math.round(oc / inRange.length * 10) / 10}/轮）`);
const seen = new Set();
let shown = 0;
for (const r of inRange) {
  for (const o of r.overlaps || []) {
    const k = o.v2Key + "|" + o.line;
    if (seen.has(k)) continue;
    seen.add(k);
    if (shown < 5) { console.log(`    [${o.v2Key} ← ${o.oldKey}] ${String(o.line).slice(0, 50)}`); shown++; }
  }
}

// ---- 映射版本 ----
const mv = {};
for (const r of inRange) mv[r.mapVersion == null ? "null" : r.mapVersion] = (mv[r.mapVersion == null ? "null" : r.mapVersion] || 0) + 1;
console.log(`\n== pinned 映射版本 ==  ${Object.entries(mv).map(([k, v]) => `v${k}: ${v} 轮`).join("｜")}`);

// ---- 样本 ----
const latest = inRange[inRange.length - 1];
const smp = latest.samples || {};
console.log("\n== Current State 截取样例（最新一条） ==");
console.log("  " + (smp.current_state || "（空）").replace(/\n/g, "\n  "));
console.log("\n== Possibly Relevant Memories 样例（最新一条） ==");
console.log("  " + (smp.relevant_memories || "（空）").replace(/\n/g, "\n  "));

console.log("\n== 构建耗时 ==");
console.log(`  avg ${Math.round(inRange.reduce((s, r) => s + (r.durationMs || 0), 0) / inRange.length)} ms  max ${Math.max(...inRange.map(r => r.durationMs || 0))} ms`);
