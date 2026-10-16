'use strict';
// 记忆 worth/volatility 离线探针（2026-10-04，方案 C 第 3 批）
//
// 目的：不改任何业务代码，先量化回答两个问题——
//   1)「这条记忆值不值得永久记」（worth 0-1，LLM 判定）
//   2)「这条记忆会不会过时」（volatility: stable/volatile/situational）
// 用真实全量 active 记忆跑一遍，输出分布报告，供用户拍阈值与卡片呈现方式。
//
// 只读：不写 memory_v2.json，不调任何写接口，不改 schema。
// 输出：data/memory_worth_probe.json（可复跑，支持断点续跑）

const fs = require('fs-extra');
const path = require('path');

const ROOT = process.env.PROBE_ROOT || '/opt/dylan-heartbeat';
const POOL = path.join(ROOT, 'data', 'memory_v2.json');
const OUT = path.join(ROOT, 'data', 'memory_worth_probe.json');
const MODEL_ROLE = 'memory_pool';
const LLM_TIMEOUT_MS = 90000;
// 首轮并发 4 触发 429（账户速率限制），降到 1 并逐条节流
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY) || 1;
const GAP_MS = Number(process.env.PROBE_GAP_MS) || 1200;
const MAX_TEXT = 400;

const SYSTEM = [
  '你是记忆评估器。给定一条记忆，判断它的「长期价值」和「时效性」。只输出单行 JSON，不要任何前言解释。',
  '',
  '【worth 评分】这条记忆值得长期保留吗（0 到 1 的小数）：',
  '- 0.9-1.0：长期稳定且会反复影响互动（性格、长期偏好、约定、边界、底线）',
  '- 0.6-0.9：有用但不一定常触发（作息习惯、饮食偏好、说话风格）',
  '- 0.3-0.6：偏事实记录，保留价值有限（某次具体事件、单次细节）',
  '- 0-0.3：不该进长期记忆（当日状态、临时情绪、无信息量的聊天碎片）',
  '',
  '【volatility 分类】只能是三者之一：',
  '- stable：不会随时间改变（性格、喜好、长期模式）',
  '- volatile：会随时间改变，但当前描述仍然成立（住址、在读状态、当前作息、当前关系阶段）',
  '- situational：一次性事件或具体情境，本不该进长期记忆库（某天发生的事、某次对话的细节）',
  '',
  '判断只依据记忆正文本身，不要臆测正文之外的信息。',
  '输出单行 JSON：{"worth":0到1的小数,"worth_reason":"一句话","volatility":"stable|volatile|situational","volatility_reason":"一句话"}',
].join('\n');

function userPrompt(text, kind, subject, created) {
  return [
    '【记忆条目】',
    '类型：' + (kind || '未标'),
    '主语：' + (subject || '未标'),
    '写入时间：' + (created || '未知'),
    '正文：' + String(text || '').slice(0, MAX_TEXT),
    '',
    '按 system 规定输出单行 JSON。',
  ].join('\n');
}

async function callLlm(user) {
  const router = require(path.join(ROOT, 'model-router'));
  const r = router.resolveRoleModel(MODEL_ROLE);
  if (!r || !r.provider || !r.provider.api_url || !r.model) throw new Error('模型未配置 role=' + MODEL_ROLE);
  const base = String(r.provider.api_url).replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(r.provider.api_key || '') },
      body: JSON.stringify({
        model: r.model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 150));
    const j = await resp.json();
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c || !String(c).trim()) throw new Error('空返回');
    return String(c).trim();
  } finally { clearTimeout(timer); }
}

function parse(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let obj = null;
  try { obj = JSON.parse(s); }
  catch (_) { const m = s.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch (_2) {} } }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '无法解析 JSON' };
  const w = Number(obj.worth);
  if (!Number.isFinite(w) || w < 0 || w > 1) return { ok: false, error: 'worth 非法: ' + obj.worth };
  const v = String(obj.volatility || '');
  if (['stable', 'volatile', 'situational'].indexOf(v) < 0) return { ok: false, error: 'volatility 非法: ' + v };
  return {
    ok: true,
    worth: w,
    worth_reason: String(obj.worth_reason || '').slice(0, 200),
    volatility: v,
    volatility_reason: String(obj.volatility_reason || '').slice(0, 200),
  };
}

