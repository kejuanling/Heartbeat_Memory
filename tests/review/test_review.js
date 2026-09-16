"use strict";

// ========================
// Memory V2 C5 集成测试：review 路由 + manual V2 接线（v2_enabled 门控）
// 运行：node tests/review/test_review.js
// 纪律：tmp 目录；不调旧池 add（旧池守卫靠「不 require 旧路由的写入路径」+ tmp 断言）
// 路由用 fake app/reply 捕获 handler 直测，不启动 fastify
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createAdmission } = require("../../memory-admission");
const registerReviewRoutes = require("../../routes/memory-review");

function makeFakeApp() {
  const handlers = {};
  return {
    handlers,
    app: {
      get: (p, o, h) => { handlers["GET " + p] = h; },
      post: (p, o, h) => { handlers["POST " + p] = h; },
    },
  };
}

function fakeReply() {
  return {
    _code: 200,
    _body: null,
    code(c) { this._code = c; return this; },
    send(b) { this._body = b; return this; },
  };
}

function makeSetup(tag, cfgOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-review-" + tag + "-"));
  const cfg = {
    paths: {
      collection: "memory_v2.json",
      review_queue: "memory_review_queue.json",
      shadow_collection: "memory_v2_shadow.json",
      shadow_queue: "memory_review_queue_shadow.json",
    },
    ...cfgOverrides,
  };
  const admission = createAdmission({ rootDir: tmpDir, config: cfg });
  const { app, handlers } = makeFakeApp();
  registerReviewRoutes(app, { basicAuth: async () => {}, admission });
  return { admission, handlers, tmpDir, cfg };
}

async function queueList(handlers) {
  const reply = fakeReply();
  await handlers["GET /admin/memory-review/queue"]({ params: {}, query: {}, body: null }, reply);
  return reply;
}

function baseCfg() {
  return {
    paths: {
      collection: "memory_v2.json",
      review_queue: "memory_review_queue.json",
      shadow_collection: "memory_v2_shadow.json",
      shadow_queue: "memory_review_queue_shadow.json",
    },
  };
}

