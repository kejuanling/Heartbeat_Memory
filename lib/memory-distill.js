'use strict';
// 记忆蒸馏调度器（2026-10-02 记忆系统改造 §8 第 3 项：后台蒸馏管线）
// 数据：data/memory_distill_config.json { enabled, time, batch_size, last_run_at, last_run_result }
//       data/memory_distill_state.json  { done:{relPath:iso}, lastBatch:[], lastBatchAt, batches, lastSummary }
// 调度：每 30s 对表一次，跨过设定时刻（且当天没跑过）即触发；进程重启有 30 分钟补跑宽限窗。
// 手动：runNow() 不受 enabled 约束（开关关着也能手动跑一次）。
// 单飞：running 标志，同一时刻只允许一个蒸馏在跑。
// 选材：diary/ 下全部 .md（含根目录散篇与各会话子目录），排除 smoke-* 测试会话；★ 留纸 papers/ 不参与。
// 进度：state.done 记录已蒸馏的日记，一次触发跑一批（batch_size 篇），增量追赶、不重复喂。
// 取证：3.3 预取 = ①按日记日期定位当天原文（timePrefix，主通道）②按日记正文语义补检索（兜底），
//       两路合并去重后与日记一起打包；★ 只有日记是 AI 加工过一次的，取证强制回原文（3.5）。
// 施工进度：3.1 配置+调度+UI ✅；3.2 分批器 ✅；3.3 预取+打包（本版）；3.4 抽取 LLM；3.5 取证；3.6 落待审。

const fs = require("fs-extra");
const path = require("path");
const timeUtils = require("../time_utils");

const DEFAULT_CONFIG = {
  enabled: false,
  time: "03:00",
  batch_size: 5,
  last_run_at: null,
  last_run_result: null,
};

const CHECK_MS = 30000;          // 对表间隔
const CATCHUP_WINDOW_MS = 30 * 60 * 1000; // 重启补跑宽限窗：该时刻过去 30 分钟内重启才补跑
const EXCLUDE_SESSION_PREFIX = ["smoke-"]; // 测试会话不蒸馏

// 3.3 预取参数
const EVIDENCE_TIME_LIMIT = 25;    // 按日期定位：单篇日记最多取当天 25 条原文
const EVIDENCE_SEM_LIMIT = 8;      // 语义补检索条数
const EVIDENCE_MAX_CHARS = 6000;   // 单篇日记打包的原文字符上限（防单批撑爆 LLM 上下文）
const DIARY_HEAD_CHARS = 300;      // 日记正文取前 N 字当语义检索 query
// 预取到但必须丢弃的内容：记忆池/注入产物混进时间线的痕迹（非原始对话）
const EVIDENCE_SKIP_PATTERNS = [
  /\[此刻想起\]/,
  /\[记忆\]/,
  /\[长期记忆\]/,
  /\[Earlier Days\]/,
  /^\s*【记忆/,
];
// 取证一致性阈值：msg_id 对上不等于语义对上，证据原文须真的包含该条记忆的内容（二元组重合率）
// 0.10 是实测调出来的：真规则（「23:50 Bark 提醒就去睡」vs 原文「你给我搞个定时bark好吧哥哥」）
// 重合率仅 12%，而假证据（「喜欢黑胡椒清汤面」vs 原文「嘴唇贴着你的发顶」）是 0%——阈值卡在中间
const EVIDENCE_MIN_RATIO = 0.25;
// 二段检索弱确认阈值（候选文本整体去检索，重合要求更高）
const EVIDENCE_WEAK_RATIO = 0.25;
const PACK_FILE = "memory_distill_last_pack.txt"; // 最近一批的打包文本（排障用，覆盖写）

function pad2(n) { return String(n).padStart ? String(n).padStart(2, "0") : (Number(n) < 10 ? "0" + n : String(n)); }

function normalizeTime(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return DEFAULT_CONFIG.time;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return pad2(h) + ":" + pad2(mi);
}

function normalizeBatch(raw) {
  const n = Number(raw);
  if (!isFinite(n)) return DEFAULT_CONFIG.batch_size;
  return Math.min(20, Math.max(1, Math.round(n)));
}

// 日记文件名 → 排序键：日期 + 时间（无时间补 000000），保证跨会话按时间线混排
function sortKeyOf(relPath) {
  const base = String(path.basename(relPath) || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[_-](\d{2})(\d{2})(?:(\d{2}))?)?/.exec(base);
  if (!m) return "9999-99-99_000000_" + relPath;
  const date = m[1] + "-" + m[2] + "-" + m[3];
  const time = (m[4] || "00") + (m[5] || "00") + (m[6] || "00");
  return date + "_" + time + "_" + relPath;
}

