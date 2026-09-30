"use strict";

// ========================
// Memory V2 C6 单测：Judge Adapter（mock / 输出解析 / llm 失败链路）
// 运行：node tests/judge/test_judge_adapter.js
// 禁止真实 API：llm 路径全部经注入的 fake callLLM，本测试零网络
// ========================

const assert = require("assert");
const { judge, judgeMock, parseJudgeOutput, buildPrompt, normalizeText, RELATIONS } = require("../../judge-adapter");

const cases = [
  // ---- mock ----
  ["mock：完全一致 → duplicate 置信 1，包含合并文本", async () => {
    const r = await judge("只能我先说晚安", "只能我先说晚安", { mode: "mock" });
    assert.deepStrictEqual(Object.keys(r).sort(), ["confidence", "merged_text", "reason", "relation"]);
    assert.strictEqual(r.relation, "duplicate");
    assert.strictEqual(r.confidence, 1);
  }],
  ["mock：引号/空白差异被规范化 → duplicate", async () => {
    const r = await judge("涵：「只能我先说晚安」", "只能我先说晚安", { mode: "mock" });
    assert.strictEqual(r.relation, "duplicate", JSON.stringify(r));
  }],
  ["mock：子集/全量包含 → duplicate 0.9", async () => {
    const r = await judge("只能我先说晚安", "她说只能我先说晚安，然后别抢着说", { mode: "mock" });
    assert.strictEqual(r.relation, "duplicate");
    assert.strictEqual(r.confidence, 0.9);
  }],
  ["mock：字面不包含的改写句 → need_review（containment 不做语义改写）", async () => {
    const r = await judge("她喝奶茶只要三分糖", "她吃东西的爱好：奶黄包、蛋挞、三分糖", { mode: "mock" });
    assert.strictEqual(r.relation, "need_review");
  }],
  ["mock：无关文本 → need_review（无语义能力诚实兜底）", async () => {
    const r = await judge("她喜欢三分糖", "网关重启完成了", { mode: "mock" });
    assert.strictEqual(r.relation, "need_review");
  }],
  ["mock：空输入 → need_review", async () => {
    const r = await judge("", "", { mode: "mock" });
    assert.strictEqual(r.relation, "need_review");
  }],
  ["normalizeText：空白+引号剥离", () => {
    assert.strictEqual(normalizeText("  「你 是 我 的 锚」 "), "你是我的锚");
  }],

  // ---- parseJudgeOutput ----
  ["parse：合法 JSON 通过", () => {
    const r = parseJudgeOutput('{"relation":"coexist","confidence":0.9,"reason":"不同分层"}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.relation, "coexist");
    assert.strictEqual(r.confidence, 0.9);
  }],
  ["parse：```json 围栏包裹可解析", () => {
    const r = parseJudgeOutput('```json\n{"relation":"duplicate","confidence":0.8,"reason":"同句"}\n```');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.relation, "duplicate");
  }],
  ["parse：JSON 外杂讯（提取 {} 片段）可解析", () => {
    const r = parseJudgeOutput('结论如下 {"relation":"update","confidence":0.7,"reason":"有「现在」"} 以上。');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.relation, "update");
  }],
  ["parse：非 JSON 垃圾 → 非法", () => {
    assert.strictEqual(parseJudgeOutput("我觉得这两条差不多").ok, false);
    assert.strictEqual(parseJudgeOutput(null).ok, false);
  }],
  ["parse：relation 枚举外 → 非法", () => {
    assert.strictEqual(parseJudgeOutput('{"relation":"merge","confidence":0.9,"reason":"x"}').ok, false);
  }],
  ["parse：confidence 缺失 → 非法（缺字段规则）；越界 → 非法", () => {
    assert.strictEqual(parseJudgeOutput('{"relation":"duplicate","reason":"x"}').ok, false);
    assert.strictEqual(parseJudgeOutput('{"relation":"duplicate","confidence":1.5,"reason":"x"}').ok, false);
  }],
  ["parse：reason 缺失容错（默认空串）", () => {
    const r = parseJudgeOutput('{"relation":"coexist","confidence":0.8}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, "");
  }],

  // ---- llm 链路（fake callLLM，零网络）----
  ["llm：callLLM 返回合法输出 → 三键结果", async () => {
    let calls = 0;
    const r = await judge("她喜欢三分糖", "她喜欢三分糖，觉得全糖太甜", {
      mode: "llm",
      callLLM: async () => { calls++; return '{"relation":"duplicate","confidence":0.85,"reason":"子集"}'; },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(r.relation, "duplicate");
    assert.strictEqual(r.confidence, 0.85);
  }],
  ["llm：两次非法输出 → need_review 兜底且 callLLM 恰好两次", async () => {
    let calls = 0;
    const r = await judge("A", "B", {
      mode: "llm",
      callLLM: async () => { calls++; return "我觉得差不多"; },
    });
    assert.strictEqual(calls, 2, "重试恰好一次");
    assert.strictEqual(r.relation, "need_review");
    assert.ok(r.reason.includes("两次非法"), r.reason);
  }],
  ["llm：第一次非法第二次合法 → 重试成功", async () => {
    let calls = 0;
    const r = await judge("A", "B", {
      mode: "llm",
      callLLM: async () => { calls++; return calls === 1 ? "差不多吧" : '{"relation":"coexist","confidence":0.8,"reason":"不同事"}'; },
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(r.relation, "coexist");
  }],
  ["llm：callLLM 抛异常 → need_review 兜底", async () => {
    const r = await judge("A", "B", { mode: "llm", callLLM: async () => { throw new Error("上游超时"); } });
    assert.strictEqual(r.relation, "need_review");
    assert.ok(r.reason.includes("callLLM 异常"), r.reason);
  }],
  ["llm：未配置 callLLM → need_review（不炸）", async () => {
    const r = await judge("A", "B", { mode: "llm" });
    assert.strictEqual(r.relation, "need_review");
    assert.ok(r.reason.includes("未配置"));
  }],
  ["buildPrompt：含判断顺序/关系定义/输出格式/双条目", () => {
    const p = buildPrompt("候选文本", "既有文本", { existingKind: "fact", existingSubject: "user", existingStatus: "active", candidateKind: "fact", candidateSubject: "user" });
    assert.ok(p.includes("判断顺序"));
    assert.ok(p.includes("duplicate"));
    assert.ok(p.includes("need_review"));
    assert.ok(p.includes("【既有】"));
    assert.ok(p.includes("【候选】"));
    assert.ok(p.includes("候选文本") && p.includes("既有文本"));
    assert.ok(p.includes("fact"));
  }],
  ["RELATIONS 枚举五值", () => {
    assert.deepStrictEqual([...RELATIONS].sort(), ["coexist", "contradiction", "duplicate", "need_review", "update"]);
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
  console.log(`\ntest_judge_adapter: ${passN} passed, ${failed} failed（共 ${cases.length} 例）`);
  process.exit(failed ? 1 : 0);
})();
