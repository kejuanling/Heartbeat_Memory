// 按天取对话原文（记忆蒸馏 3.3 选材层的新数据源）
//
// 2026-10-04 改造背景：
//   原蒸馏以「日记」为主料，只预取当天 25 条 + 语义 8 条原文，实测「日记太短抽不出东西」。
//   改为：主料 = 当天全部对话原文（跨会话聚合），日记退为导航线索。
//
// 三条硬规则（都是量过真实数据才定的）：
//   1. 必须去重——全库 23.6% 的消息内容完全重复（疑似流式多版本/编辑历史/写入重试），
//      不去重既白烧 token，又会让模型误判「这段反复出现所以重要」。
//   2. 必须过滤记忆/注入产物——否则已有记忆被当原文再抽一遍（重复记忆 + 虚假取证）。
//   3. 单条超长必须截断——全库有 108 条 >2000 字（最长 3.67 万字），
//      整条塞进去一条就能占满窗口；截断后告诉模型「可以提检索看全文」。
//
// 输出只带 role / time / content（+ msg_id 供取证引用）。

const fs = require("fs");
const path = require("path");

const TZ = "Asia/Shanghai";
const MSG_FILE_RE = /^enhanced_messages_(.+)\.json$/;
const EXCLUDE_SESSION_PREFIX = ["smoke-"];

// 与 memory-distill 的 EVIDENCE_SKIP_PATTERNS 同款：记忆池/注入产物混进时间线的痕迹
const SKIP_PATTERNS = [
  /\[此刻想起\]/,
  /\[记忆\]/,
  /\[长期记忆\]/,
  /\[Earlier Days\]/,
  /^\s*【记忆/,
];

const DEFAULT_ROLES = ["user", "assistant"];
const DEFAULT_MAX_MSG_CHARS = 2000;   // 单条截断阈值
const DUP_MIN_CHARS = 40;             // 短于此长度不参与内容去重（寒暄太容易撞）

// 从原文里剥离的注入块（实测：25.3% 的消息带标签，标签块占全库 7.8% 字符）
//   <current_time> —— 每条 user 消息尾部的系统时间戳，纯噪音，6760 处
//   <memory>       —— AI 回复里内联写的记忆，146 处；不剥离＝已有记忆被当原文再抽一遍
//                     （代价：偶尔会剥掉用户贴代码时字面写到的 <memory>，但那部分本就不该入记忆）
//   其余标签（<wake>/<phone>/<paper> 等）保留：它们是真实协议内容，含事实
const STRIP_BLOCK_RE = /<(current_time|memory)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;

function stripInjectedBlocks(s) {
  const before = String(s == null ? "" : s);
  const after = before.replace(STRIP_BLOCK_RE, "");
  return { text: after, stripped: before.length - after.length };
}

function localDayOf(iso) {
  const d = new Date(String(iso || ""));
  if (isNaN(d.getTime())) return "";
  try { return d.toLocaleDateString("en-CA", { timeZone: TZ }); }
  catch (e) { return String(iso).slice(0, 10); }
}

function normText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function listSessionFiles(baseDir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch (e) { return out; }
  for (const n of names) {
    const m = MSG_FILE_RE.exec(n);
    if (!m) continue;
    const sid = m[1];
    if (EXCLUDE_SESSION_PREFIX.some(function (p) { return sid.indexOf(p) === 0; })) continue;
    out.push({ sid: sid, file: path.join(baseDir, n) });
  }
  return out;
}

function readMessages(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(j) ? j : (j && Array.isArray(j.messages) ? j.messages : []);
  } catch (e) {
    return [];
  }
}

/**
 * 列出所有有对话的日期（本地日），升序。
 */
function listDays(baseDir) {
  const set = Object.create(null);
  for (const s of listSessionFiles(baseDir)) {
    for (const m of readMessages(s.file)) {
      if (!m || typeof m !== "object") continue;
      const d = localDayOf(m.time || m.created_at);
      if (d) set[d] = true;
    }
  }
  return Object.keys(set).sort();
}

