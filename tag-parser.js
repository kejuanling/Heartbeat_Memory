"use strict";

const memoryEngine = require("./memory-engine");

const PIN_TAG_RE = /<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi;
const MEMORY_TAG_RE = /<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi;

// 剥离所有 <memory>/<pin> 标签（含属性写法、未闭合标签），供流式过滤/时间线匹配复用
function stripTags(text) {
  return String(text || "")
    .replace(/<\s*memory\b[^>]*>([\s\S]*?)<\s*\/memory\s*>/gi, "")
    .replace(/<\s*pin\b[^>]*>([\s\S]*?)<\s*\/pin\s*>/gi, "")
    .replace(/<\s*wake\b[^>]*>([\s\S]*?)<\s*\/wake\s*>/gi, "")
    .replace(/<\s*quiet\b[^>]*>([\s\S]*?)<\s*\/quiet\s*>/gi, "")
    .replace(/<\s*compacted\b[^>]*>([\s\S]*?)<\s*\/compacted\s*>/gi, "")
    .replace(/<\s*(?:memory|pin|wake|quiet|compacted)\b[^>]*>/gi, "")
    .replace(/<\s*(?:memory|pin|wake|quiet|compacted)\b[^>]*$/gi, "");
}

// 宽松解析 {key:value,...}：值可不带引号，值里含逗号也能正确处理；
// 按 ",key:" 切分（只认已知键），兼容系统提示词教的 <pin>{title:...,content:...}</pin> 写法
function parseKeyValueBlock(raw, keys) {
  const trimmed = String(raw || "").trim().replace(/^\{|\}$/g, "");
  const re = new RegExp(",\\s*(?=(?:" + keys.join("|") + ")\\s*:)", "i");
  const parts = trimmed.split(re);
  const out = {};
  for (const part of parts) {
    const m = part.match(/^\s*(title|content|type|category|importance|reason|pinned)\s*[:=]\s*(.*)$/i);
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

async function extractAndStore(text) {
  if (!text) return text;

  const promises = [];

  // --- <memory> 轻量辅助：AI 顺手写的重要记忆 → 记忆池（自动去重，非必需） ---
  const pinMatches = text.matchAll(PIN_TAG_RE);

  for (const match of pinMatches) {
    const raw = match[1];
    const parsed = parsePinContent(raw);

    if (parsed && parsed.content) {
      const entry = {
        title: parsed.title || '',
        content: parsed.content
        // 不传 order：交给 memory-engine 追加到尾部，避免 AI 顺手写的钉选永远插到最前打乱手动排序
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

  // --- <memory> 轻量辅助：AI 顺手写的重要记忆 → 记忆池（自动去重，非必需） ---
  // 支持在标签内写 {category:"关于她", importance:0.8} 指定分类/重要级，如
  //   <memory>{category:"关于我们",importance:0.9}她喜欢在看电影时牵手</memory>
  const memoryMatches = text.matchAll(MEMORY_TAG_RE);
  for (const match of memoryMatches) {
    const raw = (match[1] || "").trim();
    if (!raw) continue;
    let body = raw, category = "", importance = null, pinned = false;
    const metaMatch = raw.match(/^\s*\{[\s\S]*?\}\s*([\s\S]*)$/);
    if (metaMatch && /^\s*\{/.test(raw)) {
      const head = raw.slice(0, raw.indexOf("}") + 1);
      const kv = parseKeyValueBlock(head, ["category", "importance", "type", "pinned"]);
      if (kv.category) category = String(kv.category).trim();
      if (kv.importance != null && isFinite(kv.importance)) importance = Number(kv.importance);
      if (kv.pinned) pinned = (String(kv.pinned) === "true" || String(kv.pinned) === "1");
      body = metaMatch[1].trim();
    }
    if (!body) continue;
    promises.push(
      Promise.resolve().then(function () {
        const memoryPool = require("./memory-pool");
        return memoryPool.ingestSummary(body, { source: "memory_tag", directCategory: category, directImportance: importance, directPinned: pinned });
      }).then(function (r) {
        if (r && (r.added || r.merged)) {
          console.log("[tag-parser] <memory> 已入记忆池:", body.slice(0, 50), "added=", r.added, "merged=", r.merged);
        } else if (r && r.skipped) {
          console.log("[tag-parser] <memory> 重复跳过:", body.slice(0, 50));
        }
        return r;
      }).catch(function (err) {
        console.warn("[tag-parser] <memory> 入库失败:", err.message);
      })
    );
  }

  await Promise.all(promises);
  return stripTags(text).trim();
}

module.exports = { extractAndStore, stripTags };
