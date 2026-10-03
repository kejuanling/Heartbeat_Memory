"use strict";
// 集成测试 1003-19：会话级「跨窗口」开关真正生效
//
// 关键场景是快照模式：data/session_inject_snapshots.json 会把 fixed_blocks（含
// conversation_continuity）固化，之后永远复用。若开关只在 context-v2-shadow 的日记过滤点生效，
// 对已有快照的存量会话完全无效——这正是实盘 12 个会话的处境。本测试专盯这一条。
//
// 断言用「日记正文」而非块标题：context_assembly 每轮实时重建，其引导文案本身会提到
// "Earlier Days" 这个词，按标题匹配会误判成日记块还在（第一版就是这么错的）。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = "/opt/dylan-heartbeat/";
const rt = require(ROOT + "context-v2-runtime.js");

const DIARY_BODY = "很久以前的一天";        // 只有 conversation_continuity 块里有
const CORE_BODY = "我是谁";                  // 快照里的 core_identity
const INSTR_BODY = "系统指令XYZ";            // system_instructions 不在实时重算名单里，可验证「只影响日记」

function mkBase(sid, opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xwinj-"));
  const data = path.join(dir, "data");
  fs.mkdirSync(path.join(data, "session_cfg"), { recursive: true });
  fs.writeFileSync(path.join(data, "memory_v2_config.json"), JSON.stringify({
    ctx_v2_enabled: true, ctx_v2_relevant_enabled: false
  }));
  fs.writeFileSync(path.join(data, "cross_inject_config.json"), JSON.stringify({ cross_inject_diary_count: 3 }));
  fs.writeFileSync(path.join(data, "diary.json"), JSON.stringify({
    version: 1, next_id: 2,
    entries: [{ id: 1, session: null, hidden: false, created_at: "2026-01-01T00:00:00.000Z", content: "## 2026-01-01 08:00\n\n" + DIARY_BODY }]
  }));
  if (opts.override !== undefined) {
    fs.writeFileSync(path.join(data, "session_cfg", sid + ".json"), JSON.stringify({ cross_inject_enabled: opts.override }));
  }
  if (opts.snapshotBlocks) {
    fs.writeFileSync(path.join(data, "session_inject_snapshots.json"), JSON.stringify({
      sessions: { [sid]: { created_at: "2026-01-01T00:00:00.000Z", system_prompt: "", fixed_blocks: opts.snapshotBlocks } }
    }));
  }
  return dir;
}

// 快照里同时放日记块 + 两个不受开关影响的块。
// 不用 context_assembly 做「应保留」样本：它在实时重算名单里，快照里的假内容必被覆盖。
const FAKE_BLOCKS = [
  { key: "core_identity", title: "Core Identity", content: CORE_BODY },
  { key: "system_instructions", title: "System Instructions", content: INSTR_BODY },
  { key: "conversation_continuity", title: "Earlier Days", content: "## Earlier Days\n\n2026-01-01\n" + DIARY_BODY }
];

const BASE_OPTS = {
  messages: [{ role: "system", content: "人设" }, { role: "user", content: "在吗" }],
  loadTimeline: () => [],
  normalizeContentToText: (s) => String(s || ""),
};

const devTexts = (messages) => messages.filter((m) => m && m.role === "developer").map((m) => String(m.content || ""));
const has = (messages, body) => devTexts(messages).some((t) => t.indexOf(body) >= 0);

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = [];
  try { await fn((d) => dir.push(d)); passed++; console.log("  ✓ " + name); }
  catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); }
  finally { dir.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }); }
}

