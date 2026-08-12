"use strict";

const memoryEngine = require("./memory-engine");

const TAG_RE = /<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi;
const PIN_TAG_RE = /<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi;

// 剥离所有 <memory>/<pin> 标签（含属性写法、未闭合标签），供流式过滤/时间线匹配复用
function stripTags(text) {
  return String(text || "")
    .replace(/<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi, "")
    .replace(/<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi, "")
    .replace(/<\s*(?:memory|pin)\b[^>]*>/gi, "")
    .replace(/<\s*(?:memory|pin)\b[^>]*$/gi, "");
}

// 宽松解析 {key:value,...}：值可不带引号，值里含逗号也能正确处理；
// 按 ",key:" 切分（只认已知键），兼容系统提示词教的 <pin>{title:...,content:...}</pin> 写法
function parseKeyValueBlock(raw, keys) {
  const trimmed = String(raw || "").trim().replace(/^\{|\}$/g, "");
  const re = new RegExp(",\\s*(?=(?:" + keys.join("|") + ")\\s*:)", "i");
  const parts = trimmed.split(re);
  const out = {};
  for (const part of parts) {
    const m = part.match(/^\s*(title|content|type|importance|reason)\s*[:=]\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "importance") {
      const n = parseFloat(val);
      if (isFinite(n)) out.importance = n;
    } else {
      out[key] = val;
    }
  }
  return out;
}

function parseTagContent(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.content) {
      return {
        content: parsed.content.trim(),
        type: parsed.type,
        importance: parsed.importance
      };
    }
  } catch {}

  const out = parseKeyValueBlock(raw, ["type", "content", "importance"]);
  if (out.content) {
    return {
      content: out.content.trim(),
      type: out.type,
      importance: out.importance
    };
  }

  return null;
}

function parsePinContent(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.content) {
      return {
        title: parsed.title || '',
        content: parsed.content.trim(),
        importance: parsed.importance,
        reason: parsed.reason || ''
      };
    }
  } catch {}

  const out = parseKeyValueBlock(raw, ["title", "content", "importance", "reason"]);
  if (out.content) {
    return {
      title: out.title || '',
      content: out.content.trim(),
      importance: out.importance,
      reason: out.reason || ''
    };
  }

  return null;
}

const VALID_TYPES = ["fact", "preference", "emotion"];

async function extractAndStore(text) {
  if (!text) return text;

  const promises = [];

  // --- <memory> tags ---
  const memMatches = text.matchAll(TAG_RE);

  for (const match of memMatches) {
    const raw = match[1];
    const parsed = parseTagContent(raw);

    if (parsed) {
      // 类型不再由 AI 判断：未写 type 或类型非法时兜底为 fact
      const memType = parsed.type && VALID_TYPES.includes(parsed.type) ? parsed.type : "fact";
      const entry = {
        content: parsed.content,
        type: memType,
        importance: parsed.importance !== undefined ? parsed.importance : 0.5,
        source: "inline"
      };
      promises.push(
        memoryEngine.addMemory(entry).catch(err => {
          console.warn("[tag-parser] 记忆写入失败:", err.message);
        })
      );
    } else {
      console.warn("[tag-parser] 标签解析失败:", raw.slice(0, 80));
    }

  }

  // --- <pin> tags ---
  const pinMatches = text.matchAll(PIN_TAG_RE);

  for (const match of pinMatches) {
    const raw = match[1];
    const parsed = parsePinContent(raw);

    if (parsed && parsed.content) {
      const entry = {
        title: parsed.title || '',
        content: parsed.content,
        order: 0
      };
      promises.push(
        memoryEngine.addPinnedMemory(entry).then(result => {
          if (result) {
            console.log("[tag-parser] 钉选写入成功:", parsed.title || parsed.content.slice(0, 50));
          }
          return result;
        }).catch(err => {
          console.warn("[tag-parser] 钉选写入失败:", err.message);
        })
      );
    } else {
      console.warn("[tag-parser] pin标签解析失败:", raw.slice(0, 80));
    }

  }

  await Promise.all(promises);
  return stripTags(text).trim();
}

module.exports = { extractAndStore, stripTags };
