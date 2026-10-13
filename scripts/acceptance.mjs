import { mkdir, appendFile, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { addDays, todayInShanghai } from "../src/domain/dates.mjs";

export const CRITERIA = Object.freeze({ durationMinutes: 70, idleStartMinutes: 10, idleEndMinutes: 35,
  firstResultMs: 45_000, fullRangeMs: 600_000, httpP95Ms: 3000, availability: 0.99, cacheAgeMs: 1200_000 });
const paths = new Set(["/api/available", "/api/calendar", "/api/collection", "/api/health", "/api/station"]);
const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null;

// Never retain request headers, query strings, bodies, log messages or exceptions.
export function safeTrace(event) {
  let path = "other";
  try { const candidate = new URL(event.event?.request?.url).pathname; if (paths.has(candidate)) path = candidate; } catch {}
  let collection; const count=(n)=>Number.isInteger(n)&&n>=0&&n<=1000?n:null;
  for (const log of event.logs ?? []) for (const message of log.message ?? []) {
    if (typeof message !== "string") continue;
    try { const p=JSON.parse(message); if(p.event === "collection_summary") collection={status:["collected","skipped","lease-lost"].includes(p.status)?p.status:"unknown",
      requests:count(p.requestsUsed), calendars:count(p.calendars?.succeeded), intervals:count(p.intervals?.succeeded)};
      else if(p.event === "collection_failed") collection={status:"failed"}; } catch {}
  }
  return { at: event.eventTimestamp, path, collection, cron: ["*/2 * * * *", "* * * * *", "0 19 * * *"].includes(event.event?.cron) ? event.event.cron : undefined,
    deployment: /^[a-f0-9-]{36}$/.test(event.scriptVersion?.id ?? "") ? event.scriptVersion.id : undefined,
    outcome: ["ok", "exception", "exceededCpu", "exceededMemory", "canceled", "unknown"].includes(event.outcome) ? event.outcome : "unknown",
    cpuMs: Number.isFinite(event.cpuTime) ? event.cpuTime : null, wallMs: Number.isFinite(event.wallTime) ? event.wallTime : null };
}

export function inspectSnapshot(p, at = Date.now()) {
  const issues = [], c = p?.meta?.snapshotCoverage;
  if (!c || !Array.isArray(p.data)) return ["INVALID_QUERY_SCHEMA"];
  if (["freshStations", "staleStations", "missingStations", "invalidStations"].reduce((n,k)=>n+c[k],0) !== c.totalStations) issues.push("COVERAGE_DENOMINATOR");
  for (const row of p.data) {
    if (row.availabilityStatus !== "known" || !Number.isSafeInteger(row.availableCount) || row.availableCount <= 0) issues.push("INVALID_POSITIVE_COUNT");
    const age = at - Date.parse(row.fetchedAt);
    if (!Number.isFinite(age) || age < -1000 || age >= CRITERIA.cacheAgeMs) issues.push("STALE_COUNT_EXPOSED");
  }
  if (c.freshStations === 0 && p.data.length) issues.push("NO_FRESH_SAMPLE_BUT_POSITIVE");
  return [...new Set(issues)];
}

export function summarize(samples, traces, { durationMs, expectedDurationMs, idleStartMs, idleEndMs, expectedDeployment } = {}) {
  const queries = samples.filter((s) => s.kind === "query"), errors = samples.filter((s) => s.http !== 200 || s.error);
  const violations = samples.flatMap((s) => s.issues ?? []), gates = [];
  if (durationMs < expectedDurationMs) gates.push("DURATION_INCOMPLETE");
  if (!samples.length || (samples.length-errors.length)/samples.length < CRITERIA.availability) gates.push("HTTP_AVAILABILITY");
  if (samples.some((s) => s.http === 429)) gates.push("NORMAL_TRAFFIC_RATE_LIMITED");
  if (!expectedDeployment || samples.some((s) => s.http===200 && s.deployment !== expectedDeployment)) gates.push("DEPLOYMENT_CHANGED_OR_UNIDENTIFIED");
  if (violations.length) gates.push(...violations);
  const ranges = {};
  for (const date of [...new Set(queries.map((s) => s.date))]) {
    const rows = queries.filter((s) => s.date === date), first = rows.find((s) => s.fresh > 0), full = rows.find((s) => s.fresh === s.total && s.total > 0 && s.unknown === 0);
    if (rows[0]?.fresh!==0) gates.push(`INITIAL_COLD_NOT_PROVEN:${date}`);
    const resumed = rows.filter((s) => s.elapsedMs >= idleEndMs), resumedFull = resumed.find((s)=>s.fresh===s.total && s.total>0 && s.unknown===0);
    const afterSecondExpiry = resumed.filter((s) => s.elapsedMs >= (resumed[0]?.elapsedMs ?? Infinity) + CRITERIA.cacheAgeMs);
    const laterFull = afterSecondExpiry.find((s) => s.fresh===s.total && s.total>0 && s.unknown===0);
    ranges[date] = { firstResultMs: first?.elapsedMs ?? null, fullMs: full?.elapsedMs ?? null,
      resumeFresh: resumed[0]?.fresh ?? null, resumeStale: resumed[0]?.stale ?? null,
      recoveryMs: resumedFull ? resumedFull.elapsedMs-idleEndMs : null, fullAfterSecondExpiry: Boolean(laterFull) };
    if (!first || first.elapsedMs>CRITERIA.firstResultMs) gates.push(`FIRST_RESULT:${date}`);
    if (!full || full.elapsedMs>CRITERIA.fullRangeMs) gates.push(`FULL_RANGE:${date}`);
    if (!resumed.length || resumed[0].fresh !== 0 || !resumed[0].stale) gates.push(`NATURAL_EXPIRY_NOT_PROVEN:${date}`);
    if (!resumedFull || resumedFull.elapsedMs-idleEndMs>CRITERIA.fullRangeMs) gates.push(`EXPIRY_RECOVERY:${date}`);
    if (!laterFull) gates.push(`SECOND_CACHE_CYCLE:${date}`);
  }
  if (Object.keys(ranges).length < 3) gates.push("THREE_RANGES_REQUIRED");
  if (queries.some((s) => (s.startedElapsedMs??s.elapsedMs)>=idleStartMs && (s.startedElapsedMs??s.elapsedMs)<idleEndMs)) gates.push("IDLE_PHASE_NOT_IDLE");
  const idleCalendars = samples.filter((s)=>s.kind === "calendar" && s.elapsedMs>=idleStartMs && s.elapsedMs<idleEndMs);
  if (new Set(idleCalendars.map((s)=>s.latestSample).filter(Boolean)).size<2) gates.push("CRON_PROGRESS_NOT_PROVEN");
  if (idleCalendars.some((s)=>s.http===200 && s.total>0 && s.fresh/s.total<.85)) gates.push("BACKGROUND_CALENDAR_FRESHNESS");
  const queryP95Ms = percentile(queries.filter((s)=>s.http===200).map((s)=>s.durationMs),.95);
  if (queryP95Ms === null || queryP95Ms>CRITERIA.httpP95Ms) gates.push("QUERY_LATENCY_P95");
  const currentTraces = traces.filter((s)=>s.deployment===expectedDeployment);
  if (currentTraces.length<20) gates.push("RUNTIME_OBSERVABILITY_INCOMPLETE");
  const cpuOverBudget = currentTraces.filter((s)=>s.cpuMs>10).length;
  if (currentTraces.some((s)=>s.outcome === "exceededCpu" || s.outcome === "exceededMemory")) gates.push("RUNTIME_LIMIT_TERMINATION");
  if (currentTraces.some((s)=>s.collection?.status === "failed")) gates.push("CRON_COLLECTION_FAILURE");
  const byPath={};
  for (const path of ["/api/available","/api/calendar","/api/collection","cron"]) {
    const selected=currentTraces.filter((s)=>path==="cron"?s.cron:s.path===path);
    byPath[path]={observed:selected.length,p95Ms:percentile(selected.map((s)=>s.cpuMs).filter(Number.isFinite),.95),over10ms:selected.filter((s)=>s.cpuMs>10).length};
  }
  return { functional: gates.length ? "FAIL" : "PASS", gates: [...new Set(gates)], durationMs, sampleCount: samples.length,
    errors: errors.length, availability: samples.length ? (samples.length-errors.length)/samples.length : 0, queryP95Ms, ranges,
    cpu: { status: !currentTraces.length ? "UNOBSERVED" : cpuOverBudget ? "BUDGET_RISK" : "WITHIN_OBSERVED_BUDGET",
      observed: currentTraces.length, over10ms: cpuOverBudget, p95Ms: percentile(currentTraces.map((s)=>s.cpuMs).filter(Number.isFinite),.95),
      terminations: currentTraces.filter((s)=>s.outcome === "exceededCpu" || s.outcome === "exceededMemory").length,byPath } };
}

export async function runAcceptance({ baseUrl, minutes = 70, output = ".data/acceptance", tail = false, offset = 12 } = {}) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) throw new Error("Use a public HTTPS origin or a local development origin");
  if (!Number.isFinite(minutes) || minutes < 70 || minutes > 90) throw new Error("Acceptance duration must be 70–90 minutes");
  if (!Number.isInteger(offset) || offset<2 || offset>60) throw new Error("Date offset must be 2–60 days");
  const root = resolve(output); await mkdir(root, { recursive: true });
  await writeFile(resolve(root,"samples.jsonl"),"",{flag:"wx"});
  await writeFile(resolve(root,"runtime.jsonl"),"",{flag:"wx"});
  const started = Date.now(), today = todayInShanghai(), dates = [offset,offset+1,offset+2].map((days)=>addDays(today,days)), endDate=addDays(today,offset+3);
  const samples = [], traces = [], suppressedUntil = new Map(); let expectedDeployment, tailChild, tailBuffer = "", lastMinute = -1, stopped = false;
  const stop=()=>{stopped=true;}; process.once("SIGINT",stop); process.once("SIGTERM",stop);
  const metadata = { startedAt: new Date(started).toISOString(), baseUrl: base.origin, dates, endDate, minutes,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), criteria: CRITERIA };
  const save = (file, row) => appendFile(resolve(root,file), JSON.stringify(row)+"\n");
  if (tail) {
    tailChild = spawn("npx", ["wrangler", "tail", "youth-inn-finder", "--format", "json"], { stdio: ["ignore","pipe","pipe"] });
    tailChild.stdout.on("data", (chunk) => {
      tailBuffer += chunk.toString(); let end;
      while ((end=tailBuffer.indexOf("\n}\n"))>=0) {
        const candidate=tailBuffer.slice(0,end+2); tailBuffer=tailBuffer.slice(end+3);
        const start=candidate.indexOf("{");
        try { const row=safeTrace(JSON.parse(candidate.slice(start))); traces.push(row); void save("runtime.jsonl",row); } catch {}
      }
      if (tailBuffer.length>4_000_000) tailBuffer="";
    });
    tailChild.stderr.on("data",()=>{});
  }
  async function sample(kind, path, { date, method="GET" }={}) {
    const key=`${kind}:${date??""}`;
    if ((suppressedUntil.get(key)??0)>Date.now()) return {row:{skipped:true,http:null},payload:null};
    const began=Date.now(); let row, payload, http=0, deployment=null;
    try {
      const r=await fetch(new URL(path,base), { method, redirect:"error", signal:AbortSignal.timeout(method==="POST"?20_000:15_000) });
      http=r.status; deployment=r.headers.get("X-Deployment-Id");
      const retry=r.headers.get("Retry-After");
      if ([429,503].includes(http) && /^\d+$/.test(retry??"")) suppressedUntil.set(key,Date.now()+Number(retry)*1000);
      const text=await r.text(); if(text.length>1_000_000) throw new Error("oversize"); payload=JSON.parse(text);
      const c=payload.meta?.snapshotCoverage;
      row={ kind,date,at:new Date().toISOString(),startedElapsedMs:began-started,elapsedMs:Date.now()-started,http:r.status,durationMs:Date.now()-began,
        deployment, fresh:c?.freshStations,total:c?.totalStations,stale:c?.staleStations,missing:c?.missingStations,
        unknown:payload.meta?.coverage?.unknownStations, rooms:payload.data?.length,latestSample:payload.meta?.latestFetchedAt,
        catalogStatus:payload.meta?.catalogStatus,code:typeof payload.code==="string"?payload.code:undefined,
        collectionStatus:kind==="collection"?payload.status:undefined,reason:kind==="collection"?payload.reason:undefined,
        attempted:kind==="collection"?payload.attempted:undefined,succeeded:kind==="collection"?payload.succeeded:undefined,failed:kind==="collection"?payload.failed:undefined,
        issues:kind==="query" && r.status===200?inspectSnapshot(payload,Date.parse(payload.meta.generatedAt)):[] };
    } catch { row={kind,date,at:new Date().toISOString(),elapsedMs:Date.now()-started,http,deployment,durationMs:Date.now()-began,error:"TRANSPORT_OR_INVALID_RESPONSE"}; }
    samples.push(row); await save("samples.jsonl",row); return { row,payload };
  }
  try {
    const initial=await sample("health","/api/health"); expectedDeployment=initial.row.deployment;
    if (!expectedDeployment) throw new Error("Deployment identity header is required before a live soak");
    metadata.deployment=expectedDeployment; await writeFile(resolve(root,"metadata.json"),JSON.stringify(metadata,null,2));
    while (!stopped && Date.now()-started < minutes*60_000) {
      const elapsed=Date.now()-started, minute=Math.floor(elapsed/60_000), idle=minute>=10 && minute<35;
      const tickStart=Date.now();
      if (minute!==lastMinute) { await sample("calendar","/api/calendar?includeDayItems=false&includeOfficialDetails=false&onlyOnShelf=true"); await sample("health","/api/health"); lastMinute=minute; }
      const queryElapsed=Date.now()-started;
      if (!(queryElapsed>=600_000 && queryElapsed<2100_000)) {
        const results=await Promise.all(dates.map((date)=>sample("query",`/api/available?date=${date}&endDate=${endDate}&onlyOnShelf=true&limit=200&includeOfficialDetails=false`,{date})));
        if (results.some((r)=>r.payload?.meta?.collection?.advanceUrl==="/api/collection")) await sample("collection","/api/collection",{method:"POST"});
        if (results.some((r)=>!r.row.skipped && (r.row.http===429 || r.row.http===200 && r.row.deployment!==expectedDeployment || r.row.issues?.length))) {
          console.log(JSON.stringify({critical:"LIVE_GATE_FAILED",minute})); break;
        }
      }
      if (elapsed%60_000 < 12_000) console.log(JSON.stringify({ minute,phase:idle?"idle-expiry":"active",coverage:dates.map((date)=>{const s=samples.findLast((s)=>s.kind==="query"&&s.date===date);return`${s?.fresh??"?"}/${s?.total??"?"}`;}),samples:samples.length,errors:samples.filter((s)=>s.http!==200).length }));
      await new Promise((resolve)=>setTimeout(resolve,Math.max(250, (idle?60_000:10_000)-(Date.now()-tickStart))));
    }
  } finally {
    process.removeListener("SIGINT",stop); process.removeListener("SIGTERM",stop);
    tailChild?.kill("SIGTERM");
    const report=summarize(samples,traces,{durationMs:Date.now()-started,expectedDurationMs:minutes*60_000,idleStartMs:600_000,idleEndMs:2100_000,expectedDeployment});
    await writeFile(resolve(root,"report.json"),JSON.stringify({...metadata,...report},null,2));
    console.log(JSON.stringify({ report:resolve(root,"report.json"),...report }));
  }
  return JSON.parse(await readFile(resolve(root,"report.json"),"utf8"));
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={};
  for(let i=2;i<process.argv.length;i++) { const key=process.argv[i]; if(key==="--tail") options.tail=true;
    else if(["--url","--minutes","--output","--offset"].includes(key)) { const value=process.argv[++i]; options[key==="--url"?"baseUrl":key.slice(2)]=["--minutes","--offset"].includes(key)?Number(value):value; }
    else throw new Error("Unknown acceptance option"); }
  const report=await runAcceptance(options); if(report.functional!=="PASS") process.exitCode=1;
}
