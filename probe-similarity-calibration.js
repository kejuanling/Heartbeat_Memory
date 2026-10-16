'use strict';
// 相似门槛离线校准（2026-10-04）
//
// 目的：为 memory-admission 新权重 0.4×词面 + 0.1×语义 定一个合理的入选门槛。
// 背景：旧权重 0.55词面+0.25语义 满分 0.8，门槛 0.28（相对 35%）。
//       新权重满分降到 0.5，0.28 相当于相对 56% —— 可能过严或过松，要用真实数据说话。
//
// 只读：读 memory_v2.json + memory_v2_vectors.json，不写任何业务数据。
// 输出：各门槛下「新记忆平均召回几条相似」+「库内随机两条的分数分布」（噪声基线）

const fs = require('fs-extra');
const path = require('path');
const ROOT = process.env.PROBE_ROOT || '/opt/dylan-heartbeat';

const POOL = path.join(ROOT, 'data', 'memory_v2.json');
const VECS = path.join(ROOT, 'data', 'memory_v2_vectors.json');

// 新权重（用户 1004 拍板）
const W_LIT = 0.4;
const W_SEM = 0.1;
const MAX_FULL = 0.5; // 0.4 + 0.1

const { tokenize, similarity } = require(path.join(ROOT, 'context-v2-adapter'));

function main() {
  const pool = fs.readJsonSync(POOL).filter(e => e && e.status === 'active' && String(e.text || '').trim());
  const vecMap = fs.readJsonSync(VECS);

  console.log('活跃记忆: ' + pool.length + ' 条');
  console.log('权重: 词面 ' + W_LIT + ' + 语义 ' + W_SEM + '（满分 ' + MAX_FULL + '）\n');

  // 预先算好每条的词面分（对每一对都要算）
  const tokens = pool.map(e => tokenize(String(e.text || '')));

  // 1) 噪声基线：库内随机两条的混合分分布（判断门槛是否低于噪声）
  const pairScores = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const lit = similarity(tokens[i], String(pool[j].text || ''));
      const sem = getSem(pool[i].id, pool[j].id, vecMap);
      const score = (sem == null) ? W_LIT * lit : (W_LIT * lit + W_SEM * sem);
      pairScores.push(score);
    }
  }
  pairScores.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  console.log('=== 噪声基线：库内任意两条记忆的混合分（' + pairScores.length + ' 对）===');
  console.log('  median ' + q(pairScores, 0.5).toFixed(3)
    + ' | p75 ' + q(pairScores, 0.75).toFixed(3)
    + ' | p90 ' + q(pairScores, 0.9).toFixed(3)
    + ' | p95 ' + q(pairScores, 0.95).toFixed(3)
    + ' | p99 ' + q(pairScores, 0.99).toFixed(3)
    + ' | max ' + pairScores[pairScores.length - 1].toFixed(3));

  // 2) 真实召回：每条作为 query，看能召回几条
  console.log('\n=== 各门槛下：每条新记忆平均召回几条相似 ===');
  const gates = [0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.28];
  const header = ['门槛', '平均条数', '中位条数', '最多条数', '召不满20的占比'];
  console.log(header.map(h => h.padEnd(14)).join(''));
  gates.forEach(g => {
    const counts = [];
    pool.forEach((q1, i) => {
      let n = 0;
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const lit = similarity(tokens[i], String(pool[j].text || ''));
        if (lit < 0.1) continue; // 沿用词面硬门槛
        const sem = getSem(pool[i].id, pool[j].id, vecMap);
        const score = (sem == null) ? W_LIT * lit : (W_LIT * lit + W_SEM * sem);
        if (score >= g) n++;
      }
      counts.push(Math.min(n, 20));
    });
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const sorted = counts.slice().sort((a, b) => a - b);
    const capped = counts.filter(c => c >= 20).length;
    console.log(
      String(g.toFixed(2)).padEnd(14)
      + avg.toFixed(1).padEnd(14)
      + String(sorted[Math.floor(sorted.length / 2)]).padEnd(14)
      + String(Math.max.apply(null, counts)).padEnd(14)
      + (capped / counts.length * 100).toFixed(1) + '%'
    );
  });

  // 3) 高分对抽样：0.16 门槛下召回最多的，看召回的是不是真重复
  console.log('\n=== 门槛 0.16 下的高分对抽样（人工判断是否真相似）===');
  const samples = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const lit = similarity(tokens[i], String(pool[j].text || ''));
      if (lit < 0.1) continue;
      const sem = getSem(pool[i].id, pool[j].id, vecMap);
      const score = (sem == null) ? W_LIT * lit : (W_LIT * lit + W_SEM * sem);
      if (score >= 0.16) samples.push({ score, a: pool[i], b: pool[j] });
    }
  }
  samples.sort((x, y) => y.score - x.score);
  console.log('共 ' + samples.length + ' 对达到 0.16\n');
  console.log('--- 最高 8 对 ---');
  samples.slice(0, 8).forEach(s => {
    console.log('  ' + s.score.toFixed(3) + '\n    A: ' + String(s.a.text).slice(0, 60)
      + '\n    B: ' + String(s.b.text).slice(0, 60));
  });
  console.log('\n--- 0.16~0.18 之间 5 对（门槛边缘，最容易误判）---');
  samples.filter(s => s.score >= 0.16 && s.score < 0.18).slice(0, 5).forEach(s => {
    console.log('  ' + s.score.toFixed(3) + '\n    A: ' + String(s.a.text).slice(0, 60)
      + '\n    B: ' + String(s.b.text).slice(0, 60));
  });
  console.log('\n--- 0.28 以上对数（沿用旧门槛的话只召回这些）---');
  console.log('  ' + samples.filter(s => s.score >= 0.28).length + ' 对');
}

function getSem(idA, idB, vecMap) {
  const va = vecMap && vecMap[idA] && vecMap[idA].v;
  const vb = vecMap && vecMap[idB] && vecMap[idB].v;
  if (!Array.isArray(va) || !Array.isArray(vb)) return null;
  let dot = 0;
  for (let i = 0; i < va.length && i < vb.length; i++) dot += va[i] * vb[i];
  return Math.max(0, dot);
}

main();
