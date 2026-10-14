// Bounded, read-only-site observation. No invitations, reminder changes or mail.
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {safeTrace} from './acceptance.mjs';
import {readDailyUsage} from './d1-usage-report.mjs';
const origin='https://youth-inn-finder.imshunsukez.workers.dev';
const minutes=Number(process.argv[2]??20),root=resolve(process.argv[3]??'.data/d1-profile');
if(!Number.isInteger(minutes)||minutes<20||minutes>40)throw new Error('Use a 20–40 minute observation');
await mkdir(root,{recursive:true});
await writeFile(root+'/runtime.jsonl','',{flag:'wx'});
const health=await fetch(origin+'/api/health'),version=health.headers.get('x-deployment-id');
if(health.status!==200||!version)throw new Error('Deployment unavailable');
const metadata={startedAt:new Date().toISOString(),minutes,version,gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mode:'idle background; one health probe/minute; no cold queries'};
await writeFile(root+'/metadata.json',JSON.stringify(metadata,null,2));
let child,buffer='',stopped=false,lastTrace=0;const traces=[],pending=new Set();
const stop=()=>{stopped=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
async function stopTail() {
  if(!child)return;const previous=child;child=null;
  const closed=new Promise(resolve=>previous.once('close',resolve));
  try{process.kill(-previous.pid,'SIGTERM');}catch{}
  let timer;await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>{try{process.kill(-previous.pid,'SIGKILL');}catch{}resolve();},5000);})]);clearTimeout(timer);
}
async function startTail() {
  await stopTail();buffer='';lastTrace=Date.now();
  child=spawn('npx',['wrangler','tail','youth-inn-finder','--format','json','--version-id',version],{detached:true,stdio:['ignore','pipe','pipe']});
  child.stderr.on('data',()=>{});child.on('error',()=>{stopped=true;});
  child.stdout.on('data',chunk=>{
    buffer+=chunk;while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      if(line==='{') {buffer=line+'\n'+buffer;break;}
      try {const raw=JSON.parse(line),trace=safeTrace(raw);if(trace.deployment!==version)continue;
        traces.push(trace);lastTrace=Date.now();const promise=appendFile(root+'/runtime.jsonl',JSON.stringify(trace)+'\n');pending.add(promise);promise.finally(()=>pending.delete(promise));
      }catch{}
    }
    // Wrangler emits multi-line JSON objects. Extract complete top-level objects
    // with a string-aware scanner; never write unparsed bytes to disk.
    let depth=0,inString=false,escape=false,start=-1;
    for(let i=0;i<buffer.length;i++) {
      const c=buffer[i];if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;continue;}
      if(c==='"'){inString=true;continue;}if(c==='{'){if(depth++===0)start=i;}
      else if(c==='}'&&--depth===0&&start>=0){const object=buffer.slice(start,i+1);buffer=buffer.slice(i+1);i=-1;start=-1;
        try {const trace=safeTrace(JSON.parse(object));if(trace.deployment!==version)continue;traces.push(trace);lastTrace=Date.now();const promise=appendFile(root+'/runtime.jsonl',JSON.stringify(trace)+'\n');pending.add(promise);promise.finally(()=>pending.delete(promise));}catch{}
      }
    }
    if(buffer.length>2*1024*1024){buffer='';stopped=true;}
  });
}
const started=Date.now(),quota=[];await startTail();
try {
  while(!stopped&&Date.now()-started<minutes*60000) {
    const response=await fetch(origin+'/api/health');if(response.status!==200||response.headers.get('x-deployment-id')!==version){stopped=true;break;}
    if(Date.now()-lastTrace>90000)await startTail();
    try {const sample=await readDailyUsage();quota.push(sample);await appendFile(root+'/quota.jsonl',JSON.stringify(sample)+'\n');
      if(!sample.completeQuerySet||sample.rowsWritten>=85000||sample.rowsRead>=4000000){metadata.stoppedForQuota=true;stopped=true;}
    }catch{metadata.analyticsFailures=(metadata.analyticsFailures??0)+1;}
    const d1=traces.filter(x=>x.d1?.complete);console.log(JSON.stringify({minute:Math.floor((Date.now()-started)/60000),traces:traces.length,metered:d1.length,latestQuota:quota.at(-1)?.rowsWritten}));
    for(let n=0;n<12&&!stopped&&Date.now()-started<minutes*60000;n++)await new Promise(resolve=>setTimeout(resolve,5000));
  }
}finally {
  await stopTail();await Promise.all(pending);
  const elapsedMs=Date.now()-started,byPhase={};
  for(const phase of ['collection','monitor','cleanup','fetch']) {
    const samples=traces.filter(x=>x.d1?.phase===phase),complete=samples.filter(x=>x.d1.complete);
    byPhase[phase]={observed:samples.length,complete:complete.length,rowsWritten:complete.reduce((n,x)=>n+x.d1.rowsWritten,0),rowsRead:complete.reduce((n,x)=>n+x.d1.rowsRead,0),cpuOver10ms:samples.filter(x=>x.cpuMs>10).length};
  }
  const times=[started,...traces.map(x=>Number(x.at)).filter(Number.isFinite).sort((a,b)=>a-b),Date.now()];
  const maxGapMs=Math.max(...times.slice(1).map((time,i)=>time-times[i]));
  const report={...metadata,finishedAt:new Date().toISOString(),elapsedMs,maxGapMs,byPhase,
    completeWindow:elapsedMs>=minutes*60000&&!metadata.stoppedForQuota&&maxGapMs<=180000,
    terminations:traces.filter(x=>['exceededCpu','exceededMemory'].includes(x.outcome)).length,
    quotaStart:quota[0],quotaEnd:quota.at(-1)};
  await writeFile(root+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
