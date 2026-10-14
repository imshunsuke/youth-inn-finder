import assert from 'node:assert/strict';
import test from 'node:test';
import {measureD1Usage} from '../src/infrastructure/d1-usage.mjs';
import {assignedColumns,installWriteAudit} from '../scripts/quota-model.mjs';
import {createTestDb} from './helpers/d1.mjs';
import {applyMigrations} from './helpers/d1.mjs';
import {createSnapshotStore} from '../src/infrastructure/snapshot-store.mjs';
import worker from '../src/worker.mjs';

test('D1 meter counts actual metadata across bind, returning-first and native batch without retaining values',async()=>{
  const seen=[];
  const original={bind(...values){seen.push(values);return this;},async all(){return {results:[{count:7}],meta:{rows_read:9,rows_written:4}};},async run(){return this.all();}};
  const native={prepare(sql){seen.push(sql);return original;},async batch(statements){assert.ok(statements.every(x=>x===original));return Promise.all(statements.map(x=>x.run()));}};
  const meter=measureD1Usage(native),statement=meter.db.prepare('private SQL').bind('private token');
  assert.equal(await statement.first('count'),7);assert.deepEqual(await statement.first(),{count:7});
  await meter.db.batch([statement,statement]);await statement.run();
  assert.deepEqual(meter.summary(),{statements:5,rowsRead:45,rowsWritten:20,missingMeta:0,failures:0,complete:true});
  assert.doesNotMatch(JSON.stringify(meter.summary()),/private|token|SQL/);
});
test('missing D1 metadata or failed statements cannot be reported as complete zero usage',async()=>{
  const meter=measureD1Usage({prepare:()=>({all:async()=>({results:[]}),run:async()=>{throw new Error('private body');}})});
  assert.equal(await meter.db.prepare('SELECT').first(),null);
  await assert.rejects(meter.db.prepare('UPDATE').run());
  assert.equal(meter.summary().complete,false);assert.equal(meter.summary().missingMeta,1);assert.equal(meter.summary().failures,1);
  assert.doesNotMatch(JSON.stringify(meter.summary()),/private body/);
});
test('offline index model identifies assignments without counting nested WHERE keys as modified columns',()=>{
  assert.deepEqual([...assignedColumns("UPDATE t SET expires_at=MAX(expires_at,(SELECT x FROM j WHERE station_id=?)),priority=MAX(priority,?),updated_at=? WHERE station_id=? RETURNING *")],['expires_at','priority','updated_at']);
  assert.deepEqual([...assignedColumns("INSERT INTO t VALUES(?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,body='WHERE,SET' RETURNING id")],['value','body']);
});
test('offline audit counts real mutations including returning statements and only charges assigned indexes',async(t)=>{
  const base=createTestDb();t.after(()=>base.close());
  await base.exec('CREATE TABLE probe (id TEXT PRIMARY KEY,value INTEGER,body TEXT); CREATE INDEX probe_value ON probe(value)');
  const {db,read}=await installWriteAudit(base);
  await db.prepare('INSERT INTO probe VALUES(?,?,?)').bind('a',1,'private').run();
  await db.prepare('UPDATE probe SET value=? WHERE id=? RETURNING id').bind(2,'a').first();
  await db.batch([db.prepare('UPDATE probe SET body=? WHERE id=?').bind('changed','a')]);
  const totals=await read();
  assert.deepEqual(totals,[{table_name:'probe',operation:'INSERT',mutations:1,conservative_writes:3},{table_name:'probe',operation:'UPDATE',mutations:2,conservative_writes:4}]);
});
test('worker instrumentation preserves the shared public cache across requests and emits aggregate-only logs',async(t)=>{
  const db=await applyMigrations(createTestDb());t.after(()=>db.close());
  await createSnapshotStore({db}).saveCatalog('0',{items:[{id:'a',name:'fixture',isOnShelf:true}],fetchedAt:new Date().toISOString()});
  let reads=0;const originalDb={prepare(sql){reads++;return db.prepare(sql);},batch:statements=>db.batch(statements)};
  const env={DB:originalDb,ASSETS:{fetch:async()=>new Response('<script type="module" src="/app.bundle.js"></script>',{headers:{'Content-Type':'text/html'}})}};
  const originalLog=console.info,logs=[];console.info=value=>logs.push(value);t.after(()=>{console.info=originalLog;});
  for(let i=0;i<3;i++){const response=await worker.fetch(new Request('https://fixture.example.test/'),env);assert.equal(response.status,200);assert.match(await response.text(),/bootstrap-catalog/);}
  assert.equal(reads,1);assert.equal(logs.length,3);assert.ok(logs.every(line=>JSON.parse(line).event==='d1_usage'));
  assert.doesNotMatch(logs.join(''),/SELECT|fixture|fetchedAt/);
});
