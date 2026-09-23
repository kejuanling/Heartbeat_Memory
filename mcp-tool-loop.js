/**
 * mcp-tool-loop.js
 * 工具执行循环：把 MCP 工具注入模型请求，处理多轮 tool_calls，直到模型不再要工具，
 * 最终把纯文本结果转成 OpenAI 兼容 SSE 流。
 *
 * 设计（隔离式）：
 *  - 不改动 server.js 现有直通转发逻辑。
 *  - 提供 runWithTools()：给定消息/模型配置，内部循环调用上游，返回最终 assistant 文本。
 *  - 提供 buildSSE()：把最终文本 + 思考链 + 工具调用记录转成 chat.html 可消费的 SSE 流。
 *
 * 流式体验：工具调用轮次用非流式（等结果），最后一次流式回传（保持前端打字效果）。
 * 透传内容：思考链 reasoning_content、工具调用记录 tool_trace（供前端渲染工具胶囊）。
 */
"use strict";

const { loadTools, toOpenAITools, callToolByExposedName } = require("./mcp-service");

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const MAX_REASONING_CHARS = 4000; // 思考链最多保留字符数，避免过长
// 轮内上游超时：与 server.js 全局口径一致（此前硬编码 120s，比全局 180s 短，长回复会先于全局超时被误杀）
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;
// 单条工具结果写进时间线的截断上限：防止超大结果（读文件/长网页）把 enhanced_messages.json 撑爆
const MAX_TOOL_RESULT_CHARS = 30000;

// 会话级工具（2026-09-12）：执行时由服务端把当前聊天会话 id 强制注入参数 session_id（覆盖模型给的值，
// 模型伪造无效）。工具端（tools_server.py）据此把日记/留纸写到对应会话目录。
const SESSION_SCOPED_TOOLS = new Set(["diary_add", "leave_paper", "view_paper"]);
function _injectSessionArg(name, args, sessionId) {
  if (sessionId && SESSION_SCOPED_TOOLS.has(name) && args && typeof args === "object" && !Array.isArray(args)) {
    args.session_id = String(sessionId);
  }
}


/**
 * 执行带工具的多轮对话。
 * @param {Object} opts
 *  - upstreamUrl / upstreamKey : 上游 API 地址与密钥
 *  - model : 模型名
 *  - messages : 已处理好的消息数组（OpenAI 兼容）
 *  - serverClients : 已连接的 MCP server client 列表
 *  - temperature / top_p / max_tokens : 可选
 *  - maxToolRounds : 工具循环上限
 *  - fetch : 可注入的 fetch（测试用），默认全局 fetch
 * @returns {Promise<{text:string, rounds:number, usage:any, reasoning:string, toolHistory:Array}>}
 */
