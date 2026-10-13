import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { createCollector } from "../src/application/collector.mjs";

const initialTime = Date.parse("2026-10-13T04:00:00Z");
const task = (stationId, expiresAt = initialTime + 2 * 60 * 60_000) => ({ stationId, startDate: "2026-10-15", endDate: "2026-10-18", expiresAt });
const tasks = (prefix, count) => Array.from({ length: count }, (_, index) => task(`${prefix}-${String(index).padStart(3, "0")}`));
async function setup(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let time = initialTime; const clock = () => new Date(time);
  return { db, clock, advance: (ms) => { time += ms; }, store: createSnapshotStore({ db, clock }) };
}
const count = async (db) => (await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n;

test("public interval capacity reserves 40 of 300 slots and active work is selected first", async (t) => {
  const { db, store } = await setup(t);
  const publicAdmission = await store.enqueueIntervalJobs(tasks("public", 350), { maxJobs: 300 });
  assert.equal(publicAdmission.accepted, 260); assert.equal(publicAdmission.capacityLimited, true);
  const activeAdmission = await store.enqueueIntervalJobs(tasks("verified", 40), { maxJobs: 300, priority: 1 });
  assert.equal(activeAdmission.accepted, 40); assert.equal(activeAdmission.capacityLimited, false);
  assert.equal(await count(db), 300);
  const due = await store.dueIntervalJobs(30);
  assert.ok(due.every((job) => job.priority === 1 && job.station_id.startsWith("verified")));
  const rejected = await store.enqueueIntervalJobs([task("public-extra")], { maxJobs: 300 });
  assert.equal(rejected.accepted, 0);
});

test("a legacy full public queue cannot reject new active reminder jobs", async (t) => {
  const { db, store } = await setup(t);
  await store.enqueueIntervalJobs(tasks("legacy-public", 300), { maxJobs: 300, reservedPriorityJobs: 0 });
  const accepted = await store.enqueueIntervalJobs(tasks("verified", 40), { maxJobs: 300, priority: 1 });
  assert.equal(accepted.accepted, 40); assert.equal(accepted.evicted, 40);
  assert.equal(await count(db), 300);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs WHERE priority=1").first()).n, 40);
});

test("promotion preserves retry state and public refresh cannot extend reminder priority", async (t) => {
  const { db, store, clock, advance } = await setup(t);
  const shared = task("shared");
  await store.enqueueIntervalJobs([shared]);
  const nextAttemptAt = clock().getTime() + 60_000;
  await store.saveIntervalBatch([], [{ ...shared, code: "UPSTREAM_TIMEOUT", failureCount: 2, nextAttemptAt }]);
  await store.enqueueIntervalJobs([shared], { priority: 1 });
  const promoted = await db.prepare("SELECT * FROM interval_query_jobs WHERE station_id='shared'").first();
  assert.equal(promoted.priority, 1); assert.equal(promoted.failure_count, 2);
  assert.equal(promoted.next_attempt_at, nextAttemptAt); assert.equal(promoted.last_error_code, "UPSTREAM_TIMEOUT");
  advance(10 * 60_000);
  await store.enqueueIntervalJobs([{ ...shared, expiresAt: clock().getTime() + 2 * 60 * 60_000 }]);
  const refreshed = await db.prepare("SELECT * FROM interval_query_jobs WHERE station_id='shared'").first();
  assert.equal(refreshed.priority, 1); assert.equal(refreshed.priority_until, promoted.priority_until);
  assert.equal(refreshed.next_attempt_at, nextAttemptAt); assert.equal(await count(db), 1);
});

test("complete active scan demotes paused or cancelled work immediately", async (t) => {
  const { db, store } = await setup(t);
  const active = task("active"); const paused = task("paused");
  await store.enqueueIntervalJobs([active, paused], { priority: 1 });
  await store.reconcileIntervalPriorities([active], { complete: true });
  assert.equal((await db.prepare("SELECT priority FROM interval_query_jobs WHERE station_id='active'").first()).priority, 1);
  assert.equal((await db.prepare("SELECT priority FROM interval_query_jobs WHERE station_id='paused'").first()).priority, 0);
});

test("paged scans and continuing public requests cannot preserve old priority beyond its lease", async (t) => {
  const { db, store, clock, advance } = await setup(t);
  const previous = task("previous-active");
  await store.enqueueIntervalJobs([previous], { priority: 1 });
  advance(46 * 60_000);
  await store.reconcileIntervalPriorities([], { complete: false });
  await store.enqueueIntervalJobs([{ ...previous, expiresAt: clock().getTime() + 2 * 60 * 60_000 }]);
  const row = await db.prepare("SELECT * FROM interval_query_jobs WHERE station_id='previous-active'").first();
  assert.equal(row.priority, 0); assert.equal(row.priority_until, 0);
  assert.ok(row.expires_at > clock().getTime());
});

test("expired collector owner cannot demote, promote or evict another owner's jobs", async (t) => {
  const { db, store, advance } = await setup(t);
  const old = await store.acquireLease({ token: "old", leaseMs: 5 });
  advance(6); const current = await store.acquireLease({ token: "current" });
  await store.enqueueIntervalJobs(tasks("verified", 40), { priority: 1, lease: current });
  await store.reconcileIntervalPriorities([], { complete: true, lease: old });
  const rejected = await store.enqueueIntervalJobs([task("old-owner")], { priority: 1, lease: old });
  assert.equal(rejected.accepted, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs WHERE priority=1").first()).n, 40);
  assert.equal(await count(db), 40);
});

test("collector promotes active conditions ahead of a full public queue and demotes after pause", async (t) => {
  const { db, store, clock } = await setup(t);
  const items = [{ id: "chosen", name: "测试驿站", district: "浦东新区", isOnShelf: true }];
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items, fetchedAt: clock().toISOString() });
  await store.enqueueIntervalJobs(tasks("public", 300), { maxJobs: 300, reservedPriorityJobs: 0 });
  await db.prepare("INSERT INTO reminders(id,email,conditions_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind("verified-reminder", "fixture@example.test", JSON.stringify({ date: "2026-10-15", endDate: "2026-10-18", stationId: "chosen" }),
      "active", clock().toISOString(), clock().toISOString()).run();
  const posted = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "POST") posted.push(JSON.parse(options.body).houseId);
    return new Response(JSON.stringify({ success: true, data: options.method === "POST" ? { idleCnt: 1 } : [] }));
  };
  const collector = createCollector({ db, clock, fetchImpl, budget: 3 });
  await collector.run();
  assert.ok(posted.includes("chosen"));
  assert.equal((await db.prepare("SELECT priority FROM interval_query_jobs WHERE station_id='chosen'").first()).priority, 1);
  assert.equal(await count(db), 300);
  await db.prepare("UPDATE reminders SET status='paused' WHERE id='verified-reminder'").run();
  await collector.run();
  assert.equal((await db.prepare("SELECT priority FROM interval_query_jobs WHERE station_id='chosen'").first()).priority, 0);
});
