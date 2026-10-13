import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.mjs";
import { COLLECTION_CRON, MONITOR_CRON, COLLECTION_POLICY } from "../src/application/collection-policy.mjs";
import { createTestDb, applyMigrations } from "./helpers/d1.mjs";

test("production Cron collects ten requests every minute and keeps monitoring in a separate invocation", async (t) => {
  const db=await applyMigrations(createTestDb()); t.after(()=>db.close()); let calls=0;
  t.mock.method(globalThis,"fetch",async(url)=>{
    calls++; return new Response(JSON.stringify({success:true,data:String(url).includes("housList")
      ? Array.from({length:90},(_,id)=>({id:String(id),name:`驿站${id}`})) : []}));
  });
  const env={DB:db,ENABLE_MONITORING:"false"};
  const collected=await worker.scheduled({cron:COLLECTION_CRON},env);
  assert.equal(COLLECTION_CRON,"* * * * *"); assert.equal(COLLECTION_POLICY.budget,10);
  assert.equal(collected.collection.requestsUsed,10); assert.equal(calls,10);
  const monitored=await worker.scheduled({cron:MONITOR_CRON},env);
  assert.equal(MONITOR_CRON,"*/2 * * * *"); assert.deepEqual(monitored,{}); assert.equal(calls,10);
});
