import assert from 'node:assert/strict';
import test from 'node:test';
import {withCatalogBootstrap} from '../src/http/catalog-bootstrap.mjs';
import {readBootstrapCatalog} from '../public/lib/search-view.mjs';
import {createApp} from '../src/http/app.mjs';
import {createSnapshotStore} from '../src/infrastructure/snapshot-store.mjs';
import {createQueryResponseCache} from '../src/infrastructure/query-response-cache.mjs';
import {createTestDb,applyMigrations} from './helpers/d1.mjs';
const now=Date.parse('2026-10-14T00:00:00Z'),fetchedAt=new Date(now).toISOString();
const html=()=>new Response('<html><body><script type="module" src="/app.bundle.js"></script></body></html>',{headers:{'Content-Type':'text/html','ETag':'old','Content-Length':'20'}});
const payload={data:[{id:'a',name:'</template><script>alert(1)</script>&',email:'private',availableCount:999}],meta:{fetchedAt}};
test('homepage bootstrap contains public directory only, escapes HTML and retains the original sample time',async()=>{
  const response=await withCatalogBootstrap(html(),Response.json(payload),now),body=await response.text();
  assert.doesNotMatch(body,/<script>alert|private|availableCount/);assert.match(body,/&lt;\/template&gt;/);assert.match(body,new RegExp(fetchedAt));
  assert.equal(response.headers.get('ETag'),null);assert.equal(response.headers.get('Content-Length'),null);assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('a missing, corrupt or hard-expired directory never prevents the static homepage from loading',async()=>{
  for(const catalog of [null,new Response('bad',{status:503}),Response.json({...payload,meta:{fetchedAt:new Date(now-24*60*60_000).toISOString()}})]) {
    const original=html(),response=await withCatalogBootstrap(original,catalog,now);assert.equal(response,original);assert.doesNotMatch(await response.text(),/bootstrap-catalog/);
  }
  assert.equal(readBootstrapCatalog({querySelector:()=>({content:{textContent:'bad'}})},now),null);
  assert.equal(readBootstrapCatalog({querySelector:()=>({content:{textContent:JSON.stringify(payload)}})},now).data[0].availableCount,undefined);
});
test('actual root router reuses the bounded public response cache and keeps script CSP unchanged',async(t)=>{
  const db=await applyMigrations(createTestDb());t.after(()=>db.close());const clock=()=>new Date(now);
  await createSnapshotStore({db,clock}).saveCatalog('0',{items:[{id:'a',name:'驿站',isOnShelf:true}],fetchedAt});
  let reads=0;const proxy={prepare(...args){reads++;return db.prepare(...args);},batch:(...args)=>db.batch(...args)};
  const app=createApp({env:{DB:proxy},clock,assetHandler:html,queryCache:createQueryResponseCache({clock:()=>now})});
  for(let i=0;i<3;i++) {
    const response=await app(new Request('https://finder.test/'));assert.equal(response.status,200);assert.match(await response.text(),/bootstrap-catalog/);
    assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/);assert.doesNotMatch(response.headers.get('Content-Security-Policy'),/unsafe-inline/);
  }
  assert.equal(reads,1);
});
