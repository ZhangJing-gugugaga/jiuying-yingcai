'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../server/storage.cjs');
const {repository}=require('../server/repository.cjs');
const {authentication}=require('../server/auth.cjs');
const core=require('../shared/core.cjs');

const today='2026-11-18';
const now='2026-11-18T04:00:00.000Z';
const report={outlet:'cs',month:'2026-10',revenue:100,orders:2,traffic:3,enroll:1,note:'经营说明'};
async function withStore(run){
 const store=openStore(':memory:');
 const repo=repository(store,{today:()=>today});
 const session=(actor,subject=actor,at=now)=>({actor,subject,now:at,today});
 const execute=(principal,command,payload)=>store.transaction(()=>{
  const state=repo.commandState(principal,command,payload);
  const result=core.execute(state,principal.actor,command,payload,{...principal,jobScope:state.__jobScope,requestId:'test-'+command});
  store.save(result.state,{before:state});
  return result.result;
 });
 const tasks=(actor,queue,params={})=>repo.taskList(session(actor),{queue,...params});
 const counts=actor=>Object.fromEntries(repo.taskOverview(session(actor)).items.map(x=>[x.queue,x.total]));
 try{await run({store,repo,session,execute,tasks,counts});}finally{store.close();}
}

test('four server counts track one persisted responsibility across report versions and finance',()=>withStore(({store,repo,session,execute,tasks,counts})=>{
 const manager=session('manager'),ops=session('ops'),finance=session('finance'),partner=session('partnerA');
 assert.deepEqual(counts('manager'),{ops:0,finance:0,partner:0,hq:0});
 const v1=execute(partner,'report.submit',report);
 execute(ops,'review.report',{id:v1.id,decision:'approve'});
 execute(partner,'report.correct',{id:v1.id,reason:'修正收入',correctionType:'field',fields:['revenue']});
 const v2=execute(partner,'report.submit',{...report,revenue:105});
 const firstReview=tasks('manager','ops').items[0];
 assert.equal(firstReview.recordId,v2.id);
 assert.equal(firstReview.dueAt,null);
 execute(ops,'review.report',{id:v2.id,decision:'return',note:'重新核实收入'});
 const returned=tasks('manager','partner').items[0];
 assert.equal(repo.detail('businessTasks',returned.id,partner).status,'open');
 assert.throws(()=>repo.taskDetail(session('partnerB'),returned.id),{code:'NOT_FOUND'});
 const message=repo.list('messages',partner).items.find(x=>x.recordId===v2.id&&x.taskId===returned.id);
 assert.ok(message);
 execute(partner,'message.read',{id:message.id});
 assert.equal(tasks('manager','partner').total,1);
 const v3=execute(partner,'report.submit',{...report,revenue:110});
 assert.equal(tasks('manager','partner').total,0);
 const nextReview=tasks('manager','ops').items[0];
 execute(ops,'review.report',{id:v3.id,decision:'approve'});
 const awaitingFinance=tasks('manager','finance').items[0];
 assert.notEqual(awaitingFinance.id,nextReview.id);
 assert.equal(awaitingFinance.recordId,v3.id);
 assert.equal(repo.taskDetail(manager,nextReview.id).status,'resolved');
 assert.equal(tasks('manager','ops').total,0);
 assert.throws(()=>repo.taskDetail(ops,awaitingFinance.id),{code:'NOT_FOUND'});
 assert.throws(()=>execute(ops,'review.report',{id:v3.id,decision:'approve'}),{code:'FORBIDDEN'});
 assert.throws(()=>store.db.prepare("INSERT INTO businessTasks SELECT 'duplicate',owner,outlet,status,month,version,current,amount_cents,data,created_at FROM businessTasks WHERE id=?").run(awaitingFinance.id),/UNIQUE constraint failed/);
 execute(finance,'review.report',{id:v3.id,decision:'approve'});
 assert.deepEqual(counts('manager'),{ops:0,finance:0,partner:0,hq:0});
 assert.equal(repo.reportContext(partner,report).currentApprovedVersion.id,v3.id);
}));

