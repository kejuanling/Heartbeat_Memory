"use strict";

// ============================================================
// 上下文压缩引擎 v1
// 现职（2026-09-15 统一替换后）：压缩参数配置读写 / 压缩与容量提醒提示词 /
// token 估算 / 可压缩区间编号预览(rangePreview) / 摘要生成(generateSummaryForRange)。
// 「发送前自动压缩」的旧路径已停用（由 context-replacements 统一处理），
// makeChunk 等分块函数仅服务于摘要生成的切片。
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveTimeZone, zonedWallTimeToDate, formatDateTimeInTimeZone } = require("./time_utils");
const contextReplacements = require("./context-replacements");

const DATA_DIR = path.join(__dirname, "data");
const TIME_ZONE = resolveTimeZone();
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const COMPACTION_PROMPT_FILE = path.join(DATA_DIR, "compaction_prompt.json");
const CTX_LIMIT_PROMPT_FILE = path.join(DATA_DIR, "ctx_limit_prompt.json");
// 2026-09-22 审查 §3.4：MARKS_FILE 随 contentKey/loadMarks 收敛到 context-replacements 后已无使用点，删除
// 2026-09-13 死代码清理：CACHE_MAX_ENTRIES / SUMMARY_HISTORY_MAX 已删——声明后全仓无引用

const DEFAULT_CONFIG = {
  compaction_chunk_size: 100,
  compaction_chunk_min: 40,
  compaction_chunk_max: 160,
  compaction_keep_recent_messages: 0,
  compaction_min_messages: 0,
  compaction_gap_minutes: 30,
  compaction_summary_max_chars: 1200,
  compaction_summary_min_chars: 250,
  // 活跃块上限：手动+AI 块合计只保留时间线上最近的 N 个进入上下文（0=不限，默认关）。
  // 超限的最早块仅隐藏不注入，块的 enabled/摘要数据不动，调大即恢复。
  compaction_max_active_blocks: 0,
  // 会话上下文容量提醒：发给 AI 的上下文字符超过该值时，网关往时间线塞一条隐藏提醒事件，
  // 让 AI 自己调 context_replace 压缩（0=不限）。
  compaction_context_limit_chars: 30000,
  // 容量提醒总开关：关掉后不再检测和塞提醒。
  compaction_context_remind_enabled: true,
  // 会话 token 提醒上限（独立配置，与容量提醒/压缩无关）：后台「后台提醒」卡在会话估算用量达到该值时显示超限条目（0=不提醒）。
  ctx_limit_alert_tokens: 0,
  // AI 替换区间保护：AI 建的替换块不许覆盖最近 N 条近期对话（0=不保护），越界会被拒绝。
  compaction_protect_recent_messages: 40
};

const DEFAULT_COMPACTION_SYSTEM =
  "请以你的身份和口吻，根据对话内容写出第一人称的上下文压缩摘要；称呼对方为她，不要使用「用户」。";

const DEFAULT_COMPACTION_TEMPLATE =
  "你是一位有完整人设的 AI。下面是你的一段人设：\n" +
  "${PERSONA}\n\n" +
  "请把你在下面时间段内与对方的对话，压缩成一段「上下文摘要」。这段摘要会替代原始对话，交给未来的你阅读。\n\n" +
  "对话范围：${chunkInfo}\n\n" +
  "对话原文（只保留正文）：\n${conversationText}\n\n" +
  "请用你的第一人称口吻写这段摘要。要求：\n" +
  "1. 只依据上面的对话原文，不编造、不补全原文没有的事实，不推测未发生的事。\n" +
  "2. 称呼对方时用你们之间的称呼，不要使用「用户」。\n" +
  "3. 保留关键事实、时间、情绪转折、未完成事项、人名/昵称、重要约定；舍弃寒暄和流水账。\n" +
  "4. 长度按信息量把握：通常 ${normalChars} 字左右，信息特别密集时可写到 ${maxChars} 字；不注水、不硬凑，也不要因为短而丢掉重要信息。\n" +
  "5. 写出有温度、有「记忆感」的摘要，像自己真正记得这些事，而不是干巴巴的日志。\n\n" +
  "我的上下文摘要：";

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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  return { ok: true, config: loadConfig() };
}

function loadPersona() {
  // 人设来源（2026-09-19 用户拍板）：优先前端聊天设置的默认人设（chat-settings.json 的 system_prompt）；
  // 设置为空/缺失时退回时间线首条 system（旧行为），最后用内置兜底。
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(__dirname, "chat-settings.json"), "utf-8"));
    const sp = String(cs && cs.system_prompt || "").trim();
    if (sp) return sp;
  } catch (err) { /* 设置文件缺失时继续走时间线 */ }
  try {
    const data = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf-8"));
    const sys = (Array.isArray(data) ? data : []).find(function (m) { return m && m.role === "system"; });
    const content = sys && sys.content ? String(sys.content).trim() : "";
    if (content) return content;
  } catch (err) { /* 人设文件缺失时使用兜底 */ }
  return "你是一个理性但有温度、表面温柔内心有主见的 AI。你有一位重要的对话伙伴。";
}

