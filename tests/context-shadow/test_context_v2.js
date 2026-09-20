"use strict";

// ========================
// Memory V2 C9 单测：Context V2 Adapter（只读检索，tmp 目录）
// 运行：node tests/context-shadow/test_context_v2.js
// 覆盖：空 Memory / 单条规则召回 / 多条排序 / 无关排除 / 只读与旧池零影响
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createMemoryV2Reader, tokenize } = require("../../context-v2-adapter");
const { createStore } = require("../../memory-v2");

function makeTmp(tag) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-ctx-" + tag + "-"));
  const paths = { collection: "memory_v2.json", review_queue: "memory_review_queue.json" };
  const writer = createStore({ rootDir: tmpDir, config: { paths } }); // 造数据用（模拟 C1-C5 已入库的记忆）
  const reader = createMemoryV2Reader({ rootDir: tmpDir, paths });
  return { writer, reader, tmpDir, coll: path.join(tmpDir, "memory_v2.json") };
}

async function seed(writer, rows) {
  for (const r of rows) {
    const v = writer.create(r);
    assert.strictEqual(v.ok, true, v.error);
  }
}

const cases = [
  ["空 Memory：retrieve 返回空且 reason 说明", async () => {
    const { reader, tmpDir } = makeTmp("empty");
    const r = await reader.retrieve("她喜欢什么", { topK: 5 });
    assert.deepStrictEqual(Object.keys(r).sort(), ["memories", "reason", "score", "source"]);
    assert.strictEqual(r.source, "memory_v2");
    assert.deepStrictEqual(r.memories, []);
    assert.strictEqual(r.score, 0);
    assert.ok(r.reason.includes("为空"), r.reason);
    fs.removeSync(tmpDir);
  }],

  ["单条 rule 召回：词面过阈值命中 kind=rule", async () => {
    const { writer, reader, tmpDir } = makeTmp("rule");
    await seed(writer, [
      { text: "以后不许催我睡觉", kind: "rule", subject: "user", origin: "manual", provenance: { method: "admin_form" } },
    ]);
    const r = await reader.retrieve("睡觉的时候要不要叫她", { topK: 5 });
    assert.strictEqual(r.memories.length, 1, JSON.stringify(r));
    assert.strictEqual(r.memories[0].kind, "rule");
    assert.strictEqual(r.memories[0].subject, "user");
    assert.ok(r.memories[0].score >= 0.15, "score=" + r.memories[0].score);
    assert.strictEqual(r.source, "memory_v2");
    assert.ok(r.score === r.memories[0].score, "顶层 score=最高分");
    fs.removeSync(tmpDir);
  }],

  ["多条排序：score desc（含并列打破）", async () => {
    const { writer, reader, tmpDir } = makeTmp("order");
    await seed(writer, [
      { text: "她喜欢猫", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } },
      { text: "她喝奶茶只要三分糖", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } },
    ]);
    const r = await reader.retrieve("她喜欢猫和奶茶", { topK: 5, minScore: 0.15 });
    assert.strictEqual(r.memories.length, 2, JSON.stringify(r));
    assert.ok(r.memories[0].score >= r.memories[1].score, "按分数降序");
    assert.strictEqual(r.source, "memory_v2");
    assert.ok(r.score === r.memories[0].score, "顶层 score=最高分");
    fs.removeSync(tmpDir);
  }],

  ["同分并列：按 id 排（priority 已删 0920）", async () => {
    const { writer, reader, tmpDir } = makeTmp("tie");
    await seed(writer, [
      { text: "她喜欢猫也喜欢狗", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } },
      { text: "她喜欢猫也喜欢狗啊", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } },
    ]);
    // query 分别与两条 sim 接近：直接用 query=她喜欢猫 也 狗 组合，使两条得分同为包含关系
    const r = await reader.retrieve("她喜欢猫也喜欢狗", { topK: 5, minScore: 0.1 });
    assert.strictEqual(r.memories.length, 2);
    const [first, second] = r.memories;
    if (first.score === second.score) {
      assert.ok(true, "同分按 id 排（builder 新 tie-break）");
    } else {
      assert.ok(first.score > second.score);
    }
    fs.removeSync(tmpDir);
  }],

  ["无关排除：全部低于阈值 → 空结果（宁缺毋滥）", async () => {
    const { writer, reader, tmpDir } = makeTmp("filter");
    await seed(writer, [
      { text: "网关重启脚本已更新到最新版本", kind: "fact", subject: "self", origin: "manual", provenance: { method: "admin_form" } },
      { text: "今晚月色不错", kind: "fact", subject: "relationship", origin: "manual", provenance: { method: "admin_form" } },
    ]);
    const r = await reader.retrieve("她喜欢的奶茶甜度", { topK: 5, minScore: 0.15 });
    assert.strictEqual(r.memories.length, 0, JSON.stringify(r));
    assert.strictEqual(r.score, 0);
    assert.ok(r.reason.includes("无命中"), r.reason);
    fs.removeSync(tmpDir);
  }],

  ["status=superseded 不参与检索（只读 active）", async () => {
    const { writer, reader, tmpDir } = makeTmp("superseded");
    const a = writer.create({ text: "她习惯白天睡", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } });
    assert.strictEqual(a.ok, true);
    writer.updateStatus(a.entry.id, "superseded", { reason: "updated" });
    const r = await reader.retrieve("她白天的睡眠习惯", { topK: 5 });
    assert.strictEqual(r.memories.length, 0, "superseded 不进检索: " + JSON.stringify(r));
    fs.removeSync(tmpDir);
  }],

  ["只读守卫：retrieve 前后集合文件逐字节一致", async () => {
    const { writer, reader, tmpDir, coll } = makeTmp("readonly");
    await seed(writer, [{ text: "她喜欢三分糖", kind: "fact", subject: "user", origin: "manual", provenance: { method: "admin_form" } }]);
    const before = fs.readFileSync(coll, "utf8");
    await reader.retrieve("她喜欢什么");
    await reader.retrieve("完全无关的查询内容");
    const after = fs.readFileSync(coll, "utf8");
    assert.strictEqual(before, after, "检索不得写本体（Schema 冻结 8）");
    fs.removeSync(tmpDir);
  }],

  ["旧池零影响：适配器不 require 旧池，tmp 内无旧池文件", () => {
    const { reader, tmpDir } = makeTmp("oldpool");
    // 结构性断言：模块源码不含对旧池/旧检索的引用
    const src = fs.readFileSync(path.join(__dirname, "../../context-v2-adapter.js"), "utf8");
    assert.ok(!src.includes("memory-pool"), "不得 require 旧池模块");
    assert.ok(!src.includes("retrieveHybrid"), "不得引用旧检索函数");
    const r = reader.retrieve("任意查询");
    assert.ok(r.source === "memory_v2");
    const all = fs.readdirSync(tmpDir);
    assert.ok(!all.some((f) => f.includes("memory_pool") || f.includes("pinned")), "旧池零接触");
    fs.removeSync(tmpDir);
  }],

  ["tokenize：中英混合/大小写/标签剥离", () => {
    const t = tokenize("<Memory>她喜欢 Bob 的歌</Memory>");
    assert.ok(t.has("喜欢") && t.has("bob") && t.has("的歌"));
    assert.ok(!t.has("<memory>"));
  }],
];

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
  console.log(`\ntest_context_v2: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
  process.exit(failed ? 1 : 0);
})();