test('regional requests use current review outlet and metric grants on list, detail and mutation',()=>withStore(({repo,session,execute,counts})=>{
 const manager=session('manager'),region=session('regional','regional_tasks');
 execute(manager,'staff.create',{subject:region.subject,name:'区域负责人',role:'regional',grants:{outlets:['cs','zz'],metrics:['orders'],reviewOutlets:['cs']},reason:'区域审核范围'});
 execute(session('partnerA'),'report.submit',report);
 execute(session('partnerA'),'report.submit',{...report,outlet:'zz',enroll:null});
 const queue=repo.taskList(region,{queue:'ops'});
 assert.equal(queue.total,1);
 assert.equal(queue.items[0].outlet,'cs');
 assert.equal(repo.taskList(region,{queue:'ops',outlet:'zz'}).total,0);
 assert.throws(()=>repo.taskList(region,{queue:'finance'}),{code:'FORBIDDEN'});
 assert.equal(counts('manager').ops,2);
 execute(manager,'grant.revoke',{id:region.subject,reason:'离岗撤销'});
 assert.deepEqual(repo.taskOverview(region).items,[]);
 assert.throws(()=>repo.taskDetail(region,queue.items[0].id),{code:'NOT_FOUND'});
 assert.throws(()=>execute(region,'review.report',{id:queue.items[0].recordId,decision:'approve'}),{code:'FORBIDDEN'});
}));

test('headquarters assignments expire former access and preserve transfer history and explicit due time',()=>withStore(async ({store,repo,session,execute,tasks})=>{
 const manager=session('manager'),ops=session('ops','ops_task_assignee'),finance=session('finance','finance_task_assignee');
 const auth=authentication(store,{NODE_ENV:'test'});
 for(const p of [ops,finance]){
  execute(manager,'staff.create',{subject:p.subject,name:p.subject,role:p.actor,reason:'派单测试'});
  const invitation=auth.issueActivation(manager,{actor:p.subject});
  await auth.activate({token:invitation.token,password:'Local-Responsibility-fixture-only'});
 }
 const p={businessType:'outlets',businessId:'cs',title:'核对网点异常',note:'登记待核对事项',dueAt:'2026-11-18T12:00:00+08:00'};
 assert.throws(()=>execute(ops,'task.create',p),{code:'FORBIDDEN'});
 const row=execute(manager,'task.create',p),id=row.id;
 assert.equal(tasks('manager','hq').items[0].assigneeRole,'manager');
 assert.throws(()=>execute(manager,'task.create',p),{code:'DUPLICATE'});
 execute(manager,'task.assign',{id,assigneeRole:'ops',assigneeUserId:ops.subject,note:'交运营复核'});
 assert.equal(repo.taskDetail(ops,id).overdue,false);
 assert.equal(repo.taskDetail({...ops,now:'2026-11-18T04:00:01.000Z'},id).overdue,true);
 assert.throws(()=>repo.taskDetail(session('ops','someone_else'),id),{code:'NOT_FOUND'});
 assert.throws(()=>execute(ops,'task.update',{id,status:'in_progress',assignee:'someone_else',note:'越权转派'}),{code:'FORBIDDEN'});
 execute(manager,'task.assign',{id,assigneeRole:'finance',assigneeUserId:finance.subject,note:'转相应岗位'});
 assert.throws(()=>execute(ops,'task.complete',{id,note:'旧人尝试关闭'}),{code:'FORBIDDEN'});
 assert.throws(()=>repo.assertTaskReplay(ops,'task.complete',{id},{id}),{code:'NOT_FOUND'});
 execute(finance,'task.complete',{id,note:'处理完成'});
 assert.equal(tasks('manager','hq').total,0);
 const closed=repo.taskDetail(manager,id);
 assert.equal(closed.completedAt,now);
 assert.equal(closed.closeReason,'completed');
 assert.deepEqual(closed.transferHistory.map(e=>e.to.role),['ops','finance']);
 assert.throws(()=>store.db.prepare("UPDATE businessTasks SET data=json_remove(data,'$.transferHistory') WHERE id=?").run(id),/immutable/);
}));

test('an outlet request without a created outlet advances and reopens by actual stage',()=>withStore(({repo,session,execute,tasks})=>{
 const partner=session('partnerA'),ops=session('ops'),location=session('location');
 const req=execute(partner,'request.submit',{type:'newOutlet',data:{name:'待开点',province:'湖南',city:'长沙',district:'开福区',address:'地址',phone:'0731-1234',opening:'2026-11-01',coords:{lat:28,lng:113,source:'manual',coordinateSystem:'GCJ-02'},photo:{id:'file-fixture'}}});
 const initial=tasks('manager','hq').items[0];
 assert.equal(initial.assigneeRole,'location');
 assert.equal(initial.recordId,req.id);
 execute(location,'location.review',{id:req.id,decision:'approve'});
 const reviewed=tasks('manager','hq').items[0];
 assert.equal(reviewed.assigneeRole,'ops');
 execute(ops,'review.request',{id:req.id,decision:'supplement',note:'补交材料'});
 const supplement=tasks('manager','partner').items[0];
 assert.equal(supplement.recordId,req.id);
 execute(partner,'request.supplement',{id:req.id,note:'已补交'});
 assert.equal(tasks('manager','partner').total,0);
 assert.notEqual(tasks('manager','hq').items[0].id,reviewed.id);
 assert.equal(repo.taskDetail(session('manager'),initial.id).status,'resolved');
}));

