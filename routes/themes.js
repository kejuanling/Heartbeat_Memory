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
// 扩展名 → MIME 回查表（/uploads/:file 直出时定 Content-Type）
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', md: 'text/markdown', csv: 'text/csv', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
// 通用附件（/v1/upload-file）：mime → 扩展名白名单（映射外一律 .bin + octet-stream，防扩展名注入/可执行直出）
const FILE_MIME_EXT = Object.assign({}, MIME_EXT, {
  'application/json': 'json',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
});
const FILE_EXT_MIME = Object.keys(FILE_MIME_EXT).reduce((out, mime) => { out[FILE_MIME_EXT[mime]] = mime; return out; }, {});
const TEXT_PARSE_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'log', 'py', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'xml', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'sh', 'bash', 'zsh', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'sql', 'toml', 'env', 'properties', 'rst', 'tex', 'vue', 'svelte', 'dockerfile', 'gradle', 'lock']);
// 展示用原始文件名净化：只留 basename、非法字符换下划线、截 80 字（落盘名是服务端生成的 file-*，不用它）
function safeBaseName(name) {
  return path.basename(String(name || 'file')).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(0, 80) || 'file';
}

module.exports = function registerThemeRoutes(app, deps) {
  const baseDir = deps && deps.baseDir ? deps.baseDir : __dirname;
  const uploadsDir = path.join(baseDir, 'data', 'uploads');

  // 2026-09-30 E1：dataURL 前缀可伪造，解码后按声明类型探测魔数，不符即拒（txt 无魔数跳过）
  const magicOk = function (mime, b) {
    if (b.length < 12) return false;
    if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47; // \x89PNG
    if (mime === 'image/jpeg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    if (mime === 'image/gif') return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46; // GIF8
    if (mime === 'image/webp') return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // RIFF....WEBP
    if (mime === 'application/pdf') return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
    return true; // text/plain 无魔数
  };

  // 2026-09-30 M2：上传频控（每 IP 60 秒 20 次，超限 429）——/v1 虽有网关鉴权，
  // 这是防御纵深；nginx 侧不加 limit_req（对已鉴权个人系统收益边际小、reload 改动面大）。
  // 键取 X-Real-IP（nginx 全 location 已设，0921 核实），缺失回退 req.ip。
  const UPLOAD_RATE_WINDOW_MS = 60000;
  const UPLOAD_RATE_MAX = 20;
  const _uploadHits = new Map(); // ip -> 时间戳数组
  function uploadRateOk(ip) {
    const now = Date.now();
    const arr = (_uploadHits.get(ip) || []).filter(t => now - t < UPLOAD_RATE_WINDOW_MS);
    if (arr.length >= UPLOAD_RATE_MAX) { _uploadHits.set(ip, arr); return false; }
    arr.push(now);
    _uploadHits.set(ip, arr);
    if (_uploadHits.size > 1000) { // 防 Map 无限增长：顺带清过期键
      for (const [k, v] of _uploadHits) {
        if (!v.some(t => now - t < UPLOAD_RATE_WINDOW_MS)) _uploadHits.delete(k);
      }
    }
    return true;
  }
  const clientIpOf = (req) => String(req.headers['x-real-ip'] || req.ip || '').trim() || 'unknown';

  app.post('/v1/upload-image', async (req, reply) => {
    if (!uploadRateOk(clientIpOf(req))) {
      reply.code(429).send({ ok: false, error: '上传过于频繁，请稍后再试' });
      return;
    }
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
    if (!magicOk(m[1], buf)) {
      reply.code(400).send({ ok: false, error: '内容与声明的文件类型不符' });
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
  // 附件预处理：PDF/DOCX 与文本文件必须在上传阶段确认正文可读取；失败时拒绝附件，避免模型只收到摘要却被误认为读过全文。
  const DOC_TEXT_MAX = 15000;
  async function extractDocTextToCache(fp, mime, name) {
    let parser = null;
    try {
      let text = "";
      const ext = String(name || "").split(".").pop().toLowerCase();
      if (ext === "pdf" || mime === "application/pdf") {
        // pdf-parse 2.x：PDFParse 类 + getText() → { pages, text, total }
        const { PDFParse } = require("pdf-parse");
        const parser = new PDFParse({ data: require("fs").readFileSync(fp), verbosity: 0 });
        const data = await parser.getText();
        text = String((data && data.text) || "");
      } else if (ext === "docx" || String(mime || "").indexOf("wordprocessingml") >= 0) {
        const mammoth = require("mammoth");
        const res = await mammoth.extractRawText({ path: fp });
        text = String((res && res.value) || "");
      }
      text = text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
      if (!text) return false;
      if (text.length > DOC_TEXT_MAX) text = text.slice(0, DOC_TEXT_MAX) + "\n…(内容过长已截断)";
      await fsp.writeFile(fp + ".txt", text);
      console.log("[upload-file] 文档正文已提取: " + name + " → " + text.length + " 字");
      return true;
    } catch (e) {
      console.warn("[upload-file] 文档正文提取失败: " + name + ": " + ((e && e.message) || e));
      return false;
    } finally {
      // pdf-parse 2.x 要显式释放 parser/worker 资源，避免连续上传时累积占用。
      if (parser && typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch (e) { /* 清理失败不覆盖解析结果 */ }
      }
    }
  }

  app.post('/v1/upload-file', async (req, reply) => {
    if (!uploadRateOk(clientIpOf(req))) {
      reply.code(429).send({ ok: false, error: '上传过于频繁，请稍后再试' });
      return;
    }
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
    const mime = String(body.mime || 'application/octet-stream').toLowerCase();
    const suppliedExt = String(body.name || '').split('.').pop().toLowerCase();
    // PDF/DOCX 优先按扩展名进入对应解析器（解析器会验证内容）；其他类型优先用已知 MIME，缺失时再按受控扩展名白名单推断。
    const ext = ((suppliedExt === 'pdf' || suppliedExt === 'docx') && FILE_EXT_MIME[suppliedExt])
      ? suppliedExt
      : (FILE_MIME_EXT[mime] || ((FILE_EXT_MIME[suppliedExt] || TEXT_PARSE_EXTS.has(suppliedExt)) ? suppliedExt : 'bin'));
    const outMime = EXT_MIME[ext] || FILE_EXT_MIME[ext] || (TEXT_PARSE_EXTS.has(ext) ? 'text/plain' : '') || FILE_MIME_EXT[mime] || 'application/octet-stream';
    const keepName = safeBaseName(body.name);
    await fsp.ensureDir(uploadsDir);
    const name = 'file-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    const fp = path.join(uploadsDir, name);
    await fsp.writeFile(fp, buf);
    let parseRequired = false;
    let parseOk = true;
    let parseError = '';
    if (ext === 'pdf' || ext === 'docx') {
      parseRequired = true;
      parseOk = await extractDocTextToCache(fp, outMime, name);
      parseError = '未能提取到正文，请确认文件有效且包含可提取文字';
    } else if (TEXT_PARSE_EXTS.has(ext) || outMime.startsWith('text/') || outMime === 'application/json') {
      parseRequired = true;
      try {
        const text = (await fsp.readFile(fp, 'utf8')).replace(/^\uFEFF/, '').replace(/\u0000/g, '').trim();
        parseOk = !!text;
      } catch (e) { parseOk = false; }
      parseError = '未能读取到文本正文，请检查文件编码或内容';
    }
    if (parseRequired && !parseOk) {
      // 解析失败不留下不可用附件，也不返回成功状态。
      try { await fsp.remove(fp); } catch (e) {}
      try { await fsp.remove(fp + '.txt'); } catch (e) {}
      reply.code(422).send({ ok: false, error: parseError });
      return;
    }
    reply.send({ ok: true, name: keepName, url: imageAbsUrl(req, '/uploads/' + name), size: buf.length, mime: outMime, parsed: parseRequired });
  });

  // 桌面图标换图（PWA 主屏图标）：前端 canvas 已居中裁方，body {icon192, icon512} 为两个 PNG dataURL，
  // 直接覆盖 workspace/push-icon-{192,512}.png（manifest.webmanifest 引用路径固定，无需改动）。
  // 旧图先备份 .bak-<ts>；iOS 缓存主屏图标，换图后需删掉桌面图标重新「添加到主屏幕」才可见。
  app.post('/v1/set-app-icon', async (req, reply) => {
    const body = req.body || {};
    const wsDir = path.join(baseDir, 'workspace');
    const targets = [
      { key: 'icon192', file: path.join(wsDir, 'push-icon-192.png') },
      { key: 'icon512', file: path.join(wsDir, 'push-icon-512.png') },
    ];
    const bufs = [];
    for (const t of targets) {
      const m = String(body[t.key] || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) {
        reply.code(400).send({ ok: false, error: t.key + ' 必填：PNG dataURL' });
        return;
      }
      const buf = Buffer.from(m[1], 'base64');
      if (!buf.length || buf.length > 2 * 1024 * 1024) {
        reply.code(413).send({ ok: false, error: t.key + ' 过大（上限 2MB）' });
        return;
      }
      bufs.push({ file: t.file, buf });
    }
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    for (const b of bufs) {
      try { await fsp.copy(b.file, b.file + '.bak-' + ts); } catch (e) { /* 首次无旧图，忽略 */ }
      await fsp.writeFile(b.file, b.buf);
    }
    reply.send({ ok: true });
  });

  // 网关直出兜底（正常流量走 nginx alias 直读磁盘）：path.basename 剥掉目录成分防路径穿越
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
