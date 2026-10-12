"use strict";

// ========================
// Memory V2 C4 集成测试：Admission Pipeline 骨架（manual 入口 · shadow 影子写入）
// 运行：node tests/admission-pipeline/test_pipeline.js
// 纪律：全部落在 os.tmpdir() 随机目录；断言主集合/旧池零写入
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createAdmission } = require("../../memory-admission");

function makeTmpAdmission(tag, extraConfig = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-pipeline-" + tag + "-"));
  const adm = createAdmission({
    rootDir: tmpDir,
    config: {
      v2_shadow: true,
      paths: {
        collection: "memory_v2.json",
        review_queue: "memory_review_queue.json",
        shadow_collection: "memory_v2_shadow.json",
        shadow_queue: "memory_review_queue_shadow.json",
      },
      ...extraConfig,
    },
  });
  return { adm, tmpDir };
}

const cases = [
  ["成功 admit：旧式 body 翻译→影子集合落库，主集合零写入", async () => {
    const { adm, tmpDir } = makeTmpAdmission("admit");
    const r = await adm.submitManual({ content: "她喝奶茶只要三分糖", category: "关于她", importance: 0.9 });
    assert.strictEqual(r.action, "admit", JSON.stringify(r));
    assert.ok(r.entry_id, "有 entry_id");
    assert.strictEqual(r.candidate.kind, "fact", "关于她→fact");
    assert.ok(!("subject" in r.candidate), "subject 已删");
    // 影子集合有货
    const shadow = fs.readJsonSync(adm.paths.shadow.collection);
    assert.strictEqual(shadow.length, 1);
    assert.strictEqual(shadow[0].status, "active");
    assert.strictEqual(shadow[0].origin, "manual");
    assert.strictEqual(shadow[0].provenance.method, "admin_form");
    // 主集合零写入（单轨制：旧路径未动、主集合未启用）
    assert.strictEqual(fs.existsSync(adm.paths.main.collection), false, "主集合文件不应被创建");
    fs.removeSync(tmpDir);
  }],

  ["validator reject：隐私手机号拒绝、影子集合不动、审计记 V1", async () => {
    const { adm, tmpDir } = makeTmpAdmission("reject");
    const r = await adm.submitManual({ content: "她手机13812345678开机了", category: "关于她" });
    assert.strictEqual(r.action, "reject");
    assert.ok(r.validation.matched_rules.includes("V1"), JSON.stringify(r.validation));
    assert.strictEqual(shadowCount(adm), 0, "影子集合保持为空");
    const audits = requireAudit(adm);
    assert.ok(audits[0].validator.matched_rules.includes("V1"));
    fs.removeSync(tmpDir);
  }],

  ["review queue：显式挂起 → 队列文件有 pending 记录（1002-14：quote 自动挂起路径随分类删除）", async () => {
    const { adm, tmpDir } = makeTmpAdmission("review");
    const r = adm.executor.review(
      { text: "涵：「只能我先说晚安」", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form", quote: "只能我先说晚安" } },
      "1002-14 显式挂起"
    );
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.queue_id, "有 queue_id");
    const queue = fs.readJsonSync(adm.paths.shadow.review_queue);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].status, "pending_review");
    assert.strictEqual(queue[0].draft.kind, "fact");
    assert.ok(!("subject" in queue[0].draft), "subject 已删");
    assert.strictEqual(shadowCount(adm), 0, "挂起不进集合");
    fs.removeSync(tmpDir);
  }],

  ["review 回流：approve → 直通落集合；reject_with_reason → 移出队列", async () => {
    const { adm, tmpDir } = makeTmpAdmission("resolve");
    const r1 = adm.executor.review(
      { text: "涵：「只能我先说晚安」", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form", quote: "只能我先说晚安" } },
      "1002-14 显式挂起"
    );
    const ok = adm.executor.resolveQueue(r1.queue_id, "approve");
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(fs.readJsonSync(adm.paths.shadow.collection).length, 1, "approve 后落集合");
    assert.strictEqual(adm.executor.listQueue().length, 0, "队列清空");
    const r2 = adm.executor.review(
      { text: "涵：「你是我的锚」", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form", quote: "你是我的锚" } },
      "1002-14 显式挂起"
    );
    const rj = adm.executor.resolveQueue(r2.queue_id, "reject_with_reason", { note: "AI 台词存疑" });
    assert.strictEqual(rj.ok, true);
    assert.strictEqual(fs.readJsonSync(adm.paths.shadow.collection).length, 1, "驳回不落集合");
    fs.removeSync(tmpDir);
  }],

  ["audit 生成：audit_id 可回查，行含 ts/hash/shadow 标记", async () => {
    const { adm, tmpDir } = makeTmpAdmission("audit");
    const r = await adm.submitManual({ content: "她习惯睡前看书", category: "关于她" });
    assert.ok(r.audit_id, "返回 audit_id");
    const audits = requireAudit(adm);
    const line = audits.find((x) => x.id === r.audit_id);
    assert.ok(line, "audit_id 能回查到审计行");
    assert.strictEqual(line.action, "admit");
    assert.ok(line.ts && line.candidate_hash.startsWith("sha256:"));
    assert.strictEqual(line.notes.shadow, true, "影子标记在场");
    assert.strictEqual(line.notes.kind, "fact");
    fs.removeSync(tmpDir);
  }],

  ["state 变化：executor.setStatus 经状态机校验（非法迁移拒绝）", async () => {
    const { adm, tmpDir } = makeTmpAdmission("state");
    const r = await adm.submitManual({ content: "她习惯睡前看书", category: "关于她" });
    const bad = adm.executor.setStatus(r.entry_id, "active", {});
    assert.strictEqual(bad.ok, false, "active→active 同态拒绝");
    const arch = adm.executor.setStatus(r.entry_id, "archived", { reason: "archived" });
    assert.strictEqual(arch.ok, true, arch.error);
    const shadow = fs.readJsonSync(adm.paths.shadow.collection);
    assert.strictEqual(shadow[0].status, "archived");
    fs.removeSync(tmpDir);
  }],

  ["重启持久化：新 admission 实例读到影子集合与队列", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-pipeline-persist-"));
    const cfg = {
      v2_shadow: true,
      paths: {
        collection: "memory_v2.json",
        review_queue: "memory_review_queue.json",
        shadow_collection: "memory_v2_shadow.json",
        shadow_queue: "memory_review_queue_shadow.json",
      },
    };
    const adm1 = createAdmission({ rootDir: tmpDir, config: cfg });
    await adm1.submitManual({ content: "她习惯睡前看书", category: "关于她" });
    const r = adm1.executor.review(
      { text: "涵：「你是我的锚」", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form", quote: "你是我的锚" } },
      "1002-14 显式挂起"
    );
    // 模拟重启
    const adm2 = createAdmission({ rootDir: tmpDir, config: cfg });
    assert.strictEqual(fs.readJsonSync(adm2.paths.shadow.collection).length, 1, "影子集合持久化");
    assert.strictEqual(adm2.executor.listQueue().length, 1, "队列持久化");
    assert.strictEqual(adm2.executor.listQueue()[0].id, r.queue_id);
    fs.removeSync(tmpDir);
  }],

  ["memory_add 快速入待审：不等待门卫且不直入正式池，后台评分后安全补写", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-pipeline-memory-add-"));
    let releaseJudge;
    let calls = 0;
    const adm = createAdmission({
      rootDir: tmpDir,
      config: {
        v2_enabled: true, v2_shadow: false, judge_mode: "llm",
        paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json", shadow_collection: "memory_v2_shadow.json", shadow_queue: "memory_review_queue_shadow.json" },
      },
      callLLM: () => { calls++; return new Promise(resolve => { releaseJudge = resolve; }); },
    });
    const started = Date.now();
    const r = adm.submitMemoryAdd({ content: "用户喜欢睡前听故事", kind: "fact" }, { sessionId: "session-memory-add-test" });
    assert.ok(Date.now() - started < 500, "提交阶段不能等待 LLM");
    assert.strictEqual(r.action, "review");
    assert.ok(r.queue_id);
    let q = fs.readJsonSync(adm.paths.main.review_queue);
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].judge_status, "pending");
    assert.strictEqual(q[0].draft.source_session, "session-memory-add-test");
    assert.strictEqual(fs.existsSync(adm.paths.main.collection) ? fs.readJsonSync(adm.paths.main.collection).length : 0, 0, "memory_add 不得直入正式池");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(calls >= 1, "后台应启动门卫评分");
    // 在门卫返回前人工驳回，迟到评分不得复活/重写已裁决记录。
    const rejected = adm.resolveReview(r.queue_id, "reject_with_reason", { note: "test race" });
    assert.strictEqual(rejected.ok, true);
    releaseJudge(JSON.stringify({ relation: "need_review", confidence: 0.7, worth: 0.8, worth_reason: "useful", volatility: "stable", volatility_reason: "stable", suggested_kind: "fact", suggested_kind_reason: "test" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    q = fs.readJsonSync(adm.paths.main.review_queue);
    assert.strictEqual(q.some(x => x.id === r.queue_id), false, "人工驳回后评分结果不得重新写回队列");
    assert.strictEqual(fs.existsSync(adm.paths.main.collection) ? fs.readJsonSync(adm.paths.main.collection).length : 0, 0, "驳回不入正式池");
    adm.stopMemoryAddJudgeWorker();
    fs.removeSync(tmpDir);
  }],

  ["v2_shadow=false → 跳过不写任何文件", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-pipeline-off-"));
    const adm = createAdmission({
      rootDir: tmpDir,
      config: {
        v2_shadow: false,
        paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json", shadow_collection: "memory_v2_shadow.json", shadow_queue: "memory_review_queue_shadow.json" },
      },
    });
    const r = await adm.submitManual({ content: "她喝奶茶只要三分糖", category: "关于她" });
    assert.strictEqual(r.action, "skipped_shadow_off");
    assert.strictEqual(fs.readdirSync(tmpDir).filter((f) => f.includes("memory_v2") || f.includes("memory_review")).length, 0, "零文件落地");
    fs.removeSync(tmpDir);
  }],

  ["无分类进待审：kind=null 放行（1007 detector 移除），approve 前必须补分类", async () => {
    const { adm, tmpDir } = makeTmpAdmission("nokind");
    const r = await adm.submitManual({ content: "今天好累啊" });
    // validator 放行（V7 对 kind null 不再拒），action 走到 admit 但存储层拒绝 kind null
    assert.strictEqual(r.validation.allowed, true, JSON.stringify(r.validation));
    assert.ok(!r.entry_id, "kind null 不应入库");
    // 显式挂起进队列后可正常 approve（kind 已补）
    const q1 = adm.executor.review(
      { text: "今天好累啊", kind: "event", origin: "manual", provenance: { method: "admin_form" } },
      "1007 测试"
    );
    const ok = adm.executor.resolveQueue(q1.queue_id, "approve");
    assert.strictEqual(ok.ok, true, ok.error);
    fs.removeSync(tmpDir);
  }],

  ["旧池守卫：整套流程不触碰旧池文件", async () => {
    const { adm, tmpDir } = makeTmpAdmission("oldpool");
    adm.submitManual({ content: "她喝奶茶只要三分糖", category: "关于她" });
    adm.submitManual({ content: "涵：「只能我先说晚安」", category: "拓本" });
    const all = fs.readdirSync(tmpDir);
    assert.ok(!all.some((f) => f.includes("memory_pool")), "旧池文件不应出现");
    assert.ok(!all.some((f) => f.includes("pinned")), "pinned 不应出现");
    fs.removeSync(tmpDir);
  }],
];

function shadowCount(adm) {
  const f = adm.paths.shadow.collection;
  return fs.existsSync(f) ? fs.readJsonSync(f).length : 0;
}

function requireAudit(adm) {
  const dir = path.join(adm.paths.main.collection, "..", "data");
  const f = fs.readdirSync(dir).filter((x) => x.startsWith("memory_audit_")).map((x) => path.join(dir, x))[0];
  assert.ok(f, "审计文件应存在");
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let passN = 0, failed = 0;
(async () => {
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
console.log(`\ntest_pipeline: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
})();
