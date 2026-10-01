'use strict';
// 对话侧 / 唤醒侧共用的上下文加工函数（2026-09-15 唤醒并入网关）。
// 从 routes/chat.js 原样搬入：工具调用记录转换、容量提醒守卫；
// 新增：tool 配对修复提取、出口字段净化、developer 头部注入块构造。
// 约束：只有这里的代码有权决定「发给模型的消息长什么样」，两条链路必须走同一套。

const crypto = require('crypto');
const { formatDateTimeInTimeZone } = require('../time_utils');
// 工具结果标头与 mcp-tool-loop 轮内/落盘同一实现（单一代码源，改口径只动一处）
const { buildToolResultContent } = require('../mcp-tool-loop');

// ---- 工具调用记录 → role=tool 消息组（发送模型前的内存转换，不落盘）----
// 历史里的工具结果此前以 assistant 文本「【工具调用记录】…」回灌，模型分不清是工具返回还是自己说过的话。
// 发送前把这条还原成主流格式：assistant(tool_calls) + 若干 role=tool 消息，内容带来源标头
// （工具名+调用时间+状态+结果），与 mcp-tool-loop.js / server.js 落盘格式同口径（改动需三处同步）。
const TOOL_NOTE_HEAD_RE = /^【工具 · (.+?)(?: · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?(?: · (成功|失败|无返回内容))?】\s?/;

// 解析「【工具调用记录】」文本为条目数组 [{name,time,status,body}]；兼容旧格式（无时间/状态段）
function parseToolNoteEntries(text) {
  const lines = String(text || "").split("\n");
  const entries = [];
  let cur = null;
  for (let i = 1; i < lines.length; i++) {   // 首行是「【工具调用记录】」总头，跳过
    const mm = lines[i].match(TOOL_NOTE_HEAD_RE);
    if (mm) {
      cur = { name: mm[1].trim(), time: mm[2] || "", status: mm[3] || "", body: lines[i].slice(mm[0].length) };
      entries.push(cur);
    } else if (cur) {
      cur.body += "\n" + lines[i];
    }
  }
  for (const e of entries) {
    e.body = String(e.body || "").trim();
    if (!e.status) {   // 旧格式兜底：从正文推状态
      if (/^\[出错\]/.test(e.body)) e.status = "失败";
      else if (e.body === "（工具无返回内容）") e.status = "无返回内容";
      else e.status = e.body ? "成功" : "无返回内容";
    }
  }
  return entries;
}

// 条目 → role=tool 消息内容（标头格式与 mcp-tool-loop.js buildToolResultContent 一致）
function toolEntryToContent(e) {
  const lines = [
    "[工具调用结果]",
    "工具：" + (e.name || "unknown"),
    "调用时间：" + (e.time || "未知（历史记录未含时间）"),
    "状态：" + (e.status === "无返回内容" ? "成功但无返回内容" : e.status)
  ];
  if (e.status === "失败") lines.push("错误信息：" + (e.body.replace(/^\[出错\]\s*/, "") || "未知错误"));
  else if (e.body) { lines.push("----"); lines.push(e.body); }
  return lines.join("\n");
}

// 逐条扫描：assistant 的「【工具调用记录】」消息 → 合成 assistant(tool_calls) + role=tool 组。
// 解析不出条目则原样保留（兜底不丢内容）。仅在发送前转换，时间线/前端/压缩均不受影响。
// role 法（2026-09-15）：工具记录一条都不过滤——对话侧、唤醒侧同一规则。
function convertToolNotesToToolRole(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  const out = [];
  let converted = 0;
  for (const m of msgs) {
    const isNote = m && m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("【工具调用记录】");
    if (!isNote) { out.push(m); continue; }
    const entries = parseToolNoteEntries(m.content);
    if (!entries.length) { out.push(m); continue; }
    const toolCalls = [];
    const toolMsgs = [];
    // 2026-09-22 审查 H11：tool_call_id 必须稳定，否则同一段历史每轮请求都不同，
    // 前缀缓存彻底失效、成本翻倍。改为基于原始消息内容 + 条目索引 + 工具名/时间的稳定哈希。
    const baseHash = crypto.createHash('sha256').update(String(m.content || '')).digest('hex').slice(0, 16);
    const baseId = "call_hist_" + baseHash;
    entries.forEach((e, k) => {
      const entryHash = crypto.createHash('sha256')
        .update(String(k) + "\0" + String(e.name || '') + "\0" + String(e.time || '') + "\0" + String(e.body || '').slice(0, 400))
        .digest('hex').slice(0, 12);
      const id = baseId + "_" + k + "_" + entryHash;
      toolCalls.push({ id, type: "function", function: { name: e.name || "unknown", arguments: "{}" } });
      toolMsgs.push({ role: "tool", tool_call_id: id, content: toolEntryToContent(e) });
    });
    out.push({ role: "assistant", content: "", tool_calls: toolCalls });
    for (const tm of toolMsgs) out.push(tm);
    converted++;
  }
  if (converted) console.log("[tool-note] 已将 " + converted + " 条工具调用记录转换为 role=tool 消息组");
  return out;
}

// ---- 新格式富字段（assistant.tools，2026-09-23 起落盘）→ role=tool 消息组（发送前内存转换，不落盘）----
// 落盘侧（server.js MCP 写回段）把整轮 toolHistory 存进 assistant.tools，轮内的
// assistant(tool_calls)+role:tool 结构不落时间线；此前没有任何代码把它还原回去，导致 9-23
// 之后的新格式回合跨轮丢失全部工具回执（旧格式文本有转换、新格式没有，两套口径漂移）——
// 模型看不到自己调过什么/收到过什么，只能按内容记忆补全，2026-09-26「第三次煮水」幻觉事故根因。
// 还原口径与主流框架的 ToolMessage 回灌一致（OpenAI tool 协议 / LangChain AIMessage.tool_calls+
// ToolMessage / Vercel AI SDK toolCallId），也与 mcp-tool-loop 轮内结构同形：
//   assistant(content:"", tool_calls, reasoning_content) → role:tool ×N → assistant(content:正文)
// thinking 模式约束（mcp-tool-loop 2026-09-23 实证）：带 tool_calls 的 assistant 缺 reasoning_content
// 会被上游 400 拒绝，故整轮 reasoning 挂在 tool_calls 消息上；尾随正文消息不重复携带。
// tool_call_id =「消息id+条目序号+工具名+时间+参数」稳定哈希（同 H11 口径）：同一段历史每轮重建
// 逐字节一致，前缀缓存不失效；id 派生不含 content，前端编辑正文不会牵连 id 变化。
function convertToolsFieldToToolRole(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  const out = [];
  let converted = 0;
  for (const m of msgs) {
    const isRich = m && m.role === "assistant" && Array.isArray(m.tools) && m.tools.length > 0 && !m.tool_calls;
    if (!isRich) { out.push(m); continue; }
    const toolCalls = [];
    const toolMsgs = [];
    const idBase = String(m.id || ("noid:" + String(m.content || "").slice(0, 120)));
    m.tools.forEach(function (t, k) {
      const name = String((t && t.name) || "unknown");
      const time = String((t && t.time) || "");
      const argsJson = JSON.stringify((t && t.args) || {});
      const id = "call_hist_" + crypto.createHash("sha256")
        .update(idBase + "\0" + k + "\0" + name + "\0" + time + "\0" + argsJson)
        .digest("hex").slice(0, 28);
      toolCalls.push({ id: id, type: "function", function: { name: name, arguments: argsJson } });
      toolMsgs.push({ role: "tool", tool_call_id: id, content: buildToolResultContent({ name: name, time: time, error: (t && t.error) || null, markdown: (t && t.result) || "" }) });
    });
    const rc = (typeof m.reasoning_content === "string" && m.reasoning_content)
      || (typeof m.reasoning === "string" && m.reasoning) || "";
    out.push(Object.assign({ role: "assistant", content: "", tool_calls: toolCalls }, rc ? { reasoning_content: rc } : {}));
    for (const tm of toolMsgs) out.push(tm);
    out.push({ role: "assistant", content: String(m.content || "") });
    converted++;
  }
  if (converted) console.log("[tool-field] 已将 " + converted + " 条 assistant.tools 还原为 role=tool 消息组");
  return out;
}

// ---- 自动修复不完整的 tool 调用（双向清理，原 chat.js 主链路内联段原样提取）----
// assistant tool_calls 后缺 tool 回执 → 整组移除；孤立 tool 消息（前无对应 tool_calls）→ 移除。
function repairToolCallPairs(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  const removeSet = new Set();

  // 检查 assistant tool_calls 是否完整
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    const expectedIds = msg.tool_calls.map(tc => tc.id);
    const followingTools = [];
    for (let j = i + 1; j < msgs.length; j++) {
      const nxt = msgs[j];
      if (nxt.role === "tool") {
        followingTools.push(nxt);
      } else {
        break;
      }
    }
    const foundIds = followingTools.map(t => t.tool_call_id);
    const complete = expectedIds.every(id => foundIds.includes(id));
    if (!complete) {
      removeSet.add(i);
      for (let j = i + 1; j < msgs.length; j++) {
        if (msgs[j].role === "tool") {
          removeSet.add(j);
        } else {
          break;
        }
      }
      console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
    }
  }

  // 检查孤立 tool 消息（前面没有对应的 tool_calls）
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") continue;
    let hasMatchingToolCalls = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = msgs[j];
      if (prev.role === "assistant" && prev.tool_calls) {
        const ids = prev.tool_calls.map(tc => tc.id);
        if (ids.includes(msgs[i].tool_call_id)) {
          hasMatchingToolCalls = true;
        }
        break;
      } else if (prev.role === "tool") {
        continue;
      } else {
        break;
      }
    }
    if (!hasMatchingToolCalls) {
      removeSet.add(i);
      console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
    }
  }

  const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
  for (const idx of sortedRemove) {
    msgs.splice(idx, 1);
  }
  return msgs;
}

