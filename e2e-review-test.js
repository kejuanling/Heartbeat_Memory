'use strict';
// 端到端验证（1004-04）：向真实 admission 提交一条候选，检查：
//   1) action 是否为 review（新逻辑：命中相似一律 review）
//   2) similar 是否列出了多条（新逻辑：取全部候选，不只最高分）
//   3) worth / volatility 是否都有值和理由
//   4) 队列记录落盘结构是否完整（含 judge 字段）
// 注意：这会真实写入待审队列一条测试记录，验证后需用 --clean 清掉。

const ROOT = '/opt/dylan-heartbeat';
const TEST_MARK = '【E2E测试-1004】';

(async () => {
  const { createAdmission } = require(ROOT + '/memory-admission');
  const admission = createAdmission({ config: {} });
  console.log('judge_mode:', admission.judgeMode);

  if (process.argv[2] === '--clean') {
    const fs = require('fs-extra');
    const qf = ROOT + '/data/memory_review_queue.json';
    const q = fs.readJsonSync(qf);
    const before = q.length;
    const kept = q.filter(x => !(x.draft && String(x.draft.text || '').includes(TEST_MARK)));
    fs.writeJsonSync(qf, kept, { spaces: 2 });
    console.log('已清理测试队列记录: ' + before + ' → ' + kept.length);
    return;
  }

  // 用一条与库内记忆高度相似的测试文本，触发"多候选"路径
  const text = TEST_MARK + '她无辣不欢，爱吃酸甜辣口味的菜';
  console.log('提交候选:', text);
  const t0 = Date.now();
  const r = await admission.submitManual(
    { content: text, kind: 'fact', subject: 'user', origin: 'memory_tag' },
    { sessionId: 'e2e-probe' },
    'manual_review'   // R7 通道：judge 会跑，但强制 review
  );
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  console.log('\n=== 1) action ===');
  console.log(r.action, '| why:', r.reason || '(见队列)');

  console.log('\n=== 2) judge_meta ===');
  const jm = r.judge_meta;
  if (!jm) { console.log('❌ 无 judge_meta'); return; }
  console.log('worth:', jm.worth, '|', jm.worth_reason);
  console.log('volatility:', jm.volatility, '|', jm.volatility_reason);
  console.log('similar 条数:', (jm.similar || []).length);
  (jm.similar || []).forEach((s, i) => {
    console.log('  [' + (i + 1) + '] score=' + s.score + ' relation=' + s.relation
      + '\n      text: ' + String(s.text).slice(0, 50)
      + '\n      why: ' + s.relation_reason);
  });

  console.log('\n=== 3) 队列记录落盘 ===');
  const fs = require('fs-extra');
  const q = fs.readJsonSync(ROOT + '/data/memory_review_queue.json');
  const rec = q.find(x => x.draft && String(x.draft.text || '').includes(TEST_MARK));
  if (!rec) { console.log('❌ 队列里找不到测试记录'); return; }
  console.log('queue_id:', rec.id);
  console.log('有 judge 字段:', !!rec.judge);
  if (rec.judge) {
    console.log('  judge.worth:', rec.judge.worth);
    console.log('  judge.volatility:', rec.judge.volatility);
    console.log('  judge.similar 条数:', (rec.judge.similar || []).length);
  }
  console.log('\n✅ 验证完成。清理请跑: node e2e-review-test.js --clean');
})().catch(e => { console.error('异常:', e && e.stack || e); process.exit(1); });