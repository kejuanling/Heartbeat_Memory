'use strict';
// 从 server.js 拆出的 /v1/* 路由(models/sessions/history/events/timeline-sync + chat/completions)。
// 依赖注入：server.js 里用到的函数经 deps 传入；baseDir = 项目根目录。
// 鉴权沿用 server.js 的全局 addHook，不需要在此重复。
const path = require('path');
const fsp = require('fs-extra');
const mcp = require('../mcp-tool-loop');
const memoryPool = require('../memory-pool');
const memoryEngine = require('../memory-engine');
const tagParser = require('../tag-parser');
const contextReplacements = require('../context-replacements');
const contextCompactor = require('../context-compactor');
const { formatDateTimeInTimeZone } = require('../time_utils');
const { parsePushEcho, parseWakeEcho } = require('../utils/push');

// 推送回显（成功推送的「刚刚给 X 发了 X 推送：」记录）需要在聊天页显示给用户看，
// 其余特殊事件（容量提醒/唤醒/日记/记忆浮现等）保持对前端隐藏。
function isPushEchoLike(m) {
  if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return false;
  if (m.event_type === 'push') return true;
  return !!parsePushEcho(m.content);
}

// ---- 跨会话语义检索（TF-IDF + 字符 bigram，与前端旧逻辑同口径）----
function charBigrams(text) {
  if (!text) return [];
  const t = String(text).toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ');
  const chars = [];
  for (let i = 0; i < t.length; i++) if (t[i] !== ' ') chars.push(t[i]);
  if (chars.length < 2) return chars;
  const r = [];
  for (let i = 0; i < chars.length - 1; i++) r.push(chars[i] + chars[i + 1]);
  return r;
}
function buildSemIndex(items) {
  const vocab = {};
  const docFreq = [];
  const docs = [];
  for (let i = 0; i < items.length; i++) {
    const tokens = charBigrams(items[i].text);
    docs.push(tokens);
    const seen = {};
    for (let j = 0; j < tokens.length; j++) {
      const tok = tokens[j];
      if (seen[tok]) continue;
      seen[tok] = true;
      if (vocab[tok] === undefined) { vocab[tok] = docFreq.length; docFreq.push(1); }
      else docFreq[vocab[tok]]++;
    }
  }
  const n = docs.length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const tokens = docs[i];
    if (!tokens.length) { rows[i] = { idx: [], val: [] }; continue; }
    const tf = {};
    for (let j = 0; j < tokens.length; j++) { const t = tokens[j]; tf[t] = (tf[t] || 0) + 1; }
    const total = tokens.length;
    const idx = [], val = []; let nsq = 0;
    for (const t in tf) {
      const k = vocab[t]; if (k === undefined) continue;
      const tfv = tf[t] / total;
      const idfv = Math.log((n + 1) / (docFreq[k] + 1)) + 1;
      const v = tfv * idfv;
      idx.push(k); val.push(v); nsq += v * v;
    }
    const nm = Math.sqrt(nsq);
    if (nm > 0) for (let k = 0; k < val.length; k++) val[k] /= nm;
    rows[i] = { idx, val };
  }
  return { vocab, rows, items };
}
function semanticSearch(index, query, threshold) {
  if (!threshold) threshold = 0.05;
  const qTokens = charBigrams(query);
  if (!qTokens.length) return [];
  const qTf = {};
  for (let i = 0; i < qTokens.length; i++) { const t = qTokens[i]; qTf[t] = (qTf[t] || 0) + 1; }
  const qTotal = qTokens.length;
  const qIdx = [], qVal = []; let qNsq = 0;
  for (const t in qTf) {
    if (index.vocab[t] === undefined) continue;
    const k = index.vocab[t];
    const v = qTf[t] / qTotal;
    qIdx.push(k); qVal.push(v); qNsq += v * v;
  }
  if (!qIdx.length) return [];
  const qNm = Math.sqrt(qNsq);
  for (let k = 0; k < qVal.length; k++) qVal[k] /= qNm;
  const results = [];
  for (let i = 0; i < index.rows.length; i++) {
    const row = index.rows[i];
    if (!row.idx.length) continue;
    let dot = 0;
    for (let qi = 0; qi < qIdx.length; qi++) {
      const qk = qIdx[qi];
      for (let di = 0; di < row.idx.length; di++) {
        if (row.idx[di] === qk) { dot += row.val[di] * qVal[qi]; break; }
      }
    }
    if (dot >= threshold) results.push({ i, score: dot });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- 会话列表元数据缓存（以文件 mtimeMs+size 为失效键，避免每次全量 loadTimeline）----
const sessionMetaCache = new Map();

// ---- 跨会话搜索索引缓存（以全部时间线文件的 mtime+size 指纹为失效键）----
// 前端仅 180ms 防抖，连续击键会连续触发 /v1/search；items 收集 + TF-IDF 建索引都按指纹复用
const searchIndexCache = { fp: null, index: null };

module.exports = function registerChatRoutes(app, deps) {
  const {
    baseDir,
    configuredModelName,
    loadTimeline,
    isRealMessageForTimeline,
    timelineFileFor,
    normalizeMessageForTimeline,
    buildTimeline,
    saveTimeline,
    appendMessages,
    appendRequestMessages,
    tailHasReply,
    patchMessage,
    deleteMessage,
    sseSubscribe,
    sseUnsubscribe,
    sseNotify,
    SSE_HEARTBEAT_MS,
    recentReplies,
    isRecentReplyCacheable,
    IDEMPOTENCY_TTL_MS,
    setRecentReply,
    buildCrossMemorySnapshot,
    sessionCrossInjectOverride,
    saveSessionCrossInjectOverride,
    prepareMessageForLLM,
    isQuietActive,
    collectTrailingUnansweredUserMessages,
    holdNewUserMessages,
    buildQuietHeldReply,
    normalizeContentToText,
    isSpecialEvent,
    stripInternalTags,
    extractTimestampWithMemory,
    stripPosition,
    extractCoRecordEventTime,
    classifySpecialEvent,
    resolveActiveProvider,
    resolveSessionProvider,
    resolveChatModel,
    sessionModelProviderOverride,
    saveSessionModelProviderOverride,
    readEnvValue,
    UPSTREAM_TIMEOUT_MS,
    handleMcpRequest,
    splitMultimodalContent,
    extractAssistantThinking,
    parseWakeTagAndSchedule,
    parseQuietTagAndSchedule,
    createContentTagFilter,
    appendSpecialEvent,
    MCP_ENABLED,
    summarizeMessagesForLog,
    setLastLLMCapture
  } = deps;

  // ========================
  // 会话上下文容量提醒：发送前检测，超限时往当轮消息流塞一条隐藏提醒并落盘，
  // 让 AI 自己调 context_replace 压缩；提醒随早期对话被压缩块覆盖后自然消失，再超限再塞。
  // 提醒全文读管理台压缩页维护的独立配置 data/ctx_limit_prompt.json（loadCtxLimitPrompt），
  // 与压缩提示词（compaction_prompt.json）互不关联；文案为用户定稿（2026-09-02 确认）。
  // ========================
  const CTX_LIMIT_HEAD = "（容量提醒）";

  // 摘要占位消息：被压缩块替换成的一段「（回忆 · … /（对话摘要 …」消息（与 context-replacements.js isReplacementMemoryMessage 同口径）
  function isSummaryPlaceholder(m) {
    if (!m || m.role !== 'assistant') return false;
    const c = String(m.content || '');
    return c.startsWith('（回忆 · ') || c.startsWith('（对话摘要');
  }

  // 容量提醒统计口径（2026-09-04 起）：按「未覆盖（未被压缩块替换）的对话原文」做 token 估算，
  // 与管理台设置的容量上限（token 估算）比较。maybeInject 在 applyReplacements 之后运行，
  // llmMessages 中被压缩块替换的部分已是摘要占位（isSummaryPlaceholder），未压缩的原文仍是原始 user/assistant 内容。
  // 计入：user/assistant 原文文本 + 标星原句（applyReplacements 有 marks 保护、标星不会被压掉，但它确实占用上下文）
  //       + 图片估算（每图 EST_IMAGE_TOKENS；历史图片已被 trim 裁剪、只留最近几轮，影响有限）。
  // 排除：system / 摘要占位 / 特殊事件 / 工具消息 —— 这些不可由 AI 压缩整理，不计入"待整理积压"。
  function countUncompressedTokens(messages) {
    let tokTotal = 0;
    for (const m of messages) {
      if (!m) continue;
      if (m.role === 'system') continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (m._ctxRep || m._ccSummary || m.tool_calls || m.tool_call_id) continue;
      if (isSummaryPlaceholder(m)) continue;
      if (isSpecialEvent(m)) continue;
      if (typeof m.content === 'string') tokTotal += contextCompactor.estimateTokens(m.content);
      else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (!part) continue;
          if (part.type === 'text' && typeof part.text === 'string') tokTotal += contextCompactor.estimateTokens(part.text);
          else if (part.type === 'image' || part.type === 'image_url') tokTotal += contextCompactor.EST_IMAGE_TOKENS;
          else tokTotal += 1; // 未知分片（附件/文件等）至少占位计 1，避免漏算致容量判定偏乐观（审查 2026-09-05 B2）
        }
      }
    }
    return tokTotal;
  }

  // 疑似有落盘 ctx_limit 提醒的会话（进程内存）：低于上限时据此跳过全量读盘清理。
  // 重启后为空——盘上遗留提醒会被特殊事件机制注入回流，流内出现时仍会触发读盘清理，闭环安全。
  const _ctxLimitReminderSessions = new Set();
  // 清理本会话时间线里落盘的历史容量提醒（kind=ctx_limit 且未删除 → 标记 deleted 并保存）。
  // 供两处使用：① 开关关闭时（不注入新提醒，但旧提醒必须清掉，否则特殊事件机制仍会每轮注回）；
  //           ② 低于上限时（提醒应消失，再超限才重新塞带新时间边界的）。
  function clearDiskCtxLimitReminder(sessionId) {
    let onDisk = false;
    try {
      const timeline = loadTimeline(sessionId);
      for (const m of timeline) {
        if (m && m.kind === 'ctx_limit' && !m.deleted) { m.deleted = true; onDisk = true; }
      }
      if (onDisk) saveTimeline(timeline, sessionId);
      if (!onDisk) _ctxLimitReminderSessions.delete(sessionId || 'default');
    } catch (cleanErr) {
      console.warn('[ctx-limit] 清理落盘容量提醒失败（不影响转发）:', cleanErr.message);
    }
    return onDisk;
  }
  function maybeInjectContextLimitReminder(llmMessages, sessionId, timeByKey) {    try {
      const cfg = contextCompactor.loadConfig();
      const limit = Number(cfg.compaction_context_limit_chars) || 0;
      // 开关关闭：不注入新提醒，但仍清理本会话落盘的历史容量提醒——
      // 否则旧提醒会被特殊事件机制每轮注回，表现成"关了开关还在注入"
      if (!cfg.compaction_context_remind_enabled) {
        const cleaned = clearDiskCtxLimitReminder(sessionId);
        if (cleaned) console.log(`[ctx-limit] 容量提醒开关已关闭，已清理会话 ${sessionId || 'default'} 落盘的历史容量提醒`);
        return;
      }
      if (limit <= 0) return;
      const tokens = countUncompressedTokens(llmMessages);
      // 注意顺序：必须先做「低于上限清理」再判「已有提醒不重复塞」——
      // 旧提醒会被特殊事件机制每轮注入回来，若先判「已有」就提前返回，永远走不到清理
      if (tokens <= limit) {
        // 已不超限：当轮消息流里不再带提醒，落盘的活跃提醒也标记删除——提示彻底消失；
        // 之后再次超限时（流里查不到提醒）会重新塞一条带新时间边界的
        let inStream = false;
        for (let i = llmMessages.length - 1; i >= 0; i--) {
          const m = llmMessages[i];
          if (m && (m.kind === 'ctx_limit' || (typeof m.content === 'string' && m.content.startsWith(CTX_LIMIT_HEAD)))) {
            llmMessages.splice(i, 1);
            inStream = true;
          }
        }
        let onDisk = false;
        // 内存标记说没有落盘提醒且消息流里也没看到（inStream=false）时，跳过全量读盘——
        // 稳态（从未超限或已清干净）下零读盘；流里出现旧提醒时仍会读盘清理（特殊事件机制会把盘上提醒注回来，闭环安全）
        if (!_ctxLimitReminderSessions.has(sessionId || 'default') && !inStream) return;
        onDisk = clearDiskCtxLimitReminder(sessionId);
        if (inStream || onDisk) {
          console.log(`[ctx-limit] 会话 ${sessionId || 'default'} 上下文 ${tokens} token（估算）已低于上限 ${limit}，容量提醒已移除（再超限会重新提醒）`);
        }
        return;
      }
      // 消息流里已有提醒（未随压缩消亡/未被窗口过滤）就不重复塞；kind 标记与文本开头双保险
      if (llmMessages.some(m => m && (m.kind === 'ctx_limit' || (typeof m.content === 'string' && m.content.startsWith(CTX_LIMIT_HEAD))))) return;

      // 建议整理段：流里最早的一段未压缩真实对话（跳过 system/摘要块/特殊事件/工具消息），
      // 取前 100 条，用 timeByKey 反查首末时间——给 AI 明确时间边界，防选错段压错范围。
      // 标星原句会保留在摘要前继续出现在上下文（设计如此），但它们不是「未压缩对话」——
      // 必须跳过，否则建议区间起点会落在已压缩区里的标星漏网原句上（渲染时间一直指向旧段）
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
      // 时间反查：消息本身 time 优先，timeByKey 兜底；注入消息（跨窗口快照等）没有时间，跳过它取最近可得的
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

      // 提醒全文：管理台独立配置 + 占位符替换（chars/limit=实际数字，chunkInfo=带时间边界的建议段）
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
        .replace(/\$\{conversationText\}/g, '（就是上面第 1 点要整理的那段对话）');
      if (!remark.trim().startsWith(CTX_LIMIT_HEAD)) return; // 模板异常兜底：开头标记缺失就不塞，防识别失效

      // 插入位置：塞到「最后一条 user 之前」（紧跟本轮用户消息之前、而非整个消息流末尾），
      // 避免对话序列以 assistant 收尾被部分模型当成"自己的上一条输出"续写。
      let insIdx = -1;
      for (let i = llmMessages.length - 1; i >= 0; i--) {
        const mm = llmMessages[i];
        if (mm && mm.role === 'user' && !isSpecialEvent(mm) && !mm.tool_call_id) { insIdx = i; break; }
      }
      const reminderMsg = { role: 'assistant', content: remark };
      if (insIdx >= 0) llmMessages.splice(insIdx, 0, reminderMsg);
      else llmMessages.push(reminderMsg);
      appendSpecialEvent(remark, { hidden: true, kind: 'ctx_limit' }, sessionId);
      _ctxLimitReminderSessions.add(sessionId || 'default');
      console.log(`[ctx-limit] 会话 ${sessionId || 'default'} 上下文 ${tokens} token（估算）超过上限 ${limit}，已塞容量提醒（${remark.length} 字符）`);
    } catch (err) {
      console.warn('[ctx-limit] 容量提醒检测失败（不影响转发）:', err.message);
    }
  }

  app.get('/v1/models', async (req, reply) => {
    reply.send({
      object: 'list',
      data: [{ id: configuredModelName(), object: 'model', created: 0, owned_by: 'gateway' }]
    });
  });

  // 多会话列表：扫描本目录下所有 enhanced_messages*.json，返回会话摘要（命中缓存只 stat 不重读）
  app.get('/v1/sessions', async (req, reply) => {
    try {
      const files = fsp.readdirSync(baseDir).filter(f => /^enhanced_messages[_-][A-Za-z0-9_-]+\.json$/.test(f));
      const sessions = [];
      const seen = new Set();
      for (const f of files) {
        const sid = f.replace(/^enhanced_messages_/, '').replace(/\.json$/, '');
        if (!sid || sid === 'default') continue;
        seen.add(sid);
        try {
          const filePath = path.join(baseDir, f);
          const st = fsp.statSync(filePath);
          const cached = sessionMetaCache.get(sid);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            sessions.push({ id: sid, name: sid, total: cached.total, real: cached.real, last_time: cached.last_time, is_default: false });
            continue;
          }
          const arr = loadTimeline(sid);
          const real = arr.filter(isRealMessageForTimeline);
          const meta = { mtimeMs: st.mtimeMs, size: st.size, total: arr.length, real: real.length, last_time: (arr[arr.length - 1] && arr[arr.length - 1].time) || null };
          sessionMetaCache.set(sid, meta);
          sessions.push({ id: sid, name: sid, total: meta.total, real: meta.real, last_time: meta.last_time, is_default: false });
        } catch (e) {}
      }
      // 清理已删除会话的缓存项，避免陈旧
      for (const k of Array.from(sessionMetaCache.keys())) {
        if (!seen.has(k)) sessionMetaCache.delete(k);
      }
      reply.send({ ok: true, sessions });
    } catch (err) {
      console.error('[GET /v1/sessions] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 删除会话：删除与会话ID对应的独立时间线文件。主会话(default)不允许删除。
  app.delete('/v1/sessions/:id', async (req, reply) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id || id === 'default') return reply.code(400).send({ error: '主会话不能删除' });
      const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
      if (safe !== id) return reply.code(400).send({ error: '非法会话ID' });
      const file = timelineFileFor(safe);
      if (!fsp.existsSync(file)) return reply.send({ ok: true, deleted: false, note: 'no-file' });
      const bakDir = path.join(baseDir, 'backups');
      if (fsp.existsSync(bakDir)) {
        const bak = path.join(bakDir, file + '.deleted-' + new Date().toISOString().replace(/[:.]/g, '-'));
        fsp.copySync(file, bak);
      }
      fsp.removeSync(file);
      reply.send({ ok: true, deleted: true });
    } catch (err) {
      console.error('[DELETE /v1/sessions/:id] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 第三方专用会话：读/写「不带 session_id 的第三方客户端(如 Kelivo)」落地到哪个会话。
  // 前端在会话列表里把某个会话设为「第三方专用」，存到 data/config.json 的 third_party_session_id。
  // 读：GET /v1/sessions/third-party → 返回当前第三方专用会话 id（可能为空）。
  // 写：POST /v1/sessions/third-party body:{session_id} → 设置/清空（传空串清空，回退 default 行为）。
  app.get('/v1/sessions/third-party', async (req, reply) => {
    try {
      const sid = String(memoryEngine.getConfig().third_party_session_id || '').trim();
      reply.send({ ok: true, session_id: sid || null });
    } catch (err) {
      console.error('[GET /v1/sessions/third-party] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.post('/v1/sessions/third-party', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const sid = String(body.session_id || '').trim();
      // 允许清空：传空串即回退 default 行为
      if (!sid) {
        await memoryEngine.updateConfig({ third_party_session_id: '' });
        return reply.send({ ok: true, session_id: '' });
      }
      const safe = sid.replace(/[^A-Za-z0-9_-]/g, '');
      if (safe !== sid) return reply.code(400).send({ error: '非法会话ID' });
      await memoryEngine.updateConfig({ third_party_session_id: safe });
      reply.send({ ok: true, session_id: safe });
    } catch (err) {
      console.error('[POST /v1/sessions/third-party] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 只读返回完整时间线（供自建聊天前端首次拉取历史；剥离内部 position 字段，保留 role/content/time）
  app.get('/v1/history', async (req, reply) => {
    try {
      const sessionId = String(req.query.session_id || req.headers['x-session-id'] || '').trim();
      const timeline = loadTimeline(sessionId);
      // 稳定 id 迁移：老数据无 id，首次被 history 读到就补 uuid 并写回（前端据此做 diff 编辑/删除）。
      let needWrite = false;
      for (const m of timeline) { if (m && !m.id) { m.id = (require('crypto').randomUUID) ? require('crypto').randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2); needWrite = true; } }
      if (needWrite) saveTimeline(timeline, sessionId);
      const items = timeline
        .filter(m => isRealMessageForTimeline(m) || (m && !m.deleted && isPushEchoLike(m)))
        .map(m => {
          const clean = { role: m.role };
          if (m.id !== undefined) clean.id = m.id;
          if (m.content !== undefined) clean.content = m.content;
          if (m.time) clean.time = m.time;
          if (m.reasoning !== undefined) clean.reasoning = m.reasoning;
          if (m.tools !== undefined) clean.tools = m.tools;
          if (m.segments !== undefined) clean.segments = m.segments;
          if (m.tokens !== undefined) clean.tokens = m.tokens;
          return clean;
        });
      reply.send({ ok: true, total: items.length, items, session_id: sessionId || 'default' });
    } catch (err) {
      console.error('[GET /v1/history] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  // 跨会话全量搜索：扫描所有会话时间线，支持关键词/语义两种模式（语义=TF-IDF+bigram）。
  app.get('/v1/search', async (req, reply) => {
    try {
      const q = String(req.query.q || '').trim();
      const mode = String(req.query.mode || 'keyword').trim() === 'semantic' ? 'semantic' : 'keyword';
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      if (!q) return reply.send({ ok: true, mode, total: 0, results: [] });
      const files = fsp.readdirSync(baseDir).filter(f => f === 'enhanced_messages.json' || /^enhanced_messages[_-][A-Za-z0-9_-]+\.json$/.test(f));
      const ql = q.toLowerCase();
      // 指纹缓存：任一时间线文件变化（mtime/size/增删）才重建 items，否则直接复用
      let fp = '';
      try {
        fp = files.map(f => {
          const st = fsp.statSync(path.join(baseDir, f));
          return f + ':' + st.mtimeMs + ':' + st.size;
        }).join('|');
      } catch (e) { fp = String(Date.now()); } // stat 失败则本次放弃缓存命中
      let items = [];
      if (searchIndexCache.fp === fp && searchIndexCache.items) {
        items = searchIndexCache.items;
      } else {
        for (const f of files) {
          // 主会话文件 enhanced_messages.json 的 sid 是 default，必须纳入搜索（否则主要聊天内容永远搜不到）
          const sid = f === 'enhanced_messages.json' ? 'default' : f.replace(/^enhanced_messages_/, '').replace(/\.json$/, '');
          if (!sid) continue;
          let arr = [];
          try { arr = loadTimeline(sid); } catch (e) { continue; }
          arr.filter(isRealMessageForTimeline).forEach((m, i) => {
            const text = normalizeContentToText(m.content) || '';
            if (!text) return;
            items.push({ sid, sidx: i, name: sid, text });
          });
        }
        searchIndexCache.fp = fp;
        searchIndexCache.items = items;
      }
      let results = [];
      if (mode === 'keyword') {
        items.forEach(it => { if (it.text.toLowerCase().includes(ql)) results.push({ sid: it.sid, sidx: it.sidx, name: it.name, text: it.text, score: 1 }); });
        results = results.slice(0, limit);
      } else {
        // 指纹命中时直接复用已建索引（TF-IDF 建索引是大头，不能每次请求重跑）
        let index = (searchIndexCache.fp === fp) ? searchIndexCache.index : null;
        if (!index) {
          index = buildSemIndex(items);
          searchIndexCache.fp = fp;
          searchIndexCache.index = index;
        }
        const hits = semanticSearch(index, q, 0.06);
        results = hits.slice(0, limit).map(h => { const it = index.items[h.i]; return { sid: it.sid, sidx: it.sidx, name: it.name, text: it.text, score: h.score }; });
      }
      reply.send({ ok: true, mode, total: results.length, results });
    } catch (err) {
      console.error('[GET /v1/search] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  // 已保存主题跨设备同步（存 data/saved-themes.json）
  const SAVED_THEMES_FILE = path.join(baseDir, 'data', 'saved-themes.json');
  app.get('/v1/themes', async (req, reply) => {
    try {
      let themes = [];
      try { if (fsp.existsSync(SAVED_THEMES_FILE)) themes = JSON.parse(fsp.readFileSync(SAVED_THEMES_FILE, 'utf-8')) || []; } catch (e) {}
      if (!Array.isArray(themes)) themes = [];
      reply.send({ ok: true, themes });
    } catch (err) {
      console.error('[GET /v1/themes] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.put('/v1/themes', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const themes = Array.isArray(body.themes) ? body.themes : [];
      const clean = themes.filter(t => t && typeof t === 'object').slice(0, 50);
      let existing = [];
      try { if (fsp.existsSync(SAVED_THEMES_FILE)) existing = JSON.parse(fsp.readFileSync(SAVED_THEMES_FILE, 'utf-8')) || []; } catch (e) {}
      if (!Array.isArray(existing)) existing = [];
      // 防止空覆盖：服务器已有主题却收到空数组时保留原数据，除非显式 replace
      if (clean.length === 0 && existing.length > 0 && !body.replace) {
        reply.send({ ok: true, saved: false, skipped: 'empty', count: existing.length });
        return;
      }
      fsp.ensureDirSync(path.join(baseDir, 'data'));
      fsp.writeFileSync(SAVED_THEMES_FILE, JSON.stringify(clean, null, 2), 'utf-8');
      reply.send({ ok: true, saved: true, count: clean.length });
    } catch (err) {
      console.error('[PUT /v1/themes] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });



  // 系统提示词备份跨设备同步（存 data/prompt-backups.json，与 /v1/themes 同模式）
  const PROMPT_BACKUPS_FILE = path.join(baseDir, 'data', 'prompt-backups.json');
  app.get('/v1/prompt-backups', async (req, reply) => {
    try {
      let backups = [];
      try { if (fsp.existsSync(PROMPT_BACKUPS_FILE)) backups = JSON.parse(fsp.readFileSync(PROMPT_BACKUPS_FILE, 'utf-8')) || []; } catch (e) {}
      if (!Array.isArray(backups)) backups = [];
      reply.send({ ok: true, backups });
    } catch (err) {
      console.error('[GET /v1/prompt-backups] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.put('/v1/prompt-backups', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const backups = Array.isArray(body.backups) ? body.backups : [];
      const now = new Date().toISOString();
      const clean = backups.filter(b => b && typeof b === 'object' && typeof b.content === 'string')
        .map(b => ({
          id: String(b.id || '').slice(0, 64) || ('pb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
          name: String(b.name || '未命名').slice(0, 60),
          content: b.content,
          createdAt: String(b.createdAt || now).slice(0, 40),
          updatedAt: String(b.updatedAt || now).slice(0, 40)
        })).slice(0, 50);
      let existing = [];
      try { if (fsp.existsSync(PROMPT_BACKUPS_FILE)) existing = JSON.parse(fsp.readFileSync(PROMPT_BACKUPS_FILE, 'utf-8')) || []; } catch (e) {}
      if (!Array.isArray(existing)) existing = [];
      // 防空覆盖：服务器已有备份却收到空数组时保留原数据，除非显式 replace（与 themes 一致）
      if (clean.length === 0 && existing.length > 0 && !body.replace) {
        reply.send({ ok: true, saved: false, skipped: 'empty', count: existing.length });
        return;
      }
      fsp.ensureDirSync(path.join(baseDir, 'data'));
      fsp.writeFileSync(PROMPT_BACKUPS_FILE, JSON.stringify(clean, null, 2), 'utf-8');
      reply.send({ ok: true, saved: true, count: clean.length });
    } catch (err) {
      console.error('[PUT /v1/prompt-backups] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 会话合并：读多个源会话时间线，按消息时间稳定排序合并写入新会话时间线；源会话不动。
  // 前端生成新 sid 传入（与 newSession 流程一致），服务端只负责合并与落盘。
  app.post('/v1/sessions/merge', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
      if (ids.length < 2) return reply.code(400).send({ error: '至少选择两个会话' });
      for (const id of ids) {
        if (id === 'default') return reply.code(400).send({ error: '主会话不参与合并' });
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return reply.code(400).send({ error: '非法会话ID: ' + id });
      }
      const target = String(body.target || '').trim();
      if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) return reply.code(400).send({ error: '非法目标会话ID' });
      if (ids.indexOf(target) >= 0) return reply.code(400).send({ error: '目标会话不能是源会话' });
      if (fsp.existsSync(timelineFileFor(target))) return reply.code(409).send({ error: '目标会话已存在' });

      // 各源会话按自身顺序取真实消息；无 time 的消息沿用同会话内前一条的时间，保持相对顺序。
      // 全局按 (ts, 源序, 会话内序) 稳定排序 —— buildTimeline 不重排真实消息，顺序由此保证。
      const entries = [];
      let total = 0;
      ids.forEach((id, si) => {
        let lastTs = 0;
        loadTimeline(id).filter(isRealMessageForTimeline).forEach((m, oi) => {
          const ts = (m.time && Number(new Date(m.time))) || 0;
          if (ts) lastTs = ts;
          entries.push({ m, ts: ts || lastTs, si, oi });
          total++;
        });
      });
      if (total === 0) return reply.code(400).send({ error: '所选会话都没有消息' });
      entries.sort((a, b) => (a.ts - b.ts) || (a.si - b.si) || (a.oi - b.oi));
      const rebuilt = buildTimeline(entries.map(e => e.m), target);
      saveTimeline(rebuilt, target);
      // 源会话压缩块复制到合并会话：matched 内容锚点在目标时间线重定位，按内容序列去重。
      // 复制语义：源会话块保留（源会话继续显示摘要），同时复制一份归属到目标会话。
      let migrateStat = null;
      try {
        migrateStat = contextReplacements.migrateSessionBlocks(ids, target);
        if (migrateStat) console.log(`[sessions/merge] 复制压缩块:`, JSON.stringify(migrateStat));
      } catch (e) { console.error('[sessions/merge] 复制压缩块失败:', e.message); }
      console.log(`[sessions/merge] 合并 ${ids.length} 个会话 -> ${target}（${total} 条源消息）`);
      reply.send({ ok: true, session_id: target, merged: total, total: rebuilt.filter(isRealMessageForTimeline).length });
    } catch (err) {
      console.error('[POST /v1/sessions/merge] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 会话分支：继承父会话中「完全落在分支点之前」的压缩块（复制语义，父会话块保留）。
  // 前端开分支后调用，branchIndex 是分支点消息在前端 msgs（真实消息序列）里的下标。
  app.post('/v1/sessions/branch-inherit', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const srcSession = String(body.srcSession || '').trim();
      const newSession = String(body.newSession || '').trim();
      const branchIndex = Number(body.branchIndex);
      if (!srcSession || !newSession || !Number.isInteger(branchIndex) || branchIndex < 0) {
        return reply.code(400).send({ error: '缺少参数' });
      }
      if (!/^[A-Za-z0-9_-]+$/.test(srcSession) || !/^[A-Za-z0-9_-]+$/.test(newSession)) {
        return reply.code(400).send({ error: '非法会话ID' });
      }
      const stat = contextReplacements.inheritSessionBlocks(srcSession, newSession, branchIndex, body.anchorId ? String(body.anchorId) : undefined);
      if (stat.error) return reply.code(404).send({ error: stat.error });
      reply.send({ ok: true, inherited: stat.inherited, skippedNoMatch: stat.skippedNoMatch, skippedCross: stat.skippedCross });
    } catch (err) {
      console.error('[POST /v1/sessions/branch-inherit] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 会话级跨窗口注入覆盖（新建会话时设置）：true=本会话强制注入, false=本会话关闭, null=跟随全局。
  // 仅影响该会话是否注入跨窗口记忆，不触碰管理台全局配置。
  app.get('/v1/sessions/:id/cross-inject', async (req, reply) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      const override = deps.sessionCrossInjectOverride(sessionId);
      reply.send({ session_id: sessionId, cross_inject_enabled: override, follow_global: override === null });
    } catch (err) {
      console.error('[GET /v1/sessions/:id/cross-inject] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.post('/v1/sessions/:id/cross-inject', async (req, reply) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      let val = null;
      if (body.enabled === true || body.enabled === 'true') val = true;
      else if (body.enabled === false || body.enabled === 'false') val = false;
      // 其余（undefined/null/''）→ null 跟随全局
      const saved = deps.saveSessionCrossInjectOverride(sessionId, val);
      reply.send({ ok: true, session_id: sessionId, cross_inject_enabled: val, saved: saved });
    } catch (err) {
      console.error('[POST /v1/sessions/:id/cross-inject] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 会话级模型供应商覆盖：本会话单独用哪个 AI 供应商（不存在/停用则回退全局）。
  // 仅影响该会话的转发目标（api_url/api_key/model），不触碰管理台全局配置。
  app.get('/v1/sessions/:id/model-provider', async (req, reply) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      const override = deps.sessionModelProviderOverride(sessionId);
      const modelName = deps.sessionModelNameOverride(sessionId);
      reply.send({ session_id: sessionId, model_provider_id: override, model_name: modelName, follow_global: override === null });
    } catch (err) {
      console.error('[GET /v1/sessions/:id/model-provider] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.post('/v1/sessions/:id/model-provider', async (req, reply) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      let val = null;
      if (typeof body.model_provider_id === 'string' && body.model_provider_id.trim()) val = body.model_provider_id.trim();
      // 其余（undefined/null/''）→ null 跟随全局
      const saved = deps.saveSessionModelProviderOverride(sessionId, val);
      let modelName = null;
      if (typeof body.model_name === 'string' && body.model_name.trim()) modelName = body.model_name.trim();
      const savedModel = deps.saveSessionModelNameOverride(sessionId, modelName);
      reply.send({ ok: true, session_id: sessionId, model_provider_id: val, model_name: modelName, saved: saved });
    } catch (err) {
      console.error('[POST /v1/sessions/:id/model-provider] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 实时事件流（SSE）：聊天页用 EventSource 订阅本会话，收到 history_update 后拉一次历史。
  app.get('/v1/events', async (req, reply) => {
    const sessionId = String(req.query.session_id || req.headers['x-session-id'] || '').trim() || 'default';
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write('retry: 3000\n\n');
    reply.raw.write('data: ' + JSON.stringify({ type: 'hello', session_id: sessionId, at: Date.now() }) + '\n\n');

    sseSubscribe(sessionId, reply);
    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, SSE_HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sseUnsubscribe(sessionId, reply);
    });
  });

  // 本地编辑/删除同步：聊天页「编辑 / 删除消息」目前只改本机 localStorage，
  // 真正写回服务端时间线要靠下一次发消息的全量重建。这里补一个轻量端点。
  // 双分支（兼容）：body.ops 是 diff 操作（新增，走 patch 定点、position 稳定）；
  //               body.messages 是旧整份（保留，靠 buildTimeline 全量，编辑/删除生效但会重排 position）。
  app.post('/v1/timeline/sync', async (req, reply) => {
    try {
      const body = req.body || {};
      const isClientChat = (req.headers['x-client'] || '').trim() === 'dylan-chat';
      if (!isClientChat) return reply.code(403).send({ error: 'forbidden' });
      const sessionId = String(body.session_id || req.headers['x-session-id'] || '').trim();
      // 新 diff 分支：body.ops = [{op:'edit',id,newContent} | {op:'delete',id}]，按 id 定点，不重排
      if (Array.isArray(body.ops)) {
        let ok = 0, miss = 0, del = 0;
        // 批量：一次 load+save，避免多选删除大段时逐 op 各读写盘一次
        const timeline = loadTimeline(sessionId);
        let changed = false;
        for (const op of body.ops) {
          if (!op || !op.id) continue;
          const idx = timeline.findIndex(m => m && m.id === op.id);
          if (idx < 0) { miss++; continue; }
          if (op.op === 'edit') {
            const updated = { ...timeline[idx], content: op.newContent, id: op.id };
            // 编辑特殊事件（推送回显/唤醒回显）：手动改 content 后，结构化元数据不再可信，
            // 用规范格式重新解析并同步更新字段；解析失败则清除字段退化为普通消息，
            // 避免管理台「推送管理」与聊天显示不一致。
            if (updated.event_type || updated.push_title || updated.push_body) {
              const parsed = parsePushEcho(op.newContent) || parseWakeEcho(op.newContent);
              if (parsed) {
                updated.event_type = (parsed.channel === '未发送') ? 'wake' : 'push';
                updated.push_at = parsed.at || updated.push_at;
                updated.push_user = parsed.user || updated.push_user;
                updated.push_channel = parsed.channel;
                updated.push_title = parsed.title;
                updated.push_body = parsed.body;
                updated.push_tail = parsed.tail;
              } else {
                delete updated.event_type;
                delete updated.push_at; delete updated.push_user; delete updated.push_channel;
                delete updated.push_title; delete updated.push_body; delete updated.push_tail;
              }
            }
            timeline[idx] = updated;
            ok++;
          } else if (op.op === 'delete') {
            timeline.splice(idx, 1);
            del++;
          } else {
            miss++;
            continue;
          }
          changed = true;
        }
        if (changed) { saveTimeline(timeline, sessionId); sseNotify(sessionId); }
        console.log(`[timeline-sync] diff编辑/删除同步 (session=${sessionId || 'default'}, 改=${ok}, 删=${del}, 未命中=${miss})`);
        return reply.send({ ok: true, edited: ok, deleted: del, missed: miss, session_id: sessionId || 'default' });
      }
      // 旧整份分支：保留兼容（老前端/退化场景）
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const realMsgs = messages.filter(isRealMessageForTimeline).map(normalizeMessageForTimeline);
      const rebuilt = buildTimeline(realMsgs, sessionId);
      saveTimeline(rebuilt, sessionId);
      sseNotify(sessionId);
      console.log(`[timeline-sync] 编辑/删除全量同步 (session=${sessionId || 'default'}, 条数=${rebuilt.length})`);
      reply.send({ ok: true, total: rebuilt.length, session_id: sessionId || 'default' });
    } catch (err) {
      console.error('[timeline-sync] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // ========================
  // /v1/chat/completions（从 server.js 拆出）
  // ========================
app.post("/v1/chat/completions", async (req, reply) => {
  try {
    const body = req.body;
    // 批注 2026-07-15：公开部署时日志不能默认写入完整上下文；
    // 这里只保留请求摘要，避免 system prompt、记忆和聊天正文进入 pm2 日志。
    console.log(JSON.stringify({
      event: "kelivo_request",
      model: body?.model || "",
      stream: body?.stream === true,
      messages: summarizeMessagesForLog(body?.messages || [])
    }));

    const kelivoMessages = body.messages || [];

    // 多会话：识别当前请求来自哪个会话
    let sessionId = String(body.session_id || req.headers["x-session-id"] || "").trim();
    // 第三方客户端(Kelivo 等)通常不带 session_id：若配置了「第三方专用会话」，
    // 则落到该会话，避免混入主会话 default；未配置才回退空(==default)。
    if (!sessionId) {
      const tpSid = String(memoryEngine.getConfig().third_party_session_id || "").trim();
      if (tpSid) sessionId = tpSid;
    }
    // 让压缩/替换按当前会话时间线工作（onResponse 钩子复位）
    contextReplacements.setActiveSession(sessionId || null);
    req.__ctxWasSet = true;
    // 客户端来源标记：自建前端(chat.html)带 x-client=dylan-chat；第三方客户端(如 Kelivo)不带。
    // 时间线已改为追加式增量写、不再全量覆盖，故放开「必须带 x-client 才写」的门槛：
    // 只要请求通过鉴权且携带真实消息就写时间线，第三方不带该头也能正常写入、供自建前端看到。
    const isClientChat = (req.headers["x-client"] || "").trim() === "dylan-chat";

    // ========================
    // 幂等回放：同一 client_msg_id 的重复请求（如浏览器断连重发）直接回放上次已生成的回复，
    // 不再次调用上游、不重复写时间线。
    // ========================
    const clientMsgId = isClientChat ? String(body.client_msg_id || "").trim() : "";
    if (clientMsgId) {
      const cached = recentReplies.get(clientMsgId);
      if (cached && isRecentReplyCacheable(cached) && (Date.now() - cached.ts) < IDEMPOTENCY_TTL_MS) {
        console.log("[idempotency] 命中同 client_msg_id 的已生成回复，直接回放");
        if (body.stream === true) {
          const stream = mcp.buildSSE(cached.text, { model: body.model || cached.model || "", usage: cached.usage, reasoning: cached.reasoning, toolHistory: cached.tools });
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const reader = stream.getReader();
          try {
            while (true) { const { done, value } = await reader.read(); if (done) break; reply.raw.write(value); }
            reply.raw.end();
          } catch (e) { try { reply.raw.end(); } catch {} }
          return;
        }
        reply.send({
          id: "chatcmpl-idem",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: cached.model || body.model || "",
          choices: [{ index: 0, message: { role: "assistant", content: cached.text }, finish_reason: "stop" }],
          usage: cached.usage || null
        });
        return;
      }
    }

    const oldTimeline = loadTimeline(sessionId);

    const finalTimeline = buildTimeline(kelivoMessages, sessionId);
    // 防误伤：携带真实消息(或首次建线)才写时间线。时间线已是追加式增量写、不再全量覆盖历史，
    // 故放宽原先「必须 x-client=dylan-chat 才写」的门槛——第三方客户端(如 Kelivo)不带该头
    // 且已带上真实消息，也能正常写入，供自建前端(chat.html)看到。
    if (kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0) {
      // 方案二增量：落盘改为以盘上为基同步差量（新消息补齐/人设同步/重生成清尾），
      // 不再拿请求全量重建覆盖；finalTimeline 仅服务后续事件注入与时间映射。通知由同步函数按需发出。
      appendRequestMessages(sessionId, kelivoMessages);
    } else {
      console.log("[timeline] 跳过时间线保存 (真实消息=" + kelivoMessages.some(isRealMessageForTimeline) + ")");
    }

    // Kelivo 发图时 content 常是数组。默认原样透传给视觉模型；
    // 图片默认原样透传给视觉模型（2026-09-08）
    let llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);
    // 主聊天（客户端携带 system 身份提示）才做记忆/跨窗口/特殊事件注入；标题总结等旁路请求保持精简
    const isMainChat = kelivoMessages.some(function (m) {
      if (!m) return false;
      if (m.role === "system") return true;
      if (m.role === "user" && typeof m.content === "string" && m.content.trim().indexOf("<system>") === 0) return true;
      return false;
    });

    // ========================
    // 消息扣住（免打扰）：扣住时段内新用户消息待处理，不转发给模型。
    // 设计口径：免打扰只服务主陪伴会话（isMainChat）——<quiet> 调度文件本身是全局一份，
    // 其他会话不受扣住影响、照常对话；释放流程（唤醒/总结/推送）也只针对主会话。
    // ========================
    if (isMainChat && isQuietActive()) {
      const trailing = collectTrailingUnansweredUserMessages(kelivoMessages);
      if (trailing.length > 0) {
        const newest = normalizeContentToText(trailing[trailing.length - 1].content) || "";
        const urgent = /紧急|急事|加急|急用|很急|马上回/.test(newest);
        if (urgent) {
          console.log("[quiet] 检测到紧急关键词，本次放行");
        } else {
          const addedHeld = holdNewUserMessages(trailing);
          console.log(`[quiet] 扣住 ${addedHeld} 条新用户消息，本次不转发给模型`);
          return buildQuietHeldReply(reply);
        }
      }
    }

    // 用时间线里的原始回复替换客户端清洗过的版本，保留 <memory>/<pin> 标签：
    // 模型能看到自己写过什么，管理台上下文窗口也能审查。
    // 匹配方式：时间线回复去掉内部标签后与客户端内容比对。
    {
      const rawByClean = new Map();
      for (const m of finalTimeline) {
        if (m.role !== "assistant" || isSpecialEvent(m) || typeof m.content !== "string") continue;
        const clean = stripInternalTags(m.content).trim();
        if (clean && !rawByClean.has(clean)) rawByClean.set(clean, m);
      }
      llmMessages = llmMessages.map(m => {
        if (m.role !== "assistant" || typeof m.content !== "string") return m;
        const raw = rawByClean.get(String(m.content).trim());
        return raw && raw.content !== m.content ? { ...m, content: raw.content } : m;
      });
    }


    // 特殊事件按时间定位插入：客户端消息不带 time 字段，
    // 先用 finalTimeline 里已解析/恢复的时间建立 内容->时间 映射，保证事件能落到对应时间位置
    const timeByKey = new Map();
    for (const m of finalTimeline) {
      if (isSpecialEvent(m)) continue;
      const key = m.role + "\u0000" + normalizeContentToText(m.content);
      const t = extractTimestampWithMemory(m);
      if (t && !timeByKey.has(key)) timeByKey.set(key, t);
    }
    const oldEvents = stripPosition(finalTimeline.filter(m => !m.deleted && isSpecialEvent(m)));
    // 当前窗口起点：最新一次重建时间线里第一条真实 user 消息时间，用于界定本次会话的特殊事件范围
    let windowStartMs = null;
    for (const m of finalTimeline) {
      if (windowStartMs !== null) break;
      if (!m || m.role !== "user") continue;
      if (isSpecialEvent(m)) continue;
      const mt = extractTimestampWithMemory(m);
      if (mt) windowStartMs = mt.getTime();
    }
    // 特殊事件注入：只取当前窗口（第一条真实 user 消息之后）内的事件；窗口内不限制条数（推送同样不限制）
    const pushEnabled = memoryPool.getConfig().cross_inject_push !== false;
    let injectableEvents = oldEvents.slice();
    if (windowStartMs !== null) {
      injectableEvents = injectableEvents.filter(ev => {
        const t = extractTimestampWithMemory(ev) || extractCoRecordEventTime(ev);
        const tms = t ? t.getTime() : NaN;
        return !isFinite(tms) || tms >= windowStartMs;
      });
    }
    // 推送开关关闭时剔除推送类特殊事件；条数不再限制（配合压缩摘要统一压缩）
    if (!pushEnabled) {
      injectableEvents = injectableEvents.filter(ev => {
        const cats = classifySpecialEvent(ev) || [];
        return cats.indexOf('push') < 0;
      });
    }

    // 特殊事件注入分类多选：只注入勾选类型；配置里没有该 key 时默认全部注入。
    // 容量提醒（ctxlimit）不受该配置限制——它是网关塞给 AI 的整理指令，必须始终可见
    const injectTypesCfg = memoryEngine.getConfig().event_inject_types;
    if (Array.isArray(injectTypesCfg)) {
      const enabledTypes = new Set(injectTypesCfg);
      const before = injectableEvents.length;
      injectableEvents = injectableEvents.filter(ev => {
        const cats = classifySpecialEvent(ev);
        if (!cats.length) return true; // 无法分类的兜底保留
        return cats.some(k => k === 'ctxlimit' || enabledTypes.has(k));
      });
      if (injectableEvents.length !== before) {
        console.log(`[event-inject] 分类过滤: ${before} -> ${injectableEvents.length} 条`);
      }
    }

    // 容量提醒注回受全局开关控制（2026-09-05 修复）：开关关闭时，历史遗留的容量提醒不再注入回流。
    // 注：上方"必须始终可见"的默认设计前提是开关开启；用户显式关闭开关时应尊重"关=彻底不注入"，
    // 与 maybeInject 的落盘清理配合，消除"关了开关还在注入"的残留。
    if (contextCompactor.loadConfig().compaction_context_remind_enabled === false) {
      const before = injectableEvents.length;
      injectableEvents = injectableEvents.filter(ev => {
        if (ev && ev.kind === 'ctx_limit') return false;
        const cats = classifySpecialEvent(ev);
        return !(Array.isArray(cats) && cats.indexOf('ctxlimit') >= 0);
      });
      if (injectableEvents.length !== before) {
        console.log(`[ctx-limit] 容量提醒开关已关闭，跳过 ${before - injectableEvents.length} 条历史容量提醒注入`);
      }
    }


    // 共影记录注入开关：关闭后整段观影记录不再注入主对话（记录仍完整保存在共影里）
    const coEventInjectEnabled = memoryEngine.getConfig().co_event_inject_enabled !== false;
    if (!coEventInjectEnabled) {
      const before = injectableEvents.length;
      injectableEvents = injectableEvents.filter(ev => !(typeof ev.content === "string" && ev.content.includes("共影）")));
      if (injectableEvents.length !== before) {
        console.log("[co-event] 共影记录注入已关闭，跳过观影记录");
      }
    }

    if (!isMainChat) injectableEvents = [];
    console.log("本次注入的特殊事件数量:", injectableEvents.length);

    // 客户端经 /v1/history 带回的推送回显会以普通 assistant 消息出现在 llmMessages，
    // 与下面 injectableEvents 注入的同一条会重复 → 按 content 去重，保证上下文只出现一次。
    const llmEventKeys = new Set();
    for (const m of llmMessages) {
      if (m && typeof m.content === "string") llmEventKeys.add(normalizeContentToText(m.content));
    }
    for (const event of injectableEvents) {
      const evKey = normalizeContentToText(event.content);
      if (llmEventKeys.has(evKey)) continue; // 已在 llmMessages（客户端带回），跳过重复注入
      const eventTime = extractTimestampWithMemory(event) || extractCoRecordEventTime(event);
      if (!eventTime) { llmMessages.push(event); llmEventKeys.add(evKey); continue; }
      let inserted = false;
      for (let i = 0; i < llmMessages.length; i++) {
        const m = llmMessages[i];
        if (m.role === "system") continue; // 系统提示保持首位，历史事件不能插到 system 之前
        let msgTime = timeByKey.get(m.role + "\u0000" + normalizeContentToText(m.content));
        if (!msgTime) msgTime = extractTimestampWithMemory(m);
        if (msgTime && msgTime >= eventTime) {
          llmMessages.splice(i, 0, event);
          inserted = true;
          break;
        }
      }
      if (!inserted) llmMessages.push(event);
      llmEventKeys.add(evKey);
    }



    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理） ----
    // 第一遍：标记需要移除的索引
    const removeSet = new Set();

    // 检查 assistant tool_calls 是否完整
    for (let i = 0; i < llmMessages.length; i++) {
      const msg = llmMessages[i];
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      const expectedIds = msg.tool_calls.map(tc => tc.id);
      const followingTools = [];
      for (let j = i + 1; j < llmMessages.length; j++) {
        const nxt = llmMessages[j];
        if (nxt.role === "tool") {
          followingTools.push(nxt);
        } else {
          break;
        }
      }
      const foundIds = followingTools.map(t => t.tool_call_id);
      const complete = expectedIds.every(id => foundIds.includes(id));
      if (!complete) {
        // 标记这条 assistant 为移除，同时标记它后面的所有 tool 消息也移除
        removeSet.add(i);
        for (let j = i + 1; j < llmMessages.length; j++) {
          if (llmMessages[j].role === "tool") {
            removeSet.add(j);
          } else {
            break;
          }
        }
        console.log(`⚠️ 自动修复：移除不完整的 tool_calls (索引 ${i})`);
      }
    }

    // 检查孤立 tool 消息（前面没有对应的 tool_calls）
    for (let i = 0; i < llmMessages.length; i++) {
      if (llmMessages[i].role !== "tool") continue;
      // 向前查找最近的 assistant
      let hasMatchingToolCalls = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = llmMessages[j];
        if (prev.role === "assistant" && prev.tool_calls) {
          // 检查这个 tool_call_id 是否在 assistant 的 tool_calls 中
          const ids = prev.tool_calls.map(tc => tc.id);
          if (ids.includes(llmMessages[i].tool_call_id)) {
            hasMatchingToolCalls = true;
          }
          break;
        } else if (prev.role === "tool") {
          continue; // 继续向前找
        } else {
          break; // 遇到 user 或其他消息，停止
        }
      }
      if (!hasMatchingToolCalls) {
        removeSet.add(i);
        console.log(`⚠️ 自动修复：移除孤立的 tool 消息 (索引 ${i})`);
      }
    }

    // 按索引从大到小删除，避免索引错乱
    const sortedRemove = Array.from(removeSet).sort((a, b) => b - a);
    for (const idx of sortedRemove) {
      llmMessages.splice(idx, 1);
    }

    // (trim 逻辑在下方最近窗口处执行，当前用户请求的图片始终保留)

    // 统一模型解析（2026-09-08）：会话级设置 → 全局默认供应商 → env 兜底，与 MCP 路径同一口径
    const { provider: prov, model: resolvedModel } = deps.resolveChatModel(sessionId, body.model);
    if (resolvedModel) body.model = resolvedModel;
    const targetApiUrl = (prov && (prov.api_url || prov.base_url)) || readEnvValue("TARGET_API_URL");
    const targetApiKey = (prov && prov.api_key) || readEnvValue("TARGET_API_KEY");
    if (!targetApiUrl || !targetApiKey) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 或 AI 供应商未配置" });
    }

    const requestedStream = body?.stream === true;

    // ========================
    // 永久注入上下文：pinned context 注入 system prompt
    // ========================
    try {
      const pinnedCtx = isMainChat && memoryEngine.buildPinnedContext ? memoryEngine.buildPinnedContext() : '';
      let crossCtx = "";
      if (isMainChat) {
        try {
          // 跨窗口触发条件：新建会话 id 时抓一次快照并固定。
          // buildCrossMemorySnapshot(sessionId) 会复用已存在的快照（同 sessionId 不再重建），
          // 因此这里不再按消息条数触发，话题相关记忆交给 surface_memory 按需召回。
          crossCtx = buildCrossMemorySnapshot(sessionId);
        } catch (cx) { console.warn("[cross-inject] 失败:", cx.message); }
      }
      let sysExtra = "";
      if (pinnedCtx) sysExtra += '\n\n## 永久上下文\n' + pinnedCtx;
      // 批注 2026-08-30：memory 提示不再硬编码注入（用户已写入 pin/永久上下文），删除此段。
      if (sysExtra) {
        const sysIdx = llmMessages.findIndex(m => m.role === "system");
        if (sysIdx >= 0) {
          llmMessages[sysIdx].content = llmMessages[sysIdx].content + sysExtra;
        } else {
          llmMessages.unshift({ role: "system", content: sysExtra.trim() });
        }
        if (pinnedCtx) console.log('[pinned] 注入永久上下文');
      }
      // 跨窗口注入：不进系统提示，作为上下文消息拼在 system 之后（与当前时间线特殊事件同属上下文层）
      if (isMainChat && crossCtx) {
        const sysIdx = llmMessages.findIndex(m => m.role === "system");
        const bg = { role: "assistant", content: crossCtx };
        if (sysIdx >= 0) {
          llmMessages.splice(sysIdx + 1, 0, bg);
        } else {
          llmMessages.unshift(bg);
        }
        console.log('[cross-inject] 注入跨窗口记忆（上下文）');
      }
    } catch (pinErr) {
      console.warn('[pinned] 注入失败:', pinErr.message);
    }

    // ========================
    // 对话时记忆浮现 / 时间注入：已随记忆池与摘要体系一起移除
    // ========================

    // 上下文记忆替换：把已记录范围里的原文替换成 AI 自己写的记忆（源文件不动，只影响本次发送）
    try {
      const beforeCount = llmMessages.length;
      llmMessages = contextReplacements.applyReplacements(llmMessages);
      if (llmMessages.length !== beforeCount) {
        console.log("[context-replacements] 发送前替换生效: 消息 " + beforeCount + " -> " + llmMessages.length);
      }
    } catch (repErr) {
      console.warn("[context-replacements] 替换失败（按原样转发）:", repErr.message);
    }

    // 历史图片裁剪已移除（2026-09-08）：图片原样透传，不做任何保留窗口

    // 会话容量提醒：替换/裁剪后按最终发送量检测，超限塞一条隐藏提醒（AI 自己压缩）
    maybeInjectContextLimitReminder(llmMessages, sessionId, timeByKey);

    // 上下文压缩已统一进「上下文替换」：早期对话块摘要与 AI 记忆现在都是同一种替换记录，
    // 由 contextReplacements.applyReplacements 统一生效，旧压缩器发送路径已停用。


    // 请求模型
    // Capture the actual messages sent to LLM for inspection
    if (isMainChat) {
      setLastLLMCapture(llmMessages.map(m => {
        const cap = splitMultimodalContent(m.content);
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




    // 管理台展示：保留完整消息序列（含动态注入），方便核对注入位置

    // 转发前只保留 OpenAI 兼容字段，剥离 Kelivo 自定义字段（position 等）
    const sanitizedMessages = llmMessages.map(msg => {
      const clean = { role: msg.role };
      if (msg.content !== undefined) clean.content = msg.content;
      if (msg.name !== undefined) clean.name = msg.name;
      if (msg.tool_calls !== undefined) clean.tool_calls = msg.tool_calls;
      if (msg.tool_call_id !== undefined) clean.tool_call_id = msg.tool_call_id;
      // 多轮对话时可回传思考链（前端若开"回传思考链"会带 reasoning_content），透传给上游而非丢弃
      if (msg.role === "assistant" && msg.reasoning_content !== undefined) clean.reasoning_content = msg.reasoning_content;
      return clean;
    });


    // === MCP_TOOL_LOOP_BEGIN ===
    // MCP 工具循环：启用时若为主聊天，走 MCP 分支（工具轮次非流式，最终流式回传）
    // 这里传入已处理好的 sanitizedMessages，完整保留记忆/时间线/替换/裁剪上下文
    if (MCP_ENABLED()) {
      try {
        // 登记当前聊天会话：AI 在工具循环里调 context_replace 时，工具服务器回调
        // /internal/apply 是独立请求（ALS 已丢），靠这个登记把块记到正确会话
        contextReplacements.noteMcpChatSession(sessionId);
        if (await handleMcpRequest(body, reply, req, sanitizedMessages, sessionId, kelivoMessages)) return;
      } catch (mcpErr) {
        console.warn("[mcp] 工具循环失败，回退原逻辑:", mcpErr.message);
      }
    }
    // === MCP_TOOL_LOOP_END ===
    // 上游请求超时保护，避免上游挂起导致 /v1 请求永久阻塞
    const upstreamController = new AbortController();
    const upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(targetApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${targetApiKey}`
        },
        body: JSON.stringify({ ...body, messages: sanitizedMessages }),
        signal: upstreamController.signal
      });
    } catch (upstreamErr) {
      clearTimeout(upstreamTimer);
      throw upstreamErr;
    }

    const upstreamContentType = response.headers.get("content-type") || "";
    const shouldStreamResponse = requestedStream || upstreamContentType.includes("text/event-stream");

    // 批注 2026-07-11：Kelivo 关闭 stream 时需要收到普通 JSON；只在请求或上游确认为 SSE 时才按流式直通。
    if (!shouldStreamResponse) {
      const responseText = await response.text();
      let finalResponseText = responseText;

      // 解析 AI 回复，提取 <memory> 标签存入记忆池，并清洗返回给用户的内容
      try {
        const parsed = JSON.parse(responseText);
        const aiMessage = parsed.choices?.[0]?.message || {};
        const aiContent = aiMessage.content || "";
        const aiThinking = extractAssistantThinking(aiMessage);
        if (aiContent) {
          // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
          parseWakeTagAndSchedule(aiContent, sessionId);
          parseQuietTagAndSchedule(aiContent);
          // 提取并存储记忆，同时拿到清洗后的文本
          const cleanText = await tagParser.extractAndStore(aiContent);
          // 用清洗后的文本替换 JSON 中的 content
          if (cleanText !== aiContent) {
            parsed.choices[0].message.content = cleanText;
            finalResponseText = JSON.stringify(parsed);
          }
          // 方案二增量：回复只追加一条；盘尾已有同内容回复（重试/重发）则跳过，不重复写
          if ((kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0)) {
            if (!tailHasReply(sessionId, cleanText)) {
              appendMessages(sessionId, [{ role: "assistant", content: cleanText }]);
            }
          } else {
            console.log("[timeline] 跳过回复落盘 (非流式)");
          }
          // 非流式同样写幂等缓存：同 client_msg_id 的重发直接回放，不重复调上游/重复写时间线
          if (cleanText && body && body.client_msg_id) {
            setRecentReply(String(body.client_msg_id).trim(), {
              text: cleanText, model: body.model || "", reasoning: aiThinking || "", tools: [], usage: (parsed && parsed.usage) || null, ts: Date.now()
            });
          }
        }
      } catch (parseErr) {
        console.warn("[memory] 非流式响应 JSON 解析失败:", parseErr.message);
      }

      clearTimeout(upstreamTimer);
      return reply
        .code(response.status)
        .header("Content-Type", upstreamContentType || "application/json")
        .send(finalResponseText);
    }

    if (!response.body) {
      return reply.code(response.status).send({ error: "上游 API 没有返回可读取的响应体" });
    }

    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    const streamChunks = [];
    try {
    // Streaming tag filter: 上游会把 <memory>/<pin> 拆成 <、memory、> 等多个事件，
    // 字节层匹配不到完整标签，必须在 content 文本层过滤后再重组 SSE 事件。
    const contentFilter = createContentTagFilter();
    const emitRawLine = (line) => reply.raw.write(line + "\n");
    let sseBuffer = "";
    // UTF-8 流式解码：多字节字符（中文/emoji）可能被网络分包从字节中间切开，
    // 逐 chunk 独立 toString 会产出 U+FFFD 乱码并破坏 <memory>/<pin> 等标签的字节层匹配
    const sseDecoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamChunks.push(value);

      sseBuffer += sseDecoder.decode(value, { stream: true });
      let nl;
      while ((nl = sseBuffer.indexOf("\n")) !== -1) {
        const rawLine = sseBuffer.slice(0, nl);
        sseBuffer = sseBuffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (!line.startsWith("data:")) {
          emitRawLine(line);
          continue;
        }
        const payload = line.slice(5).replace(/^\s+/, "");
        if (!payload || payload === "[DONE]") {
          emitRawLine(line);
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          emitRawLine(line);
          continue;
        }
        const delta = evt && evt.choices && evt.choices[0] && evt.choices[0].delta;
        // 空字符串 content 常伴随 finish_reason/usage（如末尾事件），必须原样透传
        if (delta && typeof delta.content === "string" && delta.content.length > 0) {
          contentFilter.push(delta.content, (filtered) => {
            delta.content = filtered;
            reply.raw.write("data: " + JSON.stringify(evt) + "\n\n");
          });
        } else {
          emitRawLine(line);
        }
      }
    }
    // 收尾：丢弃未闭合标签/残留前缀，转发剩余行，结束响应
    contentFilter.flush();
    if (sseBuffer) emitRawLine(sseBuffer.replace(/\n+$/, ""));
    reply.raw.end();
    } catch (streamErr) {
      // 上游中断/超时时确保响应结束，避免连接悬挂
      try { reply.raw.end(); } catch {}
      throw streamErr;
    } finally {
      clearTimeout(upstreamTimer);
    }

    // 流结束后解析 AI 回复
    try {
      const fullText = Buffer.concat(streamChunks).toString("utf-8");
      // 从 SSE 中提取完整的 AI 回复文本
      let aiFullContent = "";
      let aiThinking = "";
      let aiUsage = null;
      const lines = fullText.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const evt = JSON.parse(line.slice(6));
            const delta = evt.choices?.[0]?.delta?.content;
            if (delta) aiFullContent += delta;
            const deltaThink = evt.choices?.[0]?.delta?.reasoning_content || evt.choices?.[0]?.delta?.reasoning;
            if (deltaThink) aiThinking += (typeof deltaThink === "string" ? deltaThink : (deltaThink.text || ""));
            const finishContent = evt.choices?.[0]?.message?.content;
            if (finishContent) aiFullContent = finishContent;
            if (evt.usage) { aiUsage = evt.usage; console.log("[usage] " + JSON.stringify(evt.usage)); }
          } catch {}
        }
      }
      if (aiFullContent) {
        // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
        parseWakeTagAndSchedule(aiFullContent, sessionId);
        parseQuietTagAndSchedule(aiFullContent);
        // 提取并存储记忆，并拿到清洗后的文本
        const cleanFull = await tagParser.extractAndStore(aiFullContent).catch(err => {
          console.warn("[memory] 流式标签解析失败:", err.message);
          return aiFullContent;
        });
        // 方案二增量：回复只追加一条（富字段 reasoning/tokens 一并落，跨设备刷新不丢）；
        // 盘尾已有同内容回复（重试/重发）则跳过，不重复写
        if ((kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0)) {
          if (!tailHasReply(sessionId, cleanFull)) {
            appendMessages(sessionId, [{ role: "assistant", content: cleanFull, reasoning: aiThinking || "", tokens: aiUsage || null }]);
          }
        } else {
          console.log("[timeline] 跳过回复落盘 (流式)");
        }
        // 缓存本次已生成的回复，供同 client_msg_id 的重复请求直接回放。
        if (cleanFull && body && body.client_msg_id) {
          setRecentReply(String(body.client_msg_id).trim(), {
            text: cleanFull, model: body.model || "", reasoning: aiThinking || "", tools: [], usage: aiUsage || null, ts: Date.now()
          });
        }
      }
    } catch (streamErr) {
      console.warn("[memory] 流式响应解析失败:", streamErr.message);
    }
  } catch (err) {
    console.error(err);
    reply.code(500).send({ error: err.message });
  }
});
};
