require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// 推送记录直接落在时间线（enhanced_messages.json），由管理台「推送管理」页对接，不再单独维护日志文件。



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
const { McpServerClient, loadConfig } = require("./mcp-client");
const mcpLoop = require("./mcp-tool-loop");

// 唤醒侧注入白名单服务器：「工具集合」（本地记忆/日记工具，127.0.0.1:8771）+「花园」+「邮箱」，
// 从 mcp-servers.json 里按名称/端口挑出，避免把 search.parallel / 网易云等带进唤醒；
// loadConfig 已滤掉 enabled:false，聊天端停用即唤醒侧同步停用。
let _wakeMcpClients = null;
function getWakeMcpClients() {
  if (_wakeMcpClients) return _wakeMcpClients;
  try {
    const servers = loadConfig(path.join(__dirname, "mcp-servers.json"));
    const target = servers.filter(s => {
      const key = (s.name || "") + " " + (s.url || "");
      return /工具集合/.test(key) || /127\.0\.0\.1:8771/.test(key)
        || /花园/.test(key) || /galatea\.abysslumina\.com/.test(key)
        || /邮箱/.test(key) || /127\.0\.0\.1:5000\b/.test(key);
    });
    _wakeMcpClients = target.map(c => new McpServerClient(c));
  } catch (e) {
    console.warn("[wake-up] 加载工具集合配置失败:", e.message);
    _wakeMcpClients = [];
  }
  return _wakeMcpClients;
}
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
// 调度文件读写收口到共享模块（跨进程文件锁+损坏拒写，审查 D3）；WAKE_SCHEDULE_PATH 保留给只读路径使用
const wakeSchedule = require("./lib/wake-schedule");
const WAKE_SCHEDULE_PATH = path.join(__dirname, "data", "wake_schedule.json");
const WAKE_LOCKED_PATH = path.join(__dirname, "data", "wake-locked.json");
const SESSION_NAMES_PATH = path.join(__dirname, "data", "session-names.json");
let timedWakeTimer = null;
// 到点判定的统一宽限窗：setTimeout 的毫秒延时会被向零截断，定时器可能比闹钟时刻早 <=1ms 触发，
// 若「捕获」与「过期清理」严格用 next_wake_at <= now 判定，提前触发会两手空空、随后槽位被当过期删掉，闹钟静默蒸发
const WAKE_DUE_GRACE_MS = 2000;
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const WAKE_COMPLETIONS_URL = `${GATEWAY_BASE_URL}/internal/wake-completions`;
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

// 日记按会话分开保存（2026-09-12）：唤醒写的日记落到 diary/<会话目录>/日期.md，不再全系统共用一份。
// 会话目录命名与 gateway 的 safeSessionToken 同一套规则，保证两侧写的是同一个目录。
function diarySessionToken(sessionId) {
  if (!sessionId || sessionId === "default") return "default";
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "");
  return safe || ("h" + crypto.createHash("md5").update(String(sessionId)).digest("hex").slice(0, 12));
}

function appendDiaryEntry(content, sessionId) {
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
    const token = diarySessionToken(sessionId);
    const targetDir = token ? path.join(DIARY_DIR_PATH, token) : DIARY_DIR_PATH;
    // Ensure the diary directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      console.log("[diary] 创建日记目录:", targetDir);
    }

    const diaryFile = path.join(targetDir, `${getDiaryDateString()}.md`);
    const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
    fs.appendFileSync(diaryFile, entry, "utf-8");
    console.log(`[diary] 已保存日记（会话 ${token || "共享"}）：${diaryFile} (${cleanContent.length} 字符)`);
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

    // 推送必须有超时：否则对端挂起会卡住唤醒流程，wakeRunning 互斥会让后续唤醒全部静默跳过
    let response;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        response = await fetch(server, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: ctl.signal
        });
      } finally { clearTimeout(timer); }
    } catch (e) {
      return { ok: false, providerLabel: "ntfy", reason: "推送请求失败/超时: " + e.message };
    }
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

  // 推送必须有超时：否则对端挂起会卡住唤醒流程，wakeRunning 互斥会让后续唤醒全部静默跳过
  let response;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      response = await fetch("https://api.day.app/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(barkPayload),
        signal: ctl.signal
      });
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, providerLabel: "Bark", reason: "推送请求失败/超时: " + e.message };
  }

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

