import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createApp } from "../src/http/app.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { collectInteractiveIntervals } from "../src/application/interactive-collector.mjs";
import { createCollector } from "../src/application/collector.mjs";
import { handleQueryRequest } from "../src/http/query-routes.mjs";
import { COLLECTION_POLICY } from "../src/application/collection-policy.mjs";

const initial = Date.parse("2026-10-14T00:00:00Z");
async function fixture(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let at = initial; const clock = () => new Date(at);
  const store = createSnapshotStore({ db, clock });
  return { db, store, clock, advance: (ms) => { at += ms; } };
}

test("three date tabs sharing one network can poll every ten seconds for a complete ten-minute window", async (t) => {
  const { db, clock, advance } = await fixture(t);
  const app = createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, clock,
    queryHandler: async () => new Response("ok") });
  for (let tick = 0; tick < 60; tick++) {
    for (const date of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
      const response = await app(new Request(`https://finder.example.test/api/available?date=${date}&endDate=2026-10-25`, {
        headers: { "CF-Connecting-IP": "192.0.2.20" },
      }));
      assert.equal(response.status, 200, `normal three-tab polling was rate-limited at ${tick * 10}s`);
    }
    advance(10_000);
  }
});

test("failed calls consume actual quota, but empty backoff batches and unused slots consume none", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  await store.enqueueIntervalJobs([{ stationId: "one", startDate: "2026-10-20", endDate: "2026-10-23", expiresAt: initial + 3600_000 }]);
  await collectInteractiveIntervals({ db, clock, fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  const quota = async () => (await db.prepare("SELECT interactive_requests AS n FROM query_collector_state").first()).n;
  assert.equal(await quota(), 1, "unused eight slots must be returned after the batch");
  for (let tick = 0; tick < 5; tick++) {
    advance(10_000);
    const result = await collectInteractiveIntervals({ db, clock, fetchImpl: async () => { throw new Error("must not fetch during backoff"); } });
    assert.equal(result.attempted, 0); assert.equal(await quota(), 1);
  }
});

test("the last partial daily allowance remains usable and failed/expired owners cannot refund someone else's quota", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  await store.enqueueIntervalJobs(Array.from({ length: 12 }, (_, id) => ({ stationId: String(id), startDate: "2026-10-20", endDate: "2026-10-23", expiresAt: initial + 3600_000 })));
  const fetchImpl = async () => new Response(JSON.stringify({ success: true, data: { idleCnt: 1 } }));
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl, dailyLimit: 10 })).attempted, 9);
  advance(10_000);
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl, dailyLimit: 10 })).attempted, 1);
  advance(10_000);
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl, dailyLimit: 10 })).reason, "daily-budget");
  const old = await store.acquireInteractiveLease({ dailyLimit: 20, leaseMs: 1 }); assert.ok(old);
  advance(2); const current = await store.acquireLease(); assert.ok(current);
  const before = (await db.prepare("SELECT interactive_requests AS n FROM query_collector_state").first()).n;
  assert.equal(await store.releaseLease(old, { interactiveUsed: 0 }), false);
  assert.equal((await db.prepare("SELECT interactive_requests AS n FROM query_collector_state").first()).n, before);
  await store.releaseLease(current);
});

test("Cron waiting behind interactive work gets the next turn before more foreground slices", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  const foreground = await store.acquireInteractiveLease(); assert.ok(foreground);
  let waits = 0;
  const report = await createCollector({ db, clock, budget: 1, leaseWaitMs: 25_000,
    wait: async (ms) => {
      advance(ms); waits++;
      if (waits === 1) {
        await store.releaseLease(foreground, { interactiveUsed: 0 });
        advance(10_000);
        assert.equal(await store.acquireInteractiveLease(), null, "a queued Cron has priority over new foreground work");
      }
    }, fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [] })),
  }).run();
  assert.equal(report.status, "collected"); assert.equal(report.requestsUsed, 1); assert.equal(waits, 1);
  assert.equal((await db.prepare("SELECT collection_wait_until AS n FROM query_collector_state").first()).n, 0);
});

test("worst-case Cron waiting plus collection stays below the free per-invocation SQL limit", async (t) => {
  const { db, store, clock, advance } = await fixture(t);
  const foreground = await store.acquireInteractiveLease();
  let statements = 0, waits = 0;
  const counted = { prepare: (...args) => { statements++; return db.prepare(...args); }, batch: (...args) => db.batch(...args) };
  const report = await createCollector({ db: counted, clock, leaseWaitMs: 25_000, budget: 20, maxCatalogRefreshes: 1,
    wait: async (ms) => { advance(ms); if (++waits === 10) await store.releaseLease(foreground, { interactiveUsed: 0 }); },
    fetchImpl: async (url) => new Response(JSON.stringify({ success: true, data: url.includes("housList") ? Array.from({ length: 90 }, (_, id) => ({ id: String(id), name: `驿站${id}` })) : [] })),
  }).run();
  assert.equal(report.requestsUsed, 20); assert.equal(waits, 10); assert.ok(statements < 50, `${statements} SQL queries`);
});

