require("dotenv").config();

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const {
  getDatePartsInTimeZone,
  formatDateTimeInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

const DEFAULT_BODY_LIMIT_MB = 50;

function readBodyLimitBytes() {
  const configured = Number(process.env.REQUEST_BODY_LIMIT_MB);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_BODY_LIMIT_MB;
  return Math.floor(mb * 1024 * 1024);
}

const app = Fastify({
  logger: true,
  bodyLimit: readBodyLimitBytes()
});

app.register(require("@fastify/formbody"));

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
const TIMELINE_FILE = "enhanced_messages.json";
// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；保留原进程名，
// 只补 --update-env，避免用户改完推送配置却继续运行旧值。
const DEFAULT_RESTART_COMMAND = "pm2 restart gateway wake-up --update-env";
// 上游模型请求超时（毫秒），防止上游挂起时 /v1 请求永久阻塞
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // 批注 2026-07-15：/v1/models 要暴露部署者实际配置的模型名；
  // 不能继续硬编码示例模型，否则 Kelivo 模型选择会和真实上游不一致。
  return String(process.env.MODEL_NAME || "gateway-model").trim() || "gateway-model";
}

// ========================
// 多模态消息处理
// ========================
function shouldForwardMultimodalContent() {
  // 批注 2026-07-15：默认把 Kelivo 的图片 content 数组原样交给视觉模型；
  // 如果上游不是多模态模型，部署者仍可显式设 MULTIMODAL_MODE=text 退回旧的 [图片] 占位模式。
  const mode = (process.env.MULTIMODAL_MODE || "passthrough").trim().toLowerCase();
  return !["text", "plain", "placeholder", "false", "off", "0"].includes(mode);
}

function isDataImageUrl(value) {
  return typeof value === "string" && /^data:image\//i.test(value);
}

function isImageContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.image_url) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("image");
}

function isFileContentPart(part) {
  if (!part || typeof part !== "object") return false;
  if (part.file) return true;
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("file");
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return "[文件]";
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return "[文件]";
  return "[非文本内容]";
}

function stripKelivoSystemBloat(text) {
  const marker = '## search_web 工具使用说明';
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  return text.substring(0, idx).trimEnd();
}

function normalizeMessageForTimeline(msg) {
  const raw = normalizeContentToText(msg.content);
  const cleaned = msg.role === 'system' ? stripKelivoSystemBloat(raw) : raw;
  return { ...msg, content: cleaned };
}

// 动态注入内容的提示头：明确告诉模型这段是系统注入、用户不可见
const SYSTEM_NOTE_PREFIX = `（系统提示：以下内容${process.env.USER_DISPLAY_NAME || "用户"}不可见，仅供你参考）`;

// 时间注入配置：开关 + 间隔（分钟），从配置读取，配置台可调
function getTimeTagIntervalMinutes() {
  const fromCfg = Number(memoryEngine.getConfig ? memoryEngine.getConfig().time_tag_interval_minutes : 0);
  const fromEnv = Number(process.env.TIME_TAG_INTERVAL_MINUTES);
  const v = fromCfg > 0 ? fromCfg : (fromEnv > 0 ? fromEnv : 30);
  return Math.max(1, v);
}
function timeInjectionEnabled() {
  const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
  return cfg.time_injection_enabled !== false;
}

// 记忆检索开关（对话时）：关闭后对话不再自动检索并注入记忆；唤醒时另有独立开关
function memoryRetrievalEnabled() {
  const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
  return cfg.memory_retrieval_enabled !== false;
}
// 构建系统时间标签（注入到最后一条 user 之后；按间隔桶化，间隔内所有请求相同）
function buildSystemTimeTag() {
  const bucketMs = getTimeTagIntervalMinutes() * 60 * 1000;
  const now = new Date(Math.floor(Date.now() / bucketMs) * bucketMs);
  const parts = getDatePartsInTimeZone(now);
  const dayNames = ['周日','周一','周二','周三','周四','周五','周六'];
  // 星期必须按 TIME_ZONE 的日期计算，避免服务器本地时区与配置时区不一致时错一天
  const dayName = dayNames[new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay()] || '';
  const startHour = Number(process.env.WAKE_DAY_START_HOUR) || 10;
  const endHour = Number(process.env.WAKE_DAY_END_HOUR) || 24;
  const hour = Number(parts.hour);
  const period = (hour >= startHour && hour < endHour) ? '白天' : '夜晚';
  return `[当前系统时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${dayName} ${period}]`;
}

// 记忆浮现冷静期：冷静期内复用同一份记忆注入内容，避免每轮检索结果漂移
function getMemoryCooldownMinutes() {
  const fromCfg = Number(memoryEngine.getConfig ? memoryEngine.getConfig().memory_cooldown_minutes : 0);
  const fromEnv = Number(process.env.MEMORY_COOLDOWN_MINUTES);
  const v = fromCfg > 0 ? fromCfg : (fromEnv > 0 ? fromEnv : 30);
  return Math.max(1, v);
}

// 单条记忆冷却：同一条记忆冷却期内不重复浮现（0=关闭），避免“同一记忆反复冒出来”
function getMemoryItemCooldownMinutes() {
  const fromCfg = Number(memoryEngine.getConfig ? memoryEngine.getConfig().memory_item_cooldown_minutes : 0);
  const fromEnv = Number(process.env.MEMORY_ITEM_COOLDOWN_MINUTES);
  const v = fromCfg > 0 ? fromCfg : (fromEnv > 0 ? fromEnv : 120);
  return Math.max(0, v);
}

function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") {
    // 系统时间不再追加到 system prompt，改为动态注入到最后一条 user 之后（方案A）
    let content = stripKelivoSystemBloat(normalizeContentToText(msg.content));
    return { ...msg, content };
  }
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) return msg;

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

function sanitizeForLog(value) {
  if (typeof value === "string") {
    if (isDataImageUrl(value)) {
      const commaIndex = value.indexOf(",");
      const prefix = commaIndex >= 0 ? value.slice(0, commaIndex + 1) : value.slice(0, 40);
      return `${prefix}[base64 image omitted]`;
    }
    if (value.length > 1000) return `${value.slice(0, 1000)}... [truncated ${value.length - 1000} chars]`;
    return value;
  }

  if (Array.isArray(value)) return value.map(sanitizeForLog);

  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeForLog(child);
    }
    return sanitized;
  }

  return value;
}

function summarizeMessageForLog(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [msg?.content];
  const textChars = parts.reduce((sum, part) => sum + getTextFromContentPart(part).length, 0);
  return {
    role: msg?.role || "",
    content_type: Array.isArray(msg?.content) ? "multimodal" : typeof msg?.content,
    text_chars: textChars || normalizeContentToText(msg?.content).length,
    image_parts: parts.filter(isImageContentPart).length,
    file_parts: parts.filter(isFileContentPart).length,
    tool_calls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
  };
}

function summarizeMessagesForLog(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let imageParts = 0;
  let fileParts = 0;
  let textChars = 0;
  for (const msg of list) {
    const item = summarizeMessageForLog(msg);
    roles[item.role] = (roles[item.role] || 0) + 1;
    imageParts += item.image_parts;
    fileParts += item.file_parts;
    textChars += item.text_chars;
  }
  return { total: list.length, roles, text_chars: textChars, image_parts: imageParts, file_parts: fileParts };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ========================
// Streaming tag filter helper
// 上游（如 DeepSeek）会把 <memory>/<pin> 拆成 <、memory、> 等多个 SSE 事件，
// 字节层找不到完整标签，必须在 content 文本层做带缓冲的过滤。
// ========================
function createContentTagFilter() {
  let buf = "";
  let inTag = false;
  let tagType = ""; // "memory" | "pin"

  // 判断 tail（从某个 "<" 开始的小写文本）是否可能是 memory/pin 开标签
  function isPotentialOpen(tail) {
    if (/^<(memory|pin)(\s[^>]*)?>/.test(tail)) return true; // 完整开标签（可带属性）
    if (/^<(memory|pin)\s[^>]*$/.test(tail)) return true;     // 属性写法进行中
    if (/^<(memory|pin)$/.test(tail)) return true;            // 恰好 <memory / <pin
    if (/^<m(?:e(?:m(?:o(?:r)?)?)?)?$/.test(tail)) return true; // <m <me <mem <memo <memor
    if (/^<p(?:i)?$/.test(tail)) return true;                  // <p <pi
    if (tail === "<") return true;
    return false;
  }

  // 找到最早的可能是标签开头的 "<"
  function findOpenIndex(str) {
    const lower = str.toLowerCase();
    const candidates = [];
    const re = /<(?=[mp])/g;
    let m;
    while ((m = re.exec(lower)) !== null) {
      candidates.push(m.index);
      if (candidates.length >= 20) break;
    }
    const lastLt = lower.lastIndexOf("<");
    if (lastLt !== -1 && !candidates.includes(lastLt)) candidates.push(lastLt);
    candidates.sort((a, b) => a - b);
    for (const idx of candidates) {
      if (isPotentialOpen(lower.slice(idx))) return idx;
    }
    return -1;
  }

  return {
    push(delta, emit) {
      if (!delta) return;
      buf += delta;
      for (;;) {
        if (inTag) {
          const closeRe = tagType === "memory" ? /<\/memory>/i : /<\/pin>/i;
          const m = closeRe.exec(buf);
          if (m) {
            buf = buf.slice(m.index + m[0].length);
            inTag = false;
            tagType = "";
            continue;
          }
          // 未闭合：只保留尾部，防止无限增长
          if (buf.length > 8192) buf = buf.slice(-8192);
          return;
        }
        const open = findOpenIndex(buf);
        if (open !== -1) {
          if (open > 0) emit(buf.slice(0, open));
          buf = buf.slice(open);
          if (/^<(memory|pin)(\s[^>]*)?>/.test(buf.toLowerCase())) {
            inTag = true;
            tagType = buf.toLowerCase().startsWith("<pin") ? "pin" : "memory";
          }
          return;
        }
        if (buf) {
          emit(buf);
          buf = "";
        }
        return;
      }
    },
    flush() {
      // 丢弃未闭合标签或可疑前缀，避免半截标签发给客户端
      buf = "";
      inTag = false;
      tagType = "";
    }
  };
}

// ========================
// 读取 timeline
// ========================
function loadTimeline() {
  if (!fs.existsSync(TIMELINE_FILE)) return [];
  try {
    return fs.readJsonSync(TIMELINE_FILE);
  } catch (err) {
    // 文件损坏时先备份再按空时间线处理，避免被下一次保存静默覆盖
    try {
      const bak = TIMELINE_FILE + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-");
      fs.copySync(TIMELINE_FILE, bak);
      console.error("[timeline] 时间线文件损坏，已备份到 " + bak + "，本次按空时间线处理:", err.message);
    } catch (bakErr) {}
    return [];
  }
}

// 原子写入：先写临时文件再 rename，避免进程被杀/崩溃时把 JSON 写坏
function atomicWriteJsonSync(file, data) {
  const tmp = file + ".tmp";
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, file);
}

