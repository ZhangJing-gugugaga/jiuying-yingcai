'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server/index.cjs');

async function withBusinessServer(run){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,{token,body,key}={}){
  const headers={};
  if(token)headers.Authorization='Bearer '+token;
  if(body)headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const json=response.headers.get('content-type').startsWith('application/json');
  const data=json?await response.json():Buffer.from(await response.arrayBuffer());
  return {status:response.status,data};
 }
 async function login(actor){
  const response=await request('/api/auth/dev',{body:{actor}});
  assert.equal(response.status,200);
  return response.data.data.token;
 }
 async function get(token,path,status=200){
  const response=await request(path,{token});
  assert.equal(response.status,status,JSON.stringify(response.data.error||response.data.message||''));
  return response.data.data??response.data;
 }
 async function command(token,command,payload,{status=200,key=randomUUID()}={}){
  const response=await request('/api/commands',{token,key,body:{command,payload}});
  assert.equal(response.status,status,JSON.stringify(response.data.error||response.data.message||''));
  return response.data.data??response.data;
 }
 function row(table,id){
  return JSON.parse(app.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id).data);
 }
 function businessDate(day){
  app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify(day));
 }
 try{await run({app,login,get,command,row,businessDate});}
 finally{
  try{await new Promise(resolve=>app.server.close(resolve));}
  finally{app.store.close();}
 }
}

const october={outlet:'cs',month:'2026-10',revenue:'100.15',orders:2,traffic:5,enroll:0,note:'验收经营说明'};
const approved={decision:'approve',note:'核对业务证据'};
const reportContext='/api/reports/context?outlet=cs&month=2026-10';
const octoberStats='/api/dashboard?period=2026-10&outlet=cs';

test('T06 and T13: returned V1 remains immutable; V2 and settlement finish the linked task exactly once',()=>withBusinessServer(async f=>{
 const partner=await f.login('partnerA'),ops=await f.login('ops'),manager=await f.login('manager');
 const draft=(await f.command(partner,'report.draft',{outlet:'cs',month:'2026-10',revenue:'100.15'})).result;
 assert.equal(draft.orders,null);
 assert.equal((await f.get(partner,reportContext)).draft.id,draft.id);
 const key=randomUUID(),v1=(await f.command(partner,'report.submit',october,{key})).result;
 assert.equal((await f.command(partner,'report.submit',october,{key})).result.id,v1.id);
 await f.command(partner,'report.submit',october,{status:409});
 assert.equal((await f.get(partner,reportContext)).draft,null);
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,null);
 await f.command(ops,'review.report',{id:v1.id,decision:'return',note:'请核对订单凭证'});
 const returned=await f.get(partner,reportContext);
 assert.equal(returned.latestSubmittedVersion.reviewNote,'请核对订单凭证');
 const tasks=()=>f.get(partner,'/api/collections/businessTasks?outlet=cs&month=2026-10');
 const open=(await tasks()).items.find(t=>t.kind==='report_returned');
 assert.equal(open.recordId,v1.id);
 assert.equal(open.status,'open');
 const messages=(await f.get(partner,'/api/collections/messages?outlet=cs')).items;
 const notice=messages.find(m=>m.recordId===v1.id&&m.title==='月报退回');
 assert.equal((await f.command(partner,'message.read',{id:notice.id})).result.status,'read');
 assert.equal((await f.get(partner,'/api/collections/businessTasks/'+open.id)).status,'open');
 const v2=(await f.command(partner,'report.submit',{...october,orders:3})).result;
 assert.equal(v2.version,2);
 await f.command(ops,'review.report',{id:v2.id,...approved});
 await f.command(ops,'review.report',{id:v2.id,...approved},{status:409});
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,null);
 await f.command(manager,'settle',{month:'2026-10'});
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,100.15);
 const context=await f.get(partner,reportContext);
 assert.equal(context.currentApprovedVersion.id,v2.id);
 assert.equal(context.historyVersions[0].summaryOnly,true);
 assert.equal(context.historyVersions[0].orders,undefined);
 const stored=f.row('reports',v1.id);
 assert.equal(stored.orders,2);
 assert.equal(stored.status,'returned');
 assert.ok(stored.trail.some(t=>t.action==='review.report'&&t.subject==='ops'));
 const returnedTasks=(await tasks()).items.filter(t=>t.kind==='report_returned'&&t.recordId===v1.id);
 assert.deepEqual(returnedTasks.map(t=>[t.id,t.status,t.resolution]),[[open.id,'resolved','business_fact']]);
}));