// ---- 转发前只保留 OpenAI 兼容字段（原 chat.js 内联净化段原样提取）----
function sanitizeForUpstream(msgs) {
  return (Array.isArray(msgs) ? msgs : []).map(msg => {
    const clean = { role: msg.role };
    if (msg.content !== undefined) clean.content = msg.content;
    if (msg.name !== undefined) clean.name = msg.name;
    if (msg.tool_calls !== undefined) clean.tool_calls = msg.tool_calls;
    if (msg.tool_call_id !== undefined) clean.tool_call_id = msg.tool_call_id;
    // 多轮对话回传思考链（2026-09-24 修复）：
    // - timeline 落盘时字段叫 reasoning（chat.js toAppend.push 写的是 reasoning: aiThinking）
    // - 工具循环/前端透传时字段叫 reasoning_content
    // DeepSeek thinking 模式要求历史 assistant 必须带 reasoning_content，否则 400。
    // 两个名字都认，统一映射成 reasoning_content 发出去；空串不带（跟随 mcp-tool-loop 口径）。
    if (msg.role === "assistant") {
      const rc = msg.reasoning_content !== undefined ? msg.reasoning_content : msg.reasoning;
      if (rc !== undefined && rc !== null && String(rc).length > 0) clean.reasoning_content = rc;
    }
    return clean;
  });
}

