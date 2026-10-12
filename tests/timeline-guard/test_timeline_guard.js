"use strict";
// 时间线 fp+corrupt 双写守卫测试（2026-09-19 审查 P1-2 配套）。
// 被测函数不是复制粘贴，而是从 server.js 源文本按名提取（括号配对）后组装执行——
// server.js 改了守卫逻辑，这里的用例自动跟随真代码。
// 隔离：process.chdir 到临时目录（timelineFileFor 返回相对路径，落盘全在临时目录内）；
// fs 用 fs-extra 最小面 shim（readJsonSync/writeJsonSync/copySync 等 8 个方法），零依赖。
// 运行：node --test tests/timeline-guard/  （或直接 node 本文件）

const test = require("node:test");
const assert = require("assert");
const nodeFs = require("fs");
const os = require("os");
const nodePath = require("path");
const crypto = require("crypto");

const SERVER_JS = nodePath.join(__dirname, "..", "..", "server.js");

// ---- 源码提取器：取 function 声明（括号配对，跳过引号内花括号）与单行 const 声明 ----
function extractFunction(src, name) {
  const m = src.match(new RegExp("(?:^|\\n)((?:async )?function " + name + "\\s*\\()"));
  assert.ok(m, "server.js 中找不到 function " + name);
  let i = src.indexOf(m[1], m.index);
  let depth = 0, started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\"" || ch === "'" || ch === "`") { // 跳过字符串字面量
      const q = ch; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(src.indexOf(m[1], m.index), i + 1); }
  }
  assert.fail("function " + name + " 大括号未闭合");
}
function extractLine(src, prefix) {
  const m = src.match(new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*$", "m"));
  assert.ok(m, "server.js 中找不到声明: " + prefix);
  return m[0];
}

const src = nodeFs.readFileSync(SERVER_JS, "utf8");
// 2026-09-21 R20 起 safeSessionToken 收敛到共享模块 lib/session-token.js（server.js 内已无副本），提取源跟随
const sessionTokenSrc = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "lib", "session-token.js"), "utf8");
// 2026-09-30 V10 起 atomicWriteJsonSync 委托 json_atomic.writeJsonAtomic（server.js 内已无实现体），提取源跟随
const jsonAtomicSrc = nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "json_atomic.js"), "utf8");
const parts = [
  extractLine(src, "const TIMELINE_FILE"),
  extractLine(src, "const _timelineCache"),
  extractLine(src, "const _TIMELINE_CACHE_MAX"),
  extractLine(src, "const _corruptBackupDone"),
  extractLine(src, "const TOMBSTONE_FILE"),
  extractLine(src, "const SESSION_TOMBSTONE_TTL_MS"),
  // Guard files must stay inside each test's temporary cwd; avoid inheriting production __dirname.
  'const TIMELINE_GUARD_DIR = path.join(process.cwd(), "data", "timeline_guard");',
  'const TIMELINE_GUARD_KEEP = 3;',
  extractFunction(src, "guardTimelineCopy"),
  extractFunction(sessionTokenSrc, "safeSessionToken"),
  extractFunction(jsonAtomicSrc, "writeJsonAtomic"),
  "const _writeJsonAtomicBase = writeJsonAtomic; // server.js 委托名的沙盒内对应",
  extractFunction(src, "notifyTimelineWriteRejected"),
  extractFunction(src, "hasSameCorruptBackup"),
  extractFunction(src, "timelineFileFor"),
  extractFunction(src, "timelineFingerprint"),
  extractFunction(src, "cloneTimeline"),
  extractFunction(src, "tagTimelineSnapshot"),
  extractFunction(src, "loadTimeline"),
  extractFunction(src, "readDeletedSessionsMap"),
  extractFunction(src, "writeDeletedSessionsMap"),
  extractFunction(src, "pruneDeletedSessions"),
  extractFunction(src, "isSessionTombstoned"),
  extractFunction(src, "markSessionDeleted"),
  extractFunction(src, "atomicWriteJsonSync"),
  extractFunction(src, "backfillMissingTimes"),
  extractFunction(src, "saveTimeline"),
];
// fs 参数 = fs-extra 最小面 shim（server.js 里 const fs = require("fs-extra")）
const factory = new Function("fs", "crypto", "path", "sendPushNotification", parts.join("\n\n") +
  "\nreturn { timelineFileFor, timelineFingerprint, cloneTimeline, loadTimeline, saveTimeline, isSessionTombstoned, markSessionDeleted };");

function makeFsShim() {
  return {
    existsSync: nodeFs.existsSync,
    statSync: nodeFs.statSync,
    readFileSync: nodeFs.readFileSync,
    writeFileSync: nodeFs.writeFileSync,
    renameSync: nodeFs.renameSync,
    unlinkSync: nodeFs.unlinkSync,
    mkdirSync: nodeFs.mkdirSync,
    ensureDirSync: (d) => nodeFs.mkdirSync(d, { recursive: true }),
    readJsonSync: (f) => JSON.parse(nodeFs.readFileSync(f, "utf-8")),
    writeJsonSync: (f, data, opts) => nodeFs.writeFileSync(f, JSON.stringify(data, null, (opts && opts.spaces) != null ? opts.spaces : 0), "utf-8"),
    copySync: (a, b) => nodeFs.copyFileSync(a, b),
    readdirSync: (d, o) => nodeFs.readdirSync(d, o), // M9 hasSameCorruptBackup 扫 .corrupt-* 备份用
  };
}

