'use strict';
const assert = require('assert');
const { createConversationBuilder } = require('../../routes/chat-context');

// Isolated synthetic session: no existing session IDs, files, or live state are touched.
const timeline = Array.from({ length: 300 }, (_, i) => ({
  id: 'synthetic-' + i,
  role: i === 299 ? 'user' : (i % 2 ? 'assistant' : 'user'),
  content: 'synthetic message ' + i,
}));
timeline.__fp = 'synthetic-fp-stable';
let snapshot = null;
let saveCount = 0;
const snapshotV2 = {
  baseDir: '/isolated-test-only',
  loadSnapshot() { return snapshot; },
  isStale() { return false; },
  hasSnapshot() { return !!snapshot; },
  saveSnapshot(_baseDir, _sessionId, data) { snapshot = data; saveCount++; return true; },
  clearStale() { return true; },
  markStale() { return true; },
};
const builder = createConversationBuilder({
  loadTimeline() { return timeline; },
  prepareMessageForLLM(m) { return { role: m.role, content: m.content, ...(m.id ? { id: m.id } : {}) }; },
  stripPosition(ms) { return ms; },
  resolveSessionSystemPrompt() { return 'synthetic system prompt'; },
  incrementalContext() {
    return { head: [timeline[0]], tailStart: 299, blockFp: 'synthetic-block-fp' };
  },
  snapshotV2,
});

const first = builder('synthetic-session');
assert(first.length > 0, 'initial context should be built');
assert.strictEqual(saveCount, 1, 'missing snapshot should be built on first request');
assert(snapshot, 'snapshot should exist after first request');

// Simulate the manual rebuild endpoint: remove the snapshot while leaving builder cache warm.
snapshot = null;
const second = builder('synthetic-session');
assert(second.length > 0, 'context should still be returned after snapshot deletion');
assert.strictEqual(saveCount, 2, 'warm conversation-cache hit must not bypass lazy snapshot rebuild');
assert(snapshot, 'snapshot should be recreated after cache hit would otherwise occur');
console.log('PASS snapshot rebuild is not bypassed by warm incremental conversation cache');

// The full-history cache branch must obey the same pending-rebuild guard.
let fullSnapshot = null;
let fullSaveCount = 0;
const fullSnapshotV2 = {
  baseDir: '/isolated-test-only',
  loadSnapshot() { return fullSnapshot; },
  isStale() { return false; },
  hasSnapshot() { return !!fullSnapshot; },
  saveSnapshot(_baseDir, _sessionId, data) { fullSnapshot = data; fullSaveCount++; return true; },
  clearStale() { return true; },
  markStale() { return true; },
};
const fullBuilder = createConversationBuilder({
  loadTimeline() { return timeline; },
  prepareMessageForLLM(m) { return { role: m.role, content: m.content, ...(m.id ? { id: m.id } : {}) }; },
  stripPosition(ms) { return ms; },
  resolveSessionSystemPrompt() { return 'synthetic full-cache system prompt'; },
  snapshotV2: fullSnapshotV2,
});
const fullFirst = fullBuilder('synthetic-full-session');
assert(fullFirst.length > 0, 'initial full-history context should be built');
assert.strictEqual(fullSaveCount, 1, 'full-history path should build missing snapshot');
fullSnapshot = null;
const fullSecond = fullBuilder('synthetic-full-session');
assert(fullSecond.length > 0, 'full-history context should be returned after snapshot deletion');
assert.strictEqual(fullSaveCount, 2, 'warm full-history cache hit must not bypass lazy snapshot rebuild');
assert(fullSnapshot, 'full-history path should recreate the snapshot after deletion');
console.log('PASS snapshot rebuild is not bypassed by warm full-history conversation cache');
