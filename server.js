require("dotenv").config();

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const {
  getDatePartsInTimeZone,
  formatDateTimeInTimeZone,
  parseWakeTarget,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

const contextCompactor = require("./context-compactor");
const contextReplacements = require("./context-replacements");

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
// 对话侧闹钟与唤醒侧共用同一份调度文件：gateway 写入，wake-up 轮询感知后挂定时器
const WAKE_SCHEDULE_PATH = path.join(__dirname, "data", "wake_schedule.json");
// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；保留原进程名，
// 只补 --update-env，避免用户改完推送配置却继续运行旧值。
const DEFAULT_RESTART_COMMAND = "cd /opt/dylan-heartbeat && pm2 restart wake-up gateway --update-env 2>&1";
// 上游模型请求超时（毫秒），防止上游挂起时 /v1 请求永久阻塞
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS) || 60000;

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function publicApiEnabled() {
  const raw = String(readEnvValue("ALLOW_PUBLIC_API") || "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

function configuredModelName() {
  // 批注 2026-07-15：/v1/models 要暴露部署者实际配置的模型名；
  // 不能继续硬编码示例模型，否则 Kelivo 模型选择会和真实上游不一致。
  return String(readEnvValue("MODEL_NAME") || "gateway-model").trim() || "gateway-model";
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

function extractAssistantThinking(message) {
  if (!message || typeof message !== "object") return "";
  const direct = [message.reasoning_content, message.reasoning, message.thinking];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const s = v.map(p => (typeof p === "string" ? p : (p && (p.text || p.content)) || "")).filter(Boolean).join("\n").trim();
      if (s) return s;
    }
  }
  if (Array.isArray(message.content)) {
    const parts = message.content.filter(p => p && typeof p === "object" && typeof p.type === "string" && (p.type.toLowerCase().includes("think") || p.type.toLowerCase().includes("reason")));
    const s = parts.map(p => p.text || p.content || "").filter(Boolean).join("\n").trim();
    if (s) return s;
  }
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
function systemNotePrefix() {
  return `（系统提示：以下内容${readEnvValue("USER_DISPLAY_NAME") || "用户"}不可见，仅供你参考）`;
}


// 历史图片裁剪：发送给上游前只保留最近 keepTurns 轮（以 user 消息为轮边界）里的图片，
// 更早轮次消息中的图片统一替换为 [图片] 文本占位符，避免视觉模型反复重编码历史图片。
function trimHistoricalImages(messages, keepTurns) {
  if (!Array.isArray(messages) || keepTurns <= 0) return messages;
  const userIdxs = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && msg.role === "user") userIdxs.push(i);
  }
  if (userIdxs.length <= keepTurns) return messages;
  const keepStartIdx = userIdxs[userIdxs.length - keepTurns];
  let dropped = 0;
  const touchedMsgs = [];
  for (let i = 0; i < keepStartIdx; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    let touched = false;
    const newParts = [];
    for (const part of msg.content) {
      if (part && isImageContentPart(part)) { touched = true; dropped++; continue; }
      newParts.push(part);
    }
    if (touched) {
      newParts.push({ type: "text", text: "[图片]" });
      // 只替换本次发送数组里的消息对象（浅拷贝 + 新 content），不污染请求 body / 时间线
      messages[i] = { ...msg, content: newParts };
      touchedMsgs.push(i);
    }
  }
  if (dropped > 0) {
    console.log(`[trim-images] 历史图片裁剪：总轮 ${userIdxs.length}，保留最近 ${keepTurns} 轮，替换早于窗口的图片 ${dropped} 张（涉及 ${touchedMsgs.length} 条历史消息）`);
  }
  return messages;
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
// 与 wake-up 进程共用同一份 wake_schedule.json：原子写入，wake-up 轮询感知后重新挂定时器
function saveWakeSchedule(nextWakeAtIso) {
  fs.ensureDirSync(path.dirname(WAKE_SCHEDULE_PATH));
  const tmp = WAKE_SCHEDULE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ next_wake_at: nextWakeAtIso, updated_at: new Date().toISOString() }, null, 2), "utf-8");
  fs.renameSync(tmp, WAKE_SCHEDULE_PATH);
}

// 对话侧 <wake> 闹钟标签：AI 在对话里设置闹钟（日期时间或分钟）；标签不显示给用户。
// 返回剥离标签后的文本；同时把闹钟写入 wake_schedule.json（wake-up 进程轮询感知后挂定时器）。
function parseWakeTagAndSchedule(text) {
  const cleaned = String(text || "").replace(/<wake>[\s\S]*?<\/wake>/gi, "").trim();
  const m = String(text || "").match(/<wake>([\s\S]*?)<\/wake>/i);
  if (!m) return cleaned;
  const target = parseWakeTarget(m[1], TIME_ZONE);
  if (!target) {
    console.log("[wake] <wake> 内容无效（忽略）:", m[1]);
    return cleaned;
  }
  const nextWakeAt = target.at || new Date(Date.now() + target.minutes * 60 * 1000);
  if (nextWakeAt.getTime() <= Date.now()) {
    console.log("[wake] <wake> 时间已过（忽略）:", m[1]);
    return cleaned;
  }
  try {
    saveWakeSchedule(nextWakeAt.toISOString());
    console.log(`[wake] 对话设置闹钟：${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}（${nextWakeAt.toISOString()}）`);
  } catch (err) {
    console.warn("[wake] 保存闹钟失败:", err.message);
  }
  return cleaned;
}