function makeModule() {
  // sendPushNotification 注入 no-op（返回 Promise：调用侧有 .catch 链）：拒写告警在测试环境不需真推送
  return factory(makeFsShim(), crypto, nodePath, function () { return Promise.resolve(); });
}

// ---- 测试环境：每个用例独立临时目录 + 独立模块实例（独立缓存/守卫状态）----
function withTempDir(fn) {
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "tlguard-"));
  const oldCwd = process.cwd();
  process.chdir(dir);
  try { return fn(dir, makeModule()); }
  finally { process.chdir(oldCwd); nodeFs.rmSync(dir, { recursive: true, force: true }); }
}

const msg = (role, content) => ({ role, content, time: "2026-09-19T00:00:00.000Z" });

test("守卫标记：loadTimeline 返回的快照带 __fp（structuredClone 主路径）", () => {
  withTempDir((dir, m) => {
    nodeFs.writeFileSync("enhanced_messages_s_t1.json", JSON.stringify([msg("user", "hi")]));
    const snap = m.loadTimeline("s_t1");
    assert.strictEqual(snap.length, 1);
    assert.ok(typeof snap.__fp === "string" && snap.__fp.length > 0, "__fp 应为非空指纹");
    assert.strictEqual(snap.__fp, m.timelineFingerprint("enhanced_messages_s_t1.json"));
  });
});

test("正常路径行为不变：load → modify → save 成功且原消息保留", () => {
  withTempDir((dir, m) => {
    nodeFs.writeFileSync("enhanced_messages_s_t2.json", JSON.stringify([msg("user", "旧消息")]));
    const snap = m.loadTimeline("s_t2");
    snap.push(msg("assistant", "新回复"));
    assert.strictEqual(m.saveTimeline(snap, "s_t2"), true, "同步 load→save 指纹一致，必须放行");
    const disk = JSON.parse(nodeFs.readFileSync("enhanced_messages_s_t2.json", "utf-8"));
    assert.strictEqual(disk.length, 2);
    assert.ok(disk.some(x => x.content === "旧消息") && disk.some(x => x.content === "新回复"));
    // 文件内容不被守卫标记污染（数组自定义属性不进 JSON）
    assert.ok(!nodeFs.readFileSync("enhanced_messages_s_t2.json", "utf-8").includes("__fp"));
  });
});

test("过期快照拒写：旧快照 save 被拒，中间的新写入仍在盘上", () => {
  withTempDir((dir, m) => {
    nodeFs.writeFileSync("enhanced_messages_s_t3.json", JSON.stringify([msg("user", "M1")]));
    const stale = m.loadTimeline("s_t3"); // 快照 A（fp=F1）
    // 模拟期间他人写入：合法 load→push→save（盘上变 F2）
    const other = m.loadTimeline("s_t3");
    other.push(msg("assistant", "B 写入的消息"));
    assert.strictEqual(m.saveTimeline(other, "s_t3"), true);
    // 旧快照再改再存 → 必须拒绝
    stale.push(msg("user", "A 的过期消息"));
    assert.strictEqual(m.saveTimeline(stale, "s_t3"), false, "过期快照必须被拒写");
    const disk = JSON.parse(nodeFs.readFileSync("enhanced_messages_s_t3.json", "utf-8"));
    assert.ok(disk.some(x => x.content === "B 写入的消息"), "他人的新写入必须还在");
    assert.ok(!disk.some(x => x.content === "A 的过期消息"), "过期快照的内容不得落盘");
    // 守卫不粘滞：重新 load 后正常写回
    const fresh = m.loadTimeline("s_t3");
    fresh.push(msg("user", "A 重新 load 后的消息"));
    assert.strictEqual(m.saveTimeline(fresh, "s_t3"), true);
    assert.ok(JSON.parse(nodeFs.readFileSync("enhanced_messages_s_t3.json", "utf-8")).some(x => x.content === "A 重新 load 后的消息"));
  });
});

