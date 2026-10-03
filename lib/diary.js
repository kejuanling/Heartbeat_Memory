'use strict';
// 日记共享模块（2026-09-16）：日常聊天（routes/chat.js）与唤醒（lib/wake-scheduler.js）共用，
// 保证 [DIARY] 块提取与日记写入口径一致，杜绝两处漂移。
// 2026-10-03：日记存储从「一个日记一个文件」改为 data/diary.json（lib/diary-store 统一管理，
// id 按创建顺序自增、hidden 为字段）；本模块的写入口 appendDiaryEntry 改为 JSON 追加。
// 依赖注入：baseDir（项目根目录）、readEnvValue（gateway cachedEnv 读取，管理台保存即刷新）。

const { getDatePartsInTimeZone, resolveTimeZone } = require("../time_utils");
const { safeSessionToken } = require("./session-token"); // 2026-09-21 审查 R20：与 gateway 同口径
const diaryStore = require("./diary-store");

module.exports = function createDiaryLib(deps) {
  const { baseDir, readEnvValue } = deps;
  const TIME_ZONE = resolveTimeZone();

  // 布尔环境读取："1/true/yes/on"（不分大小写）视为真，未设置用 fallback
  function readBooleanEnv(key, fallback = false) {
    const raw = String(readEnvValue(key) ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    return ["1", "true", "yes", "on"].includes(raw);
  }

  // 当前时间（时区化）的「YYYY-MM-DD HH:mm」串，用作日记条目标题
  function getDiaryTimeString(date = new Date()) {
    const p = getDatePartsInTimeZone(date, TIME_ZONE);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }

  function appendDiaryEntry(content, sessionId) {
    if (!readBooleanEnv("DIARY_ENABLED", true)) {
      console.log("[diary] DIARY_ENABLED=false，跳过保存。请在管理台设置 DIARY_ENABLED=true");
      return false;
    }
    const cleanContent = String(content || "").trim();
    if (!cleanContent) {
      console.log("[diary] 日记内容为空，跳过保存");
      return false;
    }
    try {
      // 日记按会话归属（2026-09-12）：会话标识与 gateway safeSessionToken 同规则；
      // 「default」（无有效会话）归共享层 = session null。
      const token = safeSessionToken(sessionId);
      const session = token === "default" ? null : token;
      // 2026-10-03：写入 data/diary.json（id 由 diary-store 按创建顺序自增）
      const now = new Date();
      const entry = `## ${getDiaryTimeString(now)}\n\n${cleanContent}\n`;
      const saved = diaryStore.addEntry(baseDir, {
        session: session,
        hidden: false,
        created_at: now.toISOString(),
        content: entry,
      });
      console.log(`[diary] 已保存日记（id=${saved.id}，会话 ${session || "共享"}，${cleanContent.length} 字符）`);
      // 2026-10-19：返回完整条目（含 id）——时间线 kind=diary 消息要靠 diary_id 外键与库内条目关联
      // （页面编辑/恢复按 id 同步时间线）。失败仍返回 false，调用方真值判断不受影响。
      return saved;
    } catch (err) {
      console.error("[diary] 保存日记失败:", err.message);
      return false;
    }
  }

  // ---- [DIARY] 块提取（严格模式 2026-09-21：只认成对 [DIARY]…[/DIARY]，漏闭合/残缺标签一律不算日记，
  // 置 tagError=true 由调用方在 developer 判定行回传「标签解析错误，记忆写入失败」——写错标签不纵容）----
  function extractDiaryFromResponse(text) {
    const diaryBlocks = [];
    let remainingText = String(text || "")
      .replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
        const diary = String(content || "").trim();
        if (diary) diaryBlocks.push(diary);
        return "";
      })
      .trim();
    // 严格校验：成对块之外仍残留 [DIARY] 或 [/DIARY] = 标签残缺（漏闭合/孤开标/多尾标）
    const tagError = /\[DIARY\]|\[\/DIARY\]/i.test(remainingText);
    // 残缺标签不进日记，但也不许泄漏进推送/展示文本
    remainingText = remainingText.replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
    return { diaryContent: diaryBlocks.join("\n\n").trim(), remainingText, tagError };
  }

  // 给日记原文包 [DIARY] 标签（用于时间线 kind=diary 消息存储，完整上下文统一带标签）
  function wrapDiaryTag(content) {
    const clean = String(content || "").replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
    if (!clean) return "";
    return "[DIARY]" + clean + "[/DIARY]";
  }

  return { appendDiaryEntry, extractDiaryFromResponse, wrapDiaryTag };
};