(async function main() {
  console.log("会话级跨窗口开关（1003-19）\n");
  console.log("  提示：断言按日记正文「" + DIARY_BODY + "」匹配，不按 \"Earlier Days\" 标题——");
  console.log("  context_assembly 每轮实时重建，其引导文案本身含 \"Earlier Days\" 字样。\n");

  await test("A 快照模式 + override=false → 日记块被移除（存量会话关键场景）", async (keep) => {
    const sid = "s_test_off";
    const d = mkBase(sid, { override: false, snapshotBlocks: FAKE_BLOCKS });
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.ok(r.messages.length > 0, "应返回消息");
    assert.strictEqual(has(r.messages, DIARY_BODY), false, "override=false 时日记正文不该出现");
    assert.strictEqual(has(r.messages, INSTR_BODY), true, "其它固定块应保留");
  });

  await test("B 快照模式 + override=null（跟随全局）→ 日记块保留", async (keep) => {
    const sid = "s_test_null";
    const d = mkBase(sid, { snapshotBlocks: FAKE_BLOCKS });
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r.messages, DIARY_BODY), true, "跟随全局应照常注入");
  });

  await test("C 快照模式 + override=true → 日记块保留", async (keep) => {
    const sid = "s_test_on";
    const d = mkBase(sid, { override: true, snapshotBlocks: FAKE_BLOCKS });
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r.messages, DIARY_BODY), true, "显式开启应注入");
  });

  await test("D 关闭不改写快照文件 → 再打开能恢复（不被冻死）", async (keep) => {
    const sid = "s_test_restore";
    const d = mkBase(sid, { override: false, snapshotBlocks: FAKE_BLOCKS });
    keep(d);
    const snapFile = path.join(d, "data", "session_inject_snapshots.json");
    const before = fs.readFileSync(snapFile, "utf8");

    const r1 = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r1.messages, DIARY_BODY), false, "关闭时应不注入");
    assert.strictEqual(fs.readFileSync(snapFile, "utf8"), before, "快照文件不应被改写");

    fs.writeFileSync(path.join(d, "data", "session_cfg", sid + ".json"), JSON.stringify({ cross_inject_enabled: true }));
    const r2 = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r2.messages, DIARY_BODY), true, "重新开启后日记应恢复");
  });

  await test("E 无快照 + override=false → 首次组装也不注入", async (keep) => {
    const sid = "s_test_fresh_off";
    const d = mkBase(sid, { override: false });
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r.messages, DIARY_BODY), false, "首次组装也应尊重开关");
  });

  await test("F 无快照 + 无 override → 正常注入（默认行为不变）", async (keep) => {
    const sid = "s_test_fresh_on";
    const d = mkBase(sid, {});
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    assert.strictEqual(has(r.messages, DIARY_BODY), true, "默认应注入");
  });

  await test("G 开关只砍日记块，其它固定块原样通过", async (keep) => {
    const sid = "s_test_scope";
    const d = mkBase(sid, { override: false, snapshotBlocks: FAKE_BLOCKS });
    keep(d);
    const r = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: sid }, BASE_OPTS));
    const dev = devTexts(r.messages);
    assert.ok(!dev.some((t) => t.indexOf(DIARY_BODY) >= 0), "日记块应消失");
    assert.ok(dev.some((t) => t.indexOf(INSTR_BODY) >= 0), "system_instructions 应保留");
    assert.ok(r.messages.some((m) => m && m.role === "user"), "真实对话消息不应被影响");
  });

  await test("H 开关是按会话隔离的（A 关不影响 B 开）", async (keep) => {
    const d = mkBase("s_a_off", { override: false });
    keep(d);
    fs.writeFileSync(path.join(d, "data", "session_cfg", "s_b_on.json"), JSON.stringify({ cross_inject_enabled: true }));
    fs.writeFileSync(path.join(d, "data", "session_inject_snapshots.json"), JSON.stringify({
      sessions: {
        s_a_off: { created_at: "", system_prompt: "", fixed_blocks: FAKE_BLOCKS },
        s_b_on: { created_at: "", system_prompt: "", fixed_blocks: FAKE_BLOCKS }
      }
    }));
    const ra = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: "s_a_off" }, BASE_OPTS));
    const rb = await rt.assembleAndApply(Object.assign({ baseDir: d, sessionId: "s_b_on" }, BASE_OPTS));
    assert.strictEqual(has(ra.messages, DIARY_BODY), false, "s_a_off 应关闭");
    assert.strictEqual(has(rb.messages, DIARY_BODY), true, "s_b_on 应照常注入");
  });

  console.log("\n通过 %d / 失败 %d", passed, failed);
  process.exit(failed ? 1 : 0);
})();
