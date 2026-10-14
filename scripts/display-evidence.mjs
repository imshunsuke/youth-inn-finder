import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Input comes from real browser DOM observations, not the query service timer.
// Empty placeholders, HTTP 200s and an isolated cache-hit benchmark do not pass.
export function summarizeDisplay(evidence) {
  const records=evidence?.records || [], gates=[];
  if(records.length<20) gates.push('TWENTY_INTERACTIONS_REQUIRED');
  if(!Number.isFinite(evidence?.firstVisitMs) || evidence.firstVisitMs>1000 || evidence.firstVisitMs<0) gates.push('FIRST_VISIT_OVER_ONE_SECOND');
  if(!records.some(x=>x.kind==='day') || records.filter(x=>x.label?.startsWith('cold interval')).length<3) gates.push('DAY_AND_THREE_COLD_RANGES_REQUIRED');
  for(const [i,row] of records.entries()) {
    if(!Number.isFinite(row.ms) || row.ms<0 || row.ms>1000) gates.push(`PAINT_OVER_ONE_SECOND:${i}`);
    if(!['candidates','confirmed','open','not-open'].includes(row.state)) gates.push(`NO_USEFUL_RESULT:${i}`);
    if(!Number.isInteger(row.cards) || row.cards<0 || row.cards===0 && !['暂无匹配房源','尚未开放申请'].includes(row.emptyTitle)) gates.push(`PLACEHOLDER_IS_NOT_A_RESULT:${i}`);
    if(row.label?.startsWith('cold interval') && (!row.cards || !row.badges?.some(x=>x.includes('待确认')))) gates.push(`COLD_CANDIDATES_NOT_PROVEN:${i}`);
  }
  const times=records.map(x=>x.ms).filter(Number.isFinite).sort((a,b)=>a-b);
  return {status:gates.length?'FAIL':'PASS',gates,interactions:records.length,firstVisitMs:evidence?.firstVisitMs,
    maximumMs:times.at(-1),p95Ms:times[Math.ceil(times.length*.95)-1]};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=summarizeDisplay(JSON.parse(await readFile(process.argv[2],'utf8')));
  console.log(JSON.stringify(report,null,2)); if(report.status!=='PASS') process.exitCode=1;
}
