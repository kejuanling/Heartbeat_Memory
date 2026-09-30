// time_utils.js — 时间工具（全项目共用）：时区解析、时区化日期部件、墙上时间 ↔ UTC 互转。
// 全部按 TIME_ZONE（默认 Asia/Shanghai）处理；Railway/服务器时区不可信，
// 任何「用户侧时间」都必须经本模块换算，禁止直接 new Date(墙上时间字符串)。
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

// 校验并返回时区名：非法（Intl 不认识）时告警并回退默认值
function resolveTimeZone(raw = process.env.TIME_ZONE, fallback = DEFAULT_TIME_ZONE) {
  const zone = String(raw || "").trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    console.warn(`TIME_ZONE=${zone} 无效，已回退到 ${fallback}`);
    return fallback;
  }
}

// Date → 指定时区的日期部件 {year,month,day,hour,minute,second}（两位字符串，year 四位）
function getDatePartsInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second || "00"
  };
}

// Date → 指定时区的「YYYY-MM-DD HH:mm」串（日记标题/日志/展示通用格式）
function formatDateTimeInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 取指定时区当前小时数（昼夜判定用）
function getHourInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  return Number(getDatePartsInTimeZone(date, timeZone).hour);
}

// 该时区在该时刻相对 UTC 的偏移（毫秒，含夏令时）；zonedWallTimeToDate 的两次反推依赖它
function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second || "00")
  );
  return asUTC - date.getTime();
}

// 墙上时间（某时区的年月日时分）→ 真实 UTC Date；两次反推校正偏移变化（如夏令时切换日）。
// 非法输入返回 null。
function zonedWallTimeToDate({ year, month, day, hour, minute, second = 0 }, timeZone = resolveTimeZone()) {
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0)
  );
  let offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  let parsed = new Date(utcGuess - offset);

  // 批注 2026-07-30：Kelivo 时间戳是用户所在时区的墙上时间；Railway 常用 UTC，
  // 这里显式按 TIME_ZONE 转成真实 UTC Date，避免把北京时间误当 UTC 导致“用户来自未来”。
  const adjustedOffset = getTimeZoneOffsetMs(parsed, timeZone);
  if (adjustedOffset !== offset) {
    parsed = new Date(utcGuess - adjustedOffset);
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// 闹钟目标解析：优先日期时间（YYYY-MM-DD HH:mm，按 timeZone 墙上时间），纯数字按分钟（1~1440）。
// 尾部可选 keep=true / keep=false（2026-09-26 加；严格语法、不做容错）：
//   keep=true  → 该闹钟不受「用户中途发言即作废」影响（槽位落 keep 字段）；
//   keep=false → 与不写等价（用户发言即作废，默认行为）。
// 写了 keep 但不是规范写法（keep / keep = true / KEEP=true 等）→ 整条拒绝，避免静默降级成"以为保护了其实没保护"。
// 返回 { at: Date }（日期时间）或 { minutes: number }（分钟），两者都带 keep 布尔；无法解析返回 null。
function parseWakeTarget(raw, timeZone = resolveTimeZone()) {
  let s = String(raw || "").trim();
  if (!s) return null;
  let keep = false;
  const keepMatch = s.match(/^(.*\S)\s+(keep=(?:true|false))$/);
  if (keepMatch) {
    keep = keepMatch[2] === "keep=true";
    s = keepMatch[1].trim();
    if (!s) return null;
  } else if (/\bkeep\b/i.test(s)) {
    console.warn("[wake] keep 写法不规范，整条 <wake> 拒绝: " + String(raw || "").trim());
    return null;
  }
  // 纯数字 → 分钟（1~1440，与旧 <wake> 语义一致）
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1) return { minutes: Math.min(1440, n), keep };
    return null;
  }
  // 纯时间 HH:mm → 按 TIME_ZONE 的今天此刻解析；若已过该点则顺延到明天（到点结束语义）
  const t = s.match(/^(\d{1,2}):(\d{2})$/);
  if (t) {
    const hour = Number(t[1]);
    const minute = Number(t[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const now = new Date();
    const parts = getDatePartsInTimeZone(now, timeZone);
    const candidate = zonedWallTimeToDate(
      { year: parts.year, month: parts.month, day: parts.day, hour, minute },
      timeZone
    );
    if (candidate && !Number.isNaN(candidate.getTime())) {
      if (candidate.getTime() <= now.getTime()) {
        // 今天的 HH:mm 已过 → 顺延到明天
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tp = getDatePartsInTimeZone(tomorrow, timeZone);
        const next = zonedWallTimeToDate(
          { year: tp.year, month: tp.month, day: tp.day, hour, minute },
          timeZone
        );
        if (next && !Number.isNaN(next.getTime())) return { at: next, keep };
        return null;
      }
      return { at: candidate, keep };
    }
    return null;
  }
  // 日期时间 → 按 TIME_ZONE 解析墙上时间（先校验字段范围，避免 JS Date 自动进位把非法日期静默解析）
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    const date = zonedWallTimeToDate(
      { year: m[1], month, day, hour, minute },
      timeZone
    );
    if (date && !Number.isNaN(date.getTime())) {
      // 回读校验：防止 2026-02-30 这类不存在的日期被 JS Date 进位到 3 月
      const parts = getDatePartsInTimeZone(date, timeZone);
      if (
        Number(parts.year) === Number(m[1]) &&
        Number(parts.month) === month &&
        Number(parts.day) === day &&
        Number(parts.hour) === hour &&
        Number(parts.minute) === minute
      ) {
        // 2026-09-21 审查 R2：远期日期拒设（不静默改短闹钟语义）。AI 一句 <wake>2027-06-01 10:00</wake>
        // 曾可让 armTimedWake 挂出超 32 位上限的 setTimeout 形成热循环；30 天外的提醒本就不该由闹钟承担
        if (date.getTime() - Date.now() > 30 * 24 * 60 * 60 * 1000) {
          console.warn("[wake] 闹钟目标超过 30 天上限，拒绝设定: " + s);
          return null;
        }
        return { at: date, keep };
      }
    }
  }
  return null;
}

