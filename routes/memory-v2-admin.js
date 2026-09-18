"use strict";
// Memory V2 管理台路由（0918）：V2 集合查看 + 聊天页入池入口（manual_review 模式走流水线进 review）
// 依赖注入：admission = memory-admission 实例（可空=V2 未初始化 503）；baseDir = 项目根。

const path = require("path");
const { createStore } = require("../memory-v2");

module.exports = function registerMemoryV2Admin(app, deps) {
  const { basicAuth, admission, baseDir } = deps;

  function store() {
    return createStore({ rootDir: baseDir, config: {} });
  }

  // V2 集合全量列表 + 统计（管理台「记忆 V2」卡片）
  app.get("/admin/memory-v2/entries", { preHandler: basicAuth }, async (req, reply) => {
    try {
      const s = store();
      const items = s.list({}).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      const stats = { total: items.length, active: 0, superseded: 0, archived: 0, by_kind: {} };
      for (const it of items) {
        if (it.status === "active") stats.active++;
        else if (it.status === "superseded") stats.superseded++;
        else if (it.status === "archived") stats.archived++;
        stats.by_kind[it.kind] = (stats.by_kind[it.kind] || 0) + 1;
      }
      reply.send({ success: true, stats, items });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // 聊天页长按入池 / 管理台手填的 V2 入口：人工发起 → 完整流水线 → 强制 review 队列
  // （裁决 approve 后 formal 入库；旧池不再写——本入口自 0918 起单轨走 V2）
  app.post("/admin/memory-v2/entries", { preHandler: basicAuth }, async (req, reply) => {
    try {
      if (!admission) return reply.code(503).send({ error: "Memory V2 admission 未初始化" });
      const b = req.body || {};
      const content = String(b.content || "").trim();
      if (!content) return reply.code(400).send({ error: "content 必填" });
      const r = admission.submitManual(
        { content, category: b.category, importance: b.importance, kind: b.kind },
        { sessionId: String(b.session_id || "").trim() || null },
        "manual_review"
      );
      if (r.action === "reject") {
        return reply.send({ success: false, action: "reject", reasons: (r.validation && r.validation.reasons) || [] });
      }
      reply.send({
        success: true, action: r.action, mode: r.mode,
        queue_id: r.queue_id || null, entry_id: r.entry_id || null,
        note: r.action === "review" ? "已进 review 队列，待人工裁决后入库" : undefined,
      });
    } catch (err) {
      console.error("[POST /admin/memory-v2/entries] error:", err.message);
      reply.code(500).send({ error: err.message });
    }
  });
};
