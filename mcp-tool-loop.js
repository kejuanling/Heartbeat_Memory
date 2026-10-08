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
const upstreamAlert = require("./lib/upstream-alert"); // 2026-09-28 上游 402（余额不足）提醒

// 2026-09-30 日志加时间（q5 清理项）：error.log 无时间戳，本模块被聊天/唤醒共用，
// 错误统一带本地时间前缀，与 wake-scheduler.js logErr / wake-chat.js wakeLogWarn 同一口径。
// 时间独立成前缀、原 [mcp]/[mcp-diag]/[diary] tag 保留在消息里，按 tag grep 的旧习惯不受影响。
function mcpNowLocal() {
  try {
    const tu = require("./time_utils");
    const p = tu.getDatePartsInTimeZone(new Date(), tu.resolveTimeZone());
    return p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute + ":" + p.second;
  } catch (e) { return new Date().toISOString(); }
}
function mcpLogWarn(msg) { console.warn("[" + mcpNowLocal() + "] " + msg); }

const DEFAULT_MAX_TOOL_ROUNDS = 10; // 1004-03：聊天/唤醒工具循环上限 6→10
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

// diary_add 写日记 → 时间线落库。工具端只把正文写进日记存储、回执不返正文，服务端无从从回执里
// 提取 [DIARY] 落库，AI 重建上下文时就看不到自己写过什么（keh3 9-28 三篇全缺）。由调用方传
// onDiaryWritten 回调补一条 kind=diary 隐藏消息（isRealDiary 保护，永不压缩）。
// 2026-10-03：原先这段只写在 executeToolCalls（非流式兜底路径）里，streamToolLoop —— 也就是生产
// 主路径 —— 完全没有，导致流式对话里用 diary_add 工具写的日记从不落时间线。现由两条循环共用本函数，
// 判定口径只有这一处，不会再漂移。
function _notifyDiaryWritten(name, args, error, result, onDiaryWritten, sessionId) {
  if (name !== "diary_add" || error || typeof onDiaryWritten !== "function") return;
  const dText = (args && typeof args.content === "string" && args.content.trim()) ? args.content.trim() : "";
  if (!dText) return;
  // 2026-10-19：从工具回执解析新条目 id（tools_server.py 的 diary_add 返回 JSON 带 diary_id），
  // 时间线消息据此打外键。解析失败（旧版工具/非 JSON 回执）不阻断落库，只是这条没有外键。
  let diaryId = null;
  try {
    const parsed = JSON.parse(String((result && result.markdown) || ""));
    if (parsed && parsed.diary_id != null) diaryId = parsed.diary_id;
  } catch (e) {}
  try { onDiaryWritten(sessionId, dText, diaryId); } catch (e) { mcpLogWarn("[diary] 时间线落库回调失败: " + e.message); }
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
 *  - onDiaryWritten : 可选回调 (sessionId, 正文)，diary_add 工具成功后调用，把日记落时间线
 * @returns {Promise<{text:string, rounds:number, usage:any, reasoning:string, toolHistory:Array}>}
 */

// MiniMax 等模型把思考链直接写在 content 的 <think> 块里（非 reasoning_content 字段），
// 剥离进 reasoning，避免思考泄漏成正文显示/落库。
function splitThinkBlock(text) {
  if (typeof text !== "string" || !text) return { body: "", think: "" };
  const re = /<think>([\s\S]*?)<\/think>/g;
  const thinks = [];
  let m;
  while ((m = re.exec(text))) { if (m[1] && m[1].trim()) thinks.push(m[1].trim()); }
  if (!thinks.length) return { body: text, think: "" };
  return { body: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), think: thinks.join("\n") };
}