test('T07: a configured 5th marks late filing, whole-month exemption and mid-month pause never fabricate zero',()=>withBusinessServer(async f=>{
 const partner=await f.login('partnerA'),ops=await f.login('ops'),manager=await f.login('manager'),finance=await f.login('finance');
 await f.command(manager,'policy.configure',{name:'验收月报日',effectiveFrom:'2026-11-01',reportDueDay:5,reason:'仅验收测试'});
 const jobs={outlet:'cs',limit:1};
 await f.command(manager,'jobs.run',jobs);
 await f.command(manager,'jobs.run',jobs);
 const lateTasks=(await f.get(partner,'/api/collections/businessTasks?outlet=cs&month=2026-10')).items.filter(t=>t.kind==='report_missing');
 assert.equal(lateTasks.length,1);
 assert.equal(lateTasks[0].dueOn,'2026-11-05');
 assert.equal(lateTasks[0].overdue,true);
 await f.command(manager,'outlet.status',{outlet:'cs',status:'paused',effectiveDate:'2026-10-15',reason:'月中暂停'});
 const late=(await f.command(partner,'report.submit',october)).result;
 assert.equal(late.dueOn,lateTasks[0].dueOn);
 assert.equal(late.late,true);
 assert.equal((await f.get(partner,'/api/collections/businessTasks/'+lateTasks[0].id)).status,'resolved');
 const hy={outlet:'hy',month:'2026-10'};
 await f.command(partner,'report.submit',{...october,...hy},{status:409});
 const exempt=(await f.command(ops,'report.exempt',{...hy,reason:'整月暂停经核验'})).result;
 const exception=(await f.command(partner,'request.submit',{outlet:'hy',type:'exemptException',data:{month:hy.month,reason:'拟核实跨期退款'}})).result;
 await f.command(finance,'review.request',{id:exception.id,...approved});
 const stats=await f.get(partner,'/api/dashboard?period=2026-10&outlet=hy');
 assert.equal(stats.reportingCoverage.exempt,1);
 assert.equal(stats.totals.revenue,null);
 assert.equal(stats.totals.enroll,null);
 assert.equal(f.row('exemptions',exempt.id).status,'approved');
 assert.equal(f.row('requests',exception.id).policyPending,true);
 const pendingRule=await f.get(partner,'/api/collections/requests/'+exception.id);
 assert.equal(pendingRule.status,'approved');
 assert.equal(pendingRule.progress.stage,'awaiting_policy');
 assert.equal(pendingRule.progress.label,'待确认生效规则');
 assert.equal((await f.get(partner,'/api/collections/reports?outlet=hy&month=2026-10')).total,0);
}));

test('T08: revenue correction stays with finance, summary review preserves source, and revocation retires its override',()=>withBusinessServer(async f=>{
 const partner=await f.login('partnerA'),ops=await f.login('ops'),manager=await f.login('manager'),finance=await f.login('finance');
 const v1=(await f.command(partner,'report.submit',october)).result;
 await f.command(ops,'review.report',{id:v1.id,...approved});
 await f.command(manager,'settle',{month:'2026-10'});
 await f.command(partner,'report.correct',{id:v1.id,correctionType:'field',fields:['revenue'],reason:'核对入账'});
 const v2=(await f.command(partner,'report.submit',{...october,revenue:'120.35'})).result;
 await f.command(ops,'review.report',{id:v2.id,...approved});
 assert.equal(f.row('reports',v2.id).status,'finance');
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,100.15);
 await f.command(ops,'review.report',{id:v2.id,...approved},{status:403});
 await f.command(finance,'review.report',{id:v2.id,...approved});
 assert.equal(f.row('reports',v1.id).revenue,100.15);
 assert.equal((await f.get(partner,reportContext)).currentApprovedVersion.id,v2.id);
 await f.command(manager,'settle',{month:'2026-10'});
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,120.35);
 const adj=(await f.command(manager,'summary.adjust',{outlet:'cs',month:'2026-10',values:{revenue:'120.50'},reason:'总部汇总核对'})).result;
 await f.command(ops,'review.adjust',{id:adj.id,...approved},{status:403});
 await f.command(finance,'review.adjust',{id:adj.id,...approved});
 await f.command(manager,'settle',{month:'2026-10'});
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,120.50);
 assert.equal(f.row('reports',v2.id).revenue,120.35);
 assert.equal(f.row('summaryAdjustments',adj.id).before.revenue,120.35);
 const revoke=(await f.command(manager,'report.revoke.request',{id:v2.id,reason:'核实误审批'})).result;
 await f.command(finance,'review.revoke',{id:revoke.id,...approved});
 assert.equal(f.row('reports',v2.id).revoked,true);
 assert.equal(f.row('reports',v2.id).revenue,120.35);
 assert.equal((await f.get(partner,reportContext)).currentApprovedVersion,null);
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,null);
 assert.equal(f.row('summaryAdjustments',adj.id).status,'needsReview');
}));

