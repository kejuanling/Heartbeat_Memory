'use strict';
// lib/conversation-state.js（2026-10-03 新增）
// 会话状态机：把「上下文压缩」从「多块并列的流水摘要」改成「每个会话一份持续演化的状态」。
//
// 为什么要有这个模块
//   旧模型：长对话 → 切块 → 每块各写一段摘要 → 十几条摘要并列注入。
//   实测 154 条记录、最密的会话 39 块，每块只知道自己的那 150 条原文，
//   看不见前面几块写过什么 → 同一个人的同一件事被反复叙述 → 上下文里堆着一坨
//   「很完整、但明显还是记忆列表」的东西。
//   新模型：每个会话只有一份状态。v_{n} = f(v_{n-1}, 新增原文)。
//   第 n 次并入时，模型手里有完整的前一版，所以「删掉已经失效的旧状态」才真正可能发生。
//
// 数据
//   data/conversation_state.json          { <sessionId>: {version, record_id, text, ops, cover, updated_at, seed_from_legacy} }
//   data/conversation_state_versions.json { <sessionId>: [{version, text, ops, cover, at, source}] }  只留最近 KEEP_VERSIONS 版
//   data/conversation_state_prompt.json   { system, user_template }（管理台可覆盖，留空回落内置默认）
//
// 上下文注入：本模块不注入。状态正文作为一条「覆盖区间记录」写进 data/context_replacements.json，
//   由既有的 buildIncrementalContext / applyReplacements 原样处理——聊天主链路一行不改。
//   那条记录的 matched 只存首尾两条锚点消息：注入定位只用到首尾
//   （context-replacements.js:1732-1746 取 aStart/aEnd 之后只拿它们的 id 做定位），
//   所以记录大小与覆盖多长无关。
//
// 生命周期
//   previewMerge  调 LLM 出候选状态 + 操作清单，**不落盘**（前端拿去做 diff）
//   commitMerge   人工确认后落盘 v_{n+1}（被拦截的 remove 不生效）
//   rollback      回到历史某一版
//   undoLastMerge 撤掉最后一次并入，覆盖区间退回，原文回到「还没并入」区

const fs = require("fs-extra");
const path = require("path");
const contextReplacements = require("../context-replacements");
const { httpPostJson } = require("./http_json");

// ── 悬浮球日志（server.js 启动时注入 addCompactionLog；本模块不反向 require server.js）──
// 入参/返回与 server.js 的 addCompactionLog 一致：entry 带 id = 更新原条目（pending→success/error）
let _logFn = null;
function setLogFn(fn) { _logFn = typeof fn === "function" ? fn : null; }
function logEntry(entry) {
  try { return _logFn ? _logFn(entry) : null; } catch (e) { return null; }
}

const ROOT = path.join(__dirname, "..");
// 数据目录：默认项目 data/；测试设 CONVERSATION_STATE_DIR 指向临时目录——
// 1003-30 教训：测试清理两次误删生产状态（rm -f data/conversation_state.json），
// 测试必须与生产数据物理隔离，这个 env 就是隔离墙。
const DATA_DIR = process.env.CONVERSATION_STATE_DIR
  ? path.resolve(process.env.CONVERSATION_STATE_DIR)
  : path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "conversation_state.json");
const VERSIONS_FILE = path.join(DATA_DIR, "conversation_state_versions.json");
const PROMPT_FILE = path.join(DATA_DIR, "conversation_state_prompt.json");

const KEEP_VERSIONS = 5;          // 版本链保留几版（够回滚）
const SEARCH_ROUNDS = 4;          // 模型最多能提几轮补充检索
const SEARCH_MAX_PER_ROUND = 10;  // 每轮最多受理几条检索请求（多提的静默丢弃）
const SEARCH_LIMIT_PER_QUERY = 8; // 单条检索返回条数上限
const SEARCH_MAX_CHARS = 5000;    // 单轮回灌原文总字数上限
const LLM_TIMEOUT_MS = 600000;    // 与 nginx 读超时 620s 对齐
const MAX_STATE_CHARS = 60000;    // 状态正文硬上限（超出拒绝落盘；提示目标 2000~5000）
const MODEL_ROLE = "compaction";  // 与旧压缩同源，管理台换模型两处一起生效

