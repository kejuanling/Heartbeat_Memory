'use strict';
// 统一「自主唤醒调用器」（2026-09-15 唤醒并入网关）：
// 从会话时间线重建结构化上下文（与对话侧同一套加工函数：替换/容量提醒/工具记录转换/配对修复），
// 头部注入 developer [永久上下文]/[跨窗口]，末尾追加 developer [唤醒] 块（落盘），
// 走工具循环（失败回退直连）调模型，返回文本。
// 唤醒特有行为（Bark 推送/[NO_ACTION]/日记/<wake> 定时/写回时间线）仍由调用方负责，本模块不碰。
//
// role 法（2026-09-15 定稿；0920 起 V2 开启时上下文与聊天侧完全统一——
// 同一 assembleAndApply 入口：system 人设 → V2 固定块（assembly/instructions/identity/
// understanding/moments/continuity）→ 历史 → Relevant → [唤醒] 块（落盘）→ 生成 assistant。
// V2 关闭时回退旧路径：system 人设 → developer [永久上下文] → [跨窗口] → 历史 → [唤醒]）。
// 内部消息出口前经 lib/role-mapper.js 按供应商 profile 翻译（default: developer→system）。

const path = require('path');
const memoryEngine = require('../memory-engine');
const contextReplacements = require('../context-replacements');
const mcp = require('../mcp-tool-loop');
const { McpServerClient, loadConfig } = require('../mcp-client');
const { mapMessagesForProvider } = require('../lib/role-mapper');
const chatCtx = require('./chat-context');
const ctxV2Runtime = require('../context-v2-runtime');

// 唤醒侧注入白名单服务器：「工具集合」（本地记忆/日记工具，127.0.0.1:8771）+「花园」+「邮箱」，
// 从 mcp-servers.json 里按名称/端口挑出，避免把 search.parallel / 网易云等带进唤醒；
// loadConfig 已滤掉 enabled:false，聊天端停用即唤醒侧同步停用。（与原 wake_up.js 同一白名单）
let _wakeMcpClients = null;
function getWakeMcpClients(baseDir) {
  if (_wakeMcpClients) return _wakeMcpClients;
  try {
    const servers = loadConfig(path.join(baseDir, "mcp-servers.json"));
    const target = servers.filter(s => {
      const key = (s.name || "") + " " + (s.url || "");
      return /工具集合/.test(key) || /127\.0\.0\.1:8771/.test(key)
        || /花园/.test(key) || /galatea\.abysslumina\.com/.test(key)
        || /邮箱/.test(key) || /127\.0\.0\.1:5000\b/.test(key);
    });
    _wakeMcpClients = target.map(c => new McpServerClient(c));
  } catch (e) {
    console.warn("[wake-chat] 加载工具集合配置失败:", e.message);
    _wakeMcpClients = [];
  }
  return _wakeMcpClients;
}

// 唤醒基础上下文：与聊天侧共用统一对话构建器（createConversationBuilder，见 chat-context.js）。
// 同源同前缀——同一会话同一时刻，唤醒请求与聊天请求的构建器输出逐字一致，上游前缀缓存共享。
// （原唤醒专属拼装/图片降级已并入构建器，2026-09-15 批3）
function buildWakeBaseMessages(deps, sessionId, buildConversation) {
  return buildConversation(sessionId);
}

