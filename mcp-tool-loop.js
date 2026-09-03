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
const memoryPool = require("./memory-pool");

const DEFAULT_MAX_TOOL_ROUNDS = 6;
const MAX_REASONING_CHARS = 4000; // 思考链最多保留字符数，避免过长
// 轮内上游超时：与 server.js 全局口径一致（此前硬编码 120s，比全局 180s 短，长回复会先于全局超时被误杀）
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 180000;
// 单条工具结果写进时间线的截断上限：防止超大结果（读文件/长网页）把 enhanced_messages.json 撑爆
const MAX_TOOL_RESULT_CHARS = 30000;

// ========================
// 内置（native）记忆浮现工具：surface_memory
// 与 MCP 服务器工具一起注入 openaiTools；执行时在本地分流到 memory-pool.retrieve，
// 不发送到 MCP 服务器（记忆池是服务端全局共享，无独立 MCP server）。
// ========================
const SURFACE_MEMORY_NAME = "surface_memory";
const MEMORY_RECALL_NAME = "memory_recall";
const SURFACE_CATEGORIES = ["关于她", "关于我们", "锚点", "信号", "对话摘要"];

const NATIVE_TOOLS = [
  {
    exposedName: SURFACE_MEMORY_NAME,
    serverName: "native",
    tool: {
      name: SURFACE_MEMORY_NAME,
      description:
        "从长期记忆池按需检索与当前话题相关的记忆。当你想回忆之前聊过或记过的、关于她/关于我们/锚点/信号/对话摘要的内容时调用；传入你要聊或正在聊的话题/关键词（query），返回最相关的记忆条目。若当前上下文缺少某段相关过往记忆，可用它补上。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "要检索的话题/关键词（必填）" },
          top_k: { type: "number", description: "最多返回的条数，默认 5，上限 20", minimum: 1, maximum: 20 },
          category: { type: "string", description: "可选：只检索某个分类（关于她/关于我们/锚点/信号/对话摘要）" }
        },
        required: ["query"]
      }
    }
  },
  {
    exposedName: MEMORY_RECALL_NAME,
    serverName: "native",
    tool: {
      name: MEMORY_RECALL_NAME,
      description:
        "按【语义/含义】从长期记忆池检索相关记忆。与 surface_memory（按关键词词面匹配）不同：当你觉得词面命中不好、或想按一段意思/问题找记忆（即便用词不同）时用它。传入你想找的问题或记忆的大意，系统会用语义模型从记忆池里挑出最相关的条目返回。若当前上下文缺某段相关过往记忆，可用它补上。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "想找的记忆/问题（必填），描述含义而非精确字词" },
          top_k: { type: "number", description: "最多返回的条数，默认 5，上限 20", minimum: 1, maximum: 20 },
          category: { type: "string", description: "可选：只检索某个分类（关于她/关于我们/锚点/信号/对话摘要）" }
        },
        required: ["query"]
      }
    }
  }
];

async function callSurfaceMemory(args) {
  try {
    const query = String((args && args.query) || "").trim();
    if (!query) {
      return {
        markdown: JSON.stringify({
          type: "tool_error",
          error: "invalid_query",
          message: "surface_memory 需要 query（要检索的话题/关键词）。"
        })
      };
    }
    const topK = Math.max(1, Math.min(20, Number((args && args.top_k) || 5) || 5));
    const category = (args && args.category && SURFACE_CATEGORIES.includes(String(args.category)))
      ? String(args.category)
      : undefined;
    const mems = memoryPool.retrieve(query, { topK: topK, category: category });
    if (!Array.isArray(mems) || mems.length === 0) {
      return { markdown: "未检索到相关记忆。" };
    }
    const lines = mems.map(function (m) {
      return "【" + (m.category || "其他") + "】" + (m.content || "") + (m.pinned ? "（置顶）" : "");
    });
    return { markdown: "检索到 " + mems.length + " 条相关记忆：\n" + lines.join("\n") };
  } catch (e) {
    return {
      markdown: JSON.stringify({
        type: "tool_error",
        error: "surface_memory_error",
        message: e.message || String(e)
      })
    };
  }
}

