"use strict";

// 留纸 JSON 统一读写模块（2026-10-03）：data/papers.json
// schema: { version: 1, next_id, entries: [{ id, title, tags, created_at, updated_at, content }] }
// entries 按 id 升序 = 创建顺序；留纸全局共享（1009-10 起不再存 session）；原子写（tmp + rename）。
const fs = require("fs");
const path = require("path");

function storePath(baseDir) {
  return path.join(baseDir, "data", "papers.json");
}

function load(baseDir) {
  try {
    const d = JSON.parse(fs.readFileSync(storePath(baseDir), "utf8"));
    if (d && Array.isArray(d.entries)) return d;
  } catch (e) {}
  return { version: 1, next_id: 1, entries: [] };
}

function save(baseDir, store) {
  fs.mkdirSync(path.dirname(storePath(baseDir)), { recursive: true });
  const tmp = storePath(baseDir) + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, storePath(baseDir));
}

function addEntry(baseDir, entry) {
  const st = load(baseDir);
  const id = st.next_id;
  st.entries.push({
    id,
    title: entry.title == null ? "" : String(entry.title),
    category: entry.category == null ? "" : String(entry.category),
    reason: entry.reason == null ? "" : String(entry.reason),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    created_at: entry.created_at || new Date().toISOString(),
    updated_at: entry.updated_at || entry.created_at || new Date().toISOString(),
    content: String(entry.content || ""),
  });
  st.next_id = id + 1;
  save(baseDir, st);
  return id;
}

function getEntry(baseDir, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const st = load(baseDir);
  return st.entries.find(e => e.id === n) || null;
}

function listEntries(baseDir) {
  return load(baseDir).entries.slice(); // 已按 id 升序
}

// ── 2026-10-16 工具集 v2：编辑 + 覆盖前留存上一版 ──
// 历史文件 data/papers-history.json：{ version: 1, records: [{ paper_id, saved_at, reason, title, category, tags, content, updated_at }] }
// 只追加；每篇纸最多留最近 20 个版本。网关单进程写，原子写（tmp + rename）。
const MAX_HISTORY_PER_PAPER = 20;

function historyPath(baseDir) {
  return path.join(baseDir, "data", "papers-history.json");
}

function loadHistory(baseDir) {
  try {
    const d = JSON.parse(fs.readFileSync(historyPath(baseDir), "utf8"));
    if (d && Array.isArray(d.records)) return d;
  } catch (e) {}
  return { version: 1, records: [] };
}

function appendHistory(baseDir, rec) {
  const h = loadHistory(baseDir);
  h.records.push(rec);
  const mine = h.records.filter(r => r.paper_id === rec.paper_id);
  if (mine.length > MAX_HISTORY_PER_PAPER) {
    const drop = new Set(mine.slice(0, mine.length - MAX_HISTORY_PER_PAPER));
    h.records = h.records.filter(r => !drop.has(r));
  }
  fs.mkdirSync(path.dirname(historyPath(baseDir)), { recursive: true });
  const tmp = historyPath(baseDir) + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2), "utf8");
  fs.renameSync(tmp, historyPath(baseDir));
}

// 改一张纸：先把旧版写进历史，再落新版；返回改后的条目，找不到返回 null。
function updateEntry(baseDir, id, patch, meta) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const st = load(baseDir);
  const e = st.entries.find(x => x.id === n);
  if (!e) return null;
  appendHistory(baseDir, {
    paper_id: n,
    saved_at: new Date().toISOString(),
    reason: (meta && meta.reason) || "edit",
    title: e.title || "",
    category: e.category || "",
    paper_reason: e.reason || "", // 这篇「为什么记」的旧值；上面的 reason 是本次修改类型（append/replace/meta）
    tags: Array.isArray(e.tags) ? e.tags : [],
    content: e.content || "",
    updated_at: e.updated_at || e.created_at || "",
  });
  Object.assign(e, patch);
  save(baseDir, st);
  return e;
}

function listHistory(baseDir, id) {
  const n = Number(id);
  return loadHistory(baseDir).records.filter(r => r.paper_id === n);
}

module.exports = { storePath, load, save, addEntry, getEntry, listEntries, updateEntry, listHistory, historyPath };
