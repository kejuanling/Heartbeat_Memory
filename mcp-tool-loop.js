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

// ========================
// 内置（native）记忆浮现工具：surface_memory
// 与 MCP 服务器工具一起注入 openaiTools；执行时在本地分流到 memory-pool.retrieve，
// 不发送到 MCP 服务器（记忆池是服务端全局共享，无独立 MCP server）。
// ========================
const SURFACE_MEMORY_NAME = "surface_memory";
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
  fetchFn = fetch
}) {
  // 1. 加载 MCP 工具，并叠加内置 native 工具（surface_memory），转成 OpenAI tools[]
  const routes = await loadTools(serverClients);
  const allRoutes = NATIVE_TOOLS.concat(routes || []);
  const openaiTools = toOpenAITools(allRoutes);

  let working = messages.slice();
  let finalText = "";
  let totalUsage = null;
  let rounds = 0;

  // 收集思考链（reasoning_content）与工具调用记录（tool_trace）
  const reasoningParts = [];
  const toolHistory = [];

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
    // 只在还有工具时注入 tools（最后一轮如果没有工具就不带）
    if (round < maxToolRounds && openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
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

    // 记录这一轮 assistant 消息（含 tool_calls 则保留）
    working.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });

    // 没有 tool_calls -> 结束
    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      finalText = msg.content || "";
      break;
    }

    // 执行每个 tool_call，并记录到 toolHistory 供前端展示
    for (const tc of toolCalls) {
      const fn = tc.function || {};
      const name = fn.name || "";
      const args = _parseArgs(fn.arguments);
      let result;
      let error = null;
      try {
        if (name === SURFACE_MEMORY_NAME) {
          result = await callSurfaceMemory(args);
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
        content: result.markdown || ""
      });
      toolHistory.push({
        name,
        args,
        result: _truncateResult(result.markdown || "", error ? 0 : 800),
        error
      });
    }
  }

  // 汇总思考链（截断上限）
  const reasoning = reasoningParts.join("\n\n").slice(0, MAX_REASONING_CHARS);

  return { text: finalText, rounds, usage: totalUsage, routes, reasoning, toolHistory };
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
  buildSSE,
  DEFAULT_MAX_TOOL_ROUNDS
};
