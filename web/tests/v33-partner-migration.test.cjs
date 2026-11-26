'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,readFileSync,readdirSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const core=require('../shared/core.cjs');
const {openStore}=require('../server/storage.cjs');
const {repository}=require('../server/repository.cjs');

test('V3.3 task migration preserves HQ originals and reopens SQLite with the actual customer actions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jiuying-partner-tasks-')),file=join(dir,'fixture.db');
 const db=new DatabaseSync(file),migrationDir=join(__dirname,'../database');
 const at='2026-11-18T01:00:00.000Z',now='2026-11-18T04:00:00.000Z';
 const state=core.createState(),outlet=state.outlets.find(row=>row.id==='cs'),bill=state.bills.find(row=>row.outlet===outlet.id);
 const scope={owner:outlet.owner,outlet:outlet.id,createdAt:at};
 const reportTask={id:'task-old-report',...scope,month:'2026-10',status:'in_progress',queue:'ops',role:'ops',assigneeRole:'ops',assigneeType:'role',kind:'report_missing',businessType:'outlets',businessId:outlet.id,recordId:null,responsibilityKey:JSON.stringify(['report_missing',outlet.id,'2026-10']),taskKey:'report_missing|cs|2026-10|',target:'reports'};
 const billTask={id:'task-old-bill',...scope,month:bill.month,status:'open',queue:null,role:'finance',assigneeRole:'finance',assigneeType:'role',kind:'bill_unpaid',businessType:'bills',businessId:bill.id,recordId:bill.id,taskKey:'bill_unpaid|'+bill.id+'|',target:'fees'};
 const overdue={...billTask,id:'task-old-overdue',kind:'bill_overdue',queue:'hq',dueOn:'2026-11-01',taskKey:'bill_overdue|cs|'+bill.month+'|'+bill.id,responsibilityKey:JSON.stringify(['bills',bill.id])};
 const message={id:'msg-old-report',...scope,status:'unread',read:false,taskId:reportTask.id,recordId:reportTask.id,title:'上月月报待报送',target:'reports'};
 const ticket={id:'ticket-old',...scope,status:'waiting',messages:[{actor:'support',text:'只供本人查看的请补材料消息',at}],assignee:'support',category:'exception'};
 const replied={...ticket,id:'ticket-old-replied',status:'active'};
 const waiting={...billTask,month:null,id:'task-old-waiting',kind:'support_waiting',role:'partner',assigneeRole:'partner',businessType:'supportTickets',businessId:ticket.id,recordId:ticket.id,target:'support',taskKey:'support_waiting|'+ticket.id+'|'};
 const obsolete={...waiting,id:'task-old-obsolete',kind:'support_reply',taskKey:'support_reply|'+ticket.id+'|1',replySequence:1};
 try{
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of readdirSync(migrationDir).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&Number(name.slice(0,3))<21).sort()){
   db.exec(readFileSync(join(migrationDir,name),'utf8'));
   db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(name.slice(0,3)),name.slice(0,-4),at);
  }
  for(const key of ['schemaVersion','today','mode','grants','supportSettings'])db.prepare('INSERT INTO settings VALUES(?,?)').run(key,JSON.stringify(state[key]));
  for(const [table,row] of [['outlets',outlet],['accounts',state.accounts.find(row=>row.owner===outlet.owner)],['bills',{...bill,dueOn:'2026-11-01'}],['messages',message],['supportTickets',ticket],['supportTickets',replied],...([reportTask,billTask,overdue,waiting,obsolete].map(row=>['businessTasks',row]))])
   db.prepare(`INSERT INTO ${table}(id,owner,outlet,status,month,amount_cents,data,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(row.id,row.owner,row.outlet||null,row.status,row.month||null,row.amount?Math.round(row.amount*100):null,JSON.stringify(row),row.createdAt);
  db.close();
  let originalIds;
  for(let attempt=0;attempt<2;attempt++){
   const store=openStore(file,{seed:false});
   try{
    const repo=repository(store,{today:()=>now.slice(0,10)}),owner={actor:'partnerA',subject:'partnerA',now},other={actor:'partnerB',subject:'partnerB',now},manager={actor:'manager',subject:'manager',now};
    const rows=repo.taskList(owner,{queue:'partner'}).items;
    assert.deepEqual(rows.map(row=>row.kind).sort(),['bill_unpaid','report_missing','support_reply','support_waiting']);
    assert.deepEqual(rows.map(row=>row.id),originalIds||rows.map(row=>row.id));
    originalIds=rows.map(row=>row.id);
    const report=rows.find(row=>row.kind==='report_missing');
    assert.notEqual(report.id,reportTask.id);
    assert.equal(report.status,'open');
    assert.equal(repo.taskDetail(manager,reportTask.id).status,'in_progress');
    assert.equal(repo.taskDetail(manager,overdue.id).status,'open');
    assert.equal(repo.list('messages',owner).items[0].taskId,report.id);
    assert.equal(repo.list('messages',owner).items[0].month,report.month);
    assert.equal(repo.taskDetail(owner,billTask.id).amount,bill.amount);
    assert.equal(repo.taskDetail(owner,waiting.id).status,'open');
    assert.throws(()=>repo.taskDetail(owner,obsolete.id),{code:'NOT_FOUND'});
    assert.equal(repo.taskList(other,{queue:'partner'}).total,0);
    assert.equal(store.db.prepare('SELECT data FROM businessTasks WHERE id=?').get(reportTask.id).data,JSON.stringify(reportTask));
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   }finally{store.close();}
  }
 }finally{
  if(db.isOpen)db.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
