'use strict';
// 唤醒调度器（2026-09-15 批3收尾：wake-up 独立进程退役，调度并入 gateway）。
// 调度内核（沉默判定/定时闹钟/重启补触发/互斥）从 wake_up.js 原样搬入；
// 与独立进程期的差异：
//   - 上下文/模型调用改进程内直调 routes/wake-chat.js 的 runWakeCompletion（不再 HTTP 自环）；
//   - 唤醒产出落库直调 server.js 注入的 applyWakeEventV2（wake-event v2 同一实现）；
//   - 心跳直接更新 gateway 的 wakeUpLastHeartbeat（管理台在线状态同源）；
//   - 配置读 gateway 的 readEnvValue（cachedEnv，管理台保存即刷新，无需独立热重载）。
// 鉴权：本模块只在进程内被 server.js 启动，不暴露任何 HTTP 面。

const fs = require("fs");
const path = require("path");
const { formatDateTimeInTimeZone, getDatePartsInTimeZone, getHourInTimeZone, parseWakeTarget, zonedWallTimeToDate } = require("../time_utils");
const tagParser = require("../tag-parser");
const wakeSchedule = require("./wake-schedule");

// 到点判定的统一宽限窗：setTimeout 的毫秒延时会被向零截断，定时器可能比闹钟时刻早 <=1ms 触发，
// 若「捕获」与「过期清理」严格用 next_wake_at <= now 判定，提前触发会两手空空、随后槽位被当过期删掉，闹钟静默蒸发
const WAKE_DUE_GRACE_MS = 2000;

// 兜底版 content → 纯文本：多模态分片转 [图片]/[文件] 占位；
// 正常链路用 server.js 注入的 normalizeContentToText，仅在未注入时落到本实现
function normalizeContentToTextLocal(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "[非文本内容]";
}

