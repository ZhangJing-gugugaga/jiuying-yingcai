'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server/index.cjs');
const core=require('../shared/core.cjs');
const {reportRows}=require('../server/exports.cjs');

async function setup(t,today='2026-11-18'){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 const setToday=date=>app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify(date));
 setToday(today);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();});
 async function request(path,token,body,key){
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})};
  const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/'+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text()};
 }
 function ok(response){assert.equal(response.status,200,JSON.stringify(response.body));return response.body.data;}
 const get=async(token,path)=>ok(await request(path,token));
 const login=async actor=>ok(await request('auth/dev',null,{actor})).token;
 const command=(token,command,payload,key=randomUUID())=>request('commands',token,{command,payload},key);
 const act=async(...args)=>ok(await command(...args));
 return {app,setToday,request,get,login,command,act};
}
const metrics={revenue:120.25,orders:7,traffic:13,enroll:4,note:'修正后样本'};

test('historical correction queues one responsibility, retains both snapshots, and updates authorized formal results',async t=>{
 const f=await setup(t),[partner,manager,ops,finance,other]=await Promise.all(['partnerA','manager','ops','finance','partnerB'].map(f.login));
 const month='2026-09',target='cs';
 const old=(await f.get(partner,'reports/context?outlet='+target+'&month='+month)).currentApprovedVersion;
 const oldSnapshot=(await f.get(manager,'collections/settlements?month='+month)).items[0];
 const previous=await f.get(partner,'dashboard?period='+month+'&outlet='+target);
 assert.equal(previous.settlementStatus.state,'settled');
 await f.act(partner,'report.correct',{id:old.id,reason:'复核营业收入'});
 const correction=(await f.act(partner,'report.submit',{outlet:target,month,...metrics})).result;
 await f.act(ops,'review.report',{id:correction.id,decision:'approve'});
 assert.equal((await f.get(manager,'tasks?queue=hq&kind=report_resettlement')).total,0);
 assert.equal((await f.get(partner,'dashboard?period='+month+'&outlet='+target)).totals.revenue,previous.totals.revenue);
 const key='review-correction-1';
 await f.act(finance,'review.report',{id:correction.id,decision:'approve'},key);
 assert.equal((await f.act(finance,'review.report',{id:correction.id,decision:'approve'},key)).replayed,true);
 const queue=await f.get(manager,'tasks?queue=hq&kind=report_resettlement');
 assert.equal(queue.total,1);
 const task=queue.items[0];
 assert.equal(task.businessId,oldSnapshot.id);
 assert.equal(task.assigneeRole,'manager');
 assert.deepEqual(task.affectedOutletIds,[target]);
 assert.equal(task.impacts[0].previousReportId,old.id);
 assert.equal(task.impacts[0].reportId,correction.id);
 assert.equal((await f.request('tasks/'+task.id,other)).status,404);
 assert.equal((await f.command(finance,'settle',{month,taskId:task.id})).status,403);
 assert.equal((await f.command(manager,'task.complete',{id:task.id,note:'伪关闭'})).status,409);
 const waiting=await f.get(partner,'dashboard?period='+month+'&outlet='+target);
 assert.equal(waiting.totals.revenue,null);
 assert.deepEqual(waiting.settlementStatus,{state:'pending_resettlement',pendingMonths:[month],updatedMonths:[]});
 const unaffected=await f.get(partner,'dashboard?period='+month+'&outlet=zz');
 const otherOwner=await f.get(other,'dashboard?period='+month);
 for(const view of [unaffected,otherOwner]){
  assert.equal(view.totals.revenue,null);
  assert.deepEqual(view.settlementStatus,{state:'unsettled',pendingMonths:[],updatedMonths:[],refreshingMonths:[month]});
  const output=reportRows(view,{reports:[],businessTasks:[]},'partner');
  assert.ok(output.some(row=>row[0]==='已结算数据更新中'&&row[1]===month));
  assert.doesNotMatch(JSON.stringify(view.settlementStatus),/cs|reportId|taskId|impacts/);
 }
 const workbook=await f.request('export?format=xlsx&period='+month,other);
 assert.equal(workbook.status,200);
 assert.match(workbook.body,/已结算数据更新中/);
 assert.doesNotMatch(workbook.body,/长沙示范网点A|历史月报待重新结算/);
 const currentOutletRow=workbook.body.match(/<row\b[^>]*>.*?<\/row>/g).find(row=>row.includes('广州示范网点D'));
 assert.match(currentOutletRow,/缺失/);
 assert.ok(!currentOutletRow.includes('<v>16000</v>'));
 assert.equal((await f.request('dashboard?period='+month+'&outlet=cs',other)).status,403);
 const process=await f.get(other,'dashboard?period='+month+'&mode=process');
 assert.equal(process.totals.revenue,16000);
 assert.ok(!Object.hasOwn(process,'settlementStatus'));
 assert.equal((await f.get(partner,'dashboard?period='+month+'&kind=quarter')).settlementStatus.state,'pending_resettlement');
 assert.equal((await f.get(partner,'dashboard?period=2026-10')).settlementStatus.state,'no_data');
 const settled=(await f.act(manager,'settle',{month,taskId:task.id},'monthly-resettle-1')).result;
 assert.equal(settled.previousSettlementId,oldSnapshot.id);
 assert.ok(settled.version>1);
 assert.equal((await f.act(manager,'settle',{month,taskId:task.id},'monthly-resettle-1')).result.id,settled.id);
 const closed=await f.get(manager,'tasks/'+task.id);
 assert.equal(closed.status,'resolved');
 assert.equal(closed.resultSettlementId,settled.id);
 assert.ok(closed.completedBy);
 const prior=await f.get(manager,'collections/settlements/'+oldSnapshot.id);
 assert.equal(prior.status,'invalidated');
 assert.equal(prior.supersededBy,settled.id);
 assert.deepEqual(prior.reportIds,oldSnapshot.reportIds);
 const approved=await f.get(partner,'dashboard?period='+month+'&outlet='+target);
 assert.equal(approved.totals.revenue,metrics.revenue);
 assert.deepEqual(approved.settlementStatus,{state:'resettled',pendingMonths:[],updatedMonths:[month]});
 assert.equal((await f.get(partner,'dashboard?period='+month+'&outlet=zz')).settlementStatus.state,'settled');
 const otherRestored=await f.get(other,'dashboard?period='+month);
 assert.deepEqual(otherRestored.settlementStatus,{state:'settled',pendingMonths:[],updatedMonths:[]});
 assert.equal(otherRestored.totals.revenue,16000);
 assert.equal((await f.get(manager,'dashboard?period='+month+'&outlet='+target)).rankings.revenue[0].revenue,metrics.revenue);
 const ownerSnapshot=await f.get(partner,'collections/settlements/'+settled.id);
 assert.ok(ownerSnapshot.reportIds.includes(correction.id));
 assert.equal(ownerSnapshot.reportIds.length,3);
 for(const id of ownerSnapshot.reportIds)assert.equal((await f.get(partner,'collections/reports/'+id)).owner,'p1');
 assert.equal(ownerSnapshot.impacts,undefined);
 const csv=await f.request('export?format=csv&period='+month+'&outlet='+target,partner);
 assert.equal(csv.status,200);
 assert.match(csv.body,/120\.25/);
});

