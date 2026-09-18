'use strict';
// 图片 URL 补全：前端消息/主题图片存成 /uploads/<file>（相对路径，避免大 base64 撑爆 localStorage、
// 且不把公网域名写死在数据里）。但发给上游模型 / 给前端展示时需要绝对 URL：
//   - 前端经 nginx https 进入，浏览器能加载 https://<host>/uploads/...；
//   - 上游 deepseek 只认 https:// 绝对 URL：base64 dataURL 被拒、/uploads/ 相对路径被拒、
//     http:// 被拒（deepseek 不跟随 nginx 的 301→https 跳转），仅 https:// 绝对 URL 可访问。
// 因此这里统一把「请求来源 host + 协议」拼成绝对 URL。公网域名强制 https，本机/内网保留 http。
//
// 安全（2026-09-08）：host 不可直接信任客户端提交的 Host 头（可被伪造，构造出任意前缀的
// 上传图片 URL / 缓存污染）。取 host 的优先级改为：
//   1) 环境变量 PUBLIC_BASE_URL（可信、写死的公开基址，如 https://dqbnv.ccwu.cc，最优先）
//   2) 反向代理透传的 X-Forwarded-Host（nginx 透传来访 Host）
//   3) Fastify req.hostname（默认取 Host 头，但经过 Fastify 解析；作兜底）
//   4) 仍未取到则回退 localhost
// 并对最终 host 做净化：去掉端口、路径、查询与空白/换行等非法字符，防止注入。
const pathFn = require('path');

// 本机/内网 host 判定：imageAbsUrl 据此选 http（本机）或 https（公网）拼绝对 URL
function isLocalHost(host) {
  return /^(localhost|127\.|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
}

// 取「可信」的 host（不含 scheme），做了字符与端口净化。
function trustedHost(req) {
  const rawHost = (req && (req.headers && (req.headers['x-forwarded-host'] || req.hostname) || (req.headers && req.headers.host))) || 'localhost';
  // nginx 可能用逗号拼接多个 host，取第一个
  const first = String(rawHost).split(',')[0].trim();
  // 剥掉端口/路径/查询/空白：带括号的 IPv6（[::1]）整体保留闭合 ] 及后续主机，其余剥首冒号及之后
  let host = first;
  const v6 = host.match(/^\[[^\]]*\]/);
  if (v6) host = v6[0];
  else host = host.replace(/[:/?#\s\r\n].*$/, '');
  host = host.replace(/[^A-Za-z0-9.\-\[\]:]/g, '');   // 清残留非法字符
  return host || 'localhost';
}

// 返回「请求来源」的绝对 URL（不含尾斜杠）。req 可为空（回退 localhost）。
function imageAbsUrl(req, pathOrUri) {
  const abs = pathOrUri;
  // 已是绝对 URL（http/https 开头）或 dataURL 则不动
  if (/^(https?:)?\/\//.test(abs) || /^data:/i.test(abs) || abs.indexOf('//') === 0) return abs;
  // 优先使用配置的公开基址（可信）；否则按可信 host 拼
  let base = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (base) {
    // 只取 scheme://host（origin）；用 URL 解析，避免误伤 scheme 的 //（如 https:// 被削成 https:）
    try { base = new URL(base).origin; } catch (e) { base = base.replace(/\/+$/, ''); }
  } else {
    const host = trustedHost(req);
    const proto = isLocalHost(host) ? 'http' : 'https';
    base = proto + '://' + host;
  }
  return base + (abs.charAt(0) === '/' ? abs : '/' + abs);
}

module.exports = { imageAbsUrl, isLocalHost };