async function judgeOne(e) {
  const user = userPrompt(e.text, e.kind, e.subject, e.created_at);
  let lastErr = 'unknown';
  for (let a = 1; a <= 4; a++) {
    try {
      const p = parse(await callLlm(user));
      if (p.ok) return Object.assign({ id: e.id, text: e.text, kind: e.kind, created_at: e.created_at }, p);
      lastErr = p.error;
    } catch (err) {
      lastErr = (err && err.message) || String(err);
      // 429 限流：指数退避，别把请求打爆
      if (/429|1302|rate/i.test(lastErr)) {
        const wait = 3000 * Math.pow(2, a - 1);
        console.log('  限流，等 ' + wait + 'ms 后重试（' + e.id + '）');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }
  }
  return { id: e.id, text: e.text, kind: e.kind, created_at: e.created_at, ok: false, error: lastErr };
}

async function main() {
  const rows = fs.readJsonSync(POOL).filter(e => e && e.status === 'active' && String(e.text || '').trim());
  console.log('待评估 active 记忆:', rows.length);

  let cache = { done: {} };
  if (fs.existsSync(OUT)) { try { cache = fs.readJsonSync(OUT); } catch (_) { cache = { done: {} }; } }
  if (!cache.done) cache.done = {};

  // 只跳过成功过的；失败项要重跑（首轮 175 条全被 429 拒，若按 id 跳过就永远不会重试）
  const todo = rows.filter(r => !(cache.done[r.id] && cache.done[r.id].ok));
  console.log('已跑成功(断点续跑):', rows.length - todo.length, '| 本次待跑:', todo.length);
  if (!todo.length) return finish(cache, rows);

  let done = 0, failed = 0;
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift();
      const r = await judgeOne(e);
      if (r.ok) done++; else failed++;
      cache.done[e.id] = r;
      if ((done + failed) % 10 === 0 || !queue.length) {
        console.log('  进度 ' + (done + failed) + '/' + todo.length + '  失败 ' + failed);
        fs.writeJsonSync(OUT, cache, { spaces: 2 });
      }
      if (queue.length) await new Promise(r => setTimeout(r, GAP_MS));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  console.log('跑完：成功 ' + done + ' / 失败 ' + failed);
  finish(cache, rows);
}

function finish(cache, rows) {
  const all = rows.map(r => cache.done[r.id]).filter(Boolean);
  const ok = all.filter(x => x.ok);
  const bad = all.filter(x => !x.ok);
  console.log('\n===== 覆盖率 =====');
  console.log('总 active: ' + rows.length + ' | 已评估: ' + all.length + ' | 成功: ' + ok.length + ' | 失败: ' + bad.length);
  if (bad.length) console.log('失败样本: ' + bad.slice(0, 3).map(x => x.id + ' → ' + x.error).join(' ; '));
  if (!ok.length) return;

  const ws = ok.map(x => x.worth).sort((a, b) => a - b);
  const q = (p) => ws[Math.min(ws.length - 1, Math.floor(ws.length * p))];
  console.log('\n===== worth 分布 =====');
  console.log('min ' + ws[0].toFixed(2) + ' | p10 ' + q(0.1).toFixed(2) + ' | p25 ' + q(0.25).toFixed(2)
    + ' | median ' + q(0.5).toFixed(2) + ' | p75 ' + q(0.75).toFixed(2) + ' | p90 ' + q(0.9).toFixed(2)
    + ' | max ' + ws[ws.length - 1].toFixed(2));
  console.log('均值 ' + (ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(3));

  const buckets = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]];
  console.log('\n分档（这条最关键——决定阈值有没有区分度）：');
  buckets.forEach(([lo, hi]) => {
    const n = ok.filter(x => x.worth >= lo && x.worth < hi).length;
    console.log('  ' + (hi > 1 ? '0.90-1.00' : lo.toFixed(2) + '-' + hi.toFixed(2)).padEnd(12)
      + String(n).padStart(4) + ' 条  ' + (n / ok.length * 100).toFixed(1) + '%'
      + '  ' + '#'.repeat(Math.round(n / ok.length * 60)));
  });

  console.log('\n===== volatility 分布 =====');
  ['stable', 'volatile', 'situational'].forEach(v => {
    const n = ok.filter(x => x.volatility === v).length;
    console.log('  ' + v.padEnd(13) + String(n).padStart(4) + ' 条  ' + (n / ok.length * 100).toFixed(1) + '%  '
      + '#'.repeat(Math.round(n / ok.length * 60)));
  });

  console.log('\n===== worth × volatility 交叉 =====');
  ['stable', 'volatile', 'situational'].forEach(v => {
    const sub = ok.filter(x => x.volatility === v);
    if (!sub.length) return;
    const line = sub.map(x => x.worth).sort((a, b) => a - b);
    console.log('  ' + v.padEnd(13) + 'n=' + String(sub.length).padStart(3)
      + '  worth中位 ' + line[Math.floor(line.length / 2)].toFixed(2)
      + '  min ' + line[0].toFixed(2) + '  max ' + line[line.length - 1].toFixed(2));
  });

  console.log('\n===== 按创建月份 =====');
  const byMonth = {};
  ok.forEach(x => { const m = String(x.created_at || '').slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  Object.keys(byMonth).sort().forEach(m => console.log('  ' + m + '  ' + byMonth[m] + ' 条'));

  console.log('\n===== worth 最低的 12 条（候选沉底对象） =====');
  ok.slice().sort((a, b) => a.worth - b.worth).slice(0, 12).forEach(x => {
    console.log('  ' + x.worth.toFixed(2) + ' [' + x.volatility + '] ' + String(x.text).slice(0, 56)
      + '\n        理由: ' + x.worth_reason);
  });

  console.log('\n===== volatile 且存最久的 10 条（陈旧高危） =====');
  ok.filter(x => x.volatility === 'volatile')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, 10).forEach(x => {
      console.log('  ' + x.worth.toFixed(2) + ' ' + String(x.created_at || '').slice(0, 10) + ' '
        + String(x.text).slice(0, 56) + '\n        ' + x.volatility_reason);
    });

  console.log('\n===== situational 抽样 12 条 =====');
  ok.filter(x => x.volatility === 'situational').slice(0, 12).forEach(x => {
    console.log('  ' + x.worth.toFixed(2) + ' ' + String(x.text).slice(0, 60));
  });

  console.log('\n完整结果已存: ' + OUT);
}

main().catch(e => { console.error('探针异常: ' + (e && e.stack || e)); process.exit(1); });