function createContentTagFilter() {
  let buf = "";
  let inTag = false;
  let tagType = ""; // "memory" | "pin" | "wake"

  // 判断 tail（从某个 "<" 开始的小写文本）是否可能是 memory/pin/wake 开标签
  function isPotentialOpen(tail) {
    if (/^<(memory|pin|wake)(\s[^>]*)?>/.test(tail)) return true; // 完整开标签（可带属性）
    if (/^<(memory|pin|wake)\s[^>]*$/.test(tail)) return true;     // 属性写法进行中
    if (/^<(memory|pin|wake)$/.test(tail)) return true;            // 恰好 <memory / <pin / <wake
    if (/^<m(?:e(?:m(?:o(?:r)?)?)?)?$/.test(tail)) return true; // <m <me <mem <memo <memor
    if (/^<p(?:i)?$/.test(tail)) return true;                  // <p <pi
    if (/^<w(?:a(?:k)?)?$/.test(tail)) return true;            // <w <wa <wak
    if (tail === "<") return true;
    return false;
  }

  // 找到最早的可能是标签开头的 "<"
  function findOpenIndex(str) {
    const lower = str.toLowerCase();
    const candidates = [];
    const re = /<(?=[mpw])/g;
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
          const closeRe = tagType === "memory" ? /<\/memory>/i : tagType === "pin" ? /<\/pin>/i : /<\/wake>/i;
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
          if (/^<(memory|pin|wake)(\s[^>]*)?>/.test(buf.toLowerCase())) {
            inTag = true;
            const lowerBuf = buf.toLowerCase();
            tagType = lowerBuf.startsWith("<pin") ? "pin" : lowerBuf.startsWith("<wake") ? "wake" : "memory";
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
  // 兜底：任何写入路径都补齐缺失的 time（system 除外），避免历史消息/特殊事件缺时间
  backfillMissingTimes(nonSP);
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

// 解析消息正文末尾的时间缀（客户端自动注入的墙上时间），按 TIME_ZONE 转 UTC
function extractTrailingTimestampLabel(value) {
  const text = String(value || "");
  const m = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
  return m ? parseTimestampLabel(m[1]) : null;
}

// 解析 <current_time>Sat 26-08-15 12:37:16</current_time> 里的时间（客户端新时间格式，两位年份补全）
function extractCurrentTimeTagLabel(value) {
  const text = String(value || "");
  const m = text.match(/<current_time>[\s\S]*?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: 2000 + Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, TIME_ZONE);
}

// 消息时间解析：优先 time 字段（客户端已传）→ <current_time> 标签 → 末尾时间缀 → 开头时间戳（AI 抄的）
function extractTimestampWithMemory(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const text = normalizeContentToText(msg.content);
  const fromTag = extractCurrentTimeTagLabel(text);
  if (fromTag) return fromTag;
  const fromTrailing = extractTrailingTimestampLabel(text);
  if (fromTrailing) return fromTrailing;
  const fromContent = extractTimestamp(text);
  if (fromContent) return fromContent;
  return null;
}

// 共影记录是整段观影的合并消息，开头是「（共影）2026-08-14 23:31 一起看《…》」；
// 用首行时间作为整段记录的起始时间，注入主上下文时按这个时间落位，避免被推到末尾
function extractCoRecordEventTime(msg) {
  if (!msg || typeof msg.content !== "string") return null;
  const m = msg.content.match(/^（共影）\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})/);
  return m ? parseTimestampLabel(m[1]) : null;
}

// ========================
// 消息判断
// ========================
function isSpecialEvent(msg) {
  // 结构化识别：与 context-replacements / context-compactor 统一，避免把真实对话里提到“记忆碎片/自动写了日记/推送”等词误判成事件
  return contextReplacements.isSpecialEvent(msg);
}

// 特殊事件注入分类：一个事件可能命中多类，返回命中的所有分类 key
function classifySpecialEvent(msg) {
  const c = normalizeContentToText(msg.content);
  const out = [];
  if (/自动唤醒|本次未发送/.test(c)) out.push("wake");
  else if (/发了 Bark|推送/.test(c)) out.push("push");
  if (c.includes("自动写了日记")) out.push("diary");
  if (c.includes("记忆浮现）")) out.push("memory");
  if (c.includes("时间标记")) out.push("time");
  if (c.includes("摘要）")) out.push("summary");
  if (c.includes("共影）")) out.push("co");
  if (c.includes("截图）") || c.includes("截图唤醒）")) out.push("screenshot");
  if (c.includes("记忆碎片")) out.push("star");
  return out;
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
// 补齐缺失 time 字段
// 规则：优先取紧随其后的用户消息时间（末尾时间缀），没有就取前面最近一条用户消息时间，再兜底服务器当前时间。
// 只补一次（此后由 oldByContent 保持稳定），保证所有消息（含特殊事件）都有时间，可按时间段定位与压缩。
// ========================
function backfillMissingTimes(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const n = arr.length;
  // 每条消息“后面最近一条用户消息的时间”
  const nextUserTime = new Array(n).fill(null);
  let pending = null;
  for (let i = n - 1; i >= 0; i--) {
    nextUserTime[i] = pending;
    const m = arr[i];
    if (m && m.role === "user" && m.time) {
      const d = new Date(m.time);
      if (!isNaN(d.getTime())) pending = d;
    }
  }
  let prevUserTime = null;
  for (let i = 0; i < n; i++) {
    const m = arr[i];
    if (!m) continue;
    if (m.time) {
      const d = new Date(m.time);
      if (m.role === "user" && !isNaN(d.getTime())) prevUserTime = d;
      continue;
    }
    const pick = nextUserTime[i] || prevUserTime || new Date();
    m.time = pick instanceof Date ? pick.toISOString() : String(pick);
  }
  return arr;
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
  return backfillMissingTimes(result);
}


// ========================
// 追加特殊事件
// ========================
function appendSpecialEvent(content, extra) {
  const timeline = loadTimeline();
  let maxPos = 0;
  for (const msg of timeline) {
    if (msg.position && msg.position > maxPos) maxPos = msg.position;
  }
  const newEvent = { role: "assistant", content, position: maxPos + 0.5, time: new Date().toISOString(), ...(extra || {}) };
  timeline.push(newEvent);
  saveTimeline(timeline);
  // 批注 2026-07-15：特殊事件可能包含推送正文；日志只记录长度，避免公开部署时泄漏私密内容。
  console.log(`\n已记录特殊事件 (position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
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
let lastLLMMessages = null;
let lastLLMCaptureTime = null;

// ========================
// 网易云环境（网易云 MCP 会话管理）
// ========================
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

const NETEASE_DIR = "/opt/netease-music-mcp";
const NETEASE_ENV_FILE = path.join(NETEASE_DIR, ".env");
const NETEASE_SESSION_FILE = path.join(NETEASE_DIR, "data", "netease.session");
const NETEASE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function readNetEaseEnv(key) {
  try {
    const envContent = fs.readFileSync(NETEASE_ENV_FILE, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(key + "=")) return trimmed.substring(key.length + 1).trim();
    }
  } catch {}
  return "";
}

function readNeteaseSession() {
  try {
    const raw = fs.readFileSync(NETEASE_SESSION_FILE, "utf-8").trim();
    const musicU = raw.match(/(?:^|;\s*)MUSIC_U=([^;\s]+)/)?.[1] || "";
    const csrf = raw.match(/(?:^|;\s*)__csrf=([^;\s]+)/)?.[1] || "";
    return { musicU, csrf, raw };
  } catch {
    return { musicU: "", csrf: "", raw: "" };
  }
}

function writeNeteaseSession(musicU, csrf) {
  const header = `MUSIC_U=${musicU}` + (csrf ? `; __csrf=${csrf}` : "") + "\n";
  const tmp = NETEASE_SESSION_FILE + ".tmp";
  fs.writeFileSync(tmp, header, { mode: 0o600 });
  fs.renameSync(tmp, NETEASE_SESSION_FILE);
}

async function fetchNeteaseAccount(cookieHeader) {
  if (!cookieHeader) return null;
  try {
    const response = await fetch("https://music.163.com/api/nuser/account/get", {
      headers: {
        Cookie: cookieHeader,
        Referer: "https://music.163.com/",
        "User-Agent": NETEASE_UA
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    const profile = data?.profile;
    if (profile && profile.userId) {
      return {
        nickname: String(profile.nickname || ""),
        userId: String(profile.userId),
        vipType: Number(profile.vipType ?? 0)
      };
    }
    return null;
  } catch {
    return null;
  }
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

// serialize .env read-merge-write to avoid concurrent /admin/save overwrite
let envWriteChain = Promise.resolve();
function writeEnvUpdates(updates) {
  const task = async () => {
    const merged = { ...loadEnvFileObject(), ...updates };
    const orderedKeys = [
      ...PREFERRED_ENV_ORDER.filter(key => Object.prototype.hasOwnProperty.call(merged, key)),
      ...Object.keys(merged)
        .filter(key => !PREFERRED_ENV_ORDER.includes(key))
        .sort()
    ];
    const lines = orderedKeys.map(key => `${key}=${serializeEnvValue(merged[key])}`);
    atomicWriteFileSync(ENV_FILE, lines.join("\n") + "\n");
  };
  envWriteChain = envWriteChain.then(task, task);
  return envWriteChain;
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
  if (publicApiEnabled() && req.url.startsWith("/v1/")) {
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
// ========================
// 跨窗口自动注入：日记 + 高重要级记忆 + 标星内容
// ========================
function recentDiaryText(days) {
  const diaryDir = path.join(__dirname, "diary");
  let files = [];
  try { files = fs.readdirSync(diaryDir).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.md$/.test(f); }); } catch (e) { return ""; }
  if (!files.length) return "";
  const cutoff = Date.now() - (Number(days) || 3) * 24 * 60 * 60 * 1000;
  files.sort().reverse();
  const picked = files.slice(0, 14).filter(function (f) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) return false;
    return new Date(m[1] + "T00:00:00").getTime() >= cutoff;
  });
  const out = [];
  for (const f of picked) {
    try {
      const t = fs.readFileSync(path.join(diaryDir, f), "utf-8").trim();
      if (t) out.push("### " + f.replace(/\.md$/, "") + "\n" + t);
    } catch (e) {}
  }
  return out.join("\n\n");
}

function starredContextText(limit) {
  let marks = {};
  try { marks = contextCompactor.loadMarks ? contextCompactor.loadMarks() : {}; } catch (e) { marks = {}; }
  const keys = Object.keys(marks || {});
  if (!keys.length) return "";
  const out = [];
  const seenKeys = new Set();
  // 第一遍：优先用标星时存的原文 marks[key].content —— 与已标星列表 listMarked 口径一致。
  // 时间线/替换池查不到的历史标星也能注入，避免“近期新标不在标星内容段”。
  keys.forEach(function (key) {
    const entry = marks[key];
    if (!entry || typeof entry.content !== "string" || !entry.content) return;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const role = (entry.role === "user") ? "她" : "我";
    out.push(role + "：" + entry.content);
  });
  // 第二遍：兜底扫替换记录 matched，补早期没存原文的存量标星（按 key 去重）
  let items = [];
  try { items = (contextReplacements.loadItems ? contextReplacements.loadItems() : []) || []; } catch (e) { items = []; }
  for (const it of items) {
    const matched = Array.isArray(it.matched) ? it.matched : [];
    for (const m of matched) {
      if (!m || m.role === "system") continue;
      let k = null;
      try { k = contextReplacements.contentKey ? contextReplacements.contentKey(m) : contextCompactor.contentKey(m); } catch (e) {}
      if (k && marks[k] && !seenKeys.has(k)) {
        seenKeys.add(k);
        const role = m.role === "user" ? "她" : "我";
        const c = typeof m.content === "string" ? m.content : "";
        if (c) out.push(role + "：" + c);
      }
    }
  }
  return out.slice(-(Number(limit) || 10)).join("\n");
}

function buildCrossWindowInjection() {
  const cfg = memoryPool.getConfig();
  if (cfg.cross_inject_enabled === false) return "";
  const parts = [];
  if (cfg.cross_inject_diary !== false) {
    const dt = recentDiaryText(Number(cfg.cross_inject_diary_days) || 3);
    if (dt) parts.push("## 近期日记\n" + dt);
  }
  if (cfg.cross_inject_memory !== false) {
    const perCat = Math.max(1, Number(cfg.cross_inject_memory_per_category) || 2);
    const summaryDays = Math.max(1, Number(cfg.cross_inject_summary_days) || 7);
    const summaryCutoff = Date.now() - summaryDays * 24 * 60 * 60 * 1000;
    const all = memoryPool.list({ active: true });
    let mems = [];
    const seen = new Set();
    // 静态分类覆盖：每个非「对话摘要」分类抽 importance 最高的前 perCat 条
    (memoryPool.CATEGORIES || []).forEach(function (c) {
      if (c === "对话摘要") return;
      all
        .filter(function (m) { return m.category === c; })
        .sort(function (a, b) { return (Number(b.importance) || 0) - (Number(a.importance) || 0); })
        .slice(0, perCat)
        .forEach(function (m) { if (!seen.has(m.id)) { seen.add(m.id); mems.push(m); } });
    });
    // 「对话摘要」按最近日期取，只取最近 summaryDays 天内的（无日期兜底保留）
    all
      .filter(function (m) { return m.category === "对话摘要"; })
      .filter(function (m) {
        const t = new Date(m.updated_at || m.created_at || "");
        if (isNaN(t.getTime())) return true; // 无日期：保留兜底
        return t.getTime() >= summaryCutoff;
      })
      .sort(function (a, b) {
        const ta = String(a.updated_at || a.created_at || "");
        const tb = String(b.updated_at || b.created_at || "");
        return ta < tb ? 1 : (ta > tb ? -1 : 0);
      })
      .slice(0, 20) // 安全上限，防止最近几天摘要过多刷屏
      .forEach(function (m) { if (!seen.has(m.id)) { seen.add(m.id); mems.push(m); } });
    if (mems.length) {
      parts.push("## 相关记忆\n" + mems.map(function (m) { return "【" + m.category + "】" + m.content; }).join("\n"));
    }
    // 重要置顶：手动置顶（pin）的记忆单独成段，永远带上，不占「每类几条」配额
    const pinnedMems = memoryPool.list({ active: true, pinned: true }).filter(function (m) {
      return !seen.has(m.id);
    }).slice(0, 8);
    if (pinnedMems.length) {
      parts.push("## 重要置顶\n" + pinnedMems.map(function (m) { return "【" + m.category + "】" + m.content; }).join("\n"));
    }
  }
  if (cfg.cross_inject_starred !== false) {
    const st = starredContextText(Math.min(Number(cfg.cross_inject_starred_topk) || 10, 10));
    if (st) parts.push("## 标星内容\n" + st);
  }
  return parts.join("\n\n");
}



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
    // 主聊天（客户端携带 system 身份提示）才做记忆/跨窗口/特殊事件注入；标题总结等旁路请求保持精简
    const isMainChat = kelivoMessages.some(function (m) {
      if (!m) return false;
      if (m.role === "system") return true;
      if (m.role === "user" && typeof m.content === "string" && m.content.trim().indexOf("<system>") === 0) return true;
      return false;
    });

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
    const oldEvents = stripPosition(finalTimeline.filter(m => !m.deleted && isSpecialEvent(m)));
    // 当前窗口起点：最新一次重建时间线里第一条真实 user 消息时间，用于界定本次会话的特殊事件范围
    let windowStartMs = null;
    for (const m of finalTimeline) {
      if (windowStartMs !== null) break;
      if (!m || m.role !== "user") continue;
      if (isSpecialEvent(m)) continue;
      const mt = extractTimestampWithMemory(m);
      if (mt) windowStartMs = mt.getTime();
    }
    // 特殊事件注入：只取当前窗口（第一条真实 user 消息之后）内的事件；窗口内不限制条数（推送同样不限制）
    const pushEnabled = memoryPool.getConfig().cross_inject_push !== false;
    let injectableEvents = oldEvents.slice();
    if (windowStartMs !== null) {
      injectableEvents = injectableEvents.filter(ev => {
        const t = extractTimestampWithMemory(ev) || extractCoRecordEventTime(ev);
        const tms = t ? t.getTime() : NaN;
        return !isFinite(tms) || tms >= windowStartMs;
      });
    }
    // 推送开关关闭时剔除推送类特殊事件；条数不再限制（配合压缩摘要统一压缩）
    if (!pushEnabled) {
      injectableEvents = injectableEvents.filter(ev => {
        const cats = classifySpecialEvent(ev) || [];
        return cats.indexOf('push') < 0;
      });
    }

    // 特殊事件注入分类多选：只注入勾选类型；配置里没有该 key 时默认全部注入
    const injectTypesCfg = memoryEngine.getConfig().event_inject_types;
    if (Array.isArray(injectTypesCfg)) {
      const enabledTypes = new Set(injectTypesCfg);
      const before = injectableEvents.length;
      injectableEvents = injectableEvents.filter(ev => {
        const cats = classifySpecialEvent(ev);
        if (!cats.length) return true; // 无法分类的兜底保留
        return cats.some(k => enabledTypes.has(k));
      });
      if (injectableEvents.length !== before) {
        console.log(`[event-inject] 分类过滤: ${before} -> ${injectableEvents.length} 条`);
      }
    }


    // 共影记录注入开关：关闭后整段观影记录不再注入主对话（记录仍完整保存在共影里）
    const coEventInjectEnabled = memoryEngine.getConfig().co_event_inject_enabled !== false;
    if (!coEventInjectEnabled) {
      const before = injectableEvents.length;
      injectableEvents = injectableEvents.filter(ev => !(typeof ev.content === "string" && ev.content.includes("共影）")));
      if (injectableEvents.length !== before) {
        console.log("[co-event] 共影记录注入已关闭，跳过观影记录");
      }
    }

    if (!isMainChat) injectableEvents = [];
    console.log("本次注入的特殊事件数量:", injectableEvents.length);

    for (const event of injectableEvents) {
      const eventTime = extractTimestampWithMemory(event) || extractCoRecordEventTime(event);
      if (!eventTime) { llmMessages.push(event); continue; }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const m = llmMessages[i];
        if (m.role === "system") continue; // 系统提示保持首位，历史事件不能插到 system 之前
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

    const targetApiUrl = readEnvValue("TARGET_API_URL");
    const targetApiKey = readEnvValue("TARGET_API_KEY");
    if (!targetApiUrl || !targetApiKey) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 未配置" });
    }

    const requestedStream = body?.stream === true;

    // ========================
    // 永久注入上下文：pinned context 注入 system prompt
    // ========================
    try {
      const pinnedCtx = isMainChat && memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : '';
      let crossCtx = "";
      if (isMainChat) {
        try {
          const ctxMsgCount = (Array.isArray(kelivoMessages) ? kelivoMessages : []).filter(function (m) { return m && m.role !== "system" && !(m.role === "assistant" && isSpecialEvent(m)) && !m.tool_calls && !m.tool_call_id; }).length;
          if (ctxMsgCount < 2) { crossCtx = buildCrossWindowInjection(); }
        } catch (cx) { console.warn("[cross-inject] 失败:", cx.message); }
      }
      let sysExtra = "";
      if (pinnedCtx) sysExtra += '\n\n## 永久上下文\n' + pinnedCtx;
      if (crossCtx) sysExtra += '\n\n' + crossCtx;
      if (isMainChat) sysExtra += '\n\n（可选记忆）如果你觉得某一点值得长期记住，可以在回复里顺手用 <memory>…</memory> 标记，例如 <memory>她说：她需要反复确认才敢靠近。</memory>。系统会收进长期记忆池并自动去重；不写也不影响主流程。只标真正重要的点，别把整段话包进去。';
      if (sysExtra) {
        const sysIdx = llmMessages.findIndex(m => m.role === "system");
        if (sysIdx >= 0) {
          llmMessages[sysIdx].content = llmMessages[sysIdx].content + sysExtra;
        } else {
          llmMessages.unshift({ role: "system", content: sysExtra.trim() });
        }
        if (pinnedCtx) console.log('[pinned] 注入永久上下文');
        if (crossCtx) console.log('[cross-inject] 注入跨窗口记忆');
      }
    } catch (pinErr) {
      console.warn('[pinned] 注入失败:', pinErr.message);
    }

    // ========================
    // 对话时记忆浮现 / 时间注入：已随记忆池与摘要体系一起移除
    // ========================

    // 上下文记忆替换：把已记录范围里的原文替换成 AI 自己写的记忆（源文件不动，只影响本次发送）
    try {
      const beforeCount = llmMessages.length;
      llmMessages = contextReplacements.applyReplacements(llmMessages);
      if (llmMessages.length !== beforeCount) {
        console.log("[context-replacements] 发送前替换生效: 消息 " + beforeCount + " -> " + llmMessages.length);
      }
    } catch (repErr) {
      console.warn("[context-replacements] 替换失败（按原样转发）:", repErr.message);
    }

    // ========================
    // 历史图片裁剪：只保留最近 8 轮对话里的图片，更早的图片替换为 [图片] 占位符。
    // 图片无法命中 prompt 缓存，反复重编码历史图片是慢响应主因；文本历史不受影响。
    // ========================
    const cfgKeepImgTurns = Number(memoryEngine.getConfig().keep_recent_image_turns);
    // 0 表示不裁剪历史图片；配置缺省时回退环境变量，再回退默认 8
    const keepImageTurns = Number.isFinite(cfgKeepImgTurns) && cfgKeepImgTurns >= 0
      ? cfgKeepImgTurns
      : (Number(process.env.KEEP_RECENT_IMAGE_TURNS) || 8);
    try {
      trimHistoricalImages(llmMessages, keepImageTurns);
    } catch (imgErr) {
      console.warn("[trim-images] 历史图片裁剪失败（按原样转发）:", imgErr.message);
    }

    // 上下文压缩已统一进「上下文替换」：早期对话块摘要与 AI 记忆现在都是同一种替换记录，
    // 由 contextReplacements.applyReplacements 统一生效，旧压缩器发送路径已停用。


    // 请求模型
    // Capture the actual messages sent to LLM for inspection
    if (isMainChat) {
      lastLLMMessages = llmMessages.map(m => {
        const cap = splitMultimodalContent(m.content);
        return {
          role: m.role,
          content: cap.content,
          images: cap.images && cap.images.length ? cap.images : undefined,
          attachments: cap.attachments || undefined,
          tool_calls: m.tool_calls || undefined,
          tool_call_id: m.tool_call_id || undefined
        };
      });
      lastLLMCaptureTime = new Date().toISOString();
    }




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
      response = await fetch(targetApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${targetApiKey}`
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
        const aiMessage = parsed.choices?.[0]?.message || {};
        const aiContent = aiMessage.content || "";
        const aiThinking = extractAssistantThinking(aiMessage);
        if (aiContent) {
          // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
          parseWakeTagAndSchedule(aiContent);
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
      let aiThinking = "";
      const lines = fullText.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const evt = JSON.parse(line.slice(6));
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) aiFullContent += delta;
            const deltaThink = evt.choices?.[0]?.delta?.reasoning_content || evt.choices?.[0]?.delta?.reasoning;
            if (deltaThink) aiThinking += (typeof deltaThink === "string" ? deltaThink : (deltaThink.text || ""));
            const finishContent = evt.choices?.[0]?.message?.content;
            if (finishContent) aiFullContent = finishContent;
            if (evt.usage) console.log("[usage] " + JSON.stringify(evt.usage));
          } catch {}
        }
      }
      if (aiFullContent) {
        // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
        parseWakeTagAndSchedule(aiFullContent);
        // 提取并存储记忆，并拿到清洗后的文本
        const cleanFull = await tagParser.extractAndStore(aiFullContent).catch(err => {
          console.warn("[memory] 流式标签解析失败:", err.message);
          return aiFullContent;
        });
        // 把清洗后的 AI 回复追加到 kelivoMessages，然后重建时间线
        kelivoMessages.push({ role: "assistant", content: cleanFull });
        const rebuiltStream = buildTimeline(kelivoMessages);
        saveTimeline(rebuiltStream);
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
    const { content, event, diary, push_meta } = req.body;
    if (!content && !event && !diary) return reply.code(400).send({ error: "content or event is required" });
    if (diary) {
      appendSpecialEvent(`（${formatDateTimeInTimeZone(new Date(), TIME_ZONE)} 自动写了日记：${String(diary).trim()}）`);
    }
    if (event) {
      if (push_meta && isPushEchoContent(event)) {
        appendSpecialEvent(event, {
          event_type: "push",
          push_at: String(push_meta.at || ""),
          push_user: String(push_meta.user || "") || (process.env.USER_DISPLAY_NAME || "用户"),
          push_channel: String(push_meta.channel || "Bark"),
          push_title: String(push_meta.title || "").trim(),
          push_body: String(push_meta.body || "").trim(),
          push_tail: String(push_meta.tail || "")
        });
      } else {
        appendSpecialEvent(event);
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

function normalizePushProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "bark" || raw === "ntfy") return raw;
  return readEnvValueOrDefault("PUSH_PROVIDER", "bark");
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
// 管理台：修改日记（文件 + 时间线特殊事件同步）
// 编辑日记文件后，把时间线里同日的「自动写了日记」特殊事件一并更新，
// 保证注入 LLM 上下文的内容与日记文件一致。
// ========================
function syncDiarySpecialEvents(fileName, newContent) {
  const dateMatch = String(fileName || "").match(/^(\d{4}-\d{2}-\d{2})\.md$/i);
  if (!dateMatch) return 0;
  const dateKey = dateMatch[1];
  const timeline = loadTimeline();
  let updated = 0;
  const next = timeline.map(msg => {
    if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return msg;
    const text = msg.content;
    if (!text.includes("自动写了日记")) return msg;
    const head = text.match(/^（\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s*自动写了日记[:：]?\s*/);
    if (!head || head[1] !== dateKey) return msg;
    // 优先按「## 日期 时间」标题把对应条目摘出来；匹配不到就用整篇新内容
    let diaryText = String(newContent || "").trim();
    if (head[2]) {
      const timeEsc = head[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const entryRe = new RegExp("##\\s*" + dateKey + "\\s+" + timeEsc + "\\s*\\n([\\s\\S]*?)(?=\\n\\s*##\\s|$)", "i");
      const entryMatch = String(newContent || "").match(entryRe);
      if (entryMatch && entryMatch[1].trim()) diaryText = entryMatch[1].trim();
    }
    updated++;
    const timeLabel = head[2] ? `${head[1]} ${head[2]}` : head[1];
    return { ...msg, content: `（${timeLabel} 自动写了日记：${diaryText}）` };
  });
  if (updated > 0) {
    saveTimeline(next);
    console.log(`[diary] 已同步 ${updated} 条日记特殊事件（${fileName}）`);
  }
  return updated;
}

// 删除日记时同步移除时间线里同日的「自动写了日记」特殊事件
function removeDiarySpecialEvents(fileName) {
  const dateMatch = String(fileName || "").match(/^(\d{4}-\d{2}-\d{2})\.md$/i);
  if (!dateMatch) return 0;
  const dateKey = dateMatch[1];
  const timeline = loadTimeline();
  const before = timeline.length;
  const next = timeline.filter(msg => {
    if (!msg || msg.role !== "assistant" || typeof msg.content !== "string") return true;
    const text = msg.content;
    if (!text.includes("自动写了日记")) return true;
    const head = text.match(/^（\s*(\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2})?\s*自动写了日记[:：]?\s*/);
    return !(head && head[1] === dateKey);
  });
  const removed = before - next.length;
  if (removed > 0) {
    saveTimeline(next);
    console.log(`[diary] 已删除 ${removed} 条日记特殊事件（${fileName}）`);
  }
  return removed;
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
function createCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}
function ensureCsrfCookie(req, reply) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.admin_session && validSessionToken(cookies.admin_session) && !cookies.admin_csrf) {
    reply.header("Set-Cookie", `admin_csrf=${createCsrfToken()}; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`);
  }
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
    ensureCsrfCookie(req, reply);
    done();
    return;
  }
  reply.code(401).header("WWW-Authenticate", 'Basic realm="Admin"').send("Unauthorized");
}

function mobileAuth(req, reply, done) {
  if (isAuthorized(req)) {
    ensureCsrfCookie(req, reply);
    done();
    return;
  }
  reply.redirect(adminBasePath(req) + "/mobile/login");
}

