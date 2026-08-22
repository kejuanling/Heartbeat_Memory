require("dotenv").config();
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, ".env");
let lastEnvFingerprint = "";
// 管理台保存 .env 后热生效：每轮检查前重读 .env 并覆盖 process.env
function reloadEnvFromFile() {
  try {
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    const parsed = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    const fingerprint = JSON.stringify(Object.entries(parsed).sort());
    if (fingerprint !== lastEnvFingerprint) {
      Object.assign(process.env, parsed);
      lastEnvFingerprint = fingerprint;
      console.log("[wake-up] .env 配置已热更新");
    }
    return true;
  } catch (err) {
    console.warn("[wake-up] 读取 .env 失败:", err.message);
    return false;
  }
}
const memoryEngine = require("./memory-engine");
const tagParser = require("./tag-parser");
// 旧压缩器已统一进「上下文替换」，唤醒侧不再使用
// const contextCompactor = require("./context-compactor");
const contextReplacements = require("./context-replacements");
let memoryReady = false;
memoryEngine.init().then(() => {
  memoryReady = true;
  console.log("[wake-up] 记忆引擎就绪");
}).catch(err => {
  console.warn("[wake-up] 记忆引擎初始化失败，将以空记忆运行:", err.message);
  memoryReady = true; // 仍然继续启动，记忆会在加载后自动可用
});
const { buildNtfyPayload } = require("./ntfy_priority");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  parseWakeTarget,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

const TIMELINE_PATH = path.join(__dirname, "enhanced_messages.json");
const WAKE_SCHEDULE_PATH = path.join(__dirname, "data", "wake_schedule.json");
let timedWakeTimer = null;
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
// 上游模型请求超时（毫秒），防止模型挂起导致唤醒/心跳循环停摆
const WAKE_UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;

function internalHeaders() {
  const headers = { "Content-Type": "application/json" };
  const key = process.env.INTERNAL_API_KEY;
  if (key) headers["x-internal-key"] = key;
  return headers;
}
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = path.isAbsolute(DIARY_DIR_NAME)
  ? DIARY_DIR_NAME
  : path.join(__dirname, DIARY_DIR_NAME);

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  let remainingText = String(text || "")
    .replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
      const diary = String(content || "").trim();
      if (diary) diaryBlocks.push(diary);
      return "";
    })
    .trim();
  // 容错：模型输出被截断或漏写 [/DIARY] 时，把开标签之后剩余内容视为日记
  remainingText = remainingText
    .replace(/\[DIARY\][\s\S]*$/i, (m) => {
      const diary = m.replace(/^\[DIARY\]/i, "").trim();
      if (diary) diaryBlocks.push(diary);
      return "";
    })
    .trim();
  // 兜底：清除残留的 [DIARY]/[/DIARY] 标记，避免泄漏到推送
  remainingText = remainingText.replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

// 剥离 AI 回复里的内部标签（<memory>/<pin>），避免原始标签出现在推送和上下文里
function stripInternalTags(text) {
  return tagParser.stripTags(text).replace(/^\s+|\s+$/g, "");
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("[diary] DIARY_ENABLED=false，跳过保存。请在 .env 中设置 DIARY_ENABLED=true");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) {
    console.log("[diary] 日记内容为空，跳过保存");
    return false;
  }

  try {
    // Ensure the diary directory exists
    if (!fs.existsSync(DIARY_DIR_PATH)) {
      fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
      console.log("[diary] 创建日记目录:", DIARY_DIR_PATH);
    }
    
    const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
    const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
    fs.appendFileSync(diaryFile, entry, "utf-8");
    console.log(`[diary] 已保存日记：${diaryFile} (${cleanContent.length} 字符)`);
    return true;
  } catch (err) {
    console.error("[diary] 保存日记失败:", err.message);
    return false;
  }
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
async function sendPushNotification({ title, body }) {
  try {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
  } catch (err) {
    // 网络异常（DNS/连接/超时）不中断整个唤醒流程
    return {
      ok: false,
      providerLabel: (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase(),
      reason: err.message || String(err)
    };
  }
}

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

function normalizeContentToText(content) {
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

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
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

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}
// <wake> 标签：AI 在唤醒时设置「下一次主动唤醒时间」（分钟，1~1440）：到点前定时检查跳过，到点主动唤醒一次
function readWakeScheduleRaw() {
  try {
    if (!fs.existsSync(WAKE_SCHEDULE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(WAKE_SCHEDULE_PATH, "utf-8"));
    return data && data.next_wake_at ? data : null;
  } catch (err) {
    console.warn("[wake-up] 读取定时唤醒失败:", err.message);
    return null;
  }
}

function readWakeSchedule() {
  const data = readWakeScheduleRaw();
  if (!data) return null;
  const t = new Date(data.next_wake_at);
  return isNaN(t.getTime()) ? null : t;
}

// 设定之后用户是否已主动找过 AI（时间线里出现更新的用户消息）：是则定时作废
function isUserActiveSince(schedule) {
  if (!schedule || !schedule.updated_at) return false;
  const setTime = new Date(schedule.updated_at);
  if (isNaN(setTime.getTime())) return false;
  const messages = loadTimelineMessages();
  if (!messages) return false;
  const lastUserTime = getLastUserTime(messages);
  return !!lastUserTime && lastUserTime.getTime() > setTime.getTime();
}

function saveWakeSchedule(nextWakeAtIso) {
  fs.mkdirSync(path.dirname(WAKE_SCHEDULE_PATH), { recursive: true });
  const tmp = WAKE_SCHEDULE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ next_wake_at: nextWakeAtIso, updated_at: new Date().toISOString() }, null, 2), "utf-8");
  fs.renameSync(tmp, WAKE_SCHEDULE_PATH);
}
// 清理定时唤醒：取消内存定时器 + 删除记录（触发后 / 已过期 / 作废时调用）
function clearWakeSchedule() {
  if (timedWakeTimer) {
    clearTimeout(timedWakeTimer);
    timedWakeTimer = null;
  }
  try {
    if (fs.existsSync(WAKE_SCHEDULE_PATH)) fs.unlinkSync(WAKE_SCHEDULE_PATH);
  } catch (err) {
    console.warn("[wake-up] 清理定时唤醒失败:", err.message);
  }
}

