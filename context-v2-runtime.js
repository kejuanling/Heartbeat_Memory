'use strict';

// 聊天与唤醒共用的 V2 运行时小适配层：读取同一份 pin/记忆/日记输入，
// 并把 builder 输出替换进消息。纯读取；写入浮现记忆仍由聊天主链路负责。
const path = require('path');
const fsp = require('fs-extra');
const { buildContextBlocks } = require('./context-v2-builder');

// 扫描 diary/ 全部日记篇目（会话子目录收一层），按日期升序——与 shadow 侧 readDiaryEntriesForShadow 同口径
function readDiary(baseDir) {
  const out = [];
  const scan = (root, depth) => {
    let ents = [];
    try { ents = fsp.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.isFile() && /^\d{4}-\d{2}-\d{2}(_\d{6})?\.md$/.test(e.name)) {
        try { out.push({ date: e.name.slice(0, 10), content: fsp.readFileSync(path.join(root, e.name), 'utf8') }); } catch (_) {}
      } else if (e.isDirectory() && depth < 1) scan(path.join(root, e.name), depth + 1);
    }
  };
  scan(path.join(baseDir, 'diary'), 0);
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// 组装 V2 builder 输入：pinned 映射/V2 记忆/日记/查询（末条 user）/已浮现排除清单/日记篇数配置
function buildInput(baseDir, sessionId, messages, normalize) {
  const dataDir = path.join(baseDir, 'data');
  let pinnedEntries = [], map = null, memoriesV2 = [], excludeIds = [];
  try {
    const pinned = fsp.readJsonSync(path.join(dataDir, 'pinned.json'));
    try { map = fsp.readJsonSync(path.join(dataDir, 'context_v2_pinned_map.json')); } catch (_) {}
    const byId = new Map((map && Array.isArray(map.entries) ? map.entries : []).map(e => [e.pinnedId, e.target]));
    pinnedEntries = (Array.isArray(pinned) ? pinned : []).map(p => ({ id: p.id, title: p.title, content: p.content, target: byId.get(p.id) || 'retire' }));
  } catch (_) {}
  try { memoriesV2 = fsp.readJsonSync(path.join(dataDir, 'memory_v2.json')); } catch (_) {}
  let query = '';
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') { query = normalize(m.content) || ''; break; }
  }
  try {
    const f = fsp.readJsonSync(path.join(dataDir, 'context_v2_floated.json')) || {};
    excludeIds = Array.isArray(f[sessionId]) ? f[sessionId] : [];
  } catch (_) {}
  let diaryCount = 3;
  try { diaryCount = Number(fsp.readJsonSync(path.join(dataDir, 'memory_pool_config.json')).cross_inject_diary_count) || 3; } catch (_) {}
  return { pinnedEntries, memoriesV2, diaryEntries: readDiary(baseDir), query, excludeIds, config: { diaryCount }, map };
}

// 把 builder 输出套进消息：剔除旧 [永久上下文]/[跨窗口] developer 块→原位插入新固定块；
// relevant_memories 单独追加到末尾连续 user 消息之前（当轮待回复前）
function apply(messages, blocks) {
  const old = [];
  (messages || []).forEach((m, i) => { if (m && m.role === 'developer' && typeof m.content === 'string' && (m.content.startsWith('[永久上下文]') || m.content.startsWith('[跨窗口]'))) old.push(i); });
  const fixed = (blocks || []).filter(b => b.key !== 'relevant_memories' && !b.empty).map(b => ({ role: 'developer', content: b.content }));
  const relevant = (blocks || []).find(b => b.key === 'relevant_memories' && !b.empty);
  const out = (messages || []).filter((m, i) => old.indexOf(i) < 0);
  let at = old.length ? 0 : Math.max(0, out.findIndex(m => m && m.role === 'system') + 1);
  out.splice(at, 0, ...fixed);
  if (relevant) { let tail = out.length; while (tail && out[tail - 1].role === 'user') tail--; out.splice(tail, 0, { role: 'developer', content: relevant.content }); }
  return out;
}

// V2 总闸：memory_v2_config.json 的 ctx_v2_enabled（缺文件=false）
function enabled(baseDir) { try { return fsp.readJsonSync(path.join(baseDir, 'data', 'memory_v2_config.json')).ctx_v2_enabled === true; } catch (_) { return false; } }

module.exports = { buildInput, buildContextBlocks, apply, enabled };