// 内置默认提示词。data/conversation_state_prompt.json 非空时覆盖它；
// 管理台「恢复默认」是删文件回落这里，所以改文案两处都要改。
const DEFAULT_SYSTEM = [
  "你是一个会话状态机。你的任务不是总结对话，而是维护一份「当前状态」——截至此刻，这段对话已经变成什么样子。",
  "",
  "输入有三部分：",
  "1. 上一版状态（可能为空，这是第一次并入）",
  "2. 本次新增的对话原文",
  "3. 你请求检索时系统回灌的原文",
  "",
  "状态是什么：",
  "是一份交接单。读它的人（未来的你）不需要回看任何原文，就能立刻接上：现在在做什么、做到哪一步、定了什么、否掉了什么、还有什么悬着、我们之间现在是什么状态。",
  "",
  "状态不是什么：",
  "- 不是「这段时间发生了什么」。禁止按时间顺序复述事件。",
  "- 不是聊天记录。「下午两点聊了…三点到五点…」这种写法一律不要。",
  "- 不是记忆清单。不要把原文里出现过的偏好、性格、约定罗列成条目——那些属于长期记忆池，不属于这里。这里只放现在还成立、且会改变下一步动作的东西。",
  "- 不是原文的美化版。每一条都要经得起一个问题：不知道这条，下一步会不会做错事。",
  "",
  "最重要的一条：状态是「截至此刻最准确的版本」，不是「新信息 + 老信息」。",
  "所以你必须主动做减法：",
  "- 上一版里有、这一版已被推翻或已经过期的，删掉。",
  "- 被更新的，改写成现在的样子，不要新旧两版并存。",
  "- 同一件事说三遍的，合并成一句。",
  "某条现在还成不成立拿不准，就保留但改成待确认的语气，不要两个版本都留着。",
  "",
  "写什么（这是状态的主体）：",
  "- 正在做的事：是什么、做到哪一步、下一步是什么",
  "- 已经定了的决定，以及为什么这么定",
  "- 明确被否掉的方案、被推翻的判断，写成「曾经以为 X，现在知道是 Y」",
  "- 本轮新形成的约定、承诺、边界",
  "- 还没结束的事：悬着的、欠着的、约好没做的",
  "- 语境和关系的当前状态",
  "",
  "不写：",
  "- 寒暄、玩笑、一次性事件、当天情绪",
  "- 已经彻底过去、不会再影响任何决定的事",
  "- 你的自我叙事和抒情",
  "- 原文里没有的信息",
  "",
  "写法：",
  "- 称呼按我们平时的叫法，用「我」和「她」。",
  "- 直接写状态，不写「本次对话中」「用户表示」「我总结」。",
  "- 不要用「上次」「刚才」这种悬空指代，必要时写具体日期。",
  "- 不使用 Markdown，不加标题前言结尾。",
  "- 长度目标 2000~5000 字，写到够用就停，不要为了覆盖原文而注水。",
  "",
  "只输出 JSON，不要任何其它文字：",
  '{"state":"…状态正文…","ops":[{"type":"add|update|remove","desc":"一句话说明改了什么","reason":"仅 remove 需要"}],"search":[]}',
  "",
  "ops 是变更清单，要如实反映你对上一版做的每一处改动：",
  "- add：上一版没有、这一版新增的",
  '- update：上一版有、这一版被改写的，desc 写成「原来是什么 → 现在是什么」',
  "- remove：上一版有、这一版判定已失效的",
  "reason 写不出来的 remove，说明你其实不确定，那就别删。",
  "",
  "search：需要确认某件事的原文时使用，最多 " + SEARCH_ROUNDS + " 轮：",
  '{"search":[{"time":"2026-09-28 21:00","q":"关键词或她的原话片段"}]}',
  "- time 可选。给了就按那个时间段捞原文，不给就按 q 做内容检索。",
  "- 一次只问一件事，别塞一整句长句。",
  "- 实在没有证据就不搜，按现有材料判断。"
].join("\n");

const DEFAULT_USER_TEMPLATE = [
  "=== 上一版状态 ===",
  "${PREV_STATE}",
  "",
  "=== 本次并入的对话原文 ===",
  "${CHUNK_INFO}",
  "${CONVERSATION_TEXT}",
  "",
  "（如果你请求了检索，回灌的原文会插在最后面）",
  "",
  "请输出这一版的状态 JSON。"
].join("\n");

// ========================
// 读写
// ========================

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const j = fs.readJsonSync(file);
    return j && typeof j === "object" ? j : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.ensureDirSync(path.dirname(file));
  fs.writeJsonSync(file, obj, { spaces: 2 });
}

function nowIso() {
  return new Date().toISOString();
}

function readStates() { return readJsonSafe(STATE_FILE, {}); }
function readVersions() { return readJsonSafe(VERSIONS_FILE, {}); }

function stateRecordId(sessionId) {
  return "ctxrep_state_" + String(sessionId || "").trim();
}

function loadPromptConfig() {
  const c = readJsonSafe(PROMPT_FILE, {});
  return {
    system: String(c.system || "").trim() || DEFAULT_SYSTEM,
    user_template: String(c.user_template || "").trim() || DEFAULT_USER_TEMPLATE,
    custom_set: !!(String(c.system || "").trim() || String(c.user_template || "").trim()),
  };
}

