// 按天取对话原文（记忆蒸馏选材层的数据源）
//
// 2026-10-04 改造背景：
//   原蒸馏以「日记」为主料，只预取当天 25 条 + 语义 8 条原文，实测「日记太短抽不出东西」。
//   改为：主料 = 当天全部对话原文（跨会话聚合），日记退为导航线索。
//
// 四条硬规则（都是量过真实数据才定的）：
//   1. 必须去重——全库 23.6% 的消息内容完全重复（疑似流式多版本/编辑历史/写入重试），
//      不去重既白烧 token，又会让模型误判「这段反复出现所以重要」。
//   2. 必须剥离注入块——25.3% 的消息带标签，其中 <memory> 146 处；
//      不剥离＝已有记忆被当原文再抽一遍（重复记忆 + 虚假取证）。<current_time> 是纯时间戳噪音。
//   3. 单条超长必须截断——全库 108 条 >2000 字（最长 3.67 万字），整条塞进去一条就占满窗口。
//   4. ★ 必须先「按会话筛文件」再解析——64 个会话共 21.2MB，而含某一天通常只有 8 个 / 约 500KB。
//      靠头尾片段读拿到每个会话的「首次/最后一次消息日」，用区间判断它是否可能含目标天，
//      只解析命中的文件。否则一次跑批把全部文件 JSON.parse 一遍，RSS 直接顶穿 pm2 的 900MB 上限。

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

// 从原文里剥离的注入块（保留 <wake>/<phone>/<paper> 等真实协议内容）
const STRIP_BLOCK_RE = /<(current_time|memory)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;

const DEFAULT_ROLES = ["user", "assistant"];
const DEFAULT_MAX_MSG_CHARS = 2000;   // 单条截断阈值
const DUP_MIN_CHARS = 40;             // 短于此长度不参与内容去重（寒暄太容易撞）

const SCAN_CHUNK = 65536;             // 分块扫描块大小
const MAX_SCAN_CHUNKS = 16;           // 头/尾各最多扫 16 块（1MB），覆盖超长首/末条消息

function localDayOf(iso) {
  const d = new Date(String(iso || ""));
  if (isNaN(d.getTime())) return "";
  try { return d.toLocaleDateString("en-CA", { timeZone: TZ }); }
  catch (e) { return String(iso).slice(0, 10); }
}

function normText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function stripInjectedBlocks(s) {
  const before = String(s == null ? "" : s);
  const after = before.replace(STRIP_BLOCK_RE, "");
  return { text: after, stripped: before.length - after.length };
}

// 归档/已删除的会话不进解析菜单（2026-10-04）：
//   归档 = 用户主动收纳（数据完整保留，server.js:6831 起，有新消息会自动取消归档）。
//   这些会话用户已经从「当前会话」里收走了，不该再被当成记忆来源。
//   ★ 每次调用现读：归档列表是动态的（随时归档/有新消息自动解归档），不能在模块加载时固化。
function loadExcludedSids(baseDir) {
  const set = Object.create(null);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(baseDir, "data", "session-archive.json"), "utf-8"));
    (Array.isArray(j) ? j : []).forEach(function (s) { if (s) set[String(s)] = true; });
  } catch (e) { /* 文件不存在/损坏 = 没有归档 */ }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(baseDir, "data", "deleted_sessions.json"), "utf-8"));
    const keys = Array.isArray(d) ? d : Object.keys(d || {});
    keys.forEach(function (s) { if (s) set[String(s)] = true; });
  } catch (e) { /* 同上 */ }
  return set;
}

function listSessionFiles(baseDir, excluded) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch (e) { return out; }
  for (const n of names) {
    const m = MSG_FILE_RE.exec(n);
    if (!m) continue;
    const sid = m[1];
    if (excluded && excluded[sid]) continue;                       // 归档/已删除：跳过
    if (EXCLUDE_SESSION_PREFIX.some(function (p) { return sid.indexOf(p) === 0; })) continue;
    out.push({ sid: sid, file: path.join(baseDir, n) });
  }
  return out;
}