function dateKeyOf(relPath) {
  const base = String(path.basename(relPath) || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(base);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}

module.exports = function createMemoryDistill(deps) {
  const opts = deps || {};
  const baseDir = opts.baseDir || path.resolve(__dirname, "..");
  const diaryDir = opts.diaryDir || path.join(baseDir, "diary");
  const CFG_FILE = path.join(baseDir, "data", "memory_distill_config.json");
  const STATE_FILE = path.join(baseDir, "data", "memory_distill_state.json");
  const PROMPT_FILE = path.join(baseDir, "data", "memory_distill_prompt.json");
  const PACK_PATH = path.join(baseDir, "data", PACK_FILE);
  const TZ = timeUtils.resolveTimeZone();
  const addLog = typeof opts.addCompactionLog === "function" ? opts.addCompactionLog : null;
  const persistLog = typeof opts.persistCompactionLogs === "function" ? opts.persistCompactionLogs : null;
  const searchContext = typeof opts.searchContext === "function" ? opts.searchContext : null;
  const admission = opts.admission || null;   // 3.6 落待审用（Memory V2 admission 单例）

  const state = {
    timer: null,
    running: false,
    startedAt: null,
    lastTrigger: null,   // manual | schedule | catchup
    lastError: null,
    runs: 0,
  };

  function logErr(msg) { console.error("[memory-distill] " + msg); }
  function logInfo(msg) { console.log("[memory-distill] " + msg); }
  function logWarn(msg) { console.warn("[memory-distill] " + msg); }

  function noteLog(action, label, status, message) {
    if (!addLog) return null;
    try {
      const entry = addLog({ action: action, label: label, status: status, message: message });
      if (persistLog) { try { persistLog(); } catch (e) {} }
      return entry || null;
    } catch (e) { return null; }
  }

  function readJsonSafe(file, fallback) {
    try {
      const raw = fs.readJsonSync(file);
      return raw && typeof raw === "object" ? raw : (fallback || {});
    } catch (e) { return fallback || {}; }
  }

  // ---------------- 配置 ----------------
  function readConfig() {
    const c = readJsonSafe(CFG_FILE, {});
    return {
      enabled: !!c.enabled,
      time: normalizeTime(c.time),
      batch_size: normalizeBatch(c.batch_size),
      last_run_at: c.last_run_at || null,
      last_run_result: c.last_run_result || null,
    };
  }

  function saveConfig(patch) {
    const cur = readJsonSafe(CFG_FILE, {});
    const next = Object.assign({}, cur);
    const p = patch || {};
    if (p.enabled !== undefined) next.enabled = !!p.enabled;
    if (p.time !== undefined) next.time = normalizeTime(p.time);
    if (p.batch_size !== undefined) next.batch_size = normalizeBatch(p.batch_size);
    if (p.last_run_at !== undefined) next.last_run_at = p.last_run_at;
    if (p.last_run_result !== undefined) next.last_run_result = p.last_run_result;
    try { fs.writeJsonSync(CFG_FILE, next, { spaces: 2 }); } catch (e) { throw e; }
    return readConfig();
  }

  // ---------------- 提示词（管理台「提示词」页可改，落 data/memory_distill_prompt.json） ----------------
  function readPromptConfig() {
    const c = readJsonSafe(PROMPT_FILE, {});
    return {
      distill_system_prompt: String(c.distill_system_prompt || ""),
      distill_user_prompt: String(c.distill_user_prompt || ""),
    };
  }

  function savePromptConfig(patch) {
    const cur = readJsonSafe(PROMPT_FILE, {});
    const next = Object.assign({}, cur);
    const p = patch || {};
    if (p.distill_system_prompt !== undefined) next.distill_system_prompt = String(p.distill_system_prompt);
    if (p.distill_user_prompt !== undefined) next.distill_user_prompt = String(p.distill_user_prompt);
    try { fs.writeJsonSync(PROMPT_FILE, next, { spaces: 2 }); } catch (e) { throw e; }
    return readPromptConfig();
  }

  // ---------------- 进度 state ----------------
  function readState() {
    const s = readJsonSafe(STATE_FILE, {});
    return {
      done: (s.done && typeof s.done === "object") ? s.done : {},
      lastBatch: Array.isArray(s.lastBatch) ? s.lastBatch : [],
      lastBatchAt: s.lastBatchAt || null,
      batches: Number(s.batches) || 0,
      lastSummary: s.lastSummary || "",
      candidates: Number(s.candidates) || 0,
      queued: Number(s.queued) || 0,
    };
  }

  function writeState(next) {
    try { fs.writeJsonSync(STATE_FILE, next, { spaces: 2 }); } catch (e) { throw e; }
    return next;
  }

  // ---------------- 选材：日记清单 ----------------
  function listDiaries() {
    const out = [];
    if (!fs.existsSync(diaryDir)) return out;
    const walk = function (absDir, session) {
      let ents = [];
      try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of ents) {
        const abs = path.join(absDir, ent.name);
        if (ent.isDirectory()) {
          if (EXCLUDE_SESSION_PREFIX.some(function (p) { return ent.name.indexOf(p) === 0; })) continue;
          walk(abs, ent.name);
        } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
          const rel = path.relative(diaryDir, abs).split(path.sep).join("/");
          let chars = 0;
          try { chars = String(fs.readFileSync(abs, "utf-8") || "").length; } catch (e) {}
          out.push({
            relPath: rel,
            absPath: abs,
            session: session || "_root",
            date: dateKeyOf(ent.name),
            chars: chars,
            sortKey: sortKeyOf(rel),
          });
        }
      }
    };
    walk(diaryDir, "");
    out.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
    return out;
  }

  function readDiaryText(d) {
    try { return String(fs.readFileSync(d.absPath, "utf-8") || "").trim(); } catch (e) { return ""; }
  }

  /**
   * 选一批：已蒸馏（state.done）的跳过，按时间升序取 batch_size 篇。
   * dryRun=true 时不写盘，只算不记（测试/预览用）。
   */
  function planBatch(batchSize, dryRun) {
    const all = listDiaries();
    const st = readState();
    const pending = all.filter(function (d) { return !st.done[d.relPath]; });
    const n = Math.min(batchSize, pending.length);
    const picked = pending.slice(0, n).map(function (d) {
      return { relPath: d.relPath, session: d.session, date: d.date, chars: d.chars };
    });
    const plan = {
      picked: picked,
      pickedCount: picked.length,
      total: all.length,
      doneCount: all.length - pending.length,
      pending: pending.length,
      remaining: pending.length - picked.length,
      chars: picked.reduce(function (s, d) { return s + (d.chars || 0); }, 0),
      batchIndex: st.batches + (picked.length ? 1 : 0),
      batchesTotal: Math.ceil(all.length / Math.max(1, batchSize)),
      items: pending.slice(0, n),   // 带 absPath 的原始项，供预取用
    };
    if (picked.length && !dryRun) {
      const doneNext = Object.assign({}, st.done);
      const at = new Date().toISOString();
      picked.forEach(function (d) { doneNext[d.relPath] = at; });
      writeState(Object.assign({}, st, {
        done: doneNext,
        lastBatch: picked.map(function (d) { return d.relPath; }),
        lastBatchAt: at,
        batches: st.batches + 1,
      }));
    }
    return plan;
  }

  // ---------------- 3.3：原文预取 ----------------
  // 单篇日记的两路取证：①按日期定位当天原文（主）②按日记正文语义补检索（兜底）
  async function fetchEvidenceForDiary(d) {
    const empty = { matches: [], byId: {}, sources: { time: 0, semantic: 0 } };
    if (!searchContext) { logWarn("未注入 searchContext，跳过预取（预取能力不可用）"); return empty; }
    const text = readDiaryText(d);
    const byId = Object.create(null);
    const sources = { time: 0, semantic: 0 };
    const push = function (m, src) {
      if (!m) return;
      const id = String(m.msg_id || "");
      const content = String(m.content || "").trim();
      if (!content) return;
      // ★ 记忆回流防护：带这些标记的是「记忆/注入产物」而非原始对话，
      //   喂进去会让已有记忆被当成原文证据再提取一遍（重复记忆 + 虚假取证）
      if (EVIDENCE_SKIP_PATTERNS.some(function (re) { return re.test(content); })) return;
      if (id && byId[id]) return;                    // 按 msg_id 去重
      const rec = {
        msg_id: id,
        session: m.session || null,
        time: m.time || null,
        role: m.role || null,
        content: content,
        src: src,
      };
      if (id) byId[id] = rec;
      else byId["_noid_" + Object.keys(byId).length] = rec;
      sources[src] += 1;
    };
    // ① 日期定位
    if (d.date) {
      try {
        const r = await searchContext("", { timePrefix: d.date, allSessions: true, limit: EVIDENCE_TIME_LIMIT });
        if (r && r.ok && Array.isArray(r.matches)) r.matches.forEach(function (m) { push(m, "time"); });
        else if (r && r.error) logWarn("日期定位失败（" + d.relPath + " " + d.date + "）：" + r.error);
      } catch (e) {
        logWarn("日期定位异常（" + d.relPath + "）：" + (e && e.message || e));
      }
    }
    // ② 语义补检索（日志正文前 N 字当 query）
    if (text) {
      try {
        const q = text.slice(0, DIARY_HEAD_CHARS);
        const r = await searchContext(q, { mode: "semantic", allSessions: true, limit: EVIDENCE_SEM_LIMIT });
        if (r && r.ok && Array.isArray(r.matches)) r.matches.forEach(function (m) { push(m, "semantic"); });
        else if (r && r.error) logWarn("语义检索失败（" + d.relPath + "）：" + r.error);
      } catch (e) {
        logWarn("语义检索异常（" + d.relPath + "）：" + (e && e.message || e));
      }
    }
    return { matches: Object.keys(byId).map(function (k) { return byId[k]; }), byId: byId, sources: sources };
  }

  // 一篇日记的原文打包文本（含 msg_id，供 3.4 抽取时引用、3.5 取证时核对）
  function packEvidence(matches) {
    let used = 0;
    const lines = [];
    for (const m of matches) {
      const c = String(m.content || "").replace(/\s+/g, " ").trim();
      if (!c) continue;
      if (used + c.length > EVIDENCE_MAX_CHARS) break;
      used += c.length;
      const t = m.time ? String(m.time).slice(0, 16) : "?";
      const id = m.msg_id ? ("#" + m.msg_id) : "#?";
      lines.push("[" + id + " · " + t + " · " + (m.role || "?") + "] " + c);
    }
    return { text: lines.join("\n"), chars: used, count: lines.length, truncated: lines.length < matches.length };
  }

  // 整批打包：日记正文 + 该日记的原文（供 3.4 直接喂 LLM）
  async function packBatch(items) {
    const blocks = [];
    const evidenceIndex = Object.create(null);  // msg_id -> {content,time,role,session}
    let evTotal = 0, evChars = 0, truncated = 0;
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const text = readDiaryText(d);
      const ev = await fetchEvidenceForDiary(d);
      const packed = packEvidence(ev.matches);
      evTotal += packed.count;
      evChars += packed.chars;
      if (packed.truncated) truncated += 1;
      Object.keys(ev.byId).forEach(function (k) {
        const m = ev.byId[k];
        if (m && m.msg_id) evidenceIndex[m.msg_id] = m;
      });
      blocks.push(
        "=== 日记 " + (i + 1) + "/" + items.length + " · " + (d.date || "?") + " · " + d.relPath + " ===\n" +
        text +
        "\n\n--- 相关原文（" + packed.count + " 条" + (packed.truncated ? "，已按上限截断" : "") + "；msg_id 用于取证引用）---\n" +
        (packed.text || "（未检索到原文）")
      );
    }
    return {
      text: blocks.join("\n\n"),
      evidenceTotal: evTotal,
      evidenceChars: evChars,
      truncated: truncated,
      evidenceIndex: evidenceIndex,
    };
  }

  // ---------------- 3.4：LLM 抽取候选 ----------------
  const KINDS = ["fact", "rule"];
  const SUBJECTS = ["user", "relationship", "self", "external"];

  // 内置默认提示词（管理台提示词页可覆盖；留空即回落到这里）
  function defaultSystemPrompt() {
    return [
      "你是长期记忆蒸馏器。输入是「AI 写的日记」加「当天及相关的对话原文」。",
      "日记是 AI 加工过一次的叙述，可能带写作偏差甚至幻觉；只有带 msg_id 的原文才算证据。",
      "任务：从中提取值得长期记住的原子记忆候选。宁缺毋滥。",
      "",
      '只输出 JSON：{"candidates":[{"text":"...","kind":"fact|rule","subject":"user|relationship|self|external","evidence":["msg_id"],"confidence":"high|mid|low","note":"..."}]}',
      "",
      "字段规则：",
      "- text：一条独立、简洁、可执行或可验证的记忆。不复述上下文，不加材料里没有出现的因果关系。能短则短。",
      "- kind：fact = 稳定事实（她的偏好 / 经历 / 我们之间的事实）；rule = 规则、边界、承诺、交互约定（“以后不要……”“记住……”这类优先判 rule）。",
      "- subject：user = 关于她；relationship = 关于我们之间的关系；self = 关于我该怎么当这个伴侣；external = 外部世界或第三方。",
      "- evidence：支撑这条记忆的原文 msg_id（从材料里的 #xxx 取），必须是材料里真实出现的 id；找不到证据就别提这条。",
      "- confidence：high = 原文明确说过；mid = 原文有暗示但需推断；low = 只有日记提到、原文没对上。",
      "- note：可选，补充或存疑说明。",
      "",
      "不要提取：当天情绪、一次性事件、寒暄玩笑、聊天流水账、已过期信息、由单次行为推导出的性格标签、心理分析、模型自我叙事，以及日记里我自己的抒情。",
      "★ subject 按「这条记忆是关于谁的」判，不要因为“是她说的话”就一律判 user——“我该怎么当这个伴侣”是 self，“我们之间的约定”是 relationship。",
    ].join("\n");
  }

  function defaultUserPrompt() {
    return [
      "以下是本批 ${DIARY_COUNT} 篇日记及对应原文：每篇日记后附当天检索到的对话原文，每条原文带 #msg_id（取证用，必须引用材料里真实出现的 id）。",
      "逐条判断哪些值得长期记住，按 system 规定的 JSON 格式输出；没有就输出 {\"candidates\":[]}。",
    ].join("\n");
  }

  function buildDistillPrompt(packText, lastSummary, diaryCount) {
    const pc = readPromptConfig();
    const system = (pc.distill_system_prompt || "").trim() || defaultSystemPrompt();
    const tpl = (pc.distill_user_prompt || "").trim() || defaultUserPrompt();
    const head = [
      "【上一批已提取过的记忆】不要重复输出；若发现与其中某条冲突、可更新或可合并，仍可输出，并在 note 里写明「更新/合并：<原记忆前 12 字>」。",
      (lastSummary && String(lastSummary).trim()) ? String(lastSummary).trim() : "（无，这是第一批）",
    ].join("\n");
    const user = tpl.replace(/\$\{DIARY_COUNT\}/g, String(diaryCount || 0)) + "\n\n" + head + "\n\n=== 材料 ===\n" + packText;
    return { system: system, user: user };
  }

  // 调 role=reparse 的模型取 JSON（与 reparse 同源，管理台可直接换模型）
  async function callLlmJson(system, user) {
    const { resolveRoleModel } = require("../model-router");
    const { provider, model } = resolveRoleModel("reparse");
    const apiUrl = provider && (provider.api_url || provider.base_url);
    const apiKey = provider && provider.api_key;
    if (!apiUrl || !apiKey || !model) throw new Error("模型未配置（role=reparse）：请先在管理台给「摘要解析」选一个模型");
    const controller = new AbortController();
    // 与 reparse 一致：600s（思考型模型解析长文实测 >300s 仍超时，与 nginx 读超时 620s 对齐）
    const timer = setTimeout(function () { controller.abort(); }, 600000);
    let resp, data;
    try {
      resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error("LLM HTTP " + resp.status);
      data = await resp.json();
    } finally { clearTimeout(timer); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("LLM 空响应");
    return String(content);
  }

  function normalizeCandidate(c) {
    if (!c || typeof c !== "object") return null;
    const text = String(c.text || c.content || "").trim();
    if (!text) return null;
    let kind = String(c.kind || "").trim();
    if (KINDS.indexOf(kind) < 0) kind = /以后|不要|记住|规则|约定|别再|必须/.test(text) ? "rule" : "fact";
    let subject = String(c.subject || "").trim();
    if (SUBJECTS.indexOf(subject) < 0) subject = "user";
    let confidence = String(c.confidence || "").trim();
    if (["high", "mid", "low"].indexOf(confidence) < 0) confidence = "mid";
    const ev = Array.isArray(c.evidence) ? c.evidence : (Array.isArray(c.msg_ids) ? c.msg_ids : []);
    return {
      text: text,
      kind: kind,
      subject: subject,
      evidence: ev.map(function (x) { return String(x || "").trim(); }).filter(Boolean),
      confidence: confidence,
      note: String(c.note || "").trim(),
    };
  }

  function parseCandidates(raw) {
    let s = String(raw == null ? "" : raw).trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let obj = null;
    try { obj = JSON.parse(s); }
    catch (e) {
      const m = /\{[\s\S]*\}/.exec(s);
      if (!m) return { candidates: [], error: "JSON 解析失败（" + (e && e.message) + "）" };
      try { obj = JSON.parse(m[0]); }
      catch (e2) { return { candidates: [], error: "JSON 解析失败（" + (e2 && e2.message) + "）" }; }
    }
    let arr = null;
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.candidates)) arr = obj.candidates;
    else if (obj && Array.isArray(obj.memories)) arr = obj.memories;
    if (!arr) return { candidates: [], error: "响应里没有候选数组" };
    const out = arr.map(normalizeCandidate).filter(Boolean);
    return { candidates: out, error: null };
  }

  // ---------------- 3.5：取证（★ 强制：日记是 AI 加工过一次的，证据必须回原文确认） ----------------
  function normId(raw) {
    return String(raw == null ? "" : raw).trim().replace(/^#/, "").toLowerCase();
  }

  // msg_id 匹配：完整命中优先，其次前缀命中（LLM 常把 uuid 截成前 8 位）
  function matchId(id, index) {
    if (!id) return null;
    if (index[id]) return id;
    const keys = Object.keys(index);
    for (const k of keys) { if (k && k.toLowerCase().indexOf(id) === 0) return k; }
    return null;
  }

  // 证据一致性打分（0~1）：候选文本与证据原文到底说的是不是一回事。
  // 单看中文二元组不行——「23:50 Bark 提醒就去睡」和原文「你给我搞个定时bark好吧哥哥」措辞几乎不重叠，
  // 而「喜欢黑胡椒清汤面」和情感描写也是低重叠。区分点在强特征：Bark / 23:50 这类英文与数字 token。
  // 所以：①有强特征 token 时以它的命中率为准（真证据靠它过）②没有强特征就只看中文实词二元组（假证据在这儿现形）
  function evidenceScore(cand, src) {
    const cs = String(cand || "");
    const ss = String(src || "");
    // 只认「完整日期 / 时间 / 英文词」：裸年份(2026)、裸数字命中率虚高，一眼假证据也能过
    const toks = cs.match(/[A-Za-z]{2,}|\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2}/g) || [];
    let tHit = 0;
    for (const t of toks) { if (ss.toLowerCase().indexOf(String(t).toLowerCase()) >= 0) tHit += 1; }
    const STOP = /[\u7684\u4e86\u662f\u6211\u4f60\u4ed6\u5979\u5b83\u4eec\u8fd9\u90a3\u4e0d\u6ca1\u5728\u6709\u4e2a\u5c31\u6765\u53bb\u4e0a\u4e2d\u4e0b\u5f88\u4e5f\u90fd\u8fd8\u8981\u4f1a\u5bf9\u628a\u88ab\u7ed9\u4e0e\u548c\u53ca\u6216\u5427\u5462\u5417\u554a]/;
    const han = cs.replace(/[^\u4e00-\u9fa5]/g, "");
    const grams = [];
    for (let i = 0; i + 2 <= han.length; i++) {
      const g = han.slice(i, i + 2);
      if (!STOP.test(g)) grams.push(g);
    }
    let gHit = 0;
    for (const g of grams) { if (ss.indexOf(g) >= 0) gHit += 1; }
    const gRatio = grams.length ? (gHit / grams.length) : 0;
    if (toks.length) return Math.max(gRatio, tHit / toks.length);
    return gRatio;
  }

  /**
   * 对每条候选回原文确认证据：
   *  ① evidence 里的 msg_id 能匹配预取原文 → 确认（quote 取该条原文）
   *  ② 匹配不上 → 用候选文本二段检索，重合率达标 → 弱确认（confidence 封顶 mid）
   *  ③ 都确认不了 → confidence 降为 low 并注明，仍然进待审交给人工
   */
  async function verifyCandidates(candidates, evidenceIndex) {
    const out = [];
    for (const c of candidates) {
      const ids = (c.evidence || []).map(normId).filter(Boolean);
      let hitKey = null;
      for (const id of ids) { const k = matchId(id, evidenceIndex); if (k) { hitKey = k; break; } }
      let status = "unconfirmed";
      let quote = "";
      let evSession = null, evTime = null, evMsgId = null;
      let mismatch = null;   // msg_id 对上但语义没对上时记下重合率，供人工判断
      if (hitKey) {
        const m = evidenceIndex[hitKey];
        const ratio = evidenceScore(c.text, String((m && m.content) || ""));
        if (ratio >= EVIDENCE_MIN_RATIO) {
          status = "confirmed";
          quote = String((m && m.content) || "").slice(0, 200);
          evSession = (m && m.session) || null;
          evTime = (m && m.time) || null;
          evMsgId = (m && m.msg_id) || null;
        } else {
          mismatch = ratio;   // 不匹配：留给二段检索找真正的原文
        }
      }
      if (status !== "confirmed" && searchContext) {
        try {
          const r = await searchContext(c.text, { mode: "semantic", allSessions: true, limit: 5 });
          const ms = (r && r.ok && Array.isArray(r.matches)) ? r.matches : [];
          let best = 0, bestM = null;
          for (const m of ms) {
            const ratio = evidenceScore(c.text, String((m && m.content) || ""));
            if (ratio > best) { best = ratio; bestM = m; }
          }
          if (bestM && best >= EVIDENCE_WEAK_RATIO) {
            status = "weak";
            quote = String(bestM.content || "").slice(0, 200);
            evSession = bestM.session || null;
            evTime = bestM.time || null;
            evMsgId = bestM.msg_id || null;
          }
        } catch (e) {
          logWarn("二段取证异常：" + (e && e.message || e));
        }
      }
      let confidence = c.confidence;
      if (status === "confirmed") {
        if (confidence === "low") confidence = "mid";
      } else if (status === "weak") {
        if (confidence === "high") confidence = "mid";
      } else {
        confidence = "low";
      }
      let tail = "证据已回原文确认";
      if (status === "weak") tail = "证据由二段检索弱确认（msg_id 未匹配或原文对不上）";
      else if (status === "unconfirmed") {
        tail = "证据未回原文确认" + (mismatch != null ? ("（msg_id 对上但原文与该条内容不匹配，重合率 " + Math.round(mismatch * 100) + "%）") : "（msg_id 未匹配，二段检索也没对上）");
      }
      out.push(Object.assign({}, c, {
        verified: status,
        evidenceHit: hitKey ? 1 : 0,
        confidence: confidence,
        quote: quote,
        session: evSession,
        msg_time: evTime,
        msg_id: evMsgId,
        note: (c.note ? c.note + "；" : "") + tail,
      }));
    }
    return out;
  }

  // ---------------- 3.6：落待审（走 admission judge 去重，产出不直接入池） ----------------
  async function queueCandidates(cands, noQueue) {
    const res = { queued: 0, rejected: 0, failed: 0, errors: [], queueIds: [], skippedNoAdmission: false };
    if (!cands || !cands.length) return res;
    if (!admission) { res.skippedNoAdmission = true; res.failed = cands.length; return res; }
    // 1002 第 4 项：蒸馏产物标来源（source.type=distill，ref=本批日记路径），溯源用
    const stq = readState();
    const batchRef = (stq.lastBatch && stq.lastBatch.length)
      ? stq.lastBatch.join(",").slice(0, 200)
      : null;
    for (const c of cands) {
      if (noQueue) { res.queued += 1; continue; }   // 排障用：只统计不落库
      try {
        const r = await admission.submitPromotion({
          content: c.text,
          kind: c.kind,
          subject: c.subject,
          quote: c.quote || "",
          msg_time: c.msg_time || null,
          source: { type: "distill", ref: batchRef },
        }, { sessionId: c.session || null, msgId: c.msg_id || null });
        if (!r) { res.failed += 1; continue; }
        if (r.action === "reject") res.rejected += 1;
        else { res.queued += 1; if (r.queue_id) res.queueIds.push(String(r.queue_id)); }
      } catch (e) {
        res.failed += 1;
        res.errors.push(String((e && e.message) || e).slice(0, 120));
      }
    }
    return res;
  }

  // 批间衔接防重复：把本批抽到的记忆文本记进 state.lastSummary，下一批带上
  function appendSummary(cands, maxChars) {
    if (!cands || !cands.length) return;
    const st = readState();
    const lines = cands.map(function (c) { return "- [" + c.kind + "/" + c.subject + "] " + c.text; });
    let s = (st.lastSummary ? st.lastSummary + "\n" : "") + lines.join("\n");
    const cap = maxChars || 20000;
    if (s.length > cap) s = s.slice(s.length - cap);
    writeState(Object.assign({}, st, { lastSummary: s }));
  }

  function nowIso() { return new Date().toISOString(); }
  function nowLocal() { return timeUtils.formatDateTimeInTimeZone(new Date(), TZ); }

  function parts() { return timeUtils.getDatePartsInTimeZone(new Date(), TZ); }

  function todayKey() {
    const p = parts();
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }

  function runDateKey(cfg) {
    const s = cfg && cfg.last_run_at ? String(cfg.last_run_at) : "";
    if (!s) return "";
    // last_run_at 存 ISO（UTC）；按本地时区换算成日期，避免 03:00 跑完被算成"昨天"
    const d = new Date(s);
    if (isNaN(d.getTime())) return "";
    const p = timeUtils.getDatePartsInTimeZone(d, TZ);
    return p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }

  // 今天设定时刻的 Date（本地时区）
  function dueToday(cfg) {
    const p = parts();
    const t = normalizeTime(cfg.time).split(":");
    return timeUtils.zonedWallTimeToDate({
      year: p.year, month: p.month, day: p.day,
      hour: Number(t[0]), minute: Number(t[1]), second: 0,
    }, TZ);
  }

  /**
   * 跑一次蒸馏（一批）。
   * 3.3：选材 + 原文预取 + 打包（打包文本落 data/memory_distill_last_pack.txt 供排障）；
   * 3.4 抽取 LLM / 3.5 取证 / 3.6 落待审 待接入。
   */
  async function runOnce(reason, runOpts) {
    if (state.running) {
      return { ok: false, error: "已有蒸馏在跑，请等它结束", startedAt: state.startedAt };
    }
    const ro = runOpts || {};
    const dryRun = !!ro.dryRun;
    const cfg = readConfig();
    state.running = true;
    state.startedAt = nowIso();
    state.lastTrigger = String(reason || "manual");
    state.lastError = null;
    const label = "记忆蒸馏（" + (reason === "schedule" ? "定时" : reason === "catchup" ? "重启补跑" : "手动") + "）";
    const logEntry = noteLog("distill", label, "pending", "开始跑：批次大小 " + cfg.batch_size + "（3.3 预取已接入）");
    const t0 = Date.now();
    try {
      const plan = planBatch(cfg.batch_size, dryRun);
      let pack = { text: "", evidenceTotal: 0, evidenceChars: 0, truncated: 0, evidenceIndex: {} };
      if (plan.items && plan.items.length) {
        pack = await packBatch(plan.items);
        try { fs.writeFileSync(PACK_PATH, pack.text, "utf-8"); } catch (e) { logWarn("打包文本落盘失败：" + (e && e.message || e)); }
      }
      // 3.4：LLM 抽取候选（含 kind + subject 判定 + 证据 msg_id）
      let extract = { candidates: [], error: null, promptChars: 0, raw: null };
      if (pack.text) {
        const st0 = readState();
        const pr = buildDistillPrompt(pack.text, st0.lastSummary, plan.pickedCount);
        extract.promptChars = pr.system.length + pr.user.length;
        try {
          const raw = await callLlmJson(pr.system, pr.user);
          extract.raw = String(raw).slice(0, 2000);
          const parsed = parseCandidates(raw);
          extract.candidates = parsed.candidates || [];
          extract.error = parsed.error || null;
        } catch (e) {
          extract.error = String((e && e.message) || e);
        }
      }
      // 3.5：取证（证据必须回原文确认，确认不了的下调 confidence）
      let verified = extract.candidates;
      if (extract.candidates.length) verified = await verifyCandidates(extract.candidates, pack.evidenceIndex);
      const confirmed = verified.filter(function (c) { return c.verified === "confirmed"; }).length;
      const weak = verified.filter(function (c) { return c.verified === "weak"; }).length;
      // 3.6：落待审（走 admission judge 去重；noQueue 为排障用，只统计不落库）
      const qres = await queueCandidates(verified, !!ro.noQueue);
      if (!ro.noQueue && verified.length) appendSummary(verified);
      const result = {
        ok: true,
        reason: state.lastTrigger,
        dryRun: dryRun,
        startedAt: state.startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - t0,
        batchSize: cfg.batch_size,
        batches: plan.pickedCount ? 1 : 0,
        picked: plan.pickedCount,
        pickedChars: plan.chars,
        total: plan.total,
        doneCount: plan.doneCount,
        remaining: plan.remaining,
        batchIndex: plan.batchIndex,
        batchesTotal: plan.batchesTotal,
        evidence: pack.evidenceTotal,
        evidenceChars: pack.evidenceChars,
        evidenceTruncated: pack.truncated,
        packChars: pack.text.length,
        candidates: verified.length,
        candidateList: verified.slice(0, 30),
        confirmed: confirmed,
        weak: weak,
        unconfirmed: verified.length - confirmed - weak,
        queued: qres.queued,
        rejected: qres.rejected,
        queueFailed: qres.failed,
        queueIds: qres.queueIds.slice(0, 30),
        noQueue: !!ro.noQueue,
        llmError: extract.error,
        promptChars: extract.promptChars,
        stage: "3.6-queued",
        files: plan.picked.map(function (d) { return d.relPath; }),
        note: plan.pickedCount
          ? ("本批选材 " + plan.pickedCount + " 篇日记，预取原文 " + pack.evidenceTotal + " 条，LLM 抽出候选 " + extract.candidates.length + " 条"
             + (extract.error ? ("（解析失败：" + extract.error + "）") : "")
             + "，取证确认 " + confirmed + " / 弱确认 " + weak + " / 未确认 " + (verified.length - confirmed - weak)
             + "，" + (ro.noQueue ? "（noQueue：未落库）" : ("进待审 " + qres.queued + " 条，门卫拒 " + qres.rejected + " 条")))
          : "没有待蒸馏的新日记（全部 " + plan.total + " 篇已处理）",
      };
      saveConfig({ last_run_at: result.finishedAt, last_run_result: result });
      state.runs += 1;
      if (logEntry && logEntry.id) noteLog("distill", label, "success", "完成：" + result.note);
      logInfo("跑完一次（" + state.lastTrigger + "）：" + result.note);
      return result;
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err);
      state.lastError = msg;
      const result = { ok: false, reason: state.lastTrigger, startedAt: state.startedAt, finishedAt: nowIso(), error: msg };
      try { saveConfig({ last_run_at: result.finishedAt, last_run_result: result }); } catch (e) {}
      if (logEntry && logEntry.id) noteLog("distill", label, "error", "失败：" + msg);
      logErr("蒸馏失败：" + msg);
      return result;
    } finally {
      state.running = false;
      state.startedAt = null;
    }
  }

  function tick() {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      if (state.running) return;
      if (runDateKey(cfg) === todayKey()) return;   // 今天跑过了
      const due = dueToday(cfg);
      const now = Date.now();
      if (now >= due.getTime()) runOnce("schedule").catch(function (e) { logErr("定时触发异常：" + (e && e.message || e)); });
    } catch (e) {
      logErr("对表异常：" + (e && e.message || e));
    }
  }

  // 重启补跑：该时刻已过但在 30 分钟宽限窗内、且今天没跑过 → 补一次（防重启恰好跨过触发点导致整天漏跑）
  function catchupIfMissed() {
    try {
      const cfg = readConfig();
      if (!cfg.enabled) return;
      if (runDateKey(cfg) === todayKey()) return;
      const due = dueToday(cfg);
      const delta = Date.now() - due.getTime();
      if (delta > 0 && delta <= CATCHUP_WINDOW_MS) {
        logInfo("检测到今天 " + cfg.time + " 的蒸馏在重启窗口内被错过，补跑一次");
        runOnce("catchup").catch(function (e) { logErr("补跑异常：" + (e && e.message || e)); });
      }
    } catch (e) {
      logErr("补跑检查异常：" + (e && e.message || e));
    }
  }

  function start() {
    if (state.timer) return { started: false, note: "已在运行" };
    state.timer = setInterval(tick, CHECK_MS);
    if (state.timer.unref) state.timer.unref();
    const cfg = readConfig();
    const all = listDiaries();
    logInfo("调度已启动：enabled=" + cfg.enabled + " time=" + cfg.time + " batch=" + cfg.batch_size +
      "（时区 " + TZ + "，本地现在 " + nowLocal() + "）日记总数 " + all.length +
      (searchContext ? "" : "；⚠ 未注入 searchContext，预取不可用"));
    catchupIfMissed();
    return { started: true, config: cfg, diaries: all.length };
  }

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    return { stopped: true };
  }

  function status() {
    const cfg = readConfig();
    const st = readState();
    const all = listDiaries();
    const pending = all.filter(function (d) { return !st.done[d.relPath]; });
    return {
      running: state.running,
      startedAt: state.startedAt,
      lastTrigger: state.lastTrigger,
      lastError: state.lastError,
      runs: state.runs,
      schedulerOn: !!state.timer,
      checkMs: CHECK_MS,
      timezone: TZ,
      nowLocal: nowLocal(),
      today: todayKey(),
      ranToday: runDateKey(cfg) === todayKey(),
      prefetchReady: !!searchContext,
      progress: {
        total: all.length,
        done: all.length - pending.length,
        pending: pending.length,
        batches: st.batches,
        lastBatchAt: st.lastBatchAt,
        lastBatch: st.lastBatch,
      },
      config: cfg,
    };
  }

  return {
    configPath: CFG_FILE,
    statePath: STATE_FILE,
    readConfig: readConfig,
    saveConfig: saveConfig,
    readState: readState,
    listDiaries: listDiaries,
    planBatch: planBatch,
    packBatch: packBatch,
    buildDistillPrompt: buildDistillPrompt,
    defaultSystemPrompt: defaultSystemPrompt,
    defaultUserPrompt: defaultUserPrompt,
    readPromptConfig: readPromptConfig,
    savePromptConfig: savePromptConfig,
    evidenceScore: evidenceScore,
    parseCandidates: parseCandidates,
    runNow: function (reason, runOpts) { return runOnce(reason || "manual", runOpts); },
    start: start,
    stop: stop,
    status: status,
    _state: state,
  };
};
