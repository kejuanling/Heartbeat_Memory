'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readStarredDialogLines } = require('../../context-v2-runtime');

test('starred dialog deduplicates identical content across copied session files with different message ids', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starred-dialog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data'));
  const msg = (id) => ({ id, role: 'assistant', time: '2026-10-01T10:00:00.000Z', content: '同一句标星内容' });
  const key = crypto.createHash('sha256').update('assistant\0同一句标星内容').digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(dir, 'data', 'context_compaction_marks.json'), JSON.stringify({ marks: { [key]: { markedAt: '2026-10-01T10:00:00.000Z' } } }));
  fs.writeFileSync(path.join(dir, 'enhanced_messages_s_one.json'), JSON.stringify([msg('id-a')]));
  fs.writeFileSync(path.join(dir, 'enhanced_messages_s_two.json'), JSON.stringify([msg('id-b')]));
  const lines = readStarredDialogLines(dir, () => [], 0);
  assert.deepEqual(lines, ['同一句标星内容']);
});

test('prefers saved marked content, supports message-id keys, and falls back for legacy marks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starred-dialog-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data'));
  const legacyText = '旧版标星内容';
  const legacyKey = crypto.createHash('sha256').update('user\0' + legacyText).digest('hex').slice(0, 32);
  const marks = {
    'message-id-new': { content: '从标星文件直接读取', role: 'assistant', time: '2026-10-02T10:00:00.000Z' },
    'message-id-copy': { content: '从标星文件直接读取', role: 'assistant', time: '2026-10-02T10:00:00.000Z' },
    [legacyKey]: { markedAt: '2026-10-01T10:00:00.000Z' }
  };
  fs.writeFileSync(path.join(dir, 'data', 'context_compaction_marks.json'), JSON.stringify({ marks }));
  fs.writeFileSync(path.join(dir, 'enhanced_messages_s_old.json'), JSON.stringify([
    { id: 'old-id', role: 'user', time: '2026-10-01T10:00:00.000Z', content: legacyText }
  ]));
  const lines = readStarredDialogLines(dir, () => [], 0);
  assert.deepEqual(lines, [legacyText, '从标星文件直接读取']);
});
