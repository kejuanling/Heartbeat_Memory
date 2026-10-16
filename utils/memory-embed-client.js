"use strict";

// Dedicated embedding client for Memory V2.
// Credentials are read from ai-providers.json at runtime and never logged.
// This client is intentionally separate from utils/embed-client.js because
// context-replacements and context-digest still use the local BGE service/cache.
const fs = require("fs");
const path = require("path");

const PROVIDERS_FILE = path.join(__dirname, "..", "ai-providers.json");
const DEFAULT_PROVIDER_NAME = process.env.MEMORY_EMBEDDING_PROVIDER_NAME || "硅基流动体验";
const DEFAULT_MODEL = process.env.MEMORY_EMBEDDING_MODEL || "BAAI/bge-m3";
let embedFailUntil = 0;
let lastError = "";

function resolveConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    const providers = Array.isArray(cfg) ? cfg : (Array.isArray(cfg.providers) ? cfg.providers : []);
    const enabled = providers.filter(p => p && p.enabled !== false && p.api_key && (p.api_url || p.base_url));
    const provider = enabled.find(p => p.name === DEFAULT_PROVIDER_NAME)
      || enabled.find(p => /siliconflow\.cn/i.test(String(p.api_url || p.base_url || "")));
    if (!provider) return null;

    const u = new URL(String(provider.api_url || provider.base_url || "").trim());
    if (/\/chat\/completions\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/chat\/completions\/?$/, "/embeddings");
    } else if (!/\/embeddings\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/$/, "") + "/embeddings";
    }
    u.search = "";
    u.hash = "";
    return { url: u.toString(), apiKey: String(provider.api_key), model: DEFAULT_MODEL };
  } catch (_) {
    return null;
  }
}

async function embedBatch(texts, query, timeoutMs) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || "").trim()).filter(Boolean);
  if (!list.length) return [];
  if (Date.now() < embedFailUntil) return null;

  const cfg = resolveConfig();
  if (!cfg) {
    lastError = "embedding provider unavailable";
    embedFailUntil = Date.now() + 60000;
    return null;
  }

  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), Math.max(2000, Number(timeoutMs) || 15000));
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + cfg.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: cfg.model, input: list, encoding_format: "float" }),
      signal: ctrl.signal
    });
    const data = await resp.json();
    if (!resp.ok) {
      const message = data && (data.message || data.error && (data.error.message || data.error));
      throw new Error("HTTP " + resp.status + (message ? ": " + String(message).slice(0, 160) : ""));
    }
    if (!data || !Array.isArray(data.data) || data.data.length !== list.length) {
      throw new Error("invalid embedding response");
    }
    const ordered = data.data.slice().sort((a, b) => Number(a.index) - Number(b.index));
    const vectors = ordered.map(item => item && Array.isArray(item.embedding) ? item.embedding : null);
    if (vectors.some(v => !v || !v.length || !v.every(Number.isFinite))) {
      throw new Error("invalid embedding vector");
    }
    const dim = vectors[0].length;
    if (vectors.some(v => v.length !== dim)) throw new Error("inconsistent embedding dimensions");
    lastError = "";
    embedFailUntil = 0;
    return vectors.map(v => {
      let norm = 0;
      for (const n of v) norm += n * n;
      norm = Math.sqrt(norm);
      return norm ? v.map(n => n / norm) : v;
    });
  } catch (e) {
    lastError = e.name === "AbortError" ? "timeout" : String(e.message || e).slice(0, 220);
    embedFailUntil = Date.now() + 60000;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fused() { return Date.now() < embedFailUntil; }
function lastFailReason() { return lastError; }
function resetCircuitForTests() { embedFailUntil = 0; lastError = ""; }

module.exports = {
  embedBatch,
  fused,
  lastFailReason,
  resetCircuitForTests,
  EMBED_URL: "https://api.siliconflow.cn/v1/embeddings",
  EMBED_MODEL: DEFAULT_MODEL
};
