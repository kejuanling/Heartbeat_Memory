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

function parseTagContent(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.content && parsed.type) {
      return {
        content: parsed.content.trim(),
        type: parsed.type,
        importance: parsed.importance
      };
    }
  } catch {}

  const contentMatch = raw.match(/content["']?\s*[:=]\s*["']([^"']+)["']/);
  const typeMatch = raw.match(/type["']?\s*[:=]\s*["']([^"']+)["']/);
  const impMatch = raw.match(/importance["']?\s*[:=]\s*([0-9.]+)/);

  if (contentMatch && typeMatch) {
    return {
      content: contentMatch[1].trim(),
      type: typeMatch[1].trim(),
      importance: impMatch ? parseFloat(impMatch[1]) : undefined
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

  const titleMatch = raw.match(/title["']?\s*[:=]\s*["']([^"']+)["']/);
  const contentMatch = raw.match(/content["']?\s*[:=]\s*["']([^"']+)["']/);
  const impMatch = raw.match(/importance["']?\s*[:=]\s*([0-9.]+)/);
  const reasonMatch = raw.match(/reason["']?\s*[:=]\s*["']([^"']+)["']/);

  if (contentMatch) {
    return {
      title: titleMatch ? titleMatch[1].trim() : '',
      content: contentMatch[1].trim(),
      importance: impMatch ? parseFloat(impMatch[1]) : undefined,
      reason: reasonMatch ? reasonMatch[1].trim() : ''
    };
  }

  return null;
}

const VALID_TYPES = ["fact", "preference", "emotion", "unresolved", "resolved", "summary", "moment", "trace", "note"];

async function extractAndStore(text) {
  if (!text) return text;

  const promises = [];

  // --- <memory> tags ---
  const memMatches = text.matchAll(TAG_RE);

  for (const match of memMatches) {
    const raw = match[1];
    const parsed = parseTagContent(raw);

    if (parsed && VALID_TYPES.includes(parsed.type)) {
      const entry = {
        content: parsed.content,
        type: parsed.type,
        importance: parsed.importance !== undefined ? parsed.importance : 0.5,
        source: "inline"
      };
      promises.push(
        memoryEngine.addMemory(entry).catch(err => {
          console.warn("[tag-parser] 记忆写入失败:", err.message);
        })
      );
    } else {
      console.warn("[tag-parser] 标签解析失败或类型无效:", raw.slice(0, 80));
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
