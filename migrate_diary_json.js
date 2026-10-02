#!/usr/bin/env node
'use strict';
// ============================================================
// 日记迁移：一个日记一个文件 → data/diary.json（2026-10-03）
// 用法：
//   node migrate_diary_json.js           # dry-run：只扫描对比，不动盘
//   node migrate_diary_json.js --apply   # 正式迁移：
//     1) 生成 data/diary.json（id 按创建顺序 1..N，hidden 并入字段）
//     2) diary/ 改名 diary_legacy/（旧文件保留可回滚）
//     3) data/diary_versions/<relKey> 改名 d<id>
// ============================================================

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname);
const APPLY = process.argv.includes("--apply");

const { getDatePartsInTimeZone, resolveTimeZone } = require("./time_utils");
const TIME_ZONE = resolveTimeZone();
const DIARY_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:_(\d{4,6})(?:-(\d+))?)?\.md$/i;
const SESSION_DIR_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- 1. 扫描 diary/（根 + 会话子目录一层）----------
function scanDiary() {
  const out = [];
  const scan = (session) => {
    const abs = session ? path.join(ROOT, "diary", session) : path.join(ROOT, "diary");
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { return; }
    for (const name of names) {
      const full = path.join(abs, name);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isFile() && DIARY_FILE_RE.test(name)) {
        const rel = session ? session + "/" + name : name;
        out.push({ rel, session: session || null, name, full });
      } else if (st.isDirectory() && !session && SESSION_DIR_RE.test(name)) {
        scan(name);
      }
    }
  };
  scan(null);
  return out;
}

// ---------- 排序键：日期 / 时分秒(补6位) / -N 序 / rel ----------
function sortParts(f) {
  const m = f.name.match(DIARY_FILE_RE);
  let t = (m && m[1]) || "";
  if (t.length === 4) t = t + "00";   // HHMM → HHMM00
  t = (t || "000000").padEnd(6, "0");
  const n = (m && m[2]) ? Number(m[2]) : 0;
  return { d: f.name.slice(0, 10), t, n, rel: f.rel };
}

// ---------- 文件名本地时间 → UTC ISO（枚举时区偏移校验，兼容任意配置时区）----------
function localToUtcIso(d, t, n) {
  const h = Number(t.slice(0, 2)), mi = Number(t.slice(2, 4)), s = Number(t.slice(4, 6)) + n;
  const Y = Number(d.slice(0, 4)), M = Number(d.slice(5, 7)), D = Number(d.slice(8, 10));
  const targetMs = Date.UTC(Y, M - 1, D, h, mi, s);
  for (let off = -720; off <= 840; off += 15) {
    const u = new Date(targetMs - off * 60000);
    const p = getDatePartsInTimeZone(u, TIME_ZONE);
    if (+p.year === Y && +p.month === M && +p.day === D && +p.hour === h && +p.minute === mi && +p.second === s) {
      return u.toISOString();
    }
  }
  return new Date(targetMs - 8 * 3600e3).toISOString(); // fallback 固定 +8
}

// ---------- hidden 清单 ----------
function readHidden() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "diary_hidden.json"), "utf8"));
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch (e) { return new Set(); }
}

// ---------- 主流程 ----------
function main() {
  const files = scanDiary();
  const hidden = readHidden();
  files.sort((a, b) => {
    const ka = sortParts(a), kb = sortParts(b);
    const row = [ka.d, ka.t, String(ka.n).padStart(3, "0"), ka.rel];
    const rob = [kb.d, kb.t, String(kb.n).padStart(3, "0"), kb.rel];
    const sa = row.join("|"), sb = rob.join("|");
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const entries = files.map((f, i) => {
    const sp = sortParts(f);
    const content = fs.readFileSync(f.full, "utf8");
    const isHidden = hidden.has(f.rel) || (!f.session && hidden.has(f.name));
    return {
      id: i + 1,
      session: f.session,
      hidden: isHidden,
      created_at: localToUtcIso(sp.d, sp.t, sp.n),
      content: String(content),
      _rel: f.rel,
    };
  });

  const hiddenCount = entries.filter((e) => e.hidden).length;
  console.log("模式:", APPLY ? "APPLY" : "dry-run");
  console.log("扫描日记文件:", files.length, "| 隐藏命中:", hiddenCount);
  console.log("时区:", TIME_ZONE);
  console.log("\nid 清单（创建顺序）:");
  entries.forEach((e) => {
    console.log(
      "  #" + String(e.id).padStart(3, " "),
      e.created_at,
      e.session ? ("[" + e.session + "]") : "[共享]",
      e.hidden ? "(隐藏)" : "      ",
      e._rel,
      "(" + e.content.length + "字符)"
    );
  });

  // 版本目录盘点
  const verRoot = path.join(ROOT, "data", "diary_versions");
  let verDirs = [];
  try { verDirs = fs.readdirSync(verRoot); } catch (e) {}
  const relToId = {};
  entries.forEach((e) => { relToId[e._rel.replace(/\//g, "__")] = e.id; });
  const verMapped = verDirs.filter((d) => relToId[d]);
  const verOrphan = verDirs.filter((d) => !relToId[d]);
  console.log("\n版本目录:", verDirs.length, "| 可迁移:", verMapped.length, "| 孤儿(rel已不存在):", verOrphan.length);
  if (verOrphan.length) console.log("  孤儿:", verOrphan.join(", "));

  if (!APPLY) {
    console.log("\n[dry-run] 未动盘。确认无误后加 --apply 执行。");
    return;
  }

  // ---- APPLY 1：写 diary.json ----
  const store = {
    version: 1,
    next_id: entries.length + 1,
    entries: entries.map((e) => ({
      id: e.id, session: e.session, hidden: e.hidden, created_at: e.created_at, content: e.content,
    })),
  };
  const jp = path.join(ROOT, "data", "diary.json");
  const tmp = jp + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, jp);
  console.log("\n已写入 data/diary.json（" + entries.length + " 篇）");

  // ---- APPLY 2：版本目录改名 d<id> ----
  let verMoved = 0;
  for (const d of verMapped) {
    const from = path.join(verRoot, d);
    const to = path.join(verRoot, "d" + relToId[d]);
    if (fs.existsSync(to)) { console.log("  版本目标已存在，跳过:", to); continue; }
    fs.renameSync(from, to);
    verMoved++;
  }
  console.log("版本目录已迁移:", verMoved);

  // ---- APPLY 3：diary/ → diary_legacy/ ----
  const legacy = path.join(ROOT, "diary_legacy");
  if (fs.existsSync(legacy)) throw new Error("diary_legacy/ 已存在，请先处理");
  fs.renameSync(path.join(ROOT, "diary"), legacy);
  console.log("diary/ 已改名 diary_legacy/（旧文件保留，可回滚）");
  console.log("\n迁移完成。");
}

main();
