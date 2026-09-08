'use strict';
// 图片 URL 补全：前端消息/主题图片存成 /uploads/<file>（相对路径，避免大 base64 撑爆 localStorage、
// 且不把公网域名写死在数据里）。但发给上游模型 / 给前端展示时需要绝对 URL：
//   - 前端经 nginx https 进入，浏览器能加载 https://<host>/uploads/...；
//   - 上游 deepseek 只认 https:// 绝对 URL：base64 dataURL 被拒、/uploads/ 相对路径被拒、
//     http:// 被拒（deepseek 不跟随 nginx 的 301→https 跳转），仅 https:// 绝对 URL 可访问。
// 因此这里统一把「请求来源 host + 协议」拼成绝对 URL。公网域名强制 https，本机/内网保留 http。
const pathFn = require('path');

function isLocalHost(host) {
  return /^(localhost|127\.|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
}

// 返回「请求来源」的绝对 URL。req 可为空（回退 localhost）。
function imageAbsUrl(req, pathOrUri) {
  const host = (req && (req.hostname || (req.headers && req.headers.host))) || 'localhost';
  const proto = isLocalHost(host) ? 'http' : 'https';
  const abs = pathOrUri;
  // 已是绝对 URL（http/https 开头）或 dataURL 则不动
  if (/^(https?:)?\/\//.test(abs) || /^data:/i.test(abs) || abs.indexOf('//') === 0) return abs;
  // '/' 开头（相对根路径）→ 拼 host；否则补 '/'
  return proto + '://' + host + (abs.charAt(0) === '/' ? abs : '/' + abs);
}

module.exports = { imageAbsUrl, isLocalHost };
