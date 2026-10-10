'use strict';

// 聊天与唤醒共用的 Context V2 运行时（0920 完全统一）：
// 聊天（routes/chat.js）与唤醒（routes/wake-chat.js）调模型用的上下文组装，
// 全部走本模块 assembleAndApply 同一入口——输入组装（shadow.assembleInput）→
// bge 语义算分（vecScores，失败回落字面）→ buildContextBlocks → apply。
// 同一时刻同一会话，两侧产出逐字一致（上游前缀缓存共享）。
//
// apply 的块插入（0919 修正版，0920 起聊天唤醒共用这一份）：
// V2 固定块插到开头连续 system 人设之后——人设永远最顶。
// 不再按已删除旧块数量定位：旧逻辑 old.length>0 时插到 0，把 V2 块排到人设
// 前面（唤醒侧 0920 实翻车；聊天侧同款 bug 已于 0919 修复）。
//
// 记忆浮现写入（floatMemoriesToTimeline）同样归一在此：命中记忆原样写时间线
// 永久在场，聊天与唤醒行为一致（0920 用户拍板）。

const path = require('path');
const fs = require('fs');
const fsp = require('fs-extra');
const { buildContextBlocks } = require('./context-v2-builder');
const shadow = require('./context-v2-shadow');
const snapStore = require('./context-snapshot');
const crypto = require('crypto'); // 1010 需求3：标星 contentKey 同口径
const { createSessionCfg } = require('./lib/session-cfg');   // 2026-10-03：会话级跨窗口开关
const { getInheritedState } = require('./lib/conversation-state'); // 1010 需求2：状态机快照继承（最后一次聊天会话）
const { safeSessionToken } = require('./lib/session-token'); // 1010 需求3：标星跨会话扫描时间线文件
const { createLastChatSession } = require('./lib/last-chat-session'); // 1010 需求3：最近20条对话原文的继承源

// 1005-17：相关注入参数（memory_v2_config.json relevant 段，管理台可调）
function readRelevantCfg(baseDir) {
  try {
    const c = fsp.readJsonSync(path.join(baseDir, 'data', 'memory_v2_config.json'));
    if (c && c.relevant && typeof c.relevant === 'object') {
      const r = c.relevant;
      return {
        relevantWordWeight: r.wordWeight,
        relevantSemWeight: r.semWeight,
        relevantMinHybridScore: r.minHybridScore,
        relevantHybridTopK: r.topK,
      };
    }
  } catch (_) {}
  return {};
}

// 1005-17：注入预览——记录最近 20 轮"本应注入哪条 + 混合分"（观察用，不进 prompt）
function appendPreview(baseDir, sessionId, query, hits) {
  try {
    const p = path.join(baseDir, 'data', 'relevant_preview.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({
      time: new Date().toISOString(),
      session: String(sessionId || '').slice(0, 40),
      query: String(query || '').slice(0, 60),
      hits: (hits || []).map(function (h) {
        return { id: h && h.id, kind: h && h.kind, score: h && h.score, text: (h && h.text || '').slice(0, 80) };
      }),
    });
    arr = arr.slice(0, 20);
    fs.writeFileSync(p, JSON.stringify(arr, null, 2));
  } catch (_) {}
}


