"use strict";
/*
 * context_search LLM 精排 + 无 q 回退最新用户消息 —— 零依赖单元测试
 * 跑法（项目目录下）：node tests/context-rerank/test_context_rerank.js
 * 不依赖 ai-providers.json 内容：LLM 调用全部走注入的 provider/fetchFn。
 */
const assert = require("assert");
const path = require("path");

const rerank = require("../../context-rerank");
const ctxRep = require("../../context-replacements");

let passCount = 0;
let failCount = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passCount++;
    console.log("  PASS " + name);
  } catch (e) {
    failCount++;
    failures.push(name + " :: " + (e && e.message));
    console.log("  FAIL " + name + " :: " + (e && e.message));
  }
}

// 用例数组存箭头函数（构造期不执行），跑的时候才调用
const cases = [];
function t(name, fn) { cases.push({ name: name, fn: fn }); }

// ---- 工具：构造假候选组（形状与 searchContextEnhanced 的 groups 一致）----
function fakeGroup(content, extra) {
  return [{ content: content, time: "2026-09-01T10:00:00Z", role: "user", session: "s_test", source: "timeline", msg_id: "m_" + content.slice(0, 4) }].map(function (x) {
    return Object.assign(x, extra || {});
  });
}
function mockFetch(content, state) {
  state = state || {};
  const fn = async function (url, opts) {
    state.calls = (state.calls || 0) + 1;
    if (state.capture) state.capture(url, opts);
    if (state.throwAlways) throw new Error("模拟网络错误");
    if (state.hangUntilAbort) {
      return new Promise(function (resolve, reject) {
        opts.signal.addEventListener("abort", function () { reject(new Error("aborted")); });
      });
    }
    const seq = Array.isArray(content) ? content[Math.min(state.calls - 1, content.length - 1)] : content;
    return {
      ok: true,
      json: async function () { return { choices: [{ message: { content: seq } }] }; }
    };
  };
  return fn;
}
const PROVIDER = { api_url: "https://prov.example/v1/chat/completions", api_key: "k", model: "test-model" };

// ---- pickRerankProvider ----
t("pickRerankProvider: 默认取 is_default 且 enabled 的供应商", async () => {
  delete process.env.CONTEXT_SEARCH_RERANK_PROVIDER;
  delete process.env.CONTEXT_SEARCH_RERANK_MODEL;
  const p = rerank.pickRerankProvider([
    { id: "a", name: "甲", enabled: true, api_url: "https://a.example/v1", model: "m1" },
    { id: "b", name: "乙", enabled: true, is_default: true, api_url: "https://b.example/v1", model: "m2" }
  ]);
  assert.strictEqual(p.model, "m2");
});
t("pickRerankProvider: disabled / 坏 url / 空 model 的供应商被过滤", async () => {
  delete process.env.CONTEXT_SEARCH_RERANK_PROVIDER;
  const p = rerank.pickRerankProvider([
    { id: "a", enabled: false, is_default: true, api_url: "https://a", model: "m" },
    { id: "b", enabled: true, api_url: "https://b .example/v1", model: "m" },
    { id: "c", enabled: true, api_url: "ftp://c", model: "m" },
    { id: "d", enabled: true, api_url: "https://d.example/v1", model: "" }
  ]);
  assert.strictEqual(p, null);
});
t("pickRerankProvider: env 按 id 覆盖 + env model 覆盖", async () => {
  process.env.CONTEXT_SEARCH_RERANK_PROVIDER = "b";
  process.env.CONTEXT_SEARCH_RERANK_MODEL = "override-model";
  try {
    const p = rerank.pickRerankProvider([
      { id: "a", name: "甲", enabled: true, is_default: true, api_url: "https://a", model: "m1" },
      { id: "b", name: "乙", enabled: true, api_url: "https://b", model: "m2" }
    ]);
    assert.strictEqual(p.model, "override-model");
    assert.strictEqual(p.api_url, "https://b");
  } finally {
    delete process.env.CONTEXT_SEARCH_RERANK_PROVIDER;
    delete process.env.CONTEXT_SEARCH_RERANK_MODEL;
  }
});
t("pickRerankProvider: env 按 name 覆盖", async () => {
  process.env.CONTEXT_SEARCH_RERANK_PROVIDER = "乙";
  try {
    const p = rerank.pickRerankProvider([
      { id: "a", name: "甲", enabled: true, is_default: true, api_url: "https://a", model: "m1" },
      { id: "b", name: "乙", enabled: true, api_url: "https://b", model: "m2" }
    ]);
    assert.strictEqual(p.api_url, "https://b");
  } finally {
    delete process.env.CONTEXT_SEARCH_RERANK_PROVIDER;
  }
});

