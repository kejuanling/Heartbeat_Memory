"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const vectors = require("../../memory-v2-vectors");
const memoryV2 = require("../../memory-v2");
const embedClient = require("../../utils/memory-embed-client");

test("memory_search is keyword-only, cross-kind, and ignores triggers/vibe", async () => {
  const rows = [
    { id: "f1", kind: "fact", text: "她喜欢红心木瓜，不要太甜", triggers: ["完全不相关的暗号"], vibe: "海边" },
    { id: "r1", kind: "rule", text: "回答不要在末尾附推荐回复", created_at: "2026-10-01" },
    { id: "e1", kind: "event", text: "标星对话跨窗口注入重复问题", triggers: ["收藏星星"], vibe: "调试线上缓存" },
    { id: "f2", kind: "fact", text: "喜欢纯牛奶味冰淇淋" }
  ];
  const oldFetch = global.fetch;
  let networkCalls = 0;
  global.fetch = async () => { networkCalls++; throw new Error("memory_search must not call embeddings"); };
  try {
    const fruit = await vectors.retrieveHybrid(rows, "红心木瓜", { topK: 5 });
    assert.equal(fruit.length, 1);
    assert.equal(fruit[0].id, "f1");
    const factOnly = await vectors.retrieveHybrid(rows, "红心木瓜", { topK: 5, kind: "fact" });
    assert.deepEqual(factOnly.map(x => x.id), ["f1"]);

    const genericNoise = await vectors.retrieveHybrid([
      { id: "school-server", kind: "event", text: "她觉得学校太小气，舍不得花钱买好服务器和升级抢课系统。" }
    ], "服务器重启", { topK: 5 });
    assert.equal(genericNoise.length, 0, "matching only the server portion must not imply a reboot match");

    const rule = await vectors.retrieveHybrid(rows, "末尾推荐回复", { topK: 5 });
    assert.equal(rule.some(x => x.id === "r1"), true);

    const event = await vectors.retrieveHybrid(rows, "跨窗口注入重复", { topK: 5 });
    assert.equal(event.some(x => x.id === "e1"), true);

    const triggerOnly = await vectors.retrieveHybrid(rows, "收藏星星", { topK: 5 });
    assert.equal(triggerOnly.length, 0);
    assert.equal(networkCalls, 0);
  } finally {
    global.fetch = oldFetch;
  }
});

test("new fact/rule entries do not persist triggers or vibe", () => {
  for (const kind of ["fact", "rule"]) {
    const result = memoryV2.validateEntry({
      text: "测试记忆",
      kind,
      origin: "manual",
      provenance: { method: "admin_form" },
      triggers: ["测试关键词"],
      vibe: "测试情景"
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(Object.hasOwn(result.entry, "triggers"), false);
    assert.equal(Object.hasOwn(result.entry, "vibe"), false);
  }
  const event = memoryV2.validateEntry({
    text: "测试事件",
    kind: "event",
    origin: "manual",
    provenance: { method: "admin_form" },
    triggers: ["测试关键词"],
    vibe: "测试情景"
  });
  assert.equal(event.ok, true, event.error);
  assert.deepEqual(event.entry.triggers, ["测试关键词"]);
  assert.equal(event.entry.vibe, "测试情景");
});

test("SiliconFlow embedding client returns normalized 1024-d vectors without exposing provider secrets", async t => {
  const oldFetch = global.fetch;
  const oldModel = process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_MODEL;
  embedClient.resetCircuitForTests();
  let seen = null;
  global.fetch = async (url, init) => {
    seen = { url: String(url), model: JSON.parse(init.body).model, input: JSON.parse(init.body).input, hasAuth: /^Bearer .+/.test(init.headers.Authorization || "") };
    const embedding = Array.from({ length: 1024 }, (_, i) => i === 0 ? 3 : 4);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding }] })
    };
  };
  t.after(() => {
    global.fetch = oldFetch;
    if (oldModel === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = oldModel;
    embedClient.resetCircuitForTests();
  });
  const out = await embedClient.embedBatch(["test"], false, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 1024);
  assert.equal(seen.model, "BAAI/bge-m3");
  assert.match(seen.url, /api\.siliconflow\.cn\/v1\/embeddings$/);
  assert.equal(seen.hasAuth, true);
  const norm = Math.sqrt(out[0].reduce((sum, n) => sum + n * n, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});
