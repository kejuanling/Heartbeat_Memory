"use strict";

// ========================
// Memory V2 C1 单测：存储层（CRUD / 原子写 / 状态机 / 隔离）
// 运行：node tests/memory-v2/test_storage.js
// 纪律：全部数据落在 os.tmpdir() 随机目录，不碰生产 data/
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const mv2 = require("../../memory-v2");

function makeTmpStore(tag) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-test-" + tag + "-"));
  const store = mv2.createStore({
    rootDir: tmpDir,
    config: { paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json" } },
  });
  return { store, tmpDir };
}

function baseFact(text, overrides = {}) {
  return {
    text: text || "她喝奶茶只要三分糖",
    kind: "fact",
    subject: "user",
    origin: "manual",
    provenance: { method: "admin_form" },
    ...overrides,
  };
}

const cases = [
  ["空库创建：init 生成空集合与空队列文件，list 为空", () => {
    const { store, tmpDir } = makeTmpStore("empty");
    assert.strictEqual(fs.existsSync(store.paths.collection), false, "init 前文件不存在");
    store.init();
    assert.strictEqual(fs.existsSync(store.paths.collection), true);
    assert.strictEqual(fs.existsSync(store.paths.review_queue), true);
    assert.deepStrictEqual(fs.readJsonSync(store.paths.collection), []);
    assert.deepStrictEqual(fs.readJsonSync(store.paths.review_queue), []);
    assert.deepStrictEqual(store.list(), [], "空库 list 返回空数组");
    assert.strictEqual(store.stats().total, 0);
    fs.removeSync(tmpDir);
  }],

  ["写入与读取：create→get 往返一致", () => {
    const { store, tmpDir } = makeTmpStore("crud");
    const r = store.create(baseFact("她习惯白天睡、半夜醒着", { kind: "fact" }));
    assert.strictEqual(r.ok, true, r.error);
    const got = store.get(r.entry.id);
    assert.ok(got, "get 应命中");
    assert.strictEqual(got.text, "她习惯白天睡、半夜醒着");
    assert.strictEqual(got.kind, "fact");
    assert.ok(!("subject" in got), "subject 已删");
    assert.strictEqual(got.status, "active");
    assert.strictEqual(got.confidence, 0.8);
    assert.strictEqual(store.get("mv2_nonexistent"), null, "未命中返回 null");
    fs.removeSync(tmpDir);
  }],

  ["原子写与落盘：写穿透即时落盘、无 .tmp 残留、新实例可重载", () => {
    const { store, tmpDir } = makeTmpStore("atomic");
    const r1 = store.create(baseFact("第一条"));
    const r2 = store.create(baseFact("第二条"));
    assert.strictEqual(r1.ok && r2.ok, true);
    // 无 .tmp 残留
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    assert.deepStrictEqual(leftovers, [], "原子写不应留下 .tmp 文件");
    // 文件是合法 JSON 且含两条
    const onDisk = fs.readJsonSync(store.paths.collection);
    assert.strictEqual(onDisk.length, 2);
    // 新实例（模拟进程重启）能重载
    const store2 = mv2.createStore({
      rootDir: tmpDir,
      config: { paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json" } },
    });
    assert.strictEqual(store2.list().length, 2, "重启后数据仍在");
    assert.strictEqual(store2.get(r1.entry.id).text, "第一条");
    fs.removeSync(tmpDir);
  }],

  ["list 过滤：kind/status/limit，最新在前（subject 已删：传入过滤不生效）", () => {
    const { store, tmpDir } = makeTmpStore("list");
    store.create(baseFact("fact-user-1"));
    store.create(baseFact("rule-user", { kind: "rule" }));
    store.create(baseFact("fact-self"));
    assert.strictEqual(store.list().length, 3);
    assert.strictEqual(store.list({ kind: "fact" }).length, 2);
    assert.strictEqual(store.list({ subject: "self" }).length, 0, "subject 已删：按它过滤恒 0");
    assert.strictEqual(store.list({ kind: "rule" }).length, 1);
    assert.strictEqual(store.list({ status: "active" }).length, 3);
    assert.strictEqual(store.list({ status: "superseded" }).length, 0);
    const top2 = store.list({ limit: 2 });
    assert.strictEqual(top2.length, 2);
    assert.strictEqual(top2[0].text, "fact-self", "最新创建的排最前");
    fs.removeSync(tmpDir);
  }],

  ["状态机合法迁移：active→superseded（字段齐备）", () => {
    const { store, tmpDir } = makeTmpStore("t-supersede");
    const r = store.create(baseFact("她习惯白天睡、半夜醒着"));
    const u = store.updateStatus(r.entry.id, "superseded", { reason: "updated", supersededBy: ["mv2_newid123"] });
    assert.strictEqual(u.ok, true, u.error);
    assert.strictEqual(u.entry.status, "superseded");
    assert.strictEqual(u.entry.superseded_reason, "updated");
    assert.ok(u.entry.superseded_at, "superseded_at 已写入");
    assert.deepStrictEqual(u.entry.superseded_by, ["mv2_newid123"]);
    assert.strictEqual(u.entry.content_updated_at, r.entry.content_updated_at, "状态迁移不动正文时间");
    fs.removeSync(tmpDir);
  }],

  ["状态机非法迁移：缺 reason / reason 越界 / 回退 / 同态 / 非法值", () => {
    const { store, tmpDir } = makeTmpStore("t-illegal");
    const a = store.create(baseFact("条目A"));
    const id = a.entry.id;
    assert.strictEqual(store.updateStatus(id, "superseded", {}).ok, false, "缺 reason 拒绝");
    assert.strictEqual(store.updateStatus(id, "superseded", { reason: "archived" }).ok, false, "reason 越界拒绝");
    assert.strictEqual(store.updateStatus(id, "active", {}).ok, false, "active→active 同态拒绝");
    assert.strictEqual(store.updateStatus(id, "pending_review", {}).ok, false, "pending_review 不是集合状态");
    assert.strictEqual(store.updateStatus("mv2_nonexistent", "archived", {}).ok, false, "not_found");
    const s = store.updateStatus(id, "superseded", { reason: "updated" });
    assert.strictEqual(s.ok, true, s.error);
    assert.strictEqual(store.updateStatus(id, "active", {}).ok, false, "superseded→active 禁止（历史不可复活）");
    fs.removeSync(tmpDir);
  }],

  ["状态机全链：active→archived→active（revive 清空字段）", () => {
    const { store, tmpDir } = makeTmpStore("t-arch");
    const a = store.create(baseFact("写错了的条目"));
    const arch = store.updateStatus(a.entry.id, "archived", { reason: "retracted" });
    assert.strictEqual(arch.ok, true, arch.error);
    assert.strictEqual(arch.entry.status, "archived");
    assert.strictEqual(arch.entry.superseded_reason, "retracted");
    const revive = store.updateStatus(a.entry.id, "active", {});
    assert.strictEqual(revive.ok, true, revive.error);
    assert.strictEqual(revive.entry.status, "active");
    assert.strictEqual(revive.entry.superseded_reason, null, "revive 清空原因");
    assert.strictEqual(revive.entry.superseded_at, null);
    assert.strictEqual(revive.entry.superseded_by, null);
    fs.removeSync(tmpDir);
  }],

  ["superseded→archived 允许（归档不删除）", () => {
    const { store, tmpDir } = makeTmpStore("t-sup-arch");
    const a = store.create(baseFact("旧作息"));
    store.updateStatus(a.entry.id, "superseded", { reason: "updated" });
    const r = store.updateStatus(a.entry.id, "archived", { reason: "archived" });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.entry.status, "archived");
    fs.removeSync(tmpDir);
  }],

  ["迁移持久化：updateStatus 后新实例读到的是新状态", () => {
    const { store, tmpDir } = makeTmpStore("t-persist");
    const a = store.create(baseFact("持久化检查"));
    store.updateStatus(a.entry.id, "archived", { reason: "archived" });
    const store2 = mv2.createStore({
      rootDir: tmpDir,
      config: { paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json" } },
    });
    assert.strictEqual(store2.get(a.entry.id).status, "archived", "状态变更已落盘");
    fs.removeSync(tmpDir);
  }],

  ["只读守卫：readonly 实例拒绝一切写入", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-test-ro-"));
    const store = mv2.createStore({
      rootDir: tmpDir,
      readonly: true,
      config: { paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json" } },
    });
    assert.strictEqual(store.readonly, true);
    const r = store.create(baseFact("不该被写入"));
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("readonly"), r.error);
    assert.strictEqual(fs.existsSync(store.paths.collection), false, "只读模式不产生文件");
    fs.removeSync(tmpDir);
  }],

  ["损坏隔离：坏 JSON 触发隔离备份并大声失败，不静默清空", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-test-corrupt-"));
    const coll = path.join(tmpDir, "memory_v2.json");
    fs.writeFileSync(coll, "{ broken json !!!");
    const store = mv2.createStore({
      rootDir: tmpDir,
      config: { paths: { collection: "memory_v2.json", review_queue: "memory_review_queue.json" } },
    });
    let threw = null;
    try { store.list(); } catch (err) { threw = err; }
    assert.ok(threw, "损坏集合必须抛错");
    assert.ok(threw.message.includes("损坏"), threw.message);
    const isolated = fs.readdirSync(tmpDir).filter((f) => f.includes(".corrupt-"));
    assert.strictEqual(isolated.length, 1, "坏文件已隔离备份");
    fs.removeSync(tmpDir);
  }],
];

let pass = 0, failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    pass++;
    console.log("PASS " + name);
  } catch (err) {
    failed++;
    console.log("FAIL " + name + " :: " + err.message);
  }
}
console.log(`\ntest_storage: ${pass} passed, ${failed} failed（共 ${cases.length} 例）`);
process.exit(failed ? 1 : 0);
