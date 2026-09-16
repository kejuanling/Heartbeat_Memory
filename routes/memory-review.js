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
    const items = admission.executorMain.listQueue("pending_review").map((q) => ({
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
      },
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
    return reply.send({ success: true, action: "admit", entry_id: r.entry ? r.entry.id : null });
  });

  app.post("/admin/memory-review/queue/:id/reject", auth, async (req, reply) => {
    if (!ready()) return reply.code(503).send({ error: "memory-v2 admission 未初始化" });
    const note = (req.body || {}).note || null;
    const r = admission.resolveReview(req.params.id, "reject_with_reason", { note });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return reply.send({ success: true, action: "rejected_by_review", reason: r.reason });
  });
};
