'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../server/storage.cjs');
const {paymentService}=require('../server/payments.cjs');

const who={actor:'partnerA',subject:'partnerA'};
const manager={actor:'manager',subject:'manager'};

test('both simulated channels settle once, retain failed attempts and allow verified mock refunds',async()=>{
 const store=openStore(':memory:');
 try{
  const service=paymentService(store,{NODE_ENV:'test',ADAPTER_MODE:'mock'},{},()=>assert.fail('simulation must not call external services'));
  const [first,second,third]=store.load().bills;
  assert.equal(service.capabilities.mock,true);
  const failed=await service.prepay(who,{billId:first.id,channel:'wechat',simulation:true},'mock-first-failed','test');
  assert.equal((await service.simulate(who,failed.paymentId,'failed','test')).payment.status,'failed');
  const cancelled=await service.prepay(who,{billId:first.id,channel:'alipay',simulation:true},'mock-first-cancel','test');
  assert.equal((await service.simulate(who,cancelled.paymentId,'cancelled','test')).payment.status,'cancelled');
  for(const [bill,channel] of [[first,'wechat'],[second,'alipay']]){
   const started=await service.prepay(who,{billId:bill.id,channel,simulation:true},'mock-acceptance-'+channel,'test');
   assert.equal(started.adapterMode,'mock');
   assert.equal(started.channel,channel);
   assert.equal((await service.query(who,started.paymentId,'test')).payment.status,'pending');
   assert.equal((await service.reconcilePayment(manager,started.paymentId,'pending-reconcile')).status,'pending');
   await assert.rejects(service.prepay(who,{billId:bill.id,channel:channel==='wechat'?'alipay':'wechat',simulation:true},'mock-cross-channel-'+channel,'test'),{code:'PAYMENT_IN_PROGRESS'});
   const posted=await service.simulate(who,started.paymentId,'success','test');
   await service.simulate(who,started.paymentId,'success','replay');
   assert.equal(posted.bill.status,'paid');
   assert.equal((await service.reconcilePayment(manager,started.paymentId,'success-reconcile')).status,'matched');
   assert.equal(posted.payment.channel,channel);
   assert.equal(store.load().receipts.filter(r=>r.billId===bill.id).length,1);
   await assert.rejects(service.prepay(who,{billId:bill.id,channel,simulation:true},'mock-paid-'+channel,'test'),{code:'CONFLICT'});
   const failedRefund=await service.refundPayment(manager,started.paymentId,{amountCents:100,simulation:true},'mock-refund-fail-'+channel,'test');
   await service.simulateRefund(manager,failedRefund.id,'failed','test');
   assert.equal((await service.queryRefund(who,failedRefund.id,'test')).status,'failed');
   const refund=await service.refundPayment(manager,started.paymentId,{amountCents:100,simulation:true},'mock-refund-ok-'+channel,'test');
   await service.simulateRefund(manager,refund.id,'success','test');
   await service.simulateRefund(manager,refund.id,'success','replay');
   assert.equal((await service.queryRefund(who,refund.id,'test')).status,'success');
   const recorded=store.load().refundRequests.filter(r=>r.billId===bill.id&&r.status==='recorded');
   assert.equal(recorded.length,1);
   assert.equal(recorded[0].amount,1);
  }
  assert.equal(store.db.prepare('SELECT count(*) n FROM payment_reconciliation_records').get().n,4);
  const disabled=paymentService(store,{NODE_ENV:'production',ADAPTER_MODE:'mock'},{});
  assert.equal(disabled.capabilities.mock,false);
  await assert.rejects(disabled.prepay(who,{billId:third.id,channel:'alipay',simulation:true},'mock-disabled-order','test'),{code:'MOCK_DISABLED'});
  await assert.rejects(service.prepay(who,{billId:third.id,channel:'alipay'},'real-not-configured','test'),{code:'REAL_ADAPTER_UNAVAILABLE'});
 }finally{store.close();}
});
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {canonical}=require('../server/alipay.cjs');

