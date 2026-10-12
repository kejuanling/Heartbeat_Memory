'use strict';
// llm_log.js（2026-10-11 新增）
// 每个 LLM 调用点只保留最近 N 次「完整请求 + 完整响应」，用来排查提示词效果和缓存命中（看 usage）。
//
// 用法：把调用点原来的 httpPostJson(url, body, headers, timeout) 换成
//   llmLog.post("调用点名", httpPostJson, url, body, headers, timeout)
// 返回值和异常与原函数完全一致，日志只是旁路。
//
// 约束（都是为了不影响主流程）：
// - 日志失败一律吞掉，只打一行 console.error，绝不抛出
// - 写盘异步，不阻塞请求；同进程内同名调用点串行写，避免裁剪时误删
// - 只记请求体和响应体，不记请求头，所以不会带 API key；url 去掉 query 和账号口令
// - 只删本模块自己写出的、文件名符合格式的日志文件，其它文件一概不碰
//
// 存储：data/llm_logs/<调用点名>/<UTC时间>_<pid>_<序号>.json（data/ 已被 gitignore）
// 配置（可选）：data/llm_log_config.json  {"enabled": true, "keep": 10}；改完 5 秒内生效，不用重启
// 环境变量 LLM_LOG_DIR 可改存储根目录（测试用）

const fs = require("fs");
const path = require("path");

const BASE_DIR = process.env.LLM_LOG_DIR || path.join(__dirname, "..", "data", "llm_logs");
const CONFIG_FILE = process.env.LLM_LOG_CONFIG_FILE || path.join(__dirname, "..", "data", "llm_log_config.json");
const DEFAULT_KEEP = 10;
const MAX_KEEP = 50;
const FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_\d+_\d+\.json$/;

let _cfg = { enabled: true, keep: DEFAULT_KEEP };
let _cfgAt = 0;
function cfg() {
  const now = Date.now();
  if (now - _cfgAt < 5000) return _cfg;
  _cfgAt = now;
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const keep = parseInt(c && c.keep, 10);
    _cfg = {
      enabled: !(c && c.enabled === false),
      keep: keep >= 1 ? Math.min(MAX_KEEP, keep) : DEFAULT_KEEP,
    };
  } catch (e) {
    _cfg = { enabled: true, keep: DEFAULT_KEEP };
  }
  return _cfg;
}

function safeName(name) {
  return String(name || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "unknown";
}

// 字符串尽量解析成对象方便阅读；解析不了就原样存字符串
function parseMaybe(v) {
  if (typeof v !== "string") return v === undefined ? null : v;
  try { return JSON.parse(v); } catch (e) { return v; }
}

function cleanUrl(u) {
  try {
    const x = new URL(String(u));
    x.username = "";
    x.password = "";
    x.search = "";
    x.hash = "";
    return x.toString();
  } catch (e) {
    return String(u || "").split("?")[0];
  }
}

let _seq = 0;
const _chains = new Map(); // 调用点名 -> 写盘 Promise 链

async function writeAndPrune(name, rec, keep) {
  const dir = path.join(BASE_DIR, name);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir mode 不会收紧既有目录；显式 chmod 保证日志树只对属主开放。
  await fs.promises.chmod(BASE_DIR, 0o700);
  await fs.promises.chmod(dir, 0o700);
  _seq = (_seq + 1) % 10000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = stamp + "_" + process.pid + "_" + String(_seq).padStart(4, "0") + ".json";
  const tmp = path.join(dir, ".tmp-" + file);
  await fs.promises.writeFile(tmp, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600);
  const finalPath = path.join(dir, file);
  await fs.promises.rename(tmp, finalPath);
  await fs.promises.chmod(finalPath, 0o600);
  // 只裁剪文件名符合格式的日志，按文件名（时间）升序，删最旧的
  const names = (await fs.promises.readdir(dir)).filter(function (n) { return FILE_RE.test(n); }).sort();
  const extra = names.length - keep;
  for (let i = 0; i < extra; i++) {
    try { await fs.promises.unlink(path.join(dir, names[i])); } catch (e) { /* 另一个进程可能已删，忽略 */ }
  }
}

// 记一条日志。fire-and-forget，永不抛出。
// entry: { t0, url, request, response, status, error, meta }
function record(name, entry) {
  try {
    const c = cfg();
    if (!c.enabled) return;
    const n = safeName(name);
    const e = entry || {};
    const resp = parseMaybe(e.response);
    const rec = {
      name: n,
      time_local: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }),
      time_utc: new Date().toISOString(),
      duration_ms: e.t0 ? Date.now() - e.t0 : null,
      url: cleanUrl(e.url),
      status: e.status === undefined ? null : e.status,
      ok: !e.error && !(typeof e.status === "number" && (e.status < 200 || e.status >= 300)),
      error: e.error ? String((e.error && e.error.message) || e.error) : null,
      model: (parseMaybe(e.request) || {}).model || (resp && resp.model) || null,
      usage: (resp && typeof resp === "object" && resp.usage) || null,
      meta: e.meta || null,
      request: parseMaybe(e.request),
      response: resp,
    };
    const prev = _chains.get(n) || Promise.resolve();
    const next = prev
      .then(function () { return writeAndPrune(n, rec, c.keep); })
      .catch(function (err) { console.error("[llm_log] 写日志失败（已忽略）:", n, err && err.message ? err.message : err); });
    _chains.set(n, next);
    next.then(function () { if (_chains.get(n) === next) _chains.delete(n); });
  } catch (err) {
    try { console.error("[llm_log] 记录失败（已忽略）:", err && err.message ? err.message : err); } catch (e2) { /* ignore */ }
  }
}

// 包装一次 POST：原样透传返回值和异常，旁路记日志。
// fn 可以是返回 {status,text} 的版本，也可以是返回已解析 JSON 的版本（http_json.js）。
async function post(name, fn, url, bodyStr, headers, timeoutMs, meta) {
  const t0 = Date.now();
  let res;
  try {
    res = await fn(url, bodyStr, headers, timeoutMs);
  } catch (e) {
    record(name, { t0: t0, url: url, request: bodyStr, error: e, meta: meta });
    throw e;
  }
  if (res && typeof res === "object" && typeof res.text === "string" && typeof res.status === "number") {
    record(name, { t0: t0, url: url, request: bodyStr, status: res.status, response: res.text, meta: meta });
  } else {
    record(name, { t0: t0, url: url, request: bodyStr, response: res, meta: meta });
  }
  return res;
}

module.exports = { post, record };
