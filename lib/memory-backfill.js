'use strict';
// 老数据重跑（2026-10-02 记忆系统改造 §8 第 5 项）
//
// 干什么：把记忆池里已有的活跃记忆逐批过一遍，让 LLM 判断该怎么整理，产出**一律进待审**。
// 五动作（方案 §3.3，用户第六轮拍板 B 档：可润色，不必非得矛盾才改）：
//   update      正文过时/有误/啰嗦 → 给完整新正文（改前改后并列，人工对比）
//   supplement  信息不全 → 往里加（new_text 是加完之后的完整正文）
//   merge       两条以上说同一件事 → 合成一条（方案里「最有价值的那个」）
//   sink        过时/失效 → 建议沉底（删除级，写进独立建议列表，不混进新增候选）
//   create      原文里发现漏掉的 → 按蒸馏标准抽（宁缺毋滥，过时的旧约定不抽）
//   keep        不动（默认，不输出）
//
// 数据：data/memory_backfill_config.json   { enabled, time, batch_size, last_run_at, last_run_result }
//       data/memory_backfill_state.json    { done: { 记忆id: ISO时间 } }
//       data/memory_backfill_prompt.json   { system_prompt, user_prompt }
//       data/memory_sink_suggestions.json  { items: [{id,text,kind,reason,batch,at}] }
//
// 取证：与蒸馏同源（searchContext = context_search），原文才是证据；原文对不上的一律 keep。

const fs = require("fs-extra");
const path = require("path");
const timeUtils = require("../time_utils");

const DEFAULT_CONFIG = {
  enabled: false,     // 默认关：产出要人工审，别偷偷跑
  time: "04:00",      // 避开蒸馏（默认 03:00）与两块总结（默认 03:30）
  batch_size: 15,     // 每批多少条记忆（产出要人工审，宁小勿大）
  last_run_at: null,
  last_run_result: null,
};

const CHECK_MS = 30000;
const CATCHUP_WINDOW_MS = 30 * 60 * 1000;
const MODEL_ROLE = "reparse";               // 与蒸馏同源（结构化 JSON 输出）
const LLM_TIMEOUT_MS = 600000;
const EVIDENCE_TIME_LIMIT = 12;             // 按记忆创建日期定位：当天最多取几条原文
const EVIDENCE_PER_ROW = 3;                 // 语义补检索条数
const EVIDENCE_CHAR_PER_ROW = 600;          // 每条记忆的原文字符上限
const EVIDENCE_SKIP_PATTERNS = [
  /\[此刻想起\]/, /\[记忆\]/, /\[长期记忆\]/, /\[Earlier Days\]/, /^\s*【记忆/,
  // 1002-20 实跑暴露：语义检索大量召回 Bark 推送日志（"刚刚给涵发了…推送""下次唤醒时间"），
  // 与记忆本身毫无关系，喂进去只会让模型因为「原文对不上」而一律 keep。
  /刚刚给.{0,8}发了.{0,20}推送/, /Bark推送/, /下次唤醒时间/, /\[谢意行\]\s*来自谢/, /undefined推送/,
];
// 相关性门槛：记忆正文与原文的字符二元组重合率低于此值视为无关证据（0.08 只滤噪声，不误伤真证据——
// 蒸馏实测真证据重合率 12%、假证据 0%，这里口径更宽，因为记忆正文往往比原文短得多）
const EVIDENCE_MIN_RATIO = 0.08;
const ACTIONS = ["keep", "update", "supplement", "merge", "sink", "create"];

function pad2(n) { return String(n).padStart ? String(n).padStart(2, "0") : (Number(n) < 10 ? "0" + n : String(n)); }

function normalizeTime(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return DEFAULT_CONFIG.time;
  return pad2(Math.min(23, Math.max(0, Number(m[1])))) + ":" + pad2(Math.min(59, Math.max(0, Number(m[2]))));
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const j = fs.readJsonSync(file);
    return (j && typeof j === "object") ? j : fallback;
  } catch (e) { return fallback; }
}