function savePromptConfig(system, userTemplate) {
  writeJson(PROMPT_FILE, {
    system: String(system || "").trim(),
    user_template: String(userTemplate || "").trim(),
  });
  return loadPromptConfig();
}

function resetPromptConfig() {
  try { fs.unlinkSync(PROMPT_FILE); } catch (e) { /* 本来就没有 = 已在默认 */ }
  return loadPromptConfig();
}

// ========================
// 读状态（给前端）
// ========================

// 可压缩列表里的消息 id → 下标（0-based）。跟压缩页的编号 1-based 差 1。
// 每次现算：时间线会因增删/编辑而变，缓存下来的下标会漂。
function compressibleIndexById() {
  const idx = Object.create(null);
  const items = contextReplacements.compressibleItems();
  for (let i = 0; i < items.length; i++) {
    const m = items[i] && items[i].msg;
    const id = m && m.id ? String(m.id) : null;
    if (id && idx[id] === undefined) idx[id] = i;
  }
  return idx;
}

function getState(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "缺少 sessionId" };
  const states = readStates();
  const st = states[sid] || null;
  // 指针模型（1003-31 C 方案）：链上版本永不因回滚/撤销删除，状态由与指针比较派生——
  //   = 指针 → current；> 指针 → undone（被回滚掉，可恢复）；< 指针 → superseded（旧版）。
  const curVer = st ? Number(st.version || 0) : 0;
  const idxMap = (function () {
    try { return compressibleIndexById(); } catch (e) { return null; }
  })();
  const coverIndexRange = function (cover) {
    if (!cover || !cover.start_id || !cover.end_id || !idxMap) return null;
    const s = idxMap[cover.start_id];
    const e = idxMap[cover.end_id];
    return (typeof s === "number" && typeof e === "number") ? { start_index: s, end_index: e } : null;
  };
  const versions = (readVersions()[sid] || []).map(function (v) {
    return {
      version: v.version,
      at: v.at,
      source: v.source,
      chars: String(v.text || "").length,
      // 每一版自己的覆盖区间——「并入记录」页靠它展示那一次吃掉了哪段原文；
      // 不能用当前 cover 顶替（回滚后当前值是旧的，历史各行会全显示成同一区间）
      cover: v.cover || null,
      range: coverIndexRange(v.cover),
      status: (st && Number(v.version) === curVer) ? "current"
        : (Number(v.version) > curVer ? "undone" : "superseded"),
    };
  });

  // 覆盖区间在「可压缩编号」里的位置：状态吃掉的是时间线上一段连续前缀，
  // 前端靠它算「还剩哪些没并入」，也靠它挡住重复并入已覆盖的区间。
  // covered_range 直接从 cover 的边界 id 现算（不依赖 span 记录里的 range 快照
  // ——那是 upsertSpanRecord 写入时的下标，时间线增删后会漂）。
  let coveredRange = null;
  if (st && st.cover && st.cover.start_id && st.cover.end_id) {
    try {
      const idx = compressibleIndexById();
      const s = idx[st.cover.start_id];
      const e = idx[st.cover.end_id];
      if (typeof s === "number" && typeof e === "number") {
        coveredRange = { start_index: s, end_index: e, count: e - s + 1 };
      }
    } catch (err) { /* 读不到就当没覆盖，页面会退回让用户手填区间 */ }
  }

  return {
    ok: true,
    session: sid,
    record_id: stateRecordId(sid),
    exists: !!st,
    version: st ? (st.version || 0) : 0,
    text: st ? String(st.text || "") : "",
    ops: st && Array.isArray(st.ops) ? st.ops : [],
    cover: st && st.cover ? st.cover : null,
    covered_range: coveredRange,
    updated_at: st ? st.updated_at : null,
    seed_from_legacy: st ? !!st.seed_from_legacy : false,
    versions: versions,
  };
}

function getVersionText(sessionId, version) {
  const sid = String(sessionId || "").trim();
  const list = readVersions()[sid] || [];
  const v = list.find(function (x) { return Number(x.version) === Number(version); });
  if (!v) return { ok: false, error: "该版本不在版本链里" };
  return { ok: true, version: v.version, text: String(v.text || ""), ops: v.ops || [], cover: v.cover || null, at: v.at };
}

// ========================
// 消息 → 文本
// ========================

