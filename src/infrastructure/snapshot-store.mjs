import { AppError, invalidInput } from "../domain/errors.mjs";
import { addDays, clockDate, todayInShanghai, validateStayDates } from "../domain/dates.mjs";
import { filterListings, parseCommonQuery, parseHouseType } from "../domain/query.mjs";

export const DEFAULT_SNAPSHOT_FRESHNESS = Object.freeze({
  catalogMaxAgeMs: 20 * 60_000,
  calendarMaxAgeMs: 20 * 60_000,
  intervalMaxAgeMs: 20 * 60_000,
});
const intervalKey = (stationId, startDate, endDate) => JSON.stringify([String(stationId), startDate, endDate]);
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const allRows = async (statement) => (await statement.all()).results ?? [];
const json = (value) => JSON.stringify(value);
const leaseGuard = "EXISTS (SELECT 1 FROM query_collector_state WHERE name = 'official' AND lease_token = ? AND lease_until > ?)";

function snapshotUnavailable(status = "missing") {
  return new AppError(status === "stale" ? "房源数据正在更新，请稍后重试" : "正在收集房源数据，请稍后重试", {
    code: status === "stale" ? "SNAPSHOT_STALE" : "SNAPSHOT_PENDING", status: 503,
    retryable: true, details: { snapshotStatus: status },
  });
}

function snapshot(row, now, maxAgeMs, validate) {
  if (!row?.payload_json || !row.fetched_at) return { status: "missing", fetchedAt: row?.fetched_at ?? null, lastErrorCode: row?.last_error_code ?? null };
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { return { status: "invalid", fetchedAt: row.fetched_at, lastErrorCode: "INVALID_SNAPSHOT" }; }
  if (!validate(payload) || !Number.isFinite(Date.parse(row.fetched_at))) {
    return { status: "invalid", fetchedAt: row.fetched_at, lastErrorCode: "INVALID_SNAPSHOT" };
  }
  const age = now - Date.parse(row.fetched_at);
  return { status: age < 0 || age >= maxAgeMs ? "stale" : "fresh", payload, fetchedAt: row.fetched_at,
    lastAttemptAt: row.last_attempt_at, lastErrorCode: row.last_error_code ?? null };
}

