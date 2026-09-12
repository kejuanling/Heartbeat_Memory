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
  maxToolsPerRound = 5,
  fetchFn = fetch,
  resume = null,
  onEvent = null,
  sessionId = null
}) {
  // 1. 加载 MCP 工具，转成 OpenAI tools[]
  const routes = await loadTools(serverClients);
  const allRoutes = routes || [];
  const openaiTools = toOpenAITools(allRoutes);
  const toolCtx = { serverClients, routes, upstreamUrl, upstreamKey, model, maxToolsPerRound, sessionId };

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
  const emit = (evt) => { try { if (typeof onEvent === "function") onEvent(evt); } catch (e) {} };
  let toolSeq = 0;

  // 直通续跑模式（T-0922）：流式直通路径已把该 assistant 消息（含 tool_calls）透传给客户端，
  // 从"执行其工具"开始接续；其 content 客户端已见过，不进 contentParts（避免重复显示）
  if (resume && resume.assistantMsg) {
    const am = resume.assistantMsg;
    working.push({ role: "assistant", content: am.content || "", tool_calls: am.tool_calls });
    await executeToolCalls(am.tool_calls || [], working, toolHistory, toolCtx);
  }

  for (let round = 0; round < maxToolRounds + 1; round++) {
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
    working.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

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
async function executeToolCalls(toolCalls, working, toolHistory, ctx, onEvent, nextIndex, afterSeg) {
  const { serverClients, routes, upstreamUrl, upstreamKey, model } = ctx;
  const maxPerRound = ctx.maxToolsPerRound || 5;
  for (let _i = 0; _i < toolCalls.length; _i++) {
    const tc = toolCalls[_i];
    const _isOverLimit = _i >= (ctx.maxToolsPerRound || 5);
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
      if (_isOverLimit) {
        result = { markdown: JSON.stringify({ type: "tool_skipped", error: "max_tools_per_round", message: `单轮工具调用数超过上限 ${ctx.maxToolsPerRound || 5}，该工具未执行。`, tool: name }) };
      } else {
        result = await callToolByExposedName(serverClients, routes, name, args);
      }
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
      content: buildToolResultContent({ name, time: toolTime, error: error || (_isOverLimit ? `单轮工具调用数超过上限 ${ctx.maxToolsPerRound || 5}，该工具未执行。` : null), markdown: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS) })
    });
    toolHistory.push({
      name,
      args,
      time: toolTime,
      result: resTrunc,
      error,
      afterSeg: (typeof afterSeg === "number") ? afterSeg : -1   // 方案2刷新：该工具位于第 afterSeg 段正文之后（-1=最前）
    });
    if (typeof onEvent === "function") onEvent({ type: "tool_end", index, id, name, args, result: resTrunc, error, ok: !error && !_isOverLimit, afterSeg: (typeof afterSeg === "number") ? afterSeg : -1 });
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

// 工具调用时间（Asia/Shanghai，精确到秒）；调用时间取执行起点，跨轮回灌时随 toolHistory 落盘复用。
// 用 UTC 取值器读 +8 偏移后的时刻，宿主机时区不影响结果
function _toolCallTime(d = new Date()) {
  const loc = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return loc.getUTCFullYear() + "-" + p(loc.getUTCMonth() + 1) + "-" + p(loc.getUTCDate()) + " " +
    p(loc.getUTCHours()) + ":" + p(loc.getUTCMinutes()) + ":" + p(loc.getUTCSeconds());
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

// 安全地统计「按空行分段的段数」（与前端 makeMsgEl / runWithTools 的 _segCount 口径一致）
function _countSegs(txt) {
  return String(txt || "").split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean).length;
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
  const contentParts = [];
  let toolSeq = 0;
  const emit = (evt) => { try { if (typeof onEvent === "function") onEvent(evt); } catch (e) {} };

  for (let round = 0; round < maxToolRounds + 1; round++) {
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
    if (!resp.ok) { const t = await resp.text().catch(() => ""); throw new Error(`上游请求失败 HTTP ${resp.status}: ${t.slice(0, 300)}`); }
    if (!resp.body) throw new Error("上游无响应体");

    // 流式读取：正文/思考链实时 emit；tool_calls 分片聚合成整轮工具
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let roundContent = "";
    let roundReasoning = "";
    let firstContentOfRound = true;
    let seenContent = false;
    const toolCallAcc = [];
    const accToolCall = (tcs) => {
      for (const tc of (tcs || [])) {
        if (!tc) continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let slot = toolCallAcc[idx]; if (!slot) slot = toolCallAcc[idx] = { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function && tc.function.name) slot.name += tc.function.name;
        if (typeof tc.function.arguments === "string") slot.args += tc.function.arguments;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          // 跨轮补空行分隔，保证前端流式拼接 full 与最终 text(contentParts.join("\n\n")) 一致（空行粒度分段）
          if (firstContentOfRound && contentParts.length > 0) emit({ type: "text", text: "\n\n" });
          firstContentOfRound = false; seenContent = true;
          roundContent += delta.content;
          emit({ type: "text", text: delta.content });
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) accToolCall(delta.tool_calls);
        if (evt.usage) totalUsage = evt.usage;
      }
    }
    if (roundReasoning) reasoningParts.push(roundReasoning);
    if (seenContent) contentParts.push(roundContent);

    const toolCalls = toolCallAcc.filter(s => s && s.name).map(function (s, i) {
      return { id: s.id || ("call_" + Date.now() + "_" + i), type: "function", function: { name: s.name, arguments: s.args || "{}" } };
    });
    working.push({ role: "assistant", content: roundContent || "", tool_calls: toolCalls.length ? toolCalls : undefined });
    if (!toolCalls.length) break;

    // afterSeg：该轮工具位于「已流式正文」的最后一段之后（-1 在刷新重建时会被归到末尾，故钳到 >=0）
    const afterSeg = Math.max(0, _countSegs(contentParts.join("\n\n")) - 1);
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const fn = tc.function || {}; const name = fn.name || "";
      const args = _parseArgs(fn.arguments);
      _injectSessionArg(name, args, sessionId);
      const index = toolSeq++; const id = tc.id;
      const toolTime = _toolCallTime();   // 调用时间=执行起点
      emit({ type: "tool_start", index, id, name, args, afterSeg });
      let result, error = null;
      try { result = await callToolByExposedName(serverClients, routes, name, args); }
      catch (e) { error = e.message || String(e); result = { markdown: JSON.stringify({ type: "tool_error", error: "mcp_service_error", message: error }) }; }
      const resTrunc = _truncateResult(result.markdown || "", error ? 0 : 20000);
      // 来源标记：与 executeToolCalls 同一格式（工具名+调用时间+状态+结果，空/失败显式）
      working.push({ role: "tool", tool_call_id: id, content: buildToolResultContent({ name, time: toolTime, error, markdown: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS) }) });
      toolHistory.push({ name, args, time: toolTime, result: resTrunc, error, afterSeg });
      emit({ type: "tool_end", index, id, name, args, result: resTrunc, error, ok: !error });
    }
  }

  let text = contentParts.join("\n\n").trim();
  if (!text) text = "（工具调用轮次已达上限，模型未给出最终回复，请重试或简化请求）";
  const reasoning = reasoningParts.join("\n\n").slice(0, MAX_REASONING_CHARS);
  const segs = String(text || "").split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!segs.length) segs.push(text || "");
  return { text, rounds, usage: totalUsage, routes, reasoning, toolHistory, segments: segs.slice(), finalMessages: working.slice() };
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

