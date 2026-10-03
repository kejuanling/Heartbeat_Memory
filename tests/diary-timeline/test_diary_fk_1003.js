"use strict";
// 集成测试 1003-21：日记三面同步的外键地基
//  P1 lib/diary.js appendDiaryEntry 返回条目对象（含 id）
//  P2 server.js syncDiaryTimelineMessages 按 diary_id 定点同步（抽函数注入 mock 执行）
//  P3 工具路径：/internal/diary 返回 id → tools_server 回执带 diary_id → 网关回调第三参透传
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ReadableStream = global.ReadableStream;

const ROOT = "/opt/dylan-heartbeat/";
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
}

// ---------- P1 ----------
function testAppend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diaryfk-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });   // diary-store 原子写在 data/ 下落 tmp 文件
  try {
    const diaryLib = require(ROOT + "lib/diary")({ baseDir: dir, readEnvValue: () => undefined });
    return test("P1a appendDiaryEntry 返回条目对象（含自增 id）", async () => {
      const e1 = diaryLib.appendDiaryEntry("第一篇", "s_test_fk");
      assert.ok(e1 && typeof e1 === "object", "应返回对象，实际 " + JSON.stringify(e1));
      assert.strictEqual(e1.id, 1);
      assert.ok(e1.content.startsWith("## "), "落库正文应带「## 时间」头");
      assert.strictEqual(e1.session, "s_test_fk");
      assert.strictEqual(e1.hidden, false);
      const e2 = diaryLib.appendDiaryEntry("第二篇", null);
      assert.strictEqual(e2.id, 2, "id 应自增");
      assert.strictEqual(e2.session, null, "default 会话归共享层");
    }).then(() => test("P1b 失败路径仍返回 false（调用方真值判断兼容）", async () => {
      const diaryLib = require(ROOT + "lib/diary")({ baseDir: dir, readEnvValue: () => undefined });
      assert.strictEqual(diaryLib.appendDiaryEntry("", "s_x"), false, "空正文应 false");
      assert.strictEqual(diaryLib.appendDiaryEntry(null, "s_x"), false);
    })).then(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  } catch (e) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {} throw e; }
}

// ---------- P2：从 server.js 抽出 syncDiaryTimelineMessages，注入 mock 执行 ----------
function extractFn(name) {
  const src = fs.readFileSync(ROOT + "server.js", "utf8");
  const head = "function " + name + "(";
  const i = src.indexOf(head);
  assert.ok(i !== -1, "server.js 里找不到 " + name);
  const open = src.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  const body = src.slice(i, j);
  return new Function("loadTimeline", "saveTimeline", "sseNotify",
    body + "\nreturn " + name + ";");
}

function testSync() {
  return (async () => {
    const syncDiaryTimelineMessages = extractFn("syncDiaryTimelineMessages");

    await test("P2a 按 diary_id 定点更新，其它消息不动", async () => {
      const fn = extractFn("syncDiaryTimelineMessages");
      const tl = [
        { id: "m1", role: "assistant", content: "普通消息", position: 1 },
        { id: "m2", role: "assistant", kind: "diary", diary_id: 7, content: "[DIARY]旧文[/DIARY]", position: 2.5 },
        { id: "m3", role: "assistant", kind: "diary", diary_id: 8, content: "[DIARY]别的日记[/DIARY]", position: 3.5 }
      ];
      let saved = null, notified = 0;
      const r = fn((sid) => tl, (t) => { saved = t; }, () => { notified++; })("s_x", 7, "[DIARY]新文[/DIARY]");
      assert.deepStrictEqual(r, { patched: 1, missing: false });
      assert.strictEqual(saved[1].content, "[DIARY]新文[/DIARY]");
      assert.strictEqual(saved[1].diary_id, 7, "外键保留");
      assert.strictEqual(saved[2].content, "[DIARY]别的日记[/DIARY]", "别的日记不动");
      assert.strictEqual(saved[0].content, "普通消息");
      assert.strictEqual(notified, 1, "应 sseNotify");
    });

    await test("P2b 无匹配 → missing:true，不落盘", async () => {
      const fn = extractFn2("syncDiaryTimelineMessages");
      const tl = [{ id: "m1", role: "assistant", kind: "diary", diary_id: 9, content: "[DIARY]x[/DIARY]" }];
      let saved = null;
      const r = fn((sid) => tl, (t) => { saved = t; }, () => {})("s_x", 777, "[DIARY]y[/DIARY]");
      assert.deepStrictEqual(r, { patched: 0, missing: true }, "应报 missing");
      assert.strictEqual(saved, null, "不应落盘");
    });

    await test("P2c diaryId 为 null（旧消息无外键）→ 直接 missing，不读盘", async () => {
      const fn = extractFn2("syncDiaryTimelineMessages");
      let loaded = 0;
      const r = fn(() => { loaded++; return []; }, () => {}, () => {})("s_x", null, "[DIARY]y[/DIARY]");
      assert.deepStrictEqual(r, { patched: 0, missing: true });
      assert.strictEqual(loaded, 0, "不应读时间线");
    });

    function extractFn2(name) {
      const src = fs.readFileSync(ROOT + "server.js", "utf8");
      const i = src.indexOf("function " + name + "(");
      const o = src.indexOf("{", i);
      let d = 0, end = -1;
      for (let k = o; k < src.length; k++) {
        if (src[k] === "{") d++;
        else if (src[k] === "}") { d--; if (!d) { end = k + 1; break; } }
      }
      const body = src.slice(i, end);
      return new Function("loadTimeline", "saveTimeline", "sseNotify", body + "\nreturn " + name + ";");
    }
  })();
}

