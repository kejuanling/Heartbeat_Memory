'use strict';
// 推送回显 / 时间 纯工具(自 server.js 抽出, 逻辑零改动; writeTimelineAtomic 目标路径改为项目根)
const path = require('path');

function parsePushEcho(content) {
  const c = String(content || '').trim();
  const m = c.match(/^（([^（]*?)刚刚给([^：]*?)发了([^：]*?)推送：(.+)$/);
  if (!m) return null;
  const at = (m[1] || '').trim();
  const user = (m[2] || '').trim();
  const channel = (m[3] || '').trim();
  let rest = m[4] || '';
  let tail = '';
  const closeIdx = rest.lastIndexOf('）');
  if (closeIdx >= 0) { tail = rest.slice(closeIdx + 1); rest = rest.slice(0, closeIdx); }
  let title = '', body = '';
  const bar = rest.indexOf('｜');
  if (bar >= 0) { title = rest.slice(0, bar).trim(); body = rest.slice(bar + 1).trim(); }
  else { body = rest.trim(); }
  return { at: at, user: user, channel: channel, title: title, body: body, tail: tail };
}
function parseWakeEcho(content) {
  const c = String(content || '').trim();
  const m = c.match(/^（([^（]*?)自动唤醒：本次未发送推送(.*)$/);
  if (!m) return null;
  const at = (m[1] || '').trim();
  let rest = m[2] || '';
  let tail = '';
  const closeIdx = rest.lastIndexOf('）');
  if (closeIdx >= 0) { tail = rest.slice(closeIdx + 1); rest = rest.slice(0, closeIdx); }
  let body = rest.replace(/^｜/, '').trim();
  if (body.indexOf('原因：') === 0) body = body.slice(3).trim();
  return { at: at, channel: '未发送', title: '自动唤醒', body: body, tail: tail };
}
function buildPushEcho(meta) {
  const user = meta.user || (process.env.USER_DISPLAY_NAME || '用户');
  const channel = meta.channel || 'Bark';
  const tail = meta.tail || '';
  return '（' + (meta.at || '') + ' 刚刚给' + user + '发了' + channel + '推送：' + (meta.title || '') + '｜' + (meta.body || '') + '）' + tail;
}
function fmtLocalAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function pushEchoMeta(msg) {
  if (msg.push_title || msg.push_body) {
    return {
      position: msg.position, content: msg.content,
      at: msg.push_at || fmtLocalAt(msg.time) || '',
      user: msg.push_user || (process.env.USER_DISPLAY_NAME || '用户'),
      channel: msg.push_channel || 'Bark', title: msg.push_title || '', body: msg.push_body || '', tail: msg.push_tail || '', structured: true, sent: true
    };
  }
  const parsed = parsePushEcho(msg.content) || parseWakeEcho(msg.content);
  if (!parsed) return null;
  const wake = parsed.channel === '未发送';
  return { position: msg.position, content: msg.content, structured: false, sent: !wake, at: parsed.at || fmtLocalAt(msg.time) || '', user: parsed.user || (process.env.USER_DISPLAY_NAME || '用户'), channel: parsed.channel || 'Bark', title: parsed.title || '', body: parsed.body || '', tail: parsed.tail || '' };
}
function toEpoch(at) {
  const m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d.getTime();
}
function writeTimelineAtomic(list, filePath) {
  const fsx = require('fs-extra');
  const targetPath = filePath || path.join(__dirname, '..', 'enhanced_messages.json');
  const tmp = targetPath + '.tmp';
  fsx.writeJsonSync(tmp, list, { spaces: 2 });
  fsx.renameSync(tmp, targetPath);
}
module.exports = { parsePushEcho, parseWakeEcho, buildPushEcho, fmtLocalAt, pushEchoMeta, toEpoch, writeTimelineAtomic };