// ---- 会话上下文容量提醒守卫（原 chat.js 整段原样搬入，仅提醒消息 role 改 developer）----
// 发送前检测，超限时往当轮消息流塞一条隐藏提醒并落盘，让 AI 自己调 context_replace 压缩；
// 提醒随早期对话被压缩块覆盖后自然消失，再超限再塞。
function createCtxLimitReminderGuard(deps) {
  const {
    contextCompactor,
    contextReplacements,
    loadTimeline,
    saveTimeline,
    appendSpecialEvent,
    isSpecialEvent,
    normalizeContentToText
  } = deps;
  const CTX_LIMIT_HEAD = "（容量提醒）";

  // 摘要占位消息：被压缩块替换成的一段「## Historical Summary …」消息（0919 头改英文；旧「（回忆 · /（对话摘要」前缀保留兼容历史）
  // 与 context-replacements.js isReplacementMemoryMessage 同口径（2026-09-28 压缩块改 developer 段，同步放行）
  function isSummaryPlaceholder(m) {
    if (!m || (m.role !== 'assistant' && m.role !== 'developer')) return false;
    const c = String(m.content || '');
    return c.startsWith('## Historical Summary') || c.startsWith('（回忆 · ') || c.startsWith('（对话摘要');
  }

  // 容量提醒统计口径（2026-09-22 审查 H10）：按「发送给上游的完整消息流」做 token 估算。
  // 此前漏算 system/developer 头部块与 tool/tool_calls 往返，导致工具密集/头部块大的会话实际超量也不触发提醒。
  // 跳过项只保留：被压缩替换的替身、摘要占位、特殊事件。
  function countUncompressedTokens(messages) {
    let tokTotal = 0;
    for (const m of messages) {
      if (!m) continue;
      if (m._ctxRep || m._ccSummary) continue;
      if (isSummaryPlaceholder(m)) continue;
      if (isSpecialEvent(m)) continue;
      if (typeof m.content === 'string') tokTotal += contextCompactor.estimateTokens(m.content);
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (!part) continue;
          if (part.type === 'text' && typeof part.text === 'string') tokTotal += contextCompactor.estimateTokens(part.text);
          else if (part.type === 'image' || part.type === 'image_url') tokTotal += contextCompactor.EST_IMAGE_TOKENS;
          else if (part.type === 'file' && part.file && typeof part.file.name === 'string') tokTotal += contextCompactor.estimateTokens('[文件] ' + part.file.name);
          else tokTotal += 1; // 未知分片（附件/文件等）至少占位计 1，避免漏算致容量判定偏乐观（审查 2026-09-05 B2）
        }
      }
      // tool_calls 本身也占 token（名称 + 参数 JSON）
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || !tc.function) continue;
          if (tc.function.name) tokTotal += contextCompactor.estimateTokens(tc.function.name);
          if (typeof tc.function.arguments === 'string') tokTotal += contextCompactor.estimateTokens(tc.function.arguments);
          else if (tc.function.arguments) tokTotal += contextCompactor.estimateTokens(JSON.stringify(tc.function.arguments));
        }
      }
    }
    return tokTotal;
  }

  // 疑似有落盘 ctx_limit 提醒的会话（进程内存）：低于上限时据此跳过全量读盘清理。
  const _ctxLimitReminderSessions = new Set();
  // 2026-09-23 审查 M7：本进程已对该会话做过一次「历史提醒清理扫描」的标记（见 maybeInject 的开关关闭分支）。
  const _ctxLimitCleanSwept = new Set();

  function clearDiskCtxLimitReminder(sessionId) {
    let onDisk = false;
    try {
      const timeline = loadTimeline(sessionId);
      // 2026-09-22 审查 R12：原实现就地改 loadTimeline() 返回的元素（m.deleted = true）——
      // readJson 命中缓存时那是进程级缓存里的**原对象**，一旦 saveTimeline 被守卫拒写
      // （过期快照/损坏/墓碑），缓存就会停在「已删」而磁盘上仍是未删，后续请求读到假状态。
      // 改为构造新数组（仅命中条目换新对象），__fp 指纹原样带上以保住「过期快照拒写」保护。
      let hit = false;
      for (const m of timeline) { if (m && m.kind === 'ctx_limit' && !m.deleted) { hit = true; break; } }
      if (!hit) { _ctxLimitReminderSessions.delete(sessionId || 'default'); return false; }
      const next = timeline.map(function (m) {
        return (m && m.kind === 'ctx_limit' && !m.deleted) ? Object.assign({}, m, { deleted: true }) : m;
      });
      try { if (timeline.__fp !== undefined) next.__fp = timeline.__fp; } catch (e) {}
      onDisk = true;
      // 2026-09-23 修正（M7 配套）：原先此处不检查 saveTimeline 返回值、也没有把会话移出
      // 「疑似有提醒」集合，导致「清理成功」与「下一轮可早退」两件事脱节——会话留在集合里，
      // 早退条件 !has(_sid) 永不成立，优化对该会话失效到下一次 !hit 为止。
      // 这里改为按落盘结果决策：只有真正写盘成功才停止跟踪；
      // saveTimeline 被守卫拒写（损坏 / 过期快照 / 墓碑）时盘上提醒仍在，必须保留跟踪继续重试，
      // 否则下轮早退会跳过扫描，落盘提醒永远留在时间线里。
      const _saved = saveTimeline(next, sessionId);
      if (_saved) _ctxLimitReminderSessions.delete(sessionId || 'default');
    } catch (cleanErr) {
      console.warn('[ctx-limit] 清理落盘容量提醒失败（不影响转发）:', cleanErr.message);
    }
    return onDisk;
  }

  function maybeInject(llmMessages, sessionId, timeByKey) { try {
    const cfg = contextCompactor.loadConfig();
    const limit = Number(cfg.compaction_context_limit_chars) || 0;
    if (!cfg.compaction_context_remind_enabled) {
      // 2026-09-23 审查 M7：原实现每次请求都无条件跑 clearDiskCtxLimitReminder——而它内部
      // loadTimeline 即便命中缓存也要 cloneTimeline 深拷贝（线上实测主会话 4034 条 / 2.6MB，
      // 单次 7.75ms 同步阻塞）。开关关闭是当前常态，等于每个聊天请求白付一次深拷贝。
      // 改早退（与下方 282 行同款语义）：本进程已扫过且未见过该会话有提醒落盘 → 直接跳过。
      //   · 进程重启后首次请求会扫一次（清理重启前遗留的落盘提醒）；
      //   · 之后常态跳过；开关「开→关」时集合里仍有该会话 → 再扫一次完成清理，
      //     clearDiskCtxLimitReminder 仅在**落盘成功**时把该会话移出集合（被守卫拒写则保留跟踪继续重试）。
      const _sid = sessionId || 'default';
      if (_ctxLimitCleanSwept.has(_sid) && !_ctxLimitReminderSessions.has(_sid)) return;
      const cleaned = clearDiskCtxLimitReminder(sessionId);
      _ctxLimitCleanSwept.add(_sid);
      if (cleaned) console.log(`[ctx-limit] 容量提醒开关已关闭，已清理会话 ${_sid} 落盘的历史容量提醒`);
      return;
    }
    if (limit <= 0) return;
    const tokens = countUncompressedTokens(llmMessages);
    if (tokens <= limit) {
      let inStream = false;
      for (let i = llmMessages.length - 1; i >= 0; i--) {
        const m = llmMessages[i];
        if (m && (m.kind === 'ctx_limit' || (typeof m.content === 'string' && m.content.startsWith(CTX_LIMIT_HEAD)))) {
          llmMessages.splice(i, 1);
          inStream = true;
        }
      }
      let onDisk = false;
      if (!_ctxLimitReminderSessions.has(sessionId || 'default') && !inStream) return;
      onDisk = clearDiskCtxLimitReminder(sessionId);
      if (inStream || onDisk) {
        console.log(`[ctx-limit] 会话 ${sessionId || 'default'} 上下文 ${tokens} token（估算）已低于上限 ${limit}，容量提醒已移除（再超限会重新提醒）`);
      }
      return;
    }
    if (llmMessages.some(m => m && (m.kind === 'ctx_limit' || (typeof m.content === 'string' && m.content.startsWith(CTX_LIMIT_HEAD))))) return;

    const CHUNK_TARGET = 100;
    let starredKeys = null;
    try { starredKeys = contextReplacements.loadMarks(); } catch (e) { starredKeys = null; }
    const isStarredMsg = m => {
      if (!starredKeys || !m) return false;
      try { return Boolean(starredKeys[contextReplacements.contentKey(m)]); } catch (e) { return false; }
    };
    const picked = [];
    for (const m of llmMessages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      if (m._ctxRep || m.tool_calls || m.tool_call_id) continue;
      if (isSpecialEvent(m)) continue;
      if (isStarredMsg(m)) continue;
      picked.push(m);
      if (picked.length >= CHUNK_TARGET) break;
    }
    const timeOf = m => {
      if (!m) return null;
      if (m.time) { const d = new Date(m.time); if (!isNaN(d.getTime())) return d; }
      return timeByKey ? timeByKey.get(m.role + '\u0000' + normalizeContentToText(m.content)) : null;
    };
    let firstIdx = -1, firstT = null, lastT = null;
    for (let i = 0; i < picked.length; i++) {
      const t = timeOf(picked[i]);
      if (t) { firstIdx = i; firstT = t; break; }
    }
    if (firstT) {
      const lastIdx = Math.min(firstIdx + CHUNK_TARGET - 1, picked.length - 1);
      for (let i = lastIdx; i >= firstIdx; i--) {
        const t = timeOf(picked[i]);
        if (t) { lastT = t; break; }
      }
    }
    let chunkInfo = '最早一段未整理的对话，每块约一百条';
    if (firstT && lastT) {
      chunkInfo = '从 ' + formatDateTimeInTimeZone(firstT) + ' 到 ' + formatDateTimeInTimeZone(lastT) + '（最早一段未整理的对话，约 ' + picked.length + ' 条）';
    }
    // 系统 直接附上待整理区间的首尾消息 id（2026-09-19 统一 id 锚点后 AI 无需再检索取 id）
    const startId = picked.length ? (picked[0] && picked[0].id ? String(picked[0].id) : '') : '';
    const endId = picked.length ? (picked[picked.length - 1] && picked[picked.length - 1].id ? String(picked[picked.length - 1].id) : '') : '';
    const idRange = startId && endId
      ? 'start_id=' + startId + ' end_id=' + endId
      : '（本次未能自动取得消息 id，请先用 context_search 检索该段原文，取首尾两条的 msg_id）';

    let prompt;
    try {
      prompt = String(contextCompactor.loadCtxLimitPrompt() || '');
    } catch (pcErr) {
      prompt = '';
    }
    const remark = prompt
      .replace(/\$\{chars\}/g, String(tokens))
      .replace(/\$\{limit\}/g, String(limit))
      .replace(/\$\{chunkInfo\}/g, chunkInfo)
      .replace(/\$\{id_range\}/g, idRange)
      .replace(/\$\{conversationText\}/g, '（就是上面第 1 点要整理的那段对话）');
    if (!remark.trim().startsWith(CTX_LIMIT_HEAD)) return;

    // 插入位置：塞到「最后一条 user 之前」，避免对话序列以 assistant 收尾被部分模型当成自己的上一条输出续写。
    // role 法（2026-09-15）：注入指令一律 developer，不再伪装 assistant。
    let insIdx = -1;
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      const mm = llmMessages[i];
      if (mm && mm.role === 'user' && !isSpecialEvent(mm) && !mm.tool_call_id) { insIdx = i; break; }
    }
    const reminderMsg = { role: 'developer', content: remark };
    if (insIdx >= 0) llmMessages.splice(insIdx, 0, reminderMsg);
    else llmMessages.push(reminderMsg);
    appendSpecialEvent(remark, { hidden: true, kind: 'ctx_limit' }, sessionId);
    _ctxLimitReminderSessions.add(sessionId || 'default');
    console.log(`[ctx-limit] 会话 ${sessionId || 'default'} 上下文 ${tokens} token（估算）超过上限 ${limit}，已塞容量提醒（${remark.length} 字符）`);
  } catch (err) {
    console.warn('[ctx-limit] 容量提醒检测失败（不影响转发）:', err.message);
  } }

  return maybeInject;
}