test('re-settlement after sole-report revocation records no valid results and remains visible to its owner',async t=>{
 const f=await setup(t),[partner,manager,ops,finance,other]=await Promise.all(['partnerA','manager','ops','finance','partnerB'].map(f.login));
 const month='2026-10';
 const report=(await f.act(partner,'report.submit',{outlet:'cs',month,...metrics})).result;
 await f.act(ops,'review.report',{id:report.id,decision:'approve'});
 const first=(await f.act(manager,'settle',{month})).result;
 const req=(await f.act(manager,'report.revoke.request',{id:report.id,reason:'审批前提需纠正'})).result;
 await f.act(finance,'review.revoke',{id:req.id,decision:'approve'});
 const task=(await f.get(manager,'tasks?queue=hq&kind=report_resettlement')).items[0];
 assert.equal(task.impacts[0].kind,'report_revoked');
 const emptyOther=await f.get(other,'dashboard?period='+month);
 assert.deepEqual(emptyOther.settlementStatus,{state:'no_data',pendingMonths:[],updatedMonths:[]});
 const second=(await f.act(manager,'settle',{month,taskId:task.id})).result;
 assert.deepEqual(second.reportIds,[]);
 assert.equal(second.previousSettlementId,first.id);
 assert.equal((await f.get(partner,'collections/settlements/'+second.id)).status,'approved');
 assert.equal((await f.request('collections/settlements/'+second.id,other)).status,404);
 assert.equal((await f.get(partner,'dashboard?period='+month)).totals.revenue,null);
 assert.ok((await f.get(partner,'collections/messages')).items.some(row=>row.month===month&&row.title.includes('重新结算')));
});

