"use strict";
/*
 * context-rerank.js
 * context_search 的 LLM 精排（增强层）：输入粗检索分组后的候选组，让 LLM 挑出
 * 真正回答/解释当前查询的候选组。职责只有「选候选」，不回答用户问题、不改写原文。
 *
 * 回退契约：任何失败（总开关关闭 / 无可用供应商 / 网络异常 / 超时 / 输出无法解析 /
 * 选中的 id 全部非法 / LLM 判定全不相关）都返回 picked=null + meta.reranker="baseline"，
 * 由调用方保持基线排序返回——LLM 只让结果更聪明，绝不成为检索的单点故障。
 *
 * 供应商复用统一配置 ai-providers.json：默认取 is_default 且 enabled 的供应商，
 * env CONTEXT_SEARCH_RERANK_PROVIDER（按 id 或 name 匹配）/ CONTEXT_SEARCH_RERANK_MODEL
 * 可单独覆盖；总开关 env CONTEXT_SEARCH_RERANK=0/off/false 时整体停用。
 */

const fs = require("fs");
const path = require("path");

const PROVIDERS_FILE = path.join(__dirname, "ai-providers.json");
const RERANK_VIEW_CHARS = 200;      // 给 LLM 看的每条候选正文截断长度（过长会拉长思考模型耗时）
const RERANK_MAX_CANDIDATES = 30;   // 送入 LLM 的候选组上限（spec 粗检索候选 20~40 区间）
const RERANK_TIMEOUT_MS = Math.max(1000, Math.floor(Number(process.env.CONTEXT_SEARCH_RERANK_TIMEOUT_MS) || 10000));
// 供应商多为思考模型（如 glm-5.3-flash）：思考 token 也计入 max_tokens，上限太小会
// 让思考吃额度、正文 content 为空——精排解析全灭（2026-09-18 线上实测）。
const RERANK_MAX_OUTPUT_TOKENS = 1500;