// 装载定时唤醒：从文件读取时间，在内存里挂一个到点触发的定时器（进程重启后由 startAfterInit 重新装载）
function armTimedWake() {
  if (timedWakeTimer) {
    clearTimeout(timedWakeTimer);
    timedWakeTimer = null;
  }
  let nextWakeAt = null;
  try { nextWakeAt = readWakeSchedule(); } catch (err) { /* 读取失败按无定时处理 */ }
  if (!nextWakeAt) return;
  const delayMs = nextWakeAt.getTime() - Date.now();
  if (delayMs <= 0) {
    // 已过期（例如进程重启错过了到点时刻）：清理，恢复正常检查节奏
    try { clearWakeSchedule(); } catch (err) { /* 忽略 */ }
    return;
  }
  timedWakeTimer = setTimeout(runTimedWake, delayMs);
  console.log(`[wake-up] 已设定定时唤醒：${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}（${Math.round(delayMs / 60000)} 分钟后）`);
}

// 定时唤醒到点：若设定后用户已主动找过 AI 则作废；否则清理记录后执行一次唤醒流程（是否发推送仍由 AI 自行决定）
async function runTimedWake() {
  timedWakeTimer = null;
  try {
    if (isUserActiveSince(readWakeScheduleRaw())) {
      console.log("\n===== 定时唤醒作废 =====\n设定后用户已主动找过 AI，本次定时唤醒取消\n");
      try { clearWakeSchedule(); } catch (err) { /* 忽略 */ }
      return;
    }
  } catch (voidErr) {
    console.warn("[wake-up] 检查定时是否作废失败（按到点执行）:", voidErr.message);
  }
  try { clearWakeSchedule(); } catch (err) { /* 忽略 */ }
  console.log("\n===== 定时唤醒到点 =====\n");
  await runWakeUp();
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  // 兼容 Kelivo 新格式：<current_time>Sat 26-08-15 22:10:29</current_time>
  // （两位年份 + 可选星期前缀 + 可选秒），客户端更新后每条消息末尾都会注入
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
  // 兼容正文末尾时间缀（客户端自动注入的墙上时间）
  const tail = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
  if (tail) {
    const p = tail[1].match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
    if (p) return zonedWallTimeToDate({ year: Number(p[1]), month: Number(p[2]), day: Number(p[3]), hour: Number(p[4]), minute: Number(p[5]) }, TIME_ZONE);
  }
  return null;
}

