"use strict";

// 工具集 v2：留纸分类 / 搜索 / 概览 / 编辑（含覆盖前留存上一版）。
// 全程使用临时目录（PAPERS_BASE_DIR），不碰线上 data/papers.json。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papers-v2-"));
process.env.PAPERS_BASE_DIR = tmp;
const papers = require("../../papers");
const paperStore = require("../../lib/paper-store");

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const DATE_LINE = /（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）\n\n/;

function seed() {
  const a = papers.savePaper({ title: "月亮的梦", category: "梦", tags: ["海", "夜"], content: "我梦见在海边捡到一颗会发光的月亮碎片，很安静。" });
  const b = papers.savePaper({ title: "世界观草稿", category: "设定", tags: "城市,雨", content: "这座城市每天下午三点准时下雨。" });
  const c = papers.savePaper({ title: "随手一记", content: "买牛奶" });
  // 老条目：没有 category，正文里也没有「# 标题」头和日期头
  const legacyId = paperStore.addEntry(tmp, { title: "旧纸", tags: [], content: "旧纸正文" });
  return { a: a.id, b: b.id, c: c.id, legacy: legacyId };
}

const ids = seed();

test("savePaper 返回并保存 category", () => {
  const e = paperStore.getEntry(tmp, ids.a);
  assert.equal(e.category, "梦");
  assert.deepEqual(e.tags, ["海", "夜"]);
});

test("categoryOverview：分类计数，没填分类的归「未分类」，最近的在前", () => {
  const o = papers.categoryOverview();
  assert.equal(o.total, 4);
  const byName = Object.fromEntries(o.categories.map(x => [x.name, x.count]));
  assert.deepEqual(byName, { "梦": 1, "设定": 1, "未分类": 2 });
  assert.equal(o.categories[0].name, "未分类"); // 篇数多的在前
  assert.equal(o.recent.length, 4);
  assert.equal(o.recent[0].id, ids.legacy);
  assert.ok(o.recent.every(x => typeof x.preview === "string" && x.preview.length <= 30));
});

test("queryPapers：分类筛选 / 未分类 / 分页", () => {
  assert.equal(papers.queryPapers({ category: "梦" }).total, 1);
  assert.equal(papers.queryPapers({ category: "未分类" }).total, 2);
  const p = papers.queryPapers({ limit: 1, offset: 1 });
  assert.equal(p.returned, 1);
  assert.equal(p.total, 4);
  assert.equal(p.items[0].id, ids.c);
});

test("queryPapers：多个词需同时命中；标签命中也算；命中片段带上下文", () => {
  const r = papers.queryPapers({ q: "海边 月亮" });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].id, ids.a);
  assert.ok(r.items[0].preview.includes("海边"));
  assert.equal(papers.queryPapers({ q: "海边 不存在的词" }).total, 0);
  assert.equal(papers.queryPapers({ q: "雨" }).items[0].id, ids.b); // 标签与正文都含
  assert.equal(papers.queryPapers({ q: "夜" }).items[0].id, ids.a); // 仅标签命中
});

test("editPaper append：保留标题头和创建日期头，旧版进历史，id 不变", () => {
  const before = paperStore.getEntry(tmp, ids.a);
  const r = papers.editPaper({ id: ids.a, content: "后来我醒了。" });
  assert.equal(r.ok, true);
  assert.equal(r.id, ids.a);
  assert.equal(r.mode, "append");
  assert.equal(r.previous_length, before.content.length);
  const after = paperStore.getEntry(tmp, ids.a);
  assert.ok(after.content.startsWith("# 月亮的梦\n\n"));
  assert.match(after.content, DATE_LINE);
  assert.ok(after.content.includes("很安静。") && after.content.includes("后来我醒了。"));
  assert.ok(after.updated_at >= before.updated_at);
  assert.equal(after.created_at, before.created_at);
  const h = paperStore.listHistory(tmp, ids.a);
  assert.equal(h.length, 1);
  assert.equal(h[0].content, before.content);
});

