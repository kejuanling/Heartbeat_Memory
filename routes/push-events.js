'use strict';
// 推送回显管理路由（自 server.js 拆出；依赖 basicAuth + 项目根 baseDir）
const path = require('path');
const fsx = require('fs-extra');
const { parsePushEcho, parseWakeEcho, buildPushEcho, fmtLocalAt, pushEchoMeta, toEpoch, writeTimelineAtomic } = require('../utils/push');

const TIMELINE_FILE = 'enhanced_messages.json';

function timelinePathFor(baseDir, sessionId) {
  if (!sessionId || sessionId === 'default') {
    return path.join(baseDir, TIMELINE_FILE);
  }
  // 只允许安全的会话ID字符，防止路径穿越
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return path.join(baseDir, TIMELINE_FILE);
  return path.join(baseDir, `enhanced_messages_${safe}.json`);
}

function readTimeline(baseDir, sessionId) {
  const p = timelinePathFor(baseDir, sessionId);
  if (!fsx.existsSync(p)) return null;
  const data = fsx.readJsonSync(p);
  return Array.isArray(data) ? data : null;
}

module.exports = function registerPushEventsRoutes(app, { basicAuth, baseDir }) {

  // 列出推送记录（支持按会话筛选）
  app.get('/admin/push-events', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const sessionId = String(req.query?.session_id || '').trim() || 'default';
      const timeline = readTimeline(baseDir, sessionId);
      if (!timeline) return reply.send({ items: [], session_id: sessionId });
      const items = timeline.filter(function (x) { return !x.deleted; }).map(pushEchoMeta).filter(Boolean);
      items.sort(function (a, b) {
        const ta = toEpoch(a.at), tb = toEpoch(b.at);
        if (ta != null && tb != null) return tb - ta;
        return (b.position || 0) - (a.position || 0);
      });
      reply.send({ items: items, session_id: sessionId });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 编辑推送内容
  app.post('/admin/push-events/update', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      const sessionId = String(b.session_id || '').trim() || 'default';
      const position = Number(b.position);
      const content = String(b.content || '');
      const title = String(b.title || '').trim();
      const body = String(b.body || '').trim();
      if (!body) return reply.send({ error: '内容不能为空' });
      const tlPath = timelinePathFor(baseDir, sessionId);
      if (!fsx.existsSync(tlPath)) return reply.code(404).send({ error: '时间线不存在' });
      const timeline = fsx.readJsonSync(tlPath);
      if (!Array.isArray(timeline)) return reply.send({ error: '时间线不可读' });
      const idx = timeline.findIndex(function (x) { return x.role === 'assistant' && x.position === position && x.content === content; });
      if (idx < 0) return reply.code(404).send({ error: '记录不存在' });
      const msg = timeline[idx];
      const meta = pushEchoMeta(msg) || {};
      msg.content = buildPushEcho({ at: meta.at || '', user: meta.user || '', channel: meta.channel || 'Bark', title: title, body: body, tail: meta.tail || '' });
      msg.push_title = title;
      msg.push_body = body;
      msg.push_tail = meta.tail || '';
      msg.updated_at = new Date().toISOString();
      writeTimelineAtomic(timeline, tlPath);
      reply.send({ success: true, entry: pushEchoMeta(msg), session_id: sessionId });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 删除推送（软删除）
  app.post('/admin/push-events/delete', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      const sessionId = String(b.session_id || '').trim() || 'default';
      const position = Number(b.position);
      const content = String(b.content || '');
      const tlPath = timelinePathFor(baseDir, sessionId);
      if (!fsx.existsSync(tlPath)) return reply.code(404).send({ error: '时间线不存在' });
      const timeline = fsx.readJsonSync(tlPath);
      if (!Array.isArray(timeline)) return reply.send({ error: '时间线不可读' });
      const idx = timeline.findIndex(function (x) { return x.role === 'assistant' && x.position === position && x.content === content; });
      if (idx < 0) return reply.code(404).send({ error: '记录不存在' });
      const msg = timeline[idx];
      // 软删除：不移动数组元素（编号范围不变，避免破坏压缩/替换块），保留原内容供时间排序，
      // 仅打 deleted 标记；模型请求注入、压缩摘要文本、面板都会过滤掉它。
      msg.deleted = true;
      msg.deleted_at = new Date().toISOString();
      writeTimelineAtomic(timeline, tlPath);
      reply.send({ success: true, session_id: sessionId });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });
};