// ---------- 会话索引：只靠 stat + 头尾片段读，判断「这个会话覆盖哪些天」 ----------

const TIME_RE = /"time"\s*:\s*"([^"]+)"/g;

function lastMatch(s) {
  TIME_RE.lastIndex = 0;
  let m, hit = "";
  while ((m = TIME_RE.exec(s))) hit = m[1];
  return hit;
}

function firstMatch(s) {
  TIME_RE.lastIndex = 0;
  const m = TIME_RE.exec(s);
  return m ? m[1] : "";
}

// 从头向前分块扫，取「第一条消息」的 time
// （消息对象里 time 排在 content 之后，首条消息很长时前 8KB 里可能根本没有它）
function scanFirstTime(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    for (let c = 0; c < MAX_SCAN_CHUNKS; c++) {
      const off = c * SCAN_CHUNK;
      if (off >= size) break;
      const len = Math.min(SCAN_CHUNK, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const hit = firstMatch(buf.toString("utf-8"));
      if (hit) return hit;
    }
  } finally { fs.closeSync(fd); }
  return "";
}

// 从尾向前分块扫，取「最后一条消息」的 time
// ★ 不用 mtime 兜底：实测很多会话文件 mtime 是「今天」（被压缩/重写过），
//   拿它当上界会把区间撑到今天，等于没过滤
function scanLastTime(file, size) {
  const fd = fs.openSync(file, "r");
  try {
    for (let c = 1; c <= MAX_SCAN_CHUNKS; c++) {
      const end = size - SCAN_CHUNK * (c - 1);
      if (end <= 0) break;
      const len = Math.min(SCAN_CHUNK, end);
      const off = end - len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const hit = lastMatch(buf.toString("utf-8"));
      if (hit) return hit;
      if (off === 0) break;
    }
  } finally { fs.closeSync(fd); }
  return "";
}

function probeSession(s) {
  const st = fs.statSync(s.file);
  const size = st.size;
  const mtimeMs = st.mtimeMs;
  let firstDay = "", lastDay = "", known = false;
  try {
    const ft = scanFirstTime(s.file, size);
    const lt = scanLastTime(s.file, size);
    if (ft && lt) {
      firstDay = localDayOf(ft);
      lastDay = localDayOf(lt);
      if (lastDay < firstDay) lastDay = firstDay;   // 顺序异常时按最宽区间处理（保守）
      known = !!(firstDay && lastDay);
    }
  } catch (e) {
    known = false;
  }
  return {
    sid: s.sid,
    file: s.file,
    size: size,
    mtimeMs: mtimeMs,
    firstDay: firstDay,
    lastDay: lastDay,
    known: known,          // false = 边界未知 → 一律解析（保守，宁可慢不能漏）
  };
}

const INDEX_FILE = "data/day_source_index.json";

function loadIndexCache(baseDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(baseDir, INDEX_FILE), "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch (e) { return {}; }
}

function saveIndexCache(baseDir, cache) {
  try { fs.writeFileSync(path.join(baseDir, INDEX_FILE), JSON.stringify(cache, null, 1), "utf-8"); }
  catch (e) { /* 缓存写失败不影响正确性 */ }
}

function getIndex(baseDir) {
  const excluded = loadExcludedSids(baseDir);          // 每次现读：归档是动态的
  const files = listSessionFiles(baseDir, excluded);   // 归档/已删除会话不进解析菜单
  const cache = loadIndexCache(baseDir);
  const out = [];
  let dirty = false;
  for (const s of files) {
    let st;
    try { st = fs.statSync(s.file); } catch (e) { continue; }
    const c = cache[s.sid];
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.firstDay && c.lastDay) {
      out.push({ sid: s.sid, file: s.file, size: st.size, mtimeMs: st.mtimeMs, firstDay: c.firstDay, lastDay: c.lastDay, known: true });
      continue;
    }
    const p = probeSession(s);
    out.push(p);
    cache[s.sid] = { size: p.size, mtimeMs: p.mtimeMs, firstDay: p.firstDay, lastDay: p.lastDay, known: p.known };
    dirty = true;
  }
  if (dirty) saveIndexCache(baseDir, cache);
  return out;
}

