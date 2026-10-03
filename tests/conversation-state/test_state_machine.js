'use strict';
// tests/conversation-state/test_state_machine.js
// 状态机纯逻辑单测：不调 LLM、不碰真实 data/。
// 做法：require 前把 ../context-replacements 塞进 require.cache 当桩，
// 于是 lib/conversation-state.js 拿到的是可控的假后端，跑完删掉 data 下两个测试文件。

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");
const DATA = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA, "conversation_state.json");
const VERSIONS_FILE = path.join(DATA, "conversation_state_versions.json");
const TEST_STATE = "test-state-sess-A";
const TEST_STATE2 = "test-state-sess-B";
const TEST_STATE3 = "test-state-sess-C";
const TEST_STATE4 = "test-state-sess-D";

// ---- 记录真实存在过哪些测试文件，跑完原样恢复 ----
// 注册在 exit 上：中途断言抛错也要还原，否则崩溃一次就留下一堆脏状态，
// 下一轮跑出来的失败全是上一轮的残留（踩过一次）。
const BACKUP = {};
[STATE_FILE, VERSIONS_FILE].forEach(function (f) {
  BACKUP[f] = fs.existsSync(f) ? { existed: true, content: fs.readFileSync(f, "utf8") } : { existed: false };
});
let restored = false;
function restoreFiles() {
  if (restored) return;
  restored = true;
  Object.keys(BACKUP).forEach(function (f) {
    if (BACKUP[f].existed) fs.writeFileSync(f, BACKUP[f].content);
    else { try { fs.unlinkSync(f); } catch (e) { /* 本来就没有 */ } }
  });
}
process.on("exit", restoreFiles);

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failures.push(name + (extra ? " :: " + extra : ""));
}
function eq(name, actual, expected) {
  check(name, actual === expected, "期望 " + JSON.stringify(expected) + "，实得 " + JSON.stringify(actual));
}

// ---- 桩后端 ----
const spanWrites = [];
let tl = [];
const crPath = require.resolve(path.join(ROOT, "context-replacements.js"));
const stub = {
  compressibleItems: function () {
    return tl.map(function (m, i) { return { msg: m, idx: i }; });
  },
  loadTimeline: function () { return tl; },
  searchContextEnhanced: function () { return { results: [] }; },
  upsertSpanRecord: function (o) {
    const si = tl.findIndex(function (m) { return m && m.id === o.startMsg.id; });
    const ei = tl.findIndex(function (m) { return m && m.id === o.endMsg.id; });
    if (si === -1 || ei === -1) return { ok: false, error: "锚点不在时间线" };
    // 重叠检测（与 context-replacements.js:upsertSpanRecord 同口径：同会话 + 未停用/未隐藏 才判冲突）
    for (const w of spanWrites) {
      if (w.recordId === o.recordId) continue;
      if (w.session && w.session !== o.session) continue;
      if (w.disabled) continue;
      if (w.s <= ei && w.e >= si) return { ok: false, error: "区间与已有记录重叠，先把那些记录停用：" + w.recordId };
    }
    const existing = spanWrites.find(function (w) { return w.recordId === o.recordId; });
    if (existing) { existing.s = si; existing.e = ei; existing.text = o.text; existing.rangeLabel = o.rangeLabel || existing.rangeLabel; }
    else spanWrites.push({ recordId: o.recordId, session: o.session, s: si, e: ei, text: o.text, rangeLabel: o.rangeLabel || "" });
    return { ok: true };
  },
  removeReplacement: function (id) {
    const i = spanWrites.findIndex(function (w) { return w.recordId === id; });
    if (i >= 0) spanWrites.splice(i, 1);
    return { ok: true };
  },
};
require.cache[crPath] = { id: crPath, filename: crPath, loaded: true, exports: stub };

const cs = require(path.join(ROOT, "lib", "conversation-state.js"));

// 20 条消息
function mkMsgs(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: (prefix || "m") + i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: (i % 2 === 0 ? "她：" : "我：") + " 第" + i + "句",
      time: new Date(1767225600000 + i * 60000).toISOString(),
    });
  }
  return out;
}

// ================= 1. 读空状态 =================
const empty = cs.getState(TEST_STATE);
check("空会话 exists=false", empty.exists === false);
eq("空会话 version=0", empty.version, 0);
eq("空会话 versions=[]", empty.versions.length, 0);

