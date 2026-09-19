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
// 返回 { at: Date }（日期时间）或 { minutes: number }（分钟）；无法解析返回 null。
function parseWakeTarget(raw, timeZone = resolveTimeZone()) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // 纯数字 → 分钟（1~1440，与旧 <wake> 语义一致）
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isInteger(n) && n >= 1) return { minutes: Math.min(1440, n) };
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
        if (next && !Number.isNaN(next.getTime())) return { at: next };
        return null;
      }
      return { at: candidate };
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
        return { at: date };
      }
    }
  }
  return null;
}

// 当前时刻的 UTC ISO 串（落库 time 字段统一用）
function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  DEFAULT_TIME_ZONE,
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  nowIso,
  parseWakeTarget,
  resolveTimeZone,
  zonedWallTimeToDate
};
