import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotClient, createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { createQueryService } from "../src/application/query-service.mjs";
import { filterListings, parseCommonQuery } from "../src/domain/query.mjs";

const initialTime = Date.parse("2026-10-13T04:00:00Z");
const known = (count) => ({ availabilityStatus: "known", availableCount: count });
const station = (id, extra = {}) => ({ id: String(id), name: `驿站${id}`, district: "浦东新区", street: "街道", address: "青年路", isOnShelf: true, latitude: 31.23, longitude: 121.47, ...extra });
async function setup(t) {
  const db = await applyMigrations(createTestDb());
  t.after(() => db.close());
  let time = initialTime;
  const clock = () => new Date(time);
  return { db, clock, advance: (ms) => { time += ms; }, store: createSnapshotStore({ db, clock }) };
}

test("snapshots persist across adapter recreation and catalogs are separate by house type", async (t) => {
  const { db, store, clock } = await setup(t);
  await store.saveCatalog("0", { items: [station("a")], fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items: [station("a"), station("b")], fetchedAt: clock().toISOString() });
  await store.saveCalendarBatch([{ stationId: "a", calendar: { "2026-10-15": known(0) }, fetchedAt: clock().toISOString() }]);
  const recreated = createSnapshotStore({ db, clock });
  assert.equal((await recreated.readCatalog("0")).payload.items.length, 1);
  assert.equal((await recreated.readCatalog("1")).payload.items.length, 2);
  const calendars = await recreated.readCalendars(["a", "b"]);
  assert.equal(calendars.get("a").payload.calendar["2026-10-15"].availableCount, 0);
  assert.equal(calendars.get("b").status, "missing");
});

test("collector catalog projection preserves all filter semantics and public official URLs", async (t) => {
  const { store, clock } = await setup(t);
  const items = [
    station("a", { name: "人才驿站", address: "青年路", street: "创新街道", officialUrl: "https://official.example.test/?passObj=" + "x".repeat(5000), contact: "fixture-contact" }),
    station("b", { name: "青年驿站", district: "徐汇区", isOnShelf: false, street: "人才街道", officialUrl: "https://official.example.test/b" }),
    station("c", { isOnShelf: null, officialUrl: "https://official.example.test/c" }),
  ];
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  const [projected] = await store.readCollectorCatalogRows();
  assert.equal(projected.has_payload, 1);
  assert.deepEqual(projected.items.map((item) => item.isOnShelf), [true, false, null]);
  assert.ok(projected.items.every((item) => !Object.hasOwn(item, "officialUrl") && !Object.hasOwn(item, "contact")));
  for (const input of [{ q: "人才" }, { q: "青年路" }, { q: "创新" }, { district: "徐汇区" },
    { onlyOnShelf: true }, { stationId: "c" }, { q: "人才", onlyOnShelf: true }]) {
    const query = parseCommonQuery(input);
    assert.deepEqual(filterListings(projected.items, query).map((item) => item.id), filterListings(items, query).map((item) => item.id));
  }
  assert.deepEqual((await store.readCatalog("0")).payload.items, items, "API keeps exact complete original official links");
});

test("collector metadata excludes calendar bodies and marks corrupt snapshots for recollection", async (t) => {
  const { db, store, clock } = await setup(t);
  await store.saveCatalog("0", { items: [station("a")], fetchedAt: clock().toISOString() });
  await store.saveCalendarBatch([
    { stationId: "a", calendar: { "2026-10-15": known(3) }, fetchedAt: clock().toISOString() },
    { stationId: "outside", calendar: {}, fetchedAt: clock().toISOString() },
  ]);
  const rows = await store.readCollectorCalendarRows(["a"]);
  assert.equal(rows.length, 1); assert.equal(rows[0].has_payload, 1);
  assert.equal(rows[0].station_id, "a"); assert.equal(rows[0].payload_json, undefined);
  await db.prepare("UPDATE query_catalogs SET payload_json='invalid-json' WHERE house_type='0'").run();
  await db.prepare("UPDATE query_calendars SET payload_json='invalid-json' WHERE station_id='a'").run();
  const [catalog] = await store.readCollectorCatalogRows();
  assert.equal(catalog.has_payload, 0); assert.deepEqual(catalog.items, []);
  assert.equal((await store.readCollectorCalendarRows(["a"]))[0].has_payload, 0);
});

