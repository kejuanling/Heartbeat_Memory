"use strict";

// ========================
// Candidate Detector（C3）——发现「可能值得记的东西」
// 职责边界（17.txt / 14.txt）：只做候选发现与粗分类，不判断是否进入 Memory（那是
// validator/judge 的事），不写任何文件，不用 LLM，不依赖向量。
// 输入：{ text, source?, explicitKind? }
//   source: chat_user | chat_ai | manual | tool_output | diary | summary
// 输出（冻结）：{ candidate, kind_guess, confidence, reasons[] }
//   kind_guess: fact|rule|diary_only|history_only|unknown（1002-14 删 quote/milestone）
// 规则层级（命中即短路，从强到弱）：来源路由 → 人工显式 → 行为规则
//   → 当日状态(diary) → 流水账(history) → 长篇叙事(diary) → 稳定谓词(fact) → 闲聊兜底
// ========================

const KIND_GUESSES = ["fact", "rule", "diary_only", "history_only", "unknown"];

// 行为规则信号（未来指向）
const FUTURE_RE = /(以后|以后别|以后不要|以后不许|不许|不准|别再|不要再|永远不[要能]|每次(都)?要|只能我|记得要|要记得|答应|保证|承诺)/;
// 自我承诺（认账方向）
const COMMITMENT_RE = /我(答应|保证|承诺|认下了?)|这次我认/;
// 她对我提要求（toward_user 方向）
const HER_DEMAND_RE = /她(说|要求|让|叫|要).{0,8}(不许|不要|别|只能)|不许你|你不要|你别|你只能|我要你/;
// 引用请求 / 引文结构
const QUOTE_REQUEST_RE = /(记住(我|她|他)?(说|讲)?(过|的)?话?|原话|一字不改|记住这句|她说：|她说:)/;
const QUOTED_SPAN_RE = /[「『"][^」』"]{2,}[」』"]/;
// 里程碑：节点词 + 关系上下文双条件（裸「第一次」不足以成里程碑）
const MILESTONE_RE = /(第一次|首次|初次|纪念日|周年|领证|求婚|正式在一起|成为恋人|确立关系)/;
const MILESTONE_CONTEXT_RE = /(我们|我俩|在一起|恋爱|恋人|关系|见面|牵手|亲吻|视频|纪念|领证|结婚)/;
// 当日/短暂状态
const TEMP_TIME_RE = /(今天|今晚|刚才|刚刚|这会儿|此刻|现在|这两天)/;
const TEMP_STATE_RE = /(好累|很累|累了|好困|有点困|困了|想睡|饿了|无聊|心情不好|不开心|好难过|难过|难受|烦躁|头疼|头晕|生病|发烧|感冒|不高兴|委屈|想哭|emo)/;
// 弱确定性 / 近期时限（降 confidence，不改变候选资格）
const HEDGE_RE = /(好像|可能|大概|也许|估计|疑似)/;
const RECENT_RE = /(最近|近来|这阵子)/;
// 稳定谓词（fact 信号）
const FACT_PREDICATE_RE = /(喜欢|讨厌|爱吃|爱喝|爱看|爱听|习惯|总是|从来|从不|过敏|怕黑|怕生|怕冷|怕热|害怕|偏爱|擅长|住在|老家|工作是|学的是|专业是|生日是|甜度|口味|(妈|爸|姐|哥|弟|妹)是)/;
// 流水账：多日期罗列
const DATE_TOKEN_RE = /\d{1,2}月\d{1,2}[日号]/g;

function out(candidate, kind, confidence, reasons) {
  return { candidate, kind_guess: kind, confidence, reasons };
}

function detect(input = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const source = input.source || "chat_user";
  if (!text) return out(false, "unknown", 0, ["空文本"]);

  // 0) 来源路由（与 validator V5/PREF.* 同源，双保险）
  if (source === "tool_output") return out(false, "unknown", 0, ["工具输出不产候选（运行时环境数据）"]);
  if (source === "diary") return out(false, "diary_only", 0.7, ["叙事源直达 Diary 层"]);
  if (source === "summary") return out(false, "history_only", 0.7, ["压缩摘要直达 Compressed History 层"]);

  // 1) 人工/入口显式标记：直接采信（显式判断即隐式准入，validator 仍会复检）
  if (input.explicitKind && KIND_GUESSES.includes(input.explicitKind)) {
    return out(true, input.explicitKind, 0.95, ["入口显式标记 kind=" + input.explicitKind]);
  }

  // 4) 行为规则：未来指向词
  if (FUTURE_RE.test(text)) {
    const conf = HEDGE_RE.test(text) ? 0.5 : 0.7;
    return out(true, "rule", conf, ["未来指向词：「" + (text.match(FUTURE_RE) || []).join("/") + "」（可复用触发条件由 validator/judge 级判定）"]);
  }

  // 5) 当日/短暂状态（diary_only，不产候选）
  if (TEMP_TIME_RE.test(text) && TEMP_STATE_RE.test(text)) {
    return out(false, "diary_only", 0.7, ["当日状态：「" + (text.match(TEMP_STATE_RE) || []).join("/") + "」+ 时限词，留 Working History"]);
  }

  // 6) 流水账：多日期罗列（history_only，不产候选）
  const dates = text.match(DATE_TOKEN_RE) || [];
  if (dates.length >= 2) {
    return out(false, "history_only", 0.7, ["多日期罗列（" + dates.length + " 处）——时间组织内容归 Compressed History"]);
  }

  // 7) 长篇第一人称叙事（diary_only，不产候选）
  const selfMentions = (text.match(/我/g) || []).length;
  if (text.length >= 200 && selfMentions >= 5) {
    return out(false, "diary_only", 0.5, ["长篇第一人称叙事（" + text.length + " 字/「我」×" + selfMentions + "）归 Diary 层"]);
  }

  // 8) 稳定谓词（fact）
  const factMatch = text.match(FACT_PREDICATE_RE);
  if (factMatch) {
    let conf = 0.6;
    const notes = ["稳定谓词：「" + factMatch[0] + "」"];
    if (HEDGE_RE.test(text)) { conf = 0.4; notes.push("弱确定性词降置信"); }
    else if (RECENT_RE.test(text)) { conf = 0.45; notes.push("近期时限词降置信"); }
    return out(true, "fact", conf, notes);
  }

  // 9) 兜底：无任何信号 → 普通闲聊，不产候选
  return out(false, "unknown", 0.2, ["无稳定谓词/规则/引用/节点信号——按普通闲聊处理"]);
}

module.exports = { detect };
