'use strict';
// 从 server.js 拆出的 /v1/* 路由(models/sessions/history/events/timeline-sync + chat/completions)。
// 依赖注入：server.js 里用到的函数经 deps 传入；baseDir = 项目根目录。
// 鉴权沿用 server.js 的全局 addHook，不需要在此重复。
const path = require('path');
const fsp = require('fs-extra');
const mcp = require('../mcp-tool-loop');
const tagParser = require('../tag-parser');
const wakeSchedule = require('../lib/wake-schedule');
const contextReplacements = require('../context-replacements');
const upstreamAlert = require('../lib/upstream-alert'); // 2026-09-28 上游 402（余额不足）提醒
const contextCompactor = require('../context-compactor');
const { imageAbsUrl } = require('./imgurl');
const { formatDateTimeInTimeZone } = require('../time_utils');
const { parsePushEcho, parseWakeEcho } = require('../utils/push');
// 对话侧/唤醒侧共用上下文加工函数（2026-09-15 唤醒并入网关）
const chatCtx = require('./chat-context');
const ctxV2Runtime = require('../context-v2-runtime'); // Context V2 共享运行时（0920 完全统一：聊天唤醒同一组装入口）
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
    readSessionArchive,
    tailHasReply,
    markSessionDeleted,
    sseSubscribe,
    sseUnsubscribe,
    sseNotify,
    SSE_HEARTBEAT_MS,
    recentReplies,
    activeGenMap,
    ACTIVE_GEN_TTL_MS,
    isRecentReplyCacheable,
    IDEMPOTENCY_TTL_MS,
    IDEMPOTENCY_PENDING_WAIT_MS,
    IDEMPOTENCY_PENDING_TOTAL_MS,
    setRecentReply,
    beginPendingReply,
    waitPendingReply,
    clearPendingReply,
    sessionCrossInjectOverride,
    saveSessionCrossInjectOverride,
    prepareMessageForLLM,
    normalizeContentToText,
    isSpecialEvent,
    extractTimestampWithMemory,
    stripPosition,
    resolveChatModel,
    resolveSessionSystemPrompt,
    sessionModelProviderOverride,
    saveSessionModelProviderOverride,
    readEnvValue,
    UPSTREAM_TIMEOUT_MS,
    handleMcpRequest,
    splitMultimodalContent,
    extractAssistantThinking,
    parseWakeTagAndSchedule,
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
    stripPosition,
    resolveSessionSystemPrompt,
    loadSnapshot: (sid) => require("../context-snapshot").loadSnapshot(baseDir, sid),   // 1002-11 注入前缀快照
    incrementalContext: contextReplacements.buildIncrementalContext,   // 0929 增量：块摘要化+尾部现算
    fullCache: false   // 0929 聊天只走增量；整体缓存留给唤醒/重试（fp 不变场景）
  });

  // 日记共享模块（2026-09-16）：日常聊天 [DIARY] 提取与保存（与唤醒共用 lib/diary.js）
  const diaryLib = require('../lib/diary')({ baseDir, readEnvValue });

  // （Context V2 输入组装 assembleInput 由 server.js /admin/cross-window-inject 预览接口直接调用；
  //   Shadow 观察分支已随 S3 观察期结束退役，2026-09-28。）

  // S4 的换块（applyContextV2）与记忆浮现写入（floatMemoriesToTimeline）已于 0920 上移到
  // context-v2-runtime 共享运行时（与唤醒侧完全统一，同一 assembleAndApply 入口），此处不再保留本地副本。

  app.get('/v1/models', async (req, reply) => {
    reply.send({
      object: 'list',
      data: [{ id: configuredModelName(), object: 'model', created: 0, owned_by: 'gateway' }]
    });
  });

  // 多会话列表：扫描本目录下所有 enhanced_messages*.json，返回会话摘要（命中缓存只 stat 不重读）
  app.get('/v1/sessions', async (req, reply) => {
    try {
      // 0929-30：一次性读人设映射+备份名+全局模型，循环内查表，避免每会话重复读文件
      let spMap = {};
      try { const _j = JSON.parse(fs.readFileSync(path.join(baseDir, 'data', 'session-prompts.json'), 'utf-8')); if (_j && typeof _j === 'object') spMap = _j; } catch (e) {}
      let pbList = [];
      try { const _a = JSON.parse(fs.readFileSync(path.join(baseDir, 'data', 'prompt-backups.json'), 'utf-8')); if (Array.isArray(_a)) pbList = _a; } catch (e) {}
      const pbNameOf = function (bid) { const h = pbList.find(b => b && b.id === bid); return (h && h.name) ? h.name : ''; };
      let globalModel = '';
      try { globalModel = readEnvValue ? (readEnvValue('MODEL_NAME') || 'gateway-model') : 'gateway-model'; } catch (e) { globalModel = 'gateway-model'; }
      const files = fsp.readdirSync(baseDir).filter(f => /^enhanced_messages[_-][A-Za-z0-9_-]+\.json$/.test(f));
      const sessions = [];
      const seen = new Set();
      const archiveSet = new Set((typeof readSessionArchive === "function" ? readSessionArchive() : []));
      for (const f of files) {
        const sid = f.replace(/^enhanced_messages_/, '').replace(/\.json$/, '');
        if (!sid || sid === 'default') continue;
        seen.add(sid);
        try {
          const filePath = path.join(baseDir, f);
          const st = fsp.statSync(filePath);
          const cached = sessionMetaCache.get(sid);
          if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            let cPersona = '', cModel = '';
            const cBid = spMap[sid]; if (cBid) cPersona = pbNameOf(cBid);
            try { cModel = (deps.sessionModelNameOverride ? (deps.sessionModelNameOverride(sid) || '') : ''); } catch (e) { cModel = ''; }  // 0929-30: 无 override 返回空，前端显示「默认」
            sessions.push({ id: sid, name: sid, total: cached.total, real: cached.real, last_time: cached.last_time, is_default: false, archived: archiveSet.has(sid), persona_name: cPersona, model_name: cModel });
            continue;
          }
          const arr = loadTimeline(sid);
          // kind=diary 是隐藏日记消息（前端不显示），不计入「真实消息」数（2026-09-15）
          const real = arr.filter(m => isRealMessageForTimeline(m) && m.kind !== 'diary');
          const meta = { mtimeMs: st.mtimeMs, size: st.size, total: arr.length, real: real.length, last_time: (arr[arr.length - 1] && arr[arr.length - 1].time) || null };
          sessionMetaCache.set(sid, meta);
          let persona = '', modelN = '';
          const bid = spMap[sid]; if (bid) persona = pbNameOf(bid);
          try { modelN = (deps.sessionModelNameOverride ? (deps.sessionModelNameOverride(sid) || '') : ''); } catch (e) { modelN = ''; }  // 0929-30: 无 override 返回空，前端显示「默认」
          sessions.push({ id: sid, name: sid, total: meta.total, real: meta.real, last_time: meta.last_time, is_default: false, archived: archiveSet.has(sid), persona_name: persona, model_name: modelN });
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
      // 删除墓碑（2026-09-20 审查 F-3）。2026-09-22 审查 M10：必须**先立墓碑、再删文件**——
      // 原顺序是「removeSync → 清理周边 → 最后才写墓碑」，中间的窗口里迟到的写入
      // （生成中回复收尾/唤醒事件等）因「文件不存在且无墓碑」被 saveTimeline 放行，
      // 已删会话会以「空时间线+新消息」的残骸文件复活。墓碑守卫条件是「文件不存在 + 墓碑期内」，
      // 故先立墓碑即关闭该窗口。记录删除时刻，24h 内迟到写入被拒；过期自动失效，同 id 重建不受影响。
      try { if (typeof markSessionDeleted === 'function') markSessionDeleted(safe); } catch (e) {}
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
      // 1002-12：会话删除时注入前缀快照条目一并清除（防同 id 重建继承旧快照）
      try {
        const sr = require('../context-snapshot').deleteSnapshot(baseDir, safe);
        if (sr.existed) cleaned++;
      } catch (e) {}
      console.log(`[sessions] 会话 ${safe} 已删除，周边文件清理 ${cleaned} 处`);
      reply.send({ ok: true, deleted: true, cleaned });
    } catch (err) {
      console.error('[DELETE /v1/sessions/:id] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 只读返回时间线（供自建聊天前端拉取历史；剥离内部 position 字段，保留 role/content/time）。
  // 2026-09-29 前端"纯显示器"分页：
  //   GET /v1/history?session_id=X                     → 全量（旧客户端/导出兼容）
  //   GET /v1/history?session_id=X&mode=tail[&limit=N] → 尾部窗口：从"最后一块摘要结尾"起（未压缩原文），
  //                                                      响应带 tail_start_id（前端渲染起点，稳定；新压缩块
  //                                                      出现时联动变化）+ has_more（起点前还有更早原文）
  //   GET /v1/history?session_id=X&before=<id>&limit=N → 更早窗口：before 为当前窗口最早消息 id，
  //                                                      返回其前 N 条原文（含压缩区间原文）
  // 1004-05：进行中生成快照查询——前端断流/切回前台后轮询这里续显，不用刷新
  app.get('/v1/chat/status', async (req, reply) => {
    try {
      if ((req.headers['x-client'] || '').trim() !== 'dylan-chat') return reply.code(403).send({ error: 'forbidden' });
      const sessionId = String(req.query.session_id || '').trim();
      if (!sessionId) return reply.send({ active: false, done: true });
      const ag = activeGenMap.get(sessionId);
      if (!ag) return reply.send({ active: false, done: true });
      if (ag.done && Date.now() - ag.ts > ACTIVE_GEN_TTL_MS) { activeGenMap.delete(sessionId); return reply.send({ active: false, done: true }); }
      return reply.send({ active: !ag.done, done: ag.done, text: ag.text || "", reasoning: ag.reasoning || "", tools: ag.tools || [], ts: ag.ts });
    } catch (e) { return reply.send({ active: false, done: true }); }
  });

  app.get('/v1/history', async (req, reply) => {
    try {
      const sessionId = String(req.query.session_id || req.headers['x-session-id'] || '').trim();
      const timeline = loadTimeline(sessionId);
      // 稳定 id 迁移：老数据无 id，首次被 history 读到就补 uuid 并写回（前端据此做 diff 编辑/删除）。
      let needWrite = false;
      for (const m of timeline) { if (m && !m.id) { m.id = (require('crypto').randomUUID) ? require('crypto').randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2); needWrite = true; } }
      if (needWrite) saveTimeline(timeline, sessionId);
      const fullItems = timeline
        .filter(m => isRealMessageForTimeline(m) || (m && !m.deleted && isPushEchoLike(m)))
        // role 法（2026-09-15）：developer 块（[唤醒]等）与日记（kind=diary）只落盘不对前端展示
        .filter(m => !(m && (m.role === 'developer' || m.role === 'tool' || m.kind === 'diary' || m.kind === 'noaction')))
        .map(m => {
          const clean = { role: m.role };
          if (m.id !== undefined) clean.id = m.id;
          if (m.content !== undefined) {
            // 1005：落盘保留原始含[DIARY]文本，下发前端时剥掉日记块（kind:diary 消息已在上面过滤掉）
            const _dr = diaryLib.extractDiaryFromResponse(m.content);
            clean.content = _dr.diaryContent ? _dr.remainingText : m.content;
          }
          if (m.time) clean.time = m.time;
          if (m.reasoning !== undefined) clean.reasoning = m.reasoning;
          if (m.tools !== undefined) clean.tools = m.tools;
          if (m.segments !== undefined) clean.segments = m.segments;
          // 2026-09-24 B3 探针发现：9-23 落盘加了 stream_timeline，但本接口白名单漏同步——
          // 前端刷新后一直收不到服务端这份真实时间线（靠 localStorage 自存补回）。补上。
          if (m.stream_timeline !== undefined) clean.stream_timeline = m.stream_timeline;
          if (m.tokens !== undefined) clean.tokens = m.tokens;
          return clean;
        });
      const mode = String(req.query.mode || '');
      if (mode === 'tail' || req.query.before !== undefined) {
        const limit = req.query.limit !== undefined ? Math.min(Math.max(1, Number(req.query.limit) || 1), 500) : null;
        const cs = contextReplacements.computeTailStart(sessionId, timeline);
        // 渲染起点 = tailIndex 起第一条可见消息的 id（tailIndex 可能指向 developer/tool 等被过滤消息，向后找）
        let tailId = null;
        if (cs.tailIndex < timeline.length) {
          const visibleIds = new Set();
          for (const m of fullItems) { if (m && m.id) visibleIds.add(m.id); }
          for (let i = cs.tailIndex; i < timeline.length; i++) {
            const m = timeline[i];
            if (m && m.id && visibleIds.has(m.id)) { tailId = m.id; break; }
          }
        }
        if (req.query.before !== undefined) {
          // 更早窗口：before 消息之前的 limit 条
          const beforeId = String(req.query.before || '');
          const pos = fullItems.findIndex(m => m && m.id === beforeId);
          const lim = limit || 100;
          if (pos < 0) {
            return reply.send({ ok: true, total: fullItems.length, tail_start_id: tailId, has_more: false, items: [], session_id: sessionId || 'default' });
          }
          const start = Math.max(0, pos - lim);
          const win = fullItems.slice(start, pos);
          return reply.send({ ok: true, total: fullItems.length, tail_start_id: tailId, has_more: start > 0, items: win, session_id: sessionId || 'default' });
        }
        // mode=tail：从起点返回（limit 缺省 → 起点后全部，供 SSE 整段替换）
        const startIdx = tailId ? fullItems.findIndex(m => m && m.id === tailId) : fullItems.length;
        if (startIdx < 0) {
          return reply.send({ ok: true, total: fullItems.length, tail_start_id: tailId, has_more: false, items: [], session_id: sessionId || 'default' });
        }
        const win = limit ? fullItems.slice(startIdx, startIdx + limit) : fullItems.slice(startIdx);
        if (!win.length && startIdx >= fullItems.length) {
          // 2026-09-29：会话全部被压缩（无未压缩尾部原文）→ 从压缩块尾部起始点回退固定拉最后 limit 条原文，
          // 前端点进去至少有最近 100 条可见；tail_start_id 设为这批第一条，向上翻页继续拉更早。
          const back = Math.max(0, fullItems.length - (limit || 100));
          const winBack = fullItems.slice(back);
          return reply.send({ ok: true, total: fullItems.length, tail_start_id: winBack.length ? winBack[0].id : null, has_more: back > 0, items: winBack, session_id: sessionId || 'default' });
        }
        return reply.send({ ok: true, total: fullItems.length, tail_start_id: tailId, has_more: startIdx > 0, items: win, session_id: sessionId || 'default' });
      }
      reply.send({ ok: true, total: fullItems.length, items: fullItems, session_id: sessionId || 'default' });
    } catch (err) {
      console.error('[GET /v1/history] error:', err.message);
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
            && !(m && (m.role === 'developer' || m.role === 'tool' || m.kind === 'diary' || m.kind === 'noaction')))
            .forEach((m, i) => {
              const text = normalizeContentToText(m.content) || '';
              if (!text) return;
              items.push({ sid, sidx: i, name: sid, text });
            });
        }
        searchIndexCache.fp = fp;
        searchIndexCache.items = items;
        // 2026-09-30 V1 修复：items 重建后旧 index 的 h.i 下标全部失效，必须随之作废——
        // 否则下方指纹判断恒命中（fp 刚被置成当前值），旧索引被永久复用：新消息不进语义腿、语义分挂错消息。
        searchIndexCache.index = null;
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
  // 2026-09-21 审查清理：GET/PUT /v1/themes（主题云同步）已删除——chat.html 重构后全文件
  // 零调用，两端均无消费者。历史数据 data/saved-themes.json（9 个主题）保留在盘，git 可恢复本接口。
  // 系统提示词备份跨设备同步（存 data/prompt-backups.json）
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
      const now = new Date().toISOString();
      const norm = function (b) {
        if (!b || typeof b !== 'object' || typeof b.content !== 'string') return null;
        return {
          id: String(b.id || '').slice(0, 64) || ('pb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
          name: String(b.name || '未命名').slice(0, 60),
          content: b.content,
          createdAt: String(b.createdAt || now).slice(0, 40),
          updatedAt: String(b.updatedAt || now).slice(0, 40)
        };
      };
      let existing = [];
      try { if (fsp.existsSync(PROMPT_BACKUPS_FILE)) existing = JSON.parse(fsp.readFileSync(PROMPT_BACKUPS_FILE, 'utf-8')) || []; } catch (e) {}
      if (!Array.isArray(existing)) existing = [];
      // 新格式（2026-09-26 多端合并）：{ upserts: [备份...], delIds: [id...] } 按 id 合并，不做整表覆盖。
      // delIds 删除时同步清理 session-prompts.json 中引用该备份的会话键，避免悬挂引用导致静默回退全局。
      if (Array.isArray(body.upserts) || Array.isArray(body.delIds)) {
        const upserts = (Array.isArray(body.upserts) ? body.upserts : []).map(norm).filter(Boolean);
        const delIds = (Array.isArray(body.delIds) ? body.delIds : []).filter(id => typeof id === 'string' && id);
        for (const b of upserts) {
          const idx = existing.findIndex(x => x && x.id === b.id);
          if (idx >= 0) existing[idx] = b; else existing.push(b);
        }
        if (delIds.length) {
          existing = existing.filter(x => delIds.indexOf(x && x.id) < 0);
          const spFile = path.join(baseDir, 'data', 'session-prompts.json');
          try {
            if (fsp.existsSync(spFile)) {
              const sp = JSON.parse(fsp.readFileSync(spFile, 'utf-8')) || {};
              let changed = false;
              for (const k of Object.keys(sp)) { if (delIds.indexOf(sp[k]) >= 0) { delete sp[k]; changed = true; } }
              if (changed) fsp.writeFileSync(spFile, JSON.stringify(sp, null, 2), 'utf-8');
            }
          } catch (e) { console.warn('[prompt-backups] 清理会话引用失败:', e.message); }
        }
        existing = existing.slice(0, 50);
        fsp.writeFileSync(PROMPT_BACKUPS_FILE, JSON.stringify(existing, null, 2), 'utf-8');
        reply.send({ ok: true, saved: true, count: existing.length });
        return;
      }
      // 旧格式整表（兼容旧缓存页面）
      const clean = (Array.isArray(body.backups) ? body.backups : []).map(norm).filter(Boolean);
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
  // 重建会话注入前缀快照（1002-12）：清除该会话快照条目，下一轮请求按当前人设/记忆/日记重新生成
  app.post('/v1/sessions/:id/snapshot/rebuild', async (req, reply) => {
    try {
      const sessionId = String(req.params.id || '').trim();
      if (!sessionId || sessionId === 'default') return reply.code(400).send({ error: '主会话不需要重建快照' });
      const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
      if (safe !== sessionId) return reply.code(400).send({ error: '非法会话ID' });
      const r = require('../context-snapshot').deleteSnapshot(baseDir, safe);
      reply.send({ ok: true, session_id: safe, existed: r.existed });
    } catch (err) {
      console.error('[POST /v1/sessions/:id/snapshot/rebuild] error:', err.message);
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
      // 2026-09-21 审查 H13：心跳写失败除停心跳外还要摘除订阅，否则死连接滞留 sseSubscribers
      try { reply.raw.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); sseUnsubscribe(sessionId, reply); }
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
      // 旧整份分支（老前端/退化场景）：改「以盘上为基同步请求差量」（2026-09-20 审查 F-2）——
      // 此前整份 buildTimeline 重建会把「客户端列表里没有的服务器新写入」（他端新消息/唤醒事件）
      // 物理删除。appendRequestMessages 语义=人设同步+按 id 去重补齐+重生成清尾：盘上已有的跳过、
      // 缺的补齐；仅请求尾是 user（重生成）才清尾。中部删除不再支持走此分支（diff 分支按 id 定点
      // 删除不受影响）；空 messages 不再把时间线清空。变更时 appendRequestMessages 内部已 sseNotify。
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const syncRes = appendRequestMessages(sessionId, messages);
      const afterTl = loadTimeline(sessionId);
      console.log(`[timeline-sync] 旧整份分支改差量同步 (session=${sessionId || 'default'}, 补齐=${syncRes.appended}, 清尾=${syncRes.removedTail}, 总条数=${afterTl.length})`);
      reply.send({ ok: true, total: afterTl.length, appended: syncRes.appended, removedTail: syncRes.removedTail, session_id: sessionId || 'default' });
    } catch (err) {
      console.error('[timeline-sync] error:', err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // ========================
  // /v1/chat/completions（从 server.js 拆出）
  // ========================
app.post("/v1/chat/completions", async (req, reply) => {
  // 2026-09-23（F8）：提到 try 外声明——catch 中需要用它释放 pending 占位
  let clientMsgId = "";
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
    clientMsgId = isClientChat ? String(body.client_msg_id || "").trim() : "";
    // 自建前端预生成的本条回复稳定 id（chat.html reply_msg_id）：落盘沿用，保证落库前后端 id 一致，
    // 回复刚落库、SSE 补拉之前的编辑/删除也能被 /v1/timeline/sync 的 diff 分支定点命中。
    // 第三方客户端不带此字段 → null → appendMessages 内部照旧生成 uuid，向后兼容。
    // 注意：本文件的流式/非流式落盘出口仅在 MCP 关闭/循环异常回退时执行，主出口在 server.js MCP 写回段。
    const replyMsgId = (typeof body.reply_msg_id === "string" && body.reply_msg_id.trim())
      ? body.reply_msg_id.trim().slice(0, 64) : null;
    // 2026-09-23（F8）：把「回放已生成结果」抽成局部函数，供两种情形复用——
    //   ① 命中已完成的缓存结果（原有逻辑）；② 等待首轮请求完成之后（新增）。
    const _replayCachedReply = async function (cached) {
      console.log("[idempotency] 命中同 client_msg_id 的已生成回复，直接回放");
      if (body.stream === true) {
        // 2026-09-24 B3（M2）：回放同样下发 final 字段——cached.storedText（含标签，与时间线同源）
        // 专供前端落盘对齐（回放落盘=时间线 → 补拉不再校准）；正文仍用 cached.text（剥标签版，
        // 与实时下行口径一致）。重启前生成的旧缓存无这两个字段 → undefined → buildSSE 不下发
        // → 前端退回自己的映射，向后兼容。
        const stream = mcp.buildSSE(cached.text, { model: body.model || cached.model || "", usage: cached.usage, reasoning: cached.reasoning, toolHistory: cached.tools, finalContent: cached.storedText, finalTimeline: cached.streamTimeline });
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
        return true;
      }
      reply.send({
        id: "chatcmpl-idem",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: cached.model || body.model || "",
        choices: [{ index: 0, message: { role: "assistant", content: cached.text }, finish_reason: "stop" }],
        usage: cached.usage || null
      });
      return true;
    };
    if (clientMsgId) {
      const cached = recentReplies.get(clientMsgId);
      // ① 已有未过期的完整结果 → 直接回放（原逻辑；多一个 !cached.pending 判断以免把占位当结果）
      if (cached && !cached.pending && isRecentReplyCacheable(cached) && (Date.now() - cached.ts) < IDEMPOTENCY_TTL_MS) {
        if (await _replayCachedReply(cached)) return;
      }
      // ② 2026-09-23（F8）：同 client_msg_id 的请求**仍在生成中** → 挂起等待首轮结果再回放。
      //    典型触发：前端网络层失败后 600ms 自动重发（chat.html 的 doFetch catch），而首轮仍在生成——
      //    此时缓存里还没有结果，旧实现会把它当新请求再调一次上游（双份 token，且可能重复落盘）。
      //    改为等待首轮产出后回放，用户无感且不重复烧 token；等待上限见 IDEMPOTENCY_PENDING_WAIT_MS。
      if (cached && cached.pending) {
        console.log("[idempotency] 同 client_msg_id 请求仍在处理中，挂起等待首轮结果（不重复调上游）");
        // 1003-27：等待超时后若首轮占位仍在（首轮还活着）→ 继续等待，不降级重调上游。
        // 修复背景：前端网络失败 600ms 自动重发（同 client_msg_id）+ 首轮长生成（工具循环/上游慢
        // 超过 90s）+ 原实现在等待超时即降级重调 → 首轮连接已断但服务端继续生成并落盘，
        // 双份上游调用产生两个一模一样的回复。只有占位消失（首轮失败/崩溃）或总上限到才降级。
        let waited = await waitPendingReply(clientMsgId, IDEMPOTENCY_PENDING_WAIT_MS);
        if (waited && isRecentReplyCacheable(waited)) {
          if (await _replayCachedReply(waited)) return;
        }
        const waitTotalMs = (typeof IDEMPOTENCY_PENDING_TOTAL_MS === "number" && IDEMPOTENCY_PENDING_TOTAL_MS > 0)
          ? IDEMPOTENCY_PENDING_TOTAL_MS : (IDEMPOTENCY_PENDING_WAIT_MS * 2);
        const deadline = Date.now() + waitTotalMs;
        while (Date.now() < deadline) {
          const cur = recentReplies.get(clientMsgId);
          if (!cur || !cur.pending) break; // 首轮已结束（成功被缓存 / 失败被清占位）
          console.warn("[idempotency] 首轮仍在生成（已等待 " + Math.round((Date.now() - cached.ts) / 1000) +
            "s），继续等待，不降级重调上游");
          waited = await waitPendingReply(clientMsgId, IDEMPOTENCY_PENDING_WAIT_MS);
          if (waited && isRecentReplyCacheable(waited)) {
            if (await _replayCachedReply(waited)) return;
          }
        }
        const finalEntry = recentReplies.get(clientMsgId);
        if (finalEntry && finalEntry.pending) {
          // 总上限到首轮仍在生成：释放占位允许降级（此时前端大概率已放弃或连接早已断开）
          recentReplies.delete(clientMsgId);
          console.warn("[idempotency] 首轮超过 " + Math.round(waitTotalMs / 1000) + "s 仍未完成，释放占位降级按新请求处理");
        }
        console.warn("[idempotency] 首轮未产出可回放结果，本轮降级按新请求处理");
      }
      // ③ 登记 pending 占位，声明本请求负责生成（供后续重入请求等待）
      beginPendingReply(clientMsgId);
    }

    const oldTimeline = loadTimeline(sessionId);

    // 防误伤：携带真实消息(或首次建线)才写时间线。时间线已是追加式增量写、不再全量覆盖历史，
    // 故放宽原先「必须 x-client=dylan-chat 才写」的门槛——第三方客户端(如 Kelivo)不带该头
    // 且已带上真实消息，也能正常写入，供自建前端(chat.html)看到。
    if (kelivoMessages.some(isRealMessageForTimeline) || oldTimeline.length === 0) {
      // 方案二增量：落盘改为以盘上为基同步差量（新消息补齐/人设同步/重生成清尾），
      // 不再拿请求全量重建覆盖；通知由同步函数按需发出。
      // 2026-09-23：透传重生成锚点 id（前端「重新生成」时上报），服务端按 id 截断锚点 user 之后的全部内容
      appendRequestMessages(sessionId, kelivoMessages, { regenAnchorId: body.regen_anchor_id });
      // 用户主动聊天 → 取消 AI 之前设的定时唤醒（keep=true 的闹钟除外，2026-09-26）
      try { wakeSchedule.clearSlotUnlessKeep(sessionId); } catch(e) {}
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
    // 统一对话构建器（2026-09-15 批3核心）：聊天与唤醒同源同前缀。
    // 服务端从时间线重建上下文（role 法全量：日记/历史[唤醒]块/工具记录齐全）；
    // 客户端窗口仅用于上方增量同步（appendRequestMessages），不再作为上下文底稿。
    // 非主聊天（标题总结等旁路请求）保持客户端直通，不注入完整上下文。
    // ========================
    if (isMainChat) {
      // S4 修复：服务端时间线重建必须先于一切上下文加工（0919 静态测试抓出漏行）
      llmMessages = buildConversation(sessionId);
      // 开关在请求开始时快照读取（17.txt：防切换瞬间半新半旧）
      const v2Cfg = await fsp.readJson(path.join(baseDir, 'data', 'memory_v2_config.json')).catch(() => ({}));
      if (v2Cfg && v2Cfg.ctx_v2_enabled === true) {
        // ---- S4 正式上下文（0919 用户拍板；0920 起与唤醒共用同一 assembleAndApply 入口）----
        // V2 块替换旧两块 + Relevant 插尾 + 记忆浮现写入；回滚 = ctx_v2_enabled 置 false。
        try {
          const r = await ctxV2Runtime.assembleAndApply({
            baseDir: baseDir,
            sessionId: sessionId,
            messages: llmMessages,
            loadTimeline: loadTimeline,
            normalizeContentToText: normalizeContentToText,
          });
          llmMessages = r.messages;
          // 记忆浮现：命中的记忆原样写入时间线永久在场（hidden 前端不显示；清单防重复由 builder excludeIds 保证）
          if (r.relevantHits && r.relevantHits.length) {
            const n = ctxV2Runtime.floatMemoriesToTimeline({ appendMessages, sessionId, mems: r.relevantHits, baseDir });
            if (n) console.log('[ctx-v2] 本轮记忆浮现', n, '条');
          }
        } catch (e) { console.error('[ctx-v2] 切换层失败，回退旧上下文（不影响主聊天）:', e && e.message); }
      }
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

    // 2026-09-21 审查 H9：repair/replace/guard/convert/sanitize 五步收敛进统一管道
    // prepareModelMessages（与唤醒侧同序），此处不再散装调用。repair 在管道内第一步执行。

    // 统一模型解析（2026-09-08）：会话级设置 → 全局默认供应商 → env 兜底，与 MCP 路径同一口径
    const { provider: prov, model: resolvedModel } = deps.resolveChatModel(sessionId, body.model);
    if (resolvedModel) body.model = resolvedModel;
    // 2026-09-30 采样参数按模型适配（与唤醒侧 routes/wake-chat.js 同一规则）：
    // kimi 系列上游只接受 temperature=1（HTTP 400 "invalid temperature: only 1 is allowed
    // for this model"），top_p 只接受 0.95（同日晚实证 400 "invalid top_p: only 0.95 is allowed"，
    // 初版误钳 1 导致 MCP 流式每轮 400 回退非流式）；其他模型尊重客户端传入（设置页「对话与AI」的温度/top_p）。
    // 此前 chat-settings.json 存的 temperature=1.5 一旦被设备透传，kimi 下聊天会与唤醒同型 400。
    // 在 handler 此处统一钳制：下方 MCP 工具循环与直连分支读同一 body，两路同时生效。
    if (/kimi/i.test(String(body.model || ""))) {
      if (body.temperature !== undefined && body.temperature !== 1) {
        console.warn("[chat] kimi 模型不接受自定义 temperature，已钳到 1（原值 " + body.temperature + "）");
        body.temperature = 1;
      }
      if (body.top_p !== undefined && body.top_p !== 0.95) {
        body.top_p = 0.95;
      }
    }
    const targetApiUrl = (prov && (prov.api_url || prov.base_url)) || readEnvValue("TARGET_API_URL");
    const targetApiKey = (prov && prov.api_key) || readEnvValue("TARGET_API_KEY");
    if (!targetApiUrl || !targetApiKey) {
      return reply.code(500).send({ error: "TARGET_API_URL / TARGET_API_KEY 或 AI 供应商未配置" });
    }

    const requestedStream = body?.stream === true;

    // 上下文（人设 + V2 组装块 + 历史）由统一对话构建器重建（buildConversation），此处不再重复注入。

    // ========================
    // 对话时记忆浮现 / 时间注入：已随记忆池与摘要体系一起移除
    // ========================

    // 历史图片裁剪已移除（2026-09-08）：图片原样透传，不做任何保留窗口

    // 上下文压缩已统一进「上下文替换」：早期对话块摘要与 AI 记忆现在都是同一种替换记录，
    // 由 contextReplacements.applyReplacements 统一生效，旧压缩器发送路径已停用。

    // 统一加工管道（2026-09-21 审查 H9）：repair→replace→guard→convert→sanitize
    const sanitizedMessages = chatCtx.prepareModelMessages(llmMessages, {
      applyReplacements: (m) => contextReplacements.applyReplacements(m),
      ctxLimitGuard,
      sessionId,
      timeByKey,
      logPrefix: "[context-replacements]"
    });

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
        // 1004-11：工具循环中途上游失败时若 SSE 头已发出（streamStarted），直连分支二次 writeHead 会崩溃，
        // 客户端收半截 SSE、已生成部分不落盘。头已发 → 直接结束响应返回，不再走直连。
        if (reply.raw.headersSent) {
          try { reply.raw.end(); } catch (e) {}
          return;
        }
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
      // 2026-09-28 余额不足提醒：聊天直连 402 时记录并限频推 Bark（不阻断下方透传流程）
      if (response.status === 402) {
        upstreamAlert.note402({ model: String((body && body.model) || (resolvedModel) || ""), detail: "", sessionId }).catch(function () {});
      }
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
        // 2026-10-01 MiniMax 非流式修复：content 字符串里的 <think> 块剥离进思考链，正文用干净版（落盘/缓存/标签解析全走干净正文）
        const _sp = mcp.splitThinkBlock(String(aiMessage.content || ""));
        const aiContent = _sp.body;
        const aiThinking = [extractAssistantThinking(aiMessage), _sp.think].filter(Boolean).join("\n").trim();
        if (aiContent) {
          // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
          parseWakeTagAndSchedule(aiContent, sessionId);
          // 提取并存储记忆，同时拿到清洗后的文本
          const cleanText = await tagParser.extractAndStore(aiContent, { sessionId }).catch(err => {
            console.warn("[memory] 非流式标签解析失败:", err.message);
            return aiContent;
          });
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
                const diarySaved = diaryLib.appendDiaryEntry(diaryResult.diaryContent, sessionId);
                toAppend.push({ role: "assistant", content: diaryLib.wrapDiaryTag(diaryResult.diaryContent), kind: "diary", diary_id: (diarySaved && diarySaved.id) || undefined });
              }
              if (aiContent) {
                // 1005 改：后端时间线是流水账，落原始完整文本（含[DIARY]标签），不剥；
                // 日记内容另外存 diary.json + kind:diary 消息；前端可见内容由历史 API 下发时剥。
                toAppend.push({ id: replyMsgId || undefined, role: "assistant", content: aiContent, reasoning: aiThinking || "", tokens: (parsed && parsed.usage) || null });
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

    // 2026-09-24 P3-2A：SSE 全文解析函数（正常路径与中断路径共用同一实现，杜绝口径漂移）
    const _splitThinkBlock = function (text) {
      if (typeof text !== "string" || !text) return { body: "", think: "" };
      const re = /<think>([\s\S]*?)<\/think>/g;
      const thinks = [];
      let m;
      while ((m = re.exec(text))) { if (m[1] && m[1].trim()) thinks.push(m[1].trim()); }
      if (!thinks.length) return { body: text, think: "" };
      return { body: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), think: thinks.join("\n") };
    };
    const _parseSseFull = function (rawSse) {
      let content = "", thinking = "", usage = null, parseErrors = 0;
      const _ls = String(rawSse || "").split("\n");
      for (const _l of _ls) {
        if (_l.startsWith("data: ") && _l !== "data: [DONE]") {
          try {
            const _evt = JSON.parse(_l.slice(6));
            const _d = _evt.choices?.[0]?.delta?.content;
            if (_d) content += _d;
            const _dt = _evt.choices?.[0]?.delta?.reasoning_content || _evt.choices?.[0]?.delta?.reasoning;
            if (_dt) thinking += (typeof _dt === "string" ? _dt : (_dt.text || ""));
            const _fc = _evt.choices?.[0]?.message?.content;
            if (_fc) content = _fc;
            if (_evt.usage) { usage = _evt.usage; }
          } catch (e) { parseErrors++; }
        }
      }
      const _sp = _splitThinkBlock(content);
      const _allT = [];
      if (_sp.think) _allT.push(_sp.think);
      if (thinking && thinking.trim()) _allT.push(thinking.trim());
      return { content: _sp.body, thinking: _allT.join("\n").trim(), usage: usage, parseErrors: parseErrors };
    };
    reply.raw.writeHead(response.status, {
      "Content-Type": upstreamContentType || "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const reader = response.body.getReader();
    // 2026-09-08：不再累积上游原始字节数组（长回复会双份内存），改为流内累积解码后的 SSE 全文，供流结束提取 AI 回复/记忆标签。
    let fullRawSse = "";
    let aiFullContent = "";   // 2026-09-24 P3-2A：提升到 while 循环外（正常路径赋值 + 中断路径兜底解析共用）
    let aiThinking = "";
    let aiUsage = null;
    try {
    // Streaming tag filter: 上游会把 <memory>/<pin> 拆成 <、memory、> 等多个事件，
    // 字节层匹配不到完整标签，必须在 content 文本层过滤后再重组 SSE 事件。
    const contentFilter = createContentTagFilter();
    const thinkStripper = mcp.createThinkStripper();
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
            // 2026-10-01 MiniMax：content 内 <think> 块跨帧剥离，剥离的思考以 reasoning_content 增量帧转发（前端实时显示思考链）
            thinkStripper.push(filtered, (cleanText) => {
              if (!cleanText) return;
              delta.content = cleanText;
              reply.raw.write("data: " + JSON.stringify(evt) + "\n\n");
            });
            const _td = thinkStripper.takeThinking();
            if (_td) {
              reply.raw.write("data: " + JSON.stringify({
                id: "chatcmpl-direct",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: (body && body.model) || "",
                choices: [{ index: 0, delta: { reasoning_content: _td }, finish_reason: null }]
              }) + "\n\n");
            }
          });
        } else {
          emitRawLine(line);
        }
      }
    }
    // 2026-09-24 P3-2A：直通降级路径（MCP 关/工具循环回退）此前只透传上游 SSE、不下发 final_content——
    // 前端本地合成 content 与服务器落盘 visibleContent 口径不一致，补拉时 added 恒空、新消息不逐条弹出。
    // 此处先解析完整正文，再与 MCP 主路径（server.js B3）同款协议下发终止帧；解析结果提升为外层变量，
    // 下方落盘块直接复用（解析只跑一次，不再各自解析）。
    const _pp = _parseSseFull(fullRawSse);
    aiFullContent = _pp.content;
    aiThinking = _pp.thinking;
    aiUsage = _pp.usage;
    if (_pp.parseErrors > 0) console.warn("[stream] 本轮共 " + _pp.parseErrors + " 帧解析失败，落盘回复可能不完整");
    if (aiUsage) console.log("[usage] " + JSON.stringify(aiUsage));
    if (aiFullContent) {
      const _diaryR = diaryLib.extractDiaryFromResponse(aiFullContent);
      const _vis = _diaryR.diaryContent ? _diaryR.remainingText : aiFullContent;
      if (_vis) {
        // 直通终止帧：final_content = 可见内容（剥日记块，与时间线落盘同口径），
        // 前端 _finalContent 优先采用，本地缓存与服务器字节级一致（顶层字段第三方客户端忽略，向后兼容）
        reply.raw.write("data: " + JSON.stringify({
          id: "chatcmpl-direct",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: (body && body.model) || "",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: aiUsage || null,
          final_content: _vis
        }) + "\n\n");
      }
    }
    // 收尾：丢弃未闭合标签/残留前缀，转发剩余行，结束响应
    contentFilter.flush();
    thinkStripper.flush();
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

    // 流结束后解析 AI 回复（完整正文/思考链/usage 解析已在直通终止帧处完成，此处直接复用，
    // 2026-09-24 P3-2A：原解析循环前移，避免重复解析与口径漂移）
    try {
      // 中断路径兜底：while 循环抛错会跳过上方终止帧块（aiFullContent 仍为空），
      // 保留原「中断后仍落盘部分回复」语义（tailHasReply 保证重试时不重复写）
      if (!aiFullContent && fullRawSse) {
        const _pp2 = _parseSseFull(fullRawSse);
        aiFullContent = _pp2.content;
        aiThinking = _pp2.thinking;
        aiUsage = _pp2.usage;
        if (_pp2.parseErrors > 0) console.warn("[stream] 中断路径共 " + _pp2.parseErrors + " 帧解析失败，落盘回复可能不完整");
      }
      if (aiFullContent) {
        // 解析 <wake> 闹钟标签并写入调度（标签随后被剥离，不显示给用户）
        parseWakeTagAndSchedule(aiFullContent, sessionId);
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
              const diarySaved = diaryLib.appendDiaryEntry(diaryResult.diaryContent, sessionId);
              toAppend.push({ role: "assistant", content: diaryLib.wrapDiaryTag(diaryResult.diaryContent), kind: "diary", diary_id: (diarySaved && diarySaved.id) || undefined });
            }
            if (aiFullContent) {
              // 1005 改：后端流水账落原始完整文本（含[DIARY]标签），不剥；下发前端时剥。
              toAppend.push({ id: replyMsgId || undefined, role: "assistant", content: aiFullContent, reasoning: aiThinking || "", tokens: aiUsage || null });
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
    // 2026-09-23（F8）：生成失败时释放 pending 占位，让用户的「重试」能立即重新开始，
    // 不必等满 90s 等待上限；同时唤醒可能有的一同等待的重入请求（它们会降级为新请求处理）。
    if (clientMsgId) clearPendingReply(clientMsgId);
    reply.code(500).send({ error: err.message });
  }
});
};
