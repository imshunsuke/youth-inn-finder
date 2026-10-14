// Read-only analytics via the already authorized official CLI. Raw query text
// and CLI diagnostics are held in memory only, never printed or saved.
import {spawn} from 'node:child_process';
import {appendFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const tables={interval_query_jobs:'queue',query_collector_state:'collector',query_calendars:'calendar',query_catalogs:'catalog',query_intervals:'interval',http_rate_limits:'rateLimits',query_warm_ranges:'warming'};
export function summarizeInsights(queries,at=Date.now()) {
  if(!Array.isArray(queries))throw new TypeError('Invalid analytics response');
  const groups={};let rowsWritten=0,rowsRead=0;
  for(const q of queries) {
    if(!Number.isFinite(q.totalRowsWritten)||q.totalRowsWritten<0||!Number.isFinite(q.totalRowsRead)||q.totalRowsRead<0)throw new TypeError('Incomplete analytics totals');
    const table=/^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/i.exec(q.query??'')?.[1]?.toLowerCase();
    const kind=tables[table]??(table?.startsWith('reminder')?'reminders':'readsOrOther');
    const group=groups[kind]??={rowsWritten:0,rowsRead:0};group.rowsWritten+=q.totalRowsWritten;group.rowsRead+=q.totalRowsRead;
    rowsWritten+=q.totalRowsWritten;rowsRead+=q.totalRowsRead;
  }
  return {at:new Date(at).toISOString(),day:new Date(at).toISOString().slice(0,10),source:'D1 Query Insights since UTC midnight; adaptive analytics may lag',
    rowsWritten,rowsRead,queryGroups:queries.length,completeQuerySet:queries.length<1000,groups};
}
export function forecastUsage(samples,{minimumWindowMs=20*60_000}={}) {
  const latest=samples.at(-1);if(!latest)return {ready:false,reason:'NO_SAMPLES'};
  const current=samples.filter(x=>x.day===latest.day&&x.completeQuerySet&&Date.parse(latest.at)-Date.parse(x.at)<=2*3600_000);
  const last=current.at(-1),first=current.find(x=>Date.parse(last.at)-Date.parse(x.at)>=minimumWindowMs);
  if(!first||last!==latest)return {ready:false,reason:'INSUFFICIENT_COMPLETE_WINDOW'};
  if(last.rowsWritten<first.rowsWritten||last.rowsRead<first.rowsRead)return {ready:false,reason:'ANALYTICS_COUNTER_REGRESSED'};
  const elapsedMs=Date.parse(last.at)-Date.parse(first.at),remainingMs=Date.parse(`${last.day}T00:00:00Z`)+86400_000-Date.parse(last.at);
  const writtenPerHour=(last.rowsWritten-first.rowsWritten)*3600_000/elapsedMs,readPerHour=(last.rowsRead-first.rowsRead)*3600_000/elapsedMs;
  return {ready:true,windowMinutes:elapsedMs/60_000,writtenPerHour,readPerHour,
    projectedWritesAtReset:last.rowsWritten+writtenPerHour*remainingMs/3600_000,
    projectedReadsAtReset:last.rowsRead+readPerHour*remainingMs/3600_000,
    warning:last.rowsWritten>=70000||last.rowsRead>=3500000||
      (last.rowsWritten>=50000&&last.rowsWritten+writtenPerHour*remainingMs/3600_000>=80000)||
      (last.rowsRead>=2500000&&last.rowsRead+readPerHour*remainingMs/3600_000>=4000000)};
}
export async function readDailyUsage({at=Date.now()}={}) {
  const minutes=Math.max(1,Math.ceil((at-Math.floor(at/86400_000)*86400_000)/60_000));
  const raw=await new Promise((resolve,reject)=>{
    const child=spawn('npx',['wrangler','d1','insights','youth-inn-finder','--time-period',`${minutes}m`,'--sort-by','writes','--limit','1000','--json'],{stdio:['ignore','pipe','pipe']});
    let output='',bytes=0;const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Analytics request timed out'));},30000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){child.kill('SIGTERM');return;}output+=chunk;});
    child.stderr.on('data',()=>{});child.on('error',()=>{clearTimeout(timer);reject(new Error('Official CLI unavailable'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||bytes>4*1024*1024)reject(new Error('Analytics unavailable'));else resolve(output);});
  });
  let queries;try{queries=JSON.parse(raw);}catch{throw new Error('Analytics returned invalid JSON');}
  if(Math.floor(Date.now()/86400_000)!==Math.floor(at/86400_000))throw new Error('Analytics window crossed the UTC reset');
  return summarizeInsights(queries,Date.now());
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const snapshot=await readDailyUsage(),file=process.argv[2];let samples=[];
    if(file) {try {samples=(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
      await appendFile(file,JSON.stringify(snapshot)+'\n',{mode:0o600});}
    console.log(JSON.stringify({snapshot,forecast:forecastUsage([...samples,snapshot])},null,2));
  }catch{console.error('D1 用量分析暂不可用；不能按零用量处理。');process.exitCode=1;}
}
