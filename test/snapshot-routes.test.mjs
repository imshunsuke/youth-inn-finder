import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";
import { handleQueryRequest } from "../src/http/query-routes.mjs";

const initialTime = Date.parse("2026-10-13T04:00:00Z");
const known = (availableCount) => ({ availabilityStatus: "known", availableCount });
const station = (id) => ({ id, name: `驿站${id}`, district: "浦东新区", street: "街道", address: "青年路", latitude: 31.23, longitude: 121.47, isOnShelf: true });
const request = (path, options) => new Request(`https://finder.example.test${path}`, options);
async function setup(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let time = initialTime; const clock = () => new Date(time);
  return { db, clock, advance: (ms) => { time += ms; }, store: createSnapshotStore({ db, clock }) };
}

test("cold start returns explicit 503 pending without a fake empty successful city result", async (t) => {
  const { db, clock } = await setup(t);
  const response = await handleQueryRequest(request("/api/calendar"), { db, clock });
  assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "60");
  const payload = await response.json();
  assert.equal(payload.code, "SNAPSHOT_PENDING"); assert.equal(payload.meta.pending, true);
  assert.equal(payload.data, undefined);
});

test("query routes validate method, repeated params and numeric bounds before reading snapshots", async (t) => {
  const { db, clock } = await setup(t);
  assert.equal(await handleQueryRequest(request("/api/health"), { db, clock }), null);
  const method = await handleQueryRequest(request("/api/calendar", { method: "POST" }), { db, clock });
  assert.equal(method.status, 405); assert.equal(method.headers.get("Allow"), "GET");
  for (const path of ["/api/calendar?days=1.5", "/api/calendar?days=1&days=2", "/api/nearest?lat=1000&lon=121", "/api/calendar?owner=someone", "/api/calendar?includeDayItems=maybe"]) {
    const response = await handleQueryRequest(request(path), { db, clock });
    assert.equal(response.status, 400, path);
  }
});

test("partial calendar returns null total, known lower bound, sample times and precise snapshot coverage", async (t) => {
  const { db, clock, store } = await setup(t);
  await store.saveCatalog("0", { items: [station("fresh"), station("stale"), station("missing")], fetchedAt: clock().toISOString() });
  const oldTime = new Date(initialTime - 21 * 60_000).toISOString();
  await store.saveCalendarBatch([
    { stationId: "fresh", calendar: { "2026-10-15": known(2) }, fetchedAt: clock().toISOString() },
    { stationId: "stale", calendar: { "2026-10-15": known(9) }, fetchedAt: oldTime },
  ]);
  const response = await handleQueryRequest(request("/api/calendar?startDate=2026-10-15&days=1"), { db, clock });
  const payload = await response.json();
  assert.equal(response.status, 200); assert.equal(payload.meta.partial, true); assert.equal(payload.meta.pending, true);
  assert.equal(payload.days[0].availableCount, null); assert.equal(payload.days[0].knownAvailableCount, 2);
  assert.equal(payload.meta.availabilityFetchedAt, clock().toISOString());
  assert.deepEqual(payload.meta.snapshotCoverage, { totalStations: 3, freshStations: 1, missingStations: 1, staleStations: 1, invalidStations: 0, lastFailedStations: 0 });
  assert.equal(payload.stations.find((item) => item.id === "stale").fetchedAt, oldTime);
  assert.equal(payload.stations.find((item) => item.id === "stale").availability[0].availableCount, null);
});

