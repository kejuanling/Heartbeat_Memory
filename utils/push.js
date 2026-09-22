'use strict';
// 推送回显 / 时间 纯工具(自 server.js 抽出, 逻辑零改动; writeTimelineAtomic 目标路径改为项目根)
const path = require('path');

// 解析「成功推送回显」正文：格式=（时间 刚刚给某人了某渠道推送：标题｜正文）尾缀
// → { at, user, channel, title, body, tail }；非回显格式返回 null
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
// 解析「未发送推送」的唤醒回显正文：（时间 自动唤醒：本次未发送推送…）
// → channel 固定 '未发送'，原因文字进 body；非回显格式返回 null
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
// 由推送元数据反向拼出标准回显行（管理台编辑推送后重建 content 用，与 parsePushEcho 互逆）
function buildPushEcho(meta) {
  const user = meta.user || (process.env.USER_DISPLAY_NAME || '用户');
  const channel = meta.channel || 'Bark';
  const tail = meta.tail || '';
  return '（' + (meta.at || '') + ' 刚刚给' + user + '发了' + channel + '推送：' + (meta.title || '') + '｜' + (meta.body || '') + '）' + tail;
}
// ISO 时间 → 本地「YYYY-MM-DD HH:mm」（服务器本地时区）；非法输入返回空串
function fmtLocalAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 时间线消息 → 推送回显元数据（管理台推送列表用）：优先结构化字段（push_title/push_body），
// 否则从正文解析；两者都不中返回 null。sent=false 表示「未发送推送」的唤醒回显
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
// 「YYYY-MM-DD HH:mm」→ 本地 epoch 毫秒（推送列表按时间排序用）；解析不出返回 null
function toEpoch(at) {
  const m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// 原子写时间线文件（tmp+rename，防半截 JSON）；缺省目标=项目根主会话时间线。
// ⚠️ 2026-09-22 审查 R19 后**已无生产调用方**（原唯一调用方 routes/push-events.js 的两处写回
// 已改走 server.js 的 loadTimeline/saveTimeline）。本函数绕过 saveTimeline 的四道守卫
// （损坏/过期快照/墓碑/__corrupt）且用固定 .tmp 名（并发互相截断），**不要再用于时间线写入**；
// 如需独立路径，请复用 server.js 的 atomicWriteJsonSync 并自行补守卫。
function writeTimelineAtomic(list, filePath) {
  const fsx = require('fs-extra');
  const targetPath = filePath || path.join(__dirname, '..', 'enhanced_messages.json');
  const tmp = targetPath + '.tmp';
  fsx.writeJsonSync(tmp, list, { spaces: 2 });
  fsx.renameSync(tmp, targetPath);
}
module.exports = { parsePushEcho, parseWakeEcho, buildPushEcho, fmtLocalAt, pushEchoMeta, toEpoch, writeTimelineAtomic };