// 1010 需求3：标星的消息原文（跨窗口注入）。marks key = sha256(role+\0+正文) 前32位（与
// context-replacements.contentKey 同口径）；遍历全部时间线文件，命中的真实消息收集原文。
// 返回最近 N 条（按消息 time 排序，标星本身有限，默认全量），每条一行。
function readStarredDialogLines(baseDir, loadTimeline) {
  let marks = {};
  try {
    const d = JSON.parse(fs.readFileSync(path.join(baseDir, 'data', 'context_compaction_marks.json'), 'utf8'));
    if (d && d.marks && typeof d.marks === 'object') marks = d.marks;
  } catch (e) { return []; }
  const markKeys = Object.keys(marks);
  if (!markKeys.length) return [];
  const contentKey = function (msg) {
    const text = (msg && typeof msg.content === 'string') ? msg.content : '';
    return crypto.createHash('sha256').update((msg && msg.role ? msg.role : '') + '\u0000' + text).digest('hex').slice(0, 32);
  };
  const collect = [];
  const files = [];
  try { files.push('enhanced_messages.json'); } catch (e) {}
  try {
    const dir = fs.readdirSync(baseDir);
    for (const f of dir) { if (/^enhanced_messages_s_.*\.json$/.test(f)) files.push(f); }
  } catch (e) {}
  const seen = new Set();
  for (const f of files) {
    let tl = [];
    try { tl = JSON.parse(fs.readFileSync(path.join(baseDir, f), 'utf8')); } catch (e) { continue; }
    if (!Array.isArray(tl)) continue;
    for (const m of tl) {
      if (!m || m.role === 'system' || m.role === 'developer' || m.role === 'tool' || m.kind === 'diary' || m.kind === 'noaction') continue;
      if (!(m.content && typeof m.content === 'string' && String(m.content).trim())) continue;
      const k = contentKey(m);
      if (!markKeys.includes(k)) continue;
      const key2 = String(m.id || '') + '|' + k;
      if (seen.has(key2)) continue;
      seen.add(key2);
      collect.push({ time: String(m.time || ''), text: String(m.content).trim() });
    }
  }
  collect.sort(function (a, b) { return (a.time < b.time) ? -1 : (a.time > b.time ? 1 : 0); });
  const N = 20;
  return collect.slice(-N).map(function (x) { return x.text; });
}

// 1010 需求3：最后一次聊天会话的最近 20 条对话原文。继承源同需求2（last_chat_session.json）。
// 取该会话时间线尾部 20 条真实消息（role user/assistant，排除 system/developer/tool/diary/特殊事件），
// 保持时间正序呈现（旧在上新在下）。
function readRecentDialogLines(baseDir, loadTimeline) {
  let last = null;
  try { last = createLastChatSession(baseDir).read(); } catch (e) { last = null; }
  if (!last) return [];
  let tl = [];
  try { tl = loadTimeline(last) || []; } catch (e) { tl = []; }
  const real = (Array.isArray(tl) ? tl : []).filter(function (m) {
    if (!m) return false;
    if (m.role === 'system' || m.role === 'developer' || m.role === 'tool') return false;
    if (m.kind === 'diary' || m.kind === 'noaction') return false;
    if (!(m.content && typeof m.content === 'string' && String(m.content).trim())) return false;
    if (String(m.content).trim().indexOf('（记忆浮现') === 0) return false; // 特殊事件不注入
    return true;
  });
  const lines = real.slice(-20).map(function (m) {
    const who = m.role === 'user' ? '我' : '对方';
    return '[' + who + '] ' + String(m.content).trim();
  });
  return lines;
}

// 把 builder 输出套进消息：剔除旧 [永久上下文]/[跨窗口] developer 块 →
// 固定块插到开头连续 system 之后；relevant_memories 单独追加到
// 末尾连续 user 消息之前（当轮待回复前，位于历史之后）。
function apply(messages, blocks) {
  const old = [];
  // 1004-11：V2 块头是 "## System Instructions" 等（HEADERS），旧前缀 [永久上下文]/[跨窗口] 是
  // V1 时代遗留——只匹配旧前缀时防御失效（新块清不掉）。精确匹配 V2 五个块头 + 保留旧前缀兼容历史；
  // 不匹配 "## Conversation State"（状态块，不能清）。
  const _v2Heads = ['## System Instructions', '## Core Identity', '## Long-term Understanding', '## Earlier Days', '## Possibly Relevant Memories'];
  (messages || []).forEach((m, i) => {
    if (m && m.role === 'developer' && typeof m.content === 'string' &&
      (m.content.startsWith('[永久上下文]') || m.content.startsWith('[跨窗口]') || _v2Heads.some(function (h) { return m.content.startsWith(h); }))) old.push(i);
  });
  const fixed = (blocks || []).filter(b => b.key !== 'relevant_memories' && !b.empty).map(b => ({ role: 'developer', content: b.content }));
  const relevant = (blocks || []).find(b => b.key === 'relevant_memories' && !b.empty);
  const out = (messages || []).filter((m, i) => old.indexOf(i) < 0);
  // 插入点（0919 修正版）：跳过开头连续 system（人设），不按已删除旧块定位
  let at = 0;
  while (at < out.length && out[at] && out[at].role === 'system') at++;
  out.splice(at, 0, ...fixed);
  if (relevant) { let tail = out.length; while (tail && out[tail - 1].role === 'user') tail--; out.splice(tail, 0, { role: 'developer', content: relevant.content }); }
  return out;
}

