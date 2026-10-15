"use strict";

// 留纸存储（2026-09-12；2026-10-03 改 data/papers.json 单 JSON）。
// 只写、不注入上下文。字段 id（创建顺序递增）/session/title/created_at/content。
const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const { safeSessionToken } = require("./lib/session-token");
const paperStore = require("./lib/paper-store");

// 存储根目录：默认仓库根；测试用 PAPERS_BASE_DIR 指向临时目录，避免碰线上 data/papers.json
function baseDir() { return process.env.PAPERS_BASE_DIR || __dirname; }

const MAX_PAPER_CHARS = 30000; // 单篇软上限：超长截断保护，防止单张纸撑爆管理台列表
const SHARED_TOKEN = "_shared";

// 会话目录名：引用共享 safeSessionToken。本模块语义=空会话返回 ""，由调用方兜底共享层。
function sessionToken(sessionId) {
  return sessionId ? safeSessionToken(String(sessionId)) : "";
}

function timeZone() {
  try { return resolveTimeZone(process.env.TIME_ZONE || ""); } catch (e) { return "Asia/Shanghai"; }
}

function stamp(date) {
  const p = getDatePartsInTimeZone(date || new Date(), timeZone());
  return { date: p.year + "-" + p.month + "-" + p.day, hm: p.hour + ":" + p.minute };
}

// 落一张纸（savePaper）：内容截 3 万字上限；首行标题 +（日期 时间）头。
// 1009-10：留纸全局共享，不再存 session 字段、内容头不注入会话编号
function savePaper(opts) {
  const clean = String((opts && opts.content) || "").trim();
  if (!clean) return { ok: false, error: "内容为空" };
  const body = clean.slice(0, MAX_PAPER_CHARS);
  const title = String((opts && opts.title) || "").trim().slice(0, 100);
  const cleanList = value => (Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,，、;；\n]+/) : []))
    .map(v => String(v || "").trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30).map(v => v.slice(0, 40));
  // 一个 tags 字段统一承载分类、标签和检索词；不强制模型填写。
  const tags = cleanList(opts && opts.tags);
  const category = cleanCategory(opts && opts.category);
  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const s = stamp(now);
    const header = (title ? "# " + title + "\n\n" : "") + "（" + s.date + " " + s.hm + "）\n\n";
    const id = paperStore.addEntry(baseDir(), {
      title, tags, category,
      created_at: nowIso, updated_at: nowIso,
      content: header + body + "\n",
    });
    return { ok: true, id, title, tags, category, chars: body.length, time: s.date + " " + s.hm,
      created_at: nowIso, updated_at: nowIso };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// 全量列表（门户/管理台用）：data/papers.json 全部，id 倒序（最新在前），每张带标题、标签和创建/更新时间
function listPapers(limit) {
  const tz = timeZone();
  const out = paperStore.listEntries(baseDir())
    .slice()
    .sort((a, b) => b.id - a.id)
    .map(e => {
      const p = getDatePartsInTimeZone(new Date(e.created_at), tz);
      return {
        id: e.id, title: e.title || "", tags: Array.isArray(e.tags) ? e.tags : [],
        time: p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute,
        created_at: e.created_at, updated_at: e.updated_at || e.created_at,
        content: String(e.content || "").slice(0, 24000),
      };
    });
  return limit ? out.slice(0, limit) : out;
}

// ───────── 2026-10-16 工具集 v2：分类 / 搜索 / 概览 / 编辑（notebook 工具经网关内部接口调用）─────────
const UNCATEGORIZED = "未分类";

function cleanCategory(value) {
  return String(value == null ? "" : value).trim().slice(0, 40);
}

function cleanTags(value) {
  return (Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,，、;；\n]+/) : []))
    .map(v => String(v || "").trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 30).map(v => v.slice(0, 40));
}

const DATE_HEADER_RE = /^（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）\n\n/;

// 存储正文 = [# 标题\n\n] + （日期 时间）\n\n + 正文。拆开方便追加/覆盖/改标题时保住创建日期头。
function splitHeader(entry) {
  let c = String(entry.content || "");
  const t = String(entry.title || "");
  const titleLine = t ? "# " + t + "\n\n" : "";
  const hadTitleLine = !!titleLine && c.startsWith(titleLine);
  if (hadTitleLine) c = c.slice(titleLine.length);
  const m = DATE_HEADER_RE.exec(c);
  const dateLine = m ? m[0] : "";
  return { hadTitleLine, dateLine, body: c.slice(dateLine.length) };
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function previewOf(entry) {
  return oneLine(splitHeader(entry).body).slice(0, 30);
}

function snippetOf(body, terms) {
  const low = String(body || "").toLowerCase();
  let idx = -1;
  let len = 0;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = t.length; }
  }
  if (idx === -1) return oneLine(body).slice(0, 30); // 命中在标题/标签/分类里
  const from = Math.max(0, idx - 30);
  const to = Math.min(body.length, idx + len + 30);
  return (from > 0 ? "…" : "") + oneLine(body.slice(from, to)) + (to < body.length ? "…" : "");
}

