'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {mkdtempSync,readFileSync,readdirSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const core=require('../shared/core.cjs');
const agency=require('../shared/agency.cjs');
const {openStore}=require('../server/storage.cjs');
const {repository}=require('../server/repository.cjs');
const {createServer}=require('../server/index.cjs');

const NOW='2026-11-18T04:00:00.000Z';

function apply(store,actor,command,payload,{today='2026-11-18',now=NOW}={}){
 const output=core.execute(store.load(),actor,command,payload,{subject:actor,today,now});
 store.transaction(()=>store.save(output.state));
 return output.result;
}
function session(actor){return {actor,subject:actor,now:NOW,today:'2026-11-18'};}

test('AGT-01 forward migration keeps legacy subjects without inferring a level and reopens twice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jiuying-agency-migration-')),file=join(dir,'legacy.db');
 const db=new DatabaseSync(file),migrationDir=join(__dirname,'../database'),at='2026-11-17T00:00:00.000Z';
 const base=core.createState();
 try{
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of readdirSync(migrationDir).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&Number(name.slice(0,3))<33).sort()){
   db.exec(readFileSync(join(migrationDir,name),'utf8'));
   db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(name.slice(0,3)),name.slice(0,-4),at);
  }
  for(const key of ['schemaVersion','today','mode','grants','supportSettings'])db.prepare('INSERT INTO settings VALUES(?,?)').run(key,JSON.stringify(base[key]));
  for(const [table,rows] of [['outlets',base.outlets],['accounts',base.accounts],['organizations',base.organizations],['reports',base.reports],['bills',base.bills],['exemptions',[]],['drafts',[]],['messages',base.messages],['policies',[]]]){
   const stmt=db.prepare(`INSERT INTO ${table}(id,owner,outlet,status,month,version,current,amount_cents,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
   for(const row of rows)stmt.run(row.id,row.owner||null,row.outlet||null,row.status||'active',row.month||null,row.version||null,row.current?1:0,row.amount==null?null:Math.round(row.amount*100),JSON.stringify(row),row.createdAt||at);
  }
  db.close();
  for(let attempt=0;attempt<2;attempt++){
   const store=openStore(file,{seed:false});
   try{
    const migrations=store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row=>row.version);
    assert.ok(migrations.includes(33));
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const orgs=store.db.prepare('SELECT data FROM organizations').all().map(row=>JSON.parse(row.data));
    assert.equal(orgs.length,2);
    assert.ok(orgs.every(org=>!Object.hasOwn(org,'level')));
    const repo=repository(store,{today:()=>'2026-11-18'});
    // 旧主体仍可读取本主体月报，不被推断为一级。
    assert.ok(repo.list('reports',session('partnerA')).total>0);
    assert.throws(()=>repo.agencyProgress(session('partnerA'),{month:'2026-10'}),{code:'FORBIDDEN'});
    assert.equal(store.settings().schemaVersion,3);
   }finally{store.close();}
  }
 }finally{
  if(db.isOpen)db.close();
  rmSync(dir,{recursive:true,force:true});
 }
});

test('AGT-01 two primaries keep direct-child scopes, rebind and unbind revoke the old path immediately',()=>{
 const store=openStore(':memory:');
 try{
  const created=apply(store,'manager','account.create',{name:'丙一级',managerName:'负责人丙',mobile:'13800000003'});
  const primaryC=created.owner;
  const created2=apply(store,'manager','account.create',{name:'丁二级',managerName:'负责人丁',mobile:'13800000004'});
  const secondaryD=created2.owner;
  apply(store,'manager','agency.level',{owner:'p1',level:1,reason:'总部确认一级代理'});
  apply(store,'manager','agency.level',{owner:primaryC,level:1,reason:'总部确认一级代理'});
  apply(store,'manager','agency.level',{owner:'p2',level:2,reason:'总部确认二级代理'});
  apply(store,'manager','agency.level',{owner:secondaryD,level:2,reason:'总部确认二级代理'});
const first=apply(store,'manager','agency.bind',{parentOwner:'p1',childOwner:'p2',reason:'直属绑定'});
 apply(store,'manager','agency.bind',{parentOwner:primaryC,childOwner:secondaryD,reason:'直属绑定'});
 const batch=apply(store,'manager','import.preview',{kind:'outlets',rows:[{owner:secondaryD,name:'丁示范网点',province:'湖南',city:'长沙',district:'示范区',address:'长沙市丁路1号',phone:'000-00000001',opening:'2026-01-01',status:'open',enrollmentApplicable:true}],reason:'隔离测试建档'});
 assert.equal(batch.errorCount,0);
 apply(store,'manager','import.commit',{id:batch.id});
  const repo=repository(store,{today:()=>'2026-11-18'});

  let a=repo.agencyProgress(session('partnerA'),{month:'2026-10'});
  assert.equal(a.summary.children,1);
  assert.deepEqual(a.children.map(child=>child.childOwner),['p2']);
  assert.ok(a.children[0].outlets.every(row=>row.outlet==='gz'));
  let c=repo.agencyProgress(session('partner:'+primaryC),{month:'2026-10'});
  assert.deepEqual(c.children.map(child=>child.childOwner),[secondaryD]);
  assert.equal(c.children[0].outlets.length,1);
  assert.throws(()=>repo.agencyProgress(session('partnerB'),{month:'2026-10'}),{code:'FORBIDDEN'});

  assert.throws(()=>apply(store,'manager','agency.bind',{parentOwner:'p1',childOwner:'p2',reason:'重复绑定'}),{code:'DUPLICATE'});
  assert.throws(()=>apply(store,'manager','agency.bind',{parentOwner:'p1',childOwner:primaryC,reason:'级别不符'}),{code:'INPUT'});
  assert.throws(()=>apply(store,'manager','agency.bind',{parentOwner:'p1',childOwner:'p1',reason:'自身绑定'}),{code:'INPUT'});
  assert.throws(()=>apply(store,'manager','agency.level',{owner:'p1',level:2,reason:'仍有下级'}),{code:'CONFLICT'});
  assert.throws(()=>apply(store,'manager','agency.level',{owner:'p2',level:1,reason:'仍绑定上级'}),{code:'CONFLICT'});

  // 换绑到另一家一级：原子撤销旧关系，旧一级立即失去查询和催报权限。
  const rebound=apply(store,'manager','agency.bind',{parentOwner:primaryC,childOwner:'p2',replaceActive:true,reason:'代理关系调整'});
  assert.equal(rebound.parentOwner,primaryC);
  assert.equal(repo.agencyProgress(session('partnerA'),{month:'2026-10'}).summary.children,0);
  c=repo.agencyProgress(session('partner:'+primaryC),{month:'2026-10'});
  assert.deepEqual(c.children.map(child=>child.childOwner).sort(),['p2',secondaryD].sort());
  assert.throws(()=>apply(store,'partnerA','agency.urge',{childOwner:'p2',month:'2026-10'}),{code:'FORBIDDEN'});
  const relations=store.load().agencyRelations;
  assert.equal(relations.filter(row=>row.childOwner==='p2'&&row.status==='active').length,1);
  const revoked=relations.find(row=>row.id===first.id);
  assert.equal(revoked.status,'revoked');
  assert.equal(revoked.revokedReason,'代理关系调整');
  assert.equal(revoked.trail.at(-1).action,'revoked_by_rebind');

  apply(store,'manager','agency.unbind',{id:rebound.id,reason:'终止直属关系'});
  c=repo.agencyProgress(session('partner:'+primaryC),{month:'2026-10'});
  assert.deepEqual(c.children.map(child=>child.childOwner),[secondaryD]);
  assert.throws(()=>apply(store,'manager','agency.unbind',{id:rebound.id,reason:'重复解绑'}),{code:'TRANSITION'});
  assert.throws(()=>apply(store,'manager','agency.level',{owner:'p2',level:2,reason:'级别未变化'}),{code:'UNCHANGED'});

  const audit=store.load().audit;
  for(const command of ['agency.level','agency.bind','agency.unbind'])assert.ok(audit.some(row=>row.command===command),command+' audit missing');
  const org=JSON.parse(store.db.prepare("SELECT data FROM organizations WHERE id='p1'").get().data);
  assert.equal(org.level,1);
  assert.equal(org.levelHistory.length,1);
  assert.ok(org.levelHistory[0].reason.length>0);
 }finally{store.close();}
});

test('AGT-01 progress reports only reporting state for direct children across all reporting states',()=>{
 const s=core.createState();
 s.organizations.find(org=>org.id==='p1').level=1;
 s.organizations.find(org=>org.id==='p2').level=2;
 s.agencyRelations=[{id:'agency-fixture',owner:'p2',outlet:null,status:'active',parentOwner:'p1',childOwner:'p2',level:2,effectiveAt:'2026-01-01',createdAt:'2026-01-01T00:00:00.000Z',trail:[]}];
 const base=s.outlets.find(outlet=>outlet.id==='gz');
 const make=(id,name)=>({...JSON.parse(JSON.stringify(base)),id,outlet:id,name});
 s.outlets=['gz','gz2','gz3','gz4','gz5','gz6','gz7'].map((id,index)=>index===0?base:make(id,'二级网点'+(index+1)));
 const report=(outlet,status,overrides={})=>({id:'rpt-'+outlet,owner:'p2',outlet,status,month:'2026-10',version:1,current:status==='approved',revenue:100,orders:1,traffic:1,enroll:1,trail:[],createdAt:'2026-11-01T00:00:00.000Z',...overrides});
 s.reports=[report('gz','pending'),report('gz2','returned',{current:false,reviewNote:'请补充订单说明'}),report('gz3','approved')];
 s.drafts=[{id:'draft-gz7',owner:'p2',outlet:'gz7',month:'2026-10',status:'draft',revenue:10,orders:1,traffic:1,enroll:1,createdAt:'2026-11-01T00:00:00.000Z'}];
 s.exemptions=[{id:'exempt-gz5',owner:'p2',outlet:'gz5',month:'2026-10',status:'approved'}];
 s.outlets.find(outlet=>outlet.id==='gz6').events=[{date:'2025-01-01',status:'preparing',actor:'manager',reason:'尚未营业'}];
 s.outlets.find(outlet=>outlet.id==='gz6').status='preparing';
 const result=agency.progress(s,'partnerA',{month:'2026-10'},'2026-11-18');
 assert.equal(result.children.length,1);
 const statuses=Object.fromEntries(result.children[0].outlets.map(row=>[row.outlet,row.status]));
 assert.equal(statuses.gz,'pending');
 assert.equal(statuses.gz2,'returned');
 assert.equal(statuses.gz3,'approved');
 assert.equal(statuses.gz4,'overdue');
 assert.equal(statuses.gz5,'exempt');
 assert.equal(statuses.gz6,'not_required');
 assert.equal(statuses.gz7,'draft');
 assert.ok(result.children[0].outlets.every(row=>!Object.hasOwn(row,'revenue')&&!Object.hasOwn(row,'reportId')));
 assert.equal(result.summary.actionable,3);
 assert.equal(result.summary.approved,1);
 assert.equal(result.summary.notApplicable,2);
 assert.equal(result.children[0].outlets.find(row=>row.outlet==='gz2').returnNote,'请补充订单说明');
});

async function withServer(run){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api`;
 async function request(path,token,body,headers={}){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const payload=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,...(!Buffer.isBuffer(payload)?payload:{bytes:payload})};
 }
 async function data(path,token,body,status=200){const response=await request(path,token,body);assert.equal(response.status,status,JSON.stringify(response.error));return response.data;}
 async function login(actor){return (await data('/auth/dev',null,{actor})).token;}
 try{await run({app,request,data,login});}
 finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();}
}

