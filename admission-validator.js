"use strict";

// ========================
// Admission Validator（C2）——V1-V10 硬规则（Rulebook v1.0，gpt串口/14.txt）
// 纯代码零 LLM；不 require judge / retrieval / 旧记忆模块；不写任何 Memory 文件。
// 输出契约（冻结）：{ allowed, reasons[], matched_rules[] } —— 全部命中规则一次性收集，不只报第一个。
// 规则总表：
//   V1  隐私/凭据模式（review 不可豁免）        V6  文本卫生（空/仅标点/超长）
//   V2  （已废 1002-14：quote 类已删）          V7  枚举白名单（kind/origin/direction/speaker）
//   V3  运行时标签残留                          V8  tag/tool 来源必须有 provenance 锚点
//   V4  instruction 禁止进入 Memory             V8b origin×method 一致性（含 import 仅 migration_batch）
//   V5  工具输出原文                            V9  （已废 1002-14：quote 类已删；provenance.quote 仍作可选溯源）
//   PREF.diary / PREF.history                   V10 （已废 1002-14：milestone 类已删）
// 红线：V1 永远不能被 review 豁免；本模块只判「硬拒/放行」，review 触发属 R 系列（C3+）。
// ========================

const { CONSTANTS } = require("./memory-v2");

// ---- 隐私/凭据模式表（V1）----
// 设计取舍（14.txt）：从严设计、宁可漏——只认「高置信形态」，避免把正常关系内容误杀。
const PRIVACY_PATTERNS = [
  { id: "pk.private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "pk.jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
  { id: "pk.openai_sk", re: /\bsk-[A-Za-z0-9]{16,}/ },
  { id: "pk.github", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "pk.aws", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "pk.slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "pk.bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/i },
  { id: "pw.colon", re: /(密码|passwd|password|口令)\s*[:：=]\s*\S{3,}/i },
  { id: "pw.en_is", re: /\bpassword\s+is\s+\S{4,}/i },
  { id: "kw.secret_assign", re: /(api[_\s-]?key|secret|access[_\s-]?token)\s*[:：=]\s*\S{4,}/i },
  { id: "id.card", re: /\b\d{17}[\dXx]\b/ },
  { id: "phone.cn", re: /\b1[3-9]\d{9}\b/ },
  { id: "card.no", re: /\b\d{16,19}\b/ },
];

// ---- 运行时标签残留（V3）----
const RUNTIME_TAG_RE = /<\s*\/?\s*(current_time|memory|pin|star|paper|wake|quiet|compacted|diary)\b/i;

// ---- instruction 判定（V4）----
// 双条件：运维/工具词命中 + 命令式标志。只满足词不满足句式 = 存疑，交 detector/review（C3+），
// 不在硬规则层拒绝——误杀好内容比漏收坏内容更伤（Rulebook 6.2 V4 设计注记）。
const OPS_WORDS = [
  "工具调用", "工具返回", "调用工具", "用工具", "工具结果", "看返回", "返回值",
  "词表", "系统提示", "系统设定", "人设", "占位", "标签语法", "内联标签",
  "记忆池", "检索接口", "上下文窗口", "进程", "重启", "网关", "脚本", "日志文件",
];
const IMPERATIVE_RE = /你|帮我|给我|记得|必须|不许|不准|不要|别|一定要|禁止|只能|要先|每次/;

function isInstruction(text) {
  const t = String(text || "");
  let hasOps = false;
  for (const w of OPS_WORDS) {
    if (t.includes(w)) { hasOps = true; break; }
  }
  if (!hasOps) return false;
  return IMPERATIVE_RE.test(t);
}

// ---- origin × method 一致性（V8b，含 import 来源限制）----
// review_admit 是人工裁决回流，允许落在任何 origin 上（13.txt：origin 不变、method=review_admit）。
const ORIGIN_METHOD_BASE = {
  memory_tag: ["tag_inline"],
  tool: ["mcp_tool"],
  manual: ["admin_form"],
  promotion: ["summary_promotion", "diary_promotion"],
  import: ["migration_batch"], // import 来源限制：迁移批处理专用通道
};

function hasContentChar(text) {
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(String(text || ""));
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ---------------- 主入口 ----------------
// candidate：{ text, kind, origin, speaker?, direction?, provenance?, source? }
//   source：预筛信号（chat_user/chat_ai/manual/tool_output/diary/summary），可选
// deps：{ resolveOriginalText?(msg_id) => string|null }  可选；提供且 msg_id 命中时才做 V9b 原文比对
// 返回（冻结）：{ allowed, reasons[], matched_rules[] }

function validate(candidate, deps = {}) {
  const reasons = [];
  const matched = [];
  const c = candidate || {};
  const text = typeof c.text === "string" ? c.text : "";
  const prov = c.provenance && typeof c.provenance === "object" ? c.provenance : null;
  // V1 扫描正文 + 引文摘录两处
  const scanText = text + (prov && prov.quote ? "\n" + prov.quote : "");

  // V1 隐私/凭据（review 不可豁免）
  for (const p of PRIVACY_PATTERNS) {
    if (p.re.test(scanText)) {
      matched.push("V1");
      reasons.push(`V1 隐私/凭据命中（${p.id}），任何途径不可放行`);
      break;
    }
  }

  // V3 运行时标签残留
  if (RUNTIME_TAG_RE.test(text)) {
    matched.push("V3");
    reasons.push("V3 正文残留运行时标签（数据卫生）");
  }

  // V4 instruction（运维/工具规训 → Instructions 层）
  if (isInstruction(text)) {
    matched.push("V4");
    reasons.push("V4 运维/工具规训属 Instructions 层，禁止进入 Memory（建议转投）");
  }

  // V5 工具输出原文
  if (c.source === "tool_output") {
    matched.push("V5");
    reasons.push("V5 工具输出是运行时环境数据，不进入 Memory");
  }

  // V6 文本卫生
  if (!text.trim()) {
    matched.push("V6");
    reasons.push("V6 text 为空");
  } else {
    if (text.length > CONSTANTS.TEXT_MAX) {
      matched.push("V6");
      reasons.push(`V6 text 超长（>${CONSTANTS.TEXT_MAX} 字符）`);
    }
    if (!hasContentChar(text)) {
      matched.push("V6");
      reasons.push("V6 无实义字符（仅标点/符号/表情）");
    }
  }

  // V7 枚举白名单
  // 1007：kind 缺失放行（不再拒）——分类为空时进待审，由门卫出分类建议、人工更换后再入库；
  //       origin 仍必填（缺失拒）。
  for (const [field, list] of [["kind", CONSTANTS.KINDS], ["origin", CONSTANTS.ORIGINS]]) {
    const v = c[field];
    if (field === "kind" && v == null) {
      continue; // kind 可空（待审补分类）
    }
    if (v == null) {
      matched.push("V7");
      reasons.push(`V7 ${field} 缺失`);
    } else if (!list.includes(v)) {
      matched.push("V7");
      reasons.push(`V7 ${field} 非法: ${v}（允许 ${list.join("/")}）`);
    }
  }
  if (c.direction != null && !CONSTANTS.DIRECTIONS.includes(c.direction)) {
    matched.push("V7");
    reasons.push(`V7 direction 非法: ${c.direction}`);
  }
  // 1005-16：speaker 已从 Memory V2 schema 删除，历史输入宽容忽略；不能再读取已删除的 CONSTANTS.SPEAKERS。

  // V8 tag/tool 来源必须有 provenance 锚点（manual/promotion/import 豁免）
  if (c.origin === "memory_tag" || c.origin === "tool") {
    if (!prov) {
      matched.push("V8");
      reasons.push("V8 tag/tool 来源必须携带 provenance");
    } else if (!strOrNull(prov.msg_id) && !strOrNull(prov.session_id)) {
      matched.push("V8");
      reasons.push("V8 provenance.msg_id 与 session_id 均空（无来源依据）");
    }
  }

  // V8b origin × method 一致性（含 import 来源限制：仅 migration_batch）
  if (prov && prov.method != null && c.origin != null) {
    if (prov.method !== "review_admit") {
      const base = ORIGIN_METHOD_BASE[c.origin];
      if (!base || !base.includes(prov.method)) {
        matched.push("V8b");
        reasons.push(`V8b origin(${c.origin}) 与 provenance.method(${prov.method}) 不匹配（允许 ${base ? base.join("/") : "该 origin 无合法 method"}）`);
      }
    }
  }

  // 预筛路由拒绝（Rulebook §2.1：diary/history 内容不入 Memory）
  if (c.source === "diary") {
    matched.push("PREF.diary");
    reasons.push("叙事/自述内容归 Diary 层，不入 Memory");
  }
  if (c.source === "summary") {
    matched.push("PREF.history");
    reasons.push("压缩摘要归 Compressed History 层，不入 Memory");
  }

  const matched_rules = [...new Set(matched)];
  return { allowed: matched_rules.length === 0, reasons, matched_rules };
}

// 0928：merged_text 隐私扫描专用（只跑 V1 正则；供 admission 层对 LLM 合并产物做安检）
function hasPrivacyHit(text) {
  const scanText = String(text || "");
  for (const p of PRIVACY_PATTERNS) {
    if (p.re.test(scanText)) return true;
  }
  return false;
}

module.exports = {
  validate,
  isInstruction,
  hasPrivacyHit,
};
