'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {test}=require('node:test');
const {createServer}=require('../server/index.cjs');
const config=require('../miniprogram/config');
const {openRecord}=require('../miniprogram/utils/page');
const api=require('../miniprogram/utils/api');

async function withServer(run){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port+'/api';
 async function request(path,token,body,status=200){
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})};
  const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  assert.equal(response.status,status,JSON.stringify(payload));
  return payload;
 }
 const data=async(path,token,body,status)=> (await request(path,token,body,status)).data;
 const command=async(token,name,payload,status=200)=>(await data('/commands',token,{command:name,payload},status))?.result;
 const login=async actor=>(await data('/auth/dev',null,{actor})).token;
 const manager=await login('manager');
 async function staff(subject,role){
  await command(manager,'staff.create',{subject,name:subject,role,reason:'分级代理隔离验收岗位'});
  const invite=(await data('/auth/activation',manager,{actor:subject,username:subject}));
  return (await data('/auth/activate',null,{token:invite.token,password:randomUUID()+'-Agency-Test'}));
 }
 try{await run({app,request,data,command,login,manager,staff});}
 finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();}
}

test('AGT-02 bind→progress→urge→draft→submit→HQ return→resubmit→approve keeps one original outlet-month chain',async()=>{
 await withServer(async({app,request,data,command,login,manager,staff})=>{
  const primary=await login('partnerA'),secondary=await login('partnerB');
  await command(manager,'agency.level',{owner:'p1',level:1,reason:'总部确认一级代理'});
  await command(manager,'agency.level',{owner:'p2',level:2,reason:'总部确认二级代理'});
  await command(manager,'agency.bind',{parentOwner:'p1',childOwner:'p2',reason:'直属绑定'});
  const plan=await command(manager,'plan.publish',{name:'一级代理服务',amount:'1980.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'含经营月报与下级报送',services:['monthly_report','agency_reporting'],reason:'验收协议'});
  await command(manager,'agreement.create',{outlet:'cs',planId:plan.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-LOOP-001',reason:'验收协议'});
  const batch=await command(manager,'import.preview',{kind:'outlets',rows:[{owner:'p2',name:'株洲二级网点B',province:'湖南',city:'株洲',district:'示范区',address:'株洲市模拟路2号',phone:'000-00000002',opening:'2026-01-01',status:'open',enrollmentApplicable:false}],reason:'分级代理隔离建档'});
  assert.equal(batch.errorCount,0);
  await command(manager,'import.commit',{id:batch.id});
  const secondOutlet=app.store.load().outlets.find(outlet=>outlet.owner==='p2'&&outlet.id!=='gz').id;
  await command(manager,'outlet.status',{outlet:secondOutlet,status:'paused',effectiveDate:'2026-10-01',reason:'整月暂停营业'});
  await command(manager,'report.exempt',{outlet:secondOutlet,month:'2026-10',reason:'完整暂停营业，核实免报'});

  // 未报 / 不适用
  let progress=await data('/agency/progress?month=2026-10',primary);
  assert.equal(progress.summary.children,1);
  const statuses=Object.fromEntries(progress.children[0].outlets.map(row=>[row.outlet,row.status]));
  assert.equal(statuses.gz,'overdue');
  assert.equal(statuses[secondOutlet],'exempt');
  assert.equal(progress.summary.actionable,1);

  // 一级催报只针对未报网点；重复与越权均拒绝
  const urged=await command(primary,'agency.urge',{childOwner:'p2',month:'2026-10'});
  assert.equal(urged.agencyUrgeSummary.outletCount,1);
  await command(primary,'agency.urge',{childOwner:'p2',month:'2026-10'},409);
  await command(secondary,'agency.urge',{childOwner:'p2',month:'2026-10'},403);

  // 二级从我的事项收到同网点同账期通知
  const notices=(await data('/collections/messages',secondary)).items.filter(row=>row.agencyUrge);
  assert.equal(notices.length,1);
  assert.equal(notices[0].target,'reports');
  assert.equal(notices[0].outlet,'gz');
  assert.equal(notices[0].month,'2026-10');
  assert.equal(notices[0].recordId,'gz');
  assert.equal(notices[0].owner,'p2');

  // 草稿复用→提交，原单为同网点同自然月
  const draft=await command(secondary,'report.draft',{outlet:'gz',month:'2026-10',revenue:'1000.00',orders:20,traffic:80,enroll:2,note:'收到催报先存草稿'});
  const context=await data('/reports/context?outlet=gz&month=2026-10',secondary);
  assert.equal(context.draft.id,draft.id);
  assert.equal(context.draft.revenue,1000);
  assert.equal(context.eligibility.canSubmit,true);
  const v1=await command(secondary,'report.submit',{outlet:'gz',month:'2026-10',revenue:'1000.00',orders:20,traffic:80,enroll:2,note:'一级催报后首次报送'});
  assert.equal(v1.status,'pending');
  assert.equal(v1.version,1);
  assert.equal(v1.outlet,'gz');
  assert.equal(v1.month,'2026-10');
  assert.equal(v1.owner,'p2');
  assert.equal(v1.current,false);
  assert.equal(app.store.load().drafts.length,0);

  progress=await data('/agency/progress?month=2026-10',primary);
  assert.equal(progress.children[0].outlets.find(row=>row.outlet==='gz').status,'pending');
  assert.equal(progress.summary.actionable,0);
  await command(primary,'agency.urge',{childOwner:'p2',month:'2026-10'},409);

  // 同岗位两名经办人：被分派以外的人不能审核
  const opsA=await staff('agency_ops_a','ops'),opsB=await staff('agency_ops_b','ops');
  const queue=(await data('/tasks?queue=ops&status=open&outlet=gz',manager)).items.filter(row=>row.kind==='report_review');
  assert.equal(queue.length,1);
  assert.equal(queue[0].recordId,v1.id);
  await command(manager,'task.assign',{id:queue[0].id,assigneeRole:'ops',assigneeUserId:'agency_ops_a',note:'由运营甲跟进该月报'});
  await command(opsB.token,'review.report',{id:v1.id,decision:'return',note:'请补充订单说明'},403);
  await command(opsA.token,'review.report',{id:v1.id,decision:'return',note:'请补充订单说明'});
  const returned=await data('/collections/reports/'+v1.id,secondary);
  assert.equal(returned.status,'returned');
  assert.equal(returned.reviewNote,'请补充订单说明');
  progress=await data('/agency/progress?month=2026-10',primary);
  assert.equal(progress.children[0].outlets.find(row=>row.outlet==='gz').status,'returned');
  assert.equal(progress.summary.actionable,1);

  // 退回后重提为同网点同月的新版本，原版本保留
  await command(secondary,'report.submit',{outlet:'gz',month:'2026-10',revenue:'1000.00',orders:20,traffic:80,enroll:2,note:'一级催报后首次报送'},409);
  const v2=await command(secondary,'report.submit',{outlet:'gz',month:'2026-10',revenue:'1200.00',orders:24,traffic:90,enroll:2,note:'已按退回意见补充订单说明'});
  assert.equal(v2.version,2);
  assert.equal(v2.status,'pending');
  assert.equal(v2.current,false);
  assert.equal(v2.correctionOf??null,null);
  assert.notEqual(v2.id,v1.id);
  const history=await data('/reports/context?outlet=gz&month=2026-10',secondary);
  assert.deepEqual(history.historyVersions.map(row=>[row.version,row.status,row.id]),[[1,'returned',v1.id],[2,'pending',v2.id]]);

  // 总部从原队列审核通过
  const queue2=(await data('/tasks?queue=ops&status=open&outlet=gz',manager)).items.filter(row=>row.kind==='report_review');
  assert.equal(queue2.length,1);
  assert.equal(queue2[0].recordId,v2.id);
  await command(manager,'task.assign',{id:queue2[0].id,assigneeRole:'ops',assigneeUserId:'agency_ops_a',note:'重提版本继续由运营甲审核'});
  await command(opsA.token,'review.report',{id:v2.id,decision:'approve',note:'退回意见已处理'});
  const approved=await data('/collections/reports/'+v2.id,secondary);
  assert.equal(approved.status,'approved');
  assert.equal(approved.current,true);
  assert.equal(app.store.load().reports.filter(row=>row.outlet==='gz'&&row.month==='2026-10').length,2);
  progress=await data('/agency/progress?month=2026-10',primary);
  assert.equal(progress.children[0].outlets.find(row=>row.outlet==='gz').status,'approved');
  assert.equal(progress.summary.approved,1);
  assert.equal(progress.summary.actionable,0);
  await command(primary,'agency.urge',{childOwner:'p2',month:'2026-10'},409);

  // 催报通知直接带网点与账期；提交、退回、通过通知通过原单编号指向同一网点与账期
  const noticesAfter=(await data('/collections/messages',secondary)).items;
  const urgeNotice=noticesAfter.filter(row=>row.agencyUrge);
  assert.equal(urgeNotice.length,1);
  assert.equal(urgeNotice[0].outlet,'gz');
  assert.equal(urgeNotice[0].month,'2026-10');
  const reportNotices=noticesAfter.filter(row=>row.recordId===v1.id||row.recordId===v2.id);
  assert.ok(reportNotices.length>=3);
  assert.ok(reportNotices.some(row=>row.recordId===v1.id&&row.title==='月报退回'));
  assert.ok(reportNotices.some(row=>row.recordId===v2.id&&row.title.includes('月报批准')));
 });
});

test('AGT-02 urge notice opens the exact outlet and month through the native report route',async()=>{
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port+'/api';
 const previous=config.apiBase;
 config.apiBase='http://127.0.0.1:'+app.server.address().port;
 const storage=new Map(),navigations=[];
 global.wx={
  getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),
  navigateTo:({url,success})=>{navigations.push(url);success?.();},switchTab:({url})=>navigations.push(url),showToast(){},
  request:async options=>{
   try{
    const response=await fetch(options.url,{method:options.method,headers:options.header,...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
    options.success({statusCode:response.status,data:await response.json()});
   }catch(error){options.fail(error);}
  }
 };
 try{
  const manager=(await (await fetch(base+'/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:'manager'})})).json()).data.token;
  const send=async(actor,name,payload)=>{
   const response=await fetch(base+'/commands',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+actor,'Idempotency-Key':randomUUID()},body:JSON.stringify({command:name,payload})});
   const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.data.result;
  };
  await send(manager,'agency.level',{owner:'p1',level:1,reason:'一级代理'});
  await send(manager,'agency.level',{owner:'p2',level:2,reason:'二级代理'});
  await send(manager,'agency.bind',{parentOwner:'p1',childOwner:'p2',reason:'直属绑定'});
  const plan=await send(manager,'plan.publish',{name:'一级代理服务',amount:'1980.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'含经营月报与下级报送',services:['monthly_report','agency_reporting'],reason:'验收协议'});
  await send(manager,'agreement.create',{outlet:'cs',planId:plan.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-LOOP-002',reason:'验收协议'});
  await api.login('partnerA');
  await api.command('agency.urge',{childOwner:'p2',month:'2026-10'});
  await api.login('partnerB');
  const notice=(await api.collection('messages',{limit:20})).items.find(row=>row.agencyUrge);
  assert.ok(notice);
  await openRecord(notice);
  assert.deepEqual(navigations,['/pages/report/index?outlet=gz&month=2026-10']);
  await openRecord({...notice,id:'msg-foreign'});
  assert.deepEqual(navigations,['/pages/report/index?outlet=gz&month=2026-10','/pages/report/index?outlet=gz&month=2026-10']);
  await api.login('partnerA');
  await assert.rejects(()=>openRecord(notice),error=>[403,404].includes(error.status));
  assert.equal(navigations.length,2);
 }finally{
  config.apiBase=previous;
  delete global.wx;
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
});