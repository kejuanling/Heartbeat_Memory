'use strict';
// tests/conversation-state/test_state_machine.js
// 状态机纯逻辑单测：不调 LLM。
// 隔离双保险（1003-30 两次误删生产状态后的根治）：
//   ① require 前把 ../context-replacements 塞进 require.cache 当桩（可控假后端）；
//   ② CONVERSATION_STATE_DIR 指向临时目录——状态机模块的 data 读写全部落在临时目录，
//      生产 data/conversation_state.json 从此与测试物理无关，跑测试不再需要任何 rm。

const path = require("path");
const fs = require("fs");
const os = require("os");

// ★ 必须在 require lib/conversation-state 之前设置（模块读 env 定数据目录）
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-state-test-"));
process.env.CONVERSATION_STATE_DIR = TEST_DATA_DIR;

const ROOT = path.join(__dirname, "..", "..");
const TEST_STATE = "test-state-sess-A";
const TEST_STATE2 = "test-state-sess-B";
const TEST_STATE3 = "test-state-sess-C";
const TEST_STATE4 = "test-state-sess-D";
const TEST_STATE5 = "test-state-sess-E";

// 跑完删临时目录（exit 上挂，崩溃也清理）
let cleaned = false;
function cleanupDir() {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on("exit", cleanupDir);

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
// 2026-10-04：存量旧块模拟集（撞块自动退役用例用）。{id, source, s, e, enabled, hidden}
let legacyBlocks = [];
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
  // 2026-10-04 撞块自动退役：桩里用 legacyBlocks 模拟存量旧块。
  // 语义对齐真实实现——只退役 source!=="state" 的相交块、状态记录相交直接拒、
  // 返回原 enabled 供复原。
  retireOverlappingLegacyBlocks: function (o) {
    const si = tl.findIndex(function (m) { return m && m.id === o.startId; });
    const ei = tl.findIndex(function (m) { return m && m.id === o.endId; });
    if (si === -1 || ei === -1) return { ok: false, error: "锚点不在时间线" };
    const hits = [];
    const stateConflicts = [];
    legacyBlocks.forEach(function (b) {
      if (b.id === o.excludeId) return;
      if (b.enabled === false || b.hidden === true) return;
      if (b.s > ei || b.e < si) return;
      if (b.source === "state") { stateConflicts.push(b.id); return; }
      hits.push({ id: b.id, source: b.source || "manual", prevEnabled: b.enabled !== false });
    });
    if (stateConflicts.length) {
      return { ok: false, error: "区间与本会话已有的状态记录重叠（" + stateConflicts.join("、") + "）" };
    }
    if (!hits.length) return { ok: true, retired: [], stateConflicts: [] };
    hits.forEach(function (h) {
      const b = legacyBlocks.find(function (x) { return x.id === h.id; });
      if (b) b.enabled = false;
    });
    return { ok: true, retired: hits, stateConflicts: [] };
  },
  restoreRetiredBlocks: function (list) {
    const arr = Array.isArray(list) ? list : [];
    let n = 0;
    arr.forEach(function (r) {
      const b = legacyBlocks.find(function (x) { return x.id === r.id; });
      if (b) { b.enabled = true; n++; }
    });
    return { ok: true, restored: n };
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
// 连续性断言（1003-21 加的）要求每次并入紧接上一次覆盖范围的末尾，
// 所以这里改成一段段往后推：v2 已覆盖到 m14，v3..v8 依次吃 m15~m31。
// （20 条不够 6 次连续并入，时间线加长到 32 条。）
tl = mkMsgs(32, "m");
const anchorable32 = tl.filter(function (m) { return m.id; });
const chainEnds = [19, 22, 24, 26, 28, 31];   // v3..v8 各自的覆盖终点
let chainPrev = 14;                            // v2 已覆盖到的终点下标
for (let i = 3; i <= 8; i++) {
  const end = chainEnds[i - 3];
  const rr = cs.commitMerge({
    session: TEST_STATE,
    state: "状态 v" + i,
    ops: [{ type: "add", desc: "x" + i }],
    start_msg: anchorable32[chainPrev + 1],
    end_msg: anchorable32[end],
  });
  check("第 " + i + " 次并入成功（起点 " + (chainPrev + 1) + " 紧接上次覆盖）", rr.ok === true, JSON.stringify(rr));
  chainPrev = end;
}
const st8 = cs.getState(TEST_STATE);
eq("版本 8 后 version=8", st8.version, 8);
eq("版本链被截到 5 版", st8.versions.length, 5);
eq("版本链保留的是最近 5 版（v8..v4）", st8.versions.map(function (v) { return v.version; }).join(","), "8,7,6,5,4");
eq("v4 已被挤出", st8.versions.some(function (v) { return v.version === 3; }), false);
eq("覆盖终点推进到第 32 条（0-based 31）", st8.covered_range.end_index, 31);
eq("当前版 status=current", st8.versions.find(function (v) { return v.version === 8; }).status, "current");
eq("老版 status=superseded", st8.versions.find(function (v) { return v.version === 4; }).status, "superseded");
check("每行带自己的编号区间", st8.versions.every(function (v) { return v.range && typeof v.range.end_index === "number"; }), JSON.stringify(st8.versions));

// ================= 5. 版本正文可单独取回 =================
const v6 = cs.getVersionText(TEST_STATE, 6);
check("取 v6 正文成功", v6.ok === true, JSON.stringify(v6));
eq("v6 正文正确", v6.text, "状态 v6");

// ================= 6. 回滚（指针模型）：只挪指针，不截链 =================
r = cs.rollback({ session: TEST_STATE, version: 5 });
check("回滚成功", r.ok === true, JSON.stringify(r));
eq("回滚后正文 = v5", r.text, "状态 v5");
eq("回滚后 cover.end 退回 v5 的终点（m24）", (r.cover || {}).end_id, "m24");
eq("指针移到 v5", r.version, 5);
eq("回滚不截链：5 版全保留", (r.versions || []).map(function (v) { return v.version; }).join(","), "8,7,6,5,4");
eq("被回滚掉的 v6..v8 标记 undone", r.versions.filter(function (v) { return v.status === "undone"; }).map(function (v) { return v.version; }).join(","), "8,7,6");
eq("v4 仍是 superseded", r.versions.find(function (v) { return v.version === 4; }).status, "superseded");

// ================= 7. 撤销 = 回滚到上一版（同样不截链）=================
r = cs.undoLastMerge({ session: TEST_STATE });
check("撤销成功", r.ok === true, JSON.stringify(r));
// 当前指针在 v5，撤销 = 再退一版到 v4
eq("撤销再退一版", cs.getState(TEST_STATE).text, "状态 v4");
eq("撤销后指针在 v4", cs.getState(TEST_STATE).version, 4);
eq("链仍完整", cs.getState(TEST_STATE).versions.map(function (v) { return v.version; }).join(","), "8,7,6,5,4");
eq("v5 也成了 undone", cs.getState(TEST_STATE).versions.find(function (v) { return v.version === 5; }).status, "undone");

// ================= 7b. 恢复：切回「已撤销」的版本（不调模型，纯指针）=================
r = cs.rollback({ session: TEST_STATE, version: 7 });
check("恢复 v7 成功", r.ok === true, JSON.stringify(r));
eq("恢复后正文 = v7", r.text, "状态 v7");
eq("恢复后指针在 v7", r.version, 7);
eq("恢复后覆盖 = v7 的覆盖（终点 m28）", (r.cover || {}).end_id, "m28");
eq("链不截", r.versions.map(function (v) { return v.version; }).join(","), "8,7,6,5,4");
eq("此时 v8 是 undone、v5/v6 是 superseded",
  r.versions.filter(function (v) { return v.status === "undone"; }).map(function (v) { return v.version; }).join(","), "8");

// ================= 7c. 回滚后再并入：版本号单调递增（不撞链上已有号）=================
// 指针在 v7（覆盖到 m28），下一次并入从 m29 开始 → 新版本必须是 v9（链上最大号 8 +1），不是 v8
r = cs.commitMerge({
  session: TEST_STATE,
  state: "状态 v9",
  ops: [],
  start_msg: anchorable32[29],
  end_msg: anchorable32[31],
});
check("回滚后并入成功", r.ok === true, JSON.stringify(r));
eq("新版本号 = v9（单调，跳过已存在的 v8）", r.version, 9);
eq("链上没有撞号的两个 v8", r.versions.filter(function (v) { return v.version === 8; }).length, 1);
eq("v8 变成 superseded", r.versions.find(function (v) { return v.version === 8; }).status, "superseded");

// ================= 7d. 5 版上限：从最老那头挤 =================
// 指针先切回 v5（链上最老），再连续并入两次逼挤出。
// 提交后指针总在最新版，所以 v5/v6 会被正常挤出（指针不受影响）——
// 这也是对「回滚到老版后继续并入」完整路径的覆盖。
cs.rollback({ session: TEST_STATE, version: 5 });
r = cs.commitMerge({ session: TEST_STATE, state: "状态 v10", ops: [], start_msg: anchorable32[25], end_msg: anchorable32[28] });
check("v10 并入成功", r.ok === true, JSON.stringify(r));
r = cs.commitMerge({ session: TEST_STATE, state: "状态 v11", ops: [], start_msg: anchorable32[29], end_msg: anchorable32[31] });
check("v11 并入成功", r.ok === true, JSON.stringify(r));
const st11 = cs.getState(TEST_STATE);
eq("指针在最新版 v11", st11.version, 11);
eq("链仍为 5 版", st11.versions.length, 5);
eq("最老的 v5/v6 已被挤出", st11.versions.map(function (v) { return v.version; }).join(","), "11,10,9,8,7");

// ================= 8. 撤销到只剩一版：指针清空，但链保留（可恢复）=================
cs.commitMerge({ session: TEST_STATE2, state: "只有一版", ops: [], start_msg: anchorable[0], end_msg: anchorable[3] });
r = cs.undoLastMerge({ session: TEST_STATE2 });
check("单版撤销成功", r.ok === true, JSON.stringify(r));
eq("单版撤销指针清空", r.removedAll, true);
eq("移除后 getState 不存在", cs.getState(TEST_STATE2).exists, false);
eq("移除后注入记录也没了", spanWrites.filter(function (w) { return w.recordId.indexOf(TEST_STATE2) !== -1; }).length, 0);
// 指针模型（1003-32）：链保留，全部标 undone——并入记录里可原样恢复
const g2 = cs.getState(TEST_STATE2);
eq("链保留 1 版", g2.versions.length, 1);
eq("保留的版本标 undone", g2.versions[0].status, "undone");
eq("保留版正文还在", g2.versions[0].chars, "只有一版".length);
// 从「无状态」恢复：rollback 直接重建状态（不调模型）
r = cs.rollback({ session: TEST_STATE2, version: 1 });
check("从空状态恢复成功", r.ok === true, JSON.stringify(r));
eq("恢复后 exists=true", cs.getState(TEST_STATE2).exists, true);
eq("恢复后正文原样", cs.getState(TEST_STATE2).text, "只有一版");
check("恢复后 covered_range 正确", cs.getState(TEST_STATE2).covered_range.end_index === 3, JSON.stringify(cs.getState(TEST_STATE2).covered_range));
eq("注入记录重建", spanWrites.filter(function (w) { return w.recordId.indexOf(TEST_STATE2) !== -1; }).length, 1);

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

// ================= 10b. 连续性断言：跳着并入必须被拒 =================
// 1003-21 补的：状态覆盖的是连续前缀。用户若选了后面的一段（未覆盖区中间/末尾），
// 中间那段原文会被状态静默吞掉、而模型从没读过——表现是「那段对话像从没发生过」，
// 而且不报错、注入也正常，极难察觉。宁可拒绝写入。
cs.commitMerge({ session: TEST_STATE5, state: "前一段", ops: [], start_msg: anchorable[0], end_msg: anchorable[5] });
const cr5 = cs.getState(TEST_STATE5).covered_range;
check("并入后能算出覆盖区间（从 cover 边界现算，不靠 span 快照）",
  cr5 && cr5.start_index === 0 && cr5.end_index === 5, JSON.stringify(cr5));
r = cs.commitMerge({ session: TEST_STATE5, state: "跳着来的", ops: [], start_msg: anchorable[10], end_msg: anchorable[15] });
check("跳着并入被拒", r.ok === false, JSON.stringify(r));
check("拒绝理由点明会被吞掉", /吞掉/.test(r.error || ""), r.error);
check("拒绝理由给出正确起点（第 7 条）", /第 7 条/.test(r.error || ""), r.error);
eq("被拒时状态没变", cs.getState(TEST_STATE5).text, "前一段");
r = cs.commitMerge({ session: TEST_STATE5, state: "接着来的", ops: [], start_msg: anchorable[6], end_msg: anchorable[15] });
check("紧接覆盖范围并入成功", r.ok === true, JSON.stringify(r));
eq("连续时状态已更新", cs.getState(TEST_STATE5).text, "接着来的");
const cr5b = cs.getState(TEST_STATE5).covered_range;
eq("连续并入后覆盖终点推进到第 16 条（0-based 15）", cr5b.end_index, 15);
eq("起点仍锚在第 1 条（连续前缀）", cr5b.start_index, 0);

// ================= 10. 撞块自动退役（2026-10-04）=================
// 背景：存量旧块不迁移，状态机却在真跑。连续前缀从第 1 条起推必然撞上旧块，
// 原来 upsertSpanRecord 的重叠断言会直接拒 → 存量会话里状态机基本并不动。
// 改为：先把相交的旧块停用（数据不删、可恢复），再写状态；失败即复原。
//
// ★ 下标口径：桩里 legacyBlocks 的 s/e 是 compressibleItems() 序位（0-based），
//   与 retireOverlappingLegacyBlocks 内部用 loadTimeline 下标查区间一致（本测试里
//   compressibleItems 与 loadTimeline 同序，因为 mkMsgs 不含 system 消息）。
const TEST_RETIRE = "test-state-sess-retire";
{
  tl = mkMsgs(30, "r");
  legacyBlocks = [
    { id: "legacy-A", source: "manual", s: 5, e: 9, enabled: true },
    { id: "legacy-B", source: "manual", s: 12, e: 15, enabled: true },
    { id: "legacy-far", source: "manual", s: 25, e: 29, enabled: true },  // 不该被撞
  ];
  const a0 = tl[0], a19 = tl[19], a29 = tl[29];
  r = cs.commitMerge({ session: TEST_RETIRE, state: "退役测试 v1", ops: [], start_msg: a0, end_msg: a19 });
  check("撞上旧块仍并入成功（不再被重叠断言拒）", r.ok === true, JSON.stringify(r));
  eq("两个相交旧块已退役", legacyBlocks.filter(function (b) { return b.enabled === false; }).length, 2);
  eq("区间外的旧块不动", legacyBlocks.find(function (b) { return b.id === "legacy-far"; }).enabled, true);
  eq("退役计数进入状态", r.retired_count, 2);
  eq("退役清单记录了两个 id", r.retired_refs.map(function (x) { return x.id; }).sort().join(","), "legacy-A,legacy-B");

  // 往后推一段（连续前缀）：start_msg 是**本次新增段**的起点（紧接覆盖范围之后），
  // 覆盖前缀的起点由 commitMerge 自己从上一版 cover 继承。
  r = cs.commitMerge({ session: TEST_RETIRE, state: "退役测试 v2", ops: [], start_msg: tl[20], end_msg: a29 });
  check("继续往后并入成功", r.ok === true, JSON.stringify(r));
  eq("再退役了新相交的 legacy-far", r.retired_count, 3);
  eq("旧块全部停用", legacyBlocks.filter(function (b) { return b.enabled === false; }).length, 3);
  const crR = cs.getState(TEST_RETIRE).covered_range;
  eq("覆盖前缀终点推进到第 30 条（0-based 29）", crR.end_index, 29);
  eq("覆盖前缀起点仍锚在第 1 条", crR.start_index, 0);

  // 状态记录相交必须拒绝，而不是替它退役。
  // 换到新会话（该会话已有状态记录 legacy-state-x 与本次区间相交），
  // 用别的会话会被连续性断言先拦掉、轮不到重叠检测，测不到这条分支。
  const TEST_FORK = "test-state-sess-fork";
  tl = mkMsgs(30, "k");
  legacyBlocks = [{ id: "legacy-state-x", source: "state", s: 0, e: 3, enabled: true }];
  const k0 = tl[0], k10 = tl[10];
  const rState = cs.commitMerge({ session: TEST_FORK, state: "不该成功", ops: [], start_msg: k0, end_msg: k10 });
  check("与另一条状态记录相交时被拒", rState.ok === false, JSON.stringify(rState));
  check("拒绝理由点明状态链分叉", /状态记录重叠|分叉/.test(rState.error || ""), rState.error);
  eq("被拒时该会话没有产生状态", cs.getState(TEST_FORK).exists, false);
  eq("另一条状态记录未被替它停用", legacyBlocks[0].enabled, true);
  legacyBlocks = [];
}

// ================= 11. 撤销整条状态 → 旧块复原 =================
// 撤销把覆盖范围完全缩回，被退役的旧块必须重新生效，否则「撤销」把两边一起弄没了。
const TEST_UNDO_RETIRE = "test-state-sess-undoretire";
{
  tl = mkMsgs(20, "u");
  legacyBlocks = [{ id: "legacy-U", source: "manual", s: 3, e: 8, enabled: true }];
  const u0 = tl[0], u15 = tl[15];
  r = cs.commitMerge({ session: TEST_UNDO_RETIRE, state: "待撤销", ops: [], start_msg: u0, end_msg: u15 });
  check("并入成功且退役了旧块", r.ok === true && legacyBlocks[0].enabled === false, JSON.stringify(r));
  r = cs.undoLastMerge({ session: TEST_UNDO_RETIRE });
  check("撤销整条状态成功", r.ok === true, JSON.stringify(r));
  check("撤销返回复原数量", r.restoredBlocks === 1, JSON.stringify(r));
  eq("旧块已重新生效", legacyBlocks[0].enabled, true);
  check("状态已清空", cs.getState(TEST_UNDO_RETIRE).exists === false);
  legacyBlocks = [];
}

// ================= 恢复现场 =================
// 数据全在临时目录（CONVERSATION_STATE_DIR），exit 钩子统一删除；生产 data/ 从未被碰。
cleanupDir();

console.log("\n通过 " + passed + " 项");
if (failures.length) {
  console.log("失败 " + failures.length + " 项：");
  failures.forEach(function (f) { console.log("  ✗ " + f); });
  process.exit(1);
}
console.log("全部通过");