module.exports = function createMemoryBackfill(deps) {
  const opts = deps || {};
  const baseDir = opts.baseDir || path.resolve(__dirname, "..");
  const CFG_FILE = path.join(baseDir, "data", "memory_backfill_config.json");
  const STATE_FILE = path.join(baseDir, "data", "memory_backfill_state.json");
  const PROMPT_FILE = path.join(baseDir, "data", "memory_backfill_prompt.json");
  const SINK_FILE = path.join(baseDir, "data", "memory_sink_suggestions.json");
  const PACK_FILE = path.join(baseDir, "data", "memory_backfill_last_pack.txt");  // 最近一批的材料（排障用，覆盖写）
  const RAW_FILE = path.join(baseDir, "data", "memory_backfill_last_raw.txt");    // 最近一批的模型原始输出（排障用，覆盖写）
  const POOL_FILE = opts.poolFile || path.join(baseDir, "data", "memory_v2.json");
  const TZ = timeUtils.resolveTimeZone();
  const addLog = typeof opts.addCompactionLog === "function" ? opts.addCompactionLog : null;
  const persistLog = typeof opts.persistCompactionLogs === "function" ? opts.persistCompactionLogs : null;
  const searchContext = typeof opts.searchContext === "function" ? opts.searchContext : null;
  const admission = opts.admission || null;

  const state = { timer: null, running: false, lastError: null };

  function log(msg) {
    try { if (addLog) addLog("[memory-backfill] " + msg); } catch (_) {}
    try { if (persistLog) persistLog(); } catch (_) {}
  }

  // ---------------- 配置 / 状态 ----------------
  function readConfig() {
    const c = readJsonSafe(CFG_FILE, {});
    return {
      enabled: c.enabled !== undefined ? !!c.enabled : DEFAULT_CONFIG.enabled,
      time: normalizeTime(c.time || DEFAULT_CONFIG.time),
      batch_size: Math.max(1, Math.min(60, Number(c.batch_size) || DEFAULT_CONFIG.batch_size)),
      last_run_at: c.last_run_at || null,
      last_run_result: c.last_run_result || null,
    };
  }

  function saveConfig(patch) {
    const cur = readJsonSafe(CFG_FILE, {});
    const next = Object.assign({}, cur);
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.time !== undefined) next.time = normalizeTime(patch.time);
    if (patch.batch_size !== undefined) next.batch_size = Math.max(1, Math.min(60, Number(patch.batch_size) || DEFAULT_CONFIG.batch_size));
    if (patch.last_run_at !== undefined) next.last_run_at = patch.last_run_at;
    if (patch.last_run_result !== undefined) next.last_run_result = patch.last_run_result;
    fs.writeJsonSync(CFG_FILE, next, { spaces: 2 });
    return readConfig();
  }

  function readState() { return readJsonSafe(STATE_FILE, { done: {} }); }
  function writeState(next) { fs.writeJsonSync(STATE_FILE, next, { spaces: 2 }); }

  function readPromptConfig() {
    const c = readJsonSafe(PROMPT_FILE, {});
    return { system_prompt: String(c.system_prompt || ""), user_prompt: String(c.user_prompt || "") };
  }

  function savePromptConfig(patch) {
    const cur = readJsonSafe(PROMPT_FILE, {});
    const next = Object.assign({}, cur);
    for (const k of ["system_prompt", "user_prompt"]) {
      if (patch[k] !== undefined) next[k] = patch[k] == null ? "" : String(patch[k]);
    }
    fs.writeJsonSync(PROMPT_FILE, next, { spaces: 2 });
    return readPromptConfig();
  }

  // ---------------- 提示词（外置，管理台提示词页可改） ----------------
  function defaultSystemPrompt() {
    return [
      "你是记忆池的老数据整理器。输入是记忆池里已有的活跃记忆（带 id、分类、正文、时间），以及为每条记忆检索到的对话原文（带 #msg_id——原文才是证据，记忆正文不是）。",
      "任务：逐条判断这些老记忆该怎么处理。**只输出需要动手的**，其余不用输出。",
      "",
      "动作：",
      "- update：正文过时 / 有误 / 啰嗦 / 有歧义，给出 new_text（**完整新正文**，不是只写改动部分）。允许润色，不必非得与原文矛盾才改。",
      "- supplement：信息不全，往里加内容。add_text 是要加的部分，new_text 是加完之后的完整正文。",
      "- merge：两条以上说的是同一件事或同一些碎片，合成一条。ids 列出要合并的 id，new_text 是合成后的完整正文。★ 合并是最有价值的动作，碎片合成一条能让记忆更好用。",
      "- sink：已经过时、失效，或根本不该长期记的（一次性事件、早就改掉的旧约定、过期的旧规矩），建议沉底归档。",
      "- create：从原文里发现漏掉的、值得长期记住的东西（现有记忆里没有）。按蒸馏标准抽：宁缺毋滥，**过时的旧约定不抽**，一次性的亲昵细节不抽。",
      "- keep：不用动。默认就是 keep，**不要输出**。",
      "",
      "铁律：",
      "1. **不确定就 keep**。每一条改动都要人工过目，宁可不动也别乱改。",
      "2. **只有原文（#msg_id）能证明的才敢改、敢沉**；原文对不上、或压根没给原文的一律 keep。",
      "3. sink 是删除级动作，只在明显过时或明显不该记时才用；拿不准就 keep。",
      "4. new_text 一律写完整正文，不要写「把……改成……」这种指令式句子。",
      "5. 别制造重复：两条记忆说的是同一件事就 merge，不要各自 update 成一样的话。",
      "6. reason 写一句人话说明为什么动它——人工审核时只有这一句能帮他看懂。",
      "7. 正文里的时间、原话、细节能保留就保留；润色不等于抹掉具体。",
      "",
      '只输出 JSON：{"actions":[{"action":"update","id":"m_xxx","new_text":"...","reason":"..."}]}',
      "merge 用 ids 数组：{\"action\":\"merge\",\"ids\":[\"m_a\",\"m_b\"],\"new_text\":\"...\",\"reason\":\"...\"}",
      "create 带 kind/subject：{\"action\":\"create\",\"text\":\"...\",\"kind\":\"fact|rule\",\"subject\":\"user|relationship|self|external\",\"evidence\":[\"msg_id\"],\"reason\":\"...\"}",
    ].join("\n");
  }

  function defaultUserPrompt() {
    return [
      "本批共 ${MEM_COUNT} 条现有记忆。每条格式：",
      "[id=xxx · kind · subject · 时间] 正文",
      "  └ 原文 #msg_id（时间 · 角色）：内容",
      "",
      "${MATERIALS}",
      "",
      "逐条判断，按 system 规定的 JSON 输出；都不用动就输出 {\"actions\":[]}。",
    ].join("\n");
  }

  function buildPrompt(materials, memCount) {
    const pc = readPromptConfig();
    const system = (pc.system_prompt || "").trim() || defaultSystemPrompt();
    const tpl = (pc.user_prompt || "").trim() || defaultUserPrompt();
    const user = tpl
      .replace(/\$\{MEM_COUNT\}/g, String(memCount))
      .replace(/\$\{MATERIALS\}/g, materials);
    return { system, user };
  }

  // ---------------- 选材 ----------------
  function selectRows(limit) {
    let all = [];
    try { all = fs.readJsonSync(POOL_FILE); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    const st = readState();
    const done = st.done || {};
    return all
      .filter(function (e) { return e && e.status === "active" && String(e.text || "").trim() && !done[String(e.id)]; })
      .sort(function (a, b) { return String(a.created_at || "").localeCompare(String(b.created_at || "")); })
      .slice(0, limit)
      .map(function (e) {
        return {
          id: String(e.id), kind: e.kind || null, subject: e.subject || null,
          text: String(e.text || "").trim(),
          created_at: e.created_at || null,
        };
      });
  }

  function countRemaining() {
    let all = [];
    try { all = fs.readJsonSync(POOL_FILE); } catch (e) { all = []; }
    if (!Array.isArray(all)) all = [];
    const st = readState();
    const done = st.done || {};
    return all.filter(function (e) { return e && e.status === "active" && String(e.text || "").trim() && !done[String(e.id)]; }).length;
  }

  // ---------------- 取证：每条记忆语义检索原文 ----------------
  // 字符二元组重合率：记忆正文 vs 原文，判断「这条原文是不是真的在说这件事」
  function bigramRatio(a, b) {
    const A = String(a || "").replace(/\s+/g, "");
    const B = String(b || "").replace(/\s+/g, "");
    if (!A || !B) return 0;
    const setA = new Set();
    for (let i = 0; i < A.length - 1; i++) setA.add(A.slice(i, i + 2));
    let hit = 0, total = 0;
    for (let i = 0; i < B.length - 1; i++) {
      total++;
      if (setA.has(B.slice(i, i + 2))) hit++;
    }
    return total ? hit / total : 0;
  }

  async function fetchEvidence(rows) {
    const out = Object.create(null);
    if (!searchContext) { log("未注入 searchContext，本批无原文（模型只能凭记忆正文判断，改动会更保守）"); return out; }
    for (const r of rows) {
      const cands = [];
      // ① 时间定位：记忆创建那天（出处大概率在当天）
      const day = String(r.created_at || "").slice(0, 10);
      if (day) {
        try {
          const res = await searchContext("", { timePrefix: day, allSessions: true, limit: EVIDENCE_TIME_LIMIT });
          if (res && res.ok && Array.isArray(res.matches)) cands.push.apply(cands, res.matches);
        } catch (e) {
          log("时间定位异常（" + r.id + " " + day + "）：" + (e && e.message || e));
        }
      }
      // ② 语义补检索（记忆正文当前 120 字当 query）
      try {
        const res = await searchContext(r.text.slice(0, 120), { mode: "semantic", allSessions: true, limit: EVIDENCE_PER_ROW });
        if (res && res.ok && Array.isArray(res.matches)) cands.push.apply(cands, res.matches);
      } catch (e) {
        log("语义检索异常（" + r.id + "）：" + (e && e.message || e));
      }
      // ③ 去重 + 噪声黑名单 + 相关性门槛
      const seen = Object.create(null);
      const lines = [];
      let used = 0;
      for (const m of cands) {
        const id = String(m.msg_id || "");
        if (id && seen[id]) continue;
        const c = String(m.content || "").replace(/\s+/g, " ").trim();
        if (!c) continue;
        if (EVIDENCE_SKIP_PATTERNS.some(function (re) { return re.test(c); })) continue;
        if (bigramRatio(r.text, c) < EVIDENCE_MIN_RATIO) continue;
        if (id) seen[id] = true;
        if (used + c.length > EVIDENCE_CHAR_PER_ROW) break;
        used += c.length;
        const t = m.time ? String(m.time).slice(0, 16) : "?";
        lines.push("  └ #" + (id || "?") + "（" + t + " · " + (m.role || "?") + "）" + c);
      }
      if (lines.length) out[r.id] = lines.join("\n");
    }
    return out;
  }

  function packMaterials(rows, evidence) {
    return rows.map(function (r) {
      const head = "[" + r.id + " · " + (r.kind || "?") + " · " + (r.subject || "?") + " · " + String(r.created_at || "?").slice(0, 10) + "] " + r.text;
      const ev = evidence[r.id];
      return head + (ev ? ("\n" + ev) : "\n  └ （没检索到原文）");
    }).join("\n\n");
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
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error("LLM HTTP " + resp.status + " " + String(await resp.text()).slice(0, 200));
      const data = await resp.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { text: String(text || ""), model: r.model };
    } finally { clearTimeout(timer); }
  }

  function parseActions(rawText) {
    const s = String(rawText || "").trim();
    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      const a = s.indexOf("{"), b = s.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e2) { obj = null; }
      }
    }
    if (!obj || !Array.isArray(obj.actions)) return { actions: [], error: "输出不是 {\"actions\":[...]}" };
    const out = [];
    for (const a of obj.actions) {
      if (!a || typeof a !== "object") continue;
      const action = String(a.action || "").trim();
      if (ACTIONS.indexOf(action) < 0 || action === "keep") continue;
      const reason = String(a.reason || "").trim().slice(0, 200);
      if (action === "create") {
        const text = String(a.text || a.new_text || "").trim();
        if (!text) continue;
        out.push({
          action, text, reason,
          kind: (a.kind === "rule" || a.kind === "fact") ? a.kind : null,
          subject: ["user", "relationship", "self", "external"].indexOf(a.subject) >= 0 ? a.subject : null,
          evidence: Array.isArray(a.evidence) ? a.evidence.map(String).slice(0, 5) : [],
        });
      } else if (action === "merge") {
        const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
        const text = String(a.new_text || "").trim();
        if (ids.length < 2 || !text) continue;
        out.push({ action, ids, text, reason });
      } else if (action === "sink") {
        const id = String(a.id || "").trim();
        if (!id) continue;
        out.push({ action, id, reason });
      } else { // update / supplement
        const id = String(a.id || "").trim();
        const text = String(a.new_text || "").trim();
        if (!id || !text) continue;
        out.push({ action, id, text, add_text: String(a.add_text || "").trim(), reason });
      }
    }
    return { actions: out, error: null };
  }

  // ---------------- 落处 ----------------
  async function applyActions(actions, rows, batchRef) {
    const byId = Object.create(null);
    rows.forEach(function (r) { byId[r.id] = r; });
    const res = { queued: 0, sink: 0, skipped: 0, errors: [], items: [] };

    if (!admission || typeof admission.submitPromotion !== "function") {
      return Object.assign(res, { error: "admission 未注入，无法落待审" });
    }

    const sinkItems = readJsonSafe(SINK_FILE, { items: [] });
    const sinkArr = Array.isArray(sinkItems.items) ? sinkItems.items : [];
    const sinkSeen = Object.create(null);
    sinkArr.forEach(function (x) { if (x && x.id) sinkSeen[String(x.id)] = true; });

    for (const a of actions) {
      try {
        if (a.action === "sink") {
          const row = byId[a.id];
          if (!row) { res.skipped++; continue; }
          if (sinkSeen[a.id]) { res.skipped++; continue; }
          sinkArr.push({ id: a.id, text: row.text, kind: row.kind, subject: row.subject, reason: a.reason, batch: batchRef, at: new Date().toISOString() });
          sinkSeen[a.id] = true;
          res.sink++;
          res.items.push({ action: "sink", id: a.id, text: row.text, reason: a.reason });
          continue;
        }
        if (a.action === "create") {
          const r = await admission.submitPromotion({
            content: a.text, kind: a.kind, subject: a.subject,
            source: { type: "backfill", ref: batchRef },
            backfill: { action: "create", reason: a.reason, evidence: a.evidence },
          }, { sessionId: null, msgId: null });
          if (r && (r.action === "review" || r.action === "admit")) { res.queued++; res.items.push({ action: "create", text: a.text, reason: a.reason }); }
          else { res.skipped++; res.errors.push("create 未入队：" + (r && r.action)); }
          continue;
        }
        // update / supplement / merge：目标必须在本批里（防止模型编 id）
        const targets = a.action === "merge" ? a.ids : [a.id];
        const bad = targets.filter(function (id) { return !byId[id]; });
        if (bad.length) { res.skipped++; res.errors.push(a.action + " 目标不在本批：" + bad.join(",")); continue; }
        const oldText = targets.map(function (id) { return byId[id].text; }).join(" ／ ");
        const baseRow = byId[targets[0]];
        const r = await admission.submitPromotion({
          content: a.text, kind: baseRow.kind, subject: baseRow.subject,
          source: { type: "backfill", ref: batchRef },
          backfill: {
            action: a.action,
            target_id: a.action === "merge" ? null : a.id,
            merge_ids: a.action === "merge" ? targets : null,
            old_text: oldText,
            reason: a.reason,
          },
        }, { sessionId: null, msgId: null });
        if (r && (r.action === "review" || r.action === "admit")) {
          res.queued++;
          res.items.push({ action: a.action, id: a.id || targets.join(","), old_text: oldText, text: a.text, reason: a.reason });
        } else { res.skipped++; res.errors.push(a.action + " 未入队：" + (r && r.action)); }
      } catch (e) {
        res.errors.push(a.action + " 异常：" + String((e && e.message) || e).slice(0, 160));
      }
    }

    if (res.sink > 0) fs.writeJsonSync(SINK_FILE, { items: sinkArr }, { spaces: 2 });
    return res;
  }

  // ---------------- 跑一批 ----------------
  async function runOnce(reason, runOpts) {
    if (state.running) return { ok: false, error: "已有重跑在跑", running: true };
    state.running = true;
    const startedAt = Date.now();
    const ro = runOpts || {};
    const cfg = readConfig();
    const batchSize = Math.max(1, Math.min(60, Number(ro.batch_size) || cfg.batch_size));
    const out = { reason: reason || "manual", started_at: new Date(startedAt).toISOString(), batch_size: batchSize, ok: true, error: null };
    try {
      const rows = selectRows(batchSize);
      out.count = rows.length;
      out.remaining = countRemaining();
      if (!rows.length) {
        out.ok = true;
        out.note = "没有待重跑的记忆（全部已处理）";
        return out;
      }
      const evidence = await fetchEvidence(rows);
      out.evidence_rows = Object.keys(evidence).length;
      const materials = packMaterials(rows, evidence);
      try { fs.writeFileSync(PACK_FILE, materials); } catch (_) {}
      const p = buildPrompt(materials, rows.length);
      let parsed = { actions: [], error: "未调用" }, model = null;
      if (ro.dryRun) {
        out.mode = "dry_run";
        out.prompt_chars = p.system.length + p.user.length;
        out.note = "dryRun：未调模型";
        return out;
      }
      try {
        const r = await callLlm(p.system, p.user);
        try { fs.writeFileSync(RAW_FILE, String(r.text || "")); } catch (_) {}
        parsed = parseActions(r.text);
        model = r.model;
        out.parse_error = parsed.error;
        out.raw_chars = String(r.text || "").length;
      } catch (e) {
        out.ok = false; out.error = String((e && e.message) || e).slice(0, 200);
        state.lastError = out.error;
        log("本批失败：" + out.error);
        return out;
      }
      out.model = model;
      out.raw_actions = parsed.actions.length;
      const applied = await applyActions(parsed.actions, rows, rows.map(function (r) { return r.id; }).join(",").slice(0, 200));
      out.queued = applied.queued;
      out.sink = applied.sink;
      out.skipped = applied.skipped;
      out.apply_errors = applied.errors;
      out.items = applied.items;
      if (applied.error) { out.ok = false; out.error = applied.error; }

      // 标记已处理（失败了也算跑过，避免死循环卡在同一批）
      const st = readState();
      const done = st.done || {};
      const at = new Date().toISOString();
      rows.forEach(function (r) { done[r.id] = at; });
      writeState({ done: done });

      out.duration_ms = Date.now() - startedAt;
      try {
        saveConfig({
          last_run_at: new Date().toISOString(),
          last_run_result: { ok: out.ok, reason: out.reason, count: out.count, queued: out.queued, sink: out.sink, duration_ms: out.duration_ms },
        });
      } catch (_) {}
      log("跑完一批（" + out.reason + "，" + rows.length + " 条 → 待审 " + out.queued + " 条 / 建议沉底 " + out.sink + " 条，" + (out.duration_ms / 1000).toFixed(1) + "s）");
    } finally { state.running = false; }
    return out;
  }

  // ---------------- 调度 ----------------
  function parts() { return timeUtils.getDatePartsInTimeZone(new Date(), TZ); }
  function localDateKey(d) {
    const p = timeUtils.getDatePartsInTimeZone(d || new Date(), TZ);
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }
  function curHm() { const p = parts(); return pad2(p.hour) + ":" + pad2(p.minute); }
  function localMinutes() { const p = parts(); return Number(p.hour) * 60 + Number(p.minute); }
  function ranToday() {
    const c = readConfig();
    if (!c.last_run_at) return false;
    return localDateKey(new Date(c.last_run_at)) === localDateKey();
  }
  function dueNow() {
    const c = readConfig();
    if (!c.enabled || ranToday()) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(c.time);
    const target = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    const now = localMinutes();
    return now >= target && now - target <= 5;
  }
  function tick() {
    if (!dueNow()) return;
    runOnce("schedule").catch(function (e) { state.lastError = String((e && e.message) || e); });
  }
  function start() {
    if (state.timer) return;
    state.timer = setInterval(tick, CHECK_MS);
    if (state.timer.unref) state.timer.unref();
    const c = readConfig();
    log("调度已启动：enabled=" + c.enabled + " time=" + c.time + " batch=" + c.batch_size + "（时区 " + TZ + "，本地现在 " + localDateKey() + " " + curHm() + "）");
    try {
      const minutes = localMinutes();
      const m = /^(\d{1,2}):(\d{2})$/.exec(c.time);
      const target = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
      if (c.enabled && !ranToday() && minutes - target >= 0 && minutes - target <= CATCHUP_WINDOW_MS / 60000) {
        runOnce("schedule-catchup").catch(function (e) { state.lastError = String((e && e.message) || e); });
      }
    } catch (_) {}
  }
  function stop() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  function status() {
    const c = readConfig();
    const st = readState();
    const sink = readJsonSafe(SINK_FILE, { items: [] });
    return {
      enabled: c.enabled, time: c.time, batch_size: c.batch_size,
      running: state.running, schedulerOn: !!state.timer, tz: TZ,
      local_now: localDateKey() + " " + curHm(),
      ran_today: ranToday(),
      last_run_at: c.last_run_at, last_run_result: c.last_run_result, last_error: state.lastError,
      done_count: Object.keys((st && st.done) || {}).length,
      remaining: countRemaining(),
      sink_suggestions: Array.isArray(sink.items) ? sink.items.length : 0,
    };
  }

  function readSinkSuggestions() {
    const j = readJsonSafe(SINK_FILE, { items: [] });
    return { items: Array.isArray(j.items) ? j.items : [] };
  }
  function clearSinkSuggestion(id) {
    const j = readJsonSafe(SINK_FILE, { items: [] });
    const arr = Array.isArray(j.items) ? j.items : [];
    const next = arr.filter(function (x) { return String(x && x.id) !== String(id); });
    fs.writeJsonSync(SINK_FILE, { items: next }, { spaces: 2 });
    return { items: next };
  }

  return {
    readConfig, saveConfig,
    readState, readPromptConfig, savePromptConfig,
    defaultSystemPrompt, defaultUserPrompt, buildPrompt,
    selectRows, countRemaining, fetchEvidence, packMaterials, parseActions,
    readSinkSuggestions, clearSinkSuggestion,
    runNow: function (o) { return runOnce("manual", o); },
    status, start, stop,
  };
};
