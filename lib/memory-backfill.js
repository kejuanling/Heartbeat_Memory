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
const MODEL_ROLE = "backfill";             // 1003-11 拆分：老数据重跑独立配置（结构化 JSON 输出）
const LLM_TIMEOUT_MS = 600000;
const EVIDENCE_TIME_LIMIT = 16;             // 按记忆创建日期定位：当天最多取几条原文（放宽，由相关性门槛筛）
const EVIDENCE_PER_ROW = 6;                 // 语义补检索条数（放宽，由相关性门槛筛）
const EVIDENCE_CHAR_PER_ROW = 600;          // 每条记忆的原文字符上限
const EVIDENCE_MIN_LEN = 24;                // 原文短于这个字数不作证据：十几个字的闲聊随便撞上一两个字就能过比率门槛
const EVIDENCE_MIN_HITS = 3;                // 命中二元组的最少个数（与比率双条件，防短句随机重合）
// 1003 用户拍板：闸拉松（原本 2 轮 / 8 条 / 6 条太紧，模型动不动被截断）。
// 留上限不是为了防上游抽风，是防模型死循环——它理论上可以每轮都提检索，永远不出结论。
const SEARCH_ROUNDS = 4;             // 模型最多能提几轮补充检索（它自己定关键词，比我们替它猜准得多）
const SEARCH_MAX_PER_ROUND = 20;     // 每轮最多受理几条检索请求
const SEARCH_LIMIT_PER_QUERY = 8;    // 每次检索返回条数上限（照旧过噪声 / 相关性门槛）
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
    // 1003-25：改传对象（字符串入参会被 addCompactionLog 拆成字符索引垃圾）
    try { if (addLog) addLog({ action: "system", label: "后台任务", status: "success", message: "[memory-backfill] " + msg }); } catch (_) {}
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
      "★ 存量里最该处理的是**重复**：同一件事被记了两遍以上（措辞不同、意思一样），留最好用的那条，其余合并或建议沉底。",
      "",
      "动作：",
      "- update：正文过时 / 有误 / 啰嗦 / 有歧义，给出 new_text（**完整新正文**，不是只写改动部分）。允许润色，不必非得与原文矛盾才改。",
      "- supplement：信息不全，往里加内容。add_text 是要加的部分，new_text 是加完之后的完整正文。",
      "- merge：两条以上记的是**同一件事的碎片**（同一件事的不同侧面、同一条信息被拆成了好几条），合成一条。ids 列出要合并的 id，new_text 是合成后的完整正文。★ 合完仍然是一条能独立读懂、能独立引用的记忆，才算合对了；合完变成一串拼盘，就是合错了。",
      "- sink：已经过时、失效，或根本不该长期记的（一次性事件、早就改掉的旧约定、过期的旧规矩），建议沉底归档。",
      "- create：从原文里发现漏掉的、值得长期记住的东西（现有记忆里没有）。按蒸馏标准抽：宁缺毋滥，**过时的旧约定不抽**，一次性的亲昵细节不抽。",
      "- keep：不用动。默认就是 keep，**不要输出**。",
      "",
      "铁律：",
      "1. **不确定就 keep**。每一条改动都要人工过目，宁可不动也别乱改。",
      "2. **只有原文（#msg_id）能证明的才敢改、敢沉**；原文对不上、或压根没给原文的一律 keep——唯一例外见第 2b 条。",
      "2b. **「没检索到原文」的条目，只放行两件最保守的动作**：① merge 两条几乎在说同一件事的重复（凭正文就能判定，不需要原文）；② sink 明显不该长期记的（一次性事件、早被替代的旧规矩）。**不准 update／supplement／create**——没有原文就没有依据，不许凭感觉改写或补充。",
      "3. sink 是删除级动作，只在明显过时或明显不该记时才用；拿不准就 keep。",
      "4. new_text 一律写完整正文，不要写「把……改成……」这种指令式句子。",
      "5. 别制造重复：两条记忆说的是同一件事就 merge，不要各自 update 成一样的话（**原话／语录除外**，见第 8 条）。",
      "6. reason 写一句人话说明为什么动它——人工审核时只有这一句能帮他看懂。",
      "7. 正文里的时间、原话、细节能保留就保留；润色不等于抹掉具体。",
      "8. **原话／语录不合并**：「涵（2026-07-23）：\"……\"」这种带日期的一句原话，价值就在于它是当时说的那一句——把它并进「某某语录集」里，反而不好引用，也各自丢了时间。遇到这种就 keep 不动；正文有问题可以 update 润色，但不要 merge。该合并的是同一件事的事实碎片（比如几条都在说她爱吃什么、都在说同一次冲突），不是各自独立的原话。",
      "",
      '只输出 JSON：{"actions":[{"action":"update","id":"m_xxx","new_text":"...","reason":"..."}]}',
      "merge 用 ids 数组：{\"action\":\"merge\",\"ids\":[\"m_a\",\"m_b\"],\"new_text\":\"...\",\"reason\":\"...\"}",
      "create 带 kind/subject：{\"action\":\"create\",\"text\":\"...\",\"kind\":\"fact|rule\",\"subject\":\"user|relationship|self|external\",\"evidence\":[\"msg_id\"],\"reason\":\"...\"}",
      "需要原文时先提检索请求：{\"search\":[{\"id\":\"m_xxx\",\"query\":\"你认为能搜到原文的关键词，或她当时的原话片段\"}]}（一次最多 " + SEARCH_MAX_PER_ROUND + " 条），系统按你给的 query 去搜、把原文回给你，你再判断；最多提 " + SEARCH_ROUNDS + " 轮，之后必须出结论。",
      "★ 同一条原文本批只会给你一次：换个词又搜到同样的东西时，系统只回一句「本批前面已给过 #xxx」，不再重复。看到这句话就说明没有新信息了，别再拿同一个意思换着词搜——换个话题，或直接按第 2b 条处理。",
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
      "材料里标了「没检索到原文」的，可以输出 {\"search\":[{\"id\":\"...\",\"query\":\"...\"}]} 让我替你搜——你比我会猜关键词。拿到原文后再出 actions。",
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
  // 字符二元组重合：记忆正文 vs 原文，判断「这条原文是不是真的在说这件事」。
  // 返回 { ratio: 重合率, hits: 命中个数 }——只看比率会被短句骗（"我老公呢" 只有 3 个二元组，撞中 1 个就是 0.33），
  // 所以调用方要求 hits 与 ratio 双达标。
  function bigramScore(a, b) {
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
    return { ratio: total ? hit / total : 0, hits: hit };
  }

  // 候选原文 -> 格式化证据行（去重 + 噪声黑名单 + 长度 + 相关性双条件）
  // 1003：seenBatch 是整批共享的「已给过」集合——同一条原文本批只回灌一次，不重复喂给模型。
  // 传 null 表示不去重（单条内部仍去重）。返回 ids/dups 供调用方记账。
  function filterCands(row, cands, seenBatch) {
    const seen = Object.create(null);
    const lines = [];
    const ids = [];
    const dups = [];
    let used = 0;
    for (const m of cands) {
      const id = String(m.msg_id || "");
      if (id && seen[id]) continue;
      const c = String(m.content || "").replace(/\s+/g, " ").trim();
      if (!c) continue;
      if (EVIDENCE_SKIP_PATTERNS.some(function (re) { return re.test(c); })) continue;
      if (c.length < EVIDENCE_MIN_LEN) continue;
      const sc = bigramScore(row.text, c);
      if (sc.hits < EVIDENCE_MIN_HITS || sc.ratio < EVIDENCE_MIN_RATIO) continue;
      // 整批已给过 → 记一笔重复，不再回灌（模型换个词搜到同一条是常事）
      if (id && seenBatch && seenBatch[id]) { dups.push(id); continue; }
      if (id) seen[id] = true;
      if (used + c.length > EVIDENCE_CHAR_PER_ROW) break;
      used += c.length;
      if (id) { ids.push(id); if (seenBatch) seenBatch[id] = true; }
      const t = m.time ? String(m.time).slice(0, 16) : "?";
      lines.push("  └ #" + (id || "?") + "（" + t + " · " + (m.role || "?") + "）" + c);
    }
    return { lines: lines, ids: ids, dups: dups };
  }

  // 单条记忆取原文：query 为空 = 按创建日期定位；有 query = 按模型给的关键词语义检索
  async function searchForRow(row, query, limit, seenBatch) {
    const cands = [];
    const q = String(query || "").trim();
    if (!q) {
      const day = String(row.created_at || "").slice(0, 10);
      if (day) {
        try {
          const res = await searchContext("", { timePrefix: day, allSessions: true, limit: EVIDENCE_TIME_LIMIT });
          if (res && res.ok && Array.isArray(res.matches)) cands.push.apply(cands, res.matches);
        } catch (e) {
          log("时间定位异常（" + row.id + " " + day + "）：" + (e && e.message || e));
        }
      }
    }
    try {
      const res = await searchContext(q || row.text.slice(0, 120), { mode: "semantic", allSessions: true, limit: limit || EVIDENCE_PER_ROW });
      if (res && res.ok && Array.isArray(res.matches)) cands.push.apply(cands, res.matches);
    } catch (e) {
      log("检索异常（" + row.id + "）：" + (e && e.message || e));
    }
    return filterCands(row, cands, seenBatch || null);
  }

  // 预取：也要进 seenBatch——模型后面再搜到同一条，就不该重复回灌了
  async function fetchEvidence(rows, seenBatch) {
    const out = Object.create(null);
    if (!searchContext) { log("未注入 searchContext，本批无原文（只能靠模型自己提检索请求）"); return out; }
    for (const r of rows) {
      const res = await searchForRow(r, "", EVIDENCE_PER_ROW, seenBatch);
      if (res.lines.length) out[r.id] = res.lines.join("\n");
    }
    return out;
  }

  // 模型自己提的检索请求：按它给的 query 去搜，把原文回灌给它
  // 1003：整批共享 seenBatch，重复的原文只提示一次「本批前面已给过」，不再整条重复回灌
  async function handleSearchRequests(reqs, rows, seenBatch) {
    const byId = Object.create(null);
    rows.forEach(function (r) { byId[r.id] = r; });
    const parts = [];
    let dupTotal = 0;
    for (const s of reqs) {
      const row = byId[s.id];
      if (!row) { parts.push("[" + s.id + "] 不在本批记忆里，没法搜。"); continue; }
      const res = await searchForRow(row, s.query, SEARCH_LIMIT_PER_QUERY, seenBatch);
      dupTotal += res.dups.length;
      let body;
      if (res.lines.length) {
        body = res.lines.join("\n")
          + (res.dups.length ? "\n  └ （另有 " + res.dups.length + " 条本批前面已给过的原文，不重复：#" + res.dups.slice(0, 5).join(" #") + "）" : "");
      } else if (res.dups.length) {
        body = "  └ （按「" + s.query + "」只搜到 " + res.dups.length + " 条，都是本批前面已给过的：#" + res.dups.slice(0, 5).join(" #") + "——没有新信息，可以换个别的话题搜，或按第 2b 条处理）";
      } else {
        body = "  └ （按「" + s.query + "」没检索到原文——可以换个说法再提一次，或按第 2b 条处理）";
      }
      parts.push("[" + row.id + "] " + row.text.slice(0, 80) + "\n" + body);
    }
    return {
      dupCount: dupTotal,
      text: "以下是按你给的关键词搜到的原文（#msg_id 才是证据）：\n\n" + parts.join("\n\n")
        + "\n\n看完就出最终结论 {\"actions\":[...]}。",
    };
  }

  function packMaterials(rows, evidence) {
    return rows.map(function (r) {
      const head = "[" + r.id + " · " + (r.kind || "?") + " · " + (r.subject || "?") + " · " + String(r.created_at || "?").slice(0, 10) + "] " + r.text;
      const ev = evidence[r.id];
      return head + (ev ? ("\n" + ev) : "\n  └ （没检索到原文）");
    }).join("\n\n");
  }

  // ---------------- LLM ----------------
  async function callLlm(system, msgs) {
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
          messages: [{ role: "system", content: system }].concat(Array.isArray(msgs) ? msgs : [{ role: "user", content: String(msgs) }]),
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

  // 模型输出有两种：{"search":[...]}（还要原文）／{"actions":[...]}（出结论）
  function parseResponse(rawText) {
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
    if (!obj || typeof obj !== "object") return { actions: [], search: [], error: "输出不是 JSON" };
    const search = [];
    if (Array.isArray(obj.search)) {
      for (const x of obj.search.slice(0, SEARCH_MAX_PER_ROUND)) {
        if (!x || typeof x !== "object") continue;
        const id = String(x.id || "").trim();
        const q = String(x.query || x.q || "").trim();
        if (id && q) search.push({ id: id, query: q.slice(0, 120) });
      }
    }
    if (search.length) return { actions: [], search: search, error: null };
    const pa = parseActions(s);
    return { actions: pa.actions, search: [], error: pa.error };
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
      // 1003：整批共享的「已给过原文」集合——预取的、各轮自提检索搜到的，都记在这里，
      // 同一条原文本批只回灌一次，避免模型换个词搜到同一堆东西、token 白烧
      const batchSeen = Object.create(null);
      const evidence = await fetchEvidence(rows, batchSeen);
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
        const msgs = [{ role: "user", content: p.user }];
        let lastText = "";
        let searchRounds = 0;
        // 最多 SEARCH_ROUNDS + 2 次模型调用：首轮判断 + 每轮检索后重问 + 最后一次兜底出结论
        for (let turn = 0; turn <= SEARCH_ROUNDS + 1; turn++) {
          const r = await callLlm(p.system, msgs);
          lastText = String(r.text || "");
          model = r.model;
          try { fs.writeFileSync(RAW_FILE, lastText); } catch (_) {}
          const pr = parseResponse(lastText);
          // 模型自己提检索请求：它比我们更清楚该搜什么，命中率远高于我们替它猜关键词
          if (pr.search.length && searchContext && searchRounds < SEARCH_ROUNDS) {
            searchRounds++;
            out.search_rounds = searchRounds;
            out.search_requests = (out.search_requests || 0) + pr.search.length;
            const found = await handleSearchRequests(pr.search, rows, batchSeen);
            out.search_dups = (out.search_dups || 0) + (found.dupCount || 0);
            msgs.push({ role: "assistant", content: lastText });
            msgs.push({ role: "user", content: found.text });
            continue;
          }
          parsed = { actions: pr.actions, error: pr.error };
          break;
        }
        out.parse_error = parsed.error;
        out.raw_chars = lastText.length;
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