// 2026-10-01 MiniMax 跨帧剥离状态机：SSE 帧可能把 <think> 拆成 <th / ink> 等多帧，
// 逐帧正则匹配不到，必须 buffer 累积：完整块提取进思考链，残片（含未闭合 <think> 前缀）等下一帧。
// 1008-16 修复：push 兜底分支此前从 buf[0] 切片输出，完整 think 块匹配后（last 已越过该块）
// 又把思考链原样复制回正文 → MiniMax 正文出现 thinking 链且折叠区也有一份（复制而非移除）。
// 改为从 last 切片，仅输出未处理的尾部；拆帧（<th/ink> 等）由 PREFIXES 保留逻辑继续兜底。
function createThinkStripper() {
  let buf = "";
  let thinking = "";
  const re = /<think>([\s\S]*?)<\/think>/g;
  const PREFIXES = ["<", "<t", "<th", "<thi", "<thin", "<think"];
  return {
    push(text, cb) {
      buf += text;
      let out = "", last = 0;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(buf))) {
        out += buf.slice(last, m.index);
        if (m[1] && m[1].trim()) thinking += m[1].trim() + "\n";
        last = m.index + m[0].length;
      }
      const openIdx = buf.indexOf("<think", last);
      if (openIdx >= 0) {
        out += buf.slice(last, openIdx);
        buf = buf.slice(openIdx);
      } else {
        let keep = 0;
        for (let i = 0; i < PREFIXES.length; i++) {
          if (buf.endsWith(PREFIXES[i])) keep = Math.max(keep, PREFIXES[i].length);
        }
        if (keep > 0) {
          out += buf.slice(last, buf.length - keep);
          buf = buf.slice(buf.length - keep);
        } else {
          out += buf.slice(last);
          buf = "";
        }
      }
      if (out && cb) cb(out);
      return this;
    },
    takeThinking() {
      const t = thinking;
      thinking = "";
      return t;
    },
    flush() {
      buf = "";
    }
  };
}
// 1007 上下文快照 v2：工具定义冻死。
// 取工具顺序：快照里有 tools → 直接用（不拉 MCP）；没有 → loadTools 并回填快照。
// 快照 tools 为 null（尚未回填）时仍以快照存在为准：首次请求拉取后回填，之后永远用快照的。
async function getToolsForSession(snapshotV2, baseDir, sessionId, serverClients) {
  if (snapshotV2 && baseDir && sessionId) {
    try {
      const snap = snapshotV2.loadSnapshot(baseDir, sessionId);
      if (snap && Array.isArray(snap.tools) && snap.tools.length > 0) {
        return snap.tools; // 冻死：永远用快照里的
      }
      // 快照存在但 tools 未回填（或为空）→ 拉取一次并回填
      const routes = await loadTools(serverClients);
      const openaiTools = toOpenAITools(routes || []);
      if (snap && openaiTools.length > 0) {
        const updated = Object.assign({}, snap, { tools: openaiTools, tools_fp: snapshotV2.toolsFpOf(openaiTools) });
        snapshotV2.saveSnapshot(baseDir, sessionId, updated);
        console.log("[ctx-snapshot-v2] 工具已回填快照 session=" + sessionId + " tools=" + openaiTools.length);
      }
      return openaiTools;
    } catch (e) {
      console.warn("[ctx-snapshot-v2] 快照取工具失败，回退实时拉取:", e && e.message);
    }
  }
  const routes = await loadTools(serverClients);
  return toOpenAITools(routes || []);
}

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
  sessionId = null,
  onDiaryWritten = null,
  snapshotV2 = null,
  baseDir = null
}) {
  // 1. 加载 MCP 工具，转成 OpenAI tools[]（1007：快照优先，冻死）
  const openaiTools = await getToolsForSession(snapshotV2, baseDir, sessionId, serverClients);
  const allRoutes = openaiTools;
  // 1007-17 修复：下面 toolCtx 与函数返回值都引用了 routes，但 1007-16 把工具加载改成
  // getToolsForSession 后只留下 openaiTools，routes 已无人定义 → ReferenceError，
  // 工具循环一进来就崩、回退原逻辑。这里补回原始 MCP 路由：
  // 注意两者不是一回事——openaiTools 是发给上游的工具定义（走快照冻死），
  // routes 是「按暴露名找到并执行工具」用的原始路由（含 exposedName/serverId/tool.name），
  // callToolByExposedName 只认后者，不能用 openaiTools 顶替。
  const routes = await loadTools(serverClients);
  // 2026-10-03：onDiaryWritten 必须进 toolCtx —— executeToolCalls 读的是 ctx.onDiaryWritten，
  // 而本函数的参数表此前根本不接受它、toolCtx 也不带，server.js 传的回调在签名这层就被丢掉，
  // 0929-03 那次「修复」实际从未生效：diary_add 写的日记两条路径都没落过时间线。
  const toolCtx = { serverClients, routes, upstreamUrl, upstreamKey, model, sessionId, onDiaryWritten };

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
      // 2026-09-26：上游拉不到图片时整包 400，去图重试一次（与聊天侧图片降级同源保护）
      if (resp.status === 400 && /failed to download image/i.test(t) && stripImagePartsForDegrade(working)) {
        mcpLogWarn("[mcp] runWithTools 上游拉取图片失败(400)，去图后重试本轮");
        round--;
        continue;
      }
      // 2026-09-23 诊断（reasoning_content 400 定位用）：记录出错轮次与上下文中
      // 「带 tool_calls 的 assistant」及其 reasoning_content 覆盖情况——
      // 用于区分「首轮上下文问题」还是「后续轮回传问题」。定位到根因后可移除或降级。
      try {
        const _tcA = working.filter(function (m) { return m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length; });
        const _tcRc = _tcA.filter(function (m) { return typeof m.reasoning_content === "string" && m.reasoning_content.length > 0; });
        mcpLogWarn("[mcp-diag] runWithTools 上游失败: status=" + resp.status +
          " round=" + round + "/" + maxToolRounds +
          " model=" + model +
          " working=" + working.length +
          " assistantWithToolCalls=" + _tcA.length +
          " ofWhichHasRc=" + _tcRc.length +
          " tail3=" + working.slice(-3).map(function (m) { return (m && m.role) || "?"; }).join("/"));
      } catch (e) {}
      if (resp.status === 402) upstreamAlert.note402({ model, detail: t, sessionId }).catch(function () {});
      throw new Error(`上游请求失败 HTTP ${resp.status}: ${t.slice(0, 300)}`);
    }

    const data = await resp.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error("上游返回无 choices");
    const msg = choice.message || {};
    if (data.usage) totalUsage = data.usage;

    // 收集思考链（reasoning_content/reasoning 字段 + content 内 <think> 块，2026-09-29 MiniMax 修复）
    const _sp = splitThinkBlock(String(msg.content || ""));
    const _rparts = [];
    const _rc = String(msg.reasoning_content || msg.reasoning || "").trim();
    if (_rc) _rparts.push(_rc);
    if (_sp.think) _rparts.push(_sp.think);
    const rtext = _rparts.join("\n").trim();
    if (rtext) { reasoningParts.push(rtext); emit({ type: "reasoning", text: rtext }); }

    // 收集本轮正文（<think> 块已剥离；混合轮文本保留，见 contentParts 注释）
    const ctext = _sp.body.trim();
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
      content: _sp.body || "",
      reasoning_content: rtext,   // 2026-09-28：DeepSeek 要求所有 assistant 都带 rc（空串也可），不能省略
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
    mcpLogWarn("[mcp] 工具轮次耗尽兜底: rounds=" + rounds + " textLen=0");
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
    _notifyDiaryWritten(name, args, error, result, ctx.onDiaryWritten, ctx.sessionId);
    if (typeof onEvent === "function") onEvent({ type: "tool_end", index, id, name, args, result: resTrunc, error, ok: !error, afterSeg: (typeof afterSeg === "number") ? afterSeg : -1 });
  }
}

