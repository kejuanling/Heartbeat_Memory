'use strict';
// 记忆两块总结（2026-10-02 记忆系统改造 §8 第 6 项；1003-15 合并生成改造）
//
// 两块：Core Identity（写「规矩」）← 记忆池 active 且 kind=rule
//       Long-term Understanding（写「理解」）← 记忆池 active 且 kind=fact
// 选材口径：★ 全部活跃记忆，不是置顶(anchor)那几条——用户 1002 拍板。
//
// 数据：data/memory_summary_config.json  { enabled, time, incremental, last_run_at, last_run_result }
//       data/memory_summary_cache.json   { core_identity:{text,lines,updated_at,fingerprint,snapshot,mode,...}, understanding:{...} }
//       data/memory_summary_prompt.json  { system_prompt, user_prompt }  ← 1003-15 合并成一份；
//         旧 4 字段（core_identity_* / understanding_*）首次读取时自动迁移拼装成合并版（旧字段保留作历史）。
//
// 更新时机：每晚定时对表一次；到点后**先比指纹**——记忆池没变化就不调 LLM、不重写缓存。
// 指纹：该块选材集合的 sha256(id|text|kind|content_updated_at)，任一变化即视为「有更新」（1007 删 subject）。
// 生成模式（1003-15 用户拍板）：
//   全量（缓存无 snapshot / force / 变化条目 > 存量 50%）→ 单次 LLM 调用，两块材料一次喂，不用工具；
//   增量（变化 ≤ 50%）→ 单次 LLM 调用 + 「关键词检索记忆」工具循环（最多 4 轮），输入 = 上一版 + 增量记忆，
//        模型可自行检索补材料，最后按块标记【CORE_IDENTITY】【UNDERSTANDING】一次输出两块。
// 输出解析：按块标记拆两块，**逐块写缓存**——解析出的块照常更新，缺失/解析失败的块保留上一版。
// 降级：LLM 失败 → 保留上一版缓存 → 缓存也没有 → 注入层回落直注原始条目（builder 里的老逻辑）。

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const timeUtils = require("../time_utils");

const DEFAULT_CONFIG = {
  enabled: true,     // 默认开：指纹没变就不生成，成本极低
  time: "03:30",     // 避开蒸馏（默认 03:00）
  incremental: true, // 允许增量生成；关掉则每次全量重生成
  last_run_at: null,
  last_run_result: null,
};

const CHECK_MS = 30000;                  // 对表间隔
const CATCHUP_WINDOW_MS = 30 * 60 * 1000; // 重启补跑宽限窗
const MODEL_ROLE = "memory_summary";    // 模型角色（1003-11 拆分：与记忆提炼分开配置）
const FULL_LLM_TIMEOUT_MS = 1200000;    // 全量单次：20 分钟（1003-15 后台异步跑，无 nginx 620s 限制）
const TOOL_ROUND_TIMEOUT_MS = 600000;   // 增量工具循环每轮：10 分钟（1003-15 实测 glm 一次生成两块全文超 300s，故提到 600s）
const MAX_TOOL_ROUNDS = 4;              // 工具循环轮数上限（1003-15 用户拍板：最多 4 轮往返）
const INCREMENTAL_MAX_RATIO = 0.5;      // 变化条目超过存量这个比例 → 直接全量
const WARN_CHARS = 2000;                // 单块超过这个字数只在日志/状态里告警，不截断
const KEYWORD_TOP = 20;                 // 检索工具单次最多返回条数

const BLOCK_DEFS = {
  core_identity: { kind: "rule", label: "Core Identity（自我准则）", kindLabel: "规则类" },
  understanding: { kind: "fact", label: "Long-term Understanding（长期理解）", kindLabel: "事实类" },
};
const BLOCK_KEYS = ["core_identity", "understanding"];

function pad2(n) { return String(n).padStart ? String(n).padStart(2, "0") : (Number(n) < 10 ? "0" + n : String(n)); }

function normalizeTime(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return DEFAULT_CONFIG.time;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return pad2(h) + ":" + pad2(mi);
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const j = fs.readJsonSync(file);
    return (j && typeof j === "object") ? j : fallback;
  } catch (e) { return fallback; }
}

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32); }

// 用 http/https 模块发 JSON POST——绕开全局 fetch 底层 undici 的 300s headersTimeout。
// 那个超时不可配，长 prompt 场景会莫名其妙地 fetch failed（1003-14 实跑踩过，memory-distill 同款方案）。
function httpPostJson(url, bodyStr, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("非法 URL: " + url)); }
    const lib = u.protocol === "https:" ? https : http;
    const buf = Buffer.from(bodyStr, "utf-8");
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: (u.pathname || "/") + (u.search || ""),
      method: "POST",
      headers: Object.assign({ "Content-Length": buf.length }, headers || {}),
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf-8") });
      });
      res.on("error", reject);
    });
    // socket 空闲超时：上游迟迟不吐响应头也不会被掐断，直到我们自己定的上限
    req.setTimeout(timeoutMs, function () {
      req.destroy(new Error("LLM 请求超时（" + Math.round(timeoutMs / 1000) + "s 内上游未响应）"));
    });
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

