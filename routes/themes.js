'use strict';
// 聊天页图片转存 + 静态直出（主题云同步 /v1/themes 在 routes/chat.js，勿在此重复注册）：
// - POST /v1/upload-image  背景图/头像 dataURL 转存为 data/uploads/ 下的文件，返回 /uploads/ 短 URL，
//   避免大 base64 塞进 localStorage（配额 ~5MB，塞爆后 setItem 静默失败 = 主题/背景存不上）
// - POST /v1/upload-file   聊天「+」发文件：JSON {name, mime, data(base64)}，任意类型，<=10MB。
//   文件名扩展名只取安全字母数字（服务端生成实际文件名，原始名在响应里回传供前端展示/下载命名）。
// - GET /uploads/<file>  网关直出兜底（正常流量走 nginx alias 直读磁盘）
// 鉴权沿用 server.js 的全局 addHook（Bearer 网关 key 或已登录 admin_session），不在此重复。
const path = require('path');
const fsp = require('fs-extra');
const crypto = require('crypto');
const { imageAbsUrl } = require('./imgurl');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 解码后上限（前端本地校验 1.5MB，留余量）
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 文件上限 10MB（前端同口径校验）
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', yml: 'application/yaml', yaml: 'application/yaml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', css: 'text/css', html: 'text/html',
  pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  bin: 'application/octet-stream', exe: 'application/octet-stream', dmg: 'application/octet-stream',
  apk: 'application/vnd.android.package-archive', ipa: 'application/octet-stream'
};

// 可执行/可借脚本利用的类型，服务端直出时一律按下载处理（防同源存储型 XSS，2026-09-10 审查）
const FORCE_DOWNLOAD_EXT = ['html', 'htm', 'js', 'mjs', 'svg', 'xml', 'css'];

module.exports = function registerThemeRoutes(app, deps) {
  const baseDir = deps && deps.baseDir ? deps.baseDir : __dirname;
  const uploadsDir = path.join(baseDir, 'data', 'uploads');
  app.post('/v1/upload-image', async (req, reply) => {
    const body = req.body || {};
    const m = String(body.data || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) {
      reply.code(400).send({ ok: false, error: '仅支持 png/jpg/webp/gif 的 dataURL' });
      return;
    }
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
      reply.code(413).send({ ok: false, error: '图片过大' });
      return;
    }
    await fsp.ensureDir(uploadsDir);
    const name = 'img-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + MIME_EXT[m[1]];
    await fsp.writeFile(path.join(uploadsDir, name), buf);
    reply.send({ ok: true, url: imageAbsUrl(req, '/uploads/' + name) });
  });

  app.post('/v1/upload-file', async (req, reply) => {
    const body = req.body || {};
    const origName = String(body.name || 'file').trim();
    const b64 = String(body.data || '');
    const mime = String(body.mime || 'application/octet-stream').slice(0, 200);
    if (!b64) {
      reply.code(400).send({ ok: false, error: '缺少文件数据' });
      return;
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) {
      reply.code(400).send({ ok: false, error: '文件内容为空' });
      return;
    }
    if (buf.length > MAX_FILE_BYTES) {
      reply.code(413).send({ ok: false, error: '文件过大（上限 10MB）' });
      return;
    }
    const extMatch = origName.match(/\.([a-zA-Z0-9]{1,12})$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'bin';
    await fsp.ensureDir(uploadsDir);
    const fname = 'file-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    await fsp.writeFile(path.join(uploadsDir, fname), buf);
    reply.send({ ok: true, url: imageAbsUrl(req, '/uploads/' + fname), name: origName, size: buf.length, mime });
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
    const forceDl = FORCE_DOWNLOAD_EXT.indexOf(ext) !== -1;
    reply
      .type(forceDl ? 'application/octet-stream' : (EXT_MIME[ext] || 'application/octet-stream'))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable');
    if (forceDl) reply.header('Content-Disposition', 'attachment; filename="' + file + '"');
    reply.send(buf);
  });
};
