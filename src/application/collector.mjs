import { AppError } from "../domain/errors.mjs";
import { addDays, clockDate, todayInShanghai, validateStayDates } from "../domain/dates.mjs";
import { filterListings, parseCommonQuery } from "../domain/query.mjs";
import { createOfficialClient } from "../infrastructure/official-client.mjs";
import { createSnapshotStore, projectCollectorListings } from "../infrastructure/snapshot-store.mjs";

const backoff = (failures) => Math.min(15 * 60_000, 60_000 * 2 ** Math.min(8, Math.max(0, failures - 1)));
const safeCode = (error) => error instanceof AppError ? error.code : "COLLECTION_ERROR";

async function mapConcurrent(items, worker, concurrency = 3) {
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await worker(items[index]); }
  }));
  return results;
}

function catalogItems(row) {
  if (Array.isArray(row?.items)) return row.items;
  try { const payload = JSON.parse(row?.payload_json ?? "null"); return Array.isArray(payload?.items) ? payload.items : []; }
  catch { return []; }
}

/** Durable, bounded collector. Each run counts actual fetch() calls (including both
 * catalog types), never exceeds 30, and makes at most 3 at once. A D1 lease and fenced
 * writes protect overlapping Cron invocations/restarts; there are no process locks.
 * Use the configured Cron to fill 90 stations in several slices. Reminder evaluation
 * can still use its independently persisted 15-minute due time.
 */
