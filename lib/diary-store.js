'use strict';
// ============================================================
// 日记 JSON 存储（2026-10-03）：日记从「一个日记一个文件」迁移为单 JSON 存储。
// 文件：data/diary.json
// schema：
//   {
//     "version": 1,
//     "next_id": 103,                 // 下一篇 id（单调递增，删除不回收）
//     "entries": [
//       { "id": 1,
//         "session": null | "s_xxx",  // 所属会话（共享层 = null）
//         "hidden": false,            // 是否隐藏（隐藏不注入、工具检索不到）
//         "pin": false,               // 是否置顶（1010：置顶日记跨窗口注入固定排最前、占份数）
//         "created_at": "2026-07-21T…Z",  // 创建时间（UTC ISO）
//         "content": "## YYYY-MM-DD HH:MM\n\n正文……" }  // 正文原样（含 ## 本地时间头）
//     ]
//   }
// 所有日记读写（网关、lib/diary、xie-diary 接口、跨窗口注入、MCP 工具经内部接口）
// 只通过本模块，保证单一数据源。
// ============================================================

const fs = require("fs");
const path = require("path");

function storePath(baseDir) {
  return path.join(baseDir, "data", "diary.json");
}

function loadStore(baseDir) {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(baseDir), "utf8"));
    if (j && Array.isArray(j.entries)) {
      if (typeof j.next_id !== "number") {
        j.next_id = j.entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
      }
      return j;
    }
  } catch (e) { /* 文件缺失/损坏 → 空库 */ }
  return { version: 1, next_id: 1, entries: [] };
}

// 原子写：写临时文件 → rename（同目录 rename 原子，读方永远看到完整内容）
function saveStore(baseDir, store) {
  const p = storePath(baseDir);
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return store;
}

// 追加一篇：id = next_id 自增；返回新条目
function addEntry(baseDir, entry) {
  const store = loadStore(baseDir);
  const id = store.next_id || (store.entries.length + 1);
  const e = {
    id: id,
    session: entry.session || null,
    hidden: entry.hidden === true,
    pin: entry.pin === true,
    created_at: entry.created_at || new Date().toISOString(),
    content: String(entry.content == null ? "" : entry.content),
  };
  store.entries.push(e);
  store.next_id = id + 1;
  saveStore(baseDir, store);
  return e;
}

function getEntry(baseDir, id) {
  const store = loadStore(baseDir);
  return store.entries.find((e) => String(e.id) === String(id)) || null;
}

// 局部更新：patch.content / patch.hidden / patch.pin；返回更新后条目（不存在返回 null）
function updateEntry(baseDir, id, patch) {
  const store = loadStore(baseDir);
  const e = store.entries.find((x) => String(x.id) === String(id));
  if (!e) return null;
  if (patch.content !== undefined) e.content = String(patch.content == null ? "" : patch.content);
  if (patch.hidden !== undefined) e.hidden = patch.hidden === true;
  if (patch.pin !== undefined) e.pin = patch.pin === true;
  saveStore(baseDir, store);
  return e;
}

// 全部条目，按 id 升序（= 创建顺序）
function listEntries(baseDir) {
  return loadStore(baseDir).entries.slice().sort((a, b) => Number(a.id) - Number(b.id));
}

module.exports = {
  storePath,
  loadStore,
  saveStore,
  addEntry,
  getEntry,
  updateEntry,
  listEntries,
};