// ---- parsePickedIds ----
t("parsePickedIds: 纯数组输出", async () => {
  const r = rerank.parsePickedIds('["c01","c03"]', new Set(["c01", "c02", "c03"]));
  assert.deepStrictEqual(r.picked, ["c01", "c03"]);
});
t("parsePickedIds: markdown 代码块 + 数组外废话容忍", async () => {
  const r = rerank.parsePickedIds('好的，结果是 ```json\n["c02"]\n``` 以上', new Set(["c02"]));
  assert.deepStrictEqual(r.picked, ["c02"]);
});
t("parsePickedIds: 非法 id 丢弃、重复去重、保序", async () => {
  const r = rerank.parsePickedIds('["c09","c02","c09","c01"]', new Set(["c01", "c02"]));
  assert.deepStrictEqual(r.picked, ["c02", "c01"]);
});
t("parsePickedIds: 无数组 / JSON 坏 / 非数组 → ok=false", async () => {
  assert.strictEqual(rerank.parsePickedIds("我觉得没有相关的", new Set()).ok, false);
  assert.strictEqual(rerank.parsePickedIds("[c01]", new Set()).ok, false);
  assert.strictEqual(rerank.parsePickedIds('{"a":1}', new Set()).ok, false);
  assert.strictEqual(rerank.parsePickedIds(null, new Set()).ok, false);
});

