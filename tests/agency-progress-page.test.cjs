'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server/index.cjs');
const config=require('../miniprogram/config');
const api=require('../miniprogram/utils/api');

const tap=dataset=>({currentTarget:{dataset}});

function nativePage(name,query={}){
 let definition;
 global.Page=page=>{definition=page;};
 const file=require.resolve('../miniprogram/pages/'+name+'/index');
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

async function setup(){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const previous=config.apiBase;
 config.apiBase='http://127.0.0.1:'+app.server.address().port;
 const base=config.apiBase+'/api';
 async function request(path,token,body){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  assert.equal(response.status,200,JSON.stringify(payload));
  return payload.data;
 }
 const storage=new Map(),navigation=[],toasts=[];
 global.wx={
  getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),
  navigateTo:({url,success})=>{navigation.push(url);success?.();},switchTab:({url})=>navigation.push('tab:'+url),
  showToast:({title})=>toasts.push(title),
  request:async options=>{
   try{
    const response=await fetch(options.url,{method:options.method,headers:options.header,...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
    options.success({statusCode:response.status,data:await response.json()});
   }catch(error){options.fail(error);}
  }
 };
 async function command(actor,name,payload){
  const login=await request('/auth/dev',null,{actor});
  return (await request('/commands',login.token,{command:name,payload})).result;
 }
 await command('manager','agency.level',{owner:'p1',level:1,reason:'一级代理'});
 await command('manager','agency.level',{owner:'p2',level:2,reason:'二级代理'});
 await command('manager','agency.bind',{parentOwner:'p1',childOwner:'p2',reason:'直属绑定'});
 const plan=await command('manager','plan.publish',{name:'一级代理服务',amount:'1980.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'含经营月报与下级报送',services:['monthly_report','agency_reporting'],reason:'验收协议'});
 await command('manager','agreement.create',{outlet:'cs',planId:plan.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-PAGE-001',reason:'验收协议'});
 return {app,command,navigation,toasts,restore(){config.apiBase=previous;delete global.wx;delete global.Page;delete global.getCurrentPages;}};
}

test('AGT-04 agency progress page clears stale state on identity switch and keeps month/urge interactions exact',async()=>{
 const fixture=await setup();
 const {app,command,navigation,toasts}=fixture;
 try{
  await api.login('partnerA');
  const page=nativePage('agency-progress');
  await page.onShow();
  assert.equal(page.data.hasLoaded,true);
  assert.equal(page.data.ready,true);
  assert.equal(page.data.progressError,'');
  assert.equal(page.data.month,'2026-10');
  assert.equal(page.data.monthDisplay,'2026年10月');
  assert.equal(page.data.summary.children,1);
  const before=page.data.children[0].outletRows.find(row=>row.outlet==='gz');
  assert.equal(before.statusLabel,'逾期未报');
  assert.equal(before.versionText,'尚未提交');
  assert.match(before.dueText,/应于/);

  // 账期筛选：同一页面切到上月，通过状态来自真实报告版本
  await page.month({detail:{value:'2026-09'}});
  assert.equal(page.data.month,'2026-09');
  assert.equal(page.data.children[0].outletRows[0].statusLabel,'已通过');
  assert.equal(page.data.summary.approved,1);
  assert.equal(page.data.summary.actionable,0);

  await page.month({detail:{value:'2026-10'}});
  const batch=await command('manager','import.preview',{kind:'outlets',rows:[{owner:'p2',name:'复验二号',province:'湖南',city:'株洲',district:'示范区',address:'模拟路2号',phone:'000-00000002',opening:'2026-01-01',status:'open',enrollmentApplicable:true}],reason:'双网点催报'});
  await command('manager','import.commit',{id:batch.id});
  const first=page.urge(tap({owner:'p2'})),second=page.urge(tap({owner:'p2'}));
  await Promise.all([first,second]);
  assert.match(page.data.urgeNotice,/2 条站内催报/);
  assert.equal(app.store.load().messages.filter(row=>row.agencyUrge).length,2);
  assert.ok(page.data.children[0].lastUrgedAt);

  // 切换身份：旧进度立即清空，旧响应不再回填，错误可理解且可重试
  await api.login('partnerB');
  await page.onShow();
  assert.equal(page.data.children.length,0);
  assert.equal(page.data.summary,null);
  assert.equal(page.data.ready,false);
  assert.equal(page.data.progressError,'当前账号暂无权限查看此内容。');
  await page.retry();
  assert.equal(page.data.progressError,'当前账号暂无权限查看此内容。');
  assert.equal(page.data.children.length,0);

  await api.login('partnerA');
  await page.onShow();
  assert.equal(page.data.progressError,'');
  assert.equal(page.data.ready,true);
  assert.equal(page.data.children.length,1);

  // 旧响应即使晚到也不能回填到已切换的页面
  const pending=page.loadProgress();
  page._serial++;
  await pending;
  assert.equal(page.data.ready,false);
  assert.equal(page.data.children.length,0);
  assert.equal(page.data.summary,null);
  await page.onShow();
  assert.equal(page.data.children.length,1);

  // 解绑后同一入口仍可访问，但直属下级为空且不显示旧行
  await command('manager','agency.unbind',{childOwner:'p2',reason:'终止直属关系'});
  await page.onShow();
  assert.equal(page.data.ready,true);
  assert.equal(page.data.children.length,0);
  assert.equal(page.data.summary.children,0);
  assert.equal(page.data.summary.outlets,0);
  // 无有效协议时页面给出明确原因，而不是笼统 403
  app.store.db.prepare("DELETE FROM agreements WHERE owner='p1'").run();
  await page.onShow();
  assert.equal(page.data.ready,false);
  assert.equal(page.data.progressError,'当前主体尚未签订服务协议，不能使用下级报送，请联系总部确认。');
  assert.deepEqual(navigation,[]);
  assert.deepEqual(toasts,[]);
 }finally{
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
  fixture.restore();
 }
});