// ================= 2. commit：无上一版时覆盖区间从本次起点起 =================
tl = mkMsgs(20, "m");
const anchorable = tl.filter(function (m) { return m.id; });
let r = cs.commitMerge({
  session: TEST_STATE,
  state: "状态 v1 正文",
  ops: [{ type: "add", desc: "新增A" }],
  start_msg: anchorable[0],
  end_msg: anchorable[7],
  range_label: "2026-01-01 ~ 2026-01-01",
  count: 8,
});
check("首次并入成功", r.ok === true, JSON.stringify(r));
eq("首次并入后 version=1", r.version, 1);
eq("首次并入 cover.start = 第0条", r.cover.start_id, "m0");
eq("首次并入 cover.end = 第7条", r.cover.end_id, "m7");
eq("seed_from_legacy 首次即 false", r.seed_from_legacy, false);
eq("版本链 1 条", r.versions.length, 1);

// ================= 3. 第二次并入：起点固定、只往后延 =================
r = cs.commitMerge({
  session: TEST_STATE,
  state: "状态 v2 正文",
  ops: [
    { type: "add", desc: "新增B" },
    { type: "remove", desc: "要删的一条", reason: "已被新约定取代" },
    { type: "remove", desc: "拦下的那条", reason: "不该删" },
  ],
  blocked: ["拦下的那条"],
  start_msg: anchorable[8],      // 前端仍会带上本次区间起点，但服务端应以旧 cover 为准
  end_msg: anchorable[14],
  count: 7,
});
check("第二次并入成功", r.ok === true, JSON.stringify(r));
eq("第二次并入 version=2", r.version, 2);
eq("起点没有被本次区间拉走", r.cover.start_id, "m0");
eq("终点推进到第14条", r.cover.end_id, "m14");
eq("被拦截的 remove 不写进 ops", r.ops.length, 2);
check("ops 里不含被拦截项", r.ops.every(function (o) { return o.desc !== "拦下的那条"; }));

// ================= 3b. 覆盖标签累加：起点不动、终点推进 =================
// 独立会话跑——它会多产生一版，塞进 TEST_STATE 会把后面用例的版本号假设全打乱
cs.commitMerge({
  session: TEST_STATE3,
  state: "第一版",
  ops: [],
  start_msg: anchorable[0],
  end_msg: anchorable[7],
  label_start: "2026-01-01 00:00",
  label_end: "2026-01-01 00:07",
});
let lbl = cs.getState(TEST_STATE3);
eq("首版标签起点", lbl.cover.label_start, "2026-01-01 00:00");
eq("首版标签终点", lbl.cover.label_end, "2026-01-01 00:07");
cs.commitMerge({
  session: TEST_STATE3,
  state: "第二版",
  ops: [],
  start_msg: anchorable[8],
  end_msg: anchorable[19],
  label_start: "2026-01-01 00:08",
  label_end: "2026-01-01 00:19",
});
lbl = cs.getState(TEST_STATE3);
eq("标签起点沿用首次（没被本次拉走）", lbl.cover.label_start, "2026-01-01 00:00");
eq("标签终点推进到本次末尾", lbl.cover.label_end, "2026-01-01 00:19");
const spanAfter = spanWrites.filter(function (w) { return w.recordId === lbl.record_id; })[0];
eq("注入记录的标签是完整区间", spanAfter.rangeLabel, "2026-01-01 00:00 ~ 2026-01-01 00:19");

// ================= 4. 版本链只留 5 版 =================
for (let i = 3; i <= 8; i++) {
  const rr = cs.commitMerge({
    session: TEST_STATE,
    state: "状态 v" + i,
    ops: [{ type: "add", desc: "x" + i }],
    start_msg: anchorable[15],
    end_msg: anchorable[19],
  });
  check("第 " + i + " 次并入成功", rr.ok === true, JSON.stringify(rr));
}
const st8 = cs.getState(TEST_STATE);
eq("版本 8 后 version=8", st8.version, 8);
eq("版本链被截到 5 版", st8.versions.length, 5);
eq("版本链保留的是最近 5 版（v8..v4）", st8.versions.map(function (v) { return v.version; }).join(","), "8,7,6,5,4");
eq("v4 已被挤出", st8.versions.some(function (v) { return v.version === 3; }), false);

// ================= 5. 版本正文可单独取回 =================
const v6 = cs.getVersionText(TEST_STATE, 6);
check("取 v6 正文成功", v6.ok === true, JSON.stringify(v6));
eq("v6 正文正确", v6.text, "状态 v6");

