// 导入对话（记忆页）：把客户端导出的 txt 对话解析后存入独立检索池
// 不进对话时间线，只参与检索（context_search / 词云）
"use strict";

const fs = require("fs-extra");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "imported_conversations.json");

function load() {
  try {
    const raw = fs.readJsonSync(FILE);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function save(list) {
  fs.ensureDirSync(DATA_DIR);
  fs.writeJsonSync(FILE + ".tmp", list, { spaces: 2 });
  fs.renameSync(FILE + ".tmp", FILE);
}

function list() {
  return load().map(function (r) {
    return { id: r.id, name: r.name, imported_at: r.imported_at, count: (r.messages || []).length };
  });
}

// 检索池用：拍平成消息列表，带 record_id / msg_id
function getMessages() {
  const out = [];
  for (const r of load()) {
    const msgs = Array.isArray(r.messages) ? r.messages : [];
    for (let i = 0; i < msgs.length; i++) {
      out.push(Object.assign({}, msgs[i], { record_id: r.id, msg_id: r.id + "#" + (i + 1) }));
    }
  }
  return out;
}

// 中文时间 -> UTC ISO（按服务器时区 Asia/Shanghai，即 UTC+8）
function cnTimeToISO(y, mo, d, h, mi, sec) {
  try {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +(sec || 0)));
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  } catch (e) {
    return null;
  }
}

function mapRole(speaker) {
  const s = String(speaker || "").trim();
  if (/谢意行|assistant|ai|bot/i.test(s)) return "assistant";
  return "user";
}

// 解析 txt：按 --- 分段；每段首行 "YYYY年M月D日 HH:mm:ss · 说话人"，其余为正文
// 识别不出时间/说话人的整块按"一条无时间消息"处理
function parseTxt(content) {
  const warnings = [];
  const messages = [];
  let raw = String(content || "").replace(/\r\n/g, "\n");
  raw = raw.replace(/\n\s*-{3,}\s*$/, ""); // 去掉末尾分隔线
  const blocks = raw.split(/\n\s*-{3,}\s*\n/).map(function (b) { return b.trim(); }).filter(Boolean);

  let noHeader = 0;
  let emptyBody = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    let header = "";
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      header = t;
      headerIdx = i;
      break;
    }
    const bodyLines = lines.slice(headerIdx + 1);
    while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    const body = bodyLines.join("\n").trim();

    const hm = header.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:·|-|:|,)?\s*(.*)$/);
    let time = null;
    let speaker = "";
    let msgBody = "";
    if (hm) {
      time = cnTimeToISO(hm[1], hm[2], hm[3], hm[4], hm[5], hm[6]);
      speaker = (hm[7] || "").trim();
      msgBody = body;
      if (!msgBody) { emptyBody++; continue; } // 只有时间行没有正文，跳过
    } else {
      noHeader++;
      msgBody = block; // 整块作为内容
    }
    messages.push({
      role: mapRole(speaker),
      speaker: speaker,
      time: time,
      content: msgBody
    });
  }
  if (noHeader > 0) warnings.push(noHeader + " 段没识别出时间格式，已按无时间消息导入（仍可检索）");
  if (emptyBody > 0) warnings.push(emptyBody + " 段只有时间没有正文，已跳过");
  if (messages.length === 0) warnings.push("没有解析出任何消息，请检查内容格式");
  return { messages: messages, warnings: warnings };
}

function add(opts) {
  const parsed = parseTxt(opts && opts.content);
  const rec = {
    id: "imp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
    name: String((opts && opts.name) || "").trim() || ("导入对话 " + new Date().toISOString().slice(0, 10)),
    imported_at: new Date().toISOString(),
    messages: parsed.messages
  };
  const list = load();
  list.push(rec);
  save(list);
  invalidateDedupeCache();
  return { id: rec.id, count: parsed.messages.length, preview: parsed.messages.slice(0, 5), warnings: parsed.warnings };
}

function remove(id) {
  const list = load();
  const next = list.filter(function (r) { return r.id !== id; });
  if (next.length === list.length) return false;
  save(next);
  invalidateDedupeCache();
  return true;
}


