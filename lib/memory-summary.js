'use strict';
// 记忆两块总结（2026-10-02 记忆系统改造 §8 第 6 项）
//
// 两块：Core Identity（写「规矩」）← 记忆池 active 且 kind=rule
//       Long-term Understanding（写「理解」）← 记忆池 active 且 kind=fact
// 选材口径：★ 全部活跃记忆，不是置顶(anchor)那几条——用户 1002 拍板。
//
// 数据：data/memory_summary_config.json  { enabled, time, incremental, last_run_at, last_run_result }
//       data/memory_summary_cache.json   { core_identity:{text,lines,updated_at,fingerprint,snapshot,mode,...}, understanding:{...} }
//       data/memory_summary_prompt.json  { core_identity_system_prompt, core_identity_user_prompt, understanding_* }
//
// 更新时机：每晚定时对表一次；到点后**先比指纹**——记忆池没变化就不调 LLM、不重写缓存。
// 指纹：该块选材集合的 sha256(id|text|kind|subject|content_updated_at)，任一变化即视为「有更新」。
// 生成模式：缓存无 snapshot 或变化条目 > 存量 50% → 全量；否则增量（只喂上一版 + 新增/变化 + 已移除）。
// 降级：LLM 失败 → 保留上一版缓存 → 缓存也没有 → 注入层回落直注原始条目（builder 里的老逻辑）。

