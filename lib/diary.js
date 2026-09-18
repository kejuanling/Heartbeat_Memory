'use strict';
// 日记共享模块（2026-09-16）：日常聊天（routes/chat.js）与唤醒（lib/wake-scheduler.js）共用，
// 保证 [DIARY] 块提取与日记文件写入口径一致，杜绝两处漂移。
// 依赖注入：baseDir（项目根目录）、readEnvValue（gateway cachedEnv 读取，管理台保存即刷新）。

const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone } = require("../time_utils");

module.exports = function createDiaryLib(deps) {
  const { baseDir, readEnvValue } = deps;
  const TIME_ZONE = require("../time_utils").resolveTimeZone();

  // 布尔环境读取："1/true/yes/on"（不分大小写）视为真，未设置用 fallback
  function readBooleanEnv(key, fallback = false) {
    const raw = String(readEnvValue(key) ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    return ["1", "true", "yes", "on"].includes(raw);
  }

  // 日记目录（与 wake_up.js 期一致）：DIARY_DIR 绝对路径直接用，否则挂在项目根下
  const DIARY_DIR_NAME = readEnvValue("DIARY_DIR") || "diary";
  const DIARY_DIR_PATH = path.isAbsolute(DIARY_DIR_NAME) ? DIARY_DIR_NAME : path.join(baseDir, DIARY_DIR_NAME);

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
      // 日记按会话分开保存（2026-09-12）：会话目录命名与 gateway safeSessionToken 同规则
      let token = "default";
      if (sessionId && sessionId !== "default") {
        token = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "") || "default";
      }
      const targetDir = path.join(DIARY_DIR_PATH, token);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        console.log("[diary] 创建日记目录:", targetDir);
      }
      // 每篇一个新文件（2026-09-19 批6 D1）：文件名 = 日期_时分秒.md，隐藏/阅览粒度从「天」变「篇」。
      // 注入/阅览/隐藏三侧扫描口径已同步扩为 YYYY-MM-DD[_HHMMSS].md；旧的一天一文件保持兼容。
      const parts = getDatePartsInTimeZone(new Date(), TIME_ZONE);
      const base = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
      const entry = `## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
      let diaryFile = path.join(targetDir, `${base}.md`);
      try {
        fs.writeFileSync(diaryFile, entry, { encoding: "utf-8", flag: "wx" });
      } catch (writeErr) {
        if (writeErr && writeErr.code === "EEXIST") {
          // 同秒已存在（理论罕见）：换后缀重试，绝不覆盖已有篇
          diaryFile = path.join(targetDir, `${base}-1.md`);
          fs.writeFileSync(diaryFile, entry, { encoding: "utf-8", flag: "wx" });
        } else {
          throw writeErr;
        }
      }
      console.log(`[diary] 已保存日记（会话 ${token}）：${diaryFile} (${cleanContent.length} 字符)`);
      return true;
    } catch (err) {
      console.error("[diary] 保存日记失败:", err.message);
      return false;
    }
  }

  // ---- [DIARY] 块提取（只接受模型显式输出的 [DIARY] 块，避免把普通内容误写进日记）----
  function extractDiaryFromResponse(text) {
    const diaryBlocks = [];
    let remainingText = String(text || "")
      .replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
        const diary = String(content || "").trim();
        if (diary) diaryBlocks.push(diary);
        return "";
      })
      .trim();
    // 容错：模型输出被截断或漏写 [/DIARY] 时，把开标签之后剩余内容视为日记
    remainingText = remainingText
      .replace(/\[DIARY\][\s\S]*$/i, (m) => {
        const diary = m.replace(/^\[DIARY\]/i, "").trim();
        if (diary) diaryBlocks.push(diary);
        return "";
      })
      .trim();
    // 兜底：清除残留的 [DIARY]/[/DIARY] 标记，避免泄漏到展示
    remainingText = remainingText.replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
    return { diaryContent: diaryBlocks.join("\n\n").trim(), remainingText };
  }

  // 给日记原文包 [DIARY] 标签（用于时间线 kind=diary 消息存储，完整上下文统一带标签）
  function wrapDiaryTag(content) {
    const clean = String(content || "").replace(/\[DIARY\]|\[\/DIARY\]/gi, "").trim();
    if (!clean) return "";
    return "[DIARY]" + clean + "[/DIARY]";
  }

  return { appendDiaryEntry, extractDiaryFromResponse, wrapDiaryTag };
};