test("compact lists preserve filters/counts while official details load separately and stale catalogs stay unavailable", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  const station = { id: "one", name: "青年驿站", isOnShelf: true, district: "浦东新区", latitude: 31.2, longitude: 121.5, officialUrl: "https://qnyz.shyouth.net/" + "x".repeat(100_000) };
  await store.saveCatalog("0", { items: [station], fetchedAt: clock().toISOString() });
  await store.saveIntervalBatch([{ stationId: "one", startDate: "2026-10-20", endDate: "2026-10-23", availabilityStatus: "known", availableCount: 2, fetchedAt: clock().toISOString() }]);
  const read = (path) => handleQueryRequest(new Request(`https://finder.example.test${path}`), { db, clock });
  const path = "/api/available?date=2026-10-20&endDate=2026-10-23";
  const full = await (await read(path)).json();
  const compact = await (await read(path + "&includeOfficialDetails=false")).json();
  const { officialUrl, ...fields } = full.data[0];
  assert.deepEqual(compact.data[0], fields); assert.deepEqual(compact.meta, full.meta);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 20);
  const detail = await (await read("/api/station?stationId=one")).json();
  assert.deepEqual(detail.data, station);
  assert.equal((await read("/api/station?stationId=absent")).status, 404);
  assert.equal((await read(path + "&includeOfficialDetails=invalid")).status, 400);
  advance(20 * 60_000);
  assert.equal((await read("/api/station?stationId=one")).status, 503);
  assert.equal((await read(path + "&includeOfficialDetails=false")).status, 503);
});

test("cache expires at its exact boundary without relabelling old positive counts or resetting failure backoff", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  await store.saveCatalog("0", { items: [{ id: "one", name: "驿站" }], fetchedAt: clock().toISOString() });
  const job = { stationId: "one", startDate: "2026-10-20", endDate: "2026-10-23", expiresAt: initial + 3600_000 };
  await store.saveIntervalBatch([{ ...job, availabilityStatus: "known", availableCount: 2, fetchedAt: clock().toISOString() }]);
  advance(20 * 60_000 - 1);
  const read = async () => (await handleQueryRequest(new Request("https://finder.example.test/api/available?date=2026-10-20&endDate=2026-10-23"), { db, clock })).json();
  assert.equal((await read()).data.length, 1);
  advance(1);
  await store.saveCatalog("0", { items: [{ id: "one", name: "驿站" }], fetchedAt: clock().toISOString() });
  const expired = await read();
  assert.equal(expired.data.length, 0); assert.equal(expired.meta.snapshotCoverage.staleStations, 1); assert.equal(expired.meta.pending, true);
  const old = (await store.readIntervals(["one"], job.startDate, job.endDate)).get("one");
  assert.equal(old.fetchedAt, new Date(initial).toISOString()); assert.equal(old.status, "stale");
  await store.saveIntervalBatch([], [{ ...job, code: "UPSTREAM_TIMEOUT", failureCount: 1, nextAttemptAt: clock().getTime() + 60_000 }]);
  await read();
  assert.equal((await store.dueIntervalJobs()).length, 0);
  assert.equal((await read()).data.length, 0);
});

test("abandoned public ranges release slots after five minutes; active queries renew only their own work", async (t) => {
  const { db, clock, store, advance } = await fixture(t);
  const task=(stationId)=>({stationId,startDate:"2026-10-20",endDate:"2026-10-23",expiresAt:clock().getTime()+1800_000});
  await store.enqueueIntervalJobs([task("abandoned")]);
  await store.enqueueIntervalJobs([task("reminder")],{priority:1});
  await store.saveIntervalBatch([{...task("archive"),availabilityStatus:"known",availableCount:2,fetchedAt:clock().toISOString()}]);
  await store.enqueueIntervalJobs([{...task("current"),expiresAt:clock().getTime()+300_000}],{publicTtlMs:300_000});
  advance(240_000);
  await store.enqueueIntervalJobs([{...task("current"),expiresAt:clock().getTime()+300_000}],{publicTtlMs:300_000});
  advance(60_001); await store.pruneExpiredJobs();
  const due=(await store.dueIntervalJobs()).map(x=>x.station_id);
  assert.ok(!due.includes("abandoned")); assert.ok(due.includes("current")); assert.ok(due.includes("reminder"));
  assert.equal((await store.readIntervals(["archive"],"2026-10-20","2026-10-23")).get("archive").payload.availableCount,2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n,2);
});

