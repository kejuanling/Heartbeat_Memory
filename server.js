require("dotenv").config();

// 2026-09-21 审查 H2：全局异常兜底。Node 15+ 未处理的 Promise rejection 默认杀进程，
// 本进程承载 HTTP/SSE/唤醒定时器/流式回写，任一异步异常都会整体退出——记录后继续运行。
process.on("unhandledRejection", (reason) => {
  const detail = reason && reason.stack ? String(reason.stack).slice(0, 500) : String(reason).slice(0, 500);
  console.error(JSON.stringify({ level: "error", event: "unhandled_rejection", detail }));
});
process.on("uncaughtException", (err) => {
  const detail = err && err.stack ? String(err.stack).slice(0, 500) : String(err).slice(0, 500);
  console.error(JSON.stringify({ level: "error", event: "uncaught_exception", detail }));
});

const Fastify = require("fastify");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const doubaoAsr = require("./doubao-asr");
// Context V2 组装（预览接口与主聊天同源，2026-09-19）
const { buildContextBlocks } = require("./context-v2-builder");
const ctxV2Shadow = require("./context-v2-shadow");
// 会话级配置读写（2026-10-03 从下方抽出）：跨窗口开关要真正生效，
// context-v2-runtime.js 也得读同一份实现，而它是本文件 require 的——只能走 lib，不能反向引用。
const { createSessionCfg } = require("./lib/session-cfg");
const sessionCfg = createSessionCfg(__dirname);
const { sessionCrossInjectOverride, saveSessionCrossInjectOverride } = sessionCfg;

// === MCP 工具循环接入（隔离式，ENABLE_MCP=true 才生效）===
const mcp = require("./mcp-tool-loop");
const { createClients: mcpCreateClients, probeServer: mcpProbeServer } = require("./mcp-client");
const MCP_SERVERS_CONFIG = path.join(__dirname, "mcp-servers.json");
const MCP_ENABLED = () => readEnvValue("ENABLE_MCP") === "true";
let _mcpClientsCache = null;
function getMcpClients() {
  if (!_mcpClientsCache) {
    try { _mcpClientsCache = mcpCreateClients(MCP_SERVERS_CONFIG); }
    catch (e) { console.warn("[mcp] 加载配置失败:", e.message); _mcpClientsCache = []; }
  }
  return _mcpClientsCache;
}
// === end MCP ===

// ========================
// 实时推送（SSE）订阅注册表：/v1/events 按会话广播「有新消息」事件，
// 让已打开的聊天页实时收到别的设备发来的消息 / 唤醒主动消息，无需手动刷新。
// ========================
const sseSubscribers = new Map(); // sessionId -> Set<reply>
const SSE_HEARTBEAT_MS = 25000;
function sseSubscribe(sessionId, reply) {
  if (!sseSubscribers.has(sessionId)) sseSubscribers.set(sessionId, new Set());
  sseSubscribers.get(sessionId).add(reply);
}
function sseUnsubscribe(sessionId, reply) {
  const set = sseSubscribers.get(sessionId);
  if (set) { set.delete(reply); if (set.size === 0) sseSubscribers.delete(sessionId); }
}
// 广播一次「该会话有新消息」的轻量信号；聊天页收到后再去拉历史，避免把大 payload 推给所有客户端。
function sseNotify(sessionId) {
  const sid = String(sessionId || "default");
  const set = sseSubscribers.get(sid);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type: "history_update", session_id: sid, at: Date.now() });
  for (const reply of Array.from(set)) {
    try { reply.raw.write("data: " + payload + "\n\n"); }
    catch (e) { set.delete(reply); } // 2026-09-21 审查 H13：写失败即摘除，死连接不再滞留 Set 反复遍历
  }
}

// 僵尸连接清扫：客户端异常断开时若未触发 close 事件（半死 TCP），reply.raw.destroyed 会置位；
// 周期性扫描并移除，避免 sseSubscribers 里的 Set 无限累积。unref() 不阻止进程退出。
const SSE_ZOMBIE_SCAN_MS = 60 * 1000;
function sweepSseSubscribers() {
  for (const [sid, set] of sseSubscribers) {
    for (const reply of Array.from(set)) {
      // 2026-09-21 审查 H13：destroyed 之外补判 writableEnded/writableFinished（半开连接三选一命中即摘）
      try {
        const raw = reply.raw;
        if (!raw || raw.destroyed || raw.writableEnded || raw.writableFinished) set.delete(reply);
      }
      catch (e) { set.delete(reply); }
    }
    if (set.size === 0) sseSubscribers.delete(sid);
  }
}
setInterval(sweepSseSubscribers, SSE_ZOMBIE_SCAN_MS).unref();

// ========================
// 幂等回放：同一 client_msg_id 的重复请求直接回放上次已生成的回复，
// 避免网络重发导致上游重复生成 + 时间线重复写入。
// ========================
// client_msg_id -> {text, reasoning, tools, usage, ts}
//                或 {pending:true, ts, waiters:[fn]}（生成中的占位，2026-09-23 F8）
const recentReplies = new Map();
// 1004-05：进行中生成的实时快照（sessionId -> {text, reasoning, tools, ts, done}）。
// 前端断流/切后台回来后轮询 /v1/chat/status 拉这里续显，不再要求用户手动刷新。
// done=true 表示本轮已落盘，保留 10 分钟供最后一次补拉后清理。
const activeGenMap = new Map();
const ACTIVE_GEN_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 分钟内重复请求视为同一条
const RECENT_REPLIES_MAX = 200; // 上限，防止长期运行膨胀（配合 TTL 过期仍会残留，故再加硬上限）
// 2026-09-23 审查 F8：pending 占位的等待上限。首个请求失败/崩溃时要靠它兜底降级，
// 否则重入请求会一直挂到连接超时。取 90s，与客户端「静默超时」同量级。
const IDEMPOTENCY_PENDING_WAIT_MS = 90 * 1000;
// 1003-27：同 client_msg_id 重入请求等待首轮的总上限（5 分钟）。
// 首轮仍在生成时（前端断连自动重发 + 长生成/工具循环）不得降级重调上游，
// 否则会产生双份上游调用、两个一模一样的回复；到总上限仍无结果才允许降级。
const IDEMPOTENCY_PENDING_TOTAL_MS = 5 * 60 * 1000;
function isRecentReplyCacheable(r) {
  return r && typeof r.text === "string" && r.text.length > 0;
}
// 唤醒某占位的全部等待者（payload=null 表示「降级为新请求处理」）
function _wakeReplyWaiters(entry, payload) {
  if (!entry || !Array.isArray(entry.waiters)) return;
  const ws = entry.waiters;
  entry.waiters = [];
  for (const w of ws) { try { w(payload); } catch (e) {} }
}
// 按 ts 淘汰最旧一条（超上限时）；被淘汰者若是 pending 占位，一并唤醒其等待者
function _evictOldestReply() {
  if (recentReplies.size <= RECENT_REPLIES_MAX) return;
  let oldestKey = null, oldestTs = Infinity;
  for (const [k, v] of recentReplies) {
    if (v && typeof v.ts === "number" && v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
  }
  if (oldestKey === null) return;
  const victim = recentReplies.get(oldestKey);
  recentReplies.delete(oldestKey);
  _wakeReplyWaiters(victim, null);
}
// 写入结果并做「按 ts 淘汰最旧」的硬上限；若同 id 存在 pending 占位，唤醒其等待者。
function setRecentReply(id, entry) {
  if (!id) return;
  const prev = recentReplies.get(id);
  recentReplies.set(id, entry);
  _evictOldestReply();
  // 2026-09-23（F8）：唤醒等待同 client_msg_id 的重入请求，让它们回放本次结果而非重复调上游
  if (prev && prev.pending) _wakeReplyWaiters(prev, entry);
}
// 2026-09-23（F8）：请求开始登记 pending 占位。
// 返回 true = 登记成功（本请求负责生成）；false = 已有同 id 的处理中或已有可回放结果，
// 调用方应走「回放」或「等待」分支，不要重复调用上游。
function beginPendingReply(id) {
  if (!id) return false;
  const cur = recentReplies.get(id);
  // 已有未过期的真实结果 → 不是 pending，交给上层原回放分支
  if (cur && !cur.pending && isRecentReplyCacheable(cur) && (Date.now() - cur.ts) < IDEMPOTENCY_TTL_MS) return false;
  // 已有未超时的 pending → 交给上层等待
  if (cur && cur.pending && (Date.now() - cur.ts) < IDEMPOTENCY_PENDING_WAIT_MS) return false;
  recentReplies.set(id, { pending: true, ts: Date.now(), waiters: [] });
  _evictOldestReply();
  return true;
}
// 等待同 id 的首个请求产出结果；超时或占位消失则返回 null（调用方降级为新请求处理）。
function waitPendingReply(id, timeoutMs) {
  return new Promise(function (resolve) {
    const cur = recentReplies.get(id);
    if (!cur || !cur.pending) { resolve(cur || null); return; }
    let done = false;
    const timer = setTimeout(function () {
      if (done) return; done = true;
      // 1003-27：超时不再删除占位——占位是否仍 pending 由调用方判断（首轮还活着 → 继续等，
      // 不降级重调上游）；删除占位的责任归 clearPendingReply（失败）/setRecentReply（成功覆盖）/
      // 调用方总上限兜底。原实现超时即删占位，会令「首轮 >90s 仍在生成」的重入请求误判首轮已死
      // 而再次调用上游，产生双份相同回复。
      resolve(null);
    }, Math.max(1000, Number(timeoutMs) || IDEMPOTENCY_PENDING_WAIT_MS));
    cur.waiters.push(function (entry) {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve(entry || null);
    });
  });
}
// 2026-09-23（F8）：生成失败时释放占位，让后续重试能立刻重新开始（不必等满 90s）。
function clearPendingReply(id) {
  if (!id) return;
  const cur = recentReplies.get(id);
  if (cur && cur.pending) { recentReplies.delete(id); _wakeReplyWaiters(cur, null); }
}

// ---- 模型供应商（多供应商路由）----
const AI_PROVIDERS_CONFIG = path.join(__dirname, "ai-providers.json");
function loadAiProviders() {
  try {
    const raw = fs.readFileSync(AI_PROVIDERS_CONFIG, "utf-8");
    const cfg = JSON.parse(raw);
    return Array.isArray(cfg) ? cfg : (Array.isArray(cfg.providers) ? cfg.providers : []);
  } catch (e) { return []; }
}
function saveAiProviders(list, roleModels) {
  // role_models 随 providers 同文件保存：调用方传入则用传入值，否则保留盘上现值
  let rm = (roleModels && typeof roleModels === "object") ? roleModels : loadRoleModelsRaw();
  writeJsonFileAtomic(AI_PROVIDERS_CONFIG, { providers: list || [], role_models: rm || {} });
}
// 按用途路由模型（2026-09-24）：抽到独立 model-router.js，server.js API 与后台任务模块共用同一份解析
const {
  KNOWN_MODEL_ROLES,
  loadRoleModelsRaw,
  saveRoleModel,
  resolveRoleModel
} = require("./model-router");

// ---- 人设权威（2026-09-24 B 方案）：服务端自己决定该会话该用哪个人设，前端请求带的 system 不再决定盘上存什么 ----
// 解析顺序：data/session-prompts.json(sid->backupId) -> data/prompt-backups.json 内容 -> chat-settings.json 全局 system_prompt
function resolveSessionSystemPrompt(sessionId) {
  try {
    const sid = String(sessionId || "default").trim() || "default";
    // 1) 会话级映射
    let backupId = "";
    try {
      const spFile = path.join(__dirname, "data", "session-prompts.json");
      if (fs.existsSync(spFile)) {
        const j = JSON.parse(fs.readFileSync(spFile, "utf-8"));
        // 0929-30：session-prompts.json 是顶层结构 {sid: backupId}（无 prompts 包裹），
        // 旧读取 j.prompts[sid] 永远读不到 → 会话级人设一直回退全局。兼容两种结构。
        if (j && typeof j === "object") {
          if (typeof j[sid] === "string") backupId = j[sid];
          else if (j.prompts && typeof j.prompts[sid] === "string") backupId = j.prompts[sid];
        }
      }
    } catch (e) {}
    if (backupId) {
      try {
        const pbFile = path.join(__dirname, "data", "prompt-backups.json");
        if (fs.existsSync(pbFile)) {
          const arr = JSON.parse(fs.readFileSync(pbFile, "utf-8"));
          const hit = Array.isArray(arr) ? arr.find(function (b) { return b && b.id === backupId && typeof b.content === "string"; }) : null;
          if (hit && hit.content && hit.content.trim()) return hit.content.trim();
          console.warn("[resolveSessionSystemPrompt] 会话人设引用的备份缺失，回退全局人设: session=" + sid + " backupId=" + backupId);
        } else {
          console.warn("[resolveSessionSystemPrompt] 会话人设引用的备份缺失（备份文件不存在），回退全局人设: session=" + sid + " backupId=" + backupId);
        }
      } catch (e) {}
    }
  } catch (e) {}
  // 2) 全局人设（chat-settings.json）
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(__dirname, "chat-settings.json"), "utf-8"));
    if (cs && typeof cs.system_prompt === "string" && cs.system_prompt.trim()) return cs.system_prompt.trim();
  } catch (e) {}
  return "";
}
// 取「标记为默认」或第一个已启用的供应商（未配置则回退 TARGET_API_*）
function resolveActiveProvider() {
  const ps = loadAiProviders();
  const def = ps.find(function (p) { return p.is_default === true && p.enabled !== false && (p.api_url || p.base_url) && p.api_key; });
  if (def) return def;
  return ps.find(function (p) { return p.enabled !== false && (p.api_url || p.base_url) && p.api_key; }) || null;
}
// 统一聊天模型解析（2026-09-08）：会话级设置(供应商+模型) → 全局默认供应商 → env 兜底。
// 直通路径与 MCP 工具循环共用同一口径；模型名必须属于供应商模型列表，不在则回退供应商默认并告警。
function resolveChatModel(sessionId, bodyModel) {
  const sessPid = sessionModelProviderOverride(sessionId);
  const sessModel = sessionModelNameOverride(sessionId);
  const providers = loadAiProviders();
  const usable = function (p) { return p && p.enabled !== false && (p.api_url || p.base_url) && p.api_key; };
  const modelsOf = function (p) {
    if (Array.isArray(p.models) && p.models.length) return p.models;
    if (p.model) return [p.model];
    return [];
  };
  // L1 会话级显式设置
  if (sessPid) {
    const hit = providers.find(function (p) { return p.id === sessPid && usable(p); });
    if (hit) {
      const list = modelsOf(hit);
      if (sessModel && list.length && list.indexOf(sessModel) < 0) {
        console.warn("[resolveChatModel] 会话指定模型不在该供应商列表，回退供应商默认: " + sessModel);
      } else if (sessModel) {
        return { provider: hit, model: sessModel };
      }
      return { provider: hit, model: hit.model || list[0] || sessModel || bodyModel || "" };
    }
    console.warn("[resolveChatModel] 会话指定供应商不可用，回退全局默认: " + sessPid);
  }
  // L2 全局默认供应商
  const active = resolveActiveProvider();
  if (active) {
    const list = modelsOf(active);
    const bm = bodyModel && (!list.length || list.indexOf(bodyModel) >= 0) ? bodyModel : "";
    if (bodyModel && list.length && list.indexOf(bodyModel) < 0) {
      console.warn("[resolveChatModel] 请求模型不在默认供应商列表，回退供应商默认: " + bodyModel);
    }
    return { provider: active, model: bm || active.model || list[0] || "" };
  }
  // L3 env 兜底
  return { provider: null, model: bodyModel || readEnvValue("MODEL_NAME") || "" };
}
// 2026-09-30 V4 收敛：消息时间戳原子件统一引 time_utils（本地四份正则实现已删），
// 别名保持原函数名，调用点零改动。parseCurrentTimeTagLoose/parseLeadingWallTime/parseTrailingWallTime
// 为原 extractCurrentTimeTagLabel/parseTimestampLabel/extractTrailingTimestampLabel 的并集增强版。
const {
  getDatePartsInTimeZone,
  formatDateTimeInTimeZone,
  parseWakeTarget,
  resolveTimeZone,
  zonedWallTimeToDate,
  parseCurrentTimeTagLoose: extractCurrentTimeTagLabel,
  parseLeadingWallTime: parseTimestampLabel,
  parseLeadingWallTime: extractTimestamp,
  parseTrailingWallTime: extractTrailingTimestampLabel
} = require("./time_utils");
const { writeJsonAtomic: _writeJsonAtomicBase } = require("./json_atomic");

const contextCompactor = require("./context-compactor");
const contextReplacements = require("./context-replacements");
const contextDigest = require("./context-digest");
const conversationState = require("./lib/conversation-state");
// 状态机日志接进压缩页悬浮球（addCompactionLog 是函数声明，提升可用；闭包隔开 compactionLogs 的 TDZ）
conversationState.setLogFn(function (entry) {
  // 1004-12：状态机日志统一打 action=state 标签，前端压缩页日志按"状态机压缩"分组
  if (entry && typeof entry === "object" && !entry.action) entry = Object.assign({}, entry, { action: "state" });
  return addCompactionLog(entry);
});

const DEFAULT_BODY_LIMIT_MB = 50;

// 请求体大小上限（MB → 字节）：REQUEST_BODY_LIMIT_MB 可调，默认 50MB（大 base64 附件需要）
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

// 多会话：压缩/上下文替换按会话时间线工作。对 /admin/context-compaction/* 与 /admin/context-replacements/* 请求，从 query 的 session_id 设置活跃会话；响应后复位（无 session_id 则回退主会话）。
// 2026-10-03：/admin/conversation-state/*（状态机）也按会话工作，接进同一个机制——
// 否则 compressibleItems()/loadTimeline() 读到的是「上一个请求留下的活跃会话」，
// 并入的原文会取错会话。对已有两个前缀的行为零改动（它们只传 session_id）。
app.addHook("onRequest", async (req, reply) => {
  if (req.url && (req.url.startsWith("/admin/context-compaction") || req.url.startsWith("/admin/context-replacements") || req.url.startsWith("/admin/conversation-state"))) {
    const sidRaw = req.query && (req.query.session_id !== undefined ? req.query.session_id : req.query.session);
    const sid = sidRaw ? String(sidRaw) : null;
    req.__ctxWasSet = sid != null;
    contextReplacements.setActiveSession(sid);
  }
});
app.addHook("onResponse", async (req, reply) => {
  if (req.__ctxWasSet) {
    contextReplacements.setActiveSession(null);
    req.__ctxWasSet = false;
  }
});

const PORT = Number(process.env.PORT) || 3000;
const TARGET_API_URL = process.env.TARGET_API_URL;
const TIME_ZONE = resolveTimeZone();
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID
);
const TIMELINE_FILE = "enhanced_messages.json";
// 多会话：按 sessionId 计算对应的时间线文件。
// 空/缺省 sessionId 走默认主会话（enhanced_messages.json），100% 兼容旧行为。
// 清洗后为空的会话ID（如纯中文）用哈希生成稳定文件名：否则不同会话会共用 enhanced_messages_.json 串数据。
// 2026-09-21 审查 R20：实现收敛到 lib/session-token.js（diary.js / context-replacements.js 同源副本已一并收敛）
const { safeSessionToken } = require("./lib/session-token");
const upstreamAlert = require("./lib/upstream-alert"); // 2026-09-28 上游 402（余额不足）提醒
upstreamAlert.setPushFn(function (opts) { return sendPushNotification(opts); });
function timelineFileFor(sessionId) {
  const token = safeSessionToken(sessionId);
  if (token === "default") return TIMELINE_FILE;
  return "enhanced_messages_" + token + ".json";
}
// 批注 2026-07-17：管理页保存 .env 后要让 PM2 刷新进程环境；保留原进程名，
// 只补 --update-env，避免用户改完推送配置却继续运行旧值。
const DEFAULT_RESTART_COMMAND = "cd /opt/dylan-heartbeat && pm2 restart gateway --update-env 2>&1";
// 上游模型请求超时（毫秒），防止上游挂起时 /v1 请求永久阻塞
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;

// 布尔环境读取：注意这里直读 process.env（非 readEnvValue 的 cachedEnv 口径），
// 管理台改 .env 后要等重启才对本函数生效
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
  // 2026-09-08：图片始终原样透传给视觉模型，不再做任何 mode 回退限制。
  return true;
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

// 文件 part → 文本摘要：LLM/时间线/日志共用（LLM 不解析 file 结构，只感知"用户发了文件"）
function filePartSummary(part) {
  const f = (part && typeof part === "object" && part.file) || null;
  if (f && typeof f === "object") {
    const name = String(f.name || "文件").trim() || "文件";
    const mime = String(f.mime || "").trim();
    const size = typeof f.size === "number" && f.size > 0 ? f.size : 0;
    let s = "[文件] " + name;
    if (mime) s += "（" + mime + "）";
    if (size) s += "，" + (size >= 1048576 ? (size / 1048576).toFixed(1) + "MB" : size >= 1024 ? Math.round(size / 1024) + "KB" : size + "B");
    return s;
  }
  return "[文件]";
}


// ========================
// 文件内容注入（2026-09-10 方案A）：文本类文件把正文读进模型上下文，
// 让 AI 真正"看到"文件内容；非文本或读取失败降级为元信息摘要。
// 仅 LLM 转发链路使用；时间线/日志仍走 filePartSummary 纯摘要，防 localStorage 膨胀。
// ========================
const UPLOADS_DIR = path.join(__dirname, "data", "uploads");
const TEXT_FILE_EXTS = new Set([
  "txt", "md", "markdown", "csv", "json", "log", "py", "js", "mjs", "ts", "tsx", "jsx",
  "html", "htm", "css", "xml", "yaml", "yml", "ini", "conf", "cfg", "sh", "bash", "zsh",
  "java", "c", "h", "cpp", "hpp", "go", "rs", "sql", "toml", "env", "properties", "rst",
  "tex", "vue", "svelte", "dockerfile", "gradle", "lock"
]);
function isTextFilePart(fileObj) {
  const f = fileObj && typeof fileObj === "object" ? fileObj : {};
  const m = String(f.name || "").match(/\.([a-zA-Z0-9]{1,12})$/);
  const ext = m ? m[1].toLowerCase() : "";
  if (TEXT_FILE_EXTS.has(ext)) return true;
  const mt = String(f.mime || "").toLowerCase();
  return mt.startsWith("text/") ||
    mt === "application/json" || mt === "application/xml" ||
    mt === "application/javascript" || mt === "application/x-javascript" ||
    mt === "application/yaml" || mt === "application/x-yaml";
}
// 从 /uploads/<file> URL 读取本地文件正文（同步，只读前 maxLen+1 字节，超长截断）。失败返回 null。
function readUploadedFileContent(fileObj, maxLen) {
  maxLen = maxLen || 10000;
  const f = fileObj && typeof fileObj === "object" ? fileObj : {};
  const url = String(f.url || "");
  const m = url.match(/\/uploads\/([^/?#]+)/);
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; }
  const fp = path.join(UPLOADS_DIR, path.basename(name));
  try {
    const fd = fs.openSync(fp, "r");
    let s = "";
    try {
      const buf = Buffer.alloc(maxLen + 1);
      const n = fs.readSync(fd, buf, 0, maxLen + 1, 0);
      if (n > 0) s = buf.toString("utf8", 0, n);
    } finally { fs.closeSync(fd); }
    if (s.length > maxLen) s = s.slice(0, maxLen) + "\n…(内容过长已截断)";
    return s;
  } catch (e) { return null; }
}
// 文件 part -> LLM 文本：文本类注入正文，否则保持元信息摘要。
function filePartTextForLLM(part) {
  const summary = filePartSummary(part);
  const f = part && typeof part === "object" && part.file ? part.file : null;
  if (!f) return summary;
  if (!isTextFilePart(f)) return summary;
  const content = readUploadedFileContent(f);
  if (content === null || !content.trim()) return summary;
  return summary + "\n【文件内容】\n" + content;
}

function getTextFromContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  if (type === "text" || type === "input_text") return part.text || part.content || "";
  if (typeof part.text === "string") return part.text;
  return "";
}

// 从 assistant 消息提取思考链文本：依次找 reasoning_content/reasoning/thinking 字段
// （字符串或分片数组），再找 content 里的 think/reason 类型分片；取第一个非空来源
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

// 任意 content 形态（字符串/多模态数组/null）→ 纯文本：文本分片取文本、图片→[图片]、
// 文件→元信息摘要、其他→[非文本内容]。全文件最常用的内容归一函数，时间线/日志/扣住等都靠它
function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        const text = getTextFromContentPart(part).trim();
        if (text) return text;
        if (isImageContentPart(part)) return "[图片]";
        if (isFileContentPart(part)) return filePartSummary(part);
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }

  if (isImageContentPart(content)) return "[图片]";
  if (isFileContentPart(content)) return filePartSummary(content);
  return "[非文本内容]";
}

// 截掉 Kelivo 客户端 system prompt 自带的「## search_web 工具使用说明」及之后内容
// （第三方 App 注入的宣传段，与本项目人设无关，不进时间线/不进模型）
function stripKelivoSystemBloat(text) {
  const marker = '## search_web 工具使用说明';
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  return text.substring(0, idx).trimEnd();
}

// 时间线落盘前的消息归一：content 转纯文本；system 额外剥 Kelivo 自带说明段
function normalizeMessageForTimeline(msg) {
  const raw = normalizeContentToText(msg.content);
  const cleaned = msg.role === 'system' ? stripKelivoSystemBloat(raw) : raw;
  return { ...msg, content: cleaned };
}


// 消息 → LLM 可用形态（发模型前的统一入口）：system 清洗、文件 part 转文本（文本类注入正文，
// 见「文件内容注入」节）、多模态数组透传/转文本、空内容返回 null 由调用方丢弃
function prepareMessageForLLM(msg) {
  if (msg.role === "assistant" && msg.tool_calls) return msg;
  if (msg.role === "tool") return msg;
  if (msg.role === "system") {
    // 系统时间不再追加到 system prompt，改为动态注入到最后一条 user 之后（方案A）
    let content = stripKelivoSystemBloat(normalizeContentToText(msg.content));
    return { ...msg, content };
  }
  if (typeof msg.content === "string") return msg;

  if (Array.isArray(msg.content) && shouldForwardMultimodalContent()) {
    // 2026-09-10：文件 part 上游模型不解析（可能拒收未知结构），转文本摘要；图片 part 原样透传。
    // 2026-09-10 方案A：文本类文件把正文读进上下文（readUploadedFileContent），AI 真正可见文件内容；
    // 非文本或读取失败仍降级为元信息摘要；图片 part 原样透传。
    if (!msg.content.some(isFileContentPart)) return msg;
    return { ...msg, content: msg.content.map(function (p) {
      if (isFileContentPart(p)) return { type: "text", text: filePartTextForLLM(p) };
      return p;
    }) };
  }

  const textContent = normalizeContentToText(msg.content);
  if (!textContent) return null;
  return { ...msg, content: textContent };
}

// 单条消息的日志摘要（只记角色/形态/字数/分片数，内容不进 pm2 日志）
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

// ========================
// Streaming tag filter helper
// 上游（如 DeepSeek）会把 <memory>/<pin> 拆成 <、memory、> 等多个 SSE 事件，
// 字节层找不到完整标签，必须在 content 文本层做带缓冲的过滤。
// ========================
// 与唤醒调度器（lib/wake-scheduler.js，2026-09-15 起同在 gateway 进程内）共用同一份
// wake_schedule.json（v2 多会话 per-session 槽位）：读写已收口到 lib/wake-schedule.js
// （文件锁 + 锁内重读合并 + 损坏拒写），调度器以 20s 轻量轮询文件指纹感知变化后重挂定时器
// （原 wake-up 独立进程轮询，进程已退役）。批注 2026-09-13（审查 D3）。
const wakeSchedule = require("./lib/wake-schedule");
function saveWakeSchedule(nextWakeAtIso, sessionId, options) {
  return wakeSchedule.saveSlot(nextWakeAtIso, sessionId, options);
}

// 对话侧 <wake> 闹钟标签：AI 在对话里设置闹钟（日期时间或分钟）；标签不显示给用户。
// 返回剥离标签后的文本；同时把闹钟写入 wake_schedule.json（唤醒调度器轮询感知后挂定时器）。
// 2026-09-26：支持尾部 keep=true —— 该闹钟不受「用户中途发言即作废」影响（落 keep 字段）。
function parseWakeTagAndSchedule(text, sessionId) {
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
    saveWakeSchedule(nextWakeAt.toISOString(), sessionId, { keep: !!target.keep });
    console.log(`[wake] 对话设置闹钟：${formatDateTimeInTimeZone(nextWakeAt, TIME_ZONE)}（${nextWakeAt.toISOString()}，会话 ${sessionId || "default"}${target.keep ? "，keep=true 不受用户发言影响" : ""}）`);
  } catch (err) {
    console.warn("[wake] 保存闹钟失败:", err.message);
  }
  return cleaned;
}


