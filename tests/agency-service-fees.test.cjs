'use strict';
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {test}=require('node:test');
const {createServer}=require('../server/index.cjs');

async function withServer(run){
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port+'/api';
 async function request(path,token,body,status=200,key=randomUUID()){
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':key}:{})};
  const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  assert.equal(response.status,status,JSON.stringify(payload));
  return payload;
 }
 const data=async(path,token,body,status,key)=>(await request(path,token,body,status,key)).data;
 const command=async(token,name,payload,status=200,key)=>(await data('/commands',token,{command:name,payload},status,key))?.result;
 const login=async actor=>(await data('/auth/dev',null,{actor})).token;
 try{await run({app,request,data,command,login});}
 finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();}
}

test('AGT-03 two isolated agreements drive different services, permissions and integer-cent bills',async()=>{
 await withServer(async({app,request,data,command,login})=>{
  const manager=await login('manager'),finance=await login('finance');
  const primary=await login('partnerA'),secondary=await login('partnerB');
  const planA=await command(manager,'plan.publish',{name:'一级代理服务协议',amount:'1980.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'含经营月报、直属下级进度与站内催报',services:['monthly_report','agency_reporting'],reason:'分级代理测试协议甲'});
  const planB=await command(manager,'plan.publish',{name:'二级代理服务协议',amount:'980.50',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'含经营月报与位置核验',services:['monthly_report','location_verification'],reason:'分级代理测试协议乙'});
  assert.deepEqual(planA.services,['monthly_report','agency_reporting']);
  assert.deepEqual(planB.services,['monthly_report','location_verification']);
  await request('/commands',manager,{command:'plan.publish',payload:{name:'非法服务',amount:'1.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'无效',services:['agency_reporting','not_a_service'],reason:'校验'}},400);
  const agrA=await command(manager,'agreement.create',{outlet:'cs',planId:planA.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-A-001',reason:'一级代理协议甲'});
  const agrB=await command(manager,'agreement.create',{outlet:'gz',planId:planB.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-B-001',reason:'二级代理协议乙'});
  assert.notEqual(agrA.id,agrB.id);

  // 服务入口和说明随所属协议变化
  const contextA=await data('/context',primary),contextB=await data('/context',secondary);
  assert.equal(contextA.entitlements.items.length,1);
  assert.equal(contextA.entitlements.items[0].agreementId,agrA.id);
  assert.equal(contextA.entitlements.items[0].amountCents,198000);
  assert.deepEqual(contextA.entitlements.services.sort(),['agency_reporting','monthly_report']);
  assert.match(contextA.entitlements.items[0].terms,/下级/);
  assert.equal(contextB.entitlements.items[0].agreementId,agrB.id);
  assert.equal(contextB.entitlements.items[0].amountCents,98050);
  assert.ok(!contextB.entitlements.services.includes('agency_reporting'));
  assert.doesNotMatch(contextB.entitlements.items[0].terms,/下级/);

  // 各自只能读取自己的协议；直接请求对方协议返回404
  const listA=await data('/collections/agreements',primary);
  const listB=await data('/collections/agreements',secondary);
  assert.deepEqual(listA.items.map(row=>row.id),[agrA.id]);
  assert.deepEqual(listB.items.map(row=>row.id),[agrB.id]);
  await request('/collections/agreements/'+agrB.id,primary,null,404);
  await request('/collections/agreements/'+agrA.id,secondary,null,404);

  // 账单按对应主体协议生成，金额以整数分核对
  const billA=await command(finance,'billing.generate',{agreementId:agrA.id,month:'2026-10'});
  const billB=await command(manager,'billing.generate',{agreementId:agrB.id,month:'2026-10'});
  assert.equal(billA.amount,1980);
  assert.equal(billB.amount,980.5);
  const rowA=app.store.db.prepare('SELECT owner,outlet,amount_cents,data FROM bills WHERE id=?').get(billA.id);
  const rowB=app.store.db.prepare('SELECT owner,outlet,amount_cents,data FROM bills WHERE id=?').get(billB.id);
  assert.deepEqual({owner:rowA.owner,outlet:rowA.outlet,amount_cents:rowA.amount_cents},{owner:'p1',outlet:'cs',amount_cents:198000});
  assert.deepEqual({owner:rowB.owner,outlet:rowB.outlet,amount_cents:rowB.amount_cents},{owner:'p2',outlet:'gz',amount_cents:98050});
  const storedA=JSON.parse(rowA.data),storedB=JSON.parse(rowB.data);
  assert.equal(storedA.agreementId,agrA.id);
  assert.equal(storedA.priceVersion,planA.id);
  assert.equal(storedA.serviceEntity,'九盈集团');
  assert.equal(storedB.agreementId,agrB.id);
  assert.equal(storedB.priceVersion,planB.id);
  // 重复生成同协议同月返回原账单，不产生第二张
  const again=await command(finance,'billing.generate',{agreementId:agrA.id,month:'2026-10'});
  assert.equal(again.id,billA.id);
  assert.equal(app.store.load().bills.filter(row=>row.outlet==='cs'&&row.month==='2026-10').length,1);

  // 前端若发起跨主体付款，服务端拒绝；本人付款生成同额实收
  await request('/commands',primary,{command:'payment.start',payload:{billId:billB.id}},403);
  const payA=await command(primary,'payment.start',{billId:billA.id});
  await command(primary,'payment.resolve',{id:payA.id,outcome:'success'});
  const payB=await command(secondary,'payment.start',{billId:billB.id});
  await command(secondary,'payment.resolve',{id:payB.id,outcome:'success'});
  const receiptA=app.store.load().receipts.find(row=>row.billId===billA.id);
  const receiptB=app.store.load().receipts.find(row=>row.billId===billB.id);
  assert.equal(receiptA.amount,1980);
  assert.equal(receiptB.amount,980.5);
  assert.equal(app.store.db.prepare('SELECT amount_cents FROM receipts WHERE id=?').get(receiptA.id).amount_cents,198000);
  assert.equal(app.store.db.prepare('SELECT amount_cents FROM receipts WHERE id=?').get(receiptB.id).amount_cents,98050);
  await request('/collections/receipts/'+receiptB.id,primary,null,404);

  // 同一写请求重试沿用原幂等键；改负载必须换键
  const key=randomUUID();
  const draftPayload={command:'report.draft',payload:{outlet:'cs',month:'2026-07',revenue:'500.00',orders:5,traffic:20,enroll:1,note:'幂等测试草稿'}};
  const first=await data('/commands',primary,draftPayload,200,key);
  const retry=await data('/commands',primary,draftPayload,200,key);
  assert.equal(retry.replayed,true);
  assert.equal(retry.result.id,first.result.id);
  const conflict=await request('/commands',primary,{command:'report.draft',payload:{...draftPayload.payload,revenue:'501.00'}},409,key);
  assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');

  // 价格版本更新不改变已签协议快照与既有账单；新账单仍按协议版本计价
  const planA2=await command(manager,'plan.publish',{name:'一级代理服务协议',amount:'2180.00',serviceEntity:'九盈集团',collectionEntity:'九盈集团',invoiceEntity:'九盈集团',terms:'更新后的价格版本',services:['monthly_report','agency_reporting'],reason:'价格调整'});
  assert.notEqual(planA2.id,planA.id);
  const oldBill=app.store.load().bills.find(row=>row.id===billA.id);
  assert.equal(oldBill.amount,1980);
  assert.equal(oldBill.priceVersion,planA.id);
  const billA3=await command(finance,'billing.generate',{agreementId:agrA.id,month:'2026-09'});
  assert.equal(billA3.amount,1980);
  assert.equal(billA3.priceVersion,planA.id);

  // 未知金额保留 null，不以0代替
  const pause=await command(primary,'request.submit',{type:'pauseFee',outlet:'cs',data:{from:'2026-12-01',to:'2026-12-31',reason:'整月暂停收费测试'}});
  await command(manager,'review.request',{id:pause.id,decision:'approve',note:'同意暂停收费'});
  const adjustment=app.store.db.prepare("SELECT amount_cents,data FROM adjustments WHERE json_extract(data,'$.requestId')=?").get(pause.id);
  assert.equal(adjustment.amount_cents,null);
  assert.equal(JSON.parse(adjustment.data).amount,null);
  const adjustments=await data('/collections/adjustments',primary);
  assert.equal(adjustments.items.find(row=>row.requestId===pause.id).amount,null);

  // 服务协议决定「下级报送」办理权限：前端入口可见，服务端按协议拒绝
  const created=await command(manager,'account.create',{name:'戊一级',managerName:'负责人戊',mobile:'13800000005'});
  const orgE=created.owner;
  await command(manager,'agency.level',{owner:orgE,level:1,reason:'一级代理'});
  const batch=await command(manager,'import.preview',{kind:'outlets',rows:[{owner:orgE,name:'戊网点一',province:'湖南',city:'长沙',district:'示范区',address:'长沙市戊路1号',phone:'000-00000005',opening:'2026-01-01',status:'open',enrollmentApplicable:true}],reason:'分级服务测试建档'});
  assert.equal(batch.errorCount,0);
  const committed=await command(manager,'import.commit',{id:batch.id});
  const outletE=committed.createdIds[0];
  await command(manager,'agreement.create',{outlet:outletE,planId:planB.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-E-001',reason:'二级服务协议，不含下级管理'});
  const loginE=await login('partner:'+orgE);
  const contextE=await data('/context',loginE);
  assert.equal(contextE.agency.isPrimary,true);
  assert.ok(!contextE.entitlements.services.includes('agency_reporting'));
  const denied=await request('/agency/progress?month=2026-10',loginE,undefined,403);
  assert.match(denied.error.message,/服务协议/);
  // 增加含下级管理的协议后，同一入口的服务端校验通过
  const batch2=await command(manager,'import.preview',{kind:'outlets',rows:[{owner:orgE,name:'戊网点二',province:'湖南',city:'长沙',district:'示范区',address:'长沙市戊路2号',phone:'000-00000006',opening:'2026-01-01',status:'open',enrollmentApplicable:true}],reason:'分级服务测试建档'});
  const committed2=await command(manager,'import.commit',{id:batch2.id});
  await command(manager,'agreement.create',{outlet:committed2.createdIds[0],planId:planA.id,startMonth:'2026-01',endMonth:'2026-12',billDay:1,dueDay:5,reference:'AGT-E-002',reason:'补充一级服务协议'});
  const allowed=await data('/agency/progress?month=2026-10',loginE);
  assert.equal(allowed.summary.children,0);
 });
});