// ---------- P3：工具回执 diary_id → 回调第三参 ----------
function sseFrame(delta, finish) {
  return "data: " + JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] }) + "\n\n";
}
function toolCallFrame(name, argStr) {
  return sseFrame({ tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: argStr } }] }, "tool_calls");
}
function makeClient() {
  return {
    id: "srv_mock", name: "mock", enabled: true, connected: true, config: {},
    async connect() {}, 
    async listTools() {
      return [{ name: "diary_add", description: "写日记", inputSchema: { type: "object", properties: { content: { type: "string" } } } }];
    },
    async callTool(name, args) { return { content: [{ type: "text", text: this.lastResultJson }] }; }
  };
}
function sseResponse(frames) {
  const body = new ReadableStream({
    start(c) { const enc = new TextEncoder(); for (const f of frames) c.enqueue(enc.encode(f)); c.close(); }
  });
  return { ok: true, status: 200, body, json: async () => ({}), text: async () => "" };
}

function testToolPath() {
  const mcp = require(ROOT + "mcp-tool-loop.js");
  const BASE = {
    upstreamUrl: "http://u.invalid/v1", upstreamKey: "k", model: "m",
    messages: [{ role: "user", content: "写日记" }], sessionId: "s_tool_fk",
    fetchFn: null, onEvent: null
  };
  // 第 1 轮返回 diary_add 工具调用，第 2 轮起返回收尾正文（否则同一帧每轮重放，循环跑满 7 轮）
  function makeFetch(argJson) {
    let round = 0;
    return async () => {
      round++;
      return sseResponse(round === 1
        ? [toolCallFrame("diary_add", argJson)]
        : [sseFrame({ content: "好" }, "stop"), "data: [DONE]\n\n"]);
    };
  }
  return (async () => {
    await test("P3a 回执带 diary_id → 回调第三参收到", async () => {
      const client = makeClient();
      client.lastResultJson = JSON.stringify({ success: true, message: "已写入陪伴日记", diary_id: 42 });
      const hits = [];
      const r = await mcp.streamToolLoop(Object.assign({}, BASE, {
        serverClients: [client],
        fetchFn: makeFetch(JSON.stringify({ content: "正文A" })),
        onDiaryWritten: (sid, content, diaryId) => hits.push({ sid, content, diaryId })
      }));
      assert.strictEqual(hits.length, 1, "应恰好回调 1 次，实际 " + hits.length);
      assert.strictEqual(hits[0].diaryId, 42, "应透传 42，实际 " + hits[0].diaryId);
      assert.strictEqual(hits[0].sid, "s_tool_fk");
    });

    await test("P3b 回执无 diary_id（旧版工具）→ 第三参 null，落库不阻断", async () => {
      const client = makeClient();
      client.lastResultJson = JSON.stringify({ success: true, message: "已写入陪伴日记" });
      const hits = [];
      await mcp.streamToolLoop(Object.assign({}, BASE, {
        serverClients: [client],
        fetchFn: makeFetch(JSON.stringify({ content: "正文B" })),
        onDiaryWritten: (sid, content, diaryId) => hits.push({ diaryId })
      }));
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].diaryId, null, "解析不到应为 null");
    });

    await test("P3c 回执非 JSON → 第三参 null，不抛错", async () => {
      const client = makeClient();
      client.lastResultJson = "已写入陪伴日记（纯文本旧格式）";
      const hits = [];
      await mcp.streamToolLoop(Object.assign({}, BASE, {
        serverClients: [client],
        fetchFn: makeFetch(JSON.stringify({ content: "正文C" })),
        onDiaryWritten: (sid, c, diaryId) => hits.push({ diaryId })
      }));
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].diaryId, null);
    });
  })();
}

(async function main() {
  console.log("日记外键地基（1003-21）\n");
  await testAppend();
  await testSync();
  await testToolPath();
  console.log("\n通过 %d / 失败 %d", passed, failed);
  process.exit(failed ? 1 : 0);
})();