test('AGT-01/02 progress and urge are server-authorized while detail, attachment, export and writes stay closed',async()=>{
 await withServer(async({app,request,data,login})=>{
  const manager=await login('manager');
  await data('/commands',manager,{command:'agency.level',payload:{owner:'p1',level:1,reason:'一级代理'}});
  await data('/commands',manager,{command:'agency.level',payload:{owner:'p2',level:2,reason:'二级代理'}});
  const bound=await data('/commands',manager,{command:'agency.bind',payload:{parentOwner:'p1',childOwner:'p2',reason:'直属绑定'}});
  assert.equal(bound.result.childOwner,'p2');
  const primary=await login('partnerA'),secondary=await login('partnerB');
  const context=await data('/context',primary);
  assert.deepEqual(context.agency,{level:1,isPrimary:true,parentOwner:null,childCount:1});

  const progress=await data('/agency/progress?month=2026-10',primary);
  assert.equal(progress.month,'2026-10');
  assert.equal(progress.summary.children,1);
  assert.equal(progress.summary.overdue,1);
  assert.ok(progress.children[0].outlets.every(row=>!Object.hasOwn(row,'revenue')&&!Object.hasOwn(row,'reportId')));
  assert.equal((await request('/agency/progress?month=2026-10',secondary)).status,403);
  assert.equal((await request('/agency/progress?month=2026-10',manager)).status,403);

  // 二级已有其他月份待审原单和总部待办时，催报仍须成功且不能重复生成责任待办
  await data('/commands',secondary,{command:'report.submit',payload:{outlet:'gz',month:'2026-07',revenue:800,orders:8,traffic:30,enroll:1,note:'历史待审原单'}});
  const urged=await data('/commands',primary,{command:'agency.urge',payload:{childOwner:'p2',month:'2026-10'}});
  assert.equal(urged.result.agencyUrgeSummary.outletCount,1);
  const openTasks=await data('/tasks?queue=ops&status=open',manager);
  assert.equal(openTasks.items.filter(row=>row.kind==='report_review'&&row.month==='2026-07').length,1);
  assert.equal((await request('/commands',primary,{command:'agency.urge',payload:{childOwner:'p2',month:'2026-10'}})).status,409);
  const notices=await data('/collections/messages',secondary);
  const notice=notices.items.find(row=>row.agencyUrge);
  assert.ok(notice);
  assert.equal(notice.target,'reports');
  assert.equal(notice.outlet,'gz');
  assert.equal(notice.month,'2026-10');
  assert.equal(notice.recordId,'gz');

  const reportContext=await data('/reports/context?outlet=gz&month=2026-10',secondary);
  assert.equal(reportContext.eligibility.canEdit,true);
  const submitted=await data('/commands',secondary,{command:'report.submit',payload:{outlet:'gz',month:'2026-10',revenue:1200,orders:9,traffic:30,enroll:2,note:'收到一级催报后报送'}});
  assert.equal(submitted.result.status,'pending');

  assert.equal((await request('/reports/context?outlet=gz&month=2026-10',primary)).status,403);
  assert.equal((await request('/collections/reports/'+submitted.result.id,primary)).status,404);
  const childReports=await data('/collections/reports?outlet=gz&limit=10',primary);
  assert.equal(childReports.total,0);
  assert.equal(childReports.items.length,0);
  const ownReports=await data('/collections/reports?limit=50',primary);
  assert.ok(ownReports.total>0);
  assert.ok(ownReports.items.every(row=>row.owner==='p1'));
  assert.equal((await request('/commands',primary,{command:'report.draft',payload:{outlet:'gz',month:'2026-11',revenue:1,orders:1,traffic:1,enroll:1}})).status,403);
  assert.equal((await request('/export?format=csv&outlet=gz',primary)).status,403);
  app.store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run('file-'+randomUUID(),'partnerB','p2','二级附件.png','image/png',1,'x',Buffer.from('x'),NOW);
  const fileId=app.store.db.prepare("SELECT id FROM files WHERE owner='p2' LIMIT 1").get().id;
  assert.equal((await request('/files/'+fileId,primary)).status,403);

  // 换绑后旧一级不再看到该下级，催报被拒绝；新一级可查。
  const other=await data('/commands',manager,{command:'account.create',payload:{name:'丙一级',managerName:'负责人丙',mobile:'13800000003'}});
  await data('/commands',manager,{command:'agency.level',payload:{owner:other.result.owner,level:1,reason:'一级代理'}});
  await data('/commands',manager,{command:'agency.bind',payload:{parentOwner:other.result.owner,childOwner:'p2',replaceActive:true,reason:'换绑'}});
  const afterRebind=await data('/agency/progress?month=2026-10',primary);
  assert.equal(afterRebind.summary.children,0);
  assert.equal((await request('/commands',primary,{command:'agency.urge',payload:{childOwner:'p2',month:'2026-09'}})).status,403);
  const newPrimary=await login('partner:'+other.result.owner);
  const newProgress=await data('/agency/progress?month=2026-10',newPrimary);
  assert.deepEqual(newProgress.children.map(child=>child.childOwner),['p2']);
 });
});