"use strict";
// 工具回执跨轮回灌测试（2026-09-26 修复配套，git 6cd1264）。
// 被测对象：routes/chat-context 的统一出口管道 prepareModelMessages ——
// 时间线富字段（assistant.tools，9-23 起落盘格式）与旧格式「【工具调用记录】」文本
// 必须还原成合规的 assistant(tool_calls)+role:tool 消息组，且满足五条配对性质：
//   P1 tool_calls[].id 全局唯一
//   P2 每个 tool.tool_call_id 都能匹配到前面的 tool_calls[].id
//   P3 tool 回执紧跟对应 assistant.tool_calls 且条数齐全
//   P4 多工具时顺序一致（第 k 个回执 ↔ 第 k 个调用）
//   P5 不存在前面没有 tool_calls 的孤立 tool 消息
// 另验：稳定哈希（同输入两次转换逐字节一致，保上游前缀缓存）、
//       出口白名单不泄漏富字段（tools/segments/stream_timeline/tokens/id/time）、
//       reasoning 落位（挂 tool_calls 消息，thinking 模式回传要求）、失败回执标头。
// 运行：node --test tests/tool-roundtrip/ （或直接 node 本文件）；零外部依赖。

const test = require("node:test");
const assert = require("assert");
const chatCtx = require("../../routes/chat-context");

// ---- 五条性质校验器（与 2026-09-26 真实会话全量体检脚本同口径） ----
function assertToolPairsOk(msgs) {
  const idCount = new Map();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        assert.ok(typeof tc.id === "string" && tc.id, "P1 tool_calls[].id 非空");
        idCount.set(tc.id, (idCount.get(tc.id) || 0) + 1);
      }
      let j = i + 1, consumed = 0;
      while (j < msgs.length && msgs[j].role === "tool") {
        assert.equal(
          msgs[j].tool_call_id, m.tool_calls[consumed] && m.tool_calls[consumed].id,
          "P2/P4 回执与调用 id/顺序不符（出口 idx " + j + "，第 " + consumed + " 个）"
        );
        assert.ok(typeof msgs[j].content === "string" && msgs[j].content, "tool 回执内容非空（idx " + j + "）");
        consumed++; j++;
      }
      assert.equal(consumed, m.tool_calls.length,
        "P3 回执不齐（idx " + i + "：" + m.tool_calls.length + " 个调用只紧跟 " + consumed + " 条回执）");
      i = j - 1;
    } else if (m.role === "tool") {
      assert.fail("P5 孤立 tool 消息（idx " + i + "，id=" + m.tool_call_id + "）");
    }
  }
  for (const [id, c] of idCount) assert.equal(c, 1, "P1 id 重复: " + id);
}

// 出口白名单：发给上游的消息只允许这些键（sanitizeForUpstream 契约）
const ALLOWED_KEYS = new Set(["role", "content", "name", "tool_calls", "tool_call_id", "reasoning_content"]);
function assertSanitizedKeys(msgs) {
  for (const m of msgs) {
    for (const k of Object.keys(m)) {
      assert.ok(ALLOWED_KEYS.has(k), "出口泄漏非白名单字段 " + k + "（role=" + m.role + "）");
    }
  }
}

// ---- 用例 ----

test("新格式单工具（含失败）：组结构 + 失败标头 + reasoning 落位", () => {
  const rich = [
    { role: "user", id: "u1", content: "去岛上看看" },
    { role: "assistant", id: "a1", content: "没成，被掐了。",
      reasoning: "let me try the boil",
      tools: [{ name: "nostos_act", args: { command: { id: "start", target: "water_boil_and_cool" }, request_id: "r1" },
        time: "2026-09-26 21:32:17", result: "", error: "This operation was aborted" }] },
    { role: "user", id: "u2", content: "好吧" }
  ];
  const out = chatCtx.prepareModelMessages(rich, {});
  assertToolPairsOk(out);
  assertSanitizedKeys(out);
  const grp = out.find(m => m.role === "assistant" && m.tool_calls);
  assert.ok(grp, "应有带 tool_calls 的 assistant");
  assert.equal(grp.content, "没成，被掐了。", "assistant 正文应直接随 tool_calls 消息发送");
  assert.equal(grp.reasoning_content, "let me try the boil", "reasoning 应挂在 tool_calls 消息上");
  assert.equal(grp.tool_calls[0].function.name, "nostos_act");
  assert.deepEqual(JSON.parse(grp.tool_calls[0].function.arguments), rich[1].tools[0].args, "实参应原样回填");
  const toolMsg = out.find(m => m.role === "tool");
  assert.ok(/工具：nostos_act/.test(toolMsg.content), "回执应带工具名标头");
  assert.ok(/状态：失败/.test(toolMsg.content), "error 非空应标失败");
  assert.ok(/This operation was aborted/.test(toolMsg.content), "失败应带错误信息");
  const tail = out.filter(m => m.role === "assistant" && !m.tool_calls);
  assert.ok(!tail.some(m => m.content === "没成，被掐了。"), "正文不应再生成重复的尾随 assistant 消息");
});

