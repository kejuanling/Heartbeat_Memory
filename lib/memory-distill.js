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
const llmLog = require("./llm_log");
// 1004：选材从「日记」切到「当天全部对话原文」，按天读取的基建
const daySource = require("./day-source");

const DEFAULT_CONFIG = {
  enabled: false,
  time: "03:00",
  // 1004：语义从「每次几篇日记」改为「每次几天」；一天 = 一次 LLM 调用
  batch_size: 1,
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

// 1003 用户拍板：日记是 AI 第一人称自己写的，它落笔时心里有当时的场景，
// 我们按「日期 + 正文前 300 字」预取的原文未必对得上它那句「我记得那天……」。
// 所以给蒸馏也装上「模型自提检索」——与老数据重跑 memory-backfill 同款机制：
// 模型在 JSON 里写 {"search":[{"diary":1,"query":"..."}]}，系统代跑、把原文回灌，它再判断。
// （不是真 tools：蒸馏走 response_format:json_object，跟 function calling 在上游常互斥）
// 上限只防模型死循环（它可以每轮都提检索、永远不出结论），不防上游——与 backfill 保持一致
const SEARCH_ROUNDS = 4;            // 模型最多能提几轮补充检索
const SEARCH_MAX_PER_ROUND = 20;    // 每轮最多受理几条检索请求（多提的静默丢弃）
const SEARCH_LIMIT_PER_QUERY = 8;   // 每次检索返回条数上限

// 日记目录候选（按顺序探测）：写死单个路径，目录一改名就静默空跑
const DIARY_DIR_CANDIDATES = ["diary", "diary_legacy", path.join("workspace", "diary")];
function pickDiaryDir(base) {
  for (const c of DIARY_DIR_CANDIDATES) {
    const p = path.join(base, c);
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return path.join(base, DIARY_DIR_CANDIDATES[0]);
}

// 单次 LLM 调用超时（与 nginx 读超时 620s 对齐）
// 1004：600s 是按 glm-5.3-flash 的速度定的（12 分钟吃 1.5 万字）。
// 选材改成「一整天原文」后体量上到 2–6 万字，600s 必然撞墙；放宽到 1800s。
// （本请求是服务端直连上游 provider，不经本机 nginx，所以 nginx 的 620s/300s 与它无关）
const LLM_TIMEOUT_MS = 1800000;
// 单条原文截断阈值（超过就截断并提示模型提检索看全文）
const DAY_MAX_MSG_CHARS = 2000;
// 输出预算自动升级：与旧压缩系统（context-compactor.js）同款手法——
// 带推理的模型（MiniMax-M3 / glm 思考版）思考 token 也算进 max_tokens，
// 给少了会把正文/JSON 直接截断（finish_reason=length）。先给 16000，截断就加到 32000、50000。
const LLM_OUTPUT_BUDGETS = [16000, 32000, 50000];

// 用 http/https 模块发 JSON POST——绕开全局 fetch 底层 undici 的 300s headersTimeout。
// 那个超时不可配，长 prompt 场景会莫名其妙地 fetch failed（实跑踩过）。
function httpPostJson(url, bodyStr, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("非法 URL: " + url)); }
    const lib = u.protocol === "https:" ? require("https") : require("http");
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
  // 1003：日记目录被改名过（diary → diary_legacy），模块写死旧路径会静默空跑——
  // 104 篇日记躺了很久没被蒸馏。改成自动探测，找不到就大声报错，不再假装没事。
  const diaryDir = opts.diaryDir || pickDiaryDir(baseDir);
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
    // 1003-05 起日记搬进 data/diary.json（目录只剩改名后的 diary_legacy 旧件）。
    // 以新存储为准，否则蒸馏读的是旧件、新写的日记永远蒸馏不到。目录扫描仅作回退。
    const fromJson = listDiariesFromJson();
    if (fromJson) return fromJson;
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

  // 1003-05 起日记存在 data/diary.json（单 JSON）；正文直接带在 item.text 上，不用读文件。
  // absPath 那条路只给 legacy 目录回退用。
  function readDiaryText(d) {
    if (d && typeof d.text === "string") return String(d.text || "").trim();
    if (d && d.absPath) {
      try { return String(fs.readFileSync(d.absPath, "utf-8") || "").trim(); } catch (e) { return ""; }
    }
    return "";
  }

  // created_at 是 UTC ISO，直接切前 10 位会错一天（"2026-07-20T16:00Z" 北京时间已是 07-21）
  function localDayOf(iso) {
    const dt = new Date(String(iso || ""));
    if (isNaN(dt.getTime())) return "";
    try { return dt.toLocaleDateString("en-CA", { timeZone: TZ }); }
    catch (e) { return String(iso).slice(0, 10); }
  }

  // 新存储（data/diary.json）：id 升序、跳过用户主动隐藏的篇（隐藏 = 不注入 Earlier Days，也不该被蒸馏）
  function listDiariesFromJson() {
    try {
      // ★ listEntries 必须传 baseDir（不传的话 path.join(undefined,...) 抛错，
      //   被 loadStore 的 catch 吞成空库——表现为"明明有 104 篇却读到 0 篇"）
      const jsonPath = path.join(baseDir, "data", "diary.json");
      if (!fs.existsSync(jsonPath)) return null;   // 没有新存储 → 回退目录扫描
      const ds = require(path.join(baseDir, "lib", "diary-store.js"));
      if (!ds || typeof ds.listEntries !== "function") return null;
      const entries = ds.listEntries(baseDir) || [];
      const out = [];
      for (const e of entries) {
        if (e && e.hidden) continue;
        const content = String((e && e.content) || "");
        if (!content.trim()) continue;
        const id = String((e && e.id) || "");
        out.push({
          relPath: "d" + id,
          absPath: null,
          session: (e && e.session) || "_root",
          date: localDayOf((e && e.created_at) || ""),
          chars: content.length,
          sortKey: String(id).padStart(10, "0"),
          text: content,
        });
      }
      out.sort(function (a, b) { return a.sortKey < b.sortKey ? -1 : (a.sortKey > b.sortKey ? 1 : 0); });
      return out;
    } catch (e) {
      logWarn("读 data/diary.json 失败，回退目录扫描：" + (e && e.message || e));
      return null;
    }
  }

  /**
   * 选一批：已蒸馏（state.done）的跳过，按时间升序取 batch_size 篇。
   * dryRun=true 时不写盘，只算不记（测试/预览用）。
   */
  // 1004：选材从「按日记篇取 N 篇」改为「按天取 N 天」——一天一次调用，
  // 主料是当天全部对话原文，日记退为线索（旧 planBatch 已无调用方，随之删除）
  function planDay(batchSize, dryRun) {
    const st = readState();
    const all = daySource.listDays(baseDir);
    const today = todayKey();
    // ★ 跳过当天：03:00 定时跑的时候「今天」还没过完，跑了只会拿到半天
    const pending = all.filter(function (d) { return !st.done[d] && d < today; });
    const n = Math.max(1, Math.floor(Number(batchSize) || 1));
    // ★ 跳过空天：会话索引是按「首次/最后活跃」区间展开的，中间会有空洞日
    //   （实测 92 天里 9 天一条消息都没有）。不跳过的话，一次跑批会白白消耗一个空天。
    const pickedDays = [];
    const emptyDays = [];
    for (let i = 0; i < pending.length && pickedDays.length < n; i++) {
      const probe = daySource.readDay(baseDir, pending[i], {});
      if (!probe.msgs.length) { emptyDays.push(pending[i]); continue; }
      pickedDays.push(pending[i]);
    }
    const picked = pickedDays.map(function (d) {
      return { relPath: d, session: null, date: d, chars: 0 };
    });
    const plan = {
      picked: picked,
      pickedCount: picked.length,
      total: all.length,
      doneCount: all.length - pending.length,
      pending: pending.length,
      remaining: pending.length - picked.length,
      chars: 0,
      batchIndex: st.batches + (picked.length ? 1 : 0),
      batchesTotal: Math.ceil(pending.length / Math.max(1, n)),
      // 检索回灌要按「日记当天」定位，所以 items 保留带 date 的对象形态
      items: pickedDays.map(function (d) { return { date: d, relPath: d, session: null }; }),
      days: pickedDays.slice(),      // 日期字符串数组，供打包用
      emptyDays: emptyDays.slice(),  // 顺手跳过的空天
    };
    if (!dryRun && (picked.length || emptyDays.length)) {
      const doneNext = Object.assign({}, st.done);
      const at = new Date().toISOString();
      // 空天也标 done——它们确实没有可蒸馏的内容，别每次重扫
      emptyDays.forEach(function (d) { doneNext[d] = at; });
      pickedDays.forEach(function (d) { doneNext[d] = at; });
      writeState(Object.assign({}, st, {
        done: doneNext,
        lastBatch: pickedDays.length ? pickedDays.slice() : (st.lastBatch || []),
        lastBatchAt: pickedDays.length ? at : (st.lastBatchAt || null),
        batches: pickedDays.length ? st.batches + 1 : st.batches,
      }));
    }
    return plan;
  }

  // ★ 失败回滚：选材在调 LLM「之前」就把当天标了 done，一旦调用失败/进程被杀，
  //   这天就被白白消耗且毫无产出——所以要能撤回来
  function rollbackDays(days) {
    if (!days || !days.length) return;
    try {
      const st = readState();
      const done = Object.assign({}, st.done || {});
      let n = 0;
      days.forEach(function (d) { if (done[d]) { delete done[d]; n++; } });
      delete done.__pendingCommit;
      if (n) {
        writeState(Object.assign({}, st, { done: done, batches: Math.max(0, (st.batches || 1) - 1) }));
        logWarn("蒸馏失败，已回滚本次选材的 " + n + " 天（" + days.join(",") + "），下次重跑");
      }
    } catch (e) {
      logErr("回滚选材失败：" + (e && e.message || e));
    }
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
  // 1004：整批 = 当天日记（线索，非证据） + 当天全部对话原文（主料 = 证据源）
  async function packDay(days) {
    const blocks = [];
    const evidenceIndex = Object.create(null);
    let evTotal = 0, evChars = 0, truncated = 0, dayDiaries = 0;
    const diaries = listDiaries() || [];
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const dr = daySource.readDay(baseDir, day, { maxMsgChars: DAY_MAX_MSG_CHARS });
      // ★ 取证索引存「未截断」的正文：截断只影响喂给模型的材料，不该影响取证比对
      dr.msgs.forEach(function (m) {
        if (m && m.id) evidenceIndex[m.id] = { msg_id: m.id, content: m.content, time: m.time, role: m.role, session: m.session };
      });
      evTotal += dr.msgs.length;
      evChars += dr.chars;
      truncated += dr.stats.truncated;
      const dayD = diaries.filter(function (d) { return d.date === day; });
      dayDiaries += dayD.length;
      const diaryBlock = dayD.length
        ? dayD.map(function (d) { return readDiaryText(d); }).join("\n\n")
        : "（当天没有日记）";
      blocks.push(
        "=== " + day + " · 日记 " + dayD.length + " 篇（仅供线索，不是证据） ===\n" + diaryBlock +
        "\n\n=== " + day + " · 当天对话原文 " + dr.msgs.length + " 条（证据源，#msg_id 用于取证引用） ===\n" +
        (dr.lines.join("\n") || "（当天没有对话原文）")
      );
    }
    return {
      text: blocks.join("\n\n"),
      evidenceTotal: evTotal,
      evidenceChars: evChars,
      truncated: truncated,
      evidenceIndex: evidenceIndex,
      dayDiaries: dayDiaries,
    };
  }

  // ---------------- 3.4：LLM 抽取候选 ----------------
  const KINDS = ["fact", "rule", "event"];
  // 1007：subject 字段删除

  // 内置默认提示词（管理台提示词页可覆盖；留空即回落到这里）
  function defaultSystemPrompt() {
    return [
      "你是长期记忆抽取器。输入是「某一天的对话原文」加「当天的日记」。",
      "★ 证据只有对话原文：每条原文带 #msg_id，evidence 必须引用材料里真实出现的 id。",
      "★ 日记只是帮你定位重点的线索（AI 加工过一次，可能带写作偏差甚至幻觉），不是证据——日记里写了但原文对不上的东西一律不要抽。",
      "任务：从中提取值得长期记住的原子记忆候选。宁缺毋滥。",
      "",
      '只输出 JSON：{"candidates":[{"text":"...","kind":"fact|rule|event","evidence":["msg_id"],"confidence":"high|mid|low","note":"..."}]}（仅 event 可额外输出 triggers、vibe）',
      "",
      "字段规则：",
      "- text：一条独立、简洁、可执行或可验证的记忆。不复述上下文，不加材料里没有出现的因果关系。能短则短。",
      "- kind：fact = 稳定事实（她的偏好 / 经历 / 我们之间的事实）；rule = 规则、边界、承诺、交互约定（“以后不要……”“记住……”这类优先判 rule）；event = 具体发生过的一件事或做出来的东西（“她做了一个网页，域名是 xx”“上个月我们一起……”），之后聊天可能还会引用——具体的事归 event，稳定特质归 fact，别混。",
      "- evidence：支撑这条记忆的原文 msg_id（从材料里的 #xxx 取），必须是材料里真实出现的 id；找不到证据就别提这条。",
      "- confidence：high = 原文明确说过；mid = 原文有暗示但需推断；low = 只有日记提到、原文没对上。",
      "- note：可选，补充或存疑说明。\n- triggers：这是给 event 记忆设计的“召回入口”，不是主题摘要。先想这条具体记忆未来会在什么对话里派上用场，再反推她届时可能说出的词或口语表达。通常 1-6 个，短记忆少而准；只保留能指向这条具体记忆、且有助于词面命中的表达。\n  · 优先考虑真实聊天里自然出现的说法：事件/人/地点/作品的具体名称、简称、独特词、她可能会怎样问起或描述这件事；允许用与正文不同但有依据的口语说法。\n  · 不要只写“关系、情绪、偏好、生活”等主题分类；不要为凑数量堆泛词、近义词或长句；不要编造她没说过的昵称、事件细节或表达。每个 trigger 都要能回答：“她说出什么话时，我确实应该找回这条记忆？”\n  · 如果某个词出现在很多无关对话里也会命中，就太宽泛，尽量换成更有区分度的说法。没有可靠触发词时宁可少写。只有 event 需要输出 triggers（关键词召回入口）；fact/rule 不输出 triggers 字段。triggers 只供相关记忆注入使用，不供 memory_search 工具使用。\n- vibe：仅 event 可选的语义情景描述，作用于相关记忆注入的语义分。fact/rule 不输出 vibe 字段。描述适用场景、对话意图、关系状态、感官体验或情绪背景，重点是“什么情景下会用到这条记忆”，不是复述正文。\n  · 不要把 triggers 换成同义词列表，也不要只堆“温暖、难过、紧张”等孤立形容词。只有情景确实能补充语义信息时才写；不确定就留空。\n- 输出前只对 event 检查：triggers 是否能帮助真实聊天命中这条具体事件；vibe 是否补充了适用情景。fact/rule 直接省略这两个字段。",
      "",
      "不要提取：当天情绪（一闪而过的聊天情绪不是记忆）、一次性琐事（吃了什么、寒暄、流水账）、已过期信息、由单次行为推导出的性格标签、心理分析、模型自我叙事，以及日记里我自己的抒情。\n★ event 边界：只抽“之后可能还会被聊到、被引用”的具体事（做出来的东西、说定的重要话、经历的关键事件）；纯粹过去了就完的一次性流水账仍不抽。",
      "★ 约定与准则（rule）最容易被时间淘汰：抽之前先问一句「这条现在还成立吗」。属于某个已经过去的情境或阶段（“那时候”“之前”“以前”“那阵子”）、或后来被改掉、被别的方式替代、往后不再提起的，一律当它已过期，不要抽——过时的旧规矩进池就是垃圾，还会顶掉真正有效的新约定。",
      "★ 亲昵细节（亲密互动、身体接触一类）只发生过一次的，按一次性事件处理，不抽（除非是值得记住的 event，比如第一次见面这种里程碑）；只有形成了稳定习惯、或明确说好了的约定才抽。",
    ].join("\n");
  }

  function defaultUserPrompt() {
    return [
      "以下是 ${DIARY_COUNT} 天的材料：每天先给当天日记（仅作线索），再给当天全部对话原文（每条带 #msg_id，这是唯一的证据源）。",
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
    // 1003：检索说明硬编码追加——不依赖模板，管理台改了 distill_user_prompt 也照样生效
    const searchNote = [
      "",
      "【补充检索】材料里已经给了当天全部原文，检索只用在两种情况下：",
      "① 某条原文被截断（末尾标了「过长已截断」），你想看它的完整内容；② 你想确认的这件事发生在当天之外。",
      "遇到这几种情况，先别勉强输出，提检索请求：",
      "① 日记里提到的事在当天原文里找不到；② 你想抽一条记忆却找不到能引用的 #msg_id；",
      "③ 你想看看当时到底怎么说的（尤其被截断的那条）。",
      '格式：{"search":[{"diary":1,"query":"你认为能搜到原文的关键词，或她当时的原话片段"}]}',
      "（diary 填材料里第几天的序号，从 1 开始，不填就默认第 1 天；query 一次问一件事，别塞一整句长句）",
      "系统按你给的 query 去搜（先搜日记当天，捞不到再全库搜），把原文回给你，你再判断。",
      "最多提 " + SEARCH_ROUNDS + " 轮，之后必须出最终 {\"candidates\":[...]}。",
      "★ 同一条原文本批只会给你一次：换个词又搜到同样的东西时，系统只回一句「本批前面已给过 #xxx」，不再重复。看到这句就说明没新信息了，别再用同义词反复搜。",
      "★ 回给你的原文同样只有带 #msg_id 的才能写进 evidence。",
    ].join("\n");
    const user = tpl.replace(/\$\{DIARY_COUNT\}/g, String(diaryCount || 0)) + "\n\n" + head + searchNote + "\n\n=== 材料 ===\n" + packText;
    return { system: system, user: user };
  }

  // 调 role=distill 的模型取 JSON（1003-11 拆分：日记蒸馏独立配置）
  // 1003：改传消息数组，支持「模型提检索 → 回灌原文 → 再问」多轮（单次调用时传一条 user 即可）
  async function callLlm(system, msgs) {
    const { resolveRoleModel } = require("../model-router");
    const { provider, model } = resolveRoleModel("distill");
    const apiUrl = provider && (provider.api_url || provider.base_url);
    const apiKey = provider && provider.api_key;
    if (!apiUrl || !apiKey || !model) throw new Error("模型未配置（role=distill）：请先在管理台给「日记蒸馏」选一个模型");
    // 1003：不用全局 fetch——它底层的 undici 有 300s 的 headersTimeout，
    // 上游处理 2 万字 prompt 常常超过 300s 才吐第一个字节，结果不是我们 abort，
    // 是 undici 先抛 UND_ERR_HEADERS_TIMEOUT（实跑踩到过，表现为莫名的 fetch failed）。
    // 改用 http/https 模块直接发，超时自己控；600s 与 nginx 读超时 620s 对齐。
    let lastErr = null;
    for (let attempt = 0; attempt < LLM_OUTPUT_BUDGETS.length; attempt++) {
      const budget = LLM_OUTPUT_BUDGETS[attempt];
      const payload = JSON.stringify({
        model: model,
        messages: [{ role: "system", content: system }].concat(Array.isArray(msgs) ? msgs : [{ role: "user", content: String(msgs || "") }]),
        
        max_tokens: budget,
        response_format: { type: "json_object" },
      });
      let data;
      try {
        const res = await llmLog.post("memory_distill", httpPostJson, apiUrl, payload, {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        }, LLM_TIMEOUT_MS);
        if (res.status < 200 || res.status >= 300) {
          throw new Error("LLM HTTP " + res.status + " " + String(res.text || "").slice(0, 200));
        }
        data = JSON.parse(res.text);
      } catch (e) {
        if (!(e instanceof Error)) throw new Error(String(e));
        throw e;                       // 网络/HTTP 错误不重试预算，交给上层
      }
      const choice = data && data.choices && data.choices[0];
      const content = choice && choice.message && choice.message.content;
      const finish = choice && String(choice.finish_reason || "");
      const body = content == null ? "" : String(content);
      // 判「没吐完整」三种：空响应 / 上游明确说被截断 / 剥掉思考块后取不出完整 JSON 对象
      const noJson = !firstJsonObject(stripFences(body));
      const incomplete = !body || finish === "length" || noJson;
      if (incomplete && attempt < LLM_OUTPUT_BUDGETS.length - 1) {
        const why = !body ? "空响应" : (finish === "length" ? "finish_reason=length（输出被截断）" : "取不到完整 JSON 对象");
        logWarn("模型输出不完整（" + why + "），把 max_tokens 从 " + budget + " 加到 " + LLM_OUTPUT_BUDGETS[attempt + 1] + " 重试");
        lastErr = new Error("模型输出不完整：" + why);
        continue;
      }
      if (!body) throw new Error("LLM 空响应（已试到最大输出预算 " + budget + "）");
      return {
        text: body,
        model: model,
        finishReason: finish || null,
        attempts: attempt + 1,
        outputTokens: budget,
      };
    }
    throw lastErr || new Error("LLM 调用失败");
  }

  function normalizeCandidate(c) {
    if (!c || typeof c !== "object") return null;
    const text = String(c.text || c.content || "").trim();
    if (!text) return null;
    let kind = String(c.kind || "").trim();
    if (KINDS.indexOf(kind) < 0) kind = /以后|不要|记住|规则|约定|别再|必须/.test(text) ? "rule" : "fact";
    let confidence = String(c.confidence || "").trim();
    if (["high", "mid", "low"].indexOf(confidence) < 0) confidence = "mid";
    const ev = Array.isArray(c.evidence) ? c.evidence : (Array.isArray(c.msg_ids) ? c.msg_ids : []);
    // 1005-17：triggers（1-6 关键词）/ vibe（可选感受）由蒸馏 LLM 产出，随候选透传入库
    let triggers = [];
    if (Array.isArray(c.triggers)) {
      triggers = c.triggers.map(function (x) { return String(x || "").trim(); }).filter(Boolean);
      triggers = [...new Set(triggers)].slice(0, 6);
    }
    const candidate = {
      text: text,
      kind: kind,
      evidence: ev.map(function (x) { return String(x || "").trim(); }).filter(Boolean),
      confidence: confidence,
      note: String(c.note || "").trim(),
    };
    if (kind === "event") {
      candidate.triggers = triggers;
      candidate.vibe = String(c.vibe || "").trim() || null;
    }
    return candidate;
  }

  // 1004：模型（尤其换模型时）常在 JSON 外面裹东西——```json 围栏、前后说明文字、
  // 甚至一口气吐两个对象。原来用 /\{[\s\S]*\}/ 贪婪匹配会把它俩一起框进去，
  // 结果 "Unexpected non-whitespace character after JSON"。改成按括号配对取第一个完整对象。
  function stripFences(s) {
    let t = String(s == null ? "" : s).trim();
    // ★ 必须先剥思考块：带推理的模型（MiniMax-M3 实测就是）会把 <think>…</think> 一起吐出来，
    //   里面常抄一份 JSON 模板占位（"text":"..." 之类），不剥就会被当成第一个 JSON 对象，
    //   结果只拿到一条假候选（1004 实测：剥之前 1 条、剥之后 6 条真候选）
    t = t.replace(/<(think|reasoning|thinking)>[\s\S]*?<\/\1>/gi, "").trim();
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    return t.trim();
  }

  function firstJsonObject(s) {
    const start = s.indexOf("{");
    if (start < 0) return "";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return "";
  }

  function parseCandidates(raw) {
    let s = stripFences(raw);
    let obj = null;
    try { obj = JSON.parse(s); }
    catch (e) {
      const frag = firstJsonObject(s);
      if (!frag) return { candidates: [], error: "JSON 解析失败（" + (e && e.message) + "）" };
      try { obj = JSON.parse(frag); }
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

  // ---------------- 1003：模型自提检索 ----------------
  // 判断模型这一轮是「要检索」还是「出结论」。两种都允许同时出现，但只有 search 会触发回灌。
  function parseResponse(raw) {
    let s = stripFences(raw);
    let obj = null;
    try { obj = JSON.parse(s); }
    catch (e) {
      const frag = firstJsonObject(s);
      if (frag) { try { obj = JSON.parse(frag); } catch (e2) { obj = null; } }
    }
    if (!obj || typeof obj !== "object") return { search: [], done: false, error: "JSON 解析失败" };
    const rawSearch = Array.isArray(obj.search) ? obj.search : [];
    const search = [];
    // 单轮受理上限：多提的静默丢弃（不报错，避免模型卡在"为什么没回我"）
    for (const x of rawSearch.slice(0, SEARCH_MAX_PER_ROUND)) {
      if (!x || typeof x !== "object") continue;
      const q = String(x.query || x.q || "").trim();
      if (!q) continue;
      const n = Number(x.diary || x.d || 0);
      search.push({ diary: (n > 0 && n === Math.floor(n)) ? n : 0, query: q.slice(0, 200) });
    }
    const done = Array.isArray(obj.candidates) || Array.isArray(obj.memories);
    return { search: search, done: done, error: null };
  }

  // 按模型给的 query 替它搜原文：先搜日记当天，捞不到再全库语义搜一次
  async function searchForDiary(d, query, limit, seenBatch) {
    const none = { lines: [], recs: [], tried: [], dups: [] };
    if (!searchContext) return none;
    const byId = Object.create(null);
    const dups = [];
    const push = function (m) {
      if (!m) return;
      const id = String(m.msg_id || "");
      const content = String(m.content || "").trim();
      if (!content) return;
      // 同预取：记忆/注入产物不是原文，喂进去会造成虚假取证
      if (EVIDENCE_SKIP_PATTERNS.some(function (re) { return re.test(content); })) return;
      if (id && byId[id]) return;
      // 1003：整批已给过 → 不重复回灌
      if (id && seenBatch && seenBatch[id]) { dups.push(id); return; }
      byId[id || ("_noid_" + Object.keys(byId).length)] = {
        msg_id: id,
        session: m.session || null,
        time: m.time || null,
        role: m.role || null,
        content: content,
        src: "llm_search",
      };
    };
    const tried = [];
    // ① 当天定位（日记记的多半就是当天的事）
    if (d && d.date) {
      try {
        const r = await searchContext(query, { timePrefix: d.date, allSessions: true, limit: limit });
        if (r && r.ok && Array.isArray(r.matches)) r.matches.forEach(push);
        tried.push("当天 " + d.date);
      } catch (e) { logWarn("自提检索（当天）异常：" + (e && e.message || e)); }
    }
    // ② 当天没捞到 → 全库再搜（日记可能在回忆几天前的事）
    if (Object.keys(byId).length === 0) {
      try {
        const r = await searchContext(query, { mode: "semantic", allSessions: true, limit: limit });
        if (r && r.ok && Array.isArray(r.matches)) r.matches.forEach(push);
        tried.push("全库");
      } catch (e) { logWarn("自提检索（全库）异常：" + (e && e.message || e)); }
    }
    const recs = Object.keys(byId).map(function (k) { return byId[k]; });
    recs.forEach(function (m) { if (m && m.msg_id && seenBatch) seenBatch[m.msg_id] = true; });
    const packed = packEvidence(recs.slice(0, limit));
    return { lines: packed.text ? packed.text.split("\n") : [], recs: recs, tried: tried, dups: dups };
  }

  // 执行模型提的一批检索请求，把原文拼成一段回灌给它
  // 1003：整批共享 seenBatch——同一条原文只回灌一次，重复的只提示「本批前面已给过」
  async function handleSearchRequests(reqs, items, evidenceIndex, seenBatch) {
    const parts = [];
    let got = 0, dupTotal = 0;
    for (const s of reqs) {
      const idx = s.diary > 0 ? s.diary - 1 : 0;
      const d = (idx >= 0 && idx < items.length) ? items[idx] : items[0];
      const label = "日记 " + ((idx >= 0 && idx < items.length) ? s.diary : 1) + (d && d.date ? "（" + d.date + "）" : "");
      const r = await searchForDiary(d, s.query, SEARCH_LIMIT_PER_QUERY, seenBatch);
      // ★ 回灌的原文必须进证据索引，否则 3.5 取证认不出模型引用的这些 msg_id，白搜
      r.recs.forEach(function (m) { if (m && m.msg_id) evidenceIndex[m.msg_id] = m; });
      got += r.lines.length;
      dupTotal += r.dups.length;
      let body;
      if (r.lines.length) {
        body = r.lines.join("\n")
          + (r.dups.length ? "\n  └ （另有 " + r.dups.length + " 条本批前面已给过，不重复：#" + r.dups.slice(0, 5).join(" #") + "）" : "");
      } else if (r.dups.length) {
        body = "  └ （按「" + s.query + "」只搜到 " + r.dups.length + " 条，都是本批前面已给过的：#" + r.dups.slice(0, 5).join(" #") + "——没有新信息，换个话题搜，或按「找不到证据就别提这条」处理）";
      } else {
        body = "  └ 没搜到（已试：" + (r.tried.join(" / ") || "无") + "）——换个说法再提一次，或按「找不到证据就别提这条」处理";
      }
      parts.push("[" + label + " · 按「" + s.query + "」搜到 " + r.lines.length + " 条]\n" + body);
    }
    return {
      got: got,
      dupCount: dupTotal,
      text: "以下是按你给的关键词搜到的原文（#msg_id 才是证据，可直接写进 evidence）：\n\n" + parts.join("\n\n")
        + "\n\n看完就出最终结论 {\"candidates\":[...]}。",
    };
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
          // 1007：subject 已删
          quote: c.quote || "",
          msg_time: c.msg_time || null,
          triggers: c.triggers,
          vibe: c.vibe || null,
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
    const lines = cands.map(function (c) { return "- [" + c.kind + "] " + c.text; });
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
    const logEntry = noteLog("distill", label, "pending", "开始跑：每次 " + cfg.batch_size + " 天（主料 = 当天全部对话原文）");
    const t0 = Date.now();
    let planRef = null;   // 失败时要按它回滚选材
    try {
      const plan = planDay(cfg.batch_size, dryRun);
      planRef = plan;
      // 1004：空跑要喊清楚——不是「没有日记」，而是「没有待处理的日期」
      if (!plan.total) logWarn("时间线里一天对话都没有——本次空跑，请检查 enhanced_messages_*.json");
      else if (!plan.pickedCount) logInfo("没有待处理的日期（历史 " + plan.total + " 天已标基线，或只剩今天未过完的那天）");
      let pack = { text: "", evidenceTotal: 0, evidenceChars: 0, truncated: 0, evidenceIndex: {}, dayDiaries: 0 };
      if (plan.days && plan.days.length) {
        pack = await packDay(plan.days);
        try { fs.writeFileSync(PACK_PATH, pack.text, "utf-8"); } catch (e) { logWarn("打包文本落盘失败：" + (e && e.message || e)); }
      }
      // 3.4：LLM 抽取候选（含 kind 判定 + 证据 msg_id）
      let extract = { candidates: [], error: null, promptChars: 0, raw: null, searchRounds: 0, searchRequests: 0, model: null };
      if (pack.text) {
        const st0 = readState();
        const pr = buildDistillPrompt(pack.text, st0.lastSummary, plan.pickedCount);
        extract.promptChars = pr.system.length + pr.user.length;
        try {
          // 1003：多轮——首轮判断，模型可提检索，我们代跑回灌，最多 SEARCH_ROUNDS 轮后必须出结论
          const msgs = [{ role: "user", content: pr.user }];
          // 1003：整批共享「已给过」集合，预取的原文也算已给过——否则模型换个词又搜回同一堆，token 白烧
          const batchSeen = Object.create(null);
          Object.keys(pack.evidenceIndex || {}).forEach(function (k) { batchSeen[k] = true; });
          let raw = "", searchRounds = 0, searchRequests = 0, parsed = null;
          for (let turn = 0; turn <= SEARCH_ROUNDS + 1; turn++) {
            const r = await callLlm(pr.system, msgs);
            raw = String(r.text || "");
            if (r.model) extract.model = r.model;
            // 排障用：输出预算是否被加到第二/三档、上游有没有报截断
            extract.finishReason = r.finishReason || null;
            extract.outputTokens = r.outputTokens || null;
            extract.llmAttempts = r.attempts || 1;
            const pr2 = parseResponse(raw);
            if (pr2.search.length && searchContext && searchRounds < SEARCH_ROUNDS) {
              searchRounds++;
              searchRequests += pr2.search.length;
              // 实时记账：否则中途抛异常时，跑了几轮/几条就全丢了（首次实跑就是这么丢的）
              extract.searchRounds = searchRounds;
              extract.searchRequests = searchRequests;
              const found = await handleSearchRequests(pr2.search, plan.items, pack.evidenceIndex, batchSeen);
              extract.searchDups = (extract.searchDups || 0) + (found.dupCount || 0);
              logInfo("模型自提检索 第 " + searchRounds + " 轮：" + pr2.search.length + " 条请求，回灌 " + found.got + " 条原文，去重 " + (found.dupCount || 0) + " 条");
              msgs.push({ role: "assistant", content: raw });
              msgs.push({ role: "user", content: found.text });
              continue;
            }
            parsed = parseCandidates(raw);
            break;
          }
          extract.raw = raw.slice(0, 2000);
          // 1004：整份原始返回落盘——解析失败时没 raw 就只能干瞪眼（上次换模型踩过）
          try { fs.writeFileSync(path.join(baseDir, "data", "memory_distill_last_raw.txt"), String(raw || ""), "utf-8"); } catch (e) {}
          extract.searchRounds = searchRounds;
          extract.searchRequests = searchRequests;
          const p = parsed || parseCandidates(raw);
          extract.candidates = p.candidates || [];
          extract.error = p.error || null;
        } catch (e) {
          // 带上 name/cause，否则只见 "fetch failed" 根本分不清是超时、断连还是上游拒了
          const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
          extract.error = String((e && e.message) || e) + (e && e.name ? " [" + e.name + "]" : "") + (cause ? " (" + cause + ")" : "");
          extract.model = extract.model || null;
        }
      }
      // ★ LLM 这一步失败＝这天没产出，把选材撤回来，别让它白消耗
      if (extract.error) rollbackDays(plan.days);
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
        pickedChars: pack.evidenceChars,
        total: plan.total,
        doneCount: plan.doneCount,
        remaining: plan.remaining,
        batchIndex: plan.batchIndex,
        batchesTotal: plan.batchesTotal,
        evidence: pack.evidenceTotal,
        evidenceChars: pack.evidenceChars,
        evidenceTruncated: pack.truncated,
        packChars: pack.text.length,
        searchRounds: extract.searchRounds,
        searchRequests: extract.searchRequests,
        searchDups: extract.searchDups || 0,
        model: extract.model,
        promptChars: extract.promptChars,
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
        files: plan.days ? plan.days.slice() : [],
        days: plan.days ? plan.days.slice() : [],
        dayDiaries: pack.dayDiaries,
        note: plan.pickedCount
          ? ("本批 " + plan.pickedCount + " 天（" + (plan.days || []).join(",") + "），原文 " + pack.evidenceTotal + " 条 / " + pack.evidenceChars + " 字"
             + "，日记 " + pack.dayDiaries + " 篇作线索，LLM 抽出候选 " + extract.candidates.length + " 条"
             + (extract.error ? ("（解析失败：" + extract.error + "）") : "")
             + "，取证确认 " + confirmed + " / 弱确认 " + weak + " / 未确认 " + (verified.length - confirmed - weak)
             + "，" + (ro.noQueue ? "（noQueue：未落库）" : ("进待审 " + qres.queued + " 条，门卫拒 " + qres.rejected + " 条")))
          : "没有待处理的日期（历史 " + plan.total + " 天已标基线，或只剩今天未过完的那天）",
      };
      saveConfig({ last_run_at: result.finishedAt, last_run_result: result });
      state.runs += 1;
      if (logEntry && logEntry.id) noteLog("distill", label, "success", "完成：" + result.note);
      logInfo("跑完一次（" + state.lastTrigger + "）：" + result.note);
      return result;
    } catch (err) {
      // 走到这里＝整次跑批崩了（含进程被 pm2 内存重启杀掉前的那次），同样要回滚选材
      try { if (planRef) rollbackDays(planRef.days); } catch (e) {}
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
    const all = daySource.listDays(baseDir);
    logInfo("调度已启动：enabled=" + cfg.enabled + " time=" + cfg.time + " batch=" + cfg.batch_size +
      "（时区 " + TZ + "，本地现在 " + nowLocal() + "）可选天数 " + all.length +
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
    // 1004-11：选材已按天（planDay 写 st.done 用天 key），进度统计必须同口径——
    // 旧 listDiaries 按日记 relPath 查 done 永远查不到，管理台进度显示失真。
    const all = daySource.listDays(baseDir);
    const pending = all.filter(function (d) { return !st.done[d]; });
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
    // 1004：选材改为按天（旧 planBatch/packBatch 已删除）
    planDay: planDay,
    packDay: packDay,
    listDays: function () { return daySource.listDays(baseDir); },
    buildDistillPrompt: buildDistillPrompt,
    // 1003 自提检索（导出供排障/单测）
    parseResponse: parseResponse,
    searchForDiary: searchForDiary,
    handleSearchRequests: handleSearchRequests,
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
