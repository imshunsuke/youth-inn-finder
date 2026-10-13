import { AppError, invalidInput } from './errors.mjs';
import { addDays, todayInShanghai, validateStayDates } from './dates.mjs';
import { parseCommonQuery } from './query.mjs';

export const REMINDER_INTERVAL_MS = 15 * 60_000;
export const OBSERVATION_MAX_AGE_MS = 20 * 60_000;
export const VERIFY_TOKEN_MS = 30 * 60_000;
export const MANAGEMENT_TOKEN_MS = 30 * 24 * 60 * 60_000;

export function invitationRequired(env = {}) { return env.INVITATION_REQUIRED === 'true' || env.INVITATION_REQUIRED === true; }

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n\x00-\x1f]/.test(value)) {
    throw invalidInput('请输入有效邮箱', 'email');
  }
  const email = value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw invalidInput('请输入有效邮箱', 'email');
  return email;
}

export function normalizeConditions(value, { clock = () => new Date() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidInput('提醒条件格式无效', 'conditions');
  const dates = validateStayDates(value.date, value.endDate || null);
  const today = todayInShanghai(clock);
  if (dates.startDate < today || dates.startDate > addDays(today, 90) ||
      (dates.endDate && dates.endDate > addDays(dates.startDate, 30))) {
    throw invalidInput('提醒日期需在未来 90 天内，连续入住不超过 30 晚', 'date');
  }
  const query = parseCommonQuery({ ...value, lat: undefined, lon: undefined, sort: 'availability', limit: 200 });
  if (dates.endDate && !query.stationId) throw invalidInput('连续入住提醒请选择一个驿站', 'stationId');
  return { date: dates.startDate, endDate: dates.endDate, district: query.district, q: query.keyword,
    stationId: query.stationId, minCount: query.minCount, houseType: query.houseType, onlyOnShelf: query.onlyOnShelf };
}

export function publicReminder(row) {
  return { id: row.id, conditions: row.conditions ?? JSON.parse(row.conditions_json), status: row.status,
    conditionVersion: row.condition_version, createdAt: row.created_at, updatedAt: row.updated_at,
    verifiedAt: row.verified_at ?? null, lastCheckedAt: row.last_checked_at ?? null,
    nextCheckAt: row.next_check_at ?? null };
}

export function reminderDisabled() {
  return new AppError('邮件提醒尚未开启，请稍后再试', { code: 'REMINDERS_UNAVAILABLE', status: 503, retryable: true });
}

// Positive evidence can be useful with partial coverage. A negative observation
// requires complete coverage; unknown/stale/not-open never re-arm a sent reminder.
export function evaluateObservation(result, { now = Date.now(), maxAgeMs = OBSERVATION_MAX_AGE_MS, minCount = 1 } = {}) {
  if (!result || !Array.isArray(result.data) || ['not-open', 'stale', 'unknown'].includes(result.meta?.availabilityStatus)) return { state: 'unknown', matches: [], observedAt: null };
  const fresh = (timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) &&
    Date.parse(timestamp) <= now + 60_000 && now - Date.parse(timestamp) <= maxAgeMs;
  const matches = result.data.filter((item) => item.availabilityStatus === 'known' &&
    Number.isSafeInteger(item.availableCount) && item.availableCount >= minCount && fresh(item.fetchedAt));
  if (matches.length) return { state: 'matched', matches, observedAt: matches.map((item) => item.fetchedAt).sort()[0] };
  const meta = result.meta ?? {};
  const coverage = meta.coverage ?? {};
  const complete = result.data.length === 0 && meta.partial !== true && meta.availabilityStatus === 'known' &&
    Number.isInteger(coverage.totalStations) && coverage.totalStations >= 0 &&
    coverage.successfulStations === coverage.totalStations && coverage.failedStations === 0 &&
    coverage.unknownStations === 0 && fresh(meta.fetchedAt);
  return { state: complete ? 'empty' : 'unknown', matches: [], observedAt: complete ? meta.fetchedAt : null };
}
