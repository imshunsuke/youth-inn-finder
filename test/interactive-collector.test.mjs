import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { collectInteractiveIntervals } from "../src/application/interactive-collector.mjs";
import { createApp } from "../src/http/app.mjs";
import worker from "../src/worker.mjs";

const initial = Date.parse("2026-10-13T04:00:00Z");
async function fixture(t, size = 90) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let at = initial;
  const clock = () => new Date(at), advance = (ms) => { at += ms; };
  const store = createSnapshotStore({ db, clock });
  const items = Array.from({ length: size }, (_, id) => ({ id: String(id).padStart(3, "0"), name: `驿站${id}`, isOnShelf: true }));
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  const queue = (date = "2026-10-15") => store.enqueueIntervalQuery({ date, endDate: "2026-10-21" });
  const read = (date = "2026-10-15") => store.readIntervals(items.map((x) => x.id), date, "2026-10-21");
  return { db, clock, advance, store, items, queue, read };
}
const positive = async () => new Response(JSON.stringify({ success: true, data: { idleCnt: 1 } }));

test("visitors share one in-flight slice, persistent cooldown and Cron lease", async (t) => {
  const { db, clock, store, queue, advance } = await fixture(t);
  await queue();
  let active = 0, max = 0, calls = 0;
  let unblock; const blocked = new Promise((resolve) => { unblock = resolve; });
  const fetchImpl = async () => { calls++; active++; max = Math.max(max, active); await blocked; active--; return positive(); };
  const first = collectInteractiveIntervals({ db, clock, fetchImpl });
  // Let the first atomic lease acquisition finish while its network calls wait.
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => collectInteractiveIntervals({ db, clock, fetchImpl })));
  assert.ok(concurrent.every((r) => r.status === "throttled"));
  assert.equal(await store.acquireLease(), null);
  unblock(); assert.equal((await first).succeeded, 9);
  assert.equal(max, 6); assert.equal(calls, 9);
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl })).status, "throttled");
  advance(10_000);
  const cron = await store.acquireLease();
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl })).status, "throttled");
  await store.releaseLease(cron);
  assert.equal((await collectInteractiveIntervals({ db, clock, fetchImpl })).succeeded, 9);
});

test("two cold city ranges complete before any snapshot expires while every request remains bounded", async (t) => {
  const { db, clock, queue, read, advance } = await fixture(t);
  await queue("2026-10-15"); await queue("2026-10-16");
  let calls = 0, statements = 0;
  const counted = { prepare: (...args) => { statements++; return db.prepare(...args); }, batch: (...args) => db.batch(...args) };
  for (let batch = 0; batch < 20; batch++) {
    statements = 0;
    const r = await collectInteractiveIntervals({ db: counted, clock, fetchImpl: async () => { calls++; return positive(); } });
    assert.equal(r.attempted, 9); assert.ok(statements < 15, `${statements} D1 queries`);
    if (!batch) {
      for (const date of ["2026-10-15", "2026-10-16"]) assert.ok([...(await read(date)).values()].filter((x) => x.status === "fresh").length >= 4);
    }
    advance(10_000);
  }
  for (const date of ["2026-10-15", "2026-10-16"]) assert.equal([...(await read(date)).values()].filter((x) => x.status === "fresh").length, 90);
  assert.equal(calls, 180); assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n, 0);
});

test("daily quota survives restarts and resets next UTC day", async (t) => {
  const { db, clock, queue, advance, store, items } = await fixture(t);
  await queue();
  assert.equal((await collectInteractiveIntervals({ db, clock, dailyLimit: 9, fetchImpl: positive })).attempted, 9);
  advance(10_000);
  assert.equal((await collectInteractiveIntervals({ db, clock, dailyLimit: 9, fetchImpl: positive })).status, "throttled");
  advance(86_400_000);
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  await queue();
  assert.equal((await collectInteractiveIntervals({ db, clock, dailyLimit: 9, fetchImpl: positive })).attempted, 9);
});