// 共享组装入口（聊天与唤醒唯一调用形态）：
// opts: { baseDir, sessionId, messages, loadTimeline, normalizeContentToText }
// 返回 { messages, relevantHits }；失败向上抛，由调用方 catch 回退旧上下文。
let _vecScoreWarned = false;
// 快照模式下相关记忆动态计算的最小输入（1002-11，方案 B）：
// 只读 memory_v2 + 浮标清单 + 当前 query，其余固定输入字段置空——固定块由快照提供，
// 这里只为 relevant_memories 块（按本轮 user 消息浮动）与 relevantHits 服务。
function minimalAssembleInput(opts) {
  const dataDir = path.join(opts.baseDir, 'data');
  let memoriesV2 = [];
  try { memoriesV2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory_v2.json'), 'utf8')); } catch (e) {}
  let query = '';
  try {
    const llmMessages = Array.isArray(opts.messages) ? opts.messages : [];
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      const m = llmMessages[i];
      if (m && m.role === 'user') { query = opts.normalizeContentToText(m.content) || ''; break; }
    }
  } catch (e) {}
  let excludeIds = [];
  try {
    const map = JSON.parse(fs.readFileSync(path.join(dataDir, 'context_v2_floated.json'), 'utf8'));
    const arr = map[String(opts.sessionId || 'default')];
    excludeIds = Array.isArray(arr) ? arr.map(String) : [];
  } catch (e) {}
  // 1002 §8 第 6 项：快照模式也要能重建两块总结（不能被快照冻住），故 pinned 与总结缓存都要读。
  // pinned 进 Core Identity 块（手工固定的人设常驻内容保留），总结替代条目原文直注。
  const pinnedData = shadow.readPinnedEntries(dataDir);
  return { pinnedEntries: pinnedData.pinnedEntries, timeline: [], diaryEntries: [], memoriesV2: memoriesV2, query: query, excludeIds: excludeIds, config: Object.assign({ diaryCount: 0 }, readRelevantCfg(dataDir)), map: null, summaryBlocks: shadow.readSummaryBlocks(dataDir), sessionId: opts.sessionId || null };
}

// 语义算分（0919 注入语义升级：Relevant 打分用 bge 余弦；失败回落字面，注入不致全灭）
async function attachVecScores(input) {
  try {
    const activeRows = require('./memory-v2').createStore({ config: {} }).list({ status: 'active' });
    const rs = await require('./memory-v2-vectors').relevantScores(activeRows, input.query);
    if (rs && rs.ok) input.vecScores = rs.scores;
  } catch (e) {
    if (!_vecScoreWarned) {
      _vecScoreWarned = true;
      console.warn('[context-v2] 语义算分不可用，本次起回落字面检索（后续同类失败不再重复告警）:', e && e.message);
    }
  }
}

