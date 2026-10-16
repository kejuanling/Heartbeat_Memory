"use strict";
// 集成测试（2026-10-03）：streamToolLoop 补 onDiaryWritten 后，lovediary_add 写的日记要落时间线。
// 真实跑工具循环：mock 上游 SSE 流 + mock MCP client，断言回调的触发/不触发。
// 不是静态检查——真的走完 loadTools → 分片聚合 → 工具执行 → 回调。
const assert = require("assert");
const path = require("path");

const ROOT = "/opt/dylan-heartbeat/";
const mcp = require(path.join(ROOT, "mcp-tool-loop.js"));

// ---------- mock MCP client（满足 loadTools + callToolByExposedName 两处接口） ----------
function makeClient(opts) {
  const calls = [];
  const client = {
    id: "srv_mock",
    name: "mock",
    enabled: true,
    connected: false,
    config: {},
    calls,
    async connect() { this.connected = true; },
    async listTools() {
      return [
        { name: "lovediary_add", description: "写日记", inputSchema: { type: "object", properties: { content: { type: "string" } } } },
        { name: "memory_search", description: "查记忆", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (opts.throwOn === name) throw new Error("模拟工具后端炸了");
      return { content: [{ type: "text", text: name + " ok" }] };
    }
  };
  return client;
}

// ---------- mock 上游 SSE ----------
function sseFrame(delta, finish) {
  return "data: " + JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] }) + "\n\n";
}
function toolCallFrame(name, argStr, id) {
  return sseFrame({ tool_calls: [{ index: 0, id: id || "call_1", function: { name, arguments: argStr } }] }, "tool_calls");
}
function makeSseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    }
  });
  return { ok: true, status: 200, body, json: async () => JSON.parse("{}"), text: async () => "" };
}

// 一轮工具 + 一轮收尾正文的 fetch 替身
function makeFetch(rounds) {
  let i = 0;
  return async function fetchFn() {
    const frames = rounds[Math.min(i, rounds.length - 1)];
    i++;
    return makeSseResponse(frames);
  };
}

const BASE = {
  upstreamUrl: "http://upstream.invalid/v1",
  upstreamKey: "k",
  model: "m",
  messages: [{ role: "user", content: "写日记" }],
  sessionId: "s_test_diary"
};

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