test('configured date deadlines cross the business day and distinct headquarters jobs retain their records',()=>withStore(({repo,session,execute,tasks})=>{
 const manager=session('manager');
 execute(manager,'policy.configure',{name:'持久化截止日',effectiveFrom:'2026-11-01',reportDueDay:5,locationDueDay:18,reason:'核对截止日配置'});
 execute(manager,'jobs.run',{outlet:'hy'});
 const hq=tasks('manager','hq');
 assert.deepEqual(hq.items.map(x=>[x.kind,x.dueAt,x.overdue]),[['exemption_review','2026-11-05',true],['location_missing','2026-11-18',false]]);
 const stats=repo.taskOverview(manager).items.find(x=>x.queue==='hq');
 assert.equal(stats.overdue,1);
 assert.equal(stats.earliestDueAt,'2026-11-05');
 const saved=repo.detail('businessTasks',hq.items[0].id,manager);
 assert.equal(saved.overdueObservedAt,now);
 assert.equal(saved.trail.filter(event=>event.action==='task.overdue').length,1);
 execute(manager,'jobs.run',{outlet:'hy'});
 assert.equal(tasks('manager','hq').total,2);
 assert.equal(repo.detail('businessTasks',saved.id,manager).trail.filter(event=>event.action==='task.overdue').length,1);
}));

test('pre-existing SLA escalation inherits the active claim and hides the other assignee',()=>withStore(({store,repo,session,execute,tasks})=>{
 const manager=session('manager'),agent=session('support','support_task_001');
 execute(manager,'staff.create',{subject:agent.subject,name:'当班客服',role:'support',reason:'排班'});
 execute(manager,'support.settings',{hours:'自然分钟首响',sla:{complaint:30,aftersale:null,exception:null}});
 const ticket=execute(session('public','v32-delay-test'),'support.ticket',{outlet:'cs',category:'complaint',title:'服务核实',description:'用户原始咨询'});
 store.transaction(()=>{
  const state=store.load();
  state.supportTickets.find(x=>x.id===ticket.id).createdAt='2026-11-18T03:00:00.000Z';
  store.save(state);
 });
 execute(manager,'jobs.run',{outlet:'cs'});
 const escalation=tasks('support','hq',{kind:'support_sla'}).items[0];
 assert.equal(escalation.recordId,ticket.id);
 assert.equal(escalation.dueAt,'2026-11-18T03:30:00.000Z');
 execute(agent,'support.claim',{id:ticket.id});
 assert.equal(repo.taskDetail(agent,escalation.id).assigneeUserId,agent.subject);
 assert.throws(()=>repo.taskDetail(session('support','other_agent'),escalation.id),{code:'NOT_FOUND'});
 execute(agent,'support.reply',{id:ticket.id,text:'已开始核对'});
 assert.equal(repo.taskDetail(manager,escalation.id).status,'resolved');
}));

