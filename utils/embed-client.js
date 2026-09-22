"use strict";

// ========================
// embed-client — embed-server（本地 bge-small-zh-v1.5）共享客户端
// 供 memory-pool / context-replacements 做真语义检索。
// 失败/超时自动熔断 60s（期间直接返回 null），调用方据此降级回字面相似度。
// ========================

const EMBED_URL = (process.env.EMBED_URL || "http://127.0.0.1:8795").replace(/\/+$/, "");
let embedFailUntil = 0;
let lastError = "";

// texts: string[]；query=true 时按 BGE 约定加检索指令前缀（查询侧专用）
// 返回 number[][]（已 L2 归一化），不可用时返回 null
async function embedBatch(texts, query, timeoutMs) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || "").trim()).filter(Boolean);
  if (!list.length) return [];
  if (Date.now() < embedFailUntil) return null;
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), Math.max(2000, Number(timeoutMs) || 15000));
    const resp = await fetch(EMBED_URL + "/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: list, query: query === true }),
      signal: ctrl.signal
    });
    // 2026-09-22 审查 R4-③：此处原先头一到就 clearTimeout，body 读取裸奔——
    // embed-server 回完头挂起时会拖到 undici 默认 bodyTimeout(300s)，且熔断器不上报。
    // 改为让 timer 覆盖到 resp.json() 结束，由 finally 统一清理（与 server.js:796 同款修法）。
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (!data.ok || !Array.isArray(data.vectors)) throw new Error(data.error || "bad payload");
    return data.vectors;
  } catch (e) {
    lastError = e.name === "AbortError" ? "timeout" : e.message;
    embedFailUntil = Date.now() + 60000;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 当前是否处于熔断期（供调用方决定跳过语义路径，省一次无效等待）
function fused() { return Date.now() < embedFailUntil; }
function lastFailReason() { return lastError; }

module.exports = { embedBatch, fused, lastFailReason, EMBED_URL };
