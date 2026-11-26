'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../server/index.cjs');
const config=require('../../miniprogram/config');
const api=require('../../miniprogram/utils/api');
const {openRecord}=require('../../miniprogram/utils/page');

const tap=dataset=>({currentTarget:{dataset}});
const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQMgkTMgljgFAAEA4CcV2GZ44AAAAASUVORK5CYII=';
const sameScopeError=error=>error.status===403||error.status===404;
const command=async(name,payload)=>(await api.command(name,payload)).result;

function nativePage(name,query={}){
 let definition;
 global.Page=page=>{definition=page;};
 const file=require.resolve('../../miniprogram/pages/'+name+'/index');
 delete require.cache[file];
 require(file);
 const page={...definition,data:structuredClone(definition.data),route:'pages/'+name+'/index',setData(values,callback){
  for(const [key,value] of Object.entries(values)){
   const parts=key.split('.');
   let target=this.data;
   for(const part of parts.slice(0,-1))target=target[part]||=(Object.create(null));
   target[parts.at(-1)]=value;
  }
  callback?.();
 }};
 global.getCurrentPages=()=>[page];
 page.onLoad(query);
 return page;
}

async function fixture(work){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const previous=config.apiBase;
 config.apiBase='http://127.0.0.1:'+app.server.address().port;
 const storage=new Map(),navigation=[],scrolls=[];
 global.wx={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),
  navigateTo:({url,success})=>{navigation.push(url);success?.();},switchTab:({url,success})=>{navigation.push('tab:'+url);success?.();},showToast(){},
  pageScrollTo:({selector})=>scrolls.push(selector),request:async options=>{
   let response;
   try{
    const r=await fetch(options.url,{method:options.method,headers:options.header,...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
    response={statusCode:r.status,data:await r.json()};
   }catch(error){options.fail(error);return;}
   options.success(response);
  }};
 async function messagePage(query){const page=nativePage('messages',query);await page.onShow();return page;}
 async function destination(){
  const route=navigation.at(-1).replace(/^tab:/,'');
  const url=new URL(route,'https://native.invalid');
  const page=nativePage(url.pathname.split('/')[2],Object.fromEntries(url.searchParams));
  await page.onShow();
  assert.equal(page.data.error,'');
  return page;
 }
 try{await api.login('partnerA');await work({app,navigation,scrolls,messagePage,destination});}
 finally{
  config.apiBase=previous;
  delete global.Page;delete global.getCurrentPages;delete global.wx;
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
}

test('location notifications keep internal evidence private in new messages, legacy messages, read commands and approval history',()=>fixture(async ({app,messagePage,destination,scrolls})=>{
 const file=await api.request('/api/files','POST',{name:'现场照片.png',type:'image/png',base64:png});
 const input={outlet:'cs',month:'2026-11',coords:{lat:28.2,lng:113.1,source:'gps',coordinateSystem:'GCJ-02'},address:'初次核验地址',photo:file};
 const old=await command('location.submit',input);
 const internal='GCJ-02 内部人工核验依据 fixture-only',publicNote='请补拍带有门牌号的照片。';
 await api.login('location');
 await command('location.review',{id:old.id,decision:'exception',note:internal,publicNote});
 const legacy={id:'msg-legacy-location',owner:'p1',outlet:'cs',recordId:old.id,target:'location',status:'unread',read:false,
  title:'位置异常，请解释补件',body:internal,createdAt:'2026-11-18T04:00:00.000Z'};
 const state=app.store.load();state.messages.push(legacy);app.store.save(state);
 await api.login('partnerA');
 const replacement=await command('location.submit',{...input,address:'补件核验地址',explanation:'已补交门牌照片'});
 const page=await messagePage();
 const reviewed=page.data.messages.find(row=>row.recordId===old.id&&row.body===publicNote);
 assert.ok(reviewed,'new notice must contain its explicit public note');
 assert.equal(reviewed.title,'位置待核实，请补充说明');
 assert.doesNotMatch(JSON.stringify(page.data.messages),/fixture-only/);
 for(const message of [reviewed,await api.detail('messages',legacy.id)]){
  await page.open(tap({id:message.id}));
  const location=await destination();
  assert.equal(location.data.history[0].id,old.id);
  assert.equal(location.data.history[0].publicNote,publicNote);
  assert.ok(location.data.history.some(record=>record.id===replacement.id));
  assert.equal(scrolls.at(-1),'#verification-'+old.id);
 }
 const read=await command('message.read',{id:legacy.id});
 assert.equal(read.read,true);
 assert.doesNotMatch(JSON.stringify(read),/fixture-only/);
 const history=async()=>api.request('/api/approval-history/verifications/'+old.id);
 assert.equal((await history()).items[0].note,publicNote);
 await api.login('partnerB');
 await assert.rejects(()=>openRecord(reviewed),sameScopeError);
 await api.login('location');
 assert.equal((await history()).items[0].note,internal);
}));

test('bill, channel refund, original payment, correction and fee adjustment notices select the exact authorized detail',()=>fixture(async ({app,messagePage,destination,navigation})=>{
 const bill=(await api.collection('bills',{outlet:'cs'})).items[0];
 const payment=await api.prepay(bill.id,{channel:'wechat',simulation:true});
 await api.simulatePayment(payment.paymentId,'success');
 const manager={actor:'manager',subject:'manager'};
 const refund1=await app.payments.refundPayment(manager,payment.paymentId,{amountCents:100,simulation:true},'refund-notice-first','fixture');
 await app.payments.simulateRefund(manager,refund1.id,'success','fixture');
 const refund2=await app.payments.refundPayment(manager,payment.paymentId,{amountCents:200,simulation:true},'refund-notice-second','fixture');
 await app.payments.simulateRefund(manager,refund2.id,'success','fixture');
 const state=app.store.load();
 const source=state.messages.find(row=>row.title==='模拟退款已确认');
 const oldRefund={...source,id:'msg-legacy-refund'};
 delete oldRefund.refundId;delete oldRefund.refundRequestId;
 delete state.refundRequests.find(row=>row.id==='refund-mock-'+refund1.id).customerReference;
 state.messages.push(oldRefund,{...oldRefund,id:'msg-legacy-refund-unresolved',createdAt:'2026-11-18T00:00:00.000Z'});
 const adjustment={id:'adj-notice',owner:'p1',outlet:'cs',status:'待财务核算调整',from:'2026-10-01',to:'2026-10-31',amount:null};
 state.adjustments.push(adjustment);
 app.store.save(state);
 await api.login('manager');
 const correctionBill=state.bills.find(row=>row.outlet==='zz');
 const correction=await command('billing.correct.propose',{billId:correctionBill.id,amount:100,reason:'重新计算费用'});
 const fees=await command('fee.adjust.propose',{adjustmentId:adjustment.id,amount:40,offsetMonth:'2026-12',serviceUntil:null,reason:'内部计费依据'});
 await api.login('finance');
 await command('billing.correct.review',{id:correction.id,decision:'approve',note:'通过纠错'});
 await command('fee.adjust.review',{id:fees.id,decision:'approve',note:'通过核算'});
 await api.login('partnerA');
 const page=await messagePage();
 const paymentNotice=page.data.messages.find(row=>row.recordId===bill.id&&row.title==='模拟付款已确认');
 assert.ok(paymentNotice);
 await page.open(tap({id:paymentNotice.id}));
 let detail=await destination();
 assert.equal(detail.data.ledgerBill.id,bill.id);
 assert.equal(detail.data.ledgerBill.records[0].id,payment.paymentId);
 const refundNotice=page.data.messages.find(row=>row.refundRequestId==='refund-mock-'+refund2.id);
 assert.ok(refundNotice);
 for(const [notice,id] of [[refundNotice,refund2.id],[oldRefund,refund1.id]]){
  await page.open(tap({id:notice.id}));
  detail=await destination();
  assert.equal(detail.data.selectedApplication.id,'refund-mock-'+id);
  assert.equal(detail.data.selectedApplication.originalPayment.paymentId,payment.paymentId);
  assert.doesNotMatch(detail.data.selectedApplication.reference,/wechat:mock:/);
  const stored=app.store.load().refundRequests.find(row=>row.id==='refund-mock-'+id);
  const projected=await api.detail('refundRequests',stored.id);
  assert.match(stored.reference,/^wechat:mock:/);
  assert.equal(projected.customerReference,stored.reference.replace(/^wechat:mock:/,''));
  assert.equal(projected.reference,projected.customerReference);
  detail.openOriginalPayment();
  const original=await destination();
  assert.equal(original.data.ledgerBill.id,bill.id);
  assert.equal(original.data.ledgerBill.records[0].id,stored.receiptId);
 }
 const missing=page.data.messages.find(row=>row.id==='msg-legacy-refund-unresolved');
 assert.equal(missing.hasLink,false);
 await page.open(tap({id:page.data.messages.find(row=>row.recordId===correction.id).id}));
 detail=await destination();
 assert.equal(detail.data.ledgerBill.id,correctionBill.id);
 assert.equal(detail.data.ledgerBill.records[0].id,correction.id);
 await page.open(tap({id:page.data.messages.find(row=>row.recordId===fees.id).id}));
 detail=await destination();
 assert.equal(detail.data.selectedFinanceChange.id,fees.id);
 assert.equal(detail.data.selectedFinanceChange.amountText,'40.00');
 assert.doesNotMatch(JSON.stringify(detail.data.selectedFinanceChange),/内部计费依据/);
 const count=navigation.length;
 await api.login('partnerB');
 await assert.rejects(()=>openRecord(refundNotice),sameScopeError);
 await assert.rejects(()=>openRecord(paymentNotice),sameScopeError);
 assert.equal(navigation.length,count);
}));

test('outlet, support ticket, consultation, application and monthly version notices reopen scoped records',()=>fixture(async ({messagePage,destination,navigation,scrolls})=>{
 const source={outlet:'cs',month:'2026-10',revenue:'106.59',orders:2,traffic:8,enroll:1,note:'核验月报版本'};
 const original=await command('report.submit',source);
 const ticket=await command('support.ticket',{outlet:'cs',category:'exception',title:'核验通知工单',description:'需要总部协助'});
 const chat=await command('support.chat',{text:'核验通知会话'});
 await command('support.human',{id:chat.id});
 const request=await command('request.submit',{outlet:'zz',type:'enrollment',data:{applicable:true,reason:'核验通知申请'}});
 await api.login('ops');
 await command('review.report',{id:original.id,decision:'approve'});
 await command('outlet.status',{outlet:'zz',status:'paused',effectiveDate:'2026-11-18',reason:'状态验证'});
 await api.login('partnerA');
 await assert.rejects(()=>command('report.correct',{id:original.id,correctionType:'bad',reason:'测试输入'}),{message:'请选择单字段更正或整份月报更正。'});
 await command('report.correct',{id:original.id,correctionType:'field',fields:['revenue'],reason:'核验收入差异'});
 const corrected=await command('report.submit',{...source,revenue:'125.59'});
 await api.login('ops');
 await command('review.report',{id:corrected.id,decision:'approve'});
 await api.login('support');
 for(const row of [ticket,chat]){
  await command('support.claim',{id:row.id});
  await command('support.reply',{id:row.id,text:'已收到，正在处理。'});
 }
 await api.login('partnerA');
 let page=await messagePage({status:'unread'});
 const financeNotice=page.data.messages.find(row=>row.recordId===corrected.id&&row.title==='财务复核中');
 assert.ok(financeNotice);
 const choose=async(predicate)=>{
  const notice=page.data.messages.find(predicate);
  assert.ok(notice);
  await page.open(tap({id:notice.id}));
  return notice;
 };
 for(const version of [original,corrected]){
  await choose(row=>row.recordId===version.id);
  assert.match(navigation.at(-1),new RegExp('id='+version.id+'$'));
  const report=await destination();
  assert.equal(report.data.linkedVersion.id,version.id);
  assert.equal(Number(report.data.form.revenue),version.revenue);
 }
 assert.equal((await api.detail('messages',financeNotice.id)).read,true);
 const outlet=await choose(row=>row.target==='outlets'&&row.recordId==='zz');
 assert.equal((await destination()).data.outlet.id,'zz');
 const application=await choose(row=>row.recordId===request.id);
 assert.equal((await destination()).data.requestRows[0].id,request.id);
 assert.equal(scrolls.at(-1),'#request-'+request.id);
 for(const [item,key] of [[ticket,'ticket'],[chat,'chat']]){
  await choose(row=>row.recordId===item.id);
  const support=await destination();
  assert.equal(support.data[key].id,item.id);
  assert.equal(support.data.tab,key);
  await support.backToMessages();
  page=await destination();
  assert.equal(page.data.statusFilter,'unread');
 }
 await page.filterStatus(tap({status:'read'}));
 const ticketNotice=await choose(row=>row.recordId===ticket.id);
 assert.equal(ticketNotice.read,true);
 assert.equal((await destination()).data.ticket.id,ticket.id);
 const count=navigation.length;
 await api.login('partnerB');
 for(const notice of [outlet,application,...page.data.messages.filter(row=>[ticket.id,chat.id].includes(row.recordId))]){
  await assert.rejects(()=>openRecord(notice),sameScopeError);
 }
 assert.equal(navigation.length,count);
}));

test('old scheduled notices recover outlet and month without access to the headquarters task',()=>fixture(async ({app,messagePage,destination,navigation})=>{
 await api.login('manager');
 await command('jobs.run',{});
 const state=app.store.load();
 const task=state.businessTasks.find(row=>row.kind==='location_missing'&&row.outlet==='cs'&&row.queue==='hq');
 assert.ok(task);
 const legacy={id:'msg-legacy-scheduled',owner:'p1',outlet:'cs',recordId:task.id,taskId:task.id,target:'location',status:'unread',read:false,
  title:'本月位置待核验',body:'',createdAt:'2026-11-18T04:00:00.000Z'};
 state.messages.push(legacy);
 app.store.save(state);
 await api.login('partnerA');
 await assert.rejects(()=>api.detail('businessTasks',task.id),sameScopeError);
 const page=await messagePage();
 await page.open(tap({id:legacy.id}));
 assert.equal(navigation.at(-1),'/pages/location/index?outlet=cs&month='+task.month);
 assert.equal((await destination()).data.month,task.month);
}));

test('returning from support restores the opened notification even when it is beyond the first message page',()=>fixture(async ({app,messagePage,destination,scrolls})=>{
 const chat=await command('support.chat',{text:'查询我的资料'});
 await command('support.human',{id:chat.id});
 await api.login('support');
 await command('support.claim',{id:chat.id});
 await command('support.reply',{id:chat.id,text:'已收到咨询'});
 const state=app.store.load();
 const notice=state.messages.find(row=>row.recordId===chat.id);
 for(let index=0;index<52;index++)state.messages.push({...notice,id:'msg-later-'+index,target:'outlets',recordId:'cs'});
 app.store.save(state);
 await api.login('partnerA');
 const messages=await messagePage({status:'unread'});
 assert.ok(!messages.data.messages.some(row=>row.id===notice.id));
 await messages.more(tap({collection:'messages'}));
 await messages.open(tap({id:notice.id}));
 const support=await destination();
 assert.equal(support.data.chat.id,chat.id);
 support.backToMessages();
 const returned=await destination();
 assert.equal(returned.data.messages[0].id,notice.id);
 assert.equal(scrolls.at(-1),'#notice-'+notice.id);
 await returned.open(tap({id:notice.id}));
 assert.equal((await destination()).data.chat.id,chat.id);
}));

function delayRecord(id){
 const original=wx.request;
 let complete;
 const gate=new Promise(resolve=>{complete=resolve;});
 wx.request=options=>{
  if(new URL(options.url).pathname.endsWith('/'+id)){
   return gate.then(()=>original(options));
  }
  return original(options);
 };
 return {release:complete,restore(){wx.request=original;}};
}

test('the latest tapped support history record stays open when an earlier query returns late',()=>fixture(async ()=>{
 const first=await command('support.ticket',{outlet:'cs',category:'aftersale',title:'早先选中的工单',description:'隔离样例'});
 const second=await command('support.ticket',{outlet:'zz',category:'aftersale',title:'最近选中的工单',description:'隔离样例'});
 const page=nativePage('support');
 await page.onShow();
 page.tab(tap({tab:'ticket'}));
 const pending=delayRecord(first.id);
 try {
  const opening=page.open(tap({id:first.id}));
  await page.open(tap({id:second.id}));
  assert.equal(page.data.ticket.id,second.id);
  pending.release();
  await opening;
  assert.equal(page.data.ticket.id,second.id);
 } finally {pending.release();pending.restore();}
}));

test('opening a different support ticket prevents supplements from reaching the previous record',()=>fixture(async ({app})=>{
 const first=await command('support.ticket',{outlet:'cs',category:'aftersale',title:'待补件工单甲',description:'隔离样例'});
 const second=await command('support.ticket',{outlet:'zz',category:'aftersale',title:'待补件工单乙',description:'隔离样例'});
 await api.login('support');
 for(const ticket of [first,second]){
  await command('support.claim',{id:ticket.id});
  await command('support.reply',{id:ticket.id,text:'请补充实际资料',requestSupplement:true});
 }
 await api.login('partnerA');
 const page=nativePage('support');
 await page.onShow();
 page.tab(tap({tab:'ticket'}));
 await page.open(tap({id:first.id}));
 page.setData({'form.supplement':'仅用于验证旧记录未被写入'});
 const pending=delayRecord(second.id);
 try {
  const opening=page.open(tap({id:second.id}));
  await page.supplement();
  let records=app.store.load().supportTickets;
  assert.equal(records.find(x=>x.id===first.id).status,'waiting');
  assert.equal(records.find(x=>x.id===first.id).messages.length,1);
  pending.release();
  await opening;
  assert.equal(page.data.ticket.id,second.id);
  page.setData({'form.supplement':'资料提交到正确的工单'});
  await page.supplement();
  records=app.store.load().supportTickets;
  assert.equal(records.find(x=>x.id===first.id).status,'waiting');
  const updated=records.find(x=>x.id===second.id);
  assert.equal(updated.status,'active');
  assert.equal(updated.messages.at(-1).text,'资料提交到正确的工单');
 } finally {pending.release();pending.restore();}
}));

test('support keeps the exact notification return path when system navigation fails',()=>fixture(async ({navigation})=>{
 const page=nativePage('support',{returnStatus:'unread',returnNoticeId:'msg-fixture'});
 const navigate=wx.navigateTo;
 try {
  wx.navigateTo=({fail})=>fail({errMsg:'navigateTo:fail simulated timeout'});
  page.backToMessages();
  assert.equal(page.data.returnStatus,'unread');
 } finally {wx.navigateTo=navigate;}
 page.backToMessages();
 assert.equal(navigation.at(-1),'/pages/messages/index?status=unread&id=msg-fixture');
}));
