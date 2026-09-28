"use strict";

// 留纸存储（2026-09-12）：AI 写的故事/梦/随手创作，只写、不注入上下文。
// 按会话分目录：papers/<会话目录>/YYYY-MM-DD_HHMM.md，一次调用/一个记号 = 一张纸；
// 无会话兜底 papers/_shared/。目录命名与 server.js safeSessionToken 同一套规则。
const fs = require("fs");
const path = require("path");
const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const { safeSessionToken } = require("./lib/session-token");

const PAPERS_DIR = path.join(__dirname, "papers");
const MAX_PAPER_CHARS = 30000; // 单篇软上限：超长截断保护，防止单张纸撑爆管理台列表
const SHARED_TOKEN = "_shared";

// 会话目录名：引用共享 safeSessionToken（原手抄副本，0921 R20 收敛漏网）。
// 本模块语义=空会话返回 ""，由调用方兜底 _shared 目录，故这里包一层而非直用。
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

// 校验管理台传入的相对路径：只允许 <会话目录>/YYYY-MM-DD_HHMM[-N].md；非法返回 null
function resolvePaperRelPath(relPath) {
  const s = String(relPath || "").trim().replace(/\\/g, "/");
  const m = s.match(/^([A-Za-z0-9_-]{1,64})\/(\d{4}-\d{2}-\d{2}_\d{4}(?:-\d+)?)\.md$/);
  if (!m) return null;
  const root = path.resolve(PAPERS_DIR);
  const full = path.resolve(root, m[1] + path.sep + m[2] + ".md");
  if (!full.startsWith(root + path.sep)) return null;
  return { rel: m[1] + "/" + m[2] + ".md", session: m[1], fileName: m[2] + ".md", full };
}

// 落一张纸（savePaper）：内容截 3 万字上限，文件名=日期_时分秒.md（同秒追加 -N 序号防覆盖），
// 首行标题 +（日期 时间 · 会话）头。成功返回 {ok, relPath,...}，失败返回 {ok:false, error}
function savePaper(opts) {
  const clean = String((opts && opts.content) || "").trim();
  if (!clean) return { ok: false, error: "内容为空" };
  const body = clean.slice(0, MAX_PAPER_CHARS);
  const token = sessionToken(opts && opts.sessionId) || SHARED_TOKEN;
  const title = String((opts && opts.title) || "").trim().slice(0, 100);
  try {
    const dir = path.join(PAPERS_DIR, token);
    fs.mkdirSync(dir, { recursive: true });
    const s = stamp(new Date());
    const base = s.date + "_" + s.hm.replace(":", "");
    let name = base + ".md", n = 2;
    while (fs.existsSync(path.join(dir, name))) { name = base + "-" + n + ".md"; n++; }
    const header = (title ? "# " + title + "\n\n" : "") + "（" + s.date + " " + s.hm + (token === SHARED_TOKEN ? "" : " · " + token) + "）\n\n";
    fs.writeFileSync(path.join(dir, name), header + body + "\n", "utf-8");
    return { ok: true, relPath: token + "/" + name, title, chars: body.length, time: s.date + " " + s.hm, session: token };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// 全量列表（管理台用）：papers/ 下所有会话目录（含 _shared），每张带 relPath/session/title/摘要
function listPapers(limit) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PAPERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(d.name))
      .map(d => d.name);
  } catch (e) {}
  for (const sess of dirs) {
    const abs = path.join(PAPERS_DIR, sess);
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { continue; }
    for (const name of names.filter(n => /^\d{4}-\d{2}-\d{2}_\d{4}(?:-\d+)?\.md$/.test(n))) {
      try {
        const filePath = path.join(abs, name);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        let content = fs.readFileSync(filePath, "utf-8");
        let title = "";
        const tm = content.match(/^#\s*(.+)\n/);
        if (tm) title = tm[1].trim();
        out.push({
          name, relPath: sess + "/" + name, session: sess === SHARED_TOKEN ? null : sess, title,
          time: (name.slice(0, 10) + " " + name.slice(11, 13) + ":" + name.slice(13, 15)).replace(/-\d+\.md$/, ""),
          updated_at: stat.mtime.toISOString(),
          content: content.slice(0, 24000)
        });
      } catch (e) {}
    }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return limit ? out.slice(0, limit) : out;
}

module.exports = { savePaper, listPapers, resolvePaperRelPath };