// 统一唤醒补全：返回 { text, toolHistory, model }。
// opts: { session_id, wake_block, temperature=0.8, top_p=0.95, with_tools=true, persist_wake_block=true }
async function runWakeCompletion(deps, opts) {
  const sessionId = String(opts.session_id || "").trim();
  if (!sessionId) throw new Error("session_id is required");
  const wakeBlock = String(opts.wake_block || "").trim();
  const temperature = Number(opts.temperature) || 0.8;
  const topP = Number(opts.top_p) || 0.95;
  const withTools = opts.with_tools !== false;
  const persistWakeBlock = opts.persist_wake_block !== false;

  // 让替换/压缩按当前会话时间线工作（onResponse 钩子复位由 HTTP 层兜底，这里手动收口）
  contextReplacements.setActiveSession(sessionId || null);
  try {
    let msgs = buildWakeBaseMessages(deps, sessionId, ensureBuilder(deps));
    // 唤醒与聊天共用 Context V2 组装（0920 完全统一：同一 assembleAndApply 入口，
    // 同一时刻同一会话两侧上下文逐字一致，人设 system 恒在最顶）；开关关闭时完全保留旧路径。
    if (ctxV2Runtime.enabled(deps.baseDir)) {
      try {
        const r = await ctxV2Runtime.assembleAndApply({
          baseDir: deps.baseDir,
          sessionId: sessionId,
          messages: msgs,
          loadTimeline: deps.loadTimeline,
          normalizeContentToText: deps.normalizeContentToText,
        });
        msgs = r.messages;
        // 记忆浮现与聊天侧对齐（0920 拍板）：命中记忆原样写入时间线永久在场
        if (r.relevantHits && r.relevantHits.length) {
          const n = ctxV2Runtime.floatMemoriesToTimeline({ appendMessages: deps.appendMessages, sessionId, mems: r.relevantHits, baseDir: deps.baseDir });
          if (n) console.log('[wake-chat] 本轮记忆浮现', n, '条');
        }
      } catch (e) { console.warn('[wake-chat] Context V2 组装失败，回退旧上下文:', e.message); }
    }

    // [唤醒] 块：先落盘（追加式、原地不动、不插位），再注入本次请求末尾。
    // 静默唤醒（模型不回话）时它就是该次唤醒在时间线里的唯一留痕。
    let wakeBlockId = null;
    if (wakeBlock) {
      let blockContent = wakeBlock;
      if (persistWakeBlock) {
        try {
          const created = deps.appendMessages(sessionId, [{ role: "developer", content: blockContent }]);
          wakeBlockId = (created && created[0] && created[0].id) || null;
          console.log(`[wake-chat] developer [唤醒] 块已落盘（session ${sessionId}，${blockContent.length} 字）`);
        } catch (e) {
          console.warn("[wake-chat] [唤醒] 块落盘失败（仍注入本次请求）:", e.message);
        }
      }
      msgs.push({ role: "developer", content: blockContent });
    }

    // 上下文记忆替换（与对话侧/共影侧同款，2026-09-15 补）：已记录范围的原文替换为 AI 记忆/摘要，
    // 源文件不动。此前漏掉该步导致全时间线原文直发上游（3160 条/59.5 万字符）压垮模型。
    try {
      const beforeRep = msgs.length;
      msgs = contextReplacements.applyReplacements(msgs);
      if (msgs.length !== beforeRep) {
        console.log("[wake-chat] 上下文替换生效: 消息 " + beforeRep + " -> " + msgs.length);
      }
    } catch (repErr) {
      console.warn("[wake-chat] 上下文替换失败（按原样发送）:", repErr.message);
    }

    // 与对话侧同一套加工：容量提醒 → 工具记录全量转换（一条不滤）→ tool 配对修复 → 出口净化
    // 容量提醒建议段的时间反查表（role+content → Date）：从会话时间线构建，
    // 与对话侧同口径（2026-09-15 补：此前传 null，提醒文本退化为无时间锚的默认描述）
    const timeByKey = new Map();
    try {
      for (const tm of deps.loadTimeline(sessionId)) {
        if (!tm || tm.role === "system" || deps.isSpecialEvent(tm)) continue;
        if (!tm.time) continue;
        const d = new Date(tm.time);
        if (isNaN(d.getTime())) continue;
        const key = tm.role + "\u0000" + deps.normalizeContentToText(tm.content);
        if (!timeByKey.has(key)) timeByKey.set(key, d);
      }
    } catch (e) { /* 反查表失败不阻断，提醒退化为无时间锚 */ }
    ensureGuard(deps)(msgs, sessionId, timeByKey);
    let llmMessages = chatCtx.convertToolNotesToToolRole(msgs);
    llmMessages = chatCtx.repairToolCallPairs(llmMessages);
    const sanitized = chatCtx.sanitizeForUpstream(llmMessages);

    const { provider: prov, model: resolvedModel } = deps.resolveChatModel(sessionId, null);
    const model = resolvedModel || deps.readEnvValue("MODEL_NAME") || "";
    const url = (prov && (prov.api_url || prov.base_url)) || deps.readEnvValue("TARGET_API_URL");
    const key = (prov && prov.api_key) || deps.readEnvValue("TARGET_API_KEY");
    if (!url || !key) throw new Error("TARGET_API_URL / TARGET_API_KEY 或 AI 供应商未配置");
    const profile = (prov && prov.profile) || "default";
    const outbound = mapMessagesForProvider(profile, sanitized);

    // 捕获发给模型的完整上下文（管理台日志页可查看唤醒上下文）
    if (deps.setLastLLMCapture) {
      deps.setLastLLMCapture(outbound.map(m => {
        const cap = deps.splitMultimodalContent ? deps.splitMultimodalContent(m.content) : { content: m.content };
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

    console.log(JSON.stringify({
      event: "wake_completion_forward",
      session: sessionId,
      model,
      with_tools: withTools && getWakeMcpClients(deps.baseDir).length > 0,
      messages: outbound.length,
      chars: sanitized.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)
    }));

    let text = "";
    let toolHistory = [];
    const clients = withTools ? getWakeMcpClients(deps.baseDir) : [];
    if (clients.length) {
      try {
        const r = await mcp.runWithTools({
          upstreamUrl: url,
          upstreamKey: key,
          model,
          messages: outbound,
          serverClients: clients,
          sessionId,
          temperature,
          top_p: topP
        });
        if (r && typeof r.text === "string" && deps.normalizeContentToText(r.text).trim()) {
          text = r.text;
          toolHistory = r.toolHistory || [];
          console.log(`[wake-chat] 工具循环完成：调用工具 ${toolHistory.length} 个，正文 ${text.length} 字`);
        }
      } catch (e) {
        console.warn("[wake-chat] 工具循环失败，回退无工具直连:", e.message);
      }
    }

    if (!text) {
      // 无工具直连兜底（保证唤醒始终可用，与原 wake_up.js 口径一致）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.UPSTREAM_TIMEOUT_MS || 180000);
      let resp;
      let respText;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: outbound, temperature, top_p: topP, stream: false }),
          signal: controller.signal
        });
        // body 读取也必须在超时窗口内（2026-09-15 修复）：此前 finally 在 fetch 返回即清定时器，
        // 上游回完头再挂起时读 body 无超时（退化成 undici 默认 300s），唤醒互斥锁被长时间占死
        respText = await resp.text();
      } finally {
        clearTimeout(timer);
      }
      let data;
      try { data = JSON.parse(respText); }
      catch { throw new Error(`上游返回的不是 JSON（HTTP ${resp.status}）：${respText.slice(0, 300)}`); }
      if (!resp.ok) throw new Error(`上游模型请求失败（HTTP ${resp.status}）：${respText.slice(0, 300)}`);
      text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
      if (text) console.log(`[wake-chat] 直连完成：正文 ${text.length} 字`);
    }

    return { text, toolHistory, model, wakeBlockId };
  } finally {
    try { contextReplacements.setActiveSession(null); } catch (e) {}
  }
}