// 这个会话是否可能包含目标天
function mayContain(entry, day) {
  if (!entry.known) return true;                       // 边界未知 → 保守解析
  if (entry.firstDay && day < entry.firstDay) return false;
  if (entry.lastDay && day > entry.lastDay) return false;
  return true;
}

function readMessages(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(j) ? j : (j && Array.isArray(j.messages) ? j.messages : []);
  } catch (e) {
    return [];
  }
}

function daySpan(firstDay, lastDay) {
  // 区间内每天都算（可能含空洞日，planDay 会跳过没有消息的空天）
  const out = [];
  if (!firstDay || !lastDay || firstDay > lastDay) return out;
  const cur = new Date(firstDay + "T00:00:00Z");
  const end = new Date(lastDay + "T00:00:00Z");
  while (cur <= end && out.length < 2000) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * 列出所有有对话的日期（本地日），升序。
 * 已知边界的会话用区间展开（不解析内容）；边界未知的会话才整份解析。
 */
function listDays(baseDir, opts) {
  const o = opts || {};
  const idx = o.index || getIndex(baseDir);
  const set = Object.create(null);
  for (const e of idx) {
    if (e.known) { daySpan(e.firstDay, e.lastDay).forEach(function (d) { set[d] = true; }); continue; }
    for (const m of readMessages(e.file)) {
      if (!m || typeof m !== "object") continue;
      const d = localDayOf(m.time || m.created_at);
      if (d) set[d] = true;
    }
  }
  return Object.keys(set).sort();
}

/**
 * 取某一天的对话原文（跨会话聚合，时间升序）。只解析可能含该天的会话文件。
 * @returns {{day, msgs, lines, chars, stats}}
 */
function readDay(baseDir, dayKey, opts) {
  const o = opts || {};
  const roles = Array.isArray(o.roles) && o.roles.length ? o.roles : DEFAULT_ROLES;
  const maxChars = Math.max(0, Math.floor(Number(o.maxMsgChars) || DEFAULT_MAX_MSG_CHARS));
  const dedupe = o.dedupe !== false;
  const skip = Array.isArray(o.skipPatterns) && o.skipPatterns.length ? o.skipPatterns : SKIP_PATTERNS;
  const idx = o.index || getIndex(baseDir);

  const raw = [];
  const stats = {
    day: dayKey,
    rawCount: 0,
    rawChars: 0,
    scannedFiles: 0,
    parsedFiles: 0,
    parsedBytes: 0,
    skippedFiles: 0,
    excludedSessions: 0,        // 本应解析但被归档/删除排除的会话数
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

  // 与 getIndex 内同款读取（归档列表动态，量极小），用于可观测「本应解析但被排除的会话数」
  stats.excludedSessions = Object.keys(loadExcludedSids(baseDir)).length;

  for (const e of idx) {
    stats.scannedFiles++;
    if (!mayContain(e, dayKey)) { stats.skippedFiles++; continue; }
    const arr = readMessages(e.file);       // 一次只解析一个文件，用完即弃
    stats.parsedFiles++;
    stats.parsedBytes += e.size;
    for (const m of arr) {
      if (!m || typeof m !== "object") continue;
      if (localDayOf(m.time || m.created_at) !== dayKey) continue;
      raw.push({
        role: String(m.role || ""),
        time: String(m.time || m.created_at || ""),
        id: m.id ? String(m.id) : "",
        content: String(m.content == null ? "" : m.content),
        session: e.sid,
      });
    }
    arr.length = 0;                          // 尽快释放，避免大数组堆积把 RSS 顶上去
  }

  for (const m of raw) { stats.rawCount++; stats.rawChars += m.content.length; }

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
    m.content = c;
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
  getIndex: getIndex,
  listDays: listDays,
  readDay: readDay,
};
