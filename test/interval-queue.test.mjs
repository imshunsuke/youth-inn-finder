import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { handleQueryRequest } from "../src/http/query-routes.mjs";
import { createCollector } from "../src/application/collector.mjs";

const initialTime = Date.parse("2026-10-13T04:00:00Z");
const station = (id) => ({ id: String(id).padStart(3, "0"), name: `驿站${id}`, district: "浦东新区", isOnShelf: true });
const task = (stationId, startDate = "2026-10-18") => ({ stationId, startDate, endDate: "2026-10-21", expiresAt: initialTime + 60 * 60_000 });
const known = (job, clock, availableCount = 0) => ({ ...job, availabilityStatus: "known", availableCount, fetchedAt: clock().toISOString() });
const query = "/api/available?date=2026-10-18&endDate=2026-10-21&limit=200";
async function setup(t, size = 90) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let time = initialTime; const clock = () => new Date(time);
  const store = createSnapshotStore({ db, clock });
  const items = Array.from({ length: size }, (_, index) => station(index));
  for (const type of ["0", "1"]) await store.saveCatalog(type, { items, fetchedAt: clock().toISOString() });
  const read = async () => (await handleQueryRequest(new Request(`https://finder.example.test${query}`), { db, clock, maxIntervalJobs: 300 })).json();
  return { db, clock, store, items, read, advance: (ms) => { time += ms; } };
}
const jobCount = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n;

test("full public queue truthfully rejects a new range, then released slots admit it", async (t) => {
  const { db, clock, store, read } = await setup(t);
  const previous = Array.from({ length: 260 }, (_, index) => task(`old-${index}`, "2026-10-15"));
  await store.enqueueIntervalJobs(previous);
  const rejected = await read();
  assert.deepEqual(rejected.meta.collection, { status: "capacity-limited", requested: 90, accepted: 0, capacityLimited: true });
  assert.equal(rejected.meta.pending, true);
  await store.saveIntervalBatch(previous.slice(0, 30).map((job) => known(job, clock)));
  assert.equal(await jobCount(db), 230);
  const partial = await read();
  assert.deepEqual(partial.meta.collection, { status: "capacity-limited", requested: 90, accepted: 30, capacityLimited: true });
  assert.equal(await jobCount(db), 260);
});

test("partial retries enqueue only missing stations, retaining known zero and failure backoff", async (t) => {
  const { db, clock, store, read } = await setup(t, 3);
  await read();
  await store.saveIntervalBatch([known(task("000"), clock, 0)], [{ ...task("001"), code: "UPSTREAM_TIMEOUT", failureCount: 2, nextAttemptAt: initialTime + 120_000 }]);
  const partial = await read();
  assert.equal(partial.meta.snapshotCoverage.freshStations, 1);
  assert.deepEqual(partial.meta.collection, { status: "queued", requested: 2, accepted: 2, capacityLimited: false });
  assert.equal(await jobCount(db), 2);
  assert.equal(await db.prepare("SELECT station_id FROM interval_query_jobs WHERE station_id='000'").first(), null);
  const failed = await db.prepare("SELECT * FROM interval_query_jobs WHERE station_id='001'").first();
  assert.equal(failed.failure_count, 2); assert.equal(failed.next_attempt_at, initialTime + 120_000);
  assert.deepEqual(partial.data, [], "known zero plus unknown stations must never become a fake city-wide no-room result");
});

test("legacy completed jobs are reclaimed without deleting their snapshots or reminder slots", async (t) => {
  const { db, store, clock, read } = await setup(t);
  const previous = Array.from({ length: 260 }, (_, index) => task(`old-${index}`, "2026-10-15"));
  await store.saveIntervalBatch(previous.map((job) => known(job, clock)));
  // Reproduce rows written by the previous release, which kept successful jobs.
  await db.prepare(`INSERT INTO interval_query_jobs(station_id,start_date,end_date,expires_at,created_at,updated_at)
    SELECT json_extract(value,'$.stationId'),json_extract(value,'$.startDate'),json_extract(value,'$.endDate'),?, ?, ? FROM json_each(?)`)
    .bind(initialTime + 60 * 60_000, initialTime, initialTime, JSON.stringify(previous)).run();
  const reminder = task("reminder");
  await store.enqueueIntervalJobs([reminder], { priority: 1 });
  await store.saveIntervalBatch([known(reminder, clock)]);
  const result = await read();
  assert.equal(result.meta.collection.accepted, 90); assert.equal(result.meta.collection.capacityLimited, false);
  assert.equal(await jobCount(db), 91);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM query_intervals").first()).n, 261);
  assert.equal((await db.prepare("SELECT priority FROM interval_query_jobs WHERE station_id='reminder'").first()).priority, 1);
});

