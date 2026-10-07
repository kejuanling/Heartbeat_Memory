"use strict";

// ========================
// Judge Adapter（C6）——Admission 流程中唯一允许 LLM 的模块（16.txt 契约）
// 边界：只判「候选 × 既有」的关系并可选产出合并文本；不写任何文件；不 require
// state_executor / memory-v2 / 旧记忆模块；不改 admission 决策（本模块对调用方只给建议）。
// 输出（0928 扩展四键；1007 加分类建议）：{ relation, confidence, reason, merged_text, suggested_kind, suggested_kind_reason }
//   relation ∈ duplicate | update | contradiction | coexist | need_review
//   merged_text：duplicate/update 时 LLM 合并后的唯一记忆文本（可空→调用方回退原行为）；
//                coexist/need_review 时恒为 null
// 双实现：
//   judgeMock —— 确定性桩：规范化相等/子集包含 → duplicate（merged_text=更全侧）；其余 need_review
//   judgeLLM  —— 真实接口（B prompt，16.txt §四）：callLLM 由调用方注入（依赖注入，
//                本模块不发真实网络请求）；非法输出重试 1 次 → need_review 兜底
// ========================

// 1004-04：contradiction 从禁用改为可用（0928 起一直被提示词挡住）。
// 用户判断"矛盾"是需要人工看的关键信号（例：「她喜欢红心木瓜」vs「她不爱吃木瓜」不是 update，是矛盾）。
const RELATIONS = ["duplicate", "update", "contradiction", "coexist", "need_review"];
const VOLATILITIES = ["stable", "volatile", "situational"];

