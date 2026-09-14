'use strict';
// 统一「自主唤醒调用器」（2026-09-15 唤醒并入网关）：
// 从会话时间线重建结构化上下文（与对话侧同一套加工函数：替换/容量提醒/工具记录转换/配对修复），
// 头部注入 developer [永久上下文]/[跨窗口]，末尾追加 developer [唤醒] 块（落盘），
// 走工具循环（失败回退直连）调模型，返回文本。
// 唤醒特有行为（Bark 推送/[NO_ACTION]/日记/<wake> 定时/写回时间线）仍由调用方负责，本模块不碰。
//
// role 法（2026-09-15 定稿）：
//   system 人设 → developer [永久上下文] → developer [跨窗口] → 历史(原样)
//   → developer [唤醒]（落盘）→ 生成 assistant。
// 内部消息出口前经 lib/role-mapper.js 按供应商 profile 翻译（default: developer→system）。

const path = require('path');
const memoryEngine = require('../memory-engine');
const contextReplacements = require('../context-replacements');
const mcp = require('../mcp-tool-loop');
const { McpServerClient, loadConfig } = require('../mcp-client');
const { mapMessagesForProvider } = require('../lib/role-mapper');
const chatCtx = require('./chat-context');

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

// 从时间线重建唤醒基础消息（服务端版上下文构建；对话侧是客户端驱动，唤醒侧无客户端，自己重建）。
// 人设取时间线里的 system（聊天端每轮「人设同步」维护）；唤醒侧剥掉对话侧 search_web 工具说明段
// （沿用原 wake_up.js 口径，唤醒工具集不同）。
function buildWakeBaseMessages(deps, sessionId) {
  const timeline = deps.loadTimeline(sessionId);
  let systemContent = "";
  for (const m of timeline) {
    if (m && m.role === "system" && !m.deleted) systemContent = deps.normalizeContentToText(m.content);
  }
  systemContent = systemContent.split("## search_web 工具使用说明")[0].trim();

  // 历史：去掉 system 条目与已删除消息，去 position，原样保留（特殊事件/摘要块/工具记录都在）
  const history = deps.stripPosition(timeline.filter(m => m && m.role !== "system" && !m.deleted));

  // 历史图片/附件降级为占位文本（恢复旧唤醒侧行为）：唤醒无需重看历史图片，
  // 规避上游「下载历史图片 URL 失败 → 整包 400」的坑（2026-09-15 实测）。
  for (const m of history) {
    if (!m || !Array.isArray(m.content)) continue;
    const texts = [];
    for (const part of m.content) {
      if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part && (part.type === "image" || part.type === "image_url")) texts.push("（图片）");
      else if (part && part.type === "file") texts.push("（附件）");
    }
    m.content = texts.join("\n") || "（图片）";
  }

  const msgs = [];
  if (systemContent) msgs.push({ role: "system", content: systemContent });

  // 头部 developer 块：[永久上下文] + [跨窗口]（快照原样；稳定内容放头部，喂前缀缓存）
  let pinnedCtx = "";
  try { pinnedCtx = memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : ""; }
  catch (e) { console.warn("[wake-chat] 永久上下文构建失败（跳过）:", e.message); }
  let crossCtx = "";
  try { crossCtx = deps.buildCrossMemorySnapshot(sessionId); }
  catch (e) { console.warn("[wake-chat] 跨窗口快照构建失败（跳过）:", e.message); }
  msgs.push(...chatCtx.buildDeveloperHeaderBlocks({ pinnedCtx, crossCtx }));

  msgs.push(...history);
  return msgs;
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
    let msgs = buildWakeBaseMessages(deps, sessionId);

    // [唤醒] 块：先落盘（追加式、原地不动、不插位），再注入本次请求末尾。
    // 静默唤醒（模型不回话）时它就是该次唤醒在时间线里的唯一留痕。
    // 免打扰/闹钟状态按 role 法写进块里（0915 拍板：只告知模型，由模型自己定说不说）。
    let wakeBlockId = null;
    if (wakeBlock) {
      let blockContent = wakeBlock;
      if (typeof deps.isQuietActive === "function") {
        try {
          blockContent += "\n[免打扰] " + (deps.isQuietActive(sessionId) ? "是（是否保持安静由你自行判断）" : "否");
        } catch (e) {}
      }
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
    ensureGuard(deps)(msgs, sessionId, null);
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
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: outbound, temperature, top_p: topP, stream: false }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      const respText = await resp.text();
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
