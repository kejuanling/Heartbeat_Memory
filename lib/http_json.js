'use strict';
// http_json.js（2026-10-03 新增）
// 给「长提示词 JSON 调用」用的裸 http/https POST。
//
// 为什么不直接用全局 fetch：它的底层 undici 有 300s 的 headersTimeout，
// 上游处理几万字 prompt 常常超过 300s 才吐第一个字节 —— 那种情况下不是我们 abort，
// 是 undici 先抛 UND_ERR_HEADERS_TIMEOUT（memory-distill.js:545-548 实跑踩过）。
//
// 说明：memory-distill.js 与 memory-summary.js 各自有一份同款实现（既有重复）。
// 本文件是第三份的正解形态——新代码只许引这里；那两处是否收敛留给单独一批，
// 不在状态机这一批里动（改它们会碰到蒸馏主链路，风险不划算）。

const http = require("http");
const https = require("https");
const { URL } = require("url");

function httpPostJson(url, bodyStr, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try {
      u = new URL(String(url));
    } catch (e) {
      return reject(new Error("URL 非法: " + url));
    }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + (u.search || ""),
        method: "POST",
        headers: Object.assign({ "Content-Length": Buffer.byteLength(bodyStr) }, headers || {}),
      },
      function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error("HTTP " + res.statusCode + ": " + raw.slice(0, 400)));
          }
          let json;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            return reject(new Error("上游返回非 JSON（HTTP " + res.statusCode + "）：" + raw.slice(0, 400)));
          }
          resolve(json);
        });
      }
    );
    req.setTimeout(timeoutMs || 600000, function () {
      req.destroy(new Error("请求超时（" + (timeoutMs || 600000) / 1000 + "s）"));
    });
    req.on("error", function (err) {
      reject(new Error((err && err.message ? err.message : String(err)) +
        (err && err.code ? " [" + err.code + "]" : "")));
    });
    req.end(bodyStr);
  });
}

module.exports = { httpPostJson };