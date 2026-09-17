"use strict";

// ========================
// Context Shadow Compare（C9）——旧检索 vs V2 检索 的影子对比
// 纯函数模块：oldRetrieve / v2Retrieve 由调用方注入，本模块不 require 旧池、不写任何文件。
//   生产接法（CLI main）：把旧池 json 拷贝到副本目录，设 MEMORY_DATA_DIR 指向副本后
//   require memory-pool 的 retrieveHybrid——真实旧公式跑在副本上，副作用（计数/时间戳）
//   全落副本，旧池零影响。
// 统计口径（任务要求）：
//   命中差异（两边结果的文本键交集/独占）、数量差异（平均条数差）、类型分布（v2 的 kind
//   直方图 / 旧结果的 category 直方图）。
// ========================

const crypto = require("crypto");
const path = require("path");

function textKey(t) {
  return crypto.createHash("sha256").update(String(t || "").replace(/\s+/g, ""), "utf8").digest("hex").slice(0, 16);
}

function extractText(m) { return m && (m.text || m.content) || ""; }
function extractType(m, side) {
  if (!m) return null;
  return side === "v2" ? (m.kind || null) : (m.category || m.kind || null);
}

// queries: string[]；oldRetrieve/v2Retrieve: async (query) => memories 数组
async function compareQueries(queries, oldRetrieve, v2Retrieve) {
  const per_query = [];
  const v2TypeDist = {};
  const oldTypeDist = {};
  let sumOld = 0, sumV2 = 0, sumOverlap = 0, sumOldOnly = 0, sumV2Only = 0;

  for (const query of queries) {
    const q = String(query || "").trim();
    if (!q) continue;
    const oldList = (await oldRetrieve(q)) || [];
    const v2List = (await v2Retrieve(q)) || [];

    const oldKeys = new Set(oldList.map((m) => textKey(extractText(m))));
    const v2Keys = new Set(v2List.map((m) => textKey(extractText(m))));
    let overlap = 0, oldOnly = 0, v2Only = 0;
    for (const k of oldKeys) (v2Keys.has(k) ? overlap++ : oldOnly++);
    for (const k of v2Keys) if (!oldKeys.has(k)) v2Only++;

    for (const m of v2List) {
      const t = extractType(m, "v2") || "unknown";
      v2TypeDist[t] = (v2TypeDist[t] || 0) + 1;
    }
    for (const m of oldList) {
      const t = extractType(m, "old") || "unknown";
      oldTypeDist[t] = (oldTypeDist[t] || 0) + 1;
    }

    sumOld += oldList.length; sumV2 += v2List.length;
    sumOverlap += overlap; sumOldOnly += oldOnly; sumV2Only += v2Only;

    per_query.push({
      query: q,
      old_count: oldList.length,
      v2_count: v2List.length,
      overlap,
      old_only: oldOnly,
      v2_only: v2Only,
      v2_kinds: [...new Set(v2List.map((m) => extractType(m, "v2")))].filter(Boolean),
    });
  }

  const n = per_query.length || 1;
  return {
    queries: per_query.length,
    per_query,
    summary: {
      avg_old_count: Math.round((sumOld / n) * 100) / 100,
      avg_v2_count: Math.round((sumV2 / n) * 100) / 100,
      avg_overlap: Math.round((sumOverlap / n) * 100) / 100,
      total_old_only: sumOldOnly,
      total_v2_only: sumV2Only,
      hit_diff_avg: Math.round(((sumV2 - sumOld) / n) * 100) / 100,
      v2_type_distribution: v2TypeDist,
      old_type_distribution: oldTypeDist,
    },
  };
}

function printCompare(result) {
  console.log(`=== 新旧检索影子对比（${result.queries} 个 query）===`);
  console.log("\n[逐 query]");
  console.log("query                      old  v2  overlap  old_only  v2_only");
  for (const q of result.per_query) {
    console.log(`${q.query.slice(0, 24).padEnd(26)} ${String(q.old_count).padStart(3)} ${String(q.v2_count).padStart(3)} ${String(q.overlap).padStart(8)} ${String(q.old_only).padStart(8)} ${String(q.v2_only).padStart(8)}`);
  }
  console.log("\n[汇总]");
  const s = result.summary;
  console.log(`平均条数：old=${s.avg_old_count} vs v2=${s.avg_v2_count}（差 ${s.hit_diff_avg}）`);
  console.log(`平均重叠：${s.avg_overlap}；旧独有合计 ${s.total_old_only}；v2 独有合计 ${s.total_v2_only}`);
  console.log(`v2 类型分布：${JSON.stringify(s.v2_type_distribution)}`);
  console.log(`旧类型分布：${JSON.stringify(s.old_type_distribution)}`);
}

// CLI：--queries <文件 每行一个 query> --old-data <旧池副本目录> [--v2-collection <路径>] [--topk 5]
// 旧池跑在副本上（MEMORY_DATA_DIR 指向副本，副作用全落副本），生产旧池零影响。
async function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : dflt);
  const qFile = get("--queries", null);
  const oldDataDir = get("--old-data", null);
  const v2Collection = get("--v2-collection", "data/memory_v2.json");
  const topK = Number(get("--topk", 5));
  if (!qFile) { console.error("用法: node context-v2-compare.js --queries <文件> --old-data <旧池副本目录> [--v2-collection <路径>] [--topk 5]"); process.exit(2); }

  const fs = require("fs-extra");
  const queries = fs.readFileSync(qFile, "utf8").split("\n").map((x) => x.trim()).filter(Boolean);
  if (!queries.length) { console.error("query 文件为空"); process.exit(2); }

  const { createMemoryV2Reader } = require("./context-v2-adapter");
  const reader = createMemoryV2Reader({ rootDir: __dirname, paths: { collection: v2Collection } });
  const v2Retrieve = async (q) => reader.retrieve(q, { topK }).memories;

  let oldRetrieve;
  if (oldDataDir) {
    process.env.MEMORY_DATA_DIR = path.resolve(oldDataDir); // 必须在 require 旧池之前
    const memoryPool = require("./memory-pool"); // 真旧池代码跑在副本上
    // 旧侧用 retrieve()（词面+importance，无 embed 无后台定时器）：
    // retrieveHybrid 会触发 warmVectors 补算定时器（进程永不退出）且依赖 embed-server。
    oldRetrieve = async (q) => {
      const r = memoryPool.retrieve(q, { topK });
      return Array.isArray(r) ? r : [];
    };
    // 收尾清理（旧池模块的 flush 定时器若存在则清除），并以显式退出兜底
    if (typeof memoryPool.shutdown === "function") process.on("exit", () => { try { memoryPool.shutdown(); } catch (_) {} });
  } else {
    console.warn("未提供 --old-data：old 侧返回空（只看 v2 侧）");
    oldRetrieve = async () => [];
  }

  const result = await compareQueries(queries, oldRetrieve, v2Retrieve);
  printCompare(result);
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { compareQueries, printCompare, textKey };
