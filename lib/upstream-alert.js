'use strict';
// 上游余额不足（HTTP 402）检测与提醒（2026-09-28 用户需求）：
// 各上游调用点发现 402 → note402() 记录 + 限频触发推送（默认 60 分钟 1 条，防刷屏）；
// /admin/alerts 后台活动提醒板块读 snapshot() 展示（24h 内有效）。
// 推送函数由 server.js 注入（setPushFn(sendPushNotification)），模块自身不含推送实现。

const fs = require('fs');
const path = require('path');

const ALERT_FILE = path.join(__dirname, '..', 'data', 'upstream_402.json');
const PUSH_INTERVAL_MS = 60 * 60 * 1000;   // 60 分钟
const ALERT_WINDOW_MS = 24 * 3600 * 1000;  // 提醒板块显示窗口 24h

let _state = null;
let _pushFn = null;

function load() {
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf-8'));
  } catch (e) {
    _state = { last402At: 0, lastPushAt: 0, count: 0, lastModel: '', lastDetail: '' };
  }
  return _state;
}
function save() {
  try { fs.writeFileSync(ALERT_FILE, JSON.stringify(_state, null, 2)); } catch (e) {}
}

// 记录一次 402；限频内仅更新记录不推送。返回是否触发了推送。
async function note402(opts) {
  const s = load();
  const now = Date.now();
  const model = String((opts && opts.model) || '').trim();
  const detail = String((opts && opts.detail) || '').trim().slice(0, 200);
  const sessionId = (opts && opts.sessionId) || undefined;
  s.last402At = now;
  s.count = (s.count || 0) + 1;
  if (model) s.lastModel = model;
  if (detail) s.lastDetail = detail;
  let shouldPush = false;
  if (now - (s.lastPushAt || 0) >= PUSH_INTERVAL_MS) {
    s.lastPushAt = now;
    shouldPush = true;
  }
  save();
  if (shouldPush && _pushFn) {
    try {
      await _pushFn({
        title: '服务异常',
        body: '上游模型余额不足（HTTP 402）' + (model ? ' · ' + model : '') +
          '\n唤醒/聊天/工具会间歇失败，请充值或更换 Key',
        sessionId: sessionId,
        channel: 'bark'
      });
    } catch (e) { console.warn('[upstream-alert] 推送失败:', e && e.message); }
  }
  return shouldPush;
}

function setPushFn(fn) { _pushFn = fn; }

// 后台活动提醒板块数据源（24h 内有效）
function snapshot() {
  const s = load();
  return {
    last402At: s.last402At || 0,
    count: s.count || 0,
    lastModel: s.lastModel || '',
    lastDetail: s.lastDetail || ''
  };
}

module.exports = { note402, setPushFn, snapshot };
