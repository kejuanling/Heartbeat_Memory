'use strict';
// 会话上下文快照 v2（1007 用户拍板）：
// 前缀缓存——把「人设 + V2 注入块 + 工具定义 + 历史消息（含状态块/摘要块/记忆浮现/特殊事件/工具记录）」
// 从会话第一条消息起固化成快照落盘。请求 = 快照前缀 + 动态尾部（tail_start 之后最新消息 + 相关记忆 + 容量提醒）。
// 快照内容全部冻死，只有三类事件触发自动重建：状态机摘要更新 / 历史摘要更新 / 前端编辑消息。
// 其他一律不重建（新消息落盘并入尾部、工具定义/人设/V2 块变化继续用旧的），等手动重建。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- 路径 ----
function snapDir(baseDir) {
  return path.join(baseDir, "data", "session_ctx_snapshots_v2");
}
// ctx-v2 注入快照文件（人设 + fixed_blocks 冻死块源）
function injFile(baseDir) {
  return path.join(baseDir, "data", "session_inject_snapshots.json");
}
function snapFile(baseDir, sessionId) {
  const sid = String(sessionId || "default").trim() || "default";
  // 会话 id 可能含特殊字符，做安全化（防路径穿越）
  const safe = sid.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(snapDir(baseDir), safe + ".json");
}

// ---- 指纹 ----
function fpOf(messages) {
  try {
    const parts = (Array.isArray(messages) ? messages : []).map(function (m) {
      return String(m && m.role || "") + "\u0000" + JSON.stringify(m && m.content);
    });
    return crypto.createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 16);
  } catch (e) { return ""; }
}
function toolsFpOf(tools) {
  try {
    const s = JSON.stringify(tools || []);
    return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  } catch (e) { return ""; }
}

// ---- 读写 ----
function loadSnapshot(baseDir, sessionId) {
  try {
    const f = snapFile(baseDir, sessionId);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    // 1007-17 第三步：新快照存 entries（id 列表），旧快照存 history（完整消息副本）。
    // 1008 方案A（第四步）：v3 快照存 content（冻结消息副本）+ snap_point（尾部起点下标）。
    // 三种都能读进来，由调用方按结构判定走新逻辑还是标失效重建，
    // 这样工具侧（只读 snap.tools）不受结构切换影响。
    if (j && typeof j === "object" && (Array.isArray(j.entries) || Array.isArray(j.history) || Array.isArray(j.content))) return j;
    return null;
  } catch (e) { return null; }
}
function saveSnapshot(baseDir, sessionId, data) {
  const sid = String(sessionId || "default").trim() || "default";
  const dir = snapDir(baseDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const f = snapFile(baseDir, sessionId);
  const tmp = f + ".tmp-" + process.pid;
  const payload = Object.assign({}, data, {
    sessionId: sid,
    updated_at: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
}
function deleteSnapshot(baseDir, sessionId) {
  try { fs.unlinkSync(snapFile(baseDir, sessionId)); return true; } catch (e) { return false; }
}

// 2026-10-08 方案A：截断快照（编辑/删除/重生成落在 content 区且其后无 rep 块时调用）。
// keepIds = 截断点之前（时间线下标 < newSnapPoint）的消息 id 集合；
// rep 块（_ctxRep）整体保留——调用方已保证截断点落在所有可见压缩块区间之后。
// 截断后 snap_point = newSnapPoint，截断点之后的消息下次读取时从时间线尾部现取（前缀 token 保留）。
function truncateSnapshot(baseDir, sessionId, keepIds, newSnapPoint) {
  try {
    const snap = loadSnapshot(baseDir, sessionId);
    if (!snap || !Array.isArray(snap.content) || !Number.isFinite(newSnapPoint)) return false;
    const keep = new Set(Array.isArray(keepIds) ? keepIds.map(function (x) { return String(x); }) : []);
    const next = [];
    for (const it of snap.content) {
      if (!it) continue;
      if (it._ctxRep) { next.push(it); continue; }
      if (it.id && keep.has(String(it.id))) next.push(it);
    }
    snap.content = next;
    snap.snap_point = Number(newSnapPoint);
    return saveSnapshot(baseDir, sessionId, snap);
  } catch (e) { return false; }
}

// 会话快照存在性（重建/失效标记用）
function hasSnapshot(baseDir, sessionId) {
  try { return fs.existsSync(snapFile(baseDir, sessionId)); } catch (e) { return false; }
}

// ---- 失效标记（三类重建触发：状态摘要更新/编辑消息/手动）----
// 用一个轻量标记文件记录"该会话快照已失效，下次请求重建"。
// 重建后自动清除标记。避免每次请求都全量比对。
function staleMarkFile(baseDir, sessionId) {
  return path.join(snapDir(baseDir), ".stale-" + String(sessionId || "default").replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
}
function markStale(baseDir, sessionId, reason) {
  try {
    const f = staleMarkFile(baseDir, sessionId);
    fs.mkdirSync(snapDir(baseDir), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ reason: reason || "unknown", at: new Date().toISOString() }, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}
function isStale(baseDir, sessionId) {
  try { return fs.existsSync(staleMarkFile(baseDir, sessionId)); } catch (e) { return false; }
}
function clearStale(baseDir, sessionId) {
  try { fs.unlinkSync(staleMarkFile(baseDir, sessionId)); return true; } catch (e) { return false; }
}

module.exports = {
  loadSnapshot, saveSnapshot, deleteSnapshot, hasSnapshot,
  truncateSnapshot,
  markStale, isStale, clearStale,
  fpOf, toolsFpOf, snapFile, injFile,
};
