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
const { imageAbsUrl } = require('./imgurl');
const { formatDateTimeInTimeZone } = require('../time_utils');
const { parsePushEcho, parseWakeEcho } = require('../utils/push');
// 对话侧/唤醒侧共用上下文加工函数（2026-09-15 唤醒并入网关）
const chatCtx = require('./chat-context');
const ctxV2Shadow = require('../context-v2-shadow'); // Context V2 Shadow 观察（C10 S2-B1，只记录不改生产）
const { mapMessagesForProvider } = require('../lib/role-mapper');

// 推送回显（成功推送的「刚刚给 X 发了 X 推送：」记录）需要在聊天页显示给用户看，
// 其余特殊事件（容量提醒/唤醒/日记/记忆浮现等）保持对前端隐藏。
function isPushEchoLike(m) {
  if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return false;
  if (m.event_type === 'push') return true;
  return !!parsePushEcho(m.content);
}

// ---- 跨会话语义检索（TF-IDF + 字符 bigram，与前端旧逻辑同口径）----
// 文本 → 字符 bigram 序列（小写化；中英文数字以外的字符折成空格并丢弃；不足两字时退化为单字序列）
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
// 对 items 建 TF-IDF 向量索引（每文档 L2 归一化），返回 { vocab, rows, items } 供 semanticSearch 点积
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
// 查询向量与索引逐行点积（稀疏交集），返回 [{ i, score }] 按分降序；低于 threshold 丢弃（默认 0.05）
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

