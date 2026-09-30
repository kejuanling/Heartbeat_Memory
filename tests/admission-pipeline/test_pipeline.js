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
    assert.strictEqual(r.candidate.subject, "user");
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

  ["review queue：quote 无 judge 复核 → 挂起，队列文件有 pending 记录", async () => {
    const { adm, tmpDir } = makeTmpAdmission("review");
    const r = await adm.submitManual({ content: "涵：「只能我先说晚安」", category: "拓本", quote: "只能我先说晚安" });
    assert.strictEqual(r.action, "review", JSON.stringify(r));
    assert.ok(r.queue_id, "有 queue_id");
    const queue = fs.readJsonSync(adm.paths.shadow.review_queue);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].status, "pending_review");
    assert.strictEqual(queue[0].draft.kind, "quote");
    assert.strictEqual(queue[0].draft.subject, "user");
    assert.strictEqual(queue[0].draft.speaker, "user");
    assert.strictEqual(shadowCount(adm), 0, "挂起不进集合");
    fs.removeSync(tmpDir);
  }],

  ["review 回流：approve → 直通落集合；reject_with_reason → 移出队列", async () => {
    const { adm, tmpDir } = makeTmpAdmission("resolve");
    const r1 = await adm.submitManual({ content: "涵：「只能我先说晚安」", category: "拓本", quote: "只能我先说晚安" });
    const ok = adm.executor.resolveQueue(r1.queue_id, "approve");
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(fs.readJsonSync(adm.paths.shadow.collection).length, 1, "approve 后落集合");
    assert.strictEqual(adm.executor.listQueue().length, 0, "队列清空");
    const r2 = await adm.submitManual({ content: "涵：「你是我的锚」", category: "拓本", quote: "你是我的锚" });
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
    assert.strictEqual(line.notes.detector_kind, "fact");
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
    const r = await adm1.submitManual({ content: "涵：「你是我的锚」", category: "拓本", quote: "你是我的锚" });
    // 模拟重启
    const adm2 = createAdmission({ rootDir: tmpDir, config: cfg });
    assert.strictEqual(fs.readJsonSync(adm2.paths.shadow.collection).length, 1, "影子集合持久化");
    assert.strictEqual(adm2.executor.listQueue().length, 1, "队列持久化");
    assert.strictEqual(adm2.executor.listQueue()[0].id, r.queue_id);
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

  ["非候选拒绝：当日状态不产候选（无 category 时 detector 层拒绝）", async () => {
    const { adm, tmpDir } = makeTmpAdmission("noncand");
    const r = await adm.submitManual({ content: "今天好累啊" });
    assert.strictEqual(r.action, "reject");
    assert.ok(r.validation.matched_rules.includes("DET.not_candidate"));
    assert.strictEqual(shadowCount(adm), 0);
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