// ---- 统一对话构建器（2026-09-15 批3核心）----
// 聊天与唤醒的唯一上下文来源：从时间线重建同一条对话（role 法全量：日记/历史[唤醒]块/工具记录齐全）。
// 前缀身份：同一会话同一时刻，聊天请求与唤醒请求的本构建器输出逐字一致 → 上游前缀缓存共享。
// 图片规则（两侧对称）：历史图片降级为「（图片）」占位（附件正文由 prepareMessageForLLM 读入文本，
// 与聊天侧同口径）；仅时间线末尾的连续 user 消息（本轮待回复）图片保真。
// 2026-09-29 增量上下文构建（keh3 5000+ 条提速，用户拍板方案）：
// 把发给模型的消息流拆成「稳定头 + 实时尾」——系统注入前缀与压缩块摘要/保留消息是稳定部分，
// 每请求只现处理尾部未压缩对话。增量函数 buildIncrementalContext（context-replacements.js）
// 按块 range id 定位区间：正常块 → 摘要化（buildMemoryMessage）+ 保留不可压缩（真日记/标星前置），
// 隐藏/截断块 → 区间原文剔除，窗口外/定位失败块 → 原文透传（后续 applyReplacements 兜底，结果与全量一致）。
// 整体缓存：会话+时间线fp+块记录fp+系统提示 未变（唤醒/重试）→ 直接返回（连尾部都不重算）；
// 聊天发消息 → fp 变 → 走增量（head 轻量构建 + 尾部少量 prepare），处理量随块覆盖率大幅下降。
// 命中返回引用——下游 apply/prepareModelMessages 在副本数组操作、sanitizeForUpstream 产全新对象（已核查）。
function createConversationBuilder(deps) {
  const { loadTimeline, prepareMessageForLLM, stripPosition, resolveSessionSystemPrompt } = deps;
  const incrementalContext = deps.incrementalContext || null;
  // 2026-09-29 缓存分层（用户拍板）：整体缓存只服务「时间线未变」的场景（唤醒/重试）——
  // 聊天每次发消息 fp 必变、整体缓存必 miss，跳过 get/set 省一次 Map 查找，
  // 且避免聊天把唤醒的缓存项挤出（_convCache 上限 10）。聊天一律走增量路径（块摘要+尾部现算）。
  const useFullCache = deps.fullCache !== false;
  const _convCache = new Map(); // key: sessionId|fp|blockFp|sysKey -> msgs
  const _CONV_CACHE_MAX = 10;
  const _CONV_CACHE_MIN_MSGS = 300;
  function _convCacheKey(sessionId, fp, blockFp, systemRaw) {
    // 系统提示取全文 sha1 指纹（0929-07：原"长度+前120字"在"人设改版但长度与前缀相同"时会漏判缓存）
    const sc = systemRaw ? String(systemRaw.content || "") : "";
    let sysFp = "";
    try { sysFp = crypto.createHash("sha1").update(sc).digest("hex").slice(0, 16); }
    catch (e) { sysFp = String(sc.length); }
    return String(sessionId || "default") + "|" + fp + "|" + (blockFp || "") + "|" + sysFp;
  }
  function _convCacheSet(key, msgs) {
    if (_convCache.size >= _CONV_CACHE_MAX) {
      const firstKey = _convCache.keys().next().value;
      if (firstKey !== undefined) _convCache.delete(firstKey);
    }
    _convCache.set(key, msgs);
  }
  return function buildConversation(sessionId) {
    const timeline = loadTimeline(sessionId);
    const fp = (timeline && timeline.__fp) || "";
    const msgs = [];
    // system 人设（2026-09-24 B 方案）：服务端权威解析优先（会话级备份 -> 全局），
    // 盘上时间线里的 system 仅作兜底。前端请求带什么 system 都不再决定这里发什么。
    let systemRaw = null;
    const authoritativeSP = (typeof resolveSessionSystemPrompt === "function")
      ? (resolveSessionSystemPrompt(sessionId) || "") : "";
    if (authoritativeSP.trim()) {
      systemRaw = { role: "system", content: authoritativeSP };
    } else {
      for (const m of timeline) {
        if (m && m.role === "system" && !m.deleted) systemRaw = m;
      }
    }
    // 缓存命中判断（fp 非空 + 大会话才缓存；小会话重建便宜不缓存）
    const cacheable = !!(fp && timeline && timeline.length >= _CONV_CACHE_MIN_MSGS);
    const cacheKey = cacheable ? _convCacheKey(sessionId, fp, null, systemRaw) : null;
    // 增量路径（块记录指纹 + 系统提示）：先按「时间线fp+块fp+系统」试整体缓存
    let incResult = null;
    if (cacheable && incrementalContext) {
      incResult = incrementalContext(sessionId, timeline);
      // 2026-10-01 修复 P0：原判定只看 tailStart>0，遇「无块会话」（head=[] 且
      // tailStart=tl.length）会认定增量合法，结果 head/tail 双空 —— 整段历史被吞，
      // 上下文只剩 system。可用条件收紧为：head 非空 **或** 尾部起点在末尾之前，
      // 两者皆空即降级全量路径（下方 history 分支）。
      const incHead = (incResult && Array.isArray(incResult.head)) ? incResult.head : null;
      const incTailStart = (incResult && Number.isFinite(incResult.tailStart)) ? incResult.tailStart : -1;
      const incUsable = !!incHead && incTailStart > 0 &&
        (incHead.length > 0 || incTailStart < timeline.length);
      if (incUsable) {
        let incKey = null;
        if (useFullCache) {
          incKey = _convCacheKey(sessionId, fp, incResult.blockFp, systemRaw);
          const incHit = _convCache.get(incKey);
          if (incHit) return incHit;
        }
        // 增量构建：head（块摘要/保留/前缀/间隙，_ctxRep 直接透传） + 尾部现算
        const sysPrep = systemRaw ? prepareMessageForLLM(systemRaw) : null;
        if (sysPrep) msgs.push(sysPrep);
        const turnStart = _tailTurnStart(timeline);
        for (const m of incResult.head) {
          if (!m) continue;
          if (m._ctxRep) { msgs.push(m); continue; }
          const p = prepareMessageForLLM(m);
          if (!p) continue;
          msgs.push(downgradeHistoryImages(p));
        }
        for (let k = incResult.tailStart; k < timeline.length; k++) {
          const m = timeline[k];
          if (!m || m.role === "system" || m.deleted) continue;
          const p = prepareMessageForLLM(m);
          if (!p) continue;
          msgs.push(k < turnStart ? downgradeHistoryImages(p) : p);
        }
        if (useFullCache && incKey) _convCacheSet(incKey, msgs);
        return msgs;
      }
    }
    if (useFullCache && cacheKey) {
      const hit = _convCache.get(cacheKey);
      if (hit) return hit;
    }
    if (systemRaw) {
      const sysPrep = prepareMessageForLLM(systemRaw);
      if (sysPrep) msgs.push(sysPrep);
    }
    // 历史：非 system、未删除，剥内部字段
    const history = stripPosition(timeline.filter(m => m && m.role !== "system" && !m.deleted));
    // 本轮待回复：时间线末尾的连续 user 消息（图片保真）
    let turnStart = history.length;
    while (turnStart > 0 && history[turnStart - 1] && history[turnStart - 1].role === "user") turnStart--;
    for (let k = 0; k < history.length; k++) {
      const prepared = prepareMessageForLLM(history[k]);
      if (!prepared) continue;
      msgs.push(k < turnStart ? downgradeHistoryImages(prepared) : prepared);
    }
    if (useFullCache && cacheKey) _convCacheSet(cacheKey, msgs);
    return msgs;
  };

  // 增量路径用：时间线末尾连续 user 起点（图片保真），口径与全量路径一致
  function _tailTurnStart(timeline) {
    let n = 0;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const m = timeline[i];
      if (!m || m.role === "system" || m.deleted) continue;
      if (m.role === "user") n++;
      else break;
    }
    return timeline.length - n;
  }
}

