import assert from "node:assert/strict";
import test from "node:test";
import { freshSample, favoriteForQuery, freshIntervalView, MAX_SAMPLE_AGE_MS } from "../public/lib/listing-state.mjs";
const now=Date.parse("2026-10-14T00:00:00Z");
const row={id:"one",name:"驿站",availableCount:7,availabilityStatus:"known",fetchedAt:new Date(now).toISOString()};
test("favorites cannot carry counts between dates, after expiry or from localStorage without a current observation",()=>{
  for(const confirmed of [undefined,{...row,fetchedAt:new Date(now-MAX_SAMPLE_AGE_MS).toISOString()}]) {
    const view=favoriteForQuery(row,{...row,name:"新名称"},confirmed,now);
    assert.equal(view.name,"新名称"); assert.equal(view.availableCount,null); assert.equal(view.availabilityStatus,"unknown");
  }
  assert.equal(favoriteForQuery({...row,availableCount:9},undefined,{...row,availableCount:2},now).availableCount,2);
});
test("cached interval responses lose expired positives even when the next HTTP request fails",()=>{
  const payload={data:[row],meta:{availabilityFetchedAt:row.fetchedAt}};
  assert.equal(freshIntervalView(payload,now+MAX_SAMPLE_AGE_MS-1).items.length,1);
  const expired=freshIntervalView(payload,now+MAX_SAMPLE_AGE_MS);
  assert.equal(expired.items.length,0); assert.equal(expired.stale,true);
  assert.equal(freshSample({fetchedAt:"invalid"},now),false);
  assert.equal(freshSample({fetchedAt:new Date(now+1).toISOString()},now),false);
});
test("an expired empty negative is unknown while still-fresh positives remain useful as partial evidence",()=>{
  const old=new Date(now-MAX_SAMPLE_AGE_MS).toISOString();
  assert.equal(freshIntervalView({data:[],meta:{availabilityFetchedAt:old}},now).stale,true);
  const view=freshIntervalView({data:[{...row,fetchedAt:old},row],meta:{availabilityFetchedAt:old}},now);
  assert.equal(view.items.length,1); assert.equal(view.stale,true);
});