/**
 * 流式直通快速路径（普通聊天用）：
 * 直接以 stream:true 请求上游，逐块透传给客户端；同时解析每个 chunk，
 * 一旦发现 delta.tool_calls（模型想调工具）就中止透传，返回 { fellBackToTools: true }，
 * 由调用方回退到 runWithTools 工具循环。全程无工具调用则直接透传到底。
 *
 * 判定时机：deepseek 等模型若要调用工具，首个含内容/工具声明的 chunk 即会有 tool_calls
 * （先于任何 content 输出）。因此只读到"第一个决定性 chunk"即可判定：
 *   - 先出现 content  → 无工具调用，立即 writeHead + 回放已缓冲 + 继续透传（首字立即出）
 *   - 先出现 tool_calls → 不写 header（此时 reply.raw 仍干净），回退 runWithTools 接管
 * 这样既拿到真流式，又保证"headers already sent"不会发生。
 *
 * @returns {Promise<{ok:boolean, fellBackToTools?:boolean}>}
 */
async function tryStreamPassthrough({
  upstreamUrl,
  upstreamKey,
  model,
  messages,
  serverClients,
  body,
  reply,
  temperature,
  top_p,
  max_tokens,
  sessionId = null
}) {
  // 加载工具定义并注入 requests：让模型"有能力"调用工具，才能检测到 tool_calls。
  const routes = await loadTools(serverClients);
  const allRoutes = routes || [];
  const openaiTools = toOpenAITools(allRoutes);

  const payload = {
    model,
    messages,
    stream: true,
    temperature,
    top_p,
    max_tokens,
    ...(openaiTools.length ? { tools: openaiTools, tool_choice: "auto" } : {}),
    ...(body && body.stream_options ? { stream_options: body.stream_options } : {})
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${upstreamKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok || !resp.body) {
    return { ok: false, fellBackToTools: false };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let head = "";             // 阶段一判定"是 content"时那一行被 break 吞掉，需存起来供阶段二回放，否则回复开头丢 content
  let decided = false;       // 是否已确立"无工具/有工具"
  let sawToolCall = false;
  let sawContent = false;

  const analyzeLine = (rawLine) => {
    if (!rawLine.startsWith("data:")) return false;
    const payloadLine = rawLine.slice(5).replace(/^\s+/, "");
    if (!payloadLine || payloadLine === "[DONE]") return false;
    let evt;
    try { evt = JSON.parse(payloadLine); } catch (e) { return false; }
    const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
    if (delta && delta.tool_calls && delta.tool_calls.length) { sawToolCall = true; return true; }
    if (delta && typeof delta.content === "string" && delta.content.length > 0) { sawContent = true; return true; }
    return false;
  };

  // ---- 阶段一：读到第一个"决定性"chunk（content 或 tool_calls），期间只缓存不写头 ----
  while (!decided && !sawToolCall) {
    const { done, value } = await reader.read();
    if (done) break; // 流自然结束且无决定性事件：视为无工具，正常透传
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // 阶段一从 buffer 切走的每一行（role / reasoning_content / 首个 content 等）必须记入 head 回放，
      // 否则客户端流会缺这些事件——"回复开头缺字"正是首个 content 行被吞（analyzeLine 返回布尔，
      // 无法区分类型，故无条件全量回放，与上游字节一致）。
      head += rawLine + "\n";
      if (analyzeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine)) { decided = true; break; }
    }
    if (decided || sawToolCall) break;
  }

  // 发现工具调用：尚未写 header，交给流式工具循环接管（streamToolLoop，正文/工具均流式）
  if (sawToolCall) {
    console.log("[mcp] 流式直通检测到工具调用，回退流式工具循环");
    return { ok: true, fellBackToTools: true };
  }

  // ---- 阶段二：确认无工具，开始真正透传（写头 + 回放缓冲 + 继续读剩余流）----
  console.log("[mcp] 流式直通: 本请求无工具调用，直接透传");
  reply.raw.writeHead(resp.status, {
    "Content-Type": resp.headers.get("content-type") || "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const emit = (str) => { try { reply.raw.write(str); } catch (e) {} };
  let fullText = "";
  let reasoning = "";
  let usage = null;
  // T-0922 修复：聚合流式 tool_calls（模型"先说话后调工具"时，阶段一判定被首个 content 骗过、
  // 走了透传，标准 delta.tool_calls 事件被原样发给前端但前端不消费、工具未执行）。
  // 流式 tool_calls 是分片增量：按 index 聚合，id/name 首片给全、arguments 逐片拼接。
  const toolCallAcc = [];
  const accToolCall = (tcs) => {
    for (const tc of tcs) {
      if (!tc) continue;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let slot = toolCallAcc[idx];
      if (!slot) slot = toolCallAcc[idx] = { id: "", name: "", args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function) {
        if (tc.function.name) slot.name += tc.function.name;
        if (typeof tc.function.arguments === "string") slot.args += tc.function.arguments;
      }
    }
  };
  // 继续解析并采集全文（供调用方写时间线 / 提取 <memory> 等标签）
  const collect = (rawLine) => {
    if (!rawLine.startsWith("data:")) return;
    const payloadLine = rawLine.slice(5).replace(/^\s+/, "");
    if (!payloadLine || payloadLine === "[DONE]") return;
    let evt;
    try { evt = JSON.parse(payloadLine); } catch (e) { return; }
    const choice = evt && evt.choices && evt.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") fullText += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) accToolCall(delta.tool_calls);
    if (evt.usage) usage = evt.usage;
  };
  try {
    // 采集 buffer / chunk 里的 SSE data 行喂给 collect，让 fullText/reasoning/usage 真正累积。
    // 透传字节流仍由 emit 原样写给客户端，这里只做旁路采集，绝不改动发给浏览器的内容。
    let sseBuf = ""; // collect 只认单行 "data:"，chunk 可能含多行/半行，需按行切分
    const collectFeed = (text) => {
      sseBuf += text;
      let nl;
      while ((nl = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nl);
        sseBuf = sseBuf.slice(nl + 1);
        collect(line.replace(/\r$/, ""));
      }
    };
    if (head) { emit(head); collectFeed(head); }
    if (buffer) { emit(buffer); collectFeed(buffer); }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      emit(chunk);
      collectFeed(chunk);
    }
    // 上游流结束时若尾巴残留一条未换行的 data 行，补采一次，避免最后一条 content 丢失
    if (sseBuf) collect(sseBuf.replace(/\r$/, ""));
    // T-0922 修复：模型"先说话后调工具"被直通误判后，漏掉的工具调用在此补上——
    // 客户端流尚未 end：补执行工具循环（resume 断点续跑），把后续回复续写进同一轮流。
    // 客户端体验：先看到流式文本（真流式），工具执行完后继续收到补充内容，接近主流"边说边查再补充"。
    const pending = toolCallAcc.filter(s => s && s.name).map((s, i) => ({
      id: s.id || ("call_pt_" + Date.now() + "_" + i),
      type: "function",
      function: { name: s.name, arguments: s.args || "{}" }
    }));
    if (pending.length) {
      try {
        console.log("[mcp] 流式直通发现后置工具调用（先文本后工具），补执行并续写: " + pending.map(t => t.function.name).join(","));
        const fullSegs = String(fullText || "").split(/\n\s*\n/).map(function(s){return s.trim();}).filter(Boolean);
        const r2 = await runWithTools({
          upstreamUrl, upstreamKey, model, messages, serverClients,
          temperature, top_p, max_tokens,
          resume: { assistantMsg: { role: "assistant", content: fullText, tool_calls: pending } },
          sessionId
        });
        // 续写（伪流式）：思考链 → 工具记录 → 后续正文；直通阶段的 fullText 已发给客户端，不重发。
        // 直通文本若不以空行结尾则先补一个空行分隔，保证客户端流式拼接 full 与最终 text 一致（空行粒度分段）
        const _needSep = !/[\r\n]{2,}\s*$/.test(String(fullText || ""));
        const sse = buildSSE((_needSep ? "\n\n" : "") + (r2.text || ""), { model, reasoning: r2.reasoning || "", toolHistory: r2.toolHistory || [], usage: r2.usage || null });
        const rd = sse.getReader();
        while (true) {
          const { done, value } = await rd.read();
          if (done) break;
          emit(value);
        }
        try { reply.raw.end(); } catch {}
        // 方案2刷新：segments 按空行粒度拆（与前端 makeMsgEl 一致）；工具 afterSeg 对齐同一分段下标。
        // r2 内部轮次工具 afterSeg 以 r2.text 为基准 → 偏移 fullSegs 段数；直通续跑工具(afterSeg=-1) → 直通文本末段之后
        const finalText = [fullText, r2.text].filter(t => t && String(t).trim()).join("\n\n");
        const segs = String(finalText || "").split(/\n\s*\n/).map(function(s){return s.trim();}).filter(Boolean);
        if (!segs.length) segs.push(finalText || "");
        const th = (r2.toolHistory || []).map(function(t){
          if (t && typeof t.afterSeg === "number" && t.afterSeg >= 0) return Object.assign({}, t, { afterSeg: t.afterSeg + fullSegs.length });
          return Object.assign({}, t, { afterSeg: fullSegs.length ? fullSegs.length - 1 : -1 });
        });
        return {
          ok: true, fellBackToTools: false,
          text: finalText,
          reasoning: [reasoning, r2.reasoning].filter(t => t && String(t).trim()).join("\n\n"),
          usage: r2.usage || usage,
          toolHistory: th,
          rounds: r2.rounds,
          segments: segs
        };
      } catch (resumeErr) {
        // 续跑失败：客户端已收到直通文本，正常收尾返回已透传内容（仅工具结果缺失）
        console.warn("[mcp] 直通后置工具续跑失败（客户端已收到文本）:", resumeErr.message);
      }
    }
  } catch (e) {
    try { reply.raw.end(); } catch {}
    return { ok: false, fellBackToTools: false };
  }
  try { reply.raw.end(); } catch {}
  return { ok: true, fellBackToTools: false, text: fullText, reasoning, usage };
}

module.exports = {
  runWithTools,
  streamToolLoop,
  buildSSE,
  tryStreamPassthrough,
  DEFAULT_MAX_TOOL_ROUNDS,
  _toolCallTime,
  buildToolResultContent
};