function createContentTagFilter() {
  let buf = "";
  let inTag = false;
  let tagType = ""; // "memory" | "pin" | "wake" | "quiet" | "compacted"

  // 判断 tail（从某个 "<" 开始的小写文本）是否可能是 memory/pin/wake/compacted/paper 开标签
  function isPotentialOpen(tail) {
    if (/^<(memory|pin|wake|quiet|compacted|paper)(\s[^>]*)?>/.test(tail)) return true; // 完整开标签（可带属性）
    if (/^<(memory|pin|wake|quiet|compacted|paper)\s[^>]*$/.test(tail)) return true;     // 属性写法进行中
    if (/^<(memory|pin|wake|quiet|compacted|paper)$/.test(tail)) return true;            // 恰好 <memory / <pin / <wake / <quiet / <compacted / <paper
    if (/^<m(?:e(?:m(?:o(?:r)?)?)?)?$/.test(tail)) return true; // <m <me <mem <memo <memor
    if (/^<p(?:i)?$/.test(tail)) return true;                  // <p <pi
    if (/^<p(?:a(?:p(?:e(?:r)?)?)?)?$/.test(tail)) return true; // <p <pa <pap <pape <paper
    if (/^<w(?:a(?:k)?)?$/.test(tail)) return true;            // <w <wa <wak
    if (/^<c(?:o(?:m(?:p(?:a(?:c(?:t)?)?)?)?)?)?$/.test(tail)) return true; // <c <co <com <comp ... <compacte
    if (/^<star(\s[^>]*)?\/?>/.test(tail)) return true;        // <star> <star/> <star 属性（完整或接近完整）
    if (/^<s(?:t(?:a(?:r)?)?)?$/.test(tail)) return true;      // <s <st <sta <star
    if (tail === "<") return true;
    return false;
  }

  // 找到最早的可能是标签开头的 "<"
  function findOpenIndex(str) {
    const lower = str.toLowerCase();
    const candidates = [];
    const re = /<(?=[mpwqcs])/g;
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
          const closeRe = tagType === "memory" ? /<\/memory>/i : tagType === "pin" ? /<\/pin>/i : tagType === "quiet" ? /<\/quiet>/i : tagType === "compacted" ? /<\/compacted>/i : tagType === "star" ? /<\/star\s*>/i : tagType === "paper" ? /<\/paper\s*>/i : /<\/wake>/i;
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
          const lowerBuf = buf.toLowerCase();
          // <star>/<paper> 是轻量记号：自闭合 <star/>/<paper .../> 直接吞掉并继续输出后续正文；成对写法才进 inTag 等闭合
          const starSelf = lowerBuf.match(/^<star\b[^>]*\/>/);
          if (starSelf) {
            buf = buf.slice(starSelf[0].length);
            continue;
          }
          const paperSelf = lowerBuf.match(/^<paper\b[^>]*\/>/);
          if (paperSelf) {
            buf = buf.slice(paperSelf[0].length);
            continue;
          }
          if (/^<(memory|pin|wake|quiet|compacted|star|paper)(\s[^>]*)?>/.test(lowerBuf)) {
            inTag = true;
            tagType = lowerBuf.startsWith("<pin") ? "pin" : lowerBuf.startsWith("<wake") ? "wake" : lowerBuf.startsWith("<quiet") ? "quiet" : lowerBuf.startsWith("<compacted") ? "compacted" : lowerBuf.startsWith("<star") ? "star" : lowerBuf.startsWith("<paper") ? "paper" : "memory";
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
// 时间线读缓存：按 mtime/size 指纹失效。返回的永远是深拷贝（structuredClone），
// 调用方（appendMessages/appendRequestMessages/历史接口等）原地增删改的是克隆，
// 绝不污染缓存里的共享数组，避免跨请求/跨异步共享可变引用导致串扰。
// 任何 saveTimeline 都会改动文件 mtime/size → 指纹变化 → 下次自动重读，无需显式失效。
const _timelineCache = new Map(); // sessionId -> { fp, data }
const _TIMELINE_CACHE_MAX = 60;
const _corruptBackupDone = new Set(); // 已做过 .corrupt-* 备份的文件：同一轮损坏只备份一次，防反复 load 堆积备份
// 时间线文件指纹（size:mtime:ctime:ino）：读缓存失效与写守卫「过期快照拒写」共用。
// 2026-09-22 审查 M8：原只用 size:mtimeMs，同毫秒内等长编辑指纹不变 → 读缓存返回陈旧数据、
// 写守卫失效。补 ctimeMs 与 ino（同一次 statSync 拿，零额外 IO）。
function timelineFingerprint(file) {
  try {
    const st = fs.statSync(file);
    return st.size + ":" + st.mtimeMs + ":" + st.ctimeMs + ":" + st.ino;
  } catch (e) { return ""; }
}
// 时间线深拷贝（structuredClone 优先，退 JSON 往返）
function cloneTimeline(data) {
  try { return structuredClone(data); } catch (e) { return JSON.parse(JSON.stringify(data)); }
}
// 盘上是否已存在与该文件**内容相同**的 .corrupt-* 备份（2026-09-23 审查 M9）：
// 内存去重集 _corruptBackupDone 在进程重启后清空，若文件仍损坏会再备份一份、逐次堆积；
// 改为比对最近一份备份的内容哈希——同内容跳过，内容不同（新损坏）仍会新建备份。
function hasSameCorruptBackup(file) {
  try {
    const dir = path.dirname(file);
    const prefix = path.basename(file) + ".corrupt-";
    const cands = fs.readdirSync(dir).filter(n => n.startsWith(prefix)).sort();   // 名字含 ISO 时间戳，字典序＝时间序
    if (!cands.length) return false;
    const last = path.join(dir, cands[cands.length - 1]);
    const h = f => crypto.createHash("md5").update(fs.readFileSync(f)).digest("hex");
    return h(file) === h(last);
  } catch (e) {
    return false;   // 异常按「没有同内容备份」处理——宁可多备一份，也不漏掉损坏现场
  }
}
// 守卫标记（2026-09-19 审查 P1-2 配套）：loadTimeline 返回的克隆统一在「clone 之后」挂 __fp
// （load 时刻的盘上指纹），因此 structuredClone 与 JSON fallback 两条克隆路径拿到的快照都带
// 标记。数组自定义属性不进 JSON.stringify，不会落盘污染文件；saveTimeline 据此识别过期快照。
function tagTimelineSnapshot(cloned, fp) {
  try { cloned.__fp = fp; } catch (e) {}
  return cloned;
}
function loadTimeline(sessionId) {
  const file = timelineFileFor(sessionId);
  if (!fs.existsSync(file)) return [];
  const fp = timelineFingerprint(file);
  const hit = _timelineCache.get(sessionId);
  if (hit && hit.fp === fp) return tagTimelineSnapshot(cloneTimeline(hit.data), fp);
  try {
    const data = fs.readJsonSync(file);
    _corruptBackupDone.delete(file); // 文件能正常解析＝已从损坏中恢复，下次再损坏要重新备份
    _timelineCache.set(sessionId, { fp, data });
    if (_timelineCache.size > _TIMELINE_CACHE_MAX) {
      // 防长期运行膨胀：超上限清掉最旧的一条
      const firstKey = _timelineCache.keys().next().value;
      if (firstKey !== undefined) _timelineCache.delete(firstKey);
    }
    return tagTimelineSnapshot(cloneTimeline(data), fp);
  } catch (err) {
    // 文件损坏：先备份（同一文件只备一次），返回带 __corrupt 标记的空时间线——
    // saveTimeline 见标记且原文件仍在即拒写，绝不能用空数组覆盖损坏的历史文件。
    if (!_corruptBackupDone.has(file)) {
      try {
        // 2026-09-23 审查 M9：去重集只在内存，进程重启后清空 → 文件仍损坏时会重复备份、
        // .corrupt-* 逐次堆积。补一层「盘上已有同内容备份则跳过」（比对最近一份的 md5）。
        if (!hasSameCorruptBackup(file)) {
          const bak = file + ".corrupt-" + new Date().toISOString().replace(/[:.]/g, "-");
          fs.copySync(file, bak);
          console.error("[timeline] 时间线文件损坏，已备份到 " + bak + "，本次按空时间线处理；该文件的后续写入将被拒绝直至人工恢复:", err.message);
          notifyTimelineWriteRejected("时间线文件损坏已备份(.corrupt-*)，该会话后续写入将被拒", sessionId);
        } else {
          console.error("[timeline] 时间线文件损坏，盘上已有同内容 .corrupt-* 备份，跳过重复备份；本次按空时间线处理:", err.message);
        }
        _corruptBackupDone.add(file);   // 本轮已处理（同内容备份已存在时也标记，避免反复扫盘）
      } catch (bakErr) {
        console.error("[timeline] 时间线文件损坏且备份失败（写入守卫仍会拒绝覆盖）:", err.message, "|", bakErr.message);
      }
    }
    const empty = [];
    try { empty.__corrupt = true; } catch (e) {}
    return empty;
  }
}

// ── 会话删除墓碑（2026-09-20 审查 F-3 配套）──
// 删除会话后，迟到的写入（生成中回复收尾/唤醒事件等）会用「空时间线+新消息」把已删会话
// 以残骸文件复活。删除时在此记墓碑（相对路径，与 TIMELINE_FILE 同一 cwd 约定），saveTimeline
// 见墓碑且文件不存在即拒写；TTL 过期自动失效（此后同 id 重建不再拦截）。单用户场景 cap 50 条。
const TOMBSTONE_FILE = path.join("data", "deleted_sessions.json");
const SESSION_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
function readDeletedSessionsMap() {
  try {
    const v = fs.readJsonSync(TOMBSTONE_FILE);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}
function writeDeletedSessionsMap(map) {
  try {
    fs.mkdirSync(path.dirname(TOMBSTONE_FILE), { recursive: true });
    atomicWriteJsonSync(TOMBSTONE_FILE, map);
  } catch (e) { console.warn("[timeline] 写会话删除墓碑失败:", e.message); }
}
function pruneDeletedSessions(map, now) {
  const out = {};
  for (const k of Object.keys(map)) {
    const t = Number(map[k]);
    if (Number.isFinite(t) && now - t < SESSION_TOMBSTONE_TTL_MS) out[k] = t;
  }
  return out;
}
function isSessionTombstoned(token, now) {
  if (!token || token === "default") return false;
  const map = readDeletedSessionsMap();
  const t = Number(map[token]);
  return Number.isFinite(t) && (now || Date.now()) - t < SESSION_TOMBSTONE_TTL_MS;
}
function markSessionDeleted(sessionId) {
  const token = safeSessionToken(sessionId);
  if (!token || token === "default") return false;
  const now = Date.now();
  const map = pruneDeletedSessions(readDeletedSessionsMap(), now);
  map[token] = now;
  const keys = Object.keys(map);
  if (keys.length > 50) {
    keys.sort((a, b) => map[a] - map[b]);
    for (let i = 0; i < keys.length - 50; i++) delete map[keys[i]];
  }
  writeDeletedSessionsMap(map);
  return true;
}

// 原子写入：先写临时文件再 rename，避免进程被杀/崩溃时把 JSON 写坏。
// 2026-09-30 V10 收敛：实现统一委托 json_atomic.writeJsonAtomic（七份重复实现唯一来源），函数名保留。
function atomicWriteJsonSync(file, data) {
  _writeJsonAtomicBase(file, data);
}

function atomicWriteFileSync(file, content) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    // 2026-09-22 审查 M3：rename 前补 fsync——否则数据可能仍在页缓存，掉电/断电后
    // rename 已生效但内容截断（.env、时间线、墓碑等关键小文件都走这里）
    const fd = fs.openSync(tmp, "w");
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
  }
}




// ========================
// 保存 timeline（保留 SP）
// ========================
// 2026-09-21 审查 H3②+H4：拒写/损坏对管理员必须可见——此前只有 console.error，
// 调用方又不检查 saveTimeline 返回值，会话冻结/消息丢弃完全静默。Bark 推送 fire-and-forget。
function notifyTimelineWriteRejected(reason, sessionId) {
  try {
    sendPushNotification({
      title: "⚠️ 时间线写入被拒",
      body: `会话 ${sessionId || "default"}：${reason}。该会话可能已冻结/消息未落盘，请尽快人工处理。`
    }).catch(e => console.error("[timeline] 拒写告警推送失败:", e.message));
  } catch (e) { console.error("[timeline] 拒写告警推送异常:", e.message); }
}
function saveTimeline(messages, sessionId) {
  const file = timelineFileFor(sessionId);
  // ── 写守卫（2026-09-19 审查 P1-2 配套）：两条拒写规则，先 corrupt 后过期快照。──
  // 1) 损坏守卫：loadTimeline 因文件损坏返回的空时间线（带 __corrupt）绝不能写回，
  //    否则一次普通 append 就把整份历史覆盖成「空 + 新消息」（原文件已有 .corrupt-* 备份）。
  if (messages && messages.__corrupt === true && fs.existsSync(file)) {
    console.error("[timeline] 拒绝写入：会话 " + (sessionId || "default") + " 的时间线文件此前读取损坏（.corrupt-* 已备份），本次写入已丢弃以保护原文件。请人工核对恢复后重试。");
    notifyTimelineWriteRejected("时间线文件损坏，写入被拒（会话冻结中）", sessionId);
    return false;
  }
  // 2) 过期快照守卫：克隆数组带 __fp（load 时刻的盘上指纹）。盘上指纹已变＝load 与 save
  //    之间发生过其他写入（跨 await 携带旧快照的调用方式），放行会覆盖掉那些新写入——
  //    拒写并要求重新 load。现有同步原语（load→改→save 无 await）指纹必然一致，不受影响。
  if (messages && messages.__fp !== undefined && fs.existsSync(file)) {
    const curFp = timelineFingerprint(file);
    if (curFp && curFp !== messages.__fp) {
      console.error("[timeline] 拒绝写入：会话 " + (sessionId || "default") + " 的快照已过期（load 时指纹 " + messages.__fp + " ≠ 盘上当前 " + curFp + "，期间有其他写入）。本次写入已丢弃以避免覆盖新消息，请重新 loadTimeline 后再修改。");
      notifyTimelineWriteRejected("快照过期冲突，写入被拒（本条修改未落盘）", sessionId);
      return false;
    }
  }
  // 3) 墓碑守卫：文件已删除且仍在墓碑期内 → 拒绝重建（防迟到写入复活已删会话，见 markSessionDeleted）
  if (!fs.existsSync(file)) {
    if (isSessionTombstoned(safeSessionToken(sessionId))) {
      console.error("[timeline] 拒绝写入：会话 " + (sessionId || "default") + " 已删除且在墓碑期内，本次写入已丢弃（防迟到写入复活已删会话）。");
      notifyTimelineWriteRejected("会话已删除（墓碑期），迟到写入被拒", sessionId);
      return false;
    }
  }
  // 稳定 id：任何写盘路径都保证每条消息有唯一 id（老数据首次被写时补齐），
  // 供「编辑/删除 diff 协议」按 id 定点 patch，position 不动、不再重排。system 也统一给 id。
  for (const m of messages) { if (m && !m.id) m.id = crypto.randomUUID(); }
  const sp = messages.find(m => m.role === "system");
  const nonSP = messages.filter(m => m.role !== "system");
  // 兜底：任何写入路径都补齐缺失的 time（system 除外），避免历史消息/特殊事件缺时间
  backfillMissingTimes(nonSP);
  // 不再截断：完全保留客户端发送的全部消息（仅将 SP 放在首位）
  const final = sp ? [sp, ...nonSP] : nonSP;
  atomicWriteJsonSync(file, final);
  return true;
}

// ========================
// 提取时间戳（支持多种格式）
// 2026-09-30 V4 收敛：以下四个解析函数的本地实现已删，统一从 time_utils 引入
// （见顶部 require 的别名映射：parseTimestampLabel/extractTimestamp/extractTrailingTimestampLabel/
// extractCurrentTimeTagLabel）。extractTimestampWithMemory 的调用链保持不变。
// ========================

// 消息时间解析：优先 time 字段（客户端已传）→ <current_time> 标签 → 末尾时间缀 → 开头时间戳（AI 抄的）
function extractTimestampWithMemory(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const text = normalizeContentToText(msg.content);
  // 特殊事件：优先取内容【开头】的墙上时间（事件发生时间），
  // 避免末尾「，且设定了主动唤醒时间：…」被误当成消息末尾的时间缀，导致事件被排到上下文最底部。
  if (typeof isSpecialEvent === "function" && isSpecialEvent(msg)) {
    const fromContent = extractTimestamp(text);
    if (fromContent) return fromContent;
  }
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
// 「真实对话消息」判定（时间线写入/计数/搜索的统一口径）：排除 system、工具调用、
// 特殊事件、<system> 开头的 user 伪装消息，只认 user/assistant
function isRealMessageForTimeline(msg) {
  if (msg.role === "system") return false;
  if (msg.tool_calls) return false;
  if (isSpecialEvent(msg)) return false;
  const contentText = normalizeContentToText(msg.content);
  if (msg.role === "user" && contentText.trim().startsWith("<system>")) return false;
  return msg.role === "user" || msg.role === "assistant";
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
function buildTimeline(kelivoMessages, sessionId) {
  const oldTimeline = loadTimeline(sessionId);
  // position → 旧时间线消息，用于找回已保存的 time，避免历史消息每次都回落为服务器时间
  // 按 role+content 匹配旧时间线找回已保存的 time（position 在客户端增删后会错位，内容匹配更鲁棒）
  const oldByContent = new Map();
  for (const m of oldTimeline) {
    if (!m.time) continue;
    const key = m.role + "\u0000" + normalizeContentToText(m.content);
    if (!oldByContent.has(key)) oldByContent.set(key, m);
  }
  // 本批最后一条实时 user 消息的下标（接收时刻≈真实时间，供唤醒判断使用）；
  // 用下标而不是对象引用：map 展开后是新对象，引用比较永远为 false
  let lastUserFallbackIdx = -1;
  function toValidDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  function resolveMessageTime(msg, idx) {
    const direct = toValidDate(msg.time);
    if (direct) return direct;
    const old = oldByContent.get(msg.role + "\u0000" + normalizeContentToText(msg.content));
    const oldTime = toValidDate(old && old.time);
    if (oldTime) return oldTime;
    const fromContent = extractTimestampWithMemory(msg);
    if (fromContent) return fromContent;
    // 只有本批最后一条实时 user 消息才回填服务器接收时刻（Kelivo 实时推送≈真实时间）；
    // 其余消息不再盖伪时间，避免历史消息全部堆在同一时刻导致时间感失真
    if (idx != null && idx === lastUserFallbackIdx) return new Date();
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

  // 时间线图片原样保留：不裁剪、不压 [图片] 占位（2026-09-08）
  const realForTimeline = kelivoMessages.filter(isRealMessageForTimeline);
  const hasAnyImagePart = function (msg) { return Array.isArray(msg && msg.content) && msg.content.some(p => p && isImageContentPart(p)); };
  // 提前算好"本批最后一条实时 user 消息"的下标：resolveMessageTime 在下面 map 时就要用它，
  // 原实现赋值晚于使用导致回填分支永不生效
  lastUserFallbackIdx = -1;
  for (let i = realForTimeline.length - 1; i >= 0; i--) {
    if (realForTimeline[i].role === "user") { lastUserFallbackIdx = i; break; }
  }
  // 2026-09-08：时间线图片原样保留，不做历史裁剪/占位（keep_recent_image_turns 已移除）
  const newRealMessages = realForTimeline
    .map(function (m) {
      if (hasAnyImagePart(m)) return { ...m, content: m.content };      // 保留真实 image_url
      return normalizeMessageForTimeline(m);
    })
    .map(function (m, i) { return { ...m, _t: resolveMessageTime(m, i) }; });

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

  // lastUserFallback 已在上方（map 之前）提前计算，这里不再赋值（原赋值晚于使用，是死代码）

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
// 追加消息（增量原语）
// ========================
// 方案二核心：把「每次写时间线 = 整文件重建覆盖」拆成「只往后追加」。
// 批量版一次读盘/写盘/通知；新消息 position 依次 maxPos+0.5+i，绝不改动已有消息的
// position —— 增量写入后 position 单调稳定，可作后续 patch 定位键。
// opts.silent=true 时不推送前端；任一非 hidden 消息落库才会 sseNotify（与特殊事件 hidden 语义一致）。
function appendMessages(sessionId, msgs, opts) {
  opts = opts || {};
  const list = (Array.isArray(msgs) ? msgs : [msgs]).filter(Boolean);
  if (!list.length) return [];
  const timeline = loadTimeline(sessionId);
  let maxPos = 0;
  for (const m of timeline) {
    if (m && m.position && m.position > maxPos) maxPos = m.position;
  }
  const out = list.map(function (m, i) {
    const nm = { time: new Date().toISOString(), ...m, position: maxPos + 0.5 + i, id: m.id || crypto.randomUUID() };
    timeline.push(nm);
    return nm;
  });
  saveTimeline(timeline, sessionId);
  unarchiveSession(sessionId);   // 新消息落库 → 自动取消归档
  if (!opts.silent && out.some(m => !m.hidden)) sseNotify(sessionId);
  return out;
}

function appendMessage(sessionId, msg, opts) {
  return appendMessages(sessionId, [msg], opts)[0] || null;
}

// 按稳定 id 定点修改一条消息（编辑同步）——只改这一条，保留其余消息 position，不重排。
// patch 只覆盖传入的键（前端 diff 只发 {op:'edit', id, newContent} 类，不传 position/id）。
function patchMessage(sessionId, id, patch) {
  if (!id) return null;
  const timeline = loadTimeline(sessionId);
  const idx = timeline.findIndex(m => m && m.id === id);
  if (idx < 0) return null;
  timeline[idx] = { ...timeline[idx], ...patch, id };
  saveTimeline(timeline, sessionId);
  sseNotify(sessionId);
  return timeline[idx];
}

// 剥掉日记正文开头的「## 时间」头行（时间线 [DIARY] 消息从不带该头，见 lib/diary.js 落库格式）
function diaryBodyOnly(content) {
  return String(content || "").replace(/^##[^\n]*\n+/, "").trim();
}

// 日记 ↔ 时间线同步（2026-10-19，替代恒返回 0 的 syncDiarySpecialEvents）：按 diary_id 外键
// 定点更新时间线里的 kind=diary 消息正文。页面编辑/恢复日记后调用，保证「聊天上下文」面
// 与「谢的日记页面」面一致（跨窗口注入面直接读 diary.json，天然同步；隐藏按拍板不动时间线）。
// 时间线消息不存在（存量未回填/旧消息无外键）时返回 missing:true，由调用方决定是否提示。
function syncDiaryTimelineMessages(sessionId, diaryId, newWrappedContent) {
  if (diaryId == null) return { patched: 0, missing: true };
  try {
    const sid = sessionId || "default";
    const timeline = loadTimeline(sid);
    let patched = 0;
    const next = timeline.map(function (m) {
      if (m && m.kind === "diary" && m.diary_id === diaryId) {
        patched++;
        return Object.assign({}, m, { content: newWrappedContent });
      }
      return m;
    });
    if (!patched) return { patched: 0, missing: true };
    saveTimeline(next, sid);
    sseNotify(sid);
    console.log("[diary] 已按 diary_id=" + diaryId + " 同步时间线 " + patched + " 条消息");
    return { patched: patched, missing: false };
  } catch (e) {
    console.warn("[diary] 时间线同步失败 (diary_id=" + diaryId + "):", e.message);
    return { patched: 0, missing: true, error: e.message };
  }
}

// 工具调用记录消息判定（服务器写入格式：assistant + 「【工具调用记录】」开头）
function isToolNoteMessage(m) {
  return !!m && m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("【工具调用记录】");
}

// 盘尾最后一条真实回复是否与新回复同内容（重试/断线重发防重：命中则跳过追加，不重复写）
function tailHasReply(sessionId, content) {
  const timeline = loadTimeline(sessionId);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const m = timeline[i];
    if (!m || m.role === "system") continue;
    if (isToolNoteMessage(m)) continue;
    if (isSpecialEvent(m)) continue;
    return m.role === "assistant" && normalizeContentToText(m.content) === normalizeContentToText(content);
  }
  return false;
}

// 剥离前端为「给上游模型看」而拼进 content 的工具记录段（buildMessages 加的「【本回复前调用工具记录】…」）。
// 只应存在于转发给上游时，绝不落进时间线（否则刷新后会当正文显示、工具胶囊丢失）。
function stripFrontendToolNote(content) {
  if (typeof content !== "string") return content;
  const idx = content.indexOf("\n\n【本回复前调用工具记录】");
  if (idx < 0) return content;
  return content.slice(0, idx);
}

// 以盘上为基同步「请求消息」：人设同步 + 去重补齐 + 尾部对齐，替代拿请求全量重建覆盖。
// 用于发消息首保存 / MCP 写回：盘上永远是完整历史，请求里缺的补、多的（重生成换掉的旧回复）按覆盖语义清尾。
function appendRequestMessages(sessionId, reqMsgs, opts) {
  opts = opts || {};
  const existing = loadTimeline(sessionId);
  const reqList = Array.isArray(reqMsgs) ? reqMsgs : [];
  const keyOf = function (m) { return m.role + "\u0000" + normalizeContentToText(m.content); };
  const reqReal = reqList.filter(function (m) {
    return m && !m.tool_calls && !m.tool_call_id && !isSpecialEvent(m) && (m.role === "user" || m.role === "assistant");
  }).map(function (m) {
    // 落盘前剥离前端拼段，避免污染时间线（content 保持干净，刷新靠 tools 富字段渲染胶囊）
    const c = stripFrontendToolNote(m.content);
    return c === m.content ? m : { ...m, content: c };
  });
  const reqKeys = new Set(reqReal.map(keyOf));
  const reqLastReal = reqReal.length ? reqReal[reqReal.length - 1] : null;
  let changed = false;

  // 0) 重生成锚点截断（2026-09-23 新增）
  //    语义：移除锚点 user 消息**之后的全部时间线内容**（含特殊事件，用户拍板），保留锚点本身。
  //    为什么必须新增：下方第 2 步的「尾部对齐」按内容键匹配且**遇到 user 就停**
  //    （原设计是为防止局部窗口请求误删历史——请求只带尾部 UPLOAD_WINDOW 条时，
  //     前面消息都不在 reqKeys 里，一路清到底会误删）。副作用是**从中间重生成清不干净**：
  //    盘上会残留被移除的旧回复及其后的 user 消息，刷新/SSE 补拉时它们会「复活」并插到新回复之后。
  //    改为由前端显式上报锚点 id、服务端按 id 硬截断：边界明确、与上传窗口无关、不会误删历史。
  //    防御：锚点须存在、须是 user（只删「该 user 之后的回复」）、且不能在盘尾（无内容可删则跳过）。
  //    不传该参数时行为与改动前**完全一致**（旧客户端/第三方客户端不受影响）。
  const _anchorId = String(opts.regenAnchorId || "").trim();
  if (_anchorId) {
    const _ai = existing.findIndex(function (m) { return m && m.id === _anchorId; });
    if (_ai >= 0 && _ai < existing.length - 1 && existing[_ai].role === "user") {
      const _removed = existing.length - (_ai + 1);
      existing.splice(_ai + 1);
      changed = true;
      console.log("[regen] 按锚点 id 截断时间线: session=" + (sessionId || "default") +
        " anchor=" + _anchorId.slice(0, 8) + " 移除=" + _removed);
    } else if (_ai >= 0) {
      console.warn("[regen] 锚点不合法，忽略截断（回退原尾部对齐）: idx=" + _ai +
        " role=" + (existing[_ai] && existing[_ai].role) + " len=" + existing.length);
    } else {
      console.warn("[regen] 锚点 id 未在盘上找到，忽略截断: " + _anchorId.slice(0, 8));
    }
  }

  // 1) 人设同步（2026-09-24 B 方案）：以服务端权威 system 为准写盘上，忽略请求里带的 system。
  //    旧逻辑拿前端拼的 system 覆盖盘上，前端异步加载/换设备/备份缺失时会把会话专属人设冲成全局。
  //    现在权威来源是 session-prompts.json -> prompt-backups.json -> chat-settings.json，前端带什么都不再改盘上。
  const authoritativeSP = (typeof resolveSessionSystemPrompt === "function")
    ? (resolveSessionSystemPrompt(sessionId) || "") : "";
  if (authoritativeSP.trim()) {
    const diskSP = existing.find(function (m) { return m && m.role === "system"; });
    if (!diskSP) {
      existing.unshift({ role: "system", content: authoritativeSP, position: 0 });
      changed = true;
    } else if (normalizeContentToText(diskSP.content) !== authoritativeSP) {
      diskSP.content = authoritativeSP;
      changed = true;
    }
  }

  // 2) 尾部对齐（重生成覆盖语义）：仅当请求最后一条真实消息是 user（用户在等一条新回复）才做；
  //    连播/后台续写（请求尾是 assistant）不对齐，历史原样保留。
  //    从盘尾往前收集「不在请求键集的 assistant 真实回复」（【工具调用记录】视为附属一并入段），
  //    遇到请求内消息 / user / 特殊事件即停。收集到的整段只有在其前一条锚点消息属于请求键集
  //    （= 重生成：user 消息双方都在，仅回复被换掉）时才清除；锚点也不在请求集
  //    （= 跨设备/局部请求滞后，别端刚写的回复）则原样保留，绝不误删。
  let cut = existing.length;
  if (reqLastReal && reqLastReal.role === "user") {
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i];
      if (!m || m.role === "system") continue;
      if (isToolNoteMessage(m)) continue;
      if (m.role === "assistant" && !isSpecialEvent(m) && !reqKeys.has(keyOf(m))) { cut = i; continue; }
      break;
    }
    if (cut < existing.length) {
      let anchor = -1;
      for (let i = cut - 1; i >= 0; i--) {
        const m = existing[i];
        if (!m || m.role === "system" || isToolNoteMessage(m) || isSpecialEvent(m)) continue;
        anchor = i;
        break;
      }
      const anchorInReq = anchor >= 0 && reqKeys.has(keyOf(existing[anchor]));
      if (!anchorInReq) cut = existing.length;
    }
  }
  let removedTail = 0;
  if (cut < existing.length) {
    removedTail = existing.length - cut;
    existing.splice(cut);
    changed = true;
  }

  // 3) 去重补齐：请求里盘上还缺的真实消息按序追加（user 与 assistant 都补，防旧缓存设备回补丢消息）。
  //    按 id 防重优先：有 id 的消息只按 id 判存在（真正重复消息跳过；连发同句两条不同 id 都保留，
  //    不再被 role+content 键并掉）；无 id 的请求消息（前端未赋 id）回退 role+content 键防重（保留旧行为）。
  const diskById = new Set(existing.filter(function (m) { return m && m.id; }).map(function (m) { return m.id; }));
  const diskKeys = new Set(existing.filter(function (m) { return m && m.content != null; }).map(keyOf));
  const appended = [];
  for (const m of reqReal) {
    if (m.id && diskById.has(m.id)) continue;
    const k = keyOf(m);
    if (!m.id && diskKeys.has(k)) continue;
    if (m.id) diskById.add(m.id);
    diskKeys.add(k);
    appended.push(m);
  }
  if (appended.length) {
    let maxPos = 0;
    for (const m of existing) {
      if (m && m.position && m.position > maxPos) maxPos = m.position;
    }
    for (let i = 0; i < appended.length; i++) {
      existing.push({ time: new Date().toISOString(), ...appended[i], position: maxPos + 0.5 + i });
    }
    changed = true;
  }

  if (changed) {
    saveTimeline(existing, sessionId);
    unarchiveSession(sessionId);   // 新消息落库 → 自动取消归档
    sseNotify(sessionId);
  }
  return { appended: appended.length, removedTail: removedTail, changed: changed };
}

// ========================
// 追加特殊事件
// ========================
function appendSpecialEvent(content, extra, sessionId) {
  let newEvent;
  // 按事件内容自带的墙上时间戳插位（唤醒/日记/推送回显/共影首段时间），
  // 而不是一律追加到末尾——否则事件落库晚于其后消息时会被排到错误时间位置。
  // 容量提醒（（容量提醒）…）不带开段时间戳，解析失败回退原 appendMessage 行为。
  const evTime = extractTimestamp(content) || extractCoRecordEventTime({ content });
  if (evTime && !isNaN(evTime.getTime())) {
    const evMs = evTime.getTime();
    const timeline = loadTimeline(sessionId);
    let insertAt = timeline.length;
    for (let i = 0; i < timeline.length; i++) {
      const m = timeline[i];
      if (!m) continue;
      const mt = extractTimestampWithMemory(m) || extractCoRecordEventTime(m);
      if (mt && !isNaN(mt.getTime()) && mt.getTime() >= evMs) { insertAt = i; break; }
    }
    const prev = insertAt > 0 ? timeline[insertAt - 1] : null;
    const next = insertAt < timeline.length ? timeline[insertAt] : null;
    let pos;
    if (prev && next) pos = (Number(prev.position || 0) + Number(next.position || 0)) / 2;
    else if (prev) pos = Number(prev.position || 0) + 0.5;
    else if (next) pos = Math.max(0, Number(next.position || 0) - 0.5);
    else pos = 1;
    const msg = { time: evTime.toISOString(), role: "assistant", content, ...(extra || {}), position: pos, id: crypto.randomUUID ? crypto.randomUUID() : (String(Date.now()) + '-' + Math.random().toString(36).slice(2)) };
    timeline.splice(insertAt, 0, msg);
    saveTimeline(timeline, sessionId);
    newEvent = msg;
  } else {
    newEvent = appendMessage(sessionId, { role: "assistant", content, ...(extra || {}) });
  }
  // 插位分支已手动触发保存，此处需按 hidden 决定是否推前端刷新；
  // appendMessage 分支已在其内部处理过 sseNotify，不再重复。
  if (evTime && !(newEvent && newEvent.hidden)) sseNotify(sessionId);
  // 特殊事件（唤醒/日记/共影/推送）落库后只保留长度日志（可能含推送正文，避免泄漏）。
  console.log(`\n已记录特殊事件 (session ${sessionId || "default"}, position ${newEvent.position}, chars ${normalizeContentToText(content).length})\n`);
}


// 剥离内部标签（用于把客户端清洗版和时间线原始版互相匹配）
// 剥离模型抄进正文的「工具回声」块【工具 · NAME】{.../[...]/(...)}：
// 权威工具结果由 toolHistory(tools 字段) 与「【工具调用记录】」承担，模型重复抄写会造成冗余/刷屏，故服务端删除。
// 与前端 extractToolEchoBlocks 同判据（标签后紧跟 { [ （ 才当作工具结果块）。
function stripToolEchoBlocks(content) {
  const s = String(content || "");
  if (s.indexOf("【工具") < 0) return s;
  const re = /【工具\s*[·．.]?\s*[^】\n]+】/g;
  let rebuilt = "", last = 0, m, found = false;
  while ((m = re.exec(s)) !== null) {
    const after = s.slice(re.lastIndex);
    if (!/^\s*\n?\s*[{\[（]/.test(after)) continue;
    const restAfter = s.slice(re.lastIndex);
    const nextTool = restAfter.search(/【工具\s*[·．.]?\s*[^】\n]+】/);
    const sep = restAfter.search(/\n\s*---\s*\n/);
    let end = restAfter.length;
    if (nextTool >= 0) end = Math.min(end, nextTool);
    if (sep >= 0) end = Math.min(end, sep);
    rebuilt += s.slice(last, m.index);   // 去掉该工具回声块
    last = re.lastIndex + end;
    re.lastIndex = last;
    found = true;
  }
  if (!found) return s;
  rebuilt += s.slice(last);
  return rebuilt.replace(/\n{3,}/g, "\n\n");
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
  // 只保留消息正文，剥离内部排序与时间字段（position/time 等内部字段不外泄给上游/前端）
  return messages.map(({ position, time, ...rest }) => rest);
}

let wakeUpLastHeartbeat = null;
let lastLLMMessages = null;
let lastLLMCaptureTime = null;
// 供拆到 routes/chat.js 的 /v1/chat/completions 回写「当前请求上下文」捕获，
// 保持与 server.js 内的 lastLLMMessages/lastLLMCaptureTime 同一引用(管理台 /admin/logs/context 读取)。
function setLastLLMCapture(messages, time) {
  lastLLMMessages = messages;
  lastLLMCaptureTime = time;
}

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
  "DIARY_ENABLED",
  "DIARY_DIR",
  "REQUEST_BODY_LIMIT_MB",
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

// 用 Cookie 调网易云官方接口查账号资料（昵称/userId/VIP 等级），登录状态校验用
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

// 请求是否期望 JSON 响应（Content-Type 或 Accept 含 application/json）
function wantsJsonResponse(req) {
  const contentType = req.headers["content-type"] || "";
  const accept = req.headers.accept || "";
  return contentType.includes("application/json") || accept.includes("application/json");
}

// 解析 .env 文件为键值对象（忽略空行与 # 注释行）
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

// 启动时把 .env 读进内存一次，readEnvValue 之后只读缓存，避免每次调用都读盘。
// 任何写路径（/admin/save、改密码等）都会经过 writeEnvUpdates，写完后刷新该缓存。
let cachedEnv = loadEnvFileObject();

function serializeEnvValue(value) {
  const raw = String(value ?? "");
  // 2026-09-22 审查 M4：原实现只把换行转成 \n——含 `#` 的值写入 .env 后会被 dotenv 当**行内注释截断**
  // （如口令 p@ss#word 读回只剩 p@ss），首尾空白也会被 trim 掉。
  // 实测 dotenv 17.4.2 规则：解析时**只还原 `\n`/`\r`，不还原 `\"` 与 `\\`**——所以「转义引号」无效，
  // 唯一安全做法是加引号包裹。包裹策略：
  //   ① 值不含单引号 → 用**单引号**包裹（dotenv 对单引号值不做任何还原，值可原样保留，含双引号也安全）；
  //   ② 否则值不含双引号 → 用双引号包裹；
  //   ③ 两者都含（或含换行）→ 无法安全包裹，按原样写入并告警。
  // 其余情况保持原路径，行为与改动前逐字一致（含换行的值仍写为字面 \n，不改其语义）。
  const needQuote = raw.indexOf("#") !== -1 || /^\s|\s$/.test(raw);
  if (needQuote) {
    const hasNl = raw.indexOf("\n") !== -1 || raw.indexOf("\r") !== -1;
    if (!hasNl) {
      if (raw.indexOf("'") === -1) return "'" + raw + "'";
      if (raw.indexOf('"') === -1) return '"' + raw + '"';
    }
    console.warn("[env] 配置值含 # / 首尾空白，且同时含引号或换行，无法安全加引号包裹，按原样写入（回读可能被截断）");
  }
  return raw.replace(/\r?\n/g, "\\n");
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
    // 2026-09-22 审查 M3：原子写经临时文件 rename，权限随 umask（实测线上 .env 为 0644，
    // 任何本地用户可读全部密钥）。.env 强制 0600。
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) { console.warn("[env] chmod 0600 失败:", e.message); }
    cachedEnv = { ...merged };
    // 2026-09-21 审查 H8：同步 process.env，否则 isAuthorized/validSessionToken 仍读旧值，
    // 管理台改完口令出现「新口令登不进、旧口令照样能进」直到 pm2 restart
    for (const key of Object.keys(updates)) {
      const v = updates[key];
      if (v === undefined || v === null) delete process.env[key];
      else process.env[key] = String(v);
    }
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
  // 内部接口：若配置了 INTERNAL_API_KEY 则必须携带
  const isInternalPath = req.url.startsWith("/internal/");
  if (isInternalPath) {
    const internalKey = readEnvValue("INTERNAL_API_KEY");
    // 2026-09-21 审查 H6：fail-closed——未配置 INTERNAL_API_KEY 时直接拒绝（原为放行落到网络判断）
    if (!internalKey) {
      reply.code(403).send({ error: "INTERNAL_API_KEY 未配置，内部接口已封锁" });
      return;
    }
    const supplied = String(req.headers["x-internal-key"] || "").trim();
    if (supplied !== internalKey) {
      reply.code(401).send({ error: "Invalid internal key" });
      return;
    }
    return done();
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
    // 批注 2026-08-29：多浏览器/跨设备同步。聊天页登录后夹带 admin_session cookie，
    // 登录本身就用管理员账号密码校验（与 GATEWAY key 同等级或更强），
    // 所以允许"已登录会话"访问 /v1/*（读历史 + 发消息），
    // 避免每个浏览器都要在 localStorage 里单独存一份 GATEWAY key。
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.admin_session && validSessionToken(cookies.admin_session)) return done();
    } catch (e) {}
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
    // 2026-09-21 审查 H6：只信 X-Real-IP，弃用 X-Forwarded-For 末段兜底——
    // 链路上多一跳未改写 XFF 的代理时，攻击者自造 XFF 首段即可伪造可信 IP。
    // 线上 nginx 反代到 3000 的全部 location 均已设 X-Real-IP（2026-09-21 核实）。
    const realIp = String(req.headers["x-real-ip"] || "").trim();
    if (realIp) {
      ip = String(realIp).replace(/^::ffff:/i, "");
    }
  }
  const isTrustedNetwork = ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  if (isTrustedNetwork) return done();
  reply.code(403).send("Forbidden");
});

// ========================
// Models
// ========================
require("./routes/chat")(app, {
  baseDir: __dirname,
  configuredModelName,
  loadTimeline,
  isRealMessageForTimeline,
  timelineFileFor,
  normalizeMessageForTimeline,
  buildTimeline,
  saveTimeline,
  appendMessage,
  appendMessages,
  appendRequestMessages,
  readSessionArchive,
  tailHasReply,
  markSessionDeleted,
  sseSubscribe,
  sseUnsubscribe,
  sseNotify,
  SSE_HEARTBEAT_MS,
  recentReplies,
  activeGenMap,
  ACTIVE_GEN_TTL_MS,
  isRecentReplyCacheable,
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_PENDING_WAIT_MS,
  IDEMPOTENCY_PENDING_TOTAL_MS,
  setRecentReply,
  beginPendingReply,
  waitPendingReply,
  clearPendingReply,
  sessionCrossInjectOverride,
  saveSessionCrossInjectOverride,
  prepareMessageForLLM,
  normalizeContentToText,
  isSpecialEvent,
  extractTimestampWithMemory,
  stripPosition,
  resolveChatModel,
  resolveSessionSystemPrompt,
  sessionModelProviderOverride,
  saveSessionModelProviderOverride,
  sessionModelNameOverride,
  saveSessionModelNameOverride,
  readEnvValue,
  UPSTREAM_TIMEOUT_MS,
  handleMcpRequest,
  splitMultimodalContent,
  extractAssistantThinking,
  parseWakeTagAndSchedule,
  createContentTagFilter,
  appendSpecialEvent,
  MCP_ENABLED,
  summarizeMessagesForLog,
  setLastLLMCapture
});

// ========================
// 统一唤醒调用器（2026-09-15 唤醒并入网关）：进程内直调 wakeChatModule.runWakeCompletion
// 与对话侧同一套上下文加工（chat-context.js）；唤醒特有行为仍在调用方。
// （原 POST /internal/wake-completions HTTP 端点零消费者，2026-09-21 审查清理删除）
// ========================
const wakeChatModule = require("./routes/wake-chat");

// diary_add 工具写日记 → 时间线落库（2026-09-29 起，2026-10-03 提为具名函数）。
// 日记正文只在工具参数 args.content 里，工具端回执不返正文，服务端必须自己补一条 kind=diary
// 隐藏消息，否则 AI 重建上下文时看不到自己写过什么（isRealDiary 让它永不压缩）。
// 对话侧两条工具循环（streamToolLoop 主路径 + runWithTools 兜底）与唤醒侧工具循环共用这一个实现。
// 注：diaryLib 在下方 .env 读取区之后才初始化（const 有 TDZ），本函数只在请求期被调用，运行期安全。
function onDiaryToolWritten(sid, dContent, diaryId) {
  try {
    const msg = { role: "assistant", content: diaryLib.wrapDiaryTag(dContent), kind: "diary", time: new Date().toISOString() };
    if (diaryId != null) msg.diary_id = diaryId;   // 2026-10-19：外键，页面编辑/恢复按它定点同步
    appendMessages(sid, [msg], { silent: true });
    console.log("[diary] diary_add 已落库时间线 (session=" + sid + ", chars=" + dContent.length + ", diary_id=" + diaryId + ")");
  } catch (e) { console.warn("[diary] diary_add 落库时间线失败:", e.message); }
}

const wakeChatDeps = {
  baseDir: __dirname,
  loadTimeline,
  saveTimeline,
  appendMessages,
  appendSpecialEvent,
  isSpecialEvent,
  normalizeContentToText,
  stripPosition,
  resolveChatModel,
  resolveSessionSystemPrompt,
  readEnvValue,
  UPSTREAM_TIMEOUT_MS,
  setLastLLMCapture,
  splitMultimodalContent,
  prepareMessageForLLM,
  extractTimestampWithMemory,   // 2026-09-22 审查 §3.5：唤醒侧时间反查与对话侧统一口径（原只认 tm.time）
  onDiaryWritten: onDiaryToolWritten,   // 2026-10-03：唤醒侧 streamToolLoop 与对话侧同一实现，不再漏 diary_add 日记
  incrementalContext: contextReplacements.buildIncrementalContext,   // 0929 增量：块摘要化+尾部现算
  fullCache: true   // 0929 唤醒/重试：整体缓存直接命中（聊天侧 fullCache=false 只走增量）
};
wakeChatModule(app, wakeChatDeps);

// ========================
// 唤醒调度器（2026-09-15 批3收尾）：wake-up 独立进程退役，调度内核并入 gateway，
// 进程内直调 runWakeCompletion / applyWakeEventV2 / sendPushNotification（无 HTTP 自环）。
// 仅构建闭包；定时器与检查循环在下方 listen 回调里 start()。
// ========================
const wakeScheduler = require("./lib/wake-scheduler")({
  baseDir: __dirname,
  readEnvValue,
  normalizeContentToText,
  touchHeartbeat() { wakeUpLastHeartbeat = Date.now(); },
  sendPushNotification,
  applyWakeEventV2,
  runWakeCompletion: wakeChatModule.runWakeCompletion,
  wakeDeps: wakeChatDeps
});

// ========================
// Chat Completions
// ========================
// 会话级配置（模型供应商 / 模型名 / 跨窗口注入开关）读写：
// 实现已搬到 lib/session-cfg.js——跨窗口开关 1003-19 起真正生效，context-v2-runtime.js 也要读同一份。
// 2026-10-03：V1「跨窗口自动注入」整条链路（跨窗口记忆快照 data/cross_snapshot_<sid>.json +
// 相关记忆/近期日记文本计算）随 ctx_v2 全面启用一并删除，此处不再有注入实现。
// 现存注入只有 V2 的 conversation_continuity（Earlier Days）块，见 context-v2-runtime.js。
// 历史沿革：标星「记忆碎片」注入 2026-09-05 移除；跨窗口快照 2026-08-30 引入、09-28 拆除。
// ========================
const SESSION_CFG_DIR = sessionCfg.SESSION_CFG_DIR;   // 2026-10-03 随会话级配置读写一起搬到 lib/session-cfg.js
// 会话级模型供应商覆盖：返回该会话指定的供应商 id，null=跟随全局。
function sessionModelProviderOverride(sessionId) {
  const token = safeSessionToken(sessionId || "default");
  const file = path.join(SESSION_CFG_DIR, token + ".json");
  try {
    if (fs.existsSync(file)) {
      const o = fs.readJsonSync(file);
      if (o && typeof o.model_provider_id === "string" && o.model_provider_id) return o.model_provider_id;
    }
  } catch (e) { console.warn("[session-cfg] 读取模型供应商覆盖失败:", e.message); }
  return null;
}
function saveSessionModelProviderOverride(sessionId, providerId) {
  const token = safeSessionToken(sessionId || "default");
  const file = path.join(SESSION_CFG_DIR, token + ".json");
  let o = {};
  try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
  if (providerId === null || providerId === undefined || providerId === "") delete o.model_provider_id;
  else o.model_provider_id = String(providerId);
  fs.ensureDirSync(SESSION_CFG_DIR);
  fs.writeJsonSync(file, o);
  return o;
}
function sessionModelNameOverride(sessionId) {
  const token = safeSessionToken(sessionId || "default");
  const file = path.join(SESSION_CFG_DIR, token + ".json");
  try {
    if (fs.existsSync(file)) {
      const o = fs.readJsonSync(file);
      if (o && typeof o.model_name === "string" && o.model_name) return o.model_name;
    }
  } catch (e) { /* ignore */ }
  return null;
}
function saveSessionModelNameOverride(sessionId, modelName) {
  const token = safeSessionToken(sessionId || "default");
  const file = path.join(SESSION_CFG_DIR, token + ".json");
  let o = {};
  try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
  if (modelName === null || modelName === undefined || modelName === "") delete o.model_name;
  else o.model_name = String(modelName);
  fs.ensureDirSync(SESSION_CFG_DIR);
  fs.writeJsonSync(file, o);
  return o;
}
// ========================
// 跨窗口注入参数（2026-09-28：V1 memory_pool_config.json 归档后独立存储 data/cross_inject_config.json；
// V2 Earlier Days 篇数（context-v2-shadow）与回退路径/预览同源，管理台配置页可调）
// ========================
const CROSS_INJECT_CONFIG_FILE = path.join(__dirname, "data", "cross_inject_config.json");
function readCrossInjectConfig() {
  const base = { cross_inject_enabled: true, cross_inject_memory: true, cross_inject_diary: true, cross_inject_diary_count: 3 };
  try {
    const o = fs.readJsonSync(CROSS_INJECT_CONFIG_FILE) || {};
    if (o.cross_inject_diary_count != null) base.cross_inject_diary_count = Math.max(1, Number(o.cross_inject_diary_count) || 3);
    return base;
  } catch (e) { return base; }
}
function saveCrossInjectConfig(patch) {
  const cur = readCrossInjectConfig();
  if (patch && patch.cross_inject_diary_count != null) cur.cross_inject_diary_count = Math.max(1, Number(patch.cross_inject_diary_count) || 3);
  fs.ensureDirSync(path.dirname(CROSS_INJECT_CONFIG_FILE));
  writeJsonFileAtomic(CROSS_INJECT_CONFIG_FILE, { cross_inject_diary_count: cur.cross_inject_diary_count });
  return cur;
}
// === MCP_TOOL_LOOP_BEGIN ===
// MCP 工具循环入口：如果启用，则用 mcp-tool-loop 处理；返回 true 表示已处理并写完响应。
// messages 为已处理好的 sanitizedMessages（含记忆/时间线/替换/裁剪）
async function handleMcpRequest(body, reply, req, messages, sessionId, kelivoMessages) {
  if (!MCP_ENABLED()) return false;
  const clients = getMcpClients();
  if (!clients || clients.length === 0) return false;
  // 统一模型解析（2026-09-08）：与直通路径同口径，会话级设置 → 全局默认 → env 兜底
  const { provider: prov, model } = resolveChatModel(sessionId, body.model);
  const targetApiUrl = (prov && (prov.api_url || prov.base_url)) || readEnvValue("TARGET_API_URL");
  const targetApiKey = (prov && prov.api_key) || readEnvValue("TARGET_API_KEY");
  if (!targetApiUrl || !targetApiKey) return false;

  // 方案2：工具循环逐轮即时回传。onEvent 把「本轮正文/思考 + 每工具 start/end」实时写成 SSE，
  // 前端据此渲染工具卡与正文交错 + running→done 状态。仅流式请求启用；落盘/缓存仍用 r.toolHistory（终态）。
  let streamStarted = false;
  const streamDelta = (deltaObj) => {
    if (!streamStarted) {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      try { reply.raw.flushHeaders(); } catch (e) {}
      streamStarted = true;
    }
    // 1004-04（覆盖原 R7）：客户端断开后不再中断生成循环——改为静默丢弃 SSE 事件，让模型跑完并
    // 照常落盘。原实现抛 client gone → 工具循环中止 → assistant 回复半途丢弃不落盘，用户切后台/关页面
    // 回来刷新就看不到回复。代价是真关页面也会跑完这一轮（用户已确认接受 A 方案）。
    if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.writableFinished) {
      return;
    }
    try { reply.raw.write("data: " + JSON.stringify({
      id: "chatcmpl-mcp",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: deltaObj, finish_reason: null }]
    }) + "\n\n"); } catch (e) { /* socket 半死写失败：静默丢弃，不中断生成 */ }
  };
  const onEvent = (evt) => {
    if (!evt) return;
    // 1004-05：实时累积快照（断流续显用）——lazy init，按 sessionId 一份
    let _ag = activeGenMap.get(sessionId);
    if (!_ag || _ag.done) { _ag = { text: "", reasoning: "", tools: [], ts: Date.now(), done: false }; activeGenMap.set(sessionId, _ag); }
    try {
      if (evt.type === "text") {
        // 逐段正文先剥标签/工具回声再下发，保证用户看不到 <memory> 等标签与模型自抄的工具结果；
        // 存记忆副作用仍由收尾对完整文本做一次（extractAndStore）。
        const clean = stripToolEchoBlocks(tagParser.stripTags(evt.text));
        _ag.text += clean;
        for (let i = 0; i < clean.length; i += 24) streamDelta({ content: clean.slice(i, i + 24) });
      } else if (evt.type === "reasoning") {
        const clean = tagParser.stripTags(evt.text);
        _ag.reasoning += clean;
        for (let i = 0; i < clean.length; i += 60) streamDelta({ reasoning_content: clean.slice(i, i + 60) });
      } else if (evt.type === "tool_start") {
        const p = { index: evt.index, id: evt.id, name: evt.name, args: evt.args };
        _ag.tools.push({ id: evt.id, name: evt.name, args: evt.args, status: "running" });
        streamDelta({ tool_start: p });
      } else if (evt.type === "tool_args_delta") {
        streamDelta({ tool_args_delta: { index: evt.index, id: evt.id, delta: evt.delta || "" } });
      } else if (evt.type === "tool_end") {
        const p = { index: evt.index, id: evt.id, name: evt.name, args: evt.args, result: evt.result, error: evt.error, ok: evt.ok };
        const _ti = _ag.tools.findIndex(function (t) { return t.id === evt.id; });
        if (_ti >= 0) { _ag.tools[_ti].status = evt.error ? "error" : "ok"; _ag.tools[_ti].result = evt.result; }
        streamDelta({ tool_end: p });
      }
    } catch (e) {
      // streamDelta 把客户端断开作为异常抛出；必须继续上抛给 streamToolLoop.emit，
      // 由其将 clientGone 置位并停止后续工具/上游请求。
      throw e;
    }
  };

  let r;
    // 2026-09-09 工具路径改流式：优先走 streamToolLoop（全程 stream:true，正文/思考链实时回传，
    // 工具就地执行并继续流式），避免「检测到工具就整轮非流式等待」导致的慢。失败则回退 runWithTools（非流式兜底）。
    try {
      r = await mcp.streamToolLoop({
        upstreamUrl: targetApiUrl,
        upstreamKey: targetApiKey,
        model,
        messages: messages || body.messages || [],
        serverClients: clients,
        temperature: body.temperature,
        top_p: body.top_p,
        max_tokens: body.max_tokens,
        onEvent: (body.stream === true) ? onEvent : null,
        sessionId,
        onDiaryWritten: onDiaryToolWritten
      });
    } catch (toolLoopErr) {
      // 一旦已经向客户端发出 SSE，就不能再从头跑一遍 runWithTools：
      // 否则客户端会收到两套事件，正文/工具卡可能重复或顺序损坏。
      if (streamStarted) throw toolLoopErr;
      console.warn("[mcp] 流式工具循环失败，回退 runWithTools (非流式):", toolLoopErr.message);
      r = await mcp.runWithTools({
        upstreamUrl: targetApiUrl,
        upstreamKey: targetApiKey,
        model,
        messages: messages || body.messages || [],
        serverClients: clients,
        onEvent: (body.stream === true) ? onEvent : null,
        sessionId,
        onDiaryWritten: onDiaryToolWritten
      });
    }

  // 1004-05 兜底：不管本轮有没有正文，生成结束就把快照标 done（空回复/异常也别让前端一直轮询）。
  // 有正文时上面落盘块会用最终 r.text 覆盖；这里先按已累积的 text 收尾。
  const _agFinal = activeGenMap.get(sessionId);
  if (_agFinal && !_agFinal.done) { _agFinal.done = true; _agFinal.ts = Date.now(); }
  // 工具循环跑完后，把「完整消息序列」捕获进 lastLLMMessages，
  // 让「当前请求上下文」如实展示带 tool_calls / tool 结果的真实链路（而非基础上下文）。
  try {
    const finalMsgs = r && r.finalMessages;
    if (Array.isArray(finalMsgs) && finalMsgs.length) {
      setLastLLMCapture(finalMsgs.map(m => {
        const cap = splitMultimodalContent(m.content);
        return {
          role: m.role,
          content: cap.content,
          images: cap.images && cap.images.length ? cap.images : undefined,
          attachments: cap.attachments || undefined,
          tool_calls: m.tool_calls || undefined,
          tool_call_id: m.tool_call_id || undefined
        };
      }), new Date().toISOString());
    }
  } catch (capErr) {
    console.warn("[mcp] 捕获最终上下文失败:", capErr.message);
  }

  // 提取 <memory>/<pin>/<wake>/<quiet> 标签：存记忆池并剥离，避免标签显示给用户
  let aiClean = (r && r.text) || "";
  if (aiClean) {
    // 对话侧 <wake>/<quiet> 调度必须用剥离前的原始文本解析；此前 MCP 分支只剥标签不落调度，
    // 对话内闹钟/免打扰静默失效（2026-09-11 修复），与非 MCP 路径（routes/chat.js）同口径。
    try {
      parseWakeTagAndSchedule(aiClean, sessionId);
    } catch (e) {
      console.warn("[mcp] 闹钟调度解析失败:", e.message);
    }
    try {
      const cleaned = await tagParser.extractAndStore(aiClean, { sessionId });
      if (typeof cleaned === "string" && cleaned) aiClean = cleaned;
    } catch (e) {
      console.warn("[mcp] 标签解析失败:", e.message);
    }
  }
  // 剥离工具回声（权威结果走 toolHistory，避免模型重复抄写/刷屏）
  aiClean = stripToolEchoBlocks(aiClean);

  // 2026-09-24 B3（M1 提级）：最终落盘版数据在函数级构造一次——时间线写回（下方 if 块内）
  // 与 SSE 终止帧（块外，try-catch 包裹）必须共用同一份。此前 storedText/timeline 映射都在
  // if 块内，终止帧直接引用会 ReferenceError 且被终止帧的 try-catch 静默吞掉
  // → 表现为"字段永远不下发、前端静默退回旧行为"，测试还可能假通过。
  // 1004-11：与落盘同口径——落盘 visibleStored 剥日记块，终止帧此前不剥 → 前端本地缓存
  // 含 [DIARY] 与时间线字节不一致（补拉每次校准）。这里统一剥掉。
  const _storedBase = stripToolEchoBlocks((r && r.text) ? r.text : (aiClean || ""));
  const _storedDiary = _storedBase ? diaryLib.extractDiaryFromResponse(_storedBase) : { diaryContent: "", remainingText: "" };
  const finalStoredText = _storedDiary.diaryContent ? _storedDiary.remainingText : _storedBase;
  const finalTimelinePayload = (r && Array.isArray(r.streamTimeline))
    ? r.streamTimeline.map(function (n) {
        if (!n || !n.type) return null;
        if (n.type === "text") return { type: "text", text: String(n.text || "") };
        if (n.type === "tool" && n.tool) return { type: "tool", tool: n.tool };
        return null;
      }).filter(Boolean)
    : undefined;   // runWithTools 回退无 streamTimeline → 不下发，前端退回自己的映射

  // 修复：MCP 分支此前拦截了主流程的"AI 回复写回时间线"，导致刷新后回复丢失。
  // 这里把最终回复也写回当前会话的时间线。
  if (r && r.text) {
    try {
      // 1004-05：标记快照完成，前端补拉拿到最终内容
      const _agDone = activeGenMap.get(sessionId);
      if (_agDone) { _agDone.text = r.text; _agDone.reasoning = r.reasoning || _agDone.reasoning; _agDone.done = true; _agDone.ts = Date.now(); }
      // 1004-06：服务端主动推送——iOS 后台会冻结前端 JS，前端 notify fetch 发不出去。
      // 落盘时检查该会话有无在线 SSE 订阅：无订阅=用户不在看这个会话（切后台/关页面）→ 直接发推送。
      try {
        const _subs = sseSubscribers.get(sessionId);
        if (!_subs || _subs.size === 0) {
          const _pushBody = String(r.text || "").replace(/<[^>]+>/g, "").replace(/[#*`>\n]/g, " ").trim().slice(0, 200);
          if (_pushBody) sendPushNotification({ title: "", body: _pushBody, sessionId }).catch(function () {});
        }
      } catch (e) {}
      // 方案二增量：以盘上为基同步请求差量（人设同步/去重补齐/重生成尾部对齐），
      // 不再拿请求消息数组全量重建覆盖——前端只带局部历史（分页/懒加载）也不会丢服务器完整历史。
      const reqMsgs = Array.isArray(kelivoMessages) && kelivoMessages.length
        ? kelivoMessages
        : (messages || body.messages || []);
      // 2026-09-23：透传重生成锚点 id（前端点「重新生成」时上报），服务端据此按 id 截断
      // 该 user 消息之后的全部时间线内容，替代原先「按内容尾部对齐」在中间重生成时清不干净的问题
      const syncRes = appendRequestMessages(sessionId, reqMsgs, { regenAnchorId: body.regen_anchor_id });
      // 稳定 id 沿用（2026-09-22）：自建前端预生成 reply_msg_id 随请求上行，落盘沿用同一 id——
      // 回复落库前后端 id 一致，落库后、SSE 补拉前的编辑/删除也能被 /v1/timeline/sync 的 diff 分支按 id 定点命中。
      // 冲突兜底：盘上已存在同 id 则弃用客户端 id（appendMessages 回退服务端 uuid），防时间线出现重复 id。
      let replyMsgId = (typeof body.reply_msg_id === "string" && body.reply_msg_id.trim())
        ? body.reply_msg_id.trim().slice(0, 64) : null;
      if (replyMsgId && loadTimeline(sessionId).some(function (m) { return m && m.id === replyMsgId; })) replyMsgId = null;
      // 工具结果已经由 assistant.tools 结构化保存，不再额外写入旧式「【工具调用记录】」assistant 消息。
      const toAppend = [];
      // 富字段一并落时间线：reasoning/tools/tokens，跨设备刷新不再丢（前端 /v1/history 读取这些字段）。
      // 盘尾已有同内容回复（重试/重复写回）则跳过，不重复追写。
      // 存储用原始文本但去工具回声：保留 <wake>/<memory> 等标签作为上下文一部分；下发/回放仍用 aiClean。
      // 2026-09-24 B3：storedText/timeline 映射提级为函数级 finalStoredText/finalTimelinePayload（与终止帧共用）
      const storedText = finalStoredText;
      // 1005 修复：此前 finalStoredText 已剥过一次 DIARY，这里又对剥过的文本再提取一次 → 永远为空。
      // 改为直接复用首次提取的 _storedDiary。
      const _diaryResult = _storedDiary;
      const visibleStored = storedText;
      if (!tailHasReply(sessionId, visibleStored)) {
        if (_diaryResult.diaryContent) {
          const _diarySaved = diaryLib.appendDiaryEntry(_diaryResult.diaryContent, sessionId);
          toAppend.push({ role: "assistant", content: diaryLib.wrapDiaryTag(_diaryResult.diaryContent), kind: "diary", diary_id: (_diarySaved && _diarySaved.id) || undefined });
        }
        toAppend.push({
          id: replyMsgId || undefined,
          // 1005 改：后端流水账落原始完整文本（r.text 含[DIARY]标签），不剥；下发前端时剥。
          role: "assistant", content: (r && r.text) ? r.text : aiClean, reasoning: r.reasoning || "", tools: r.toolHistory || [], tokens: r.usage || null,
          segments: (r.toolHistory && r.toolHistory.length) ? (r.segments || []).map(function(s){ return stripToolEchoBlocks(tagParser.stripTags(s)); }) : undefined,
          stream_timeline: finalTimelinePayload   // 真实事件时间线：刷新时按 text/tool 原顺序重建（与终止帧下发同一份）
        });
      }
      if (toAppend.length) appendMessages(sessionId, toAppend);
      console.log("[mcp] AI 回复已写回时间线 (session=" + (sessionId || "default") + ", chars=" + r.text.length + ", 补齐=" + syncRes.appended + ", 清尾=" + syncRes.removedTail + ", 追加=" + toAppend.length + ", rid=" + (replyMsgId ? replyMsgId.slice(0, 8) : "-") + ")");
    } catch (wr) {
      console.warn("[mcp] 写回时间线失败:", wr.message);
    }
  }

  // 缓存本次已生成的回复，供同 client_msg_id 的重复请求直接回放。
  if (aiClean && body && body.client_msg_id) {
    setRecentReply(String(body.client_msg_id).trim(), {
      text: aiClean, model, reasoning: r.reasoning || "", tools: r.toolHistory || [], usage: r.usage || null, ts: Date.now(),
      // 2026-09-24 B3（M2）：回放时 final 字段的数据源。text 保持 aiClean（剥标签版，回放下行
      // 正文与实时口径一致）；storedText（含标签，与时间线同源）单独存、专供 final_content——
      // 否则回放落盘=剥标签版 ≠ 时间线含标签版 → 补拉照样校准（回放是重试/断线重发的高频场景）。
      storedText: finalStoredText,
      streamTimeline: finalTimelinePayload || null
    });
  }

  // 把最终文本转成 OpenAI 兼容 SSE 流（工具轮次已结束，这里流式回传最终结果）
  if (body.stream === true) {
    if (streamStarted) {
      // 2026-09-13 审查修复：onEvent 逐轮流式回传后补终止 chunk——此前裸 end 无
      // finish_reason/usage/[DONE]，与 buildSSE 收尾口径不一致，依赖终止事件的客户端会卡住、usage 丢失
      try {
        reply.raw.write("data: " + JSON.stringify({
          id: "chatcmpl-mcp",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: (r && r.usage) || null,
          // 2026-09-24 B3：最终落盘版随流下发（与时间线写回共用 finalStoredText/finalTimelinePayload，
          // 见上方 M1 提级注释），自建前端据此落盘、与服务器时间线字节级一致。
          // 顶层字段第三方客户端忽略；空/undefined 时不下发，前端退回自己的映射（向后兼容）。
          ...(finalStoredText ? { final_content: finalStoredText } : {}),
          ...(finalTimelinePayload ? { final_stream_timeline: finalTimelinePayload } : {})
        }) + "\n\n");
        reply.raw.write("data: [DONE]\n\n");
      } catch {}
      try { reply.raw.end(); } catch {}
      return true;
    }   // 方案2：已用 onEvent 逐轮流式回传，避免 buildSSE 重复
    // 2026-09-24 B3：runWithTools 回退出口（未发过 SSE 才会走到）同样下发 final——与上方时间线
    // 写回共用同一份（runWithTools 无 streamTimeline → finalTimelinePayload 为 undefined 不下发）
    const stream = mcp.buildSSE(aiClean, { model, usage: r.usage, reasoning: r.reasoning, toolHistory: r.toolHistory, finalContent: finalStoredText || undefined, finalTimeline: finalTimelinePayload || undefined });
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
      }
      reply.raw.end();
    } catch (e) {
      try { reply.raw.end(); } catch {}
    }
    return true;
  }

  // 非流式：返回 OpenAI JSON
  reply.send({
    id: "chatcmpl-mcp",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: aiClean },
      finish_reason: "stop"
    }],
    usage: r.usage
  });
  return true;
}
// === MCP_TOOL_LOOP_END ===