// ---- rerankGroupsWithLLM：主流程 ----
t("精排正常路径：选中的 id 映射回组下标、非法与重复 id 忽略", async () => {
  const state = {};
  const groups = [fakeGroup("甲"), fakeGroup("乙"), fakeGroup("丙")];
  const r = await rerank.rerankGroupsWithLLM("查询词", groups, {
    pickMax: 5, provider: PROVIDER, fetchFn: mockFetch('["c02","c99","c02"]', state)
  });
  assert.strictEqual(state.calls, 1);
  assert.strictEqual(r.reranked, undefined); // 返回体里没有 reranked 字段，字段在 meta
  assert.deepStrictEqual(r.picked, [1]);
  assert.strictEqual(r.meta.reranked, true);
  assert.strictEqual(r.meta.reranker, "llm");
  assert.strictEqual(r.meta.model, "test-model");
});
t("精排 prompt：包含查询、候选行与 pickMax 上限，Bearer 鉴权头", async () => {
  const state = { capture: null };
  let captured = null;
  state.capture = function (url, opts) { captured = { url: url, opts: opts }; };
  const groups = [fakeGroup("内容一"), fakeGroup("内容二")];
  await rerank.rerankGroupsWithLLM("她问的原话", groups, {
    pickMax: 3, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state)
  });
  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(captured.opts.headers.Authorization, "Bearer k");
  assert.strictEqual(body.model, "test-model");
  assert.strictEqual(body.max_tokens, 1500); // 思考模型思考 token 也计入，太小会挤掉正文
  assert.ok(body.messages[0].content.indexOf("她问的原话") >= 0);
  assert.ok(body.messages[0].content.indexOf("最多挑 3 个") >= 0);
  assert.ok(body.messages[0].content.indexOf("c01 | 2026-09-01T10:00:00Z | user | s_test | 内容一") >= 0);
  assert.strictEqual(body.stream, false);
});
t("第一次输出是废话、第二次合法 → 重试成功（共调 2 次）", async () => {
  const state = {};
  const groups = [fakeGroup("甲"), fakeGroup("乙")];
  const r = await rerank.rerankGroupsWithLLM("q", groups, {
    pickMax: 5, provider: PROVIDER, fetchFn: mockFetch(["我选 c01", '```json\n["c01"]\n```'], state)
  });
  assert.strictEqual(state.calls, 2);
  assert.deepStrictEqual(r.picked, [0]);
});
t("两次输出都无效 → picked=null + baseline + 原因", async () => {
  const state = {};
  const groups = [fakeGroup("甲")];
  const r = await rerank.rerankGroupsWithLLM("q", groups, {
    pickMax: 5, provider: PROVIDER, fetchFn: mockFetch("没有数组的内容", state)
  });
  assert.strictEqual(state.calls, 2);
  assert.strictEqual(r.picked, null);
  assert.strictEqual(r.meta.reranked, false);
  assert.strictEqual(r.meta.reranker, "baseline");
  assert.ok((r.meta.reason || "").indexOf("LLM 输出无效") === 0);
});
t("fetch 持续抛错 → 重试 2 次后回退基线", async () => {
  const state = { throwAlways: true };
  const groups = [fakeGroup("甲")];
  const r = await rerank.rerankGroupsWithLLM("q", groups, {
    pickMax: 5, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state)
  });
  assert.strictEqual(state.calls, 2);
  assert.strictEqual(r.picked, null);
  assert.strictEqual(r.meta.reranker, "baseline");
});
t("LLM 判定全不相关（空数组）→ 回退基线，不返回 0 条结果", async () => {
  const state = {};
  const groups = [fakeGroup("甲")];
  const r = await rerank.rerankGroupsWithLLM("q", groups, {
    pickMax: 5, provider: PROVIDER, fetchFn: mockFetch("[]", state)
  });
  assert.strictEqual(r.picked, null);
  assert.ok((r.meta.reason || "").indexOf("无相关候选") >= 0);
});
t("思考模型：content 为空、reasoning_content 带数组 → 能解析出结果", async () => {
  const groups = [fakeGroup("甲"), fakeGroup("乙")];
  let calls = 0;
  const fetchFn = async function () {
    calls++;
    return { ok: true, json: async function () { return { choices: [{ message: { content: "", reasoning_content: '我看了一下，应该选第一个。答案：["c01"]' } }] }; } };
  };
  const r = await rerank.rerankGroupsWithLLM("q", groups, { pickMax: 5, provider: PROVIDER, fetchFn: fetchFn });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(r.picked, [0]);
  assert.strictEqual(r.meta.reranker, "llm");
});
t("content 与 reasoning_content 都为空 → 按无效输出回退", async () => {
  const groups = [fakeGroup("甲")];
  const fetchFn = async function () {
    return { ok: true, json: async function () { return { choices: [{ message: { content: "", reasoning_content: "" } }] }; } };
  };
  const r = await rerank.rerankGroupsWithLLM("q", groups, { pickMax: 5, provider: PROVIDER, fetchFn: fetchFn });
  assert.strictEqual(r.picked, null);
  assert.strictEqual(r.meta.reranker, "baseline");
});
t("超时 → 回退基线（fetch 挂起直到 abort）", async () => {
  const state = { hangUntilAbort: true };
  const groups = [fakeGroup("甲")];
  const r = await rerank.rerankGroupsWithLLM("q", groups, {
    pickMax: 5, timeoutMs: 50, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state)
  });
  assert.strictEqual(r.picked, null);
  assert.strictEqual(r.meta.reranker, "baseline");
});
t("env CONTEXT_SEARCH_RERANK=0 → 不发请求，reranker=off", async () => {
  process.env.CONTEXT_SEARCH_RERANK = "0";
  try {
    const state = {};
    const r = await rerank.rerankGroupsWithLLM("q", [fakeGroup("甲")], {
      pickMax: 5, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state)
    });
    assert.strictEqual(state.calls, undefined);
    assert.strictEqual(r.picked, null);
    assert.strictEqual(r.meta.reranker, "off");
  } finally {
    delete process.env.CONTEXT_SEARCH_RERANK;
  }
});
t("无候选组 / 查询为空 → 直接回退，不发请求", async () => {
  const state = {};
  const r1 = await rerank.rerankGroupsWithLLM("q", [], { pickMax: 5, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state) });
  const r2 = await rerank.rerankGroupsWithLLM("   ", [fakeGroup("甲")], { pickMax: 5, provider: PROVIDER, fetchFn: mockFetch('["c01"]', state) });
  assert.strictEqual(state.calls, undefined);
  assert.strictEqual(r1.picked, null);
  assert.strictEqual(r2.picked, null);
});

