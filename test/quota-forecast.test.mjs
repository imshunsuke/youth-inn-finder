import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeInsights,forecastUsage} from '../scripts/d1-usage-report.mjs';
import {safeTrace} from '../scripts/acceptance.mjs';
const sample=(at,rowsWritten,rowsRead=1000)=>({at:`2026-10-14T${at}:00Z`,day:'2026-10-14',rowsWritten,rowsRead,completeQuerySet:true});
test('quota forecast warns from growth before the hard limit, without mixing UTC days or old bursts',()=>{
  const report=forecastUsage([sample('01:00',100),sample('05:00',50000),sample('06:00',55000)]);
  assert.equal(report.ready,true);assert.equal(report.writtenPerHour,5000);assert.equal(report.projectedWritesAtReset,145000);assert.equal(report.warning,true);
  assert.equal(forecastUsage([{...sample('23:00',99999),day:'2026-10-13'},sample('06:00',1000)]).ready,false);
  assert.equal(forecastUsage([sample('05:00',60000),sample('06:00',55000)]).reason,'ANALYTICS_COUNTER_REGRESSED');
  assert.equal(forecastUsage([sample('05:00',100),{...sample('06:00',200),completeQuerySet:false}]).ready,false);
});
test('analytics reports only numeric categories, strips SQL and rejects absent totals',()=>{
  const report=summarizeInsights([{query:'INSERT INTO interval_query_jobs VALUES ("private token")',totalRowsWritten:17,totalRowsRead:25}],Date.parse('2026-10-14T06:00:00Z'));
  assert.equal(report.groups.queue.rowsWritten,17);assert.doesNotMatch(JSON.stringify(report),/private|token|VALUES/);
  assert.throws(()=>summarizeInsights([{query:'SELECT private'}]));
});
test('runtime D1 evidence keeps metadata and discards unapproved log fields',()=>{
  const trace=safeTrace({logs:[{message:[JSON.stringify({event:'d1_usage',phase:'collection',statements:8,rowsRead:300,rowsWritten:12,missingMeta:0,failures:0,complete:true,sql:'private',email:'private@example.test'})]}]});
  assert.deepEqual(trace.d1,{phase:'collection',statements:8,rowsRead:300,rowsWritten:12,missingMeta:0,failures:0,complete:true});
  assert.doesNotMatch(JSON.stringify(trace),/private|email|sql/);
});