// 语义记忆召回：词面预筛候选 (~40) -> 上游免费模型按语义挑相关 -> 只返回挑中
async function callMemoryRecall(args, ctx) {
  try {
    const query = String((args && args.query) || "").trim();
    if (!query) {
      return {
        markdown: JSON.stringify({
          type: "tool_error",
          error: "invalid_query",
          message: "memory_recall 需要 query（想找的记忆/问题）。"
        })
      };
    }
    const topK = Math.max(1, Math.min(20, Number((args && args.top_k) || 5) || 5));
    const category = (args && args.category && SURFACE_CATEGORIES.includes(String(args.category)))
      ? String(args.category)
      : undefined;
    // 1. 词面预筛：拿全部 active 记忆，按词面相似度取前 ~40 做候选
    const rows = memoryPool.list({ active: true, category: category || undefined });
    const qt = memoryPool.tokensOf(query);
    const scored = rows.map(function (r) {
      const sim = qt.size ? memoryPool.contentSimilarity((r.content || "") + " " + (r.category || ""), query) : 0;
      return { r, sim };
    });
    scored.sort(function (a, b) {
      return (b.sim - a.sim) || ((Number(b.r.importance) || 0) - (Number(a.r.importance) || 0));
    });
    const cands = scored.slice(0, 40);
    if (cands.length === 0) return { markdown: "未找到相关记忆。" };

    // 2. 上游免费模型按语义挑最相关的 topK（失败/未配置则回退词面 topK）
    const picked = await rerankMemories(query, cands, topK, ctx);

    const results = [];
    for (const p of picked) {
      if (!p || !p.r) continue;
      results.push("【" + (p.r.category || "其他") + "】" + (p.r.content || "") + (p.r.pinned ? "（置顶）" : ""));
    }
    if (results.length === 0) return { markdown: "未找到语义相关的记忆。" };
    return { markdown: "语义检索到 " + results.length + " 条相关记忆：\n" + results.join("\n") };
  } catch (e) {
    return {
      markdown: JSON.stringify({
        type: "tool_error",
        error: "memory_recall_error",
        message: e.message || String(e)
      })
    };
  }
}

// 用上游免费模型从候选中按语义挑 topK；返回候选对象数组
async function rerankMemories(query, cands, topK, ctx) {
  const upUrl = ctx && ctx.upstreamUrl;
  const upKey = ctx && ctx.upstreamKey;
  const model = ctx && ctx.model;
  const fallback = cands.slice(0, topK);
  if (!upUrl || !upKey || !model) return fallback;
  const list = cands.map(function (c, i) {
    return i + ": 【" + (c.r.category || "其他") + "】" + String(c.r.content || "").slice(0, 300);
  }).join("\n");
  const system = "你是记忆检索助手。根据用户查询，从下面候选记忆里挑出【语义上最相关、对回答最有帮助】的若干条。只返回候选编号数组（编号从 0 开始，如 [3,7,9]），按相关性从高到低，最多 " + topK + " 条。若都不相关或无法判断，返回 []。不要输出编号之外的任何内容。";
  const user = "用户查询（按含义找记忆）：" + query + "\n候选记忆：\n" + list;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 20000);
  let resp;
  try {
    resp = await fetch(upUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + upKey },
      body: JSON.stringify({ model: model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, max_tokens: 256 }),
      signal: controller.signal
    });
  } finally { clearTimeout(timer); }
  if (!resp.ok) return fallback;
  const data = await resp.json().catch(function () { return null; });
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) return fallback;
  const arrayText = (String(content).match(/\[[^\]]*\]/g) || []).pop() || "";
  const nums = (String(arrayText).match(/\d+/g) || []).map(Number).filter(function (n) { return n >= 0 && n < cands.length; });
  const seen = new Set();
  const out = [];
  for (const n of nums) { if (!seen.has(n)) { out.push(cands[n]); seen.add(n); } }
  return out.slice(0, topK).length ? out.slice(0, topK) : fallback;
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
  resume = null
}) {
  // 1. 加载 MCP 工具，并叠加内置 native 工具（surface_memory），转成 OpenAI tools[]
  const routes = await loadTools(serverClients);
  const allRoutes = NATIVE_TOOLS.concat(routes || []);
  const openaiTools = toOpenAITools(allRoutes);
  const toolCtx = { serverClients, routes, upstreamUrl, upstreamKey, model };

  let working = messages.slice();
  let totalUsage = null;
  let rounds = 0;

  // 收集思考链（reasoning_content）与工具调用记录（tool_trace）
  const reasoningParts = [];
  const toolHistory = [];
  // T-0922 修复：每一轮模型说过的话都收集（同轮"文本+工具调用"混合时文本不再丢弃），
  // 按轮次拼接为最终回复——与主流聊天一致："我帮你查一下" →（工具跑）→ 结果补充
  const contentParts = [];

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
    if (rtext) reasoningParts.push(rtext);

    // 收集本轮正文（混合轮文本保留，见 contentParts 注释）
    const ctext = String(msg.content || "").trim();
    if (ctext) contentParts.push(ctext);

    // 记录这一轮 assistant 消息（含 tool_calls 则保留）
    working.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

    // 没有 tool_calls -> 结束
    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) break;

    // 执行每个 tool_call，并记录到 toolHistory 供前端展示
    await executeToolCalls(toolCalls, working, toolHistory, toolCtx);
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

  return { text, rounds, usage: totalUsage, routes, reasoning, toolHistory, finalMessages: working.slice() };
}