// 统一对话构建器（惰性创建，与聊天侧同一实例逻辑）
let buildConversation = null;
function ensureBuilder(deps) {
  if (!buildConversation) {
    buildConversation = chatCtx.createConversationBuilder({
      loadTimeline: deps.loadTimeline,
      prepareMessageForLLM: deps.prepareMessageForLLM,
      buildCrossMemorySnapshot: deps.buildCrossMemorySnapshot,
      stripPosition: deps.stripPosition,
      memoryEngine
    });
  }
  return buildConversation;
}

// 守卫惰性创建（依赖 server.js 注入的时间线函数；直接调用 runWakeCompletion 也可用）
let ctxLimitGuard = null;
function ensureGuard(deps) {
  if (!ctxLimitGuard) {
    ctxLimitGuard = chatCtx.createCtxLimitReminderGuard({
      contextCompactor: require('../context-compactor'),
      contextReplacements,
      loadTimeline: deps.loadTimeline,
      saveTimeline: deps.saveTimeline,
      appendSpecialEvent: deps.appendSpecialEvent,
      isSpecialEvent: deps.isSpecialEvent,
      normalizeContentToText: deps.normalizeContentToText
    });
  }
  return ctxLimitGuard;
}

module.exports = function registerWakeChatRoutes(app, deps) {
  ensureGuard(deps);

  // 内部接口：主唤醒（独立进程期）/ 未来其他调用方经 HTTP 使用统一唤醒链路。
  // 注（2026-09-19 复核）：当前全仓无调用方——唤醒调度已在 gateway 内直调 runWakeCompletion，本端点预留。
  // 鉴权走全局 /internal/ 钩子（x-internal-key）。
  app.post("/internal/wake-completions", async (req, reply) => {
    try {
      const body = req.body || {};
      const res = await runWakeCompletion(deps, body);
      reply.send({ ok: true, text: res.text, tool_history: res.toolHistory, model: res.model, wake_block_id: res.wakeBlockId });
    } catch (err) {
      console.error("[wake-completions] error:", err.message);
      reply.code(500).send({ ok: false, error: err.message });
    }
  });
};

module.exports.runWakeCompletion = runWakeCompletion;
module.exports.getWakeMcpClients = getWakeMcpClients;