// ================= 6. 回滚：正文与覆盖退回那一版 =================
r = cs.rollback({ session: TEST_STATE, version: 5 });
check("回滚成功", r.ok === true, JSON.stringify(r));
eq("回滚后正文 = v5", r.text, "状态 v5");
eq("回滚后 cover.end 退回 v5 的终点", (r.cover || {}).end_id, "m19");
eq("回滚时版本号跟着退回（内容即版本）", r.version, 5);
eq("版本链截到 v5 为止（v3 早被 5 版上限挤掉）", r.versions.map(function (v) { return v.version; }).join(","), "5,4");

// ================= 7. 撤销最后一次并入 =================
r = cs.undoLastMerge({ session: TEST_STATE });
check("撤销成功", r.ok === true, JSON.stringify(r));
// 上一步已回滚到 v5，所以撤销 = 再退一版到 v4
eq("撤销再退一版", cs.getState(TEST_STATE).text, "状态 v4");
eq("撤销后版本号是 v4", cs.getState(TEST_STATE).version, 4);
eq("撤销把版本链截到 v4", cs.getState(TEST_STATE).versions.map(function (v) { return v.version; }).join(","), "4");

// ================= 8. 撤销到只剩一版时应整条移除 =================
cs.commitMerge({ session: TEST_STATE2, state: "只有一版", ops: [], start_msg: anchorable[0], end_msg: anchorable[3] });
r = cs.undoLastMerge({ session: TEST_STATE2 });
check("单版撤销成功", r.ok === true, JSON.stringify(r));
eq("单版撤销整条移除", r.removedAll, true);
eq("移除后 getState 不存在", cs.getState(TEST_STATE2).exists, false);
eq("移除后注入记录也没了", spanWrites.filter(function (w) { return w.recordId.indexOf(TEST_STATE2) !== -1; }).length, 0);

// ================= 9. 区间重叠必须被拒 =================
// 场景要写对：同一会话连续两次并入不算「重叠」——commitMerge 把覆盖区间固定成连续前缀
// （第二次的起点取自上一版的 cover.start_id），m0..m5 接上 m3..m9 合起来是合法的 m0..m9。
// 真正会撞的是「状态前缀盖住了别的记录」——阶段二迁移旧块时的常态：状态要从第 1 条起吃，
// 而前面几段旧块还没退役，就必须挡住，否则 applyReplacements 的单调定位会错位吞区间。
spanWrites.push({ recordId: "ctxrep_legacy_xyz", session: TEST_STATE4, s: 3, e: 9, text: "一条没退役的旧块", rangeLabel: "" });
const before = spanWrites.length;
r = cs.commitMerge({ session: TEST_STATE4, state: "撞车", ops: [], start_msg: anchorable[0], end_msg: anchorable[5] });
check("状态前缀撞上旧块被拒", r.ok === false, JSON.stringify(r));
check("拒绝理由提到重叠", /重叠/.test(r.error || ""), r.error);
eq("被拒时没有新增注入记录", spanWrites.length, before);
eq("被拒时状态没落盘", cs.getState(TEST_STATE4).exists, false);
// 旧块退役（同会话换成停用）后，同一次并入就应该成功
const legacy = spanWrites.find(function (w) { return w.recordId === "ctxrep_legacy_xyz"; });
legacy.disabled = true;
r = cs.commitMerge({ session: TEST_STATE4, state: "不撞了", ops: [], start_msg: anchorable[0], end_msg: anchorable[5] });
check("旧块停用后可以写入", r.ok === true, JSON.stringify(r));

// ================= 10. 越界与缺参 =================
r = cs.commitMerge({ session: TEST_STATE, state: "", ops: [] });
check("空正文被拒", r.ok === false);
r = cs.commitMerge({ session: TEST_STATE, state: "x", ops: [], end_msg: null });
check("缺末尾锚点被拒", r.ok === false);
check("缺末尾锚点的理由正确", /末尾锚点/.test(r.error || ""), r.error);
r = cs.rollback({ session: TEST_STATE, version: 99 });
check("回滚到不存在的版本被拒", r.ok === false);
r = cs.undoLastMerge({ session: "never-existed" });
check("撤销不存在的会话被拒", r.ok === false);

// ================= 恢复现场 =================
restoreFiles();

console.log("\n通过 " + passed + " 项");
if (failures.length) {
  console.log("失败 " + failures.length + " 项：");
  failures.forEach(function (f) { console.log("  ✗ " + f); });
  process.exit(1);
}
console.log("全部通过");