// 读 han 手机最近一次上报的状态快照（电池/当前App/位置），注入唤醒上下文
// 数据在 phone-report-api(8080)，经 /state/latest 读取；user_id 固定为 han
const PHONE_STATE_URL = "http://127.0.0.1:8080/state/latest?user_id=han";
const PHONE_STATE_TOKEN = process.env.PHONE_STATE_TOKEN || ""; // 与 phone-api systemd unit 的 AUTH_TOKEN 一致，值在 .env

async function fetchPhoneStateContext() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(PHONE_STATE_URL, {
      signal: controller.signal,
      headers: { "Authorization": "Bearer " + PHONE_STATE_TOKEN },
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const st = data && data.state;
    if (!st) return ""; // 没有上报过，不注入
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

// ========================
// 多会话：扫描所有会话语，解决"唤醒只盯主会话、感知不到分会话活跃"的问题。
// 返回 [{ sessionId, messages }]，主会话 sessionId="default"。
// ========================
function loadAllSessionTimelines() {
  const results = [];
  function readTimelineFile(file, sessionId) {
    try {
      if (!fs.existsSync(file)) return null;
      const arr = JSON.parse(fs.readFileSync(file, "utf-8"));
      return Array.isArray(arr) ? { sessionId, file, messages: arr } : null;
    } catch (e) {
      console.warn("[wake-up] 读取会话语失败:", file, e.message);
      return null;
    }
  }
  const main = readTimelineFile(TIMELINE_PATH, "default");
  if (main) results.push(main);
  // 其余会话：enhanced_messages_<safe>.json（与 server.js timelineFileFor 规则一致）
  try {
    const files = fs.readdirSync(__dirname).filter(f => /^enhanced_messages_[A-Za-z0-9_-]+\.json$/.test(f));
    for (const f of files) {
      const sid = f.replace(/^enhanced_messages_/, "").replace(/\.json$/, "");
      if (!sid || sid === "default") continue;
      const t = readTimelineFile(path.join(__dirname, f), sid);
      if (t) results.push(t);
    }
  } catch (e) {
    console.warn("[wake-up] 枚举会话语失败:", e.message);
  }
  return results;
}

// 取最近仍活跃的会话语（最后一条真实 user/assistant 消息时间最晚者）。
// 唤醒的沉默判定、上下文、写回都用它，避免"主会话安静就乱唤醒 / 分会话活跃却感知不到"。
function latestActiveTimeline() {
  const all = loadAllSessionTimelines();
  let best = null;
  let bestTime = null;
  for (const tl of all) {
    const last = getLastMessageTime(tl.messages);
    if (!last) continue;
    if (!bestTime || last.getTime() > bestTime.getTime()) {
      bestTime = last;
      best = tl;
    }
  }
  return best;
}

// 锁定唤醒会话集合：读 data/wake-locked.json（网关侧写入），返回会话 id 数组；读失败/不存在返回 []
function readWakeLockedSessions() {
  try {
    if (!fs.existsSync(WAKE_LOCKED_PATH)) return [];
    const v = JSON.parse(fs.readFileSync(WAKE_LOCKED_PATH, "utf-8"));
    return Array.isArray(v) ? v.filter(function (s) { return typeof s === "string" && s; }) : [];
  } catch (e) {
    console.warn("[wake-up] 读取锁定唤醒会话失败:", e.message);
    return [];
  }
}

// 按会话 id 取时间线（找不到返回 null）
function getTimelineBySessionId(sessionId) {
  const all = loadAllSessionTimelines();
  const hit = all.find(function (tl) { return tl.sessionId === sessionId; });
  return hit || null;
}

// 确定本轮要唤醒的会话目标：
// - 有锁定集合 → 逐一取锁定会话（跳过已删/不存在的），各自独立判断；
// - 无锁定 → 不唤醒（用户拍板：锁定为空即关闭唤醒，不做全局"最后活跃"兜底）。
function collectWakeTargets() {
  const locked = readWakeLockedSessions();
  if (!locked.length) {
    console.log("[wake-up] 未锁定任何会话，本次唤醒关闭");
    return [];
  }
  const targets = [];
  for (const sid of locked) {
    const tl = getTimelineBySessionId(sid);
    if (tl && Array.isArray(tl.messages) && tl.messages.length) {
      console.log("[wake-up] 唤醒基于会话（锁定）: " + sid + "（共 " + tl.messages.length + " 条）");
      targets.push({ sessionId: sid, messages: tl.messages });
    } else {
      console.warn("[wake-up] 锁定会话不存在/已删，跳过: " + sid);
    }
  }
  return targets;
}

// 任一会话里是否存在"设定之后"的用户消息（用于定时唤醒作废判定）：
// 用户可能在任何会话里主动找过 AI，不能只看主会话。
function isUserActiveAnywhereSince(schedule) {
  if (!schedule || !schedule.updated_at) return false;
  const setTime = new Date(schedule.updated_at);
  if (isNaN(setTime.getTime())) return false;
  const all = loadAllSessionTimelines();
  for (const tl of all) {
    const lastUserTime = getLastUserTime(tl.messages);
    if (lastUserTime && lastUserTime.getTime() > setTime.getTime()) return true;
  }
  return false;
}
// <wake> 标签：AI 在唤醒时设置「下一次主动唤醒时间」（分钟，1~1440）：到点前定时检查跳过，到点主动唤醒一次
// v2：调度文件为多会话 per-session 槽位，结构 { version:2, sessions: { <sid>: { next_wake_at, updated_at } } }
function readWakeScheduleRaw() {
  try {
    if (!fs.existsSync(WAKE_SCHEDULE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(WAKE_SCHEDULE_PATH, "utf-8"));
    return (data && typeof data === "object") ? data : null;
  } catch (err) {
    console.warn("[wake-up] 读取定时唤醒失败:", err.message);
    return null;
  }
}

// v2 per-session：取某个会话的调度条目（无则 null）。兼容旧单条格式（无 sessions 结构时归到 default）。
function readWakeScheduleFor(sessionId) {
  const sid = String(sessionId || "default").trim() || "default";
  const raw = readWakeScheduleRaw();
  if (!raw) return null;
  if (!raw.sessions) {
    if (sid !== "default") return null;
    return (raw.next_wake_at ? { next_wake_at: raw.next_wake_at, updated_at: raw.updated_at, session: "default" } : null);
  }
  const entry = (raw.sessions && typeof raw.sessions === "object") ? raw.sessions[sid] : null;
  return (entry && entry.next_wake_at) ? { ...entry, session: sid } : null;
}

// v2：写入 schedule 对象已收口到 lib/wake-schedule.js（saveSlot/clearSlot/pruneExpired，审查 D3）；
// 本进程对调度文件只剩只读路径（readWakeScheduleRaw/轮询 mtime）。

// v2：所有会话调度里最近一个未来时间点（用于挂内存定时器）；无 → null
function nextWakeFromAnySession() {
  const raw = readWakeScheduleRaw();
  if (!raw) return null;
  const sessions = raw.sessions || {};
  let best = null;
  for (const sid of Object.keys(sessions)) {
    const e = sessions[sid];
    if (!e || !e.next_wake_at) continue;
    const t = new Date(e.next_wake_at);
    if (isNaN(t.getTime())) continue;
    if (!best || t.getTime() < best.getTime()) best = t;
  }
  return best;
}

// 已到点（next_wake_at <= now + 宽限窗）的显式 <wake> 闹钟会话 id 列表（v2 per-session）。
// 用于 runTimedWake 清理调度前捕获（否则被 pruneExpiredSchedules 删除后无法定位），
// 以及 runWakeUpInner 在周期检查路径下兜底自算。
// 宽限窗必须与 pruneExpiredSchedules 一致：定时器可能提前 <=1ms 触发，此刻槽位还差几毫秒才算过期，
// 捕获若不带宽限就会空手而归，紧随其后的清理会把槽位删掉。
function getDueWakeSessionIds() {
  const raw = readWakeScheduleRaw();
  if (!raw) return [];
  const sessions = raw.sessions || {};
  const now = Date.now();
  const out = [];
  for (const sid of Object.keys(sessions)) {
    const e = sessions[sid];
    const t = e && e.next_wake_at ? new Date(e.next_wake_at) : null;
    if (t && !isNaN(t.getTime()) && t.getTime() <= now + WAKE_DUE_GRACE_MS) out.push(sid);
  }
  return out;
}

// v2：删除所有已过期（<= now + 宽限窗，与 getDueWakeSessionIds 同一口径）或无效的会话调度条，写回文件；返回是否有改动
// 批注 2026-09-13（审查 D3）：收口到共享模块（跨进程锁+损坏拒写）
function pruneExpiredSchedules() {
  return wakeSchedule.pruneExpired(WAKE_DUE_GRACE_MS);
}

// v2 按会话作废判定：该会话设定闹钟(updated_at)之后，该会话内是否又出现用户消息
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

// 会话显示名（用于推送标注来源）：读 data/session-names.json，找不到返回空串
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

// 设定之后用户是否已主动找过 AI（任一会话时间线里出现更新的用户消息）：是则定时作废
function isUserActiveSince(schedule) {
  if (!schedule || !schedule.updated_at) return false;
  return isUserActiveAnywhereSince(schedule);
}

function saveWakeSchedule(nextWakeAtIso, sessionId) {
  // 批注 2026-09-13（审查 D3）：收口到共享模块（跨进程锁+锁内重读合并+损坏拒写）
  wakeSchedule.saveSlot(nextWakeAtIso, sessionId);
}
// 清理定时唤醒（v2 按会话）：传入 sessionId 清该会话槽位并重挂内存定时器；
// 不传（或空）则清空全部会话调度并取消内存定时器（触发后 / 已过期 / 作废时调用）
function clearWakeSchedule(sessionId) {
  if (sessionId === undefined || sessionId === null || String(sessionId).trim() === "") {
    try {
      // 批注 2026-09-13（审查 D3）：清空走共享模块（跨进程锁）
      wakeSchedule.clearSlot();
    } catch (err) {
      console.warn("[wake-up] 清理全部定时唤醒失败:", err.message);
    }
    if (timedWakeTimer) { clearTimeout(timedWakeTimer); timedWakeTimer = null; }
    return;
  }
  const sid = String(sessionId).trim() || "default";
  let changed = false;
  try {
    // 批注 2026-09-13（审查 D3）：清槽位走共享模块（跨进程锁+损坏拒写）
    changed = wakeSchedule.clearSlot(sid);
  } catch (err) {
    console.warn("[wake-up] 清理定时唤醒失败:", err.message);
  }
  if (changed) armTimedWake();
}

// 装载定时唤醒：从文件读取时间，在内存里挂一个到点触发的定时器（进程重启后由 startAfterInit 重新装载）
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
    // 修复 2026-09-09：进程重启/错过后到期闹钟丢失。
    let due = [];
    try { due = getDueWakeSessionIds(); } catch (e) { /* 忽略 */ }
    try { pruneExpiredSchedules(); } catch (err) { /* 忽略 */ }
    if (timedWakeTimer) { clearTimeout(timedWakeTimer); timedWakeTimer = null; }
    if (due.length) {
      console.log(`[wake-up] 检测到已到点的闹钟（进程重启错过），补触发唤醒：${due.join(", ")}`);
      // 异步触发，不阻塞本函数（armTimedWake 被 startAfterInit / 20s 轮询同步调用）
      setTimeout(() => { runWakeUp(due); }, 0);
    }
    return;
  }
  // Math.ceil：setTimeout 会把小数毫秒向零截断，不取整会让定时器比闹钟时刻早触发 <=1ms
  timedWakeTimer = setTimeout(runTimedWake, Math.max(1, Math.ceil(delayMs)));
  console.log(`[wake-up] 已设定定时唤醒：${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}（${Math.round(delayMs / 60000)} 分钟后）`);
}

// 定时唤醒到点：先捕获已到点会话（带宽限窗），唤醒完成后再清理过期调度并重挂剩余定时器。
// 清理放在 runWakeUp 之后：若 runWakeUp 因互斥被跳过，槽位留在盘上，末尾 armTimedWake 的
// 过期分支会补触发，闹钟不会丢（此前清理在前 + 互斥跳过会静默吞掉闹钟）。
async function runTimedWake() {
  timedWakeTimer = null;
  const dueSids = getDueWakeSessionIds();
  console.log("\n===== 定时唤醒到点 =====\n");
  const executed = await runWakeUp(dueSids);
  // 仅当本次唤醒真的执行过（未被互斥跳过）才清理：跳过时槽位留在盘上，
  // 末尾 armTimedWake 的过期分支会补触发；否则槽位被删、闹钟静默丢失
  // 批注 2026-09-13（审查 B1）：改用 runWakeUp 的显式返回值，修复「跳过后守卫恒真仍清理」
  if (executed) {
    try { pruneExpiredSchedules(); } catch (voidErr) { console.warn("[wake-up] 清理过期定时失败:", voidErr.message); }
  }
  try { armTimedWake(); } catch (rearErr) { /* 重挂剩余未来槽位失败时由 20s 轮询兜底 */ }
}

function getNow() {
  return new Date();
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
    // 口径=用户最后消息：AI 回复/唤醒事件（assistant）不重置沉默计时，
    // 否则沉默时长被自己的输出不断刷新，唤醒/推送比阈值系统性推迟
    if (msg.role === "user") {
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

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "", phoneContext = "") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    let out = template;
    // 时间与沉默时长（此前漏替换，AI 唤醒时看到的是字面占位符；与 env/默认模板分支保持一致）
    out = out
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      // 天气：兼容模板里的 `${weatherContext}` / `${weather}` / 旧中文占位符 `${天气信息（可选）}`
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext)
      .replace(/\$\{天气信息（可选）\}/g, weatherContext);
    // 手机状态
    out = out.replace(/\$\{phoneContext\}/g, phoneContext)
             .replace(/\$\{手机状态（可选）\}/g, phoneContext);
    return out;
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext)
      .replace(/\$\{phoneContext\}/g, phoneContext);
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
${phoneContext ? `\n${phoneContext}\n` : ""}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
- 写前先用 diary_list 工具读本会话今天已写的日记：今天已经写过的话题不要重复写，可以接着写新段落，或写完全不同的新主题。
- 你可以设置下一次系统主动唤醒你的时间，格式为 <wake>数值</wake>，单位为分钟。设置后这段时间内系统不会再唤醒你，时间一到会主动唤醒你一次；如果到点前她主动找过你，这个定时会自动作废。不想设置就不输出这个标签。
`;
}

let wakeRunning = false;
// 返回值：本次是否真的执行过唤醒（未被互斥跳过）。runTimedWake 据此决定是否清理到期槽位。
// 批注 2026-09-13（审查 B1）：此前调用方用 `!wakeRunning` 判断「是否执行过」，但本函数的
// finally 在返回前就把 wakeRunning 复位了，守卫恒为真——被互斥跳过的调用也会清理槽位，
// 到期闹钟被静默删除。改为显式返回 executed 布尔。
async function runWakeUp(dueSids) {
  if (wakeRunning) {
    console.log("[wake-up] 上一次唤醒仍在进行，本次跳过");
    return false;
  }
  wakeRunning = true;
  try {
    await runWakeUpInner(dueSids);
    // 执行过但中途抛错也视为「执行过」：槽位时间戳已推进/推送可能已发出，
    // 保持与旧行为一致的清理语义，避免失败槽位被过期补触发循环重试
    return true;
  } catch (err) {
    // 定时唤醒入口（runTimedWake）由 setTimeout 触发、无人兜底，异常会成为
    // unhandled rejection 直接杀死进程（Node 15+ 默认 throw）；统一在此记日志吃掉。
    // 非 Error 抛出物（字符串等）没有堆栈，补记捕获点调用栈便于定位来源（如 "data is not defined"）
    const detail = (err && err.stack)
      ? err.stack
      : String(err) + "\n[非 Error 抛出物，以下是捕获点调用栈]\n" + new Error("trace").stack;
    console.error("[wake-up] 唤醒执行失败:", detail);
    return true;
  } finally {
    wakeRunning = false;
  }
}

async function runWakeUpInner(dueSids) {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  // 多会话：锁定集合中每个会话各自独立计时、独立推送、写回各自会话；无锁定则不唤醒（关闭唤醒）。
  const targets = collectWakeTargets();

  // 显式 <wake> 闹钟（用户在对话里让 AI 设的提醒）不受「锁定唤醒」影响：无论该会话是否被锁定、
  // 也无论是否锁定了任何会话，只要到现在点就必须被处理。定时路径下 runTimedWake 清理前已捕获 dueSids；
  // 周期检查路径（scheduleNextCheck）无清理，这里再兜底自行捕获一次。
  const dueSet = new Set();
  if (Array.isArray(dueSids)) { for (const sid of dueSids) dueSet.add(sid); }
  for (const sid of getDueWakeSessionIds()) { dueSet.add(sid); }
  if (dueSet.size) {
    const sessionByTarget = new Map();
    for (const t of targets) sessionByTarget.set(t.sessionId || "default", t);
    for (const sid of dueSet) {
      const known = sessionByTarget.get(sid);
      if (known) { known.explicitWake = true; continue; }
      const tl = getTimelineBySessionId(sid);
      if (tl && Array.isArray(tl.messages) && tl.messages.length) {
        console.log("[wake-up] 显式闹钟已到点，唤醒会话（未锁定）: " + sid + "（共 " + tl.messages.length + " 条）");
        targets.push({ sessionId: sid, messages: tl.messages, explicitWake: true });
        sessionByTarget.set(sid, targets[targets.length - 1]);
      } else {
        console.warn("[wake-up] 显式闹钟会话不存在/已删，跳过: " + sid);
      }
    }
  }

  if (!targets.length) { console.log("[wake-up] 无唤醒目标（未锁定/锁定的会话已删），本次跳过"); return; }

  // AI 设置的「下一次主动唤醒时间」：设定后用户一旦主动找过 AI 则定时作废；
  // 未到点之前定时检查跳过（不影响对话）；已过期则清理。
  // 无锁定（全局单会话，仅旧式 default 槽位）时在此全局判定；有锁定时 schedule 归属各会话，由 runWakeForTarget 各自检查。
  const locked = readWakeLockedSessions();
  if (!locked.length) {
    // 无锁定：只可能作用于主会话(default)的调度，按 default 处理（保留防御性；不阻塞上面已并入的显式闹钟目标）
    try {
      const schedule = readWakeScheduleFor("default");
      if (schedule) {
        if (isUserActiveSinceFor(schedule, "default")) {
          console.log("\n用户已主动找过 AI，定时唤醒作废，恢复正常唤醒节奏\n");
          try { clearWakeSchedule("default"); } catch (voidErr) {
            console.warn("[wake-up] 清理作废定时失败:", voidErr.message);
          }
        } else {
          const nextWakeAt = new Date(schedule.next_wake_at);
          // 2026-09-13 死代码清理：原「targets 为空则整体跳过」分支永不可达（上方已对空 targets 提前 return），
          // 锁定模式下未到点的旧 default 调度不应阻塞已并入的显式闹钟目标——保留原语义：未到点仅跳过过期清理
          if (isNaN(nextWakeAt.getTime()) || nextWakeAt.getTime() <= Date.now() + WAKE_DUE_GRACE_MS) {
            try { clearWakeSchedule("default"); } catch (expireErr) {
              console.warn("[wake-up] 清理过期唤醒时间失败:", expireErr.message);
            }
          }
        }
      }
    } catch (scheduleErr) {
      console.warn("[wake-up] 检查下次唤醒时间失败（忽略）:", scheduleErr.message);
    }
  }

  // 多锁定会话同时到点：逐个处理并错峰（每会话推送间隔收敛，避免连发多条）
  const sleepMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  for (let i = 0; i < targets.length; i++) {
    await runWakeForTarget(targets[i]);
    if (i < targets.length - 1) await sleepMs(1500);
  }
}

async function runWakeForTarget(target) {
  // 针对单个会话的完整唤醒流程：沉默判定、上下文、推送、写回都基于这个会话。
  const messages = target.messages;
  const wakeSessionId = target.sessionId || "default";
  console.log("[wake-up] 唤醒处理会话: " + wakeSessionId + "（共 " + messages.length + " 条）");

  const lastMessageTime = getLastMessageTime(messages);
  if (!lastMessageTime) {
    console.log("未找到消息时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastMessageTime) / 1000 / 60);

  // 显式 <wake> 闹钟：用户明确要求在此时点被提醒，跳过常规沉默判定，保证「永远生效」。
  // 设定之后用户在该会话又主动找过 AI → 定时作废，此时不强行提醒（交回正常节奏）。
  let explicitWake = !!target.explicitWake;
  // 会话级「下一次主动唤醒时间」：严格按会话隔离。AI 在该会话设定后，只跳过该会话的唤醒（不影响其他锁定会话）。
  try {
    const schedule = readWakeScheduleFor(wakeSessionId);
    if (schedule) {
      if (isUserActiveSinceFor(schedule, wakeSessionId)) {
        // 设定之后用户在该会话主动找过 AI → 定时作废，本次按正常节奏判断
        explicitWake = false;
        try { clearWakeSchedule(wakeSessionId); } catch (voidErr) { console.warn("[wake-up] 清理作废定时失败:", voidErr.message); }
      } else {
        const nextWakeAt = new Date(schedule.next_wake_at);
        // 同一口径带宽限窗：定时器提前 <=1ms 触发时，槽位在毫秒级仍"未到点"，不能因此跳过本次唤醒
        if (!isNaN(nextWakeAt.getTime()) && nextWakeAt.getTime() > Date.now() + WAKE_DUE_GRACE_MS) {
          console.log(`[wake-up] 会话 ${wakeSessionId} 的下一次主动唤醒时间未到（${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}），跳过该会话唤醒`);
          return;
        }
        // 已到点 → 清除该会话定时，让本次唤醒正常进行
        explicitWake = true;
        try { clearWakeSchedule(wakeSessionId); } catch (expireErr) { console.warn("[wake-up] 清理过期定时唤醒失败:", expireErr.message); }
      }
    }
  } catch (scheduleErr) {
    console.warn("[wake-up] 检查会话级下次唤醒时间失败（忽略）:", scheduleErr.message);
  }

  if (!explicitWake && !shouldWake(lastMessageTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();
  const phoneContext = await fetchPhoneStateContext();

  // [永久上下文]/[跨窗口] 注入已收口到网关统一唤醒链路（2026-09-15 批2），本进程不再拼装上下文。
  const wakePrompt = buildWakePrompt(getLocalTimeString(), diffMinutes, weatherContext, phoneContext);
  // === 统一唤醒链路（2026-09-15 批2）：上下文重建/工具循环全在网关 /internal/wake-completions ===
  // 本进程只保留：调度、沉默判定、唤醒提示词（= developer [唤醒] 块）、推送/日记/写回决策。
  let rawAiTextFull = "";
  let wakeToolHistory = [];
  let wakeBlockId = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), WAKE_UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(WAKE_COMPLETIONS_URL, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          session_id: wakeSessionId,
          wake_block: wakePrompt,
          with_tools: true,
          temperature: 0.8,
          top_p: 0.95
        }),
        signal: ctl.signal
      });
    } finally { clearTimeout(timer); }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.ok) {
      throw new Error("HTTP " + res.status + " " + String((data && data.error) || "").slice(0, 200));
    }
    rawAiTextFull = String(data.text || "");
    wakeToolHistory = Array.isArray(data.tool_history) ? data.tool_history : [];
    wakeBlockId = data.wake_block_id || null;
    console.log("[wake-up] 统一链路完成：工具 " + wakeToolHistory.length + " 个，正文 " + rawAiTextFull.length + " 字");
  } catch (e) {
    console.error("[wake-up] 统一唤醒链路失败，本次唤醒中止:", e.message);
    return;
  }


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
          saveWakeSchedule(nextWakeAt.toISOString(), wakeSessionId);
          wakeScheduleNote = `，且设定了主动唤醒时间：${label}`;
          console.log(`[wake-up] AI 设定主动唤醒时间：${label}（${nextWakeAt.toISOString()}，会话 ${wakeSessionId}）`);
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
  console.log(JSON.stringify({ via_gateway: true, tools: wakeToolHistory.length, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent, wakeSessionId);
  const aiText = diaryResult.remainingText;

  let eventContent;
  let pushMeta = null;

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
      // 会话标识：锁定多个会话时，推送标题明确标注来源会话，避免混淆
      const sessName = getSessionDisplayName(wakeSessionId);
      if (sessName) safeTitle = `[${sessName}] ${safeTitle}`;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
      } else {
        const pushAt = getLocalTimeString();
        eventContent = `（${pushAt} 刚刚给${process.env.USER_DISPLAY_NAME || "用户"}发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
        pushMeta = { at: pushAt, user: process.env.USER_DISPLAY_NAME || "用户", channel: pushResult.providerLabel, title: safeTitle, body: safeBody, session: wakeSessionId, session_name: sessName };
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
      await tagParser.extractAndStore(rawAiText, { sessionId: wakeSessionId });
      console.log("[tag-parser] 唤醒时标签解析完成");
    } catch (tagErr) {
      console.warn("[tag-parser] 唤醒时标签解析失败:", tagErr.message);
    }

    try {
      // 回写必须有超时 + 非 2xx 必须留痕：否则网关重启中/密钥不匹配时回复静默丢失，排查无迹
      // v2（2026-09-15 role 法）：speak/diary 原地追加为 assistant 消息；push 结构化挂字段；
      // 不再生成回显事件行、不再按时间戳插位；[NO_ACTION]/空回复时不带 speak（只留 [唤醒] 块）
      const speakOut = (aiText && !/^\[NO_ACTION\]/.test(aiText)) ? rawAiTextFull : "";
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      let aiReplyResponse;
      try {
        aiReplyResponse = await fetch(GATEWAY_URL, {
          method: "POST",
          headers: internalHeaders(),
          body: JSON.stringify({
            v2: true,
            session_id: wakeSessionId,
            speak: speakOut,
            diary: diaryResult.diaryContent || "",
            push: pushMeta,
            tools: wakeToolHistory.length ? wakeToolHistory : undefined,
            wake_block_id: wakeBlockId || undefined
          }),
          signal: ctl.signal
        });
      } finally { clearTimeout(timer); }
      if (aiReplyResponse.ok) {
        console.log("\n已保存 AI 完整回复到时间线\n");
      } else {
        console.error("\n保存 AI 完整回复失败: 网关返回 HTTP " + aiReplyResponse.status + "（本次唤醒产出可能未落时间线，仅存在于推送中）");
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
    // 发送心跳（8s 超时：gateway 半死时 undici 默认 300s 才报错，检查循环会被卡死顺延）
    try {
      const hbController = new AbortController();
      const hbTimer = setTimeout(() => hbController.abort(), 8000);
      try {
        await fetch(HEARTBEAT_URL, { method: "POST", headers: internalHeaders(), body: "{}", signal: hbController.signal });
      } finally { clearTimeout(hbTimer); }
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