test('Alipay RSA2 and agreement mapping gate every charge and verified refund',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jy-payment-fixtures-'));
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const providerKeys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const privatePath=path.join(dir,'merchant.pem'),publicPath=path.join(dir,'provider.pem');
 fs.writeFileSync(privatePath,keys.privateKey.export({type:'pkcs8',format:'pem'}));
 fs.writeFileSync(publicPath,providerKeys.publicKey.export({type:'spki',format:'pem'}));
 t.after(()=>{fs.unlinkSync(privatePath);fs.unlinkSync(publicPath);fs.rmdirSync(dir);});
 const store=openStore(':memory:');
 t.after(()=>store.close());
 const env={NODE_ENV:'test',ADAPTER_MODE:'real',ALIPAY_ENABLED:'1',ALIPAY_PRODUCT:'wap',ALIPAY_PRODUCT_AUTHORIZED:'1',
  ALIPAY_APP_ID:'local-app-fixture',ALIPAY_MERCHANT_ID:'local-seller-fixture',
  ALIPAY_GATEWAY:'https://openapi.alipay.com/gateway.do',ALIPAY_NOTIFY_URL:'https://test.invalid/api/payments/alipay/notify',
  ALIPAY_PRIVATE_KEY_PATH:privatePath,ALIPAY_PUBLIC_KEY_PATH:publicPath};
 const entity='隔离测试协议主体';
 const merchant={merchantId:env.ALIPAY_MERCHANT_ID,appId:env.ALIPAY_APP_ID};
 const mapping=merchant=>JSON.stringify({[entity]:{alipay:merchant}});
 let contacted=0,status='WAIT_BUYER_PAY',refundStatus='REFUND_SUCCESS';
 const sign=raw=>crypto.sign('RSA-SHA256',Buffer.from(raw),providerKeys.privateKey).toString('base64');
 const makeNotification=(fields,signature)=>new URLSearchParams({...fields,sign_type:'RSA2',sign:signature||sign(canonical(fields))}).toString();
 const contract=()=>{const state=store.load(), bill=state.bills[0];
  Object.assign(bill,{agreementId:'pay-fixture-agreement',collectionEntity:entity,currency:'CNY'});
  state.agreements.push({id:bill.agreementId,owner:bill.owner,outlet:bill.outlet,status:'active',priceSnapshot:{collectionEntity:entity}});
  store.transaction(()=>store.save(state));
 };
 const provider=async(url,options)=>{
  contacted++;
  assert.equal(url,env.ALIPAY_GATEWAY);
  assert.equal(options.redirect,'error');
  const {sign:signature,...p}=Object.fromEntries(options.body);
  assert.ok(crypto.verify('RSA-SHA256',Buffer.from(canonical(p)),keys.publicKey,Buffer.from(signature,'base64')));
  const biz=JSON.parse(p.biz_content);
  const data={code:'10000',out_trade_no:biz.out_trade_no,trade_no:'alipay-unique-test-reference'};
  if(p.method==='alipay.trade.query')Object.assign(data,{trade_status:status,total_amount:'1980.00',seller_id:env.ALIPAY_MERCHANT_ID,app_id:env.ALIPAY_APP_ID,send_pay_date:'2026-11-18 12:00:00'});
  if(p.method==='alipay.trade.close')status='TRADE_CLOSED';
  if(p.method==='alipay.trade.fastpay.refund.query')Object.assign(data,{out_request_no:biz.out_request_no,refund_amount:'100.01',refund_status:refundStatus});
  if(p.method==='alipay.trade.refund')assert.equal(biz.refund_amount,'100.01');
  const raw=JSON.stringify(data);
  return new Response('{"'+p.method.replaceAll('.','_')+'_response":'+raw+',"sign":"'+sign(raw)+'"}');
 };
 const service=paymentService(store,env,{},provider);
 const bill=store.load().bills[0],input={billId:bill.id,channel:'alipay'};
 await assert.rejects(service.prepay(who,input,'no-contract-key','bad-contract'),{code:'PAY_CONTRACT_MISMATCH'});
 contract();
 await assert.rejects(service.prepay(who,input,'no-mapping-key','mapping-missing'),{code:'PAY_MERCHANT_MAPPING'});
 env.PAYMENT_MERCHANT_MAPPINGS=mapping({...merchant,merchantId:'wrong-local-seller'});
 await assert.rejects(service.prepay(who,input,'wrong-merchant-key','mapping-does-not-match'),{code:'PAY_MERCHANT_MISMATCH'});
 assert.equal(contacted,0);
 assert.equal(store.load().payments.length,0);
 assert.equal(store.load().receipts.length,0);
 assert.equal(store.load().audit.filter(r=>r.command==='payment.merchant.rejected').length,3);

 env.PAYMENT_MERCHANT_MAPPINGS=mapping(merchant);
 const order=await service.prepay(who,input,'configured-test-order','test');
 const checkout=new URL(order.checkout.checkoutUrl),fields=Object.fromEntries(checkout.searchParams);
 const {sign:signature,...params}=fields;
 assert.ok(crypto.verify('RSA-SHA256',Buffer.from(canonical(params)),keys.publicKey,Buffer.from(signature,'base64')));
 assert.equal(params.method,'alipay.trade.wap.pay');
 const biz=JSON.parse(params.biz_content);
 assert.equal(biz.total_amount,'1980.00');
 assert.equal((await service.query(who,order.paymentId,'timeout-recovery')).payment.status,'pending');

 const notice={notify_id:'local-signed-notification',out_trade_no:biz.out_trade_no,
  trade_no:'alipay-unique-test-reference',trade_status:'TRADE_SUCCESS',total_amount:'1980.00',app_id:env.ALIPAY_APP_ID,seller_id:env.ALIPAY_MERCHANT_ID,gmt_payment:'2026-11-18 12:00:00'};
 for(const changed of [{app_id:'wrong-app'},{seller_id:'wrong-seller'},{total_amount:'0.01'},{currency:'USD'}]){
  assert.throws(()=>service.notify({},makeNotification({...notice,...changed}),'mismatch','alipay'),{code:'PAY_MISMATCH'});
 }
 assert.throws(()=>service.notify({},makeNotification(notice,'Zm9yZ2Vk'),'bad-signature','alipay'),{code:'PAY_SIGNATURE'});
 assert.equal(store.load().receipts.length,0);
 const raw=makeNotification(notice);
 const paid=service.notify({},raw,'verified','alipay');
 assert.equal(paid.bill.status,'paid');
 service.notify({},raw,'duplicate','alipay');
 const receipt=store.load().receipts[0];
 assert.equal(receipt.channel,'alipay');
 assert.equal(receipt.collectionEntity,entity);
 assert.equal(receipt.merchantId,env.ALIPAY_MERCHANT_ID);
 assert.equal(receipt.amount,1980);
 assert.equal(store.load().receipts.length,1);

 const current=store.load();
 current.refundRequests.push({id:'approved-refund-fixture',owner:bill.owner,outlet:bill.outlet,status:'approved',billId:bill.id,receiptId:receipt.id,amount:100.01});
 store.transaction(()=>store.save(current));
 const refund=await service.refundPayment(manager,order.paymentId,{refundRequestId:'approved-refund-fixture'},'alipay-refund-test','test');
 assert.equal(refund.status,'success');
 const refundNotice=makeNotification({notify_id:'local-refund-notice',out_biz_no:refund.id,out_trade_no:biz.out_trade_no,seller_id:env.ALIPAY_MERCHANT_ID,app_id:env.ALIPAY_APP_ID});
 await service.notifyRefund({},refundNotice,'refund-notify','alipay');
 await service.notifyRefund({},refundNotice,'refund-repeat','alipay');
 assert.equal(store.load().refundRequests.filter(r=>r.status==='recorded').length,1);
 assert.equal(store.load().bills[0].refundAmount,100.01);
 assert.equal(store.load().bills[0].status,'paid');
 assert.equal(store.db.prepare('SELECT count(*) n FROM payment_refund_notifications').get().n,1);
});
test('WeChat refund adapter validates authenticated response and refund notification',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jy-wx-refund-fixture-'));
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const privatePath=path.join(dir,'test-private.pem'),publicPath=path.join(dir,'test-public.pem');
 fs.writeFileSync(privatePath,keys.privateKey.export({type:'pkcs8',format:'pem'}));
 fs.writeFileSync(publicPath,keys.publicKey.export({type:'spki',format:'pem'}));
 t.after(()=>{fs.unlinkSync(privatePath);fs.unlinkSync(publicPath);fs.rmdirSync(dir);});
 const env={NODE_ENV:'test',ADAPTER_MODE:'real',WECHAT_PAY_ENABLED:'1',WECHAT_APP_ID:'local-fixture-app',WECHAT_MCH_ID:'local-fixture-merchant',
  WECHAT_API_V3_KEY:'test-only-key-length-32-bytes!!!',WECHAT_CERT_SERIAL:'LOCAL',WECHAT_PRIVATE_KEY_PATH:privatePath,WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_LOCAL',
  WECHAT_PAY_PUBLIC_KEY_PATH:publicPath,WECHAT_PAY_NOTIFY_URL:'https://test.invalid/api/payments/notify',
  WECHAT_PAY_REFUND_NOTIFY_URL:'https://test.invalid/api/payments/wechat/refund-notify'};
 const headersFor=raw=>{
  const timestamp=Math.floor(Date.now()/1000).toString(),nonce='test-nonce';
  return {'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':env.WECHAT_PAY_PUBLIC_KEY_ID,
   'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.from(timestamp+'\n'+nonce+'\n'+raw+'\n'),keys.privateKey).toString('base64')};
 };
 const encrypt=(data,id,eventType)=>{
  const nonce=crypto.randomBytes(9).toString('base64'), associated='test-data';
  const aes=crypto.createCipheriv('aes-256-gcm',Buffer.from(env.WECHAT_API_V3_KEY),Buffer.from(nonce));
  aes.setAAD(Buffer.from(associated));
  const ciphertext=Buffer.concat([aes.update(JSON.stringify(data)),aes.final(),aes.getAuthTag()]).toString('base64');
  return JSON.stringify({id,event_type:eventType,resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data:associated,ciphertext}});
 };
 const store=openStore(':memory:');
 t.after(()=>store.close());
 const state=store.load(), bill=state.bills[0], entity='微信收款测试主体';
 Object.assign(bill,{agreementId:'wechat-test-contract',currency:'CNY',collectionEntity:entity});
 state.agreements.push({id:bill.agreementId,owner:bill.owner,outlet:bill.outlet,status:'active',priceSnapshot:{collectionEntity:entity}});
 store.transaction(()=>store.save(state));
 env.PAYMENT_MERCHANT_MAPPINGS=JSON.stringify({[entity]:{wechat:{merchantId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID}}});
 let charge,refundBody;
 const provider=async(url,options)=>{
  const route=new URL(url).pathname;
  if(route.endsWith('/jsapi')){
   charge=JSON.parse(options.body);
   const raw='{"prepay_id":"local-wx-refund-test"}';
   return new Response(raw,{headers:headersFor(raw)});
  }
  if(options.method==='POST'){
   refundBody=JSON.parse(options.body);
   assert.equal(refundBody.notify_url,env.WECHAT_PAY_REFUND_NOTIFY_URL);
   assert.deepEqual(refundBody.amount,{refund:12345,total:198000,currency:'CNY'});
  }
  const raw=JSON.stringify({out_refund_no:refundBody.out_refund_no,out_trade_no:charge.out_trade_no,refund_id:'wechat-local-refund-id',
   status:'PROCESSING',amount:{refund:12345,currency:'CNY'}});
  return new Response(raw,{headers:headersFor(raw)});
 };
 const service=paymentService(store,env,{openid:()=> 'test-local-openid'},provider);
 const order=await service.prepay(who,{billId:bill.id},'local-wx-payment-key','case');
 const paid={out_trade_no:charge.out_trade_no,transaction_id:'wechat-local-charge-id',appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,
  trade_state:'SUCCESS',trade_type:'JSAPI',amount:{total:198000,currency:'CNY'},success_time:new Date().toISOString()};
 const payNotice=encrypt(paid,'local-pay','TRANSACTION.SUCCESS');
 service.notify(headersFor(payNotice),payNotice,'case');
 const receipt=store.load().receipts[0],next=store.load();
 next.refundRequests.push({id:'approved-wx-refund',owner:bill.owner,outlet:bill.outlet,status:'approved',billId:bill.id,receiptId:receipt.id,amount:123.45});
 store.transaction(()=>store.save(next));
 const refund=await service.refundPayment(manager,order.paymentId,{refundRequestId:'approved-wx-refund'},'local-wx-refund-key','case');
 assert.equal(refund.status,'pending');
 const normalized={out_refund_no:refund.id,out_trade_no:charge.out_trade_no,refund_id:'wechat-local-refund-id',mchid:env.WECHAT_MCH_ID,refund_status:'SUCCESS',amount:{refund:12345,currency:'CNY'}};
 const bad=encrypt({...normalized,amount:{refund:1,currency:'CNY'}},'local-bad-refund','REFUND.SUCCESS');
 await assert.rejects(service.notifyRefund(headersFor(bad),bad,'case','wechat'),{code:'PAY_MISMATCH'});
 assert.equal(store.load().refundRequests[0].status,'approved');
 const raw=encrypt(normalized,'local-wx-refund','REFUND.SUCCESS');
 assert.equal((await service.notifyRefund(headersFor(raw),raw,'case','wechat')).status,'success');
 assert.equal((await service.notifyRefund(headersFor(raw),raw,'duplicate','wechat')).status,'success');
 assert.equal(store.load().refundRequests[0].status,'recorded');
 assert.equal(store.load().bills[0].refundAmount,123.45);
});
test('isolated HTTP checkout exposes two simulated choices and enforces resource access',async t=>{
 const {createServer}=require('../server/index.cjs');
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'},integrationFetch:()=>assert.fail('development HTTP must not contact vendors')});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();});
 const base='http://127.0.0.1:'+app.server.address().port;
 const get=async(path,token)=>fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});
 const post=(path,data,token,key='local-http-test-key')=>fetch(base+path,{method:'POST',
  headers:{'Content-Type':'application/json','Idempotency-Key':key,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
 const getAccount=async actor=>(await (await post('/api/auth/dev',{actor})).json()).data.token;
 const token=await getAccount('partnerA'), other=await getAccount('partnerB');
 const cfg=(await (await get('/api/config')).json()).data;
 assert.deepEqual(cfg.paymentChannels,{wechat:false,alipay:false,mock:true});
 for(const [index,channel] of ['wechat','alipay'].entries()){
  const bill=app.store.load().bills[index];
  assert.equal((await post('/api/payments/prepay',{billId:bill.id,channel,simulation:true},other,'external-check-'+channel)).status,403);
  const created=await post('/api/payments/prepay',{billId:bill.id,channel,simulation:true},token,'internal-check-'+channel);
  assert.equal(created.status,200);
  const {data:order}=await created.json();
  assert.equal(order.channel,channel);
  assert.equal((await post('/api/commands',{command:'payment.resolve',payload:{id:order.paymentId,outcome:'success'}},token,'legacy-check-'+channel)).status,409);
  const action='/api/payments/'+order.paymentId+'/simulate';
  assert.equal((await post(action,{outcome:'success'},other)).status,403);
  assert.equal((await post(action,{outcome:'success'},token)).status,200);
  assert.equal((await post(action,{outcome:'success'},token)).status,200);
  assert.equal(app.store.load().receipts.filter(row=>row.billId===bill.id).length,1);
 }
});