module.exports = function createWakeScheduler(deps) {
  const {
    baseDir,
    readEnvValue,
    normalizeContentToText,
    touchHeartbeat,
    sendPushNotification,
    applyWakeEventV2,
    runWakeCompletion,
    wakeDeps
  } = deps;
  const toText = normalizeContentToText || normalizeContentToTextLocal;
  const TIME_ZONE = require("../time_utils").resolveTimeZone();

  // 日记共享模块（2026-09-16）：日常聊天与唤醒共用，[DIARY] 提取/日记写入同一口径
  const diaryLib = require("./diary")({ baseDir, readEnvValue });
  const WAKE_SCHEDULE_PATH = path.join(baseDir, "data", "wake_schedule.json");
  const WAKE_LOCKED_PATH = path.join(baseDir, "data", "wake-locked.json");
  const SESSION_NAMES_PATH = path.join(baseDir, "data", "session-names.json");
  const TIMELINE_PATH = path.join(baseDir, "enhanced_messages.json");
  let timedWakeTimer = null;
  let wakeRunning = false;

  // ---- 配置（gateway cachedEnv 口径，默认值与 wake_up.js 期一致）----
  function readNumberEnv(key, fallback, options = {}) {
    const value = Number(readEnvValue(key));
    const min = options.min ?? -Infinity;
    const max = options.max ?? Infinity;
    if (Number.isFinite(value) && value >= min && value <= max) return value;
    return fallback;
  }
  function readBooleanEnv(key, fallback = false) {
    const raw = String(readEnvValue(key) ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    return ["1", "true", "yes", "on"].includes(raw);
  }
  // 是否处于「白天」时段（WAKE_DAY_START_HOUR~WAKE_DAY_END_HOUR，支持跨午夜区间），
  // 决定沉默阈值与检查间隔取日间还是夜间配置
  function isDayTime(date = new Date()) {
    const hour = getHourInTimeZone(date, TIME_ZONE);
    const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
    const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }
  function getWakeAfterMinutes(date = new Date()) {
    return isDayTime(date)
      ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
      : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 180, { min: 1 });
  }
  function getCheckIntervalMinutes(date = new Date()) {
    return isDayTime(date)
      ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 60, { min: 1 })
      : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 180, { min: 1 });
  }
  function getCheckIntervalMs() {
    return getCheckIntervalMinutes(new Date()) * 60 * 1000;
  }

  // ---- 日记（实现已抽至 lib/diary.js 共享模块，2026-09-16）----
  function stripInternalTags(text) {
    return tagParser.stripTags(text).replace(/^\s+|\s+$/g, "");
  }

  // ---- 上下文注入（天气 / 手机状态）----
  async function fetchWeatherContext() {
    if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";
    const lat = Number(readEnvValue("WEATHER_LAT"));
    const lon = Number(readEnvValue("WEATHER_LON"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
      return "";
    }
    const table = { 0: "晴朗", 1: "大致晴朗", 2: "局部多云", 3: "阴天", 45: "有雾", 48: "雾凇", 51: "小毛毛雨", 53: "中等毛毛雨", 55: "较强毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "较强阵雨", 82: "强阵雨", 95: "雷暴", 96: "雷暴伴小冰雹", 99: "雷暴伴大冰雹" };
    const location = readEnvValue("WEATHER_LOCATION_NAME") || "当前位置";
    const units = (readEnvValue("WEATHER_UNITS") || "metric").trim().toLowerCase();
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
    url.searchParams.set("daily", "sunrise,sunset");
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "1");
    url.searchParams.set("temperature_unit", units === "fahrenheit" ? "fahrenheit" : "celsius");
    url.searchParams.set("wind_speed_unit", units === "fahrenheit" ? "mph" : "kmh");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const current = data.current || {};
      const daily = data.daily || {};
      const u = data.current_units || {};
      const codeText = table[current.weather_code] || `天气代码 ${current.weather_code}`;
      const lines = [
        "## 天气信息",
        `- 位置：${location}`,
        `- 当前：${codeText}，${current.temperature_2m}${u.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${u.apparent_temperature || "°C"}`,
        `- 湿度：${current.relative_humidity_2m}${u.relative_humidity_2m || "%"}`,
        `- 降雨：${current.precipitation}${u.precipitation || "mm"}`,
        `- 风速：${current.wind_speed_10m}${u.wind_speed_10m || ""}`
      ];
      if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
        lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
      }
      return lines.join("\n");
    } catch (err) {
      console.log("天气注入失败，跳过本次天气信息:", err.message);
      return "";
    } finally {
      clearTimeout(timeout);
    }
  }
  async function fetchPhoneStateContext() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      let response;
      try {
        response = await fetch("http://127.0.0.1:8080/state/latest?user_id=han", {
          signal: controller.signal,
          headers: { Authorization: "Bearer " + (readEnvValue("PHONE_STATE_TOKEN") || "") }
        });
      } finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const st = data && data.state;
      if (!st) return "";
      const lines = ["## 手机状态（han 本人手机，最近一次上报）"];
      if (st.battery != null && st.battery !== "") lines.push(`- 电量：${st.battery}%（数值为百分数，范围 0-100）`);
      if (st.current_app) lines.push(`- 正在用：${st.current_app}`);
      if (st.location) lines.push(`- 位置：${st.location}`);
      if (st.captured_at) lines.push(`- 上报时间：${st.captured_at}`);
      return lines.join("\n");
    } catch (err) {
      console.log("手机状态注入失败，跳过本次:", err.message);
      return "";
    }
  }

  // ---- 多会话扫描 ----
  function loadAllSessionTimelines() {
    const results = [];
    function readTimelineFile(file, sessionId) {
      try {
        if (!fs.existsSync(file)) return null;
        const arr = JSON.parse(fs.readFileSync(file, "utf-8"));
        return Array.isArray(arr) ? { sessionId, file, messages: arr } : null;
      } catch (e) {
        console.warn("[wake-scheduler] 读取会话语失败:", file, e.message);
        return null;
      }
    }
    const main = readTimelineFile(TIMELINE_PATH, "default");
    if (main) results.push(main);
    try {
      const files = fs.readdirSync(baseDir).filter(f => /^enhanced_messages_[A-Za-z0-9_-]+\.json$/.test(f));
      for (const f of files) {
        const sid = f.replace(/^enhanced_messages_/, "").replace(/\.json$/, "");
        if (!sid || sid === "default") continue;
        const t = readTimelineFile(path.join(baseDir, f), sid);
        if (t) results.push(t);
      }
    } catch (e) {
      console.warn("[wake-scheduler] 枚举会话语失败:", e.message);
    }
    return results;
  }
  function getTimelineBySessionId(sessionId) {
    return loadAllSessionTimelines().find(tl => tl.sessionId === sessionId) || null;
  }
  function readWakeLockedSessions() {
    try {
      if (!fs.existsSync(WAKE_LOCKED_PATH)) return [];
      const v = JSON.parse(fs.readFileSync(WAKE_LOCKED_PATH, "utf-8"));
      return Array.isArray(v) ? v.filter(s => typeof s === "string" && s) : [];
    } catch (e) {
      console.warn("[wake-scheduler] 读取锁定唤醒会话失败:", e.message);
      return [];
    }
  }
  function collectWakeTargets() {
    const locked = readWakeLockedSessions();
    if (!locked.length) return [];
    const targets = [];
    for (const sid of locked) {
      const tl = getTimelineBySessionId(sid);
      if (tl && Array.isArray(tl.messages) && tl.messages.length) {
        targets.push({ sessionId: sid, messages: tl.messages });
      } else {
        console.warn("[wake-scheduler] 锁定会话不存在/已删，跳过: " + sid);
      }
    }
    return targets;
  }

  // ---- 时间解析（沉默判定）----
  // 消息正文时间戳解析（三级降级）：<current_time> 标签 → 行首「YYYY-MM-DD HH:mm」→ 行尾日期串；
  // 按本机时区折算成 Date，解析不出返回 null
  function parseTimelineTimestamp(value) {
    const text = String(value || "");
    const tagMatch = text.match(/<\s*current_time\s*>\s*(?:[A-Za-z]{2,4}\s+)?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})(?::(\d{2}))?/);
    if (tagMatch) {
      const [, yy, month, day, hour, minute] = tagMatch;
      return zonedWallTimeToDate({ year: 2000 + Number(yy), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) }, TIME_ZONE);
    }
    const match = text.match(/^（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
    if (match) {
      const [, yyyy, , month, day, hour, minute] = match;
      return zonedWallTimeToDate({ year: Number(yyyy), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) }, TIME_ZONE);
    }
    const tail = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
    if (tail) {
      const p = tail[1].match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
      if (p) return zonedWallTimeToDate({ year: Number(p[1]), month: Number(p[2]), day: Number(p[3]), hour: Number(p[4]), minute: Number(p[5]) }, TIME_ZONE);
    }
    return null;
  }
  // 从会话尾部倒查最近一条用户消息的时间：优先 msg.time 字段，缺失再从正文解析
  function getLastUserTime(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;
      if (msg.time) {
        const d = new Date(msg.time);
        if (!isNaN(d.getTime())) return d;
      }
      const parsed = parseTimelineTimestamp(toText(msg.content));
      if (parsed) return parsed;
    }
    return null;
  }
  // 沉默判定：距用户最后一条消息是否已超过当前时段的唤醒阈值
  function shouldWake(lastUserTime) {
    const now = new Date();
    const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
    return diffMinutes >= getWakeAfterMinutes(now);
  }

  // ---- 调度文件（只读路径；写路径收口 lib/wake-schedule.js）----
  function readWakeScheduleRaw() {
    try {
      if (!fs.existsSync(WAKE_SCHEDULE_PATH)) return null;
      const data = JSON.parse(fs.readFileSync(WAKE_SCHEDULE_PATH, "utf-8"));
      return (data && typeof data === "object") ? data : null;
    } catch (err) {
      console.warn("[wake-scheduler] 读取定时唤醒失败:", err.message);
      return null;
    }
  }
  function readWakeScheduleFor(sessionId) {
    const sid = String(sessionId || "default").trim() || "default";
    const raw = readWakeScheduleRaw();
    if (!raw) return null;
    if (!raw.sessions) {
      if (sid !== "default") return null;
      return (raw.next_wake_at ? { next_wake_at: raw.next_wake_at, updated_at: raw.updated_at, session: "default" } : null);
    }
    const entry = raw.sessions[sid];
    return (entry && entry.next_wake_at) ? { ...entry, session: sid } : null;
  }
  function nextWakeFromAnySession() {
    const raw = readWakeScheduleRaw();
    if (!raw) return null;
    let best = null;
    for (const sid of Object.keys(raw.sessions || {})) {
      const e = raw.sessions[sid];
      if (!e || !e.next_wake_at) continue;
      const t = new Date(e.next_wake_at);
      if (isNaN(t.getTime())) continue;
      if (!best || t.getTime() < best.getTime()) best = t;
    }
    return best;
  }
  function getDueWakeSessionIds() {
    const raw = readWakeScheduleRaw();
    if (!raw) return [];
    const now = Date.now();
    const out = [];
    for (const sid of Object.keys(raw.sessions || {})) {
      const e = raw.sessions[sid];
      const t = e && e.next_wake_at ? new Date(e.next_wake_at) : null;
      if (t && !isNaN(t.getTime()) && t.getTime() <= now + WAKE_DUE_GRACE_MS) out.push(sid);
    }
    return out;
  }
  function pruneExpiredSchedules() {
    return wakeSchedule.pruneExpired(WAKE_DUE_GRACE_MS);
  }
  function isUserActiveSinceFor(entry, sessionId) {
    if (!entry || !entry.updated_at) return false;
    const setTime = new Date(entry.updated_at);
    if (isNaN(setTime.getTime())) return false;
    const sid = String(sessionId || "default").trim() || "default";
    const tl = getTimelineBySessionId(sid);
    if (!tl) return false;
    const lastUserTime = getLastUserTime(tl.messages);
    return !!(lastUserTime && lastUserTime.getTime() > setTime.getTime());
  }
  function getSessionDisplayName(sessionId) {
    const sid = String(sessionId || "default").trim() || "default";
    try {
      if (fs.existsSync(SESSION_NAMES_PATH)) {
        const names = JSON.parse(fs.readFileSync(SESSION_NAMES_PATH, "utf-8"));
        const n = names && names[sid];
        if (typeof n === "string" && n.trim()) return n.trim();
      }
    } catch (e) {}
    return "";
  }

  // ---- 唤醒提示词 ----
  function buildWakePrompt(currentTime, diffMinutes, weatherContext = "", phoneContext = "") {
    const promptFile = path.join(baseDir, "wake_prompt.txt");
    if (fs.existsSync(promptFile)) {
      let out = fs.readFileSync(promptFile, "utf-8");
      out = out
        .replace(/\$\{currentTime\}/g, currentTime)
        .replace(/\$\{diffMinutes\}/g, diffMinutes)
        .replace(/\$\{weatherContext\}/g, weatherContext)
        .replace(/\$\{weather\}/g, weatherContext)
        .replace(/\$\{天气信息（可选）\}/g, weatherContext)
        .replace(/\$\{phoneContext\}/g, phoneContext)
        .replace(/\$\{手机状态（可选）\}/g, phoneContext);
      return out;
    }
    const fromEnv = readEnvValue("WAKE_PROMPT_TEMPLATE");
    if (fromEnv) {
      return String(fromEnv)
        .replace(/\\n/g, "\n")
        .replace(/\$\{currentTime\}/g, currentTime)
        .replace(/\$\{diffMinutes\}/g, diffMinutes)
        .replace(/\$\{weatherContext\}/g, weatherContext)
        .replace(/\$\{weather\}/g, weatherContext)
        .replace(/\$\{phoneContext\}/g, phoneContext);
    }
    return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}
