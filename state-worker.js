// state-worker.js —— 会话状态机生成独立进程（2026-10-07）
//
// 背景：状态机 preview（LLM 算新状态）原挂在 gateway 进程内同步长请求上，
// gateway 重启/推送/nginx 超时就掐断生成（2026-10-07 实测两次：02:43、17:18）。
// 独立进程后 gateway 只登记任务（写 pending 日志 + 任务文件）并立即返回，
// 本进程后台调 LLM，完成后：
//   - 候选落盘：复用 conversation-state.previewMerge（内部 saveCandidate 写 CANDIDATE_FILE）
//   - 日志更新：不直接写 compaction_log（避免与 gateway 双进程覆盖），
//     回调 gateway /internal/state-log（统一 X-Internal-Key 鉴权）
// 进程生命周期独立于 gateway；本进程崩溃由 pm2 自动拉起，启动时把残留 running 任务标中断。
require("dotenv").config();
const http = require("http");
const path = require("path");
const fs = require("fs-extra");

const conversationState = require("./lib/conversation-state");
const contextReplacements = require("./context-replacements");

const PORT = Number(process.env.STATE_WORKER_PORT || 3110);
const INTERNAL_KEY = String(process.env.INTERNAL_API_KEY || "").trim();
const GATEWAY_URL = String(process.env.GATEWAY_CALLBACK_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TASK_FILE = path.join(__dirname, "data", "state_tasks.json");

// ── 日志回调（fire-and-forget）：worker 内 logEntry 的同步返回值无用
//（previewMerge 用 gateway 传入的 logId 更新原条目，不走"创建日志拿 id"路径），
// 每次日志事件异步转发给 gateway；gateway 短暂不可达时静默，不影响生成与候选落盘。
conversationState.setLogFn(function (entry) {
  try {
    httpJsonPost(GATEWAY_URL + "/internal/state-log", entry, { "X-Internal-Key": INTERNAL_KEY }, 8000)
      .catch(function () { /* 回调失败不影响生成 */ });
  } catch (e) { /* */ }
  return null;
});

// ── 任务文件（与 gateway 共享：gateway 登记 running，worker 完成后翻 done/error）──
function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASK_FILE, "utf8")); } catch (e) { return []; }
}
function writeTasks(tasks) {
  const tmp = TASK_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tasks));
  fs.renameSync(tmp, TASK_FILE); // 原子换名，双进程并发读不会读到半个文件
}
function updateTask(logId, status) {
  try {
    const tasks = readTasks();
    const t = tasks.find(function (x) { return x && x.id === logId; });
    if (t) { t.status = status; t.updatedAt = new Date().toISOString(); writeTasks(tasks); }
  } catch (e) { /* 任务文件更新失败不影响生成 */ }
}

// ── 任务执行 ──
const running = new Map(); // sessionId -> startedAt
async function runTask(task) {
  const sessionId = String(task.session || "").trim();
  try {
    // 时间线/检索按会话工作：worker 是独立进程，每次任务显式设置活跃会话
    contextReplacements.setActiveSession(sessionId);
    const r = await conversationState.previewMerge({
      session: sessionId,
      start: task.start,
      end: task.end,
      logId: task.logId, // gateway 登记任务时创建的日志 id，跨进程直接复用更新
      overwrite: task.overwrite === true, // 1011-03：只有用户确认覆盖（前端带 overwrite）才允许覆盖旧候选
    });
    updateTask(task.logId, r && r.ok ? "done" : "error");
    if (r && !r.ok) {
      // previewMerge 部分早退路径不写日志（如「区间里没有可并入的消息」在 logEntry 之前 return），
      // 补一条 error 回调，前端轮询按 logId 才能停下来。
      try {
        await httpJsonPost(GATEWAY_URL + "/internal/state-log",
          { id: task.logId, status: "error", message: String(r.error || "生成失败") },
          { "X-Internal-Key": INTERNAL_KEY }, 8000);
      } catch (_) { /* 回调失败：前端轮询会在候选缺失时一直转，用户可刷新恢复 */ }
    }
    console.log("[state-worker] " + sessionId + " 第" + task.start + "~" + task.end + "条 ok=" + !!(r && r.ok) +
      (r && r.error ? " err=" + String(r.error).slice(0, 160) : ""));
  } catch (e) {
    updateTask(task.logId, "error");
    console.error("[state-worker] " + sessionId + " 异常:", e && e.message);
    try {
      await httpJsonPost(GATEWAY_URL + "/internal/state-log",
        { id: task.logId, status: "error", message: "worker 异常：" + ((e && e.message) || String(e)) },
        { "X-Internal-Key": INTERNAL_KEY }, 8000);
    } catch (_) { /* */ }
  } finally {
    running.delete(sessionId);
  }
}