// 执行一批 tool_call：结果写入 working（供下一轮上游请求）与 toolHistory（供前端展示）
async function executeToolCalls(toolCalls, working, toolHistory, ctx) {
  const { serverClients, routes, upstreamUrl, upstreamKey, model } = ctx;
  for (const tc of toolCalls) {
    const fn = tc.function || {};
    const name = fn.name || "";
    const args = _parseArgs(fn.arguments);
    let result;
    let error = null;
    try {
      if (name === SURFACE_MEMORY_NAME) {
        result = await callSurfaceMemory(args);
      } else if (name === MEMORY_RECALL_NAME) {
        result = await callMemoryRecall(args, { upstreamUrl, upstreamKey, model });
      } else {
        result = await callToolByExposedName(serverClients, routes, name, args);
      }
    } catch (e) {
      error = e.message || String(e);
      result = { markdown: JSON.stringify({ type: "tool_error", error: "mcp_service_error", message: error }) };
    }
    working.push({
      role: "tool",
      tool_call_id: tc.id,
      // 截断超大工具结果：时间线/后续轮次上下文都不需要完整大结果，30k 字符足够模型引用
      content: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS)
    });
    toolHistory.push({
      name,
      args,
      result: _truncateResult(result.markdown || "", error ? 0 : 20000),
      error
    });
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
  max_tokens
}) {
  // 加载工具定义并注入 requests：让模型"有能力"调用工具，才能检测到 tool_calls。
  const routes = await loadTools(serverClients);
  const allRoutes = NATIVE_TOOLS.concat(routes || []);
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

  // 发现工具调用：尚未写 header，交给 runWithTools 接管
  if (sawToolCall) {
    console.log("[mcp] 流式直通检测到工具调用，回退 runWithTools");
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
        const r2 = await runWithTools({
          upstreamUrl, upstreamKey, model, messages, serverClients,
          temperature, top_p, max_tokens,
          resume: { assistantMsg: { role: "assistant", content: fullText, tool_calls: pending } }
        });
        // 续写（伪流式）：思考链 → 工具记录 → 后续正文；直通阶段的 fullText 已发给客户端，不重发
        const sse = buildSSE(r2.text || "", { model, reasoning: r2.reasoning || "", toolHistory: r2.toolHistory || [], usage: r2.usage || null });
        const rd = sse.getReader();
        while (true) {
          const { done, value } = await rd.read();
          if (done) break;
          emit(value);
        }
        try { reply.raw.end(); } catch {}
        return {
          ok: true, fellBackToTools: false,
          text: [fullText, r2.text].filter(t => t && String(t).trim()).join("\n\n"),
          reasoning: [reasoning, r2.reasoning].filter(t => t && String(t).trim()).join("\n\n"),
          usage: r2.usage || usage,
          toolHistory: r2.toolHistory || [],
          rounds: r2.rounds
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
  buildSSE,
  tryStreamPassthrough,
  DEFAULT_MAX_TOOL_ROUNDS
};
