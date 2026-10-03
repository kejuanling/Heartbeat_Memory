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
const { createSessionCfg } = require('./lib/session-cfg');   // 2026-10-03：会话级跨窗口开关

// 把 builder 输出套进消息：剔除旧 [永久上下文]/[跨窗口] developer 块 →
// 固定块插到开头连续 system 之后；relevant_memories 单独追加到
// 末尾连续 user 消息之前（当轮待回复前，位于历史之后）。
function apply(messages, blocks) {
  const old = [];
  (messages || []).forEach((m, i) => { if (m && m.role === 'developer' && typeof m.content === 'string' && (m.content.startsWith('[永久上下文]') || m.content.startsWith('[跨窗口]'))) old.push(i); });
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
  return { pinnedEntries: pinnedData.pinnedEntries, timeline: [], diaryEntries: [], memoriesV2: memoriesV2, query: query, excludeIds: excludeIds, config: { diaryCount: 0 }, map: null, summaryBlocks: shadow.readSummaryBlocks(dataDir) };
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
  const existing = snapStore.loadSnapshot(opts.baseDir, opts.sessionId);
  let blocks;
  let relevantHits = [];
  if (existing && Array.isArray(existing.fixed_blocks)) {
    // ---- 快照模式（1002-11）：人设与固定块永不重算，仅相关记忆动态 ----
    const input = minimalAssembleInput(opts);
    // 关闭时 query 置空：buildRelevant 首行即返回空 → 无块、无 hits（顺带跳过 embed 请求）
    if (relOn) await attachVecScores(input); else input.query = '';
    const built = buildContextBlocks(input);
    blocks = existing.fixed_blocks
      .filter(function (b) { return b && b.content; })
      .map(function (b) { return { key: b.key, title: b.title || '', content: b.content, empty: false }; });
    // 1002 §8 第 6 项 + 1002-20：两块 LLM 总结与顶层引导都不能被快照冻住——
    // 记忆池一变总结就重生成、pinned(assembly) 文案一改就应即时生效，
    // 而快照只重算 relevant。故这些块永远用本次实时构建的结果覆盖/插入。
    ['context_assembly', 'core_identity', 'long_term_understanding'].forEach(function (key) {
      const nb = built.blocks.find(function (b) { return b.key === key && !b.empty; });
      if (!nb) return;
      const i = blocks.findIndex(function (b) { return b.key === key; });
      if (i >= 0) { blocks[i] = nb; return; }
      // 老快照里没这块（当时为空）：插在 Earlier Days 之后、Relevant 之前，保住块序
      const j = blocks.findIndex(function (b) { return b.key === 'conversation_continuity'; });
      if (j >= 0) blocks.splice(j + 1, 0, nb); else blocks.push(nb);
    });
    const rel = built.blocks.find(function (b) { return b.key === 'relevant_memories' && !b.empty; });
    if (rel) blocks.push(rel);
    relevantHits = built.relevantHits || [];
  } else {
    // ---- 首次（新会话 / 存量会话无快照）：全量组装并固化快照 ----
    const input = shadow.assembleInput({
      baseDir: opts.baseDir,
      sessionId: opts.sessionId,
      llmMessages: opts.messages,
      loadTimeline: opts.loadTimeline,
      normalizeContentToText: opts.normalizeContentToText,
    });
    if (relOn) await attachVecScores(input); else input.query = '';
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
  }
  // 1002 第 4 项：相关记忆命中打点 → entry.last_hit_at（评估用）。
  // builder 是纯函数，副作用只在运行时做；打点失败静默，绝不影响上下文组装。
  try {
    const adm = require('./memory-admission').getAdmission();
    if (adm && typeof adm.markHit === 'function' && relevantHits.length) {
      adm.markHit(relevantHits.map(function (h) { return h && h.id; }));
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
    blocks = blocks.filter(function (b) { return b && b.key !== 'conversation_continuity'; });
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
