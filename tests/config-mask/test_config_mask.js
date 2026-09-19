"use strict";
// maskConfigSecrets 单测（2026-09-20 审查 P1-1 收尾）：GET /admin/config 读出口脱敏。
// 被测函数从 server.js 源文本按括号配对提取（server.js 改动用例自动跟随）。零依赖。
// 运行：node --test tests/config-mask/  （或直接 node 本文件）

const test = require("node:test");
const assert = require("assert");
const nodeFs = require("fs");
const nodePath = require("path");

const SERVER_JS = nodePath.join(__dirname, "..", "..", "server.js");

function extractFunction(src, name) {
  const m = src.match(new RegExp("(?:^|\\n)((?:async )?function " + name + "\\s*\\()"));
  assert.ok(m, "server.js 中找不到 function " + name);
  let i = src.indexOf(m[1], m.index);
  let depth = 0, started = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(src.indexOf(m[1], m.index), i + 1); }
  }
  assert.fail("function " + name + " 大括号未闭合");
}

const src = nodeFs.readFileSync(SERVER_JS, "utf8");
const factory = new Function(
  extractFunction(src, "maskConfigSecrets") + "\nreturn maskConfigSecrets;"
);
const maskConfigSecrets = factory();

test("视觉模型 api_key 置空并附 _set 布尔", () => {
  const cfg = {
    co_vision_api_key: "sk-secret-126chars",
    co_vision_model_id: "m1",
    vision_models: [
      { id: "m1", name: "A", api_key: "sk-abc", model: "glm-4v" },
      { id: "m2", name: "B", api_key: "", model: "glm-4v" }
    ]
  };
  const out = maskConfigSecrets(cfg);
  assert.strictEqual(out.co_vision_api_key, "", "顶层 key 必须置空");
  assert.strictEqual(out.co_vision_api_key_set, true);
  assert.strictEqual(out.co_vision_model_id, "m1", "非敏感字段原样");
  assert.strictEqual(out.vision_models[0].api_key, "", "列表 key 必须置空");
  assert.strictEqual(out.vision_models[0].api_key_set, true);
  assert.strictEqual(out.vision_models[1].api_key, "");
  assert.strictEqual(out.vision_models[1].api_key_set, false, "空 key 的 _set 必须为 false");
  assert.strictEqual(out.vision_models[1].model, "glm-4v");
});

test("无敏感字段时安全通过且不添加误导性 _set", () => {
  const out = maskConfigSecrets({ memory_retrieval_enabled: true, vision_models: [] });
  assert.strictEqual(out.memory_retrieval_enabled, true);
  assert.strictEqual(out.co_vision_api_key_set, undefined, "原 config 无该字段时不加 _set");
  assert.deepStrictEqual(out.vision_models, []);
});

test("入参不被原地修改（深拷贝）", () => {
  const cfg = { co_vision_api_key: "sk-keep", vision_models: [{ id: "m1", api_key: "sk-x" }] };
  const out = maskConfigSecrets(cfg);
  assert.strictEqual(cfg.co_vision_api_key, "sk-keep", "原对象不得被改");
  assert.strictEqual(cfg.vision_models[0].api_key, "sk-x");
  assert.notStrictEqual(out, cfg);
});

test("null/undefined 入参安全", () => {
  assert.deepStrictEqual(maskConfigSecrets(null), {});
  assert.deepStrictEqual(maskConfigSecrets(undefined), {});
});

// 直接运行本文件时也执行
if (require.main === module) {}