test("新格式四工具（两条同名同参同时间）：id 仍唯一、顺序保持", () => {
  const mk = (time) => ({ name: "nostos_status", args: { view: "actions" }, time, result: "存档版本：15", error: null });
  const rich = [
    { role: "assistant", id: "a2", content: "查完了。",
      reasoning: "call twice",
      tools: [mk("2026-09-26 21:32:09"), mk("2026-09-26 21:32:09"), // 完全相同：唯一性只能靠条目序号
        { name: "nostos_act", args: { request_id: "r2" }, time: "2026-09-26 21:32:17", result: "ok", error: null },
        { name: "todo_list", args: {}, time: "2026-09-26 21:32:20", result: "empty", error: null }] },
    { role: "user", id: "u3", content: "嗯" }
  ];
  const out = chatCtx.prepareModelMessages(rich, {});
  assertToolPairsOk(out);
  const grp = out.find(m => m.role === "assistant" && m.tool_calls);
  assert.equal(grp.tool_calls.length, 4);
  assert.deepEqual(grp.tool_calls.map(t => t.function.name),
    ["nostos_status", "nostos_status", "nostos_act", "todo_list"], "顺序不得重排");
});

test("旧格式「【工具调用记录】」文本仍正常转换（两套来源混跑五条性质）", () => {
  const legacy = [
    { role: "user", id: "u4", content: "帮我记一下" },
    { role: "assistant", id: "a3", content: "【工具调用记录】\n【工具 · diary_add · 2026-09-26 10:00:00 · 成功】已写入\n【工具 · memory_add · 2026-09-26 10:00:02 · 失败】[出错] 池满" },
    { role: "assistant", id: "a4", content: "记好了。",
      reasoning: "rc",
      tools: [{ name: "leave_paper", args: {}, time: "2026-09-26 10:00:05", result: "ok", error: null }] },
    { role: "user", id: "u5", content: "好" }
  ];
  const out = chatCtx.prepareModelMessages(legacy, {});
  assertToolPairsOk(out);
  const groups = out.filter(m => m.role === "assistant" && m.tool_calls);
  assert.equal(groups.length, 2, "新旧两种来源各成一组");
  assertSanitizedKeys(out);
});

test("稳定哈希：同一输入两次转换逐字节一致（保前缀缓存）", () => {
  const rich = [
    { role: "assistant", id: "a5", content: "x",
      reasoning: "r", tools: [{ name: "t", args: { k: 1 }, time: "2026-09-26 21:32:17", result: "y", error: null }] }
  ];
  const a = chatCtx.prepareModelMessages(rich, {});
  const b = chatCtx.prepareModelMessages(rich, {});
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("富字段不泄漏到出口：普通消息与工具组的键都在白名单内", () => {
  const rich = [
    { role: "assistant", id: "a6", content: "带富字段的回复",
      reasoning: "rr",
      tools: [{ name: "t2", args: {}, time: "2026-09-26 21:32:17", result: "ok", error: null }],
      segments: ["带富字段的回复"], stream_timeline: [{ type: "text", text: "x" }],
      tokens: { prompt_tokens: 1 }, time: "2026-09-26T13:32:00Z" }
  ];
  const out = chatCtx.prepareModelMessages(rich, {});
  assertSanitizedKeys(out);
  assert.ok(!out.some(m => m.tools || m.segments || m.stream_timeline || m.tokens || m.time),
    "tools/segments/stream_timeline/tokens/time 不得出现在出口");
});

test("无 tools 的 assistant 原样通过（reasoning 仍归一为 reasoning_content）", () => {
  const plain = [{ role: "assistant", id: "a7", content: "普通回复", reasoning: "思考" }];
  const out = chatCtx.prepareModelMessages(plain, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "普通回复");
  assert.equal(out[0].reasoning_content, "思考");
  assert.ok(!out[0].tool_calls);
});