function rerankDisabled() {
  const v = String(process.env.CONTEXT_SEARCH_RERANK || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

// 纯函数：从供应商列表里挑精排用的供应商（测试可直测）
function pickRerankProvider(list) {
  const enabled = (Array.isArray(list) ? list : []).filter(function (p) {
    return p && p.enabled && String(p.api_url || "").trim().startsWith("http") && !/\s/.test(String(p.api_url || "").trim()) && String(p.model || "").trim();
  });
  if (enabled.length === 0) return null;
  const want = String(process.env.CONTEXT_SEARCH_RERANK_PROVIDER || "").trim();
  const wantModel = String(process.env.CONTEXT_SEARCH_RERANK_MODEL || "").trim();
  const picked =
    (want && enabled.find(function (p) { return String(p.id) === want || String(p.name) === want; })) ||
    enabled.find(function (p) { return p.is_default; }) ||
    enabled[0];
  if (!picked) return null;
  return {
    api_url: String(picked.api_url).trim(),
    api_key: String(picked.api_key || ""),
    model: wantModel || String(picked.model).trim()
  };
}

// 兼容两种顶层形态：{ providers: [...] }（现行 ai-providers.json）或直接的 [...] 数组
function pickProvidersFromConfig(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return (parsed && Array.isArray(parsed.providers)) ? parsed.providers : null;
}

function resolveRerankProvider() {
  // 2026-09-24：优先按用途路由（设置里给「记忆重排」指定的模型），未指定则回退原自选逻辑
  try {
    const { provider, model } = require("./model-router").resolveRoleModel("rerank");
    if (provider && model) {
      return { api_url: String(provider.api_url || provider.base_url || "").trim(), api_key: provider.api_key || "", model: model };
    }
  } catch (e) {}
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf-8"));
  } catch (e) {
    return null;
  }
  return pickRerankProvider(pickProvidersFromConfig(parsed));
}

function _candidateId(i) { return "c" + String(i + 1).padStart(2, "0"); }

function buildRerankPrompt(query, candidates, pickMax) {
  const lines = candidates.map(function (c) {
    return c.id + " | " + (c.time || "时间未知") + " | " + (c.role || "?") + " | " + (c.session || "?") + " | " + c.text;
  });
  return [
    "你是历史对话检索的筛选器。下面给你一次检索的查询，以及粗检索返回的候选片段。",
    "任务：挑出与查询真正相关的候选——能直接回答查询、或提供查询所需的背景/细节/后续结果的都算相关；只是碰巧出现相似词语的不算。",
    "允许挑多段互相配套的候选（比如一段给背景、一段给细节、一段给结果）；最多挑 " + pickMax + " 个；宁缺毋滥，都不相关就输出空数组。",
    "只输出一个 JSON 数组（元素是候选 id 字符串），如 [\"c03\",\"c11\"]；不要输出解释，不要输出数组以外的任何内容。",
    "",
    "【查询】" + query,
    "【候选】",
    lines.join("\n")
  ].join("\n");
}

// 解析 LLM 输出：容忍 markdown 代码块与数组外少量废话；id 必须在候选集合内、去重、保序
function parsePickedIds(raw, validIds) {
  if (raw == null) return { ok: false, error: "空输出" };
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const l = s.indexOf("[");
  const r = s.lastIndexOf("]");
  if (l === -1 || r === -1 || r < l) return { ok: false, error: "输出里没有 JSON 数组" };
  let arr;
  try {
    arr = JSON.parse(s.slice(l, r + 1));
  } catch (e) {
    return { ok: false, error: "JSON 解析失败" };
  }
  if (!Array.isArray(arr)) return { ok: false, error: "输出不是数组" };
  const seen = new Set();
  const picked = [];
  for (const x of arr) {
    const id = String(x).trim();
    if (validIds.has(id) && !seen.has(id)) { seen.add(id); picked.push(id); }
  }
  return { ok: true, picked: picked };
}

/*
 * 主入口。
 * @param {string} query 检索查询（用户原话或显式 q）
 * @param {Array<Array>} groups 粗检索分组后的候选组（每组 g[0] 为代表消息，含 content/time/role/session/source）
 * @param {Object} opts { pickMax, timeoutMs, fetchFn(测试注入) }
 * @returns {Promise<{picked: Array<number>|null, meta: {reranked:boolean, reranker:string, reason?, model?}}>}
 *   picked = 选中候选组在 groups 里的下标（按 LLM 给出的顺序）；null = 回退基线排序
 */
async function rerankGroupsWithLLM(query, groups, opts) {
  const o = opts || {};
  const pickMax = Math.max(1, Math.floor(Number(o.pickMax) || 5));
  const fetchFn = o.fetchFn || fetch;
  const timeoutMs = Math.max(1000, Math.floor(Number(o.timeoutMs) || RERANK_TIMEOUT_MS));

  if (rerankDisabled()) {
    return { picked: null, meta: { reranked: false, reranker: "off", reason: "精排已通过 env 关闭" } };
  }
  const arr = Array.isArray(groups) ? groups : [];
  const candidates = arr.slice(0, RERANK_MAX_CANDIDATES).map(function (g, i) {
    const rep = (g && g[0]) || {};
    const text = String(rep.content || "");
    return {
      id: _candidateId(i),
      time: rep.time || null,
      role: rep.role || "",
      session: rep.session || (rep.source === "imported" ? "imported" : ""),
      text: text.length > RERANK_VIEW_CHARS ? text.slice(0, RERANK_VIEW_CHARS) + "…" : text
    };
  });
  if (candidates.length === 0 || !String(query || "").trim()) {
    return { picked: null, meta: { reranked: false, reranker: "baseline", reason: "无候选或查询为空" } };
  }
  const provider = o.provider || resolveRerankProvider();
  if (!provider) {
    return { picked: null, meta: { reranked: false, reranker: "baseline", reason: "无可用供应商（ai-providers.json）" } };
  }

  const prompt = buildRerankPrompt(query, candidates, pickMax);
  const validIds = new Set(candidates.map(function (c) { return c.id; }));
  const idToIndex = new Map(candidates.map(function (c, i) { return [c.id, i]; }));

  async function callOnce(perTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, perTimeoutMs);
    try {
      const resp = await fetchFn(provider.api_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + provider.api_key
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: RERANK_MAX_OUTPUT_TOKENS,
          stream: false
        }),
        signal: controller.signal
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new Error("响应缺少 choices[0].message");
      return msg;
    } finally {
      clearTimeout(timer);
    }
  }

  // 重试用总预算制：两次尝试共享 timeoutMs 预算（默认 10s，仍在 MCP 调用链 15s 上限内），
  // 剩余不足 1.5s 就不再重试，保证最坏情况总耗时 ≈ timeoutMs，不顶爆上层超时。
  const deadline = Date.now() + timeoutMs;
  let parsed = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining < 1500) break;
    try {
      const msg = await callOnce(Math.max(1000, Math.min(timeoutMs, remaining)));
      // 思考模型可能把答案放在 reasoning_content、content 为空（或反之）：两个字段依次尝试解析
      const raws = [];
      if (typeof msg.content === "string" && msg.content.trim()) raws.push(msg.content);
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) raws.push(msg.reasoning_content);
      if (raws.length === 0) throw new Error("响应没有可解析的 content/reasoning_content");
      for (const raw of raws) {
        parsed = parsePickedIds(raw, validIds);
        if (parsed.ok) break;
        lastErr = parsed.error || "";
      }
    } catch (e) {
      parsed = { ok: false, error: (e && e.message) || String(e) };
      lastErr = parsed.error || "";
    }
    if (parsed && parsed.ok) break;
  }
  if (!parsed.ok) {
    return { picked: null, meta: { reranked: false, reranker: "baseline", reason: "LLM 输出无效: " + lastErr } };
  }
  if (parsed.picked.length === 0) {
    return { picked: null, meta: { reranked: false, reranker: "baseline", reason: "LLM 判定无相关候选" } };
  }

  const picked = parsed.picked.map(function (id) { return idToIndex.get(id); }).filter(function (i) { return i !== undefined; });
  return { picked: picked, meta: { reranked: true, reranker: "llm", model: provider.model } };
}

module.exports = {
  rerankGroupsWithLLM,
  pickRerankProvider,
  pickProvidersFromConfig,
  resolveRerankProvider,
  parsePickedIds,
  _candidateId
};
