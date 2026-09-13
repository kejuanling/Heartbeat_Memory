// wake_schedule.json 的跨进程读写模块（gateway 与 wake-up 双进程共用）。
// 批注 2026-09-13（审查 D3）：此前 gateway（server.js）与 wake-up（wake_up.js）各自
// 「读全文件 → 改一个槽位 → 整文件覆盖写回」且共用固定 .tmp 名，双进程同时写时后写者
// 基于旧快照覆盖，会互吞对方的闹钟槽位。本模块把所有写操作收口到同一份代码：
// 跨进程文件锁（借鉴 memory-engine withPinnedLock）+ 锁内重读合并 + 带	pid 原子写 +
// 「解析失败拒绝写回」（防止坏文件被 {} 覆盖掉其它会话的槽位）。
const fs = require("fs");
const path = require("path");

const SCHEDULE_PATH = path.join(__dirname, "..", "data", "wake_schedule.json");
const LOCK_PATH = SCHEDULE_PATH + ".lock";

function withLock(fn, timeoutMs) {
  if (timeoutMs === undefined) timeoutMs = 2000;
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) {
        // 陈旧锁强拆：持锁段均为毫秒级同步操作，超时基本等于持锁进程崩溃残留
        try { fs.unlinkSync(LOCK_PATH); } catch (e2) {}
        continue;
      }
      // 主线程同步等待（Atomics.wait 不烧 CPU）；持锁段极短，实际几乎不会发生竞争
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 10);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
  }
}

// 读原始对象；文件不存在返回 null。解析失败抛错（写路径捕获后拒绝写回，读路径自行兜底）。
function readRawOrThrow() {
  if (!fs.existsSync(SCHEDULE_PATH)) return null;
  const data = JSON.parse(fs.readFileSync(SCHEDULE_PATH, "utf-8"));
  return (data && typeof data === "object") ? data : null;
}

// 宽松读：任何失败返回 null（供只读路径使用，与原 readWakeScheduleRaw 行为一致）
function readRaw() {
  try { return readRawOrThrow(); } catch (e) { return null; }
}

// 原子写（锁外调用方需已持锁；tmp 带 pid 防双进程互相截断）
function writeRawLocked(data) {
  fs.mkdirSync(path.dirname(SCHEDULE_PATH), { recursive: true });
  const tmp = SCHEDULE_PATH + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, SCHEDULE_PATH);
}

// 设定某会话槽位。文件损坏（解析失败）时拒绝写回并返回 false，防止 {} 覆盖掉其它会话槽位。
function saveSlot(nextWakeAtIso, sessionId) {
  const sid = String(sessionId || "default").trim() || "default";
  return withLock(function () {
    let data;
    try {
      data = readRawOrThrow();
    } catch (e) {
      console.error("[wake-schedule] 文件解析失败，拒绝写回（防覆盖其它会话槽位）:", e.message);
      return false;
    }
    if (!data || typeof data !== "object") data = {};
    const sessions = (data.sessions && typeof data.sessions === "object") ? data.sessions : {};
    sessions[sid] = { next_wake_at: nextWakeAtIso, updated_at: new Date().toISOString() };
    data.version = 2;
    data.sessions = sessions;
    writeRawLocked(data);
    return true;
  });
}

// 清空某会话槽位；sessionId 为空则清空全部。返回是否有改动；损坏时拒绝写返回 false。
function clearSlot(sessionId) {
  return withLock(function () {
    let data;
    try {
      data = readRawOrThrow();
    } catch (e) {
      console.error("[wake-schedule] 文件解析失败，拒绝写回:", e.message);
      return false;
    }
    if (sessionId === undefined || sessionId === null || String(sessionId).trim() === "") {
      if (!fs.existsSync(SCHEDULE_PATH)) return false;
      writeRawLocked({ version: 2, sessions: {} });
      return true;
    }
    const sid = String(sessionId).trim() || "default";
    if (!data) return false;
    if (data.sessions && data.sessions[sid]) {
      delete data.sessions[sid];
      writeRawLocked(data);
      return true;
    }
    if (!data.sessions && sid === "default" && data.next_wake_at) {
      writeRawLocked({ version: 2, sessions: {} });
      return true;
    }
    return false;
  });
}

// 删除所有已过期（<= now + graceMs）或无效的槽位，返回是否有改动。损坏时拒绝写回。
function pruneExpired(graceMs) {
  const grace = (graceMs === undefined) ? 2000 : graceMs;
  return withLock(function () {
    let data;
    try {
      data = readRawOrThrow();
    } catch (e) {
      console.error("[wake-schedule] 文件解析失败，拒绝清理写回:", e.message);
      return false;
    }
    if (!data || !data.sessions) return false;
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(data.sessions)) {
      const e = data.sessions[sid];
      const t = e && e.next_wake_at ? new Date(e.next_wake_at) : null;
      if (!e || !e.next_wake_at || isNaN(t.getTime()) || t.getTime() <= now + grace) {
        delete data.sessions[sid];
        changed = true;
      }
    }
    if (changed) writeRawLocked(data);
    return changed;
  });
}

module.exports = { withLock, readRaw, readRawOrThrow, saveSlot, clearSlot, pruneExpired, SCHEDULE_PATH };
