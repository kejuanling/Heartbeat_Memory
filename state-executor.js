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
    if (queue) return queue;
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
      const r = store.create(draft);
      if (!r.ok) return { ok: false, error: r.error };
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
      return { ok: true, action: "admit", entry: r.entry, resolved: rec, merge: mergeInfo };
    }
    if (decision === "reject_with_reason") {
      q.splice(idx, 1);
      flushQueue();
      return { ok: true, action: "rejected_by_review", reason: strSafe(opts2.note), resolved: rec };
    }
    return { ok: false, error: "未知 decision: " + decision };
  }

  // 1002-09 待审草稿编辑：仅改 pending_review 记录的 draft 白名单字段，不裁决不入库；
  // 编辑痕迹 push 进 details（路由回显 reasons），rec.edited 标记供前端展示
  function editQueue(queueId, patch = {}) {
    if (readonly) return { ok: false, error: "readonly" };
    const ALLOW = ["text", "kind", "subject", "speaker", "direction"];
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
        if (!["fact", "rule", "quote", "milestone"].includes(kv)) return { ok: false, error: "kind 非法: " + kv };
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
    admit, review, reject, setStatus, resolveQueue, listQueue, editQueue,
    paths: { collection: store.paths.collection, queue: queuePath },
    readonly,
  };
}

function strSafe(v) { return v == null ? null : String(v); }

module.exports = { createStateExecutor };