test('T09 and T10: independent receivable, cancelled and duplicate mock payments, and approved exact-cent offset',()=>withBusinessServer(async f=>{
 const partner=await f.login('partnerA'),other=await f.login('partnerB'),manager=await f.login('manager'),finance=await f.login('finance');
 const plan=(await f.command(manager,'plan.publish',{name:'验收套餐',amount:'100.10',serviceEntity:'验收主体',collectionEntity:'验收主体',invoiceEntity:'验收主体',terms:'测试整月服务',reason:'验收测试价格'})).result;
 const agreement=(await f.command(manager,'agreement.create',{outlet:'hy',planId:plan.id,startMonth:'2026-12',endMonth:'2027-12',billDay:1,dueDay:5,reference:'TEST-HY',reason:'验收测试协议'})).result;
 f.businessDate('2026-12-01');
 const data={agreementId:agreement.id,month:'2026-12'};
 const bill=(await f.command(finance,'billing.generate',data)).result;
 assert.equal((await f.command(finance,'billing.generate',data)).result.id,bill.id);
 assert.equal((await f.get(finance,'/api/collections/bills/'+bill.id)).status,'unpaid');
 assert.equal((await f.get(partner,'/api/collections/bills/'+bill.id)).amount,100.10);
 await f.get(other,'/api/collections/bills/'+bill.id,404);
 await f.command(other,'payment.start',{billId:bill.id},{status:403});
 for(const outcome of ['failed','cancelled']){
  const payment=(await f.command(partner,'payment.start',{billId:bill.id})).result;
  await f.command(partner,'payment.resolve',{id:payment.id,outcome});
  assert.equal(f.row('bills',bill.id).status,'unpaid');
 }
 const payment=(await f.command(partner,'payment.start',{billId:bill.id})).result;
 for(let i=0;i<2;i++)await f.command(partner,'payment.resolve',{id:payment.id,outcome:'success'});
 assert.equal(f.row('bills',bill.id).status,'paid');
 const receipts=f.app.store.db.prepare("SELECT amount_cents,data FROM receipts WHERE json_extract(data,'$.billId')=?").all(bill.id);
 assert.equal(receipts.length,1);
 assert.equal(receipts[0].amount_cents,10010);
 assert.equal(JSON.parse(receipts[0].data).adapterMode,'mock');
 const pause=(await f.command(partner,'request.submit',{outlet:'hy',type:'pauseFee',data:{from:'2026-12-01',to:'2026-12-15',reason:'验收暂停收费'}})).result;
 await f.command(finance,'review.request',{id:pause.id,...approved,publicNote:'同意暂停申请'});
 const pausePath='/api/collections/requests/'+pause.id;
 const stage=async token=>(await f.get(token,pausePath)).progress.stage;
 assert.equal(await stage(partner),'awaiting_calculation');
 assert.equal(await stage(finance),'awaiting_calculation');
 await f.get(other,pausePath,404);
 const approvalNotice=(await f.get(partner,'/api/collections/messages')).items
  .find(message=>message.recordId===pause.id&&message.body.includes('核算'));
 assert.ok(approvalNotice,'the original approval notice explains the remaining fee calculation');
 const pending=(await f.get(finance,'/api/collections/adjustments?outlet=hy')).items.find(x=>x.requestId===pause.id);
 assert.deepEqual([pending.amount,pending.offsetMonth,pending.serviceUntil],[null,null,null]);
 assert.equal(f.row('bills',bill.id).amount,100.10);
 assert.equal(f.row('outlets','hy').agreementEnd,'2027-12-31');
 const proposed=(await f.command(manager,'fee.adjust.propose',{adjustmentId:pending.id,amount:'10.01',offsetMonth:'2027-01',serviceUntil:null,reason:'验收专用人工核算'})).result;
 assert.equal(await stage(partner),'awaiting_finance_review');
 await f.command(finance,'fee.adjust.review',{id:proposed.id,...approved});
 assert.equal(await stage(partner),'awaiting_credit_bill');
 f.businessDate('2027-01-01');
 const next=(await f.command(finance,'billing.generate',{...data,month:'2027-01'})).result;
 assert.equal(next.amount,90.09);
 assert.equal(f.app.store.db.prepare('SELECT amount_cents FROM bills WHERE id=?').get(next.id).amount_cents,9009);
 assert.equal(f.row('adjustments',pending.id).appliedBillId,next.id);
 const requestAfter=(await f.get(partner,'/api/collections/requests?outlet=hy')).items.find(row=>row.id===pause.id);
 assert.deepEqual([requestAfter.status,requestAfter.progress.stage,requestAfter.progress.billId,requestAfter.progress.month],
  ['approved','credited',next.id,'2027-01']);
 assert.equal((await f.get(partner,'/api/collections/messages/'+approvalNotice.id)).body,approvalNotice.body);
 assert.equal(f.row('outlets','hy').agreementEnd,'2027-12-31');
}));

