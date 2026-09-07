/**
 * mcp-service.js
 * 服务层：把 MCP 服务器工具整合成 OpenAI 兼容的 tools 数组，并执行工具调用。
 *
 * 设计目标（隔离式）：
 *  - server.js 直通转发链路完全不动。
 *  - 本模块独立负责：加载配置、连接 MCP 服务器、工具名冲突处理、把 MCP 工具
 *    转换为 OpenAI 兼容 tools[]、执行 tools/call、把结果扁平化为 markdown 文本。
 *
 * 工具名冲突处理参照 kelivo mcp_tool_service：
 *  - 同名工具用 "server__tool" 改名
 *  - 名字清洗（非 [a-zA-Z0-9_-] 替换为 _，截断 64 字符）
 *  - 首字符非字母/下划线时加 mcp_ 前缀
 */
"use strict";

const { createClients } = require("./mcp-client");

// ---- 工具名清洗（参照 kelivo _sanitizeToolNamePart / _limitToolName）----
function sanitizeNamePart(value, fallback = "tool") {
  let s = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^-+/, "");

  // 高亮：display 里的部分被当作代码块给用户看，这里只清洗工具名本身
  s = s.replace(/[_-]+$/, "");
  return s || fallback;
}

function limitName(name, max = 64) {
  return name.length > max ? name.slice(0, max) : name;
}

function qualifiedToolName(serverName, toolName) {
  const s = sanitizeNamePart(serverName, "mcp");
  const t = sanitizeNamePart(toolName, "tool");
  let name = `${s}__${t}`;
  if (!/^[a-zA-Z_]/.test(name)) name = `mcp_${name}`;
  return limitName(name);
}

// ---- 加载全部工具，转为 OpenAI 兼容 tools[] ----
async function loadTools(serverClients) {
  const routes = []; // { serverId, serverName, tool, exposedName }
  const nameCounts = {};

  for (const client of serverClients) {
    if (!client.enabled) continue;
    try {
      await client.connect();
      const tools = await client.listTools();
      // 服务器级工具白名单：mcp-servers.json 条目配 allowTools: [工具名] 时，
      // 只注入名单内的工具，其余丢弃（防止外部服务器塞一堆没用的工具给模型）
      const allowRaw = client.config && client.config.allowTools;
      const allow = Array.isArray(allowRaw) ? allowRaw.map((n) => String(n)) : null;
      const visible = allow ? tools.filter((t) => allow.indexOf(t.name) >= 0) : tools;
      if (allow && visible.length === 0 && tools.length > 0) {
        console.warn(`[mcp] 服务器 ${client.name} 的 allowTools 白名单未匹配任何工具（服务器共 ${tools.length} 个工具），请检查工具名拼写`);
      }
      visible.forEach((t) => {
        const key = t.name;
        nameCounts[key] = (nameCounts[key] || 0) + 1;
        routes.push({ serverId: client.id, serverName: client.name, tool: t });
      });
    } catch (e) {
      console.warn(`[mcp] 连接失败 ${client.id}: ${e.message}`);
    }
  }

  // 生成唯一 exposedName（参照 kelivo _toolRoutes）
  const usedNames = new Set();
  const result = [];
  for (const route of routes) {
    const conflicted = nameCounts[route.tool.name] > 1;
    const base = conflicted
      ? qualifiedToolName(route.serverName, route.tool.name)
      : route.tool.name;
    let unique = base;
    let counter = 2;
    while (usedNames.has(unique)) {
      unique = `${limitName(base)}_${counter++}`;
    }
    usedNames.add(unique);
    result.push({ ...route, exposedName: unique });
  }

  return result;
}

// ---- 把路由列表转成 OpenAI 兼容 tools[] ----
function toOpenAITools(routes) {
  return routes.map((r) => ({
    type: "function",
    function: {
      name: r.exposedName,
      description: r.tool.description || "",
      parameters: r.tool.inputSchema || { type: "object", properties: {} }
    }
  }));
}

// ---- 执行一个工具调用，扁平化为 markdown 文本 ----
async function callToolByExposedName(serverClients, routes, exposedName, args) {
  const route = routes.find((r) => r.exposedName === exposedName);
  if (!route) {
    return _toolError("tool_not_found", `找不到工具: ${exposedName}`);
  }
  const client = serverClients.find((c) => c.id === route.serverId);
  if (!client) {
    return _toolError("server_unavailable", `服务器不可用: ${route.serverName}`);
  }
  try {
    if (!client.connected) await client.connect();
    const res = await client.callTool(route.tool.name, args || {});
    return _flattenToolResult(res, route);
  } catch (e) {
    return _toolError("tool_call_failed", `${e.message || e}`, route);
  }
}

// ---- 工具返回值扁平化（参照 kelivo _flattenToolResult）----
function _flattenToolResult(res, route) {
  if (!res) return _toolError("empty_result", "工具返回为空", route);
  const content = res.content || [];
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === "text" && c.text) {
      parts.push(c.text);
    } else if (c.type === "image") {
      if (c.url) parts.push(`![](${c.url})`);
      else if (c.data) parts.push(`[图片: ${c.mimeType || "image"}]`);
    } else if (c.type === "resource" && c.text) {
      parts.push(c.text);
    } else if (c.text) {
      parts.push(c.text);
    } else if (c.uri) {
      parts.push(`resource: ${c.uri}`);
    } else {
      try {
        parts.push(JSON.stringify(c));
      } catch (e) {
        parts.push(String(c));
      }
    }
  }
  // 结构化 content（一部分 modern MCP 返回 structuredContent，当 text 缺失时兜底）
  if (parts.length === 0 && res.structuredContent) {
    parts.push(JSON.stringify(res.structuredContent, null, 2));
  }
  const text = parts.join("\n").trim();
  if (res.isError) {
    return _toolError("tool_error", text || "工具执行出错（isError=true）", route);
  }
  return { markdown: text || "[工具无返回内容]" };
}

function _toolError(code, message, route) {
  return {
    markdown: JSON.stringify(
      {
        type: "tool_error",
        error: code,
        message,
        tool: route?.exposedName,
        server: route?.serverName
      },
      null,
      2
    )
  };
}

module.exports = {
  loadTools,
  toOpenAITools,
  callToolByExposedName,
  sanitizeNamePart,
  qualifiedToolName
};