test("a snapshot completed between reading and admission cannot resurrect public work", async (t) => {
  const { db, store, clock } = await setup(t, 1);
  const job = task("000");
  await store.saveIntervalBatch([known(job, clock)]);
  const admitted = await store.enqueueIntervalJobs([job]);
  assert.deepEqual(admitted, { requested: 0, accepted: 0, capacityLimited: false });
  assert.equal(await jobCount(db), 0);
});

test("an expired collector cannot release another owner's job; live reminder promotion wins", async (t) => {
  const { db, store, clock, advance } = await setup(t, 1);
  const job = task("000");
  await store.enqueueIntervalJobs([job]);
  const old = await store.acquireLease({ token: "old", leaseMs: 5 });
  advance(6); const current = await store.acquireLease({ token: "current" });
  await store.saveIntervalBatch([known(job, clock)], [], { lease: old });
  assert.equal(await jobCount(db), 1); assert.equal((await store.readIntervals(["000"], job.startDate, job.endDate)).get("000").status, "missing");
  await store.enqueueIntervalJobs([job], { priority: 1, lease: current });
  await store.saveIntervalBatch([known(job, clock)], [], { lease: current });
  assert.equal(await jobCount(db), 1); assert.equal((await store.readIntervals(["000"], job.startDate, job.endDate)).get("000").status, "fresh");
});

test("a legacy retry with a still-fresh snapshot retains backoff when promoted to a reminder", async (t) => {
  const { db, store, clock } = await setup(t, 1);
  const job = task("000");
  await store.enqueueIntervalJobs([job]);
  await store.saveIntervalBatch([], [{ ...job, code: "UPSTREAM_TIMEOUT", failureCount: 2, nextAttemptAt: initialTime + 120_000 }]);
  await db.prepare("UPDATE query_intervals SET payload_json=?,fetched_at=? WHERE station_id='000'")
    .bind(JSON.stringify({availabilityStatus:"known",availableCount:1}),clock().toISOString()).run();
  await store.enqueueIntervalJobs([job], { priority: 1 });
  const row = await db.prepare("SELECT * FROM interval_query_jobs WHERE station_id='000'").first();
  assert.equal(row.priority, 1); assert.equal(row.failure_count, 2); assert.equal(row.next_attempt_at, initialTime + 120_000);
});

test("90-station range completes across production-size slices while visible-page retries do not resurrect fresh jobs", async (t) => {
  const { db, store, clock, advance, items, read } = await setup(t);
  const posted = new Set();
  const fetchImpl = async (url, options) => {
    const data = options.method === "POST" ? (posted.add(JSON.parse(options.body).houseId), { idleCnt: 1 })
      : url.includes("housList") ? items.map((item) => ({ ...item, houseId: item.id, houseName: item.name })) : [{ applyDate: "2026-10-18", applyNumber: 1 }];
    return new Response(JSON.stringify({ success: true, data }));
  };
  const collector = createCollector({ db, clock, fetchImpl, budget: 20, maxCatalogRefreshes: 1 });
  let result = await read();
  for (let slice = 0; slice < 30 && result.meta.pending; slice++) {
    const report = await collector.run();
    assert.ok(report.requestsUsed <= 20);
    result = await read();
    assert.ok(await jobCount(db) <= 260);
    if (result.meta.pending) advance(2 * 60_000);
  }
  assert.equal(posted.size, 90, "every station must be reached despite earlier snapshots expiring");
  assert.equal(result.meta.pending, false, `the complete fresh range must eventually be returned: ${JSON.stringify(result.meta.snapshotCoverage)}`);
  assert.equal(result.data.length, 90); assert.equal(await jobCount(db), 0);
});
