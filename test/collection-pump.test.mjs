import assert from "node:assert/strict";
import test from "node:test";
import { createCollectionPump } from "../public/lib/collection-pump.mjs";
const pending = { pending: true, collection: { advanceUrl: "/api/collection" } };

test("hidden, complete and untrusted collection URLs do not trigger upstream work", async () => {
  const pump = createCollectionPump({ requestImpl: () => { throw new Error("unexpected request"); } });
  for (const [meta, options] of [[pending, { visible: false }], [{ ...pending, pending: false }],
    [{ ...pending, collection: { advanceUrl: "https://other.test/collect" } }], [undefined]]) {
    assert.equal(await pump.advance(meta, options), null);
  }
});
test("overlapping ticks coalesce and failures honor Retry-After before resuming", async () => {
  let at = 0, calls = 0, unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const pump = createCollectionPump({ clock: () => at, requestImpl: async (path, options) => {
    calls++; assert.equal(path, "/api/collection"); assert.equal(options.method, "POST"); assert.equal(options.body, undefined);
    if (calls === 1) { await blocked; return { payload: { status: "collected" }, retryAfter: "10" }; }
    if (calls === 2) throw Object.assign(new Error("rate limited"), { status: 429, retryAfter: "600" });
    return { payload: { status: "idle" }, retryAfter: "10" };
  } });
  const first = pump.advance(pending); at = 10_000;
  assert.equal(pump.advance(pending), first); assert.equal(calls, 1);
  unblock(); await first;
  at = 10_000; await assert.rejects(pump.advance(pending), /rate limited/);
  at = 609_999; assert.equal(await pump.advance(pending), null);
  at = 610_000; assert.equal((await pump.advance(pending)).status, "idle"); assert.equal(calls, 3);
});
test("network time does not add a second cooldown to successful collection",async()=>{
  let at=0,calls=0;
  const pump=createCollectionPump({clock:()=>at,requestImpl:async()=>{calls++;at+=500;return{payload:{status:"collected"},retryAfter:"10"};}});
  await pump.advance(pending); assert.equal(at,500);
  at=999; assert.equal(await pump.advance(pending),null);
  at=1250; await pump.advance(pending); assert.equal(calls,2);
});

test('a visible pending range drains continuously, stops on completion and never doubles in-flight requests',async()=>{
 let at=0,calls=0,active=0,max=0,meta={...pending},progress=0;
 const pump=createCollectionPump({clock:()=>at,wait:async(ms)=>{at+=ms;},requestImpl:async()=>{calls++;active++;max=Math.max(max,active);at+=600;active--;return{payload:{status:'collected',succeeded:6},retryAfter:'1'};}});
 const read=()=>({meta,visible:true});const run=pump.drain('range',read,(r)=>{progress+=r.succeeded;if(progress>=90)meta={pending:false};});assert.equal(pump.drain('range',read),run);await run;
 assert.equal(calls,15);assert.equal(max,1);assert.ok(at<=20000);pump.observe('range',meta);assert.equal(pump.pollDelay('range'),10000);
});

test('fast draining is bounded to one minute and stops when hidden; a later read cannot renew its fast window',async()=>{
 let at=0,calls=0,visible=true;const pump=createCollectionPump({clock:()=>at,wait:async(ms)=>{at+=ms;},requestImpl:async()=>{calls++;return{payload:{status:'collected'},retryAfter:'1'};}});
 const read=()=>({meta:pending,visible});await pump.drain('range',read);assert.equal(at,60000);assert.equal(calls,48);assert.equal(pump.pollDelay('range'),10000);
 await pump.drain('range',read);assert.equal(calls,49);assert.equal(pump.pollDelay('range'),10000);
 visible=false;await pump.drain('other',read);assert.equal(calls,49);
});

test('one-second progress reads stop after the first sample or five seconds, without extending the fast window',()=>{
 let at=0;const pump=createCollectionPump({clock:()=>at});const empty={...pending,snapshotCoverage:{freshStations:0}};pump.observe('range',empty);assert.equal(pump.pollDelay('range'),1000);
 pump.observe('range',{...pending,snapshotCoverage:{freshStations:1}});assert.equal(pump.pollDelay('range'),2000);pump.observe('range',empty);at=5000;assert.equal(pump.pollDelay('range'),2000);at=60000;pump.observe('range',empty);assert.equal(pump.pollDelay('range'),10000);
});