const cases = [
  ["review 列表：候选摘要/provenance/reasons/audit_id 齐备", async () => {
    const { admission, handlers, tmpDir } = makeSetup("list", { v2_enabled: true });
    const sub = admission.submitV2({ content: "涵：「只能我先说晚安」", category: "拓本", quote: "只能我先说晚安" });
    assert.strictEqual(sub.action, "review", JSON.stringify(sub));
    const reply = await queueList(handlers);
    assert.strictEqual(reply._code, 200);
    assert.strictEqual(reply._body.total, 1);
    const item = reply._body.items[0];
    assert.strictEqual(item.id, sub.queue_id);
    assert.strictEqual(item.candidate.text, "涵：「只能我先说晚安」");
    assert.strictEqual(item.candidate.kind, "quote");
    assert.strictEqual(item.candidate.speaker, "user");
    assert.ok(item.provenance && item.provenance.method === "admin_form");
    assert.ok(item.audit_id, "audit_id 已关联");
    assert.ok(Array.isArray(item.reasons) && item.reasons.length > 0, "reasons 可见");
    fs.removeSync(tmpDir);
  }],

  ["approve：经 state_executor 落 memory_v2，队列清空，审计记 review_approved", async () => {
    const { admission, handlers, tmpDir } = makeSetup("approve", { v2_enabled: true });
    const sub = admission.submitV2({ content: "涵：「只能我先说晚安」", category: "拓本", quote: "只能我先说晚安" });
    const reply = fakeReply();
    await handlers["POST /admin/memory-review/queue/:id/approve"]({ params: { id: sub.queue_id }, body: {} }, reply);
    assert.strictEqual(reply._code, 200);
    assert.strictEqual(reply._body.entry_id, sub.entry_id || reply._body.entry_id);
    const coll = fs.readJsonSync(admission.paths.main.collection);
    assert.strictEqual(coll.length, 1, "正式集合落库");
    assert.strictEqual(coll[0].status, "active");
    assert.strictEqual(admission.executorMain.listQueue().length, 0, "队列清空");
    const audits = requireAudit(admission);
    assert.ok(audits.some((x) => x.action === "review_approved"), "裁决进审计");
    fs.removeSync(tmpDir);
  }],

  ["reject：记录 reason、移出队列、主集合不变、审计记 review_rejected", async () => {
    const { admission, handlers, tmpDir } = makeSetup("rejectq", { v2_enabled: true });
    const sub = admission.submitV2({ content: "涵：「你是我的锚」", category: "拓本", quote: "你是我的锚" });
    const reply = fakeReply();
    await handlers["POST /admin/memory-review/queue/:id/reject"]({ params: { id: sub.queue_id }, body: { note: "AI 台词存疑" } }, reply);
    assert.strictEqual(reply._code, 200);
    assert.strictEqual(reply._body.action, "rejected_by_review");
    assert.strictEqual(admission.executorMain.listQueue().length, 0, "已移出队列");
    const mainColl = admission.paths.main.collection;
    assert.strictEqual(fs.existsSync(mainColl) ? fs.readJsonSync(mainColl).length : 0, 0, "主集合不变");
    const audits = requireAudit(admission);
    assert.ok(audits.some((x) => x.action === "review_rejected" && x.notes.note === "AI 台词存疑"));
    fs.removeSync(tmpDir);
  }],

  ["audit 关联：队列记录的 audit_id 能回查到审计行", async () => {
    const { admission, tmpDir } = makeSetup("link", { v2_enabled: true });
    const sub = admission.submitV2({ content: "涵：「给我亲一口」", category: "拓本", quote: "给我亲一口" });
    const audits = requireAudit(admission);
    const line = audits.find((x) => x.id === sub.audit_id);
    assert.ok(line, "audit_id 对应审计行存在");
    const queue = admission.executorMain.listQueue()[0];
    assert.strictEqual(queue.audit_id, sub.audit_id);
    fs.removeSync(tmpDir);
  }],

  ["v2 关闭无影响：submitV2 → skipped_v2_off，零文件落地", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-review-off-"));
    const admission = createAdmission({ rootDir: tmpDir, config: baseCfg() });
    const r = admission.submitV2({ content: "她喝奶茶只要三分糖", category: "关于她" });
    assert.strictEqual(r.action, "skipped_v2_off");
    assert.strictEqual(fs.readdirSync(tmpDir).filter((f) => f.includes("memory_v2") || f.includes("memory_review") || f.includes("memory_audit")).length, 0, "零落地");
    fs.removeSync(tmpDir);
  }],

  ["v2 开启正式旁路：旧池继续写由旧路由恒执行保证，V2 落主集合", () => {
    const { admission, tmpDir } = makeSetup("formal", { v2_enabled: true });
    const r = admission.submitV2({ content: "她喝奶茶只要三分糖", category: "关于她", importance: 0.9 });
    assert.strictEqual(r.action, "admit");
    assert.strictEqual(r.mode, "formal");
    assert.strictEqual(fs.readJsonSync(admission.paths.main.collection).length, 1);
    assert.strictEqual(fs.existsSync(admission.paths.shadow.collection), false, "正式模式不写影子");
    fs.removeSync(tmpDir);
  }],

  ["v2 影子旁路：enabled=false + shadow=true → 只写影子", () => {
    const { admission, tmpDir } = makeSetup("shadowside", { v2_shadow: true });
    const r = admission.submitV2({ content: "她喝奶茶只要三分糖", category: "关于她" });
    assert.strictEqual(r.action, "admit");
    assert.strictEqual(r.mode, "shadow");
    assert.strictEqual(fs.readJsonSync(admission.paths.shadow.collection).length, 1);
    assert.strictEqual(fs.existsSync(admission.paths.main.collection), false, "主集合不动");
    fs.removeSync(tmpDir);
  }],

  ["旧池守卫：全流程不产生旧池/pinned 文件", () => {
    const { admission, tmpDir } = makeSetup("oldpool", { v2_enabled: true });
    admission.submitV2({ content: "她喜欢猫", category: "关于她" });
    admission.submitV2({ content: "涵：「你是我的锚」", category: "拓本", quote: "你是我的锚" });
    const all = fs.readdirSync(tmpDir);
    assert.ok(!all.some((f) => f.includes("memory_pool") || f.includes("pinned")), "旧池/pinned 零接触: " + all.join(","));
    fs.removeSync(tmpDir);
  }],

  ["admission 未初始化：review 路由 503（V2 停用不影响旧池）", async () => {
    const { app, handlers } = makeFakeApp();
    registerReviewRoutes(app, { basicAuth: async () => {}, admission: null });
    const reply = fakeReply();
    await handlers["GET /admin/memory-review/queue"]({ params: {}, body: null }, reply);
    assert.strictEqual(reply._code, 503);
    const reply2 = fakeReply();
    await handlers["POST /admin/memory-review/queue/:id/approve"]({ params: { id: "x" }, body: null }, reply2);
    assert.strictEqual(reply2._code, 503);
  }],

  ["路由字段完备：queue 接口注册齐全", () => {
    const { handlers } = makeSetup("routes", { v2_enabled: true });
    for (const key of [
      "GET /admin/memory-review/queue",
      "POST /admin/memory-review/queue/:id/approve",
      "POST /admin/memory-review/queue/:id/reject",
    ]) assert.ok(handlers[key], "缺路由: " + key);
  }],
];

function requireAudit(admission) {
  const dir = path.join(admission.paths.main.collection, "..", "data");
  const f = fs.readdirSync(dir).filter((x) => x.startsWith("memory_audit_")).map((x) => path.join(dir, x))[0];
  assert.ok(f, "审计文件应存在");
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

(async () => {
  let passN = 0, failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      passN++;
      console.log("PASS " + name);
    } catch (err) {
      failed++;
      console.log("FAIL " + name + " :: " + err.message);
    }
  }
  console.log(`\ntest_review: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
  process.exit(failed ? 1 : 0);
})();