(async function main() {
  console.log("streamToolLoop / runWithTools —— lovediary_add 时间线落库\n");

  await test("A 流式主路径：lovediary_add 成功 → 回调被调用，参数正确", async () => {
    const client = makeClient({});
    const hits = [];
    const fetchFn = makeFetch([
      [toolCallFrame("lovediary_add", JSON.stringify({ content: "  今天她说了那句话  " }))],
      [sseFrame({ content: "写好了" }, "stop"), "data: [DONE]\n\n"]
    ]);
    const r = await mcp.streamToolLoop(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null,
      onDiaryWritten: (sid, content) => hits.push({ sid, content })
    }));
    assert.strictEqual(hits.length, 1, "应恰好回调 1 次，实际 " + hits.length);
    assert.strictEqual(hits[0].sid, "s_test_diary", "sessionId 传错");
    assert.strictEqual(hits[0].content, "今天她说了那句话", "正文应 trim，实际 " + JSON.stringify(hits[0].content));
    // 顺带确认整条链路真的跑完了（不是提前 return 的假通过）
    assert.strictEqual(client.calls.length, 1, "工具应被真实调用");
    assert.strictEqual(client.calls[0].name, "lovediary_add");
    assert.ok(r.text.indexOf("写好了") >= 0, "第二轮正文应被收到，实际 " + JSON.stringify(r.text));
    assert.strictEqual(r.toolHistory.length, 1, "toolHistory 应有 1 条");
  });

  await test("B 非 lovediary_add 工具 → 不触发回调", async () => {
    const client = makeClient({});
    const hits = [];
    const fetchFn = makeFetch([
      [toolCallFrame("memory_search", JSON.stringify({ q: "蓝鲸" }))],
      [sseFrame({ content: "没有日记" }, "stop"), "data: [DONE]\n\n"]
    ]);
    await mcp.streamToolLoop(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null,
      onDiaryWritten: (sid, content) => hits.push({ sid, content })
    }));
    assert.strictEqual(hits.length, 0, "不该触发，实际 " + hits.length);
  });

  await test("C lovediary_add 正文为空/纯空白 → 不触发回调", async () => {
    for (const content of ["", "   ", "\n\t "]) {
      const client = makeClient({});
      const hits = [];
      const fetchFn = makeFetch([
        [toolCallFrame("lovediary_add", JSON.stringify({ content }))],
        [sseFrame({ content: "空的" }, "stop"), "data: [DONE]\n\n"]
      ]);
      await mcp.streamToolLoop(Object.assign({}, BASE, {
        serverClients: [client], fetchFn, onEvent: null,
        onDiaryWritten: (sid, c) => hits.push({ sid, c })
      }));
      assert.strictEqual(hits.length, 0, "content=" + JSON.stringify(content) + " 时不该触发");
    }
  });

  await test("D 未传 onDiaryWritten → 不报错，循环正常结束", async () => {
    const client = makeClient({});
    const fetchFn = makeFetch([
      [toolCallFrame("lovediary_add", JSON.stringify({ content: "有回调吗" }))],
      [sseFrame({ content: "好了" }, "stop"), "data: [DONE]\n\n"]
    ]);
    const r = await mcp.streamToolLoop(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null
    }));
    assert.ok(r.text.indexOf("好了") >= 0);
  });

  await test("E 回调自己抛异常 → 不影响工具循环", async () => {
    const client = makeClient({});
    const fetchFn = makeFetch([
      [toolCallFrame("lovediary_add", JSON.stringify({ content: "炸一下" }))],
      [sseFrame({ content: "循环仍完成" }, "stop"), "data: [DONE]\n\n"]
    ]);
    const r = await mcp.streamToolLoop(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null,
      onDiaryWritten: () => { throw new Error("回调内部错误"); }
    }));
    assert.ok(r.text.indexOf("循环仍完成") >= 0, "回调抛错不应中断循环");
  });

  await test("F session_id 强制注入仍生效（回调拿到的 sid 不受模型伪造影响）", async () => {
    const client = makeClient({});
    const hits = [];
    const fetchFn = makeFetch([
      [toolCallFrame("lovediary_add", JSON.stringify({ content: "正文", session_id: "模型伪造的" }))],
      [sseFrame({ content: "ok" }, "stop"), "data: [DONE]\n\n"]
    ]);
    await mcp.streamToolLoop(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null,
      onDiaryWritten: (sid, c) => hits.push({ sid, c })
    }));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].sid, "s_test_diary", "回调 sid 应为真实会话");
    assert.strictEqual(client.calls[0].args.session_id, "s_test_diary",
      "发给工具的 session_id 应被服务端覆盖为 " + client.calls[0].args.session_id);
  });

  // ---- 回归：非流式兜底路径（executeToolCalls）重构后行为不变 ----
  await test("G 回归 runWithTools：lovediary_add 仍触发回调", async () => {
    const client = makeClient({});
    const hits = [];
    let call = 0;
    const fetchFn = async function fetchFn() {
      call++;
      if (call === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "lovediary_add", arguments: JSON.stringify({ content: "非流式正文" }) } }] } }] }),
          text: async () => ""
        };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "非流式完成" } }] }), text: async () => "" };
    };
    const r = await mcp.runWithTools(Object.assign({}, BASE, {
      serverClients: [client], fetchFn, onEvent: null,
      onDiaryWritten: (sid, content) => hits.push({ sid, content })
    }));
    assert.strictEqual(hits.length, 1, "非流式路径应回调 1 次，实际 " + hits.length);
    assert.strictEqual(hits[0].content, "非流式正文");
    assert.ok(r.text.indexOf("非流式完成") >= 0);
  });

  console.log("\n通过 %d / 失败 %d", passed, failed);
  process.exit(failed ? 1 : 0);
})();
