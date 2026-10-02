"use strict";

// 留纸存储（2026-09-12；2026-10-03 改 data/papers.json 单 JSON）。
// 只写、不注入上下文。字段 id（创建顺序递增）/session/title/created_at/content。
const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const { safeSessionToken } = require("./lib/session-token");
const paperStore = require("./lib/paper-store");

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
// 2026-10-03：改存 data/papers.json（lib/paper-store），返回 {ok, id, title, chars, time, session}
function savePaper(opts) {
  const clean = String((opts && opts.content) || "").trim();
  if (!clean) return { ok: false, error: "内容为空" };
  const body = clean.slice(0, MAX_PAPER_CHARS);
  const token = sessionToken(opts && opts.sessionId) || SHARED_TOKEN;
  const title = String((opts && opts.title) || "").trim().slice(0, 100);
  try {
    const s = stamp(new Date());
    const header = (title ? "# " + title + "\n\n" : "") + "（" + s.date + " " + s.hm + (token === SHARED_TOKEN ? "" : " · " + token) + "）\n\n";
    const id = paperStore.addEntry(__dirname, {
      session: token === SHARED_TOKEN ? null : token,
      title,
      created_at: new Date().toISOString(),
      content: header + body + "\n",
    });
    return { ok: true, id, title, chars: body.length, time: s.date + " " + s.hm, session: token === SHARED_TOKEN ? null : token };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// 全量列表（门户/管理台用）：data/papers.json 全部，id 倒序（最新在前），每张带 id/session/title/time/摘要
function listPapers(limit) {
  const tz = timeZone();
  const out = paperStore.listEntries(__dirname)
    .slice()
    .sort((a, b) => b.id - a.id)
    .map(e => {
      const p = getDatePartsInTimeZone(new Date(e.created_at), tz);
      return {
        id: e.id, session: e.session, title: e.title || "",
        time: p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute,
        created_at: e.created_at,
        content: String(e.content || "").slice(0, 24000),
      };
    });
  return limit ? out.slice(0, limit) : out;
}

module.exports = { savePaper, listPapers };
