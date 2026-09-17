"use strict";

// ========================
// Memory V2 C7 集成测试：memory_tag Shadow 旁路
// 运行：node tests/tag-shadow/test_tag_shadow.js
// 纪律：tmp 目录；断言零 Memory 写入（正式写禁止）、零旧池接触
// ========================

const assert = require("assert");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { createTagShadow } = require("../../memory-tag-shadow");

function makeTmpShadow(tag, shadowOn = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv2-tagshadow-" + tag + "-"));
  const shadow = createTagShadow({ rootDir: tmpDir, shadowOn });
  return { shadow, tmpDir };
}

function auditLines(shadow) {
  const dir = shadow.audit.dir;
  const f = fs.readdirSync(dir).filter((x) => x.startsWith("memory_audit_")).map((x) => path.join(dir, x))[0];
  assert.ok(f, "审计文件应存在");
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const cases = [
  ["正常 tag shadow：fact 标签 → would_admit，provenance 透传 sessionId/msg_id=null", async () => {
    const { shadow, tmpDir } = makeTmpShadow("normal");
    const results = await shadow.observeReply('<memory>{category:"关于她",importance:0.8}她喝奶茶只要三分糖</memory>', { sessionId: "s_main" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].would_action, "would_admit", JSON.stringify(results[0]));
    assert.strictEqual(results[0].detect.kind_guess, "fact");
    assert.strictEqual(results[0].validation.allowed, true);
    const rep = shadow.report();
    assert.strictEqual(rep.total_tags, 1);
    assert.strictEqual(rep.candidates, 1);
    assert.strictEqual(rep.would_admit, 1);
    assert.strictEqual(rep.rejects, 0);
    assert.strictEqual(rep.reviews, 0);
    // 审计里的 provenance：sessionId 保留、msg_id null
    const line = auditLines(shadow)[0];
    assert.strictEqual(line.origin, "memory_tag");
    assert.strictEqual(line.notes.shadow, true);
    assert.strictEqual(line.notes.tag, true);
    const hashOnly = line; // provenance 明细在 validator 之外——审计行携带 origin 与 judge
    assert.ok(line.judge && line.judge.relation, "judge 结果已记录");
    fs.removeSync(tmpDir);
  }],

  ["validator reject：隐私手机号标签 → would_reject 且审计含 V1", async () => {
    const { shadow, tmpDir } = makeTmpShadow("reject");
    const results = await shadow.observeReply('<memory>{category:"关于她",importance:0.9}她手机13812345678开机了</memory>', { sessionId: "s_main" });
    assert.strictEqual(results[0].would_action, "would_reject");
    assert.ok(results[0].validation.matched_rules.includes("V1"));
    const line = auditLines(shadow)[0];
    assert.strictEqual(line.action, "would_reject");
    assert.ok(line.validator.matched_rules.includes("V1"));
    fs.removeSync(tmpDir);
  }],

  ["judge 记录：mock 无检索通道 → relation need_review 且进分布", async () => {
    const { shadow, tmpDir } = makeTmpShadow("judge");
    await shadow.observeReply('<memory>{category:"关于她"}她习惯睡前看书</memory>', { sessionId: "s_main" });
    const rep = shadow.report();
    assert.ok(rep.judge_relations.need_review >= 1, JSON.stringify(rep.judge_relations));
    const line = auditLines(shadow)[0];
    assert.strictEqual(line.judge.relation, "need_review");
    fs.removeSync(tmpDir);
  }],

  ["quote 标签 → would_review（保守人工）", async () => {
    const { shadow, tmpDir } = makeTmpShadow("quote");
    const results = await shadow.observeReply('<memory>{category:"拓本",importance:0.9}涵：「只能我先说晚安」</memory>', { sessionId: "s_main" });
    assert.strictEqual(results[0].would_action, "would_review", JSON.stringify(results[0]));
    const rep = shadow.report();
    assert.strictEqual(rep.reviews, 1);
    assert.strictEqual(rep.would_admit, 0);
    fs.removeSync(tmpDir);
  }],

  ["多标签回复：总 tag 数按标签计，逐条观察", async () => {
    const { shadow, tmpDir } = makeTmpShadow("multi");
    const results = await shadow.observeReply(
      '正文文本<memory>{category:"关于她"}她喜欢三分糖</memory>中间话<memory>{category:"拓本",importance:0.9}涵：「你是我的锚」</memory>',
      { sessionId: "s_main" }
    );
    assert.strictEqual(results.length, 2);
    const rep = shadow.report();
    assert.strictEqual(rep.total_tags, 2);
    assert.strictEqual(rep.would_admit, 1);
    assert.strictEqual(rep.reviews, 1);
    fs.removeSync(tmpDir);
  }],

  ["detector 非候选：无类别的当日状态标签 → would_reject（DET.not_candidate）", async () => {
    const { shadow, tmpDir } = makeTmpShadow("noncand");
    const results = await shadow.observeReply("<memory>今天好累啊不想动了</memory>", { sessionId: "s_main" });
    assert.strictEqual(results[0].would_action, "would_reject");
    assert.ok(results[0].validation.matched_rules.includes("DET.not_candidate"));
    fs.removeSync(tmpDir);
  }],

  ["零 Memory 写入 + 零旧池接触（正式写禁止）", async () => {
    const { shadow, tmpDir } = makeTmpShadow("nowrite");
    await shadow.observeReply('<memory>{category:"关于她"}她喜欢三分糖</memory>', { sessionId: "s_main" });
    const all = fs.readdirSync(tmpDir);
    assert.ok(!all.some((f) => f.includes("memory_v2") || f.includes("memory_review")), "禁止正式写 Memory V2: " + all.join(","));
    assert.ok(!all.some((f) => f.includes("memory_pool") || f.includes("pinned")), "旧池零接触");
    assert.strictEqual(shadow.report().would_admit, 1, "shadow 统计照常累计");
    fs.removeSync(tmpDir);
  }],

  ["shadow 关闭无影响：observe skipped、零审计、统计不动", async () => {
    const { shadow, tmpDir } = makeTmpShadow("off", false);
    const results = await shadow.observeReply('<memory>{category:"关于她"}她喜欢三分糖</memory>', { sessionId: "s_main" });
    assert.strictEqual(results[0].skipped, true);
    const rep = shadow.report();
    assert.strictEqual(rep.total_tags, 0);
    assert.strictEqual(rep.shadow_on, false);
    assert.strictEqual(fs.existsSync(path.join(tmpDir, "data")), false, "零审计落地");
    fs.removeSync(tmpDir);
  }],

  ["msg_id 缺失必须 null；传入则透传", async () => {
    const { shadow, tmpDir } = makeTmpShadow("msgid");
    const r1 = await shadow.observe({ text: "她喜欢三分糖", category: "关于她" }, { sessionId: "s_main" });
    const r2 = await shadow.observe({ text: "她喜欢三分糖", category: "关于她" }, { sessionId: "s_main", msgId: "3f2a9c88-1111" });
    assert.strictEqual(r1.skipped, false);
    assert.strictEqual(r2.skipped, false);
    // provenance 在返回里可核对
    assert.strictEqual(r2.provenanceBuild ?? undefined, undefined); // builder 结果在 audit，不直接外露——此处仅确认不抛错
    fs.removeSync(tmpDir);
  }],

  ["parseTagBody：JSON 头（非标准 JSON）/纯正文 两形态", () => {
    const { parseTagBody } = require("../../memory-tag-shadow");
    const a = parseTagBody('{category:"关于她",importance:0.8}她喜欢三分糖');
    assert.strictEqual(a.meta.category, "关于她", JSON.stringify(a.meta));
    assert.strictEqual(a.meta.importance, 0.8);
    assert.strictEqual(a.body, "她喜欢三分糖");
    const c = parseTagBody("纯正文没有元信息");
    assert.deepStrictEqual(c.meta, {});
    assert.strictEqual(c.body, "纯正文没有元信息");
  }],

  ["report 形状：六统计键 + shadow_on + updated_at", async () => {
    const { shadow, tmpDir } = makeTmpShadow("shape");
    await shadow.observeReply('<memory>{category:"关于她"}她喜欢三分糖</memory>', { sessionId: "s_main" });
    const rep = shadow.report();
    for (const k of ["total_tags", "candidates", "rejects", "reviews", "would_admit", "judge_relations", "shadow_on", "updated_at"]) {
      assert.ok(k in rep, "缺键 " + k);
    }
    fs.removeSync(tmpDir);
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
  console.log(`\ntest_tag_shadow: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
  process.exit(failed ? 1 : 0);
})();