test("collection failures retain successful data and old timestamps instead of fabricating zero", async (t) => {
  const { store, clock, advance } = await setup(t);
  const original = clock().toISOString();
  await store.saveCatalog("0", { items: [station("a")], fetchedAt: original });
  await store.saveCalendarBatch([{ stationId: "a", calendar: { "2026-10-15": known(5) }, fetchedAt: original }]);
  advance(60_000);
  await store.saveCalendarBatch([], [{ stationId: "a", code: "UPSTREAM_TIMEOUT", nextAttemptAt: clock().getTime() + 60_000 }]);
  const cached = (await store.readCalendars(["a"])).get("a");
  assert.equal(cached.fetchedAt, original);
  assert.equal(cached.payload.calendar["2026-10-15"].availableCount, 5);
  assert.equal(cached.lastErrorCode, "UPSTREAM_TIMEOUT");
  advance(20 * 60_000);
  assert.equal((await store.readCalendars(["a"])).get("a").status, "stale");
});

test("snapshot client makes stale, missing and corrupt calendars unknown through the query core", async (t) => {
  const { db, store, clock } = await setup(t);
  const oldTime = new Date(initialTime - 21 * 60_000).toISOString();
  await store.saveCatalog("0", { items: [station("fresh"), station("stale"), station("missing"), station("corrupt")], fetchedAt: clock().toISOString() });
  await store.saveCalendarBatch([
    { stationId: "fresh", calendar: { "2026-10-15": known(2) }, fetchedAt: clock().toISOString() },
    { stationId: "stale", calendar: { "2026-10-15": known(9) }, fetchedAt: oldTime },
    { stationId: "corrupt", calendar: {}, fetchedAt: clock().toISOString() },
  ]);
  await db.prepare("UPDATE query_calendars SET payload_json='invalid-json' WHERE station_id='corrupt'").run();
  const client = createSnapshotClient({ db, clock });
  const result = await createQueryService({ client, clock }).findCalendar({ startDate: "2026-10-15", days: 1 });
  assert.equal(result.days[0].availableCount, null);
  assert.equal(result.days[0].knownAvailableCount, 2);
  assert.deepEqual(result.meta.coverage, { totalStations: 4, successfulStations: 1, failedStations: 3, unknownStations: 3 });
  assert.equal(result.stations.find((item) => item.id === "stale").availability[0].availableCount, null);
  assert.deepEqual((await client.diagnostics()).observations.map(({ status }) => status).sort(), ["fresh", "invalid", "missing", "stale"]);
});

test("90-station frontend query reads snapshots in bulk rather than making 90 D1 reads", async (t) => {
  const { db, store, clock } = await setup(t);
  const stations = Array.from({ length: 90 }, (_, index) => station(index));
  await store.saveCatalog("0", { items: stations, fetchedAt: clock().toISOString() });
  await store.saveCalendarBatch(stations.map(({ id }) => ({ stationId: id, calendar: { "2026-10-15": known(1) }, fetchedAt: clock().toISOString() })));
  let statements = 0;
  const countedDb = { prepare: (...args) => { statements += 1; return db.prepare(...args); }, batch: (...args) => db.batch(...args) };
  const client = createSnapshotClient({ db: countedDb, clock });
  const result = await createQueryService({ client, clock }).findCalendar({ startDate: "2026-10-15", days: 1 });
  assert.equal(result.days[0].availableCount, 90);
  assert.equal(result.meta.partial, false);
  assert.equal(statements, 2);
});

