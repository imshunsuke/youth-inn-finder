import { AppError, invalidInput } from "./errors.mjs";

export const BUSINESS_TIME_ZONE = "Asia/Shanghai";
const shanghaiDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function clockDate(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AppError("时钟配置无效");
  return date;
}

export function nowIso(clock) {
  return clockDate(clock).toISOString();
}

export function todayInShanghai(clock) {
  const parts = shanghaiDateFormatter.formatToParts(clockDate(clock));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseIsoDate(value, field = "date", label = "日期") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidInput(`${label}必须是 YYYY-MM-DD`, field);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalidInput(`${label}不是有效日期`, field);
  }
  return value;
}

export function addDays(value, offset) {
  const date = new Date(`${parseIsoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  const result = date.toISOString().slice(0, 10);
  return parseIsoDate(result);
}

export function validateStayDates(startDate, endDate = null) {
  const start = parseIsoDate(startDate, "date", "入住日期");
  if (endDate === null || endDate === undefined) return { startDate: start, endDate: null };
  const end = parseIsoDate(endDate, "endDate", "离店日期");
  if (end <= start) throw invalidInput("离店日期必须晚于入住日期", "endDate");
  return { startDate: start, endDate: end };
}
