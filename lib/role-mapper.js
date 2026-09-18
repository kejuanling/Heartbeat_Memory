'use strict';
// role 出口映射层（2026-09-15 role 法定稿）。
// 内部统一消息表示：system / developer / user / assistant / tool。
// 时间线存储与内存构建永远用内部表示，只在「发给上游前」按供应商 profile 翻译一次。
// profile 取自 AI 供应商配置的 profile 字段（无则 default）。

// 出口翻译分发：按供应商 profile 选映射器（claude/gemini 专用，其余一律 default）；
// 非数组输入或缺 role 的消息项先过滤再传给对应映射器
function mapMessagesForProvider(profile, messages) {
  const p = String(profile || "default").trim().toLowerCase();
  const msgs = (Array.isArray(messages) ? messages : []).filter(m => m && m.role);
  if (p === "claude") return mapForClaude(msgs);
  if (p === "gemini") return mapForGemini(msgs);
  return mapForDefault(msgs);
}

// 默认（OpenAI 兼容上游）：developer → system，位置与内容原样保留。
// 注：DeepSeek 等主流兼容上游不认 developer 角色，故 default profile 必须做此映射。
function mapForDefault(msgs) {
  return msgs.map(m => (m.role === "developer" ? { ...m, role: "system" } : m));
}

// Claude 系：system/developer 都进顶层 system 参数（本函数合并为首条 system 消息，
// 由 Claude 侧适配器再抬到顶层参数）；messages 只留 user/assistant；
// 工具结果裹进 user 消息（tool_result 语义），assistant 的 tool_calls 原样透传由适配器转 tool_use 块。
function mapForClaude(msgs) {
  const sysParts = [];
  const rest = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "developer") { sysParts.push(String(m.content ?? "")); continue; }
    rest.push(m);
  }
  const out = [];
  if (sysParts.length) out.push({ role: "system", content: sysParts.join("\n\n").trim() });
  for (const m of rest) {
    if (m.role === "tool") {
      // 工具结果并入前一条 user（Claude 要求 tool_result 在 user 消息里）；
      // OpenAI 兼容层转原生 API 时由适配器包成 {type:"tool_result", tool_use_id} 块
      const prev = out[out.length - 1];
      const wrap = { role: "user", content: `[tool_result for ${m.tool_call_id || "unknown"}]\n${String(m.content ?? "")}` };
      if (prev && prev.role === "user" && prev._toolResultWrap) {
        prev.content += "\n\n" + wrap.content;
        continue;
      }
      wrap._toolResultWrap = true;
      out.push(wrap);
      continue;
    }
    out.push(m.role === "model" ? { ...m, role: "assistant" } : m);
  }
  // 剥掉内部合并标记（2026-09-15 修复：_toolResultWrap 会随 JSON 发给上游，严格上游可能拒收未知字段）
  return out.map(m => (m && m._toolResultWrap !== undefined)
    ? (() => { const { _toolResultWrap, ...rest } = m; return rest; })()
    : m);
}

// Gemini 系（OpenAI 兼容层约定）：assistant → model；developer → system。
// 原生 body（systemInstruction/contents）转换由该供应商适配器负责，这里只做角色名归一。
function mapForGemini(msgs) {
  return msgs.map(m => {
    if (m.role === "assistant") return { ...m, role: "model" };
    if (m.role === "developer") return { ...m, role: "system" };
    return m;
  });
}

module.exports = { mapMessagesForProvider };
