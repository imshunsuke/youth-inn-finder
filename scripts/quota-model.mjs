// Offline workload model: real application SQL and SQLite, fake upstream/mail.
// Row mutations are measured. Index charges are conservative estimates, not D1 billing.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalDatabase } from '../src/development/d1.mjs';
import { createCollector } from '../src/application/collector.mjs';
import { createMonitor } from '../src/application/monitor.mjs';
import { createQueryService } from '../src/application/query-service.mjs';
import { createSnapshotStore, createSnapshotClient } from '../src/infrastructure/snapshot-store.mjs';
import { createApp } from '../src/http/app.mjs';
import { createQueryResponseCache } from '../src/infrastructure/query-response-cache.mjs';
import { collectInteractiveIntervals } from '../src/application/interactive-collector.mjs';
import { COLLECTION_POLICY } from '../src/application/collection-policy.mjs';
import { addDays } from '../src/domain/dates.mjs';

export function assignedColumns(sql) {
  const start=/\bSET\b/i.exec(sql); if(!start)return new Set();
  let depth=0,quote=null,part='',parts=[];
  for(let i=start.index+3;i<sql.length;i++) {
    const c=sql[i];
    if(quote) {part+=c;if(c===quote) {if(sql[i+1]===quote)part+=sql[++i];else quote=null;}continue;}
    if(c==="'"||c==='"'||c==='`'){quote=c;part+=c;continue;}
    if(c==='(')depth++;if(c===')')depth--;
    if(depth===0&&/^(?:WHERE|RETURNING)\b/i.test(sql.slice(i))){break;}
    if(depth===0&&c===','){parts.push(part);part='';}else part+=c;
  }
  parts.push(part);
  return new Set(parts.map(x=>/^\s*([a-z_]+)\s*=/i.exec(x)?.[1]?.toLowerCase()).filter(Boolean));
}

export async function installWriteAudit(db) {
  const tables=(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).results;
  await db.exec('CREATE TEMP TABLE quota_audit (table_name TEXT,operation TEXT,mutations INTEGER,conservative_writes INTEGER,PRIMARY KEY(table_name,operation))');
  await db.exec('CREATE TEMP TABLE quota_statement (weight INTEGER); INSERT INTO quota_statement VALUES(1)');
  const indexedColumns=new Map();
  for(const {name} of tables) {
    if(!/^[a-z_]+$/.test(name)) throw new Error('Unexpected fixture table');
    const indexes=(await db.prepare(`PRAGMA index_list(${name})`).all()).results;
    const columns=[];
    for(const index of indexes) {
      if(index.partial||!/^[a-zA-Z0-9_]+$/.test(index.name))throw new Error('Unsupported fixture index');
      const fields=(await db.prepare(`PRAGMA index_info(${index.name})`).all()).results.map(x=>x.name);
      if(fields.some(x=>!x))throw new Error('Expression indexes require a separate charge model');
      columns.push(fields);
    }
    indexedColumns.set(name,columns);
    for(const operation of ['INSERT','UPDATE','DELETE']) {
      // Charge both removal and insertion for every index assigned by UPDATE,
      // even if the assigned value happens to be unchanged. SQL bindings stay private.
      const weight=operation==='UPDATE'?'(SELECT weight FROM quota_statement)':1+indexes.length;
      await db.exec(`CREATE TEMP TRIGGER quota_${name}_${operation} AFTER ${operation} ON ${name} BEGIN
        INSERT INTO quota_audit VALUES('${name}','${operation}',1,${weight}) ON CONFLICT(table_name,operation)
        DO UPDATE SET mutations=mutations+1,conservative_writes=conservative_writes+${weight}; END`);
    }
  }
  const wrap=(statement)=>{
    const table=/^(?:UPDATE|INSERT INTO|DELETE FROM)\s+([a-z_]+)/i.exec(statement.sql)?.[1];
    const changed=assignedColumns(statement.sql),affected=(indexedColumns.get(table)||[]).filter(fields=>fields.some(field=>changed.has(field))).length;
    const enter=()=>db.prepare('UPDATE quota_statement SET weight=?').bind(1+2*affected).execute();
    return {sql:statement.sql,bind:(...values)=>wrap(statement.bind(...values)),execute(){enter();return statement.execute();},
      async all(){return this.execute();},async run(){return this.execute();},
      async first(column){enter();return statement.first(column);},async raw(options){enter();return statement.raw(options);}};
  };
  return {db:{prepare:sql=>wrap(db.prepare(sql)),batch:statements=>db.batch(statements)},
    read:async()=> (await db.prepare('SELECT * FROM quota_audit ORDER BY table_name,operation').all()).results};
}