function normalizeText(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[「」『』"'""'']/g, "")
    .trim();
}

// ---- mock：确定性桩（judge_mode=mock 时使用） ----
function judgeMock(candidateText, existingText) {
  const c = normalizeText(candidateText);
  const e = normalizeText(existingText);
  const M = (relation, conf, reason) => ({ relation, confidence: conf, relation_reason: reason,
    worth: null, worth_reason: null, volatility: null, volatility_reason: null, merged_text: null,
    suggested_kind: null, suggested_kind_reason: null });
  if (!c || !e) return M("need_review", 0.5, "mock：空输入无法判定");
  if (c === e) return M("duplicate", 1, "mock：规范化后完全一致");
  if (e.includes(c) || c.includes(e)) {
    const fuller = c.length >= e.length ? "候选" : "既有";
    return M("duplicate", 0.9, `mock：子集/全量包含（${fuller}侧更全）`);
  }
  return M("need_review", 0.5, "mock：无语义判定能力，转人工/llm");
}

// ---- B prompt（16.txt §四原则：无角色扮演、固定判断顺序、封闭词表、一句 reason、单行 JSON）----
// 提示词页配置（2026-09-19）：data/judge_prompt.json 存自定义模板（占位符
// ${existing_kind}/${existing_text}/${candidate_kind}/${candidate_text}），不配置走内置组装（行为不变）。
const fs = require("fs");
const path = require("path");
const JUDGE_PROMPT_FILE = path.join(__dirname, "data", "judge_prompt.json");

// ---- B prompt（1004 改造：judge 退化为「只提供信息的人」）----
// 1004-04 用户拍板：
//  ① 五个关系全部开放（含 contradiction，0928 起一直被禁用），每个都要给理由
//  ② 额外输出两个纯信息字段：worth（值不值得长期记）+ volatility（会不会过时）
//  ③ 不再生成 merged_text——命中相似一律进待审，合并交人工在待审页对照决定
//  ④ 保留 1002 起在管理台累积的细化规则（更大清单/子项不判 duplicate、update 必须有可定位新旧信号）
const JUDGE_TEMPLATE_DEFAULT =
  "你是记忆评估器。给定一条【候选】记忆和一条【既有】记忆，输出三组判断：关系、长期价值、时效性。只输出规定结论。\n" +
  "判断顺序：1) 主体是否一致；2) 表述形态是否同类——原话（带引号/说话人/口语语气）与转述（第三人称概括/事实陈述/带解读）是两种形态，一边原话一边转述=不同分层，直接判 coexist；3) 同形态下是否同一条：逐字相同，或候选完整复述了既有那条并把它并入更大的事实集合；4) 候选是否有时间/否定/变更信号；5) 两边对同一件事的说法是否冲突。\n" +
  "关系定义：\n" +
  "- duplicate=同主体同谓语同值，且表述形态同类（同为原话或同为转述）；或候选是既有的全量扩展版（完整复述既有那条一遍，再并列更多同层事实）。候选若是更大清单/集合，而既有只是其中一个子项，不判duplicate。只有同主体、同谓语、同值、同形态的一条对一条，才可 duplicate。\n" +
  "- update=同主体同谓语且值随时间变化（候选文本必须含时间/否定/变更词）。仅当候选包含可定位的新旧信号，且明确指向\"现在/之后/最近一次\"时，才判 update。无法确定新旧先后，必须 need_review。\n" +
  "- contradiction=两条对同一件事给出明确冲突的说法（如喜欢 vs 不喜欢、去过 vs 没去过），两条都可能成立、需要人工决定以哪个为准。有冲突就该选它，不要因为分不清新旧而退回 need_review。\n" +
  "- coexist=以下任一：①多条独立原话的拼合 vs 其中单条（拼合只是容器，每一句都是独立记忆，子项各自保留）；②一边是原话、另一边是转述/概括/带解读（同一内容的不同分层）；③主体相同但讲的是不同事。\n" +
  "- need_review=无法归入以上任一关系（跨主体、证据不足、形态混合、表述含糊到判不出讲的是不是一回事）。\n" +
  "对照示例：\n" +
  "- 既有「他每天早起跑步，坚持了三年」/ 候选「他作息规律：每天早起跑步坚持三年；晚上十一点前睡；周末爬山」→ duplicate（同为转述；候选完整复述了既有那条并扩展成清单）\n" +
  "- 既有「小林：'这首歌我单曲循环了一整天。'」/ 候选「小林：'这首歌我单曲循环了一整天。' 小林：'演唱会门票抢到了。' 小林：'下次带朋友一起来。'」→ coexist（多条独立原话的拼合，既有那条是其中的独立子项，各自保留）\n" +
  "- 既有「他说'我不吃香菜'——饮食上很固执，点菜时要注意」/ 候选「他：'我不吃香菜。'」→ coexist（带解读的完整记忆 vs 其中的裸引原话，不同分层）\n" +
  "价值判断（只针对【候选】这条记忆本身，与【既有】无关，即使没有相似也要判断）：\n" +
  "- worth=这条候选值得长期保留吗（0 到 1 的小数）：0.9-1.0 长期稳定且会反复影响互动（性格、长期偏好、约定、边界、底线）；0.6-0.9 有用但不一定常触发（作息习惯、饮食偏好、说话风格；以及值得记住的具体事 event——做过的东西、重要经历、之后聊天还可能引用的一次性事件）；0.3-0.6 偏事实记录，保留价值有限（普通单次细节、一般事实记录）；0-0.3 不该进长期记忆（当日状态、临时情绪、吃喝琐事、无信息量的聊天碎片）。\n" +
  "- volatility 三选一：stable=不会随时间改变（性格、喜好、长期模式）；volatile=会随时间改变但当前描述仍成立（住址、在读状态、当前作息、当前关系阶段）；situational=一次性事件或具体情境——先分清两类：值得记住的具体事（event：做过的东西、重要时刻、之后还可能被聊到、能引用的信息）仍应入库，worth 按上面的 event 档给；纯粹一次性琐事（吃喝、寒暄、某天偶然发生的小事、某次对话的细碎细节）才判本不该进长期记忆库。\n" +
  "分类建议（1007 加，只建议不操作）：suggested_kind 判断【候选】这条的分类是否与内容实质相符——fact=稳定事实（偏好/经历/双方之间的稳定事实）；rule=规则、边界、承诺、交互约定（\"以后不要……\"\"记住……\"这类）；event=具体发生过的一件事或做出来的东西（做过的东西、重要经历、之后聊天还可能引用的一次性事件）。分类相符填 null（不用换）；觉得不符就建议改成 fact/rule/event 之一；若候选没有分类（为空），必须给出一个 suggested_kind 建议，在 fact/rule/event 中选最接近的并说明理由。suggested_kind_reason 一句话说明为什么建议换（只有 suggested_kind 非 null 时才写）。\n" +
  "约束：只依据给定文本判定，不臆测文本之外的信息；字面包含关系本身不构成 duplicate 的充分理由（先检查形态与分层）；禁止输出规定词之外的词；merged_text 恒输出 null（合并由人工决定，机器不做合并）；三个 reason 各只写一句话。\n" +
  '输出单行 JSON：{"relation":"duplicate|update|contradiction|coexist|need_review","confidence":0到1的小数,"relation_reason":"一句话","worth":0到1的小数,"worth_reason":"一句话","volatility":"stable|volatile|situational","volatility_reason":"一句话","merged_text":null,"suggested_kind":null,"suggested_kind_reason":null}\n' +
  "【既有】（${existing_kind}）：${existing_text}\n" +
  "【候选】（${candidate_kind}）：${candidate_text}";

function loadJudgeTemplate() {
  try {
    const cfg = JSON.parse(fs.readFileSync(JUDGE_PROMPT_FILE, "utf-8"));
    if (cfg && typeof cfg.template === "string") return cfg.template.trim();
  } catch (_) { /* 缺失/坏损用内置 */ }
  return "";
}

function saveJudgeTemplate(t) {
  const template = String(t == null ? "" : t).trim();
  fs.mkdirSync(path.dirname(JUDGE_PROMPT_FILE), { recursive: true });
  fs.writeFileSync(JUDGE_PROMPT_FILE + ".tmp", JSON.stringify({ template }, null, 2), "utf-8");
  fs.renameSync(JUDGE_PROMPT_FILE + ".tmp", JUDGE_PROMPT_FILE);
  return template;
}

function getJudgePromptConfig() {
  const custom = loadJudgeTemplate();
  return { custom, default_template: JUDGE_TEMPLATE_DEFAULT, effective: custom || JUDGE_TEMPLATE_DEFAULT };
}

function interpolateJudgeTemplate(tpl, candidateText, existingText, meta = {}) {
  return String(tpl)
    .replace(/\$\{existing_kind\}/g, meta.existingKind ? String(meta.existingKind) : "")
    .replace(/\$\{existing_text\}/g, String(existingText == null ? "" : existingText))
    .replace(/\$\{candidate_kind\}/g, meta.candidateKind ? String(meta.candidateKind) : "")
    .replace(/\$\{candidate_text\}/g, String(candidateText == null ? "" : candidateText));
}

function buildPrompt(candidateText, existingText, meta = {}) {
  const custom = loadJudgeTemplate();
  if (custom) return interpolateJudgeTemplate(custom, candidateText, existingText, meta);
  // 2026-10-01 单源收敛：兜底组装直接复用 JUDGE_TEMPLATE_DEFAULT（此前这里有一份独立硬编码文案，
  // 与常量双副本并存——改常量不动这里等于没改，benchmark 实测抓到）。富 kind 信息（status）保留。
  // 1007：subject 删除，不再拼进 kind 串。
  const ek = meta.existingKind ? `${meta.existingKind}/${meta.existingStatus || ""}` : "";
  const ck = meta.candidateKind ? `${meta.candidateKind}` : "";
  return interpolateJudgeTemplate(JUDGE_TEMPLATE_DEFAULT, candidateText, existingText, {
    existingKind: ek, candidateKind: ck,
  });
}

// ---- 输出解析（严格：relation 必须在枚举内、confidence 必须是 0-1 数字，否则判非法）----
function parseJudgeOutput(raw) {
  if (raw == null) return { ok: false, error: "空输出" };
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { obj = JSON.parse(m[0]); } catch (_2) { /* 保持 null */ }
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "无法解析为 JSON" };
  if (!RELATIONS.includes(obj.relation)) return { ok: false, error: "relation 非法: " + obj.relation };
  const conf = Number(obj.confidence);
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) return { ok: false, error: "confidence 缺失或非法: " + obj.confidence };
  // 1004-04：worth / volatility 降级处理——LLM 没给或给了非法值时不阻断判定，
  // 只置 null（待审页面对应位置不显示），其余字段照常可用。
  const worth = (obj.worth == null || obj.worth === "") ? null : Number(obj.worth);
  const worthOk = (worth != null && Number.isFinite(worth) && worth >= 0 && worth <= 1);
  const vol = String(obj.volatility == null ? "" : obj.volatility).trim();
  const volOk = VOLATILITIES.indexOf(vol) >= 0;
  // merged_text：1004 起判重不再自动合并，恒为 null（保留字段仅供契约兼容）
  // 1007：suggested_kind 分类建议（只建议不操作）——枚举 fact|rule|event|null，非法/缺失降级 null
  const sk = String(obj.suggested_kind == null ? "" : obj.suggested_kind).trim();
  const skOk = sk === "" || sk === "null" || ["fact", "rule", "event"].indexOf(sk) >= 0;
  const suggested_kind = (skOk && sk !== "" && sk !== "null") ? sk : null;
  const suggested_kind_reason = suggested_kind ? String(obj.suggested_kind_reason || "").slice(0, 200) : null;
  return {
    ok: true,
    relation: obj.relation,
    confidence: conf,
    // 1004：reason 拆成两个——relation_reason 与 worth/volatility 各自的 why
    relation_reason: String(obj.relation_reason || obj.reason || "").slice(0, 200),
    worth: worthOk ? Math.round(worth * 100) / 100 : null,
    worth_reason: worthOk ? String(obj.worth_reason || "").slice(0, 200) : null,
    volatility: volOk ? vol : null,
    volatility_reason: volOk ? String(obj.volatility_reason || "").slice(0, 200) : null,
    merged_text: null,
    suggested_kind: suggested_kind,
    suggested_kind_reason: suggested_kind_reason,
  };
}

