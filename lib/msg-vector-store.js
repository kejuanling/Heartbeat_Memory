// msg-vector-store.js — 消息向量缓存 SQLite 存储层（2026-09-13 阶段4）
// 取代 data/context_msg_vectors.json 的全量 stringify 落盘：node:sqlite 单表（零新依赖），
// sig 主键 upsert + 按需取行；L1 小 Map 兜高频重复 sig；超 2 万条按 updated 淘汰。
// 首次启动自动迁移旧 JSON（迁移成功后改名 .migrated 保留；回滚=代码改回旧版+把 .migrated 改回原名）。
// 仅 gateway 进程惰性打开（wake-up 只用替换功能，从不触发加载），无跨进程写冲突。
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "context_msg_vectors.db");
const LEGACY_JSON = path.join(DATA_DIR, "context_msg_vectors.json");
const LEGACY_MIGRATED = LEGACY_JSON + ".migrated";
const MAX_ROWS = 20000;   // 与旧 JSON 时代上限一致
const L1_MAX = 3000;      // 常驻内存向量条数（512 维 float32 ≈ 2KB/条，3000 条约 6MB）

let db = null;
let l1 = new Map(); // sig -> Float32Array

function _init() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS vectors (sig TEXT PRIMARY KEY, vec BLOB NOT NULL, updated INTEGER NOT NULL)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_vectors_updated ON vectors(updated)");
  _migrateLegacy();
  return db;
}

// 旧 JSON → SQLite 一次性迁移：仅当库为空且旧文件存在。updated 用基准时间+序号递增，
// 保住旧 order 的插入顺序语义（老条目先淘汰）。
function _migrateLegacy() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM vectors").get();
  if (row.c > 0) return;
  if (!fs.existsSync(LEGACY_JSON)) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(LEGACY_JSON, "utf8")); } catch (e) {
    console.log("[vec-store] 旧 JSON 解析失败，跳过迁移（保持旧文件原样）:", e.message);
    return;
  }
  const vecs = raw && raw.vecs && typeof raw.vecs === "object" ? raw.vecs : {};
  const order = Array.isArray(raw.order) ? raw.order : Object.keys(vecs);
  const ins = db.prepare("INSERT OR REPLACE INTO vectors(sig, vec, updated) VALUES(?, ?, ?)");
  const base = Date.now() - 1000;
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const sig of order) {
      const b64 = vecs[sig];
      if (!b64) continue;
      const buf = Buffer.from(b64, "base64");
      if (buf.length < 4) continue;
      ins.run(sig, buf, base + n);
      n++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.log("[vec-store] 迁移失败回滚，旧文件保留:", e.message);
    return;
  }
  try { fs.renameSync(LEGACY_JSON, LEGACY_MIGRATED); } catch (e) { /* 改名失败不影响入库结果 */ }
  console.log("[vec-store] 旧 JSON 迁移入库:", n, "条，旧文件已改名 .migrated");
}

function _l1Put(sig, v) {
  if (l1.has(sig)) l1.delete(sig);
  l1.set(sig, v);
  while (l1.size > L1_MAX) l1.delete(l1.keys().next().value);
}

function _evictIfNeeded() {
  const c = db.prepare("SELECT COUNT(*) AS c FROM vectors").get().c;
  if (c <= MAX_ROWS) return;
  db.prepare("DELETE FROM vectors WHERE sig IN (SELECT sig FROM vectors ORDER BY updated ASC LIMIT ?)").run(c - MAX_ROWS);
}

// BLOB(Uint8Array/Buffer) → Float32Array：slice 出独立 ArrayBuffer 规避字节对齐问题
function _blobToF32(blob) {
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(ab);
}

// 批量取：sigs 中命中的 sig -> Float32Array（L1 优先，未命中一次 SQL IN 查询）
function getMany(sigs) {
  _init();
  const out = new Map();
  const miss = [];
  for (const sig of sigs) {
    const hit = l1.get(sig);
    if (hit) out.set(sig, hit);
    else miss.push(sig);
  }
  for (let i = 0; i < miss.length; i += 400) {
    const chunk = miss.slice(i, i + 400);
    const rows = db.prepare(
      "SELECT sig, vec FROM vectors WHERE sig IN (" + chunk.map(() => "?").join(",") + ")"
    ).all(...chunk);
    for (const r of rows) {
      const v = _blobToF32(r.vec);
      if (v.length) { out.set(r.sig, v); _l1Put(r.sig, v); }
    }
  }
  return out;
}

function has(sig) {
  _init();
  if (l1.has(sig)) return true;
  return !!db.prepare("SELECT 1 FROM vectors WHERE sig = ?").get(sig);
}

// 写入：upsert（含更新，刷新 updated 作 LRU 依据）
function set(sig, v) {
  _init();
  const f32 = Float32Array.from(v);
  if (!f32.length) return;
  db.prepare(
    "INSERT INTO vectors(sig, vec, updated) VALUES(?, ?, ?) " +
    "ON CONFLICT(sig) DO UPDATE SET vec = excluded.vec, updated = excluded.updated"
  ).run(sig, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), Date.now());
  _l1Put(sig, f32);
  _evictIfNeeded();
}

function count() {
  _init();
  return db.prepare("SELECT COUNT(*) AS c FROM vectors").get().c;
}

module.exports = { getMany, has, set, count };