module.exports = function createMemorySummary(deps) {
  const opts = deps || {};
  const baseDir = opts.baseDir || path.resolve(__dirname, "..");
  const CFG_FILE = path.join(baseDir, "data", "memory_summary_config.json");
  const CACHE_FILE = path.join(baseDir, "data", "memory_summary_cache.json");
  const PROMPT_FILE = path.join(baseDir, "data", "memory_summary_prompt.json");
  const POOL_FILE = opts.poolFile || path.join(baseDir, "data", "memory_v2.json");
  const TZ = timeUtils.resolveTimeZone();
  const addLog = typeof opts.addCompactionLog === "function" ? opts.addCompactionLog : null;
  const persistLog = typeof opts.persistCompactionLogs === "function" ? opts.persistCompactionLogs : null;

  const state = { timer: null, running: false, lastError: null };

  function log(msg) {
    // 1003-25：改传对象（字符串入参会被 addCompactionLog 拆成字符索引垃圾）
    try { if (addLog) addLog({ action: "system", label: "后台任务", status: "success", message: "[memory-summary] " + msg }); } catch (_) {}
    try { if (persistLog) persistLog(); } catch (_) {}
  }

  // ---------------- 配置 ----------------
  function readConfig() {
    const c = readJsonSafe(CFG_FILE, {});
    return {
      enabled: c.enabled !== undefined ? !!c.enabled : DEFAULT_CONFIG.enabled,
      time: normalizeTime(c.time),
      incremental: c.incremental !== undefined ? !!c.incremental : DEFAULT_CONFIG.incremental,
      last_run_at: c.last_run_at || null,
      last_run_result: c.last_run_result || null,
    };
  }

  function saveConfig(patch) {
    const cur = readJsonSafe(CFG_FILE, {});
    const next = Object.assign({}, cur, patch || {});
    if (next.enabled !== undefined) next.enabled = !!next.enabled;
    if (next.time !== undefined) next.time = normalizeTime(next.time);
    if (next.incremental !== undefined) next.incremental = !!next.incremental;
    fs.writeJsonSync(CFG_FILE, next, { spaces: 2 });
    return readConfig();
  }

  // ---------------- 缓存 ----------------
  function emptyBlock() {
    return { text: "", lines: [], updated_at: null, fingerprint: null, snapshot: null, mode: null, count: 0, model: null, error: null };
  }

  function readCache() {
    const c = readJsonSafe(CACHE_FILE, {});
    const out = {};
    for (const k of BLOCK_KEYS) {
      const b = (c && c[k]) || {};
      out[k] = Object.assign(emptyBlock(), {
        text: String(b.text || ""),
        lines: Array.isArray(b.lines) ? b.lines.map(String) : [],
        updated_at: b.updated_at || null,
        fingerprint: b.fingerprint || null,
        snapshot: (b.snapshot && typeof b.snapshot === "object") ? b.snapshot : null,
        mode: b.mode || null,
        count: Number(b.count) || 0,
        model: b.model || null,
        error: b.error || null,
      });
    }
    return out;
  }

  function writeBlock(key, patch) {
    const cur = readJsonSafe(CACHE_FILE, {});
    const prev = Object.assign(emptyBlock(), (cur && cur[key]) || {});
    const next = Object.assign({}, prev, patch || {});
    cur[key] = next;
    fs.writeJsonSync(CACHE_FILE, cur, { spaces: 2 });
    return next;
  }

  // ---------------- 提示词（管理台「提示词」页可改，1003-15 合并成一份 system + 一份 user） ----------------

  // 内置默认（合并版）：原两份默认全文拼装 + 块标记输出要求
  function defaultCombinedSystem() {
    return [
      "本次一次生成两块总结，按块标记分隔输出：",
      "【CORE_IDENTITY】",
      "（第一块正文）",
      "【UNDERSTANDING】",
      "（第二块正文）",
      "",
      "=== 第一块 Core Identity（自我准则，规则类记忆）===",
      "你要把一批「规则类记忆」压成一段常驻的自我准则，供 AI 每次对话开头阅读。",
      "要求：",
      "1. 语气是祈使句——写「我该怎么做」，不是「她怎样」。这是给 AI 自己看的行为准则。",
      "2. 保留专有名词与具体细节（人名、地名、物件名、她的原话），禁止抽象成「她喜欢小动物」这类空话。",
      "3. 允许保留矛盾：「她有时…有时…」比「她是个…的人」更真。",
      "4. 不臆断动机，只写记忆里有的；不用排比句、不用标语式总结。",
      "5. 能短则短——同义的两条合并成一条，不为凑内容复述；不设硬上限但不许注水。",
      "6. 与另一块「Long-term Understanding」不得重复同一条信息；既可作规则又可作事实的，归这一块。",
      "7. 只输出正文，不要任何前言、解释、后记。",
      "",
      "=== 第二块 Long-term Understanding（长期理解，事实类记忆）===",
      "你要把一批「事实类记忆」压成一段长期理解，供 AI 每次对话开头阅读。",
      "要求：",
      "1. 语气是陈述句——写「她是什么样的人、我们的长期模式」，不是「我该怎么做」。",
      "2. 保留专有名词与具体细节（人名、地名、物件名、她的原话），禁止抽象成「她喜欢小动物」这类空话。",
      "3. 允许保留矛盾：「她有时…有时…」比「她是个…的人」更真。",
      "4. 不臆断动机，只写记忆里有的；不用排比句、不用标语式总结。",
      "5. 能短则短——同义的两条合并成一条，不为凑内容复述；不设硬上限但不许注水。",
      "6. 与另一块「Core Identity」不得重复同一条信息；既可作规则又可作事实的，归 Core Identity，这块不写。",
      "7. 只输出正文，不要任何前言、解释、后记。",
    ].join("\n");
  }

  // 内置默认 user（合并版）：两块材料分节
  function defaultCombinedUser() {
    return [
      "本次一次生成两块总结，以下是两块各自的材料。",
      "",
      "=== 第一块材料：规则类记忆（Core Identity 用）共 ${RULE_COUNT} 条 ===",
      "${RULE_PREVIOUS_BLOCK}",
      "${RULE_DELTA_BLOCK}",
      "=== 规则类记忆证据 ===",
      "${RULE_MEMORY_LIST}",
      "",
      "=== 第二块材料：事实类记忆（Long-term Understanding 用）共 ${FACT_COUNT} 条 ===",
      "${FACT_PREVIOUS_BLOCK}",
      "${FACT_DELTA_BLOCK}",
      "=== 事实类记忆证据 ===",
      "${FACT_MEMORY_LIST}",
      "",
      "请根据全部证据重新校准「相处模型」与「长期理解模型」。上一版只是旧的理解，不是需要逐条维护的清单；可以保留、合并、重构、拆分或删除旧表达。最终按 system 规定的块标记输出两块当前最准确、最有解释力的模型，不要前言、解释、后记。",
    ].join("\n");
  }

  // 旧 4 字段自定义 → 合并版（1003-15 一次性迁移，用户确认的整理优化版结构）
  function migrateLegacyPrompts(c) {
    const cs = String(c.core_identity_system_prompt || "").trim();
    const cu = String(c.core_identity_user_prompt || "").trim();
    const us = String(c.understanding_system_prompt || "").trim();
    const uu = String(c.understanding_user_prompt || "").trim();
    const system = [
      "本次一次生成两块总结，按块标记分隔输出：",
      "【CORE_IDENTITY】",
      "（第一块正文）",
      "【UNDERSTANDING】",
      "（第二块正文）",
      "",
      "=== 第一块 Core Identity（自我准则，基于规则类记忆）===",
      "以「我该怎么做」的操作视角，输出高密度的相处模型——这些规则共同要求我成为怎样的伴侣；遇到记忆里没有的新情况，依据什么长期原则理解她、理解我们。",
      "",
      cs,
      "",
      "=== 第二块 Long-term Understanding（长期理解，基于事实类记忆）===",
      "以陈述视角输出长期理解——这些经历共同让我理解她什么；出现从未见过的新消息时，这些理解帮我判断什么。",
      "",
      us,
      "",
      "=== 两块共同要求 ===",
      "1. 一条信息只出现一次：既可作规则又可作事实的，只写进最贴切的那一块；同一块内的不同分段之间也不得重复。",
      "2. 允许保留矛盾，但要写出它们之间稳定的结构；不臆断动机，不做心理诊断。",
      "3. 只输出两块正文（块标记 + 正文），不要任何前言、解释、后记。",
      "4. 第一块字数控制在两千以内，第二块控制在三千以内。",
    ].join("\n");
    const mapLegacy = function (u, P) {
      return String(u || "")
        .replace(/\$\{MEMORY_COUNT\}/g, "${" + P + "_COUNT}")
        .replace(/\$\{PREVIOUS_BLOCK\}/g, "${" + P + "_PREVIOUS_BLOCK}")
        .replace(/\$\{DELTA_BLOCK\}/g, "${" + P + "_DELTA_BLOCK}")
        .replace(/\$\{MEMORY_LIST\}/g, "${" + P + "_MEMORY_LIST}");
    };
    const user = [
      "本次一次生成两块总结，以下是两块各自的材料。",
      "",
      "=== 第一块材料：规则类记忆（Core Identity 用）===",
      cu ? mapLegacy(cu, "RULE") : "下面是记忆池里当前活跃的全部规则类记忆，共 ${RULE_COUNT} 条。\n\n${RULE_PREVIOUS_BLOCK}\n\n${RULE_DELTA_BLOCK}\n\n=== 全部记忆证据 ===\n${RULE_MEMORY_LIST}",
      "",
      "=== 第二块材料：事实类记忆（Long-term Understanding 用）===",
      uu ? mapLegacy(uu, "FACT") : "下面是记忆池里当前活跃的全部事实类记忆，共 ${FACT_COUNT} 条。\n\n${FACT_PREVIOUS_BLOCK}\n\n${FACT_DELTA_BLOCK}\n\n=== 全部记忆证据 ===\n${FACT_MEMORY_LIST}",
      "",
      "请按 system 规定的块标记【CORE_IDENTITY】【UNDERSTANDING】分别输出两块正文，不要前言、解释、后记。",
    ].join("\n");
    return { system: system, user: user };
  }

  function readPromptConfig() {
    const c = readJsonSafe(PROMPT_FILE, {});
    const hasLegacy = !!(c.core_identity_system_prompt || c.core_identity_user_prompt || c.understanding_system_prompt || c.understanding_user_prompt);
    if (!c.system_prompt && !c.user_prompt && hasLegacy) {
      // 1003-15 一次性迁移：旧 4 字段拼成合并版写入新字段；旧字段保留作历史
      const m = migrateLegacyPrompts(c);
      c.system_prompt = m.system;
      c.user_prompt = m.user;
      try { fs.writeJsonSync(PROMPT_FILE, c, { spaces: 2 }); } catch (_) {}
    }
    return {
      system_prompt: String(c.system_prompt || ""),
      user_prompt: String(c.user_prompt || ""),
    };
  }

  function savePromptConfig(patch) {
    const cur = readJsonSafe(PROMPT_FILE, {});
    const next = Object.assign({}, cur);
    for (const k of Object.keys(patch || {})) {
      if (k === "system_prompt" || k === "user_prompt") {
        next[k] = patch[k] == null ? "" : String(patch[k]);
      }
    }
    fs.writeJsonSync(PROMPT_FILE, next, { spaces: 2 });
    const out = readPromptConfig();
    // 防呆：自定义 User 提示词里若没有两块记忆清单占位符，模型看不到记忆材料——
    // 不会报错，只会静默地凭空编，是最难查的一类错，保存时就明确提示。
    const warn = [];
    const u = out.user_prompt.trim();
    if (u && u.indexOf("${RULE_MEMORY_LIST}") < 0 && u.indexOf("${FACT_MEMORY_LIST}") < 0) {
      warn.push("User 提示词里没有 ${RULE_MEMORY_LIST}/${FACT_MEMORY_LIST}——模型会看不到记忆清单，只能凭上一版改或自己编。想自己拼清单就不用管，否则请补回去。");
    }
    out.warnings = warn;
    return out;
  }

  // ---------------- 选材与指纹 ----------------
  function selectRows(blockKey) {
    const kind = BLOCK_DEFS[blockKey].kind;
    let all = [];
    try { all = fs.readJsonSync(POOL_FILE); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    return all
      .filter(function (e) { return e && e.status === "active" && e.kind === kind && String(e.text || "").trim(); })
      .sort(function (a, b) { return String(a.created_at || "").localeCompare(String(b.created_at || "")); });
  }

  // 指纹只看「会影响总结内容」的字段：正文变了、条目增删、kind 变了都算变化（1007 删 subject）
  function fingerprintOf(rows) {
    const parts = rows.map(function (e) {
      return [e.id, String(e.text || "").trim(), e.kind, e.content_updated_at || e.created_at || ""].join("|");
    });
    parts.sort();
    return sha256(parts.join("\n"));
  }

  function snapshotOf(rows) {
    const s = {};
    for (const e of rows) s[String(e.id)] = String(e.text || "").trim();
    return s;
  }

  function diffSnapshot(prevSnap, rows) {
    const now = snapshotOf(rows);
    const added = [], changed = [], removed = [];
    for (const id of Object.keys(now)) {
      if (!prevSnap || prevSnap[id] === undefined) added.push(now[id]);
      else if (prevSnap[id] !== now[id]) changed.push(now[id]);
    }
    if (prevSnap) {
      for (const id of Object.keys(prevSnap)) if (now[id] === undefined) removed.push(prevSnap[id]);
    }
    return { added, changed, removed, now };
  }

  // ---------------- 材料拼装 ----------------
  function listText(rows) {
    return rows.map(function (e, i) {
      return (i + 1) + ". " + String(e.text || "").trim();
    }).join("\n");
  }

  // 合并 prompt 组装（1003-15）：需要生成的块各自渲染一个材料分节；占位符 ${RULE_*} / ${FACT_*} 运行时替换
  function buildBothPrompt(blocks, rowsById, prevById, deltaById, modeById, opts) {
    const pc = readPromptConfig();
    const o = opts || {};
    let system = (pc.system_prompt || "").trim() || defaultCombinedSystem();
    if (o.tools) {
      system += "\n\n需要补充查看记忆池时，可调用工具 summary_search 按关键词检索记忆（工具调用轮数最多 " + MAX_TOOL_ROUNDS + " 轮；不需要检索就直接输出正文）。";
    }
    let tpl = (pc.user_prompt || "").trim() || defaultCombinedUser();
    if (blocks.length === 1) {
      const onlyMark = blocks[0] === "core_identity" ? "CORE_IDENTITY" : "UNDERSTANDING";
      tpl += "\n\n本次只输出【" + onlyMark + "】一块（另一块无需生成，不要输出），按 system 规定的格式。";
    }
    const vals = {};
    for (const k of BLOCK_KEYS) {
      const P = k === "core_identity" ? "RULE" : "FACT";
      const gen = blocks.indexOf(k) >= 0;
      const rows = rowsById[k] || [];
      const prev = prevById[k] || emptyBlock();
      const mode = modeById[k] || "full";
      const delta = deltaById[k] || { added: [], changed: [], removed: [] };
      let previousBlock = "（无上一版，这是首次生成）";
      if (prev.text) {
        previousBlock = "【上一版" + BLOCK_DEFS[k].label + "】\n" + prev.text
          + "\n（这只是上一版的理解，不是需要逐条维护的清单。请根据当前全部证据重新校准；可以保留、合并、重构、拆分或删除旧表达。不要因为上一版存在某句话就机械保留；如果多个旧段落可以被更高层原则统一，请主动融合。）";
      }
      let deltaBlock = "";
      if (mode === "incremental") {
        const parts = [];
        if (delta.added.length) parts.push("【新增记忆】\n" + delta.added.map(function (t) { return "- " + t; }).join("\n"));
        if (delta.changed.length) parts.push("【正文有改动的记忆】\n" + delta.changed.map(function (t) { return "- " + t; }).join("\n"));
        if (delta.removed.length) parts.push("【已移除的记忆】（如果上一版里有基于它们的话，删掉那些话）\n" + delta.removed.map(function (t) { return "- " + t; }).join("\n"));
        deltaBlock = parts.join("\n\n");
      }
      // 记忆清单：全量=全部条目；增量=只给增量条目（用户拍板：增量输入=上一版 + 增量记忆，需要更多自己检索）
      const list = (mode === "full") ? listText(rows) : (delta.added.concat(delta.changed).concat(delta.removed)).join("\n");
      vals[P + "_COUNT"] = String(rows.length);
      vals[P + "_PREVIOUS_BLOCK"] = gen ? previousBlock : "";
      vals[P + "_DELTA_BLOCK"] = gen ? deltaBlock : "";
      vals[P + "_MEMORY_LIST"] = gen ? list : "";
    }
    let user = tpl;
    for (const key of Object.keys(vals)) user = user.split("${" + key + "}").join(vals[key]);
    return { system: system, user: user };
  }

  // ---------------- LLM（httpPostJson 自控超时，绕 undici 300s headersTimeout） ----------------
  async function _callChat(messages, opts) {
    const router = require("../model-router");
    const r = router.resolveRoleModel(MODEL_ROLE);
    if (!r || !r.provider || !r.provider.api_url || !r.model) throw new Error("模型未配置（role=" + MODEL_ROLE + "）");
    const base = String(r.provider.api_url).replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
    const body = { model: r.model, messages: messages, temperature: 0.3 };
    if (opts && opts.tools) { body.tools = opts.tools; body.tool_choice = "auto"; }
    const timeoutMs = (opts && opts.timeoutMs) || FULL_LLM_TIMEOUT_MS;
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + String(r.provider.api_key || "") };
    const res = await httpPostJson(url, JSON.stringify(body), headers, timeoutMs);
    if (res.status < 200 || res.status >= 300) throw new Error("LLM HTTP " + res.status + ": " + res.text.slice(0, 200));
    let j;
    try { j = JSON.parse(res.text); } catch (e) { throw new Error("LLM 响应不是 JSON: " + res.text.slice(0, 200)); }
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) throw new Error("LLM 响应缺 choices[0].message");
    const content = msg.content && String(msg.content).trim() ? String(msg.content).trim() : "";
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
    if (!content && !(toolCalls && toolCalls.length)) throw new Error("LLM 返回空内容");
    return { text: content, model: r.model, tool_calls: toolCalls };
  }

  // 全量单次调用（1200s）
  async function callLlm(system, user) {
    const r = await _callChat([{ role: "system", content: system }, { role: "user", content: user }], { timeoutMs: FULL_LLM_TIMEOUT_MS });
    return { text: r.text, model: r.model };
  }

  // 增量工具循环（最多 MAX_TOOL_ROUNDS 轮；最后一轮不带工具，强制输出正文）
  async function callLlmWithTools(system, user) {
    const toolDefs = [{
      type: "function",
      function: {
        name: "summary_search",
        description: "按关键词检索记忆池里活跃的记忆条目（规则类或事实类），返回命中的条目原文及其 id。生成总结时如需补充查看相关记忆（比如增量清单里的记忆想确认完整内容、或想查同主题的其他记忆）可调用。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "检索关键词（一个或多个，用空格分隔）" },
            kind: { type: "string", enum: ["rule", "fact"], description: "可选：限定只检索规则类(rule)或事实类(fact)；不填两类都搜" },
          },
          required: ["query"],
        },
      },
    }];
    const messages = [{ role: "system", content: system }, { role: "user", content: user }];
    let model = null;
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const useTools = rounds < MAX_TOOL_ROUNDS; // 最后一轮不带工具，模型只能输出正文
      const r = await _callChat(messages, { timeoutMs: TOOL_ROUND_TIMEOUT_MS, tools: useTools ? toolDefs : null });
      model = r.model;
      if (!r.tool_calls || !r.tool_calls.length) {
        if (!r.text) throw new Error("LLM 第 " + rounds + " 轮返回空正文");
        return { text: r.text, model: model, rounds: rounds };
      }
      messages.push({ role: "assistant", content: r.text || null, tool_calls: r.tool_calls });
      for (const tc of r.tool_calls) {
        const fn = tc.function || {};
        let args = {};
        try { args = JSON.parse(fn.arguments || "{}"); } catch (e) { args = {}; }
        let res;
        try { res = keywordHit(args.query, args.kind); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
        messages.push({ role: "tool", tool_call_id: tc.id || ("call_" + rounds + "_" + messages.length), content: JSON.stringify(res) });
      }
      log("增量工具循环第 " + rounds + " 轮：模型调用了 " + r.tool_calls.length + " 次 summary_search");
    }
    throw new Error("工具循环达到上限 " + MAX_TOOL_ROUNDS + " 轮仍未输出正文");
  }

  // 关键词检索（1003-08 memory_search 同口径：命中词数降序、最新在前、过滤中文单字词元）
  function keywordHit(query, kind) {
    const q = String(query == null ? "" : query).trim();
    if (!q) return { ok: false, error: "query 不能为空", results: [] };
    const terms = q.toLowerCase()
      .split(/[\s,，、;；]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; })
      .filter(function (s) { return !/^[\u4e00-\u9fa5]$/.test(s); }); // 中文单字词元到处命中，过滤（1003-08 经验）
    if (!terms.length) return { ok: false, error: "关键词无效（拆分后都是单字）", results: [] };
    let all = [];
    try { all = fs.readJsonSync(POOL_FILE); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    const rows = all.filter(function (e) {
      return e && e.status === "active" && String(e.text || "").trim()
        && (!kind || e.kind === kind);
    });
    const scored = [];
    for (const e of rows) {
      const low = String(e.text).toLowerCase();
      let hits = 0;
      for (const t of terms) { if (low.indexOf(t) !== -1) hits++; }
      if (!hits) continue;
      scored.push({ id: e.id, content: String(e.text).trim(), hits: hits, updated: e.content_updated_at || e.created_at || "" });
    }
    scored.sort(function (a, b) { return b.hits - a.hits || String(b.updated).localeCompare(String(a.updated)); });
    return {
      ok: true,
      results: scored.slice(0, KEYWORD_TOP).map(function (r) { return { id: r.id, content: r.content }; }),
      count: scored.length,
    };
  }

  // ---------------- 输出解析 ----------------
  function parseOutput(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const lines = t.split("\n").map(function (s) { return s.replace(/\s+$/, ""); }).filter(function (s) { return s.trim(); });
    return { text: lines.join("\n"), lines: lines };
  }

  // 按块标记拆两块（1003-15）：宽容匹配【CORE_IDENTITY】/【自我准则】、【UNDERSTANDING】/【长期理解】
  function parseBoth(text, wantBlocks) {
    const t = String(text || "").trim();
    const out = {};
    const coreRe = /【\s*CORE[\s_-]?IDENTITY\s*】|【\s*自我准则\s*】/i;
    const undRe = /【\s*UNDERSTANDING\s*】|【\s*长期理解\s*】/i;
    const coreMatch = t.match(coreRe);
    const undMatch = t.match(undRe);
    for (const k of wantBlocks) {
      let sec = null;
      if (k === "core_identity") {
        if (coreMatch) {
          const start = coreMatch.index + coreMatch[0].length;
          const end = undMatch ? undMatch.index : t.length;
          sec = t.slice(start, end);
        }
      } else {
        if (undMatch) sec = t.slice(undMatch.index + undMatch[0].length, t.length);
      }
      out[k] = sec ? parseOutput(sec) : null;
    }
    return out;
  }

  // ---------------- 生成两块（1003-15 合并：一次 LLM 调用出两块，逐块写缓存） ----------------
  async function generateBoth(runOpts) {
    const ro = runOpts || {};
    const cache = readCache();
    const cfg = readConfig();
    const rowsById = {}, fpById = {}, prevById = {}, freshById = {};
    for (const k of BLOCK_KEYS) {
      rowsById[k] = selectRows(k);
      fpById[k] = fingerprintOf(rowsById[k]);
      prevById[k] = cache[k] || emptyBlock();
      freshById[k] = !!(prevById[k].fingerprint && prevById[k].fingerprint === fpById[k] && prevById[k].lines.length > 0);
    }
    const out = { blocks: {}, tool_rounds: 0 };
    // 1004-12：成功块"已更新"细节攒起来合并进汇总条（一次任务只写 1 条悬浮球日志），失败/告警仍单独记
    const updates = [];
    for (const k of BLOCK_KEYS) {
      const rows = rowsById[k];
      const fresh = freshById[k];
      const o = out.blocks[k] = {
        block: k, kind: BLOCK_DEFS[k].kind, count: rows.length, fingerprint: fpById[k],
        fresh: !!(fresh && !ro.force), mode: null, chars: 0, model: null, error: null,
      };
      if (!rows.length) {
        o.mode = "empty";
        o.error = "无活跃记忆（kind=" + BLOCK_DEFS[k].kind + "）";
        continue;
      }
      if (fresh && !ro.force) {
        o.mode = "skipped";
        o.chars = prevById[k].text.length;
        o.updated_at = prevById[k].updated_at;
        o.lines = prevById[k].lines;
        continue;
      }
      if (ro.dryRun) {
        o.mode = "would_generate";
        continue;
      }
    }
    const need = BLOCK_KEYS.filter(function (k) {
      const m = out.blocks[k].mode;
      return m !== "skipped" && m !== "empty" && m !== "would_generate";
    });
    if (ro.dryRun || !need.length) return out;

    // 每块模式：全量 / 增量
    const modeById = {}, deltaById = {};
    for (const k of need) {
      const rows = rowsById[k], prev = prevById[k];
      let delta = diffSnapshot(prev.snapshot, rows);
      const changedCount = delta.added.length + delta.changed.length + delta.removed.length;
      let mode = "full";
      // 1003-15：force（强制重新生成）恒走全量单次调用；仅非 force 时按变化量走增量工具循环
      if (!ro.force && cfg.incremental && prev.snapshot && prev.text && rows.length > 0
        && changedCount <= Math.max(1, Math.floor(rows.length * INCREMENTAL_MAX_RATIO))) {
        mode = "incremental";
      }
      if (mode === "full") delta = diffSnapshot(null, rows);
      modeById[k] = mode;
      deltaById[k] = delta;
    }
    const anyIncremental = need.some(function (k) { return modeById[k] === "incremental"; });
    const p = buildBothPrompt(need, rowsById, prevById, deltaById, modeById, { tools: anyIncremental });
    let parsedBlocks = null, model = null, rounds = 0;
    try {
      const r = anyIncremental ? await callLlmWithTools(p.system, p.user) : await callLlm(p.system, p.user);
      model = r.model;
      rounds = r.rounds || 0;
      parsedBlocks = parseBoth(r.text, need);
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      for (const k of need) {
        out.blocks[k].mode = "failed";
        out.blocks[k].error = msg;
        out.blocks[k].keptPrevious = !!prevById[k].lines.length;
      }
      log("两块生成失败，保留上一版缓存: " + msg);
      return out;
    }
    out.tool_rounds = rounds;
    for (const k of need) {
      const parsed = parsedBlocks[k];
      if (!parsed || !parsed.lines.length) {
        out.blocks[k].mode = "failed";
        out.blocks[k].error = "LLM 输出缺块/为空（按块标记解析不到）";
        out.blocks[k].keptPrevious = !!prevById[k].lines.length;
        log(k + " 输出解析失败，保留上一版缓存");
        continue;
      }
      const saved = writeBlock(k, {
        text: parsed.text,
        lines: parsed.lines,
        updated_at: new Date().toISOString(),
        fingerprint: fpById[k],
        snapshot: snapshotOf(rowsById[k]),
        mode: modeById[k],
        count: rowsById[k].length,
        model: model,
        error: null,
      });
      out.blocks[k].mode = modeById[k];
      out.blocks[k].chars = parsed.text.length;
      out.blocks[k].model = model;
      out.blocks[k].updated_at = saved.updated_at;
      out.blocks[k].lines = parsed.lines;
      if (parsed.text.length > WARN_CHARS) {
        log(k + " 单块 " + parsed.text.length + " 字，超过告警线 " + WARN_CHARS + "（不截断）");
        out.blocks[k].warn = true;
      }
      updates.push(k + " 已更新（" + modeById[k] + "，" + rowsById[k].length + " 条 → " + parsed.lines.length + " 行 / " + parsed.text.length + " 字）");
    }
    out.updates = updates;
    return out;
  }

  // ---------------- 跑一次（两块） ----------------
  async function runOnce(reason, runOpts) {
    if (state.running) return { ok: false, error: "已有生成在跑" };
    state.running = true;
    const startedAt = Date.now();
    const res = { reason: reason || "manual", started_at: new Date(startedAt).toISOString(), blocks: {}, ok: true, error: null };
    try {
      const r = await generateBoth(runOpts || {});
      res.blocks = r.blocks || {};
      res.tool_rounds = r.tool_rounds || 0;
      const failed = BLOCK_KEYS.filter(function (k) { return res.blocks[k] && res.blocks[k].mode === "failed"; });
      if (failed.length) { res.ok = false; res.error = "失败块: " + failed.join(","); }
      res.duration_ms = Date.now() - startedAt;
      try {
        saveConfig({
          last_run_at: new Date().toISOString(),
          last_run_result: {
            ok: res.ok, reason: res.reason, duration_ms: res.duration_ms, tool_rounds: res.tool_rounds,
            blocks: BLOCK_KEYS.map(function (k) { return { block: k, mode: res.blocks[k].mode, chars: res.blocks[k].chars || 0 }; }),
          },
        });
      } catch (_) {}
      const _detail = (r && r.updates && r.updates.length) ? "；" + r.updates.join("；") : "";
      log("两块总结跑完（" + res.reason + "，" + (res.duration_ms / 1000).toFixed(1) + "s" + (res.tool_rounds ? "，工具 " + res.tool_rounds + " 轮" : "") + "）：" + BLOCK_KEYS.map(function (k) { return k + "=" + (res.blocks[k] ? res.blocks[k].mode : "?"); }).join(" ") + _detail);
    } finally {
      state.running = false;
    }
    return res;
  }

  // ---------------- 调度 ----------------
  function parts() { return timeUtils.getDatePartsInTimeZone(new Date(), TZ); }

  function localDateKey(d) {
    const p = timeUtils.getDatePartsInTimeZone(d || new Date(), TZ);
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }

  function curHm() {
    const p = parts();
    return pad2(p.hour) + ":" + pad2(p.minute);
  }

  function localMinutes() {
    const p = parts();
    return Number(p.hour) * 60 + Number(p.minute);
  }

  function ranToday() {
    const c = readConfig();
    if (!c.last_run_at) return false;
    // last_run_at 存 ISO(UTC)，换算回本地日期再比，避免 03:30 跑完被算成"昨天"
    return localDateKey(new Date(c.last_run_at)) === localDateKey();
  }

  function dueNow() {
    const c = readConfig();
    if (curHm() !== c.time) return false;
    if (ranToday()) return false;
    return true;
  }

  function tick() {
    if (state.running) return;
    const c = readConfig();
    if (!c.enabled) return;
    if (!dueNow()) return;
    runOnce("schedule").catch(function (e) { state.lastError = String((e && e.message) || e); });
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(tick, CHECK_MS);
    if (state.timer.unref) state.timer.unref();
    const c = readConfig();
    log("调度已启动：enabled=" + c.enabled + " time=" + c.time + "（时区 " + TZ + "，本地现在 " + localDateKey() + " " + curHm() + "）");
    // 重启补跑：该时刻刚过去 30 分钟内，且当天没跑过
    try {
      const minutes = localMinutes();
      const m = /^(\d{1,2}):(\d{2})$/.exec(c.time);
      const target = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
      if (c.enabled && !ranToday() && minutes - target >= 0 && minutes - target <= CATCHUP_WINDOW_MS / 60000) {
        runOnce("schedule-catchup").catch(function (e) { state.lastError = String((e && e.message) || e); });
      }
    } catch (_) {}
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function status() {
    const c = readConfig();
    const cache = readCache();
    const blocks = {};
    for (const key of BLOCK_KEYS) {
      const rows = selectRows(key);
      const fp = fingerprintOf(rows);
      const b = cache[key] || emptyBlock();
      blocks[key] = {
        count: rows.length,
        fingerprint: fp,
        cached: !!b.updated_at,
        updated_at: b.updated_at,
        chars: b.text ? b.text.length : 0,
        lines: b.lines ? b.lines.length : 0,
        mode: b.mode,
        model: b.model,
        fresh: !!(b.fingerprint && b.fingerprint === fp && b.lines && b.lines.length),
        error: b.error || null,
      };
    }
    return {
      enabled: c.enabled,
      time: c.time,
      incremental: c.incremental,
      running: state.running,
      schedulerOn: !!state.timer,
      tz: TZ,
      local_now: localDateKey() + " " + curHm(),
      ran_today: ranToday(),
      last_run_at: c.last_run_at,
      last_run_result: c.last_run_result,
      last_error: state.lastError,
      blocks: blocks,
    };
  }

  return {
    readConfig, saveConfig,
    readCache, writeBlock,
    readPromptConfig, savePromptConfig,
    defaultCombinedSystem, defaultCombinedUser,
    selectRows, fingerprintOf, diffSnapshot, buildBothPrompt, parseOutput,
    generateBoth,
    runNow: function (o) { return runOnce("manual", o); },
    status, start, stop,
  };
};
