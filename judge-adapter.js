"use strict";

// ========================
// Judge Adapter（C6）——Admission 流程中唯一允许 LLM 的模块（16.txt 契约）
// 边界：只判「候选 × 既有」的关系并可选产出合并文本；不写任何文件；不 require
// state_executor / memory-v2 / 旧记忆模块；不改 admission 决策（本模块对调用方只给建议）。
// 输出（0928 扩展四键）：{ relation, confidence, reason, merged_text }
//   relation ∈ duplicate | update | contradiction | coexist | need_review
//   merged_text：duplicate/update 时 LLM 合并后的唯一记忆文本（可空→调用方回退原行为）；
//                coexist/need_review 时恒为 null
// 双实现：
//   judgeMock —— 确定性桩：规范化相等/子集包含 → duplicate（merged_text=更全侧）；其余 need_review
//   judgeLLM  —— 真实接口（B prompt，16.txt §四）：callLLM 由调用方注入（依赖注入，
//                本模块不发真实网络请求）；非法输出重试 1 次 → need_review 兜底
// ========================

const RELATIONS = ["duplicate", "update", "contradiction", "coexist", "need_review"];

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
  if (!c || !e) return { relation: "need_review", confidence: 0.5, reason: "mock：空输入无法判定" };
  if (c === e) return { relation: "duplicate", confidence: 1, reason: "mock：规范化后完全一致", merged_text: candidateText };
  if (e.includes(c) || c.includes(e)) {
    const fuller = c.length >= e.length ? "候选" : "既有";
    const merged = c.length >= e.length ? candidateText : existingText;
    return { relation: "duplicate", confidence: 0.9, reason: `mock：子集/全量包含（${fuller}侧更全，落地保留更全一份）`, merged_text: merged };
  }
  return { relation: "need_review", confidence: 0.5, reason: "mock：无语义判定能力，转人工/llm", merged_text: null };
}

// ---- B prompt（16.txt §四原则：无角色扮演、固定判断顺序、封闭词表、一句 reason、单行 JSON）----
// 提示词页配置（2026-09-19）：data/judge_prompt.json 存自定义模板（占位符
// ${existing_kind}/${existing_text}/${candidate_kind}/${candidate_text}），不配置走内置组装（行为不变）。
const fs = require("fs");
const path = require("path");
const JUDGE_PROMPT_FILE = path.join(__dirname, "data", "judge_prompt.json");

const JUDGE_TEMPLATE_DEFAULT =
  "你是记忆关系判定器。判断【候选】与【既有】两条记忆的关系，只输出规定结论。\n" +
  "判断顺序：1) 主体是否一致；2) 是否表达同一件事；3) 值是否相同；4) 候选是否有时间/否定/变更信号。\n" +
  "关系定义：duplicate=同主体同谓语同值（含简版与全量版本）；update=同主体同谓语且值随时间变化（候选文本必须含时间/否定/变更词）；coexist=相似但不同事、或同一内容的不同分层形态；need_review=无法确定（疑似矛盾、跨主体、证据不足时必须选它，这不算失败）。\n" +
  "当关系为 duplicate 或 update 时，必须输出 merged_text（把两条合并成唯一一条记忆文本）：保留两条中仍有效的信息，以候选的更新为准，删去冗余重复措辞，合并后字数不超过较长原条的 1.5 倍；禁止添加原文不存在的事实或推测。关系为 coexist 或 need_review 时，merged_text 输出 null。\n" +
  "约束：只依据给定文本判定；禁止输出规定词之外的词；禁止输出 contradiction（疑似矛盾分不清新旧时输出 need_review）；reason 只写一句话。\n" +
  '输出单行 JSON：{"relation":"duplicate|update|coexist|need_review","confidence":0到1的小数,"reason":"一句话","merged_text":"合并后的文本或null"}\n' +
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
  const ek = meta.existingKind ? `（${meta.existingKind}/${meta.existingSubject || ""}/${meta.existingStatus || ""}）` : "";
  const ck = meta.candidateKind ? `（${meta.candidateKind}/${meta.candidateSubject || ""}）` : "";
  return [
    "你是记忆关系判定器。判断【候选】与【既有】两条记忆的关系，只输出规定结论。",
    "判断顺序：1) 主体是否一致；2) 是否表达同一件事；3) 值是否相同；4) 候选是否有时间/否定/变更信号。",
    "关系定义：duplicate=同主体同谓语同值（含简版与全量版本）；update=同主体同谓语且值随时间变化（候选文本必须含时间/否定/变更词）；coexist=相似但不同事、或同一内容的不同分层形态；need_review=无法确定（疑似矛盾、跨主体、证据不足时必须选它，这不算失败）。",
    "当关系为 duplicate 或 update 时，必须输出 merged_text（把两条合并成唯一一条记忆文本）：保留两条中仍有效的信息，以候选的更新为准，删去冗余重复措辞，合并后字数不超过较长原条的 1.5 倍；禁止添加原文不存在的事实或推测。关系为 coexist 或 need_review 时，merged_text 输出 null。",
    "约束：只依据给定文本判定；禁止输出规定词之外的词；禁止输出 contradiction（疑似矛盾分不清新旧时输出 need_review）；reason 只写一句话。",
    '输出单行 JSON：{"relation":"duplicate|update|coexist|need_review","confidence":0到1的小数,"reason":"一句话","merged_text":"合并后的文本或null"}',
    `【既有】${ek}：${existingText}`,
    `【候选】${ck}：${candidateText}`,
  ].join("\n");
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
  // merged_text：仅 duplicate/update 时有效（coexist/need_review 时 LLM 应给 null，给了也忽略）；
  // 空/缺失 → null（调用方按原行为回退，不阻断判定）
  let merged = null;
  if (obj.merged_text != null && typeof obj.merged_text === "string" && String(obj.merged_text).trim()) {
    merged = String(obj.merged_text).trim().slice(0, 3000);
  }
  return { ok: true, relation: obj.relation, confidence: conf, reason: String(obj.reason || "").slice(0, 200), merged_text: merged };
}

// ---- llm 实现（callLLM 注入：async (prompt, attempt) => raw 字符串）----
async function judgeLLM(candidateText, existingText, opts = {}) {
  const call = opts.callLLM;
  if (typeof call !== "function") {
    return { relation: "need_review", confidence: 0.5, reason: "llm 通道未配置（callLLM 缺失），转人工" };
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
      return { relation: parsed.relation, confidence: parsed.confidence, reason: parsed.reason, merged_text: parsed.merged_text };
    }
    lastErr = parsed.error;
  }
  return { relation: "need_review", confidence: 0.5, reason: `judge 输出两次非法已转人工（${lastErr}）`, merged_text: null };
}

// ---- 统一入口（恒 async；mock 立即兑现）----
async function judge(candidateText, existingText, opts = {}) {
  const mode = opts.mode || "mock";
  if (mode === "llm") return judgeLLM(candidateText, existingText, opts);
  return judgeMock(candidateText, existingText);
}

module.exports = { judge, judgeLLM, parseJudgeOutput, buildPrompt, normalizeText, RELATIONS, getJudgePromptConfig, saveJudgeTemplate };
