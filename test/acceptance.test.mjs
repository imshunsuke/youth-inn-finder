import assert from "node:assert/strict";
import test from "node:test";
import { safeTrace, inspectSnapshot, summarize } from "../scripts/acceptance.mjs";
const deployment="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function evidence() {
  const samples=[];
  for(const date of ["2026-10-26","2026-10-27","2026-10-28"]) for(const [elapsedMs,fresh,stale] of [[0,0,0],[10_000,3,0],[300_000,90,0],[2100_000,0,90],[2400_000,90,0],[3360_000,90,0]]) {
    samples.push({kind:"query",date,elapsedMs,fresh,stale,total:90,unknown:fresh===90?0:90-fresh,http:200,durationMs:100,deployment,issues:[]});
  }
  for(const elapsedMs of [1200_000,1800_000]) samples.push({kind:"calendar",elapsedMs,latestSample:String(elapsedMs),http:200,durationMs:100,deployment});
  const traces=Array.from({length:20},()=>({deployment,outcome:"ok",cpuMs:8}));
  const options={durationMs:4200_000,expectedDurationMs:4200_000,idleStartMs:600_000,idleEndMs:2100_000,expectedDeployment:deployment};
  return {samples,traces,options};
}
test("acceptance needs multi-range completion, natural expiry, recovery and a second cache lifetime",()=>{
  const {samples,traces,options}=evidence(); assert.equal(summarize(samples,traces,options).functional,"PASS");
  const onlyHttp=samples.map(s=>s.kind==="query"?{...s,fresh:0,unknown:90}:s);
  assert.equal(summarize(onlyHttp,traces,options).functional,"FAIL");
  const short=summarize(samples,traces,{...options,durationMs:300_000}); assert.ok(short.gates.includes("DURATION_INCOMPLETE"));
  const unobserved=summarize(samples,[],options); assert.ok(unobserved.gates.includes("RUNTIME_OBSERVABILITY_INCOMPLETE"));
});
test("rate limits, deployment drift and runtime terminations fail instead of being hidden by 200 responses",()=>{
  const {samples,traces,options}=evidence();
  assert.ok(summarize([...samples,{...samples[0],http:429}],traces,options).gates.includes("NORMAL_TRAFFIC_RATE_LIMITED"));
  assert.ok(summarize([...samples,{...samples[0],deployment:"different"}],traces,options).gates.includes("DEPLOYMENT_CHANGED_OR_UNIDENTIFIED"));
  const terminated=[...traces,{deployment,outcome:"exceededCpu",cpuMs:30}];
  assert.ok(summarize(samples,terminated,options).gates.includes("RUNTIME_LIMIT_TERMINATION"));
  const risk=summarize(samples,[...traces,{deployment,outcome:"ok",cpuMs:15}],options);
  assert.equal(risk.functional,"PASS"); assert.equal(risk.cpu.status,"BUDGET_RISK");
});
test("old positive counts, unknown/zero masquerading as rooms and inconsistent coverage are rejected",()=>{
  const now=Date.now(), meta={snapshotCoverage:{totalStations:1,freshStations:1,staleStations:0,missingStations:0,invalidStations:0}};
  const row={availabilityStatus:"known",availableCount:1,fetchedAt:new Date(now).toISOString()};
  assert.deepEqual(inspectSnapshot({meta,data:[row]},now),[]);
  assert.ok(inspectSnapshot({meta,data:[{...row,fetchedAt:new Date(now-1200_000).toISOString()}]},now).includes("STALE_COUNT_EXPOSED"));
  assert.ok(inspectSnapshot({meta,data:[{...row,availableCount:0}]},now).includes("INVALID_POSITIVE_COUNT"));
  assert.ok(inspectSnapshot({meta:{snapshotCoverage:{...meta.snapshotCoverage,freshStations:0}},data:[row]},now).includes("COVERAGE_DENOMINATOR"));
});
test("runtime evidence strips credentials, emails, URL parameters, headers and log messages",()=>{
  const raw={eventTimestamp:1,scriptVersion:{id:deployment},outcome:"ok",cpuTime:5,wallTime:10,
    event:{request:{url:"https://finder.example.test/api/available?email=private@example.test&token=private-token",headers:{Authorization:"private-secret"},body:"private-body"}},
    logs:[{message:["private-log"]}],exceptions:[{message:"private-exception"}]};
  const output=JSON.stringify(safeTrace(raw));
  assert.doesNotMatch(output,/private|Authorization|email|token/); assert.equal(safeTrace(raw).path,"/api/available");
});
