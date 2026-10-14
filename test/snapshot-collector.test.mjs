import assert from "node:assert/strict";
import test from "node:test";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";
import { createCollector } from "../src/application/collector.mjs";
import { createSnapshotStore } from "../src/infrastructure/snapshot-store.mjs";

const initialTime = Date.parse("2026-10-13T04:00:00Z");
const station = (index, extra = {}) => ({ id: String(index).padStart(3, "0"), name: `驿站${index}`, district: "浦东新区", isOnShelf: "1", ...extra });
const officialResponse = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
async function setup(t) {
  const db = await applyMigrations(createTestDb()); t.after(() => db.close());
  let time = initialTime;
  const clock = () => new Date(time);
  return { db, clock, advance: (ms) => { time += ms; }, store: createSnapshotStore({ db, clock }) };
}

test("90 stations collect in durable slices with total fetch budget 30 including catalogs and shared calendar IDs", async (t) => {
  const { db, clock } = await setup(t);
  const calls = [];
  let active = 0; let maximum = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), method: options.method }); active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1;
    return officialResponse(url.includes("housList") ? Array.from({ length: 90 }, (_, index) => station(index))
      : [{ applyDate: "2026-10-15", applyNumber: 1 }]);
  };
  const reports = [];
  for (let index = 0; index < 4; index += 1) reports.push(await createCollector({ db, clock, fetchImpl }).run());
  assert.deepEqual(reports.map((item) => item.requestsUsed), [30, 30, 30, 2]);
  assert.ok(reports.every((item) => item.requestsUsed <= 30));
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("housList")).length, 2);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("calendar")).length, 90);
  assert.equal(new Set(calls.filter(({ url }) => url.pathname.endsWith("calendar")).map(({ url }) => url.searchParams.get("id"))).size, 90);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM query_calendars").first()).n, 90);
  assert.ok(maximum <= 3);
  const idle = await createCollector({ db, clock, fetchImpl }).run();
  assert.equal(idle.requestsUsed, 0);
});

test("one catalog refresh per slice alternates durable catalog cursors within the shared request budget", async (t) => {
  const { db, clock, advance } = await setup(t);
  for (const maxCatalogRefreshes of [0, 3, 1.5, "1", null, NaN]) {
    assert.throws(() => createCollector({ db, maxCatalogRefreshes }), /catalog refresh limit/);
  }
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    return officialResponse(parsed.pathname.endsWith("housList")
      ? Array.from({ length: 4 }, (_, index) => station(index))
      : [{ applyDate: "2026-10-15", applyNumber: 1 }]);
  };
  const reports = [];
  for (let round = 0; round < 4; round += 1) {
    if (round === 2) advance(16 * 60_000);
    reports.push(await createCollector({ db, clock, fetchImpl, budget: 3, maxCatalogRefreshes: 1 }).run());
    assert.equal((await db.prepare("SELECT catalog_cursor FROM query_collector_state WHERE name='official'").first()).catalog_cursor,
      round % 2 === 0 ? 1 : 0);
  }
  assert.deepEqual(calls.filter((url) => url.pathname.endsWith("housList")).map((url) => url.searchParams.get("housType")),
    ["0", "1", "0", "1"]);
  assert.ok(reports.every((report) => report.catalogs.attempted === 1 && report.catalogs.succeeded === 1));
  assert.deepEqual(reports.map((report) => report.requestsUsed), [3, 3, 3, 3]);
  assert.equal(reports.reduce((total, report) => total + report.requestsUsed, 0), calls.length);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM query_catalogs WHERE fetched_at=?").bind(clock().toISOString()).first()).n, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM query_calendars").first()).n, 4);
});

test("overlapping Cron invocation observes persistent lease and sends no fetch", async (t) => {
  const { db, clock } = await setup(t);
  let entered; const entering = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; entered(); await gate; return officialResponse([]); };
  const running = createCollector({ db, clock, fetchImpl, budget: 1 }).run();
  await entering;
  const overlap = await createCollector({ db, clock, fetchImpl }).run();
  assert.equal(overlap.status, "skipped");
  assert.equal(overlap.requestsUsed, 0);
  assert.equal(calls, 1);
  release(); await running;
});

