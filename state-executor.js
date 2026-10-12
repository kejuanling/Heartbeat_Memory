"use strict";

// ========================
// State Executor（C4）——Memory V2 的唯一写手
// 铁律（15.txt）：全系统只有本模块允许落笔 memory_v2.json / review_queue（经 memory-v2 存储层）。
// 支持 admit / reject / review 三动作；任何状态变化都经 memory-v2 存储层校验
// （Schema/枚举/状态机），本模块不做格式转换之外的自由写入。
// ========================

const fs = require("fs-extra");
const crypto = require("crypto");
const { nowIso } = require("./time_utils");
const { createStore } = require("./memory-v2");

function atomicWriteJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeJsonSync(tmp, data, { spaces: 2 });
  fs.renameSync(tmp, file);
}

function newQueueId() { return "rq_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"); }

// opts: { store（memory-v2 createStore 实例）, queuePath?, readonly? }
function createStateExecutor(opts = {}) {
  const store = opts.store;
  if (!store) throw new Error("createStateExecutor 需要 memory-v2 store 实例");
  const queuePath = opts.queuePath || store.paths.review_queue;
  const readonly = opts.readonly != null ? !!opts.readonly : store.readonly;
  let queue = null;

  function loadQueue() {
    // 每次操作都重新读盘，避免 admission/tag-parser/后台评分各自缓存队列后互相覆盖。
    // 队列文件是跨入口共享状态，不能把首次加载的数组当作永久真身。
    if (!fs.existsSync(queuePath)) queue = [];
    else {
      try {
        queue = fs.readJsonSync(queuePath);
      } catch (err) {
        const backup = queuePath + ".corrupt-" + Date.now();
        try { fs.renameSync(queuePath, backup); } catch (_) { /* 同存储层隔离策略 */ }
        throw new Error(`review queue 损坏，已隔离到 ${backup}：${err.message}`);
      }
    }
    if (!Array.isArray(queue)) throw new Error(`review queue 格式非法（应为数组）: ${queuePath}`);
    return queue;
  }

  function flushQueue() {
    if (readonly) return;
    atomicWriteJson(queuePath, queue);
  }

  // admit：写入 V2 集合（Schema/状态机校验在存储层）
  function admit(draft) {
    const r = store.create(draft);
    if (!r.ok) return { ok: false, action: "admit", error: r.error };
    return { ok: true, action: "admit", written: true, entry: r.entry };
  }

  // review：挂起进队列（不进集合）；记录必须带 reason（为什么挂起）；
  // meta.auditId 关联审计行，meta.details 携带 validator/detector 的拒绝或存疑原因供人工查看
  function review(draft, reason, meta = {}) {
    if (readonly) return { ok: false, action: "review", error: "readonly" };
    // 1007：subject 删除——任何入口落队列前剥除（低层兜底，与 admission 层双保险）
    if (draft && typeof draft === "object" && "subject" in draft) {
      const _d = Object.assign({}, draft);
      delete _d.subject;
      draft = _d;
    }
    const q = loadQueue();
    const rec = {
      id: newQueueId(),
      status: "pending_review",
      created_at: nowIso(),
      reason: strSafe(reason),
      audit_id: strSafe(meta.auditId) || null,
      details: Array.isArray(meta.details) ? meta.details : null,
      draft, // 校验过的基础字段，供人工裁决时直通落地
      // 0928 合并草稿：{ merged_text, from_id, from_kind, from_text }——approve 时以 merged_text 覆盖正文，
      // 旧条目（from_id）置 superseded(reason=merged)；reject 时旧条目原样不动
      merge: meta.merge && typeof meta.merge === "object" ? meta.merge : null,
      // 1004-04：judge 的纯信息输出 {worth, worth_reason, volatility, volatility_reason, similar[]}。
      // 只供待审页面展示（分数卡 + 相似清单 + 逐条沉底），judge 不参与任何入库决策。
      judge: meta.judge && typeof meta.judge === "object" ? meta.judge : null,
      // memory_add 的门卫任务异步执行；这些字段用于持久化状态与失败恢复。
      judge_status: meta.judge_status || (meta.judge ? "completed" : null),
      judge_error: meta.judge_error || null,
      judge_attempts: Number.isInteger(meta.judge_attempts) ? meta.judge_attempts : 0,
      source: meta.source || null,
    };
    q.push(rec);
    flushQueue();
    return { ok: true, action: "review", written: true, queue_id: rec.id };
  }

  // reject：不写任何集合/队列（审计由 pipeline 负责）
  function reject(draft, reason) {
    return { ok: true, action: "reject", written: false, reason: strSafe(reason) };
  }

  // 状态变化（集合内）：必须经存储层状态机校验，非法迁移在 store 层拒绝
  function setStatus(id, toStatus, opts2 = {}) {
    return store.updateStatus(id, toStatus, opts2 || {});
  }

  // 人工裁决回流（C5 管理台用）：approve → 草稿（可修订）落集合；reject_with_reason → 移出队列
  function resolveQueue(queueId, decision, opts2 = {}) {
    if (readonly) return { ok: false, error: "readonly" };
    const q = loadQueue();
    const idx = q.findIndex((x) => x.id === queueId);
    if (idx < 0) return { ok: false, error: "not_found: " + queueId };
    const rec = q[idx];
    if (rec.status !== "pending_review") return { ok: false, error: "already_resolved: " + rec.status };
    if (decision === "approve") {
      const draft = { ...(opts2.edit || {}), ...rec.draft };
      // 0928 合并候选：批准即用 LLM 合并文本覆盖正文；旧条目置 superseded(reason=merged) 并回链新条目
      let mergeInfo = null;
      if (rec.merge && rec.merge.merged_text) {
        draft.text = rec.merge.merged_text;
      }
      // 1007：kind 可空进待审（门卫建议+人工更换）——approve 时仍未分类则明确拒绝，提示先更换
      if (draft.kind == null || !["fact", "rule", "event"].includes(draft.kind)) {
        return { ok: false, error: "kind 未分类：请先在待审页选择/更换分类（可用门卫建议）再通过" };
      }
      const r = store.create(draft);
      if (!r.ok) return { ok: false, error: r.error };
      // 1002-22 老数据重跑（记忆改造第 5 项）：批准即「新条目入池 + 旧条目沉底」，一步到位不留重复。
      // 用户 1002 拍板：「都放在待审，放一起；批准的话旧记忆沉底、新记忆入池」。
      // reason 受状态机限制只有 updated/merged/contradiction_resolved：merge 用 merged，update/supplement 用 updated。
      // create 没有旧条目（本来就是补抽）；sink 走建议列表，根本不进待审。旧条目已沉底/归档的不动。
      let backfillInfo = null;
      const bf = rec.draft && rec.draft.backfill;
      if (bf && typeof bf === "object") {
        const ids = [];
        const pushId = function (v) {
          const s = v == null ? "" : String(v).trim();
          if (s && ids.indexOf(s) < 0) ids.push(s);
        };
        if (Array.isArray(bf.merge_ids)) bf.merge_ids.forEach(pushId);
        pushId(bf.target_id);
        const reason = bf.action === "merge" ? "merged" : "updated";
        const oldList = [];
        for (let i = 0; i < ids.length; i++) {
          const oid = ids[i];
          const old = store.get(oid);
          if (!old) { oldList.push({ old_id: oid, superseded: false, reason: "missing" }); continue; }
          if (old.status !== "active") { oldList.push({ old_id: oid, superseded: false, reason: "not_active:" + old.status }); continue; }
          const up = store.updateStatus(oid, "superseded", { reason: reason, supersededBy: [r.entry.id] });
          oldList.push({ old_id: oid, superseded: !!up.ok, error: up.ok ? null : (up.error || "unknown") });
        }
        backfillInfo = { action: bf.action || null, new_id: r.entry.id, old: oldList };
      }
      if (rec.merge && rec.merge.merged_text && rec.merge.from_id) {
        const old = store.get(rec.merge.from_id);
        if (old && old.status === "active") {
          const up = store.updateStatus(rec.merge.from_id, "superseded", { reason: "merged", supersededBy: [r.entry.id] });
          mergeInfo = { old_id: rec.merge.from_id, superseded: up.ok, error: up.ok ? null : up.error, merged_id: r.entry.id };
        } else {
          mergeInfo = { old_id: rec.merge.from_id, superseded: false, reason: old ? "not_active" : "missing", merged_id: r.entry.id };
        }
      }
      q.splice(idx, 1);
      flushQueue();
      return { ok: true, action: "admit", entry: r.entry, resolved: rec, merge: mergeInfo, backfill: backfillInfo };
    }
    if (decision === "reject_with_reason") {
      q.splice(idx, 1);
      flushQueue();
      return { ok: true, action: "rejected_by_review", reason: strSafe(opts2.note), resolved: rec };
    }
    return { ok: false, error: "未知 decision: " + decision };
  }

  // 后台门卫结果只允许写回仍在人工待审中的记录，且只更新评分字段，不覆盖人工编辑/裁决。
  function updatePendingJudge(queueId, patch = {}) {
    if (readonly) return { ok: false, error: "readonly" };
    const q = loadQueue();
    const idx = q.findIndex((x) => x.id === queueId);
    if (idx < 0) return { ok: false, error: "not_found" };
    const rec = q[idx];
    if (rec.status !== "pending_review") return { ok: false, error: "already_resolved" };
    if (patch.expectedText !== undefined && String(rec.draft && rec.draft.text || "") !== String(patch.expectedText)) {
      return { ok: false, error: "candidate_changed" };
    }
    if (rec.source !== "memory_add" || !["pending", "running", "failed"].includes(rec.judge_status)) {
      return { ok: false, error: "not_async_judge_job" };
    }
    if (patch.judge && typeof patch.judge === "object") {
      rec.judge = patch.judge;
      rec.draft = Object.assign({}, rec.draft || {}, { judge: patch.judge });
      for (const k of ["worth", "worth_reason", "volatility", "volatility_reason"]) {
        if (patch.judge[k] !== undefined) rec.draft[k] = patch.judge[k];
      }
    }
    if (patch.details) rec.details = Array.isArray(rec.details) ? rec.details.concat(patch.details) : patch.details;
    if (patch.judge_status) rec.judge_status = patch.judge_status;
    if (patch.judge_error !== undefined) rec.judge_error = patch.judge_error;
    if (patch.judge_attempts !== undefined) rec.judge_attempts = patch.judge_attempts;
    rec.judge_updated_at = nowIso();
    flushQueue();
    return { ok: true, record: rec };
  }

  // 1002-09 待审草稿编辑：仅改 pending_review 记录的 draft 白名单字段，不裁决不入库；
  // 编辑痕迹 push 进 details（路由回显 reasons），rec.edited 标记供前端展示
  function editQueue(queueId, patch = {}) {
    if (readonly) return { ok: false, error: "readonly" };
    const ALLOW = ["text", "kind", "speaker", "direction"];
    const clean = {};
    for (const k of ALLOW) {
      if (patch[k] === undefined) continue;
      const v = patch[k];
      if (k === "text") {
        const sv = String(v == null ? "" : v).trim();
        if (!sv) return { ok: false, error: "text 不能为空" };
        clean.text = sv;
      } else if (k === "kind") {
        const kv = String(v == null ? "" : v).trim();
        if (!["fact", "rule", "event"].includes(kv)) return { ok: false, error: "kind 非法: " + kv };
        clean.kind = kv;
      } else {
        clean[k] = v == null ? null : String(v).trim();
      }
    }
    if (Object.keys(clean).length === 0) return { ok: false, error: "无可编辑字段" };
    const q = loadQueue();
    const idx = q.findIndex(function (x) { return x.id === queueId; });
    if (idx < 0) return { ok: false, error: "not_found: " + queueId };
    const rec = q[idx];
    if (rec.status !== "pending_review") return { ok: false, error: "already_resolved: " + rec.status };
    rec.draft = Object.assign({}, rec.draft || {}, clean);
    rec.details = Array.isArray(rec.details) ? rec.details.slice() : [];
    rec.details.push({ action: "edited", at: nowIso(), fields: Object.keys(clean) });
    rec.edited = true;
    flushQueue();
    return { ok: true, queue_id: rec.id, draft: rec.draft, fields: Object.keys(clean) };
  }

  function listQueue(status = "pending_review") {
    return loadQueue().filter((x) => x.status === status);
  }

  return {
    admit, review, reject, setStatus, resolveQueue, listQueue, editQueue, updatePendingJudge,
    paths: { collection: store.paths.collection, queue: queuePath },
    readonly,
  };
}

function strSafe(v) { return v == null ? null : String(v); }

module.exports = { createStateExecutor };