/** D1 adapter: only public snapshots/jobs; never reads or writes a user's identity. */
export function createSnapshotStore({ db, clock = () => new Date() } = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") throw new TypeError("A D1-compatible database is required");
  const now = () => clockDate(clock).getTime();
  const prepare = (sql, values = []) => db.prepare(sql).bind(...values);
  const fencedValues = (lease) => [lease?.token ?? "", now()];
  const guard = (lease) => lease ? leaseGuard : "1 = 1";
  const guardedBindings = (lease) => lease ? fencedValues(lease) : [];

  async function readCatalog(houseType = "0", { maxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.catalogMaxAgeMs, compact = false, stationId } = {}) {
    const type = parseHouseType(houseType);
    let row;
    if (compact || stationId) {
      const valid = "CASE WHEN json_valid(c.payload_json) THEN json_type(c.payload_json,'$.items')='array' ELSE 0 END";
      row = await prepare(`SELECT c.fetched_at,c.last_attempt_at,c.last_error_code,c.payload_json IS NOT NULL AS has_payload,
        CASE WHEN ${valid} THEN (SELECT json_group_array(json(CASE WHEN item.type='object'
          THEN ${compact ? "json_remove(item.value,'$.officialUrl')" : "item.value"} ELSE 'null' END))
          FROM json_each(c.payload_json,'$.items') item ${stationId ? "WHERE CASE WHEN item.type='object' THEN json_extract(item.value,'$.id') END=?" : ""}) END AS items_json
        FROM query_catalogs c WHERE c.house_type=?`, [...(stationId ? [stationId] : []), type]).first();
      if (row) row.payload_json = row.items_json ? `{"items":${row.items_json}}` : row.has_payload ? "null" : null;
    } else row = await prepare("SELECT * FROM query_catalogs WHERE house_type = ?", [type]).first();
    return snapshot(row, now(), maxAgeMs, (payload) => Array.isArray(payload?.items) && payload.items.every((item) =>
      item && typeof item === "object" && typeof item.id === "string" && item.id && typeof item.name === "string"));
  }

  async function readCatalogRows() { return allRows(prepare("SELECT * FROM query_catalogs ORDER BY house_type")); }
  async function readCalendarRows() { return allRows(prepare("SELECT * FROM query_calendars ORDER BY station_id")); }

  // Collection needs membership/filter fields, not the much larger encoded official
  // detail URLs. Project inside D1 so those bytes never enter the collecting Worker.
  // Full catalog reads above remain unchanged for the public query adapter.
  function collectorCatalogStatement() {
    const valid = "CASE WHEN json_valid(c.payload_json) THEN CASE WHEN json_type(c.payload_json, '$.items')='array' THEN 1 ELSE 0 END ELSE 0 END";
    return prepare(`SELECT c.house_type, c.fetched_at, c.last_attempt_at,
      c.last_error_code, c.failure_count, c.next_attempt_at, ${valid} AS has_payload,
      (SELECT json_group_array(json_object(
        'id', json_extract(item.value, '$.id'), 'name', json_extract(item.value, '$.name'),
        'district', json_extract(item.value, '$.district'), 'address', json_extract(item.value, '$.address'),
        'street', json_extract(item.value, '$.street'),
        'isOnShelf', json(CASE json_extract(item.value, '$.isOnShelf') WHEN 1 THEN 'true' WHEN 0 THEN 'false' ELSE 'null' END)))
        FROM json_each(CASE WHEN ${valid}=1 THEN c.payload_json ELSE '{"items":[]}' END, '$.items') AS item) AS items_json
      FROM query_catalogs c ORDER BY c.house_type`);
  }
  const collectorCatalogs = (rows) => rows.map(({ items_json, ...metadata }) => ({ ...metadata, items: JSON.parse(items_json || "[]") }));
  async function readCollectorCatalogRows() { return collectorCatalogs(await allRows(collectorCatalogStatement())); }

  // No calendar payload is needed to decide which station is due. Scope the single
  // metadata query to current membership and leave actual date data in D1.
  function collectorCalendarStatement(stationIds) {
    const valid = "CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json, '$.calendar')='object' THEN 1 ELSE 0 END ELSE 0 END";
    return prepare(`SELECT station_id, fetched_at, last_attempt_at, last_error_code,
      failure_count, next_attempt_at, ${valid} AS has_payload FROM query_calendars
      ${stationIds ? "WHERE station_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))" : ""}
      ORDER BY station_id`, stationIds ? [json(stationIds)] : []);
  }
  async function readCollectorCalendarRows(stationIds) {
    return stationIds?.length === 0 ? [] : allRows(collectorCalendarStatement(stationIds));
  }

  async function readCollectorInputs(lease) {
    // Independent planning reads share one D1 round trip. Calendar payloads and
    // encoded official URLs stay out of the Worker. Newly listed IDs are simply
    // missing in this metadata map and will be collected normally.
    try {
      const result = await db.batch([collectorCatalogStatement(), collectorCalendarStatement(),
        prepare("SELECT id,conditions_json FROM reminders WHERE status='active' ORDER BY (id>?) DESC,id LIMIT 200", [lease.reminderCursor]),
        prepare(`UPDATE interval_query_jobs SET priority=0,priority_until=0 WHERE priority=1
          AND (priority_until<=? OR NOT EXISTS(SELECT 1 FROM reminders WHERE status='active')) AND ${guard(lease)}`,
        [now(), ...guardedBindings(lease)])]);
      return { catalogs: collectorCatalogs(result[0].results), calendars: result[1].results, reminders: result[2].results };
    } catch (error) {
      if (!String(error.message).includes("no such table")) throw error;
      const result = await db.batch([collectorCatalogStatement(), collectorCalendarStatement()]);
      await reconcileIntervalPriorities([], { lease, complete: true });
      return { catalogs: collectorCatalogs(result[0].results), calendars: result[1].results, reminders: [] };
    }
  }

  async function readCalendars(stationIds, { maxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.calendarMaxAgeMs } = {}) {
    const rows = stationIds.length ? await allRows(prepare(
      "SELECT * FROM query_calendars WHERE station_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))", [json(stationIds)])) : [];
    const byId = new Map(rows.map((row) => [row.station_id, row]));
    return new Map(stationIds.map((id) => [String(id), snapshot(byId.get(String(id)), now(), maxAgeMs,
      (payload) => payload?.calendar && typeof payload.calendar === "object" && !Array.isArray(payload.calendar))]));
  }

  async function readIntervals(stationIds, startDate, endDate, { maxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.intervalMaxAgeMs } = {}) {
    const rows = stationIds.length ? await allRows(prepare(
      "SELECT * FROM query_intervals WHERE start_date = ? AND end_date = ? AND station_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",
      [startDate, endDate, json(stationIds)])) : [];
    const byId = new Map(rows.map((row) => [row.station_id, row]));
    return new Map(stationIds.map((id) => [String(id), snapshot(byId.get(String(id)), now(), maxAgeMs,
      (payload) => payload && ((payload.availabilityStatus === "unknown" && payload.availableCount === null) ||
        (payload.availabilityStatus === "known" && Number.isSafeInteger(payload.availableCount) && payload.availableCount >= 0)))]));
  }

  async function saveCatalog(houseType, result, { lease } = {}) {
    const saved = await prepare(`INSERT INTO query_catalogs
      (house_type, payload_json, fetched_at, last_attempt_at, last_error_code, failure_count, next_attempt_at)
      SELECT ?, ?, ?, ?, NULL, 0, 0 WHERE ${guard(lease)}
      ON CONFLICT (house_type) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at,
      last_attempt_at=excluded.last_attempt_at, last_error_code=NULL, failure_count=0, next_attempt_at=0`,
    [parseHouseType(houseType), json({ items: result.items }), result.fetchedAt, now(), ...guardedBindings(lease)]).run();
    return changes(saved) > 0;
  }

  async function recordCatalogFailure(houseType, code, nextAttemptAt, { lease } = {}) {
    return changes(await prepare(`INSERT INTO query_catalogs
      (house_type, last_attempt_at, last_error_code, failure_count, next_attempt_at)
      SELECT ?, ?, ?, 1, ? WHERE ${guard(lease)}
      ON CONFLICT (house_type) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
      last_error_code=excluded.last_error_code, failure_count=query_catalogs.failure_count+1, next_attempt_at=excluded.next_attempt_at`,
    [parseHouseType(houseType), now(), code, nextAttemptAt, ...guardedBindings(lease)]).run()) > 0;
  }

  // Bulk JSON inserts keep a 30-fetch collection comfortably below D1's per-invocation
  // query count. Every mutation is fenced by the current durable lease when supplied.
  function calendarStatements(successes, failures = [], { lease } = {}) {
    const statements = [];
    if (successes.length) statements.push(prepare(`INSERT INTO query_calendars
      (station_id, payload_json, fetched_at, last_attempt_at, last_error_code, failure_count, next_attempt_at)
      SELECT json_extract(value, '$.stationId'), json_extract(value, '$.payloadJson'), json_extract(value, '$.fetchedAt'), ?, NULL, 0, 0
      FROM json_each(?) WHERE ${guard(lease)}
      ON CONFLICT (station_id) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at,
      last_attempt_at=excluded.last_attempt_at, last_error_code=NULL, failure_count=0, next_attempt_at=0`,
    [now(), json(successes.map((item) => ({ stationId: String(item.stationId), payloadJson: json({ calendar: item.calendar }), fetchedAt: item.fetchedAt }))), ...guardedBindings(lease)]));
    if (failures.length) statements.push(prepare(`INSERT INTO query_calendars
      (station_id, last_attempt_at, last_error_code, failure_count, next_attempt_at)
      SELECT json_extract(value, '$.stationId'), ?, json_extract(value, '$.code'), 1, json_extract(value, '$.nextAttemptAt')
      FROM json_each(?) WHERE ${guard(lease)}
      ON CONFLICT (station_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_error_code=excluded.last_error_code,
      failure_count=query_calendars.failure_count+1, next_attempt_at=excluded.next_attempt_at`,
    [now(), json(failures), ...guardedBindings(lease)]));
    return statements;
  }
  async function saveCalendarBatch(successes, failures = [], options = {}) {
    const statements = calendarStatements(successes, failures, options);
    return statements.length ? db.batch(statements) : [];
  }

  function intervalStatements(successes, failures = [], { lease, refreshMs = 15 * 60_000 } = {}) {
    const statements = [];
    const attemptAt = now();
    if (successes.length) statements.push(prepare(`INSERT INTO query_intervals
      (station_id, start_date, end_date, payload_json, fetched_at, last_attempt_at, last_error_code)
      SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate'),
      json_extract(value, '$.payloadJson'), json_extract(value, '$.fetchedAt'), ?, NULL
      FROM json_each(?) WHERE ${guard(lease)}
      ON CONFLICT (station_id, start_date, end_date) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at,
      last_attempt_at=excluded.last_attempt_at, last_error_code=NULL`,
    [attemptAt, json(successes.map((item) => ({ ...item, payloadJson: json({ availabilityStatus: item.availabilityStatus, availableCount: item.availableCount }) }))), ...guardedBindings(lease)]));
    if (failures.length) statements.push(prepare(`INSERT INTO query_intervals
      (station_id, start_date, end_date, last_attempt_at, last_error_code)
      SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate'), ?, json_extract(value, '$.code')
      FROM json_each(?) WHERE ${guard(lease)}
      ON CONFLICT (station_id, start_date, end_date) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, last_error_code=excluded.last_error_code`,
    [attemptAt, json(failures), ...guardedBindings(lease)]));
    const updates = [...successes.map((item) => ({ ...item, nextAttemptAt: attemptAt + refreshMs, failureCount: 0, code: null })),
      ...failures.map((item) => ({ ...item, failureCount: item.failureCount ?? 1 }))];
    if (updates.length) statements.push(prepare(`UPDATE interval_query_jobs AS job SET
      next_attempt_at = (SELECT json_extract(value, '$.nextAttemptAt') FROM json_each(?) WHERE
        json_extract(value, '$.stationId')=job.station_id AND json_extract(value, '$.startDate')=job.start_date AND json_extract(value, '$.endDate')=job.end_date),
      failure_count = (SELECT json_extract(value, '$.failureCount') FROM json_each(?) WHERE
        json_extract(value, '$.stationId')=job.station_id AND json_extract(value, '$.startDate')=job.start_date AND json_extract(value, '$.endDate')=job.end_date),
      last_error_code = (SELECT json_extract(value, '$.code') FROM json_each(?) WHERE
        json_extract(value, '$.stationId')=job.station_id AND json_extract(value, '$.startDate')=job.start_date AND json_extract(value, '$.endDate')=job.end_date),
      updated_at = ? WHERE (station_id, start_date, end_date) IN
      (SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate') FROM json_each(?))
      AND ${guard(lease)}`, [json(updates), json(updates), json(updates), attemptAt, json(updates), ...guardedBindings(lease)]));
    // Public lookups are one-shot work. Keep the snapshot, but release their slots
    // in the same transaction; only live reminder jobs need periodic refreshes.
    if (successes.length) statements.push(prepare(`DELETE FROM interval_query_jobs
      WHERE (priority=0 OR priority_until<=?) AND (station_id, start_date, end_date) IN
        (SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate') FROM json_each(?))
      AND ${guard(lease)}`, [attemptAt, json(successes), ...guardedBindings(lease)]));
    return statements;
  }
  async function saveIntervalBatch(successes, failures = [], options = {}) {
    const statements = intervalStatements(successes, failures, options);
    return statements.length ? db.batch(statements) : [];
  }

  async function finishCollection(lease, { calendars = [], intervals = [], cursors = {}, refreshMs = 15 * 60_000 } = {}) {
    const statements = [...calendarStatements(calendars.filter((x) => x.ok), calendars.filter((x) => !x.ok), { lease }),
      ...intervalStatements(intervals.filter((x) => x.ok), intervals.filter((x) => !x.ok), { lease, refreshMs })];
    const cursorIndex = statements.length;
    statements.push(prepare(`UPDATE query_collector_state SET calendar_cursor=COALESCE(?,calendar_cursor),
      catalog_cursor=COALESCE(?,catalog_cursor),reminder_cursor=COALESCE(?,reminder_cursor),updated_at=?
      WHERE name='official' AND lease_token=? AND lease_until>?`,
    [cursors.calendarCursor ?? null, cursors.catalogCursor ?? null, cursors.reminderCursor ?? null, now(), ...fencedValues(lease)]),
    prepare("UPDATE query_collector_state SET lease_token=NULL,lease_until=0,interactive_reserved=0 WHERE name='official' AND lease_token=?", [lease.token]));
    const results = await db.batch(statements);
    return changes(results[cursorIndex]) > 0;
  }

  async function acquireLease({ token = globalThis.crypto.randomUUID(), leaseMs = 180_000 } = {}) {
    const at = now();
    const row = await prepare(`INSERT INTO query_collector_state
      (name, lease_token, lease_until, updated_at) VALUES ('official', ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET lease_token=excluded.lease_token, lease_until=excluded.lease_until, updated_at=excluded.updated_at, collection_wait_until=0
      WHERE query_collector_state.lease_until <= ? RETURNING *`, [token, at + leaseMs, at, at]).first();
    return row ? { token, expiresAt: row.lease_until, calendarCursor: row.calendar_cursor,
      catalogCursor: row.catalog_cursor, reminderCursor: row.reminder_cursor } : null;
  }

  async function hasLease(lease) {
    return Boolean(await prepare(`SELECT 1 AS owned WHERE ${leaseGuard}`, fencedValues(lease)).first());
  }

  async function requestCollectionTurn(ttlMs = 30_000) {
    await prepare("UPDATE query_collector_state SET collection_wait_until=MAX(collection_wait_until,?) WHERE name='official'", [now() + ttlMs]).run();
  }

  // The same fenced lease as Cron keeps total upstream concurrency bounded across
  // all visitors. Reserve quota atomically before fetching; failures also count.
  async function acquireInteractiveLease({ budget = 9, cooldownMs = 1000, dailyLimit = 6000, leaseMs = 60_000 } = {}) {
    const at = now(), day = Math.floor(at / 86_400_000), token = globalThis.crypto.randomUUID();
    const row = await prepare(`INSERT INTO query_collector_state
      (name,lease_token,lease_until,updated_at,interactive_started_at,interactive_day,interactive_requests,interactive_reserved)
      VALUES ('official',?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,updated_at=excluded.updated_at,
      interactive_started_at=excluded.interactive_started_at,interactive_day=excluded.interactive_day,
      interactive_reserved=CASE WHEN query_collector_state.interactive_day=?
        THEN MIN(?,?-query_collector_state.interactive_requests) ELSE ? END,
      interactive_requests=CASE WHEN query_collector_state.interactive_day=?
        THEN MIN(?,query_collector_state.interactive_requests+?) ELSE ? END
      WHERE query_collector_state.lease_until<=?
        AND query_collector_state.interactive_started_at<=?
        AND query_collector_state.collection_wait_until<=?
        AND (query_collector_state.interactive_day<>? OR query_collector_state.interactive_requests<?)
      RETURNING lease_until,interactive_reserved,interactive_day`,
    [token,at+leaseMs,at,at,day,budget,budget,day,budget,dailyLimit,budget,day,dailyLimit,budget,budget,at,at-cooldownMs,at,day,dailyLimit]).first();
    return row ? { token, expiresAt: row.lease_until, interactiveReserved: row.interactive_reserved, interactiveDay: row.interactive_day } : null;
  }

  async function advanceCursor(lease, { calendarCursor, catalogCursor, reminderCursor } = {}) {
    return changes(await prepare(`UPDATE query_collector_state SET calendar_cursor=COALESCE(?, calendar_cursor),
      catalog_cursor=COALESCE(?, catalog_cursor), reminder_cursor=COALESCE(?, reminder_cursor), updated_at=?
      WHERE name='official' AND lease_token=? AND lease_until>?`,
    [calendarCursor ?? null, catalogCursor ?? null, reminderCursor ?? null, now(), ...fencedValues(lease)]).run()) > 0;
  }

  async function releaseLease(lease, { interactiveUsed } = {}) {
    const refund = Number.isInteger(interactiveUsed) && Number.isInteger(lease.interactiveReserved)
      ? Math.max(0, lease.interactiveReserved - interactiveUsed) : 0;
    return changes(await prepare(`UPDATE query_collector_state SET lease_token=NULL, lease_until=0,interactive_reserved=0,
      interactive_requests=CASE WHEN interactive_day=? THEN MAX(0,interactive_requests-?) ELSE interactive_requests END
      WHERE name='official' AND lease_token=?`, [lease.interactiveDay ?? -1, refund, lease.token]).run()) > 0;
  }

  async function dueIntervalJobs(limit = 30) {
    // Interleave ranges rather than draining one 90-station range first. Within
    // each priority, ranges least recently attempted get the next turn. This also
    // rotates fairly when there are more ranges than this slice has slots.
    return allRows(prepare(`WITH due AS (
      SELECT *, CASE WHEN priority_until > ? THEN priority ELSE 0 END AS effective_priority
      FROM interval_query_jobs WHERE expires_at > ? AND next_attempt_at <= ?
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY effective_priority, start_date, end_date
        ORDER BY next_attempt_at, created_at, station_id) AS range_turn FROM due
    ) SELECT * FROM ranked AS job ORDER BY effective_priority DESC, range_turn,
      COALESCE((SELECT MAX(sample.last_attempt_at) FROM query_intervals AS sample
        WHERE sample.start_date=job.start_date AND sample.end_date=job.end_date), 0),
      next_attempt_at, created_at, station_id, start_date, end_date LIMIT ?`, [now(), now(), now(), limit]));
  }
  async function nextIntervalAttemptAt() {
    const row = await prepare("SELECT MIN(next_attempt_at) AS at FROM interval_query_jobs WHERE expires_at>?", [now()]).first();
    return row?.at ?? null;
  }

  async function enqueueIntervalQuery(conditions, { ttlMs = 30 * 60_000, maxJobs = 300,
    catalogMaxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.catalogMaxAgeMs,
    intervalMaxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.intervalMaxAgeMs, observations } = {}) {
    const query = parseCommonQuery(conditions);
    const dates = validateStayDates(conditions.date, conditions.endDate);
    if (!dates.endDate) throw invalidInput("区间采集必须提供离店日期", "endDate");
    const today = todayInShanghai(clock);
    if (dates.startDate < today || dates.startDate > addDays(today, 90) || dates.endDate > addDays(dates.startDate, 30)) {
      throw invalidInput("入住需在未来 90 天内，连续入住不超过 30 晚", "endDate");
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxJobs) || maxJobs < 1) throw new TypeError("Invalid interval queue configuration");
    const catalog = await readCatalog(query.houseType, { maxAgeMs: catalogMaxAgeMs, compact: true });
    if (catalog.status !== "fresh") throw snapshotUnavailable(catalog.status);
    const candidates = [...new Set(filterListings(catalog.payload.items, query).map((item) => String(item.id)))];
    const snapshots = observations ? new Map(observations.filter((item) => item.kind === "interval").map((item) => [item.stationId, item]))
      : await readIntervals(candidates, dates.startDate, dates.endDate, { maxAgeMs: intervalMaxAgeMs });
    const ids = candidates.filter((id) => snapshots.get(id)?.status !== "fresh");
    if (!ids.length) return { requested: 0, accepted: 0, capacityLimited: false };
    const at = now();
    const expiresAt = Math.min(at + ttlMs, Date.parse(`${dates.startDate}T00:00:00+08:00`));
    if (expiresAt <= at) return { requested: ids.length, accepted: 0, capacityLimited: false };
    return enqueueIntervalJobs(ids.map((stationId) => ({ stationId, startDate: dates.startDate, endDate: dates.endDate, expiresAt })), { maxJobs, intervalMaxAgeMs, publicTtlMs: ttlMs });
  }

  // Internal bulk admission for active reminder collection. Callers validate dates
  // and filter against a trusted catalog first; no reminder rows are mutated here.
  async function enqueueIntervalJobs(tasks, { maxJobs = 300, lease, priority = 0,
    reservedPriorityJobs = maxJobs >= 40 ? 40 : 0, priorityTtlMs = 45 * 60_000,
    intervalMaxAgeMs = DEFAULT_SNAPSHOT_FRESHNESS.intervalMaxAgeMs, publicTtlMs } = {}) {
    if (!tasks.length) return { requested: 0, accepted: 0, capacityLimited: false };
    if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new TypeError("Invalid interval queue capacity");
    if (!Number.isFinite(intervalMaxAgeMs) || intervalMaxAgeMs <= 0) throw new TypeError("Invalid interval snapshot freshness");
    if (publicTtlMs !== undefined && (!Number.isFinite(publicTtlMs) || publicTtlMs <= 0)) throw new TypeError("Invalid public queue lease");
    if (![0, 1].includes(priority) || !Number.isInteger(reservedPriorityJobs) || reservedPriorityJobs < 0 ||
        reservedPriorityJobs > maxJobs || !Number.isFinite(priorityTtlMs) || priorityTtlMs <= 0) {
      throw new TypeError("Invalid interval queue priority configuration");
    }
    const at = now();
    const byKey = new Map(tasks.map((task) => [intervalKey(task.stationId, task.startDate, task.endDate), task]));
    const jobs = [...byKey.values()].filter((task) => task.expiresAt > at)
      .map((task) => ({ ...task, priorityUntil: priority ? Math.min(task.expiresAt, at + priorityTtlMs) : 0 }));
    if (!jobs.length) return { requested: 0, accepted: 0, capacityLimited: false };
    const payload = json(jobs);
    const freshInterval = (stationId, startDate, endDate) => `EXISTS (SELECT 1 FROM query_intervals AS sample WHERE sample.station_id=${stationId}
      AND sample.start_date=${startDate} AND sample.end_date=${endDate} AND sample.fetched_at>? AND sample.fetched_at<=?
      AND CASE WHEN json_valid(sample.payload_json) THEN
        (json_extract(sample.payload_json,'$.availabilityStatus')='known' AND json_type(sample.payload_json,'$.availableCount')='integer'
          AND json_extract(sample.payload_json,'$.availableCount') BETWEEN 0 AND 9007199254740991)
        OR (json_extract(sample.payload_json,'$.availabilityStatus')='unknown' AND json_type(sample.payload_json,'$.availableCount')='null')
      ELSE 0 END)`;
    const freshJob = freshInterval("job.station_id", "job.start_date", "job.end_date");
    const freshIncoming = freshInterval("json_extract(value, '$.stationId')", "json_extract(value, '$.startDate')", "json_extract(value, '$.endDate')");
    const freshBindings = [new Date(at - intervalMaxAgeMs).toISOString(), new Date(at).toISOString()];
    // Public work cannot occupy the reserved reminder capacity. Active reminder
    // admission may evict ordinary work when an older/full queue needs space.
    // All admission/eviction is one transaction; retries and successful due times
    // survive priority promotion. Public refresh never extends priority_until.
    const statements = [
      prepare(`DELETE FROM interval_query_jobs WHERE expires_at <= ? AND ${guard(lease)}`, [at, ...guardedBindings(lease)]),
      prepare(`UPDATE interval_query_jobs SET priority=0, priority_until=0 WHERE priority=1
        AND priority_until<=? AND ${guard(lease)}`, [at, ...guardedBindings(lease)]),
      // Reclaim successful jobs left by older releases, even before their TTL.
      prepare(`DELETE FROM interval_query_jobs AS job WHERE priority=0 AND failure_count=0 AND last_error_code IS NULL
        AND ${freshJob} AND ${guard(lease)}`,
        [...freshBindings, ...guardedBindings(lease)]),
    ];
    // Bound older public leases to the current policy once, without moving their
    // deadline forward. Only the currently queried tasks are renewed below.
    if (publicTtlMs !== undefined) statements.push(prepare(`UPDATE interval_query_jobs SET expires_at=?
      WHERE priority=0 AND expires_at>? AND ${guard(lease)}`, [at+publicTtlMs,at+publicTtlMs,...guardedBindings(lease)]));
    const updateIndex = statements.length;
    statements.push(
      prepare(`UPDATE interval_query_jobs AS job SET expires_at=MAX(expires_at,
        (SELECT json_extract(value, '$.expiresAt') FROM json_each(?) WHERE json_extract(value, '$.stationId')=job.station_id
          AND json_extract(value, '$.startDate')=job.start_date AND json_extract(value, '$.endDate')=job.end_date)),
        priority=MAX(priority, ?), priority_until=CASE WHEN ?=1 THEN MAX(priority_until,
          (SELECT json_extract(value, '$.priorityUntil') FROM json_each(?) WHERE json_extract(value, '$.stationId')=job.station_id
            AND json_extract(value, '$.startDate')=job.start_date AND json_extract(value, '$.endDate')=job.end_date)) ELSE priority_until END,
        updated_at=?
        WHERE (station_id, start_date, end_date) IN
          (SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate') FROM json_each(?))
        AND ${guard(lease)} ${priority === 0 ? `AND NOT ${freshJob}` : ""}`,
      [payload, priority, priority, payload, at, payload, ...guardedBindings(lease), ...(priority === 0 ? freshBindings : [])]),
    );
    const evictionIndex = statements.length;
    if (priority === 1) statements.push(prepare(`DELETE FROM interval_query_jobs
      WHERE (station_id, start_date, end_date) IN (SELECT station_id, start_date, end_date FROM interval_query_jobs
        WHERE priority=0 ORDER BY expires_at, updated_at, station_id, start_date, end_date LIMIT MAX(0,
          (SELECT COUNT(*) FROM interval_query_jobs WHERE expires_at>?) +
          (SELECT COUNT(*) FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM interval_query_jobs
            WHERE station_id=json_extract(value, '$.stationId') AND start_date=json_extract(value, '$.startDate')
              AND end_date=json_extract(value, '$.endDate'))) - ?)) AND ${guard(lease)}`,
    [at, payload, maxJobs, ...guardedBindings(lease)]));
    const capacitySql = priority === 1
      ? "MAX(0, ? - (SELECT COUNT(*) FROM interval_query_jobs WHERE expires_at > ?))"
      : "MAX(0, MIN(? - (SELECT COUNT(*) FROM interval_query_jobs WHERE expires_at > ?), ? - (SELECT COUNT(*) FROM interval_query_jobs WHERE expires_at > ? AND priority=0)))";
    const capacityBindings = priority === 1 ? [maxJobs, at] : [maxJobs, at, maxJobs - reservedPriorityJobs, at];
    const insertIndex = statements.length;
    statements.push(prepare(`INSERT INTO interval_query_jobs
      (station_id, start_date, end_date, expires_at, priority, priority_until, created_at, updated_at)
        SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate'),
          json_extract(value, '$.expiresAt'), ?, json_extract(value, '$.priorityUntil'), ?, ? FROM json_each(?)
        WHERE NOT EXISTS (SELECT 1 FROM interval_query_jobs WHERE station_id=json_extract(value, '$.stationId')
          AND start_date=json_extract(value, '$.startDate') AND end_date=json_extract(value, '$.endDate')) AND ${guard(lease)} ${priority === 0 ? `AND NOT ${freshIncoming}` : ""}
        LIMIT ${capacitySql}`,
    [priority, at, at, payload, ...guardedBindings(lease), ...(priority === 0 ? freshBindings : []), ...capacityBindings]));
    // A collector may finish after the HTTP read. Do not resurrect that work or
    // misreport the completed stations as rejected by the capacity limit.
    if (priority === 0) statements.push(prepare(`SELECT COUNT(*) AS requested FROM json_each(?) WHERE NOT ${freshIncoming}`,
      [payload, ...freshBindings]));
    const results = await db.batch(statements);
    const accepted = changes(results[updateIndex]) + changes(results[insertIndex]);
    const requested = priority === 0 ? results.at(-1).results[0].requested : jobs.length;
    const evicted = priority === 1 ? changes(results[evictionIndex]) : 0;
    return { requested, accepted, capacityLimited: accepted < requested, ...(evicted ? { evicted } : {}) };
  }

  // A complete active-reminder scan can immediately demote paused/cancelled work.
  // With a larger paged scan, the independent priority TTL bounds any old privilege.
  async function reconcileIntervalPriorities(tasks, { lease, complete = false } = {}) {
    return prepare(`UPDATE interval_query_jobs SET priority=0, priority_until=0 WHERE priority=1 AND
      (priority_until<=? OR (?=1 AND (station_id, start_date, end_date) NOT IN
        (SELECT json_extract(value, '$.stationId'), json_extract(value, '$.startDate'), json_extract(value, '$.endDate') FROM json_each(?))))
      AND ${guard(lease)}`, [now(), complete ? 1 : 0, json(tasks), ...guardedBindings(lease)]).run();
  }

  async function pruneExpiredJobs() {
    return prepare("DELETE FROM interval_query_jobs WHERE expires_at <= ?", [now()]).run();
  }

  return Object.freeze({ readCatalog, readCatalogRows, readCalendarRows, readCollectorCatalogRows,
    readCollectorCalendarRows, readCollectorInputs, readCalendars, readIntervals, finishCollection,
    saveCatalog, recordCatalogFailure, saveCalendarBatch, saveIntervalBatch, acquireLease, acquireInteractiveLease, requestCollectionTurn, hasLease,
    advanceCursor, releaseLease, dueIntervalJobs, nextIntervalAttemptAt, enqueueIntervalQuery, enqueueIntervalJobs, reconcileIntervalPriorities, pruneExpiredJobs });
}

