"use strict";
// 会话 ID → 安全文件名 token（2026-09-21 审查 R20 收敛）：
// 此前 server.js / lib/diary.js / context-replacements.js 各有一份实现，
// diary.js 版本清洗后为空时落 "default"，与 server.js 的 md5 兜底口径不同，
// 会让纯中文等会话的日记混写进同一目录。全项目统一引用本模块，禁止再复制。
const crypto = require("crypto");

function safeSessionToken(sessionId) {
  if (!sessionId || sessionId === "default") return "default";
  // 只允许安全的会话ID字符，防止路径穿越；清洗后为空（如纯中文）用 md5 兜底，
  // 保证不同会话各自独立目录/文件，不串数据
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "");
  return safe || ("h" + crypto.createHash("md5").update(String(sessionId)).digest("hex").slice(0, 12));
}

module.exports = { safeSessionToken };