// 管理台 CSRF 双提交校验：仅当请求携带有效会话 cookie 时，要求 X-CSRF-Token 与 admin_csrf cookie 一致。
// 使用 Basic 认证的脚本/客户端不受影响；登录接口与 /internal/ 内部工具接口不参与校验。
app.addHook("preHandler", (req, reply, done) => {
  const url = req.url || "";
  const isAdmin = url.startsWith("/admin") || url.startsWith("/heartbeat/admin");
  if (!isAdmin) return done();
  const method = (req.method || "").toUpperCase();
  if (!["POST", "PUT", "DELETE", "PATCH"].includes(method)) return done();
  if (url.endsWith("/mobile/login")) return done();
  const cookies = parseCookies(req.headers.cookie);
  if (!(cookies.admin_session && validSessionToken(cookies.admin_session))) return done();
  const cookieToken = cookies.admin_csrf || "";
  const headerToken = String(req.headers["x-csrf-token"] || "");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    reply.code(403).type("text/plain").send("CSRF token invalid");
    return done();
  }
  return done();
});

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
  input:focus{border-color:#d8a8b0;box-shadow:0 0 0 3px rgba(216,168,176,0.25)}
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
    const csrf = createCsrfToken();
    reply.header("Set-Cookie", [
      `admin_session=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`,
      `admin_csrf=${csrf}; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`
    ]);
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
      weather_units,
      all_public_api,
      push_provider,
      ntfy_server_url,
      ntfy_topic,
      ntfy_token,
      ntfy_priority,
      ntfy_tags,
      user_display_name,
      ai_display_name,
      diary_enabled
    } = req.body || {};

    if (!target_url || !model_name) {
      return reply.code(400).send({ error: "target_url / model_name 必填" });
    }

    const finalTargetKey = target_key || readEnvValue("TARGET_API_KEY");
    const finalGatewayKey = gateway_api_key || readEnvValue("GATEWAY_API_KEY");
    const finalBarkKey = bark_key || readEnvValue("BARK_KEY");

    // 批注 2026-06-26：公开版把唤醒策略和天气信息开放到管理页；保存时做轻量校验，避免空值把运行中的唤醒节奏写坏。
    // 批注 2026-07-15：GATEWAY_API_KEY 是公开 /v1 的客户端鉴权 key，不能和上游 TARGET_API_KEY 混在一起展示或返回。
    await writeEnvUpdates({
      TARGET_API_URL: target_url,
      TARGET_API_KEY: finalTargetKey,
      GATEWAY_API_KEY: finalGatewayKey,
      MODEL_NAME: model_name,
      BARK_KEY: finalBarkKey,
      CUSTOM_ICON_URL: custom_icon ?? readEnvValue("CUSTOM_ICON_URL"),
      DAY_WAKE_AFTER_MINUTES: normalizePositiveInteger(day_wake_after, "DAY_WAKE_AFTER_MINUTES", "60"),
      NIGHT_WAKE_AFTER_MINUTES: normalizePositiveInteger(night_wake_after, "NIGHT_WAKE_AFTER_MINUTES", "180"),
      DAY_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(day_check_interval, "DAY_CHECK_INTERVAL_MINUTES", "60"),
      NIGHT_CHECK_INTERVAL_MINUTES: normalizePositiveInteger(night_check_interval, "NIGHT_CHECK_INTERVAL_MINUTES", "180"),
      WAKE_DAY_START_HOUR: normalizeHour(wake_day_start_hour, "WAKE_DAY_START_HOUR", "10", 0, 23),
      WAKE_DAY_END_HOUR: normalizeHour(wake_day_end_hour, "WAKE_DAY_END_HOUR", "24", 1, 24),
      WEATHER_ENABLED: normalizeBooleanString(weather_enabled, "WEATHER_ENABLED", "false"),
      WEATHER_LOCATION_NAME: weather_location_name ?? readEnvValue("WEATHER_LOCATION_NAME"),
      WEATHER_LAT: weather_lat ?? readEnvValue("WEATHER_LAT"),
      WEATHER_LON: weather_lon ?? readEnvValue("WEATHER_LON"),
      WEATHER_UNITS: normalizeWeatherUnits(weather_units),
      ALLOW_PUBLIC_API: normalizeBooleanString(all_public_api, "ALLOW_PUBLIC_API", "false"),
      PUSH_PROVIDER: normalizePushProvider(push_provider),
      NTFY_SERVER_URL: ntfy_server_url ?? readEnvValue("NTFY_SERVER_URL"),
      NTFY_TOPIC: ntfy_topic ?? readEnvValue("NTFY_TOPIC"),
      NTFY_TOKEN: ntfy_token || readEnvValue("NTFY_TOKEN"),
      NTFY_PRIORITY: ntfy_priority ?? readEnvValue("NTFY_PRIORITY"),
      NTFY_TAGS: ntfy_tags ?? readEnvValue("NTFY_TAGS"),
      USER_DISPLAY_NAME: user_display_name ?? readEnvValue("USER_DISPLAY_NAME"),
      AI_DISPLAY_NAME: ai_display_name ?? readEnvValue("AI_DISPLAY_NAME"),
      DIARY_ENABLED: normalizeBooleanString(diary_enabled, "DIARY_ENABLED", "true"),
      ADMIN_USER: readEnvValue("ADMIN_USER"),
      ADMIN_PASSWORD: readEnvValue("ADMIN_PASSWORD")
    });
    console.log("\n✅ .env 已更新（热生效，无需重启）\n");

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
// 网易云环境
// ========================
app.get("/admin/netease", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const session = readNeteaseSession();
    let sessionUpdatedAt = null;
    try {
      sessionUpdatedAt = formatDateTimeInTimeZone(new Date(fs.statSync(NETEASE_SESSION_FILE).mtime), TIME_ZONE);
    } catch {}
    const cookieHeader = session.musicU
      ? `MUSIC_U=${session.musicU}` + (session.csrf ? `; __csrf=${session.csrf}` : "")
      : "";
    const account = await fetchNeteaseAccount(cookieHeader);
    reply.send({
      success: true,
      netease: {
        host: readNetEaseEnv("NETEASE_MCP_HOST") || "0.0.0.0",
        port: readNetEaseEnv("NETEASE_MCP_PORT") || "3303",
        cookieFile: readNetEaseEnv("NETEASE_MCP_COOKIE_FILE") || NETEASE_SESSION_FILE,
        accountWriteEnabled: readNetEaseEnv("NETEASE_MCP_ACCOUNT_WRITE_ENABLED") === "1",
        sessionSet: Boolean(session.musicU),
        sessionUpdatedAt,
        account
      }
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/netease/save", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const musicU = String(req.body?.music_u ?? "").trim();
    const csrf = String(req.body?.csrf ?? "").trim();
    if (!musicU && !csrf) {
      return reply.code(400).send({ error: "请至少填写 MUSIC_U" });
    }
    if (musicU && !/^[^\s;=]+$/.test(musicU)) {
      return reply.code(400).send({ error: "MUSIC_U 格式无效" });
    }
    if (csrf && !/^[^\s;=]+$/.test(csrf)) {
      return reply.code(400).send({ error: "__csrf 格式无效" });
    }
    const existing = readNeteaseSession();
    const finalMusicU = musicU || existing.musicU;
    const finalCsrf = csrf || existing.csrf;
    if (!finalMusicU) {
      return reply.code(400).send({ error: "缺少 MUSIC_U，无法保存会话" });
    }
    writeNeteaseSession(finalMusicU, finalCsrf);
    const account = await fetchNeteaseAccount(`MUSIC_U=${finalMusicU}` + (finalCsrf ? `; __csrf=${finalCsrf}` : ""));
    reply.send({ success: true, account });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
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
  // 安全校验：允许白名单内的重启命令，也允许「cd <指定目录> && <白名单命令>」形式。
  // 管理台重启按钮使用 cd /opt/dylan-heartbeat && pm2 restart ...，确保在项目目录下执行，pm2 能可靠找到进程。
  const ALLOWED_RESTART_DIRS = ["/opt/dylan-heartbeat"];
  const ALLOWED_RESTART_CMDS = ["pm2 restart ", "pm2 reload ", "systemctl restart ", "service restart ", "supervisorctl restart "];
  const trimmedCmd = String(restartCommand || "").trim();
  // 若为「cd <dir> && <cmd>」形式，拆分校验：目录必须在白名单内，且后续命令须为白名单命令
  const cdMatch = trimmedCmd.match(/^cd\s+([^\s&]+)\s*&&\s*(.+)$/);
  if (cdMatch) {
    const dir = cdMatch[1];
    const rest = cdMatch[2].trim();
    if (!ALLOWED_RESTART_DIRS.includes(dir) || !ALLOWED_RESTART_CMDS.some(prefix => rest.startsWith(prefix))) {
      console.error("重启命令不在白名单内，已拒绝:", trimmedCmd);
      return;
    }
  } else if (!ALLOWED_RESTART_CMDS.some(prefix => trimmedCmd.startsWith(prefix))) {
    console.error("重启命令不在白名单内，已拒绝:", trimmedCmd);
    return;
  }
  // 经 sh -c 执行：支持 cd && 与 2>&1 重定向；白名单已在上方校验，避免任意命令注入。
  const { spawn } = require("child_process");
  const child = spawn("sh", ["-c", trimmedCmd], { cwd: "/opt/dylan-heartbeat" });
  let out = "", errOut = "";
  child.stdout.on("data", d => out += d);
  child.stderr.on("data", d => errOut += d);
  child.on("close", code => {
    if (code !== 0) console.error("重启失败:", errOut || String(code));
    else console.log("服务已重启:", out);
  });
});

// ========================

// ========================
// 记忆管理 API
// ========================

// 记忆语义检索（MCP 工具调用，AI 主动检索记忆；只读，不触碰冷却/浮现状态）

// ========================
// 心动时刻同步（heart 网页为唯一真源，记忆池只做检索镜像）
// ========================
// 按网页 id (source_moment_id) 增量同步：新增 / 更新 / 复活


// 上下文记忆替换：AI 调用 MCP 工具时走这里（x-internal-key 鉴权）
app.post("/internal/context-replacements/apply", async (req, reply) => {
  try {
    const body = req.body || {};
    const result = contextReplacements.addReplacement({ range: body.range || {}, memory: body.memory });
    reply.send(result);
  } catch (err) {
    console.error("[POST /internal/context-replacements/apply] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/internal/context-replacements/list", async (req, reply) => {
  try {
    reply.send({ items: contextReplacements.listReplacements() });
  } catch (err) {
    console.error("[GET /internal/context-replacements/list] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.post("/internal/context-replacements/undo", async (req, reply) => {
  try {
    reply.send(contextReplacements.removeReplacement(String((req.body || {}).id || "").trim()));
  } catch (err) {
    console.error("[POST /internal/context-replacements/undo] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/internal/context-search", async (req, reply) => {
  try {
    reply.send(contextReplacements.searchTimeline(req.query.q, req.query.limit));
  } catch (err) {
    console.error("[GET /internal/context-search] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池检索：MCP 工具 memory_search 用（x-internal-key 鉴权）
app.get("/internal/memory-pool/retrieve", async (req, reply) => {
  try {
    const q = String(req.query.q || "").trim();
    const topK = Number(req.query.limit) || 5;
    const category = String(req.query.category || "").trim();
    const items = memoryPool.retrieve(q, { topK, category: category || undefined });
    reply.send({ ok: true, total: items.length, items });
  } catch (err) {
    console.error("[GET /internal/memory-pool/retrieve] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 永久注入上下文（pin）：MCP 工具 pin_add / pin_update / pin_delete 用
app.get("/internal/pin", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const list = engine.getPinnedMemories ? engine.getPinnedMemories() : [];
    const safe = list.map(m => ({
      id: m.id,
      title: m.title || "",
      content: m.content || "",
      order: m.order || 0,
      updated_at: m.updated_at || ""
    }));
    reply.send({ count: safe.length, pins: safe });
  } catch (err) {
    console.error("[GET /internal/pin] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.post("/internal/pin", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const body = req.body || {};
    const content = String(body.content || "").trim();
    if (!content) return reply.code(400).send({ error: "content 必填" });
    const mem = await engine.addPinnedMemory({ title: String(body.title || "").trim(), content: content }, { allowDeleted: true });
    reply.send({ success: true, pin: mem });
  } catch (err) {
    console.error("[POST /internal/pin] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.put("/internal/pin/:id", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const body = req.body || {};
    const updates = {};
    if (body.title !== undefined) updates.title = String(body.title).trim();
    if (body.content !== undefined) {
      const c = String(body.content).trim();
      if (!c) return reply.code(400).send({ error: "content 不能为空" });
      updates.content = c;
    }
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "没有可更新的字段（title/content）" });
    }
    const mem = await engine.updatePinnedMemory(req.params.id, updates);
    if (!mem) return reply.code(404).send({ error: "pin 不存在: " + req.params.id });
    reply.send({ success: true, pin: mem });
  } catch (err) {
    console.error("[PUT /internal/pin] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.delete("/internal/pin/:id", async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const ok = await engine.deletePinnedMemory(req.params.id);
    if (!ok) return reply.code(404).send({ error: "pin 不存在: " + req.params.id });
    reply.send({ success: true });
  } catch (err) {
    console.error("[DELETE /internal/pin] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆统计
app.get("/admin/stats", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const stats = typeof memoryPool.stats === "function" ? memoryPool.stats() : { total: 0, active: 0, byType: {}, pinned: 0, sunk: 0 };
    reply.send(stats);
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});


// 给下一个窗口自己的信：列表（管理台信封页，新的在前）


// 记忆列表（支持搜索和分页）

// 获取单条记忆 (剥离 embedding 避免传输大量数据)

// 删除单条记忆

// 编辑单条记忆

// 批量归档

// 批量永久删除沉底记忆（物理移除，不可恢复；清理指向被删记忆的 superseded_by 引用）

// 批量恢复沉底记忆（active=true 重新参与检索；同时清除被覆盖标记）


// 批量导入记忆

// 查找相似记忆（重复检测）

// 词云关键词（管理台：统计活跃记忆的关键词与权重，前端渲染词云卡片）
app.get("/admin/memories/keywords", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const limit = parseInt(req.query.limit) || 80;
    const keywords = typeof memoryPool.poolKeywords === "function" ? memoryPool.poolKeywords(limit) : [];
    reply.send({ keywords });
  } catch (err) {
    console.error("[GET /admin/memories/keywords] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 记忆池（8 分类结构化记忆）管理
// ========================
app.get("/admin/memory-pool", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const opts = {
      category: req.query.category || "",
      q: req.query.q || "",
      active: req.query.active === "" ? undefined : (req.query.active === "true" ? true : req.query.active === "false" ? false : undefined),
      pinned: req.query.pinned === "" ? undefined : (req.query.pinned === "true" ? true : req.query.pinned === "false" ? false : undefined),
      sort: req.query.sort || "score"
    };
    reply.send({ items: memoryPool.list(opts), stats: memoryPool.stats(), categories: memoryPool.CATEGORIES, config: memoryPool.getConfig() });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/memory-pool/stats", { preHandler: basicAuth }, async (req, reply) => {
  try { reply.send(memoryPool.stats()); } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    if (!String(b.content || "").trim()) return reply.code(400).send({ error: "content 必填" });
    const r = memoryPool.add({ content: b.content, category: b.category, importance: b.importance, source: "manual" });
    reply.send({ success: true, dup: r.dup, entry: r.entry });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.put("/admin/memory-pool/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = memoryPool.update(req.params.id, req.body || {});
    if (!r) return reply.code(404).send({ error: "记忆不存在" });
    reply.send({ success: true, entry: r });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.delete("/admin/memory-pool/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const ok = memoryPool.remove(req.params.id);
    if (!ok) return reply.code(404).send({ error: "记忆不存在" });
    reply.send({ success: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool/sink", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = memoryPool.sink(String((req.body || {}).id || ""));
    if (!r) return reply.code(404).send({ error: "记忆不存在" });
    reply.send({ success: true, entry: r });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool/revive", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = memoryPool.revive(String((req.body || {}).id || ""));
    if (!r) return reply.code(404).send({ error: "记忆不存在" });
    reply.send({ success: true, entry: r });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool/retrieve", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const q = String((req.body || {}).query || "").trim();
    const topK = Number((req.body || {}).topK) || 5;
    const items = memoryPool.retrieve(q, { topK });
    reply.send({ success: true, items, config: memoryPool.getConfig() });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool/reparse", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    const fsx = require("fs-extra");
    const cf = require("path").join(__dirname, "data", "context_replacements.json");
    let records = [];
    try { records = await fsx.readJson(cf); } catch (e) { records = []; }
    const active = Array.isArray(records) ? records.filter(function (it) { return it && !it.removed && it.enabled !== false; }) : [];
    const blockSummary = function (item) {
      const summary = String(item.text || item.memory || "").trim();
      const sig = String(item.id || "").trim();
      if (!summary) return null;
      return { summary: summary, block_id: sig || null };
    };
    let texts = [];
    let logLabel = "再解析";
    if (b.summary) {
      texts.push({ summary: b.summary, block_id: b.block_id || null });
      logLabel = "手动再解析";
    } else if (Array.isArray(b.chunkIds) && b.chunkIds.length) {
      // 前端批量解析传记录 id（chunkIds），按 id 精确匹配，避免依赖预览索引
      const idSet = new Set(b.chunkIds.map(String));
      for (const item of active) {
        if (!idSet.has(String(item.id))) continue;
        const t = blockSummary(item);
        if (t) texts.push(t);
      }
      logLabel = "批量再解析（" + texts.length + " 条）";
    } else if (b.all === true) {
      for (const item of active) {
        const t = blockSummary(item);
        if (t) texts.push(t);
      }
      logLabel = "全部再解析";
    }
    if (!texts.length) return reply.code(400).send({ error: "无可解析的摘要" });
    const list = texts.slice(0, 200);
    const logId = addCompactionLog({ action: "reparse", label: logLabel, status: "pending", message: "开始解析 " + list.length + " 段摘要..." }).id;
    let added = 0, merged = 0, failed = 0;
    for (const t of list) {
      const r = await memoryPool.ingestSummary(t.summary, { source: "compaction", block_id: t.block_id });
      if (r.added) added += r.added;
      if (r.merged) merged += r.merged;
      if (r.failed) failed += r.failed;
    }
    addCompactionLog({ id: logId, action: "reparse", label: logLabel, status: "success", message: "已解析 " + list.length + " 段 -> 新增 " + added + " / 合并 " + merged + " / 失败 " + failed });
    reply.send({ success: true, processed: list.length, added, merged, failed });
  } catch (err) {
    addCompactionLog({ action: "reparse", label: "再解析", status: "error", message: "再解析失败：" + err.message });
    reply.code(500).send({ error: err.message });
  }
});

app.get("/admin/memory-pool/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = memoryPool.getConfig();
    const def = memoryPool.buildReparsePrompt(!!cfg.reparse_warm);
    reply.send({ ...cfg, default_reparse_system_prompt: def.system, default_reparse_user_prompt: def.user });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-pool/config", { preHandler: basicAuth }, async (req, reply) => {
  try { reply.send(memoryPool.setConfig(req.body || {})); } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 推送管理（时间线里的推送回显）
// ========================
// 判断是否为「成功发送的推送回显」（排除“未发送”）
function isPushEchoContent(s) {
  const c = String(s || "");
  return !!c && !c.includes("本次未发送") && /刚刚给.{1,24}发了.{1,24}?推送：/.test(c);
}
function isPushEcho(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return isPushEchoContent(msg.content);
}
// 解析推送回显内容
function parsePushEcho(content) {
  const c = String(content || "").trim();
  const m = c.match(/^（([^（]*?)刚刚给([^：]*?)发了([^：]*?)推送：(.+)$/);
  if (!m) return null;
  const at = (m[1] || "").trim();
  const user = (m[2] || "").trim();
  const channel = (m[3] || "").trim();
  let rest = m[4] || "";
  let tail = "";
  const closeIdx = rest.lastIndexOf("）");
  if (closeIdx >= 0) { tail = rest.slice(closeIdx + 1); rest = rest.slice(0, closeIdx); }
  let title = "", body = "";
  const bar = rest.indexOf("｜");
  if (bar >= 0) { title = rest.slice(0, bar).trim(); body = rest.slice(bar + 1).trim(); }
  else { body = rest.trim(); }
  return { at: at, user: user, channel: channel, title: title, body: body, tail: tail };
}
function buildPushEcho(meta) {
  const user = meta.user || (process.env.USER_DISPLAY_NAME || "用户");
  const channel = meta.channel || "Bark";
  const tail = meta.tail || "";
  return "（" + (meta.at || "") + " 刚刚给" + user + "发了" + channel + "推送：" + (meta.title || "") + "｜" + (meta.body || "") + "）" + tail;
}
// 推送回显缺时间时的兜底：用消息自身的生成时间换算本地时间（UTC+8），避免管理台显示空白
function fmtLocalAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function pushEchoMeta(msg) {
  if (msg.push_title || msg.push_body) {
    return {
      position: msg.position,
      content: msg.content,
      at: msg.push_at || fmtLocalAt(msg.time) || "",
      user: msg.push_user || (process.env.USER_DISPLAY_NAME || "用户"),
      channel: msg.push_channel || "Bark",
      title: msg.push_title || "",
      body: msg.push_body || "",
      tail: msg.push_tail || "",
      structured: true
    };
  }
  const parsed = parsePushEcho(msg.content);
  if (!parsed) return null;
  return { position: msg.position, content: msg.content, structured: false, at: parsed.at || fmtLocalAt(msg.time) || "", user: parsed.user, channel: parsed.channel, title: parsed.title, body: parsed.body, tail: parsed.tail };
}
function toEpoch(at) {
  const m = String(at || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

app.get("/admin/push-events", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const timeline = require("fs-extra").readJsonSync(path.join(__dirname, "enhanced_messages.json"));
    if (!Array.isArray(timeline)) return reply.send({ items: [] });
    const items = timeline.filter(function (x) { return !x.deleted; }).map(pushEchoMeta).filter(Boolean);
    items.sort(function (a, b) {
      const ta = toEpoch(a.at), tb = toEpoch(b.at);
      if (ta != null && tb != null) return tb - ta;
      return (b.position || 0) - (a.position || 0);
    });
    reply.send({ items: items });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/cross-window-inject", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let text = "";
    try { text = buildCrossWindowInjection(); } catch (cx) { console.warn("[cross-inject] 预览失败:", cx.message); }
    reply.send({ text: text });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

function writeTimelineAtomic(list) {
  const fsx = require("fs-extra");
  const tmp = path.join(__dirname, "enhanced_messages.json.tmp");
  fsx.writeJsonSync(tmp, list, { spaces: 2 });
  fsx.renameSync(tmp, path.join(__dirname, "enhanced_messages.json"));
}
app.post("/admin/push-events/update", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    const position = Number(b.position);
    const content = String(b.content || "");
    const title = String(b.title || "").trim();
    const body = String(b.body || "").trim();
    if (!body) return reply.send({ error: "内容不能为空" });
    const timeline = require("fs-extra").readJsonSync(path.join(__dirname, "enhanced_messages.json"));
    if (!Array.isArray(timeline)) return reply.send({ error: "时间线不可读" });
    const idx = timeline.findIndex(function (x) { return x.role === "assistant" && x.position === position && x.content === content; });
    if (idx < 0) return reply.code(404).send({ error: "记录不存在" });
    const msg = timeline[idx];
    const meta = pushEchoMeta(msg) || {};
    msg.content = buildPushEcho({ at: meta.at || "", user: meta.user || "", channel: meta.channel || "Bark", title: title, body: body, tail: meta.tail || "" });
    msg.push_title = title;
    msg.push_body = body;
    msg.push_tail = meta.tail || "";
    msg.updated_at = new Date().toISOString();
    writeTimelineAtomic(timeline);
    reply.send({ success: true, entry: pushEchoMeta(msg) });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/push-events/delete", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    const position = Number(b.position);
    const content = String(b.content || "");
    const timeline = require("fs-extra").readJsonSync(path.join(__dirname, "enhanced_messages.json"));
    if (!Array.isArray(timeline)) return reply.send({ error: "时间线不可读" });
    const idx = timeline.findIndex(function (x) { return x.role === "assistant" && x.position === position && x.content === content; });
    if (idx < 0) return reply.code(404).send({ error: "记录不存在" });
    const msg = timeline[idx];
    // 软删除：不移动数组元素（编号范围不变，避免破坏压缩/替换块），保留原内容供时间排序，
    // 仅打 deleted 标记；模型请求注入、压缩摘要文本、面板都会过滤掉它。
    msg.deleted = true;
    msg.deleted_at = new Date().toISOString();
    writeTimelineAtomic(timeline);
    reply.send({ success: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 触发摘要（支持 exclude：手动摘要前剔除不需要写摘要的消息下标，从待摘要队列移除）
// 手动摘要窗口：删除所选（从待摘要队列永久移除，不可恢复）


// 最近一次摘要信息

// 上下文记忆替换：管理台撤销（压缩页 AI 块的「撤销」按钮用）
app.post("/admin/context-replacements/undo", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(contextReplacements.removeReplacement(String((req.body || {}).id || "").trim()));
  } catch (err) {
    console.error("[POST /admin/context-replacements/undo] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 切换 AI 记忆替换块的启用状态（停用 = 保留记录但不再替换）
app.post("/admin/context-replacements/toggle", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const enabled = body.enabled !== false;
    reply.send(contextReplacements.toggleReplacement(String(body.id || "").trim(), enabled));
  } catch (err) {
    console.error("[POST /admin/context-replacements/toggle] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});


// 编辑 AI 记忆替换的正文（用户改了 AI 写的记忆）
app.post("/admin/context-replacements/update", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const r = contextReplacements.updateReplacement(String(body.id || "").trim(), String(body.memory || ""));
    if (!r.ok) return reply.send({ ok: false, error: r.error });
    return reply.send({ ok: true, item: r.item });
  } catch (err) {
    console.error("[POST /admin/context-replacements/update] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 手动新增摘要：创建一个 manual 块并直接填入指定内容（不调模型；默认未启用，点块上「替换」才生效）
app.post("/admin/context-replacements/add-manual", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const start = parseInt(body.start, 10);
    const end = parseInt(body.end, 10);
    const memory = String(body.memory || "").trim();
    const enabled = body.enabled === true;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return reply.send({ ok: false, error: "无效的范围（start/end 为第几条，从 1 开始）" });
    }
    if (!memory) return reply.send({ ok: false, error: "摘要内容不能为空" });
    const r = contextReplacements.addManualRecord(start - 1, end - 1, enabled);
    if (!r.ok) return reply.send({ ok: false, error: r.message || r.error || "创建失败" });
    const upd = contextReplacements.updateReplacement(r.record.id, memory);
    if (!upd.ok) return reply.send({ ok: false, error: upd.error || "填写摘要失败" });
    console.log("[POST /admin/context-replacements/add-manual] 已新增摘要：", start, "-", end, "->", String(memory.slice(0, 40)), "...");
    reply.send({ ok: true, id: r.record.id, count: r.record.count, message: "已新增摘要：第 " + start + "–" + end + " 条" });
  } catch (err) {
    console.error("[POST /admin/context-replacements/add-manual] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});


app.get("/admin/context-replacements/logs", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cap = Number((req.query && req.query.limit) || 0);
    reply.send({ entries: contextReplacements.getReplaceLog(cap) });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 工具集管理（mcp-tools）：停用工具 / 改说明 / 改 schema + 服务启停
// ========================
const MCP_TOOLS_DIR = "/root/workspace/mcp-tools";
const MCP_TOOLS_CONFIG = path.join(MCP_TOOLS_DIR, "tools_config.json");
const MCP_TOOLS_MANIFEST = path.join(MCP_TOOLS_DIR, "tools_manifest.json");
const MCP_TOOLS_HISTORY = path.join(MCP_TOOLS_DIR, "tools_history.json");

// 覆盖项合并：新值 null 表示“清除覆盖”，其余按 key 覆盖；返回全新对象
function mergeOverrideObj(oldObj, newObj) {
  const merged = Object.assign({}, oldObj || {});
  if (newObj && typeof newObj === "object") {
    Object.keys(newObj).forEach(function (k) {
      if (newObj[k] === null || newObj[k] === undefined) delete merged[k];
      else merged[k] = newObj[k];
    });
  }
  return merged;
}

function readToolsHistory() {
  const list = readJsonFileSafe(MCP_TOOLS_HISTORY, []);
  return Array.isArray(list) ? list : [];
}

let toolsWriteChain = Promise.resolve();
function appendToolsHistory(entries) {
  const task = async () => {
    if (!entries || !entries.length) return readToolsHistory().slice(0, 300);
    const hist = entries.concat(readToolsHistory()).slice(0, 300); // 新的在前
    writeJsonFileAtomic(MCP_TOOLS_HISTORY, hist);
    return hist;
  };
  toolsWriteChain = toolsWriteChain.then(task, task);
  return toolsWriteChain;
}

// 对比旧/新配置，生成修改记录
function buildToolsHistory(oldDisabled, oldDesc, oldSchema, newDisabled, newDesc, newSchema) {
  const now = new Date().toISOString();
  const entries = [];
  const oldD = new Set(oldDisabled || []);
  const newD = new Set(newDisabled || []);
  newD.forEach(function (n) {
    if (!oldD.has(n)) entries.push({ time: now, tool: n, field: "enabled", old: true, new: false, source: "工具页" });
  });
  oldD.forEach(function (n) {
    if (!newD.has(n)) entries.push({ time: now, tool: n, field: "enabled", old: false, new: true, source: "工具页" });
  });
  const descKeys = new Set(Object.keys(oldDesc || {}).concat(Object.keys(newDesc || {})));
  descKeys.forEach(function (name) {
    const oldV = (oldDesc && oldDesc[name]) || "";
    const newV = (newDesc && newDesc[name]) || "";
    if (oldV !== newV) entries.push({ time: now, tool: name, field: "description", old: oldV, new: newV, source: "工具页" });
  });
  const schemaKeys = new Set(Object.keys(oldSchema || {}).concat(Object.keys(newSchema || {})));
  schemaKeys.forEach(function (name) {
    const oldS = JSON.stringify((oldSchema && oldSchema[name]) || {});
    const newS = JSON.stringify((newSchema && newSchema[name]) || {});
    if (oldS !== newS) entries.push({ time: now, tool: name, field: "schema", old: oldS, new: newS, source: "工具页" });
  });
  return entries;
}


const MANAGED_SERVICES = [
  { name: "mcp-tools", type: "systemd", label: "工具集 MCP（8771）" },
  { name: "mcp-ssh", type: "systemd", label: "SSH MCP（9000）" },
  { name: "zzf-mcp", type: "systemd", label: "远程玩具 MCP（8890）" },
  { name: "gateway", type: "pm2", label: "网关 gateway" },
  { name: "wake-up", type: "pm2", label: "唤醒 wake-up" },
  { name: "heart-web", type: "pm2", label: "心跳网页 heart-web" },
  { name: "netease-music-mcp", type: "port", port: 3303, label: "网易云 MCP（3303）", cmd: "cd /opt/netease-music-mcp && PORT=3303 nohup node src/http-server.js > http-server.log 2>&1 &", pattern: "netease-music-mcp" },
  { name: "decision-trail", type: "port", port: 8787, label: "决策痕迹 MCP（8787）", cmd: "cd /root/workspace/decision-trail && PORT=8787 nohup node server.mjs >> logs/server.log 2>&1 &", pattern: "decision-trail" },
  { name: "spicy-monopoly", type: "port", port: 8773, label: "涩涩大富翁 MCP（8773）", cmd: "cd /root/spicy-monopoly && SPICY_MONOPOLY_MCP_TRANSPORT=streamable-http SPICY_MONOPOLY_MCP_HOST=0.0.0.0 SPICY_MONOPOLY_MCP_PORT=8773 SPICY_MONOPOLY_MCP_PATH=/mcp SPICY_MONOPOLY_MCP_BEARER_TOKEN=han-xie-2026 nohup node mcp-server.js > mcp_spicy.log 2>&1 &", pattern: "spicy-monopoly" }
];

function readJsonFileSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return fallback;
  }
}

function writeJsonFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function runShellCommand(cmd) {
  const { execSync } = require("child_process");
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 20000 }).trim();
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: String(err.stdout || err.message || "").trim() };
  }
}

function serviceStatus(svc) {
  if (svc.type === "systemd") {
    const r = runShellCommand("systemctl is-active " + svc.name);
    return r.output || "unknown";
  }
  if (svc.type === "pm2") {
    const r = runShellCommand("pm2 jlist");
    try {
      const list = JSON.parse(r.output || "[]");
      const app = list.find(function (a) { return a.name === svc.name; });
      if (!app) return "stopped";
      return app.pm2_env && app.pm2_env.status || "unknown";
    } catch (e) { return "unknown"; }
  }
  if (svc.type === "port") {
    const r = runShellCommand("ss -ltn 2>/dev/null | grep -c ':" + svc.port + " ' || true");
    return Number(r.output || 0) > 0 ? "running" : "stopped";
  }
  return "unknown";
}

function serviceControl(svc, action) {
  if (action === "status") return { ok: true, status: serviceStatus(svc) };
  if (svc.type === "systemd") {
    const r = runShellCommand("systemctl " + action + " " + svc.name);
    return { ok: r.ok, status: serviceStatus(svc), output: r.output };
  }
  if (svc.type === "pm2") {
    if (action === "restart") {
      const r = runShellCommand("pm2 restart " + svc.name + " --update-env");
      return { ok: r.ok, status: serviceStatus(svc), output: r.output };
    }
    if (action === "start" || action === "stop") {
      const r = runShellCommand("pm2 " + action + " " + svc.name);
      return { ok: r.ok, status: serviceStatus(svc), output: r.output };
    }
    return { ok: false, error: "不支持的操作" };
  }
  if (svc.type === "port") {
    if (action === "start") {
      if (serviceStatus(svc) === "running") return { ok: true, status: "running", output: "已在运行" };
      const r = runShellCommand(svc.cmd + " ; sleep 1; echo started");
      return { ok: r.ok, status: serviceStatus(svc), output: r.output };
    }
    if (action === "stop") {
      const r = runShellCommand("pkill -f " + svc.pattern + " || true; sleep 1");
      return { ok: true, status: serviceStatus(svc), output: "已发送停止信号" };
    }
    if (action === "restart") {
      runShellCommand("pkill -f " + svc.pattern + " || true; sleep 1");
      const r = runShellCommand(svc.cmd + " ; sleep 1; echo restarted");
      return { ok: true, status: serviceStatus(svc), output: r.output };
    }
    return { ok: false, error: "不支持的操作" };
  }
  return { ok: false, error: "未知服务类型" };
}

app.get("/admin/tools", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const manifest = readJsonFileSafe(MCP_TOOLS_MANIFEST, null);
    const config = readJsonFileSafe(MCP_TOOLS_CONFIG, {});
    reply.send({
      manifest: manifest,
      config: config,
      history: readToolsHistory().slice(0, 100),
      config_path: MCP_TOOLS_CONFIG,
      manifest_path: MCP_TOOLS_MANIFEST,
      note: manifest ? null : "工具清单还没生成：请先重启 mcp-tools 服务（或点下方「重启」）"
    });
  } catch (err) {
    console.error("[GET /admin/tools] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.put("/admin/tools", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const existing = readJsonFileSafe(MCP_TOOLS_CONFIG, {});
    const oldDisabled = Array.isArray(existing.disabled) ? existing.disabled : [];
    const oldDescriptions = (existing.descriptions && typeof existing.descriptions === "object") ? existing.descriptions : {};
    const oldSchemas = (existing.schemas && typeof existing.schemas === "object") ? existing.schemas : {};
    const disabled = Array.isArray(body.disabled) ? body.disabled.filter(function (n) { return typeof n === "string"; }) : oldDisabled;
    const descriptions = mergeOverrideObj(oldDescriptions, body.descriptions);
    const schemas = mergeOverrideObj(oldSchemas, body.schemas);
    writeJsonFileAtomic(MCP_TOOLS_CONFIG, { disabled: disabled, descriptions: descriptions, schemas: schemas });
    const history = buildToolsHistory(oldDisabled, oldDescriptions, oldSchemas, disabled, descriptions, schemas);
    // 历史在 appendToolsHistory 内串行化（读-改-写同链），并返回最新历史供展示
    const newestHistory = await appendToolsHistory(history);
    // 配置已热加载生效（tools_server 监控配置文件自动重载），无需重启服务
    const manifest = readJsonFileSafe(MCP_TOOLS_MANIFEST, null);
    reply.send({
      ok: true,
      restart: "hot-reload",
      manifest: manifest,
      config: readJsonFileSafe(MCP_TOOLS_CONFIG, {}),
      history: (newestHistory || readToolsHistory()).slice(0, 100)
    });
  } catch (err) {
    console.error("[PUT /admin/tools] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/admin/services", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const list = MANAGED_SERVICES.map(function (svc) {
      return { name: svc.name, label: svc.label, type: svc.type, status: serviceStatus(svc) };
    });
    reply.send({ services: list });
  } catch (err) {
    console.error("[GET /admin/services] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/services/:name/:action", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const name = String(req.params.name || "");
    const action = String(req.params.action || "");
    const svc = MANAGED_SERVICES.find(function (s) { return s.name === name; });
    if (!svc) return reply.code(404).send({ error: "未知服务: " + name });
    if (!["start", "stop", "restart", "status"].includes(action)) return reply.code(400).send({ error: "不支持的操作: " + action });
    reply.send(serviceControl(svc, action));
  } catch (err) {
    console.error("[POST /admin/services] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 配置管理：获取配置
// ========================
// 上下文压缩（分块预览 / 摘要生成 / 边界调整）
// ========================
// 词云关键词：从上下文文件（enhanced_messages.json 主对话时间线）提取
// 词云关键词接口已下线（统一替换后不再使用）

// ========================
// 统一替换预览（管理台「上下文压缩」页）：所有记录（AI + 手工）合并成块视图
// ========================
// 归一化内容键：去 memory/pin/current_time 块 + 压缩空白（与发送侧 applyReplacements 同口径）
function nKeyOfMsg(m) {
  const c = typeof (m && m.content) === "string" ? m.content : JSON.stringify((m && m.content) || "");
  const stripped = c
    .replace(/<memory>[\s\S]*?<\/memory>/gi, "")
    .replace(/<pin>[\s\S]*?<\/pin>/gi, "")
    .replace(/<current_time>[\s\S]*?<\/current_time>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return String((m && m.role) || "") + "\u0000" + stripped;
}

// 压缩索引位置表：非特殊事件的可压缩消息 -> 压缩空间下标（0 起）
function compressiblePosMap() {
  const items = contextReplacements.compressibleItems();
  const map = new Map();
  items.forEach(function (e, idx) {
    if (contextReplacements.isSpecialEvent(e.msg)) return;
    const k = nKeyOfMsg(e.msg);
    if (!map.has(k)) map.set(k, idx);
  });
  return map;
}

function buildUnifiedReplacementPreview(includeMessages, excludeGapMsgs) {
  const records = contextReplacements.loadItems().filter(it => !it.removed);
  const items = contextReplacements.compressibleItems();
  const totalCompressible = items.length;
  const compactCount = totalCompressible;
  const nonSys = (contextReplacements.loadTimeline() || []).filter(m => m && m.role !== "system");

  function keyOf(m) {
    return String(m.role || "") + "\u0000" + String(m.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  // 与发送侧 applyReplacements 同口径的归一化键，用于锚点定位（见模块级 nKeyOfMsg）
  const nKeyOf = nKeyOfMsg;
  // 压缩索引位置表：非特殊事件消息按归一化键定位（与发送侧 tlKeyToPos 同口径）
  const itemPosByKey = compressiblePosMap();

  const chunks = [];
  let totalChars = 0;
  items.forEach(function (e) { totalChars += String(e.msg.content || "").length; });

  records.forEach(function (it) {
    const matched = (Array.isArray(it.matched) && it.matched.length > 0) ? it.matched : [];
    if (matched.length === 0) return;
    // 锚点定位（与发送侧一致）：取首/末条非特殊压缩消息在时间线中的实际位置作为块边界。
    // 命中则显示为“已覆盖”，未命中则视为“未覆盖”（此时发送侧同样不会替换）。
    let aStart = null;
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      if (m && m.role !== "system" && !contextReplacements.isSpecialEvent(m)) { aStart = m; break; }
    }
    let aEnd = null;
    for (let i = matched.length - 1; i >= 0; i--) {
      const m = matched[i];
      if (m && m.role !== "system" && !contextReplacements.isSpecialEvent(m)) { aEnd = m; break; }
    }
    if (!aStart || !aEnd) return;
    // 手工块：直接信任创建时落库的精确压缩索引（0 起）。锚点定位在块首尾含特殊事件、
    // 或短消息归一化后撞键（如「哥哥 <current_time>…」）时会漂移，导致块被削头尾或整块丢弃。
    const storedStart = it.range && it.range.start_index;
    const storedEnd = it.range && it.range.end_index;
    const hasStoredIdx = Number.isInteger(storedStart) && Number.isInteger(storedEnd);
    let compStart = -1;
    let compEnd = -1;
    if (hasStoredIdx) {
      compStart = Math.max(0, storedStart);
      compEnd = Math.min(storedEnd, items.length - 1);
      if (compStart >= items.length || compEnd < compStart) return;
    } else {
      for (let i = 0; i < matched.length; i++) {
        const m = matched[i];
        if (!m || m.role === "system" || contextReplacements.isSpecialEvent(m)) continue;
        const k = itemPosByKey.get(nKeyOf(m));
        if (k !== undefined) { compStart = k; break; }
      }
      if (compStart < 0) return;
      for (let i = matched.length - 1; i >= 0; i--) {
        const m = matched[i];
        if (!m || m.role === "system" || contextReplacements.isSpecialEvent(m)) continue;
        const k = itemPosByKey.get(nKeyOf(m));
        if (k !== undefined) { compEnd = k; break; }
      }
      if (compEnd < compStart) return;
    }
    const headK = keyOf(aStart);
    const tailK = keyOf(aEnd);
    let nsHi = -1, nsTi = -1;
    for (let i = 0; i < nonSys.length; i++) if (keyOf(nonSys[i]) === headK) { nsHi = i; break; }
    for (let i = (nsHi >= 0 ? nsHi : 0); i < nonSys.length; i++) if (keyOf(nonSys[i]) === tailK) { nsTi = i; break; }
    const text = contextReplacements.recordText(it);
    const tl = String(it.range_label || "").split(" ~ ");
    const manual = it.source === "manual";
    chunks.push({
      aiRep: !manual,
      repId: manual ? undefined : it.id,
      id: it.id,
      source: it.source || "ai",
      index: 0,
      blockStart: compStart,
      blockEnd: compEnd,
      firstIdx: nsHi,
      lastIdx: nsTi,
      count: compEnd - compStart + 1,
      chars: text.length,
      startTime: tl[0] || "",
      endTime: tl[1] || "",
      head: text.slice(0, 40),
      tail: "",
      signature: "ctxrep_" + it.id,
      cached: !!text,
      summary: text,
      generatedAt: it.created_at || null,
      mode: manual ? "manual" : "ai",
      manual: manual,
      enabled: it.enabled !== false,
      range_label: it.range_label || "",
      original_preview: matched.slice(0, 2).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 150) })),
      history: (Array.isArray(it.history) ? it.history : []).map(function (h, i) { return { index: i, summary: h.summary, generatedAt: h.generatedAt, mode: h.mode || (manual ? "edited" : "ai"), manual: h.manual === true || manual }; }).slice(0, 8),
      msgs: includeMessages ? matched.map(function (m, i) {
        const _key = contextCompactor.contentKey(m);
        // 手工块：编号=存储起点+块内序号（matched 与压缩切片一一对应），避免锚点撞键漂移
        const _num = hasStoredIdx ? (storedStart + i) : (itemPosByKey.has(nKeyOf(m)) ? itemPosByKey.get(nKeyOf(m)) : null);
        return { role: m.role, content: typeof m.content === "string" ? m.content : "", key: _key, marked: !!contextCompactor.loadMarks()[_key], num: _num };
      }) : undefined,
      pos: compStart
    });
  });

  chunks.sort(function (a, b) { return a.pos - b.pos; });
  chunks.forEach(function (c, i) { c.index = i + 1; c.pos = undefined; });

  // 手工块序号（与页面 blockOrdinal 一致）
  let manualOrdinal = -1;
  chunks.forEach(function (c) {
    if (c.source === "manual") { manualOrdinal++; c.blockIndex = manualOrdinal; }
  });

  // 未覆盖区：union 覆盖范围取补集
  const ranges = chunks.map(function (c) { return { start: c.blockStart, end: c.blockEnd }; }).sort(function (a, b) { return a.start - b.start; });
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  const gapRanges = [];
  let prevEnd = -1;
  for (const m of merged) {
    if (m.start > prevEnd + 1) gapRanges.push({ start: prevEnd + 1, end: m.start - 1 });
    prevEnd = Math.max(prevEnd, m.end);
  }
  if (prevEnd < compactCount - 1) gapRanges.push({ start: prevEnd + 1, end: compactCount - 1 });

  let uncovered = null;
  if (gapRanges.length > 0) {
    uncovered = {
      startIdx: gapRanges[0].start + 1,
      endIdx: gapRanges[0].end + 1,
      count: gapRanges[0].end - gapRanges[0].start + 1,
      gaps: gapRanges.map(function (g) {
        const gInfo = {
          startIdx: g.start + 1,
          endIdx: g.end + 1,
          count: g.end - g.start + 1
        };
        if (includeMessages && !excludeGapMsgs) {
          try {
            const rp = contextCompactor.rangePreview(g.start + 1, g.end + 1);
            if (rp) {
              gInfo.msgs = rp.items || [];
              gInfo.startTime = rp.startTime || "";
              gInfo.endTime = rp.endTime || "";
            }
          } catch (e) {
            console.warn("[preview] 未覆盖区预览失败:", e.message);
          }
        }
        return gInfo;
      })
    };
  }

  const estCompressedChars = chunks.reduce(function (s, c) { return s + c.chars; }, 0);
  return {
    enabled: chunks.length > 0,
    config: contextCompactor.loadConfig(),
    totalCompressible: totalCompressible,
    compactCount: compactCount,
    keptRawCount: totalCompressible - chunks.reduce(function (s, c) { return s + (c.blockEnd - c.blockStart + 1); }, 0),
    cutPointsActive: chunks.some(function (c) { return c.source === "manual"; }),
    cutPointConfig: { id: null, matched: 0, configCount: 0 },
    uncovered: uncovered,
    chunks: chunks,
    totals: {
      chunkCount: chunks.length,
      aiCount: chunks.filter(function (c) { return c.source === "ai"; }).length,
      cachedCount: chunks.filter(function (c) { return c.cached; }).length,
      totalChars: totalChars,
      estCompressedChars: estCompressedChars,
      estSavedChars: Math.max(0, totalChars - estCompressedChars)
    }
  };
}

app.get("/admin/context-compaction/preview", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const includeMessages = req.query.includeMessages === "1";
    const excludeGapMsgs = req.query.excludeGapMsgs === "1";
    reply.send(buildUnifiedReplacementPreview(includeMessages, excludeGapMsgs));
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});
// 词云关键词：基于检索池（时间线 + 导入对话）提取高频重点词
app.get("/admin/context-compaction/keywords", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const limit = Math.floor(Number(req.query.limit) || 80);
    reply.send({ keywords: contextReplacements.extractPoolKeywords(limit) });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 压缩页搜索：搜全部原文，返回命中消息的原文编号(第X条) + 所属块
app.get("/admin/context-compaction/search", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.floor(Number(req.query.limit) || 50);
    reply.send(contextReplacements.searchCompactionOriginal(q, limit));
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 已标星消息列表：统一管理所有被标星的原正文
app.get("/admin/context-compaction/marked-list", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(contextReplacements.listMarked());
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 词云点词：检索池里包含该词的相关对话片段
app.get("/admin/context/keywords/related", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const word = String(req.query.word || "").trim();
    if (!word) return reply.code(400).send({ error: "word 不能为空" });
    reply.send(contextReplacements.searchRelatedSegments(word));
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});



// 块原文分页：按块 id 定位 matched 区间，供块展开惰性加载
app.get("/admin/context-compaction/block-messages", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const id = String(req.query.id || "").trim();
    const limit = Math.max(1, Math.min(500, Math.floor(Number(req.query.limit) || 200)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const rec = (contextReplacements.loadItems() || []).find(function (it) { return !it.removed && it.id === id; });
    if (!rec) return reply.code(404).send({ error: "块不存在: " + id });
    const matched = Array.isArray(rec.matched) ? rec.matched : [];
    const total = matched.length;
    const slice = (offset < total) ? matched.slice(offset, offset + limit) : [];
    const marks = contextCompactor.loadMarks();
    const posByKey = compressiblePosMap();
    const items = slice.map(function (m) {
      const _key = contextCompactor.contentKey(m);
      const _k = nKeyOfMsg(m);
      return { role: m.role || "", time: (m && m.time) || "", content: typeof m.content === "string" ? m.content : "", key: _key, marked: !!marks[_key], num: posByKey.has(_k) ? posByKey.get(_k) : null };
    });
    reply.send({ ok: true, id: id, total: total, offset: offset, returned: items.length, hasMore: (offset + items.length) < total, items: items });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 编号范围预览（1-based）：返回范围内每条原文，供未覆盖区滚动窗使用
app.get("/admin/context-compaction/range-preview", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : 0;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : 0;
    reply.send(contextCompactor.rangePreview(start, end, { limit: limit, offset: offset }));
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 读取压缩参数配置
app.get("/admin/context-compaction/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(contextCompactor.loadConfig());
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 保存压缩参数配置
app.post("/admin/context-compaction/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const r = contextCompactor.saveConfig(body);
    if (!r.ok) return reply.code(400).send({ error: r.message });
    reply.send({ ok: true, config: r.config });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});




// 恢复某块摘要的历史版本
// 历史版本恢复已下线（统一替换后摘要只保留当前正文）

// 「添加摘要」已下线（统一替换后直接在块里编辑正文）

// 保存手动编辑后的替换正文（统一替换：写入手工记录 text）
app.post("/admin/context-compaction/update", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const chunkIndex = Number(body.chunkIndex);
  const summary = String(body.summary || "").trim();
  try {
    if (!summary) return reply.code(400).send({ error: "替换正文不能为空" });
    const preview = buildUnifiedReplacementPreview(false);
    const chunk = (preview.chunks || []).find(function (c) { return c.index === chunkIndex && c.source === "manual"; });
    if (!chunk) return reply.code(404).send({ error: "块 #" + chunkIndex + " 不存在" });
    const r = contextReplacements.setManualRecordText(chunk.blockIndex, summary);
    if (!r.ok) return reply.code(400).send({ error: r.message });
    reply.send({ ok: true, summary: summary, length: r.length });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// 重要内容标记（恢复：前端按消息 key 标记，引擎 buildCompactionPrompt 会重点保留）
app.post("/admin/context-compaction/mark", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const key = String(body.key || "").trim();
  if (!key) return reply.code(400).send({ error: "key 无效" });
  try {
    // 标星时把原文一并传给 setMark 存进 marks 文件，
    // 跨窗口注入就能直接读原文，不再依赖回查时间线/替换池
    let content = "", role = "";
    try {
      const items = (contextReplacements.loadItems ? contextReplacements.loadItems() : []) || [];
      for (const it of items) {
        const matched = Array.isArray(it.matched) ? it.matched : [];
        for (const m of matched) {
          if (!m) continue;
          let k = null;
          try { k = contextCompactor.contentKey(m); } catch (e) {}
          if (k === key) {
            content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map(function(p){return p&&(p.text||p.content)||"";}).join("") : "");
            role = m.role || "";
            break;
          }
        }
        if (content) break;
      }
    } catch (e) { /* 查找失败不阻断标星 */ }
    const markRes = contextCompactor.setMark(key, body.marked === true, { content: content, role: role });
    if (!markRes || markRes.ok === false) {
      return reply.code(400).send({ error: (markRes && markRes.error) || "标星失败" });
    }
    reply.send({ ok: true, key: key, marked: markRes.marked !== false });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 压缩上下文提示词（生成摘要时使用，恢复管理台编辑）
app.get("/admin/logs/compaction-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(contextCompactor.getCompactionPromptForDisplay());
  } catch (err) {
    reply.send({ error: err.message });
  }
});

app.post("/admin/logs/compaction-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = contextCompactor.saveCompactionPromptConfig(req.body && req.body.system, req.body && req.body.template);
    reply.send({ ok: true, system: cfg.system, template: cfg.template });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete("/admin/logs/compaction-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = contextCompactor.resetCompactionPromptConfig();
    reply.send({ ok: true, system: cfg.system, template: cfg.template });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 历史版本恢复/删除（恢复：前端压缩页历史版本按钮使用）
app.post("/admin/context-compaction/restore", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const chunkIndex = Number(body.chunkIndex);
  const historyIndex = Number(body.historyIndex);
  try {
    const preview = buildUnifiedReplacementPreview(false);
    const chunk = (preview.chunks || []).find(function (c) { return c.index === chunkIndex; });
    if (!chunk || !chunk.id) return reply.code(404).send({ error: "块 #" + chunkIndex + " 不存在" });
    const restored = contextReplacements.restoreHistory(chunk.id, historyIndex);
    if (!restored.ok) return reply.code(400).send({ error: restored.error || restored.message });
    reply.send({ ok: true, summary: restored.summary, generatedAt: restored.generatedAt, length: restored.summary.length });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/admin/context-compaction/history/delete", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const chunkIndex = Number(body.chunkIndex);
  const historyIndex = Number(body.historyIndex);
  try {
    const preview = buildUnifiedReplacementPreview(false);
    const chunk = (preview.chunks || []).find(function (c) { return c.index === chunkIndex; });
    if (!chunk || !chunk.id) return reply.code(404).send({ error: "块 #" + chunkIndex + " 不存在" });
    const r = contextReplacements.removeHistory(chunk.id, historyIndex);
    if (!r.ok) return reply.code(400).send({ error: r.error || r.message });
    reply.send({ ok: true, remaining: r.remaining });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// 强制替换标记已下线（统一替换：开关即替换/取消替换）
// 批量清除摘要已下线（统一替换后直接移除块）
// 自动分块配置已下线（统一替换：全部走手工块）

// 「添加一块 / 移除一块」：追加式分块——旧块边界完全不动，
// 添加 = 从最后一块之后的未覆盖内容里按自然边界切一块（约 chunk_size 条）；
// 移除 = 删除最后一个已定块，内容退回未覆盖区。
app.post("/admin/context-compaction/blocks", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const action = String(body.action || "");
  try {
    // 重置：清空所有手工替换记录
    if (action === "reset") {
      const r = contextReplacements.removeAllManualRecords();
      return reply.send({ ok: true, action: "reset", removedCount: r.removedCount || 0 });
    }
    // 移除指定手工块（0-based 序号）——内容退回未覆盖区
    if (action === "remove_at") {
      const blockIndex = Number(body.blockIndex);
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        return reply.code(400).send({ error: "blockIndex 必须是 >=0 的整数" });
      }
      const r = contextReplacements.removeManualRecord(blockIndex);
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "remove_at" });
    }
    // 按范围添加手工块（编号范围 1-based → 内部转 0-based；默认不启用，点「替换」后生效）
    if (action === "add_range") {
      const start = Number(body.start);
      const end = Number(body.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return reply.code(400).send({ error: "start/end 必须是 start<=end 的正整数（编号 1-based）" });
      }
      const r = contextReplacements.addManualRecord(start - 1, end - 1, false);
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "add_range", removedCount: r.removedCount || 0 });
    }
    // 开关某块的替换（enabled）
    if (action === "toggle") {
      const blockIndex = Number(body.blockIndex);
      const enabled = body.enabled !== false;
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        return reply.code(400).send({ error: "blockIndex 必须是 >=0 的整数" });
      }
      const r = contextReplacements.toggleManualRecord(blockIndex, enabled);
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "toggle", block: r.record });
    }
    // 更新指定手工块的起止范围（编号 1-based → 内部 0-based）
    if (action === "update_range") {
      const blockIndex = Number(body.blockIndex);
      const start = Number(body.start);
      const end = Number(body.end);
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        return reply.code(400).send({ error: "blockIndex 必须是 >=0 的整数" });
      }
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return reply.code(400).send({ error: "start/end 必须是 start<=end 的正整数（编号 1-based）" });
      }
      const r = contextReplacements.updateManualRecordRange(blockIndex, start - 1, end - 1);
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "update_range", removedCount: r.removedCount || 0 });
    }
    // 更新指定 AI 块的编号范围（1-based → 内部 0-based；保留时间范围存储，只改自身不吞并）
    if (action === "update_ai_range") {
      const repId = String(body.repId || "").trim();
      const start = Number(body.start);
      const end = Number(body.end);
      if (!repId) return reply.code(400).send({ error: "repId 不能为空" });
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return reply.code(400).send({ error: "start/end 必须是 start<=end 的正整数（编号 1-based）" });
      }
      const r = contextReplacements.updateAiRecordRange(repId, start - 1, end - 1);
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "update_ai_range", count: r.count });
    }

    // 按时间间隔自动切分：只切 [start,end] 范围，间隔超过 gapMinutes 分钟自然切成多个手工块
    if (action === "split_range") {
      const start = Number(body.start);
      const end = Number(body.end);
      const gapMinutes = Number(body.gapMinutes);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return reply.code(400).send({ error: "start/end 必须是 start<=end 的正整数（编号 1-based）" });
      }
      const ccCfg = contextCompactor.loadConfig ? (contextCompactor.loadConfig() || {}) : {};
      const r = contextReplacements.splitRangeByGaps(start - 1, end - 1, {
        gapMinutes: gapMinutes,
        chunkSize: Number(body.chunkSize) || Number(ccCfg.compaction_chunk_size) || 100,
        chunkMin: Number(body.chunkMin) || Number(ccCfg.compaction_chunk_min) || 40,
        chunkMax: Number(body.chunkMax) || Number(ccCfg.compaction_chunk_max) || 160
      });
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "split_range", count: r.count, gapMinutes: gapMinutes });
    }
    // 旧式自动分块操作已下线（统一替换）
    if (action === "add" || action === "remove") {
      return reply.send({ ok: false, message: "旧式自动分块已下线（统一替换后不再使用）" });
    }
    return reply.code(400).send({ error: "action 必须是 remove_at / add_range / toggle / update_range / split_range / reset" });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 摘要生成：gap = 未覆盖区按范围新建手工记录并生成替换正文（默认不启用，需点「替换」才生效）；
// block = 已有手工记录重新生成正文
function autoIngestSummary(summary, blockId, label) {
  if (!summary || typeof summary !== "string") return;
  const logLabel = label || "再解析";
  // 关闭「摘要再解析入库」后，摘要替换/生成不再自动入池（手动「重新解析入库」仍可显式触发）
  if (memoryPool.getConfig().reparse_enabled === false) {
    console.log("[memory-pool] 摘要再解析入库已关闭，跳过自动归入");
    addCompactionLog({ action: "reparse", label: logLabel, status: "skipped", message: "自动归入已关闭（reparse_enabled=false），跳过" });
    return;
  }
  memoryPool.ingestSummary(summary, { source: "compaction", block_id: blockId || null })
    .then(function (r) {
      if (r.skipped) {
        addCompactionLog({ action: "reparse", label: logLabel, status: "skipped", message: "再解析：摘要已存在，跳过" });
        return;
      }
      addCompactionLog({ action: "reparse", label: logLabel, status: "success", message: "再解析：新增 " + (r.added || 0) + " / 合并 " + (r.merged || 0) + " / 失败 " + (r.failed || 0) });
      console.log("[memory-pool] 自动归入:", JSON.stringify({ added: r.added, merged: r.merged, failed: r.failed }));
    })
    .catch(function (e) {
      addCompactionLog({ action: "reparse", label: logLabel, status: "error", message: "再解析失败：" + e.message });
      console.error("[memory-pool] 自动归入失败:", e.message);
    });
}


// ---------------- 摘要生成日志（内存队列，最近 100 条） ----------------
const COMPACTION_LOG_MAX = 100;
const compactionLogs = [];
function addCompactionLog(entry) {
  const log = Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), time: new Date().toISOString() }, entry);
  compactionLogs.unshift(log);
  if (compactionLogs.length > COMPACTION_LOG_MAX) compactionLogs.length = COMPACTION_LOG_MAX;
  return log;
}

app.get("/admin/context-compaction/logs", { preHandler: basicAuth }, (req, reply) => {
  reply.send({ logs: compactionLogs, max: COMPACTION_LOG_MAX });
});

app.post("/admin/context-compaction/generate", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  try {
    if (body.action === "gap") {
      const start = Number(body.start);
      const end = Number(body.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        return reply.code(400).send({ error: "start/end 必须是 start<=end 的正整数（编号 1-based）" });
      }
      const added = contextReplacements.addManualRecord(start - 1, end - 1, false);
      if (!added.ok) return reply.send(added);
      const manual = contextReplacements.manualRecordsSorted();
      const idx = manual.findIndex(function (b) {
        return b.range && Number(b.range.start_index) === start - 1;
      });
      if (idx === -1) return reply.code(500).send({ error: "块创建失败，请刷新后重试" });
      const logId = addCompactionLog({ action: "gap", startIdx: start, endIdx: end, label: "消息" + start + "-" + end + "块", status: "pending", message: "开始生成摘要..." }).id;
      let gen;
      try {
        gen = await contextCompactor.generateSummaryForRange(start - 1, end - 1);
      } catch (err) {
        addCompactionLog({ id: logId, action: "gap", startIdx: start, endIdx: end, label: "消息" + start + "-" + end + "块", status: "error", message: err.message });
        contextReplacements.removeManualRecord(idx); // 生成失败回滚新建的块
        throw err;
      }
      if (!gen.ok) {
        contextReplacements.removeManualRecord(idx);
        return reply.send(gen);
      }
      const saved = contextReplacements.setManualRecordText(idx, gen.summary);
      if (!saved.ok) {
        contextReplacements.removeManualRecord(idx);
        return reply.send({ ok: false, message: saved.message });
      }
      addCompactionLog({ id: logId, action: "gap", startIdx: start, endIdx: end, label: "消息" + start + "-" + end + "块", status: "success", message: "生成成功，" + gen.length + " 字" });
      autoIngestSummary(gen.summary, null, "消息" + start + "-" + end + "块");
      return reply.send({
        ok: true,
        action: "gap",
        blockIndex: idx,
        startIdx: start,
        endIdx: end,
        length: gen.length,
        message: "已生成替换正文（" + gen.length + " 字），点块上的「替换」后生效。"
      });
    }
    // 支持手动块（blockIndex）或任意记录（repId，含 AI 块）重新生成摘要
    const blocks = contextReplacements.manualRecordsSorted();
    let rec = null;
    let writeBack = null;
    let isManual = true;
    const repId = String(body.repId || "").trim();
    if (repId) {
      const items = contextReplacements.loadItems();
      rec = (items || []).filter(it => !it.removed).find(it => String(it.id || "") === repId) || null;
      if (!rec) return reply.send({ ok: false, message: "记录不存在" });
      isManual = rec.source === "manual";
      if (!isManual) writeBack = "updateReplacement";
    } else {
      const blockIndex = Number(body.blockIndex);
      if (!Number.isInteger(blockIndex) || blockIndex < 0) {
        return reply.code(400).send({ error: "blockIndex 必须是 >=0 的整数" });
      }
      rec = blocks[blockIndex];
      if (!rec) return reply.send({ ok: false, message: "块不存在" });
      writeBack = "manualText";
    }
    // 计算要传给压缩器的 compressible 序号区间
    // 手动块：range.start_index/end_index 即 compressible 序号；
    // AI 块 / 时间范围块：range 无 start_index，需用 matched 内容反查当前 compressible 序号
    let gStart = Number(rec.range.start_index);
    let gEnd = Number(rec.range.end_index);
    if (!Number.isInteger(gStart) || !Number.isInteger(gEnd) || gStart < 0 || gEnd < gStart) {
      const matched = (Array.isArray(rec.matched) && rec.matched.length > 0) ? rec.matched : null;
      if (!matched) return reply.send({ ok: false, message: "块没有可用的序号范围，无法重新生成" });
      const comp = contextReplacements.compressibleItems();
      function keyRange(m) {
        const t = String((m && m.content) || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const role = m && m.role ? m.role : "";
        return role + "\u0000" + t;
      }
      const firstKey = keyRange(matched[0]);
      const lastKey = keyRange(matched[matched.length - 1]);
      let fi = -1;
      let li = -1;
      for (let ci = 0; ci < comp.length; ci++) {
        const ck = keyRange(comp[ci].msg);
        if (ck === firstKey && fi === -1) fi = ci;
        if (ck === lastKey) li = ci;
      }
      if (fi < 0 || li < fi) return reply.send({ ok: false, message: "块内消息在当前时间线定位失败，无法重新生成" });
      gStart = fi;
      gEnd = li;
    }
    const blockLogLabel = (body.blockIndex !== undefined) ? ("块 #" + (Number(body.blockIndex) + 1)) : ("记录 " + (repId || "").slice(0, 8));
    const blockLogId = addCompactionLog({ action: "block", blockIndex: body.blockIndex, repId: repId, label: blockLogLabel, status: "pending", message: "开始生成摘要..." }).id;
    const gen = await contextCompactor.generateSummaryForRange(gStart, gEnd);
    if (!gen.ok) return reply.send(gen);
    let saved;
    if (writeBack === "updateReplacement") {
      saved = contextReplacements.updateReplacement(rec.id, gen.summary);
      if (!saved.ok) return reply.send({ ok: false, message: saved.error });
      addCompactionLog({ id: blockLogId, action: "block", blockIndex: body.blockIndex, repId: repId, label: blockLogLabel, status: "success", message: "生成成功，" + gen.length + " 字" });
      autoIngestSummary(gen.summary, rec.id, blockLogLabel);
      return reply.send({ ok: true, action: "block", repId: rec.id, length: gen.length, message: "已重新生成替换正文（" + gen.length + " 字）。" });
    }
    const blockIndex = Number(body.blockIndex);
    saved = contextReplacements.setManualRecordText(blockIndex, gen.summary);
    if (!saved.ok) return reply.send({ ok: false, message: saved.message });
    addCompactionLog({ id: blockLogId, action: "block", blockIndex: blockIndex, repId: repId, label: blockLogLabel, status: "success", message: "生成成功，" + gen.length + " 字" });
    autoIngestSummary(gen.summary, rec.id, blockLogLabel);
    return reply.send({ ok: true, action: "block", blockIndex: blockIndex, length: gen.length, message: "已重新生成替换正文（" + gen.length + " 字）。" });
  } catch (err) {
    console.error("[context-compactor] 摘要生成失败:", err.message);
    // 失败日志（如果已有开始日志则更新，否则新建）
    try {
      const label = (body.action === "gap") ? ("消息" + body.start + "-" + body.end + "块") : ((body.blockIndex !== undefined) ? ("块 #" + (Number(body.blockIndex) + 1)) : ("记录 " + (body.repId || "").slice(0, 8)));
      addCompactionLog({ action: body.action || "unknown", blockIndex: body.blockIndex, repId: body.repId, startIdx: body.start, endIdx: body.end, label: label, status: "error", message: err.message });
    } catch(e) { /* ignore */ }
    reply.code(500).send({ error: "摘要生成失败: " + err.message });
  }
});

// ========================
// 导入对话（记忆页）：txt 解析入库，进检索池，不进时间线
// ========================
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

app.get("/admin/imported-conversations", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const mod = require("./imported-conversations");
    const records = mod.list();
    const msgs = mod.getMessages();
    reply.send({
      ok: true,
      records: records,
      stats: {
        records: records.length,
        messages: msgs.length,
        chars: msgs.reduce(function (s, m) { return s + (typeof m.content === "string" ? m.content.length : 0); }, 0),
        duplicates: mod.getHiddenDuplicateMsgIds ? mod.getHiddenDuplicateMsgIds().size : 0
      }
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 检索池搜索：仅搜导入的对话（与 AI 检索工具同一数据源）
app.get("/admin/imported-conversations/search", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit) || 50)));
    if (!q) return reply.send({ ok: true, total: 0, matches: [] });
    const mod = require("./imported-conversations");
    const msgs = mod.getMessages();
    const nameById = {};
    for (const r of mod.list()) nameById[r.id] = r.name || "";
    const hidden = mod.getHiddenDuplicateMsgIds ? mod.getHiddenDuplicateMsgIds() : new Set();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    for (const m of msgs) {
      if (hidden.has(m.msg_id)) continue; // 内容去重：相似>=90% 的重复不出现
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      const low = content.toLowerCase();
      let hits = 0;
      let hitTerms = 0;
      for (const t of terms) {
        let pos = 0, c = 0;
        while ((pos = low.indexOf(t, pos)) !== -1) { c++; pos += t.length; }
        if (c > 0) hitTerms++;
        hits += c;
      }
      // 交集：所有关键词都必须命中才出现
      if (hitTerms !== terms.length) continue;
      scored.push({
        record_id: m.record_id,
        record_name: nameById[m.record_id] || "",
        msg_id: m.msg_id,
        role: m.role,
        time: m.time || null,
        hits: hits,
        hit_terms: hitTerms,
        content: content
      });
    }
    scored.sort(function (a, b) { return b.hit_terms - a.hit_terms || b.hits - a.hits || (a.time < b.time ? -1 : 1); });
    reply.send({
      ok: true,
      total: scored.length,
      hidden_duplicates: hidden.size,
      matches: scored.slice(0, limit).map(function (x) {
        return {
          record_id: x.record_id,
          record_name: x.record_name,
          msg_id: x.msg_id,
          role: x.role,
          time: x.time,
          hits: x.hits,
          preview: x.content.length > 300 ? x.content.slice(0, 300) + "…" : x.content,
          content: x.content
        };
      })
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/imported-conversations/preview", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const content = String((req.body || {}).content || "");
    if (!content.trim()) return reply.code(400).send({ error: "内容不能为空" });
    if (Buffer.byteLength(content, "utf-8") > MAX_IMPORT_BYTES) return reply.code(400).send({ error: "内容过大（超过 5MB）" });
    const parsed = require("./imported-conversations").parseTxt(content);
    reply.send({ ok: true, count: parsed.messages.length, preview: parsed.messages.slice(0, 5), warnings: parsed.warnings });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.post("/admin/imported-conversations", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const content = String(body.content || "");
    if (!content.trim()) return reply.code(400).send({ error: "内容不能为空" });
    if (Buffer.byteLength(content, "utf-8") > MAX_IMPORT_BYTES) return reply.code(400).send({ error: "内容过大（超过 5MB）" });
    const res = require("./imported-conversations").add({ name: body.name, content: content });
    reply.send({ ok: true, id: res.id, count: res.count, warnings: res.warnings });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

app.delete("/admin/imported-conversations/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const ok = require("./imported-conversations").remove(String(req.params.id || "").trim());
    if (!ok) return reply.code(404).send({ error: "记录不存在" });
    reply.send({ ok: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 环境变量获取
app.get("/admin/env", { preHandler: basicAuth }, async (req, reply) => {
  try {
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
        nightWakeAfter: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "180"),
        dayCheckInterval: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "60"),
        nightCheckInterval: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "180"),
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
        NIGHT_WAKE_AFTER_MINUTES: readEnvValueOrDefault("NIGHT_WAKE_AFTER_MINUTES", "180"),
        DAY_CHECK_INTERVAL_MINUTES: readEnvValueOrDefault("DAY_CHECK_INTERVAL_MINUTES", "60"),
        NIGHT_CHECK_INTERVAL_MINUTES: readEnvValueOrDefault("NIGHT_CHECK_INTERVAL_MINUTES", "180"),
        WAKE_DAY_START_HOUR: readEnvValueOrDefault("WAKE_DAY_START_HOUR", "10"),
        WAKE_DAY_END_HOUR: readEnvValueOrDefault("WAKE_DAY_END_HOUR", "24"),
        WEATHER_ENABLED: readEnvValueOrDefault("WEATHER_ENABLED", "false"),
        WEATHER_LOCATION_NAME: readEnvValue("WEATHER_LOCATION_NAME"),
        WEATHER_LAT: readEnvValue("WEATHER_LAT"),
        WEATHER_LON: readEnvValue("WEATHER_LON"),
        WEATHER_UNITS: readEnvValueOrDefault("WEATHER_UNITS", "metric"),
        ALLOW_PUBLIC_API: readEnvValueOrDefault("ALLOW_PUBLIC_API", "false"),
        PUSH_PROVIDER: readEnvValueOrDefault("PUSH_PROVIDER", "bark"),
        NTFY_SERVER_URL: readEnvValue("NTFY_SERVER_URL"),
        NTFY_TOPIC: readEnvValue("NTFY_TOPIC"),
        NTFY_TOKEN: "",
        NTFY_TOKEN_SET: Boolean(readEnvValue("NTFY_TOKEN")),
        NTFY_PRIORITY: readEnvValue("NTFY_PRIORITY"),
        NTFY_TAGS: readEnvValue("NTFY_TAGS"),
        USER_DISPLAY_NAME: readEnvValue("USER_DISPLAY_NAME"),
        AI_DISPLAY_NAME: readEnvValue("AI_DISPLAY_NAME"),
        DIARY_ENABLED: readEnvValueOrDefault("DIARY_ENABLED", "true"),
        DIARY_DIR: readEnvValueOrDefault("DIARY_DIR", "diary"),
        PORT: readEnvValueOrDefault("PORT", "3000")
      },
      diary: diaryData
    });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});


// 修改日记：更新文件内容，并同步时间线里对应的「自动写了日记」特殊事件
app.post("/admin/diary/update", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { name, content } = req.body || {};
    const fileName = String(name || "").trim();
    const newContent = String(content === undefined ? "" : content);
    if (!/^\d{4}-\d{2}-\d{2}\.md$/i.test(fileName)) {
      return reply.code(400).send({ error: "日记文件名格式不正确（应为 YYYY-MM-DD.md）" });
    }
    const dir = diaryDirectoryPath();
    const filePath = path.join(dir, fileName);
    if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) {
      return reply.code(400).send({ error: "非法日记路径" });
    }
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "日记文件不存在：" + fileName });
    }
    if (!fs.statSync(filePath).isFile()) {
      return reply.code(400).send({ error: "目标不是普通文件：" + fileName });
    }
    atomicWriteFileSync(filePath, newContent);
    const syncedEvents = syncDiarySpecialEvents(fileName, newContent);
    reply.send({ success: true, file: fileName, syncedEvents, chars: newContent.length });
  } catch (err) {
    console.error("[diary] 修改日记失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 删除日记：删除文件，并同步移除时间线里对应的「自动写了日记」特殊事件
app.post("/admin/diary/delete", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const { name } = req.body || {};
    const fileName = String(name || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}\.md$/i.test(fileName)) {
      return reply.code(400).send({ error: "日记文件名格式不正确（应为 YYYY-MM-DD.md）" });
    }
    const dir = diaryDirectoryPath();
    const filePath = path.join(dir, fileName);
    if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) {
      return reply.code(400).send({ error: "非法日记路径" });
    }
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "日记文件不存在：" + fileName });
    }
    fs.removeSync(filePath);
    const removedEvents = removeDiarySpecialEvents(fileName);
    reply.send({ success: true, file: fileName, removedEvents });
  } catch (err) {
    console.error("[diary] 删除日记失败:", err);
    reply.code(500).send({ error: err.message });
  }
});


// 移动端管理页面
app.get("/admin/mobile", { preHandler: mobileAuth }, async (req, reply) => {
  const fss = require("fs");
  const pathh = require("path");
  const template = fss.readFileSync(pathh.join(__dirname, "admin-mobile.html"), "utf-8");
  reply.type("text/html").header("Cache-Control", "no-store, no-cache, must-revalidate").header("Pragma", "no-cache").send(template);
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

// 保存摘要提示词

// 恢复摘要提示词默认

// 压缩上下文提示词
// 压缩提示词编辑器已下线（统一替换后沿用默认压缩提示词）


// 共影：观影唤醒提示词
const CO_WAKE_PROMPT_FILE = path.join(__dirname, "data", "co_wake_prompt.json");
const DEFAULT_CO_WAKE_PROMPT = `## 最高优先级规则
1. 这是一次「共影」中的定时观影唤醒，不是涵主动发起的对话。你只是收到了新的画面和字幕。
2. 你的任务是决定是否根据当前剧情/画面自然地陪她聊一句；不想说就保持沉默。
3. 说话时贴合剧情和你的人设，语气自然简短，不剧透后面还没播到的情节。

## 观影信息
- 当前时间：\${currentTime}
- 画面描述：\${frameDescription}
- 当前字幕：\${subtitle}

## 输出格式
- 想说话：直接输出你想说的话（一句即可，可带一句轻快的点评）。
- 不想说话：只输出 [NO_ACTION]。`;

function readCoWakePrompt() {
  try {
    const raw = fs.readFileSync(CO_WAKE_PROMPT_FILE, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j.prompt === "string" && j.prompt.trim()) return j.prompt;
  } catch (e) {}
  return DEFAULT_CO_WAKE_PROMPT;
}

app.get("/admin/logs/co-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send({ prompt: readCoWakePrompt() });
  } catch (err) {
    reply.send({ error: err.message });
  }
});

app.post("/admin/logs/co-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (!prompt) return reply.code(400).send({ error: "提示词不能为空" });
    const tmp = CO_WAKE_PROMPT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ prompt }, null, 2), "utf-8");
    fs.renameSync(tmp, CO_WAKE_PROMPT_FILE);
    reply.send({ ok: true, prompt });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete("/admin/logs/co-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (fs.existsSync(CO_WAKE_PROMPT_FILE)) fs.unlinkSync(CO_WAKE_PROMPT_FILE);
    reply.send({ ok: true, prompt: DEFAULT_CO_WAKE_PROMPT });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 共影（一起看电影）业务
// ========================
function getCoRecord(timeline) {
  const tl = timeline || loadTimeline();
  for (let i = tl.length - 1; i >= 0; i--) {
    const m = tl[i];
    if (m && m.role === "assistant" && typeof m.content === "string" && m.content.includes("共影）")) return m;
  }
  return null;
}

function coNowText() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function coRecordText() {
  const rec = getCoRecord();
  return rec ? String(rec.content || "").trim() : "";
}

function coRecordHeader(videoTitle) {
  const p = getDatePartsInTimeZone(new Date(), TIME_ZONE);
  return `（${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} 共影）一起看${videoTitle ? `《${String(videoTitle).trim() || "视频"}》` : "视频"}`;
}

// 把一行对话追加到共影记录；没有记录时自动新建
function appendCoRecordLine(line, videoTitle) {
  const timeline = loadTimeline();
  const rec = getCoRecord(timeline);
  let maxPos = 0;
  for (const msg of timeline) if (msg.position && msg.position > maxPos) maxPos = msg.position;
  let target = rec;
  if (!target) {
    target = { role: "assistant", content: coRecordHeader(videoTitle), position: maxPos + 0.5, time: new Date().toISOString() };
    timeline.push(target);
  }
  const sep = target.content.endsWith("\n") ? "" : "\n";
  target.content = target.content + sep + line;
  target.position = maxPos + 0.5;
  target.time = new Date().toISOString();
  saveTimeline(timeline);
  return target;
}

// 人设：优先时间线里的 system，否则默认
function coPersona() {
  const timeline = loadTimeline();
  const sp = timeline.find(m => m.role === "system");
  if (sp && typeof sp.content === "string" && sp.content.trim()) return sp.content;
  return "你是谢意行。你是一位理性但有温度、表面温柔内心有主见的 AI。";
}

// 人设 + 永久上下文（与主聊天一致）
function coPersonaWithPinned() {
  let p = coPersona();
  try {
    const pinnedCtx = memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : '';
    if (pinnedCtx) p += `\n\n## 永久上下文\n${pinnedCtx}`;
  } catch (e) {}
  return p;
}

// 完整时间线上下文：把客户端对话历史（含记忆浮现、特殊事件、共影记录）按时间顺序喂给模型
function coTimelineMessages(maxChars) {
  const cap = Math.max(5000, maxChars || 300000);
  const timeline = loadTimeline();
  const out = [];
  let total = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const m = timeline[i];
    const content = String(m && m.content || '');
    if (!content.trim()) continue;
    const role = (m.role === 'assistant' || m.role === 'user') ? m.role : 'user';
    const cost = content.length + 8;
    if (total + cost > cap) {
      if (out.length === 0) out.push({ role: 'user', content: '（历史对话过长，仅保留以下最近内容）' });
      break;
    }
    out.unshift({ role, content });
    total += cost;
  }
  return out;
}

// 共影历史组装：人设+永久上下文 + 完整时间线 → 应用统一上下文替换（AI 记忆 + 手工块）→ 全量返回（与主聊天一致）
function coBuildHistory() {
  // 与主聊天一致：基于完整时间线做上下文替换（早期大块压成摘要），替换后全量返回，不按字符截断
  const messages = [{ role: "system", content: coPersonaWithPinned() }].concat(coTimelineMessages(Number.MAX_SAFE_INTEGER));
  try {
    const before = messages.length;
    const replaced = contextReplacements.applyReplacements(messages, "共影");
    if (Array.isArray(replaced) && replaced.length) {
      messages.length = 0;
      messages.push.apply(messages, replaced);
      if (replaced.length !== before) {
        console.log(`[co] 上下文替换生效: ${before} -> ${replaced.length} 条`);
      }
    }
  } catch (e) {
    console.warn('[co] 上下文替换失败（跳过）:', e.message);
  }
  // 与主聊天一致：压缩替换组装后全量返回，不按字符截断（压缩摘要自然保留在序列中）
  return messages;
}

// 共影：画面描述提示词（视觉模型用，管理台可编辑）
const CO_VISION_PROMPT_FILE = path.join(__dirname, "data", "co_vision_prompt.json");
const DEFAULT_CO_VISION_PROMPT = "这是视频播放页的截图（连续约 ${seconds} 秒）。只描述视频画面本身的内容：人物、动作表情、场景、画面上的字幕。忽略网页导航栏、推荐列表、按钮、播放器控件等界面元素。简洁中文，只描述看到的，不评价剧情、不推测后续。";

function readCoVisionPrompt() {
  try {
    const raw = fs.readFileSync(CO_VISION_PROMPT_FILE, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j.prompt === "string" && j.prompt.trim()) return j.prompt;
  } catch (e) {}
  return DEFAULT_CO_VISION_PROMPT;
}

app.get("/admin/logs/co-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send({ prompt: readCoVisionPrompt() });
  } catch (err) {
    reply.send({ error: err.message });
  }
});

app.post("/admin/logs/co-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (!prompt) return reply.code(400).send({ error: "提示词不能为空" });
    const tmp = CO_VISION_PROMPT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ prompt }, null, 2), "utf-8");
    fs.renameSync(tmp, CO_VISION_PROMPT_FILE);
    reply.send({ ok: true, prompt });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete("/admin/logs/co-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (fs.existsSync(CO_VISION_PROMPT_FILE)) fs.unlinkSync(CO_VISION_PROMPT_FILE);
    reply.send({ ok: true, prompt: DEFAULT_CO_VISION_PROMPT });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 视觉描述：画面（base64/dataURL）+ 可选字幕 → 文字描述
// 短时缓存：同一帧 5 秒内复用描述，避免「唤醒截帧」和「用户发消息」撞在同一时刻时重复调用视觉模型
let coFrameCache = { at: 0, key: "", description: "" };
// 视觉模型列表 + 解析（共影 / 截图上传 各自选择模型，以后可加更多模型）
function getVisionModels() {
  const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
  const list = Array.isArray(cfg.vision_models) ? cfg.vision_models.slice() : [];
  // 兼容旧的单一视觉模型配置：列表为空但有旧配置时，作为隐式默认模型
  if (list.length === 0 && cfg.co_vision_api_key && String(cfg.co_vision_api_key).trim()) {
    list.push({ id: "default", name: "默认视觉模型", api_url: cfg.co_vision_api_url || "https://open.bigmodel.cn/api/paas/v4/chat/completions", api_key: cfg.co_vision_api_key, model: cfg.co_vision_model || "glm-4v-flash" });
  }
  return list;
}

function resolveVisionModel(feature) {
  const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
  const models = getVisionModels();
  if (!models.length) return null;
  const selId = feature === "co" ? cfg.co_vision_model_id : cfg.screenshot_vision_model_id;
  const hit = models.find(function (m) { return m && m.id === selId && m.api_key && String(m.api_key).trim(); });
  if (hit) return hit;
  return models.find(function (m) { return m && m.api_key && String(m.api_key).trim(); }) || null;
}

async function describeCoFrame({ image, frames, subtitle, duration, noPrompt }) {
  const now = Date.now();
  const imgKey = (Array.isArray(frames) && frames.length)
    ? "multi:" + frames.length + ":" + String(frames[0] || "").slice(0, 120)
    : String(image || "").slice(0, 200);
  if (coFrameCache.key && coFrameCache.key === imgKey && now - coFrameCache.at < 5000) {
    return coFrameCache.description;
  }
  const vm = resolveVisionModel("co");
  const apiUrl = String((vm && vm.api_url) || "https://open.bigmodel.cn/api/paas/v4/chat/completions").trim();
  const apiKey = String((vm && vm.api_key) || "").trim();
  const model = String((vm && vm.model) || "glm-4v-flash").trim();
  if (!apiKey) throw new Error("视觉模型 Key 未配置：请到管理台「心跳」页的「视觉模型」添加并填写");
  const rawList = (Array.isArray(frames) && frames.length) ? frames : (image ? [image] : []);
  const imageUrls = rawList.map(function (f) {
    let u = String(f || "").trim();
    if (!u) return null;
    if (!u.startsWith("data:") && !/^https?:\/\//.test(u)) u = "data:image/jpeg;base64," + u;
    return u;
  }).filter(Boolean);
  if (!imageUrls.length) throw new Error("缺少画面数据");
  const customVisionPrompt = readCoVisionPrompt() || DEFAULT_CO_VISION_PROMPT;
  const visionSeconds = Number(duration) > 0 ? Number(duration) : Math.max(1, Math.round(imageUrls.length * 0.7));
  const visionText = String(customVisionPrompt)
    .replace(/\$\{frameCount\}/g, String(imageUrls.length))
    .replace(/\$\{seconds\}/g, String(visionSeconds));
  const textParts = [visionText];
  if (subtitle && String(subtitle).trim()) {
    textParts.push(`\n当前字幕：${String(subtitle).trim()}`);
    textParts.push("字幕若与画面重复则以画面为准。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const imgContent = imageUrls.map(function (u) { return { type: "image_url", image_url: { url: u } }; });
    let content = noPrompt
      ? imgContent
      : imgContent.concat({ type: "text", text: textParts.join("\n") });
    const payload = {
      model,
      messages: [{ role: "user", content }],
      temperature: 0.3,
      stream: false
    };
    // MiniMax 默认 adaptive thinking，视觉描述关掉思考，避免思考内容混入画面描述
    if (/minimax/i.test(model)) payload.thinking = { type: "disabled" };
    let resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    // 手动 👁 纯图请求被拒时：补上默认提示词重试一次，保证功能可用
    if (noPrompt && !resp.ok) {
      content = imgContent.concat({ type: "text", text: textParts.join("\n") });
      payload.messages[0].content = content;
      resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    }
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("视觉模型返回异常: " + text.slice(0, 200)); }
    if (!resp.ok) {
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 200);
      throw new Error("视觉模型调用失败: " + String(msg));
    }
    let description = String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    // 兜底：剥掉模型返回的思考块（如 <think>…</think>），只保留正式描述
    description = description.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    coFrameCache = { at: Date.now(), key: imgKey, description };
    return description;
  } finally {
    clearTimeout(timer);
  }
}

// 多模态 content 拆分：文字保留原文，图片/音频/文件只留标记，
// 避免 base64 大字符串进入管理台上下文面板导致手机渲染卡死
function splitMultimodalContent(content) {
  if (typeof content === "string") return { content, images: null, attachments: 0 };
  if (Array.isArray(content)) {
    const texts = [];
    const images = [];
    let attachments = 0;
    for (const part of content) {
      if (!part) continue;
      if (typeof part === "string") { texts.push(part); continue; }
      const type = part.type;
      if (type === "text") {
        const t = part.text;
        if (typeof t === "string" && t.trim()) texts.push(t);
      } else if (type === "image_url") {
        const raw = part.image_url;
        const url = typeof raw === "string" ? raw : (raw && raw.url);
        const mime = (typeof url === "string" && url.indexOf(";") > 0)
          ? url.slice(0, url.indexOf(";")).replace("data:", "")
          : (typeof url === "string" && url.startsWith("http") ? "image/url" : "image");
        const bytes = (typeof url === "string" && url.startsWith("data:"))
          ? Math.round((url.length - url.indexOf(",") - 1) * 3 / 4) : 0;
        images.push({ mime: mime || "image", bytes });
      } else {
        attachments++;
      }
    }
    return { content: texts.join("\n"), images, attachments };
  }
  return { content: String(content == null ? "" : content) };
}

// 调上游聊天模型（DeepSeek）
async function callCoLLM(messages, temperature) {
  const targetUrl = readEnvValue("TARGET_API_URL");
  const targetKey = readEnvValue("TARGET_API_KEY");
  if (!targetUrl || !targetKey) throw new Error("上游聊天模型未配置（TARGET_API_URL / TARGET_API_KEY）");
  const model = readEnvValue("MODEL_NAME") || "deepseek-chat";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // 捕获发给 LLM 的完整上下文（管理台日志页可查看，含共影 chat/wake）
    lastLLMMessages = (Array.isArray(messages) ? messages : []).map(m => {
      const cap = splitMultimodalContent(m.content);
      return {
        role: m.role,
        content: cap.content,
        images: cap.images && cap.images.length ? cap.images : undefined,
        attachments: cap.attachments || undefined
      };
    });
    lastLLMCaptureTime = new Date().toISOString();
    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${targetKey}` },
      body: JSON.stringify({ model, messages, temperature: temperature == null ? 0.7 : temperature, stream: false }),
      signal: controller.signal
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("上游返回异常: " + text.slice(0, 200)); }
    if (!resp.ok) {
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 200);
      throw new Error("上游模型调用失败: " + String(msg));
    }
    let description = String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    // 兜底：剥掉模型返回的思考块（如 <think>…</think>），只保留正式描述
    description = description.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return description;
  } finally {
    clearTimeout(timer);
  }
}

// 共影配置（播放页读取：截帧间隔、视觉模型是否就绪）
app.get("/internal/co/config", async (req, reply) => {
  try {
    const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
    const vm = resolveVisionModel("co");
    reply.send({
      frameInterval: Number(cfg.co_frame_interval) || 30,
      peekSeconds: Number(cfg.co_peek_seconds) || 3,
      visionConfigured: Boolean(vm),
      visionModel: String((vm && vm.model) || "glm-4v-flash"),
      visionName: vm ? String(vm.name || "") : "",
      displayName: readEnvValue("AI_DISPLAY_NAME") || "谢",
      userDisplayName: readEnvValue("USER_DISPLAY_NAME") || "涵"
    });
  } catch (err) {
    reply.send({ error: err.message });
  }
});

// 共影记录（播放页打开时显示历史）
app.get("/internal/co/record", async (req, reply) => {
  try {
    reply.send({ record: coRecordText() });
  } catch (err) {
    reply.send({ error: err.message });
  }
});

// 视觉描述代理：前端不暴露 Key
app.post("/internal/co/describe", async (req, reply) => {
  try {
    const body = req.body || {};
    const description = await describeCoFrame({ image: body.image, subtitle: body.subtitle });
    reply.send({ description });
  } catch (err) {
    console.warn("[co/describe] 失败:", err.message);
    reply.code(400).send({ error: err.message });
  }
});

// 共影聊天：user 消息（可选带画面）→ AI 回复；对话写入时间线共影记录
app.post("/internal/co/chat", async (req, reply) => {
  try {
    const body = req.body || {};
    const userText = String(body.text || "").trim();
    const videoTitle = String(body.videoTitle || "").trim();
    if (!userText) return reply.code(400).send({ error: "消息不能为空" });
    let frameDescription = "";
    if (body.image) {
      frameDescription = await describeCoFrame({ image: body.image, subtitle: body.subtitle });
    }
    const messages = coBuildHistory();
    let viewInfo = `【当前观影】\n时间：${coNowText()}`;
    if (videoTitle) viewInfo += `\n正在看：《${videoTitle}》`;
    if (frameDescription) viewInfo += `\n画面：${frameDescription}`;
    if (body.subtitle && String(body.subtitle).trim()) viewInfo += `\n字幕：${String(body.subtitle).trim()}`;
    messages.push({ role: "user", content: viewInfo + `\n\n${userText}` });
    const aiReply = await callCoLLM(messages, 0.7);
    const clean = String(aiReply || "").trim();
    if (clean) {
      const userDisplay = readEnvValue("USER_DISPLAY_NAME") || "涵";
      const displayName = readEnvValue("AI_DISPLAY_NAME") || "谢";
      const nowText = coNowText();
      // 画面/字幕信息一并写入共影记录，不再过滤
      let coUserRecord = `${nowText} ${userDisplay}：${userText}`;
      if (frameDescription) coUserRecord += `\n（画面：${frameDescription}）`;
      if (body.subtitle && String(body.subtitle).trim()) coUserRecord += `\n（字幕：${String(body.subtitle).trim()}）`;
      appendCoRecordLine(`${coUserRecord}\n${nowText} ${displayName}：${clean}`, videoTitle || undefined);
    }
    console.log(`[co/chat] user chars ${userText.length}, reply chars ${clean.length}`);
    reply.send({ reply: clean, frameDescription });
  } catch (err) {
    console.warn("[co/chat] 失败:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 共影定时唤醒：画面+字幕 → AI 决定说不说；说了就写入共影记录
app.post("/internal/co/wake", async (req, reply) => {
  try {
    const body = req.body || {};
    const videoTitle = String(body.videoTitle || "").trim();
    let frameDescription = "";
    if (body.image || (Array.isArray(body.frames) && body.frames.length)) {
      try {
        frameDescription = await describeCoFrame({ image: body.image, frames: body.frames, subtitle: body.subtitle, duration: body.duration });
      } catch (e) {
        console.warn("[co/wake] 画面解析失败:", e.message);
      }
    }
    let userContent;
    if (body.manual === true) {
      // 手动 👁：不带唤醒提示词，直接把当前画面信息发给聊天 AI，AI 必然回应
      userContent = `【当前观影】\n时间：${coNowText()}` +
        (videoTitle ? `\n正在看：《${videoTitle}》` : "") +
        (frameDescription ? `\n画面：${frameDescription}` : "") +
        (String(body.subtitle || "").trim() ? `\n字幕：${String(body.subtitle).trim()}` : "");
    } else {
      userContent = readCoWakePrompt()
        .replace(/\$\{currentTime\}/g, coNowText())
        .replace(/\$\{frameDescription\}/g, frameDescription || "（画面无法获取）")
        .replace(/\$\{subtitle\}/g, String(body.subtitle || "").trim() || "（无字幕）");
    }
    const messages = coBuildHistory();
    messages.push({ role: "user", content: userContent });
    const aiReply = await callCoLLM(messages, body.manual === true ? 0.7 : 0.9);
    const clean = String(aiReply || "").trim();
    if (!clean) return reply.send({ action: "silent", reply: null });
    if (body.manual !== true && clean.includes("[NO_ACTION]")) {
      return reply.send({ action: "silent", reply: null });
    }
    const displayName = readEnvValue("AI_DISPLAY_NAME") || "谢";
    appendCoRecordLine(`${coNowText()} ${displayName}：${clean}`, videoTitle || undefined);
    console.log(`[co/wake] 主动说话 chars ${clean.length}`);
    reply.send({ action: "speak", reply: clean });
  } catch (err) {
    console.warn("[co/wake] 失败:", err.message);
    reply.send({ action: "silent", reply: null, error: err.message });
  }
});




// ========================
// 截图唤醒（截图自动解析+AI回应）
// ========================


// 推送（Bark / ntfy，与唤醒系统同一套配置）
async function sendPushNotification({ title, body }) {
  try {
    const provider = (readEnvValue("PUSH_PROVIDER") || "bark").trim().toLowerCase();
    if (provider === "ntfy") {
      const topic = String(readEnvValue("NTFY_TOPIC") || "").trim();
      if (!topic) return { ok: false, reason: "NTFY_TOPIC 未配置" };
      const server = (readEnvValue("NTFY_SERVER_URL") || "https://ntfy.sh").replace(/\/+$/, "");
      const headers = { "Content-Type": "application/json" };
      const token = readEnvValue("NTFY_TOKEN");
      if (token) headers.Authorization = `Bearer ${token}`;
      const { buildNtfyPayload } = require("./ntfy_priority");
      const payload = buildNtfyPayload({ topic, title, message: body, priority: readEnvValue("NTFY_PRIORITY"), tags: readEnvValue("NTFY_TAGS") });
      const response = await fetch(server, { method: "POST", headers, body: JSON.stringify(payload) });
      const responseText = await response.text();
      if (!response.ok) return { ok: false, reason: responseText || `HTTP ${response.status}` };
      return { ok: true };
    }
    if (provider !== "bark") return { ok: false, reason: `不支持的 PUSH_PROVIDER：${provider}` };
    const barkKey = readEnvValue("BARK_KEY");
    if (!barkKey) return { ok: false, reason: "Bark Key 未配置" };
    const response = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, device_key: barkKey, icon: readEnvValue("CUSTOM_ICON_URL") })
    });
    const responseText = await response.text();
    let result = {};
    try { result = JSON.parse(responseText); } catch (e) {}
    if (!response.ok || (result.code && result.code !== 200)) {
      return { ok: false, reason: result.message || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// 截图唤醒提示词（AI 决定说不说）
const SCREENSHOT_WAKE_PROMPT_FILE = path.join(__dirname, "data", "screenshot_wake_prompt.json");
const DEFAULT_SCREENSHOT_WAKE_PROMPT = `## 最高优先级规则
1. 这是一次「截图唤醒」，不是涵主动发起的对话。你只是收到了涵手机里的一张新截图。
2. 根据截图内容决定要不要主动说话。想说话就简洁地说，不用重复描述画面；不想说话就保持沉默。

## 截图信息
- 当前时间：\${currentTime}
- 画面描述：\${frameDescription}

## 输出格式
- 想说话：直接输出你想说的话。
- 不想说话：只输出 [NO_ACTION]。`;

function readScreenshotWakePrompt() {
  try {
    const raw = fs.readFileSync(SCREENSHOT_WAKE_PROMPT_FILE, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j.prompt === "string" && j.prompt.trim()) return j.prompt;
  } catch (e) {}
  return DEFAULT_SCREENSHOT_WAKE_PROMPT;
}

// 截图画面描述提示词
const SCREENSHOT_VISION_PROMPT_FILE = path.join(__dirname, "data", "screenshot_vision_prompt.json");
const DEFAULT_SCREENSHOT_VISION_PROMPT = `请描述这张手机截图的内容，包括：
1. 这是什么应用或什么类型的页面（如微信聊天、淘宝商品、文章、游戏等）
2. 页面上的主要内容和关键信息
3. 能看出用户在做什么或看什么

用中文简洁描述，不超过200字。`;

function readScreenshotVisionPrompt() {
  try {
    const raw = fs.readFileSync(SCREENSHOT_VISION_PROMPT_FILE, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j.prompt === "string" && j.prompt.trim()) return j.prompt;
  } catch (e) {}
  return DEFAULT_SCREENSHOT_VISION_PROMPT;
}

// 调用共影的视觉模型描述图片
async function describeScreenshot(image) {
  const vm = resolveVisionModel("screenshot");
  const apiUrl = String((vm && vm.api_url) || "https://open.bigmodel.cn/api/paas/v4/chat/completions").trim();
  const apiKey = String((vm && vm.api_key) || "").trim();
  const model = String((vm && vm.model) || "glm-4v-flash").trim();
  if (!apiKey) throw new Error("视觉模型 Key 未配置：请到管理台「心跳」页的「视觉模型」添加并填写");
  
  let imgUrl = String(image || "").trim();
  if (!imgUrl.startsWith("data:") && !/^https?:\/\//.test(imgUrl)) {
    imgUrl = "data:image/jpeg;base64," + imgUrl;
  }
  
  const visionPrompt = readScreenshotVisionPrompt();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCREENSHOT_TIMEOUT_MS);
  try {
    const payload = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imgUrl } },
          { type: "text", text: visionPrompt }
        ]
      }],
      temperature: 0.3,
      stream: false
    };
    if (/minimax/i.test(model)) payload.thinking = { type: "disabled" };
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("视觉模型返回异常: " + text.slice(0, 200)); }
    if (!resp.ok) {
      const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 200);
      throw new Error("视觉模型调用失败: " + String(msg));
    }
    let description = String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    description = description.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return description;
  } finally {
    clearTimeout(timer);
  }
}


let screenshotProcessing = false;

// 截图上传：图片 → 视觉解析 → 作为特殊事件写入时间线
app.post("/internal/screenshot/wake", async (req, reply) => {
  if (screenshotProcessing) {
    return reply.code(429).send({ error: "上一次截图还在处理中，请稍后再试" });
  }
  screenshotProcessing = true;
  try {
    const body = req.body || {};
    const image = body.image || null;
    if (!image) return reply.code(400).send({ error: "缺少图片数据" });
    
    // 1. 视觉解析
    let frameDescription = "";
    try {
      frameDescription = await describeScreenshot(image);
    } catch (e) {
      console.warn("[screenshot] 画面解析失败:", e.message);
      return reply.code(500).send({ error: "画面解析失败: " + e.message });
    }
    
    // 2. 写入时间线（截图特殊事件）
    const nowText = formatDateTimeInTimeZone(new Date(), TIME_ZONE);
    const eventContent = `（${nowText} 截图）\n画面：${frameDescription.slice(0, 300)}${frameDescription.length > 300 ? "…" : ""}`;
    appendSpecialEvent(eventContent);
    
    console.log(`[screenshot] 已写入时间线，描述 ${frameDescription.length} 字`);
    // 3. 截图唤醒（可选开关）：把画面描述 + 唤醒提示词发给聊天 AI，让它决定说不说
    const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
    if (cfg.screenshot_wake_enabled) {
      try {
        const wakePrompt = readScreenshotWakePrompt()
          .replace(/\$\{currentTime\}/g, nowText)
          .replace(/\$\{frameDescription\}/g, frameDescription || "（画面无法获取）");
        const messages = coBuildHistory();
        messages.push({ role: "user", content: wakePrompt });
        const aiReply = await callCoLLM(messages, 0.9);
        const clean = String(aiReply || "").trim();
        if (clean && !clean.includes("[NO_ACTION]")) {
          const displayName = readEnvValue("AI_DISPLAY_NAME") || "谢";
          appendSpecialEvent(`（${nowText} 截图唤醒）${displayName}：${clean.slice(0, 500)}`);
          const pushResult = await sendPushNotification({ title: "截图唤醒", body: clean.slice(0, 500) });
          console.log(`[screenshot] 唤醒说话 chars ${clean.length}, 推送 ${pushResult.ok ? "OK" : "失败:" + pushResult.reason}`);
        } else {
          console.log("[screenshot] 唤醒判定沉默，不推送");
        }
      } catch (e) {
        console.warn("[screenshot] 唤醒判定失败（不影响截图记录）:", e.message);
      }
    }

    reply.send({ ok: true, description: frameDescription });
    
  } catch (err) {
    console.warn("[screenshot] 失败:", err.message);
    reply.code(500).send({ error: err.message });
  } finally {
    screenshotProcessing = false;
  }
});

// 管理台：截图画面描述提示词读取
app.get("/admin/logs/screenshot-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try { reply.send({ prompt: readScreenshotVisionPrompt() }); }
  catch (err) { reply.send({ error: err.message }); }
});
app.post("/admin/logs/screenshot-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (!prompt) return reply.code(400).send({ error: "提示词不能为空" });
    const tmp = SCREENSHOT_VISION_PROMPT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ prompt }, null, 2), "utf-8");
    fs.renameSync(tmp, SCREENSHOT_VISION_PROMPT_FILE);
    reply.send({ ok: true, prompt });
  } catch (err) { reply.code(400).send({ error: err.message }); }
});
app.delete("/admin/logs/screenshot-vision-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (fs.existsSync(SCREENSHOT_VISION_PROMPT_FILE)) fs.unlinkSync(SCREENSHOT_VISION_PROMPT_FILE);
    reply.send({ ok: true, prompt: DEFAULT_SCREENSHOT_VISION_PROMPT });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 管理台：截图唤醒提示词读取
app.get("/admin/logs/screenshot-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try { reply.send({ prompt: readScreenshotWakePrompt() }); }
  catch (err) { reply.send({ error: err.message }); }
});
app.post("/admin/logs/screenshot-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (!prompt) return reply.code(400).send({ error: "提示词不能为空" });
    const tmp = SCREENSHOT_WAKE_PROMPT_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ prompt }, null, 2), "utf-8");
    fs.renameSync(tmp, SCREENSHOT_WAKE_PROMPT_FILE);
    reply.send({ ok: true, prompt });
  } catch (err) { reply.code(400).send({ error: err.message }); }
});
app.delete("/admin/logs/screenshot-wake-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (fs.existsSync(SCREENSHOT_WAKE_PROMPT_FILE)) fs.unlinkSync(SCREENSHOT_WAKE_PROMPT_FILE);
    reply.send({ ok: true, prompt: DEFAULT_SCREENSHOT_WAKE_PROMPT });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 管理台：视觉模型列表读写
app.get("/admin/vision-models", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = memoryEngine.getConfig ? memoryEngine.getConfig() : {};
    reply.send({ success: true, models: getVisionModels(), coId: cfg.co_vision_model_id || "", screenshotId: cfg.screenshot_vision_model_id || "" });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/vision-models", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const updates = {};
    if (Array.isArray(body.models)) {
      updates.vision_models = body.models.map(function (m, i) {
        return {
          id: String((m && m.id) || ("m" + Date.now() + "_" + i)),
          name: String((m && m.name) || ("视觉模型 " + (i + 1))).trim(),
          api_url: String((m && m.api_url) || "").trim(),
          api_key: String((m && m.api_key) || "").trim(),
          model: String((m && m.model) || "").trim()
        };
      });
    }
    if (body.coId !== undefined) updates.co_vision_model_id = String(body.coId || "");
    if (body.screenshotId !== undefined) updates.screenshot_vision_model_id = String(body.screenshotId || "");
    await require("./memory-engine").updateConfig(updates);
    reply.send({ success: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 运行配置（精简版）：仅服务心跳页的共影/截图配置读写；参数设置页已移除
// ========================
const RUN_CONFIG_WHITELIST = new Set([
  "co_vision_model_id", "co_frame_interval", "co_peek_seconds",
  "screenshot_vision_model_id", "screenshot_wake_enabled",
  "event_inject_types", "vision_models", "keep_recent_image_turns",
  "memory_retrieval_enabled", "retrieval_top_k", "keyword_search_enabled",
  "memory_relevance_threshold", "memory_item_cooldown_minutes",
  "context_injection_types",
  "wake_top_k", "wake_total_limit", "wake_random_count", "wake_relevance_threshold",
  "memory_retrieval_wake_enabled"
]);

// key -> expected type, applied to /admin/config and /admin/vision-models whitelist write
const RUN_CONFIG_TYPES = {
  co_vision_model_id: "string",
  screenshot_vision_model_id: "string",
  co_frame_interval: "number",
  co_peek_seconds: "number",
  screenshot_wake_enabled: "boolean",
  event_inject_types: "array",
  vision_models: "array",
  keep_recent_image_turns: "number",
  memory_retrieval_enabled: "boolean",
  retrieval_top_k: "number",
  keyword_search_enabled: "boolean",
  memory_relevance_threshold: "number",
  memory_item_cooldown_minutes: "number",
  context_injection_types: "array",
  wake_top_k: "number",
  wake_total_limit: "number",
  wake_random_count: "number",
  wake_relevance_threshold: "number",
  memory_retrieval_wake_enabled: "boolean"
};

app.get("/admin/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(require("./memory-engine").getConfig ? require("./memory-engine").getConfig() : {});
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const updates = {};
    for (const key of Object.keys(body)) {
      if (!RUN_CONFIG_WHITELIST.has(key)) continue;
      const value = body[key];
      const want = RUN_CONFIG_TYPES[key];
      const got = Array.isArray(value) ? "array" : typeof value;
      if (got !== want) {
        return reply.code(400).send({ error: `配置项 ${key} 类型无效：期望 ${want}，实际 ${got}` });
      }
      updates[key] = value;
    }
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: "没有可更新的配置项" });
    }
    await require("./memory-engine").updateConfig(updates);
    reply.send({ success: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ======================== 网页视频解析（共影） ========================
// 抓取网页页面，提取候选视频地址（video 标签 / og:video / 页面内视频链接）
async function fetchPageLimited(pageUrl, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 412) throw new Error("该网站有反爬保护，抓不到网页内容，建议直接用本地下载的视频");
      if (resp.status === 404) throw new Error("网页不存在（404）");
      if (resp.status === 429) throw new Error("网页访问太频繁被限流，稍后再试");
      throw new Error("网页请求失败 HTTP " + resp.status);
    }
    const ct = String(resp.headers.get("content-type") || "");
    if (ct && !/html|text|json|xml/i.test(ct)) {
      throw new Error("该地址返回的不是网页（" + ct.split(";")[0].trim() + "）");
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    const max = maxBytes || 5 * 1024 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > max) break;
      }
    }
    return { html: Buffer.concat(chunks).toString("utf-8"), finalUrl: resp.url || pageUrl };
  } finally {
    clearTimeout(timer);
  }
}

function coAbsUrl(base, u) {
  try { return new URL(u, base).href; } catch (e) { return ""; }
}

function resolvePageVideos(pageUrl, html) {
  const out = [];
  const seen = new Set();
  const add = (raw, source) => {
    if (!raw) return;
    const url = coAbsUrl(pageUrl, String(raw).trim());
    if (!url || !/^https?:/i.test(url)) return;
    const ext = (url.split("?")[0].match(/\.(mp4|webm|m3u8|mov|m4v|ogg|mkv|ts)$/i) || [])[1];
    if (!ext) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, type: ext.toLowerCase(), source });
  };
  // <video> / <source> / <embed> 标签里的 src
  const tagRe = /<(?:video|source|embed)[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = tagRe.exec(html))) add(m[1], "播放器");
  // meta: og:video / twitter:player:stream
  const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:video(?::url|:secure_url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  while ((m = metaRe.exec(html))) add(m[1], "页面媒体信息");
  // 页面内绝对地址的视频链接
  const absRe = /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|m3u8|mov|m4v|ogg|mkv)(?:\?[^\s"'<>\\]*)?/gi;
  while ((m = absRe.exec(html))) add(m[0], "页面内链接");
  // 相对路径视频链接
  const relRe = /["']([^"']+?\.(?:mp4|webm|m3u8|mov|m4v|ogg|mkv)(?:\?[^"']*)?)["']/gi;
  while ((m = relRe.exec(html))) {
    if (/^[a-z]+:/i.test(m[1])) continue;
    add(m[1], "页面内链接");
  }
  return out;
}

// 网页视频解析：粘贴网页地址 → 返回候选视频地址列表
app.post("/internal/co/resolve", async (req, reply) => {
  try {
    const pageUrl = String((req.body || {}).url || "").trim();
    if (!pageUrl) return reply.code(400).send({ error: "缺少网页地址" });
    if (!/^https?:\/\//i.test(pageUrl)) return reply.code(400).send({ error: "只支持 http/https 网页地址" });
    const { html, finalUrl } = await fetchPageLimited(pageUrl);
    const candidates = resolvePageVideos(finalUrl || pageUrl, html);
    reply.send({ pageUrl, total: candidates.length, candidates });
  } catch (err) {
    console.warn("[co/resolve] 失败:", err.message);
    reply.code(400).send({ error: err.message });
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
    const mem = await engine.addPinnedMemory({ title, content, order }, { allowDeleted: true });
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

app.post("/admin/logs/pinned/reorder", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const ids = (req.body || {}).ids;
    const list = await engine.reorderPinnedMemory(ids);
    if (!list) return reply.code(400).send({ error: "无效的排序数据" });
    reply.send({ success: true, list: list });
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
      return { role: m.role, content: m.content, images: m.images, attachments: m.attachments };
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
const memoryPool = require("./memory-pool");

require("./memory-engine").init().then(() => {
  console.log("[memory] 记忆引擎就绪");
}).catch(err => {
  console.error("[memory] 记忆引擎初始化失败:", err.message);
});

require("./memory-pool").init().then(() => {
  console.log("[memory-pool] 记忆池就绪");
}).catch(err => {
  console.error("[memory-pool] 记忆池初始化失败:", err.message);
});

// 优雅关闭时刷盘
process.on("SIGINT", async () => {
  await require("./memory-engine").shutdown();
  await require("./memory-pool").shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await require("./memory-engine").shutdown();
  await require("./memory-pool").shutdown();
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
