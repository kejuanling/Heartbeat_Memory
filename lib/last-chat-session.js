"use strict";
// 最后一次聊天的会话（2026-10-10 新增）
//
// 为什么需要：需求2「状态机快照注入」的继承源 = 「最后一次聊天的会话」（不是前端
// 上报的「最后打开的会话」——data/current-session.json 由 chat.html 在切会话/搜索/
// 新建时 pushCurrentSession 上报，语义是"最后打开"，会随前端行为漂移）。
// 这里由服务端在 /v1/chat/completions 主聊天请求入口记录，语义精确到"最后一次
// 真实聊天"，且不依赖前端。
//
// 数据落点：data/last_chat_session.json  { session: "<sessionId>", updatedAt: ISO }
// 无文件/空 session = 没有可继承的会话（调用方判空跳过即可）。
const path = require("path");
const fs = require("fs-extra");

function createLastChatSession(baseDir) {
  const FILE = path.join(baseDir, "data", "last_chat_session.json");

  // 主聊天请求入口调用：记录"这次聊天发生在哪个会话"。空 sessionId（default 主会话）
  // 也照记，读取方自行判空；写入失败静默（绝不影响聊天主链路）。
  function record(sessionId) {
    try {
      fs.ensureDirSync(path.dirname(FILE));
      fs.writeJsonSync(FILE, {
        session: String(sessionId || "").trim(),
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (e) {
      console.warn("[last-chat-session] 写入失败（不影响聊天）:", e.message);
      return false;
    }
  }

  // 读最后一次聊天的会话 id；无记录/损坏返回 null。
  function read() {
    try {
      if (!fs.existsSync(FILE)) return null;
      const o = fs.readJsonSync(FILE);
      const s = String((o && o.session) || "").trim();
      return s || null;
    } catch (e) {
      return null;
    }
  }

  return { FILE, record, read };
}

module.exports = { createLastChatSession };
