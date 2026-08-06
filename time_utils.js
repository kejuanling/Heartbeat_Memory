const DEFAULT_TIME_ZONE = "Asia/Shanghai";

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

function formatDateTimeInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function getHourInTimeZone(date = new Date(), timeZone = resolveTimeZone()) {
  return Number(getDatePartsInTimeZone(date, timeZone).hour);
}

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

function zonedWallTimeToDate({ year, month, day, hour, minute }, timeZone = resolveTimeZone()) {
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0
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

module.exports = {
  DEFAULT_TIME_ZONE,
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
};