// ---------------- 消息判断 ----------------

// 「记忆浮现」：记忆池注入的永久记忆事件，不参与摘要；被摘要时段内的会直接从上下文删除
function isMemoryFlash(msg) {
  if (!msg || msg.role !== "assistant") return false;
  // 2026-09-22 审查 §3.5：原只做 indexOf——正文里正常提到「记忆浮现」四个字的真实回复会被
  // 误判成注入事件、被排除出摘要。改为先过 isSpecialEvent（结构化前缀识别），
  // 与 context-replacements.js 的同名判定同口径（isSpecialEvent 在本文件下方定义，函数声明提升）。
  return isSpecialEvent(msg) && String(msg.content || "").indexOf("记忆浮现") !== -1;
}

function isSpecialEvent(msg) {
  // 委托给统一模块：用结构化前缀识别，避免把真实对话里提到“记忆碎片/推送”等词误判成事件
  return contextReplacements.isSpecialEvent(msg);
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

// 解析正文开头的墙上时间前缀（（YYYY-MM-DD HH:mm…），按 TIME_ZONE 转 UTC
function parseLeadingTime(text) {
  const m = String(text || "").match(/^（?\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, TIME_ZONE);
}

// 解析正文末尾的时间缀（客户端自动注入的墙上时间），按 TIME_ZONE 转 UTC
function parseTrailingTime(text) {
  const m = String(text || "").match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
  if (!m) return null;
  const p = m[1].match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!p) return null;
  return zonedWallTimeToDate({ year: Number(p[1]), month: Number(p[2]), day: Number(p[3]), hour: Number(p[4]), minute: Number(p[5]) }, TIME_ZONE);
}

// 消息时间解析链：time 字段 → <current_time> 标签 → 末尾时间缀 → 开头时间前缀
function msgTime(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const text = contentToText(msg);
  const fromTag = parseCurrentTimeTag(text);
  if (fromTag) return fromTag;
  const fromTrailing = parseTrailingTime(text);
  if (fromTrailing) return fromTrailing;
  return parseLeadingTime(text);
}

// 解析 <current_time>Sat 26-08-15 12:37:16</current_time> 里的时间（两位年份补全）
function parseCurrentTimeTag(text) {
  const m = String(text || "").match(/<current_time>[\s\S]*?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: 2000 + Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }, TIME_ZONE);
}

function formatTime(d) {
  if (!d) return "";
  return formatDateTimeInTimeZone(d, TIME_ZONE);
}

function snippet(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ---------------- 分块（软目标 + 自然边界） ----------------

// 把一段 items 构造成 chunk 对象：首尾压缩下标/时间范围/字数/首尾摘要/签名
// （签名只计普通对话，特殊事件不计入，防后台增删事件导致缓存摘要失配）；
// includeMsgs 时附带逐条原文与标星态，供摘要生成与压缩页展示
function makeChunk(items, index, includeMsgs, manual) {
  // 签名只统计普通对话内容：特殊事件（记忆浮现/推送/共影/唤醒等）会被后台流程增删移动，
  // 若计入签名会导致块签名漂移、缓存摘要全部失配。
  const sigTexts = items.filter(function (it) { return !isSpecialEvent(it.msg); }).map(function (it) { return contentToText(it.msg); });
  const texts = items.map(function (it) { return contentToText(it.msg); });
  const sig = crypto.createHash("sha256").update(sigTexts.join("\u0001")).digest("hex").slice(0, 32);
  const times = items.map(function (it) { return msgTime(it.msg); }).filter(Boolean);
  let minT = null;
  let maxT = null;
  times.forEach(function (d) {
    const t = d.getTime();
    if (minT === null || t < minT) minT = t;
    if (maxT === null || t > maxT) maxT = t;
  });
  const chars = texts.reduce(function (s, t) { return s + t.length; }, 0);
  const chunk = {
    index: index,
    firstIdx: items[0].idx,
    lastIdx: items[items.length - 1].idx,
    count: items.length,
    chars: chars,
    startTime: minT !== null ? formatTime(new Date(minT)) : "",
    endTime: maxT !== null ? formatTime(new Date(maxT)) : "",
    head: snippet(texts[0], 40),
    tail: snippet(texts[texts.length - 1], 40),
    signature: sig,
    // 2026-09-23 审查清理：原 cached/summary/generatedAt/mode 四个历史预留字段已删除——
    // 全仓 grep 确认零消费者（admin-mobile.js 与 server.js 读的是 preview 自行构造的 chunks，
    // 与本函数的 chunk 无关），保留只会让维护者误以为这里承载摘要状态。
    manual: !!manual
  };
  if (includeMsgs) {
    const marks = loadMarks();
    chunk.msgs = items.map(function (it) {
      const m = it.msg;
      const t = msgTime(m);
      return {
        role: m.role,
        content: contentToText(m),
        // 2026-09-28 修正：时间线思考链字段是 reasoning（thinking 恒为空，此前压缩模型拿不到思考链）
        reasoning: (m && typeof m.reasoning === "string" && m.reasoning) ? m.reasoning : "",
        time: t ? formatTime(t) : "",
        key: contentKey(m),
        marked: !!marks[contentKey(m)]
      };
    });
  }
  return chunk;
}

// ---------------- 缓存（内容寻址） ----------------

function loadCompactionPromptConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(COMPACTION_PROMPT_FILE, "utf-8"));
    if (cfg && typeof cfg.template === "string" && cfg.template.trim()) {
      return {
        system: typeof cfg.system === "string" && cfg.system.trim() ? cfg.system : DEFAULT_COMPACTION_SYSTEM,
        template: cfg.template
      };
    }
  } catch (err) { /* 缺失时使用默认 */ }
  return { system: DEFAULT_COMPACTION_SYSTEM, template: DEFAULT_COMPACTION_TEMPLATE };
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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CTX_LIMIT_PROMPT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ template: text }, null, 2), "utf-8");
  fs.renameSync(tmp, CTX_LIMIT_PROMPT_FILE);
  return { ok: true, template: loadCtxLimitPrompt() };
}