test("calendar route accepts includeDayItems=false without changing partial snapshot aggregates or station metadata", async (t) => {
  const { db, clock, store } = await setup(t);
  await store.saveCatalog("0", { items: [station("fresh"), station("missing")], fetchedAt: clock().toISOString() });
  await store.saveCalendarBatch([{ stationId: "fresh", calendar: { "2026-10-15": known(3) }, fetchedAt: clock().toISOString() }]);
  const path = "/api/calendar?startDate=2026-10-15&days=2";
  const legacy = await (await handleQueryRequest(request(path), { db, clock })).json();
  assert.deepEqual(legacy.days[0].items.map((item) => item.id), ["fresh"]);
  const response = await handleQueryRequest(request(`${path}&includeDayItems=false`), { db, clock });
  assert.equal(response.status, 200);
  const compact = await response.json();
  assert.deepEqual(compact, { ...legacy, days: legacy.days.map(({ items, ...day }) => day) });
  assert.equal(compact.days[0].availableCount, null);
  assert.equal(compact.days[0].knownAvailableCount, 3);
  assert.equal(compact.meta.pending, true);
});

test("interval query only queues missing work, then reads exact persisted interval availability", async (t) => {
  const { db, store, clock } = await setup(t);
  await store.saveCatalog("0", { items: [station("a"), station("b")], fetchedAt: clock().toISOString() });
  const path = "/api/available?date=2026-10-15&endDate=2026-10-18";
  const pending = await (await handleQueryRequest(request(path), { db, clock })).json();
  assert.deepEqual(pending.data, []); assert.equal(pending.meta.pending, true); assert.equal(pending.meta.partial, true);
  assert.equal(pending.meta.availabilityStatus, "partial"); assert.equal(pending.meta.collection.status, "queued");
  assert.equal(pending.meta.collection.accepted, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n, 2);
  await store.saveIntervalBatch([
    { stationId: "a", startDate: "2026-10-15", endDate: "2026-10-18", ...known(3), fetchedAt: clock().toISOString() },
    { stationId: "b", startDate: "2026-10-15", endDate: "2026-10-18", ...known(0), fetchedAt: clock().toISOString() },
  ]);
  const ready = await (await handleQueryRequest(request(path), { db, clock })).json();
  assert.equal(ready.meta.pending, false); assert.equal(ready.meta.partial, false);
  assert.deepEqual(ready.data.map(({ id, availableCount }) => ({ id, availableCount })), [{ id: "a", availableCount: 3 }]);
});

test("expired catalog returns 503 while snapshot data never gets relabelled as newly fetched", async (t) => {
  const { db, store, clock, advance } = await setup(t);
  const fetchedAt = clock().toISOString();
  await store.saveCatalog("0", { items: [station("a")], fetchedAt });
  advance(20 * 60_000);
  const response = await handleQueryRequest(request("/api/nearest?lat=31.23&lon=121.47"), { db, clock });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "SNAPSHOT_STALE");
  assert.equal((await store.readCatalog()).fetchedAt, fetchedAt);
});

test("storage errors have a generic 500 response without raw database details", async () => {
  const db = { prepare() { throw new Error("PRIVATE_DATABASE_DETAILS"); }, batch() {} };
  const response = await handleQueryRequest(request("/api/calendar"), { db });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("PRIVATE_DATABASE_DETAILS"), false);
});