// ========================
// 内部接口：记录唤醒事件
// ========================
// 2026-09-13 审查修复：唤醒事件幂等去重——HTTP 重试会把同一唤醒事件/回复重复落库
// （appendSpecialEvent 无内容查重，buildTimeline 的视图去重掩盖不了盘上累积）。
// 进程内指纹窗口 10 分钟：同会话+同内容组合的重复请求直接跳过。

// ========================
// 内部：小世界事件落时间线（2026-09-19 批6 D4）
// unified_server.py 在「涵写日记 / 经期开始结束」时回调：往「最新请求的会话」时间线末尾追加一条
// developer(kind=diary) 隐藏消息——前端不显示、模型可见（与 [唤醒] 块同一展示过滤口径）。
// 鉴权：/internal/ 路径统一走 X-Internal-Key（见顶部 onRequest 钩子），不另设账号。
// 最新会话口径 = 项目根 enhanced_messages*.json 中 mtime 最新者（重启不丢，与「最新请求」字面语义一致）。
// ========================
// 小世界事件总开关（2026-10-01 用户拍板：暂时关闭）。
// 开关文件：data/timeline-event.json —— 写 {"enabled":false} 即丢弃全部事件
// （不落时间线、不进模型上下文）；文件缺失或 enabled 不为 false 时保持原行为。
// 每次请求读一次文件判定，改完即时生效，无需重启 gateway。
function timelineEventEnabled() {
  try {
    const p = path.join(__dirname, "data", "timeline-event.json");
    if (!fs.existsSync(p)) return true;
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return (j && j.enabled === false) ? false : true;
  } catch (e) { return true; }
}
// 按谓词移除时间线消息（2026-10-01 通知撤回用）。
// 用 splice 原地删而非 filter：loadTimeline 返回的数组带 __fp（盘上指纹），
// filter 会产出新数组丢掉该属性，可能绕过 saveTimeline 的过期快照守卫；splice 保留数组身份与指纹。
function removeTimelineMessages(sessionId, predicate) {
  const tl = loadTimeline(sessionId);
  if (!Array.isArray(tl)) return 0;
  const hit = [];
  for (let i = tl.length - 1; i >= 0; i--) {
    let ok = false;
    try { ok = !!predicate(tl[i]); } catch (e) { ok = false; }
    if (ok) hit.push(i);
  }
  for (const i of hit) tl.splice(i, 1);
  if (hit.length) saveTimeline(tl, sessionId);
  return hit.length;
}
function latestRequestedSessionId() {
  let best = { mtimeMs: -1, sid: "default" };
  try {
    for (const f of fs.readdirSync(__dirname)) {
      const m = f.match(/^enhanced_messages(?:[_-]([A-Za-z0-9_-]+))?\.json$/);
      if (!m) continue;
      let mt = 0;
      try { mt = fs.statSync(path.join(__dirname, f)).mtimeMs; } catch (e) { continue; }
      if (mt > best.mtimeMs) best = { mtimeMs: mt, sid: m[1] || "default" };
    }
  } catch (e) {}
  return best.sid;
}
function fmtEventDateTime(iso) {
  try {
    const p = getDatePartsInTimeZone(new Date(iso), TIME_ZONE);
    return p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
  } catch (e) { return ""; }
}
app.post("/internal/timeline-event", async (req, reply) => {
  try {
    const body = req.body || {};
    const type = String(body.type || "").trim();
    // 撤回通知（2026-10-01）：涵删日记后由 unified_server.py 回调。
    // 刻意放在通知开关判定**之前**——开关只管「要不要落新通知」，撤回是清理动作，
    // 即使通知已关闭也要能清掉历史遗留的失效通知。
    if (type === "diary_undo") {
      const undoSid = latestRequestedSessionId();
      const undoEid = (body.entry_id != null && String(body.entry_id) !== "") ? String(body.entry_id) : "";
      const undoT = body.time ? new Date(body.time) : null;
      const undoLabel = (undoT && !isNaN(undoT.getTime())) ? fmtEventDateTime(undoT.toISOString()) : "";
      const refKey = undoEid ? ("han_diary:" + undoEid) : "";
      const removed = removeTimelineMessages(undoSid, function (m) {
        if (!m || m.role !== "developer" || m.kind !== "diary") return false;
        // 新数据带 event_ref → 按 entry_id 精确匹配；老数据无 event_ref → 回退按时间标签匹配
        if (refKey) return m.event_ref === refKey;
        if (undoLabel) return String(m.content || "").indexOf("涵写了日记（" + undoLabel + "）") !== -1;
        return false;
      });
      console.log("[timeline-event] diary_undo entry_id=" + (undoEid || "-") + " 会话 " + undoSid + " 撤回=" + removed);
      return reply.send({ success: true, session: undoSid, removed: removed });
    }
    if (!timelineEventEnabled()) {
      console.log("[timeline-event] 开关已关闭，丢弃事件 type=" + type);
      return reply.send({ success: false, disabled: true, type: type });
    }
    const parsed = body.time ? new Date(body.time) : new Date();
    const timeIso = isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
    let content = "";
    let eventRef = "";   // 可回溯标记：删日记时据此精确撤回本条通知
    if (type === "han_diary") {
      content = "[小世界] 涵写了日记（" + fmtEventDateTime(timeIso) + "）";
      if (body.entry_id != null && String(body.entry_id) !== "") eventRef = "han_diary:" + String(body.entry_id);
    } else if (type === "period_start") {
      if (!isDate(body.start)) return reply.code(400).send({ error: "start 日期格式应为 YYYY-MM-DD" });
      content = "[小世界] 涵记录了经期开始（" + String(body.start).slice(5) + "）";
    } else if (type === "period_end") {
      if (!isDate(body.start) || !isDate(body.end)) return reply.code(400).send({ error: "start/end 日期格式应为 YYYY-MM-DD" });
      const days = Math.round((new Date(body.end) - new Date(body.start)) / 86400000) + 1;
      content = "[小世界] 涵记录了经期结束（" + String(body.start).slice(5) + "～" + String(body.end).slice(5) + "，共 " + days + " 天）";
    } else {
      return reply.code(400).send({ error: "未知事件类型：" + type });
    }
    const sid = latestRequestedSessionId();
    const added = appendMessages(sid, [{ role: "developer", kind: "diary", content, time: timeIso, event_ref: eventRef || undefined }], { silent: true });
    console.log("[timeline-event] " + type + " -> 会话 " + sid);
    reply.send({ success: true, session: sid, id: added[0] ? added[0].id : null });
  } catch (err) {
    console.error("[timeline-event] 落时间线失败:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 日记落库唯一格式（2026-09-21 用户拍板）：[DIARY]日记内容[/DIARY]。
// 不管调用方传什么形态（裸正文/自带标签），剥净标签后统一重包裹；剥完为空则返回空串由调用方跳过。
function normalizeDiaryForStore(raw) {
  const inner = String(raw || "").replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
  return inner ? "[DIARY]" + inner + "[/DIARY]" : "";
}

// wake-event v2 落库实现（2026-09-15 批3收尾抽出）：网关内唤醒调度器（lib/wake-scheduler.js）进程内直调，无 HTTP 入口。
function applyWakeEventV2(body) {
  try {
    const { session_id, speak, diary, diary_id: diaryId, push, event, tools, wake_block_id, reasoning } = body || {};
    const evSession = typeof session_id === "string" && session_id.trim() ? String(session_id).trim() : null;
    const speakRaw = String(speak || "").trim();
    const diaryRaw = normalizeDiaryForStore(diary);
    const eventRaw = String(event || "").trim();
    const pushMeta = (push && typeof push === "object") ? push : null;
    const wakeTools = Array.isArray(tools) ? tools.filter(t => t && t.name) : [];
    const appended = [];
    if (diaryRaw) appended.push({ role: "assistant", content: diaryRaw, kind: "diary", diary_id: (diaryId != null) ? diaryId : undefined });
    // 2026-09-24（用户拍板 B 案）：时间线是流水账记录层，AI 所有输出原样入库不可改写（0920 拍板核心）。
    // [NO_ACTION] 开头的静默输出同样原样落 assistant 行、打 kind=noaction——
    // /v1/history 与 sidx 下发层按 kind 过滤（与 kind=diary 同款机制），前端不显示；
    // 服务端上下文重建（buildConversation 读盘上全量）仍能看到，AI 不再"失忆"上次的静默决定。
    // （旧拦截"跳过 [NO_ACTION] 原文"是 0829 加的，0920 拍板时漏撤，导致该类输出实际未入库。）
    if (speakRaw) {
      const msg = { role: "assistant", content: speakRaw };
      // 2026-09-28：speak 保留 <wake> 标签原文（时间线原始流水），kind=noaction 判定必须
      // 先剥 <wake> 前缀——否则 [NO_ACTION] 消息漏打 kind，前端 /v1/history 不过滤会直接显示
      const speakHead = String(speakRaw).replace(/^<wake>[\s\S]*?<\/wake>\s*/i, "");
      if (/^\[NO_ACTION\]/i.test(speakHead)) msg.kind = "noaction";
      if (pushMeta) msg.push = pushMeta;
      if (wakeTools.length) msg.tools = wakeTools;
      // 2026-09-24 P3-3：唤醒思考链落盘（聊天链路 MCP 路径同样落 reasoning），前端刷新后可见思考链区块
      const wakeReasoning = typeof reasoning === "string" && reasoning.trim() ? String(reasoning).trim() : "";
      if (wakeReasoning) msg.reasoning = wakeReasoning;
      appended.push(msg);
    }
    // 2026-09-20 恢复判定回写：event=唤醒判定记录（发推/未发/失败，沿用文本格式，推送管理读端直接解析）
    // → developer 系统层消息落时间线，前端不显示（与 [唤醒] 块同层）
    if (eventRaw) appended.push({ role: "developer", content: eventRaw });
    if (appended.length) appendMessages(evSession, appended);
    // 静默但调过工具：工具记录回填到本次的 developer [唤醒] 块上，不丢工具痕迹
    if (!appended.length && wakeTools.length && wake_block_id) {
      try { patchMessage(evSession, wake_block_id, { tools: wakeTools }); } catch (e) {}
    }
    console.log(`[wake-event] v2 落库 (session ${evSession || "default"}, speak=${speakRaw ? 1 : 0}, diary=${diaryRaw ? 1 : 0}, push=${pushMeta ? 1 : 0}, event=${eventRaw ? 1 : 0}, tools=${wakeTools.length})`);
    return { ok: true, v2: true, appended: appended.length };
  } catch (err) {
    console.error("[wake-event] v2 落库失败:", err.message);
    return { ok: false, error: err.message };
  }
}

// ========================
// 读取 .env 值
// ========================
function readEnvValue(key) {
  // 批注 2026-07-30：Railway Variables 是云端部署的权威配置源；
  // 容器内 .env 只作兜底，避免管理页保存出的临时文件覆盖平台变量。
  if (IS_RAILWAY_RUNTIME && process.env[key]) return process.env[key];
  // 启动时已把 .env 读进内存缓存，避免热路径每次读盘；/admin/save 等写路径后已刷新。
  if (Object.prototype.hasOwnProperty.call(cachedEnv, key)) return cachedEnv[key];
  return process.env[key] || "";
}

function readEnvValueOrDefault(key, fallback) {
  const value = readEnvValue(key);
  return value === "" ? fallback : value;
}

// 日记共享模块（2026-09-26）：MCP 工具循环分支的 [DIARY] 提取/落库，与 routes/chat.js、
// lib/wake-scheduler.js 同一实现（lib/diary.js），杜绝三路径口径漂移。
// 依赖 readEnvValue，故在 .env 读取区之后初始化；请求期才被 handleMcpRequest 调用。
const diaryLib = require("./lib/diary")({ baseDir: __dirname, readEnvValue });
// 2026-10-03：日记 JSON 存储（data/diary.json）统一读写模块
const diaryStore = require("./lib/diary-store");

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
  if (raw === "bark" || raw === "webpush") return raw;
  return readEnvValueOrDefault("PUSH_PROVIDER", "bark");
}

function normalizeWeatherUnits(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "fahrenheit") return "fahrenheit";
  if (raw === "metric" || raw === "celsius") return "metric";
  // 空值或非法值：保留 .env 原配置，避免保存表单时把单位意外重置
  return readEnvValueOrDefault("WEATHER_UNITS", "metric");
}

function readDiaryEntries(limit) {
  // 2026-10-03：日记改存 data/diary.json（lib/diary-store）；返回 id 倒序（最新在前，兼容旧行为）
  const out = diaryStore.listEntries(__dirname).slice().sort((a, b) => b.id - a.id);
  return limit ? out.slice(0, limit) : out;
}

// ========================
// 管理台：修改日记（文件 + 时间线特殊事件同步）
// 编辑日记文件后，把时间线里同日的「醒来写了日记」特殊事件一并更新（旧事件「自动写了日记」同样匹配），
// 保证注入 LLM 上下文的内容与日记文件一致。
// ========================
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
// 签发管理台会话 token（有效期 30 天，HMAC-SHA256 签名；密钥持久化于 data/session_secret.txt）
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
  // 非hex签名会让 Buffer.from(...,"hex") 解析成空/短buffer，timingSafeEqual 直接抛错变 500——先校验字符集，异常一律按 401 拒绝
  if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}
function createCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}
function ensureCsrfCookie(req, reply) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.admin_session && validSessionToken(cookies.admin_session) && !cookies.admin_csrf) {
    reply.header("Set-Cookie", `admin_csrf=${createCsrfToken()}; Path=/; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`);
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
let _warnedNoAdminCred = false;
function isAuthorized(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.admin_session && validSessionToken(cookies.admin_session)) return true;
  const auth = req.headers.authorization || "";
  const spIdx = auth.indexOf(" ");
  const scheme = spIdx >= 0 ? auth.slice(0, spIdx) : auth;
  const encoded = spIdx >= 0 ? auth.slice(spIdx + 1) : "";
  // 2026-09-22 审查 M6：scheme 按 HTTP 规范大小写不敏感（原 `!== "Basic"` 会拒掉 "basic"/"BASIC"，
  // 某些客户端/代理会改大小写）；同时改用 indexOf+slice 取凭据，不再依赖 split 的段数。
  if (scheme.toLowerCase() !== "basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString();
  const colonIndex = decoded.indexOf(":");
  const user = decoded.substring(0, colonIndex);
  const password = decoded.substring(colonIndex + 1);
  // 2026-09-21 审查 H7：改恒定时间比较，与 validSessionToken 同标准；长度不等先拒（长度本身不构成秘密）
  const expUser = String(process.env.ADMIN_USER || "");
  const expPass = String(process.env.ADMIN_PASSWORD || "");
  // 2026-09-22 审查 M6：口令未配置时 fail-closed。原实现两者皆空时 `timingSafeEqual("","")` 为真，
  // 于是「空用户名 + 空密码」即可进入管理台（配置残缺的部署存在认证绕过）。
  if (!expUser || !expPass) {
    if (!_warnedNoAdminCred) {
      _warnedNoAdminCred = true;
      console.error("[auth] ADMIN_USER/ADMIN_PASSWORD 未配置，管理台已拒绝全部请求（fail-closed）");
    }
    return false;
  }
  const ok = user.length === expUser.length && password.length === expPass.length
    && crypto.timingSafeEqual(Buffer.from(user), Buffer.from(expUser))
    && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expPass));
  return ok;
}