function contentToText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(function (p) {
      if (!p) return "";
      if (typeof p.text === "string") return p.text;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

// 记忆浮现是记忆池注入内容，不是对话本身——不进状态（口径与旧压缩器一致）
function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  return String(msg.content || "").indexOf("记忆浮现") !== -1;
}

function roleLabel(msg) {
  if (!msg) return "我";
  if (msg.role === "user") return process.env.USER_DISPLAY_NAME || "对方";
  if (msg.role === "developer") return "系统";
  return "我";
}

const REASONING_EACH_MAX = 600;   // 单条思考链截断
const REASONING_TOTAL_MAX = 8000;  // 思考链总量预算（状态 prompt 比旧压缩更吃紧，压一半）

function formatMessages(msgs) {
  let total = 0;
  const lines = msgs.map(function (m) {
    if (isMemoryFlash(m)) return null;
    const body = contentToText(m);
    const tag = "[" + roleLabel(m) + "] ";
    const r = (m && m.role === "assistant" && typeof m.reasoning === "string") ? m.reasoning.trim() : "";
    if (r) {
      const cut = r.length > REASONING_EACH_MAX ? r.slice(0, REASONING_EACH_MAX) + "…（思考链已截断）" : r;
      if (total + cut.length <= REASONING_TOTAL_MAX) {
        total += cut.length;
        return tag + body + "\n[思考] " + cut;
      }
    }
    return tag + body;
  }).filter(Boolean);
  return { text: lines.join("\n\n"), dropped: msgs.length - lines.length };
}

function fmtTimeLabel(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) return "";
  const p = function (x) { return String(x).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

// 返回 {start, end, label}：状态覆盖的是「首次并入起 ~ 最近一次并入止」这一整段，
// 所以首尾分开存，累加时只换 end、不动 start（否则第 12 次并入后标签会缩成只剩最后一段）。
function rangeLabelPartsOf(msgs) {
  const t = msgs.map(function (m) { return m && m.time ? m.time : null; }).filter(Boolean);
  if (!t.length) return { start: "", end: "", label: "" };
  const start = fmtTimeLabel(t[0]);
  const end = fmtTimeLabel(t[t.length - 1]);
  return { start: start, end: end, label: start + " ~ " + end };
}

function rangeLabelOf(msgs) {
  return rangeLabelPartsOf(msgs).label;
}

// ========================
// LLM
// ========================

async function callLlm(system, msgs) {
  const { resolveRoleModel } = require("../model-router");
  const { provider, model } = resolveRoleModel(MODEL_ROLE);
  const apiUrl = provider && (provider.api_url || provider.base_url);
  const apiKey = provider && provider.api_key;
  if (!apiUrl || !apiKey || !model) {
    throw new Error("模型未配置（role=" + MODEL_ROLE + "）：请在管理台给「压缩摘要」选一个模型");
  }
  // max_tokens 分档重试（口径同 context-compactor 的 outputBudgets）：
  // glm-5.3-flash 这类思考模型的思考也计入 max_tokens（记忆：智谱四坑），不给够预算
  // 正文会被截断 → JSON 解析失败。首档 16000 不够就逐档加到 50000。
  const outputBudgets = [16000, 32000, 50000];
  let lastErr = null;
  for (let attempt = 0; attempt < outputBudgets.length; attempt++) {
    const payload = JSON.stringify({
      model: model,
      messages: [{ role: "system", content: system }].concat(msgs),
      temperature: 0.3,
      response_format: { type: "json_object" },
      max_tokens: outputBudgets[attempt],
    });
    const data = await httpPostJson(apiUrl, payload, {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    }, LLM_TIMEOUT_MS);
    const choice = data.choices && data.choices[0];
    const text = choice && choice.message && choice.message.content;
    const finish = choice && choice.finish_reason;
    if (!text || !String(text).trim() || finish === "length") {
      lastErr = new Error(!text || !String(text).trim()
        ? "上游返回空正文（HTTP 正常）"
        : "正文被截断（finish_reason=length，输出预算 " + outputBudgets[attempt] + " 不够）");
      continue;
    }
    return { text: String(text), model: model, finish_reason: finish, max_tokens: outputBudgets[attempt] };
  }
  throw lastErr || new Error("模型调用失败");
}

// 思考模型会把推理混进 content：抠第一个完整 JSON 对象出来
function parseResponse(raw) {
  const s = String(raw || "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a === -1 || b <= a) return { error: "没找到 JSON 对象" };
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch (e) {
    return { error: "JSON 解析失败：" + e.message };
  }
}

function normalizeOps(ops) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  ops.forEach(function (o) {
    if (!o || typeof o !== "object") return;
    const type = String(o.type || "").trim();
    if (["add", "update", "remove"].indexOf(type) === -1) return;
    const desc = String(o.desc || "").trim();
    if (!desc) return;
    out.push({ type: type, desc: desc, reason: String(o.reason || "").trim() });
  });
  return out;
}

// ========================
// 检索回合（照搬 memory-distill.js:951-971 的形态）
// ========================

async function runSearchRequests(reqs, seenBatch) {
  const list = Array.isArray(reqs) ? reqs.slice(0, SEARCH_MAX_PER_ROUND) : [];
  const parts = [];
  let got = 0;
  let dup = 0;
  for (const r of list) {
    const time = String((r && r.time) || "").trim();
    const q = String((r && r.q) || "").trim();
    if (!time && !q) continue;
    let res;
    try {
      const opts = { allSessions: true, limit: SEARCH_LIMIT_PER_QUERY };
      if (time && !q) opts.timePrefix = time;             // 纯时间定位（context-replacements.js:2401 pureTimeMode）
      else if (time) opts.timePrefix = time;              // 内容检索后再按时间过滤
      if (q) opts.mode = "semantic";
      res = await contextReplacements.searchContextEnhanced(q, opts);
    } catch (e) {
      parts.push("【检索失败】" + (time || q) + "：" + e.message);
      continue;
    }
    const hits = (res && (res.results || res.messages || res.items)) || [];
    const kept = [];
    for (const h of hits) {
      const id = String((h && (h.id || h.msg_id)) || "");
      if (!id) continue;
      if (seenBatch[id]) { dup++; continue; }             // 同一条原文本批只给一次
      seenBatch[id] = true;
      kept.push("#" + id + " [" + roleLabel(h) + "] " + contentToText(h));
      got++;
    }
    if (kept.length) {
      parts.push("【检索】" + (time || q) + "\n" + kept.join("\n"));
    } else {
      parts.push("【检索】" + (time || q) + "：没有新的原文（本批前面已给过的内容不再重复）。");
    }
  }
  let text = parts.join("\n\n");
  if (text.length > SEARCH_MAX_CHARS) {
    text = text.slice(0, SEARCH_MAX_CHARS) + "\n（本轮回灌原文已截断）";
  }
  return { text: text, got: got, dupCount: dup };
}

// ========================
// 预览（不落盘）
// ========================

function sliceRange(sessionId, start, end) {
  const items = contextReplacements.compressibleItems();
  const total = items.length;
  const s = Math.max(1, Math.floor(Number(start) || 1));
  let e = Math.floor(Number(end));
  if (!Number.isInteger(e) || e < s) e = s;
  e = Math.min(e, total);
  if (s > total) return { ok: false, error: "起始编号超出可压缩范围（共 " + total + " 条）" };
  const slice = items.slice(s - 1, e);
  const msgs = slice.map(function (it) { return it.msg; }).filter(Boolean);
  return { ok: true, msgs: msgs, count: msgs.length, total: total, startNum: s, endNum: e };
}

async function previewMerge(params) {
  const sessionId = String(params && params.session || "").trim();
  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  const range = sliceRange(sessionId, params.start, params.end);
  if (!range.ok) return range;
  if (!range.msgs.length) return { ok: false, error: "选中区间里没有可并入的消息" };

  const cur = getState(sessionId);
  const prevText = cur.exists ? cur.text : "（无，这是这个会话的第一版状态）";
  const fmt = formatMessages(range.msgs);
  const rangeParts = rangeLabelPartsOf(range.msgs);
  const pc = loadPromptConfig();
  const userMsg = pc.user_template
    .replace(/\$\{PREV_STATE\}/g, prevText)
    .replace(/\$\{CHUNK_INFO\}/g, "第 " + range.startNum + "~" + range.endNum + " 条，共 " + range.count + " 条，" + (rangeLabelOf(range.msgs) || "时间未知"))
    .replace(/\$\{CONVERSATION_TEXT\}/g, fmt.text);

  // 锚点：区间首尾**非记忆浮现**的消息（记忆浮现不进状态也不该当锚点）
  const anchorable = range.msgs.filter(function (m) { return m && m.id && !isMemoryFlash(m); });
  if (!anchorable.length) return { ok: false, error: "区间里没有可定位的消息 id" };
  const startMsg = anchorable[0];
  const endMsg = anchorable[anchorable.length - 1];

  const msgs = [{ role: "user", content: userMsg }];
  const seenBatch = Object.create(null);
  let raw = "";
  let parsed = null;
  let searchRounds = 0;
  let model = null;
  let lastErr = null;

  // 悬浮球日志：pending → success/error（addCompactionLog 的 id 语义：带 id 即更新原条目）
  const logId = (function () {
    const e = logEntry({
      label: "状态并入 · " + sessionId.slice(-12),
      status: "pending",
      message: "正在算新状态：第 " + range.startNum + "~" + range.endNum + " 条（" + range.count + " 条）",
    });
    return e && e.id;
  })();

  for (let turn = 0; turn <= SEARCH_ROUNDS + 1; turn++) {
    let r;
    try {
      r = await callLlm(pc.system, msgs);
    } catch (e) {
      lastErr = e;
      break;
    }
    raw = r.text;
    if (r.model) model = r.model;
    const p = parseResponse(raw);
    if (p.error) { lastErr = new Error(p.error + "（模型 " + (model || "?") + "，finish_reason=" + (r.finish_reason || "?") + "）"); break; }
    const searchReqs = Array.isArray(p.search) ? p.search : [];
    if (searchReqs.length && searchRounds < SEARCH_ROUNDS) {
      searchRounds++;
      logEntry({ id: logId, status: "pending", message: "模型自提检索第 " + searchRounds + " 轮（" + searchReqs.length + " 条请求）…" });
      const found = await runSearchRequests(searchReqs, seenBatch);
      msgs.push({ role: "assistant", content: raw });
      msgs.push({ role: "user", content: "【回灌原文】\n" + found.text });
      continue;
    }
    parsed = p;
    break;
  }

  if (!parsed) {
    const errMsg = (lastErr && lastErr.message ? lastErr.message : "模型没给出可解析的 JSON") +
      (raw ? "（原始输出前 200 字：" + raw.slice(0, 200).replace(/\n/g, " ") + "）" : "");
    logEntry({ id: logId, status: "error", message: errMsg });
    return {
      ok: false,
      error: errMsg,
      raw_head: raw.slice(0, 500),
      model: model,
      search_rounds: searchRounds,
    };
  }

  const stateText = String(parsed.state || "").trim();
  if (!stateText) {
    const e2 = "模型没给出 state 正文";
    logEntry({ id: logId, status: "error", message: e2 });
    return { ok: false, error: e2, raw_head: raw.slice(0, 500) };
  }
  if (stateText.length > MAX_STATE_CHARS) {
    const e3 = "状态正文超长（" + stateText.length + " 字，硬上限 " + MAX_STATE_CHARS + "）";
    logEntry({ id: logId, status: "error", message: e3 });
    return { ok: false, error: e3 };
  }

  logEntry({
    id: logId,
    status: "success",
    message: "已算好 v" + ((cur.version || 0) + 1) + " 候选（状态 " + stateText.length + " 字、变更 " +
      normalizeOps(parsed.ops).length + " 条" + (searchRounds ? "、检索 " + searchRounds + " 轮" : "") + "），等确认并入",
  });

  return {
    ok: true,
    session: sessionId,
    model: model,
    search_rounds: searchRounds,
    search_hits: Object.keys(seenBatch).length,
    prev_version: cur.version,
    state: stateText,
    ops: normalizeOps(parsed.ops),
    range: {
      start_num: range.startNum,
      end_num: range.endNum,
      count: range.count,
      range_label: rangeParts.label,
      label_start: rangeParts.start,
      label_end: rangeParts.end,
      start_id: String(startMsg.id),
      end_id: String(endMsg.id),
      start_msg: startMsg,
      end_msg: endMsg,
    },
  };
}

// ========================
// 落盘
// ========================

// 确认并入：结果（成功/失败）都写悬浮球日志。并入本身是即时的（不调模型），
// 失败几乎都是校验拒绝（连续性断言/重叠断言/锚点丢失）——正需要日志说明原因。
function commitMerge(params) {
  const r = _commitMerge(params);
  const sessionId = String(params && params.session || "").trim();
  const ver = r.ok ? ("v" + r.version) : "?";
  const coverTxt = (r.ok && r.cover) ? ((r.cover.label_start || "") + " ~ " + (r.cover.label_end || "")) : "";
  logEntry({
    label: "状态并入 · " + (sessionId ? sessionId.slice(-12) : "?"),
    status: r.ok ? "success" : "error",
    message: r.ok
      ? "已确认并入 → " + ver + "（覆盖 " + coverTxt + "，状态 " + String(r.text || "").length + " 字）"
      : "并入失败：" + (r.error || "未知原因"),
  });
  return r;
}

function _commitMerge(params) {
  const sessionId = String(params && params.session || "").trim();
  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  const text = String(params.state || "").trim();
  if (!text) return { ok: false, error: "状态正文为空" };
  if (text.length > MAX_STATE_CHARS) return { ok: false, error: "状态正文超长" };

  const cur = getState(sessionId);
  // 版本号单调递增（指针模型）：回滚到 v5 后再并入，新版本是「链上最大号 +1」（如 v9），
  // 不是 cur.version+1（那会跟链上已存在的 v6 撞号）。
  const chain = readVersions()[sessionId] || [];
  let maxVer = cur.version || 0;
  chain.forEach(function (v) { if (Number(v.version) > maxVer) maxVer = Number(v.version); });
  const nextVersion = maxVer + 1;

  // 覆盖区间：首版取本次区间起点，之后固定住起点、只往后延（连续前缀）
  const endMsg = params.end_msg;
  if (!endMsg || !endMsg.id) return { ok: false, error: "缺少区间末尾锚点消息" };

  const tl = contextReplacements.loadTimeline();
  let coverStartMsg = null;
  if (cur.exists && cur.cover && cur.cover.start_id) {
    coverStartMsg = tl.find(function (m) {
      return m && m.id && String(m.id) === String(cur.cover.start_id);
    }) || null;
    if (!coverStartMsg) return { ok: false, error: "当前状态的起始锚点已不在时间线里，请先整份重算" };
  } else {
    coverStartMsg = (params.start_msg && params.start_msg.id) ? params.start_msg : null;
    if (!coverStartMsg) return { ok: false, error: "缺少区间起始锚点消息" };
  }

  // ★ 连续性断言：状态覆盖的是一段「连续前缀」，本次并入必须紧接在它后面。
  // 漏了这条会让一段从未被模型读过的原文被状态静默吞掉——表现是「那段对话像是从没发生过」，
  // 而且不可察觉（状态正文不报错、注入也正常）。宁可拒绝写入。
  if (cur.exists && cur.covered_range && typeof cur.covered_range.end_index === "number") {
    const idPos = compressibleIndexById();
    const newStart = (params.start_msg && params.start_msg.id) ? idPos[String(params.start_msg.id)] : undefined;
    const newEnd = endMsg.id ? idPos[String(endMsg.id)] : undefined;
    if (newStart === undefined || newEnd === undefined) {
      return { ok: false, error: "本次并入区间的消息在当前会话的可压缩列表里定位不到，换个区间再试" };
    }
    const expected = cur.covered_range.end_index + 1;   // 0-based
    if (newStart !== expected) {
      const gapFrom = expected + 1;
      return {
        ok: false,
        error: "并入区间必须紧接在状态覆盖范围之后。当前状态覆盖到第 " + cur.covered_range.end_index +
          " 条，本次却从第 " + (newStart + 1) + " 条开始——第 " + gapFrom + "~" + newStart +
          " 条会被状态吞掉，但模型从没读过它们。\n请从第 " + gapFrom + " 条开始并入（或用「自动分块」）。",
      };
    }
  }

  const recordId = stateRecordId(sessionId);
  // 覆盖区间标签：首次并入用本次起点，之后起点不动、只推进终点
  // （否则第 12 次并入后标签会缩成只剩最后一段，页面上会误导「这份状态只覆盖了最近一次」）
  const prevCover = (cur.exists && cur.cover) ? cur.cover : null;
  const passedLabel = String(params.range_label || "");
  const passedParts = passedLabel.split(" ~ ");
  const labelStart = (prevCover && prevCover.label_start)
    ? prevCover.label_start
    : (String(params.label_start || "") || passedParts[0] || "");
  const labelEnd = String(params.label_end || "") || passedParts[1] || "";
  const cover = {
    start_id: String(coverStartMsg.id),
    end_id: String(endMsg.id),
    label_start: labelStart,
    label_end: labelEnd,
  };
  const coverLabel = labelStart && labelEnd ? (labelStart + " ~ " + labelEnd) : (labelStart || labelEnd || "");

  const spanRes = contextReplacements.upsertSpanRecord({
    recordId: recordId,
    session: sessionId,
    startMsg: coverStartMsg,
    endMsg: endMsg,
    text: text,
    rangeLabel: coverLabel,
    count: params.count != null ? Number(params.count) : undefined,
    source: "state",
  });
  if (!spanRes.ok) return { ok: false, error: spanRes.error || spanRes.message || "写入状态记录失败" };

  // 操作清单：前端标记为拦截的 remove 不写进历史（那是「本来就没删」的诚实记录）
  const blocked = Array.isArray(params.blocked) ? params.blocked.map(String) : [];
  const ops = normalizeOps(params.ops).filter(function (o) {
    return !(o.type === "remove" && blocked.indexOf(o.desc) !== -1);
  });

  const states = readStates();
  states[sessionId] = {
    version: nextVersion,
    record_id: recordId,
    text: text,
    ops: ops,
    cover: cover,
    updated_at: nowIso(),
    seed_from_legacy: false,
  };
  writeJson(STATE_FILE, states);

  const versions = readVersions();
  const list = versions[sessionId] || [];
  list.unshift({
    version: nextVersion,
    text: text,
    ops: ops,
    cover: cover,
    at: nowIso(),
    source: params.source || "merge",
  });
  // 指针模型：链只在提交时从「最老那头」挤出（KEEP_VERSIONS 上限不变）。
  // 提交后指针总在新版本上，最老的不可能是指针，无需特判。
  while (list.length > KEEP_VERSIONS) list.length = KEEP_VERSIONS;
  versions[sessionId] = list;
  writeJson(VERSIONS_FILE, versions);

  console.log("[conversation-state] 已并入 " + sessionId + " → v" + nextVersion +
    "（覆盖到 " + (params.range_label || "") + "，状态 " + text.length + " 字）");

  return getState(sessionId);
}

function rollback(params) {
  const sessionId = String(params && params.session || "").trim();
  const target = Number(params && params.version);
  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  const list = readVersions()[sessionId] || [];
  const v = list.find(function (x) { return Number(x.version) === target; });
  if (!v) return { ok: false, error: "该版本不在版本链里（只保留最近 " + KEEP_VERSIONS + " 版）" };
  const cur = getState(sessionId);
  // 指针模型：cur.exists=false（整条已撤销）时也允许切——那就是「从并入记录里恢复」，
  // 状态从这里重建。没有状态时无所谓「挪指针」，就是原样恢复那一版。

  const tl = contextReplacements.loadTimeline();
  const startMsg = tl.find(function (m) { return m && m.id && String(m.id) === String(v.cover && v.cover.start_id); });
  const endMsg = tl.find(function (m) { return m && m.id && String(m.id) === String(v.cover && v.cover.end_id); });
  if (!startMsg || !endMsg) return { ok: false, error: "该版本的覆盖锚点已不在时间线里，无法回滚" };

  const spanRes = contextReplacements.upsertSpanRecord({
    recordId: stateRecordId(sessionId),
    session: sessionId,
    startMsg: startMsg,
    endMsg: endMsg,
    text: String(v.text || ""),
    rangeLabel: (v.cover && v.cover.label_start && v.cover.label_end)
      ? (v.cover.label_start + " ~ " + v.cover.label_end)
      : ((cur.cover && (cur.cover.label_start || cur.cover.label_end))
        ? ((cur.cover.label_start || "") + (cur.cover.label_end ? " ~ " + cur.cover.label_end : ""))
        : ""),
    source: "state",
  });
  if (!spanRes.ok) return { ok: false, error: spanRes.error || "回滚写入失败" };

  const states = readStates();
  const st = states[sessionId] || {
    record_id: stateRecordId(sessionId),
    ops: [],
    cover: v.cover || null,
    seed_from_legacy: false,
  };
  // 指针模型（1003-31 C 方案）：回滚 = 只挪指针，**不截链**。
  // 比 target 新的版本留在链上标「已撤销」，随时可以再切回去（恢复，不调模型）。
  st.version = Number(v.version);
  st.text = String(v.text || "");
  st.ops = v.ops || [];
  st.cover = v.cover || st.cover;
  st.updated_at = nowIso();
  states[sessionId] = st;
  writeJson(STATE_FILE, states);

  console.log("[conversation-state] 已切到 " + sessionId + " → v" + target +
    "（指针移动，链上 " + list.length + " 版保留）");
  return getState(sessionId);
}

function undoLastMerge(params) {
  const sessionId = String(params && params.session || "").trim();
  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  const list = readVersions()[sessionId] || [];
  if (!list.length) return { ok: false, error: "没有可撤销的并入" };

  const cur = getState(sessionId);
  // list 是 unshift 的，越靠前越新；current 后面那一项就是「比当前旧一版」
  const idx = list.findIndex(function (x) { return Number(x.version) === Number(cur.version); });
  const previous = idx >= 0 ? list[idx + 1] : null;

  // 没有更早的版本 → 状态指针清空、原文全部回到未覆盖区。
  // 指针模型（1003-32）：**版本链保留**，全部标「已撤销·可恢复」——
  // 撤销第一版 ≠ 丢失，并入记录里点两下就能原样恢复（不调模型）。
  // 此前这里连链一起删，用户撤销后并入记录直接变空（1003-32 实测反馈）。
  if (!previous) {
    const states = readStates();
    delete states[sessionId];
    writeJson(STATE_FILE, states);
    const rm = contextReplacements.removeReplacement(stateRecordId(sessionId));
    logEntry({ label: "状态撤销 · " + sessionId.slice(-12), status: "success", message: "已撤销整条状态（原文全部回到未覆盖区；版本链保留，可在并入记录里恢复）" });
    console.log("[conversation-state] 已撤销 " + sessionId + " 的最后一次并入（指针清空，链保留 " + list.length + " 版，rm=" + (rm && rm.ok) + "）");
    return { ok: true, removedAll: true, session: sessionId };
  }

  const r = rollback({ session: sessionId, version: previous.version });
  if (!r.ok) { logEntry({ label: "状态撤销 · " + sessionId.slice(-12), status: "error", message: "撤销失败：" + (r.error || "?") }); return r; }
  logEntry({ label: "状态撤销 · " + sessionId.slice(-12), status: "success", message: "已切回 v" + previous.version + "（v" + cur.version + " 标记为已撤销，链上可随时恢复）" });
  return { ok: true, removedAll: false, rolled_to: previous.version, state: r };
}

module.exports = {
  setLogFn,
  getState,
  getVersionText,
  previewMerge,
  commitMerge,
  rollback,
  undoLastMerge,
  loadPromptConfig,
  savePromptConfig,
  resetPromptConfig,
  DEFAULT_SYSTEM,
  DEFAULT_USER_TEMPLATE,
  KEEP_VERSIONS,
};