// ---- 工具调用记录 → role=tool 消息组（发送模型前的内存转换，不落盘）----
// 2026-09-15 已搬至 routes/chat-context.js（对话侧/唤醒侧共用），此处经 chatCtx 调用。

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

  // 会话上下文容量提醒守卫（2026-09-15 搬至 routes/chat-context.js，对话侧/唤醒侧共用同一实现）
  const ctxLimitGuard = chatCtx.createCtxLimitReminderGuard({
    contextCompactor,
    contextReplacements,
    loadTimeline,
    saveTimeline,
    appendSpecialEvent,
    isSpecialEvent,
    normalizeContentToText
  });

  // 统一对话构建器（2026-09-15 批3核心）：聊天与唤醒同源同前缀的唯一上下文来源
  const buildConversation = chatCtx.createConversationBuilder({
    loadTimeline,
    prepareMessageForLLM,
    buildCrossMemorySnapshot,
    stripPosition,
    memoryEngine
  });

  // 日记共享模块（2026-09-16）：日常聊天 [DIARY] 提取与保存（与唤醒共用 lib/diary.js）
  const diaryLib = require('../lib/diary')({ baseDir, readEnvValue });

  // ---- Context V2 Shadow 输入组装（C10 S2-B1，2026-09-17）：全部只读，异常由调用点 try/catch 兜底 ----
  // 已知简化（观察口径，S3 观察期校准）：日记不做隐藏清单过滤、不做会话创建日边界过滤。
  // 未进 context_v2_pinned_map.json 的 pinned 条目按 retire 处理（不进任何注入块，报告可见）。
  function readDiaryEntriesForShadow() {
    const out = [];
    const scan = (root, depth) => {
      let entries = [];
      try { entries = fsp.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.isFile() && /^\d{4}-\d{2}-\d{2}(_\d{6})?\.md$/.test(ent.name)) {
          try { out.push({ date: ent.name.slice(0, 10), content: fsp.readFileSync(path.join(root, ent.name), 'utf8') }); } catch (e) {}
        } else if (ent.isDirectory() && depth < 1) {
          scan(path.join(root, ent.name), depth + 1); // 会话子目录收一层
        }
      }
    };
    scan(path.join(baseDir, 'diary'), 0);
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function buildCtxV2ShadowInput(sessionId, llmMessages) {
    const dataDir = path.join(baseDir, 'data');
    let pinnedEntries = [];
    let shadowMap = null;
    try {
      const pinned = fsp.readJsonSync(path.join(dataDir, 'pinned.json'));
      try {
        shadowMap = fsp.readJsonSync(path.join(dataDir, 'context_v2_pinned_map.json')); // fs-extra 第二参是 options，不能传 default
        if (!shadowMap || !Array.isArray(shadowMap.entries)) shadowMap = null;
      } catch (e) { shadowMap = null; }
      const byId = new Map((shadowMap && Array.isArray(shadowMap.entries) ? shadowMap.entries : []).map(e => [e.pinnedId, e.target]));
      pinnedEntries = (Array.isArray(pinned) ? pinned : []).map(p => ({
        id: p && p.id, title: p && p.title, content: p && p.content,
        target: byId.get(p && p.id) || 'retire',
      }));
    } catch (e) {}
    let timeline = [];
    try {
      timeline = (loadTimeline(sessionId) || []).map(m => ({
        role: m && m.role,
        content: typeof (m && m.content) === 'string' ? m.content : '',
      }));
    } catch (e) {}
    let memoriesV2 = [];
    try { memoriesV2 = fsp.readJsonSync(path.join(dataDir, 'memory_v2.json')); } catch (e) {}
    let query = '';
    try {
      for (let i = llmMessages.length - 1; i >= 0; i--) {
        const m = llmMessages[i];
        if (m && m.role === 'user') { query = normalizeContentToText(m.content) || ''; break; }
      }
    } catch (e) {}
    // 记忆浮现清单：本会话已写入时间线的记忆 id，Relevant 检索剥除防重复（0918 拍板）
    let excludeIds = [];
    try {
      excludeIds = ctxV2Shadow.floatIdsForSession(path.join(dataDir, 'context_v2_floated.json'), sessionId);
    } catch (e) {}
    // map 挂在 v2Input 上供 maybeObserve 取 mapVersion（builder 只读已知字段，多余键无害）
    return { pinnedEntries, timeline, diaryEntries: readDiaryEntriesForShadow(), memoriesV2, query, excludeIds, map: shadowMap };
  }

  // Context V2 记忆浮现（0918 拍板）：Relevant 命中（≥0.30）的记忆原样写入时间线永久在场，
  // 断绝「有据回复→支撑消失→编造倾向」的链条。挂 v2_enabled 总闸（正式启用才写，shadow 期只读）。
  // 消息形态：role=developer、content=组装条目同款纯原文、float_id 为内部簿记字段
  //（LLM 清洗自动剥离不进上下文）；hidden=true 前端不显示；压缩抹除清单由 addReplacement 侧负责。
  // 注（2026-09-19 复核）：当前全仓无调用点——记忆浮现尚未接线，上述 v2_enabled 总闸未生效，本函数为预留实现。
  function floatMemoriesToTimeline(sessionId, mems) {
    const list = (Array.isArray(mems) ? mems : []).filter(m => m && m.id && String(m.text || '').trim());
    if (!list.length) return 0;
    appendMessages(sessionId, list.map(m => ({
      role: 'developer',
      content: strSafeEntry(m),
      float_id: m.id,
      hidden: true,
    })), { silent: true });
    ctxV2Shadow.appendFloatIds(path.join(baseDir, 'data', 'context_v2_floated.json'), sessionId, list.map(m => m.id));
    return list.length;

    function strSafeEntry(m) {
      const t = String(m.text || '').trim();
      const d = m.established_at && /^\d{4}-\d{2}-\d{2}/.test(String(m.established_at)) ? String(m.established_at).slice(0, 10) : (m.created_at && /^\d{4}-\d{2}-\d{2}/.test(String(m.created_at)) ? String(m.created_at).slice(0, 10) : null);
      return d ? t + '（' + d + '）' : t;
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
          // kind=diary 是隐藏日记消息（前端不显示），不计入「真实消息」数（2026-09-15）
          const real = arr.filter(m => isRealMessageForTimeline(m) && m.kind !== 'diary');
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
      // 2026-09-13 审查修复：同步清理会话周边文件——此前只删时间线，跨窗口快照/会话配置/
      // 唤醒锁定槽位永久残留，同 id 重建会话会继承旧快照固化的 created_at 导致日记注入边界漂移
      const cleanupTargets = [
        path.join(baseDir, 'cross_snapshot_' + safe + '.json'),
        path.join(baseDir, 'data', 'session_cfg', safe + '.json')
      ];
      let cleaned = 0;
      for (const t of cleanupTargets) {
        try { if (fsp.existsSync(t)) { fsp.removeSync(t); cleaned++; } } catch (e) {}
      }
      try {
        const wakeLockedPath = path.join(baseDir, 'data', 'wake-locked.json');
        if (fsp.existsSync(wakeLockedPath)) {
          const locked = fsp.readJsonSync(wakeLockedPath);
          if (Array.isArray(locked) && locked.includes(safe)) {
            fsp.writeJsonSync(wakeLockedPath, locked.filter(s => s !== safe));
            cleaned++;
          }
        }
      } catch (e) {}
      console.log(`[sessions] 会话 ${safe} 已删除，周边文件清理 ${cleaned} 处`);
      reply.send({ ok: true, deleted: true, cleaned });
    } catch (err) {
      console.error('[DELETE /v1/sessions/:id] error:', err.message);
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
        // role 法（2026-09-15）：developer 块（[唤醒]等）与日记（kind=diary）只落盘不对前端展示
        .filter(m => !(m && (m.role === 'developer' || m.role === 'tool' || m.kind === 'diary')))
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
  // 影子时间线（0918）：后台活动抽屉展示「落盘但前端不显示」的时间线内容——
  // 记忆浮现（float_id）、developer 块、diary、特殊事件等。只读，不影响任何链路。
  app.get('/v1/timeline-hidden', async (req, reply) => {
    try {
      const sessionId = String(req.query.session_id || req.headers['x-session-id'] || '').trim();
      const timeline = loadTimeline(sessionId);
      const items = timeline
        .filter(m => m && !m.deleted)
        .filter(m => m.float_id || m.role === 'developer' || m.kind === 'diary' || (m.role === 'assistant' && m.hidden === true))
        .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
        .map(m => {
          const kind = m.float_id ? 'memory_float' : (m.kind === 'diary' ? 'diary' : (m.role === 'developer' ? 'developer_block' : 'hidden_event'));
          const text = String(typeof m.content === 'string' ? m.content : '').trim();
          return {
            id: m.id || null,
            kind,
            float_id: m.float_id || null,
            time: m.time || null,
            text,
            chars: text.length,
          };
        });
      reply.send({ ok: true, total: items.length, items, session_id: sessionId || 'default' });
    } catch (err) {
      console.error('[GET /v1/timeline-hidden] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  // 跨会话全量搜索：扫描所有会话时间线，混合模式 = 语义分（TF-IDF+bigram 余弦）与关键词命中分五五开合成排序。
  // 语义索引只存两字 bigram，单字/纯符号查询在语义侧必为 0 分，靠关键词腿保底（2026-09-13，替代原 semantic|keyword 二选一）。
  app.get('/v1/search', async (req, reply) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      if (!q) return reply.send({ ok: true, mode: 'hybrid', total: 0, results: [] });
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
          // sidx 口径必须与 /v1/history 的可见序列完全一致（真实消息+推送回显可见；developer/tool/diary 隐藏），
          // 前端按该下标定位跳转（switchSessionAndLocate 索引的就是 history 序列）。
          // 2026-09-15 修复：此前只按 isRealMessageForTimeline 计数，推送回显不入列、v2 日记误入列，
          // 主会话实测 3059 条可搜消息中 2302 条错位（偏差最多 19 条），搜索跳转落在错误消息上。
          arr.filter(m => (isRealMessageForTimeline(m) || (m && !m.deleted && isPushEchoLike(m)))
            && !(m && (m.role === 'developer' || m.role === 'tool' || m.kind === 'diary')))
            .forEach((m, i) => {
              const text = normalizeContentToText(m.content) || '';
              if (!text) return;
              items.push({ sid, sidx: i, name: sid, text });
            });
        }
        searchIndexCache.fp = fp;
        searchIndexCache.items = items;
      }
      // 指纹命中时直接复用已建索引（TF-IDF 建索引是大头，不能每次请求重跑）
      let index = (searchIndexCache.fp === fp) ? searchIndexCache.index : null;
      if (!index) {
        index = buildSemIndex(items);
        searchIndexCache.fp = fp;
        searchIndexCache.index = index;
      }
      const semScores = new Array(items.length).fill(0);
      semanticSearch(index, q, 0.05).forEach(h => { semScores[h.i] = h.score; });
      // 总分 = 语义 50% + 关键词 50%（关键词命中=1 否则 0）；任一腿有分即入结果，按总分降序
      const results = [];
      items.forEach((it, i) => {
        const kw = it.text.toLowerCase().includes(ql) ? 1 : 0;
        const score = 0.5 * semScores[i] + 0.5 * kw;
        if (score > 0) results.push({ sid: it.sid, sidx: it.sidx, name: it.name, text: it.text, score });
      });
      results.sort((a, b) => b.score - a.score);
      reply.send({ ok: true, mode: 'hybrid', total: results.length, results: results.slice(0, limit) });
    } catch (err) {
      console.error('[GET /v1/search] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  // 已保存主题跨设备同步（存 data/saved-themes.json）
  const SAVED_THEMES_FILE = path.join(baseDir, 'data', 'saved-themes.json');
  app.get('/v1/themes', async (req, reply) => {
    try {
      let data = { themes: [], current: '' };
      try { if (fsp.existsSync(SAVED_THEMES_FILE)) { const raw = JSON.parse(fsp.readFileSync(SAVED_THEMES_FILE, 'utf-8')) || []; if (Array.isArray(raw)) data = { themes: raw, current: '' }; else if (typeof raw === 'object' && Array.isArray(raw.themes)) data = { themes: raw.themes, current: String(raw.current || '') }; } } catch (e) {}
      if (!Array.isArray(data.themes)) data.themes = [];
      reply.send({ ok: true, themes: data.themes, current: data.current });
    } catch (err) {
      console.error('[GET /v1/themes] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });
  app.put('/v1/themes', async (req, reply) => {
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const themes = Array.isArray(body.themes) ? body.themes : [];
      const clean = themes.filter(t => t && typeof t === 'object').slice(0, 100);
      const current = (typeof body.current === 'string') ? body.current : '';
      let existingThemes = [];
      try { if (fsp.existsSync(SAVED_THEMES_FILE)) { const raw = JSON.parse(fsp.readFileSync(SAVED_THEMES_FILE, 'utf-8')) || []; existingThemes = Array.isArray(raw) ? raw : (raw.themes || []); } } catch (e) {}
      if (!Array.isArray(existingThemes)) existingThemes = [];
      // 防止空覆盖：服务器已有主题却收到空数组时保留原数据，除非显式 replace
      if (clean.length === 0 && existingThemes.length > 0 && !body.replace) {
        reply.send({ ok: true, saved: false, skipped: 'empty', count: existingThemes.length });
        return;
      }
      fsp.ensureDirSync(path.join(baseDir, 'data'));
      fsp.writeFileSync(SAVED_THEMES_FILE, JSON.stringify({ current: current, themes: clean }, null, 2), 'utf-8');
      reply.send({ ok: true, saved: true, count: clean.length, current: current });
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

    // 防误伤：携带真实消息(或首次建线)才写时间线。时间线已是追加式增量写、不再全量覆盖历史，
    // 故放宽原先「必须 x-client=dylan-chat 才写」的门槛——第三方客户端(如 Kelivo)不带该头
    // 且已带上真实消息，也能正常写入，供自建前端(chat.html)看到。
    if (kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0) {
      // 方案二增量：落盘改为以盘上为基同步差量（新消息补齐/人设同步/重生成清尾），
      // 不再拿请求全量重建覆盖；通知由同步函数按需发出。
      appendRequestMessages(sessionId, kelivoMessages);
    } else {
      console.log("[timeline] 跳过时间线保存 (真实消息=" + kelivoMessages.some(isRealMessageForTimeline) + ")");
    }

    // 非主聊天（标题总结等旁路请求）的直通底稿；主聊天在下方由统一对话构建器重建覆盖
    let llmMessages = kelivoMessages
      .map(prepareMessageForLLM)
      .filter(Boolean);
    // 主聊天（客户端携带 system 身份提示）才做记忆/跨窗口/特殊事件注入；标题总结等旁路请求保持精简。
    // 2026-09-15 上传瘦身配套：x-client=dylan-chat（自建前端）本身就是主聊天信号——
    // 即使未配置人设（请求里无 system），聊天页请求也要走时间线重建，否则窗口化上传会变成上下文本身。
    const isMainChat = isClientChat || kelivoMessages.some(function (m) {
      if (!m) return false;
      if (m.role === "system") return true;
      if (m.role === "user" && typeof m.content === "string" && m.content.trim().indexOf("<system>") === 0) return true;
      return false;
    });

    // ========================
    // 消息扣住（免打扰）：扣住时段内新用户消息待处理，不转发给模型。
    // 设计口径：<quiet> 调度按会话隔离——扣住的是「AI 写入该标签的会话」自己的消息，
    // 其他会话不受影响；释放流程也只针对该会话。
    // ========================
    if (isQuietActive(sessionId)) {
      const trailing = collectTrailingUnansweredUserMessages(kelivoMessages);
      if (trailing.length > 0) {
        const newest = normalizeContentToText(trailing[trailing.length - 1].content) || "";
        const urgent = /紧急|急事|加急|急用|很急|马上回/.test(newest);
        if (urgent) {
          console.log("[quiet] 检测到紧急关键词，本次放行");
        } else {
          const addedHeld = holdNewUserMessages(trailing, sessionId);
          console.log(`[quiet] 扣住 ${addedHeld} 条新用户消息，本次不转发给模型`);
          // 批注 2026-09-13（审查 B4）：按请求的 stream 参数返回 SSE 或普通 JSON
          return buildQuietHeldReply(reply, body?.stream === true);
        }
      }
    }

    // ========================
    // 统一对话构建器（2026-09-15 批3核心）：聊天与唤醒同源同前缀。
    // 服务端从时间线重建上下文（role 法全量：日记/历史[唤醒]块/工具记录齐全）；
    // 客户端窗口仅用于上方增量同步（appendRequestMessages），不再作为上下文底稿。
    // 非主聊天（标题总结等旁路请求）保持客户端直通，不注入完整上下文。
    // ========================
    if (isMainChat) {
      llmMessages = buildConversation(sessionId);
      // ---- Context V2 Shadow 观察（C10 S2-B1，2026-09-17）：只记录不改变生产回答 ----
      // ctx_v2_shadow=false（memory_v2_config.json）时零行为差异；shadow 全程只读 llmMessages，
      // maybeObserve 内部 try/catch，任何失败只记 error 不影响主聊天。
      try {
        const shadowCfg = await fsp.readJson(path.join(baseDir, 'data', 'memory_v2_config.json')).catch(() => ({}));
        if (shadowCfg && shadowCfg.ctx_v2_shadow === true) {
          ctxV2Shadow.maybeObserve({
            flag: true,
            sessionId,
            oldMessages: llmMessages,
            v2Input: buildCtxV2ShadowInput(sessionId, llmMessages),
            file: ctxV2Shadow.buildShadowPath(path.join(baseDir, 'data', 'context_shadow'), new Date()),
          });
        }
      } catch (e) { console.error('[ctx-v2-shadow] 接线层失败（不影响主聊天）:', e && e.message); }
    }

    // 内容->时间 映射：容量提醒建议段反查时间用。2026-09-15 上传瘦身配套：改从服务端时间线构建
    // （此前按客户端全量请求构建，窗口化后老消息的时间锚会丢；与唤醒侧同口径）。
    const timeByKey = new Map();
    try {
      for (const tm of loadTimeline(sessionId)) {
        if (!tm || tm.role === "system" || isSpecialEvent(tm)) continue;
        const key = tm.role + "\u0000" + normalizeContentToText(tm.content);
        if (timeByKey.has(key)) continue;
        const t = extractTimestampWithMemory(tm);
        if (t) timeByKey.set(key, t);
      }
    } catch (e) { /* 反查表失败不阻断，提醒退化为无时间锚 */ }



    console.log(JSON.stringify({
      event: "llm_forward_summary",
      messages: summarizeMessagesForLog(llmMessages)
    }));

    // ---- 自动修复不完整的 tool 调用（双向清理，实现搬至 chat-context.js）----
    llmMessages = chatCtx.repairToolCallPairs(llmMessages);

    // 统一模型解析（2026-09-08）：会话级设置 → 全局默认供应商 → env 兜底，与 MCP 路径同一口径
    const { provider: prov, model: resolvedModel } = deps.resolveChatModel(sessionId, body.model);
    if (resolvedModel) body.model = resolvedModel;
    const targetApiUrl = (prov && (prov.api_url || prov.base_url)) || readEnvValue("TARGET_API_URL");
    const targetApiKey = (prov && prov.api_key) || readEnvValue("TARGET_API_KEY");
    if (!targetApiUrl || !targetApiKey) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 或 AI 供应商未配置" });
    }

    const requestedStream = body?.stream === true;

    // [永久上下文]/[跨窗口] developer 头部块已由统一对话构建器注入（buildConversation），此处不再重复。

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
    ctxLimitGuard(llmMessages, sessionId, timeByKey);

    // 上下文压缩已统一进「上下文替换」：早期对话块摘要与 AI 记忆现在都是同一种替换记录，
    // 由 contextReplacements.applyReplacements 统一生效，旧压缩器发送路径已停用。

    // 工具调用记录回灌转换：把历史里 assistant 形态的「【工具调用记录】」还原成
    // role=tool 消息组（带工具名/调用时间/状态标头），模型明确知道来源，不混入普通对话流。
    // 必须在 applyReplacements 之后（压缩块匹配仍按 assistant 文本形态），转发前生效。
    llmMessages = chatCtx.convertToolNotesToToolRole(llmMessages);

    // 转发前只保留 OpenAI 兼容字段，剥离 Kelivo 自定义字段（position 等）
    const sanitizedMessages = chatCtx.sanitizeForUpstream(llmMessages);

    // role 出口映射（2026-09-15）：内部 developer 块按供应商 profile 翻译后再发上游
    // （default：developer→system；claude：并顶层 system+tool 裹 user；gemini：assistant→model）。
    const providerProfile = (prov && prov.profile) || 'default';
    const outboundMessages = mapMessagesForProvider(providerProfile, sanitizedMessages);

    // 捕获发给 LLM 的完整上下文（管理台日志页可查看；= 真正发出的映射后消息）
    if (isMainChat) {
      setLastLLMCapture(outboundMessages.map(m => {
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

    // 2026-09-08 图片 URL 统一补全：前端把消息图片转存为 /uploads/<file>（避免大 base64 撑爆 localStorage），
    // 上游 deepseek 只认 https:// 绝对 URL（相对路径/base64/http 均被拒），故发模型前经 imageAbsUrl
    // 统一补齐请求来源的 http(s)://<host> 前缀（公网强制 https；已是绝对/dataURL 的自动保留）。
    try {
      const _imgFill = (msg) => {
        const c = msg && msg.content;
        if (!Array.isArray(c)) return;
        for (const part of c) {
          if (part && part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") {
            part.image_url.url = imageAbsUrl(req, part.image_url.url);
          }
          if (part && part.type === "file" && part.file && typeof part.file.url === "string") {
            part.file.url = imageAbsUrl(req, part.file.url);
          }
        }
      };
      for (const _m of outboundMessages) _imgFill(_m);
      // 历史遗留：content 可能是字符串里内嵌 data:image（极少数），这里不动——字符串型图片上游走 base64 由上游判断
    } catch (_e) { console.warn("[chat] 图片URL补全忽略:", _e.message); }

    // === MCP_TOOL_LOOP_BEGIN ===
    // MCP 工具循环：启用时若为主聊天，走 MCP 分支（工具轮次非流式，最终流式回传）
    // 这里传入已处理好的 sanitizedMessages，完整保留记忆/时间线/替换/裁剪上下文
    if (MCP_ENABLED()) {
      try {
        // 登记当前聊天会话：AI 在工具循环里调 context_replace 时，工具服务器回调
        // /internal/apply 是独立请求（ALS 已丢），靠这个登记把块记到正确会话
        contextReplacements.noteMcpChatSession(sessionId);
        if (await handleMcpRequest(body, reply, req, outboundMessages, sessionId, kelivoMessages)) return;
      } catch (mcpErr) {
        console.warn("[mcp] 工具循环失败，回退原逻辑:", mcpErr.message, "| session:", sessionId, "| msgs:", Array.isArray(sanitizedMessages) ? sanitizedMessages.length : -1, "| model:", (body && body.model) || "");
      }
    }
    // === MCP_TOOL_LOOP_END ===
    // 上游请求超时保护，避免上游挂起导致 /v1 请求永久阻塞
    let upstreamController = new AbortController();
    let upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    let response;
    try {
      const doFetch = () => fetch(targetApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${targetApiKey}`
        },
        body: JSON.stringify({ ...body, messages: outboundMessages }),
        signal: upstreamController.signal
      });
      response = await doFetch();
      // 图片 400 优雅降级（2026-09-15）：上游拉不到本轮新图（CDN 拦截供应商爬虫/文件失效）会整包 400，
      // 此前用户只能看到报错。这里把消息里的图片换成占位文本重试一次，保证回复仍能生成。
      // 用 clone() 探测错误体：非图片原因不降级时，原响应体保持可读、照常透传给客户端。
      if (response.status === 400) {
        const errText = await response.clone().text().catch(() => "");
        if (/failed to download image/i.test(errText)) {
          let degraded = false;
          for (const m of outboundMessages) {
            if (!Array.isArray(m.content)) continue;
            for (let pi = 0; pi < m.content.length; pi++) {
              const p = m.content[pi];
              if (p && p.type === "image_url") {
                m.content[pi] = { type: "text", text: "（图片暂时无法读取，本轮已省略）" };
                degraded = true;
              }
            }
          }
          if (degraded) {
            console.warn("[chat] 上游拉取图片失败(400)，本轮图片换占位后重试一次");
            clearTimeout(upstreamTimer);
            upstreamController = new AbortController();
            upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
            response = await doFetch();
          }
        }
      }
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
          parseQuietTagAndSchedule(aiContent, sessionId);
          // 提取并存储记忆，同时拿到清洗后的文本
          const cleanText = await tagParser.extractAndStore(aiContent, { sessionId });
          // 用清洗后的文本替换 JSON 中的 content
          if (cleanText !== aiContent) {
            parsed.choices[0].message.content = cleanText;
            finalResponseText = JSON.stringify(parsed);
          }
          // 方案二增量：回复只追加一条；盘尾已有同内容回复（重试/重发）则跳过，不重复写。
          // 存储用原始含标签文本（<wake>/<memory> 等是上下文一部分，模型可见、前端显示时剥、编辑框可见）。
          if ((kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0)) {
            // 2026-09-16 [DIARY]：AI 在回复中写日记 → 存日记文件 + 时间线追加隐藏日记消息（带标签），可见回复剥掉日记块
            const diaryResult = diaryLib.extractDiaryFromResponse(aiContent);
            const visibleContent = diaryResult.diaryContent ? diaryResult.remainingText : aiContent;
            if (!tailHasReply(sessionId, visibleContent)) {
              const toAppend = [];
              if (diaryResult.diaryContent) {
                diaryLib.appendDiaryEntry(diaryResult.diaryContent, sessionId);
                toAppend.push({ role: "assistant", content: diaryLib.wrapDiaryTag(diaryResult.diaryContent), kind: "diary" });
              }
              if (visibleContent) {
                // 与流式路径同口径落富字段（2026-09-15：此前非流式丢思考链/token，刷新后不一致）
                toAppend.push({ role: "assistant", content: visibleContent, reasoning: aiThinking || "", tokens: (parsed && parsed.usage) || null });
              }
              if (toAppend.length) appendMessages(sessionId, toAppend);
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
    // 2026-09-08：不再累积上游原始字节数组（长回复会双份内存），改为流内累积解码后的 SSE 全文，供流结束提取 AI 回复/记忆标签。
    let fullRawSse = "";
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
      const decodedChunk = sseDecoder.decode(value, { stream: true });
      sseBuffer += decodedChunk;
      fullRawSse += decodedChunk;
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
      // 2026-09-13 审查修复：不再 rethrow——rethrow 会跳过下方的落盘块（已生成的部分回复
      // 不落盘，刷新即丢），且外层 catch 会对已发头的响应二次 send。中断后仍走落盘块，
      // 把已收到的部分回复存档（tailHasReply 保证重试时不重复写）。
      console.warn("[stream] 流式中断（客户端断开/上游异常）:", streamErr.message);
      try { reply.raw.end(); } catch {}
    } finally {
      clearTimeout(upstreamTimer);
    }

    // 流结束后解析 AI 回复
    try {
      const fullText = fullRawSse;
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
        parseQuietTagAndSchedule(aiFullContent, sessionId);
        // 提取并存储记忆，并拿到清洗后的文本
        const cleanFull = await tagParser.extractAndStore(aiFullContent, { sessionId }).catch(err => {
          console.warn("[memory] 流式标签解析失败:", err.message);
          return aiFullContent;
        });
        // 方案二增量：回复只追加一条（富字段 reasoning/tokens 一并落，跨设备刷新不丢）；
        // 盘尾已有同内容回复（重试/重发）则跳过，不重复写。
        // 存储用原始含标签文本（模型可见、前端显示时剥、编辑框可见）。
        if ((kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0)) {
          // 2026-09-16 [DIARY]：同非流式，AI 回复中的日记块 → 日记文件 + 隐藏日记消息（带标签），可见回复剥掉日记块
          const diaryResult = diaryLib.extractDiaryFromResponse(aiFullContent);
          const visibleContent = diaryResult.diaryContent ? diaryResult.remainingText : aiFullContent;
          if (!tailHasReply(sessionId, visibleContent)) {
            const toAppend = [];
            if (diaryResult.diaryContent) {
              diaryLib.appendDiaryEntry(diaryResult.diaryContent, sessionId);
              toAppend.push({ role: "assistant", content: diaryLib.wrapDiaryTag(diaryResult.diaryContent), kind: "diary" });
            }
            if (visibleContent) {
              // 方案二增量：回复只追加一条（富字段 reasoning/tokens 一并落，跨设备刷新不丢）
              toAppend.push({ role: "assistant", content: visibleContent, reasoning: aiThinking || "", tokens: aiUsage || null });
            }
            if (toAppend.length) appendMessages(sessionId, toAppend);
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
