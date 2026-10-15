"use strict";

// 2026-10-16：reason 字段 + Notebook Index 注入块（目录行、builder、会话多选 key）。
// 全程临时目录（PAPERS_BASE_DIR），不碰线上 data/papers.json。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papers-idx-"));
process.env.PAPERS_BASE_DIR = tmp;
const papers = require("../../papers");
const paperStore = require("../../lib/paper-store");
const { buildContextBlocks, BLOCK_DEFS } = require("../../context-v2-builder");
const { createSessionCfg } = require("../../lib/session-cfg");

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test("空本子：indexLines 返回 []，builder 不产出 notebook_index", () => {
  assert.deepEqual(papers.indexLines(10), []);
  const r = buildContextBlocks({ notebookLines: papers.indexLines(10) });
  assert.equal(r.blocks.some(b => b.key === "notebook_index"), false);
});

test("reason：保存、单行化、截 200 字、可单独 edit、可被 q 搜到", () => {
  const long = "x".repeat(300);
  const a = papers.savePaper({ title: "排查记录", category: "技术笔记", reason: "  上次\n踩过  \n  这个坑 ", content: "nginx 502 是 upstream 超时" });
  assert.equal(a.ok, true);
  assert.equal(a.reason, "上次 踩过 这个坑");
  assert.equal(paperStore.getEntry(tmp, a.id).reason, "上次 踩过 这个坑");
  const b = papers.savePaper({ title: "长原因", reason: long, content: "正文" });
  assert.equal(paperStore.getEntry(tmp, b.id).reason.length, 200);
  // 只改 reason，不动正文
  const before = paperStore.getEntry(tmp, a.id).content;
  const e = papers.editPaper({ id: a.id, reason: "改个原因" });
  assert.equal(e.ok, true);
  assert.equal(e.reason, "改个原因");
  assert.equal(paperStore.getEntry(tmp, a.id).content, before);
  // 历史里留了旧 reason
  const hist = paperStore.listHistory(tmp, a.id);
  assert.equal(hist[hist.length - 1].paper_reason, "上次 踩过 这个坑");
  assert.equal(hist[hist.length - 1].reason, "meta");
  // q 能搜到 reason
  const q = papers.queryPapers({ q: "改个原因" });
  assert.equal(q.total, 1);
  assert.equal(q.items[0].reason, "改个原因");
  // 什么都不给仍报错，且提示里有 reason
  const none = papers.editPaper({ id: a.id });
  assert.equal(none.ok, false);
  assert.match(none.error, /reason/);
});

test("没有 reason 的老条目：不报错，返回空串", () => {
  const id = paperStore.addEntry(tmp, { title: "旧纸", tags: [], content: "旧纸正文" });
  assert.equal(papers.queryPapers({ q: "旧纸正文" }).items[0].reason, "");
  assert.equal(paperStore.getEntry(tmp, id).reason, "");
});

test("indexLines：<=n 篇用「全部」，>n 篇取最近 n 篇，id 倒序，分类按篇数排", () => {
  const before = paperStore.listEntries(tmp).length; // 前面几个用例已经写了 3 篇
  for (let i = 0; i < 9; i++) {
    papers.savePaper({ title: "岛志" + i, category: "岛志", content: "内容" + i });
  }
  const lines = papers.indexLines(10);
  assert.equal(lines[0], "这是你的笔记本目录，会话建立时的快照，之后新增的可能不在里面。");
  assert.match(lines[1], /^分类：岛志 9 篇｜/);
  assert.match(lines[1], /技术笔记 1 篇/);
  assert.match(lines[1], /未分类 \d+ 篇/);
  assert.equal(lines[2], "最近 10 篇（id｜标题｜分类｜更新日期）：");
  const items = lines.slice(3, 13);
  assert.equal(items.length, 10);
  assert.match(items[0], /^\d+｜岛志8｜岛志｜\d{4}-\d{2}-\d{2}$/);
  const idsDesc = items.map(l => Number(l.split("｜")[0]));
  assert.deepEqual(idsDesc, idsDesc.slice().sort((x, y) => y - x));
  assert.match(lines[lines.length - 1], /notebook action=list/);
  // 总数 <= n：说「全部」
  const small = papers.indexLines(before + 9 + 5);
  assert.match(small[2], /^全部 \d+ 篇/);
});