// 2026-09-26 查岗截图配套：上游拉不到图片（CDN 拦截/文件失效）会整包 400。与聊天侧同款
// 保护——把消息里的 image_url 部件换成占位文本，调用方重试一次。返回是否发生了降级。
function stripImagePartsForDegrade(working) {
  let degraded = false;
  for (const m of working) {
    if (!m || !Array.isArray(m.content)) continue;
    for (let i = 0; i < m.content.length; i++) {
      const p = m.content[i];
      if (p && p.type === "image_url") {
        m.content[i] = { type: "text", text: "（图片暂时无法读取，本轮已省略）" };
        degraded = true;
      }
    }
  }
  return degraded;
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
  sessionId = null,
  onDiaryWritten = null,
  snapshotV2 = null,
  baseDir = null
}) {
  const openaiTools = await getToolsForSession(snapshotV2, baseDir, sessionId, serverClients);
  // 1007-17 修复：同上——本函数返回值里也引用了 routes（原加载被 getToolsForSession 替换后
  // 就没人定义了）。这是「回复整条丢失」的直接原因：流程全部跑完、到最后 return 才抛错，
  // catch 拿不到 r，外层只能回退。
  const routes = await loadTools(serverClients);
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
    // 客户端断开不中断循环——继续跑完上游请求
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
      // 2026-09-26：上游拉不到图片时整包 400，去图重试一次（与聊天侧图片降级同源保护）
      if (resp.status === 400 && /failed to download image/i.test(t) && stripImagePartsForDegrade(working)) {
        mcpLogWarn("[mcp] streamToolLoop 上游拉取图片失败(400)，去图后重试本轮");
        round--;
        continue;
      }
      // 2026-09-23 诊断：同 runWithTools，记录轮次与带 tool_calls 的 assistant 的 rc 覆盖情况
      try {
        const _tcA = working.filter(function (m) { return m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length; });
        const _tcRc = _tcA.filter(function (m) { return typeof m.reasoning_content === "string" && m.reasoning_content.length > 0; });
        mcpLogWarn("[mcp-diag] streamToolLoop 上游失败: status=" + resp.status +
          " round=" + round + "/" + maxToolRounds +
          " model=" + model +
          " working=" + working.length +
          " assistantWithToolCalls=" + _tcA.length +
          " ofWhichHasRc=" + _tcRc.length);
      } catch (e) {}
      if (resp.status === 402) upstreamAlert.note402({ model, detail: t, sessionId }).catch(function () {});
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
    const thinkStripper = createThinkStripper();
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
      // 客户端断开不取消上游流——网关继续跑完，结果存时间线，前端重连后可见
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).replace(/^\s+/, "");
        if (!payload || payload === "[DONE]") continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        // 1008-16 修复：Kimi/Moonshot 等上游的 usage 帧 choices 为空数组，此前被 !choice continue 跳过 → 落盘 tokens 恒 null
        if (evt && evt.usage) totalUsage = evt.usage;
        const choice = evt && evt.choices && evt.choices[0]; if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
          roundReasoning += delta.reasoning_content;
          emit({ type: "reasoning", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content.length) {
          // 2026-10-01 MiniMax：content 内 <think> 块跨帧剥离进思考链（streamToolLoop 此前漏修，补齐）
          // 不在后端注入任何“气泡分隔符”。气泡分隔符属于前端配置，工具/正文顺序由事件时间线保存。
          thinkStripper.push(delta.content, function (cleanText) {
            if (!cleanText) return;
            seenContent = true;
            roundContent += cleanText;
            const lastTimeline = streamTimeline.length ? streamTimeline[streamTimeline.length - 1] : null;
            if (lastTimeline && lastTimeline.type === "text") lastTimeline.text += cleanText;
            else streamTimeline.push({ type: "text", text: cleanText });
            emit({ type: "text", text: cleanText });
          });
          const _thinkDelta = thinkStripper.takeThinking();
          if (_thinkDelta) { roundReasoning += _thinkDelta; emit({ type: "reasoning", text: _thinkDelta }); }
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
          if (evt && evt.usage) totalUsage = evt.usage;
          const choice = evt && evt.choices && evt.choices[0];
          if (choice) {
            const delta = choice.delta || {};
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
              roundReasoning += delta.reasoning_content;
              emit({ type: "reasoning", text: delta.reasoning_content });
            }
            if (typeof delta.content === "string" && delta.content.length) {
              thinkStripper.push(delta.content, function (cleanText) {
                if (!cleanText) return;
                seenContent = true;
                roundContent += cleanText;
                const lastTimeline = streamTimeline.length ? streamTimeline[streamTimeline.length - 1] : null;
                if (lastTimeline && lastTimeline.type === "text") lastTimeline.text += cleanText;
                else streamTimeline.push({ type: "text", text: cleanText });
                emit({ type: "text", text: cleanText });
              });
              const _thinkDelta = thinkStripper.takeThinking();
              if (_thinkDelta) { roundReasoning += _thinkDelta; emit({ type: "reasoning", text: _thinkDelta }); }
            }
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) accToolCall(delta.tool_calls);
            if (evt.usage) totalUsage = evt.usage;
          }
        }
      }
    }
    if (roundReasoning) reasoningParts.push(roundReasoning);
    if (seenContent) contentParts.push(roundContent);
    thinkStripper.flush();

    // 客户端断开后继续执行工具——结果要攒下来写入时间线
    const toolCalls = toolCallAcc.map(function (s, i) {
      if (!s || !s.name) return null;
      return { _sourceIndex: i, id: s.id || ("call_" + Date.now() + "_" + i), type: "function", function: { name: s.name, arguments: s.args || "{}" } };
    }).filter(Boolean);
    working.push({ role: "assistant", content: roundContent || "", reasoning_content: roundReasoning, tool_calls: toolCalls.length ? toolCalls : undefined });   // 2026-09-28：rc 空串也保留（DeepSeek 要求）
    if (!toolCalls.length) break;

    for (let i = 0; i < toolCalls.length; i++) {
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
      // 1004-11：落盘/前端 20KB 截断（防 assistant.tools 膨胀）；发给模型的走 MAX_TOOL_RESULT_CHARS(30KB)，
      // 模型可见更全、落盘瘦身——两条口径有意不同，勿合并。
      const resTrunc = _truncateResult(result.markdown || "", error ? 0 : 20000);
      // 来源标记：与 executeToolCalls 同一格式（工具名+调用时间+状态+结果，空/失败显式）
      working.push({ role: "tool", tool_call_id: id, content: buildToolResultContent({ name, time: toolTime, error, markdown: _truncateResult(result.markdown || "", MAX_TOOL_RESULT_CHARS) }) });
      toolHistory.push({ name, args, time: toolTime, result: resTrunc, error });
      // 2026-10-03：与 executeToolCalls 同口径补齐——流式主路径此前漏写，diary_add 日记不落时间线
      _notifyDiaryWritten(name, args, error, result, onDiaryWritten, sessionId);
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
  toolHistory = [],
  finalContent = null,      // 2026-09-24 B3：最终落盘版 content（含标签 storedText 口径），结尾帧以 final_content 下发
  finalTimeline = null      // 2026-09-24 B3：最终落盘版精简 timeline，结尾帧以 final_stream_timeline 下发
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
    usage,
    // 2026-09-24 B3：最终落盘版数据随流下发——自建前端据此落盘，与服务器时间线字节级一致，
    // 补拉不再触发数据替换。顶层字段（与 usage 平级），第三方客户端忽略未知字段，向后兼容；
    // 未提供时不下发（前端退回自己的映射，行为同旧版）。
    ...(finalContent != null ? { final_content: finalContent } : {}),
    ...(finalTimeline != null ? { final_stream_timeline: finalTimeline } : {})
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
  buildToolResultContent,
  splitThinkBlock,
  createThinkStripper,
  getToolsForSession
};