/**
 * 取某一天的对话原文（跨会话聚合，时间升序）。
 * @param {string} baseDir 项目根
 * @param {string} dayKey  本地日 "YYYY-MM-DD"
 * @param {object} opts    { roles, maxMsgChars, dedupe, skipPatterns }
 * @returns {{day:string, msgs:Array, lines:Array, chars:number, stats:object}}
 */
function readDay(baseDir, dayKey, opts) {
  const o = opts || {};
  const roles = Array.isArray(o.roles) && o.roles.length ? o.roles : DEFAULT_ROLES;
  const maxChars = Math.max(0, Math.floor(Number(o.maxMsgChars) || DEFAULT_MAX_MSG_CHARS));
  const dedupe = o.dedupe !== false;
  const skip = Array.isArray(o.skipPatterns) && o.skipPatterns.length ? o.skipPatterns : SKIP_PATTERNS;

  const raw = [];
  for (const s of listSessionFiles(baseDir)) {
    for (const m of readMessages(s.file)) {
      if (!m || typeof m !== "object") continue;
      if (localDayOf(m.time || m.created_at) !== dayKey) continue;
      raw.push({
        role: String(m.role || ""),
        time: String(m.time || m.created_at || ""),
        id: m.id ? String(m.id) : "",
        content: String(m.content == null ? "" : m.content),
        session: s.sid,
      });
    }
  }

  const stats = {
    day: dayKey,
    rawCount: raw.length,
    rawChars: 0,
    droppedRole: 0,
    droppedInjected: 0,
    droppedDup: 0,
    droppedDupChars: 0,
    strippedInjected: 0,
    strippedChars: 0,
    truncated: 0,
    kept: 0,
    chars: 0,
  };
  for (const m of raw) stats.rawChars += m.content.length;

  raw.sort(function (a, b) {
    const ta = Date.parse(a.time) || 0, tb = Date.parse(b.time) || 0;
    if (ta !== tb) return ta - tb;
    return a.session < b.session ? -1 : (a.session > b.session ? 1 : 0);
  });

  const seenContent = Object.create(null);
  const seenId = Object.create(null);
  const msgs = [];
  for (const m of raw) {
    if (roles.indexOf(m.role) < 0) { stats.droppedRole++; continue; }
    const st = stripInjectedBlocks(m.content);
    if (st.stripped > 0) { stats.strippedInjected++; stats.strippedChars += st.stripped; }
    const c = st.text;
    m.content = c;                     // 后续打包/取证都用剥离后的正文
    if (!c.trim()) continue;
    if (skip.some(function (re) { return re.test(c); })) { stats.droppedInjected++; continue; }
    if (dedupe) {
      if (m.id && seenId[m.id]) { stats.droppedDup++; stats.droppedDupChars += c.length; continue; }
      const key = normText(c);
      if (key.length >= DUP_MIN_CHARS && seenContent[key]) { stats.droppedDup++; stats.droppedDupChars += c.length; continue; }
      if (key.length >= DUP_MIN_CHARS) seenContent[key] = true;
      if (m.id) seenId[m.id] = true;
    }
    msgs.push(m);
  }

  const lines = [];
  let chars = 0;
  for (const m of msgs) {
    let c = m.content;
    let cut = false;
    if (maxChars > 0 && c.length > maxChars) {
      c = c.slice(0, maxChars);
      cut = true;
      stats.truncated++;
    }
    const t = m.time ? String(m.time).slice(11, 16) : "?";
    lines.push("[" + (m.role || "?") + " · " + t + " · " + (m.id ? "#" + m.id : "#?") + "] " + c
      + (cut ? "\n  └（本条过长已截断，原文 " + m.content.length + " 字；需要看全文请提检索）" : ""));
    chars += c.length;
  }

  stats.kept = msgs.length;
  stats.chars = chars;
  return { day: dayKey, msgs: msgs, lines: lines, chars: chars, stats: stats };
}

module.exports = {
  TZ: TZ,
  SKIP_PATTERNS: SKIP_PATTERNS,
  DEFAULT_ROLES: DEFAULT_ROLES,
  DEFAULT_MAX_MSG_CHARS: DEFAULT_MAX_MSG_CHARS,
  localDayOf: localDayOf,
  listDays: listDays,
  readDay: readDay,
};
