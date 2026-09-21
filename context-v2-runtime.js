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
const fsp = require('fs-extra');
const { buildContextBlocks } = require('./context-v2-builder');
const shadow = require('./context-v2-shadow');

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
async function assembleAndApply(opts) {
  const input = shadow.assembleInput({
    baseDir: opts.baseDir,
    sessionId: opts.sessionId,
    llmMessages: opts.messages,
    loadTimeline: opts.loadTimeline,
    normalizeContentToText: opts.normalizeContentToText,
  });
  // 0919 注入语义升级（聊天唤醒同款）：Relevant 打分用 bge 余弦；
  // embed 熔断等算分失败不传 vecScores，builder 回落字面，注入不致全灭。
  try {
    const activeRows = require('./memory-v2').createStore({ config: {} }).list({ status: 'active' });
    const rs = await require('./memory-v2-vectors').relevantScores(activeRows, input.query);
    if (rs && rs.ok) input.vecScores = rs.scores;
  } catch (e) {
    // 语义算分失败按字面回落。仅首次告警：此前这里是空 catch，'../memory-v2' 的路径写错
    // 被静默吞掉、V2 语义检索长期未生效却无人发现（2026-09-21 审查 R16）。
    if (!_vecScoreWarned) {
      _vecScoreWarned = true;
      console.warn('[context-v2] 语义算分不可用，本次起回落字面检索（后续同类失败不再重复告警）:', e && e.message);
    }
  }
  const built = buildContextBlocks(input);
  return { messages: apply(opts.messages, built.blocks), relevantHits: built.relevantHits || [] };
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

module.exports = { assembleAndApply, apply, floatMemoriesToTimeline, enabled };