test("failed catalog request consumes budget and backoff permits the other catalog next run", async (t) => {
  const { db, clock } = await setup(t);
  const calls = [];
  const fetchImpl = async (url) => { calls.push(new URL(url).searchParams.get("housType")); return officialResponse([], 503); };
  const first = await createCollector({ db, clock, fetchImpl, budget: 1 }).run();
  const second = await createCollector({ db, clock, fetchImpl, budget: 1 }).run();
  assert.equal(first.requestsUsed, 1); assert.equal(second.requestsUsed, 1);
  assert.deepEqual(calls, ["0", "1"]);
  const third = await createCollector({ db, clock, fetchImpl, budget: 1 }).run();
  assert.equal(third.requestsUsed, 0);
});

test("interval jobs share actual POST results, cannot starve behind calendars, and consume the same budget", async (t) => {
  const { db, store, clock } = await setup(t);
  const items = Array.from({ length: 90 }, (_, index) => station(index));
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items, fetchedAt: clock().toISOString() });
  await store.enqueueIntervalQuery({ date: "2026-10-15", endDate: "2026-10-18", stationId: "000" });
  const calls = [];
  const report = await createCollector({ db, clock, budget: 6, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return officialResponse(options.method === "POST" ? { idleCnt: 4 } : [{ applyDate: "2026-10-15", applyNumber: 0 }]);
  } }).run();
  assert.equal(report.requestsUsed, 6);
  assert.equal(report.intervals.succeeded, 1);
  assert.equal(report.calendars.succeeded, 5);
  const post = calls.find(({ options }) => options.method === "POST");
  assert.deepEqual(JSON.parse(post.options.body), { intoDate: "2026-10-15", endDate: "2026-10-18", houseId: "000" });
  assert.equal((await store.readIntervals(["000"], "2026-10-15", "2026-10-18")).get("000").payload.availableCount, 4);
  assert.equal((await store.dueIntervalJobs()).length, 0);
});

