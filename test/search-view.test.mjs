import assert from 'node:assert/strict';
import test from 'node:test';
import { searchView, sanitizeCatalog, readCatalogCache, writeCatalogCache, HISTORY_MAX_AGE_MS } from '../public/lib/search-view.mjs';
import { MAX_SAMPLE_AGE_MS } from '../public/lib/listing-state.mjs';
const now = Date.parse('2026-10-14T00:00:00Z'), date='2026-10-16', endDate='2026-10-18';
const stations = ['a','b','c'].map((id) => ({id,name:`驿站${id}`,district:'浦东',availableCount:999}));
const sample = (stationId, availableCount, age=0) => ({stationId,availableCount,availabilityStatus:'known',fetchedAt:new Date(now-age).toISOString()});
const interval = (observations) => ({observations,meta:{date,endDate}});
const view = (changes={}) => searchView({stations,date,endDate,now,...changes});
test('a cold range yields real directory cards immediately, never invented room counts',()=>{
  const result=view(); assert.equal(result.pending,3); assert.equal(result.confirmed,0);
  for(const x of result.items){assert.equal(x.availableCount,null);assert.equal(x.displayState,'candidate');}
});
test('confirmation replaces a candidate; exact zero removes it, without losing the other unknown station',()=>{
  const result=view({interval:interval([sample('a',3),sample('b',0)])});
  assert.deepEqual(result.items.map(x=>[x.id,x.displayState]),[['a','confirmed'],['c','candidate']]);
  assert.equal(result.confirmed,1); assert.equal(result.pending,1); assert.equal(result.excluded,1);
});
test('counts cannot cross date ranges, and daily positives do not prove continuous availability',()=>{
  const calendar={stations:stations.map(x=>({...x,fetchedAt:new Date(now).toISOString(),availability:[{date,availableCount:9,availabilityStatus:'known'}]}))};
  assert.equal(view({calendar}).confirmed,0);
  assert.equal(view({interval:{...interval([sample('a',3)]),meta:{date,endDate:'2026-10-19'}}}).confirmed,0);
});
test('soft expiry keeps the same sample time as historical and hard expiry removes its count',()=>{
  const old=sample('a',3,MAX_SAMPLE_AGE_MS);
  const result=view({interval:interval([old,sample('b',0,MAX_SAMPLE_AGE_MS)])});
  assert.equal(result.confirmed,0); assert.equal(result.historical,2); assert.equal(result.pending,3);
  assert.equal(result.items[0].availableCount,null); assert.equal(result.items[0].historicalCount,3);
  assert.equal(result.items[0].historicalFetchedAt,old.fetchedAt);
  const hard=view({interval:interval([sample('a',3,HISTORY_MAX_AGE_MS)])});
  assert.equal(hard.items[0].displayState,'candidate'); assert.equal(hard.items[0].historicalCount,undefined);
});
test('invalid, missing, future samples and below-minimum confirmed counts remain distinct',()=>{
  const result=view({minCount:2,interval:interval([sample('a',1),sample('b',-1),sample('c',8,-1)])});
  assert.equal(result.excluded,1); assert.equal(result.confirmed,0); assert.equal(result.pending,2);
});
test('a stale daily zero remains a candidate; daily history is separate from known availability',()=>{
  const calendar={stations:[{id:'a',fetchedAt:new Date(now-MAX_SAMPLE_AGE_MS).toISOString(),historicalAvailability:{[date]:{availableCount:0,availabilityStatus:'known'}}}]};
  const result=view({calendar,endDate:null}); assert.equal(result.items[0].displayState,'historical'); assert.equal(result.items[0].historicalCount,0);
  assert.equal(result.items[0].availableCount,null);
});
test('not-open dates yield no candidates, and a fully confirmed negative can yield a legitimate empty result',()=>{
  assert.equal(view({interval:{meta:{date,endDate,availabilityStatus:'not-open'}}}).status,'not-open');
  const result=view({interval:interval(stations.map(x=>sample(x.id,0)))});assert.equal(result.status,'open');assert.equal(result.items.length,0);assert.equal(result.pending,0);
});
test('persisted directory is bounded, expires, and strips counts, credentials and official links',()=>{
  const data={data:[{...stations[0],email:'private',token:'secret',officialUrl:'https://example.test',isOnShelf:true}],meta:{fetchedAt:new Date(now).toISOString()}};
  const clean=sanitizeCatalog(data,now);assert.equal(clean.data[0].availableCount,undefined);assert.equal(clean.data[0].email,undefined);assert.equal(clean.data[0].token,undefined);assert.equal(clean.data[0].officialUrl,undefined);
  const records=new Map(),storage={getItem:k=>records.get(k),setItem:(k,v)=>records.set(k,v)};
  assert.equal(writeCatalogCache('0',data,storage,now),true);assert.equal(readCatalogCache('0',storage,now).data.length,1);
  assert.equal(readCatalogCache('1',storage,now),null);assert.equal(readCatalogCache('0',storage,now+24*60*60_000),null);
  assert.equal(sanitizeCatalog({...data,meta:{fetchedAt:new Date(now+1).toISOString()}},now),null);
  assert.equal(readCatalogCache('0',{getItem(){throw new Error('blocked');}},now),null);
});
