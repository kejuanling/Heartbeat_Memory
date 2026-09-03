/**
 * mcp-client.js
 * 自研轻量 MCP 客户端传输层（CommonJS，零外部依赖）。
 * 支持三种协议：
 *  - streamable-http : 标准 MCP Streamable HTTP（JSON-RPC over HTTP，返回结果可能是 JSON 或 SSE）
 *  - custom-jsonrpc : 自定义 HTTP JSON-RPC（如 tools_server/zzf-mcp，单次 POST JSON 返回 JSON）
 *  - stdio          : 本地子进程，通过 stdin/stdout 走 JSON-RPC
 *
 * 目标是让 server.js 网关能作为 MCP 客户端，把外部 MCP 工具暴露给上游大模型。
 */
"use strict";

const { spawn } = require("child_process");

// ---- 轻量 HTTP JSON-RPC 适配 ----
async function httpJsonRpc(url, method, params, { headers = {}, jsonrpcId = Date.now(), timeoutMs = 15000, sessionId = null, onSession = null } = {}) {
  const payload = {
    jsonrpc: "2.0",
    id: jsonrpcId,
    method,
    params: params ?? {}
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reqHeaders = Object.assign(
      { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      headers,
      sessionId ? { "Mcp-Session-Id": sessionId } : {}
    );
    const resp = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const sessId = resp.headers.get("mcp-session-id");
    if (onSession && sessId) onSession(sessId);
    const text = await resp.text();
    // Streamable HTTP 返回 SSE 时，text 是 "data: {...}\n\n" 格式，取最后一个 data
    const jsonText = parseSseOrJson(text);
    let data = JSON.parse(jsonText);

    // 兼容某些实现返回 { result: ... } 而不是顶层 result
    if (data && data.error) {
      const err = new Error(`MCP 错误: ${data.error.message || JSON.stringify(data.error)}`);
      err.code = data.error.code;
      err.data = data.error;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// 解析：可能是纯 JSON，也可能是 SSE 流（多个 data: 行），取最后一条非 [DONE] 的 data
function parseSseOrJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "{}";
  // 判断是否为 SSE 格式（包含 data: 行）
  if (trimmed.includes("data:")) {
    const lines = trimmed.split("\n");
    let lastData = null;
    for (const line of lines) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1] && m[1] !== "[DONE]") lastData = m[1];
    }
    return lastData || "{}";
  }
  return trimmed;
}

// ---- stdio 传输 ----
class StdioMcpTransport {
  constructor({ command, args = [], env = {} }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buffer = "";
    this.pending = new Map(); // id -> {resolve, reject}
    this.nextId = 1;
    this.handlers = {}; // notification 处理器
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (d) => this._onData(d.toString("utf8")));
    this.proc.stderr.on("data", (d) => this._onStderr(d.toString("utf8")));
    this.proc.on("error", (e) => this._rejectAll(e));
    this.proc.on("exit", (code) => this._rejectAll(new Error(`stdio 进程退出 code=${code}`)));
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this._dispatch(msg);
      } catch (e) {
        // 忽略非 JSON 行
      }
    }
  }

  _onStderr(chunk) {
    // 记录 stderr 便于调试，但不需要 break 任何东西
    // console.error("[mcp-stdio stderr]", chunk);
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "MCP error"));
      else resolve(msg.result);
    } else if (msg.method && this.handlers[msg.method]) {
      this.handlers[msg.method](msg.params);
    }
  }

  _rejectAll(err) {
    for (const [, { reject }] of this.pending) reject(err);
    this.pending.clear();
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { jsonrpc: "2.0", id, method, params: params ?? {} };
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
      // 超时保护
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`stdio 请求超时: ${method}`));
        }
      }, 15000);
    });
  }

  close() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch (e) {}
    // 兜底杀进程：部分子进程不因 stdin 关闭而退出（如自带 REPL 的 node 脚本），残留会占资源
    const p = this.proc;
    try { p.kill(); } catch (e) {}
    const killTimer = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, 2000);
    if (killTimer.unref) killTimer.unref();
  }
}

// ---- 统一客户端封装 ----
class McpServerClient {
  constructor(config) {
    this.config = config;
    this.id = config.id;
    this.name = config.name || config.id;
    this.type = config.type || "auto";
    this.url = config.url;
    this.command = config.command;
    this.args = config.args || [];
    this.headers = config.headers || {};
    this.enabled = config.enabled !== false;
    this.transport = null;
    this.tools = [];
    this.connected = false;
    this._initialized = false;
    this.error = null;
    this.sessionId = null;
  }

