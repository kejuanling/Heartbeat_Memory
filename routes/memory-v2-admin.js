"use strict";
// Memory V2 管理台路由：集合查看/编辑 + 聊天页入池 + 旧池形状映射视图（0919 管理台数据源切换；0920 删重要级/时间衰减）
// 依赖注入：admission = memory-admission 实例（可空）；baseDir = 项目根。

const path = require("path");
const { createStore } = require("../memory-v2");
const v2vectors = require("../memory-v2-vectors");

const KIND_MAP = { "关于她": "fact", "认账": "rule", "拓本": "fact", fact: "fact", rule: "rule", event: "event" }; // 旧池类名 → V2 kind（管理台表单仍传类名，落库前翻译；1002-14 删 quote/milestone，1005-19 加 event）

module.exports = function registerMemoryV2Admin(app, deps) {
  const { basicAuth, admission, baseDir } = deps;

  // 每请求新建 store 实例：memory-v2 惰性加载且写穿透，无跨请求缓存成本
  function store() {
    return createStore({ rootDir: baseDir, config: {} });
  }

  // V2 集合全量列表 + 统计
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

  // 旧池形状映射视图：管理台记忆池页数据源（0919 起前端显示 V2 数据）
  app.get("/admin/memory-v2/pool-view", { preHandler: basicAuth }, async (req, reply) => {
    try {
      const s = store();
      const q = String(req.query.q || "").trim();
      const category = String(req.query.category || "").trim();
      const sort = String(req.query.sort || "recent");
      let mapped = s.list({}).map(e => ({
        id: e.id,
        content: e.text,
        category: e.kind,
        active: e.status === "active",
        pinned: !!e.anchor,
        sunk: e.status === "archived",
        updated_at: e.created_at,
        retrieval_count: 0, // V2 检索恒只读无计数（旧池污染字段的结构性根除）
        source: e.origin,
        status: e.status,
        subject: e.subject,
        // 1005-16：评估标签透传（judge/探针产出；未评估为 null，前端显示占位）
        worth: (typeof e.worth === "number") ? e.worth : null,
        worth_reason: e.worth_reason || null,
        volatility: e.volatility || null,
        volatility_reason: e.volatility_reason || null,
        // 1005-19：关键词/氛围透传（记忆池卡片 mpTagsHtml 渲染用；此前漏映射导致前端恒显示暂无关键词）
        triggers: Array.isArray(e.triggers) ? e.triggers : [],
        vibe: e.vibe || null,
      }));
      if (q) mapped = mapped.filter(x => x.content.includes(q));
      if (category) mapped = mapped.filter(x => x.category === category);
      // 0920 用户拍板：排序只留 最新(recent，默认)/最旧(oldest) 两种
      const dir = sort === "oldest" ? 1 : -1;
      mapped.sort((a, b) => dir * String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
      const stats = {
        total: mapped.length,
        active: mapped.filter(x => x.active).length,
        pinned: mapped.filter(x => x.pinned).length,
        sunk: mapped.filter(x => x.sunk).length,
      };
      reply.send({ success: true, stats, items: mapped });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // 相似分组（0919 第六个统计按钮）：活跃条目按语义向量聚类成组，供人工沉底重复条目。
  // 阈值 ?th= 可调（0.5-0.99，默认 0.85）；embed-server 不可用时 503，前端显示提示。
  app.get("/admin/memory-v2/similar-groups", { preHandler: basicAuth }, async (req, reply) => {
    try {
      let th = Number(req.query.th);
      if (!Number.isFinite(th)) th = 0.85;
      th = Math.min(0.99, Math.max(0.5, th));
      const s = store();
      const rows = s.list({ status: "active" });
      if (!rows.length) return reply.send({ success: true, threshold: th, group_count: 0, groups: [] });
      const ready = await v2vectors.ensureVectors(rows);
      if (!ready) return reply.code(503).send({ error: "向量服务不可用（embed-server 熔断中），稍后再试" });
      v2vectors.pruneVectors(rows); // 全量行清理已消失 id（检索等子集调用不做清理，防误删）
      const byId = new Map(rows.map((r) => [r.id, r]));
      const groups = v2vectors.similarGroups(rows, th).map((g) => ({
        max_sim: g.max_sim,
        items: g.ids.map((id) => {
          const e = byId.get(id);
          return { id: e.id, text: e.text, kind: e.kind, subject: e.subject, created_at: e.created_at };
        }),
      }));
      reply.send({ success: true, threshold: th, group_count: groups.length, groups });
    } catch (err) {
      console.error("[GET /admin/memory-v2/similar-groups] error:", err.message);
      reply.code(500).send({ error: err.message });
    }
  });

  // 新增/编辑入口。
  // 管理台表单（direct:true）=人工即准入，直接建条目（P1 直通，不经 review）；
  // 聊天页长按入池（无 direct）=manual_review，走流水线进 review 队列人工裁决。
  app.post("/admin/memory-v2/entries", { preHandler: basicAuth }, async (req, reply) => {
    try {
      if (!admission) return reply.code(503).send({ error: "Memory V2 admission 未初始化" });
      const b = req.body || {};
      const content = String(b.content || "").trim();
      if (!content) return reply.code(400).send({ error: "content 必填" });

      if (b.direct === true) {
        const kind = KIND_MAP[String(b.category || "").trim()];
        if (!kind) return reply.code(400).send({ error: "category 必须是 fact/rule" });
        const r2 = store().create({
          text: content, kind,
          subject: String(b.subject || "user"),
          origin: "manual",
          provenance: { method: "admin_form" },
        });
        if (!r2.ok) return reply.code(400).send({ error: r2.error });
        if (b.pinned === true) store().updateFields(r2.entry.id, { anchor: true });
        return reply.send({ success: true, action: "admit_new", id: r2.entry.id, entry: r2.entry });
      }

      const r = await admission.submitManual(
        { content, category: b.category, kind: b.kind, speaker: b.speaker, msg_time: b.msg_time },
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

  // 编辑（管理台表单）：content/category/pinned → text/kind/anchor（importance/priority 已删）
  app.put("/admin/memory-v2/entries/:id", { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      const patch = {};
      if (b.content != null) patch.text = String(b.content);
      if (b.category != null) {
        const kind = KIND_MAP[String(b.category).trim()];
        if (!kind) return reply.code(400).send({ error: "category 非法（fact/rule/event）" });
        patch.kind = kind;
      }
      if (b.pinned != null) patch.anchor = !!b.pinned;
      if (b.subject != null) patch.subject = String(b.subject);
      const r = store().updateFields(req.params.id, patch);
      if (!r.ok) return reply.code(400).send({ error: r.error });
      reply.send({ success: true, entry: r.entry });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // 状态机操作：archive（沉底/删除语义，可恢复）| revive（归档恢复）
  app.post("/admin/memory-v2/entries/:id/status", { preHandler: basicAuth }, async (req, reply) => {
    try {
      const action = String((req.body || {}).action || "");
      let r;
      if (action === "archive") r = store().updateStatus(req.params.id, "archived", { reason: "archived" });
      else if (action === "revive") r = store().updateStatus(req.params.id, "active");
      else return reply.code(400).send({ error: "action 必须是 archive/revive" });
      if (!r.ok) return reply.code(400).send({ error: r.error });
      reply.send({ success: true, entry: r.entry });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });

  // 置顶（anchor 注入层标记）
  app.post("/admin/memory-v2/entries/:id/pin", { preHandler: basicAuth }, async (req, reply) => {
    try {
      const r = store().updateFields(req.params.id, { anchor: !!((req.body || {}).pinned) });
      if (!r.ok) return reply.code(400).send({ error: r.error });
      reply.send({ success: true, entry: r.entry });
    } catch (err) {
      reply.code(500).send({ error: err.message });
    }
  });
};