async function runWithTools({
  upstreamUrl,
  upstreamKey,
  model,
  messages,
  serverClients,
  temperature,
  top_p,
  max_tokens,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  fetchFn = fetch,
  resume = null,
  onEvent = null,
  sessionId = null
}) {
  // 1. 加载 MCP 工具，转成 OpenAI tools[]
  const routes = await loadTools(serverClients);
  const allRoutes = routes || [];
  const openaiTools = toOpenAITools(allRoutes);
  const toolCtx = { serverClients, routes, upstreamUrl, upstreamKey, model, sessionId };

  let working = messages.slice();
  let totalUsage = null;
  let rounds = 0;

  // 收集思考链（reasoning_content）与工具调用记录（tool_trace）
  const reasoningParts = [];
  const toolHistory = [];
  // T-0922 修复：每一轮模型说过的话都收集（同轮"文本+工具调用"混合时文本不再丢弃），
  // 按轮次拼接为最终回复——与主流聊天一致："我帮你查一下" →（工具跑）→ 结果补充
  const contentParts = [];

  // 方案2：逐轮即时回传。onEvent 把「本轮正文/思考 + 每个工具 start/end」实时推给调用方，
  // 供前端渲染工具卡与正文交错 + running→done 状态。落盘/缓存仍用 toolHistory（终态快照），不受影响。
  // 2026-09-21 审查 R7：onEvent 抛错（客户端断开）置 clientGone，工具循环随即中断，不再白烧 token
  let clientGone = false;
  const emit = (evt) => { try { if (typeof onEvent === "function") onEvent(evt); } catch (e) { clientGone = true; } };
  let toolSeq = 0;

  // 直通续跑模式（T-0922）：流式直通路径已把该 assistant 消息（含 tool_calls）透传给客户端，
  // 从"执行其工具"开始接续；其 content 客户端已见过，不进 contentParts（避免重复显示）
  if (resume && resume.assistantMsg) {
    const am = resume.assistantMsg;
    // 同主循环：续跑起点若带思考链也必须回传，否则 thinking mode 上游仍会 400。
    working.push({
      role: "assistant",
      content: am.content || "",
      reasoning_content: am.reasoning_content || undefined,
      tool_calls: am.tool_calls
    });
    await executeToolCalls(am.tool_calls || [], working, toolHistory, toolCtx);
  }

  for (let round = 0; round < maxToolRounds + 1; round++) {
    if (clientGone) { console.log("[mcp] 客户端已断开，工具循环提前结束"); break; }
    rounds = round;
    const body = {
      model,
      messages: working,
      stream: false,
      temperature,
      top_p,
      max_tokens
    };
    // 只在还有工具时注入 tools；最后一轮带 tools 定义但 tool_choice="none"：
    // 保持 tools 定义能让严格上游接受带 tool_calls/tool 历史的请求（历史里引用过的工具必须在 tools 里），
    // tool_choice="none" 阻止模型再发起新一轮工具调用
    if (round < maxToolRounds && openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "auto";
    } else if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "none";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetchFn(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${upstreamKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      // 2026-09-23 诊断（reasoning_content 400 定位用）：记录出错轮次与上下文中
      // 「带 tool_calls 的 assistant」及其 reasoning_content 覆盖情况——
      // 用于区分「首轮上下文问题」还是「后续轮回传问题」。定位到根因后可移除或降级。
      try {
        const _tcA = working.filter(function (m) { return m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length; });
        const _tcRc = _tcA.filter(function (m) { return typeof m.reasoning_content === "string" && m.reasoning_content.length > 0; });
        console.warn("[mcp-diag] runWithTools 上游失败: status=" + resp.status +
          " round=" + round + "/" + maxToolRounds +
          " model=" + model +
          " working=" + working.length +
          " assistantWithToolCalls=" + _tcA.length +
          " ofWhichHasRc=" + _tcRc.length +
          " tail3=" + working.slice(-3).map(function (m) { return (m && m.role) || "?"; }).join("/"));
      } catch (e) {}
      throw new Error(`上游请求失败 HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }

    const data = await resp.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error("上游返回无 choices");
    const msg = choice.message || {};
    if (data.usage) totalUsage = data.usage;

    // 收集思考链（兼容 reasoning_content 与 reasoning 两种字段）
    const rtext = String(msg.reasoning_content || msg.reasoning || "").trim();
    if (rtext) { reasoningParts.push(rtext); emit({ type: "reasoning", text: rtext }); }

    // 收集本轮正文（混合轮文本保留，见 contentParts 注释）
    const ctext = String(msg.content || "").trim();
    if (ctext) {
      contentParts.push(ctext);
      // 轮次间补一个空行分隔：保证客户端流式拼接的 full 与最终 text(contentParts.join("\n\n")) 一致，
      // 前端 makeMsgEl/segSplitText 按空行拆段与 afterSeg 才能对得上
      if (contentParts.length > 1) emit({ type: "text", text: "\n\n" });
      emit({ type: "text", text: ctext });
    }

    // 记录这一轮 assistant 消息（含 tool_calls 则保留）
    // 2026-09-23 修复：thinking mode 下必须把本轮思考链原样回传给上游，否则下一轮请求会被拒：
    //   HTTP 400 "The `reasoning_content` in the thinking mode must be passed back to the API"
    // 此前只 push 了 content/tool_calls，唤醒侧（wake-chat.js 走本函数）每轮都 400 失败、
    // 退化为「无工具直连」，工具能力实际失效（日志实测 35 次）。
    // 与 streamToolLoop 同口径：无思考链时传 undefined，让 JSON.stringify 省略该键。
    working.push({
      role: "assistant",
      content: msg.content || "",
      reasoning_content: rtext || undefined,
      tool_calls: msg.tool_calls
    });

    // 没有 tool_calls -> 结束
    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) break;

    // 执行每个 tool_call，并记录到 toolHistory 供前端展示（方案2：逐工具实时推 tool_start/tool_end）
    // afterSeg：工具所在轮正文之后、按空行粒度拆出的段下标（与前端 makeMsgEl 分段一致；-1=正文为空/最前）
    const _segCount = (txt) => String(txt || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).length;
    await executeToolCalls(toolCalls, working, toolHistory, toolCtx, emit, () => toolSeq++, _segCount(contentParts.join("\n\n")) - 1);
  }

  // 最终回复 = 各轮正文拼接；兜底：轮次耗尽模型全程没说过话时占位提示，
  // 避免 handleMcpRequest 因空文本跳过时间线写入、客户端收到无日志的空回复。
  // resume 模式除外：客户端已有直通文本，这里为空就空着，由调用方决定。
  let text = contentParts.join("\n\n").trim();
  if (!text && !(resume && resume.assistantMsg)) {
    text = "（工具调用轮次已达上限，模型未给出最终回复，请重试或简化请求）";
    console.warn("[mcp] 工具轮次耗尽兜底: rounds=" + rounds + " textLen=0");
  }

  // 汇总思考链（截断上限）
  const reasoning = reasoningParts.join("\n\n").slice(0, MAX_REASONING_CHARS);

  // segments 按空行粒度拆（与前端 makeMsgEl 一致），工具 afterSeg 也以同一分段下标对齐
  const segs = String(text || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (!segs.length) segs.push(text || "");
  return { text, rounds, usage: totalUsage, routes, reasoning, toolHistory, segments: segs.slice(), finalMessages: working.slice() };
}

// 执行一批 tool_call：结果写入 working（供下一轮上游请求）与 toolHistory（供前端展示）
// 方案2 onEvent/nextIndex 可选：开启时每个工具实时推 tool_start（执行前）/tool_end（执行后），
// 前端据此渲染"执行中→已完成/失败"状态卡；index 用于配对 start/end。老调用不传则跳过（兼容）。
// 2026-09-22 用户拍板：单轮工具数上限取消（AI 实际很少用工具，上限反而制造两份实现漂移）——
// 本函数与 streamToolLoop 现在都不限额；轮数仍由 maxToolRounds 兜底。
async function executeToolCalls(toolCalls, working, toolHistory, ctx, onEvent, nextIndex, afterSeg) {
  const { serverClients, routes, upstreamUrl, upstreamKey, model } = ctx;
  for (let _i = 0; _i < toolCalls.length; _i++) {
    const tc = toolCalls[_i];
    const fn = tc.function || {};
    const name = fn.name || "";
    const args = _parseArgs(fn.arguments);
    _injectSessionArg(name, args, ctx.sessionId);
    const index = (typeof nextIndex === "function") ? nextIndex() : toolHistory.length;
    const id = tc.id || ("call_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7));
    const toolTime = _toolCallTime();   // 调用时间=执行起点，进模型上下文与 toolHistory 同一份
    let result;
    let error = null;
    try {
      if (typeof onEvent === "function") onEvent({ type: "tool_start", index, id, name, args, afterSeg: (typeof afterSeg === "number") ? afterSeg : -1 });
      result = await callToolByExposedName(serverClients, routes, name, args);
    } catch (e) {
      error = e.message || String(e);
      result = { markdown: JSON.stringify({ type: "tool_error", error: "mcp_service_error", message: error }) };
    }
    const resTrunc = _truncateResult(result.markdown || "", error ? 0 : 20000);
    working.push({
      role: "tool",
      tool_call_id: id,
      // 来源标记：工具名+调用时间+状态（成功/失败/空返回显式），模型不必靠内容特征猜；
      // 截断超大工具结果：时间线/后续轮次上下文都不需要完整大结果，30k 字符足够模型引用
      content: buildToolResultContent({ name, time: toolTime, error: error || null, markdown: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS) })
    });
    toolHistory.push({
      name,
      args,
      time: toolTime,
      result: resTrunc,
      error,
      afterSeg: (typeof afterSeg === "number") ? afterSeg : -1   // 方案2刷新：该工具位于第 afterSeg 段正文之后（-1=最前）
    });
    if (typeof onEvent === "function") onEvent({ type: "tool_end", index, id, name, args, result: resTrunc, error, ok: !error, afterSeg: (typeof afterSeg === "number") ? afterSeg : -1 });
  }
}

// 解析 function 的 arguments（可能是字符串或对象）
function _parseArgs(args) {
  if (args == null) return {};
  if (typeof args === "object") return args;
  if (typeof args === "string") {
    try { return JSON.parse(args) || {}; } catch (e) { return {}; }
  }
  return {};
}

// 截断工具返回摘要，避免 tool_trace 过大
function _truncateResult(text, max = 800) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 工具调用时间（精确到秒）；调用时间取执行起点，跨轮回灌时随 toolHistory 落盘复用。
// 2026-09-13 审查修复：改用可配置 TIME_ZONE（与 server.js 同一 resolveTimeZone 口径）——
// 此前硬编码 UTC+8，非 +8 时区部署时工具调用时间戳会错 8 小时并随 toolHistory 进模型上下文
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const TOOLCALL_TIME_ZONE = resolveTimeZone();
function _toolCallTime(d = new Date()) {
  const p = getDatePartsInTimeZone(d, TOOLCALL_TIME_ZONE);
  return p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute + ":" + p.second;
}

// 工具结果进模型上下文的统一标头（与 routes/chat.js 跨轮回灌转换保持同一格式，两处改要同步）：
// 让模型明确知道「这是工具 X 在时间 T 返回的」，不靠内容特征猜；
// 失败/空返回显式标注，绝不静默省略或给空字符串。
function buildToolResultContent({ name, time, error, markdown }) {
  const body = String(markdown ?? "").trim();
  const status = error ? "失败" : (body ? "成功" : "成功但无返回内容");
  const lines = [
    "[工具调用结果]",
    "工具：" + (name || "unknown"),
    "调用时间：" + (time || _toolCallTime()),
    "状态：" + status
  ];
  if (error) lines.push("错误信息：" + error);
  if (body) { lines.push("----"); lines.push(body); }
  return lines.join("\n");
}

/**
 * 流式工具循环（2026-09-09，修复「用工具慢 + 工具卡堆末尾」）：
 * 全程以 stream:true 请求上游，正文/思考链增量实时回传，工具参数在某轮齐了就就地执行
 * （onEvent 推 tool_start/tool_end，前端据此内联渲染工具卡），再把工具结果喂回上游继续流式补正文。
 * 与 runWithTools 同返回结构；调用方可在抛错时回退 runWithTools（失败兜底）。
 * 关键：不再整轮非流式等待，正文秒出；工具卡按真实到达顺序内联。
 */
async function streamToolLoop({
  upstreamUrl,
  upstreamKey,
  model,
  messages,
  serverClients,
  temperature,
  top_p,
  max_tokens,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  onEvent = null,
  fetchFn = fetch,
  sessionId = null
}) {
  const routes = await loadTools(serverClients);
  const openaiTools = toOpenAITools(routes || []);
  let working = messages.slice();
  let totalUsage = null;
  let rounds = 0;
  const reasoningParts = [];
  const toolHistory = [];
  const streamTimeline = [];
  const contentParts = [];
  let toolSeq = 0;
  // 2026-09-21 审查 R7：客户端断开标志（onEvent 抛错即置位），读取与工具循环据此中断
  let clientGone = false;
  const emit = (evt) => { try { if (typeof onEvent === "function") onEvent(evt); } catch (e) { clientGone = true; } };

  for (let round = 0; round < maxToolRounds + 1; round++) {
    if (clientGone) { console.log("[mcp] 客户端已断开，流式工具循环提前结束"); break; }
    rounds = round;
    const body = { model, messages: working, stream: true, temperature, top_p, max_tokens };
    if (round < maxToolRounds && openaiTools.length > 0) { body.tools = openaiTools; body.tool_choice = "auto"; }
    else if (openaiTools.length > 0) { body.tools = openaiTools; body.tool_choice = "none"; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetchFn(upstreamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      // 2026-09-23 诊断：同 runWithTools，记录轮次与带 tool_calls 的 assistant 的 rc 覆盖情况
      try {
        const _tcA = working.filter(function (m) { return m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length; });
        const _tcRc = _tcA.filter(function (m) { return typeof m.reasoning_content === "string" && m.reasoning_content.length > 0; });
        console.warn("[mcp-diag] streamToolLoop 上游失败: status=" + resp.status +
          " round=" + round + "/" + maxToolRounds +
          " model=" + model +
          " working=" + working.length +
          " assistantWithToolCalls=" + _tcA.length +
          " ofWhichHasRc=" + _tcRc.length);
      } catch (e) {}
      throw new Error(`上游请求失败 HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }
    if (!resp.body) throw new Error("上游无响应体");

    // 流式读取：正文/思考链实时 emit；tool_calls 分片聚合成整轮工具
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let roundContent = "";
    let roundReasoning = "";
    let seenContent = false;
    const toolCallAcc = [];
    const accToolCall = (tcs) => {
      for (const tc of (tcs || [])) {
        if (!tc) continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let slot = toolCallAcc[idx];
        if (!slot) {
          slot = toolCallAcc[idx] = { id: "", name: "", args: "", eventIndex: null, startSent: false };
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function && tc.function.name) slot.name += tc.function.name;
        if (typeof tc.function.arguments === "string") {
          const deltaArgs = tc.function.arguments;
          slot.args += deltaArgs;
          if (slot.eventIndex !== null) emit({ type: "tool_args_delta", index: slot.eventIndex, id: slot.id, delta: deltaArgs });
        }
        // 第一次拿到工具名时分配最终全局 index；start/end 永远复用它。
        if (slot.name && slot.eventIndex === null) {
          slot.eventIndex = toolSeq++;
          slot.startSent = true;
          const toolNode = { type: "tool", tool: { index: slot.eventIndex, id: slot.id, name: slot.name, args: slot.args || "", status: "running", result: "", error: null } };
          streamTimeline.push(toolNode);
          emit({ type: "tool_start", index: slot.eventIndex, id: slot.id, name: slot.name, args: slot.args || "" });
        }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 2026-09-21 审查 R7：客户端断开即取消上游流并结束本轮
      if (clientGone) { try { await reader.cancel(); } catch (e) {} break; }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).replace(/^\s+/, "");
        if (!payload || payload === "[DONE]") continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        const choice = evt && evt.choices && evt.choices[0]; if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
          roundReasoning += delta.reasoning_content;
          emit({ type: "reasoning", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content.length) {
          // 不在后端注入任何“气泡分隔符”。气泡分隔符属于前端配置，工具/正文顺序由事件时间线保存。
          seenContent = true;
          roundContent += delta.content;
          const lastTimeline = streamTimeline.length ? streamTimeline[streamTimeline.length - 1] : null;
          if (lastTimeline && lastTimeline.type === "text") lastTimeline.text += delta.content;
          else streamTimeline.push({ type: "text", text: delta.content });
          emit({ type: "text", text: delta.content });
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) accToolCall(delta.tool_calls);
        if (evt.usage) totalUsage = evt.usage;
      }
    }
    // 上游最后一帧可能没有换行；把残留 SSE 行补处理。
    buf += decoder.decode();
    if (buf.trim()) {
      const trimmed = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).replace(/^\s+/, "");
        if (payload && payload !== "[DONE]") {
          let evt; try { evt = JSON.parse(payload); } catch { evt = null; }
          const choice = evt && evt.choices && evt.choices[0];
          if (choice) {
            const delta = choice.delta || {};
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
              roundReasoning += delta.reasoning_content;
              emit({ type: "reasoning", text: delta.reasoning_content });
            }
            if (typeof delta.content === "string" && delta.content.length) {
              seenContent = true;
              roundContent += delta.content;
              const lastTimeline = streamTimeline.length ? streamTimeline[streamTimeline.length - 1] : null;
              if (lastTimeline && lastTimeline.type === "text") lastTimeline.text += delta.content;
              else streamTimeline.push({ type: "text", text: delta.content });
              emit({ type: "text", text: delta.content });
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) accToolCall(delta.tool_calls);
            if (evt.usage) totalUsage = evt.usage;
          }
        }
      }
    }
    if (roundReasoning) reasoningParts.push(roundReasoning);
    if (seenContent) contentParts.push(roundContent);

    // 2026-09-21 审查 R7：断开后不再执行本轮工具
    if (clientGone) break;
    const toolCalls = toolCallAcc.map(function (s, i) {
      if (!s || !s.name) return null;
      return { _sourceIndex: i, id: s.id || ("call_" + Date.now() + "_" + i), type: "function", function: { name: s.name, arguments: s.args || "{}" } };
    }).filter(Boolean);
    working.push({ role: "assistant", content: roundContent || "", reasoning_content: roundReasoning || undefined, tool_calls: toolCalls.length ? toolCalls : undefined });
    if (!toolCalls.length) break;

    for (let i = 0; i < toolCalls.length; i++) {
      if (clientGone) break; // 2026-09-21 审查 R7
      const tc = toolCalls[i];
      const fn = tc.function || {}; const name = fn.name || "";
      const args = _parseArgs(fn.arguments);
      _injectSessionArg(name, args, sessionId);
      const slot = toolCallAcc[typeof tc._sourceIndex === "number" ? tc._sourceIndex : i] || null;
      const index = slot && slot.eventIndex !== null ? slot.eventIndex : toolSeq++;
      const id = tc.id;
      const toolTime = _toolCallTime();   // 调用时间=执行起点
      // tool_start 已在上游流中实时发出；只有异常情况下没拿到名字的才补发。
      if (!slot || !slot.startSent) {
        streamTimeline.push({ type: "tool", tool: { index, id, name, args: "", status: "running", result: "", error: null } });
        emit({ type: "tool_start", index, id, name, args: "" });
      }
      let result, error = null;
      try { result = await callToolByExposedName(serverClients, routes, name, args); }
      catch (e) { error = e.message || String(e); result = { markdown: JSON.stringify({ type: "tool_error", error: "mcp_service_error", message: error }) }; }
      const resTrunc = _truncateResult(result.markdown || "", error ? 0 : 20000);
      // 来源标记：与 executeToolCalls 同一格式（工具名+调用时间+状态+结果，空/失败显式）
      working.push({ role: "tool", tool_call_id: id, content: buildToolResultContent({ name, time: toolTime, error, markdown: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS) }) });
      toolHistory.push({ name, args, time: toolTime, result: resTrunc, error });
      const timelineTool = streamTimeline.find(function (n) { return n && n.type === "tool" && n.tool && n.tool.index === index; });
      if (timelineTool && timelineTool.tool) {
        // 工具名/ID 可能在流的早期尚未到齐；终态必须把完整身份回填到 canonical timeline。
        timelineTool.tool.id = id;
        timelineTool.tool.name = name;
        timelineTool.tool.args = args;
        timelineTool.tool.time = toolTime;
        timelineTool.tool.result = resTrunc;
        timelineTool.tool.error = error;
        timelineTool.tool.status = error ? "failed" : "done";
      }
      emit({ type: "tool_end", index, id, name, args, result: resTrunc, error, ok: !error });
    }
  }

  let text = contentParts.join("\n\n").trim();
  if (!text) text = "（工具调用轮次已达上限，模型未给出最终回复，请重试或简化请求）";
  const reasoning = reasoningParts.join("\n\n").slice(0, MAX_REASONING_CHARS);
  const segs = String(text || "").split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!segs.length) segs.push(text || "");
  return { text, rounds, usage: totalUsage, routes, reasoning, toolHistory, streamTimeline: streamTimeline.slice(), segments: segs.slice(), finalMessages: working.slice() };
}