async function assembleAndApply(opts) {
  // 相关记忆开关（1002 拍板）：关=不检索、不注入、不写时间线、不调 embed。
  const relOn = relevantEnabled(opts.baseDir);
  // 1005-17 预览模式：注入关闭但 relevant.preview=true 时，照常检索算分观察"本应注入哪条"，
  // 但不进 prompt、不浮现时间线、不打点（真实命中打点只在真注入时发生）。
  let relPreview = false;
  if (!relOn) {
    try { relPreview = fsp.readJsonSync(path.join(opts.baseDir, 'data', 'memory_v2_config.json')).relevant.preview === true; }
    catch (_) { relPreview = false; }
  }
  const existing = snapStore.loadSnapshot(opts.baseDir, opts.sessionId);
  let blocks;
  let relevantHits = [];
  if (existing && Array.isArray(existing.fixed_blocks)) {
    // ---- 快照模式（1002-11）：人设与固定块永不重算，仅相关记忆动态 ----
    const input = minimalAssembleInput(opts);
    // 关闭时 query 置空：buildRelevant 首行即返回空 → 无块、无 hits（顺带跳过 embed 请求）
    if (relOn || relPreview) { if (!relOn) input.previewOnly = true; await attachVecScores(input); } else input.query = '';
    const built = buildContextBlocks(input);
    blocks = existing.fixed_blocks
      .filter(function (b) { return b && b.content; })
      .map(function (b) { return { key: b.key, title: b.title || '', content: b.content, empty: false }; });
    // 1007 用户拍板：V2 注入块全部冻死（System Instructions / Core Identity / Long-term Understanding /
    // Earlier Days 都从快照读，不再实时构建覆盖）。此前 1002 §8 的"两块总结实时覆盖"逻辑已删除——
    // 记忆池/总结/文案变化都不会再即时反映，只有手动重建快照（或状态摘要/编辑消息触发重建）才更新。
    // 唯一仍动态的是 relevant_memories（相关记忆按本轮 user 消息现算）。
    const rel = built.blocks.find(function (b) { return b.key === 'relevant_memories' && !b.empty; });
    if (rel) blocks.push(rel);
    relevantHits = built.relevantHits || [];
    // 1005-17 预览：记录本应注入条目后清空（不浮现、不打点）；真注入时此段不触发
    if (relPreview && relevantHits.length) {
      try { appendPreview(opts.baseDir, opts.sessionId, input.query, relevantHits); } catch (_) {}
      relevantHits = [];
    }
  } else {
    // ---- 首次（新会话 / 存量会话无快照）：全量组装并固化快照 ----
    const input = shadow.assembleInput({
      baseDir: opts.baseDir,
      sessionId: opts.sessionId,
      llmMessages: opts.messages,
      loadTimeline: opts.loadTimeline,
      normalizeContentToText: opts.normalizeContentToText,
    });
    // 1010 需求3：多选注入块的两个新增数据源（标星消息 / 最近20条对话原文），
    // 装配层算好行传给 builder（builder 保持纯函数）。失败静默（空块自然被跳过）。
    try { input.starredLines = readStarredDialogLines(opts.baseDir, opts.loadTimeline); } catch (e) { input.starredLines = []; }
    try { input.recentDialogLines = readRecentDialogLines(opts.baseDir, opts.loadTimeline); } catch (e) { input.recentDialogLines = []; }
    if (relOn || relPreview) { if (!relOn) input.previewOnly = true; await attachVecScores(input); } else input.query = '';
    const built = buildContextBlocks(input);
    const sysMsg = (opts.messages || []).find(function (m) { return m && m.role === 'system'; });
    try {
      snapStore.saveSnapshot(opts.baseDir, opts.sessionId, {
        created_at: new Date().toISOString(),
        system_prompt: sysMsg && sysMsg.content ? String(sysMsg.content) : '',
        fixed_blocks: built.blocks
          .filter(function (b) { return b.key !== 'relevant_memories' && !b.empty; })
          .map(function (b) { return { key: b.key, title: b.title || '', content: b.content }; }),
      });
      console.log('[ctx-v2] 会话注入快照已生成: session=' + opts.sessionId);
    } catch (e) {
      console.warn('[ctx-v2] 快照保存失败（不影响本次请求，下次重试生成）:', e && e.message);
    }
    blocks = built.blocks;
    relevantHits = built.relevantHits || [];
    // 1010 需求3：会话级多选注入块（inject_blocks）——新建会话时选定的注入内容。
    // 缺省/null = 跟随全局默认三块（1010-21 用户澄清口径：全局默认注入永久上下文+记忆两大块总结+日记，
    // 标星的对话/状态机快照/最近20条对话原文是增强项，仅会话级明确勾选才注入）。过滤后的集合在首轮固化成快照，
    // 之后该会话按快照冻结（与"新建会话时选择"的语义一致）。
    // 映射：permanent=system_instructions, summary=core_identity+long_term_understanding,
    //       diary=conversation_continuity, starred_dialog, state=conversation_state_inherit(下方),
    //       recent_dialog。relevant_memories 不受此开关控制（独立总闸）。
    let wantBlocks = null; // 注入块白名单；null 表示未解析成功（不过滤，保守放行）
    try {
      const cfg = createSessionCfg(opts.baseDir);
      const inj = cfg.readInjectBlocks(opts.sessionId);
      wantBlocks = new Set(Array.isArray(inj) ? inj : cfg.DEFAULT_INJECT_BLOCKS);
      blocks = blocks.filter(function (b) {
        if (!b || !b.key) return true;
        if (b.key === 'system_instructions') return wantBlocks.has('permanent');
        if (b.key === 'core_identity' || b.key === 'long_term_understanding') return wantBlocks.has('summary');
        if (b.key === 'conversation_continuity') return wantBlocks.has('diary');
        if (b.key === 'starred_dialog') return wantBlocks.has('starred_dialog');
        if (b.key === 'recent_dialog') return wantBlocks.has('recent_dialog');
        if (b.key === 'conversation_state_inherit') return wantBlocks.has('state');
        return true;
      });
    } catch (e) { console.warn('[ctx-v2] inject_blocks 过滤失败（本次不过滤）:', e && e.message); }
    // 1010 需求2：状态机快照继承（仅首次、无快照会话）——
    // b 没有自己的状态机时，把「最后一次聊天的会话 a」的状态正文作为 Conversation State 块 live 注入。
    // 三个不进快照的原因：a) 继承块是"一次性的"，进快照会让 b 永远冻结 a 的状态；
    //   b) b 一旦自己 commitMerge，现有替换块通道（ctxrep_state_<b>）自然接管，继承块不应残留；
    //   c) 与需求3 的"状态机快照"多选项语义一致（该块不固化、随会话演化）。
    // 继承块 key 用 conversation_state_inherit：apply() 会把它当普通 developer 块插入（非 relevant、
    // 非 empty），且 _v2Heads 不含 "## Conversation State" 头 → 不会被清除。
    try {
      const inh = getInheritedState(opts.sessionId);
      // 1010-21 口径修正：跟随全局（无 state 勾选）时不注入继承块——全局默认不含状态机快照
      if (inh && inh.text && wantBlocks && wantBlocks.has('state')) {
        // 1010 需求3 顺序（用户拍板）：日记 → 标星的对话 → 状态机快照 → 最近20条对话原文。
        // 故继承块插到 recent_dialog 之前（而非追加末尾，否则会排到最近20条后面）。
        const inheritBlock = { key: 'conversation_state_inherit', title: '', content: '## Conversation State\n\n' + inh.text, empty: false };
        const recIdx = blocks.findIndex(function (b) { return b && b.key === 'recent_dialog'; });
        if (recIdx >= 0) { blocks.splice(recIdx, 0, inheritBlock); }
        else { blocks = blocks.concat([inheritBlock]); }
        console.log('[ctx-v2] 状态机快照继承注入: session=' + opts.sessionId + ' <- ' + inh.session + '（' + String(inh.text).length + ' 字，一次性不固化）');
      }
    } catch (e) { console.warn('[ctx-v2] 状态机快照继承注入失败（跳过）:', e && e.message); }
    // 1005-17 预览：记录本应注入条目后清空（不浮现、不打点）；真注入时此段不触发
    if (relPreview && relevantHits.length) {
      try { appendPreview(opts.baseDir, opts.sessionId, input.query, relevantHits); } catch (_) {}
      relevantHits = [];
    }
  }
  // 1002 第 4 项：相关记忆命中打点 → entry.last_hit_at（评估用）。
  // builder 是纯函数，副作用只在运行时做；打点失败静默，绝不影响上下文组装。
  try {
    const adm = require('./memory-admission').getAdmission();
    if (adm && typeof adm.markHit === 'function' && relevantHits.length) {
      adm.markHit(relevantHits.map(function (h) { return h && h.id; }));
    }
    // 1005-17：event 衰减（注入 +0.05 在 markHit 内；这里跑每日 -0.01 扫描，跌破 0.2 归档+进待审）
    if (adm && typeof adm.decayEvents === 'function') {
      try { adm.decayEvents(); } catch (_) { /* 衰减失败不影响主链路 */ }
    }
  } catch (_) { /* 打点失败不影响主链路 */ }
  // 会话级跨窗口开关（1003-19 用户拍板「让它生效」）：override=false 时本会话不注入 Earlier Days
  //（= 其它会话写的日记，块 key conversation_continuity）。
  //
  // 为什么放这里而不是 context-v2-shadow 的日记过滤点：快照模式下 minimalAssembleInput 返回的
  // diaryEntries 恒为 []（固定块来自 data/session_inject_snapshots.json），在 shadow 里过滤对
  // 「已有快照的存量会话」完全无效——实测 12 个会话全部已固化 conversation_continuity。
  // 放这里则首次组装与快照复用两条路径都生效，切换开关下一轮请求即刻见效。
  //
  // 只过滤本次输出、不改快照文件：关掉再打开能恢复，不会像「重建快照」那样把记忆冻死。
  // true / null（跟随全局）一律放行——V2 没有全局总开关，跟随即等于现有行为。
  if (createSessionCfg(opts.baseDir).sessionCrossInjectOverride(opts.sessionId) === false) {
    // 1010 需求2/3：跨窗口注入内容在 override=false 时一并剔除（Earlier Days + 状态继承 + 标星 + 最近20条）
    blocks = blocks.filter(function (b) {
      return b && b.key !== 'conversation_continuity' && b.key !== 'conversation_state_inherit'
        && b.key !== 'starred_dialog' && b.key !== 'recent_dialog';
    });
  }
  return { messages: apply(opts.messages, blocks), relevantHits: relevantHits };
}

