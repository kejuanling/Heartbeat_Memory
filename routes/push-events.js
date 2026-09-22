'use strict';
// 推送回显管理路由（自 server.js 拆出；依赖 basicAuth + baseDir + loadTimeline/saveTimeline）
const path = require('path');
const fsx = require('fs-extra');
const { parsePushEcho, parseWakeEcho, buildPushEcho, fmtLocalAt, pushEchoMeta, toEpoch } = require('../utils/push');

const TIMELINE_FILE = 'enhanced_messages.json';

const { safeSessionToken } = require('../lib/session-token'); // 2026-09-22 审查 §四.7：收敛手抄副本

// 时间线文件路径（走共享 safeSessionToken，与 gateway / diary / context-replacements 同口径）：
// 清洗为空 → md5 哈希文件名，避免纯中文等非法字符 sid 被错误解析到主会话时间线（读错数据/改错会话）
function timelinePathFor(baseDir, sessionId) {
  const token = safeSessionToken(sessionId);
  if (token === 'default') return path.join(baseDir, TIMELINE_FILE);
  return path.join(baseDir, `enhanced_messages_${token}.json`);
}

// 扫描所有会话时间线文件，返回 [{ sessionId, path }]
function listAllTimelines(baseDir) {
  const files = fsx.readdirSync(baseDir);
  const result = [];
  // 主会话
  if (fsx.existsSync(path.join(baseDir, TIMELINE_FILE))) {
    result.push({ sessionId: 'default', path: path.join(baseDir, TIMELINE_FILE) });
  }
  // 分会话
  for (const f of files) {
    const m = f.match(/^enhanced_messages_([A-Za-z0-9_-]+)\.json$/);
    if (m) {
      result.push({ sessionId: m[1], path: path.join(baseDir, f) });
    }
  }
  return result;
}

// 时间线 → 推送回显条目：取未删除消息中可解析出推送元数据的（pushEchoMeta），附上所属会话
function extractPushItems(timeline, sessionId) {
  if (!Array.isArray(timeline)) return [];
  return timeline
    .filter(function (x) { return !x.deleted; })
    .map(pushEchoMeta)
    .filter(Boolean)
    .map(function (item) {
      return Object.assign({}, item, { session_id: sessionId });
    });
}

module.exports = function registerPushEventsRoutes(app, { basicAuth, baseDir, loadTimeline, saveTimeline }) {

  // 列出推送记录
  // - 传 session_id：只返回该会话的推送
  // - 不传 session_id：返回所有会话的推送（管理台用）
  app.get('/admin/push-events', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const rawSession = String(req.query?.session_id || '').trim();
      const sessionId = rawSession || 'default';
      const wantAll = rawSession === '' && (req.query?.all === '1' || req.query?.all === 'true');

      let items = [];
      if (wantAll || rawSession === '') {
        // 汇总所有会话
        const timelines = listAllTimelines(baseDir);
        for (const tl of timelines) {
          try {
            if (!fsx.existsSync(tl.path)) continue;
            const data = fsx.readJsonSync(tl.path);
            items = items.concat(extractPushItems(data, tl.sessionId));
          } catch (e) {
            console.warn('[push-events] 读取会话时间线失败:', tl.sessionId, e.message);
          }
        }
      } else {
        // 单会话
        const p = timelinePathFor(baseDir, sessionId);
        if (fsx.existsSync(p)) {
          const data = fsx.readJsonSync(p);
          items = extractPushItems(data, sessionId);
        }
      }

      items.sort(function (a, b) {
        const ta = toEpoch(a.at), tb = toEpoch(b.at);
        if (ta != null && tb != null) return tb - ta;
        return (b.position || 0) - (a.position || 0);
      });
      reply.send({ items: items, session_id: rawSession || 'all' });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 编辑推送内容（必须带 session_id）
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
      // 2026-09-22 审查 R19：改走 gateway 的 loadTimeline/saveTimeline——原实现
      // readJsonSync → 改 → writeTimelineAtomic 整份写回，绕过 saveTimeline 四道守卫
      // （损坏 / 过期快照 / 墓碑 / __corrupt），且用固定 .tmp 名：读与写之间任何其它写入
      // （生成中回复收尾、唤醒落库）都会被整份覆盖掉。loadTimeline 带 __fp 快照指纹，
      // saveTimeline 据此拒写并发冲突，拒绝时回 409 让前端刷新重试而非静默丢数据。
      const timeline = loadTimeline(sessionId);
      if (!Array.isArray(timeline)) return reply.send({ error: '时间线不可读' });
      const idx = timeline.findIndex(function (x) { return (x.role === 'assistant' || x.role === 'developer') && x.position === position; });
      if (idx < 0) return reply.code(404).send({ error: '记录不存在' });
      const msg = timeline[idx];
      const meta = pushEchoMeta(msg) || {};
      msg.content = buildPushEcho({ at: meta.at || '', user: meta.user || '', channel: meta.channel || 'Bark', title: title, body: body, tail: meta.tail || '' });
      msg.push_title = title;
      msg.push_body = body;
      msg.push_tail = meta.tail || '';
      msg.updated_at = new Date().toISOString();
      if (saveTimeline(timeline, sessionId) === false) {
        return reply.code(409).send({ error: '时间线已被其它写入更新（或已删除），请刷新后重试' });
      }
      reply.send({ success: true, entry: Object.assign({}, pushEchoMeta(msg), { session_id: sessionId }), session_id: sessionId });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });

  // 删除推送（软删除，必须带 session_id）
  app.post('/admin/push-events/delete', { preHandler: basicAuth }, async (req, reply) => {
    try {
      const b = req.body || {};
      const sessionId = String(b.session_id || '').trim() || 'default';
      const position = Number(b.position);
      const content = String(b.content || '');
      const tlPath = timelinePathFor(baseDir, sessionId);
      if (!fsx.existsSync(tlPath)) return reply.code(404).send({ error: '时间线不存在' });
      // 2026-09-22 审查 R19：同 update 路由，改走 loadTimeline/saveTimeline（守卫 + 快照指纹）
      const timeline = loadTimeline(sessionId);
      if (!Array.isArray(timeline)) return reply.send({ error: '时间线不可读' });
      const idx = timeline.findIndex(function (x) { return (x.role === 'assistant' || x.role === 'developer') && x.position === position; });
      if (idx < 0) return reply.code(404).send({ error: '记录不存在' });
      const msg = timeline[idx];
      msg.deleted = true;
      msg.deleted_at = new Date().toISOString();
      if (saveTimeline(timeline, sessionId) === false) {
        return reply.code(409).send({ error: '时间线已被其它写入更新（或已删除），请刷新后重试' });
      }
      reply.send({ success: true, session_id: sessionId });
    } catch (err) { reply.code(500).send({ error: err.message }); }
  });
};
