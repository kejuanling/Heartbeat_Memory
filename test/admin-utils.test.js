// 管理台纯函数单测：直接从 admin-mobile.html 提取顶层函数源码执行，
// 保持"单文件部署"前提下仍能给纯逻辑补测试。
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = readFileSync(path.join(__dirname, "..", "admin-mobile.html"), "utf-8");
const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!js) throw new Error("admin-mobile.html 未找到 <script> 块");

function extractFn(name) {
  const start = js.search(new RegExp("function " + name + "\\("));
  if (start < 0) throw new Error("未找到函数 " + name);
  const open = js.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}") { depth--; if (depth === 0) break; }
  }
  return js.slice(start, i + 1);
}

const sandbox = {};
vm.createContext(sandbox);
const src = ["fmtCcNum", "escHtml", "escHtml2", "escJsStr", "ccBuildEmptyNoticeHtml", "ccBuildSummaryStatsHtml"]
  .map(extractFn).join("\n")
  + "\nglobalThis.__utils = { fmtCcNum, escHtml, escHtml2, escJsStr, ccBuildEmptyNoticeHtml, ccBuildSummaryStatsHtml };";
vm.runInContext(src, sandbox);
const { fmtCcNum, escHtml, escHtml2, escJsStr, ccBuildEmptyNoticeHtml, ccBuildSummaryStatsHtml } = sandbox.__utils;

test("fmtCcNum 数字格式化", () => {
  assert.equal(fmtCcNum(0), "0");
  assert.equal(fmtCcNum(9999), "9999");
  assert.equal(fmtCcNum(10000), "1万");
  assert.equal(fmtCcNum(12345), "1.2万");
  assert.equal(fmtCcNum("abc"), "0");
});

test("escHtml 仅转义 & < >", () => {
  assert.equal(escHtml('<a href="x">&'), "&lt;a href=\"x\"&gt;&amp;");
  assert.equal(escHtml(null), "");
});

test("escHtml2 同时转义双引号与单引号", () => {
  assert.equal(escHtml2('<b>"\'&'), "&lt;b&gt;&quot;&#39;&amp;");
});

test("escJsStr 供 onclick 内联安全转义", () => {
  assert.equal(escJsStr("a'b\"c"), "a\\'b&quot;c");
  assert.equal(escJsStr("&<>"), "&amp;&lt;&gt;");
});

test("ccBuildEmptyNoticeHtml 未覆盖区/阈值提示", () => {
  const d = { totalCompressible: 10, config: { compaction_min_messages: 5 } };
  assert.match(ccBuildEmptyNoticeHtml(d, 1, 5), /未触发自动压缩/);
  assert.match(ccBuildEmptyNoticeHtml(d, 1, 5), /10 条消息/);
  assert.match(ccBuildEmptyNoticeHtml(d, 0, 5), /未达压缩阈值/);
  assert.equal(ccBuildEmptyNoticeHtml(d, 0, 0), "");
});

test("ccBuildSummaryStatsHtml 统计条", () => {
  const out = ccBuildSummaryStatsHtml(
    { totalCompressible: 10 },
    { estCompressedChars: 12345, chunkCount: 2, cachedCount: 1, totalChars: 20000 }
  );
  assert.match(out, /1\.2万/);
  assert.match(out, /2<\/b><i>块/);
  assert.match(out, /1<\/b><i>缓存/);
  assert.match(out, /2万/);
});