function resetCtxLimitPrompt() {
  try { fs.unlinkSync(CTX_LIMIT_PROMPT_FILE); } catch (err) { /* 文件不存在视为已恢复默认 */ }
  return { ok: true, template: DEFAULT_CTX_LIMIT_PROMPT };
}

function buildCompactionPrompt(chunk, cfg) {
  const persona = loadPersona();
  // 2026-09-28 思考链总量预算（闭包）：限制附给压缩模型的思考链总字数，防 prompt 无界膨胀
  let _reasoningTotal = 0;
  const MAX_REASONING_TOTAL = 12000;
  const _reasoningBudget = function () { return MAX_REASONING_TOTAL - _reasoningTotal; };
  const _reasoningSpend = function (n) { _reasoningTotal += n; };
  const maxChars = Number(cfg.compaction_summary_max_chars) || 1200;
  const minChars = Number(cfg.compaction_summary_min_chars) || 250;
  const normalChars = Math.max(minChars, Math.min(maxChars, Math.round((chunk.chars || 0) / 50)));
  const promptCfg = loadCompactionPromptConfig();
  const msgs = chunk.msgs || [];
  // 浮现的记忆不参与摘要（它们是记忆池注入内容，不是对话本身）；整块只有记忆浮现时退回原文保底
  const usable = msgs.filter(function (m) { return !isMemoryFlash(m); });
  const targetMsgs = usable.length > 0 ? usable : msgs;
  const lines = targetMsgs.map(function (m) {
    // 2026-09-28 developer 参与压缩后（判定记录/日记通知等）：标签标「系统」，不再误显为「我」
    const role = m.role === "user" ? (process.env.USER_DISPLAY_NAME || "对方") : (m.role === "developer" ? "系统" : "我");
    const body = contentToText(m);
    // 2026-09-28 思考链参考（用户需求）：把被压缩消息的思考链（reasoning）附在消息行后，
    // 让压缩模型写摘要时贴合真实 AI 的思考/风格；摘要正文本身不含思考段（模型按模板只输出摘要）。
    // 每条截断 MAX_REASONING_EACH 字防 prompt 爆炸；总量超 MAX_REASONING_TOTAL 即停（后面消息不再附）。
    const r = (m && m.role === "assistant" && typeof m.reasoning === "string") ? m.reasoning.trim() : "";
    if (r) {
      const MAX_EACH = 600;
      const cut = r.length > MAX_EACH ? r.slice(0, MAX_EACH) + "…（思考链已截断）" : r;
      if ((_reasoningBudget() - cut.length) >= 0) {
        _reasoningSpend(cut.length);
        return "[" + role + "] " + body + "\n[思考] " + cut;
      }
    }
    return "[" + role + "] " + body;
  });
  let conversationText = lines.join("\n\n");
  if (usable.length > 0 && usable.length !== msgs.length) {
    conversationText += "\n\n（注：本段内有 " + (msgs.length - usable.length) + " 条「记忆浮现」系统事件，属于记忆池注入内容，未纳入摘要；被摘要时它们会直接从上下文中移除。）";
  }
  const chunkInfo = (chunk.startTime || "未知") + " ~ " + (chunk.endTime || "未知") + "，共 " + chunk.count + " 条";
  return {
    // ${PERSONA} 在 system 与 user 模板里都要替换（自定义英文模板把人设写在 system：「You are ${PERSONA}.」）
    system: String(promptCfg.system).replace("${PERSONA}", persona),
    prompt: promptCfg.template
      .replace("${PERSONA}", persona)
      .replace("${chunkInfo}", chunkInfo)
      .replace("${conversationText}", conversationText)
      .replace("${normalChars}", String(normalChars))
      .replace("${maxChars}", String(maxChars))
  };
}