  async connect() {
    if (this.connected && this._initialized) return;
    const type = this.type;
    if (type === "stdio" || (type === "auto" && this.command)) {
      if (!this.transport) {
        this.transport = new StdioMcpTransport({ command: this.command, args: this.args, env: this.headers.env || {} });
      }
      await this.transport.start();
      await this._initializeStdio();
    } else if (type === "custom-jsonrpc" || type === "streamable-http" || type === "auto") {
      await this._initializeHttp();
    } else {
      throw new Error(`未知 MCP 传输类型: ${type}`);
    }
    this.connected = true;
  }

  async _initializeStdio() {
    const result = await this.transport.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "kelivo-gateway", version: "1.0.0" }
    });
    this._initialized = true;
    try { await this.transport.request("notifications/initialized", {}); } catch (e) {}
  }

  async _initializeHttp() {
    const result = await httpJsonRpc(this.url, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "kelivo-gateway", version: "1.0.0" }
    }, { headers: this.headers, sessionId: this.sessionId, onSession: (s) => { this.sessionId = s; } });
    this._initialized = true;
    try {
      await httpJsonRpc(this.url, "notifications/initialized", {}, { headers: this.headers, sessionId: this.sessionId });
    } catch (e) {}
  }

  async listTools() {
    // 工具清单缓存：loadTools 在每条聊天消息前都会调用（对全部服务器串行 tools/list），
    // 无缓存时每条消息叠加数百 ms 至数秒延迟；清单只在配置变更时清缓存（server.js PUT /admin/mcp/servers 会重建客户端）
    if (this.connected && this._initialized && this._toolsCache) return this._toolsCache;
    if (!this.connected) await this.connect();
    if (this.type === "stdio" || (this.transport instanceof StdioMcpTransport)) {
      const r = await this.transport.request("tools/list", {});
      this.tools = (r && r.tools) || [];
    } else {
      const r = await httpJsonRpc(this.url, "tools/list", {}, { headers: this.headers, sessionId: this.sessionId });
      this.tools = (r && r.result && r.result.tools) || [];
    }
    this._toolsCache = this.tools;
    return this.tools;
  }

  async callTool(name, args = {}) {
    if (!this.connected && this.type !== "stdio") await this.connect();
    try {
      if (this.type === "stdio" || (this.transport instanceof StdioMcpTransport)) {
        return await this.transport.request("tools/call", { name, arguments: args });
      }
      const r = await httpJsonRpc(this.url, "tools/call", { name, arguments: args }, { headers: this.headers, sessionId: this.sessionId });
      if (r && r.result) return r.result;
      if (r && r.error) throw new Error(r.error.message || "调用失败");
      return r;
    } catch (e) {
      // 会话失效（MCP 服务器重启后 Mcp-Session-Id 作废）时复位连接状态触发下次重连，
      // 否则 callTool 会一直报错直到人为改配置/重启 gateway
      const msg = String(e && e.message || e);
      if (/session|404|invalid request/i.test(msg)) {
        this.connected = false;
        this._initialized = false;
        this.sessionId = null;
        this._toolsCache = null;
        console.warn(`[mcp] 客户端 ${this.id} 会话失效，已复位待重连: ${msg}`);
      }
      throw e;
    }
  }

  close() {
    if (this.transport && typeof this.transport.close === "function") this.transport.close();
    this.connected = false;
  }
}

// ---- 加载配置 + 构建客户端 ----
function loadConfig(path = "./mcp-servers.json") {
  const fs = require("fs");
  const raw = fs.readFileSync(path, "utf8");
  const cfg = JSON.parse(raw);
  return (cfg.servers || []).filter((s) => s.enabled !== false);
}

function createClients(configPath) {
  const servers = loadConfig(configPath);
  return servers.map((s) => new McpServerClient(s));
}

// 探测单个 MCP 服务器（连接状态 + 工具清单），用于管理台显示；失败返回 connected:false
async function probeServer(config) {
  const c = new McpServerClient(config);
  try {
    await c.connect();
    const tools = await c.listTools();
    return {
      connected: true,
      tools: (tools || []).map(function (t) { return { name: t.name, description: t.description || "" }; }),
      toolCount: (tools || []).length
    };
  } catch (e) {
    return { connected: false, tools: [], toolCount: 0, error: String((e && e.message) || e) };
  } finally {
    try { c.close(); } catch (e) {}
  }
}

module.exports = {
  McpServerClient,
  createClients,
  loadConfig,
  probeServer,
  StdioMcpTransport,
  httpJsonRpc
};