// ---- llm 实现（callLLM 注入：async (prompt, attempt) => raw 字符串）----
async function judgeLLM(candidateText, existingText, opts = {}) {
  const call = opts.callLLM;
  if (typeof call !== "function") {
    return { relation: "need_review", confidence: 0.5, relation_reason: "llm 通道未配置（callLLM 缺失），转人工", worth: null, worth_reason: null, volatility: null, volatility_reason: null, merged_text: null, suggested_kind: null, suggested_kind_reason: null };
  }
  const prompt = buildPrompt(candidateText, existingText, opts.meta || {});
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = null;
    try {
      raw = await call(prompt, attempt);
    } catch (err) {
      lastErr = "callLLM 异常: " + (err && err.message ? err.message : err);
      continue;
    }
    const parsed = parseJudgeOutput(raw);
    if (parsed.ok) {
      return { relation: parsed.relation, confidence: parsed.confidence, relation_reason: parsed.relation_reason,
               worth: parsed.worth, worth_reason: parsed.worth_reason,
               volatility: parsed.volatility, volatility_reason: parsed.volatility_reason, merged_text: null };
    }
    lastErr = parsed.error;
  }
  return { relation: "need_review", confidence: 0.5, relation_reason: "judge 输出两次非法已转人工（" + lastErr + "）",
           worth: null, worth_reason: null, volatility: null, volatility_reason: null, merged_text: null };
}

// ---- 统一入口（恒 async；mock 立即兑现）----
async function judge(candidateText, existingText, opts = {}) {
  const mode = opts.mode || "mock";
  if (mode === "llm") return judgeLLM(candidateText, existingText, opts);
  return judgeMock(candidateText, existingText);
}

module.exports = { judge, judgeLLM, parseJudgeOutput, buildPrompt, normalizeText, RELATIONS, getJudgePromptConfig, saveJudgeTemplate };
