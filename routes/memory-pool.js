'use strict';
// 记忆池管理路由（自 server.js 拆出；依赖 basicAuth + ../memory-pool 模块）
const memoryPool = require('../memory-pool');

module.exports = function registerMemoryPoolRoutes(app, { basicAuth, v2Manual }) {
  // 记忆池列表（管理台）：按类目/关键词/active/pinned 筛选排序，一次带回列表+统计+分类+配置
  app.get('/admin/memory-pool', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const opts = {
        category: req.query.category || '',
        q: req.query.q || '',
        active: req.query.active === '' ? undefined : (req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined),
        pinned: req.query.pinned === '' ? undefined : (req.query.pinned === 'true' ? true : req.query.pinned === 'false' ? false : undefined),
        sort: req.query.sort || 'score'
      };
      reply.send({ items: memoryPool.list(opts), stats: memoryPool.stats(), categories: memoryPool.CATEGORIES, config: memoryPool.getConfig() });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  app.post('/admin/memory-pool', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      if (!String(b.content || '').trim()) return reply.code(400).send({ error: 'content 必填' });
      const r = await memoryPool.add({ content: b.content, category: b.category, importance: b.importance, source: 'manual' });
      // C5：Memory V2 门控钩子（可选注入）。旧池 add 恒执行在前（v2_enabled=true 时旧池也继续写，
      // 兼容承诺）；钩子异常只告警不影响旧池响应。
      let v2 = null;
      if (typeof v2Manual === 'function') {
        try { v2 = await v2Manual(b); } catch (err) { console.warn('[memory-pool] V2 钩子异常:', err.message); }
      }
      reply.send({ success: true, dup: r.dup, entry: r.entry, v2 });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  app.put('/admin/memory-pool/:id', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const r = memoryPool.update(req.params.id, req.body || {});
      if (!r) return reply.code(404).send({ error: '记忆不存在' });
      reply.send({ success: true, entry: r });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  app.delete('/admin/memory-pool/:id', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const ok = memoryPool.remove(req.params.id);
      if (!ok) return reply.code(404).send({ error: '记忆不存在' });
      reply.send({ success: true });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 沉底：把条目标记为失活（active=false，保留不删除），revive 可恢复
  app.post('/admin/memory-pool/sink', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const r = memoryPool.sink(String((req.body || {}).id || ''));
      if (!r) return reply.code(404).send({ error: '记忆不存在' });
      reply.send({ success: true, entry: r });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 复活：把失活条目恢复为 active=true
  app.post('/admin/memory-pool/revive', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const r = memoryPool.revive(String((req.body || {}).id || ''));
      if (!r) return reply.code(404).send({ error: '记忆不存在' });
      reply.send({ success: true, entry: r });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 清洗结果导入：preview=true 只校验+预览统计；确认后 preview=false 应用（应用前自动全量备份）
  app.post('/admin/memory-pool/import', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      const changes = Array.isArray(b.changes) ? b.changes : [];
      if (!changes.length) return reply.code(400).send({ error: 'changes 必填：清洗结果变更数组' });
      const r = await memoryPool.importChanges(changes, { preview: b.preview === true });
      if (!r.ok && !r.preview) return reply.code(400).send(r);
      reply.send(r);
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });
};
