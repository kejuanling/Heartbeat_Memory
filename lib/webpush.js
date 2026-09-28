'use strict';
// Web Push（iOS 桌面 PWA 系统通知）通道：订阅存取 + VAPID 发送 + 死订阅清理。
// 与 Bark / ntfy 并列的第三条 PUSH_PROVIDER 通道，由 server.js sendPushNotification 分发进来。
// 订阅端点经全局鉴权 hook（公网 /v1 需 Bearer GATEWAY_API_KEY 或管理员登录态）。
const path = require('path');
const fs = require('fs');
const { safeSessionToken } = require('./session-token');

const SUBS_FILE = path.join(__dirname, '..', 'data', 'push_subscriptions.json');
const TTL_SECONDS = 3600;

// web-push 是纯 Node 实现（依赖 node crypto），加载失败只影响本通道，不拖垮进程
function loadWebPushLib() {
  try { return require('web-push'); } catch (e) { return null; }
}

function readSubs() {
  try {
    const j = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (j && Array.isArray(j.subscriptions)) return j;
  } catch (e) {}
  return { subscriptions: [] };
}

// 原子写：临时文件 + rename，避免写一半断电留下截断 JSON
function writeSubs(data) {
  const dir = path.dirname(SUBS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = SUBS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SUBS_FILE);
}

// 订阅校验：endpoint 必须 https，p256dh/auth 必须非空字符串（防脏数据进存储）
function validateSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return 'subscription 缺失';
  const endpoint = String(subscription.endpoint || '').trim();
  if (!/^https:\/\//.test(endpoint)) return 'endpoint 非法';
  const keys = subscription.keys || {};
  if (!String(keys.p256dh || '').trim() || !String(keys.auth || '').trim()) return 'keys(p256dh/auth) 缺失';
  return null;
}

// 按 endpoint upsert（重复订阅不追加），session 经 safeSessionToken 清洗后存储
function upsertSubscription(sessionId, subscription) {
  const invalid = validateSubscription(subscription);
  if (invalid) return { ok: false, reason: invalid };
  const token = safeSessionToken(String(sessionId || 'default'));
  const endpoint = String(subscription.endpoint).trim();
  const data = readSubs();
  const record = {
    session_id: token,
    endpoint,
    keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) },
    updated_at: new Date().toISOString()
  };
  const idx = data.subscriptions.findIndex(s => s.endpoint === endpoint);
  if (idx >= 0) data.subscriptions[idx] = record;
  else data.subscriptions.push(record);
  try {
    writeSubs(data);
    return { ok: true, session_id: token };
  } catch (e) {
    return { ok: false, reason: '订阅写入失败: ' + e.message };
  }
}

function removeSubsByEndpoint(endpoints) {
  if (!endpoints || !endpoints.length) return;
  const dead = new Set(endpoints);
  const data = readSubs();
  data.subscriptions = data.subscriptions.filter(s => !dead.has(s.endpoint));
  try { writeSubs(data); } catch (e) { console.error('[webpush] 死订阅清理写入失败:', e.message); }
}

function getPublicKey() {
  return String(process.env.VAPID_PUBLIC_KEY || '').trim();
}

// 发送到某会话的订阅（sessionId 为空 = 发给全部订阅，用于管理台告警类）。
// 返回契约与 bark/ntfy 分支一致：{ ok, reason?, providerLabel }
async function sendToSession({ title, body, sessionId } = {}) {
  const lib = loadWebPushLib();
  if (!lib) return { ok: false, reason: 'web-push 依赖未安装', providerLabel: 'WebPush' };
  const publicKey = getPublicKey();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(process.env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey) return { ok: false, reason: 'VAPID 密钥未配置', providerLabel: 'WebPush' };
  if (!subject) return { ok: false, reason: 'VAPID_SUBJECT 未配置（Apple 拒绝占位身份）', providerLabel: 'WebPush' };
  try { lib.setVapidDetails(subject, publicKey, privateKey); } catch (e) {
    return { ok: false, reason: 'VAPID 配置无效: ' + e.message, providerLabel: 'WebPush' };
  }

  let subs = readSubs().subscriptions || [];
  if (sessionId) {
    const token = safeSessionToken(String(sessionId));
    subs = subs.filter(s => s.session_id === token);
  }
  if (!subs.length) {
    return { ok: false, reason: sessionId ? '该会话无 WebPush 订阅（未在 PWA 内开启通知）' : 'WebPush 无任何订阅', providerLabel: 'WebPush' };
  }

  const targetUrl = '/chat?from_push=1&session_id=' + encodeURIComponent(sessionId || 'default');
  // 2026-09-26 用户拍板：不要标题行。iOS 在 title 为空时会自动渲染「from + App 名」占位，
  // 无法真正去掉——故把正文顶到加粗标题位，body 留空，通知呈「App 名 + 消息加粗」。
  // 带真实 title 的调用（管理台告警类）不受影响。
  let notifyTitle = String(title || '');
  let notifyBody = String(body || '');
  if (!notifyTitle) { notifyTitle = notifyBody; notifyBody = ''; }
  const payload = JSON.stringify({ title: notifyTitle, body: notifyBody, url: targetUrl });

  let sent = 0;
  const deadEndpoints = [];
  for (const sub of subs) {
    try {
      await lib.sendNotification(sub, payload, { TTL: TTL_SECONDS, timeout: 15000 });
      sent++;
    } catch (e) {
      // 404/410 = 订阅已失效（用户清数据/重装），从存储剔除；其余错误按失败计数不剔除
      if (e && (e.statusCode === 404 || e.statusCode === 410)) deadEndpoints.push(sub.endpoint);
    }
  }
  if (deadEndpoints.length) removeSubsByEndpoint(deadEndpoints);

  if (sent === 0) {
    const reason = deadEndpoints.length === subs.length
      ? '订阅已全部失效并清理，请重新在 PWA 内开启通知'
      : 'WebPush 发送失败（订阅 ' + subs.length + ' 条，成功 0 条）';
    return { ok: false, reason, providerLabel: 'WebPush' };
  }
  return { ok: true, providerLabel: 'WebPush', sent };
}

module.exports = { upsertSubscription, sendToSession, getPublicKey };