test("ninety simulated minutes: three city ranges share a queue, survive faults and recover after 25 minutes away", async (t) => {
  const { db, store, clock, advance } = await fixture(t);
  const items = Array.from({ length: 90 }, (_, index) => ({ id: String(index).padStart(3, "0"), name: `驿站${index}`, isOnShelf: true }));
  const ranges = ["2026-10-20", "2026-10-21", "2026-10-22"];
  let calls = 0, capacityObserved = false, hiddenExpired = false, maxQueued = 0;
  const failures = new Set(), totals = new Map(ranges.map((date) => [date, { first: null, complete: [], incompleteSince: 0, wasComplete: false }]));
  const fetchImpl = async (url, options) => {
    calls++;
    if (options.method === "POST") {
      const body = JSON.parse(options.body), key = `${body.intoDate}:${body.houseId}`;
      if (body.houseId === "007" && !failures.has(key)) { failures.add(key); return new Response("transient", { status: 503 }); }
      return new Response(JSON.stringify({ success: true, data: { idleCnt: body.houseId === "000" ? 0 : 1 } }));
    }
    return new Response(JSON.stringify({ success: true, data: url.includes("housList") ? items.map((x) => ({ ...x, isOnShelf: "1" }))
      : [{ applyDate: "2026-10-20", applyNumber: 1 }] }));
  };
  for (const type of ["0", "1"]) await store.saveCatalog(type, { items, fetchedAt: clock().toISOString() });
  const collector = () => createCollector({ db, clock, fetchImpl, ...COLLECTION_POLICY });
  const app = () => createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, clock, interactiveCollection: true,
    collectIntervals: (options) => collectInteractiveIntervals({ ...options, fetchImpl }) });
  for (let second = 0; second <= 90 * 60; second += 10) {
    if (second % 60 === 0) await collector().run();
    const hidden = second >= 10 * 60 && second < 35 * 60;
    if (!hidden) {
      for (const date of ranges) {
        const response = await app()(new Request(`https://finder.example.test/api/available?date=${date}&endDate=2026-10-25&onlyOnShelf=true&includeOfficialDetails=false&limit=200`));
        assert.equal(response.status, 200, `unexpected HTTP ${response.status} at ${second}s`);
        const p = await response.json(), c = p.meta.snapshotCoverage, stats = totals.get(date);
        assert.equal(c.totalStations, 90);
        assert.equal(c.freshStations + c.staleStations + c.missingStations + c.invalidStations, 90);
        assert.ok(p.data.every((x) => x.availabilityStatus === "known" && x.availableCount > 0));
        capacityObserved ||= p.meta.collection?.capacityLimited === true;
        if (c.freshStations && stats.first === null) stats.first = second;
        if (second === 35 * 60) { assert.equal(c.freshStations, 0); assert.equal(p.data.length, 0); hiddenExpired = true; stats.incompleteSince = second; }
        const complete = c.freshStations === 90 && !p.meta.partial;
        if (complete && !stats.wasComplete) {
          assert.ok(second - stats.incompleteSince <= 600, `${date} recovery took ${second - stats.incompleteSince}s`);
          stats.complete.push(second);
        }
        if (!complete && stats.wasComplete) stats.incompleteSince = second;
        stats.wasComplete = complete;
        if (p.meta.collection?.advanceUrl) await app()(new Request("https://finder.example.test/api/collection", { method: "POST" }));
      }
    }
    const size = (await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs WHERE expires_at>?").bind(clock().getTime()).first()).n;
    maxQueued = Math.max(maxQueued, size); assert.ok(size <= 260);
    advance(10_000);
  }
  assert.equal(capacityObserved, true); assert.equal(hiddenExpired, true); assert.ok(maxQueued >= 250);
  for (const [date, stats] of totals) {
    assert.ok(stats.first <= 30, `${date} first batch took ${stats.first}s`);
    assert.ok(stats.complete.length >= 3, `${date} must recover across several cache lifetimes`);
    assert.equal(stats.wasComplete, true);
    t.diagnostic(`${date}: first=${stats.first}s, full transitions=${stats.complete.join(',')}s`);
  }
  const quota = (await db.prepare("SELECT interactive_requests AS n FROM query_collector_state").first()).n;
  assert.ok(quota <= 6000); t.diagnostic(`official requests=${calls}, interactive quota=${quota}, max public jobs=${maxQueued}`);
});
