"use strict";
// Benchmark llm 通道（D3-2 正式达标跑）：与 memory-admission.js 内置 defaultCallLLM 同款实现
// （role=memory_admit，temperature 0.1 / max_tokens 2048 / json_object / 45s 超时）——考的就是生产裁判；
// 生产通道参数若变更，此处需同步。用法：--callLLM benchmark/call-llm-prod.js
async function callLLM(prompt) {
  const { provider, model } = require("../model-router").resolveRoleModel("memory_admit");
  const apiUrl = provider && (provider.api_url || provider.base_url);
  const apiKey = provider && provider.api_key;
  if (!apiUrl || !apiKey || !model) throw new Error("模型未配置（role=memory_admit：请在设置里给「记忆准入」选模型或启用默认供应商）");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1, max_tokens: 2048, response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("LLM HTTP " + resp.status);
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("LLM 空响应");
    return String(content);
  } finally { clearTimeout(timer); }
}
module.exports = { callLLM };