// ========================
// 内容去重：相似度 >=90% 的重复消息沉底，检索不出现（保留最先导入的那条）
// ========================
const DEDUPE_SIMILARITY = 0.9;
const DEDUPE_MIN_CHARS = 30;
const DEDUPE_GRAM = 5;
const DEDUPE_GRAM_LIST_CAP = 120;
const DEDUPE_CANDIDATE_CAP = 200;
const DEDUPE_CACHE_MS = 300000;
let dedupeCache = { at: 0, hidden: null, total: 0 };

function normForDedupe(content) {
  return String(content || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "")
    .replace(/\s+/g, "");
}

function gramSetOf(norm, k) {
  const set = new Set();
  if (norm.length < k) { if (norm) set.add(norm); return set; }
  for (let i = 0; i <= norm.length - k; i++) set.add(norm.slice(i, i + k));
  return set;
}

function jaccardSim(a, b) {
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;
  for (const g of small) if (big.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function computeHiddenDuplicates() {
  const msgs = getMessages();
  const hidden = new Set();
  // 1) 精确重复：归一化文本一致
  const exactSeen = new Map();
  for (const m of msgs) {
    const n = normForDedupe(m.content);
    if (!n || n.length < DEDUPE_MIN_CHARS) continue;
    if (exactSeen.has(n)) { hidden.add(m.msg_id); continue; }
    exactSeen.set(n, m.msg_id);
  }
  // 2) 近重复：5-gram Jaccard >= 0.9（只和没被隐藏的比，保留更早那条）
  const active = [];
  for (const m of msgs) {
    if (hidden.has(m.msg_id)) continue;
    const n = normForDedupe(m.content);
    if (!n || n.length < DEDUPE_MIN_CHARS) continue;
    active.push({ msg_id: m.msg_id, grams: gramSetOf(n, DEDUPE_GRAM) });
  }
  const inverted = new Map(); // gram -> [activeIndex]
  const dupOf = new Map();    // activeIndex -> representative msg_id
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (dupOf.has(i)) continue;
    const shared = new Map(); // activeIndex -> shared gram count
    for (const g of a.grams) {
      const list = inverted.get(g);
      if (!list) continue;
      for (const j of list) {
        if (j === i || dupOf.has(j)) continue;
        if (!shared.has(j) && shared.size >= DEDUPE_CANDIDATE_CAP) continue;
        shared.set(j, (shared.get(j) || 0) + 1);
      }
    }
    for (const [j, cnt] of shared) {
      const b = active[j];
      const minShared = Math.ceil(DEDUPE_SIMILARITY * Math.min(a.grams.size, b.grams.size));
      if (cnt < minShared) continue;
      if (jaccardSim(a.grams, b.grams) >= DEDUPE_SIMILARITY) dupOf.set(j, a.msg_id);
    }
    for (const g of a.grams) {
      if (!inverted.has(g)) inverted.set(g, []);
      const list = inverted.get(g);
      if (list.length < DEDUPE_GRAM_LIST_CAP) list.push(i);
    }
  }
  const hiddenSet = new Set(hidden);
  for (const j of dupOf.keys()) hiddenSet.add(active[j].msg_id);
  return { hidden: hiddenSet, total: hiddenSet.size };
}

// 返回需要隐藏的重复 msg_id 集合（带缓存；导入/删除后失效）
function getHiddenDuplicateMsgIds() {
  const now = Date.now();
  if (!dedupeCache.hidden || now - dedupeCache.at > DEDUPE_CACHE_MS) {
    const r = computeHiddenDuplicates();
    dedupeCache = { at: now, hidden: r.hidden, total: r.total };
    console.log("[imported-conversations] 检索池去重完成：隐藏 " + r.total + " 条重复内容");
  }
  return dedupeCache.hidden;
}

function invalidateDedupeCache() {
  dedupeCache = { at: 0, hidden: null, total: 0 };
}

module.exports = { list: list, getMessages: getMessages, parseTxt: parseTxt, add: add, remove: remove, getHiddenDuplicateMsgIds: getHiddenDuplicateMsgIds, hiddenDuplicateCount: function () { return getHiddenDuplicateMsgIds().size; }, invalidateDedupeCache: invalidateDedupeCache };
