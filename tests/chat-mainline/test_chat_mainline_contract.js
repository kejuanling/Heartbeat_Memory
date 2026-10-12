"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-llm-log-test-"));
const logRoot = path.join(tempRoot, "logs");
const configPath = path.join(tempRoot, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ enabled: true, keep: 2 }), { mode: 0o600 });
process.env.LLM_LOG_DIR = logRoot;
process.env.LLM_LOG_CONFIG_FILE = configPath;
const llmLog = require(path.join(root, "lib", "llm_log.js"));

test("pending helper 在竞争和旧请求迟到收尾时不会释放新状态", () => {
  const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const begin = source.match(/function beginPendingReply\(id\) \{[\s\S]*?\n\}/);
  const clear = source.match(/function clearPendingReply\(id, owner\) \{[\s\S]*?\n\}/);
  assert.ok(begin && clear, "应能定位生产 helper");
  const state = {
    recentReplies: new Map(),
    IDEMPOTENCY_TTL_MS: 600000,
    Date,
    isRecentReplyCacheable: r => !!(r && typeof r.text === "string" && r.text.length),
    _evictOldestReply() {},
    _wakeReplyWaiters(entry, payload) { entry.woken = payload; }
  };
  vm.runInNewContext(begin[0] + "\n" + clear[0], state);
  const owner = state.beginPendingReply("same-id");
  assert.ok(owner && owner.pending);
  assert.equal(state.beginPendingReply("same-id"), false, "第二个请求不能认领同一 pending");
  const replacement = { pending: true, ts: Date.now(), waiters: [] };
  state.recentReplies.set("same-id", replacement);
  state.clearPendingReply("same-id", owner);
  assert.equal(state.recentReplies.get("same-id"), replacement, "旧 owner 不得删除替代状态");
  state.clearPendingReply("same-id", replacement);
  assert.equal(state.recentReplies.has("same-id"), false, "当前 owner 可以正常释放");
});

test("幂等 pending 只能由占位所有者释放", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const route = fs.readFileSync(path.join(root, "routes", "chat.js"), "utf8");
  assert.match(server, /function beginPendingReply\(id\)[\s\S]*?if \(cur && cur\.pending\) return false;[\s\S]*?return owner;/);
  assert.match(server, /function clearPendingReply\(id, owner\)[\s\S]*?if \(cur === owner && cur\.pending\)/);
  assert.match(server, /function _evictOldestReply\(\)[\s\S]*?if \(v && v\.pending\) continue;/);
  assert.match(route, /pendingOwner = beginPendingReply\(clientMsgId\)/);
  assert.match(route, /finally\s*\{[\s\S]*?clearPendingReply\(clientMsgId, pendingOwner\)/);
  assert.doesNotMatch(route, /recentReplies\.delete\(clientMsgId\)/);
  assert.match(route, /return reply\.code\(409\)\.send\(\{ error: "同一消息仍在生成，请稍后重试" \}\)/);
  assert.match(route, /if \(!reply\.raw\.headersSent\) reply\.code\(500\)\.send/);
  assert.match(server, /memoryV2Admission\.submitMemoryAdd\(/, "MCP memory_add 必须走立即入待审、后台评分的快速通道");
  assert.match(server, /readStarredDialogLimit,\s*saveStarredDialogLimit,\s*readSessionDiaryCount,\s*saveSessionDiaryCount/, "会话级注入设置必须传入 chat routes");
});

test("新建与合并会话等待跨窗口及提示词/模型设置保存", () => {
  const html = fs.readFileSync(path.join(root, "workspace", "chat.html"), "utf8");
  assert.match(html, /const crossResp=await fetch\("\/v1\/sessions\/"\+encodeURIComponent\(sid\)\+"\/cross-inject"/);
  assert.match(html, /await setSessionPrompt\(sid, backupId, true\)/);
  assert.match(html, /const providerSaved=await saveSessionProvider\(sid, providerId, modelName, sid\)/);
  assert.match(html, /if\(sending\|\|_segBusy\|\|_sessionInitBusy\)/);
  assert.match(html, /const cxResp=await fetch\("\/v1\/sessions\/"\+encodeURIComponent\(target\)\+"\/cross-inject"/);
  assert.match(html, /if\(_bp\) await setSessionPrompt\(target, _bp, true\)/);
});

test("LLM 日志采用私有权限并按配置裁剪到最近 N 条", async () => {
  for (let i = 0; i < 5; i++) {
    llmLog.record("retention_test", {
      url: "https://example.invalid/v1/chat",
      request: JSON.stringify({ n: i }),
      response: JSON.stringify({ ok: true, n: i }),
      status: 200
    });
  }
  const dir = path.join(logRoot, "retention_test");
  let names = [];
  for (let i = 0; i < 50; i++) {
    try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json")); } catch {}
    if (names.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(names.length, 2, "应只保留配置指定的 2 条日志");
  assert.equal(fs.statSync(logRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of names) {
    assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
  const loggerSource = fs.readFileSync(path.join(root, "lib", "llm_log.js"), "utf8");
  assert.match(loggerSource, /const MAX_KEEP = 50/);
  assert.match(loggerSource, /Math\.min\(MAX_KEEP, keep\)/);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