function basicAuth(req, reply, done) {
  if (isAuthorized(req)) {
    ensureCsrfCookie(req, reply);
    done();
    return;
  }
  // 2026-09-21 审查 H7：带了凭据但错误才计失败（未带凭据的普通访问不计，避免浏览者把自己锁死）
  const authHeader = String(req.headers.authorization || "");
  if (authHeader.startsWith("Basic ") && authHeader.length > 6) {
    loginFail();
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
  const isAdmin = url.startsWith("/admin") || url.startsWith("/heartbeat/admin") || url.startsWith("/v1/");
  if (!isAdmin) return done();
  const method = (req.method || "").toUpperCase();
  if (!["POST", "PUT", "DELETE", "PATCH"].includes(method)) return done();
  if (url.endsWith("/mobile/login")) return done();
  if (url.endsWith("/chat-login")) return done();
  // 聊天页语音接口：已过 mcpManageAuth 鉴权，豁免 CSRF（前端读 cookie 易错）
  if (url.endsWith("/admin/tts") || url.endsWith("/admin/voice-config")) return done();
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
// 批注 2026-09-13（审查 S3）：管理台登录防爆破。经两层反代后所有请求在 Node 侧同源
// （X-Real-IP 被二跳覆盖为 127.0.0.1，见 0913-02 审查 S2），无法按来源 IP 区分，
// 故按「账号」全局锁定：连续 5 次失败锁 15 分钟，成功登录即清零。个人系统单管理员账号，此口径够用。
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
let loginFails = 0;
let loginLockedUntil = 0;
function loginLocked() { return Date.now() < loginLockedUntil; }
function loginFail() {
  loginFails++;
  if (loginFails >= LOGIN_MAX_FAILS) {
    loginLockedUntil = Date.now() + LOGIN_LOCK_MS;
    loginFails = 0;
    console.warn("[login] 连续失败过多，管理台登录锁定 15 分钟");
  }
}
function loginOk() { loginFails = 0; loginLockedUntil = 0; }
function loginRemainingLockMinutes() { return Math.max(1, Math.ceil((loginLockedUntil - Date.now()) / 60000)); }

app.get("/admin/mobile/login", async (req, reply) => {
  reply.type("text/html").send(LOGIN_PAGE_HTML.replace("<!--ERROR-->", ""));
});

app.post("/admin/mobile/login", async (req, reply) => {
  if (loginLocked()) {
    await new Promise(r => setTimeout(r, 500));
    reply.type("text/html").send(LOGIN_PAGE_HTML.replace("<!--ERROR-->", '<div class="err">失败次数过多，已锁定 ' + loginRemainingLockMinutes() + ' 分钟</div>'));
    return;
  }
  const body = req.body || {};
  const ok = String(body.user || "") === process.env.ADMIN_USER
    && String(body.password || "") === process.env.ADMIN_PASSWORD;
  if (ok) {
    loginOk();
    const csrf = createCsrfToken();
    reply.header("Set-Cookie", [
      `admin_session=${createSessionToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`,
      `admin_csrf=${csrf}; Path=/; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`
    ]);
    reply.redirect(adminBasePath(req) + "/mobile");
    return;
  }
  await new Promise(r => setTimeout(r, 500));
  loginFail();
  reply.type("text/html").send(LOGIN_PAGE_HTML.replace("<!--ERROR-->", '<div class="err">用户名或密码错误</div>'));
});

// 聊天前端登录：复用管理台账号密码校验（JSON 接口，供 /chat 页做密码登录用）
app.post("/admin/chat-login", async (req, reply) => {
  if (loginLocked()) {
    return reply.code(429).send({ ok: false, error: "失败次数过多，已锁定 " + loginRemainingLockMinutes() + " 分钟" });
  }
  const body = req.body || {};
  console.log("[chat-login] got user=" + JSON.stringify(String(body.user || "")) + " pwLen=" + String(body.password || "").length + " at=" + new Date().toISOString());
  const ok = String(body.user || "") === process.env.ADMIN_USER
    && String(body.password || "") === process.env.ADMIN_PASSWORD;
  if (ok) {
    loginOk();
    // 让 /chat 页也能走管理台会话：登录成功后下发 admin_session + admin_csrf cookie，
    // chat.html 内置卡片即可直接调 /heartbeat/admin/*（cookie 认证 + CSRF 双提交）。
    const csrf = createCsrfToken();
    reply.header("Set-Cookie", [
      `admin_session=${createSessionToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`,
      `admin_csrf=${csrf}; Path=/; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_DAYS * 24 * 3600}`
    ]);
    reply.send({ ok: true });
    return;
  }
  await new Promise(r => setTimeout(r, 500));
  loginFail();
  console.log("[chat-login] rejected user=" + JSON.stringify(String(body.user || "") ));
  reply.code(401).send({ ok: false, error: "账号或密码错误" });
});

// 修改登录密码（管理台/聊天页共用）：校验旧密码，写回 .env 并热更新 process.env
app.post("/admin/change-password", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const oldPw = String(body.old_password || "");
    const newPw = String(body.new_password || "").trim();
    if (oldPw !== (process.env.ADMIN_PASSWORD || "")) {
      return reply.code(400).send({ ok: false, error: "旧密码不正确" });
    }
    if (!newPw) return reply.code(400).send({ ok: false, error: "新密码不能为空" });
    if (newPw.length < 4) return reply.code(400).send({ ok: false, error: "新密码至少 4 位" });
    await writeEnvUpdates({ ADMIN_PASSWORD: newPw });
    process.env.ADMIN_PASSWORD = newPw;   // 热生效：basicAuth/chat-login 直接读取该值
    // 批注 2026-09-13（审查 S5）：改密成功即轮换会话密钥——所有已签发的 admin_session
    // （HMAC 用旧密钥）立即失效，包括可能已泄漏的 token；所有设备需重新登录（预期行为）。
    sessionSecret = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(SESSION_SECRET_FILE, sessionSecret, { mode: 0o600 });
    } catch (e) {
      console.error("[change-password] 轮换会话密钥失败:", e.message);
    }
    console.log("[change-password] 登录密码已更新，会话密钥已轮换（所有登录态失效）");
    reply.send({ ok: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
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
  // 剥掉「cd <dir> && 」前缀后，剩余命令不允许再出现命令拼接/管道/替换符（2>&1 重定向除外）：
  // 否则 "pm2 restart gateway && <任意命令>" 可借前缀白名单绕过校验
  const execPart = (cdMatch ? cdMatch[2] : trimmedCmd).replace(/2>&1/g, "");
  if (/[;&|`]|\$\(/.test(execPart)) {
    console.error("重启命令含拼接/管道等非法片段，已拒绝:", trimmedCmd);
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
    // AI 压缩成功 → 该会话的容量提醒使命完成，标记删除；
    // 若上下文仍超上限，下次请求会带新的时间段重新提醒，一段一段压到达标为止。
    if (result && result.ok && result.session) {
      try {
        const timeline = loadTimeline(result.session);
        let removed = false;
        for (const m of timeline) {
          if (m && m.kind === "ctx_limit" && !m.deleted) { m.deleted = true; removed = true; }
        }
        if (removed) {
          saveTimeline(timeline, result.session);
          console.log("[ctx-limit] AI 已完成一次压缩，清除会话 " + result.session + " 的容量提醒（仍超限会重新提醒）");
        }
      } catch (cleanErr) {
        console.warn("[ctx-limit] 清除容量提醒失败（不影响替换结果）:", cleanErr.message);
      }
    }
    reply.send(result);
  } catch (err) {
    console.error("[POST /internal/context-replacements/apply] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/internal/context-search", async (req, reply) => {
  try {
    const mode = String(req.query.mode || "semantic");
    const allSessions = req.query.all_sessions === "1" || req.query.all_sessions === "true";
    const limit = Number(req.query.limit) || undefined;
    const threshold = req.query.threshold !== undefined ? Number(req.query.threshold) : undefined;
    const timePrefix = req.query.time_prefix !== undefined ? String(req.query.time_prefix) : undefined;
    const latest = req.query.latest !== undefined ? Number(req.query.latest) : 0;
    let q = req.query.q;
    const useLatestUser = req.query.use_latest_user === "1";
    if (useLatestUser && String(q || "").trim() === "" && !timePrefix && !(latest > 0)) {
      // MCP 工具未提供 q：取当前会话最新一条用户消息原文当检索查询。
      // 会话解析走 getLatestUserMessage → loadTimeline 的 effectiveSession 链
      //（工具回调场景由 noteMcpChatSession 的 90 秒窗口兜底）。
      const latest = contextReplacements.getLatestUserMessage({ session: req.query.session || undefined });
      if (!latest || !latest.content) {
        return reply.code(404).send({ ok: false, error: "没有提供 q，且当前会话取不到最新的用户消息（时间线为空或尚无用户发言），请显式提供 q" });
      }
      q = latest.content;
    }
    const result = await contextReplacements.searchContextEnhanced(q, { mode, allSessions, limit, threshold, timePrefix, latest });
    if (useLatestUser && result && result.ok) result.query_source = "latest_user";
    reply.send(result);
  } catch (err) {
    console.error("[GET /internal/context-search] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 「回看已替换历史摘要」：MCP 工具 context_digest 用（鉴权走全局 /internal hook 的 x-internal-key）
app.post("/internal/context-digest", async (req, reply) => {
  try {
    const q = String((req.body && req.body.q) || "").trim();
    const result = await contextDigest.digest(q);
    reply.send(result);
  } catch (err) {
    console.error("[POST /internal/context-digest] error:", err.message);
    reply.code(500).send({ ok: false, error: err.message });
  }
});

// 按 消息id 给聊天原文标星/取消：MCP 工具 context_star 用（x-internal-key 鉴权）
// AI 标星只做「原文保留在上下文」（与用户标星共用 marks 存储、同样不参与压缩/替换），
// 但不同步写记忆池——标星与对话碎片分开（看板 I5 方向）；取消标星直接删 key，无沉底逻辑。
app.post("/internal/context-mark", async (req, reply) => {
  try {
    const b = req.body || {};
    const session = String(b.session || "").trim();
    const marked = b.marked === undefined ? true : !!b.marked;
    const r = contextReplacements.findMessagesByIds(session, b.msg_ids);
    if (!r.found.length) {
      return reply.code(404).send({ ok: false, error: "这些 msg_id 都没找到对应消息（确认 session 与 msg_id 来自同一次 context_search）", missing: r.missing });
    }
    const starred = [];
    const failed = [];
    for (const m of r.found) {
      const res = contextReplacements.setMark(m.key, marked, { content: m.content, role: m.role, msg_time: m.time });
      if (res && res.ok) starred.push({ msg_id: m.msg_id, role: m.role, time: m.time });
      else failed.push({ msg_id: m.msg_id, error: (res && res.error) || "标星失败" });
    }
    reply.send({ ok: true, starred, failed, missing: r.missing });
  } catch (err) {
    console.error("[POST /internal/context-mark] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池检索：MCP 工具 memory_search 用（x-internal-key 鉴权）
// 0919 用户拍板「换新」：数据源切 V2 集合（旧池退役为迁移源，不再写入）。
// 检索公式（0920 删重要级/时间衰减，用户拍板）：0.55 语义余弦(bge-small-zh) + 0.20 字面；
// embed-server 不可用自动降级纯字面（0.6/0.4）。category 兼容旧分类名 → V2 kind。
// 恒只读：不计数、不自动置顶（旧池检索写状态的污染在 V2 结构性根除）。
const MEMORY_CATEGORY_TO_KIND = { "关于她": "fact", "认账": "rule", "拓本": "fact", "压缩摘要": "fact", "对话碎片": "fact", "关于我们": "fact", "锚点": "fact", "信号": "fact", "对话摘要": "fact" };
app.get("/internal/memory-pool/retrieve", async (req, reply) => {
  try {
    const { createStore } = require("./memory-v2");
    const v2vectors = require("./memory-v2-vectors");
    const q = String(req.query.q || "").trim();
    const topK = Number(req.query.limit) || 5;
    const category = String(req.query.category || "").trim();
    const breath = req.query.breath === "1" || req.query.breath === "true";
    const kind = MEMORY_CATEGORY_TO_KIND[category] || category || null;
    // 特殊分类：「最近」=按正文更新时间倒序（浏览式，忽略关键词）；「已置顶」=只在 anchor 置顶里
    // 每请求新建 store（与 /admin/memory-v2/* 同款）：admission 等旁路实例各自持内存副本，避免读到陈旧缓存
    const rows = createStore({ config: {} }).list({ status: "active" });
    let items;
    if (category === "最近") {
      items = v2vectors.recent(rows, { topK });
    } else if (category === "已置顶") {
      items = q
        ? await v2vectors.retrieveHybrid(rows, q, { topK, pinnedOnly: true })
        : v2vectors.recent(rows, { topK, pinnedOnly: true });
    } else if (breath && !q) {
      // breath 模式：无 q 时只浮现记忆（未沉底，优先置顶/最近更新）
      items = v2vectors.breath(rows, { limit: topK, kind: kind || undefined });
    } else {
      items = await v2vectors.retrieveHybrid(rows, q, { topK, kind: kind || undefined });
    }
    reply.send({ ok: true, total: items.length, items });
  } catch (err) {
    console.error("[GET /internal/memory-pool/retrieve] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池新增记忆：MCP 工具 memory_add 用（x-internal-key 鉴权）
// 0918 起：v2 总闸任一开启时改道 V2 admission（tool 入口），双闸全关时原路直灌旧池（回滚通道）
app.post("/internal/memory-pool/add", async (req, reply) => {
  try {
    const b = req.body || {};
    const content = String(b.content || "").trim();
    if (!content) return reply.code(400).send({ error: "content 必填" });
    if (memoryV2Admission) {
      const v2 = await memoryV2Admission.submitV2(
        { content, category: b.category },
        { sessionId: String(b.session_id || "").trim() }
      );
      if (v2.action !== "skipped_shadow_off") {
        return reply.send({
          success: true, v2: true, action: v2.action,
          id: v2.entry_id || (v2.candidate ? v2.candidate.id : null) || null,
          queue_id: v2.queue_id || null,
          note: v2.action === "review" ? "已进 review 队列待人工裁决" : undefined,
        });
      }
    }
    // 2026-09-28：V1 记忆池删除，旧池直灌回滚通道移除——V2 admission 不可用即失败
    reply.code(503).send({ error: "V2 记忆通道未就绪" });
  } catch (err) {
    console.error("[POST /internal/memory-pool/add] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池按 id 置顶/取消置顶：MCP 工具 memory_pin 用（x-internal-key 鉴权）
// 0919 换新：写 V2 anchor（memory_search 数据源已切 V2，返回 V2 集合条目 id，迁移条目保留 mp_ 原id）；anchor=注入层常驻标记
app.post("/internal/memory-pool/pin", async (req, reply) => {
  try {
    const b = req.body || {};
    const id = String(b.id || "").trim();
    if (!id) return reply.code(400).send({ error: "id 必填：记忆 id（memory_search 返回）" });
    const store = require("./memory-v2").createStore({ config: {} });
    // 0920 扩展：可选 sunk（true=沉底 archive，false=恢复 revive）；pinned 缺省 true 保持旧契约
    if (b.sunk !== undefined) {
      const r = store.updateStatus(id, b.sunk ? "archived" : "active", { reason: b.sunk ? "archived" : "revive" });
      if (!r.ok) return reply.code(404).send({ error: "找不到这条记忆：id=" + id });
      const e0 = r.entry;
      let e = e0;
      if (b.pinned !== undefined) {
        const r2 = store.updateFields(id, { anchor: !!b.pinned });
        if (r2.ok) e = r2.entry;
      }
      return reply.send({ success: true, entry: { id: e.id, content: e.text, pinned: e.anchor === true, sunk: e.status === "archived" } });
    }
    const pinned = b.pinned === undefined ? true : !!b.pinned;
    const r = store.updateFields(id, { anchor: pinned });
    if (!r.ok) return reply.code(404).send({ error: "找不到这条记忆：id=" + id });
    const e = r.entry;
    reply.send({ success: true, entry: { id: e.id, content: e.text, pinned: e.anchor === true, sunk: e.status === "archived" } });
  } catch (err) {
    console.error("[POST /internal/memory-pool/pin] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池硬删除：管理台「彻底删除」按钮用（basicAuth；不可恢复，区别于 archive 软沉底）
app.post("/admin/memory-v2/entries/:id/delete", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = require("./memory-v2").createStore({ rootDir: __dirname, config: {} }).hardDelete(req.params.id);
    if (!r.ok) return reply.code(404).send({ error: r.error });
    reply.send({ success: true });
  } catch (err) {
    console.error("[POST /admin/memory-v2/entries/:id/delete] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 记忆池按 id 直接覆盖正文：MCP 工具 memory_update 用（x-internal-key 鉴权）
// 0920 加：只改 text（content_updated_at 机制自动刷新）；不走 admission 流水线，直接落 V2 主集合
app.post("/internal/memory-v2/update", async (req, reply) => {
  try {
    const b = req.body || {};
    const id = String(b.id || "").trim();
    const content = String(b.content || "").trim();
    if (!id) return reply.code(400).send({ error: "id 必填：记忆 id（memory_search 返回）" });
    if (!content) return reply.code(400).send({ error: "content 必填：覆盖后的记忆正文" });
    const r = require("./memory-v2").createStore({ config: {} }).updateFields(id, { text: content });
    if (!r.ok) return reply.code(404).send({ error: "找不到这条记忆：id=" + id });
    const e = r.entry;
    reply.send({ success: true, entry: { id: e.id, content: e.text, content_updated_at: e.content_updated_at } });
  } catch (err) {
    console.error("[POST /internal/memory-v2/update] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});


// ========================
// 记忆池（8 分类结构化记忆）管理
// ========================
// Memory V2 admission（C5）：惰性轻量初始化，失败仅停用 V2（v2_enabled 默认 false，旧池行为不变）
// 2026-09-28：V2 记忆向量后台预热（启动 8s + 每 10 分钟增量，对齐旧池机制；新增即算由 memory-v2 写入路径负责）
try { require("./memory-v2-vectors").startWarmup(); } catch (e) { console.warn("[memory-v2] 向量预热启动失败:", e.message); }

let memoryV2Admission = null;
try {
  memoryV2Admission = require("./memory-admission").createAdmission({});
} catch (err) {
  console.warn("[memory-v2] admission 初始化失败，V2 停用:", err.message);
}

// 记忆蒸馏调度器（1002 记忆改造 §8 第 3 项）：配置 data/memory_distill_config.json；路由 /admin/memory-distill/*
// 3.1 配置+调度骨架+手动触发；3.2 起分批/预取/抽取/校验/落待审接入
let memoryDistill = null;
let memorySummary = null;
let memoryBackfill = null;
try {
  memoryDistill = require("./lib/memory-distill")({
    baseDir: __dirname,
    addCompactionLog: addCompactionLog,
    persistCompactionLogs: persistCompactionLogs,
    // 3.3 预取通道：与 MCP 工具 context_search 同源（都是 contextReplacements.searchContextEnhanced）
    searchContext: function (q, o) { return contextReplacements.searchContextEnhanced(q, o); },
    // 3.6 落待审通道：Memory V2 admission 单例（promotion 通道一律进 review，不直接入池）
    admission: memoryV2Admission,
  });
  } catch (err) { console.warn("[memory-distill] 初始化失败，蒸馏停用:", err.message); }

  // 两块 LLM 总结调度器（1002 记忆改造 §8 第 6 项）：Core Identity / Long-term Understanding
  // 选材 = 记忆池全部活跃记忆（rule→Core，fact→Understanding），不是置顶几条；
  // 每晚定时按指纹判断：池子没变就不调 LLM，变了才重生成并写缓存。
  try {
    memorySummary = require("./lib/memory-summary")({
      baseDir: __dirname,
      addCompactionLog: addCompactionLog,
      persistCompactionLogs: persistCompactionLogs,
    });
  } catch (err) { console.warn("[memory-summary] 初始化失败，两块总结停用:", err.message); }

  // 老数据重跑（1002 记忆改造 §8 第 5 项）：逐批把已有活跃记忆过一遍，产出一律进待审；
  // 五动作 update / supplement / merge / create 落待审，sink（沉底，删除级）写进独立建议列表。
  try {
    memoryBackfill = require("./lib/memory-backfill")({
      baseDir: __dirname,
      addCompactionLog: addCompactionLog,
      persistCompactionLogs: persistCompactionLogs,
      // 与蒸馏同源：context_search 的检索能力，回原文取证（原文对不上的一律不动）
      searchContext: function (q, o) { return contextReplacements.searchContextEnhanced(q, o); },
      // 3.6 同款落待审通道：Memory V2 admission 单例（promotion 通道一律进 review）
      admission: memoryV2Admission,
    });
  } catch (err) { console.warn("[memory-backfill] 初始化失败，老数据重跑停用:", err.message); }

// 2026-09-28：V1 记忆池删除——旧池静默迁移（startMemoryBackgroundMigration）与 routes/memory-pool 挂载已移除

// 记忆流水线 judge 判定提示词（提示词页配置，2026-09-19）
const judgeAdapter = require("./judge-adapter");
app.get("/admin/memory-judge/prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const c = judgeAdapter.getJudgePromptConfig();
    reply.send({ template: c.effective, custom_set: !!c.custom, default_template: c.default_template });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/memory-judge/prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const t = judgeAdapter.saveJudgeTemplate((req.body || {}).template);
    reply.send({ ok: true, custom_set: !!t });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.delete("/admin/memory-judge/prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    judgeAdapter.saveJudgeTemplate("");
    reply.send({ ok: true, custom_set: false });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
require("./routes/memory-review")(app, { basicAuth, admission: memoryV2Admission });
// 记忆 V2 管理台：集合查看 + 聊天页入池（manual_review 走流水线进 review）
require("./routes/memory-v2-admin")(app, { basicAuth, admission: memoryV2Admission, baseDir: __dirname });
// 聊天页主题云同步 + 背景图/头像转存（/v1/themes, /v1/upload-image, /uploads/:file）
require("./routes/themes")(app, { baseDir: __dirname });
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
    // 0928：块编号（块#N）与压缩页预览同源——复用统一预览构建，按记录 id 取展示序号
    let indexByRecord = null;
    try {
      const pv = buildUnifiedReplacementPreview(false);
      if (pv && Array.isArray(pv.chunks)) {
        indexByRecord = new Map();
        pv.chunks.forEach(function (c) { if (c && c.id != null) indexByRecord.set(String(c.id), c.index); });
      }
    } catch (e) { indexByRecord = null; }
    // 一键入池（direct）：0918 起停用——无判断直灌是低质量记忆的主通道（存量 340+ 条教训）。
    // 请走 LLM 解析：解析压缩块覆盖区间的「时间线原文」（原文都在，压缩只影响发送），
    // 产出的候选走 V2 admission 完整流水线并全部进 review 队列人工把关。
    if (b.direct === true) {
      return reply.code(403).send({ error: "直接入池已停用（2026-09-18）。请改用 LLM 解析：候选将进 review 队列人工把关后入库。" });
    }
    // 0918 promotion 改造：LLM 解析对象=压缩块覆盖区间的「时间线原文」（非摘要——摘要是劣化的
    // 二手文本，在它上面做提取只会产出劣化记忆）。候选逐条走 admission promotion 模式（R7 全落 review）。
    const slicedOriginals = [];
    for (const t of list) {
      const item = active.find(function (it) { return String(it.id) === String(t.block_id); });
      const original = item && item.range ? sliceTimelineOriginal(item.session, item.range) : null;
      slicedOriginals.push({
        block_id: t.block_id,
        session: item && item.session || null,
        source_text: original && original.trim() ? original : t.summary,
        summary: t.summary, // 0928：日志块标识用摘要前 20 字（原 block_id 分不清是哪块）
        degraded: !(original && original.trim()),
      });
    }
    const degradedCount = slicedOriginals.filter(s => s.degraded).length;
    if (degradedCount) console.warn("[reparse] " + degradedCount + "/" + slicedOriginals.length + " 块原文切片不可得，退化为摘要文本解析");
    let reviewed = 0, rejected = 0, failed = 0;
    let failedBlocks = []; // 失败块明细：{ idx, block, err }
    const logId2 = addCompactionLog({ action: "reparse", label: "解析原文进 review（" + slicedOriginals.length + " 块）", status: "pending", message: "开始解析原文并提取候选...（共 " + slicedOriginals.length + " 块）" }).id;
    // 0928：日志实时更新「正在解析第 k/N 块」（写回同一条日志，面板轮询可见进度）
    const updateLogMsg = function (msg) {
      const li = compactionLogs.findIndex(function (x) { return x.id === logId2; });
      if (li >= 0) { compactionLogs[li].message = msg; try { persistCompactionLogs(); } catch (e) {} }
    };
    // 0928：块标识 = 压缩页块编号（块#N，与预览同源）；预览不可得时回退摘要前 12 字
    const blockLabel = function (sb) {
      const bid = String((sb && sb.block_id) || "");
      const idx = indexByRecord ? indexByRecord.get(bid) : undefined;
      if (idx != null) return "块 #" + idx;
      const sum = String((sb && sb.summary) || "").replace(/\s+/g, " ").trim();
      return sum ? "块 ?（" + sum.slice(0, 12) + "）" : String(bid || "?").slice(0, 12);
    };
    for (let k = 0; k < slicedOriginals.length; k++) {
      const s = slicedOriginals[k];
      try {
        const candidates = await extractMemoryCandidates(s.source_text);
        // 2026-09-28：解析成功 → 该块标记「已解析」（preview 下发 parsed，前端徽标显示蓝色已解析）
        const parsedItem = active.find(function (it) { return String(it.id) === String(s.block_id); });
        if (parsedItem) parsedItem.reparsed_at = new Date().toISOString();
        for (const c of candidates) {
          try {
            const r = await (memoryV2Admission
              ? memoryV2Admission.submitPromotion({ content: c.text, kind: c.kind, block_id: s.block_id }, { sessionId: s.session })
              : Promise.resolve({ action: "error" }));
            if (r.action === "reject") rejected++; else reviewed++;
          } catch (e) { failed++; }
        }
        updateLogMsg("正在解析 第 " + (k + 1) + "/" + slicedOriginals.length + " 块（" + blockLabel(s) + "）：已产候选 " + reviewed + " 条 / 门卫拒绝 " + rejected + " / 失败 " + failed);
      } catch (e) {
        failed++;
        failedBlocks.push({ idx: k + 1, block: blockLabel(s), err: e && e.message ? String(e.message).slice(0, 80) : String(e) });
        console.error("[reparse] 原文解析失败:", e.message);
        updateLogMsg("正在解析 第 " + (k + 1) + "/" + slicedOriginals.length + " 块（" + blockLabel(s) + "）：失败 - " + (e && e.message ? String(e.message).slice(0, 80) : String(e)));
      }
    }
    // 2026-09-28：把「已解析」标记写回压缩块记录（解析成功才标记；失败块保持原状可重试）
    try { await fsx.writeJson(cf, records); } catch (e) { console.warn("[reparse] 写回解析标记失败:", e.message); }
    let finalMsg = "候选 " + reviewed + " 条进 review 队列 / 门卫拒绝 " + rejected + " / 失败 " + failed;
    if (failedBlocks.length) finalMsg += "；失败块：" + failedBlocks.map(function (f) { return "第" + f.idx + "块(" + f.block + ":" + f.err + ")"; }).join(" / ");
    addCompactionLog({ id: logId2, action: "reparse", label: "解析原文进 review（" + slicedOriginals.length + " 块）", status: "success", message: finalMsg });
    return reply.send({ success: true, promotion: true, processed: slicedOriginals.length, degraded: degradedCount, reviewed, rejected, failed, note: "候选已全部进 review 队列，请在记忆 review 页人工裁决" });
  } catch (err) {
    addCompactionLog({ action: "reparse", label: "再解析", status: "error", message: "再解析失败：" + err.message });
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 0928-48：reparse 分批限流调度器（按会话串行 + 块间定时间隔，防 LLM 429）
// 单飞：已有任务在跑返回 409；状态 GET /schedule/status；取消 POST /schedule/cancel
// ========================
let reparseScheduler = null;
const REPARSE_DEFAULT_GAP_MS = 300000; // 块间默认 5 分钟


// —— promotion 改造 helper（0918）：压缩块区间的时间线原文切片 + LLM 候选提取 ——

// 压缩块覆盖区间的时间线原文（原文都在——压缩替换只影响发送，源时间线未动）
// 锚点=消息 id（2026-09-19 统一）：按块 range 的 start_id/end_id 在时间线里精确定位，
// 编号下标已废弃（压缩编号≠原始数组下标，直接 slice 会错位）。
function sliceTimelineOriginal(sessionId, range) {
  try {
    const tl = loadTimeline(sessionId);
    if (!Array.isArray(tl)) return null;
    let s = -1, e = -1;
    if (range && range.start_id) s = tl.findIndex(function (m) { return m && String(m.id) === String(range.start_id); });
    if (range && range.end_id) e = tl.findIndex(function (m) { return m && String(m.id) === String(range.end_id); });
    if (s < 0 || e < 0 || e < s) return null;
    const seg = tl.slice(s, e + 1)
      .filter(function (m) { return m && (m.role === "user" || m.role === "assistant") && !m.deleted; })
      .map(function (m) {
        const text = String(typeof m.content === "string" ? m.content : "").replace(/<current_time>[^<]*<\/current_time>/g, "").trim();
        return text ? (m.role === "user" ? "她: " : "我: ") + text : "";
      })
      .filter(Boolean);
    return seg.join("\n").slice(0, 24000) || null; // 上限约 1.2 万 tok，防异常超长
  } catch (e) { return null; }
}

// ---------------- 摘要解析（reparse）提示词配置（2026-09-28 从 V1 记忆池迁出） ----------------
// V1 记忆池已删除，reparse_system_prompt/user_prompt/reparse_merge_max_chars 改存独立文件，
// 管理台端点 /admin/reparse/config 读写（原 /admin/memory-pool/config）。
const REPARSE_CONFIG_FILE = path.join(__dirname, "data", "reparse_config.json");
function readReparseConfig() {
  try { return fs.readJsonSync(REPARSE_CONFIG_FILE) || {}; } catch (e) { return {}; }
}
function buildReparsePrompt() {
  const system = "你是长期记忆提取器。你的任务不是总结对话，而是从对话原文中找出那些在未来再次交流时仍然有用、并且会改变你理解用户或处理方式的信息。宁可少记，也不要把聊天流水账写进长期记忆。\n" +
    "只提取有证据支持的信息，不要根据一次行为猜测人格、心理、动机或身份；不要把你自己的解释当成用户事实。区分一次性事件与稳定倾向：‘今天吃了什么’通常不记，‘长期偏好什么’才记。\n" +
    "优先提取：稳定偏好/习惯；用户明确要求以后遵守的交互规则；用户反复纠正并希望以后避免的行为；长期目标、项目背景和持续有效的约束；重要关系规则；只有在未来确实有用时才保留重要原话。\n" +
    "不要提取：当天情绪、一次性事件、普通寒暄、玩笑调侃、聊天流水账、已经明显过期的信息、单次行为推导出的性格标签、心理分析、模型自我叙事。\n" +
    "特别注意：用户对助手的纠正、明确的‘以后不要……/以后要……/记住……’、以及会改变未来回应方式的要求，优先视为高价值规则。不要把这些规则写成对用户人格的判断。\n" +
    "每条记忆必须独立、简洁、可执行或可验证；不要复述上下文，不要加入未出现的因果关系。";
  const user = "从下面的对话原文中提取长期记忆候选。只输出 JSON 数组，不要输出解释。每项格式为 {\"text\":\"记忆内容\",\"kind\":\"fact|rule\"}。没有真正值得长期记住的信息就输出 []。\n\n判断标准：如果删掉这条信息，未来再次与她交流时基本不会改变你的理解或行为，就不要提取。";
  return { system, user };
}
function saveReparseConfig(patch) {
  const cur = readReparseConfig();
  Object.assign(cur, patch || {});
  try { fs.writeJsonSync(REPARSE_CONFIG_FILE, cur, { spaces: 2 }); } catch (e) { throw e; }
  return cur;
}

// LLM 候选提取：从对话原文提取值得长期记住的稳定信息（简短风格 prompt，JSON 数组输出）
async function extractMemoryCandidates(sourceText) {
  const { provider, model } = resolveRoleModel("reparse");
  const apiUrl = provider && (provider.api_url || provider.base_url);
  const apiKey = provider && provider.api_key;
  if (!apiUrl || !apiKey || !model) throw new Error("模型未配置（role=reparse：请在设置里给「摘要解析」选模型或启用默认供应商）");
  // 提示词接入管理台配置：reparse_system_prompt/user_prompt 自定义覆盖，内置默认=buildReparsePrompt（原文提取版）
  const pcfg = readReparseConfig();
  const pdef = buildReparsePrompt();
  const system = String(pcfg.reparse_system_prompt || "").trim() || pdef.system;
  const user = (String(pcfg.reparse_user_prompt || "").trim() || pdef.user) + "\n\n对话原文：\n" + sourceText;
  const controller = new AbortController();
  // 10 分钟（0928 拍板）：思考型模型解析长文实测 >300s 仍超时（reparse 多次 abort）；与 nginx 读超时(620s) 对齐
  const timer = setTimeout(() => controller.abort(), 600000);
  let resp, data;
  try {
    resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.2, response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("LLM HTTP " + resp.status);
    data = await resp.json();
  } finally { clearTimeout(timer); }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("LLM 空响应");
  const cleaned = String(content).replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch (e) { throw new Error("LLM 输出非 JSON"); }
  if (!Array.isArray(arr)) arr = arr && Array.isArray(arr.memories) ? arr.memories : null;
  if (!Array.isArray(arr)) throw new Error("LLM 输出非数组");
  const KINDS = ["fact", "rule"];
  return arr
    .map(x => (x && typeof x === "object" ? { text: String(x.text || "").trim(), kind: KINDS.includes(x.kind) ? x.kind : "fact" } : null))
    .filter(x => x && x.text.length >= 4 && x.text.length <= 500);
}

// 摘要解析提示词配置（2026-09-28 从 /admin/memory-pool/config 迁出，V1 记忆池已删除）
app.get("/admin/reparse/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const cfg = readReparseConfig();
    const def = buildReparsePrompt();
    reply.send({
      reparse_system_prompt: String(cfg.reparse_system_prompt || ""),
      reparse_user_prompt: String(cfg.reparse_user_prompt || ""),
      reparse_merge_max_chars: Number(cfg.reparse_merge_max_chars) || 8000,
      default_reparse_system_prompt: def.system,
      default_reparse_user_prompt: def.user,
    });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/reparse/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.reparse_system_prompt !== undefined) patch.reparse_system_prompt = String(b.reparse_system_prompt).trim();
    if (b.reparse_user_prompt !== undefined) patch.reparse_user_prompt = String(b.reparse_user_prompt).trim();
    if (b.reparse_merge_max_chars !== undefined) patch.reparse_merge_max_chars = Number(b.reparse_merge_max_chars) || 8000;
    reply.send(saveReparseConfig(patch));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 记忆蒸馏配置 / 手动触发 / 状态（1002 记忆改造 §8 3.1）
// ========================
function requireDistill(reply) {
  if (memoryDistill) return true;
  reply.code(500).send({ error: "蒸馏模块未初始化" });
  return false;
}

app.get("/admin/memory-distill/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try { reply.send(memoryDistill.readConfig()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-distill/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.time !== undefined) patch.time = String(b.time);
    if (b.batch_size !== undefined) patch.batch_size = Number(b.batch_size);
    reply.send(memoryDistill.saveConfig(patch));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 立即跑一次：不受 enabled 约束（关着也能手动跑）；单飞，已在跑返回 409
app.post("/admin/memory-distill/run", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try {
    if (memoryDistill.status().running) {
      return reply.code(409).send({ error: "已有蒸馏在跑", status: memoryDistill.status() });
    }
    // 1004：支持 dryRun / noQueue 透传——改选材后第一次试跑要先「不落库」看质量，
    // 免得抽出来的东西直接灌进待审队列、还要人工一条条删
    const o = (req && req.body && typeof req.body === "object") ? req.body : {};
    const runOpts = { dryRun: !!o.dryRun, noQueue: !!o.noQueue };
    const r = await memoryDistill.runNow("manual", runOpts);
    reply.send(r);
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/memory-distill/status", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try { reply.send(memoryDistill.status()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

// 蒸馏抽取提示词（System + User）：留空 = 回落内置默认；DELETE = 清空自定义回到内置
app.get("/admin/memory-distill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try {
    const c = memoryDistill.readPromptConfig();
    reply.send({
      distill_system_prompt: c.distill_system_prompt || "",
      distill_user_prompt: c.distill_user_prompt || "",
      default_distill_system_prompt: memoryDistill.defaultSystemPrompt(),
      default_distill_user_prompt: memoryDistill.defaultUserPrompt(),
      custom_set: !!(c.distill_system_prompt || c.distill_user_prompt),
    });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-distill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try {
    const b = req.body || {};
    const patch = {};
    if (b.distill_system_prompt !== undefined) patch.distill_system_prompt = String(b.distill_system_prompt).trim();
    if (b.distill_user_prompt !== undefined) patch.distill_user_prompt = String(b.distill_user_prompt).trim();
    reply.send(memoryDistill.savePromptConfig(patch));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.delete("/admin/memory-distill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireDistill(reply)) return;
  try {
    reply.send(memoryDistill.savePromptConfig({ distill_system_prompt: "", distill_user_prompt: "" }));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 两块 LLM 总结配置 / 手动生成 / 状态 / 提示词（1002 记忆改造 §8 第 6 项）
// ========================
function requireSummary(reply) {
  if (memorySummary) return true;
  reply.code(500).send({ error: "两块总结模块未初始化" });
  return false;
}

app.get("/admin/memory-summary/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try { reply.send(memorySummary.readConfig()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-summary/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.time !== undefined) patch.time = String(b.time);
    if (b.incremental !== undefined) patch.incremental = !!b.incremental;
    reply.send(memorySummary.saveConfig(patch));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 立即生成一次：不受 enabled 约束；force=true 时忽略指纹（池子没变也重生成）
app.post("/admin/memory-summary/run", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try {
    if (memorySummary.status().running) {
      return reply.code(409).send({ error: "已有生成在跑", status: memorySummary.status() });
    }
    const b = req.body || {};
    const force = !!b.force;
    // 1003-15：改后台异步——全量（可能 5-20 分钟）不再占 HTTP 连接（nginx 读超时 620s 兜不住），
    // 接口立即返回 started，前端轮询 /admin/memory-summary/status 直到跑完。
    setImmediate(function () {
      memorySummary.runNow({ force: force }).then(function (r) {
        console.log("[memory-summary] 后台生成完成:", JSON.stringify(r && { ok: r.ok, error: r.error, tool_rounds: r.tool_rounds, blocks: r.blocks }));
      }).catch(function (e) {
        console.error("[memory-summary] 后台生成异常:", e && e.message);
      });
    });
    reply.send({ ok: true, started: true, force: force });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/memory-summary/status", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try { reply.send(memorySummary.status()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

// 两块提示词：留空 = 回落内置默认；DELETE = 清空自定义
app.get("/admin/memory-summary/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try {
    const c = memorySummary.readPromptConfig();
    reply.send({
      system_prompt: c.system_prompt || "",
      user_prompt: c.user_prompt || "",
      default_system_prompt: memorySummary.defaultCombinedSystem(),
      default_user_prompt: memorySummary.defaultCombinedUser(),
      custom_set: !!(c.system_prompt || c.user_prompt),
    });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-summary/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try {
    const b = req.body || {};
    reply.send(memorySummary.savePromptConfig(b));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.delete("/admin/memory-summary/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireSummary(reply)) return;
  try {
    reply.send(memorySummary.savePromptConfig({ system_prompt: "", user_prompt: "" }));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 老数据重跑（1002 记忆改造 §8 第 5 项）
// ========================
function requireBackfill(reply) {
  if (memoryBackfill) return true;
  reply.code(500).send({ error: "老数据重跑模块未初始化" });
  return false;
}

app.get("/admin/memory-backfill/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try { reply.send(memoryBackfill.readConfig()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-backfill/config", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try {
    const b = req.body || {};
    const patch = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.time !== undefined) patch.time = String(b.time);
    if (b.batch_size !== undefined) patch.batch_size = Number(b.batch_size);
    reply.send(memoryBackfill.saveConfig(patch));
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 跑一批：body.batch_size 可临时改批量；body.dry_run=true 只组装材料不调模型
app.post("/admin/memory-backfill/run", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try {
    if (memoryBackfill.status().running) return reply.code(409).send({ error: "已有重跑在跑" });
    const b = req.body || {};
    const r = await memoryBackfill.runNow({ batch_size: b.batch_size, dryRun: !!b.dry_run });
    reply.send(r);
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/memory-backfill/status", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try { reply.send(memoryBackfill.status()); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

// 建议沉底列表（sink 是删除级，不混进新增候选；这里只列，不自动执行）

// 重跑提示词：留空 = 回落内置默认；DELETE = 清空自定义
app.get("/admin/memory-backfill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try {
    const c = memoryBackfill.readPromptConfig();
    reply.send({
      system_prompt: c.system_prompt || "",
      user_prompt: c.user_prompt || "",
      default_system_prompt: memoryBackfill.defaultSystemPrompt(),
      default_user_prompt: memoryBackfill.defaultUserPrompt(),
      custom_set: !!(c.system_prompt || c.user_prompt),
    });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.post("/admin/memory-backfill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try { reply.send(memoryBackfill.savePromptConfig(req.body || {})); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

app.delete("/admin/memory-backfill/prompt", { preHandler: basicAuth }, async (req, reply) => {
  if (!requireBackfill(reply)) return;
  try { reply.send(memoryBackfill.savePromptConfig({ system_prompt: "", user_prompt: "" })); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

// ========================
// 推送管理（时间线里的推送回显）
// ========================
// 判断是否为「成功发送的推送回显」（排除“未发送”）
function isPushEchoContent(s) {
  const c = String(s || "");
  return !!c && !c.includes("本次未发送") && /刚刚给.{1,24}发了.{1,24}?推送：/.test(c);
}
// 解析推送回显内容
// 2026-09-22 审查 R19：注入 loadTimeline/saveTimeline，让推送编辑/删除走时间线四道守卫 + 快照指纹

// 跨窗口注入参数（日记条数，V2 Earlier Days 篇数同源）
app.get("/admin/cross-inject/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const c = readCrossInjectConfig();
    reply.send({ cross_inject_diary_count: c.cross_inject_diary_count, default_count: 3 });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/cross-inject/config", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const c = saveCrossInjectConfig((req.body || {}));
    reply.send({ ok: true, cross_inject_diary_count: c.cross_inject_diary_count });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});



// 上下文记忆替换：管理台撤销（压缩页 AI 块的「撤销」按钮用）
app.post("/admin/context-replacements/undo", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(contextReplacements.removeReplacement(String((req.body || {}).id || "").trim()));
  } catch (err) {
    console.error("[POST /admin/context-replacements/undo] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 切换 AI 记忆替换块的启用状态（停用 = 保留记录但不再替换）；
// body 带 hidden 字段时改为设置/取消手动隐藏（入池归档：摘要与区间原文都不再注入上下文）
app.post("/admin/context-replacements/toggle", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    if (body.hidden !== undefined) {
      reply.send(contextReplacements.setReplacementHidden(String(body.id || "").trim(), body.hidden === true));
      return;
    }
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
  { name: "zzf-mcp", type: "systemd", label: "远程玩具 MCP（8890）" },
  { name: "gateway", type: "pm2", label: "网关 gateway" },
  { name: "netease-music-mcp", type: "port", port: 3303, label: "网易云 MCP（3303）", cmd: "cd /opt/netease-music-mcp && PORT=3303 nohup node src/http-server.js > http-server.log 2>&1 &", pattern: "netease-music-mcp" },
  { name: "spicy-monopoly", type: "port", port: 8773, label: "涩涩大富翁 MCP（8773）", cmd: `cd /opt/dylan-heartbeat/spicy-monopoly && SPICY_MONOPOLY_MCP_TRANSPORT=streamable-http SPICY_MONOPOLY_MCP_HOST=0.0.0.0 SPICY_MONOPOLY_MCP_PORT=8773 SPICY_MONOPOLY_MCP_PATH=/mcp SPICY_MONOPOLY_MCP_BEARER_TOKEN=${process.env.SPICY_MONOPOLY_MCP_BEARER_TOKEN || ""} nohup node mcp-server.js > mcp_spicy.log 2>&1 &`, pattern: "spicy-monopoly" },
  { name: "yun-mcp-v2", type: "systemd", label: "云文件 MCP yun（9010）" },
  { name: "unified-backend", type: "systemd", label: "统一后端（8777）" },
  { name: "nginx", type: "systemd", label: "nginx 网关（80/443）" },
  { name: "email-mcp", type: "pm2", label: "邮箱 MCP email-mcp" },
  { name: "embed-server", type: "pm2", label: "向量服务 embed-server" }
];

function readJsonFileSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return fallback;
  }
}

// 原子写 JSON（tmp+rename）。2026-09-30 V10 收敛：与上方 atomicWriteJsonSync 的历史重复已合并，
// 统一委托 json_atomic.writeJsonAtomic；函数名保留（10 处调用点零改动）。
function writeJsonFileAtomic(file, data) {
  _writeJsonAtomicBase(file, data);
}

// 同步执行 shell 命令（20s 超时），返回 {ok, output}；管理台服务状态/控制用（注意：同步阻塞事件循环）
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
      // pattern 首字符转字符类（如 pm2 → [p]m2）：pkill -f 按正则匹配整条命令行时不再命中执行中的 sh -c 自身
      const killPat = "[" + String(svc.pattern).slice(0, 1) + "]" + String(svc.pattern).slice(1);
      const r = runShellCommand("pkill -f " + killPat + " || true; sleep 1");
      return { ok: true, status: serviceStatus(svc), output: "已发送停止信号" };
    }
    if (action === "restart") {
      const killPat = "[" + String(svc.pattern).slice(0, 1) + "]" + String(svc.pattern).slice(1);
      runShellCommand("pkill -f " + killPat + " || true; sleep 1");
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

// 2026-09-24：优先取最近一轮上游真实返回的 prompt_tokens（routes/chat.js 落盘 assistant.tokens=usage），
// 这才是"实际发给上游的 token"；老会话/没跑过一轮的才 fallback 到 estimateAlertTokens 估算。
function latestActualPromptTokens(timeline) {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const m = timeline[i];
    if (!m || m.role !== "assistant" || m.deleted) continue;
    const u = m.tokens;
    if (u && typeof u === "object" && Number.isFinite(u.prompt_tokens) && u.prompt_tokens > 0) {
      return u.prompt_tokens;
    }
  }
  return null;
}

// 批次4 C5：容量提醒 token 估算（与容量提醒守卫 countUncompressedTokens 同口径）
// 2026-09-22 审查 H10：计入 system/developer 头部块与 tool/tool_calls 往返，避免守卫失效。
function estimateAlertTokens(timeline) {
  let tok = 0;
  for (const m of timeline) {
    if (!m) continue;
    if (m._ctxRep || m._ccSummary) continue;
    if (isSpecialEvent(m)) continue;
    const c = m.content;
    if (typeof c === "string") {
      if (c.startsWith("## Historical Summary") || c.startsWith("（回忆 · ") || c.startsWith("（对话摘要")) continue;
      tok += contextCompactor.estimateTokens(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string") tok += contextCompactor.estimateTokens(part.text);
        else if (part.type === "image" || part.type === "image_url") tok += contextCompactor.EST_IMAGE_TOKENS;   // §3.5：去掉 `|| 1200` 兜底字面（EST_IMAGE_TOKENS 恒有值，两口径统一）
        else if (part.type === "file" && part.file && typeof part.file.name === "string") tok += contextCompactor.estimateTokens("[文件] " + part.file.name);
        else tok += 1;
      }
    }
    // tool_calls 本身也占 token（名称 + 参数 JSON）
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc || !tc.function) continue;
        if (tc.function.name) tok += contextCompactor.estimateTokens(tc.function.name);
        if (typeof tc.function.arguments === "string") tok += contextCompactor.estimateTokens(tc.function.arguments);
        else if (tc.function.arguments) tok += contextCompactor.estimateTokens(JSON.stringify(tc.function.arguments));
      }
    }
  }
  return tok;
}

// 批次4 C5：后台活动「提醒」板块数据源：网易云 Cookie 失效 / 会话上下文达容量上限 / 服务异常



app.put("/admin/tools", { preHandler: mcpManageAuth }, async (req, reply) => {
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

// MCP 服务器注册表管理（聊天客户端"设置→连接"或管理台调用）
// 鉴权：管理台/聊天页会话（admin_session cookie，聊天页经 chat-login 下发）或 admin basicAuth。
// 批注 2026-09-13（审查 S1）：不再接受 GATEWAY_API_KEY——那是下发给聊天客户端的 /v1 key，
// 若可进管理接口，等于一个泄露的聊天 key 就能读走全部上游凭据并注册任意 MCP command（RCE 面）。
// 聊天页登录后已持有 admin_session cookie（mcpAuthHeaders 同时带 credentials:include），功能不受影响。
function mcpManageAuth(req, reply, done) {
  if (isAuthorized(req)) return done();
  return basicAuth(req, reply, done);
}

app.get("/admin/mcp/servers", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(MCP_SERVERS_CONFIG, "utf-8"));
    const list = (cfg.servers || []).map(async function (s) {
      const base = { id: s.id, name: s.name, type: s.type, url: s.url, command: s.command, args: s.args || [], headers: s.headers || {}, enabled: s.enabled !== false };
      // 工具白名单原样带回前端，避免管理台保存时丢失（PUT 端会保留该字段）
      if (Array.isArray(s.allowTools)) base.allowTools = s.allowTools.map(String);
      // 工具级黑名单（聊天端工具查看页的每工具开关）同样带回，避免保存时丢失
      if (Array.isArray(s.blockTools)) base.blockTools = s.blockTools.map(String);
      if (s.enabled === false) return Object.assign(base, { connected: false, tools: [], toolCount: 0, note: "已停用" });
      try {
        const probe = await mcpProbeServer(s);
        // 「工具集合」服务器：用 mcp-tools 的 manifest/config 丰富每个工具（启用/描述/参数）
        if (s.name === "工具集合" || /:8771\b/.test(String(s.url || ""))) {
          const manifest = readJsonFileSafe(MCP_TOOLS_MANIFEST, null);
          const tcfg = readJsonFileSafe(MCP_TOOLS_CONFIG, {});
          const disabled = Array.isArray(tcfg.disabled) ? tcfg.disabled : [];
          const descs = (tcfg.descriptions && typeof tcfg.descriptions === "object") ? tcfg.descriptions : {};
          const schemas = (tcfg.schemas && typeof tcfg.schemas === "object") ? tcfg.schemas : {};
          const mtools = (manifest && Array.isArray(manifest.tools)) ? manifest.tools : [];
          const enriched = mtools.map(function (t) {
            const nm = t && t.name;
            const schema = schemas[nm] || (t && t.inputSchema) || null;
            const params = (schema && schema.properties && typeof schema.properties === "object") ? Object.keys(schema.properties) : [];
            return { name: nm, description: (descs[nm] != null ? descs[nm] : (t && t.description) || ""), enabled: disabled.indexOf(nm) < 0, params: params };
          }).filter(function (t) { return t.name; });
          return Object.assign(base, probe, { tools: enriched, toolCount: enriched.length, managedTools: true });
        }
        // 工具全部返回、逐个标 enabled（聊天端工具查看页按此渲染开关）：
        // allowTools 白名单外的 / blockTools 黑名单内的工具注入侧会被滤掉，这里标 enabled:false
        if (Array.isArray(probe.tools)) {
          const allow = Array.isArray(base.allowTools) ? base.allowTools : null;
          const block = Array.isArray(base.blockTools) ? base.blockTools : null;
          probe.tools = probe.tools.map((t) => Object.assign({}, t, {
            enabled: (!allow || allow.indexOf(t && t.name) >= 0) && (!block || block.indexOf(t && t.name) < 0)
          }));
          probe.toolCount = probe.tools.filter((t) => t.enabled !== false).length;
        }
        return Object.assign(base, probe);
      } catch (e) {
        return Object.assign(base, { connected: false, tools: [], toolCount: 0, error: String((e && e.message) || e) });
      }
    });
    const servers = await Promise.all(list);
    // 批注 2026-09-13（审查 S1）：headers 常含 Authorization token，不回明文——
    // 非空值置空并列入 headers_set，PUT 端空值按 id 从旧配置恢复（回传即保留）。
    const safeServers = servers.map(function (s) {
      if (!s || !s.headers || typeof s.headers !== "object") return s;
      const out = Object.assign({}, s, { headers: {} });
      const set = [];
      for (const k of Object.keys(s.headers)) {
        if (String(s.headers[k] || "").trim()) { out.headers[k] = ""; set.push(k); }
        else out.headers[k] = s.headers[k];
      }
      if (set.length) out.headers_set = set;
      return out;
    });
    reply.send({ ok: true, servers: safeServers, config_path: MCP_SERVERS_CONFIG });
  } catch (err) {
    console.error("[GET /admin/mcp/servers] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.put("/admin/mcp/servers", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const arr = Array.isArray(body.servers) ? body.servers : [];
    // 批注 2026-09-13（审查 S1）：GET 已不回明文 headers，客户端回传的空值视为「未改动」，
    // 按 id 从旧配置恢复非空值，避免脱敏回写把真实凭据抹掉。
    let _oldServers = [];
    try { _oldServers = (JSON.parse(fs.readFileSync(MCP_SERVERS_CONFIG, "utf-8")).servers) || []; } catch (e) {}
    const clean = arr.map(function (s) {
      const o = { id: String(s.id || ""), name: String(s.name || ""), type: String(s.type || "auto"), enabled: s.enabled !== false };
      if (s.url) o.url = String(s.url);
      if (s.command) o.command = String(s.command);
      if (Array.isArray(s.args)) o.args = s.args.map(String);
      if (s.headers && typeof s.headers === "object") {
        const old = _oldServers.find(function (x) { return x && x.id === o.id; });
        const merged = {};
        for (const k of Object.keys(s.headers)) {
          const v = String(s.headers[k] || "").trim();
          merged[k] = v ? v : String((old && old.headers && old.headers[k]) || "");
        }
        if (Object.keys(merged).some(function (k) { return String(merged[k] || "").trim(); })) o.headers = merged;
      }
      // 工具白名单：透传保留（mcp-service.loadTools 据此过滤注入给模型的工具）
      if (Array.isArray(s.allowTools)) o.allowTools = s.allowTools.map(String);
      // 工具级黑名单：透传保留（每工具开关，关闭的工具不注入模型）
      if (Array.isArray(s.blockTools)) o.blockTools = s.blockTools.map(String);
      return o;
    }).filter(function (s) { return s.id && s.name; });
    writeJsonFileAtomic(MCP_SERVERS_CONFIG, { servers: clean });
    _mcpClientsCache = null; // 强制下次重载
    reply.send({ ok: true, restart: "hot-reload", count: clean.length });
  } catch (err) {
    console.error("[PUT /admin/mcp/servers] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/admin/ai-providers", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    // 批注 2026-09-13（审查 S1）：api_key 不回明文，只回 api_key_set 布尔；PUT 端空值按 id 保留旧值。
    const providers = loadAiProviders().map(function (p) {
      if (!p || typeof p !== "object") return p;
      const has = !!(p.api_key && String(p.api_key).trim());
      return Object.assign({}, p, { api_key: "", api_key_set: has });
    });
    reply.send({ ok: true, providers: providers });
  } catch (err) {
    console.error("[GET /admin/ai-providers] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 2026-09-13 审查修复（前后端不对齐）：前端「自动导入心跳唤醒模型」此前期望从 /admin/env
// 拿 TARGET_API_KEY 明文，但该接口出于安全从不回密钥（响应结构也对不上），该功能自上线起
// 永不生效。改为后端专属端点：密钥不出服务器，前端只在供应商列表为空时触发导入。
app.post("/admin/ai-providers/import-heartbeat", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const list = loadAiProviders();
    if (list.length) { reply.send({ ok: true, imported: false, reason: "已有供应商，跳过导入" }); return; }
    const url = readEnvValue("TARGET_API_URL");
    const key = readEnvValue("TARGET_API_KEY");
    const model = readEnvValue("MODEL_NAME") || "deepseek-v4-flash-vision-exp";
    if (!url || !key) { reply.send({ ok: true, imported: false, reason: "缺少 TARGET_API_URL/TARGET_API_KEY 配置" }); return; }
    const prov = {
      id: "p_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name: model || "心跳唤醒模型", api_url: url, api_key: key, model: model, models: [model], enabled: true
    };
    saveAiProviders([prov]);
    console.log("[ai-providers] 已自动导入心跳唤醒模型作为聊天模型（model=" + model + "）");
    reply.send({ ok: true, imported: true });
  } catch (err) {
    console.error("[import-heartbeat] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

app.put("/admin/ai-providers", { preHandler: mcpManageAuth }, async (req, reply) => {  try {
    const arr = Array.isArray(req.body && req.body.providers) ? req.body.providers : [];
    // 批注 2026-09-13（审查 S1）：GET 已不回明文 api_key，客户端回传空值视为「未改动」，
    // 按 id 从旧配置恢复，避免脱敏回写抹掉真实凭据（也顺带修复「编辑不改 key 即被清空」）。
    const oldList = loadAiProviders();
    const clean = arr.map(function (p) {
      const o = { id: String(p.id || ""), name: String(p.name || ""), enabled: p.enabled !== false };
      if (p.api_url || p.base_url) o.api_url = String(p.api_url || p.base_url);
      if (p.api_key && String(p.api_key).trim()) {
        o.api_key = String(p.api_key);
      } else {
        const old = oldList.find(function (x) { return x && x.id === o.id && x.api_key; });
        if (old) o.api_key = String(old.api_key);
      }
      if (p.is_default === true || p.is_default === "true") o.is_default = true;
      if (p.profile && String(p.profile).trim()) o.profile = String(p.profile).trim();
      if (p.balance_url && String(p.balance_url).trim()) o.balance_url = String(p.balance_url).trim();
      let _models = [];
      if (Array.isArray(p.models)) _models = p.models.map(function(s){ return String(s).trim(); }).filter(Boolean);
      else if (p.model) _models = [String(p.model).trim()].filter(Boolean);
      if (_models.length) o.models = _models;
      if (p.model) o.model = String(p.model).trim();
      else if (_models.length) o.model = _models[0];
      else o.model = "";
      return o;
    }).filter(function (p) { return p.name && p.api_url; });
    saveAiProviders(clean);
    reply.send({ ok: true, restart: "hot-reload", count: clean.length });
  } catch (err) {
    console.error("[PUT /admin/ai-providers] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// ===== 供应商测试连接（2026-09-30）：GET /models 优先（零消耗），不支持则回退最小 chat 请求 =====
function provBaseOf(urlStr) {
  const u = String(urlStr || "").trim();
  if (!u) return "";
  // 去掉尾部路径（/chat/completions 或 /messages），得到基地址
  let b = u;
  if (b.endsWith("/chat/completions")) b = b.slice(0, -"/chat/completions".length);
  else if (b.endsWith("/messages")) b = b.slice(0, -"/messages".length);
  return b.replace(/\/+$/, "");
}
app.post("/admin/providers/test", { preHandler: mcpManageAuth }, async (req, reply) => {
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  let apiUrl = String(body.api_url || "").trim(), apiKey = String(body.api_key || "").trim(), model = String(body.model || "").trim();
  let profile = String(body.profile || "").trim() || "default";
  if (body.id) {
    const p = loadAiProviders().find(function (x) { return x && String(x.id) === String(body.id); });
    if (p) { apiUrl = String(p.api_url || ""); apiKey = String(p.api_key || ""); model = String(p.model || ""); profile = String(p.profile || "") || "default"; }
  }
  if (!apiUrl || !apiKey) return reply.code(400).send({ ok: false, error: "缺少 API 地址或 Key" });
  const base = provBaseOf(apiUrl);
  const started = Date.now();
  const lat = function () { return Date.now() - started; };
  try {
    if (profile === "claude") {
      // Anthropic 原生：POST {base}/v1/messages（x-api-key 头）
      const url = (base || apiUrl) + "/v1/messages";
      const ctrl = new AbortController(); const t = setTimeout(function(){ ctrl.abort(); }, 15000);
      const resp = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: model || "claude-3-5-sonnet-latest", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) });
      clearTimeout(t);
      if (resp.ok) return reply.send({ ok: true, latency_ms: lat(), note: "连通（Anthropic /v1/messages）" });
      const j = await resp.json().catch(function(){ return {}; });
      return reply.send({ ok: false, latency_ms: lat(), error: (j && (j.error && (j.error.message || j.error.type))) || ("HTTP " + resp.status) });
    }
    // OpenAI 兼容：先 GET /models（免费）
    try {
      const url = base + "/models";
      const ctrl = new AbortController(); const t = setTimeout(function(){ ctrl.abort(); }, 15000);
      const resp = await fetch(url, { method: "GET", signal: ctrl.signal, headers: { "Authorization": "Bearer " + apiKey } });
      clearTimeout(t);
      if (resp.ok) {
        const j = await resp.json().catch(function(){ return {}; });
        const n = (j && Array.isArray(j.data)) ? j.data.length : 0;
        return reply.send({ ok: true, latency_ms: lat(), note: "连通（GET /models" + (n ? "，拉取 " + n + " 个模型）" : "）") });
      }
    } catch (e) { /* 网络异常走 chat 回退 */ }
    // 回退最小 chat 请求
    const url = base + "/chat/completions";
    const ctrl = new AbortController(); const t = setTimeout(function(){ ctrl.abort(); }, 20000);
    const resp = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey }, body: JSON.stringify({ model: model || "default", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }) });
    clearTimeout(t);
    if (resp.ok) return reply.send({ ok: true, latency_ms: lat(), note: "连通（最小 chat 请求）" });
    const j = await resp.json().catch(function(){ return {}; });
    return reply.send({ ok: false, latency_ms: lat(), error: (j && (j.error && (j.error.message || j.error.type))) || ("HTTP " + resp.status) });
  } catch (err) {
    return reply.send({ ok: false, latency_ms: lat(), error: "请求失败：" + (err && err.name === "AbortError" ? "超时(15s)" : (err && err.message || err)) });
  }
});

// ===== 供应商余额查询（2026-09-30）：读 balance_url，兼容 DeepSeek / one-api 等格式 =====
function pickBalance(json) {
  if (json == null) return null;
  // DeepSeek 官方：{ balance_infos:[{total_balance, currency,...}] }
  if (Array.isArray(json.balance_infos) && json.balance_infos.length) {
    const b = json.balance_infos[0];
    return { balance: b.total_balance, currency: b.currency || "CNY" };
  }
  // one-api/new-api 系：{ balance, quota } 或 { data:{balance} }
  for (const k of ["balance", "total_balance", "amount", "balance_usd"]) {
    if (typeof json[k] === "number" || typeof json[k] === "string") {
      if (String(json[k]).trim() !== "") return { balance: json[k], currency: "USD" };
    }
  }
  if (json.data && typeof json.data === "object") {
    // Kimi 官方（2026-10-01 实测）：{code,data:{available_balance(元),cash_balance,...}}
    if (typeof json.data.available_balance === "number") return { balance: json.data.available_balance, currency: "CNY" };
    // OpenRouter（2026-10-01 实测）：{data:{limit_remaining,limit,usage,...}}——limit_remaining=剩余信用额度
    if (typeof json.data.limit_remaining === "number" && typeof json.data.limit === "number") return { balance: json.data.limit_remaining, currency: "USD" };
    return pickBalance(json.data);
  }
  return null;
}
app.post("/admin/providers/balance", { preHandler: mcpManageAuth }, async (req, reply) => {
  const body = (req.body && typeof req.body === "object") ? req.body : {};
  const id = String(body.id || "").trim();
  if (!id) return reply.code(400).send({ ok: false, error: "缺少供应商 id" });
  const p = loadAiProviders().find(function (x) { return x && String(x.id) === id; });
  if (!p) return reply.code(404).send({ ok: false, error: "供应商不存在" });
  // 2026-10-01：接受前端按类型预设传来的兜底余额接口（历史保存值被 PUT 副作用抹掉/从未填写时，列表按钮也能直接查）
  const bu = String((body.balance_url && String(body.balance_url).trim()) || p.balance_url || "").trim();
  if (!bu) return reply.send({ ok: false, error: "该供应商未配置余额接口" });
  if (!p.api_key) return reply.send({ ok: false, error: "供应商未配置 API Key" });
  const started = Date.now();
  try {
    const ctrl = new AbortController(); const t = setTimeout(function(){ ctrl.abort(); }, 15000);
    const resp = await fetch(bu, { method: "GET", signal: ctrl.signal, headers: { "Authorization": "Bearer " + String(p.api_key), "Accept": "application/json" } });
    clearTimeout(t);
    if (!resp.ok) return reply.send({ ok: false, error: "余额接口 HTTP " + resp.status });
    const j = await resp.json().catch(function(){ return {}; });
    const hit = pickBalance(j);
    if (hit) return reply.send({ ok: true, balance: hit.balance, currency: hit.currency, latency_ms: Date.now() - started });
    return reply.send({ ok: false, error: "无法解析余额（接口返回格式未知）", raw: JSON.stringify(j).slice(0, 300) });
  } catch (err) {
    return reply.send({ ok: false, error: "余额查询失败：" + (err && err.name === "AbortError" ? "超时(15s)" : (err && err.message || err)) });
  }
});

// ---- 按用途路由模型：列出所有用途当前选择 + 可用供应商/模型（供设置页渲染） ----
app.get("/admin/model-roles", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const providers = loadAiProviders().filter(function (p) {
      return p && p.enabled !== false && (p.api_url || p.base_url) && p.api_key;
    }).map(function (p) {
      return {
        id: p.id, name: p.name, is_default: p.is_default === true,
        models: Array.isArray(p.models) && p.models.length ? p.models : (p.model ? [p.model] : [])
      };
    });
    const rm = loadRoleModelsRaw();
    const out = {};
    Object.keys(KNOWN_MODEL_ROLES).forEach(function (role) {
      const e = rm[role] || {};
      const prov = e.provider_id ? providers.find(function (x) { return x.id === e.provider_id; }) : null;
      out[role] = {
        label: KNOWN_MODEL_ROLES[role],
        provider_id: e.provider_id || "",
        model: e.model || "",
        provider_name: prov ? prov.name : "",
        model_display: (prov && e.model) ? e.model : "（跟随聊天模型）"
      };
    });
    reply.send({ ok: true, roles: out, providers: providers });
  } catch (err) {
    console.error("[GET /admin/model-roles] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// 设置单个用途的模型（provider_id/model 均空 = 跟随全局聊天模型）
app.put("/admin/model-roles/:role", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const role = String(req.params.role || "");
    if (!KNOWN_MODEL_ROLES[role]) return reply.code(400).send({ error: "unknown role: " + role });
    const providerId = String((req.body && req.body.provider_id) || "").trim();
    const modelName = String((req.body && req.body.model) || "").trim();
    if (!saveRoleModel(role, { provider_id: providerId, model: modelName })) {
      return reply.code(400).send({ error: "save failed" });
    }
    reply.send({ ok: true, restart: "hot-reload" });
  } catch (err) {
    console.error("[PUT /admin/model-roles] error:", err.message);
    reply.code(500).send({ error: err.message });
  }
});

// ---- 语音服务（TTS 文字转语音；MiniMax t2a_v2）----
const VOICE_CONFIG = path.join(__dirname, "voice-config.json");
function loadVoiceConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(VOICE_CONFIG, "utf-8"));
    if (!c || typeof c !== "object") c = {};
  } catch (e) { c = {}; }
  return migrateVoiceConfig(c);
}
// 旧版单供应商扁平结构 -> 新版 providers[] 结构（兼容历史配置，迁移一次即稳定）
function migrateVoiceConfig(c) {
  if (c && Array.isArray(c.providers) && c.providers.length) return c;
  const v = c || {};
  const prov = {
    id: "vp_doubao",
    type: "doubao",
    name: v.name || "豆包",
    enabled: v.enabled !== false,
    api_key: v.api_key || "",
    api_base: v.api_base || "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
    resource_id: v.resource_id || "seed-tts-2.0",
    asr_resource_id: v.asr_resource_id || "volc.seedasr.sauc.duration",
    sample_rate: Number(v.sample_rate || 24000),
    audio_format: v.audio_format || "mp3",
    speed: Number(v.speed != null ? v.speed : 0),
    active_voice: v.speaker || v.voice_id || "",
    voices: Array.isArray(v.speakers) && v.speakers.length ? v.speakers.map(function (s) {
      return (typeof s === "string") ? { value: s, label: s } : s;
    }) : []
  };
  // 若旧配置明显是 MiniMax（api_base 指向 minimaxi 且无豆包 resource_id），转成 minimax 类型
  if (prov.api_base && /minimaxi\.com/i.test(prov.api_base) && !v.resource_id) {
    prov.type = "minimax";
    prov.tts_model = v.tts_model || "speech-2.6-turbo";
    prov.emotion = v.emotion || "calm";
    prov.vol = Number(v.vol != null ? v.vol : 1.0);
    prov.pitch = Number(v.pitch != null ? v.pitch : 0);
    prov.bitrate = Number(v.bitrate || 128000);
    prov.channels = Number(v.channels || 1);
    prov.sample_rate = Number(v.sample_rate || 32000);
  }
  return { enabled: v.enabled !== false, active_provider: v.active_provider || prov.id, providers: [prov] };
}
function saveVoiceConfig(cfg) { writeJsonFileAtomic(VOICE_CONFIG, cfg); }
// 取当前生效的语音供应商（活动且启用 -> 否则首个启用 -> 否则首个）
function resolveActiveVoiceProvider(cfg) {
  const ps = (cfg && Array.isArray(cfg.providers)) ? cfg.providers : [];
  let active = ps.find(function (p) { return p.id === cfg.active_provider && p.enabled !== false; });
  if (!active) active = ps.find(function (p) { return p.enabled !== false; });
  return active || (ps[0] || null);
}

app.get("/admin/voice-config", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    // 批注 2026-09-13（审查 S1）：api_key 不回明文，只回 api_key_set 布尔；PUT 端空值按 id 保留旧值。
    const cfg = loadVoiceConfig();
    if (Array.isArray(cfg.providers)) {
      cfg.providers = cfg.providers.map(function (p) {
        if (!p || typeof p !== "object") return p;
        const has = !!(p.api_key && String(p.api_key).trim());
        return Object.assign({}, p, { api_key: "", api_key_set: has });
      });
    }
    if (cfg.asr_api_key) { cfg.asr_api_key_set = true; delete cfg.asr_api_key; }
    reply.send({ ok: true, config: cfg });
  }
  catch (err) { reply.code(500).send({ error: err.message }); }
});

app.put("/admin/voice-config", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const b = req.body || {};
    // 批注 2026-09-13（审查 S1）：GET 已不回明文 api_key，客户端回传空值视为「未改动」，
    // 按 id 从旧配置恢复，避免脱敏回写抹掉真实凭据。
    const prevCfg = loadVoiceConfig();
    const prevProviders = Array.isArray(prevCfg.providers) ? prevCfg.providers : [];
    const clean = {
      enabled: b.enabled !== false,
      active_provider: String(b.active_provider || ""),
      providers: Array.isArray(b.providers) ? b.providers.map(function (p) {
        const pid = String(p.id || "");
        let apiKey = String(p.api_key || "").trim();
        if (!apiKey) {
          const old = prevProviders.find(function (x) { return x && String(x.id || "") === pid && x.api_key; });
          if (old) apiKey = String(old.api_key);
        }
        return {
          id: String(p.id || ("vp_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36))),
          type: (p.type === "minimax" || p.type === "openai") ? p.type : "doubao",
          name: String(p.name || (p.type === "minimax" ? "MiniMax" : (p.type === "openai" ? "OpenAI 兼容" : "豆包"))),
          enabled: p.enabled !== false,
          api_key: apiKey,
          api_base: String(p.api_base || ""),
          resource_id: String(p.resource_id || "seed-tts-2.0"),
          asr_resource_id: String(p.asr_resource_id || "volc.seedasr.sauc.duration"),
          sample_rate: Number(p.sample_rate || 24000),
          audio_format: String(p.audio_format || "mp3"),
          speed: Number(p.speed != null ? p.speed : 0),
          active_voice: String(p.active_voice || ""),
          voices: Array.isArray(p.voices) ? p.voices.map(function (v) {
            return { value: String(v.value || ""), label: String(v.label || v.value || "") };
          }) : [],
          tts_model: String(p.tts_model || "speech-2.6-turbo"),
          emotion: String(p.emotion || "calm"),
          vol: Number(p.vol != null ? p.vol : 1.0),
          pitch: Number(p.pitch != null ? p.pitch : 0),
          bitrate: Number(p.bitrate || 128000),
          channels: Number(p.channels || 1)
        };
      }) : []
    };
    if (!clean.active_provider && clean.providers.length) clean.active_provider = clean.providers[0].id;
    // 保留独立的豆包 ASR 配置（前端只回传 providers，别误清掉 asr_api_key/asr_resource_id）
    const curCfg = loadVoiceConfig();
    if (!clean.asr_api_key && curCfg.asr_api_key) clean.asr_api_key = curCfg.asr_api_key;
    if (!clean.asr_resource_id && curCfg.asr_resource_id) clean.asr_resource_id = curCfg.asr_resource_id;
    saveVoiceConfig(clean);
    reply.send({ ok: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 文字 → 语音（base64 mp3）。前端 POST JSON { text, speaker?, resource_id? }，返回 { ok, audio(base64), format }
// 供应商三支持：doubao=火山豆包（seed-tts，X-Api-Key）；minimax=t2a_v2；openai=OpenAI 兼容 /audio/speech（Bearer）。
app.post("/admin/tts", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const cfg = loadVoiceConfig();
    let p = resolveActiveVoiceProvider(cfg);
    // 试听覆盖：请求带 provider_id 时用指定供应商（编辑表单里试听非当前生效供应商的音色），
    // 找不到或已停用则忽略，回落当前生效。
    const reqPid = String((req.body && req.body.provider_id) || "");
    if (reqPid) {
      const ovP = (Array.isArray(cfg.providers) ? cfg.providers : []).find(function (x) { return x && x.id === reqPid && x.enabled !== false; });
      if (ovP) p = ovP;
    }
    if (!p || !p.api_key) return reply.code(400).send({ error: "未配置语音供应商 API Key" });
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return reply.code(400).send({ error: "内容为空" });
    const speaker = String((req.body && req.body.speaker) || p.active_voice || "").trim();
    const isDoubao = p.type === "doubao"; // 只按类型判定，避免 MiniMax 带 seed-* 资源ID被误判成豆包

    if (isDoubao) {
      // ---- 火山豆包 语音合成（seed-tts-2.0 / seed-icl-2.0）----
      const url = String(p.api_base || "https://openspeech.bytedance.com/api/v3/tts/unidirectional").replace(/\/$/, "");
      const sampleRate = Number(p.sample_rate || 24000);
      const enc = String(p.audio_format || "mp3");
      const speechRate = Number(p.speed != null ? p.speed : 0);
      const payload = {
        user: { uid: "dylan-heartbeat" },
        req_params: {
          text: text.slice(0, 1500),
          speaker: speaker || "zh_female_vv_uranus_bigtts",
          sample_rate: sampleRate,
          audio_params: { format: enc, speech_rate: speechRate }
        }
      };
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": p.api_key,
          "X-Api-Resource-Id": String(p.resource_id || "seed-tts-2.0"),
          "X-Api-Request-Id": (require("crypto").randomUUID ? require("crypto").randomUUID() : String(Date.now()))
        },
        body: JSON.stringify(payload)
      });
      const txt = await r.text();
      // 豆包 seed-tts 返回的是「分块流式」：多个 {"code":0,...,"data":"<base64片段>"} 拼接，最后 {"code":20000000,...,"data":null} 结束。
      // 需把所有 code==0 的 data 片段(base64)按顺序拼接成完整音频。
      let audio = "";
      if (!r.ok) {
        return reply.code(502).send({ error: "豆包TTS失败: HTTP " + r.status + " " + String(txt).slice(0, 200) });
      }
      const dataPat = /\{"code":0,"message":"[^"]*","data":"([^"]*)"\}/g;
      let mm;
      while ((mm = dataPat.exec(txt))) {
        audio += mm[1] || "";
      }
      if (!audio) {
        const errM = /"message":"([^"]*)"/.exec(txt);
        return reply.code(502).send({ error: "豆包TTS失败: " + String((errM && errM[1]) || "无音频返回").slice(0, 200) });
      }
      // audio 已是拼接好的 base64
      reply.send({ ok: true, audio: audio, format: enc || "mp3", sample_rate: sampleRate, extra: null, provider: p.name });
      return;
    }

    // ---- OpenAI 兼容 TTS（如 api.mosi.cn：POST {api_base}，Bearer 鉴权，体 {model,input,voice}，返回音频二进制）----
    if (p.type === "openai") {
      const url = String(p.api_base || "").replace(/\/$/, "");
      if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: "OpenAI 兼容供应商未配置接口地址（api_base 应为完整 /audio/speech 地址）" });
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.api_key },
        body: JSON.stringify({
          model: p.tts_model || "moss-tts-1.5-flash",
          input: text.slice(0, 1500),
          voice: speaker,
          response_format: p.audio_format || "mp3"
        })
      });
      if (!r.ok) {
        const errTxt = await r.text();
        return reply.code(502).send({ error: "TTS失败: HTTP " + r.status + " " + String(errTxt).slice(0, 200) });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return reply.code(502).send({ error: "TTS 失败: 无音频返回" });
      reply.send({ ok: true, audio: buf.toString("base64"), format: p.audio_format || "mp3", sample_rate: p.sample_rate || 24000, extra: null, provider: p.name });
      return;
    }

    // ---- MiniMax t2a_v2 ----
    const payload = {
      model: p.tts_model || "speech-2.8-turbo",
      text: text.slice(0, 1200),
      stream: false,
      voice_setting: {
        voice_id: speaker || "ttv-voice-2026070919184726-re9oBNKY",
        speed: p.speed != null ? p.speed : 0.8,
        vol: p.vol != null ? p.vol : 1.0,
        pitch: p.pitch != null ? p.pitch : 0
        // 不带 emotion：用户实测该情感参数效果假，情绪走文本内标记
      },
      audio_setting: {
        format: p.audio_format || "mp3",
        sample_rate: p.sample_rate || 32000,
        bitrate: p.bitrate || 128000,
        channel: p.channels != null ? p.channels : 1
      },
      pronunciation_dict: { tone: Array.isArray(p.pronunciation_tone) ? p.pronunciation_tone : [] },
      subtitle_enable: false
    };
    const base = (p.api_base || "https://api.minimaxi.com/v1").replace(/\/$/, "");
    const r = await fetch(base + "/t2a_v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + p.api_key },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    let audio = (j && j.data && j.data.audio) || "";
    if (!audio) return reply.code(502).send({ error: "TTS 失败: " + ((j && j.base_resp && j.base_resp.status_msg) || "unknown") });
    if (/^[0-9a-fA-F]+$/.test(audio) && audio.length % 2 === 0) {
      try { audio = Buffer.from(audio, "hex").toString("base64"); } catch (e) {}
    }
    reply.send({ ok: true, audio: audio, format: p.audio_format || "mp3", sample_rate: p.sample_rate || 32000, extra: (j && j.data && j.data.extra_info) || null, provider: p.name });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 文字 → 语音已在上方；这里是 语音 → 文字（豆包流式 ASR）
// 前端把 16kHz/单声道/16bit PCM WAV 以 base64 POST 上来，后端连豆包 bigmodel_nostream 识别。
// ASR 独立使用豆包 key（cfg.asr_api_key），不再复用"当前激活的 TTS 供应商"的 key。
app.post("/admin/asr", { preHandler: mcpManageAuth }, async (req, reply) => {
  try {
    const cfg = loadVoiceConfig();
    const p = resolveActiveVoiceProvider(cfg);
    const asrKey = (cfg && cfg.asr_api_key) || (p && p.api_key);
    if (!asrKey) return reply.code(400).send({ error: "未配置语音识别（豆包）API Key" });
    const b64 = String((req.body && (req.body.audio || req.body.data)) || "").trim();
    if (!b64) return reply.code(400).send({ error: "缺少音频数据" });
    let wavBytes;
    try { wavBytes = Buffer.from(b64, "base64"); } catch (e) { return reply.code(400).send({ error: "音频解码失败" }); }
    if (!wavBytes || wavBytes.length < 44) return reply.code(400).send({ error: "音频过短或格式错误" });

    const resourceId = String((req.body && req.body.resource_id) || (cfg && cfg.asr_resource_id) || (p && p.asr_resource_id) || "volc.seedasr.sauc.duration").trim();
    const text = await doubaoAsr.recognizeAsr(wavBytes, {
      token: asrKey,
      resourceId,
      uid: "dylan-heartbeat",
      segmentMs: 200,
      timeoutMs: 25000
    });
    if (!text) return reply.send({ ok: true, text: "" });
    reply.send({ ok: true, text });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

app.get("/admin/services", { preHandler: basicAuth }, async (req, reply) => {
  try {
    // 并行查状态，替代串行 execSync：后者会同步阻塞事件循环（9 个服务逐条跑，
    // systemd 异常时单条最多 20s，期间所有聊天/SSE/上游转发全部冻结）
    const { exec } = require("child_process");
    const runAsync = (cmd) => new Promise((resolve) => {
      exec(cmd, { encoding: "utf-8", timeout: 20000 }, (err, stdout) => {
        // systemctl is-active 对非活跃服务以非零退出码输出 "inactive"：以 stdout 为准（与原 execSync 口径一致），
        // 无 stdout 才退回错误消息
        const out = String(stdout || "").trim();
        resolve(out || (err ? String(err.message || "").trim() : ""));
      });
    });
    // pm2 型服务只跑一次 jlist，从进程表 JSON 解析状态（pm2 jlist 输出整表，逐条跑太浪费）
    const hasPm2 = MANAGED_SERVICES.some(s => s.type === "pm2");
    const [pm2Raw, ...statuses] = await Promise.all([
      hasPm2 ? runAsync("pm2 jlist") : Promise.resolve("[]"),
      ...MANAGED_SERVICES.map(function (svc) {
        if (svc.type === "systemd") return runAsync("systemctl is-active " + svc.name);
        if (svc.type === "pm2") return Promise.resolve("");
        return runAsync("ss -ltn 2>/dev/null | grep -c ':" + svc.port + " ' || true");
      })
    ]);
    let pm2List = [];
    try { pm2List = JSON.parse(pm2Raw || "[]"); } catch (e) {}
    const list = MANAGED_SERVICES.map(function (svc, i) {
      if (svc.type === "pm2") {
        const app = pm2List.find(p => p && p.name === svc.name);
        const status = app ? ((app.pm2_env && app.pm2_env.status) || "unknown") : "stopped";
        return { name: svc.name, label: svc.label, type: svc.type, status: status };
      }
      if (svc.type === "port") {
        const n = Number(statuses[i] || 0);
        const status = n > 0 ? "running" : "stopped";
        return { name: svc.name, label: svc.label, type: svc.type, status: status };
      }
      return { name: svc.name, label: svc.label, type: svc.type, status: statuses[i] || "unknown" };
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

// ========================
// 上下文压缩（分块预览 / 摘要生成 / 边界调整）
// ========================

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
    .replace(/<star\b[^>]*>(?:\s*<\/star\s*>)?/gi, "")
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
  // 多会话：记录显式按当前会话过滤（与 applyReplacements 套用、blocks 路由 manualRecordsSorted 同口径），
  // 不再只靠"锚点锚不到就跳过"的软隔离——跨会话内容撞键时其他会话的块会被误显示/误操作。
  const curSession = contextReplacements.getActiveSession() || "default";
  // 手工块序号单一来源：manualRecordsSorted()（按会话过滤+排序）的下标，
  // 预览中因锚点/窗口被跳过的块不占序号，避免后续块 blockIndex 漂移导致 blocks 路由错位。
  const manualOrdinals = new Map();
  contextReplacements.manualRecordsSorted().forEach(function (rec, i) { manualOrdinals.set(rec.id, i); });
  const records = contextReplacements.loadItems().filter(it => !it.removed && (!it.session || it.session === curSession));
  const items = contextReplacements.compressibleItems();
  const totalCompressible = items.length;
  const compactCount = totalCompressible;
  const timeline = contextReplacements.loadTimeline() || [];
  const nonSys = timeline.filter(m => m && m.role !== "system");
  // 当前窗口起点：旧窗口块不显示（首条锚点消息早于窗口起点的块视为不在当前时间线）
  const windowStartMs = contextReplacements.currentWindowStartMs(timeline);

  function keyOf(m) {
    return String(m.role || "") + "\u0000" + String(m.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  // 与发送侧 applyReplacements 同口径的归一化键，用于锚点定位（见模块级 nKeyOfMsg）
  const nKeyOf = nKeyOfMsg;
  // 压缩索引位置表：非特殊事件消息按归一化键定位（与发送侧 tlKeyToPos 同口径）
  const itemPosByKey = compressiblePosMap();
  // 消息 id -> 压缩下标：与发送侧同口径的 id 优先定位（id 唯一，不受内容编辑/位置漂移/短消息撞键影响）
  const idPosByKey = new Map();
  items.forEach(function (e, idx) {
    if (e && e.msg && e.msg.id != null && e.msg.id !== "") idPosByKey.set(String(e.msg.id), idx);
  });

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
    // 手工块：优先信任创建时落库的精确压缩索引（0 起）。锚点定位在块首尾含特殊事件、
    // 或短消息归一化后撞键（如「哥哥 <current_time>…」）时会漂移，导致块被削头尾或整块丢弃。
    // 但存储编号只在时间线未重建/未换窗口时有效：首条 matched 与同编号消息内容一致才信任，
    // 否则退回内容锚点定位，避免旧窗口块的编号漂移到新窗口消息上（与发送侧 recordCompRange 同口径）。
    const storedStart = it.range && it.range.start_index;
    const storedEnd = it.range && it.range.end_index;
    const hasStoredIdx = Number.isInteger(storedStart) && Number.isInteger(storedEnd);
    let storedValid = false;
    if (hasStoredIdx) {
      const m0 = matched[0];
      const atStart = items[storedStart];
      storedValid = !!(m0 && atStart && nKeyOf(m0) === nKeyOf(atStart.msg));
    }
    let compStart = -1;
    let compEnd = -1;
    if (hasStoredIdx && storedValid) {
      compStart = Math.max(0, storedStart);
      compEnd = Math.min(storedEnd, items.length - 1);
      if (compStart >= items.length || compEnd < compStart) return;
    } else {
      // id 精确匹配优先（与发送侧 applyReplacements 同口径）：matched 首尾带 id 且时间线可查时
      // 直接定位区间，内容搜索跳过——「哥哥」等高频短语内容撞键从根上消失。
      const sId = aStart && aStart.id != null && aStart.id !== "" ? String(aStart.id) : "";
      const eId = aEnd && aEnd.id != null && aEnd.id !== "" ? String(aEnd.id) : "";
      const kIdStart = sId ? idPosByKey.get(sId) : undefined;
      const kIdEnd = eId ? idPosByKey.get(eId) : undefined;
      if (kIdStart !== undefined && kIdEnd !== undefined && kIdEnd >= kIdStart) {
        compStart = kIdStart;
        compEnd = kIdEnd;
      } else {
        // id 查不到（第三方导入/旧记录未迁移）才回退内容锚点匹配。
        // 与发送侧 applyReplacements 同口径：用首/末条非特殊事件 matched 定位块边界。
        // 不整段扫描 matched，避免短消息归一化撞键（如「哥哥」）把旧窗口块错配到新窗口。
        const kStart = itemPosByKey.get(nKeyOf(aStart));
        if (kStart === undefined) return;
        compStart = kStart;
        let kEnd = itemPosByKey.get(nKeyOf(aEnd));
        if (kEnd === undefined) {
          for (let i = matched.length - 2; i >= 0; i--) {
            const m = matched[i];
            if (!m || m.role === "system" || contextReplacements.isSpecialEvent(m)) continue;
            kEnd = itemPosByKey.get(nKeyOf(m));
            if (kEnd !== undefined) break;
          }
        }
        if (kEnd === undefined || kEnd < compStart) return;
        compEnd = kEnd;
      }
      // 区间膨胀闸（与发送侧同口径）：首尾之一误匹配到远处重复内容时整块拒绝（发送侧同样不注入），
      // 显示为未覆盖区而不是假范围。
      if (matched.length > 0 && (compEnd - compStart + 1) > matched.length * 1.5 + 20) return;
    }
    // 窗口隔离：块首条消息的实际时间早于当前窗口起点 → 旧窗口块，不显示（发送侧同样不注入）
    if (windowStartMs !== null) {
      const firstMsg = items[compStart] && items[compStart].msg;
      const t = firstMsg ? contextReplacements.messageTime(firstMsg) : null;
      if (t && t.getTime() < windowStartMs) return;
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
      parsed: !!it.reparsed_at,          // 2026-09-28：该块已解析过（前端徽标显示蓝色「已解析」）
      parsedAt: it.reparsed_at || null,
      manualHidden: it.hidden === true,
      range_label: it.range_label || "",
      // 消息 id 边界（批量导入识别用）：首/尾非特殊压缩消息的自带 id，id 稳定不受内容编辑/位置漂移影响
      first_id: (aStart && aStart.id) ? String(aStart.id) : undefined,
      last_id: (aEnd && aEnd.id) ? String(aEnd.id) : undefined,
      original_preview: matched.slice(0, 2).map(m => ({ role: m.role, content: String(m.content || "").slice(0, 150) })),
      history: (Array.isArray(it.history) ? it.history : []).map(function (h, i) { return { index: i, summary: h.summary, generatedAt: h.generatedAt, mode: h.mode || (manual ? "edited" : "ai"), manual: h.manual === true || manual }; }).slice(0, 8),
      msgs: includeMessages ? matched.map((function () {
        // loadMarks 提到循环外：matched 数百条时逐条调用会放大读盘（现走缓存，仍省每条的重复调用）
        const _marks = contextReplacements.loadMarks ? contextReplacements.loadMarks() : {};
        return function (m, i) {
        const _key = contextReplacements.contentKey(m);
        // 手工块：编号=存储起点+块内序号（matched 与压缩切片一一对应），避免锚点撞键漂移；
        // 存储编号失效（换窗口）时退回内容锚点编号
        const _num = (hasStoredIdx && storedValid) ? (storedStart + i) : (itemPosByKey.has(nKeyOf(m)) ? itemPosByKey.get(nKeyOf(m)) : null);
        return { role: m.role, content: typeof m.content === "string" ? m.content : "", key: _key, marked: !!_marks[_key], num: _num, id: m && m.id ? String(m.id) : undefined };
        };
      })()) : undefined,
      pos: compStart
    });
  });

  chunks.sort(function (a, b) { return a.pos - b.pos; });
  chunks.forEach(function (c, i) { c.index = i + 1; c.pos = undefined; });

  // 隐藏块：与发送侧 applyReplacements 同口径——手动隐藏块标记 hidden，摘要与区间原文都不进上下文。
  // 2026-10-04：原先这里还有「活跃块上限」截断（previewMaxActive），随旧压缩系统一并下线。
  // 只剩手动隐藏这一条用户可控路径。
  let hiddenCount = 0;
  chunks.forEach(function (c) {
    if (c.manualHidden) { c.hidden = true; hiddenCount++; }
  });

  // 手工块序号：直接用 manualRecordsSorted()（按会话过滤+排序）的下标，与 blocks 路由同源；
  // 服务端保证每个通过会话过滤的手工 chunk 都能查到序号（records 与 manualRecordsSorted 过滤口径一致）
  chunks.forEach(function (c) {
    if (c.source === "manual") {
      const ord = manualOrdinals.get(c.id);
      if (ord !== undefined) c.blockIndex = ord;
    }
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

  // 「实际约」口径：已启用且有摘要的块计摘要字数；取消替换/未生成摘要的块与未覆盖区计原文
  // （与发送侧 applyReplacements「enabled!==false 且有摘要才套用」一致）；隐藏块不进上下文不计入
  const rangeChars = function (s, e) {
    let n = 0;
    for (let i = Math.max(0, s); i <= Math.min(items.length - 1, e); i++) n += String(items[i].msg.content || "").length;
    return n;
  };
  const estCompressedChars = chunks.reduce(function (s, c) {
    if (c.hidden) return s;
    if (c.enabled !== false && c.summary) return s + String(c.summary).length;
    return s + rangeChars(c.blockStart, c.blockEnd);
  }, 0) + gapRanges.reduce(function (s, g) { return s + rangeChars(g.start, g.end); }, 0);

  // 容量提醒 token 分解（2026-09-04 起，管理台展示用）：让用户看清"实际发送"里
  // 未覆盖积压 / 标星原句 / 置顶记忆（永久上下文）/ 图片 各占多少。
  // 均为估算（estimateTokens：中文≈1字/token，其余≈4字符/token；图片每张 EST_IMAGE_TOKENS）。
  const textToken = function (t) { return contextCompactor.estimateTokens(String(t || '')); };
  const rangeText = function (s, e) {
    let out = '';
    for (let i = Math.max(0, s); i <= Math.min(items.length - 1, e); i++) {
      const c = items[i] && items[i].msg && items[i].msg.content;
      if (typeof c === 'string') out += c;
    }
    return out;
  };
  const msgTextTokens = function (m) {
    if (!m) return 0;
    if (typeof m.content === 'string') return textToken(m.content);
    if (Array.isArray(m.content)) {
      let n = 0;
      for (const p of m.content) if (p && p.type === 'text') n += textToken(p.text);
      return n;
    }
    return 0;
  };
  const msgImageCount = function (m) {
    if (!Array.isArray(m.content)) return 0;
    return m.content.filter(function (p) { return p && (p.type === 'image' || p.type === 'image_url'); }).length;
  };
  let _previewMarks = {};
  try { _previewMarks = (contextReplacements.loadMarks && contextReplacements.loadMarks()) || {}; } catch (e) { _previewMarks = {}; }
  let markedTokens = 0, imageTokens = 0;
  (nonSys || []).forEach(function (m) {
    if (!m) return;
    try { if (_previewMarks[contextReplacements.contentKey(m)]) markedTokens += msgTextTokens(m); } catch (e) { /* 单条失败忽略 */ }
    imageTokens += msgImageCount(m) * contextCompactor.EST_IMAGE_TOKENS;
  });
  let pinnedTokens = 0;
  try { pinnedTokens = textToken(memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : ''); } catch (e) { pinnedTokens = 0; }
  const uncoveredTokens = gapRanges.reduce(function (s, g) { return s + textToken(rangeText(g.start, g.end)); }, 0)
    + chunks.filter(function (c) { return !c.hidden && !(c.enabled !== false && c.summary); })
        .reduce(function (s, c) { return s + textToken(rangeText(c.blockStart, c.blockEnd)); }, 0);
  const activeSummaryTokens = chunks.filter(function (c) { return !c.hidden && c.enabled !== false && c.summary; })
    .reduce(function (s, c) { return s + textToken(c.summary); }, 0);
  const estTotalTokens = uncoveredTokens + activeSummaryTokens + markedTokens + imageTokens + pinnedTokens;
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
      hiddenCount: hiddenCount,
      manualHiddenCount: chunks.filter(function (c) { return c.manualHidden; }).length,
      estSavedChars: Math.max(0, totalChars - estCompressedChars),
      estUncoveredTokens: uncoveredTokens,
      markedTokens: markedTokens,
      imageTokens: imageTokens,
      pinnedTokens: pinnedTokens,
      estTotalTokens: estTotalTokens
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

// 重要内容标记（恢复：前端按消息 key 标记，引擎 buildCompactionPrompt 会重点保留）
app.post("/admin/context-compaction/mark", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const key = String(body.key || "").trim();
  if (!key) return reply.code(400).send({ error: "key 无效" });
  try {
    // 标星时把原文一并传给 setMark 存进 marks 文件，
    // 跨窗口注入就能直接读原文，不再依赖回查时间线/替换池
    let content = String(body.content || "");
    let role = String(body.role || "").trim();
    if (!content.trim()) {
      content = "";
      try {
        const items = (contextReplacements.loadItems ? contextReplacements.loadItems() : []) || [];
      for (const it of items) {
        const matched = Array.isArray(it.matched) ? it.matched : [];
        for (const m of matched) {
          if (!m) continue;
          let k = null;
          try { k = contextReplacements.contentKey(m); } catch (e) {}
          if (k === key) {
            content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map(function(p){return p&&(p.text||p.content)||"";}).join("") : "");
            role = m.role || "";
            break;
          }
        }
        if (content) break;
      }
      } catch (e) { /* 查找失败不阻断标星 */ }
    }
    // 标星与记忆池完全拆开（I5，2026-09-12）：标星只做「原文保留在上下文」，
    // 不再自动写入记忆池；想存记忆走长按菜单「入池」或 AI 工具，池内去重兜底。
    const markRes = contextReplacements.setMark(key, body.marked === true, { content: content, role: role, msg_time: String(body.msg_time || "") });
    if (!markRes || markRes.ok === false) {
      return reply.code(400).send({ error: (markRes && markRes.error) || "标星失败" });
    }
    reply.send({ ok: true, key: key, marked: markRes.marked !== false });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 更新已标星消息正文（管理台"已标星消息"编辑）：只更新 content，保留角色与标星时间

// 容量提醒提示词（会话超上限时塞给 AI 的整条提醒；独立配置，与压缩提示词互不关联）
app.get("/admin/context-compaction/ctx-limit-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send({ template: contextCompactor.loadCtxLimitPrompt() });
  } catch (err) {
    reply.send({ error: err.message });
  }
});

app.post("/admin/context-compaction/ctx-limit-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = contextCompactor.saveCtxLimitPrompt(req.body && req.body.template);
    if (!r.ok) return reply.code(400).send({ error: r.message });
    reply.send({ ok: true, template: r.template });
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.delete("/admin/context-compaction/ctx-limit-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const r = contextCompactor.resetCtxLimitPrompt();
    reply.send(r);
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 块摘要的历史版本管理（恢复 / 删除某一份历史）。
// 2026-10-04 说明：旧压缩系统下线时一度把这两条一起删了，随后复核判定它们属「保留」侧——
// 存量旧块的摘要可能同时有现用版 + 若干历史版，用户要能翻回去或删掉某一份，
// 这与「生成新摘要」不是一回事（不调模型，只在已存档的版本之间切换）。
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

// ========================
// 会话状态机（2026-10-03 新增， lib/conversation-state.js）
//
// 与上面那套 /admin/context-compaction/* 是两条独立的路：老的仍是「块」语义（并列摘要），
// 新的是「状态」语义（每会话一份持续演化的状态）。阶段一两条并存，存量不动。
// 压缩页用 mode=state 时走这里，mode=block 时走老的那套。
// ========================

function _csSessionOf(req) {
  const q = req.query || {};
  const b = req.body || {};
  return String(q.session || q.session_id || b.session || b.session_id || "").trim();
}

app.get("/admin/conversation-state", { preHandler: basicAuth }, async (req, reply) => {
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  try {
    // 顺带回带候选状态：省得管理台再发一次请求就能同时拿到「当前状态 + 待确认候选」
    const st = conversationState.getState(sid);
    st.candidate = conversationState.getCandidate(sid);
    reply.send(st);
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// 丢弃某会话的待确认候选（用户不想要这份了；不调模型、不可恢复——要留着就点确认并入）
app.post("/admin/conversation-state/candidate/discard", { preHandler: basicAuth }, async (req, reply) => {
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  try {
    reply.send(conversationState.clearCandidate(sid));
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.get("/admin/conversation-state/version", { preHandler: basicAuth }, async (req, reply) => {
  const sid = _csSessionOf(req);
  const v = Number((req.query || {}).version);
  if (!sid || !Number.isInteger(v)) return reply.code(400).send({ error: "缺少 session 或 version" });
  try {
    reply.send(conversationState.getVersionText(sid, v));
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

// 预览：调 LLM 出候选状态 + 操作清单，**不落盘**。前端拿去做 diff 面板。
app.post("/admin/conversation-state/preview", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  try {
    const r = await conversationState.previewMerge({
      session: sid,
      start: body.start,
      end: body.end,
    });
    reply.send(r);
  } catch (err) {
    reply.code(400).send({ error: (err && err.message) || String(err) });
  }
});

// 确认并入：blocked 里列出的 remove 不生效（前端「阻止删除」）
app.post("/admin/conversation-state/commit", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  try {
    const r = conversationState.commitMerge({
      session: sid,
      state: body.state,
      ops: body.ops,
      blocked: body.blocked,
      start_msg: body.start_msg,
      end_msg: body.end_msg,
      range_label: body.range_label,
      label_start: body.label_start,
      label_end: body.label_end,
      count: body.count,
      source: body.source,
    });
    reply.send(r);
  } catch (err) {
    reply.code(400).send({ error: (err && err.message) || String(err) });
  }
});

// 手动改当前状态正文（2026-10-04）：直接覆盖当前版、保存即生效、不产生新版本。
// 与 undo 一样是破坏性写操作，但改的是正文不是状态记录——加同样的 confirm 闸，
// 避免「探测接口存在性」这类空 body 请求真的把状态正文清空。
app.post("/admin/conversation-state/edit", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  if (body.confirm !== true) {
    return reply.code(400).send({ error: "改写状态正文需要显式确认：请带 confirm:true（会直接覆盖当前版本的正文）" });
  }
  try {
    reply.send(conversationState.editStateText({ session: sid, text: body.text }));
  } catch (err) {
    reply.code(400).send({ error: (err && err.message) || String(err) });
  }
});

app.post("/admin/conversation-state/rollback", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  try {
    reply.send(conversationState.rollback({ session: sid, version: body.version }));
  } catch (err) {
    reply.code(400).send({ error: (err && err.message) || String(err) });
  }
});

// 撤销最后一次并入：覆盖区间退回，被吃掉的那段原文回到未覆盖区
//
// 2026-10-04 加 confirm 闸（1004-03 事故的根因修复）：
//   原实现只凭 URL 的 session_id 就能执行——一个空 body 的 POST 就会把整条状态删掉。
//   探测接口存在性（curl 空 body 看返回码）这种完全无害的操作，真的会删生产数据。
//   undo 删的是不可逆的东西（版本链虽保留，但用户视角状态直接消失），所以要求调用方
//   显式声明「我知道这会撤销」，前端在 confirm 弹窗通过后带 confirm:true。
app.post("/admin/conversation-state/undo", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const sid = _csSessionOf(req);
  if (!sid) return reply.code(400).send({ error: "缺少 session 参数" });
  if (body.confirm !== true) {
    return reply.code(400).send({ error: "撤销需要显式确认：请带 confirm:true（撤销会移除当前状态，被吃掉的那段原文回到未覆盖区）" });
  }
  try {
    reply.send(conversationState.undoLastMerge({ session: sid }));
  } catch (err) {
    reply.code(400).send({ error: (err && err.message) || String(err) });
  }
});

// 状态机提示词：读 / 存 / 恢复默认
app.get("/admin/conversation-state/prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send(conversationState.loadPromptConfig());
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

app.post("/admin/conversation-state/prompt", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  try {
    if (String(body.action || "") === "reset") {
      return reply.send(conversationState.resetPromptConfig());
    }
    reply.send(conversationState.savePromptConfig(body.system, body.user_template));
  } catch (err) {
    reply.code(400).send({ error: err.message });
  }
});

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
    // 移除指定手工块——优先按记录 id 精确命中（序号在预览到点击之间可能因块增删错位），
    // 未传 id 的旧前端回退 0-based 序号。内容退回未覆盖区。
    if (action === "remove_at") {
      const recId = String(body.id || "").trim();
      const r = recId
        ? contextReplacements.removeManualRecordById(recId)
        : (function () {
            const blockIndex = Number(body.blockIndex);
            if (!Number.isInteger(blockIndex) || blockIndex < 0) {
              return { ok: false, message: "blockIndex 必须是 >=0 的整数" };
            }
            return contextReplacements.removeManualRecord(blockIndex);
          })();
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "remove_at" });
    }
    // 按范围添加手工块 —— 2026-10-04 下线：压缩改由状态机承担，新块不再从「块」这条路产生。
    // 存量旧块照常工作（toggle/hide/remove_at/reset 都在），只是不能再新建。
    // 开关某块的替换（enabled）——优先按记录 id，旧前端回退序号
    if (action === "toggle") {
      const recId = String(body.id || "").trim();
      const enabled = body.enabled !== false;
      const r = recId
        ? contextReplacements.toggleManualRecordById(recId, enabled)
        : (function () {
            const blockIndex = Number(body.blockIndex);
            if (!Number.isInteger(blockIndex) || blockIndex < 0) {
              return { ok: false, message: "blockIndex 必须是 >=0 的整数" };
            }
            return contextReplacements.toggleManualRecord(blockIndex, enabled);
          })();
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "toggle", block: r.record });
    }
    // 手动隐藏/取消隐藏指定手工块（入池归档：摘要与区间原文都不再注入上下文，可随时取消恢复）——优先按记录 id
    if (action === "hide") {
      const recId = String(body.id || "").trim();
      const hidden = body.hidden === true;
      const r = recId
        ? contextReplacements.setManualRecordHiddenById(recId, hidden)
        : (function () {
            const blockIndex = Number(body.blockIndex);
            if (!Number.isInteger(blockIndex) || blockIndex < 0) {
              return { ok: false, message: "blockIndex 必须是 >=0 的整数" };
            }
            return contextReplacements.setManualRecordHidden(blockIndex, hidden);
          })();
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({ ok: true, action: "hide", block: r.record });
    }
    // 更新块边界（update_range / update_ai_range）—— 2026-10-04 下线：
    // 旧块的区间一旦被状态机并入吃掉就由状态接管，边界调整这条路随之关闭；
    // 存量块仍可 toggle（启停）/ hide / remove_at / reset。

    // 按时间间隔自动切分 —— 2026-10-04 起**只允许 dryRun**（只算切点不建块）：
    // 唯一在用的是状态机的「自动分块」按钮（admin-mobile.html），它要的是切点边界。
    // 建块模式下线：真建块会与状态记录的重叠断言打架，且压缩已不再走块语义。
    if (action === "split_range") {
      if (body.dryRun !== true) {
        return reply.code(400).send({ error: "自动分块已下线建块模式，只支持 dryRun（只算切点，供状态机并入用）" });
      }
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
        chunkMax: Number(body.chunkMax) || Number(ccCfg.compaction_chunk_max) || 160,
        dryRun: true
      });
      if (!r.ok) return reply.send({ ok: false, message: r.message });
      return reply.send({
        ok: true, action: "split_range", count: r.count, gapMinutes: gapMinutes,
        segments: r.segments || [],
        dryRun: true
      });
    }
    // 旧式自动分块操作已下线（统一替换）
    if (action === "add" || action === "remove" || action === "add_range" ||
        action === "update_range" || action === "update_ai_range") {
      return reply.send({ ok: false, message: "该操作已随旧压缩系统下线（2026-10-04）：压缩改由会话状态机承担，存量旧块仍可启停/隐藏/移除。" });
    }
    return reply.code(400).send({ error: "action 必须是 remove_at / toggle / hide / split_range(dryRun) / reset" });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 摘要生成：gap = 未覆盖区按范围新建手工记录并生成替换正文（默认不启用，需点「替换」才生效）；
// block = 已有手工记录重新生成正文
// 2026-09-02 起摘要生成/替换不再自动解析入池：入池统一由管理台手动触发
//（「解析入池」= LLM 提炼；「一键入池」= 摘要全文直接入库，均不自动跑）


// ---------------- 摘要生成日志（文件持久化，保留当天；重启不丢） ----------------
// 2026-09-29：原「最近 10 条」改「当天」——生成任务多时 10 条放不下（keh3 一次批量 35 块），
// 当天 00:00（服务器本地时区，+8）之后的条目全保留，跨天自动清出；已读角标逻辑不受影响（不清日志）。
const COMPACTION_LOG_FILE = path.join(__dirname, "data", "compaction_log.json");
function compactionLogDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function inCompactionLogDay(l) {
  try { return !!(l && new Date(l.time).getTime() >= compactionLogDayStart()); }
  catch (e) { return false; }
}
let compactionLogs = [];
try {
  const loaded = JSON.parse(fs.readFileSync(COMPACTION_LOG_FILE, "utf8"));
  if (Array.isArray(loaded)) compactionLogs = loaded.filter(inCompactionLogDay);
} catch (e) { compactionLogs = []; }
function persistCompactionLogs() {
  try { fs.writeFileSync(COMPACTION_LOG_FILE, JSON.stringify(compactionLogs.filter(inCompactionLogDay))); } catch (e) { /* 持久化失败不影响运行 */ }
}
function addCompactionLog(entry) {
  const now = new Date().toISOString();
  // 1003-25：防字符串入参（memory-summary/backfill 的 log 曾直接传字符串，
  // 被 Object.assign 按字符索引拆成 {"0":"[","1":"m"...} 垃圾，前端显示「未知操作进行中」）
  if (entry == null) return null;
  if (typeof entry !== "object") {
    entry = { label: "后台任务", status: "success", message: String(entry) };
  }
  // 2026-09-29 修复：带 id 的 entry 是"更新已有日志"（生成任务的 pending→success/error 翻状态），
  // 原实现总是 unshift 新建 → 同一次生成产生 pending+success 两条、且前端 trackedGenId 只匹配
  // logs[0]，多点几次生成后 id 错位 → 消息栏永远"进行中"。更新时原地替换并移到最前
  // （保持"最新状态"在 logs[0]），time 刷新为本次更新时间（前端显示完成时刻）。
  if (entry && entry.id) {
    const idx = compactionLogs.findIndex(function (l) { return l && l.id === entry.id; });
    if (idx >= 0) {
      const old = compactionLogs[idx];
      compactionLogs.splice(idx, 1);
      const merged = Object.assign({}, old, entry, { id: old.id, time: now });
      compactionLogs.unshift(merged);
      persistCompactionLogs();
      return merged;
    }
  }
  // 1004-12：调度启动日志去重——gateway 每次重启各模块都写一条，同一天同模块只保留一条（刷新时间不新增）
  if (entry.action === "system" && String(entry.message || "").indexOf("调度已启动") >= 0) {
    const prefix = String(entry.message || "").split("：")[0];
    const dup = compactionLogs.find(function (l) {
      return l && l.action === "system" && String(l.message || "").indexOf("调度已启动") >= 0 &&
        String(l.message || "").split("：")[0] === prefix;
    });
    if (dup) {
      dup.time = now;
      persistCompactionLogs();
      return dup;
    }
  }
  const log = Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), time: now }, entry);
  compactionLogs.unshift(log);
  compactionLogs = compactionLogs.filter(inCompactionLogDay);
  persistCompactionLogs();
  return log;
}

app.get("/admin/context-compaction/logs", { preHandler: basicAuth }, (req, reply) => {
  reply.send({ logs: compactionLogs, max: compactionLogs.length });
});


// 环境变量获取
app.get("/admin/env", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const diaryEntries = readDiaryEntries();
    // 2026-10-03：日记改 data/diary.json，字段 id/session/hidden/created_at/content
    const diaryData = diaryEntries.map(e => ({
      id: e.id, session: e.session,
      time: formatDateTimeInTimeZone(new Date(e.created_at), TIME_ZONE),
      content: e.content, hidden: e.hidden
    }));
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



// 小世界门户「留纸」页 API（2026-09-12）：与站点其它门户 API 同口径公开（单人流站点，nginx SSL 层）
app.get("/papers/api/list", async (req, reply) => {
  try {
    // 2026-10-03：留纸改 data/papers.json，接口按 id 点名
    const papers = require("./papers");
    const list = papers.listPapers().slice(0, 100).map(e => ({
      id: e.id, session: e.session, title: e.title, time: e.time
    }));
    reply.send({ papers: list });
  } catch (err) {
    console.error("[papers] 门户列表失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/papers/api/read", async (req, reply) => {
  try {
    const paperStore = require("./lib/paper-store");
    const e = paperStore.getEntry(__dirname, (req.query || {}).id);
    if (!e) return reply.code(404).send({ error: "纸不存在" });
    reply.send({ id: e.id, title: e.title, content: e.content });
  } catch (err) {
    console.error("[papers] 门户读取失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// ===== MCP 工具（tools_server.py）经内部接口读写留纸（2026-10-03）=====
// 写操作集中在网关单进程，避免多进程并发写 papers.json；鉴权由全局 /internal 钩子处理。
app.post("/internal/paper", async (req, reply) => {
  try {
    const body = req.body || {};
    const r = require("./papers").savePaper({
      content: body.content, title: body.title, sessionId: body.session_id,
    });
    if (!r || !r.ok) return reply.code(400).send({ error: (r && r.error) || "留纸失败" });
    reply.send({ success: true, id: r.id, title: r.title, chars: r.chars, time: r.time, session: r.session });
  } catch (err) {
    console.error("[internal/paper] 留纸失败:", err);
    reply.code(500).send({ error: err.message });
  }
});
// 读留纸：不带参=最近 10 张列表（id/标题/时间/会话）；带 id=N=那一张全文
app.get("/internal/paper/view", async (req, reply) => {
  try {
    const papers = require("./papers");
    const id = String((req.query || {}).id || "").trim();
    if (id) {
      const paperStore = require("./lib/paper-store");
      const e = paperStore.getEntry(__dirname, id);
      if (!e) return reply.code(404).send({ error: "纸不存在：id=" + id });
      // 1003-20：补创建时间（与列表同口径）
      const _tu = require("./time_utils");
      const _dp = _tu.getDatePartsInTimeZone(new Date(e.created_at), _tu.resolveTimeZone());
      return reply.send({ id: e.id, title: e.title, time: _dp.year + "-" + _dp.month + "-" + _dp.day + " " + _dp.hour + ":" + _dp.minute, content: String(e.content || "").trim() });
    }
    const list = papers.listPapers().slice(0, 10).map(e => ({
      id: e.id, title: e.title, time: e.time,
    }));
    reply.send({ papers: list, total: papers.listPapers().length,
      message: "带 id=编号 可看对应那张全文" });
  } catch (err) {
    console.error("[internal/paper/view] 读留纸失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 门户：谢的日记（2026-09-13 只读；2026-09-19 批6 D1 增隐藏状态与切换）
// 数据源 = diary/ 全目录（共享层 + 各会话目录），与跨窗口注入同一扫描口径但**不做日期边界**：
// 这是用户自己的阅览页，已隐藏篇置灰标出（hidden=true），可一键恢复；隐藏只影响注入给 AI。
// ========================
function xieDiaryAuth(req, reply, done) {
  // 门户日记口令门（2026-09-20）：Bearer GATEWAY_API_KEY / X-API-Key，或已登录管理台会话 cookie 放行
  const configuredKey = readEnvValue("GATEWAY_API_KEY");
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const headerKey = String(req.headers["x-api-key"] || "").trim();
  if (configuredKey && (bearer === configuredKey || headerKey === configuredKey)) return done();
  try {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.admin_session && validSessionToken(cookies.admin_session)) return done();
  } catch (e) {}
  reply.code(401).send({ error: "需要访问口令" });
}
// ===== MCP 工具（tools_server.py）经内部接口读写日记（2026-10-03）=====
// 写操作集中在网关单进程，避免多进程并发写 diary.json；鉴权由全局 /internal 钩子处理。
app.post("/internal/diary", async (req, reply) => {
  try {
    const body = req.body || {};
    const saved = diaryLib.appendDiaryEntry(body.content, body.session_id);
    // 2026-10-19：多返回新条目 id——tools_server.py 把它塞进工具回执，网关工具循环据此给
    // 时间线消息打 diary_id 外键（success 仍为布尔，旧判断不受影响）
    reply.send({ success: !!saved, id: (saved && saved.id) || undefined });
  } catch (err) {
    console.error("[internal/diary] 写日记失败:", err);
    reply.code(500).send({ error: err.message });
  }
});
// 读日记：只返回正文（自带「## 时间」头 = 时间+正文），不带会话编号/文件路径
app.get("/internal/diary/view", async (req, reply) => {
  try {
    const all = diaryStore.listEntries(__dirname).filter(e => !e.hidden);
    const date = String(req.query.date || "").trim();
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: "date 格式应为 YYYY-MM-DD" });
      const day = all.filter(e => {
        const p = getDatePartsInTimeZone(new Date(e.created_at), TIME_ZONE);
        return `${p.year}-${p.month}-${p.day}` === date;
      });
      if (!day.length) return reply.code(404).send({ error: "没有 " + date + " 的日记" });
      return reply.send({ date, content: day.map(e => String(e.content).trim()).join("\n\n") });
    }
    let count = 1;
    try { count = Math.max(1, Math.min(Number(req.query.count) || 1, 30)); } catch (e) {}
    const picked = all.slice(-count);
    return reply.send({
      entries: picked.map(e => ({ content: String(e.content).trim() })),
      count: picked.length,
      message: "共 " + all.length + " 篇日记，返回最近 " + picked.length + " 篇；带 date=YYYY-MM-DD 可看某天",
    });
  } catch (err) {
    console.error("[internal/diary/view] 读日记失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

app.get("/xie-diary/api/list", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    // 2026-10-03：日记改 data/diary.json，按 id 点名；list 回 id/session/hidden/created_at/content/vc
    const entries = diaryStore.listEntries(__dirname).slice().sort((a, b) => b.id - a.id).map(e => ({
      id: e.id, session: e.session, hidden: e.hidden, created_at: e.created_at,
      content: e.content, vc: countDiaryVersions(e.id)
    }));
    reply.send({ entries });
  } catch (err) {
    console.error("[xie-diary] 门户列表失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 小世界门户：切换某篇日记隐藏状态（2026-09-19 批6 D1）。与 /xie-diary/api/list 同级公开；
// 与已删的管理台 /admin/diary/hide（2026-09-20 清理）曾操作同一份 data/diary_hidden.json，语义=不参与跨窗口注入、可恢复。
app.post("/xie-diary/api/hide", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const e = diaryStore.getEntry(__dirname, body.id);
    if (!e) return reply.code(404).send({ error: "日记不存在：id=" + body.id });
    const wantHidden = body.hidden !== false;
    diaryStore.updateEntry(__dirname, e.id, { hidden: wantHidden });
    reply.send({ success: true, id: e.id, hidden: wantHidden });
  } catch (err) {
    console.error("[xie-diary] 切换隐藏失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// ========================
// 门户日记历史版本（2026-10-02；2026-10-03 改按日记 id 归档）
// 编辑保存前把整份旧内容另存一份 → 编辑不再是不可逆覆盖。
// 存 data/diary_versions/d<id>/v<ISO>.md：刻意不放在 diary 下，
// 不会被跨窗口注入扫到（文件名也不匹配日记正则，双保险）。
// ========================
const DIARY_VERSIONS_DIR = path.join(__dirname, "data", "diary_versions");
const DIARY_VERSION_MAX = 50;   // 每篇最多留 50 份，超出删最旧
function diaryVersionDir(id) { return path.join(DIARY_VERSIONS_DIR, "d" + id); }
function saveDiaryVersion(id, content) {
  const dir = diaryVersionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const name = "v" + new Date().toISOString().replace(/[:.]/g, "-") + ".md";
  fs.writeFileSync(path.join(dir, name), String(content == null ? "" : content), "utf-8");
  try {   // 超出上限删最旧
    const all = fs.readdirSync(dir).filter(n => /^v.+\.md$/.test(n)).sort();
    for (let i = 0; i < all.length - DIARY_VERSION_MAX; i++) fs.unlinkSync(path.join(dir, all[i]));
  } catch (e) {}
  return name;
}
function listDiaryVersions(id) {
  const dir = diaryVersionDir(id);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /^v.+\.md$/.test(n)); } catch (e) { return []; }
  const pad = (x) => String(x).padStart(2, "0");
  return names.sort().reverse().map((n) => {
    let time = n.slice(1, -3), chars = 0;
    try {
      const st = fs.statSync(path.join(dir, n));
      const d = new Date(st.mtimeMs);
      time = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " "
           + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } catch (e) {}
    try { chars = fs.readFileSync(path.join(dir, n), "utf-8").length; } catch (e) {}
    return { ts: n, time, chars };
  });
}
function countDiaryVersions(id) {
  try { return fs.readdirSync(diaryVersionDir(id)).filter(n => /^v.+\.md$/.test(n)).length; } catch (e) { return 0; }
}
function findDiaryVersion(id, ts) {
  const n = String(ts || "");
  if (!/^v[A-Za-z0-9_.:-]+\.md$/.test(n)) return null;    // 防目录穿越
  const dir = diaryVersionDir(id);
  const full = path.join(dir, n);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return fs.existsSync(full) ? { full, name: n } : null;
}
// 门户：编辑日记（2026-09-20；2026-10-03 改 id + 只提交正文，头行按 created_at 保持）。
app.post("/xie-diary/api/update", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const e = diaryStore.getEntry(__dirname, body.id);
    if (!e) return reply.code(404).send({ error: "日记不存在：id=" + body.id });
    const newText = String(body.text === undefined ? "" : body.text).trim();
    if (!newText) return reply.code(400).send({ error: "正文不能为空" });
    // 落盘前把整份旧内容另存为历史版本（编辑不再是不可逆覆盖）
    try { saveDiaryVersion(e.id, e.content); }
    catch (ve) { console.error("[xie-diary] 保存历史版本失败:", ve.message); }
    // 头行保持 created_at 的本地时间（与原格式一致），正文替换
    const p = getDatePartsInTimeZone(new Date(e.created_at), TIME_ZONE);
    const newContent = `## ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}\n\n${newText}\n`;
    diaryStore.updateEntry(__dirname, e.id, { content: newContent });
    // 2026-10-19：按 diary_id 外键同步时间线（syncedEvents 字段保留 = 同步条数，旧前端字段兼容）
    const sync = syncDiaryTimelineMessages(e.session, e.id, diaryLib.wrapDiaryTag(newText));
    reply.send({ success: true, id: e.id, syncedEvents: sync.patched, timelineMissing: sync.missing, chars: newContent.length });
  } catch (err) {
    console.error("[xie-diary] 编辑日记失败:", err);
    reply.code(500).send({ error: err.message });
  }
});

// 门户：某篇日记的历史版本列表（2026-10-02；2026-10-03 改 id）。只回时间与字数，不回正文。
app.get("/xie-diary/api/versions", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    const e = diaryStore.getEntry(__dirname, req.query.id);
    if (!e) return reply.code(404).send({ error: "日记不存在：id=" + req.query.id });
    reply.send({ versions: listDiaryVersions(e.id) });
  } catch (err) {
    console.error("[xie-diary] 版本列表失败:", err);
    reply.code(500).send({ error: err.message });
  }
});
// 门户：某个历史版本的正文（点「查看」时才取，避免列表一次拉几十份全文）
app.get("/xie-diary/api/version", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    const e = diaryStore.getEntry(__dirname, req.query.id);
    if (!e) return reply.code(404).send({ error: "日记不存在：id=" + req.query.id });
    const v = findDiaryVersion(e.id, req.query.ts);
    if (!v) return reply.code(404).send({ error: "历史版本不存在" });
    reply.send({ content: fs.readFileSync(v.full, "utf-8") });
  } catch (err) {
    console.error("[xie-diary] 版本正文失败:", err);
    reply.code(500).send({ error: err.message });
  }
});
// 门户：把某篇日记恢复到指定历史版本（2026-10-02；2026-10-03 改 id）。
// 恢复前先把「当前内容」存为一个新版本 —— 恢复本身也可逆，永不丢内容。
app.post("/xie-diary/api/restore", { preHandler: xieDiaryAuth }, async (req, reply) => {
  try {
    const body = req.body || {};
    const e = diaryStore.getEntry(__dirname, body.id);
    if (!e) return reply.code(404).send({ error: "日记不存在：id=" + body.id });
    const v = findDiaryVersion(e.id, body.ts);
    if (!v) return reply.code(404).send({ error: "历史版本不存在" });
    saveDiaryVersion(e.id, e.content);
    const old = fs.readFileSync(v.full, "utf-8");
    diaryStore.updateEntry(__dirname, e.id, { content: old });
    // 2026-10-19：按 diary_id 外键同步时间线（恢复的正文剥掉「## 时间」头行后重包裹）
    const sync = syncDiaryTimelineMessages(e.session, e.id, diaryLib.wrapDiaryTag(diaryBodyOnly(old)));
    reply.send({ success: true, id: e.id, chars: old.length, syncedEvents: sync.patched, timelineMissing: sync.missing });
  } catch (err) {
    console.error("[xie-diary] 恢复历史版本失败:", err);
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
app.get("/admin/mobile.css", async (req, reply) => {
  reply.type("text/css").header("Cache-Control", "no-store, no-cache, must-revalidate").send(require("fs").readFileSync(path.join(__dirname, "admin-mobile.css"), "utf-8"));
});
app.get("/admin/mobile.js", async (req, reply) => {
  reply.type("application/javascript").header("Cache-Control", "no-store, no-cache, must-revalidate").send(require("fs").readFileSync(path.join(__dirname, "admin-mobile.js"), "utf-8"));
});

// ========================
// 日志与上下文查看 API
// ========================

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

// 「回看已替换历史摘要」整理提示词（context_digest；data/context_digest_prompt.json 覆盖默认模板）
app.get("/admin/logs/context-digest-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    reply.send({ text: contextDigest.loadPromptTemplate() });
  } catch (err) {
    reply.send({ text: "", error: err.message });
  }
});

app.post("/admin/logs/context-digest-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return reply.code(400).send({ error: "内容不能为空" });
    if (text.indexOf("${instruction}") === -1 || text.indexOf("${materials}") === -1) {
      return reply.code(400).send({ error: "模板必须包含 ${instruction} 与 ${materials} 两个占位符" });
    }
    atomicWriteFileSync(contextDigest.PROMPT_FILE, JSON.stringify({ template: text }, null, 2) + "\n");
    reply.send({ ok: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

// 恢复默认（删自定义模板文件，回落内置默认）
app.delete("/admin/logs/context-digest-prompt", { preHandler: basicAuth }, async (req, reply) => {
  try {
    fs.rmSync(contextDigest.PROMPT_FILE, { force: true });
    reply.send({ ok: true });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});
// 1005 补回：永久注入上下文（pinned memories）CRUD
app.get("/admin/logs/pinned", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const list = engine.getPinnedMemories ? engine.getPinnedMemories() : [];
    reply.send({ list });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/logs/pinned", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const { title, content, order } = req.body || {};
    const mem = await engine.addPinnedMemory({ title, content, order }, { allowDeleted: true });
    reply.send({ success: true, memory: mem });
  } catch (err) { reply.code(500).send({ error: err.message }); }
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
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/logs/pinned/reorder", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const ids = (req.body || {}).ids;
    const list = await engine.reorderPinnedMemory(ids);
    if (!list) return reply.code(400).send({ error: "无效的排序数据" });
    reply.send({ success: true, list });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.delete("/admin/logs/pinned/:id", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const engine = require("./memory-engine");
    const ok = await engine.deletePinnedMemory(req.params.id);
    reply.send({ ok });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 1005 补回：最后一次发给 LLM 的完整上下文
app.get("/admin/logs/context", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (!lastLLMMessages) { reply.send({ messages: [], total: 0, captureTime: null }); return; }
    const messages = lastLLMMessages.map(m => {
      if (m.role === "_divider") return { role: "_divider", content: m.content };
      return { role: m.role, content: m.content, images: m.images, attachments: m.attachments, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id };
    });
    reply.send({ messages, total: messages.length, captureTime: lastLLMCaptureTime });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
// 1005 补回：标星列表（含 in_context 标记）
app.get("/admin/context-compaction/marked-list", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const res = contextReplacements.listMarked();
    try {
      const norm = function (s) { return String(s || "").toLowerCase().replace(/\s+/g, ""); };
      let captureText = "";
      if (Array.isArray(lastLLMMessages)) {
        captureText = lastLLMMessages.map(function (m) {
          const c = m && m.content;
          if (typeof c === "string") return c;
          if (Array.isArray(c)) return c.map(function (p) { return (p && typeof p.text === "string") ? p.text : ""; }).join("");
          return "";
        }).join("\n");
        captureText = norm(captureText);
      }
      if (captureText) {
        (res.results || []).forEach(function (r) {
          const full = norm(r.content);
          if (!full) { r.in_context = false; return; }
          const probe = full.length > 100 ? full.slice(0, 100) : full;
          r.in_context = captureText.indexOf(probe) >= 0;
        });
      } else {
        (res.results || []).forEach(function (r) { r.in_context = false; });
      }
    } catch (e) {
      (res.results || []).forEach(function (r) { if (r.in_context === undefined) r.in_context = false; });
    }
    reply.send(res);
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.post("/admin/context-compaction/marked/update", { preHandler: basicAuth }, async (req, reply) => {
  const body = req.body || {};
  const key = String(body.key || "").trim();
  const content = String(body.content || "").trim();
  if (!key) return reply.code(400).send({ error: "key 无效" });
  if (!content) return reply.code(400).send({ error: "正文内容不能为空" });
  try {
    const r = contextReplacements.updateMark(key, { content: content });
    if (!r.ok) return reply.code(400).send({ error: r.error || "更新失败" });
    reply.send({ ok: true, content: r.content });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 1005 补回：唤醒日志
app.get("/admin/logs/wake-up", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const lines = parseInt(req.query.lines) || 200;
    const logPath = process.env.WAKE_UP_LOG_PATH || "/root/.pm2/logs/gateway-out.log";
    try {
      let raw = "";
      try {
        const st = fs.statSync(logPath);
        const readBytes = Math.min(st.size, 3 * 1024 * 1024);
        const buf = Buffer.alloc(readBytes);
        const fd = fs.openSync(logPath, "r");
        try { fs.readSync(fd, buf, 0, readBytes, st.size - readBytes); } finally { fs.closeSync(fd); }
        raw = buf.toString("utf-8");
        if (readBytes < st.size) raw = raw.slice(raw.indexOf("\n") + 1);
      } catch (e) {
        raw = fs.readFileSync(logPath, "utf-8");
      }
      const allLines = raw.split("\n").filter(l => l.trim());
      const KEEP = ["开始自动唤醒", "====", "[wake-scheduler]", "[wake-chat]", "[diary]"];
      const DROP = ["块已落盘", "直连完成", "已设定定时唤醒", "唤醒周期已重置",
        "唤醒调度器已在 gateway 内启动", "wake_completion_forward", "Wake Result",
        "[tag-parser]", "[wake-event]"];
      const filtered = allLines.filter(l => KEEP.some(k => l.includes(k)) && !DROP.some(k => l.includes(k)));
      const tailLines = filtered.slice(-lines);
      reply.send({ lines: tailLines, total: filtered.length });
    } catch {
      reply.send({ lines: [], total: 0, error: "日志文件不存在" });
    }
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

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

// 推送（Bark / WebPush，与唤醒系统同一套配置）
// sessionId：目标会话（WebPush 通道按会话定向订阅；bark 忽略此字段）。
// 唤醒/告警类调用方必须传；后台回复类由 /v1/notify/reply-done 带入。
async function sendPushNotification({ title, body, sessionId } = {}) {
  // 15s 超时：Bark 对端挂起时不能卡住免打扰释放等调用方
  const pushController = new AbortController();
  const pushTimer = setTimeout(() => pushController.abort(), 15000);
  try {
    const provider = (readEnvValue("PUSH_PROVIDER") || "bark").trim().toLowerCase();
    if (provider === "webpush") {
      clearTimeout(pushTimer);
      return await require("./lib/webpush").sendToSession({ title, body, sessionId });
    }
    if (provider !== "bark") return { ok: false, reason: `不支持的 PUSH_PROVIDER：${provider}` };
    const barkKey = readEnvValue("BARK_KEY");
    if (!barkKey) return { ok: false, reason: "Bark Key 未配置" };
    const response = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, device_key: barkKey, icon: readEnvValue("CUSTOM_ICON_URL") }),
      signal: pushController.signal
    });
    const responseText = await response.text();
    let result = {};
    try { result = JSON.parse(responseText); } catch (e) {}
    if (!response.ok || (result.code && result.code !== 200)) {
      return { ok: false, reason: result.message || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "推送超时(15s)" : err.message };
  } finally {
    clearTimeout(pushTimer);
  }
}

// 前端在聊天页切后台时，AI 回复结束后调这个接口弹 Bark 通知
app.post("/v1/notify/reply-done", async (req, reply) => {
  try {
    const preview = String((req.body && req.body.preview) || "").trim();
    if (!preview) return reply.send({ ok: false, reason: "empty" });
    const sessionId = String((req.body && req.body.session_id) || "").trim() || "default";
    // 2026-09-26 用户拍板：通知不显示标题行，preview 全文作为正文（title 置空）
    const r = await sendPushNotification({ title: "", body: preview.slice(0, 200), sessionId });
    reply.send(r);
  } catch (e) { reply.code(500).send({ error: e.message }); }
});

// iOS 桌面 PWA 系统通知（WebPush 通道）：VAPID 公钥下发 + 订阅上报
// 鉴权走全局 /v1 hook（公网需 GATEWAY_API_KEY 或管理员登录态），与聊天页其他 /v1 接口同口径
app.get("/v1/push/vapid-public-key", async (req, reply) => {
  reply.send({ ok: true, publicKey: require("./lib/webpush").getPublicKey() });
});
app.post("/v1/push/subscribe", async (req, reply) => {
  const body = req.body || {};
  const r = require("./lib/webpush").upsertSubscription(body.session_id, body.subscription);
  if (!r.ok) return reply.code(400).send(r);
  reply.send(r);
});




// ======================== 聊天页设置云端同步 ========================
// 把 chat.html 的前端设置（api_key / system_prompt / cfg）整体存到服务器，
// 换浏览器输入同一 key 后自动拉取覆盖本地，保持一致。用 basicAuth（管理台会话 cookie 亦可）。
const CHAT_SETTINGS_FILE = path.join(__dirname, "chat-settings.json");
// 参数归属表：设置页(chat-settings.json.cfg)只该改「界面/聊天显示类」参数；凡属管理台专属的行为参数
// （记忆池/跨窗口注入/容量提醒/上下文上限/历史分页等）一律拒绝从设置页接口写入与下发，杜绝"同名摆设"假开关。
function consoleOwnedCfgKeys() {
  const blocked = new Set([
    // 容量提醒 / 上下文上限 / 历史分页：管理台唯一权威（设置页不显示假开关）
    "capacity_remind_enabled", "capacity_remind_threshold", "context_limit", "history_limit",
    "pagination", "history_pagination", "conversation_pagination", "max_history",
    // 记忆池 / 跨窗口注入：由控制台 /config 与 /memory-pool/config 管理
    "cross_inject_enabled", "cross_inject_diary", "cross_inject_diary_count", "cross_inject_diary_days",
    "cross_inject_memory", "cross_inject_memory_per_category", "cross_inject_push",
    "cross_inject_summary_days",
    // 记忆解析 / 清理 / 去重（reparse_enabled/warm/max_chars/max_items 已于 0928 删除，无功能读取点）
    "reparse_merge_max_chars",
    "reparse_system_prompt", "reparse_user_prompt",
    "clean_enabled", "clean_max_items", "clean_ref_dup_threshold", "clean_ref_threshold", "clean_ref_topk",
    "clean_system_prompt", "clean_temperature", "clean_user_prompt",
    "dedup_anchor_threshold", "dedup_cross_threshold", "dedup_threshold",
    "retrieval_top_k", "decay_days", "auto_pin_retrieval_count"
  ]);
  // 2026-09-28：V1 记忆池删除，不再从 memory_pool_config.json 运行时并入拦截键
  return blocked;
}
app.get("/admin/chat-settings", { preHandler: basicAuth }, async (req, reply) => {
  try {
    if (!fs.existsSync(CHAT_SETTINGS_FILE)) return reply.send({ ok: true, exists: false });
    const data = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, "utf-8")) || {};
    // api_key（GATEWAY key）不回明文：置空+api_key_set 布尔（2026-09-20 审查 P1-1 收尾）；
    // PUT 端空值视为「未改动」保留现值，脱敏回写不会抹掉真 key
    if (typeof data.api_key === "string") {
      data.api_key_set = !!data.api_key.trim();
      data.api_key = "";
    }
    if (data.cfg && typeof data.cfg === "object") {
      const blocked = consoleOwnedCfgKeys();
      const cleanCfg = {};
      for (const k of Object.keys(data.cfg)) if (!blocked.has(k)) cleanCfg[k] = data.cfg[k];
      data.cfg = cleanCfg;
    }
    reply.send({ ok: true, exists: true, data });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/chat-settings", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    // 以现文件为基合并（此前整份覆盖：PUT 不带 api_key/system_prompt 会把现值抹掉）；
    // api_key 空串=未改动，保留现值（配合 GET 脱敏回写协议）
    let clean = {};
    try { if (fs.existsSync(CHAT_SETTINGS_FILE)) clean = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, "utf-8")) || {}; } catch (e) { clean = {}; }
    if (!clean || typeof clean !== "object" || Array.isArray(clean)) clean = {};
    if (typeof body.api_key === "string" && body.api_key.trim()) clean.api_key = body.api_key;
    if (typeof body.system_prompt === "string") clean.system_prompt = body.system_prompt;
    if (body.cfg && typeof body.cfg === "object") {
      const blocked = consoleOwnedCfgKeys();
      const cfg = {};
      for (const k of Object.keys(body.cfg)) {
        if (blocked.has(k)) { console.warn("[chat-settings] 拦截管理台专属参数从设置页写入:", k); continue; }
        cfg[k] = body.cfg[k];
      }
      clean.cfg = cfg;
    }
    writeJsonFileAtomic(CHAT_SETTINGS_FILE, clean);
    reply.send({ ok: true, saved: true });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 会话改名映射跨设备同步（存 data/session-names.json）
const SESSION_NAMES_FILE = path.join(__dirname, "data", "session-names.json");
app.get("/admin/session-names", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let names = {};
    try { if (fs.existsSync(SESSION_NAMES_FILE)) names = JSON.parse(fs.readFileSync(SESSION_NAMES_FILE, "utf-8")) || {}; } catch (e) {}
    reply.send({ ok: true, names });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/session-names", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    fs.ensureDirSync(path.dirname(SESSION_NAMES_FILE));
    let names = {};
    try { if (fs.existsSync(SESSION_NAMES_FILE)) names = JSON.parse(fs.readFileSync(SESSION_NAMES_FILE, "utf-8")) || {}; } catch (e) { names = {}; }
    if (!names || typeof names !== "object" || Array.isArray(names)) names = {};
    const hasDelta = (body.set && typeof body.set === "object") || Array.isArray(body.unset);
    if (hasDelta) {
      // 新格式（2026-09-26 多端合并）：{ set: {会话: 名称}, unset: [会话...] } 按键合并，不做整表覆盖；
      // set/unset 均可单独出现（只改 / 只删），互不依赖
      if (body.set && typeof body.set === "object") {
        for (const k of Object.keys(body.set)) {
          const v = body.set[k];
          if (typeof v === "string") { if (v.trim()) names[k] = v.trim(); else delete names[k]; }
        }
      }
      if (Array.isArray(body.unset)) {
        for (const k of body.unset) { if (typeof k === "string") delete names[k]; }
      }
    } else if (body.names && typeof body.names === "object") {
      // 旧格式整表（兼容旧缓存页面）
      const clean = {};
      for (const k of Object.keys(body.names)) { if (typeof body.names[k] === "string") clean[k] = body.names[k]; }
      names = clean;
    }
    fs.writeFileSync(SESSION_NAMES_FILE, JSON.stringify(names, null, 2), "utf-8");
    reply.send({ ok: true, saved: true, count: Object.keys(names).length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 会话级人设（提示词备份）选择跨设备同步（存 data/session-prompts.json）
const SESSION_PROMPTS_FILE = path.join(__dirname, "data", "session-prompts.json");
app.get("/admin/session-prompts", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let prompts = {};
    try { if (fs.existsSync(SESSION_PROMPTS_FILE)) prompts = JSON.parse(fs.readFileSync(SESSION_PROMPTS_FILE, "utf-8")) || {}; } catch (e) {}
    reply.send({ ok: true, prompts });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/session-prompts", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    fs.ensureDirSync(path.dirname(SESSION_PROMPTS_FILE));
    let prompts = {};
    try { if (fs.existsSync(SESSION_PROMPTS_FILE)) prompts = JSON.parse(fs.readFileSync(SESSION_PROMPTS_FILE, "utf-8")) || {}; } catch (e) { prompts = {}; }
    if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) prompts = {};
    const hasDelta = (body.set && typeof body.set === "object") || Array.isArray(body.unset);
    if (hasDelta) {
      // 新格式（2026-09-26 多端合并）：{ set: {会话: 备份id}, unset: [会话...] } 按键合并，不做整表覆盖；
      // set/unset 均可单独出现（只改 / 只删），互不依赖
      if (body.set && typeof body.set === "object") {
        for (const k of Object.keys(body.set)) {
          const v = body.set[k];
          if (typeof v === "string") { if (v) prompts[k] = v; else delete prompts[k]; }
        }
      }
      if (Array.isArray(body.unset)) {
        for (const k of body.unset) { if (typeof k === "string") delete prompts[k]; }
      }
    } else if (body.prompts && typeof body.prompts === "object") {
      // 旧格式整表（兼容旧缓存页面）
      const clean = {};
      for (const k of Object.keys(body.prompts)) { if (typeof body.prompts[k] === "string") clean[k] = body.prompts[k]; }
      prompts = clean;
    }
    fs.writeFileSync(SESSION_PROMPTS_FILE, JSON.stringify(prompts, null, 2), "utf-8");
    reply.send({ ok: true, saved: true, count: Object.keys(prompts).length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 会话归档跨设备同步（存 data/session-archive.json）：归档=收纳（数据完整保留），
// 从主列表收进「归档」区；新消息落库自动取消归档回主列表。
const SESSION_ARCHIVE_FILE = path.join(__dirname, "data", "session-archive.json");
function readSessionArchive(){
  try{ if(fs.existsSync(SESSION_ARCHIVE_FILE)){ const v=JSON.parse(fs.readFileSync(SESSION_ARCHIVE_FILE,"utf-8"))||[]; if(Array.isArray(v)) return v.filter(function(s){return typeof s==="string"&&s;}); } }catch(e){}
  return [];
}
function writeSessionArchive(list){ try{ fs.ensureDirSync(path.dirname(SESSION_ARCHIVE_FILE)); fs.writeFileSync(SESSION_ARCHIVE_FILE, JSON.stringify(list,null,2),"utf-8"); }catch(e){} }
function unarchiveSession(sessionId){
  // 新消息落库 → 自动取消归档（归档会话回到主列表；多端由 loadSessions 拉取同步）
  const sid=String(sessionId||"").trim();
  if(!sid) return;
  const list=readSessionArchive();
  if(list.indexOf(sid)<0) return;
  writeSessionArchive(list.filter(function(x){return x!==sid;}));
  console.log(`[session-archive] 会话 ${sid} 有新消息，自动取消归档`);
}
app.get("/admin/session-archive", { preHandler: basicAuth }, async (req, reply) => {
  try { reply.send({ ok: true, archived: readSessionArchive() }); }
  catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/session-archive", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    let arch = readSessionArchive();
    if (Array.isArray(body.add) || Array.isArray(body.remove)) {
      const add = Array.isArray(body.add) ? body.add.filter(function (s2) { return typeof s2 === "string" && s2; }) : [];
      const remove = Array.isArray(body.remove) ? body.remove.filter(function (s2) { return typeof s2 === "string" && s2; }) : [];
      for (const s2 of add) { if (arch.indexOf(s2) < 0) arch.push(s2); }
      arch = arch.filter(function (s2) { return remove.indexOf(s2) < 0; });
    } else if (Array.isArray(body.archived)) {
      arch = body.archived.filter(function (s2) { return typeof s2 === "string" && s2; });
    }
    writeSessionArchive(arch);
    reply.send({ ok: true, saved: true, count: arch.length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
// 会话置顶跨设备同步（存 data/session-pins.json）
const SESSION_PINS_FILE = path.join(__dirname, "data", "session-pins.json");
app.get("/admin/session-pins", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let pins = [];
    try { if (fs.existsSync(SESSION_PINS_FILE)) { const v = JSON.parse(fs.readFileSync(SESSION_PINS_FILE, "utf-8")) || []; if (Array.isArray(v)) pins = v; } } catch (e) {}
    reply.send({ ok: true, pins });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/session-pins", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    fs.ensureDirSync(path.dirname(SESSION_PINS_FILE));
    let pins = [];
    try { if (fs.existsSync(SESSION_PINS_FILE)) { const v = JSON.parse(fs.readFileSync(SESSION_PINS_FILE, "utf-8")) || []; if (Array.isArray(v)) pins = v; } } catch (e) { pins = []; }
    if (Array.isArray(body.add) || Array.isArray(body.remove)) {
      // 新格式（2026-09-26 多端合并）：{ add: [会话], remove: [会话] } 逐项合并，不做整表覆盖
      const add = Array.isArray(body.add) ? body.add.filter(function (s) { return typeof s === "string" && s; }) : [];
      const remove = Array.isArray(body.remove) ? body.remove.filter(function (s) { return typeof s === "string" && s; }) : [];
      for (const s2 of add) { if (pins.indexOf(s2) < 0) pins.push(s2); }
      pins = pins.filter(function (s2) { return remove.indexOf(s2) < 0; });
    } else if (Array.isArray(body.pins)) {
      // 旧格式整表（兼容旧缓存页面）
      pins = body.pins.filter(function (s2) { return typeof s2 === "string" && s2; });
    }
    fs.writeFileSync(SESSION_PINS_FILE, JSON.stringify(pins, null, 2), "utf-8");
    reply.send({ ok: true, saved: true, count: pins.length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 会话锁定唤醒（存 data/wake-locked.json）：唤醒进程只对这些会话各自独立计时并唤醒；置顶时可选一并锁定，取消置顶即解锁
const WAKE_LOCKED_FILE = path.join(__dirname, "data", "wake-locked.json");
app.get("/admin/wake-locked", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let sessions = [];
    try { if (fs.existsSync(WAKE_LOCKED_FILE)) { const v = JSON.parse(fs.readFileSync(WAKE_LOCKED_FILE, "utf-8")) || []; if (Array.isArray(v)) sessions = v; } } catch (e) {}
    reply.send({ ok: true, sessions });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/wake-locked", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const sessions = (body.sessions && Array.isArray(body.sessions)) ? body.sessions.filter(function (s) { return typeof s === "string" && s; }) : [];
    // 2026-09-13 审查修复：改原子写——裸 writeFileSync 的写盘窗口被唤醒侧读到半截 JSON 时，
    // readWakeLockedSessions 解析失败返回空，当轮唤醒（含到期显式闹钟）整体静默停摆
    writeJsonFileAtomic(WAKE_LOCKED_FILE, sessions);
    reply.send({ ok: true, saved: true, count: sessions.length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 会话分支父级跨设备同步（存 data/session-branches.json）
const SESSION_BRANCHES_FILE = path.join(__dirname, "data", "session-branches.json");
app.get("/admin/session-branches", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let branches = {};
    try { if (fs.existsSync(SESSION_BRANCHES_FILE)) branches = JSON.parse(fs.readFileSync(SESSION_BRANCHES_FILE, "utf-8")) || {}; } catch (e) {}
    reply.send({ ok: true, branches });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/session-branches", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    fs.ensureDirSync(path.dirname(SESSION_BRANCHES_FILE));
    let branches = {};
    try { if (fs.existsSync(SESSION_BRANCHES_FILE)) branches = JSON.parse(fs.readFileSync(SESSION_BRANCHES_FILE, "utf-8")) || {}; } catch (e) { branches = {}; }
    if (!branches || typeof branches !== "object" || Array.isArray(branches)) branches = {};
    const normBranch = function (v) {
      if (!v || typeof v !== "object") return null;
      return { fromSession: String(v.fromSession || ""), fromIndex: (Number(v.fromIndex) >= 0) ? Number(v.fromIndex) : 0, createdAt: String(v.createdAt || "") };
    };
    const hasDelta = (body.set && typeof body.set === "object") || Array.isArray(body.unset);
    if (hasDelta) {
      // 新格式（2026-09-26 多端合并）：{ set: {会话: 分支父级}, unset: [会话...] } 按键合并，不做整表覆盖；
      // set/unset 均可单独出现（只改 / 只删），互不依赖
      if (body.set && typeof body.set === "object") {
        for (const k of Object.keys(body.set)) {
          const nv = normBranch(body.set[k]);
          if (nv) branches[k] = nv; else delete branches[k];
        }
      }
      if (Array.isArray(body.unset)) {
        for (const k of body.unset) { if (typeof k === "string") delete branches[k]; }
      }
    } else if (body.branches && typeof body.branches === "object") {
      // 旧格式整表（兼容旧缓存页面）
      const clean = {};
      for (const k of Object.keys(body.branches)) { const nv = normBranch(body.branches[k]); if (nv) clean[k] = nv; }
      branches = clean;
    }
    fs.writeFileSync(SESSION_BRANCHES_FILE, JSON.stringify(branches, null, 2), "utf-8");
    reply.send({ ok: true, saved: true, count: Object.keys(branches).length });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

// 当前会话跨设备同步（存 data/current-session.json；单用户最后打开的会话）
const CURRENT_SESSION_FILE = path.join(__dirname, "data", "current-session.json");
app.get("/admin/current-session", { preHandler: basicAuth }, async (req, reply) => {
  try {
    let cur = null;
    try { if (fs.existsSync(CURRENT_SESSION_FILE)) cur = JSON.parse(fs.readFileSync(CURRENT_SESSION_FILE, "utf-8")); } catch (e) {}
    reply.send({ ok: true, session: (cur && cur.session) || "", updatedAt: (cur && cur.updatedAt) || "" });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});
app.put("/admin/current-session", { preHandler: basicAuth }, async (req, reply) => {
  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const sid = String(body.session || "").trim();
    if (!sid) return reply.code(400).send({ error: "session 不能为空" });
    fs.ensureDirSync(path.dirname(CURRENT_SESSION_FILE));
    fs.writeFileSync(CURRENT_SESSION_FILE, JSON.stringify({ session: sid, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
    reply.send({ ok: true, saved: true, session: sid });
  } catch (err) { reply.code(500).send({ error: err.message }); }
});

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

// 唤醒原始日志（wake-up 独立进程的 pm2 日志尾读）：2026-09-15 进程退役后日志不再增长，
// 仅剩历史排查价值；路径可经 WAKE_UP_LOG_PATH 覆盖

// ========================
// 启动服务
// ========================
// ========================
// 初始化记忆引擎
// ========================
const tagParser = require("./tag-parser");
const memoryEngine = require("./memory-engine");

require("./memory-engine").init().then(() => {
  console.log("[memory] 记忆引擎就绪");
}).catch(err => {
  console.error("[memory] 记忆引擎初始化失败:", err.message);
});

// 2026-09-28：V1 记忆池删除——memory-pool require/init/shutdown 全部移除
// （memory-engine 空壳 shutdown 已于 1335d36 删除；退出仅保留 V2 记忆闪存兜底）
process.on("SIGINT", async () => {
  process.exit(0);
});
process.on("SIGTERM", async () => {
  process.exit(0);
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Gateway 运行在 ${address}`);
  // 消息向量后台预热（embed-server 就绪通常更快，等 15s 避开启动高峰；失败由检索时惰性补算兜底）
  setTimeout(() => {
    try { contextReplacements.startMsgVectorWarmup(); } catch (e) { console.warn("[context-search] 向量预热启动失败:", e.message); }
  }, 15000);
  // 批3收尾（2026-09-15）：wake-up 独立进程退役，唤醒调度器在 gateway 内启动。
  // 心跳不再 HTTP 自环自拍，直接置位（管理台在线状态同源）；调度器周期检查时持续刷新。
  setTimeout(() => {
    try {
      wakeScheduler.start();
      wakeUpLastHeartbeat = Date.now();
      try { if (memoryDistill) memoryDistill.start(); } catch (e) { console.error("[memory-distill] 启动失败:", e && e.message); }
      try { if (memorySummary) memorySummary.start(); } catch (e) { console.error("[memory-summary] 启动失败:", e && e.message); }
      try { if (memoryBackfill) memoryBackfill.start(); } catch (e) { console.error("[memory-backfill] 启动失败:", e && e.message); }
      console.log('心跳状态已恢复');
    } catch (e) {
      console.error("[wake-scheduler] 启动失败:", e && e.message);
    }
  }, 3000);
});