test("corrupt 拒写：损坏文件绝不能被空数组覆盖，备份只做一次", () => {
  withTempDir((dir, m) => {
    const broken = '{"role":"user","content": BROKEN';
    nodeFs.writeFileSync("enhanced_messages_s_t4.json", broken);
    const snap = m.loadTimeline("s_t4");
    assert.strictEqual(snap.length, 0);
    assert.strictEqual(snap.__corrupt, true, "损坏回退必须带 __corrupt 标记");
    assert.strictEqual(snap.__fp, undefined, "损坏回退不带 __fp（无有效指纹）");
    snap.push(msg("user", "损坏期间的新消息"));
    assert.strictEqual(m.saveTimeline(snap, "s_t4"), false, "corrupt 快照必须被拒写");
    assert.strictEqual(nodeFs.readFileSync("enhanced_messages_s_t4.json", "utf-8"), broken, "原损坏文件必须原样保留，不得被覆盖");
    const baks = nodeFs.readdirSync(".").filter(f => f.startsWith("enhanced_messages_s_t4.json.corrupt-"));
    assert.strictEqual(baks.length, 1, "损坏备份应存在");
    // 反复 load 不堆积备份
    m.loadTimeline("s_t4"); m.loadTimeline("s_t4"); m.saveTimeline(m.loadTimeline("s_t4"), "s_t4");
    const baks2 = nodeFs.readdirSync(".").filter(f => f.startsWith("enhanced_messages_s_t4.json.corrupt-"));
    assert.strictEqual(baks2.length, 1, "同一轮损坏只备份一次");
  });
});

test("文件不存在的新会话不受守卫影响：空数组放行创建", () => {
  withTempDir((dir, m) => {
    const snap = m.loadTimeline("s_t5_new");
    assert.strictEqual(snap.length, 0);
    assert.strictEqual(snap.__corrupt, undefined, "不存在的文件不是损坏");
    snap.push(msg("user", "首条消息"));
    assert.strictEqual(m.saveTimeline(snap, "s_t5_new"), true, "新会话首写必须放行");
    assert.ok(nodeFs.existsSync("enhanced_messages_s_t5_new.json"));
  });
});

test("外部构造数组（无 __fp/__corrupt，如 buildTimeline 输出）保存放行", () => {
  withTempDir((dir, m) => {
    nodeFs.writeFileSync("enhanced_messages_s_t6.json", JSON.stringify([msg("user", "旧")]));
    const rebuilt = [msg("user", "重建内容")]; // 故意不带任何守卫标记
    assert.strictEqual(m.saveTimeline(rebuilt, "s_t6"), true, "无标记数组走原有覆盖语义");
    assert.ok(JSON.parse(nodeFs.readFileSync("enhanced_messages_s_t6.json", "utf-8")).some(x => x.content === "重建内容"));
  });
});

test("cloneTimeline：JSON fallback 分支可用（两条克隆路径的 __fp 由 loadTimeline 统一补挂）", () => {
  withTempDir((dir, m) => {
    const weird = [msg("user", "x")];
    weird.__fn = function () {}; // structuredClone 不支持函数 → 触发 JSON fallback
    const cloned = m.cloneTimeline(weird);
    assert.ok(Array.isArray(cloned) && cloned.length === 1, "fallback 必须返回等价数组");
    assert.strictEqual(cloned[0].content, "x");
    // 端到端：readJsonSync 产物永远可 clone，故 fallback 在真实 load 路径为兜底分支；
    // __fp 由 tagTimelineSnapshot 在 clone 之后统一挂，两条路径的快照都带标记（见第一条用例）。
  });
});

test("墓碑：已删除会话的迟到写入被拒，不复活残骸文件", () => {
  withTempDir((dir, m) => {
    assert.strictEqual(m.markSessionDeleted("s_t7_dead"), true, "标记删除应成功");
    assert.strictEqual(m.markSessionDeleted("default"), false, "主会话不可墓碑");
    const snap = m.loadTimeline("s_t7_dead"); // 文件不存在 → 空数组、非 corrupt
    assert.strictEqual(snap.length, 0);
    snap.push(msg("user", "迟到的消息"));
    assert.strictEqual(m.saveTimeline(snap, "s_t7_dead"), false, "墓碑期内必须拒写");
    assert.ok(!nodeFs.existsSync("enhanced_messages_s_t7_dead.json"), "不得重建文件");
    assert.ok(m.isSessionTombstoned("s_t7_dead"));
  });
});

test("墓碑过期后恢复可写（TTL 语义）", () => {
  withTempDir((dir, m) => {
    nodeFs.mkdirSync("data", { recursive: true });
    const old = Date.now() - 25 * 60 * 60 * 1000; // 超过 24h TTL
    nodeFs.writeFileSync(nodePath.join("data", "deleted_sessions.json"), JSON.stringify({ s_t8_old: old }));
    assert.strictEqual(m.isSessionTombstoned("s_t8_old"), false, "过期墓碑不生效");
    const snap = m.loadTimeline("s_t8_old");
    snap.push(msg("user", "过期后的同 id 重建首条"));
    assert.strictEqual(m.saveTimeline(snap, "s_t8_old"), true, "墓碑过期必须放行");
    assert.ok(nodeFs.existsSync("enhanced_messages_s_t8_old.json"));
  });
});

// 直接运行本文件时也执行（node tests/timeline-guard/test_timeline_guard.js）
if (require.main === module) {
  // node:test 在 require.main 模式下自动运行以上用例并输出结果
}