test("indexLines：无标题显示（无标题），标题超长截 60 字", () => {
  papers.savePaper({ content: "没有标题的一篇" });
  papers.savePaper({ title: "长".repeat(100), content: "长标题" });
  const lines = papers.indexLines(3);
  const items = lines.slice(3, 6);
  assert.ok(items.some(l => l.includes("｜长".repeat(0) + "长".repeat(60) + "｜")));
  assert.ok(items.every(l => !l.includes("长".repeat(61))));
  assert.ok(items.some(l => l.includes("（无标题）")));
});

test("builder：notebook_index 产出带标题的块，排在 starred_dialog 之后、relevant_memories 之前", () => {
  const keys = BLOCK_DEFS.map(d => d.key);
  assert.ok(keys.indexOf("notebook_index") === keys.indexOf("starred_dialog") + 1);
  assert.ok(keys.indexOf("notebook_index") < keys.indexOf("relevant_memories"));
  const r = buildContextBlocks({ starredLines: ["一条标星"], notebookLines: papers.indexLines(10) });
  const order = r.blocks.map(b => b.key);
  assert.ok(order.indexOf("notebook_index") > order.indexOf("starred_dialog"));
  const nb = r.blocks.find(b => b.key === "notebook_index");
  assert.ok(nb.content.startsWith("## Notebook Index\n这是你的笔记本目录"));
  assert.equal(nb.empty, false);
});

test("会话多选：notebook_index 是合法 key，默认不勾", () => {
  const cfg = createSessionCfg(tmp);
  assert.ok(cfg.ALL_INJECT_BLOCKS.includes("notebook_index"));
  assert.ok(!cfg.DEFAULT_INJECT_BLOCKS.includes("notebook_index"));
  const norm = cfg.normalizeInjectBlocks(["core_identity", "notebook_index", "bogus"]);
  assert.ok(norm.includes("notebook_index"));
  assert.ok(!norm.includes("bogus"));
  assert.ok(norm.includes("system_instructions") && norm.includes("state_machine"));
});

test("只改分类/标签/原因不动 updated_at；改正文或标题才更新", async () => {
  const r = papers.savePaper({ title: "日期测试", content: "原文" });
  const t0 = paperStore.getEntry(tmp, r.id).updated_at;
  await new Promise(res => setTimeout(res, 15));
  assert.equal(papers.editPaper({ id: r.id, category: "岛志", reason: "补", tags: ["a"] }).ok, true);
  assert.equal(paperStore.getEntry(tmp, r.id).updated_at, t0);
  await new Promise(res => setTimeout(res, 15));
  assert.equal(papers.editPaper({ id: r.id, content: "补一句" }).ok, true);
  const t1 = paperStore.getEntry(tmp, r.id).updated_at;
  assert.ok(t1 > t0);
  await new Promise(res => setTimeout(res, 15));
  assert.equal(papers.editPaper({ id: r.id, title: "新标题" }).ok, true);
  assert.ok(paperStore.getEntry(tmp, r.id).updated_at > t1);
});

test("「最近」按更新时间排：带旧日期的迁入纸不会因为 id 大就排到最前", () => {
  const old = paperStore.addEntry(tmp, { title: "迁入的旧纸", category: "晨午报", content: "旧", created_at: "2026-07-22T00:00:00.000Z", updated_at: "2026-07-22T00:00:00.000Z" });
  const fresh = papers.savePaper({ title: "刚写的新纸", content: "新" });
  assert.ok(old < fresh.id);
  const newerId = paperStore.addEntry(tmp, { title: "更大id但更旧", content: "x", created_at: "2026-07-23T00:00:00.000Z", updated_at: "2026-07-23T00:00:00.000Z" });
  assert.ok(newerId > fresh.id);
  const o = papers.categoryOverview();
  assert.equal(o.recent[0].id, fresh.id);
  const q = papers.queryPapers({ limit: 50 }).items.map(i => i.id);
  assert.ok(q.indexOf(fresh.id) < q.indexOf(newerId));
  assert.ok(q.indexOf(newerId) < q.indexOf(old));
  const lines = papers.indexLines(50);
  const idx = lines.map(l => l.split("｜")[0]);
  assert.ok(idx.indexOf(String(fresh.id)) < idx.indexOf(String(newerId)));
  assert.ok(papers.listPapers().map(p => p.id).indexOf(fresh.id) < papers.listPapers().map(p => p.id).indexOf(old));
});