// 历史图片降级为占位文本（对称规则的历史侧；附件正文已在 prepareMessageForLLM 转为文本）
function downgradeHistoryImages(m) {
  if (!m || !Array.isArray(m.content)) return m;
  let changed = false;
  const parts = m.content.map(p => {
    if (p && (p.type === "image" || p.type === "image_url")) { changed = true; return { type: "text", text: "（图片）" }; }
    return p;
  });
  return changed ? { ...m, content: parts } : m;
}

// ---- 统一模型消息加工管道（2026-09-21 审查 H9）----
// 此前 chat.js 与 wake-chat.js 各自散装调用 repair/replace/guard/convert，顺序不同
// （聊天侧 repair→replace→guard→convert；唤醒侧 replace→guard→convert→repair），
// 同一份历史两条入口产出不同结构，与文件头「两条链路必须同一套」的约束冲突。
// 现在顺序在这里写死，两条链路只准调本函数：
//   repair（先修残缺对）→ applyReplacements（上下文替换）→ ctxLimitGuard（容量提醒）
//   → convertToolNotesToToolRole（旧格式工具记录回灌）→ convertToolsFieldToToolRole（新格式 tools 字段回灌）
//   → sanitizeForUpstream（出口净化）
// opts: { applyReplacements?, ctxLimitGuard?, sessionId?, timeByKey?, logPrefix? }
function prepareModelMessages(messages, opts) {
  const o = opts || {};
  const logPrefix = o.logPrefix || "[context-replacements]";
  let msgs = repairToolCallPairs(messages);
  if (typeof o.applyReplacements === "function") {
    try {
      const before = msgs.length;
      msgs = o.applyReplacements(msgs);
      if (msgs.length !== before) console.log(logPrefix + " 发送前替换生效: 消息 " + before + " -> " + msgs.length);
    } catch (repErr) {
      console.warn(logPrefix + " 替换失败（按原样转发）:", repErr.message);
    }
  }
  if (typeof o.ctxLimitGuard === "function") {
    try { o.ctxLimitGuard(msgs, o.sessionId, o.timeByKey); }
    catch (e) { console.warn(logPrefix + " 容量提醒检测失败（不影响转发）:", e.message); }
  }
  msgs = convertToolNotesToToolRole(msgs);
  msgs = convertToolsFieldToToolRole(msgs);
  return sanitizeForUpstream(msgs);
}

module.exports = {
  parseToolNoteEntries,
  toolEntryToContent,
  convertToolNotesToToolRole,
  convertToolsFieldToToolRole,
  repairToolCallPairs,
  sanitizeForUpstream,
  prepareModelMessages,
  createCtxLimitReminderGuard,
  createConversationBuilder
};
