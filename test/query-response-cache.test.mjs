import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueryResponseCache} from '../src/infrastructure/query-response-cache.mjs';
import {createApp} from '../src/http/app.mjs';
import {createSnapshotStore} from '../src/infrastructure/snapshot-store.mjs';
import {createTestDb,applyMigrations} from './helpers/d1.mjs';

test('cached responses cannot outlive the oldest station or catalog, even at the exact expiry boundary',async(t)=>{
 const db=await applyMigrations(createTestDb());t.after(()=>db.close());let at=Date.parse('2026-10-14T00:00:00Z');const clock=()=>new Date(at),store=createSnapshotStore({db,clock});
 await store.saveCatalog('0',{items:[{id:'one',name:'驿站'}],fetchedAt:clock().toISOString()});
 await store.saveIntervalBatch([{stationId:'one',startDate:'2026-10-20',endDate:'2026-10-23',availableCount:2,availabilityStatus:'known',fetchedAt:clock().toISOString()}]);
 const cache=createQueryResponseCache({clock:()=>at}),app=createApp({env:{DB:db,APP_SECRET:'unit-test-secret-with-at-least-32-bytes'},clock,queryCache:cache});const req=()=>new Request('https://finder.test/api/available?date=2026-10-20&endDate=2026-10-23');
 at+=1200000-500;const first=await app(req());assert.equal((await first.json()).data.length,1);assert.equal(first.headers.get('X-Snapshot-Valid-Until'),String(at+500));
 at+=499;const hit=await app(req());assert.equal(hit.headers.get('X-Query-Cache'),'HIT');assert.equal((await hit.json()).data.length,1);
 at++;await store.saveCatalog('0',{items:[{id:'one',name:'驿站'}],fetchedAt:clock().toISOString()});const expired=await app(req());assert.notEqual(expired.headers.get('X-Query-Cache'),'HIT');const p=await expired.json();assert.equal(p.data.length,0);assert.equal(p.meta.pending,true);assert.equal(p.meta.snapshotCoverage.staleStations,1);
});

test('only successful public responses with a bounded validity hint can be cached; no reminder or credential entries',async()=>{
 let at=100;const cache=createQueryResponseCache({clock:()=>at,maxEntries:2,maxBytes:1000});
 const req=(path='/api/calendar',headers)=>new Request('https://finder.test'+path,{headers});
 const good=()=>new Response('public',{headers:{'X-Snapshot-Valid-Until':'500','Cache-Control':'no-store'}});
 for(const r of [req('/api/reminders'),req('/api/calendar',{Authorization:'Bearer private'}),req('/api/calendar',{Cookie:'private=true'})]){await cache.put(r,good());assert.equal(cache.get(r),null);}
 await cache.put(req(),new Response('pending'));assert.equal(cache.get(req()),null);
 await cache.put(req(),new Response('failed',{status:503,headers:{'X-Snapshot-Valid-Until':'500'}}));assert.equal(cache.get(req()),null);
 await cache.put(req(),good());assert.equal(await cache.get(req()).text(),'public');at=500;assert.equal(cache.get(req()),null);
});

test('cache hits still pass interval traffic admission and finite memory eviction',async(t)=>{
 const db=await applyMigrations(createTestDb());t.after(()=>db.close());let count=0;const cache=createQueryResponseCache({maxEntries:1});
 const app=createApp({env:{DB:db,APP_SECRET:'unit-test-secret-with-at-least-32-bytes'},queryCache:cache,queryHandler:async()=>{count++;return new Response('public',{headers:{'X-Snapshot-Valid-Until':String(Date.now()+60000)}});}});
 const req=(date='2026-10-20')=>new Request('https://finder.test/api/available?date='+date+'&endDate=2026-10-23');
 await app(req());await app(req());assert.equal(count,1);assert.equal((await db.prepare("SELECT count FROM http_rate_limits WHERE bucket_key LIKE 'interval:global:%'").first()).count,2);
 await app(req('2026-10-21'));await app(req());assert.equal(count,3);
});