export function projectCollectorListings(items) {
  return items.map(({ id, name, district, address, street, isOnShelf }) => ({
    id, name, district, address, street,
    isOnShelf: isOnShelf === true ? true : isOnShelf === false ? false : null,
  }));
}

/** Per-request read-only client for createQueryService(). No upstream fetch occurs.
 * Catalog and station records are read in bulk, not one D1 query per station.
 * Missing/stale/invalid observations throw into queryService's unknown/partial path;
 * diagnostics retains their old timestamps without exposing expired counts as current.
 */
export function createSnapshotClient({ db, store, clock = () => new Date(), compactCatalog = false, ...options } = {}) {
  store ??= createSnapshotStore({ db, clock });
  const freshness = { ...DEFAULT_SNAPSHOT_FRESHNESS, ...options };
  const catalogs = new Map();
  const stationIds = new Set();
  const observations = new Map();
  let calendars;
  const intervals = new Map();
  async function fetchListings({ houseType = "0" } = {}) {
    const type = parseHouseType(houseType);
    if (!catalogs.has(type)) catalogs.set(type, store.readCatalog(type, { maxAgeMs: freshness.catalogMaxAgeMs, compact: compactCatalog }));
    const entry = await catalogs.get(type);
    if (entry.status !== "fresh") throw snapshotUnavailable(entry.status);
    entry.payload.items.forEach((item) => stationIds.add(String(item.id)));
    return { items: entry.payload.items, fetchedAt: entry.fetchedAt };
  }
  function record(key, stationId, kind, entry) {
    observations.set(key, { stationId: String(stationId), kind, status: entry.status,
      fetchedAt: entry.fetchedAt, lastErrorCode: entry.lastErrorCode ?? null });
    if (entry.status !== "fresh") throw snapshotUnavailable(entry.status);
    return entry;
  }
  async function fetchCalendar(stationId) {
    stationIds.add(String(stationId));
    calendars ??= store.readCalendars([...stationIds], { maxAgeMs: freshness.calendarMaxAgeMs });
    const previousBatch = calendars;
    const loaded = await previousBatch;
    // Other concurrent callers may already have replaced the old catalog batch.
    // Only its first waiter schedules a wider read; all others await that replacement.
    if (!loaded.has(String(stationId)) && calendars === previousBatch) {
      calendars = store.readCalendars([...stationIds], { maxAgeMs: freshness.calendarMaxAgeMs });
    }
    const entry = record(`calendar:${stationId}`, stationId, "calendar", (await calendars).get(String(stationId)) ?? { status: "missing", fetchedAt: null });
    return { calendar: entry.payload.calendar, fetchedAt: entry.fetchedAt };
  }
  async function fetchDateAvailability(stationId, startDate, endDate = null) {
    if (!endDate) {
      const result = await fetchCalendar(stationId);
      return { ...(result.calendar[startDate] ?? { availabilityStatus: "unknown", availableCount: null }), fetchedAt: result.fetchedAt };
    }
    const group = `${startDate}|${endDate}`;
    stationIds.add(String(stationId));
    if (!intervals.has(group)) intervals.set(group, store.readIntervals([...stationIds], startDate, endDate, { maxAgeMs: freshness.intervalMaxAgeMs }));
    const previousBatch = intervals.get(group);
    const loaded = await previousBatch;
    if (!loaded.has(String(stationId)) && intervals.get(group) === previousBatch) {
      intervals.set(group, store.readIntervals([...stationIds], startDate, endDate, { maxAgeMs: freshness.intervalMaxAgeMs }));
    }
    const entry = record(intervalKey(stationId, startDate, endDate), stationId, "interval",
      (await intervals.get(group)).get(String(stationId)) ?? { status: "missing", fetchedAt: null });
    return { ...entry.payload, fetchedAt: entry.fetchedAt };
  }
  async function diagnostics() {
    return { catalogs: await Promise.all([...catalogs].map(async ([houseType, promise]) => {
      const item = await promise; return { houseType, status: item.status, fetchedAt: item.fetchedAt, lastErrorCode: item.lastErrorCode ?? null };
    })), observations: [...observations.values()], freshness };
  }
  return Object.freeze({ fetchListings, fetchCalendar, fetchDateAvailability, diagnostics });
}