/**
 * 把最终文本 + 思考链 + 工具记录转成 OpenAI 兼容 SSE 流。
 * 事件顺序：思考链 → 工具记录(tool_trace) → 正文 content → 结束。
 * 注意：这是伪流式——事件虽按小块切分，但整包一次性 enqueue 下发（无逐块延迟），
 * 仅保证客户端走与真流式相同的解析路径。
 * @returns {ReadableStream}
 */
function buildSSE(text, {
  model = "",
  finishReason = "stop",
  usage = null,
  reasoning = "",
  toolHistory = []
} = {}) {
  const enc = new TextEncoder();
  const events = [];
  const base = () => ({
    id: "chatcmpl-mcp",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model
  });
  const push = (obj) => events.push(`data: ${JSON.stringify(obj)}\n\n`);

  // 1. 思考链（reasoning_content）分块流出
  const rs = 60;
  for (let i = 0; i < reasoning.length; i += rs) {
    push({
      ...base(),
      choices: [{ index: 0, delta: { reasoning_content: reasoning.slice(i, i + rs) }, finish_reason: null }]
    });
  }

  // 2. 工具调用记录：一次性以 delta.tool_trace 下发，前端据此渲染工具胶囊
  if (toolHistory && toolHistory.length) {
    push({
      ...base(),
      choices: [{ index: 0, delta: { tool_trace: toolHistory }, finish_reason: null }]
    });
  }

  // 3. 正文 content 分块流出
  const size = 24;
  for (let i = 0; i < text.length; i += size) {
    push({
      ...base(),
      choices: [{ index: 0, delta: { content: text.slice(i, i + size) }, finish_reason: null }]
    });
  }

  // 4. 结尾（usage / finish_reason）
  push({
    ...base(),
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage
  });
  events.push("data: [DONE]\n\n");

  const data = events.join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(data));
      controller.close();
    }
  });
}


module.exports = {
  runWithTools,
  streamToolLoop,
  buildSSE,
  DEFAULT_MAX_TOOL_ROUNDS,
  _toolCallTime,
  buildToolResultContent
};