// 当前时刻的 UTC ISO 串（落库 time 字段统一用）
function nowIso() {
  return new Date().toISOString();
}

// ========================
// 消息时间戳解析原子件（2026-09-30 V4 收敛：四套重复实现的唯一来源）
// 此前 server.js / context-compactor.js / context-replacements.js / lib/wake-scheduler.js
// 各自维护一份正则，细节漂移（replacements 缺 <current_time> 分支导致压缩块 range_label
// 与预览时间不一致；wake 的标签正则最宽容）。统一取各版并集（最宽容）形态。
// ========================

// 时区缓存：本模块原子件共用（resolveTimeZone 每次 new Intl.DateTimeFormat，重复调用浪费）
let _tzCache = null;
function tzCached() {
  return _tzCache || (_tzCache = resolveTimeZone());
}

// <current_time>Sat 26-08-15 12:37:16</current_time>（两位年份补全；容忍标签内空格、周几前缀、可选秒）
function parseCurrentTimeTagLoose(value) {
  const m = String(value || "").match(/<\s*current_time\s*>\s*(?:[A-Za-z]{2,4}\s+)?(\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: 2000 + Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0 }, tzCached());
}

// 行首墙上时间（「（」前缀容忍；四位年份、日期分隔符成对复用；时分可选——只有日期时按当天 00:00。
// 墙上时间必须按业务时区解析，不能按服务器本地时区——换 UTC 主机会整体偏移）
function parseLeadingWallTime(value) {
  const m = String(value || "").match(/^（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(?:(\d{1,2})[:：](\d{2}))?/);
  if (!m) return null;
  return zonedWallTimeToDate({ year: Number(m[1]), month: Number(m[3]), day: Number(m[4]), hour: m[5] ? Number(m[5]) : 0, minute: m[6] ? Number(m[6]) : 0 }, tzCached());
}

// 行尾时间缀（客户端自动注入的墙上时间）
function parseTrailingWallTime(value) {
  const m = String(value || "").match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2})\s*$/);
  return m ? parseLeadingWallTime(m[1]) : null;
}

// 消息内容拍平（多模态 content 数组 → 纯文本）
function contentToTextLoose(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(function (p) { return typeof p === "string" ? p : (p && typeof p === "object" ? (p.text || p.content || "") : ""); })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// 标准消息时间链（与原 context-compactor 链一致）：msg.time 字段 → <current_time> 标签 → 行尾缀 → 行首前缀
function parseMsgTimestamp(msg) {
  if (msg && msg.time) {
    const d = new Date(msg.time);
    if (!isNaN(d.getTime())) return d;
  }
  const text = contentToTextLoose(msg && msg.content);
  return parseCurrentTimeTagLoose(text) || parseTrailingWallTime(text) || parseLeadingWallTime(text);
}

module.exports = {
  contentToTextLoose,
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  nowIso,
  parseCurrentTimeTagLoose,
  parseLeadingWallTime,
  parseMsgTimestamp,
  parseTrailingWallTime,
  parseWakeTarget,
  resolveTimeZone,
  zonedWallTimeToDate
};
