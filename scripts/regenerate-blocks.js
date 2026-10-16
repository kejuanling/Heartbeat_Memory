'use strict';
// 批量重生成压缩块摘要 v3（2026-10-01）
// 直接用块里存的 matched 原文快照，调 compactor.generateSummaryForMessages 生成新摘要写回。
// 串行，每块间隔 120s，失败继续。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cr = require(path.join(ROOT, 'context-replacements'));
const compactor = require(path.join(ROOT, 'context-compactor'));
const SCHED = path.join(ROOT, 'data', 'context_replacements.json');
const LOG = path.join(ROOT, 'data', 'regenerate-blocks.log');

const KEH3 = 's_mtpq796n_o1keh3';
const EXCLUDE_KEH3_IDX = new Set([11, 12, 13, 14, 17, 23, 24, 27, 35, 36, 37, 38]);
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 120 * 1000;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

async function regenOne(rec) {
  const matched = Array.isArray(rec.matched) ? rec.matched : [];
  if (!matched.length) return { ok: false, reason: 'matched 为空，无原文可生成' };
  let gen;
  try {
    gen = await compactor.generateSummaryForMessages(matched);
  } catch (e) {
    return { ok: false, reason: '生成异常: ' + e.message };
  }
  if (!gen || !gen.ok) return { ok: false, reason: (gen && gen.message) || '生成失败' };
  const isManual = rec.source === 'manual';
  let saved;
  try {
    saved = isManual ? cr.setManualRecordTextById(rec.id, gen.summary)
                     : cr.updateReplacement(rec.id, gen.summary);
  } catch (e) {
    return { ok: false, reason: '写回异常: ' + e.message };
  }
  if (!saved || saved.ok === false) return { ok: false, reason: '写回失败: ' + ((saved && (saved.message || saved.error)) || '?') };
  return { ok: true, length: gen.length };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SCHED, 'utf8'));
  const items = Array.isArray(data) ? data : (data.items || []);

  const keh3 = items.filter(it => !it.removed && it.session === KEH3)
                    .sort((a, b) => String(a.range_label || '').localeCompare(String(b.range_label || '')));
  const excludeIds = new Set();
  keh3.forEach((it, i) => { if (EXCLUDE_KEH3_IDX.has(i + 1)) excludeIds.add(it.id); });

  let todo = items.filter(it => !it.removed && it.enabled !== false && !excludeIds.has(it.id));
  if (process.env.LIMIT) todo = todo.slice(0, Number(process.env.LIMIT));

  log('==== 批量重生成 v3 开始 ====');
  log('待处理: ' + todo.length + '，排除 keh3: ' + excludeIds.size + '，间隔: ' + (INTERVAL_MS/1000) + 's');

  let ok = 0, fail = 0;
  const failures = [];

  for (let i = 0; i < todo.length; i++) {
    const rec = todo[i];
    log('[' + (i+1) + '/' + todo.length + '] id=' + rec.id + ' session=' + rec.session + ' range=' + rec.range_label + ' matched=' + (Array.isArray(rec.matched)?rec.matched.length:0));
    const r = await regenOne(rec);
    if (r.ok) {
      ok++;
      log('  -> 成功，' + r.length + ' 字');
    } else {
      fail++;
      failures.push({ id: rec.id, session: rec.session, range: rec.range_label, reason: r.reason });
      log('  -> 失败: ' + r.reason);
    }
    if (i < todo.length - 1) await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  log('==== 完成 ====');
  log('成功: ' + ok + '，失败: ' + fail + '，总计: ' + todo.length);
  failures.forEach(f => log('  FAIL ' + f.id + ' | ' + f.session + ' | ' + f.range + ' | ' + f.reason));
}

main().catch(e => { log('致命错误: ' + e.message); process.exit(1); });