${phoneContext ? `\n${phoneContext}\n` : ""}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
- 写前先用 diary_list 工具读本会话今天已写的日记：今天已经写过的话题不要重复写，可以接着写新段落，或写完全不同的新主题。
- 你可以设置下一次系统主动唤醒你的时间，格式为 <wake>数值</wake>，单位为分钟。设置后这段时间内系统不会再唤醒你，时间一到会主动唤醒你一次；如果到点前她主动找过你，这个定时会自动作废。不想设置就不输出这个标签。
`;
  }

  // ---- 定时器 ----
  function armTimedWake() {
    if (timedWakeTimer) {
      clearTimeout(timedWakeTimer);
      timedWakeTimer = null;
    }
    let nextWakeAt = null;
    try { nextWakeAt = nextWakeFromAnySession(); } catch (err) { /* 读取失败按无定时处理 */ }
    if (!nextWakeAt) return;
    const delayMs = nextWakeAt.getTime() - Date.now();
    if (delayMs <= 0) {
      // 已过期（例如进程重启错过了到点时刻）：先捕获到点的显式 <wake> 闹钟并补触发一次唤醒，
      // 再清理过期调度——否则显式提醒会被静默丢弃，用户设的闹钟到点毫无反应。
      let due = [];
      try { due = getDueWakeSessionIds(); } catch (e) { /* 忽略 */ }
      try { pruneExpiredSchedules(); } catch (err) { /* 忽略 */ }
      if (timedWakeTimer) { clearTimeout(timedWakeTimer); timedWakeTimer = null; }
      if (due.length) {
        console.log(`[wake-scheduler] 检测到已到点的闹钟（进程重启错过），补触发唤醒：${due.join(", ")}`);
        setTimeout(() => { runWakeUp(due); }, 0);
      }
      return;
    }
    // Math.ceil：setTimeout 会把小数毫秒向零截断，不取整会让定时器比闹钟时刻早触发 <=1ms
    timedWakeTimer = setTimeout(runTimedWake, Math.max(1, Math.ceil(delayMs)));
    console.log(`[wake-scheduler] 已设定定时唤醒：${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}（${Math.round(delayMs / 60000)} 分钟后）`);
  }
  async function runTimedWake() {
    timedWakeTimer = null;
    const dueSids = getDueWakeSessionIds();
    console.log("\n===== 定时唤醒到点 =====\n");
    const executed = await runWakeUp(dueSids);
    // 仅当本次唤醒真的执行过（未被互斥跳过）才清理：跳过时槽位留在盘上，
    // 末尾 armTimedWake 的过期分支会补触发；否则槽位被删、闹钟静默丢失
    if (executed) {
      try { pruneExpiredSchedules(); } catch (e) { console.warn("[wake-scheduler] 清理过期定时失败:", e.message); }
    }
    try { armTimedWake(); } catch (e) { /* 重挂失败由轮询兜底 */ }
  }

  // ---- 唤醒主流程（互斥）----
  async function runWakeUp(dueSids) {
    if (wakeRunning) {
      console.log("[wake-scheduler] 上一次唤醒仍在进行，本次跳过");
      return false;
    }
    wakeRunning = true;
    try {
      await runWakeUpInner(dueSids);
      return true;
    } catch (err) {
      // 统一记日志吃掉：定时入口由 setTimeout 触发无人兜底，异常会成为 unhandled rejection
      const detail = (err && err.stack) ? err.stack : String(err) + "\n[非 Error 抛出物，以下是捕获点调用栈]\n" + new Error("trace").stack;
      console.error("[wake-scheduler] 唤醒执行失败:", detail);
      return true;
    } finally {
      wakeRunning = false;
    }
  }
  async function runWakeUpInner(dueSids) {
    console.log("\n==========================");
    console.log("开始自动唤醒");
    console.log("==========================\n");
    const targets = collectWakeTargets();
    // 显式 <wake> 闹钟不受「锁定唤醒」影响：只要到现在点就必须被处理（未锁定的会话也并入）
    const dueSet = new Set();
    if (Array.isArray(dueSids)) { for (const sid of dueSids) dueSet.add(sid); }
    for (const sid of getDueWakeSessionIds()) dueSet.add(sid);
    if (dueSet.size) {
      const sessionByTarget = new Map();
      for (const t of targets) sessionByTarget.set(t.sessionId || "default", t);
      for (const sid of dueSet) {
        const known = sessionByTarget.get(sid);
        if (known) { known.explicitWake = true; continue; }
        const tl = getTimelineBySessionId(sid);
        if (tl && Array.isArray(tl.messages) && tl.messages.length) {
          targets.push({ sessionId: sid, messages: tl.messages, explicitWake: true });
        } else {
          console.warn("[wake-scheduler] 显式闹钟会话不存在/已删，跳过: " + sid);
        }
      }
    }
    if (!targets.length) { console.log("[wake-scheduler] 无唤醒目标（未锁定/锁定的会话已删），本次跳过"); return; }
    // 多锁定会话同时到点：逐个处理并错峰（每会话推送间隔收敛，避免连发多条）
    const sleepMs = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < targets.length; i++) {
      await runWakeForTarget(targets[i]);
      if (i < targets.length - 1) await sleepMs(1500);
    }
  }
  async function runWakeForTarget(target) {
    const messages = target.messages;
    const wakeSessionId = target.sessionId || "default";
    console.log("[wake-scheduler] 唤醒处理会话: " + wakeSessionId + "（共 " + messages.length + " 条）");

    const lastMessageTime = getLastUserTime(messages);
    if (!lastMessageTime) {
      console.log("[wake-scheduler] 未找到用户消息时间");
      return;
    }
    const now = new Date();
    const diffMinutes = Math.floor((now - lastMessageTime) / 1000 / 60);

    let explicitWake = !!target.explicitWake;
    try {
      const schedule = readWakeScheduleFor(wakeSessionId);
      if (schedule) {
        if (isUserActiveSinceFor(schedule, wakeSessionId)) {
          // 设定之后用户在该会话主动找过 AI → 定时作废，本次按正常节奏判断
          explicitWake = false;
          try { wakeSchedule.clearSlot(wakeSessionId); } catch (e) { console.warn("[wake-scheduler] 清理作废定时失败:", e.message); }
        } else {
          const nextWakeAt = new Date(schedule.next_wake_at);
          // 同一口径带宽限窗：定时器提前 <=1ms 触发时，槽位在毫秒级仍"未到点"
          if (!isNaN(nextWakeAt.getTime()) && nextWakeAt.getTime() > Date.now() + WAKE_DUE_GRACE_MS) {
            console.log(`[wake-scheduler] 会话 ${wakeSessionId} 的下一次主动唤醒时间未到（${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}），跳过该会话唤醒`);
            return;
          }
          explicitWake = true;
          try { wakeSchedule.clearSlot(wakeSessionId); } catch (e) { console.warn("[wake-scheduler] 清理过期定时唤醒失败:", e.message); }
        }
      }
    } catch (scheduleErr) {
      console.warn("[wake-scheduler] 检查会话级下次唤醒时间失败（忽略）:", scheduleErr.message);
    }

    if (!explicitWake && !shouldWake(lastMessageTime)) {
      console.log("\n[wake-scheduler] 暂不需要唤醒\n");
      return;
    }

    const weatherContext = await fetchWeatherContext();
    const phoneContext = await fetchPhoneStateContext();
    const wakePrompt = buildWakePrompt(formatDateTimeInTimeZone(new Date(), TIME_ZONE), diffMinutes, weatherContext, phoneContext);

    // 统一唤醒链路（进程内直调，无 HTTP 自环）：上下文重建/工具循环全在 runWakeCompletion
    let rawAiTextFull = "";
    let wakeToolHistory = [];
    let wakeBlockId = null;
    try {
      const res = await runWakeCompletion(wakeDeps, {
        session_id: wakeSessionId,
        wake_block: wakePrompt,
        with_tools: true,
        temperature: 0.8,
        top_p: 0.95
      });
      rawAiTextFull = String(res.text || "");
      wakeToolHistory = Array.isArray(res.toolHistory) ? res.toolHistory : [];
      wakeBlockId = res.wakeBlockId || null;
      console.log("[wake-scheduler] 统一链路完成：工具 " + wakeToolHistory.length + " 个，正文 " + rawAiTextFull.length + " 字");
    } catch (e) {
      console.error("[wake-scheduler] 统一唤醒链路失败，本次唤醒中止:", e.message);
      return;
    }

    // <wake> 标签：AI 可设置下次主动唤醒时间；标签不进入推送正文和时间线
    const wakeTagMatch = rawAiTextFull.match(/<wake>([\s\S]*?)<\/wake>/i);
    let wakeScheduleNote = "";
    if (wakeTagMatch) {
      const parsed = parseWakeTarget(wakeTagMatch[1], TIME_ZONE);
      if (parsed) {
        const nextWakeAt = parsed.at || new Date(Date.now() + parsed.minutes * 60 * 1000);
        if (nextWakeAt.getTime() > Date.now()) {
          const label = parsed.at
            ? formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)
            : `${parsed.minutes} 分钟后（至 ${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}）`;
          try {
            wakeSchedule.saveSlot(nextWakeAt.toISOString(), wakeSessionId);
            wakeScheduleNote = `，且设定了主动唤醒时间：${label}`;
            console.log(`[wake-scheduler] AI 设定主动唤醒时间：${label}（${nextWakeAt.toISOString()}，会话 ${wakeSessionId}）`);
            armTimedWake();
          } catch (wakeErr) {
            console.warn("[wake-scheduler] 保存下次唤醒时间失败:", wakeErr.message);
          }
        } else {
          console.log("[wake-scheduler] <wake> 时间已过（忽略）:", wakeTagMatch[1]);
        }
      } else {
        console.log("[wake-scheduler] <wake> 内容无效（忽略）:", wakeTagMatch[1]);
      }
    }
    const rawAiText = rawAiTextFull.replace(/<wake>[\s\S]*?<\/wake>/gi, "").trim();
    console.log("\nWake Result Summary:\n");
    console.log(JSON.stringify({ via_gateway: true, tools: wakeToolHistory.length, ai_text_chars: rawAiText.length }));

    const diaryResult = diaryLib.extractDiaryFromResponse(rawAiText);
    const diarySaved = diaryLib.appendDiaryEntry(diaryResult.diaryContent, wakeSessionId);
    const aiText = diaryResult.remainingText;

    const nowText = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
    let eventContent;
    let pushMeta = null;

    if (!aiText) {
      console.log("\n[wake-scheduler] AI 未返回推送内容，本次不发送推送\n");
      eventContent = diarySaved
        ? `（${nowText} 自动唤醒：本次未发送推送｜原因：只写日记）`
        : `（${nowText} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
    } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
      const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
      console.log("\n[wake-scheduler] AI 选择不发送推送\n");
      let reason = (noActionMatch[1] || "").trim();
      if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
        reason = reason.replace(/^原因[：:]\s*/, "").trim();
      }
      eventContent = reason
        ? `（${nowText} 自动唤醒：本次未发送推送｜原因：${reason}）`
        : `（${nowText} 自动唤醒：本次未发送推送）`;
    } else {
      console.log("\n[wake-scheduler] AI 选择发送推送\n");
      let barkText = stripInternalTags(aiText).replace(/\[DIARY\]|\[\/DIARY\]/gi, "");
      const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
      if (barkMatch) {
        barkText = barkMatch[1].trim();
      } else {
        barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
        barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
      }
      barkText = barkText
        .replace(/^标题[：:]\s*/gm, "")
        .replace(/^正文[：:]\s*/gm, "");
      const lines = barkText.split("\n").filter(line => line.trim() !== "");
      let title, body;
      if (lines.length === 0) {
        console.log("\n[wake-scheduler] 推送内容清洗后为空，本次不发送推送\n");
        eventContent = `（${nowText} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
      } else if (lines.length === 1) {
        title = "来自" + (readEnvValue("AI_DISPLAY_NAME") || "AI");
        body = lines[0].trim();
      } else if (lines.length === 2) {
        title = lines[0].trim();
        body = lines[1].trim();
      } else {
        title = lines[0].trim();
        body = lines.slice(1).map(l => l.trim()).join(" ");
      }

      if (!eventContent) {
        const safeBody = body.length > 800 ? body.substring(0, 797) + "..." : body;
        let safeTitle = title || "来自伴侣";
        if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;
        const sessName = getSessionDisplayName(wakeSessionId);
        if (sessName) safeTitle = `[${sessName}] ${safeTitle}`;

        const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
        if (!pushResult.ok) {
          console.log(`\n${pushResult.providerLabel || "推送"} 推送失败，本次不发送推送\n`);
          eventContent = `（${nowText} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel || "推送"} 推送失败：${pushResult.reason}）`;
        } else {
          eventContent = `（${nowText} 刚刚给${readEnvValue("USER_DISPLAY_NAME") || "用户"}发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
          pushMeta = { at: nowText, user: readEnvValue("USER_DISPLAY_NAME") || "用户", channel: pushResult.providerLabel, title: safeTitle, body: safeBody, session: wakeSessionId, session_name: sessName };
        }
      }
    }

    if (wakeScheduleNote && eventContent) {
      eventContent += wakeScheduleNote;
    }

    // 保存 AI 的完整回复到时间线（进程内直调 wake-event v2 同一实现；幂等去重只在 HTTP 入口做）
    if (rawAiText) {
      try {
        await tagParser.extractAndStore(rawAiText, { sessionId: wakeSessionId });
        console.log("[tag-parser] 唤醒时标签解析完成");
      } catch (tagErr) {
        console.warn("[tag-parser] 唤醒时标签解析失败:", tagErr.message);
      }
      try {
        const speakOut = (aiText && !/^\[NO_ACTION\]/.test(aiText)) ? rawAiTextFull : "";
        const r = applyWakeEventV2({
          v2: true,
          session_id: wakeSessionId,
          speak: speakOut,
          diary: diaryResult.diaryContent || "",
          push: pushMeta,
          tools: wakeToolHistory.length ? wakeToolHistory : undefined,
          wake_block_id: wakeBlockId || undefined
        });
        if (r && r.ok) {
          console.log("\n[wake-scheduler] 已保存 AI 完整回复到时间线\n");
        } else {
          console.error("\n[wake-scheduler] 保存 AI 完整回复失败（本次唤醒产出可能未落时间线）:", r && r.error);
        }
      } catch (err) {
        console.error("\n[wake-scheduler] 保存 AI 完整回复失败:", err.message);
      }
    }
  }

  // ---- 周期检查 ----
  async function scheduleNextCheck() {
    try {
      touchHeartbeat();
      await runWakeUp();
    } catch (err) {
      console.error("[wake-scheduler] 唤醒检查出错:", err);
    }
    setTimeout(scheduleNextCheck, getCheckIntervalMs());
  }

  // 对话侧（gateway）写入 wake_schedule.json 后，靠轻量轮询感知变化并重新挂定时器
  let lastWakeScheduleFingerprint = null;
  function fingerprintWakeSchedule() {
    try {
      if (!fs.existsSync(WAKE_SCHEDULE_PATH)) return null;
      const stat = fs.statSync(WAKE_SCHEDULE_PATH);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }
  function pollWakeScheduleFile() {
    const fp = fingerprintWakeSchedule();
    if (fp !== lastWakeScheduleFingerprint) {
      lastWakeScheduleFingerprint = fp;
      armTimedWake();
    }
  }

  function start() {
    armTimedWake();
    lastWakeScheduleFingerprint = fingerprintWakeSchedule();
    setInterval(pollWakeScheduleFile, 20_000);
    setTimeout(scheduleNextCheck, 10_000);
    console.log("[wake-scheduler] 唤醒调度器已在 gateway 内启动（wake-up 独立进程退役）");
  }

  return { start, runNow: runWakeUp, armTimedWake };
};