test('fee calculation and independent proposal review alternate on one responsibility',()=>withStore(({store,repo,session,execute,tasks})=>{
 const manager=session('manager'),ops=session('ops'),finance=session('finance'),partner=session('partnerA');
 const pause=execute(partner,'request.submit',{type:'pauseFee',outlet:'cs',data:{from:'2026-10-01',to:'2026-10-31',reason:'停业费用调整'}});
 execute(finance,'review.request',{id:pause.id,decision:'approve'});
 const initial=tasks('ops','hq',{kind:'fee_calculation'}).items[0];
 assert.equal(initial.businessType,'adjustments');
 assert.equal(initial.canViewBusiness,true);
 assert.equal(tasks('finance','finance',{kind:'fee_calculation'}).total,0);
 const adjustment=repo.detail('adjustments',initial.businessId,ops);
 assert.equal(adjustment.amount,null);
 const payload={adjustmentId:adjustment.id,amount:36.50,offsetMonth:'2026-12',serviceUntil:null,reason:'凭证核算'};
 assert.throws(()=>execute(finance,'fee.adjust.propose',payload),{code:'FORBIDDEN'});
 const proposal=execute(ops,'fee.adjust.propose',payload);
 const financeQueue=tasks('finance','finance',{kind:'fee_proposal_review'});
 assert.equal(financeQueue.total,1);
 const firstReview=financeQueue.items[0];
 assert.equal(firstReview.businessType,'feeProposals');
 assert.equal(firstReview.businessId,proposal.id);
 assert.equal(firstReview.canViewBusiness,true);
 assert.equal(firstReview.month,'2026-12');
 assert.equal(tasks('ops','hq',{kind:'fee_calculation'}).total,0);
 assert.equal(repo.taskDetail(manager,initial.id).status,'resolved');
 assert.throws(()=>repo.taskDetail(ops,firstReview.id),{code:'NOT_FOUND'});
 execute(manager,'jobs.run',{outlet:'cs'});
 assert.equal(tasks('ops','hq',{kind:'fee_calculation'}).total,0);
 assert.equal(tasks('finance','finance',{kind:'fee_proposal_review'}).items[0].id,firstReview.id);
 execute(finance,'fee.adjust.review',{id:proposal.id,decision:'return',note:'补充核算依据'});
 assert.equal(tasks('finance','finance',{kind:'fee_proposal_review'}).total,0);
 const recalculation=tasks('ops','hq',{kind:'fee_calculation'}).items[0];
 assert.equal(recalculation.businessId,adjustment.id);
 assert.notEqual(recalculation.id,initial.id);
 assert.equal(repo.taskDetail(manager,firstReview.id).status,'resolved');
 const retry=execute(manager,'fee.adjust.propose',{...payload,amount:40.05});
 execute(finance,'fee.adjust.review',{id:retry.id,decision:'approve',note:'核算依据齐全'});
 assert.equal(tasks('ops','hq',{kind:'fee_calculation'}).total,0);
 assert.equal(tasks('finance','finance',{kind:'fee_proposal_review'}).total,0);
 assert.equal(repo.detail('adjustments',adjustment.id,finance).amount,40.05);
 const history=store.db.prepare("SELECT status FROM businessTasks WHERE json_extract(data,'$.responsibilityKey')=?").all(JSON.stringify(['adjustments',adjustment.id]));
 assert.deepEqual(history.map(row=>row.status),['resolved','resolved','resolved','resolved']);
}));

test('an escalated support case has a manager responsibility until management handles it',()=>withStore(({store,repo,session,execute,tasks})=>{
 const manager=session('manager'),support=session('support'),visitor=session('public','v32-escalation-test');
 execute(manager,'support.settings',{hours:'核验首响配置',sla:{complaint:30,aftersale:null,exception:null}});
 const ticket=execute(visitor,'support.ticket',{outlet:'cs',category:'complaint',title:'需要跟踪',description:'用户信息仅客服可见'});
 store.transaction(()=>{
  const state=store.load();
  state.supportTickets.find(x=>x.id===ticket.id).createdAt='2026-11-18T03:00:00.000Z';
  store.save(state);
 });
 execute(manager,'jobs.run',{outlet:'cs'});
 const sla=tasks('support','hq',{kind:'support_sla'}).items[0];
 assert.ok(sla);
 execute(support,'support.claim',{id:ticket.id});
 execute(support,'support.escalate',{id:ticket.id,reason:'按升级流程复核'});
 const management=tasks('manager','hq',{kind:'support_management'}).items[0];
 assert.ok(management);
 assert.equal(management.businessId,ticket.id);
 assert.equal(management.assigneeRole,'manager');
 assert.equal(management.canViewBusiness,true);
 assert.equal(tasks('support','hq',{kind:'support_management'}).total,0);
 assert.equal(repo.taskDetail(manager,sla.id).status,'resolved');
 execute(manager,'jobs.run',{outlet:'cs'});
 assert.equal(tasks('manager','hq',{kind:'support_management'}).items[0].id,management.id);
 assert.equal(tasks('support','hq',{kind:'support_sla'}).total,0);
 assert.throws(()=>execute(support,'support.close',{id:ticket.id,note:'尚未处理'}),{code:'TRANSITION'});
 execute(manager,'support.management',{id:ticket.id,note:'已核实并答复'});
 assert.equal(repo.taskDetail(manager,management.id).status,'resolved');
 assert.equal(tasks('manager','hq',{kind:'support_management'}).total,0);
 execute(support,'support.close',{id:ticket.id,note:'已完成处理'});
 const active=store.db.prepare("SELECT count(*) n FROM businessTasks WHERE status IN ('open','in_progress') AND json_extract(data,'$.responsibilityKey')=?").get(JSON.stringify(['supportTickets',ticket.id]));
 assert.equal(active.n,0);
}));

