import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeDisplay} from '../scripts/display-evidence.mjs';
const valid=()=>({firstVisitMs:500,records:Array.from({length:20},(_,i)=>({label:i<3?'cold interval '+i:'day '+i,kind:i<3?'interval':'day',ms:25,state:'candidates',cards:20,badges:['连续入住待确认']}))});
test('one-second acceptance rejects spinners, missing cold coverage, missing timings and even a single late paint',()=>{
  assert.equal(summarizeDisplay(valid()).status,'PASS');
  for(const change of [x=>{x.firstVisitMs=1001;},x=>{x.records[5].ms=1000.01;},x=>{x.records[6].cards=0;},x=>{x.records[0].state='loading';},x=>{x.records[1].badges=['已确认 9 间'];},x=>{x.records.pop();}]) {
    const input=valid();change(input);assert.equal(summarizeDisplay(input).status,'FAIL');
  }
  const empty=valid();empty.records[3]={...empty.records[3],cards:0,badges:[],state:'open',emptyTitle:'暂无匹配房源'};assert.equal(summarizeDisplay(empty).status,'PASS');
});
