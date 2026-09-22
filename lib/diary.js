'use strict';
// 日记共享模块（2026-09-16）：日常聊天（routes/chat.js）与唤醒（lib/wake-scheduler.js）共用，
// 保证 [DIARY] 块提取与日记文件写入口径一致，杜绝两处漂移。
// 依赖注入：baseDir（项目根目录）、readEnvValue（gateway cachedEnv 读取，管理台保存即刷新）。

const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone } = require("../time_utils");
const { safeSessionToken } = require("./session-token"); // 2026-09-21 审查 R20：与 gateway 同口径

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
      // （2026-09-21 审查 R20：改为直接引用共享实现，原本地副本清洗后为空落 "default" 与 gateway 的 md5 兜底不一致）
      const token = safeSessionToken(sessionId);
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
      // 2026-09-22 审查 R24：同秒重复写时原实现落 `${base}-1.md`（连字符后缀），而全系统 5 处
      // 扫描/校验正则只认 `_\d{4,6}` → 文件成功落盘却立刻成孤儿（列表不显示、管理台读不到、
      // 日期提取失败、编辑器拒绝打开）。改为「秒数 +1 重试」，始终产出
      // `YYYY-MM-DD_HHMMSS.md` 同构命名，与全部扫描口径天然一致。
      let diaryFile = path.join(targetDir, `${base}.md`);
      let written = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 5 && !written; attempt++) {
        try {
          fs.writeFileSync(diaryFile, entry, { encoding: "utf-8", flag: "wx" });
          written = true;
        } catch (writeErr) {
          lastErr = writeErr;
          if (writeErr && writeErr.code === "EEXIST") {
            const t = getDatePartsInTimeZone(new Date(Date.now() + (attempt + 1) * 1000), TIME_ZONE);
            diaryFile = path.join(targetDir, `${t.year}-${t.month}-${t.day}_${t.hour}${t.minute}${t.second}.md`);
          } else {
            throw writeErr;
          }
        }
      }
      if (!written) throw (lastErr || new Error("同秒重复写入无法分配唯一文件名"));
      console.log(`[diary] 已保存日记（会话 ${token}）：${diaryFile} (${cleanContent.length} 字符)`);
      return true;
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