test('migration preserves legacy task identity and restores only current responsibilities',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{DatabaseSync}=require('node:sqlite');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiuying-v32-tasks-'));
 const filename=path.join(dir,'v31.db'),migrations=path.resolve(__dirname,'../database');
 const v31=new DatabaseSync(filename);
 let reopened;
 try{
  v31.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of fs.readdirSync(migrations).filter(x=>/^\d{3}_[a-z0-9_]+\.sql$/.test(x)&&Number(x.slice(0,3))<=13).sort()){
   v31.exec(fs.readFileSync(path.join(migrations,name),'utf8'));
   v31.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(name.slice(0,3)),name.slice(0,-4),now);
  }
  const row={id:'legacy-rpt',owner:'p1',outlet:'cs',month:'2026-10',version:2,status:'finance'};
  const legacy={id:'legacy-task',owner:row.owner,outlet:row.outlet,month:row.month,status:'open',kind:'report_review',role:'finance',taskKey:'report_review|legacy-rpt|',recordId:row.id,createdAt:now,dueOn:'2026-11-05',internal:true};
  const verif={id:'legacy-location',owner:'p1',outlet:'cs',month:'2026-11',status:'exception'};
  const adjustment={id:'legacy-adjustment',owner:'p1',outlet:'cs',status:'待财务核算调整'};
  const awaitingProposal={...adjustment,id:'legacy-needs-proposal',outlet:'zz'};
  const proposal={id:'legacy-fee',owner:'p1',outlet:'cs',status:'pending',adjustmentId:adjustment.id,offsetMonth:'2026-12',amount:12.34};
  const priorTask={...legacy,id:'legacy-calc',outlet:'zz',month:null,recordId:awaitingProposal.id,kind:'fee_calculation',taskKey:'fee_calculation|legacy-needs-proposal|',dueOn:null};
  const severe={id:'legacy-escalation',owner:'visitor-legacy',outlet:'cs',status:'active',severe:true,assignee:'support',messages:[]};
  const oldSla={...legacy,id:'legacy-escalation-sla',owner:null,month:'2026-11',recordId:severe.id,kind:'support_sla',role:'support',dueOn:null,taskKey:'support_sla|cs|2026-11|legacy-escalation'};
  for(const [table,r] of [['reports',row],['businessTasks',legacy],['verifications',verif],['adjustments',adjustment],['adjustments',awaitingProposal],['feeProposals',proposal],['businessTasks',priorTask],['supportTickets',severe],['businessTasks',oldSla]])
   v31.prepare(`INSERT INTO ${table}(id,owner,outlet,status,month,version,data,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(r.id,r.owner,r.outlet,r.status,r.month??null,r.version??null,JSON.stringify(r),now);
  v31.close();
  const manager={actor:'manager',subject:'manager',today,now};
  for(let pass=0;pass<2;pass++){
   reopened=openStore(filename,{seed:false});
   const repo=repository(reopened,{today:()=>today}),old=repo.taskDetail(manager,legacy.id);
   assert.equal(old.status,'resolved');
   assert.equal(old.closeReason,'migration_stage_reconciled');
   const finance=repo.taskList(manager,{queue:'finance',kind:'report_finance_review'});
   assert.equal(finance.total,1);
   assert.equal(finance.items[0].recordId,row.id);
   assert.equal(finance.items[0].dueAt,null);
   assert.equal(repo.taskList(manager,{queue:'hq',kind:'location_exception'}).items[0].recordId,verif.id);
   assert.equal(repo.taskList(manager,{queue:'finance',kind:'fee_proposal_review'}).items[0].recordId,proposal.id);
   assert.equal(repo.taskList(manager,{queue:'hq',kind:'fee_calculation'}).items[0].recordId,awaitingProposal.id);
   assert.equal(repo.taskDetail(manager,priorTask.id).status,'resolved');
   assert.equal(repo.taskDetail(manager,priorTask.id).assigneeRole,'finance');
   assert.equal(repo.taskList(manager,{queue:'hq',kind:'support_management'}).items[0].recordId,severe.id);
   assert.equal(repo.taskDetail(manager,oldSla.id).status,'resolved');
   assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   reopened.close();reopened=null;
  }
 }finally{
  if(v31.isOpen)v31.close();
  reopened?.close();
  for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));
  fs.rmdirSync(dir);
 }
});