test('legacy requests and notifications suppress review remarks, while new explicit customer statements stay visible',async t=>{
 const f=await setup(t),[partner,manager,finance,other]=await Promise.all(['partnerA','manager','finance','partnerB'].map(f.login));
 const privateText='INTERNAL_FINANCE_OLD_SECRET',publicText='请核对申请期间后补交资料';
 const legacy={id:'req-pre-v33',outlet:'cs',owner:'p1',status:'returned',createdAt:'2026-11-12T01:00:00Z',type:'pauseFee',reviewNote:privateText,data:{from:'2026-10-01',to:'2026-10-31',reason:'加盟商填写',unknownInternal:privateText},trail:[{actor:'finance',subject:'finance-user',action:'review.request',note:privateText,executedAt:'2026-11-13T01:00:00Z',after:{status:'returned'}}]};
 const before=f.app.store.load(),seed=core.clone(before);
 seed.requests.push(legacy);
 seed.messages.push({id:'msg-pre-v33',outlet:'cs',owner:'p1',status:'unread',target:'requests',recordId:legacy.id,title:'申请处理结果：returned',body:privateText,createdAt:'2026-11-13T01:00:00Z'});
 f.app.store.transaction(()=>f.app.store.save(seed,{before}));
 for(const path of ['collections/requests/'+legacy.id,'collections/requests','approval-history/requests/'+legacy.id,'collections/messages/msg-pre-v33','state']){
  assert.doesNotMatch(JSON.stringify(await f.get(partner,path)),new RegExp(privateText));
 }
 assert.equal((await f.request('collections/requests/'+legacy.id,other)).status,404);
 const read=await f.act(partner,'message.read',{id:'msg-pre-v33'},'private-history-msg-read');
 const replay=await f.act(partner,'message.read',{id:'msg-pre-v33'},'private-history-msg-read');
 assert.equal(replay.replayed,true);
 assert.doesNotMatch(JSON.stringify([read,replay]),new RegExp(privateText));
 const detail=await f.get(manager,'collections/requests/'+legacy.id);
 assert.equal(detail.financeReviewNote,privateText);
 assert.match(JSON.stringify(await f.get(manager,'approval-history/requests/'+legacy.id)),new RegExp(privateText));
 const reopened=await f.act(partner,'request.supplement',{id:legacy.id,note:'已补充资料'});
 assert.doesNotMatch(JSON.stringify(reopened),new RegExp(privateText));
 await f.act(finance,'review.request',{id:legacy.id,decision:'supplement',note:'INTERNAL_FINANCE_NEW_SECRET',publicNote:publicText});
 const customer=await f.get(partner,'collections/requests/'+legacy.id);
 assert.equal(customer.publicNote,publicText);
 assert.equal(customer.financeReviewNote,undefined);
 assert.doesNotMatch(JSON.stringify(customer),/INTERNAL_FINANCE_NEW_SECRET/);
 const events=(await f.get(partner,'approval-history/requests/'+legacy.id)).items;
 assert.ok(events.some(event=>event.note===publicText));
 assert.doesNotMatch(JSON.stringify(events),/INTERNAL_FINANCE_(OLD|NEW)_SECRET|finance-user/);
 const messages=(await f.get(partner,'collections/messages')).items;
 assert.ok(messages.some(row=>row.recordId===legacy.id&&row.body===publicText));
 assert.doesNotMatch(JSON.stringify(messages),/INTERNAL_FINANCE_(OLD|NEW)_SECRET/);
});

test('old revocation details hide internal reasons, original values, and audit history from partner roles',async t=>{
 const f=await setup(t),[partner,manager,finance]=await Promise.all(['partnerA','manager','finance'].map(f.login));
 const report=(await f.get(partner,'reports/context?outlet=cs&month=2026-09')).currentApprovedVersion;
 const request=(await f.act(manager,'report.revoke.request',{id:report.id,reason:'PRIVATE_REVOCATION_REASON'})).result;
 await f.act(finance,'review.revoke',{id:request.id,decision:'return',note:'PRIVATE_FINANCE_NOTE',publicNote:'复核保留本期结果'});
 const detail=await f.get(partner,'collections/requests/'+request.id);
 assert.deepEqual(detail.data,{reportId:report.id,month:'2026-09',version:report.version});
 assert.equal(detail.publicNote,'复核保留本期结果');
 const trail=await f.get(partner,'approval-history/requests/'+request.id);
 assert.doesNotMatch(JSON.stringify([trail,detail]),/PRIVATE_REVOCATION_REASON|PRIVATE_FINANCE_NOTE|originalValues|initiator/);
 assert.match(JSON.stringify(await f.get(manager,'collections/requests/'+request.id)),/PRIVATE_REVOCATION_REASON/);
 const reopen=await f.command(partner,'request.supplement',{id:request.id,note:'申请人越权重开总部撤销'});
 assert.equal(reopen.status,403);
 assert.equal((await f.get(manager,'collections/requests/'+request.id)).status,'returned');
});