for (const kind of ["calendar", "interval"]) test(`${kind} batch expansion coalesces concurrent readers after changing house type`, async (t) => {
  const { db, store, clock } = await setup(t);
  const first = Array.from({ length: 90 }, (_, index) => station(String(index)));
  const second = Array.from({ length: 90 }, (_, index) => station(String(index + 90)));
  await store.saveCatalog("0", { items: first, fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items: second, fetchedAt: clock().toISOString() });
  if (kind === "calendar") {
    await store.saveCalendarBatch([...first, ...second].map(({ id }) => ({ stationId: id,
      calendar: { "2026-10-15": known(1) }, fetchedAt: clock().toISOString() })));
  } else {
    await store.saveIntervalBatch([...first, ...second].map(({ id }) => ({ stationId: id,
      startDate: "2026-10-15", endDate: "2026-10-18", ...known(1), fetchedAt: clock().toISOString() })));
  }
  let statements = 0;
  let snapshotReads = 0;
  const countedDb = { prepare(sql) {
    statements += 1;
    if (sql.includes(`SELECT * FROM query_${kind === "calendar" ? "calendars" : "intervals"}`)) snapshotReads += 1;
    return db.prepare(sql);
  }, batch: (...args) => db.batch(...args) };
  const client = createSnapshotClient({ db: countedDb, clock });
  const service = createQueryService({ client, clock, concurrency: 3 });
  const query = { date: "2026-10-15", ...(kind === "interval" ? { endDate: "2026-10-18" } : {}), limit: 200 };
  const initial = await service.findAvailable({ ...query, houseType: "0" });
  const expanded = await service.findAvailable({ ...query, houseType: "1" });
  assert.equal(initial.data.length, 90);
  assert.equal(expanded.data.length, 90);
  assert.equal(expanded.meta.partial, false);
  assert.equal(snapshotReads, 2, "one original read plus one shared wider read");
  assert.equal(statements, 4, "two catalog reads and two snapshot reads");
});

test("lease is durable and expired owners cannot overwrite snapshots, advance cursor or release a newer lease", async (t) => {
  const { db, store, clock, advance } = await setup(t);
  const oldLease = await store.acquireLease({ token: "old", leaseMs: 5 });
  assert.equal(await createSnapshotStore({ db, clock }).acquireLease({ token: "other" }), null);
  advance(6);
  const newLease = await store.acquireLease({ token: "new" });
  await store.saveCalendarBatch([{ stationId: "a", calendar: { "2026-10-15": known(9) }, fetchedAt: clock().toISOString() }], [], { lease: newLease });
  const rejected = await store.saveCalendarBatch([{ stationId: "a", calendar: { "2026-10-15": known(0) }, fetchedAt: clock().toISOString() }], [], { lease: oldLease });
  assert.equal(rejected[0].meta.changes, 0);
  assert.equal(await store.saveCatalog("0", { items: [], fetchedAt: clock().toISOString() }, { lease: oldLease }), false);
  assert.equal(await store.advanceCursor(oldLease, { calendarCursor: "wrong" }), false);
  assert.equal(await store.releaseLease(oldLease), false);
  assert.equal(await store.hasLease(newLease), true);
  assert.equal((await store.readCalendars(["a"])).get("a").payload.calendar["2026-10-15"].availableCount, 9);
});

test("interval queue admission is durable, bounded, deduplicated and does not reset retry backoff", async (t) => {
  const { store, db, clock } = await setup(t);
  await store.saveCatalog("0", { items: Array.from({ length: 10 }, (_, index) => station(index)), fetchedAt: clock().toISOString() });
  const query = { date: "2026-10-15", endDate: "2026-10-18" };
  const first = await store.enqueueIntervalQuery(query, { maxJobs: 3 });
  assert.deepEqual(first, { requested: 10, accepted: 3, capacityLimited: true });
  await store.enqueueIntervalQuery(query, { maxJobs: 3 });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n, 3);
  await store.saveIntervalBatch([], [{ stationId: "0", startDate: query.date, endDate: query.endDate,
    code: "UPSTREAM_TIMEOUT", failureCount: 1, nextAttemptAt: clock().getTime() + 60_000 }]);
  await store.enqueueIntervalQuery(query, { maxJobs: 3 });
  assert.equal((await db.prepare("SELECT next_attempt_at FROM interval_query_jobs WHERE station_id='0'").first()).next_attempt_at, clock().getTime() + 60_000);
  assert.equal((await store.dueIntervalJobs()).length, 2);
});

test("interval snapshots use the exact station/date tuple and retain valid zero", async (t) => {
  const { db, store, clock } = await setup(t);
  await store.saveCatalog("0", { items: [station("a")], fetchedAt: clock().toISOString() });
  await store.saveIntervalBatch([{ stationId: "a", startDate: "2026-10-15", endDate: "2026-10-18", ...known(0), fetchedAt: clock().toISOString() }]);
  const client = createSnapshotClient({ db, clock });
  await client.fetchListings();
  assert.equal((await client.fetchDateAvailability("a", "2026-10-15", "2026-10-18")).availableCount, 0);
  await assert.rejects(client.fetchDateAvailability("a", "2026-10-15", "2026-10-19"), (error) => error.status === 503);
});