// 记忆浮现写入（S4 聊天侧实现原样搬入，0920 起两侧共用）：
// 命中的记忆原样写入时间线永久在场（hidden 前端不显示；LLM 清洗自动剥离）；
// 防重复由 builder 的 excludeIds（context_v2_floated.json）保证。
// opts: { appendMessages, sessionId, mems, baseDir }；返回写入条数。
function floatMemoriesToTimeline(opts) {
  const list = (Array.isArray(opts.mems) ? opts.mems : []).filter(m => m && m.id && String(m.text || '').trim());
  if (!list.length) return 0;
  opts.appendMessages(opts.sessionId, list.map(m => ({
    role: 'developer',
    content: strSafeEntry(m),
    float_id: m.id,
    hidden: true,
  })), { silent: true });
  shadow.appendFloatIds(path.join(opts.baseDir, 'data', 'context_v2_floated.json'), opts.sessionId, list.map(m => m.id));
  return list.length;

  function strSafeEntry(m) {
    const t = String(m.text || '').trim();
    const d = m.established_at && /^\d{4}-\d{2}-\d{2}/.test(String(m.established_at)) ? String(m.established_at).slice(0, 10) : (m.created_at && /^\d{4}-\d{2}-\d{2}/.test(String(m.created_at)) ? String(m.created_at).slice(0, 10) : null);
    return d ? t + '（' + d + '）' : t;
  }
}

