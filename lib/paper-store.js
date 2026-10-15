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

module.exports = { storePath, load, save, addEntry, getEntry, listEntries };