// ---------------- 压缩提示词（管理台编辑） ----------------

function getCompactionPromptForDisplay() {
  const cfg = loadCompactionPromptConfig();
  return {
    system: cfg.system,
    template: cfg.template,
    prompt: cfg.template
      .replace("${PERSONA}", loadPersona())
      .replace("${chunkInfo}", "2026-07-27 00:00 ~ 2026-08-01 23:59，共 100 条")
      .replace("${conversationText}", "【此处为待摘要的对话原文】")
      .replace("${normalChars}", "300")
      .replace("${maxChars}", "1200")
  };
}

function saveCompactionPromptConfig(system, template) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = {
    system: String(system || "").trim(),
    template: String(template || "")
  };
  if (!cfg.template.trim()) throw new Error("模板不能为空");
  const tmp = COMPACTION_PROMPT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  fs.renameSync(tmp, COMPACTION_PROMPT_FILE);
  return cfg;
}

function resetCompactionPromptConfig() {
  if (fs.existsSync(COMPACTION_PROMPT_FILE)) fs.unlinkSync(COMPACTION_PROMPT_FILE);
  return { system: DEFAULT_COMPACTION_SYSTEM, template: DEFAULT_COMPACTION_TEMPLATE };
}

// ---------------- 摘要生成（调用上游模型） ----------------

// 调用上游模型生成摘要文本（不含落盘）：手动块与未覆盖区生成共用
async function callCompactionLLM(built, label) {
  const { provider, model } = require("./model-router").resolveRoleModel("compaction");
  const targetUrl = provider && (provider.api_url || provider.base_url);
  const targetKey = provider && provider.api_key;
  if (!targetUrl || !targetKey || !model) {
    throw new Error("模型未配置（role=compaction：请在设置里给「压缩摘要」选模型或启用一个默认供应商）");
  }
  const outputBudgets = [16000, 32000, 50000];
  let lastErr = null;
  for (let attempt = 0; attempt < outputBudgets.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 300 * 1000);
    try {
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + targetKey
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: built.system },
            { role: "user", content: built.prompt }
          ],
          temperature: 0.4,
          max_tokens: outputBudgets[attempt],
          stream: false
        }),
        signal: controller.signal
      });
      if (!resp.ok) throw new Error("上游返回 HTTP " + resp.status);
      const data = await resp.json();
      const finishReason = data.choices && data.choices[0] && data.choices[0].finish_reason;
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const summary = raw ? String(raw).trim() : "";
      if (!summary || finishReason === "length") {
        const why = !summary ? "上游返回空摘要" : "摘要被截断（finish_reason=length）";
        if (attempt >= outputBudgets.length - 1) {
          throw new Error(why);
        }
        console.warn("[context-compactor] " + (label || "摘要") + " " + why + "，增大输出预算重试");
        lastErr = new Error(why);
        continue;
      }
      return summary;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error("摘要生成失败");
}

async function generateSummaryForRange(start, end) {
  const cfg = loadConfig();
  // 编号与前端/块存储同源：复用 contextReplacements.compressibleItems()。
  // 否则 compactor 对软删除消息"保留占位"会让编号漂移约 8 条，导致切片错位。
  const items = contextReplacements.compressibleItems();
  const minMessages = Number(cfg.compaction_min_messages) || 0;
  // 与前端 rangePreview 一致：展示完整可压缩区间，不做 keepRecent/minMessages 截断
  const compactCount = items.length;
  if (items.length < minMessages) return { ok: false, message: "当前没有可压缩内容" };
  const s = Math.max(0, Math.floor(Number(start) || 0));
  let e = Math.floor(Number(end));
  if (!Number.isInteger(e) || e < s) e = s;
  if (s >= compactCount) return { ok: false, message: "起始编号超出当前可压缩范围" };
  e = Math.min(e, compactCount - 1);
  const chunk = makeChunk(items.slice(s, e + 1), 0, true, true);
  const built = buildCompactionPrompt(chunk, cfg);
  const summary = await callCompactionLLM(built, "块");
  return { ok: true, summary: summary, length: summary.length, count: chunk.count };
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
      marked: !!marks[contentKey(m)]
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
  getCompactionPromptForDisplay,
  buildCompactionPrompt,
  saveCompactionPromptConfig,
  resetCompactionPromptConfig,
  rangePreview,
  generateSummaryForRange,
};