function atomicWriteFileSync(file, content) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// ========================
// 保存 timeline（保留 SP）
// ========================
function saveTimeline(messages) {
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  // 不再截断：完全保留客户端发送的全部消息（仅将 SP 放在首位）
  const final = sp ? [sp, ...nonSP] : nonSP;
  atomicWriteJsonSync(TIMELINE_FILE, final);
}

// ========================
// 提取时间戳（支持多种格式）
// ========================
function parseTimestampLabel(value) {
  const text = String(value || "");
  const match = text.match(/^（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  // 批注 2026-07-30：Kelivo 写进消息前缀的是用户配置时区的墙上时间；
  // 公网/Railway 不能按服务器 UTC 解析，否则时间线和自动唤醒都会被推迟。
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function stripLeadingTimestamp(content) {
  // 批注 2026-07-15：兼容 Kelivo 有时把日期和时间贴在一起的前缀；
  // 旧格式 "YYYY-MM-DD HH:mm" 继续保留，新格式 "YYYY-MM-DDHH:mm" 不再导致时间记忆/排序失效。
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function extractTimestamp(content) {
  return parseTimestampLabel(content);
}

// 消息时间解析：优先使用已持久化的 time 字段，其次解析正文时间前缀
function extractTimestampWithMemory(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const fromContent = extractTimestamp(normalizeContentToText(msg.content));
  if (fromContent) return fromContent;
  return null;
}

// ========================
// 消息判断
// ========================
function isSpecialEvent(msg) {
  if (msg.role !== "assistant") return false;
  const c = normalizeContentToText(msg.content);
  // 批注 2026-07-11：推送渠道从 Bark 扩展到 ntfy；继续兼容早期时间线里的 Bark/宝宝事件，避免升级后旧唤醒事件丢失。
  const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
  return (
    c.includes("刚刚给宝宝发了 Bark") ||
    c.includes(`刚刚给${userDisplay}发了 Bark`) ||
    c.includes("自动唤醒：本次未发送 Bark") ||
    c.includes("自动唤醒：本次未发送推送") ||
    (c.includes(`刚刚给${userDisplay}发了`) && c.includes("推送")) ||
    (c.includes("刚刚给宝宝发了") && c.includes("推送")) ||
    c.includes("自动写了日记") ||
    c.includes("记忆浮现）")
  );
}

function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
}

function isSystemRule(msg) {
  if (msg.role === "system") return true;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return true;
  return false;
}

// ========================
// 构建 Timeline
// ========================
function buildTimeline(kelivoMessages) {
  const oldTimeline = loadTimeline();
  // position → 旧时间线消息，用于找回已保存的 time，避免历史消息每次都回落为服务器时间
  // 按 role+content 匹配旧时间线找回已保存的 time（position 在客户端增删后会错位，内容匹配更鲁棒）
  const oldByContent = new Map();
  for (const m of oldTimeline) {
    if (!m.time) continue;
    const key = m.role + "\u0000" + normalizeContentToText(m.content);
    if (!oldByContent.has(key)) oldByContent.set(key, m);
  }
  // 本批最后一条实时 user 消息（接收时刻≈真实时间，供唤醒判断使用）
  let lastUserFallback = null;
  function toValidDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  function resolveMessageTime(msg) {
    const direct = toValidDate(msg.time);
    if (direct) return direct;
    const old = oldByContent.get(msg.role + "\u0000" + normalizeContentToText(msg.content));
    const oldTime = toValidDate(old && old.time);
    if (oldTime) return oldTime;
    const fromContent = extractTimestampWithMemory(msg);
    if (fromContent) return fromContent;
    // 只有本批最后一条实时 user 消息才回填服务器接收时刻（Kelivo 实时推送≈真实时间）；
    // 其余消息不再盖伪时间，避免历史消息全部堆在同一时刻导致时间感失真
    if (lastUserFallback && msg === lastUserFallback) return new Date();
    return null;
  }
  function timeIsoOrUndefined(msg) {
    const d = resolveMessageTime(msg);
    return d ? d.toISOString() : undefined;
  }
  const newSystemMessages = kelivoMessages
    .filter(msg => msg.role === "system")
    .map(normalizeMessageForTimeline);
  const latestSP = newSystemMessages.length > 0 ? newSystemMessages[newSystemMessages.length - 1] : null;
  const oldSP = oldTimeline.find(msg => msg.role === "system");

  const newRealMessages = kelivoMessages
    .filter(isRealMessageForTimeline)
    .map(normalizeMessageForTimeline)
    .map(m => ({ ...m, _t: resolveMessageTime(m) }));

  const oldSpecialEvents = oldTimeline.filter(isSpecialEvent).sort((a, b) => {
    const timeA = extractTimestampWithMemory(a);
    const timeB = extractTimestampWithMemory(b);
    if (timeA && timeB) return timeA - timeB;
    return 0;
  });

  const merged = [...newRealMessages];
  for (const event of oldSpecialEvents) {
    const eventTime = extractTimestampWithMemory(event);
    if (!eventTime) { merged.push(event); continue; }
    let inserted = false;
    for (let i = 0; i < merged.length; i++) {
      const msgTime = merged[i]._t || extractTimestampWithMemory(merged[i]);
      if (msgTime && msgTime >= eventTime) {
        merged.splice(i, 0, event);
        inserted = true;
        break;
      }
    }
    if (!inserted) merged.push(event);
  }

  const seen = new Set();
  const unique = merged.filter(msg => {
    const key = JSON.stringify({ role: msg.role, content: msg.content });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  lastUserFallback = [...unique].reverse().find(m => m.role === "user") || null;

  const result = [];
  if (latestSP) result.push({ ...latestSP, position: 0, time: timeIsoOrUndefined(latestSP) });
  else if (oldSP) result.push({ ...oldSP, position: 0, time: timeIsoOrUndefined(oldSP) });

  let realPos = 1;
  const finalMessages = [];
  let pendingSpecial = [];
  for (const msg of unique) {
    if (isSpecialEvent(msg)) {
      pendingSpecial.push(msg);
    } else {
      if (pendingSpecial.length > 0) {
        const prevRealPos = realPos - 1;
        const step = 1 / (pendingSpecial.length + 1);
        for (let i = 0; i < pendingSpecial.length; i++) {
          const { _t: _t1, ...cleanEvent } = pendingSpecial[i];
      finalMessages.push({ ...cleanEvent, position: parseFloat((prevRealPos + step * (i + 1)).toFixed(4)), time: timeIsoOrUndefined(pendingSpecial[i]) });
        }
        pendingSpecial = [];
      }
      const { _t, ...cleanMsg } = msg;
      finalMessages.push({ ...cleanMsg, position: realPos, time: timeIsoOrUndefined(msg) });
      realPos++;
    }
  }
  if (pendingSpecial.length > 0) {
    const lastRealPos = realPos - 1;
    for (let i = 0; i < pendingSpecial.length; i++) {
      const { _t: _t3, ...cleanEventTail } = pendingSpecial[i];
      finalMessages.push({ ...cleanEventTail, position: parseFloat((lastRealPos + 0.3 * (i + 1)).toFixed(4)), time: timeIsoOrUndefined(pendingSpecial[i]) });
    }
  }

  result.push(...finalMessages);
  return result;
}


// ========================
// 追加特殊事件
// ========================
function appendSpecialEvent(content) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5, time: new Date().toISOString() };
  timeline.push(newEvent);
  saveTimeline(timeline);
  // 批注 2026-07-15：特殊事件可能包含推送正文；日志只记录长度，避免公开部署时泄漏私密内容。
  console.log(`\n已记录特殊事件 (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}

// ========================
// 记忆浮现写入对话：把浮现的记忆作为特殊事件写入对话记录，永久留在上下文
// （同一记忆只写入一次，避免对话记录被同一段记忆反复刷屏）
// ========================
const surfacedMemoryEventIds = new Set();
function buildMemoryEventContent(memories) {
  const timeStr = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  const body = memories.map(m => memoryEngine.formatContext([m])).join("\n");
  return `（${timeStr} 记忆浮现）\n${body}`;
}
function insertMemoriesToConversation(memories) {
  const freshOnes = memories.filter(m => m && m.id && typeof m.content === "string" && m.content && !surfacedMemoryEventIds.has(m.id));
  if (freshOnes.length === 0) return 0;
  appendSpecialEvent(buildMemoryEventContent(freshOnes));
  freshOnes.forEach(m => surfacedMemoryEventIds.add(m.id));
  return freshOnes.length;
}

// 剥离内部标签（用于把客户端清洗版和时间线原始版互相匹配）
function stripInternalTags(text) {
  return tagParser.stripTags(text).trim();
}

// 剥离 [DIARY] 块（成对或未闭合）：日记已通过 diary 字段单独记录，避免原始标签/重复文本进入上下文
function stripDiaryBlocks(text) {
  return String(text || "")
    .replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, "")
    .replace(/\[DIARY\][\s\S]*$/i, "")
    .replace(/\[DIARY\]|\[\/DIARY\]/gi, "")
    .trim();
}

function stripPosition(messages) {
  // 只保留消息正文，剥离内部排序与时间字段（与 wake_up.js 保持一致，避免内部字段外泄）
  return messages.map(({ position, time, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;
const recentInjectedMemoryIds = new Map(); // 记忆级冷却：id -> 上次注入时间戳，避免同一记忆反复浮现
// 记忆浮现冷静期缓存：冷静期内复用同一份“时间+记忆”注入内容
let memoryInjectionCache = null;
const RECENT_MEMORY_TTL = 30 * 60 * 1000;
let lastLLMMessages = null;
let lastLLMCaptureTime = null;

// ========================
// 预设方案
// ========================
const PRESETS_FILE = "./presets.json";
const ENV_FILE = ".env";
const PREFERRED_ENV_ORDER = [
  "TARGET_API_URL",
  "TARGET_API_KEY",
  "GATEWAY_API_KEY",
  "MODEL_NAME",
  "BARK_KEY",
  "CUSTOM_ICON_URL",
  "ALLOW_PUBLIC_API",
  "PUSH_PROVIDER",
  "NTFY_SERVER_URL",
  "NTFY_TOPIC",
  "NTFY_TOKEN",
  "NTFY_PRIORITY",
  "NTFY_TAGS",
  "DIARY_ENABLED",
  "DIARY_DIR",
  "REQUEST_BODY_LIMIT_MB",
  "MULTIMODAL_MODE",
  "DAY_WAKE_AFTER_MINUTES",
  "NIGHT_WAKE_AFTER_MINUTES",
  "DAY_CHECK_INTERVAL_MINUTES",
  "NIGHT_CHECK_INTERVAL_MINUTES",
  "WAKE_DAY_START_HOUR",
  "WAKE_DAY_END_HOUR",
  "WEATHER_ENABLED",
  "WEATHER_LOCATION_NAME",
  "WEATHER_LAT",
  "WEATHER_LON",
  "WEATHER_UNITS",
  "PORT",
  "GATEWAY_BASE_URL",
  "TIME_ZONE",
  "RESTART_COMMAND",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];

function loadPresets() {
  if (!fs.existsSync(PRESETS_FILE)) return [];
  try { return fs.readJsonSync(PRESETS_FILE); } catch { return []; }
}

function savePresets(presets) {
  atomicWriteJsonSync(PRESETS_FILE, presets);
}

function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

function loadEnvFileObject() {
  const result = {};
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  } catch {}
  return result;
}

function serializeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n");
}

function writeEnvUpdates(updates) {
  const merged = { ...loadEnvFileObject(), ...updates };
  const orderedKeys = [
    ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
    ...Object.keys(merged)
      .filter(key => !PREFERRED_ENV_ORDER.includes(key))
      .sort()
  ];
  const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
  atomicWriteFileSync(ENV_FILE, lines.join("\n") + "\n");
}

function readRestartCommand() {
  return readEnvValue("RESTART_COMMAND") || DEFAULT_RESTART_COMMAND;
}

// ========================
// 安全：放行 /admin，其他仅本地/局域网
// ========================
app.addHook("onRequest", (req, reply, done) => {
  if (req.url.startsWith("/admin")) return done();
  // 内部接口（唤醒事件/心跳/测试推送）：若配置了 INTERNAL_API_KEY 则必须携带
  const isInternalPath = req.url.startsWith("/internal/") || req.url.startsWith("/test-bark");
  if (isInternalPath) {
    const internalKey = readEnvValue("INTERNAL_API_KEY");
    if (internalKey) {
      const supplied = String(req.headers["x-internal-key"] || "").trim();
      if (supplied !== internalKey) {
        reply.code(401).send({ error: "Invalid internal key" });
        return;
      }
      return done();
    }
  }
  // 批注 2026-07-15：公网部署常经过反代，真实公网请求可能在 Node 侧显示为 127/10 网段；
  // 所以 ALLOW_PUBLIC_API=true 后必须先验 /v1 的网关 key，避免被云平台内网 IP 绕过。
  if (readBooleanEnv("ALLOW_PUBLIC_API", false) && req.url.startsWith("/v1/")) {
    const configuredKey = readEnvValue("GATEWAY_API_KEY");
    if (!configuredKey) {
      reply.code(401).send({ error: "公网 /v1 已开启，但 GATEWAY_API_KEY 未配置" });
      return;
    }
    const auth = String(req.headers.authorization || "");
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    const headerKey = String(req.headers["x-gateway-api-key"] || req.headers["x-api-key"] || "").trim();
    if (bearer === configuredKey || headerKey === configuredKey) return done();
    // 批注 2026-07-30：Kelivo 可能在模型探测或旧预设里继续带错 key；
    // 只记路径和 header 类型，帮助排查缓存/重复请求，绝不把任意密钥写入日志。
    console.warn(JSON.stringify({
      event: "gateway_auth_rejected",
      path: req.url.split("?")[0],
      auth_source: bearer ? "bearer" : headerKey ? "x-api-key" : "missing"
    }));
    reply.code(401).send({ error: "Gateway API Key 无效或缺失" });
    return;
  }
  // 客户端真实 IP：只有直连来源是可信内网（本机/内网）时才信任 nginx 转发的
  // X-Real-IP / X-Forwarded-For，避免公网直连时伪造转发头绕过内网判断。
  const rawIp = req.ip || req.connection.remoteAddress || "";
  // Node 双栈环境下 IPv4 常被映射为 ::ffff:x.x.x.x，先归一化再判断
  const directIp = String(rawIp).replace(/^::ffff:/i, "");
  const isLocalPeer = directIp === "127.0.0.1" || directIp === "::1" || directIp === "localhost" || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(directIp);
  let ip = directIp;
  if (isLocalPeer) {
    const realIp = String(req.headers["x-real-ip"] || "").trim();
    if (realIp) {
      ip = String(realIp).replace(/^::ffff:/i, "");
    } else {
      const xff = String(req.headers["x-forwarded-for"] || "").trim();
      if (xff) {
        const parts = xff.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length > 0) ip = String(parts[parts.length - 1]).replace(/^::ffff:/i, "");
      }
    }
  }
  const isTrustedNetwork = ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  if (isTrustedNetwork) return done();
  reply.code(403).send("Forbidden");
});

// ========================
// Models
// ========================
app.get("/v1/models", async (req, reply) => {
  reply.send({
    object: "list",
    data: [{ id: configuredModelName(), object: "model", created: 0, owned_by: "gateway" }]
  });
});

// ========================
// Chat Completions
// ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    // 批注 2026-07-15：公开部署时日志不能默认写入完整上下文；
    // 这里只保留请求摘要，避免 system prompt、记忆和聊天正文进入 pm2 日志。
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];

    const oldTimeline = loadTimeline();

    const finalTimeline = buildTimeline(kelivoMessages);
    // 防误伤：请求未携带任何真实消息（空 body/探活请求）时不覆盖已有时间线，
    // 避免一次异常请求把完整历史冲成空壳（时间线以客户端完整历史为源）
    if (kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0) {
      saveTimeline(finalTimeline);
    } else {
      console.log("[timeline] 请求未包含真实消息，跳过时间线保存");
    }

    // Kelivo 发图时 content 常是数组。默认原样透传给视觉模型；
    // 如上游不支持图片，可设置 MULTIMODAL_MODE=text 退回文本占位。
    let llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);

    // 用时间线里的原始回复替换客户端清洗过的版本，保留 <memory>/<pin> 标签：
    // 模型能看到自己写过什么，管理台上下文窗口也能审查。
    // 匹配方式：时间线回复去掉内部标签后与客户端内容比对。
    {
      const rawByClean = new Map();
      for (const m of finalTimeline) {
        if (m.role !== "assistant" || isSpecialEvent(m) || typeof m.content !== "string") continue;
        const clean = stripInternalTags(m.content).trim();
        if (clean && !rawByClean.has(clean)) rawByClean.set(clean, m);
      }
      llmMessages = llmMessages.map(m => {
        if (m.role !== "assistant" || typeof m.content !== "string") return m;
        const raw = rawByClean.get(String(m.content).trim());
        return raw && raw.content !== m.content ? { ...m, content: raw.content } : m;
      });
    }


    // 特殊事件按时间定位插入：客户端消息不带 time 字段，
    // 先用 finalTimeline 里已解析/恢复的时间建立 内容->时间 映射，保证事件能落到对应时间位置
    const timeByKey = new Map();
    for (const m of finalTimeline) {
      if (isSpecialEvent(m)) continue;
      const key = m.role + "\u0000" + normalizeContentToText(m.content);
      const t = extractTimestampWithMemory(m);
      if (t && !timeByKey.has(key)) timeByKey.set(key, t);
    }
    const oldEvents = stripPosition(finalTimeline.filter(isSpecialEvent));

    console.log("本次注入的特殊事件数量:", oldEvents.length);

    for (const event of oldEvents) {
      const eventTime = extractTimestampWithMemory(event);
      if (!eventTime) { llmMessages.push(event); continue; }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const m = llmMessages[i];
        let msgTime = timeByKey.get(m.role + "\u0000" + normalizeContentToText(m.content));
        if (!msgTime) msgTime = extractTimestampWithMemory(m);
        if (msgTime && msgTime >= eventTime) {
          llmMessages.splice(i, 0, event);
          inserted = true;
          break;
        }
      }
      if (!inserted) llmMessages.push(event);
    }


    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    // (trim 逻辑移至 lastLLMMessages 捕获处，避免误删当前用户请求)

    if (!TARGET_API_URL || !process.env.TARGET_API_KEY) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;

    // ========================
    // 永久注入上下文：pinned context 注入 system prompt
    // ========================
    try {
      const pinnedCtx = memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : '';
      if (pinnedCtx) {
        const pinnedBlock = '\n\n## 永久上下文\n' + pinnedCtx;
        const sysIdx = llmMessages.findIndex(m => m.role === "system");
        if (sysIdx >= 0) {
          llmMessages[sysIdx].content = llmMessages[sysIdx].content + pinnedBlock;
        } else {
          llmMessages.unshift({ role: "system", content: pinnedBlock.trim() });
        }
        console.log('[pinned] 注入永久上下文');
      }
    } catch (pinErr) {
      console.warn('[pinned] 注入失败:', pinErr.message);
    }

    // ========================
    // 记忆浮现：冷静期内复用同一份注入内容，冷静期过后才重新检索
    // ========================
    try {
      // 取最后 N 条对话消息（user + assistant 混合，按原顺序拼接）
      const dialogMsgs = kelivoMessages.filter(m =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
      );
      if (dialogMsgs.length > 0) {
        // 记忆检索总开关：关闭时清空冷静期缓存，避免旧记忆继续注入
        if (!memoryRetrievalEnabled()) memoryInjectionCache = null;
        const now = Date.now();
        // 冷静期内直接复用缓存内容，保证请求体尾部稳定
        const reused = memoryRetrievalEnabled() && memoryInjectionCache && now < memoryInjectionCache.expiresAt;
        let dynContent = reused ? memoryInjectionCache.content : null;
        if (dynContent === null && memoryRetrievalEnabled()) {
          // 冷静期已过：重新检索相关记忆并刷新缓存
          const cfg = memoryEngine.getConfig();
          const windowSize = cfg.memory_query_window || 3;
          const recentMsgs = dialogMsgs.slice(-windowSize);
          const query = recentMsgs.map(m => m.content).join(" ");
          const memResults = await memoryEngine.buildContext(query, {
            minSummaryAgeHours: cfg.summary_surfacing_min_age_enabled === false ? 0 : (Number(cfg.summary_surfacing_min_age_hours) || 0)
          });
          if (memResults.length > 0) {
            const threshold = cfg.memory_relevance_threshold || 0.3;
            const relevant = memResults.filter(m => (m._score || 0) >= threshold);
            // 单条记忆冷却：同一条记忆冷却期内不重复浮现
            const itemCooldownMs = getMemoryItemCooldownMinutes() * 60 * 1000;
            const fresh = relevant.filter(m => {
              const last = recentInjectedMemoryIds.get(m.id);
              return last === undefined || (now - last) >= itemCooldownMs;
            });
            if (fresh.length > 0) {
              const memStr = memoryEngine.formatContext(fresh);
              // 浮现记忆作为独立 system 消息，插到最后一条 user 之后；启用时间注入时带上时间
              const timeTag = timeInjectionEnabled() ? buildSystemTimeTag() : '';
              dynContent = timeTag
                ? `${SYSTEM_NOTE_PREFIX}\n\n${timeTag}\n\n## 相关记忆\n${memStr}`
                : `${SYSTEM_NOTE_PREFIX}\n\n## 相关记忆\n${memStr}`;
              memoryInjectionCache = { content: dynContent, expiresAt: now + getMemoryCooldownMinutes() * 60 * 1000 };
              console.log(`[memory] 重新检索并缓存记忆浮现（冷静期 ${getMemoryCooldownMinutes()} 分钟，单条冷却 ${getMemoryItemCooldownMinutes()} 分钟，浮现 ${fresh.length} 条，阈值: ${threshold}）`);
              fresh.forEach(m => recentInjectedMemoryIds.set(m.id, now));
              // 记忆浮现写入对话：开启时，本次浮现的记忆写入对话记录，永久留在上下文
              if (cfg.memory_persist_on_surface_enabled) {
                try {
                  const inserted = insertMemoriesToConversation(fresh);
                  if (inserted > 0) console.log(`[memory] 浮现记忆已写入对话 ${inserted} 条`);
                } catch (convErr) {
                  console.warn("[memory] 浮现记忆写入对话失败:", convErr.message);
                }
              }
              // 清理已过冷却期的记录，防止 Map 无限膨胀
              for (const [id, ts] of recentInjectedMemoryIds) {
                if (now - ts >= itemCooldownMs) recentInjectedMemoryIds.delete(id);
              }
              // 仍超限时保留最新的 50 条
              if (recentInjectedMemoryIds.size > 100) {
                const entries = Array.from(recentInjectedMemoryIds.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50);
                recentInjectedMemoryIds.clear();
                entries.forEach(([id, ts]) => recentInjectedMemoryIds.set(id, ts));
              }
            }
          }
        }
        if (dynContent !== null) {
          // 消息中已存在完全相同内容则跳过，避免重复注入
          const alreadyInjected = llmMessages.some(m => m.role === "system" && typeof m.content === "string" && m.content === dynContent);
          if (alreadyInjected) {
            console.log("[memory] 复用冷静期记忆注入（内容已存在，跳过）");
          } else {
            // 记忆浮现内容是否保留（默认保留：避免每轮移除/重插导致前缀缓存断裂）
            const stickyMemories = process.env.MEMORY_STICKY !== '0';
            if (!stickyMemories) {
              // 移除旧的动态 system 消息（避免重复）
              for (let i = llmMessages.length - 1; i >= 0; i--) {
                if (llmMessages[i].role === "system" && typeof llmMessages[i].content === "string" && llmMessages[i].content.includes("## 相关记忆")) {
                  llmMessages.splice(i, 1);
                }
              }
            } else {
              // 保留模式：只在上限超限时移除最旧的一条（会带来一次缓存 miss，但避免上下文无限膨胀）
              const maxSticky = Math.max(1, parseInt(process.env.MEMORY_MAX_STICKY || '50', 10) || 50);
              const memIdx = [];
              for (let i = 0; i < llmMessages.length; i++) {
                if (llmMessages[i].role === "system" && typeof llmMessages[i].content === "string" && llmMessages[i].content.includes("## 相关记忆")) {
                  memIdx.push(i);
                }
              }
              if (memIdx.length >= maxSticky) {
                llmMessages.splice(memIdx[0], 1);
                console.log(`[memory] 保留模式超限，移除最旧记忆 (${memIdx.length} -> ${memIdx.length - 1})`);
              }
            }
            // 找到最后一条 user 消息索引
            let lastUserIdx = -1;
            for (let i = llmMessages.length - 1; i >= 0; i--) {
              if (llmMessages[i].role === "user") { lastUserIdx = i; break; }
            }
            // 在最后一条 user 之后插入动态 system 消息
            if (lastUserIdx >= 0) {
              llmMessages.splice(lastUserIdx + 1, 0, { role: "system", content: dynContent });
            } else {
              // 兜底：没有 user 消息时追加到末尾
              llmMessages.push({ role: "system", content: dynContent });
            }
            console.log(`[memory] 注入记忆（${reused ? '复用冷静期缓存' : '新检索'}）`);
          }
        }
      }
    } catch (memErr) {
      console.error("[memory] 浮现失败:", memErr.message);
    }
    // 时间注入：未注入记忆时补充系统时间（可配置开关与间隔）
    if (timeInjectionEnabled()) {
      const hasDynTime = llmMessages.some(m =>
        m.role === "system" && typeof m.content === "string" && m.content.includes("[当前系统时间")
      );
      if (!hasDynTime) {
        const timeTag = buildSystemTimeTag();
        let lastUserIdx2 = -1;
        for (let i = llmMessages.length - 1; i >= 0; i--) {
          if (llmMessages[i].role === "user") { lastUserIdx2 = i; break; }
        }
        if (lastUserIdx2 >= 0) {
          llmMessages.splice(lastUserIdx2 + 1, 0, { role: "system", content: `${SYSTEM_NOTE_PREFIX}\n\n${timeTag}` });
        }
      }
    }




    // 请求模型
    // Capture the actual messages sent to LLM for inspection
    lastLLMMessages = llmMessages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content || '')),
      tool_calls: m.tool_calls || undefined,
      tool_call_id: m.tool_call_id || undefined
    }));
    lastLLMCaptureTime = new Date().toISOString();




    // 管理台展示：保留完整消息序列（含动态注入），方便核对注入位置

    // 转发前只保留 OpenAI 兼容字段，剥离 Kelivo 自定义字段（position 等）
    const sanitizedMessages = llmMessages.map(msg => {
      const clean = { role: msg.role };
      if (msg.content !== undefined) clean.content = msg.content;
      if (msg.name !== undefined) clean.name = msg.name;
      if (msg.tool_calls !== undefined) clean.tool_calls = msg.tool_calls;
      if (msg.tool_call_id !== undefined) clean.tool_call_id = msg.tool_call_id;
      return clean;
    });


    // 上游请求超时保护，避免上游挂起导致 /v1 请求永久阻塞
    const upstreamController = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(TARGET_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TARGET_API_KEY}`
        },
        body: JSON.stringify({ ...body, messages: sanitizedMessages }),
        signal: upstreamController.signal
      });
    } catch (upstreamErr) {
      clearTimeout(upstreamTimer);
      throw upstreamErr;
    }

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // 批注 2026-07-11：Kelivo 关闭 stream 时需要收到普通 JSON；只在请求或上游确认为 SSE 时才按流式直通。
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      let finalResponseText = responseText;

      // 解析 AI 回复，提取 <memory> 标签存入记忆池，并清洗返回给用户的内容
      try {
        const parsed = JSON.parse(responseText);
        const aiContent = parsed.choices?.[0]?.message?.content || "";
        if (aiContent) {
          // 提取并存储记忆，同时拿到清洗后的文本
          const cleanText = await tagParser.extractAndStore(aiContent);
          // 用清洗后的文本替换 JSON 中的 content
          if (cleanText !== aiContent) {
            parsed.choices[0].message.content = cleanText;
            finalResponseText = JSON.stringify(parsed);
          }
          // 把 AI 回复追加到 kelivoMessages，然后重建时间线
          kelivoMessages.push({ role: "assistant", content: cleanText });
          const rebuilt = buildTimeline(kelivoMessages);
          saveTimeline(rebuilt);
          // 追加到待处理消息（供摘要引擎使用）
          const userMsgs = kelivoMessages.filter(m => m.role === "user" && typeof m.content === "string");
          if (userMsgs.length > 0) {
            // Only add the most recent user message (prevents duplicates across turns)
            const latestUser = userMsgs[userMsgs.length - 1];
            const pending = memoryEngine.getPendingMessages();
            const alreadyAdded = pending.some(m => m.role === "user" && m.content === latestUser.content);
            if (!alreadyAdded) {
              memoryEngine.addPendingMessage({ role: "user", content: latestUser.content });
            }
          }
          memoryEngine.addPendingMessage({ role: "assistant", content: cleanText });
          // 重置沉默计时器
          summaryEngine.resetIdleTimer();
        }
      } catch (parseErr) {
        console.warn("[memory] 非流式响应 JSON 解析失败:", parseErr.message);
      }

      clearTimeout(upstreamTimer);
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(finalResponseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    const streamChunks = [];
    try {
    // Streaming tag filter: 上游会把 <memory>/<pin> 拆成 <、memory、> 等多个事件，
    // 字节层匹配不到完整标签，必须在 content 文本层过滤后再重组 SSE 事件。
    const contentFilter = createContentTagFilter();
    const emitRawLine = (line) => reply.raw.write(line + "\n");
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamChunks.push(value);

      sseBuffer += Buffer.from(value).toString("utf-8");
      let nl;
      while ((nl = sseBuffer.indexOf("\n")) !== -1) {
        const rawLine = sseBuffer.slice(0, nl);
        sseBuffer = sseBuffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith("data:")) {
          emitRawLine(line);
          continue;
        }
        const payload = line.slice(5).replace(/^\s+/, "");
        if (!payload || payload === "[DONE]") {
          emitRawLine(line);
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          emitRawLine(line);
          continue;
        }
        const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
        // 空字符串 content 常伴随 finish_reason/usage（如末尾事件），必须原样透传
        if (delta && typeof delta.content === "string" && delta.content.length > 0) {
          contentFilter.push(delta.content, (filtered) => {
            delta.content = filtered;
            reply.raw.write("data: " + JSON.stringify(evt) + "\n\n");
          });
        } else {
          emitRawLine(line);
        }
      }
    }
    // 收尾：丢弃未闭合标签/残留前缀，转发剩余行，结束响应
    contentFilter.flush();
    if (sseBuffer) emitRawLine(sseBuffer.replace(/\n+$/, ""));
    reply.raw.end();
    } catch (streamErr) {
      // 上游中断/超时时确保响应结束，避免连接悬挂
      try { reply.raw.end(); } catch {}
      throw streamErr;
    } finally {
      clearTimeout(upstreamTimer);
    }

    // 流结束后解析 AI 回复
    try {
      const fullText = Buffer.concat(streamChunks).toString("utf-8");
      // 从 SSE 中提取完整的 AI 回复文本
      let aiFullContent = "";
      const lines = fullText.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const evt = JSON.parse(line.slice(6));
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) aiFullContent += delta;
            const finishContent = evt.choices?.[0]?.message?.content;
            if (finishContent) aiFullContent = finishContent;
            if (evt.usage) console.log("[usage] " + JSON.stringify(evt.usage));
          } catch {}
        }
      }
      if (aiFullContent) {
        // 提取并存储记忆，并拿到清洗后的文本
        const cleanFull = await tagParser.extractAndStore(aiFullContent).catch(err => {
          console.warn("[memory] 流式标签解析失败:", err.message);
          return aiFullContent;
        });
        // 把清洗后的 AI 回复追加到 kelivoMessages，然后重建时间线
        kelivoMessages.push({ role: "assistant", content: cleanFull });
        const rebuiltStream = buildTimeline(kelivoMessages);
        saveTimeline(rebuiltStream);
        // 追加到待处理消息
        const userMsgs = kelivoMessages.filter(m => m.role === "user" && typeof m.content === "string");
        if (userMsgs.length > 0) {
          // Only add the most recent user message (prevents duplicates across turns)
          const latestUser = userMsgs[userMsgs.length - 1];
          const pending = memoryEngine.getPendingMessages();
          const alreadyAdded = pending.some(m => m.role === "user" && m.content === latestUser.content);
          if (!alreadyAdded) {
            memoryEngine.addPendingMessage({ role: "user", content: latestUser.content });
          }
        }
        memoryEngine.addPendingMessage({ role: "assistant", content: cleanFull });
        // 重置沉默计时器
        summaryEngine.resetIdleTimer();
      }
    } catch (streamErr) {
      console.warn("[memory] 流式响应解析失败:", streamErr.message);
    }
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 内部接口：记录唤醒事件
// ========================
app.post("/internal/wake-event", async (req, reply) => {
  try {
    const { content, event, diary, memories } = req.body;
    if (!content && !event && !diary && !(Array.isArray(memories) && memories.length)) return reply.code(400).send({ error: "content or event is required" });
    if (Array.isArray(memories) && memories.length > 0) {
      // 记忆浮现写入对话：开启时，唤醒浮现的记忆随事件写入对话记录，永久留在上下文
      try {
        const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
        if (cfg.memory_persist_on_surface_enabled) {
          const inserted = insertMemoriesToConversation(memories.filter(m => m && m.id));
          if (inserted > 0) console.log(`[wake-event] 浮现记忆已写入对话 ${inserted} 条`);
        }
      } catch (memErr) {
        console.warn("[wake-event] 浮现记忆写入对话失败:", memErr.message);
      }
    }
    if (diary) {
      appendSpecialEvent(`（${formatDateTimeInTimeZone(new Date(), TIME_ZONE)} 自动写了日记：${String(diary).trim()}）`);
    }
    if (event) {
      appendSpecialEvent(event);
      try {
        memoryEngine.addPendingMessage({ role: "assistant", content: event });
      } catch (memErr) {
        console.warn("[wake-event] 记忆系统写入失败:", memErr.message);
      }
    }
    if (content) {
      // 先解析记忆标签，存储清洗后的文本，避免 <memory> 原始标签进入上下文/事件
      let stored = stripDiaryBlocks(String(content).trim());
      try {
        const cleaned = await tagParser.extractAndStore(content);
        if (cleaned) stored = stripDiaryBlocks(cleaned);
      } catch (e) {
        console.warn("[wake-event] 标签解析失败:", e.message);
      }
      if (stored) {
        appendSpecialEvent(stored);
        memoryEngine.addPendingMessage({ role: "assistant", content: stored });
      }
    }
    reply.send({ success: true });
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 读取 .env 值
// ========================
function readEnvValue(key) {
  // 批注 2026-07-30：Railway Variables 是云端部署的权威配置源；
  // 容器内 .env 只作兜底，避免管理页保存出的临时文件覆盖平台变量。
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  try {
    const envContent = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

function normalizePositiveInteger(value, key, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeHour(value, key, fallback, min, max) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= min && n <= max) return String(Math.floor(n));
  return readEnvValueOrDefault(key, fallback);
}

function normalizeBooleanString(value, key, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return "true";
  if (["false", "0", "no", "off"].includes(raw)) return "false";
  return readEnvValueOrDefault(key, fallback);
}

function normalizeWeatherUnits(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "fahrenheit") return "fahrenheit";
  if (raw === "metric" || raw === "celsius") return "metric";
  // 空值或非法值：保留 .env 原配置，避免保存表单时把单位意外重置
  return readEnvValueOrDefault("WEATHER_UNITS", "metric");
}

function diaryDirectoryPath() {
  const configured = readEnvValueOrDefault("DIARY_DIR", "diary");
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function readDiaryEntries(limit = 20) {
  const dir = diaryDirectoryPath();
  try {
    if (!fs.existsSync(dir)) return [];
    // 批注 2026-07-15：管理页只读展示 wake-up 生成的本地日记；
    // 只读取 DIARY_DIR 下的 .md 文件，避免把任意路径内容暴露到 admin 页面。
    return fs.readdirSync(dir)
      .filter(name => /^[^/\\]+\.md$/i.test(name))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit)
      .map(name => {
        const filePath = path.join(dir, name);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8").slice(0, 24000);
        return { name, updated_at: stat.mtime.toISOString(), content };
      });
  } catch (err) {
    return [{ name: "读取日记失败", updated_at: new Date().toISOString(), content: err.message || String(err) }];
  }
}

// ========================
// HTTP Basic Auth
// ========================
// ========================
// 管理台会话（记住登录）
// ========================
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_SECRET_FILE = path.join(__dirname, "data", "session_secret.txt");
let sessionSecret = null;
function getSessionSecret() {
  if (sessionSecret) return sessionSecret;
  try {
    const saved = fs.readFileSync(SESSION_SECRET_FILE, "utf-8").trim();
    if (saved) {
      sessionSecret = saved;
      return saved;
    }
  } catch (e) {}
  sessionSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
  } catch (e) {}
  return sessionSecret;
}
function createSessionToken() {
  const exp = Date.now() + SESSION_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const payload = `${exp}.${process.env.ADMIN_USER}`;
  const sig = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function validSessionToken(token) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expS, user, sig] = parts;
  if (user !== process.env.ADMIN_USER) return false;
  if (!/^\d+$/.test(expS) || Number(expS) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(`${expS}.${user}`).digest("hex");
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch (e) {
      out[key] = val;
    }
  }
  return out;
}
function adminBasePath(req) {
  return req.url.startsWith("/heartbeat/admin") ? "/heartbeat/admin" : "/admin";
}
function isAuthorized(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.admin_session && validSessionToken(cookies.admin_session)) return true;
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  return user === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD;
}

function basicAuth(req, reply, done) {
  if (isAuthorized(req)) {
    done();
    return;
  }
  reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
}

function mobileAuth(req, reply, done) {
  if (isAuthorized(req)) {
    done();
    return;
  }
  reply.redirect(adminBasePath(req) + "/mobile/login");
}

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理台登录</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{width:100%;max-width:360px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
  h1{font-size:20px;margin-bottom:6px}
  p.sub{font-size:13px;color:#888;margin-bottom:24px}
  label{display:block;font-size:13px;color:#555;margin:14px 0 6px}
  input{width:100%;padding:11px 12px;border:1px solid #dde1e7;border-radius:10px;font-size:15px;outline:none}
  input:focus{border-color:#6c8cff}
  button{width:100%;margin-top:24px;padding:12px;border:none;border-radius:10px;background:#4a6cf7;color:#fff;font-size:16px;cursor:pointer}
  button:active{opacity:.85}
  .err{background:#fdecec;color:#c0392b;font-size:13px;padding:10px 12px;border-radius:8px;margin-top:16px}
  .hint{font-size:12px;color:#aaa;margin-top:14px;text-align:center}
</style>
</head>
<body>
  <form class="card" method="post" action="">
    <h1>管理台</h1>
    <p class="sub">登录后 30 天内免登录</p>
    <label>用户名</label>
    <input type="text" name="user" autocomplete="username" required autofocus>
    <label>密码</label>
    <input type="password" name="password" autocomplete="current-password" required>
    <!--ERROR-->
    <button type="submit">登 录</button>
    <p class="hint">登录状态保留 30 天，仅本机浏览器有效</p>
  </form>
</body>
</html>`;