// 优先读取消息自带的 time 字段（2026-08 起时间线统一补充该字段）
function dateFromField(msg) {
  if (!msg || !msg.time) return null;
  const d = new Date(msg.time);
  return isNaN(d.getTime()) ? null : d;
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const fromField = dateFromField(msg);
      if (fromField) return fromField;
      const content = normalizeContentToText(msg.content);
      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function getLastMessageTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user" || msg.role === "assistant") {
      const fromField = dateFromField(msg);
      if (fromField) return fromField;
      const content = normalizeContentToText(msg.content);
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, time, ...rest }) => rest);
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
- 你可以设置下一次系统主动唤醒你的时间，格式为 <wake>数值</wake>，单位为分钟。设置后这段时间内系统不会再唤醒你，时间一到会主动唤醒你一次；如果到点前她主动找过你，这个定时会自动作废。不想设置就不输出这个标签。
`;
}

let wakeRunning = false;
async function runWakeUp() {
  if (wakeRunning) {
    console.log("[wake-up] 上一次唤醒仍在进行，本次跳过");
    return;
  }
  wakeRunning = true;
  try {
    await runWakeUpInner();
  } finally {
    wakeRunning = false;
  }
}

async function runWakeUpInner() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  // AI 设置的「下一次主动唤醒时间」：设定后用户一旦主动找过 AI 则定时作废；
  // 未到点之前定时检查跳过（不影响对话）；已过期则清理
  try {
    const schedule = readWakeScheduleRaw();
    if (schedule) {
      if (isUserActiveSince(schedule)) {
        console.log("\n用户已主动找过 AI，定时唤醒作废，恢复正常唤醒节奏\n");
        try { clearWakeSchedule(); } catch (voidErr) {
          console.warn("[wake-up] 清理作废定时失败:", voidErr.message);
        }
      } else {
        const nextWakeAt = new Date(schedule.next_wake_at);
        if (!isNaN(nextWakeAt.getTime()) && nextWakeAt.getTime() > Date.now()) {
          console.log(`\n下一次主动唤醒时间未到（${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}），本次跳过唤醒\n`);
          return;
        }
        try { clearWakeSchedule(); } catch (expireErr) {
          console.warn("[wake-up] 清理过期唤醒时间失败:", expireErr.message);
        }
      }
    }
  } catch (scheduleErr) {
    console.warn("[wake-up] 检查下次唤醒时间失败（忽略）:", scheduleErr.message);
  }

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastMessageTime = getLastMessageTime(messages);
  if (!lastMessageTime) {
    console.log("未找到消息时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastMessageTime) / 1000 / 60);

  if (!shouldWake(lastMessageTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();

  // 永久注入上下文
  let pinnedContext = "";
  try {
    const pinnedCtx = memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : "";
    if (pinnedCtx) {
      pinnedContext = "\n\n## 永久上下文\n" + pinnedCtx;
      console.log("[pinned] 唤醒时注入永久上下文");
    }
  } catch (pinErr) {
    console.warn("[pinned] 唤醒时注入失败:", pinErr.message);
  }

  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
  let cleanMessages = stripPosition(messages);

  // 上下文记忆替换：唤醒时看到的也是 AI 写好的记忆而不是原文（源文件不动）
  try {
    const beforeWake = cleanMessages.length;
    cleanMessages = contextReplacements.applyReplacements(cleanMessages);
    if (cleanMessages.length !== beforeWake) {
      console.log("[wake-up] 上下文记忆替换生效: 消息 " + beforeWake + " -> " + cleanMessages.length);
    }
  } catch (repErr) {
    console.warn("[wake-up] 上下文记忆替换失败（按原样处理）:", repErr.message);
  }

  // 唤醒历史消息：与主聊天同一套组装（统一替换已在上面生效），保留结构化消息；
  // 与对话的唯一区别：不含工具调用链（唤醒不需要工具），末尾多注入一条唤醒提示词。
  function filterMemoryMsgs(msgs) {
    return msgs.filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    });
  }

  // 上下文压缩已统一进「上下文替换」：历史 = 替换后的非 system 消息，不做条数上限，与对话侧一致
  let historyMsgs = filterMemoryMsgs(cleanMessages.filter(msg => msg.role !== "system"));

  // 唤醒不需要工具调用链（对话侧才有）；历史内容统一为纯文本
  historyMsgs = historyMsgs
    .filter(m => m.role !== "tool" && !m.tool_calls && !m.tool_call_id)
    .map(m => (Array.isArray(m.content) ? { ...m, content: normalizeContentToText(m.content) } : m));

  // 批注 2026-08-19 唐山：唤醒侧兜底——历史末尾若仍是用户最新未回复消息，则剔除这些尾部 user 消息，
  // 保证发给 AI 的最后一条始终是 AI 自己的回复（正常对话最后一条都是 assistant），
  // 避免 AI 把最后一条用户消息当成未回答而去生成对话回复。
  while (historyMsgs.length && historyMsgs[historyMsgs.length - 1].role === "user") {
    historyMsgs.pop();
  }

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt
    ? normalizeContentToText(baseSystemPrompt.content).split("## search_web 工具使用说明")[0].trim()
    : "";

  // 稳定 system = 人设(cleanSP) + 永久上下文(pinned)，与主聊天一致
  const stableSystem = [cleanSP, pinnedContext].filter(Boolean).join("\n\n");
  // 唤醒提示词：改到最后一条消息之下（历史之后），AI 读完历史再读后台唤醒规则
  const dynamicContent = [
    `（系统提示：以下内容${process.env.USER_DISPLAY_NAME || "用户"}不可见，仅供你参考）`,
    wakePrompt
  ].filter(Boolean).join("\n\n");

  const wakeMessages = [
    {
      role: "system",
      content: stableSystem
    },
    ...historyMsgs,
    {
      role: "system",
      content: dynamicContent
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  // 上游请求超时保护，避免模型挂起导致唤醒/心跳循环停摆
  const wakeController = new AbortController();
  const wakeTimer = setTimeout(() => wakeController.abort(), WAKE_UPSTREAM_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(process.env.TARGET_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TARGET_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.MODEL_NAME,
        messages: wakeMessages,
        temperature: 0.8,
        top_p: 0.95,
        stream: false
      }),
      signal: wakeController.signal
    });
  } finally {
    clearTimeout(wakeTimer);
  }

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`模型返回的不是 JSON（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  const rawAiTextFull = normalizeContentToText(data.choices?.[0]?.message?.content).trim();

  // <wake> 标签：AI 可设置下次主动唤醒时间（日期时间或分钟）；标签不进入推送正文和时间线
  const wakeTagMatch = rawAiTextFull.match(/<wake>([\s\S]*?)<\/wake>/i);
  let wakeScheduleNote = "";
  if (wakeTagMatch) {
    const target = parseWakeTarget(wakeTagMatch[1], TIME_ZONE);
    if (target) {
      const nextWakeAt = target.at || new Date(Date.now() + target.minutes * 60 * 1000);
      if (nextWakeAt.getTime() > Date.now()) {
        const label = target.at
          ? formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)
          : `${target.minutes} 分钟后（至 ${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}）`;
        try {
          saveWakeSchedule(nextWakeAt.toISOString());
          wakeScheduleNote = `，且设定了主动唤醒时间：${label}`;
          console.log(`[wake-up] AI 设定主动唤醒时间：${label}（${nextWakeAt.toISOString()}）`);
          armTimedWake();
        } catch (wakeErr) {
          console.warn("[wake-up] 保存下次唤醒时间失败:", wakeErr.message);
        }
      } else {
        console.log("[wake-up] <wake> 时间已过（忽略）:", wakeTagMatch[1]);
      }
    } else {
      console.log("[wake-up] <wake> 内容无效（忽略）:", wakeTagMatch[1]);
    }
  }
  const rawAiText = rawAiTextFull.replace(/<wake>[\s\S]*?<\/wake>/gi, "").trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    eventContent = diarySaved
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI 选择不发送推送
    console.log("\nAI 选择不发送推送\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
  } else {
    // 没有 [NO_ACTION] 就视为想发推送
    console.log("\nAI 选择发送推送\n");
    let barkText = stripInternalTags(aiText).replace(/\[DIARY\]|\[\/DIARY\]/gi, "");

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
    } else if (lines.length === 1) {
      title = "来自" + (process.env.AI_DISPLAY_NAME || "AI");
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // ≥3 行：第一行标题，剩余用空格拼接成正文
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // 保护：截断过长正文，兼容 Bark 和 ntfy 的移动端展示。
      const safeBody = body.length > 800 ? body.substring(0, 797) + "..." : body;
      // 若标题为空或以数字开头，加个前缀，可自行修改
      let safeTitle = title || "来自伴侣";
      if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
      } else {
        eventContent = `（${getLocalTimeString()} 刚刚给${process.env.USER_DISPLAY_NAME || "用户"}发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
      }
    }
  }

  if (wakeScheduleNote && eventContent) {
    eventContent += wakeScheduleNote;
  }

  // 保存 AI 的完整回复到时间线
  if (rawAiText) {
    // 提取 <memory> 和 <pin> 标签（唤醒时也允许 AI 写记忆和钉选）
    try {
      await tagParser.extractAndStore(rawAiText);
      console.log("[tag-parser] 唤醒时标签解析完成");
    } catch (tagErr) {
      console.warn("[tag-parser] 唤醒时标签解析失败:", tagErr.message);
    }

    try {
      const aiReplyResponse = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          content: rawAiText,
          event: eventContent,
          diary: diaryResult.diaryContent || ""
        })
      });
      if (aiReplyResponse.ok) {
        console.log("\n已保存 AI 完整回复到时间线\n");
      }
    } catch (err) {
      console.error("\n保存 AI 完整回复失败:", err.message);
    }
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    reloadEnvFromFile();
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST", headers: internalHeaders(), body: "{}" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
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

// 启动第一次检查：等记忆引擎初始化完成后再执行
function startAfterInit() {
  if (!memoryReady) {
    setTimeout(startAfterInit, 500);
    return;
  }
  armTimedWake();
  lastWakeScheduleFingerprint = fingerprintWakeSchedule();
  setInterval(pollWakeScheduleFile, 20_000);
  setTimeout(scheduleNextCheck, 10_000);
}
startAfterInit();

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log("==================================\n");