// V2 总闸：memory_v2_config.json 的 ctx_v2_enabled（缺文件=false）
function enabled(baseDir) { try { return fsp.readJsonSync(path.join(baseDir, 'data', 'memory_v2_config.json')).ctx_v2_enabled === true; } catch (_) { return false; } }

// ── 相关记忆（Relevant）自动注入开关（2026-10-02 用户拍板关闭）──
// 背景（实测，见诊断报告）：184 条 active 记忆两两 bge 余弦 median 0.586 / p10 0.502，
// 而入选门槛换算只需 sem ≥0.41——门槛低于库内随机配对基线，"宁缺毋滥"在设计上不成立；
// 抽查 33 组命中约 65-70% 与当轮话题无关，且每轮硬取 3 条（1 真相关 + 2 凑数）。
// 另实测：77 条被浮现过的记忆里 75 条（97%）的信息已被 Core Identity / Long-term
// Understanding 两块总结覆盖，0 条是总结里没有的 → 自动检索属重复劳动。
// 关闭后：① 不生成 relevant_memories 块 ② 不写时间线浮现 ③ 省掉每轮一次 embed 请求。
// 兜底：模型仍可用 memory_search 工具主动检索。开关置 true 即恢复原行为。
// 缺省=true（保持向后兼容，显式 false 才关）。
function relevantEnabled(baseDir) {
  try {
    return fsp.readJsonSync(path.join(baseDir, 'data', 'memory_v2_config.json')).ctx_v2_relevant_enabled !== false;
  } catch (_) { return true; }
}

module.exports = { assembleAndApply, apply, floatMemoriesToTimeline, enabled, relevantEnabled };
