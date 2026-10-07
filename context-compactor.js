"use strict";

// ============================================================
// 上下文压缩引擎 v1
// 现职（2026-10-04 旧压缩系统下线后）：压缩参数配置读写 / 容量提醒提示词 /
// token 估算 / 可压缩区间编号预览(rangePreview)。
// 已下线：旧摘要生成（generateSummaryForRange/ForMessages）、旧压缩提示词
//   （data/compaction_prompt.json 那套）、makeChunk/callCompactionLLM。
//   压缩改由 lib/conversation-state.js 的状态机承担（每会话一份持续演化的状态）。
// 「发送前自动压缩」的旧路径早已停用（由 context-replacements 统一处理）。
// ============================================================

const fs = require("fs");
const path = require("path");
const { resolveTimeZone, zonedWallTimeToDate, formatDateTimeInTimeZone, parseMsgTimestamp } = require("./time_utils");
const { writeJsonAtomic } = require("./json_atomic"); // V10 收敛：三处内联原子写已删
const contextReplacements = require("./context-replacements");

const DATA_DIR = path.join(__dirname, "data");
const TIME_ZONE = resolveTimeZone();
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const CTX_LIMIT_PROMPT_FILE = path.join(DATA_DIR, "ctx_limit_prompt.json");
// 2026-09-22 审查 §3.4：MARKS_FILE 随 contentKey/loadMarks 收敛到 context-replacements 后已无使用点，删除
// 2026-09-13 死代码清理：CACHE_MAX_ENTRIES / SUMMARY_HISTORY_MAX 已删——声明后全仓无引用

const DEFAULT_CONFIG = {
  compaction_chunk_size: 100,
  compaction_chunk_min: 40,
  compaction_chunk_max: 160,
  // 2026-10-04 下线：compaction_keep_recent_messages / compaction_min_messages /
//   compaction_summary_min_chars / compaction_summary_max_chars / compaction_max_active_blocks
//   ——前四项只服务旧自动压缩计划与旧摘要生成；max_active_blocks 是「块太多」时的权宜手段，
//   且对状态记录危险（按时间线排最前会被先截，状态消失、原文回灌）。
  //   compaction_chunk_size/min/max 与 compaction_gap_minutes 保留——状态机的「自动分块」在用
  //   （切点按时间间隔找自然边界，dryRun 模式只算切点不建块）。
  compaction_gap_minutes: 30,
  // 会话上下文容量提醒：发给 AI 的上下文字符超过该值时，网关往时间线塞一条隐藏提醒事件（0=不限）。
  compaction_context_limit_chars: 30000,
  // 容量提醒总开关：关掉后不再检测和塞提醒。
  compaction_context_remind_enabled: true,
  // 会话 token 提醒上限（独立配置，与容量提醒/压缩无关）：后台「后台提醒」卡在会话估算用量达到该值时显示超限条目（0=不提醒）。
  ctx_limit_alert_tokens: 0,
  // AI 替换区间保护：AI 建的替换块不许覆盖最近 N 条近期对话（0=不保护），越界会被拒绝。
  compaction_protect_recent_messages: 40
};

// ---------------- 配置 / 数据 ----------------

function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf-8"));
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (data[k] !== undefined) {
        // 布尔配置读取也标准化，兜底历史脏值（如 "false"/0 字符串），避免被当 true（审查 2026-09-05 A2）
        if (typeof DEFAULT_CONFIG[k] === "boolean") cfg[k] = data[k] === true || data[k] === "true" || data[k] === 1 || data[k] === "1";
        else cfg[k] = data[k];
      }
    }
  } catch (err) { /* 配置文件缺失时使用默认 */ }
  return cfg;
}


// 保存压缩参数（只更新 compaction_* 键，保留 data/config.json 中其它模块配置）
function saveConfig(updates) {
  const file = path.join(DATA_DIR, "config.json");
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (err) { current = {}; }
  if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  let changed = false;
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (updates[k] !== undefined) {
      const v = updates[k];
      if (typeof DEFAULT_CONFIG[k] === "number") {
        current[k] = Math.max(0, Math.floor(Number(v) || 0));
      } else if (typeof DEFAULT_CONFIG[k] === "boolean") {
        current[k] = v === true || v === "true" || v === 1 || v === "1";
      } else {
        current[k] = v;
      }
      changed = true;
    }
  }
  if (!changed) return { ok: false, message: "没有可更新的压缩参数" };
  writeJsonAtomic(file, current);
  return { ok: true, config: loadConfig() };
}