test("editPaper replace：整篇覆盖但保住日期头；上一版可找回", () => {
  const before = paperStore.getEntry(tmp, ids.a);
  const dateLine = DATE_LINE.exec(before.content)[0];
  const r = papers.editPaper({ id: ids.a, mode: "replace", content: "全新的正文" });
  assert.equal(r.ok, true);
  const after = paperStore.getEntry(tmp, ids.a);
  assert.equal(after.content, "# 月亮的梦\n\n" + dateLine + "全新的正文\n");
  const h = paperStore.listHistory(tmp, ids.a);
  assert.equal(h.length, 2);
  assert.equal(h[1].content, before.content);
});

test("editPaper 只改分类/标签：正文不动，历史 reason=meta", () => {
  const before = paperStore.getEntry(tmp, ids.a);
  const r = papers.editPaper({ id: ids.a, category: "随笔", tags: ["a", "b", "a"] });
  assert.equal(r.ok, true);
  assert.equal(r.mode, null);
  const after = paperStore.getEntry(tmp, ids.a);
  assert.equal(after.content, before.content);
  assert.equal(after.category, "随笔");
  assert.deepEqual(after.tags, ["a", "b"]);
  const h = paperStore.listHistory(tmp, ids.a);
  assert.equal(h[h.length - 1].reason, "meta");
  assert.equal(papers.categoryOverview().categories.some(x => x.name === "随笔" && x.count === 1), true);
});

test("editPaper 老条目：追加不凭空加标题头；显式改标题才加", () => {
  const r1 = papers.editPaper({ id: ids.legacy, content: "补一句" });
  assert.equal(r1.ok, true);
  const e1 = paperStore.getEntry(tmp, ids.legacy);
  assert.equal(e1.content, "旧纸正文\n\n补一句\n");
  const r2 = papers.editPaper({ id: ids.legacy, title: "新标题" });
  assert.equal(r2.ok, true);
  const e2 = paperStore.getEntry(tmp, ids.legacy);
  assert.equal(e2.title, "新标题");
  assert.ok(e2.content.startsWith("# 新标题\n\n"));
});

test("editPaper 改标题：标题头同步更新，日期头保留", () => {
  const before = paperStore.getEntry(tmp, ids.b);
  const dateLine = DATE_LINE.exec(before.content)[0];
  const r = papers.editPaper({ id: ids.b, title: "世界观定稿" });
  assert.equal(r.ok, true);
  const after = paperStore.getEntry(tmp, ids.b);
  assert.ok(after.content.startsWith("# 世界观定稿\n\n" + dateLine));
  assert.ok(after.content.includes("准时下雨"));
});

test("editPaper 错误路径：找不到 / 什么都没给 / mode 非法 / 超长不改动", () => {
  assert.equal(papers.editPaper({ id: 99999, content: "x" }).ok, false);
  assert.equal(papers.editPaper({ id: ids.c }).ok, false);
  assert.equal(papers.editPaper({ id: ids.c, content: "x", mode: "prepend" }).ok, false);
  const histBefore = paperStore.listHistory(tmp, ids.c).length;
  const contentBefore = paperStore.getEntry(tmp, ids.c).content;
  const tooLong = papers.editPaper({ id: ids.c, content: "字".repeat(30001) });
  assert.equal(tooLong.ok, false);
  assert.equal(papers.editPaper({ id: ids.c, mode: "replace", content: "字".repeat(30001) }).ok, false);
  assert.equal(paperStore.getEntry(tmp, ids.c).content, contentBefore);
  assert.equal(paperStore.listHistory(tmp, ids.c).length, histBefore);
});

test("历史每篇最多留 20 个版本，留下的是最近的", () => {
  for (let i = 1; i <= 25; i++) assert.equal(papers.editPaper({ id: ids.c, content: "第" + i + "次" }).ok, true);
  const h = paperStore.listHistory(tmp, ids.c);
  assert.equal(h.length, 20);
  const lastPrev = h[h.length - 1].content;
  assert.ok(lastPrev.includes("第24次"));
});

test("listPapers（网页留纸页用）不受影响：仍按 id 倒序、带标题标签", () => {
  const list = papers.listPapers();
  assert.equal(list.length, 4);
  assert.ok(list[0].id > list[1].id);
  assert.ok(Array.isArray(list[0].tags));
});