function sortedEntries() {
  return paperStore.listEntries(baseDir()).slice().sort((a, b) => b.id - a.id); // id 倒序 = 最新在前
}

function brief(e, preview) {
  return {
    id: e.id, title: e.title || "", category: e.category || "",
    tags: Array.isArray(e.tags) ? e.tags : [],
    created_at: e.created_at, updated_at: e.updated_at || e.created_at,
    length: String(e.content || "").length, preview,
  };
}

// 目录/筛选/搜索：category 精确匹配（"未分类" = 没填分类的）；q 按空白切词，所有词都要命中（标题/分类/标签/正文）
function queryPapers(opts) {
  const o = opts || {};
  let limit = parseInt(o.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 10;
  if (limit > 50) limit = 50;
  let offset = parseInt(o.offset, 10);
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const category = cleanCategory(o.category);
  const terms = String(o.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  let all = sortedEntries();
  if (category) all = all.filter(e => (e.category || UNCATEGORIZED) === category);
  const snippets = new Map();
  if (terms.length) {
    all = all.filter(e => {
      const body = splitHeader(e).body;
      const hay = [e.title, e.category, (Array.isArray(e.tags) ? e.tags : []).join(" "), body].join("\n").toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
      snippets.set(e.id, snippetOf(body, terms));
      return true;
    });
  }
  const items = all.slice(offset, offset + limit)
    .map(e => brief(e, snippets.has(e.id) ? snippets.get(e.id) : previewOf(e)));
  return { total: all.length, offset, limit, returned: items.length, items };
}

// 不带参数的 notebook list：分类概览 + 最近 5 篇
function categoryOverview() {
  const all = sortedEntries();
  const counts = new Map();
  for (const e of all) {
    const k = e.category || UNCATEGORIZED;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const categories = Array.from(counts, ([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  return { total: all.length, categories, recent: all.slice(0, 5).map(e => brief(e, previewOf(e))) };
}

// 编辑：append（默认）追加 / replace 整篇覆盖；title/category/tags 可单独改。改之前旧版进历史。
function editPaper(opts) {
  const o = opts || {};
  const e0 = paperStore.getEntry(baseDir(), o.id);
  if (!e0) return { ok: false, error: "纸不存在：id=" + o.id };
  const hasContent = typeof o.content === "string" && o.content.trim() !== "";
  const hasTitle = o.title !== undefined && o.title !== null;
  const hasCategory = o.category !== undefined && o.category !== null;
  const hasTags = o.tags !== undefined && o.tags !== null;
  if (!hasContent && !hasTitle && !hasCategory && !hasTags) {
    return { ok: false, error: "没有要改的内容：content / title / category / tags 至少给一个" };
  }
  if (o.mode !== undefined && o.mode !== null && o.mode !== "" && o.mode !== "append" && o.mode !== "replace") {
    return { ok: false, error: "mode 只能是 append 或 replace" };
  }
  const mode = o.mode === "replace" ? "replace" : "append";
  const parts = splitHeader(e0);
  const previousLength = String(e0.content || "").length;
  let body = parts.body;
  if (hasContent) {
    const clean = String(o.content).trim();
    if (mode === "replace") {
      if (clean.length > MAX_PAPER_CHARS) return { ok: false, error: "覆盖内容超过单篇 " + MAX_PAPER_CHARS + " 字上限（当前 " + clean.length + " 字）" };
      body = clean + "\n";
    } else {
      const base = body.replace(/\s+$/, "");
      if (base.length + 2 + clean.length > MAX_PAPER_CHARS) {
        return { ok: false, error: "追加后会超过单篇 " + MAX_PAPER_CHARS + " 字上限（现有 " + base.length + " 字，追加 " + clean.length + " 字）" };
      }
      body = base + "\n\n" + clean + "\n";
    }
  }
  const newTitle = hasTitle ? String(o.title).trim().slice(0, 100) : String(e0.title || "");
  // 只有原来就带「# 标题」行、或这次显式改了标题，才写标题行；老条目没有的不凭空加
  const titleLine = newTitle && (parts.hadTitleLine || hasTitle) ? "# " + newTitle + "\n\n" : "";
  const patch = { content: titleLine + parts.dateLine + body, updated_at: new Date().toISOString() };
  if (hasTitle) patch.title = newTitle;
  if (hasCategory) patch.category = cleanCategory(o.category);
  if (hasTags) patch.tags = cleanTags(o.tags);
  const e = paperStore.updateEntry(baseDir(), e0.id, patch, { reason: hasContent ? mode : "meta" });
  if (!e) return { ok: false, error: "纸不存在：id=" + o.id };
  return {
    ok: true, id: e.id, title: e.title || "", category: e.category || "",
    tags: Array.isArray(e.tags) ? e.tags : [], updated_at: e.updated_at,
    length: String(e.content || "").length, previous_length: previousLength,
    mode: hasContent ? mode : null,
  };
}

module.exports = { savePaper, listPapers, queryPapers, categoryOverview, editPaper };