test('T12: settled workbook contains only the selected settlement narratives and respects role and outlet scope',()=>withBusinessServer(async f=>{
 const partner=await f.login('partnerA'),other=await f.login('partnerB'),ops=await f.login('ops'),manager=await f.login('manager'),regional=await f.login('regional');
 const narrative='仅过程数据验收标识214';
 const v1=(await f.command(partner,'report.submit',{...october,note:narrative})).result;
 await f.command(ops,'review.report',{id:v1.id,...approved});
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,null);
 assert.equal((await f.get(partner,octoberStats+'&mode=process')).totals.revenue,100.15);
 assert.equal((await f.get(partner,octoberStats)).rankings,undefined);
 assert.equal((await f.get(regional,octoberStats+'&mode=process')).totals.revenue,undefined);
 await f.get(other,octoberStats,403);
 const route='/api/export?period=2026-10&outlet=cs&format=xlsx';
 await f.get(ops,route,403);
 await f.get(other,route,403);
 assert.ok((await f.get(partner,route+'&mode=process')).includes(Buffer.from(narrative)));
 assert.equal((await f.get(partner,route)).includes(Buffer.from(narrative)),false);
 await f.command(manager,'settle',{month:'2026-10'});
 const settled=await f.get(partner,route);
 assert.ok(settled.includes(Buffer.from(narrative)));
 assert.equal(settled.includes(Buffer.from('独立排名')),false);
 assert.ok((await f.get(manager,route)).includes(Buffer.from('独立排名')));
 const pdf=await f.get(partner,route.replace('xlsx','pdf'));
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
}));

test('V3.2 scoped settlement coexists with another outlet pending while its task keeps the same id',()=>withBusinessServer(async f=>{
 const [partner,ops,manager]=await Promise.all(['partnerA','ops','manager'].map(f.login));
 const approvedReport=(await f.command(partner,'report.submit',october)).result;
 await f.command(ops,'review.report',{id:approvedReport.id,...approved});
 const pending=(await f.command(partner,'report.submit',{...october,outlet:'zz'})).result;
 const before=(await f.get(manager,'/api/tasks?queue=ops&outlet=zz&month=2026-10')).items;
 assert.equal(before.length,1);
 assert.equal(before[0].recordId,pending.id);
 await f.command(manager,'settle',{month:'2026-10'});
 assert.deepEqual((await f.get(manager,'/api/tasks?queue=ops&outlet=zz&month=2026-10')).items,before);
 assert.equal((await f.get(partner,octoberStats)).totals.revenue,100.15);
}));

test('V3.2 support configuration saves while a real support queue is active',()=>withBusinessServer(async f=>{
 const [visitor,manager]=await Promise.all(['public','manager'].map(f.login));
 const ticket=(await f.command(visitor,'support.ticket',{outlet:'cs',category:'complaint',title:'配置回归工单',description:'隔离库合成测试凭证'})).result;
 const find=async()=> (await f.get(manager,'/api/tasks?queue=hq&kind=support_queue')).items.find(item=>item.recordId===ticket.id);
 const before=await find();
 assert.ok(before);
 await f.command(manager,'support.settings',{hours:'测试客服配置',sla:{complaint:null,aftersale:null,exception:null}});
 assert.deepEqual(await find(),before);
}));

test('V3.2 legacy audit projection and new audit capture both redact sensitive text',()=>withBusinessServer(async f=>{
 const [partner,ops,manager,finance]=await Promise.all(['partnerA','ops','manager','finance'].map(f.login));
 const id=(await f.command(partner,'report.submit',october)).result.id;
 const sensitive='业务审批 API_KEY: synthetic-example-key 访客联系 sample@example.test';
 await f.command(ops,'review.report',{id,decision:'approve',note:sensitive});
 const created=f.app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.recordId')=? AND json_extract(data,'$.command')='review.report'").get(id);
 const original=JSON.parse(created.data);
 assert.doesNotMatch(original.reason,/synthetic-example-key|sample@example\.test/);
 const fixture={...original,id:'audit-v32-legacy-text',reason:sensitive};
 f.app.store.db.prepare('INSERT INTO audit(id,status,data,created_at) VALUES(?,?,?,?)').run(fixture.id,fixture.status,JSON.stringify(fixture),fixture.executedAt);
 const legacy=await f.get(manager,'/api/collections/audit/'+fixture.id);
 assert.match(legacy.reason,/业务审批/);
 assert.doesNotMatch(legacy.reason,/synthetic-example-key|sample@example\.test/);
 assert.equal(f.row('audit',fixture.id).reason,sensitive);
 assert.equal((await f.get(finance,'/api/collections/reports/'+id)).trail,undefined);
}));