test("discovery catalog never claims date availability and remains bounded to one day", async(t)=>{
  const {db,store,clock,advance}=await setup(t);
  const fetchedAt=clock().toISOString();
  await store.saveCatalog('0',{items:[{...station('a'),houseCount:999}],fetchedAt});
  advance(21*60_000);
  const response=await handleQueryRequest(request('/api/catalog?includeOfficialDetails=false'),{db,clock});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.meta.catalogStatus,'stale');
  assert.equal(body.meta.fetchedAt,fetchedAt);assert.equal(body.meta.availabilityStatus,'unconfirmed');assert.equal(body.data[0].houseCount,undefined);
  advance(24*60*60_000);assert.equal((await handleQueryRequest(request('/api/catalog'),{db,clock})).status,503);
});
test("preview preserves historical samples separately without changing strict API or monitoring semantics",async(t)=>{
  const {db,store,clock}=await setup(t);const old=new Date(initialTime-21*60_000).toISOString();
  await store.saveCatalog('0',{items:[station('a'),station('b')],fetchedAt:clock().toISOString()});
  await store.saveIntervalBatch([{stationId:'a',startDate:'2026-10-15',endDate:'2026-10-18',...known(9),fetchedAt:old},
    {stationId:'b',startDate:'2026-10-15',endDate:'2026-10-18',...known(0),fetchedAt:clock().toISOString()}]);
  const path='/api/available?date=2026-10-15&endDate=2026-10-18';
  const strict=await(await handleQueryRequest(request(path),{db,clock})).json();assert.deepEqual(strict.data,[]);assert.equal(strict.observations,undefined);
  const preview=await(await handleQueryRequest(request(path+'&preview=true'),{db,clock})).json();assert.deepEqual(preview.data,[]);
  assert.equal(preview.meta.snapshotCoverage.staleStations,1);assert.equal(preview.meta.coverage.unknownStations,1);
  assert.equal(preview.observations.find(x=>x.stationId==='a').fetchedAt,old);assert.equal(preview.observations.find(x=>x.stationId==='a').snapshotStatus,'stale');
  assert.equal(preview.observations.find(x=>x.stationId==='b').availableCount,0);
});
test("calendar history is display-only and disappears at the one-hour hard limit",async(t)=>{
  const {db,store,clock}=await setup(t);const old=new Date(initialTime-21*60_000).toISOString();
  await store.saveCatalog('0',{items:[station('a'),station('b')],fetchedAt:clock().toISOString()});
  await store.saveCalendarBatch([{stationId:'a',calendar:{'2026-10-15':known(8)},fetchedAt:old},
    {stationId:'b',calendar:{'2026-10-15':known(7)},fetchedAt:new Date(initialTime-60*60_000).toISOString()}]);
  const body=await(await handleQueryRequest(request('/api/calendar?startDate=2026-10-15&days=1&preview=true'),{db,clock})).json();
  assert.equal(body.days[0].knownAvailableCount,0);assert.equal(body.stations[0].availability[0].availableCount,null);
  assert.equal(body.stations[0].historicalAvailability['2026-10-15'].availableCount,8);assert.equal(body.stations[0].fetchedAt,old);
  assert.equal(body.stations[1].historicalAvailability,undefined);
});

test('cold interval admission reuses the already validated filtered catalog',async(t)=>{
  const {db,store,clock}=await setup(t);await store.saveCatalog('0',{items:[station('a'),station('b')],fetchedAt:clock().toISOString()});
  let catalogReads=0;const proxy={prepare(sql){if(sql.includes('FROM query_catalogs'))catalogReads++;return db.prepare(sql);},batch:(...args)=>db.batch(...args)};
  const response=await handleQueryRequest(request('/api/available?date=2026-10-15&endDate=2026-10-18&stationId=a&includeOfficialDetails=false'),{db:proxy,clock});
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.meta.collection.accepted,1);
  assert.equal(catalogReads,1);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM interval_query_jobs').first()).n,1);
});
test('a failed bulk availability read returns a retryable service error instead of healthy 200 with zero observations',async(t)=>{
  const {db,store,clock}=await setup(t);await store.saveCatalog('0',{items:[station('a'),station('b')],fetchedAt:clock().toISOString()});
  const proxy={prepare(sql){return {bind(...values){const statement=db.prepare(sql).bind(...values);return sql.includes('FROM query_intervals WHERE')?{...statement,all:async()=>{throw new Error('PRIVATE_D1_READ_ERROR');}}:statement;}};},batch:(...args)=>db.batch(...args)};
  const response=await handleQueryRequest(request('/api/available?date=2026-10-15&endDate=2026-10-18&preview=true'),{db:proxy,clock});
  assert.equal(response.status,500);assert.equal(response.headers.get('X-Snapshot-Valid-Until'),null);
  assert.doesNotMatch(await response.text(),/PRIVATE_D1_READ_ERROR/);
});
