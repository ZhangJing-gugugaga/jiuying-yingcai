'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server/index.cjs');
const {runScheduledBatch}=require('../server/scheduler.cjs');

test('scheduler does not reopen an older returned version after a subsequent approved version is revoked',async t=>{
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();});
 const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,{token,body}={}){
  const headers=token?{Authorization:'Bearer '+token}:{};
  if(body){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();}
  const response=await fetch(base+path,{headers,method:body?'POST':'GET',body:body&&JSON.stringify(body)});
  const output=await response.json();assert.equal(response.status,200,JSON.stringify(output));return output.data;
 }
 const login=async actor=>(await request('/api/auth/dev',{body:{actor}})).token;
 const [partner,ops,manager,finance]=await Promise.all(['partnerA','ops','manager','finance'].map(login));
 const command=async(token,name,payload)=>(await request('/api/commands',{token,body:{command:name,payload}})).result;
 const report={outlet:'cs',month:'2026-10',revenue:100,orders:8,traffic:11,enroll:2};
 const returned=await command(partner,'report.submit',report);
 await command(ops,'review.report',{id:returned.id,decision:'return',note:'补充业务说明'});
 const approved=await command(partner,'report.submit',{...report,note:'已按意见补件'});
 await command(ops,'review.report',{id:approved.id,decision:'approve'});
 const revocation=await command(manager,'report.revoke.request',{id:approved.id,reason:'误审批需复核'});
 await command(finance,'review.revoke',{id:revocation.id,decision:'approve'});

 const storedLatest=app.store.db.prepare('SELECT status,current,data FROM reports WHERE id=?').get(approved.id);
 assert.equal(storedLatest.status,'approved');
 assert.equal(storedLatest.current,0);
 assert.equal(JSON.parse(storedLatest.data).revoked,true);
 const taskRows=()=>app.store.db.prepare(`SELECT id,status,data FROM businessTasks
  WHERE json_extract(data,'$.recordId')=? AND json_extract(data,'$.kind')='report_returned' ORDER BY id`).all(returned.id);
 const original=taskRows();
 assert.equal(original.length,1);
 assert.equal(original[0].status,'resolved');
 assert.equal(JSON.parse(original[0].data).assigneeRole,'partner');

 const run=await runScheduledBatch(app.store,{now:'2026-11-18T10:00:00.000Z'});
 assert.ok(run.processed>0);
 assert.deepEqual(taskRows(),original,'scheduled reconciliation must retain just the closed original task');
 const queue=await request('/api/tasks?queue=partner&kind=report_returned',{token:partner});
 assert.equal(queue.total,0);
});