// ---- getLatestUserMessage ----
t("getLatestUserMessage: 取最新一条有正文的 user 消息，跳过 system/assistant/空 user", async () => {
  const timeline = [
    { role: "system", content: "系统提示", id: "s0" },
    { role: "user", content: "第一条", id: "u1", time: "2026-09-01T08:00:00Z" },
    { role: "assistant", content: "回复", id: "a1" },
    { role: "user", content: [{ type: "text", text: "" }], id: "u2" },
    { role: "user", content: "你还记得我为什么放弃那个 TTS 声音吗", id: "u3", time: "2026-09-18T12:00:00Z" }
  ];
  let gotSession = "未调用";
  const r = ctxRep.getLatestUserMessage({}, {
    loadTimeline: function (sid) { gotSession = sid; return timeline; }
  });
  assert.strictEqual(r.content, "你还记得我为什么放弃那个 TTS 声音吗");
  assert.strictEqual(r.msg_id, "u3");
  assert.strictEqual(r.session, null);
  assert.strictEqual(gotSession, undefined);
});
t("getLatestUserMessage: 显式 session 透传给 loader；_session 优先回填", async () => {
  const timeline = [
    { role: "user", content: "跨会话消息", id: "u9", _session: "s_real" }
  ];
  let gotSession = "未调用";
  const r = ctxRep.getLatestUserMessage({ session: "s_query" }, {
    loadTimeline: function (sid) { gotSession = sid; return timeline; }
  });
  assert.strictEqual(gotSession, "s_query");
  assert.strictEqual(r.session, "s_real");
});
t("getLatestUserMessage: 没有 user 消息 → null", async () => {
  const r = ctxRep.getLatestUserMessage({}, { loadTimeline: function () { return [{ role: "assistant", content: "只有AI" }]; } });
  assert.strictEqual(r, null);
  const r2 = ctxRep.getLatestUserMessage({}, { loadTimeline: function () { return "不是数组"; } });
  assert.strictEqual(r2, null);
});

// ---- resolveRerankProvider：顶层形态分发 + 真实文件兜底形状 ----
t("pickProvidersFromConfig: 对象取 providers、数组取自身、坏输入给 null", async () => {
  const list = [{ id: "a", enabled: true, api_url: "https://a", model: "m" }];
  assert.strictEqual(rerank.pickProvidersFromConfig({ providers: list }), list);
  assert.strictEqual(rerank.pickProvidersFromConfig(list), list);
  assert.strictEqual(rerank.pickProvidersFromConfig({}), null);
  assert.strictEqual(rerank.pickProvidersFromConfig(null), null);
});
t("resolveRerankProvider: 真实 ai-providers.json 存在时必须解析出供应商（能抓住顶层分发写反）", async () => {
  const fs = require("fs");
  const file = path.join(__dirname, "..", "..", "ai-providers.json");
  if (!fs.existsSync(file)) {
    console.log("    （本地无 ai-providers.json，跳过）");
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  const viaModule = rerank.pickRerankProvider(rerank.pickProvidersFromConfig(parsed));
  if (rerank.pickProvidersFromConfig(parsed)) {
    // 文件里有 enabled 且合法的供应商时，解析不允许返回 null（此断言曾抓出三元写反）
    assert.notStrictEqual(viaModule, null, "文件内有合法供应商但解析为 null");
    const def = parsed.providers.find(function (p) { return p.is_default; });
    if (def) assert.strictEqual(viaModule.model, def.model);
  }
  const p = rerank.resolveRerankProvider();
  if (p !== null) {
    assert.ok(String(p.api_url).startsWith("http"));
    assert.ok(String(p.model).length > 0);
  }
});

// ---- 跑 ----
(async function main() {
  console.log("context-rerank / getLatestUserMessage 单元测试");
  for (const c of cases) {
    await check(c.name, c.fn);
  }
  console.log("合计 " + cases.length + " 例：PASS " + passCount + " / FAIL " + failCount);
  if (failCount > 0) {
    console.log("失败明细：\n" + failures.join("\n"));
    process.exit(1);
  }
})();
