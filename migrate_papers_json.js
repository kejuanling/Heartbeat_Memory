#!/usr/bin/env node
"use strict";
// 留纸迁移：papers/<会话目录>/YYYY-MM-DD_HHMM[-N].md → data/papers.json（2026-10-03）
// 用法：node migrate_papers_json.js          # dry-run，只打印不落盘
//       node migrate_papers_json.js --apply  # 正式迁移：
//         1) 写 data/papers.json（id 按创建顺序递增）
//         2) papers/ 改名 papers_legacy/（旧文件保留可回滚）
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PAPERS_DIR = path.join(ROOT, "papers");
const SHARED_TOKEN = "_shared";
const APPLY = process.argv.includes("--apply");

const NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{4})(?:-(\d+))?\.md$/;

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

// 扫描 papers/ 全部会话目录（一层），返回 {rel, session, name, mtimeMs, chars}
function scan() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PAPERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(d.name))
      .map(d => d.name);
  } catch (e) { return out; }
  for (const sess of dirs) {
    const abs = path.join(PAPERS_DIR, sess);
    let names = [];
    try { names = fs.readdirSync(abs); } catch (e) { continue; }
    for (const name of names) {
      if (!NAME_RE.test(name)) continue;
      try {
        const st = fs.statSync(path.join(abs, name));
        if (!st.isFile()) continue;
        const content = fs.readFileSync(path.join(abs, name), "utf8");
        let title = "";
        const tm = content.match(/^#\s*(.+)\n/);
        if (tm) title = tm[1].trim();
        out.push({
          rel: sess + "/" + name, session: sess === SHARED_TOKEN ? null : sess,
          name, title, content,
          mtimeMs: st.mtimeMs, chars: Buffer.byteLength(content),
        });
      } catch (e) {}
    }
  }
  // 排序键：mtime 为主（真实创建时刻），同秒同刻按会话名+文件名兜底
  out.sort((a, b) => (a.mtimeMs - b.mtimeMs)
    || String(a.rel).localeCompare(String(b.rel)));
  return out;
}

function main() {
  const files = scan();
  console.log("扫描留纸文件: %d", files.length);
  if (!files.length) {
    console.log("没有可迁移的留纸");
    if (APPLY) console.log("（papers/ 不存在或无文件，跳过改名）");
    return;
  }
  const hidden = loadJson(path.join(ROOT, "data", "diary_hidden.json"));
  console.log("时区: Asia/Shanghai（created_at 取自文件 mtime，UTC ISO，含秒）\n");
  console.log("id 清单（创建顺序）:");
  files.forEach((f, i) => {
    const id = i + 1;
    const d = new Date(f.mtimeMs);
    const tag = f.session ? "会话 " + f.session : "共享";
    console.log(`  #${String(id).padStart(3, " ")} ${d.toISOString()} [${tag}] ${f.rel} (${f.chars}字节)`);
  });

  if (!APPLY) {
    console.log("\n[dry-run] 未动盘。确认无误后加 --apply 执行。");
    return;
  }

  // ---- APPLY 1：写 data/papers.json ----
  const store = {
    version: 1,
    next_id: files.length + 1,
    entries: files.map((f, i) => ({
      id: i + 1,
      session: f.session,
      title: f.title,
      created_at: new Date(f.mtimeMs).toISOString(),
      content: f.content,
    })),
  };
  const jp = path.join(ROOT, "data", "papers.json");
  const tmp = jp + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, jp);
  console.log("\n已写入 data/papers.json（%d 张纸）", files.length);

  // ---- APPLY 2：papers/ → papers_legacy/ ----
  const legacy = path.join(ROOT, "papers_legacy");
  if (fs.existsSync(legacy)) throw new Error("papers_legacy/ 已存在，请先处理");
  fs.renameSync(PAPERS_DIR, legacy);
  console.log("papers/ 已改名 papers_legacy/（旧文件保留，可回滚）");
  console.log("\n迁移完成。");
}

main();