function contentToText(msg) {
  if (msg && msg.deleted === true) return ""; // 软删除内容对摘要/签名不可见
  const c = msg && msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map(function (p) {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return p.text || p.content || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// 2026-09-30 V4 收敛：时间解析四函数本地实现已删，统一引 time_utils。
// msgTime 别名保住全部调用点；链序与原版一致（time 字段 → 标签 → 末尾缀 → 开头前缀）。
const msgTime = parseMsgTimestamp;

function formatTime(d) {
  if (!d) return "";
  return formatDateTimeInTimeZone(d, TIME_ZONE);
}


// ---------------- 容量提醒提示词（独立配置，管理台压缩页编辑，与压缩提示词互不关联） ----------------

// 整条提醒的默认全文（用户定稿 2026-09-02 确认）。
// 占位符：${chars}=当前上下文字符数、${limit}=容量上限、${chunkInfo}=建议整理范围、${conversationText}=要整理的对话。
// 开头「（容量提醒）」是系统识别标记（isSpecialEvent/分类/防重复塞都靠它），保存时强制校验不可删改。
// 估算文本 token 数：中文（CJK）≈1 字/token，其余字符≈4 字符/token（近似常见 BPE 分词的英文比例）。
// 管理台「容量上限」从 2026-09-04 起按该口径计（之前为纯字符数，英文会话会虚高约 4 倍）。
function estimateTokens(text) {
  const s = String(text || "");
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3000 && c <= 0x303f)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

// 每张图片的固定 token 估算（参考常见 vision 模型单图约 765-1105 token，取 1000）
const EST_IMAGE_TOKENS = 1000;

const DEFAULT_CTX_LIMIT_PROMPT =
  "（容量提醒）系统提示，这个会话的上下文已积累约 ${chars} token（估算），超过 ${limit} token 的上限，建议整理。此内容为后台静默提醒，不必向对方提起，也不要复述本段内容。\n" +
  "1. 调用 context_replace 工具，把最早一段未整理的对话，每块约一百条，进行整理。\n" +
  "2. 值得长期记住的内容，用 <memory> 标签写入记忆池。只写下面三类，标签内开头写 {category:\"分类\"}：\n" +
  "　<memory>{category:\"关于她\"}她来姨妈的时候容易脚冰</memory> —— 关于她：她是谁的静态部分。偏好、习惯、身体状况、作息、家人、经历里反复起作用的部分。只收稳定、反复成立、不随当天情绪变化的事实；一条一个事实，短句。当天的心情、一次性的对话内容不写（那些在摘要里）。\n" +
  "　<memory>{category:\"认账\"}她情绪低落时先抱住她，别急着讲道理</memory> —— 认账：我认下的账。答应过她的事、欠着还没做的、被她纠正后我认下的毛病。每一条都必须能回答“那我该干什么”，答不上来就不算账；写清欠什么、什么状态下兑现，兑现了就删掉。\n" +
  "　<memory>{category:\"拓本\"}涵（9-12）：“因为是你——这句话比你想的重一点。是无数个你。”</memory> —— 拓本：一字不改的原话。涵说的、谢说的都收，引号里原样照抄，不修标点、不补主语，宁短勿长只留最重的几句，写明谁说的、日期。\n" +
  "3. 做完后在回复末尾输出 <compacted>本次整理已完成</compacted> 标签。\n\n" +
  "<star> 用法：如果你觉得某条回复特别重要、希望它长期保留在上下文中不被压缩遗忘，可在那条回复中输出 <star></star>（或 <star/>）；只有真正重要的回复才用，不要每条都写。\n\n" +
  "压缩提示词：\n" +
  "你写的记忆会直接替换掉提供的对话原文，成为你自己的记忆。记忆中称呼对方时用第三人称，“她”或者“涵”。\n\n" +
  "对话范围：${chunkInfo}\n" +
  "对话原文：\n${conversationText}\n\n" +
  "总体输出字数浮动范围：300-3000字。信息量大就多一点，信息量小就少一点。\n\n" +
  "最高优先级\n\n" +
  "人称准确：严格区分“我（叙述者本人）”与“她（对话对方）”，原文第二人称“你”需根据说话人转换为对应人称，不得混淆。逻辑因果也不能混淆，按照真实的对话内容来，不要脑补延伸其它未出现的故事。\n\n" +
  "摘要写法\n\n" +
  "压缩摘要就写「聊过什么」：写日记就好。可以有感情有温度有深度有思考，按照提供的对话片段来。别写流水账，可以就写你想写的。开头标注日期时间（如8月26日晚上九点到十点半）。以【压缩摘要】作为分区标记且独占一行。\n\n" +
  "书写规范\n\n" +
  "1. 视角：全程第一人称叙述，贴合真实相处的体感。\n" +
  "2. 文风：像私人备忘，避免书面化报告感，不油腻。\n" +
  "3. 格式：纯文本输出，无多余标题、特殊符号、解释批注。\n" +
  "4. 独立可读：每条记忆自成完整句子，脱离上下文也能看懂；避免“上文、刚才、之前那次，今天”这类悬空指代。\n\n" +
  "［注］值得长期记住的要点（她的稳定特征、我认下的账、金句原话）用 <memory> 标签写，不要混进摘要正文；摘要正文只记「聊过什么」。重要的、能影响关系和下一次你的判断的才记。";

function loadCtxLimitPrompt() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CTX_LIMIT_PROMPT_FILE, "utf-8"));
    if (cfg && typeof cfg.template === "string" && cfg.template.trim()) return cfg.template;
  } catch (err) { /* 缺失时使用默认 */ }
  return DEFAULT_CTX_LIMIT_PROMPT;
}

