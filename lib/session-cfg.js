"use strict";
// 会话级配置读写（2026-10-03 从 server.js 抽出）
//
// 为什么抽：跨窗口注入开关要真正生效，就得让 context-v2-runtime.js 读到
// sessionCrossInjectOverride——而 context-v2-runtime.js 是被 server.js require 的，
// 反向 require 会形成循环依赖。故把这一族提到 lib，双方 require 同一份实现。
// （server.js 里的模型供应商/模型名覆盖仍留在原地：只有 server 侧消费，无需共享。）
//
// 数据落点不变：data/session_cfg/<safeSessionToken(sessionId)>.json，无文件 = 跟随全局。
const path = require("path");
const fs = require("fs-extra");
const { safeSessionToken } = require("./session-token");

function createSessionCfg(baseDir) {
  const SESSION_CFG_DIR = path.join(baseDir, "data", "session_cfg");   // 会话级配置（如跨窗口注入覆盖）；无文件=跟随全局

  // 会话级跨窗口注入覆盖：true=本会话强制注入, false=本会话关闭, null=跟随全局
  // 2026-10-19 起真正被消费方读取：context-v2-runtime.assembleAndApply 在 override=false 时
  // 过滤掉 conversation_continuity（Earlier Days 块）。此前 V1 拆除后无人读，API/UI 形同虚设。
  function sessionCrossInjectOverride(sessionId) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    try {
      if (fs.existsSync(file)) {
        const o = fs.readJsonSync(file);
        if (o && typeof o.cross_inject_enabled === "boolean") return o.cross_inject_enabled;
      }
    } catch (e) { console.warn("[session-cfg] 读取覆盖失败:", e.message); }
    return null;
  }

  function saveSessionCrossInjectOverride(sessionId, enabled) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    let o = {};
    try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
    if (enabled === null || enabled === undefined) delete o.cross_inject_enabled;
    else o.cross_inject_enabled = !!enabled;
    fs.ensureDirSync(SESSION_CFG_DIR);
    fs.writeJsonSync(file, o);
    return o;
  }

  return { SESSION_CFG_DIR, sessionCrossInjectOverride, saveSessionCrossInjectOverride };
}

module.exports = { createSessionCfg };
