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
  // 被消费方：context-v2-runtime.assembleAndApply（2026-10-03 commit 6c93586 起真正生效；
  // 1010-26/28 口径定为：override=false → 只保留人设+时间线本体，仅 relevant_memories 独立保留，
  // 且跳过生成注入快照）。此前 V1 拆除后无人读，API/UI 形同虚设。
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

  // 1010-26 契约重构：会话级「跨窗口注入内容」多选（inject_blocks），8 项 key。
  //   锁死（默认注入且不可取消）：system_instructions（永久上下文）/ state_machine（本会话状态机）
  //   默认（可取消）：core_identity / long_term_understanding / conversation_continuity（日记 Earlier Days）
  //   按需（默认不勾）：starred_dialog（标星的对话）/ notebook_index（笔记本目录，2026-10-16 新增，共 9 项）/ state_inherit（继承上个会话状态）/ recent_dialog（最近20条对话原文）
  // 结构：data/session_cfg/<token>.json 的 inject_blocks 数组；缺省 null = 跟随全局默认（DEFAULT_INJECT_BLOCKS）。
  // 旧 key 自动迁移：permanent→system_instructions / summary→core_identity+long_term_understanding /
  //                  diary→conversation_continuity / state→state_machine。
  const LOCKED_INJECT_BLOCKS = ["system_instructions", "state_machine"];
  const DEFAULT_INJECT_BLOCKS = ["system_instructions", "state_machine", "core_identity", "long_term_understanding", "conversation_continuity"];
  const ALL_INJECT_BLOCKS = ["system_instructions", "core_identity", "long_term_understanding", "conversation_continuity", "starred_dialog", "notebook_index", "state_inherit", "recent_dialog", "state_machine"];
  const LEGACY_INJECT_BLOCKS = {
    permanent: ["system_instructions"],
    summary: ["core_identity", "long_term_understanding"],
    diary: ["conversation_continuity"],
    state: ["state_machine"],
  };

  // 归一化：合法 key 去重 + 旧 key 迁移 + 锁死项强制并入。返回 null 表示"未设置"（跟随全局默认）。
  function normalizeInjectBlocks(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    const push = function (k) { if (ALL_INJECT_BLOCKS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k); };
    list.forEach(function (k) {
      const mapped = LEGACY_INJECT_BLOCKS[k];
      if (mapped) mapped.forEach(push);
      else push(k);
    });
    LOCKED_INJECT_BLOCKS.forEach(push);
    return out;
  }

  function readInjectBlocks(sessionId) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    try {
      if (fs.existsSync(file)) {
        const o = fs.readJsonSync(file);
        if (o && Array.isArray(o.inject_blocks)) {
          // 合法 key 去重 + 旧 key 迁移 + 锁死项强制并入（锁死项恒在，区别仅剩 null=跟随全局默认）
          return normalizeInjectBlocks(o.inject_blocks);
        }
      }
    } catch (e) { console.warn("[session-cfg] 读取 inject_blocks 失败:", e.message); }
    return null; // null = 跟随全局默认（DEFAULT_INJECT_BLOCKS 三块）
  }

  // 标星对话注入条数：0 = 全量；未设置时默认全量。
  function readStarredDialogLimit(sessionId) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    try {
      if (fs.existsSync(file)) {
        const o = fs.readJsonSync(file);
        const n = Number(o && o.starred_dialog_limit);
        if (Number.isFinite(n) && n >= 0) return Math.min(10000, Math.floor(n));
      }
    } catch (e) { console.warn("[session-cfg] 读取 starred_dialog_limit 失败:", e.message); }
    return 0;
  }

  function saveStarredDialogLimit(sessionId, limit) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    let o = {};
    try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
    let n = Number(limit);
    if (!Number.isFinite(n) || n < 0) n = 0;
    o.starred_dialog_limit = Math.min(10000, Math.floor(n));
    fs.ensureDirSync(SESSION_CFG_DIR);
    fs.writeJsonSync(file, o);
    return o;
  }

  // 会话级 Earlier Days 日记篇数：null = 跟随管理台全局配置；正整数 = 本会话覆盖。
  function readSessionDiaryCount(sessionId) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    try {
      if (fs.existsSync(file)) {
        const o = fs.readJsonSync(file);
        const n = Number(o && o.diary_count_override);
        if (o && o.diary_count_override != null && Number.isFinite(n) && n >= 1) return Math.min(1000, Math.floor(n));
      }
    } catch (e) { console.warn("[session-cfg] 读取 diary_count_override 失败:", e.message); }
    return null;
  }

  function saveSessionDiaryCount(sessionId, count) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    let o = {};
    try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
    if (count === null || count === undefined || String(count).trim() === "") delete o.diary_count_override;
    else {
      let n = Number(count);
      if (!Number.isFinite(n) || n < 1) n = 1;
      o.diary_count_override = Math.min(1000, Math.floor(n));
    }
    fs.ensureDirSync(SESSION_CFG_DIR);
    fs.writeJsonSync(file, o);
    return o;
  }

  function saveInjectBlocks(sessionId, blocks) {
    const token = safeSessionToken(sessionId || "default");
    const file = path.join(SESSION_CFG_DIR, token + ".json");
    let o = {};
    try { if (fs.existsSync(file)) o = fs.readJsonSync(file) || {}; } catch (e) { o = {}; }
    const list = normalizeInjectBlocks(blocks);
    if (list !== null) o.inject_blocks = list;   // 归一化后的集合（锁死项恒在）
    else delete o.inject_blocks;                 // null/undefined = 未设置（跟随全局默认）
    fs.ensureDirSync(SESSION_CFG_DIR);
    fs.writeJsonSync(file, o);
    return o;
  }


  // 2026-10-15 会话分支继承：把父会话的会话级配置文件整体复制给子会话，
  // 覆盖 cross_inject_enabled / inject_blocks / starred_dialog_limit / diary_count_override
  // 及未来新增的会话级键。父会话无配置文件（跟随全局）→ 子会话同样跟随全局，不建文件。
  // 失败只告警不抛出，不影响分支映射本身的保存。
  function inheritFrom(fromSessionId, toSessionId) {
    try {
      const fromToken = safeSessionToken(fromSessionId || "");
      const toToken = safeSessionToken(toSessionId || "");
      if (!fromToken || !toToken || fromToken === toToken) return false;
      const fromFile = path.join(SESSION_CFG_DIR, fromToken + ".json");
      if (!fs.existsSync(fromFile)) return false;
      const o = fs.readJsonSync(fromFile);
      if (!o || typeof o !== "object") return false;
      fs.ensureDirSync(SESSION_CFG_DIR);
      fs.writeJsonSync(path.join(SESSION_CFG_DIR, toToken + ".json"), o);
      return true;
    } catch (e) { console.warn("[session-cfg] 分支继承配置失败:", e.message); return false; }
  }

  return { SESSION_CFG_DIR, sessionCrossInjectOverride, saveSessionCrossInjectOverride, readInjectBlocks, saveInjectBlocks, readStarredDialogLimit, saveStarredDialogLimit, readSessionDiaryCount, saveSessionDiaryCount, inheritFrom, normalizeInjectBlocks, ALL_INJECT_BLOCKS, DEFAULT_INJECT_BLOCKS, LOCKED_INJECT_BLOCKS };
}

module.exports = { createSessionCfg };