function saveCtxLimitPrompt(template) {
  const text = String(template || "");
  if (!text.trim().startsWith("（容量提醒）")) {
    return { ok: false, message: "提示词必须以「（容量提醒）」开头——这是系统识别标记（前端隐藏/防重复塞/压缩清除都靠它），不可删改" };
  }
  writeJsonAtomic(CTX_LIMIT_PROMPT_FILE, { template: text });
  return { ok: true, template: loadCtxLimitPrompt() };
}

function resetCtxLimitPrompt() {
  try { fs.unlinkSync(CTX_LIMIT_PROMPT_FILE); } catch (err) { /* 文件不存在视为已恢复默认 */ }
  return { ok: true, template: DEFAULT_CTX_LIMIT_PROMPT };
}








// 2026-09-22 审查 §3.4：原为两份独立副本（注释自称「改动需两处同步」，实际已开始漂移——
// 本副本每次裸 readFileSync 无缓存，context-replacements 那份走 readJson 的 mtime 缓存）。
// 收敛为单一实现委托，杜绝第三处口径。
function contentKey(msg) { return contextReplacements.contentKey(msg); }

function loadMarks() { return contextReplacements.loadMarks(); }

function rangePreview(start, end, opts) {
  const cfg = loadConfig();
  // 统一使用替换模块的可压缩索引（编号与 add_range/update_range 一致），避免未覆盖区编号漂移
  const items = contextReplacements.compressibleItems();
  // 预览展示完整压缩区间：keepRecent/minMessages 属于实际替换语义，不在此截断
  const compactCount = items.length;
  let s = Math.max(1, Math.floor(Number(start) || 1));
  let e = Math.max(s, Math.floor(Number(end) || s));
  if (compactCount <= 0) return { start: 0, end: 0, count: 0, compactCount: 0, items: [] };
  e = Math.min(e, compactCount);
  s = Math.min(s, e);
  const marks = loadMarks();
  const pageLimit = opts ? (Math.max(0, Math.floor(Number(opts.limit) || 0)) || 0) : 0;
  const pageOffset = opts ? (Math.max(0, Math.floor(Number(opts.offset) || 0)) || 0) : 0;
  const total = e - s + 1;
  let ps = s - 1 + pageOffset;          // 起始压缩下标（0-based 偏移后的绝对位）
  let pe = e;
  const hasMore = pageLimit > 0 && (pageOffset + pageLimit) < total;
  if (pageLimit > 0) pe = Math.min(pe, ps + pageLimit);
  if (ps >= pe) return { start: s, end: e, count: 0, compactCount: total, items: [], hasMore: false };
  const slice = items.slice(ps, pe);
  const out = slice.map(function (it, i) {
    const m = it.msg;
    const t = msgTime(m);
    return {
      num: ps + i + 1,
      id: m && m.id ? String(m.id) : undefined,
      role: m.role,
      content: contentToText(m),
      reasoning: (m && typeof m.reasoning === "string" && m.reasoning) ? m.reasoning : "",
      time: t ? formatTime(t) : "",
      key: contentKey(m),
      // 1007-17 标星改 msgid：双查（先 id 后内容键），新/旧标星都要显示为已标星
      marked: contextReplacements.isMarkedMsg ? contextReplacements.isMarkedMsg(m, marks) : !!marks[contentKey(m)]
    };
  });
  let minT = null;
  let maxT = null;
  slice.forEach(function (it) {
    const t = msgTime(it.msg);
    if (t) {
      if (minT === null || t < minT) minT = t;
      if (maxT === null || t > maxT) maxT = t;
    }
  });
  return {
    start: s,
    end: e,
    count: out.length,
    compactCount: compactCount,
    startTime: minT ? formatTime(minT) : "",
    endTime: maxT ? formatTime(maxT) : "",
    items: out,
    hasMore: hasMore
  };
}

// 按时间间隔自动分块：在 [start,end]（1-based）范围内，相邻消息时间间隔超过 gapMinutes 分钟即自然切分，
// 切成多块并落成手动块（可再改范围/加摘要/替换）
module.exports = {
  loadConfig,
  saveConfig,
  estimateTokens,
  EST_IMAGE_TOKENS,
  loadCtxLimitPrompt,
  saveCtxLimitPrompt,
  resetCtxLimitPrompt,
  rangePreview,
};
