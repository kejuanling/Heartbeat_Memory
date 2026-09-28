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
const upstreamAlert = require('../lib/upstream-alert'); // 2026-09-28 上游 402（余额不足）提醒
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
  let reasoning = "";   // 2026-09-24 P3-3：思考链透出（默认空串，直连兜底路径无思考链）
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
          // 2026-09-28 防堆积：developer [唤醒] 块每次落盘前，先删掉时间线里旧的唤醒块
          // （内容含「系统唤醒」特征），只保留最新一条。旧唤醒块是含当时时间戳的过期指令，
          // 模型只需看到最新一条；否则每唤醒周期追加一条、且 developer 不在压缩范围
          // （isCompressible 只认 user/assistant）永不压缩 → 无限堆积。
          // 一次 load + filter + save（不逐条 deleteMessage，避免大量重复读写）；
          // 静默保存不触发 sseNotify，新块由下方 appendMessages 统一通知。
          try {
            const tl = deps.loadTimeline(sessionId);
            const kept = tl.filter(function (m) {
              return !(m && m.role === "developer" && typeof m.content === "string" &&
                m.content.indexOf("系统唤醒") >= 0);
            });
            if (kept.length !== tl.length) {
              deps.saveTimeline(kept, sessionId);
              console.log(`[wake-chat] 已清理旧 [唤醒] 块 ${tl.length - kept.length} 条（session ${sessionId}）`);
            }
          } catch (e) {
            console.warn("[wake-chat] 清理旧 [唤醒] 块失败（跳过清理，仅追加新块）:", e.message);
          }
          const created = deps.appendMessages(sessionId, [{ role: "developer", content: blockContent }]);
          wakeBlockId = (created && created[0] && created[0].id) || null;
          console.log(`[wake-chat] developer [唤醒] 块已落盘（session ${sessionId}，${blockContent.length} 字）`);
        } catch (e) {
          console.warn("[wake-chat] [唤醒] 块落盘失败（仍注入本次请求）:", e.message);
        }
      }
      msgs.push({ role: "developer", content: blockContent });
    }

    // 容量提醒建议段的时间反查表（role+content → Date）：从会话时间线构建，
    // 与对话侧同口径。2026-09-22 审查 §3.5：此前只认 `tm.time` 字段（无则跳过），
    // 而对话侧用的是 extractTimestampWithMemory 的多级降级（time 字段 → <current_time> 标签 →
    // 行首/行尾日期），两侧对同一份历史会算出不同的时间区间。改为共用同一实现。
    const timeByKey = new Map();
    try {
      for (const tm of deps.loadTimeline(sessionId)) {
        if (!tm || tm.role === "system" || deps.isSpecialEvent(tm)) continue;
        const key = tm.role + "\u0000" + deps.normalizeContentToText(tm.content);
        if (timeByKey.has(key)) continue;
        const t = typeof deps.extractTimestampWithMemory === "function" ? deps.extractTimestampWithMemory(tm) : (tm.time ? new Date(tm.time) : null);
        if (t && !isNaN(t.getTime())) timeByKey.set(key, t);
      }
    } catch (e) { /* 反查表失败不阻断，提醒退化为无时间锚 */ }

    // 2026-09-21 审查 H9：替换/容量提醒/工具转换/配对修复/出口净化全部收敛进统一管道
    // prepareModelMessages，顺序与聊天侧逐字一致（此前本侧是 replace→guard→convert→repair，与 chat.js 相反）。
    // 上下文记忆替换（2026-09-15 补）在管道内执行：此前漏掉该步曾致全时间线原文直发上游压垮模型。
    const sanitized = chatCtx.prepareModelMessages(msgs, {
      applyReplacements: (m) => contextReplacements.applyReplacements(m),
      ctxLimitGuard: ensureGuard(deps),
      sessionId,
      timeByKey,
      logPrefix: "[wake-chat]"
    });

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
        // 2026-09-23：工具循环由 runWithTools（非流式）改为 streamToolLoop（流式），
        // 与对话侧（server.js handleMcpRequest）**统一为同一条实现**。
        // 动因：此前两条链路各有一套工具循环，唯独唤醒侧只走非流式 runWithTools——
        // 这正是「同一批工具调用，只有 [wake-chat] 反复报 reasoning_content 400、
        // 对话侧从不报」的结构性原因（口径漂移）。项目既有约束是「两条链路必须同一套」
        // （见 routes/chat-context.js 文件头），工具循环层是最后一个未收敛的环节。
        // 唤醒没有 SSE 输出需求，故 onEvent 传 null（对话侧非流式请求同样如此，代码内
        // 有 `onEvent: (body.stream === true) ? onEvent : null` 的判空，安全）。
        // 返回字段兼容：本处只消费 r.text 与 r.toolHistory，streamToolLoop 两者都返回；
        // maxToolRounds 默认值两者同为 DEFAULT_MAX_TOOL_ROUNDS。
        // 回滚：把下面 streamToolLoop 改回 runWithTools 即可（一行）。
        const r = await mcp.streamToolLoop({
          upstreamUrl: url,
          upstreamKey: key,
          model,
          messages: outbound,
          serverClients: clients,
          sessionId,
          temperature,
          top_p: topP,
          onEvent: null
        });
        if (r && typeof r.text === "string" && deps.normalizeContentToText(r.text).trim()) {
          text = r.text;
          toolHistory = r.toolHistory || [];
          // 2026-09-24 P3-3：透出思考链（streamToolLoop 已收集 reasoning），供 applyWakeEventV2 落盘——
          // 否则唤醒回复刷新后无思考链区块，与聊天链路不一致
          reasoning = r.reasoning || "";
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
      if (!resp.ok) {
        if (resp.status === 402) upstreamAlert.note402({ model, detail: respText, sessionId }).catch(function () {});
        throw new Error(`上游模型请求失败（HTTP ${resp.status}）：${respText.slice(0, 300)}`);
      }
      text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
      if (text) console.log(`[wake-chat] 直连完成：正文 ${text.length} 字`);
    }

    return { text, toolHistory, reasoning, model, wakeBlockId };
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
      memoryEngine,
      resolveSessionSystemPrompt: deps.resolveSessionSystemPrompt
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

// 2026-09-21 审查清理：POST /internal/wake-completions 零消费者已删除——
// 唤醒调度（lib/wake-scheduler.js）在 gateway 进程内直调 runWakeCompletion，
// HTTP 自环端点自独立唤醒进程退役后即无调用方。runWakeCompletion 仍经下方导出供进程内使用。
module.exports = function registerWakeChatRoutes(app, deps) {
  ensureGuard(deps);
};

module.exports.runWakeCompletion = runWakeCompletion;
module.exports.getWakeMcpClients = getWakeMcpClients;