test('legacy fifth cutoff matches report context, operations, partner prompts, coverage, and exports at the date boundary',async t=>{
 const f=await setup(t,'2026-11-05'),[partner,manager,ops]=await Promise.all(['partnerA','manager','ops'].map(f.login));
 const context='reports/context?outlet=cs&month=2026-10',stats='dashboard?period=2026-10&outlet=cs';
 await f.act(ops,'jobs.run',{outlet:'cs',limit:1});
 const atCutoff=await f.get(partner,context);
 assert.equal(atCutoff.eligibility.canSubmit,true);
 assert.equal(atCutoff.timing.dueOn,'2026-11-05');
 assert.equal(atCutoff.timing.late,false);
 assert.equal((await f.get(partner,stats)).reportingCoverage.overdue,0);
 f.setToday('2026-11-06');
 const pastCutoff=await f.get(partner,context);
 assert.equal(pastCutoff.eligibility.canSubmit,true);
 assert.equal(pastCutoff.timing.late,true);
 const task=(await f.get(ops,'tasks?queue=ops&kind=report_missing&outlet=cs')).items[0];
 assert.equal(task.dueAt,'2026-11-05');
 assert.equal(task.overdue,true);
 const heading=(await f.get(ops,'tasks/overview?kind=report_missing')).items.find(row=>row.queue==='ops');
 assert.equal(heading.overdue,1);
 const prompt=(await f.get(partner,'collections/businessTasks?status=open')).items.find(row=>row.kind==='report_missing'&&row.outlet==='cs');
 assert.equal(prompt.dueOn,task.dueAt);
 assert.equal(prompt.overdue,true);
 const dashboard=await f.get(manager,stats);
 assert.equal(dashboard.reportingCoverage.overdue,1);
 assert.ok(reportRows(dashboard,{businessTasks:[task],today:'2026-11-06'},'manager').some(row=>row.includes('逾期未报')));
 const csv=await f.request('export?format=csv&period=2026-10&outlet=cs',partner);
 assert.match(csv.body,/逾期未报网点月/);
 const report=(await f.act(partner,'report.submit',{outlet:'cs',month:'2026-10',...metrics})).result;
 assert.equal(report.dueOn,task.dueAt);
 assert.equal(report.late,true);
 const submitted=(await f.get(partner,stats)).reportingCoverage;
 assert.equal(submitted.overdue,0);
 assert.equal(submitted.lateSubmitted,1);
});

test('unconfirmed cutoff stays unset and configured deadlines refresh existing reminders without waiting for the next run',async t=>{
 const f=await setup(t),[partner,manager,ops]=await Promise.all(['partnerA','manager','ops'].map(f.login));
 await f.act(ops,'jobs.run',{outlet:'cs',limit:1});
 const context='reports/context?outlet=cs&month=2026-10';
 const list='tasks?queue=ops&kind=report_missing&outlet=cs';
 await f.act(manager,'policy.configure',{name:'仅确认位置制度',effectiveFrom:'2026-11-01',locationDueDay:18,reason:'逐项签认'});
 const pending=await f.get(partner,context);
 assert.equal(pending.timing.dueOn,null);
 assert.equal(pending.timing.late,null);
 const task=(await f.get(ops,list)).items[0];
 assert.equal(task.dueAt,null);
 assert.equal(task.overdue,false);
 await f.act(manager,'policy.configure',{name:'签认自然日',effectiveFrom:'2026-11-01',reportDueDay:20,reason:'按签认调整'});
 assert.equal((await f.get(partner,context)).timing.dueOn,'2026-11-20');
 const refreshed=(await f.get(ops,list)).items[0];
 assert.equal(refreshed.id,task.id);
 assert.equal(refreshed.dueAt,'2026-11-20');
 assert.equal(refreshed.overdue,false);
});