// ========================
// 管理台登录接口
// ========================
app.get("/admin/mobile/login", async (req, reply) => {
  reply.type("text/html").send(LOGIN_PAGE_HTML.replace("<!--ERROR-->", ""));
});

app.post("/admin/mobile/login", async (req, reply) => {
  const body = req.body || {};
  const ok = String(body.user || "") === process.env.ADMIN_USER
    && String(body.password || "") === process.env.ADMIN_PASSWORD;
  if (ok) {
    reply.header("Set-Cookie", `admin_session=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`);
    reply.redirect(adminBasePath(req) + "/mobile");
    return;
  }
  await new Promise(r => setTimeout(r, 500));
  reply.type("text/html").send(LOGIN_PAGE_HTML.replace("<!--ERROR-->", '<div class="err">用户名或密码错误</div>'));
});

// ========================
// 管理页面 GET /admin
// ========================
// 管理台入口：桌面版已移除，统一跳转到移动端管理台
app.get("/admin", { preHandler: mobileAuth }, async (req, reply) => {
  reply.redirect(adminBasePath(req) + "/mobile");
});

app.post("/admin/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const {
      target_url,
      target_key,
      gateway_api_key,
      model_name,
      bark_key,
      custom_icon,
      day_wake_after,
      night_wake_after,
      day_check_interval,
      night_check_interval,
      wake_day_start_hour,
      wake_day_end_hour,
      weather_enabled,
      weather_location_name,
      weather_lat,
      weather_lon,
      weather_units
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    // 批注 2026-06-26：公开版把唤醒策略和天气信息开放到管理页；保存时做轻量校验，避免空值把运行中的唤醒节奏写坏。
    // 批注 2026-07-15：GATEWAY_API_KEY 是公开 /v1 的客户端鉴权 key，不能和上游 TARGET_API_KEY 混在一起展示或返回。
    writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon || "",
      DAY_WAKE_AFTER_MINUTES: normalizePositiveInteger(day_wake_after, "DAY_WAKE_AFTER_MINUTES", "60"),
      NIGHT_WAKE_AFTER_MINUTES: normalizePositiveInteger(night_wake_after, "NIGHT_WAKE_AFTER_MINUTES", "120"),
      DAY_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(day_check_interval, "DAY_CHECK_INTERVAL_MINUTES", "10"),
      NIGHT_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(night_check_interval, "NIGHT_CHECK_INTERVAL_MINUTES", "120"),
      WAKE_DAY_START_HOUR: normalizeHour(wake_day_start_hour, "WAKE_DAY_START_HOUR", "10", 0, 23),
      WAKE_DAY_END_HOUR: normalizeHour(wake_day_end_hour, "WAKE_DAY_END_HOUR", "24", 1, 24),
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name || "",
      WEATHER_LAT: weather_lat || "",
      WEATHER_LON: weather_lon || "",
      WEATHER_UNITS: normalizeWeatherUnits(weather_units),
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });
    console.log("\n✅ .env 已更新，可通过管理页重启服务\n");

    if (wantsJsonResponse(req)) {
      return reply.send({ success: true });
    }

    reply.type("text/html").send(`<!DOCTYPE html>
<html lang="zh">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>已保存</title></head>
<body style="text-align:center;font-family:-apple-system,sans-serif;padding:40px;">
  <h2>✅ 配置已保存</h2>
  <p>现在可以返回管理页，点击重启按钮让新配置生效。</p>
  <a href="/admin">← 返回设置</a>
</body></html>`);
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 保存预设方案
// ========================
app.post("/admin/presets/save", { preHandler: basicAuth }, async (req, reply) => {
  const { name, target_url, target_key, model_name } = req.body || {};
  if (!name || !target_url || !model_name) {
    return reply.code(400).send({ error: "name / target_url / model_name 必填" });
  }
  const presets = loadPresets();
  const existing = presets.findIndex(p => p.name === name);
  const entry = { name, target_url, target_key: target_key || "", model_name };
  if (existing >= 0) presets[existing] = entry;
  else presets.push(entry);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 删除预设方案
// ========================
app.post("/admin/presets/delete", { preHandler: basicAuth }, async (req, reply) => {
  const { name } = req.body || {};
  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  reply.send({ success: true });
});

// ========================
// 心跳接口
// ========================
app.post("/internal/heartbeat", async (req, reply) => {
  wakeUpLastHeartbeat = Date.now();
  reply.send({ status: "ok" });
});

// ========================
// 管理页一键重启
// ========================
app.post("/admin/restart", { preHandler: basicAuth }, async (req, reply) => {
  const restartCommand = readRestartCommand();

  // 立即回复，避免重启时连接中断
  reply.send({ success: true, output: `重启指令已发送：${restartCommand}` });
  
  // 稍后重启。默认只重启本项目的两个进程；可通过 RESTART_COMMAND 自定义。
  // 安全校验：只允许白名单内的重启命令，避免管理账号泄露后被用于任意命令执行
  const ALLOWED_RESTART_PREFIXES = ["pm2 restart ", "pm2 reload ", "systemctl restart ", "service restart ", "supervisorctl restart "];
  const trimmedCmd = String(restartCommand || "").trim();
  if (!ALLOWED_RESTART_PREFIXES.some(prefix => trimmedCmd.startsWith(prefix))) {
    console.error("重启命令不在白名单内，已拒绝:", trimmedCmd);
    return;
  }
  const { exec } = require("child_process");
  exec(trimmedCmd, (err, stdout, stderr) => {
    if (err) {
      console.error("重启失败:", stderr);
    } else {
      console.log("服务已重启:", stdout);
    }
  });
});

// ========================

// ========================
// 记忆管理 API
// ========================

// 记忆语义检索（MCP 工具调用，AI 主动检索记忆；只读，不触碰冷却/浮现状态）
app.get("/internal/memory/search", async (req, reply) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return reply.code(400).send({ error: "q 必填" });
    const topK = Math.min(20, Math.max(1, parseInt(req.query.topK, 10) || 5));
    const filters = {};
    if (req.query.type) {
      filters.types = String(req.query.type).split(",").map(s => s.trim()).filter(Boolean);
    }
    if (req.query.minImportance !== undefined && req.query.minImportance !== "") {
      filters.minImportance = parseFloat(req.query.minImportance);
    }
    const engine = require("./memory-engine");
    const results = await engine.search(q, topK, filters);
    const safe = results.map(m => {
      const { embedding, ...rest } = m;
      return rest;
    });
    reply.send({ query: q, count: safe.length, memories: safe });
  } catch (err) {
    console.error("[GET /internal/memory/search] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆编辑（MCP/AI 主动修改记忆：内容、重要性、类型等；按 id 精确修改）
app.post("/internal/memory/update", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const body = req.body || {};
    const id = String(body.id || "").trim();
    const updates = body.updates || {};
    if (!id) return reply.code(400).send({ error: "id 必填" });
    const clean = {};
    for (const k of ["content", "importance", "type", "active"]) {
      if (updates[k] !== undefined) clean[k] = updates[k];
    }
    if (Object.keys(clean).length === 0) {
      return reply.code(400).send({ error: "没有可更新的字段（content/importance/type/active）" });
    }
    const ok = await engine.updateMemory(id, clean);
    if (!ok) return reply.code(404).send({ error: "记忆不存在: " + id });
    const mem = engine.getMemoryById(id);
    const { embedding, ...rest } = mem;
    reply.send({ success: true, memory: rest });
  } catch (err) {
    console.error("[POST /internal/memory/update] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆删除（软删除：active=false，沉底不再被检索）
app.post("/internal/memory/delete", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const id = String((req.body || {}).id || "").trim();
    if (!id) return reply.code(400).send({ error: "id 必填" });
    const mem = engine.getMemoryById(id);
    if (!mem) return reply.code(404).send({ error: "记忆不存在: " + id });
    const ok = engine.deleteMemory(id);
    if (!ok) return reply.code(500).send({ error: "删除失败" });
    const { embedding, ...rest } = mem;
    reply.send({ success: true, deleted: rest });
  } catch (err) {
    console.error("[POST /internal/memory/delete] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆统计
app.get("/admin/stats", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const stats = require("./memory-engine").getStats ? require("./memory-engine").getStats() : { total: 0, active: 0, byType: {}, similarCount: 0, similarGroups: 0 };
    reply.send(stats);
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 记忆列表（支持搜索和分页）
app.get("/admin/memories", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const query = req.query || {};
    const filters = {};
    if (query.type) filters.types = [query.type];
    if (query.active !== undefined) filters.active = query.active === "true" || query.active === true;
    if (query.search) filters.search = query.search;
    if (query.page) filters.page = parseInt(query.page);
    if (query.pageSize) filters.pageSize = parseInt(query.pageSize);
    if (query.sortBy) filters.sortBy = query.sortBy;
    const result = require("./memory-engine").getMemories ? require("./memory-engine").getMemories(filters) : [];
    const total = require("./memory-engine").memories ? require("./memory-engine").memories.length : 0;
    reply.send({ memories: result, total });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 获取单条记忆 (剥离 embedding 避免传输大量数据)
app.get("/admin/memories/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const mem = engine.getMemoryById ? engine.getMemoryById(req.params.id) : null;
    if (!mem) return reply.code(404).send({ error: "记忆不存在" });
    const { embedding, ...rest } = mem;
    reply.send(rest);
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 删除单条记忆
app.delete("/admin/memories/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const id = req.params.id;
    console.log("[DELETE /admin/memories/:id] id=" + JSON.stringify(id) + " body=" + JSON.stringify(req.body));
    if (!id) return reply.code(400).send({ error: "id 必填" });
    const engine = require("./memory-engine");
    const mem = engine.getMemoryById ? engine.getMemoryById(id) : null;
    if (!mem) return reply.code(404).send({ error: "记忆不存在" });
    const ok = engine.deleteMemory ? engine.deleteMemory(id) : false;
    reply.send({ success: ok });
  } catch (err) {
    console.error("[DELETE memories] error:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 编辑单条记忆
app.put("/admin/memories/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const id = req.params.id;
    if (!id) return reply.code(400).send({ error: "id 必填" });
    const updates = req.body || {};
    if (!updates.content && !updates.importance && !updates.type) {
      return reply.code(400).send({ error: "至少提供 content / importance / type 之一" });
    }
    const ok = require("./memory-engine").updateMemory ? await require("./memory-engine").updateMemory(id, updates) : false;
    if (!ok) return reply.code(404).send({ error: "记忆不存在" });
    reply.send({ success: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 批量归档
app.post("/admin/memories/batch/archive", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { type, olderThanDays } = req.body || {};
    if (!type) return reply.code(400).send({ error: "type 必填" });
    const cutoff = olderThanDays ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : 0;
    let count = 0;
    const mems = require("./memory-engine").memories || [];
    for (const mem of mems) {
      if (mem.type === type && mem.active) {
        if (cutoff > 0 && mem.timestamp) {
          const age = Date.now() - new Date(mem.timestamp).getTime();
          if (age < cutoff) continue;
        }
        mem.active = false;
        count++;
      }
    }
    // Mark dirty to ensure changes are flushed to disk
    require("./memory-engine").memories && (() => {
      const engine = require("./memory-engine");
      if (engine.markDirty) engine.markDirty();
    })();
    reply.send({ success: true, archived: count });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});


// 批量导入记忆
app.post("/admin/memories/import", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const entries = req.body.entries || req.body || [];
    if (!Array.isArray(entries)) {
      return reply.code(400).send({ error: "需要 entries 数组" });
    }
    const engine = require("./memory-engine");
    let added = 0, skipped = 0, errors = 0;
    const results = [];
    for (const entry of entries) {
      try {
        const result = await engine.addMemory(entry);
        if (result) {
          added++;
          results.push({ id: result.id, content: result.content?.substring(0, 50), status: "added" });
        } else {
          skipped++;
          results.push({ content: entry.content?.substring(0, 50), status: "skipped" });
        }
      } catch (err) {
        errors++;
        results.push({ content: entry.content?.substring(0, 50), status: "error", error: err.message });
      }
    }
    reply.send({ success: true, added, skipped, errors, results });
  } catch (err) {
    console.error("[POST /admin/memories/import] error:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 查找相似记忆（重复检测）
app.get("/admin/memories/similar", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const threshold = parseFloat(req.query.threshold) || 0.6;
    const engine = require("./memory-engine");
    if (!engine.findSimilarMemories) {
      return reply.code(500).send({ error: "findSimilarMemories not available" });
    }
    const clusters = engine.findSimilarMemories(threshold);
    // Strip embeddings to avoid huge response
    const safeClusters = clusters.map(c => ({
      ...c,
      members: c.members.map(m => {
        const { embedding, ...rest } = m;
        return rest;
      })
    }));
    reply.send({ clusters: safeClusters, totalClusters: safeClusters.length });
  } catch (err) {
    console.error("[GET /admin/memories/similar] error:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 触发摘要
app.post("/admin/summary/trigger", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const summaryEngine = require("./summary-engine");
    if (summaryEngine.triggerNow) {
      summaryEngine.triggerNow().catch(e => {
        console.error("[admin] 手动触发摘要失败:", e.message);
      });
    }
    reply.send({ success: true, message: "摘要已触发" });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 最近一次摘要信息
app.get("/admin/summary/last", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const fss = require("fs");
    const pathh = require("path");
    const stateFile = pathh.join(__dirname, "data", "state.json");
    let state = {};
    try {
      if (fss.existsSync(stateFile)) {
        state = JSON.parse(fss.readFileSync(stateFile, "utf-8"));
      }
    } catch {}
    reply.send({
      last_summary_time: state.last_summary_time || null,
      is_summary_running: state.is_summary_running || false,
      pending_messages: (state.pending_messages || []).length
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 配置管理：获取配置
app.get("/admin/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const config = require("./memory-engine").getConfig ? require("./memory-engine").getConfig() : {};
    reply.send(config);
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 配置管理：更新配置
app.post("/admin/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const updates = req.body || {};
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "无更新内容" });
    }
    await require("./memory-engine").updateConfig(updates);
    // If max_interval changed, restart the max interval timer
    if (updates.max_interval_minutes !== undefined) {
      try { require("./summary-engine").restartMaxIntervalTimer(); } catch (e) {}
    }
    reply.send({ success: true, config: require("./memory-engine").getConfig() });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 环境变量获取
app.get("/admin/env", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const presets = loadPresets();
    const diaryEntries = readDiaryEntries(20);
    const diaryData = diaryEntries.map(e => ({ name: e.name, time: formatDateTimeInTimeZone(new Date(e.updated_at), TIME_ZONE), content: e.content }));
    reply.send({
      uptime: Math.floor(process.uptime()),
      wakeStatus: wakeUpLastHeartbeat ? "在线（上次心跳: " + formatDateTimeInTimeZone(new Date(wakeUpLastHeartbeat), TIME_ZONE) + "）" : "离线或未启动",
      apiUrl: readEnvValue("TARGET_API_URL"),
      model: readEnvValue("MODEL_NAME"),
      icon: readEnvValue("CUSTOM_ICON_URL"),
      gatewayKey: !!readEnvValue("GATEWAY_API_KEY"),
      wake: {
        dayWakeAfter: readEnvValueOrDefault("DAY_WAKE_AFTER_MINUTES", "60"),
        nightWakeAfter: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "120"),
        dayCheckInterval: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "10"),
        nightCheckInterval: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "120"),
        dayStartHour: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
        dayEndHour: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24")
      },
      weather: {
        enabled: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
        locationName: readEnvValue("WEATHER_LOCATION_NAME"),
        lat: readEnvValue("WEATHER_LAT"),
        lon: readEnvValue("WEATHER_LON"),
        units: readEnvValueOrDefault("WEATHER_UNITS", "metric")
      },
      env: {
        // 非敏感字段明文返回；密钥类只回传是否已配置，避免把凭据发给前端（表单留空=保存时保留原值）
        TARGET_API_URL: readEnvValue("TARGET_API_URL"),
        TARGET_API_KEY: "",
        TARGET_API_KEY_SET: Boolean(readEnvValue("TARGET_API_KEY")),
        MODEL_NAME: readEnvValue("MODEL_NAME"),
        BARK_KEY: "",
        BARK_KEY_SET: Boolean(readEnvValue("BARK_KEY")),
        GATEWAY_API_KEY: "",
        GATEWAY_API_KEY_SET: Boolean(readEnvValue("GATEWAY_API_KEY")),
        CUSTOM_ICON_URL: readEnvValue("CUSTOM_ICON_URL"),
        DAY_WAKE_AFTER_MINUTES: readEnvValueOrDefault("DAY_WAKE_AFTER_MINUTES", "60"),
        NIGHT_WAKE_AFTER_MINUTES: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "120"),
        DAY_CHECK_INTERVAL_MINUTES: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "10"),
        NIGHT_CHECK_INTERVAL_MINUTES: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "120"),
        WAKE_DAY_START_HOUR: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
        WAKE_DAY_END_HOUR: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24"),
        WEATHER_ENABLED: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
        WEATHER_LOCATION_NAME: readEnvValue("WEATHER_LOCATION_NAME"),
        WEATHER_LAT: readEnvValue("WEATHER_LAT"),
        WEATHER_LON: readEnvValue("WEATHER_LON"),
        WEATHER_UNITS: readEnvValueOrDefault("WEATHER_UNITS", "metric"),
        DIARY_ENABLED: readEnvValueOrDefault("DIARY_ENABLED", "true"),
        DIARY_DIR: readEnvValueOrDefault("DIARY_DIR", "diary"),
        PORT: readEnvValueOrDefault("PORT", "3000")
      },
      presets: presets,
      diary: diaryData
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 移动端管理页面
app.get("/admin/mobile", { preHandler: mobileAuth }, async (req, reply) => {
  const fss = require("fs");
  const pathh = require("path");
  const template = fss.readFileSync(pathh.join(__dirname, "admin-mobile.html"), "utf-8");
  reply.type("text/html").send(template);
});

// ========================
// 日志与上下文查看 API
// ========================

// 获取唤醒原始日志
// 获取唤醒提示词（wake_prompt.txt 当前内容）
app.get("/admin/logs/wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const promptPath = path.join(__dirname, "wake_prompt.txt");
    reply.send({ text: fs.readFileSync(promptPath, "utf-8") });
  } catch (err) {
    reply.send({ text: "", error: err.message });
  }
});

// 保存唤醒提示词
app.post("/admin/logs/wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return reply.code(400).send({ error: "内容不能为空" });
    atomicWriteFileSync(path.join(__dirname, "wake_prompt.txt"), text + "\n");
    reply.send({ ok: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 获取摘要提示词（system + 模板）
app.get("/admin/logs/summary-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(summaryEngine.getSummaryPromptForDisplay());
  } catch (err) {
    reply.send({ error: err.message });
  }
});

// 保存摘要提示词
app.post("/admin/logs/summary-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = summaryEngine.saveSummaryPromptConfig(req.body && req.body.system, req.body && req.body.template);
    reply.send({ ok: true, system: cfg.system, template: cfg.template });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// 恢复摘要提示词默认
app.delete("/admin/logs/summary-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = summaryEngine.resetSummaryPromptConfig();
    reply.send({ ok: true, system: cfg.system, template: cfg.template });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.get("/admin/logs/wake-up", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const lines = parseInt(req.query.lines) || 200;
    const logPath = process.env.WAKE_UP_LOG_PATH || "/root/.pm2/logs/wake-up-out.log";
    try {
      const raw = fs.readFileSync(logPath, "utf-8");
      const allLines = raw.split("\n").filter(l => l.trim());
      const tailLines = allLines.slice(-lines);
      reply.send({ lines: tailLines, total: allLines.length });
    } catch {
      reply.send({ lines: [], total: 0, error: "日志文件不存在" });
    }
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 获取/新增/删除 永久注入上下文 (pinned memories)
app.get("/admin/logs/pinned", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const list = engine.getPinnedMemories ? engine.getPinnedMemories() : [];
    reply.send({ list });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/logs/pinned", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const { title, content, order } = req.body || {};
    const mem = await engine.addPinnedMemory({ title, content, order });
    reply.send({ success: true, memory: mem });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});



app.put("/admin/logs/pinned/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const { title, content, order } = req.body || {};
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (order !== undefined) updates.order = order;
    const mem = await engine.updatePinnedMemory(req.params.id, updates);
    if (!mem) return reply.code(404).send({ error: "not found" });
    reply.send({ success: true, memory: mem });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});
app.delete("/admin/logs/pinned/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const ok = await engine.deletePinnedMemory(req.params.id);
    reply.send({ success: ok });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 获取最后一次发给LLM的完整上下文
app.get("/admin/logs/context", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (!lastLLMMessages) {
      reply.send({ messages: [], total: 0, captureTime: null });
      return;
    }
    const messages = lastLLMMessages.map(m => {
      if (m.role === "_divider") return { role: "_divider", content: m.content };
      return { role: m.role, content: m.content };
    });
    reply.send({ messages, total: messages.length, captureTime: lastLLMCaptureTime });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 测试 Bark
// ========================
app.get("/test-bark", async (req, reply) => {
  const formattedTime = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
  appendSpecialEvent(`（${formattedTime} 刚刚给${process.env.USER_DISPLAY_NAME || "用户"}发了 Bark：这是一条测试推送。）`);
  reply.send({ success: true });
});

// ========================
// 启动服务
// ========================
// ========================
// 初始化记忆引擎
// ========================
const tagParser = require("./tag-parser");
const memoryEngine = require("./memory-engine");
const summaryEngine = require("./summary-engine");

require("./memory-engine").init().then(() => {
  console.log("[memory] 记忆引擎就绪");
  require("./summary-engine").init();
}).catch(err => {
  console.error("[memory] 记忆引擎初始化失败:", err.message);
});

// 优雅关闭时刷盘
process.on("SIGINT", async () => {
  await require("./memory-engine").shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await require("./memory-engine").shutdown();
  process.exit(0);
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
  setTimeout(async () => {
    try {
      const headers = { "Content-Type": "application/json" };
      const internalKey = readEnvValue("INTERNAL_API_KEY");
      if (internalKey) headers["x-internal-key"] = internalKey;
      await fetch(`http://127.0.0.1:${PORT}/internal/heartbeat`, { method: "POST", headers, body: "{}" });
      console.log('心跳状态已恢复');
    } catch (e) {}
  }, 3000);
});