test("failures remain unknown and preserve backoff; expired foreground workers cannot overwrite a new owner", async (t) => {
  const { db, clock, store, queue, read, advance } = await fixture(t, 1);
  await queue();
  const failed = await collectInteractiveIntervals({ db, clock, fetchImpl: async () => new Response("unavailable", { status: 503 }) });
  assert.equal(failed.failed, 1); assert.equal((await read()).get("000").status, "missing");
  advance(10_000);
  const waiting = await collectInteractiveIntervals({ db, clock, fetchImpl: positive });
  assert.equal(waiting.attempted, 0); assert.equal(waiting.retryAfterMs, 50_000);
  advance(60_000);
  let unblock; const delayed = new Promise((resolve) => { unblock = resolve; });
  const old = collectInteractiveIntervals({ db, clock, fetchImpl: async () => { await delayed; return positive(); } });
  await new Promise((resolve) => setImmediate(resolve));
  advance(60_001); const newer = await store.acquireLease(); assert.ok(newer);
  unblock(); await old;
  assert.equal((await read()).get("000").status, "missing");
  assert.equal(await store.hasLease(newer), true);
  await store.releaseLease(newer);
});

test("validated pending query schedules work without delaying the response; ready and invalid queries do not", async (t) => {
  const { db, clock, queue } = await fixture(t, 1);
  const tasks = []; let finished = false;
  let unblock; const delayed = new Promise((resolve) => { unblock = resolve; });
  const app = createApp({ env: { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" }, clock,
    onIntervalPending: () => tasks.push(collectInteractiveIntervals({ db, clock, fetchImpl: async () => { await delayed; return positive(); } }).then(() => { finished = true; })) });
  const url = "https://finder.example.test/api/available?date=2026-10-15&endDate=2026-10-21";
  const response = await app(new Request(url));
  assert.equal(finished, false); assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal((await response.json()).meta.refreshAfterMs, 1000);
  unblock(); await Promise.all(tasks);
  const ready = await app(new Request(url));
  assert.equal((await ready.json()).meta.pending, false); assert.equal(tasks.length, 1);
  assert.equal((await app(new Request(url + "&date=bad"))).status, 400); assert.equal(tasks.length, 1);
  assert.equal((await app(new Request(url, { headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal(tasks.length, 1);
});

test("production Worker separates snapshot reads from a bounded collection invocation", async (t) => {
  const { db, store, items } = await fixture(t, 1);
  const now = new Date();
  const date = new Date(now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
  await store.saveCatalog("0", { items, fetchedAt: now.toISOString() });
  t.mock.method(globalThis, "fetch", positive);
  const env = { DB: db, APP_SECRET: "unit-test-secret-with-at-least-32-bytes" };
  const req = () => new Request(`https://finder.example.test/api/available?date=${date}&endDate=${end}`);
  const first = await worker.fetch(req(), env);
  const pending = await first.json();
  assert.equal(pending.meta.pending, true); assert.equal(pending.meta.collection.advanceUrl, "/api/collection");
  const collected = await worker.fetch(new Request("https://finder.example.test/api/collection", { method: "POST" }), env);
  assert.equal((await collected.json()).succeeded, 1);
  const second = await worker.fetch(req(), env);
  const payload = await second.json();
  assert.equal(payload.meta.pending, false); assert.equal(payload.data.length, 1);
});

test('a request just before the shared cooldown gets a short exact retry instead of another two seconds',async(t)=>{
 const {db,clock,queue,advance}=await fixture(t);await queue();await collectInteractiveIntervals({db,clock,budget:6,fetchImpl:positive});advance(999);
 const early=await collectInteractiveIntervals({db,clock,budget:6,fetchImpl:positive});assert.equal(early.status,'throttled');assert.equal(early.retryAfterMs,100);advance(100);assert.equal((await collectInteractiveIntervals({db,clock,budget:6,fetchImpl:positive})).attempted,6);
});