test('upgrade creates a single pending task for an already invalidated legacy period',t=>{
 const {mkdtempSync,rmSync}=require('node:fs');
 const {tmpdir}=require('node:os');
 const {join}=require('node:path');
 const {openStore}=require('../server/storage.cjs');
 const dir=mkdtempSync(join(tmpdir(),'jiuying-v33-settlement-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const dbPath=join(dir,'upgrade.db');
 const legacy=openStore(dbPath);
 const state=legacy.load();
 const m='2026-09',prior=state.settlements.find(row=>row.month===m),report=state.reports.find(row=>row.month===m&&row.outlet==='cs');
 prior.status='invalidated';
 prior.invalidatedAt='2026-11-10T06:00:00.000Z';
 report.current=false;
 report.revoked=true;
 report.revokedAt=prior.invalidatedAt;
 legacy.transaction(()=>legacy.save(state));
 legacy.db.prepare('DELETE FROM schema_migrations WHERE version=18').run();
 legacy.close();
 for(let i=0;i<2;i++){
  const upgraded=openStore(dbPath);
  try{
   const rows=upgraded.load().businessTasks.filter(row=>row.kind==='report_resettlement');
   assert.equal(rows.length,1);
   assert.equal(rows[0].businessId,prior.id);
   assert.equal(rows[0].assigneeRole,'manager');
   assert.deepEqual(rows[0].affectedOutletIds,['cs']);
   assert.equal(rows[0].impacts[0].kind,'report_revoked');
   assert.equal(rows[0].impacts[0].previousReportId,report.id);
   assert.equal(upgraded.load().settlements.find(row=>row.id===prior.id).resettlementTaskId,rows[0].id);
  }finally{upgraded.close();}
 }
});

test('two changes across stores append distinct impacts to the same invalidated settlement',async t=>{
 const f=await setup(t),[manager,finance]=await Promise.all(['manager','finance'].map(f.login));
 for(const outlet of ['cs','gz']){
  const version=(await f.get(manager,'reports/context?outlet='+outlet+'&month=2026-09')).currentApprovedVersion;
  const request=(await f.act(manager,'report.revoke.request',{id:version.id,reason:'误审批'})).result;
  await f.act(finance,'review.revoke',{id:request.id,decision:'approve'});
 }
 const tasks=await f.get(manager,'tasks?queue=hq&kind=report_resettlement&month=2026-09');
 assert.equal(tasks.total,1);
 assert.deepEqual(tasks.items[0].affectedOutletIds,['cs','gz']);
 assert.equal(tasks.items[0].impacts.length,2);
});

test('settlement freezes approved summary values in the snapshot before subsequent adjustment',async t=>{
 const f=await setup(t),[manager,finance]=await Promise.all(['manager','finance'].map(f.login));
 const month='2026-09',outlet='cs',stats='dashboard?period='+month+'&outlet='+outlet;
 const act=async revenue=>{
  const adjustment=(await f.act(manager,'summary.adjust',{outlet,month,values:{revenue},reason:'有效汇总调整'})).result;
  await f.act(finance,'review.adjust',{id:adjustment.id,decision:'approve',note:'独立审核'});
  return adjustment;
 };
 const a=await act(123.45);
 const one=(await f.act(manager,'settle',{month})).result;
 assert.equal(one.reportValues[a.sourceReportId].values.revenue,123.45);
 assert.deepEqual(one.reportValues[a.sourceReportId].adjustmentIds,[a.id]);
 assert.equal((await f.get(manager,stats)).totals.revenue,123.45);
 const b=await act(456.78);
 const two=(await f.act(manager,'settle',{month})).result;
 assert.equal(two.previousSettlementId,one.id);
 assert.equal(two.reportValues[b.sourceReportId].values.revenue,456.78);
 const historical=await f.get(manager,'collections/settlements/'+one.id);
 assert.equal(historical.reportValues[a.sourceReportId].values.revenue,123.45);
 const summary=(await f.get(manager,'collections/settlements?month=2026-09')).items.find(row=>row.id===one.id);
 assert.ok(summary);
 assert.equal(Object.hasOwn(summary,'reportValues'),false,'list must keep full report-values only in drill-down');
 assert.ok(summary.reportIds.includes(a.sourceReportId),'legacy report membership remains accessible');
 assert.equal((await f.get(manager,stats)).totals.revenue,456.78);
});