// ── 内部 HTTP：接收 gateway 任务 ──
const server = http.createServer(function (req, res) {
  if (req.method === "GET" && req.url === "/state/health") { return json(res, 200, { ok: true, pid: process.pid }); }
  if (req.method !== "POST") { return json(res, 405, { ok: false, error: "method not allowed" }); }
  // 与 gateway 同一把内部钥匙（INTERNAL_API_KEY）双向鉴权
  if (String(req.headers["x-internal-key"] || "").trim() !== INTERNAL_KEY) {
    return json(res, 401, { ok: false, error: "invalid key" });
  }
  const chunks = [];
  req.on("data", function (c) { chunks.push(c); });
  req.on("end", function () {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return json(res, 400, { ok: false, error: "bad json" }); }
    if (req.url === "/state/run") {
      const sessionId = String(body.session || "").trim();
      const start = Number(body.start);
      const end = Number(body.end);
      const logId = String(body.logId || "");
      if (!sessionId || !Number.isInteger(start) || !Number.isInteger(end) || end < start) {
        return json(res, 400, { ok: false, error: "参数不正确（session/start/end/logId）" });
      }
      if (running.has(sessionId)) {
        return json(res, 409, { ok: false, error: "该会话已有生成任务在跑" });
      }
      running.set(sessionId, Date.now());
      json(res, 200, { ok: true, accepted: true });
      runTask({ session: sessionId, start: start, end: end, logId: logId, overwrite: body.overwrite === true }).then(function () {}, function () {});
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  });
});

// ── 启动钩子：上次进程残留的 running 任务标中断（pm2 拉起本进程时执行）──
(function markRunningInterruptedOnBoot() {
  try {
    const tasks = readTasks();
    let changed = false;
    tasks.forEach(function (t) {
      if (t && t.status === "running") {
        t.status = "interrupted";
        t.updatedAt = new Date().toISOString();
        changed = true;
        httpJsonPost(GATEWAY_URL + "/internal/state-log",
          { id: t.id, status: "interrupted", message: "（生成服务重启中断，可重新生成）" },
          { "X-Internal-Key": INTERNAL_KEY }, 8000).catch(function () {});
      }
    });
    if (changed) writeTasks(tasks);
    if (tasks.length) {
      console.log("[state-worker] 启动扫描任务文件：" + tasks.length + " 条，残留 running 标中断 " +
        tasks.filter(function (t) { return t.status === "interrupted"; }).length + " 条");
    }
  } catch (e) { /* 标中断失败不影响启动 */ }
})();

server.listen(PORT, "127.0.0.1", function () {
  console.log("[state-worker] listening 127.0.0.1:" + PORT + " pid=" + process.pid +
    " key=" + (INTERNAL_KEY ? "set" : "MISSING") + " gateway=" + GATEWAY_URL);
});

// ── 小工具 ──
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function httpJsonPost(url, obj, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const payload = JSON.stringify(obj);
    const mod = u.protocol === "http:" ? http : require("https");
    const rq = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + (u.search || ""),
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, headers || {}),
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("HTTP " + res.statusCode + ": " + raw.slice(0, 300)));
        let j;
        try { j = JSON.parse(raw); } catch (e) { return reject(new Error("非 JSON 响应")); }
        resolve(j);
      });
    });
    rq.setTimeout(timeoutMs || 8000, function () { rq.destroy(new Error("请求超时")); });
    rq.on("error", function (err) { reject(new Error((err && err.message) || String(err))); });
    rq.end(payload);
  });
}