export function createCollector({ db, clock = () => new Date(), fetchImpl = (...args) => globalThis.fetch(...args),
  budget = 30, concurrency = 3, maxCatalogRefreshes = 2, leaseMs = 180_000, timeoutMs = 12_000,
  catalogRefreshMs = 15 * 60_000, calendarRefreshMs = 15 * 60_000,
  intervalRefreshMs = 15 * 60_000, maxIntervalJobs = 300, baseUrl,
  leaseWaitMs = 0, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(budget) || budget < 1 || budget > 30) throw new TypeError("Collector budget must be 1–30");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new TypeError("Collector concurrency must be 1–3");
  if (!Number.isInteger(maxCatalogRefreshes) || maxCatalogRefreshes < 1 || maxCatalogRefreshes > 2) throw new TypeError("Collector catalog refresh limit must be 1–2");
  if (!Number.isFinite(leaseMs) || leaseMs < 1) throw new TypeError("Invalid collector lease duration");
  if (!Number.isFinite(leaseWaitMs) || leaseWaitMs < 0 || leaseWaitMs > 25_000 || typeof wait !== "function") throw new TypeError("Invalid collector wait budget");
  const store = createSnapshotStore({ db, clock });
  const now = () => clockDate(clock).getTime();

  async function queueActiveIntervals(catalogs, lease, rows) {
    if (!rows.length) return { activeReminders: 0, accepted: 0, invalid: 0, reminderCursor: lease.reminderCursor };
    const byType = new Map(catalogs.map((row) => [row.house_type, catalogItems(row)]));
    const tasks = new Map();
    let invalid = 0;
    const today = todayInShanghai(clock);
    for (const row of rows) {
      try {
        const conditions = JSON.parse(row.conditions_json);
        if (!conditions.endDate) continue;
        const query = parseCommonQuery(conditions);
        const dates = validateStayDates(conditions.date, conditions.endDate);
        if (dates.startDate < today || dates.startDate > addDays(today, 90) || dates.endDate > addDays(dates.startDate, 30)) continue;
        const expiresAt = Math.min(now() + 45 * 60_000, Date.parse(`${dates.startDate}T00:00:00+08:00`));
        for (const station of filterListings(byType.get(query.houseType) ?? [], query)) {
          const key = JSON.stringify([station.id, dates.startDate, dates.endDate]);
          if (tasks.size < maxIntervalJobs || tasks.has(key)) tasks.set(key, { stationId: String(station.id), ...dates, expiresAt });
        }
      } catch { invalid += 1; }
    }
    await store.reconcileIntervalPriorities([...tasks.values()], { lease, complete: rows.length < 200 });
    const queued = await store.enqueueIntervalJobs([...tasks.values()], { maxJobs: maxIntervalJobs, lease, priority: 1 });
    return { activeReminders: rows.length, accepted: queued.accepted, invalid, capacityLimited: queued.capacityLimited,
      reminderCursor: rows.at(-1)?.id ?? lease.reminderCursor };
  }

  async function run() {
    let lease = await store.acquireLease({ leaseMs });
    const deadline = now() + leaseWaitMs;
    if (!lease && leaseWaitMs > 0) await store.requestCollectionTurn(leaseWaitMs + 5000);
    while (!lease && now() < deadline) {
      await wait(Math.min(2500, deadline - now()));
      lease = await store.acquireLease({ leaseMs });
    }
    if (!lease) return { status: "skipped", reason: "lease-held", requestsUsed: 0, budget };
    let requestsUsed = 0, finished = false;
    const client = createOfficialClient({ clock, concurrency, cacheTtlMs: 0, timeoutMs, ...(baseUrl ? { baseUrl } : {}),
      fetchImpl: async (...args) => {
        if (requestsUsed >= budget) throw new AppError("采集请求预算已用完", { code: "COLLECTION_BUDGET_EXHAUSTED", status: 503 });
        requestsUsed += 1;
        return fetchImpl(...args);
      },
    });
    const report = { status: "collected", budget, requestsUsed: 0,
      catalogs: { attempted: 0, succeeded: 0, failed: 0 }, calendars: { attempted: 0, succeeded: 0, failed: 0 },
      intervals: { attempted: 0, succeeded: 0, failed: 0 } };
    try {
      const inputs = await store.readCollectorInputs(lease);
      const rows = new Map(inputs.catalogs.map((row) => [row.house_type, row]));
      const types = lease.catalogCursor === 1 ? ["1", "0"] : ["0", "1"];
      let nextCatalogCursor = lease.catalogCursor;
      for (const type of types) {
        if (report.catalogs.attempted >= maxCatalogRefreshes) break;
        const previous = rows.get(type);
        const fetchedAt = Date.parse(previous?.fetched_at ?? "");
        const due = !previous?.has_payload || !Number.isFinite(fetchedAt) || now() < fetchedAt || now() - fetchedAt >= catalogRefreshMs;
        if (!due || (previous?.next_attempt_at ?? 0) > now() || requestsUsed >= budget) continue;
        report.catalogs.attempted += 1;
        nextCatalogCursor = type === "0" ? 1 : 0;
        try {
          const result = await client.fetchListings({ houseType: type });
          if (!await store.saveCatalog(type, result, { lease })) return { ...report, status: "lease-lost", requestsUsed };
          rows.set(type, { house_type: type, items: projectCollectorListings(result.items), has_payload: 1,
            fetched_at: result.fetchedAt, failure_count: 0, next_attempt_at: 0 });
          report.catalogs.succeeded += 1;
        } catch (error) {
          await store.recordCatalogFailure(type, safeCode(error), now() + backoff((previous?.failure_count ?? 0) + 1), { lease });
          report.catalogs.failed += 1;
        }
      }
      const reminders = await queueActiveIntervals([...rows.values()], lease, inputs.reminders);
      const allIds = [...new Set([...rows.values()].flatMap(catalogItems).map((item) => String(item.id)))].sort();
      const calendarRows = new Map(inputs.calendars.map((row) => [row.station_id, row]));
      const orderedIds = [...allIds.filter((id) => id > lease.calendarCursor), ...allIds.filter((id) => id <= lease.calendarCursor)];
      const dueCalendars = orderedIds.filter((id) => {
        const row = calendarRows.get(id);
        const fetchedAt = Date.parse(row?.fetched_at ?? "");
        return (row?.next_attempt_at ?? 0) <= now() && (!row?.has_payload || !Number.isFinite(fetchedAt) || now() < fetchedAt || now() - fetchedAt >= calendarRefreshMs);
      });
      const remaining = budget - requestsUsed;
      const dueIntervals = await store.dueIntervalJobs(remaining);
      // Share the slice evenly while both kinds are due. At one third, a cold
      // 90-station range can expire before its last stations are collected.
      const urgentCalendars = dueCalendars.filter((id) => {
        const at = Date.parse(calendarRows.get(id)?.fetched_at ?? "");
        return Number.isFinite(at) && now() - at >= 17 * 60_000;
      });
      const urgentCalendarCount = urgentCalendars.length;
      // Close-to-expiry calendars get most of a small Cron slice. Leave one
      // interval slot so reminder work cannot starve behind a cold calendar.
      const intervalAllowance = urgentCalendarCount ? Math.max(1, remaining - urgentCalendarCount) : Math.max(1, Math.floor(remaining / 2));
      const intervalSlots = Math.min(dueIntervals.length, dueCalendars.length ? intervalAllowance : remaining);
      const calendarSlots = Math.min(dueCalendars.length, Math.max(0, remaining - intervalSlots));
      const intervalCount = Math.min(dueIntervals.length, remaining - calendarSlots);
      const urgentIds = new Set(urgentCalendars);
      const selectedCalendars = [...urgentCalendars, ...dueCalendars.filter((id) => !urgentIds.has(id))].slice(0, calendarSlots);
      const selectedIntervals = dueIntervals.slice(0, intervalCount);
      if (!await store.hasLease(lease)) return { ...report, status: "lease-lost", requestsUsed };
      const tasks = [...selectedCalendars.map((stationId) => ({ kind: "calendar", stationId })),
        ...selectedIntervals.map((job) => ({ kind: "interval", stationId: job.station_id, startDate: job.start_date, endDate: job.end_date, failureCount: job.failure_count }))];
      const outcomes = await mapConcurrent(tasks, async (task) => {
        try {
          const result = task.kind === "calendar" ? await client.fetchCalendar(task.stationId)
            : await client.fetchDateAvailability(task.stationId, task.startDate, task.endDate);
          return { ...task, ...result, ok: true };
        } catch (error) {
          const failureCount = task.kind === "calendar" ? (calendarRows.get(task.stationId)?.failure_count ?? 0) + 1 : task.failureCount + 1;
          return { ...task, ok: false, code: safeCode(error), failureCount, nextAttemptAt: now() + backoff(failureCount) };
        }
      }, concurrency);
      const calendars = outcomes.filter((item) => item.kind === "calendar");
      const intervals = outcomes.filter((item) => item.kind === "interval");
      const advanced = await store.finishCollection(lease, { calendars, intervals, refreshMs: intervalRefreshMs, cursors: {
        calendarCursor: selectedCalendars.at(-1) ?? lease.calendarCursor, catalogCursor: nextCatalogCursor,
        reminderCursor: reminders.reminderCursor,
      } });
      finished = true;
      for (const [name, values] of [["calendars", calendars], ["intervals", intervals]]) {
        report[name] = { attempted: values.length, succeeded: values.filter((item) => item.ok).length, failed: values.filter((item) => !item.ok).length };
      }
      return { ...report, status: advanced ? "collected" : "lease-lost", requestsUsed, reminders,
        calendarCursor: selectedCalendars.at(-1) ?? lease.calendarCursor, queuedIntervalTasks: dueIntervals.length };
    } finally {
      if (!finished) await store.releaseLease(lease);
    }
  }
  return Object.freeze({ run });
}
