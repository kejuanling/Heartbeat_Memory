"use strict";

// ========================
// Memory Review 路由（C5）——review 队列人工裁决
// GET  /admin/memory-review/queue            列表（候选摘要/provenance/reasons/audit_id）
// POST /admin/memory-review/queue/:id/approve 裁决通过 → state_executor 落 memory_v2
// POST /admin/memory-review/queue/:id/reject  裁决驳回（记录 reason）→ 移出队列
// 所有裁决动作经 admission.resolveReview 落审计。admission 未初始化时一律 503（V2 停用不影响旧池）。
// ========================

module.exports = function registerMemoryReviewRoutes(app, { basicAuth, admission }) {
  const auth = { preHandler: basicAuth };
  const ready = () => admission != null;

  app.get("/admin/memory-review/queue", auth, async (req, reply) => {
    if (!ready()) return reply.code(503).send({ error: "memory-v2 admission 未初始化" });
    const items = admission.executorMain.listQueue("pending_review").slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).map((q) => ({
      id: q.id,
      status: q.status,
      created_at: q.created_at,
      reason: q.reason,
      audit_id: q.audit_id || null,
      candidate: {
        text: q.draft.text,
        kind: q.draft.kind,
        subject: q.draft.subject,
        speaker: q.draft.speaker || null,
        direction: q.draft.direction || null,
        origin: q.draft.origin,
        // 1002 第 5 项：老数据重跑的动作元信息（action/old_text/merge_ids/target_id/reason），
        // 管理台据此显示「改前 / 改后」对照——不映射出来前端只能看到光秃秃的新正文，没法审。
        backfill: q.draft.backfill || null,
      },
      // 0928 合并草稿：此前一直没被映射出来，管理台那段「既有 / 候选 / 合并后」对照是死代码
      merge: q.merge || null,
      // 1004-04：judge 的纯信息输出 {worth, worth_reason, volatility, volatility_reason, similar[]}，
      // 供待审卡片显示两个分数 + 相似记忆清单（每条可逐条沉底）。judge 不参与决策。
      judge: q.judge || null,
      provenance: q.draft.provenance || null,
      reasons: q.details || [],
    }));
    return reply.send({ items, total: items.length });
  });

  app.post("/admin/memory-review/queue/:id/approve", auth, async (req, reply) => {
    if (!ready()) return reply.code(503).send({ error: "memory-v2 admission 未初始化" });
    const edit = (req.body || {}).edit || null; // 可选字段修订 {kind?,subject?,...}
    const r = admission.resolveReview(req.params.id, "approve", { edit });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    // 1002-22：老数据重跑的候选，把旧条目沉底结果回给前端（管理台据此提示「旧记忆 N 条已沉底」）
    return reply.send({ success: true, action: "admit", entry_id: r.entry ? r.entry.id : null, backfill: r.backfill || null });
  });

  app.post("/admin/memory-review/queue/:id/edit", auth, async (req, reply) => {
    if (!ready()) return reply.code(503).send({ error: "memory-v2 admission 未初始化" });
    const patch = {};
    for (const k of ["text", "kind", "subject", "speaker", "direction"]) {
      if ((req.body || {})[k] !== undefined) patch[k] = (req.body || {})[k];
    }
    const r = admission.editQueue(req.params.id, patch);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    const q = admission.executorMain.listQueue("pending_review").find(function (x) { return x.id === req.params.id; });
    const out = {
      id: r.queue_id,
      status: q ? q.status : "pending_review",
      created_at: q ? q.created_at : null,
      reason: q ? q.reason : null,
      audit_id: q ? q.audit_id : null,
      candidate: q ? { text: q.draft.text, kind: q.draft.kind, subject: q.draft.subject, speaker: q.draft.speaker || null, direction: q.draft.direction || null, origin: q.draft.origin } : null,
      provenance: q ? q.draft.provenance || null : null,
      reasons: q ? q.details || [] : [],
    };
    return reply.send({ success: true, item: out });
  });

  app.post("/admin/memory-review/queue/:id/reject", auth, async (req, reply) => {
    if (!ready()) return reply.code(503).send({ error: "memory-v2 admission 未初始化" });
    const note = (req.body || {}).note || null;
    const r = admission.resolveReview(req.params.id, "reject_with_reason", { note });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return reply.send({ success: true, action: "rejected_by_review", reason: r.reason });
  });
};