test("only active reminder intervals expand into shared tasks and reminder records are untouched", async (t) => {
  const { db, store, clock } = await setup(t);
  const items = [station(0), station(1, { district: "徐汇区" })];
  await store.saveCatalog("0", { items, fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items, fetchedAt: clock().toISOString() });
  for (const [id, status, conditions] of [
    ["one", "active", { date: "2026-10-15", endDate: "2026-10-18", district: "浦东新区" }],
    ["two", "active", { date: "2026-10-15", endDate: "2026-10-18", stationId: "000" }],
    ["pending", "pending", { date: "2026-10-15", endDate: "2026-10-19", stationId: "001" }],
  ]) await db.prepare("INSERT INTO reminders (id,email,conditions_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(id, "fixture@example.test", JSON.stringify(conditions), status, clock().toISOString(), clock().toISOString()).run();
  const before = await db.prepare("SELECT * FROM reminders ORDER BY id").all();
  let posts = 0;
  const result = await createCollector({ db, clock, fetchImpl: async (_url, options) => {
    if (options.method === "POST") { posts += 1; return officialResponse({ idleCnt: 1 }); }
    return officialResponse([]);
  } }).run();
  assert.equal(result.reminders.activeReminders, 2);
  assert.equal(posts, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM interval_query_jobs").first()).n, 1);
  assert.deepEqual((await db.prepare("SELECT * FROM reminders ORDER BY id").all()).results, before.results);
});

test("failed refresh retains old successful observations and uses persistent backoff", async (t) => {
  const { db, store, clock, advance } = await setup(t);
  await store.saveCatalog("0", { items: [station(0)], fetchedAt: clock().toISOString() });
  await store.saveCatalog("1", { items: [station(0)], fetchedAt: clock().toISOString() });
  const original = clock().toISOString();
  await store.saveCalendarBatch([{ stationId: "000", calendar: { "2026-10-15": { availabilityStatus: "known", availableCount: 5 } }, fetchedAt: original }]);
  advance(16 * 60_000);
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; return url.includes("housList") ? officialResponse([station(0)]) : officialResponse([], 503); };
  const report = await createCollector({ db, clock, fetchImpl }).run();
  assert.equal(report.calendars.failed, 1);
  const calendar = (await store.readCalendars(["000"])).get("000");
  assert.equal(calendar.fetchedAt, original); assert.equal(calendar.payload.calendar["2026-10-15"].availableCount, 5);
  const countBefore = calls;
  assert.equal((await createCollector({ db, clock, fetchImpl }).run()).requestsUsed, 0);
  assert.equal(calls, countBefore);
});

test("a full slice uses bulk snapshot SQL below D1 free per-invocation query budget", async (t) => {
  const { db, clock } = await setup(t);
  let statements = 0;
  const countedDb = { prepare: (...args) => { statements += 1; return db.prepare(...args); }, batch: (...args) => db.batch(...args) };
  const report = await createCollector({ db: countedDb, clock, fetchImpl: async (url) => officialResponse(url.includes("housList")
    ? Array.from({ length: 90 }, (_, index) => station(index)) : []) }).run();
  assert.equal(report.requestsUsed, 30);
  assert.ok(statements < 25, `used ${statements} SQL statements`);
});

test("collector uses slim catalog/calendar reads while preserving fresh raw official links in public storage", async (t) => {
  const { db, clock, store } = await setup(t);
  const statements = [];
  const countedDb = { prepare(sql) { statements.push(sql); return db.prepare(sql); }, batch: (...args) => db.batch(...args) };
  await createCollector({ db: countedDb, clock, budget: 3, fetchImpl: async (url) => officialResponse(url.includes("housList")
    ? [{ ...station(0), dizhi: "测试地址", street: "人才街道", lxfs: "fixture-contact" }] : []) }).run();
  assert.ok(statements.some((sql) => sql.includes("AS items_json")));
  assert.ok(statements.some((sql) => sql.includes("AS has_payload FROM query_calendars")));
  assert.ok(!statements.some((sql) => /SELECT \* FROM query_catalogs|SELECT \* FROM query_calendars/.test(sql)));
  const saved = await store.readCatalog("0");
  const details = JSON.parse(new URL(saved.payload.items[0].officialUrl).searchParams.get("passObj"));
  assert.equal(details.dizhi, "测试地址"); assert.equal(details.street, "人才街道");
  assert.equal(details.lxfs, "fixture-contact");
});

test('ordinary collection batches lock, planning and fenced completion into two D1 round trips',async(t)=>{
 const db=await applyMigrations(createTestDb());t.after(()=>db.close());const clock=()=>new Date('2026-10-14T00:00:00Z'),store=createSnapshotStore({db,clock});await store.saveCatalog('0',{items:Array.from({length:90},(_,id)=>({id:String(id),name:'站'+id})),fetchedAt:clock().toISOString()});await store.saveCatalog('1',{items:[],fetchedAt:clock().toISOString()});
 let trips=0;const wrap=(s)=>new Proxy(s,{get(target,p){if(p==='bind')return(...v)=>wrap(target.bind(...v));if(['first','all','run'].includes(p))return(...a)=>{trips++;return target[p](...a);};const v=target[p];return typeof v==='function'?v.bind(target):v;}});
 const adapter={prepare:(...a)=>wrap(db.prepare(...a)),batch:(s)=>{trips++;return db.batch(s);}};
 const report=await createCollector({db:adapter,clock,budget:10,fetchImpl:async()=>new Response(JSON.stringify({success:true,data:[{applyDate:'2026-10-20',applyNumber:2}]}))}).run();assert.equal(report.requestsUsed,10);assert.ok(trips<=2,`${trips} D1 round trips`);
});

test('an expired completion cannot save data or release a newer lease, including the combined final transaction',async(t)=>{
 const db=await applyMigrations(createTestDb());t.after(()=>db.close());let at=Date.now();const clock=()=>new Date(at),store=createSnapshotStore({db,clock});const old=await store.acquireLease({leaseMs:1});at+=2;const current=await store.acquireLease();
 const ok=await store.finishCollection(old,{calendars:[{ok:true,stationId:'one',calendar:{'2026-10-20':{availabilityStatus:'known',availableCount:2}},fetchedAt:clock().toISOString()}],cursors:{calendarCursor:'wrong'}});assert.equal(ok,false);assert.equal((await store.readCalendars(['one'])).get('one').status,'missing');assert.equal(await store.hasLease(current),true);await store.releaseLease(current);
});
