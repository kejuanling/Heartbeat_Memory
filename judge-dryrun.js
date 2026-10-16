'use strict';
// judge 新契约 dry-run（1004-04）：验证 LLM 能否按新提示词返回 worth/volatility + 关系理由
// 只读：只调 LLM，不写任何数据

const { judgeLLM } = require('/opt/dylan-heartbeat/judge-adapter');

async function callLLM(prompt) {
  const { provider, model } = require('/opt/dylan-heartbeat/model-router').resolveRoleModel('memory_admit');
  const base = String(provider.api_url).replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.api_key },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  const j = await r.json();
  if (!j.choices || !j.choices[0]) throw new Error('bad response: ' + JSON.stringify(j).slice(0, 200));
  return j.choices[0].message.content;
}

const CASES = [
  { name: '① 真重复', cand: '她喜欢吃红心木瓜，说不甜', exist: '她喜欢红心木瓜，甜度适中，不太甜' },
  { name: '② 矛盾（检验 contradiction 是否放开）', cand: '她不喜欢吃木瓜，说纤维太多', exist: '她喜欢红心木瓜，甜度适中' },
  { name: '③ 无关（应对 coexist 或 need_review）', cand: '她宿舍是上床下桌', exist: '她无辣不欢，爱吃酸甜辣口味' },
  { name: '④ 无相似占位（走无相似分支时的形态）', cand: '答完话不要再多补一句，问完就停', exist: '（无相似记忆）' },
];

(async () => {
  const out = [];
  for (const c of CASES) {
    const t0 = Date.now();
    let r;
    try {
      r = await judgeLLM(c.cand, c.exist, { callLLM });
    } catch (e) {
      r = { error: (e && e.message) || String(e) };
    }
    out.push({ case: c.name, ms: Date.now() - t0, result: r });
    console.log('===== ' + c.name + ' （' + (Date.now() - t0) + 'ms）=====');
    console.log(JSON.stringify(r, null, 1));
    console.log();
  }
  require('fs').writeFileSync('/tmp/judge-dryrun.json', JSON.stringify(out, null, 1));
  console.log('已存 /tmp/judge-dryrun.json');
})();