const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
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
const MODEL_ROLE = "memory_summary";    // 模型角色（1003-11 拆分：与记忆提炼分开配置；未配置则回落默认供应商）
const LLM_TIMEOUT_MS = 600000;           // 与 nginx 读超时 620s 对齐
const INCREMENTAL_MAX_RATIO = 0.5;       // 变化条目超过存量这个比例 → 直接全量
const WARN_CHARS = 2000;                 // 单块超过这个字数只在日志/状态里告警，不截断

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
    try { if (addLog) addLog("[memory-summary] " + msg); } catch (_) {}
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

  // ---------------- 提示词（管理台「提示词」页可改） ----------------
  function defaultSystemPrompt(blockKey) {
    if (blockKey === "core_identity") {
      return [
        "你要把一批「规则类记忆」压成一段常驻的自我准则，供 AI 每次对话开头阅读。",
        "",
        "要求：",
        "1. 语气是祈使句——写「我该怎么做」，不是「她怎样」。这是给 AI 自己看的行为准则。",
        "2. 按 subject 分段输出，段标题严格写成：",
        "### 我该怎么当这个伴侣（self）",
        "### 我们之间的约定（relationship）",
        "### 她要我怎么做（user）",
        "   段内每条以「- 」开头；某段没有内容就整段省略（连标题都不要写）。",
        "3. 保留专有名词与具体细节（人名、地名、物件名、她的原话），禁止抽象成「她喜欢小动物」这类空话。",
        "4. 允许保留矛盾：「她有时…有时…」比「她是个…的人」更真。",
        "5. 不臆断动机，只写记忆里有的；不用排比句、不用标语式总结。",
        "6. 能短则短——同义的两条合并成一条，不为凑内容复述；不设硬上限但不许注水。",
        "7. 与另一块「Long-term Understanding」不得重复同一条信息；既可作规则又可作事实的，归这一块。",
        "8. ★ 同一块内的不同分段之间也不得重复同一条信息：一条信息只写在最贴切的那一段，全篇只出现一次。",
        "9. 只输出正文（段标题行 + 条目行），不要任何前言、解释、后记。",
      ].join("\n");
    }
    return [
      "你要把一批「事实类记忆」压成一段长期理解，供 AI 每次对话开头阅读。",
      "",
      "要求：",
      "1. 语气是陈述句——写「她是什么样的人、我们的长期模式」，不是「我该怎么做」。",
      "2. 按 subject 分段输出，段标题严格写成：",
      "### 关于她（user）",
      "### 关于我们（relationship）",
      "   段内每条以「- 」开头；某段没有内容就整段省略（连标题都不要写）。",
      "3. 保留专有名词与具体细节（人名、地名、物件名、她的原话），禁止抽象成「她喜欢小动物」这类空话。",
      "4. 允许保留矛盾：「她有时…有时…」比「她是个…的人」更真。",
      "5. 不臆断动机，只写记忆里有的；不用排比句、不用标语式总结。",
      "6. 能短则短——同义的两条合并成一条，不为凑内容复述；不设硬上限但不许注水。",
      "7. 与另一块「Core Identity」不得重复同一条信息；既可作规则又可作事实的，归 Core Identity，这块不写。",
      "8. ★ 同一块内的不同分段之间也不得重复同一条信息：一条信息只写在最贴切的那一段（写「她」还是写「我们」按主语判断），全篇只出现一次。",
      "9. 只输出正文（段标题行 + 条目行），不要任何前言、解释、后记。",
    ].join("\n");
  }

  function defaultUserPrompt(blockKey) {
    return [
      "下面是记忆池里当前活跃的全部${KIND_LABEL}记忆，共 ${MEMORY_COUNT} 条。",
      "${PREVIOUS_BLOCK}",
      "${DELTA_BLOCK}",
      "=== 记忆条目 ===",
      "${MEMORY_LIST}",
      "",
      "把它们压成一段常驻的${BLOCK_LABEL}，按 system 规定的分段格式输出。",
    ].join("\n");
  }

  function readPromptConfig() {
    const c = readJsonSafe(PROMPT_FILE, {});
    const out = {};
    for (const k of BLOCK_KEYS) {
      out[k + "_system_prompt"] = String(c[k + "_system_prompt"] || "");
      out[k + "_user_prompt"] = String(c[k + "_user_prompt"] || "");
    }
    return out;
  }

  function savePromptConfig(patch) {
    const cur = readJsonSafe(PROMPT_FILE, {});
    const next = Object.assign({}, cur);
    for (const k of Object.keys(patch || {})) {
      if (BLOCK_KEYS.indexOf(k) >= 0 || BLOCK_KEYS.some(b => k === b + "_system_prompt" || k === b + "_user_prompt")) {
        next[k] = patch[k] == null ? "" : String(patch[k]);
      }
    }
    fs.writeJsonSync(PROMPT_FILE, next, { spaces: 2 });
    const out = readPromptConfig();
    // 防呆：自定义 User 提示词里若没有 ${MEMORY_LIST}，模型看不到记忆清单——
    // 不会报错，只会静默地凭空编，是最难查的一类错，保存时就明确提示。
    const warn = [];
    for (const k of BLOCK_KEYS) {
      const u = String(next[k + "_user_prompt"] || "").trim();
      if (u && u.indexOf("${MEMORY_LIST}") < 0) {
        warn.push(BLOCK_DEFS[k].label + " 的 User 提示词里没有 ${MEMORY_LIST}——模型会看不到记忆清单，只能凭上一版改或自己编。想自己拼清单就不用管，否则请补回去。");
      }
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

  // 指纹只看「会影响总结内容」的字段：正文变了、条目增删、kind/subject 变了都算变化
  function fingerprintOf(rows) {
    const parts = rows.map(function (e) {
      return [e.id, String(e.text || "").trim(), e.kind, e.subject, e.content_updated_at || e.created_at || ""].join("|");
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
      return (i + 1) + ". [" + (e.subject || "user") + "] " + String(e.text || "").trim();
    }).join("\n");
  }

  function buildPrompt(blockKey, rows, prev, delta, mode) {
    const pc = readPromptConfig();
    const def = BLOCK_DEFS[blockKey];
    const system = (pc[blockKey + "_system_prompt"] || "").trim() || defaultSystemPrompt(blockKey);
    const tpl = (pc[blockKey + "_user_prompt"] || "").trim() || defaultUserPrompt(blockKey);

    let previousBlock = "（无上一版，这是首次生成）";
    if (prev && prev.text) {
      previousBlock = "【上一版理解模型】\n" + prev.text + "\n（这只是上一版的认知模型，不是需要逐条维护的清单。请根据当前全部证据重新校准；可以保留、合并、重构、拆分或删除旧表达。不要因为上一版存在某句话就机械保留；如果多个旧段落可以被更高层原则统一，请主动融合。最终输出当前最准确的理解模型，而不是增量补丁。）";
    }
    let deltaBlock = "";
    if (mode === "incremental") {
      const parts = [];
      if (delta.added.length) parts.push("【新增记忆】\n" + delta.added.map(function (t) { return "- " + t; }).join("\n"));
      if (delta.changed.length) parts.push("【正文有改动的记忆】\n" + delta.changed.map(function (t) { return "- " + t; }).join("\n"));
      if (delta.removed.length) parts.push("【已移除的记忆】（如果上一版里有基于它们的话，删掉那些话）\n" + delta.removed.map(function (t) { return "- " + t; }).join("\n"));
      deltaBlock = parts.join("\n\n");
    }

    const user = tpl
      .replace(/\$\{MEMORY_COUNT\}/g, String(rows.length))
      .replace(/\$\{KIND_LABEL\}/g, def.kindLabel)
      .replace(/\$\{BLOCK_LABEL\}/g, def.label)
      .replace(/\$\{PREVIOUS_BLOCK\}/g, previousBlock)
      .replace(/\$\{DELTA_BLOCK\}/g, deltaBlock)
      .replace(/\$\{MEMORY_LIST\}/g, listText(rows));
    return { system, user };
  }

  // ---------------- LLM ----------------
  async function callLlm(system, user) {
    const router = require("../model-router");
    const r = router.resolveRoleModel(MODEL_ROLE);
    if (!r || !r.provider || !r.provider.api_url || !r.model) throw new Error("模型未配置（role=" + MODEL_ROLE + "）");
    const base = String(r.provider.api_url).replace(/\/+$/, "");
    const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, LLM_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + String(r.provider.api_key || "") },
        body: JSON.stringify({
          model: r.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.3,
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error("LLM HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200));
      const j = await resp.json();
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content || !String(content).trim()) throw new Error("LLM 返回空内容");
      return { text: String(content).trim(), model: r.model };
    } finally {
      clearTimeout(timer);
    }
  }

  // 去围栏、拆行、去重空行
  function parseOutput(text) {
    let t = String(text || "").trim();
    t = t.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const lines = t.split("\n").map(function (s) { return s.replace(/\s+$/, ""); }).filter(function (s) { return s.trim(); });
    return { text: lines.join("\n"), lines };
  }

  // ---------------- 生成一块 ----------------
  async function generateBlock(blockKey, runOpts) {
    const ro = runOpts || {};
    const rows = selectRows(blockKey);
    const fp = fingerprintOf(rows);
    const cache = readCache();
    const prev = cache[blockKey] || emptyBlock();
    const fresh = prev.fingerprint && prev.fingerprint === fp && prev.lines.length > 0;
    const out = { block: blockKey, kind: BLOCK_DEFS[blockKey].kind, count: rows.length, fingerprint: fp, fresh: fresh, mode: null, chars: 0, model: null, error: null };

    if (!rows.length) {
      out.mode = "empty";
      out.error = "无活跃记忆（kind=" + BLOCK_DEFS[blockKey].kind + "）";
      return out;
    }
    if (fresh && !ro.force) {
      out.mode = "skipped";
      out.chars = prev.text.length;
      out.updated_at = prev.updated_at;
      out.lines = prev.lines;
      return out;
    }
    if (ro.dryRun) {
      out.mode = (fresh && !ro.force) ? "skipped" : "would_generate";
      return out;
    }

    // 模式选择：无 snapshot / 关了增量 / 变化超过一半 → 全量；否则增量
    const cfg = readConfig();
    let delta = diffSnapshot(prev.snapshot, rows);
    const changedCount = delta.added.length + delta.changed.length + delta.removed.length;
    let mode = "full";
    if (cfg.incremental && prev.snapshot && prev.text && rows.length > 0 && changedCount <= Math.max(1, Math.floor(rows.length * INCREMENTAL_MAX_RATIO))) {
      mode = "incremental";
    }
    if (mode === "full") delta = diffSnapshot(null, rows);

    const p = buildPrompt(blockKey, rows, prev, delta, mode);
    let parsed = null, model = null;
    try {
      const r = await callLlm(p.system, p.user);
      parsed = parseOutput(r.text);
      model = r.model;
    } catch (e) {
      out.mode = "failed";
      out.error = String((e && e.message) || e).slice(0, 200);
      out.keptPrevious = !!(prev && prev.lines && prev.lines.length);
      log(blockKey + " 生成失败，保留上一版缓存: " + out.error);
      return out;
    }
    if (!parsed.lines.length) {
      out.mode = "failed";
      out.error = "LLM 输出为空";
      return out;
    }

    const saved = writeBlock(blockKey, {
      text: parsed.text,
      lines: parsed.lines,
      updated_at: new Date().toISOString(),
      fingerprint: fp,
      snapshot: snapshotOf(rows),
      mode: mode,
      count: rows.length,
      model: model,
      error: null,
    });

    out.mode = mode;
    out.chars = parsed.text.length;
    out.model = model;
    out.updated_at = saved.updated_at;
    out.lines = parsed.lines;
    if (parsed.text.length > WARN_CHARS) {
      log(blockKey + " 单块 " + parsed.text.length + " 字，超过告警线 " + WARN_CHARS + "（不截断）");
      out.warn = true;
    }
    log(blockKey + " 已更新（" + mode + "，" + rows.length + " 条 → " + parsed.lines.length + " 行 / " + parsed.text.length + " 字）");
    return out;
  }

  // ---------------- 跑一次（两块） ----------------
  async function runOnce(reason, runOpts) {
    if (state.running) return { ok: false, error: "已有生成在跑" };
    state.running = true;
    const startedAt = Date.now();
    const cfg = readConfig();
    const res = { reason: reason || "manual", started_at: new Date(startedAt).toISOString(), blocks: {}, ok: true, error: null };
    try {
      for (const key of BLOCK_KEYS) {
        try {
          res.blocks[key] = await generateBlock(key, runOpts);
        } catch (e) {
          res.blocks[key] = { block: key, mode: "failed", error: String((e && e.message) || e).slice(0, 200) };
        }
      }
      const failed = BLOCK_KEYS.filter(function (k) { return res.blocks[k] && res.blocks[k].mode === "failed"; });
      if (failed.length) { res.ok = false; res.error = "失败块: " + failed.join(","); }
      res.duration_ms = Date.now() - startedAt;
      try { saveConfig({ last_run_at: new Date().toISOString(), last_run_result: { ok: res.ok, reason: res.reason, duration_ms: res.duration_ms, blocks: Object.keys(res.blocks).map(function (k) { return { block: k, mode: res.blocks[k].mode, chars: res.blocks[k].chars || 0 }; }) } }); } catch (_) {}
      log("两块总结跑完（" + res.reason + "，" + (res.duration_ms / 1000).toFixed(1) + "s）：" + BLOCK_KEYS.map(function (k) { return k + "=" + (res.blocks[k] ? res.blocks[k].mode : "?"); }).join(" "));
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
    defaultSystemPrompt, defaultUserPrompt,
    selectRows, fingerprintOf, diffSnapshot, buildPrompt, parseOutput,
    generateBlock,
    runNow: function (o) { return runOnce("manual", o); },
    status, start, stop,
  };
};
