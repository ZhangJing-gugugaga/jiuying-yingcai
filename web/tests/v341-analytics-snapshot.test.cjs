'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {mkdtempSync,rmSync,rmdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server/index.cjs');
const {openStore}=require('../server/storage.cjs');
const core=require('../shared/core.cjs');

const month='2026-09',outlet='cs';
const initialNote='原结算影像说明';
const query='period='+month+'&outlet='+outlet;

async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'jy-v341-report-'));
 const filename=join(dir,'test.db');
 const app=createServer({dbPath:filename,env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 const writer=openStore(filename);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
  writer.close();
  for(const suffix of ['','-shm','-wal'])rmSync(filename+suffix,{force:true});
  rmdirSync(dir);
 });
 const root='http://127.0.0.1:'+app.server.address().port+'/api/';
 function request(route,token,body){
  const headers={
   ...(token?{Authorization:'Bearer '+token}:{}),
   ...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{}),
  };
  return fetch(root+route,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
 }
 async function json(route,token,body){
  const res=await request(route,token,body);
  const parsed=await res.json();
  assert.equal(res.status,200,JSON.stringify(parsed));
  return parsed.data;
 }
 const login=async actor=>(await json('auth/dev',null,{actor})).token;
 const partner=await login('partnerA'),ops=await login('ops');
 const source=app.store.load();
 const original=source.reports.find(row=>row.outlet===outlet&&row.month===month&&row.current);
 original.note=initialNote;
 app.store.transaction(()=>app.store.save(source));
 const before=await json('dashboard?'+query,partner);
 assert.equal(before.settlementStatus.state,'settled');
 assert.equal(before.totals.revenue,original.revenue);
 const act=(token,command,payload)=>json('commands',token,{command,payload});
 await act(partner,'report.correct',{id:original.id,reason:'收入复核'});
 const correction=(await act(partner,'report.submit',{outlet,month,revenue:246.80,orders:9,traffic:19,enroll:2,note:'本轮更正说明'})).result;
 assert.equal((await act(ops,'review.report',{id:correction.id,decision:'approve'})).result.status,'finance');

 function approveOnSnapshotRead(){
  const db=app.store.db,prepare=db.prepare.bind(db);
  let committed=false;
  db.prepare=sql=>{
   const statement=prepare(sql);
   if(committed||!sql.includes("SELECT month,json_extract(data,'$.reportIds') ids"))return statement;
   return {all(...args){
    const rows=statement.all(...args);
    writer.transaction(()=>{
     const previous=writer.load();
     const result=core.execute(previous,'finance','review.report',{id:correction.id,decision:'approve'},{subject:'finance'});
     assert.equal(result.result.status,'approved');
     writer.save(result.state,{before:previous});
    });
    committed=true;
    return rows;
   }};
  };
  return ()=>assert.ok(committed,'second SQLite connection must commit during the read');
 }
 return {partner,request,json,approveOnSnapshotRead,original};
}

test('dashboard uses one snapshot when another connection approves a correction between reads',async t=>{
 const f=await fixture(t);
 const verifyCommit=f.approveOnSnapshotRead();
 const first=await f.json('dashboard?'+query,f.partner);
 verifyCommit();
 assert.equal(first.totals.revenue,f.original.revenue);
 assert.equal(first.settlementStatus.state,'settled');
 const second=await f.json('dashboard?'+query,f.partner);
 assert.equal(second.settlementStatus.state,'pending_resettlement');
 assert.equal(second.totals.revenue,null);
});

test('official Excel export keeps notes and amounts in the same snapshot during a correction approval',async t=>{
 const f=await fixture(t);
 const verifyCommit=f.approveOnSnapshotRead();
 const first=await f.request('export?format=xlsx&'+query,f.partner);
 verifyCommit();
 assert.equal(first.status,200);
 const firstWorkbook=Buffer.from(await first.arrayBuffer()).toString('utf8');
 assert.ok(firstWorkbook.includes('<c r="B4" t="n"><v>'+f.original.revenue+'</v>'),'old month amount remains in the export');
 assert.ok(firstWorkbook.includes(initialNote));
 assert.ok(!firstWorkbook.includes('经营数据更新中'));
 const second=await f.request('export?format=xlsx&'+query,f.partner);
 assert.equal(second.status,200);
 const secondWorkbook=Buffer.from(await second.arrayBuffer()).toString('utf8');
 assert.ok(!secondWorkbook.includes(initialNote));
 assert.ok(secondWorkbook.includes('经营数据更新中'));
 assert.match(secondWorkbook,/缺失 \/ 不适用/);
});
