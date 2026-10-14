import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";

async function fixture(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let at = Date.parse("2026-10-14T04:00:00Z");
  const clock = () => new Date(at);
  const writes = [];
  const measured = { prepare: (sql) => db.prepare(sql), batch: async (statements) => {
    const results = await db.batch(statements);
    statements.forEach((statement, index) => {
      if (/^(UPDATE|INSERT INTO|DELETE FROM) interval_query_jobs\b/.test(statement.sql)) {
        writes.push({ operation: statement.sql.split(" ")[0], changed: results[index].meta.changes });
      }
    });
    return results;
  } };
  const store = createSnapshotStore({ db: measured, clock });
  const tasks = (date, count = 90) => Array.from({ length: count }, (_, i) => ({ stationId: String(i),
    startDate: date, endDate: "2026-11-05", expiresAt: at + 300_000 }));
  return { db, store, clock, writes, tasks, advance: (ms) => { at += ms; } };
}

test("three city ranges: frequent progress polls write no jobs until renewal is needed", async (t) => {
  const { store, writes, tasks, advance } = await fixture(t);
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03"];
  const admit = () => Promise.all(dates.map((date) => store.enqueueIntervalJobs(tasks(date), { publicTtlMs: 300_000 })));
  const first = await admit(); assert.deepEqual(first.map((x) => x.accepted), [90, 90, 80]);
  writes.length = 0;
  for (let i = 0; i < 60; i++) {
    advance(2_000);
    const next = await admit();
    assert.deepEqual(next.map((x) => x.accepted), [90, 90, 80]);
    assert.deepEqual(next.map((x) => x.capacityLimited), [false, false, true]);
  }
  assert.equal(writes.reduce((sum, x) => sum + x.changed, 0), 0,
    "180 progress polls must not rewrite the 260 existing jobs (indexes are additional D1 writes)");
  advance(60_000); writes.length = 0; await admit();
  assert.equal(writes.reduce((sum, x) => sum + x.changed, 0), 260, "renew once near expiry");
  advance(2_000); writes.length = 0; await admit();
  assert.equal(writes.reduce((sum, x) => sum + x.changed, 0), 0);
});

test("successful public jobs are deleted without first updating their retry indexes", async (t) => {
  const { store, clock, writes, tasks, db } = await fixture(t);
  const jobs = tasks("2026-11-01", 2);
  await store.enqueueIntervalJobs([jobs[0]]);
  await store.enqueueIntervalJobs([jobs[1]], { priority: 1 });
  writes.length = 0;
  await store.saveIntervalBatch(jobs.map((job) => ({ ...job, availabilityStatus: "known", availableCount: 0, fetchedAt: clock().toISOString() })));
  assert.deepEqual(writes, [{ operation: "UPDATE", changed: 1 }, { operation: "DELETE", changed: 1 }]);
  const remaining = await db.prepare("SELECT * FROM interval_query_jobs").all();
  assert.equal(remaining.results.length, 1); assert.equal(remaining.results[0].priority, 1);
  assert.ok(remaining.results[0].next_attempt_at > clock().getTime());
});

test("active reminder scans renew priority near expiry, not every minute", async (t) => {
  const { store, tasks, writes, advance } = await fixture(t);
  const jobs = () => tasks("2026-11-01", 2).map((job) => ({ ...job, expiresAt: job.expiresAt + 3600_000 }));
  await store.enqueueIntervalJobs(jobs(), { priority: 1 }); writes.length = 0;
  for (let i = 0; i < 29; i++) {
    advance(60_000);
    assert.equal((await store.enqueueIntervalJobs(jobs(), { priority: 1 })).accepted, 2);
  }
  assert.equal(writes.reduce((sum, x) => sum + x.changed, 0), 0);
  advance(60_000); await store.enqueueIntervalJobs(jobs(), { priority: 1 });
  assert.equal(writes.reduce((sum, x) => sum + x.changed, 0), 2);
});
