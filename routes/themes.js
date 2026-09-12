'use strict';
// 聊天页附件转存 + 静态直出（主题云同步 /v1/themes 在 routes/chat.js，勿在此重复注册）：
// - POST /v1/upload-image  图片/PDF/纯文本 dataURL 转存为 data/uploads/ 下的文件，返回 /uploads/ 短 URL，
//   避免大 base64 塞进 localStorage（配额 ~5MB，塞爆后 setItem 静默失败 = 主题/背景存不上）
// - GET /uploads/:file  网关直出兜底（正常流量走 nginx alias 直读磁盘）
// 鉴权沿用 server.js 的全局 addHook（Bearer 网关 key 或已登录 admin_session），不在此重复。
const path = require('path');
const fsp = require('fs-extra');
const crypto = require('crypto');
const fs = require('fs');
const { imageAbsUrl } = require('./imgurl');

// 附件转存大小上限（MB）：聊天页「设置 → 显示与行为 → 附件大小上限」可调，
// 存 chat-settings.json 的 cfg.upload_max_mb；0.5~30 夹紧（30MB 文件 base64 后仍 < 50MB 请求体上限）。
const DEFAULT_UPLOAD_MAX_MB = 2;
function uploadMaxBytes() {
  let mb = DEFAULT_UPLOAD_MAX_MB;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'chat-settings.json'), 'utf-8'));
    const v = Number(data && data.cfg && data.cfg.upload_max_mb);
    if (Number.isFinite(v) && v > 0) mb = v;
  } catch (e) { /* 配置缺失用默认 */ }
  if (!(mb >= 0.5)) mb = 0.5;
  if (mb > 30) mb = 30;
  return Math.floor(mb * 1024 * 1024);
}

// 支持的附件类型：图片（主题/头像/聊天图沿用）+ PDF / 纯文本（此前 pdf/txt 走 base64 直塞，现统一转存短链）
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt'
};
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain' };
// 通用附件（/v1/upload-file）：mime → 扩展名白名单（映射外一律 .bin + octet-stream，防扩展名注入/可执行直出）
const FILE_MIME_EXT = Object.assign({}, MIME_EXT, {
  'application/json': 'json',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'application/zip': 'zip'
});
function safeBaseName(name) {
  return path.basename(String(name || 'file')).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 80) || 'file';
}

module.exports = function registerThemeRoutes(app, deps) {
  const baseDir = deps && deps.baseDir ? deps.baseDir : __dirname;
  const uploadsDir = path.join(baseDir, 'data', 'uploads');

  app.post('/v1/upload-image', async (req, reply) => {
    const body = req.body || {};
    const m = String(body.data || '').match(/^data:(image\/(?:png|jpeg|webp|gif)|application\/pdf|text\/plain);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) {
      reply.code(400).send({ ok: false, error: '仅支持 png/jpg/webp/gif/pdf/txt 的 dataURL' });
      return;
    }
    const buf = Buffer.from(m[2], 'base64');
    const maxBytes = uploadMaxBytes();
    if (!buf.length || buf.length > maxBytes) {
      reply.code(413).send({ ok: false, error: '附件过大（上限 ' + Math.floor(maxBytes / 1024 / 1024 * 10) / 10 + 'MB，可在聊天页设置调整）' });
      return;
    }
    await fsp.ensureDir(uploadsDir);
    const prefix = m[1] === 'application/pdf' || m[1] === 'text/plain' ? 'att-' : 'img-';
    const name = prefix + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + MIME_EXT[m[1]];
    await fsp.writeFile(path.join(uploadsDir, name), buf);
    reply.send({ ok: true, url: imageAbsUrl(req, '/uploads/' + name) });
  });

  // 通用附件转存（聊天窗口发 PDF/文本/音视频等）：body {name, mime, data(base64 无 dataURL 前缀)}
  // 上限与 /v1/upload-image 同一设置项（cfg.upload_max_mb）；前端 0910 已调用本路由但后端缺失（404），此处补齐。
  app.post('/v1/upload-file', async (req, reply) => {
    const body = req.body || {};
    const b64 = String(body.data || '').replace(/^data:[^,]*,/, '');
    const m = b64.match(/^[A-Za-z0-9+/=]+$/);
    if (!m || !b64) {
      reply.code(400).send({ ok: false, error: 'data 必填：纯 base64 字符串' });
      return;
    }
    const buf = Buffer.from(b64, 'base64');
    const maxBytes = uploadMaxBytes();
    if (!buf.length || buf.length > maxBytes) {
      reply.code(413).send({ ok: false, error: '文件过大（上限 ' + Math.floor(maxBytes / 1024 / 1024 * 10) / 10 + 'MB，可在聊天页设置调整）' });
      return;
    }
    const mime = String(body.mime || 'application/octet-stream');
    const ext = FILE_MIME_EXT[mime] || 'bin';
    const outMime = EXT_MIME[ext] || FILE_MIME_EXT[mime] || 'application/octet-stream';
    const keepName = safeBaseName(body.name);
    await fsp.ensureDir(uploadsDir);
    const name = 'file-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    await fsp.writeFile(path.join(uploadsDir, name), buf);
    reply.send({ ok: true, name: keepName, url: imageAbsUrl(req, '/uploads/' + name), size: buf.length, mime: outMime });
  });

  app.get('/uploads/:file', async (req, reply) => {
    const file = path.basename(String((req.params && req.params.file) || ''));
    let buf;
    try {
      buf = await fsp.readFile(path.join(uploadsDir, file));
    } catch (e) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const ext = (file.split('.').pop() || '').toLowerCase();
    reply
      .type(EXT_MIME[ext] || 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(buf);
  });
};
