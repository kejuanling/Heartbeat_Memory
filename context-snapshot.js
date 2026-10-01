'use strict';

// 会话系统注入前缀快照（1002-11，方案 B）：
// 人设（system_prompt）+ 跨窗口注入固定块（fixed_blocks）在会话首次请求时固化，
// 之后该会话永远复用（改全局人设/记忆池/日记/跨窗口配置均不影响已有会话）。
// relevant_memories（相关记忆）是动态块，不进快照，每轮现算。
// 快照文件损坏/缺失时调用方回退原流程（fail-safe）。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function snapshotFile(baseDir) {
  return path.join(baseDir, "data", "session_inject_snapshots.json");
}

function loadAll(baseDir) {
  try {
    const j = JSON.parse(fs.readFileSync(snapshotFile(baseDir), "utf8"));
    if (j && typeof j === "object") {
      if (j.sessions && typeof j.sessions === "object") return j.sessions;
      return j; // 兼容初版直接顶层 {sid:{...}} 的结构
    }
    return {};
  } catch (e) {
    return {};
  }
}

function loadSnapshot(baseDir, sessionId) {
  const sid = String(sessionId || "default").trim() || "default";
  const s = loadAll(baseDir)[sid];
  return s && typeof s === "object" ? s : null;
}

// 原子写（tmp + rename），防并发读半截
function saveSnapshot(baseDir, sessionId, data) {
  const sid = String(sessionId || "default").trim() || "default";
  const all = loadAll(baseDir);
  all[sid] = data;
  const f = snapshotFile(baseDir);
  const tmp = f + ".tmp-" + process.pid;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 统一存 { sessions: { sid: {...} } } 结构；loadAll 兼容读取初版顶层结构
    fs.writeFileSync(tmp, JSON.stringify({ sessions: all }, null, 2), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    throw e;
  }
  return true;
}

// 快照指纹：人设 + 固定块内容 sha1，供日志/缓存 key 使用
function snapshotFp(s) {
  if (!s) return "";
  try {
    const parts = [String(s.system_prompt || "")];
    if (Array.isArray(s.fixed_blocks)) {
      for (const b of s.fixed_blocks) parts.push(String(b && b.content || ""));
    }
    return crypto.createHash("sha1").update(parts.join("\n---\n")).digest("hex").slice(0, 16);
  } catch (e) {
    return String((s.system_prompt || "").length);
  }
}

module.exports = { loadSnapshot, saveSnapshot, snapshotFp };