export async function modelDay({users=0,reminders=10,days=1,upstreamFails=false}={}) {
  if(!Number.isInteger(users)||users<0||users>500||!Number.isInteger(reminders)||reminders<0||reminders>10||!Number.isInteger(days)||days<1||days>2) throw new Error('Invalid fixture size');
  const baseDb=createLocalDatabase();let db=baseDb;
  try {
    const migrations=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(x=>x.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,migrations),'utf8'));
    const initial=Date.parse('2026-10-14T00:00:00Z'); let at=initial;
    const clock=()=>new Date(at),stats={catalogFetches:0,calendarFetches:0,intervalFetches:0,queries:0,pumps:0,checked:0,fakeMail:0,completed:0,abandoned:0,httpErrors:0};
    const items=Array.from({length:90},(_,i)=>({id:String(i).padStart(3,'0'),name:`Fixture ${i}`,isOnShelf:true,district:'浦东新区'}));
    const fakeFetch=async(url,options={})=> {
      if(options.method==='POST')stats.intervalFetches++;
      else if(String(url).includes('housList'))stats.catalogFetches++;
      else stats.calendarFetches++;
      if(upstreamFails&&options.method==='POST')throw new Error('fixture upstream unavailable');
      return Response.json({success:true,data:options.method==='POST'?{idleCnt:1}:String(url).includes('housList')?items:
        Array.from({length:90},(_,i)=>({applyDate:addDays('2026-10-14',i),applyNumber:1}))});
    };
    const env={DB:db,APP_SECRET:'offline-fixture-secret-at-least-32-bytes',BREVO_API_KEY:'fake-offline-key',MAIL_FROM:'fixture@example.test',PUBLIC_URL:'https://fixture.example.test'};
    for(let i=0;i<reminders;i++) {
      const conditions={date:'2026-11-20',endDate:'2026-11-22',stationId:items[i].id,houseType:'0',onlyOnShelf:true,minCount:1};
      await db.prepare('INSERT INTO reminders(id,email,conditions_json,status,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .bind(`fixture-${i}`,`fixture-${Math.floor(i/2)}@example.test`,JSON.stringify(conditions),'active',clock().toISOString(),clock().toISOString(),clock().toISOString()).run();
    }
    const audited=await installWriteAudit(db);db=audited.db;const audit=audited.read;
    const collector=createCollector({db,clock,fetchImpl:fakeFetch,...COLLECTION_POLICY,leaseWaitMs:0});
    const app=createApp({env,clock,interactiveCollection:true,collectIntervals:(options)=>collectInteractiveIntervals({...options,clock,fetchImpl:fakeFetch}),queryCache:createQueryResponseCache({clock:()=>at})});
    const active=[],daily=[];
    for(let second=0;second<days*86400;second+=10) {
      at=initial+second*1000;
      if(second%60===0) {
        await collector.run();
        if(second%120===0) {
          const monitor=createMonitor({db,env,clock,queryService:createQueryService({client:createSnapshotClient({db,clock}),clock}),mail:{send:async()=>{stats.fakeMail++;}}});
          const report=await monitor.run({limit:3,sendLimit:2,cleanup:false});stats.checked+=report.checked??0;
        }
      }
      const sessions=users*2;
      for(let i=0;i<sessions;i++) {
        const start=60+Math.floor(i*85000/Math.max(1,sessions)/10)*10;
        if(second%86400!==start)continue;
        const date=addDays('2026-10-14',2+i%60),endDate=addDays(date,1+Math.floor(i/60)%29);
        active.push({date,endDate,started:at,user:Math.floor(i/2),warm:true});
      }
      for(let i=active.length-1;i>=0;i--) {
        const session=active[i];
        if(at-session.started>=600000) { active.splice(i,1);stats.abandoned++;continue; }
        const query=new URLSearchParams({date:session.date,endDate:session.endDate,onlyOnShelf:'true',limit:'200',includeOfficialDetails:'false',preview:'true',warm:String(session.warm)});
        session.warm=false;stats.queries++;
        const response=await app(new Request(`https://fixture.example.test/api/available?${query}`,{headers:{'CF-Connecting-IP':`fixture-user-${session.user}`}}));
        const payload=await response.json();
        if(response.status!==200)stats.httpErrors++;
        if(payload.meta?.pending) {
          stats.pumps++;
          const pump=await app(new Request('https://fixture.example.test/api/collection',{method:'POST',headers:{'CF-Connecting-IP':`fixture-user-${session.user}`}}));
          if(pump.status!==200)stats.httpErrors++;
        } else if(payload.meta?.snapshotCoverage?.freshStations===90) { active.splice(i,1);stats.completed++; }
      }
      if(second%86400===86390) {
        await db.prepare('DELETE FROM http_rate_limits WHERE expires_at<?').bind(at).run();
        daily.push({day:daily.length+1,audit:await audit(),stats:{...stats}});
      }
    }
    const rows=await audit();
    return {mode:'offline measured table mutations plus conservative index charge model',users,reminders,days,upstreamFails,
      assumptions:'90 stations; up to ten single-station reminders; two distinct full-city cold stays per user/day; polls every 10 seconds for at most 10 minutes; no real network or mail; assigned indexes charged twice on UPDATE',
      rowMutations:rows.reduce((n,x)=>n+x.mutations,0),conservativeWrites:rows.reduce((n,x)=>n+x.conservative_writes,0),stats,byTable:rows,daily};
  } finally {baseDb.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const users=(process.argv[2]??'0,5,10,25').split(',').map(Number),results=[];
  for(const count of users) {const report=await modelDay({users:count});results.push(report);console.log(JSON.stringify({users:count,mutations:report.rowMutations,conservativeWrites:report.conservativeWrites,...report.stats}));}
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(results,null,2));
}
