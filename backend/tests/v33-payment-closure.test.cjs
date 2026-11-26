'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {openStore}=require('../server/storage.cjs');
const {paymentService}=require('../server/payments.cjs');
const {canonical}=require('../server/alipay.cjs');

const owner={actor:'partnerA',subject:'partnerA'};
const hq={actor:'finance',subject:'finance-staff'};
const expired='2000-01-01T00:00:00.000Z';

function fixture(t,envPatch={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jy-v33-payment-'));
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const privatePath=path.join(dir,'merchant.pem'),publicPath=path.join(dir,'platform.pem');
 fs.writeFileSync(privatePath,privateKey.export({type:'pkcs8',format:'pem'}));
 fs.writeFileSync(publicPath,publicKey.export({type:'spki',format:'pem'}));
 const dbPath=path.join(dir,'fixture.db'),store=openStore(dbPath);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true});});
 const env={NODE_ENV:'test',ADAPTER_MODE:'real',ALIPAY_ENABLED:'1',ALIPAY_PRODUCT:'wap',ALIPAY_PRODUCT_AUTHORIZED:'1',
  ALIPAY_GATEWAY:'https://openapi.alipay.com/gateway.do',ALIPAY_NOTIFY_URL:'https://merchant.invalid/api/payments/alipay/notify',
  ALIPAY_APP_ID:'local-test-app',ALIPAY_MERCHANT_ID:'test-merchant',ALIPAY_PRIVATE_KEY_PATH:privatePath,ALIPAY_PUBLIC_KEY_PATH:publicPath,
  ...envPatch};
 const state=store.load(),bill=state.bills[0],entity='隔离签名夹具收款主体';
 Object.assign(bill,{agreementId:'signed-test-agreement',collectionEntity:entity,currency:'CNY'});
 state.agreements.push({id:bill.agreementId,owner:bill.owner,outlet:bill.outlet,status:'active',priceSnapshot:{collectionEntity:entity}});
 store.transaction(()=>store.save(state));
 env.PAYMENT_MERCHANT_MAPPINGS=JSON.stringify({[entity]:{alipay:{appId:env.ALIPAY_APP_ID,merchantId:env.ALIPAY_MERCHANT_ID}}});
 const sign=raw=>crypto.sign('RSA-SHA256',Buffer.from(raw),privateKey).toString('base64');
 const calls=[];
 const behavior={trade:'ABSENT',refund:'REFUND_PROCESSING',badSignature:false,ambiguousRefund:false};
 const fetcher=async(url,options)=>{
  assert.equal(url,env.ALIPAY_GATEWAY);
  const {sign:signature,...params}=Object.fromEntries(options.body);
  assert.ok(crypto.verify('RSA-SHA256',Buffer.from(canonical(params)),publicKey,Buffer.from(signature,'base64')));
  const {method}=params,biz=JSON.parse(params.biz_content);
  calls.push({method,biz});
  let body={code:'10000',out_trade_no:biz.out_trade_no,trade_no:'signed-fixture-'+biz.out_trade_no};
  if(method==='alipay.trade.query') {
   if(behavior.trade==='ABSENT') body={code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'};
   else if(behavior.trade==='PROFILE_ERROR') body={code:'40004',sub_code:'ACQ.PARTNER_ERROR'};
   else Object.assign(body,{trade_status:behavior.trade,total_amount:'1980.00',seller_id:env.ALIPAY_MERCHANT_ID,
    app_id:env.ALIPAY_APP_ID,send_pay_date:'2026-11-18 12:00:00'});
  } else if(method==='alipay.trade.close') {
   if(behavior.racePaid){
    behavior.trade='TRADE_SUCCESS';
    body={code:'40004',sub_code:'ACQ.TRADE_STATUS_ERROR'};
   } else behavior.trade='TRADE_CLOSED';
  }
  else if(method==='alipay.trade.refund'&&behavior.ambiguousRefund) throw Error('injected lost response');
  else if(method==='alipay.trade.fastpay.refund.query') {
   if(behavior.refund==='UNAVAILABLE') body={code:'20000'};
   else Object.assign(body,{out_request_no:biz.out_request_no,refund_status:behavior.refund,refund_amount:'100.01'});
  } else assert.equal(method,'alipay.trade.refund');
  const raw=JSON.stringify(body),responseKey=method.replaceAll('.','_')+'_response';
  return new Response(JSON.stringify({[responseKey]:body,sign:behavior.badSignature?'Zm9yZ2Vk':sign(raw)}));
 };
 const service=paymentService(store,env,{},fetcher);
 const checkout=key=>service.prepay(owner,{billId:bill.id,channel:'alipay'},key,'isolated-checkout');
 const tradeId=paymentId=>store.db.prepare('SELECT out_trade_no AS id FROM payment_provider_orders WHERE payment_id=?').get(paymentId).id;
 const notice=(tradeNo,id,extra={})=>{
  const fields={notify_id:id,out_trade_no:tradeNo,trade_no:'signed-fixture-'+tradeNo,trade_status:'TRADE_SUCCESS',
   total_amount:'1980.00',seller_id:env.ALIPAY_MERCHANT_ID,app_id:env.ALIPAY_APP_ID,gmt_payment:'2026-11-18 12:00:00',...extra};
  return new URLSearchParams({...fields,sign_type:'RSA2',sign:sign(canonical(fields))}).toString();
 };
 return {store,env,service,bill,checkout,tradeId,notice,calls,behavior,fetcher,dbPath};
}

test('production rejects sandbox checkout, simulation, and non-production merchant identities before network or ledger writes',async t=>{
 const f=fixture(t,{NODE_ENV:'production',ALIPAY_GATEWAY:'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  ALIPAY_APP_ID:'2026000000000001',ALIPAY_MERCHANT_ID:'2088000000000001'});
 assert.equal(f.service.capabilities.alipay,false);
 await assert.rejects(f.checkout('prod-sandbox-denied'),{code:'CONFIG'});
 await assert.rejects(f.service.prepay(owner,{billId:f.bill.id,channel:'alipay',simulation:true},'prod-mock-denied','mock'),{code:'MOCK_DISABLED'});
 const invalid=paymentService(f.store,{...f.env,ALIPAY_GATEWAY:'https://openapi.alipay.com/gateway.do',ALIPAY_MERCHANT_ID:'test-merchant'},{},f.fetcher);
 assert.equal(invalid.capabilities.alipay,false);
 await assert.rejects(invalid.prepay(owner,{billId:f.bill.id,channel:'alipay'},'prod-fixture-denied','fixture'),{code:'CONFIG'});
 assert.deepEqual(f.calls,[]);
 assert.equal(f.store.load().payments.length,0);
 assert.equal(f.store.load().receipts.length,0);
});

test('production refuses to query a historical sandbox order with production-shaped identifiers',async t=>{
 const f=fixture(t,{ALIPAY_GATEWAY:'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  ALIPAY_APP_ID:'2026000000000001',ALIPAY_MERCHANT_ID:'2088000000000001'});
 const order=await f.checkout('sandbox-checkout-key');
 const live=paymentService(f.store,{...f.env,NODE_ENV:'production',ALIPAY_GATEWAY:'https://openapi.alipay.com/gateway.do'},{},f.fetcher);
 await assert.rejects(live.query(owner,order.paymentId,'cross-environment-query'),{code:'PAYMENT_ENVIRONMENT_MISMATCH'});
 assert.deepEqual(f.calls,[]);
 assert.equal(f.store.load().receipts.length,0);
});

test('only an authenticated absent query can release an expired checkout, and late success stays durable if another order settles',async t=>{
 const f=fixture(t), first=await f.checkout('first-test-checkout');
 await assert.rejects(f.service.close(owner,first.paymentId,'not-yet-expired'),{code:'PAY_NOT_EXPIRED'});
 f.store.db.prepare('UPDATE payment_provider_orders SET expires_at=? WHERE payment_id=?').run(expired,first.paymentId);
 f.behavior.badSignature=true;
 await assert.rejects(f.service.close(owner,first.paymentId,'forged-absent'),{code:'PAY_SIGNATURE'});
 f.behavior.badSignature=false;
 f.behavior.trade='PROFILE_ERROR';
 await assert.rejects(f.service.close(owner,first.paymentId,'unknown-provider-result'),{code:'PAY_PROVIDER_REJECTED'});
 assert.equal(f.service.inspect(owner,first.paymentId).payment.status,'pending');
 f.behavior.trade='ABSENT';
 const closed=await f.service.close(owner,first.paymentId,'signed-expired-absent');
 assert.equal(closed.payment.status,'cancelled');
 assert.equal(closed.providerTradeState,'NOT_FOUND');
 assert.equal(f.calls.filter(row=>row.method==='alipay.trade.close').length,0);
 const next=await f.checkout('replacement-checkout');
 const tradeNo=f.tradeId(first.paymentId);
 assert.equal(f.service.notify({},f.notice(f.tradeId(next.paymentId),'replacement-notice'),'replacement','alipay').payment.status,'success');
 for(const id of ['late-notice','late-notice','independent-late-notice']){
  const late=f.service.notify({},f.notice(tradeNo,id),'late','alipay');
  assert.equal(late.payment.status,'cancelled');
  assert.equal(late.reconciliationRequired,true);
 }
 assert.equal(f.store.load().receipts.length,1);
 assert.equal(f.store.load().receipts[0].paymentId,next.paymentId);
 const exceptions=f.service.paymentExceptions(hq,{limit:20});
 assert.equal(exceptions.items.length,1);
 assert.deepEqual(
  {paymentId:exceptions.items[0].paymentId,amountCents:exceptions.items[0].amountCents,status:exceptions.items[0].status},
  {paymentId:first.paymentId,amountCents:198000,status:'open'}
 );
 assert.throws(()=>f.service.paymentExceptions(owner,{}),{code:'FORBIDDEN'});
 f.behavior.trade='TRADE_SUCCESS';
 assert.equal((await f.service.reconcilePayment(hq,first.paymentId,'operator-late-query')).status,'exception');
 assert.equal(f.service.paymentExceptions(hq,{}).items.length,1);
 assert.equal(f.store.load().receipts.length,1);
});

test('payment confirmed while a channel close is in flight is booked once from the signed follow-up query',async t=>{
 const f=fixture(t),order=await f.checkout('inflight-close-order');
 f.store.db.prepare('UPDATE payment_provider_orders SET expires_at=? WHERE payment_id=?').run(expired,order.paymentId);
 f.behavior.trade='WAIT_BUYER_PAY';
 f.behavior.racePaid=true;
 const result=await f.service.close(owner,order.paymentId,'paid-during-close');
 assert.equal(result.providerTradeState,'SUCCESS');
 assert.equal(result.payment.status,'success');
 assert.equal(f.store.load().receipts.length,1);
 f.service.notify({},f.notice(f.tradeId(order.paymentId),'paid-after-close-query'),'duplicate','alipay');
 assert.equal(f.store.load().receipts.length,1);
});

test('one approved business refund reserves a stable channel order and signed query recovers a lost response',async t=>{
 const f=fixture(t),pay=await f.checkout('successful-refund-payment');
 f.service.notify({},f.notice(f.tradeId(pay.paymentId),'payment-before-refund'),'paid','alipay');
 const state=f.store.load(),receipt=state.receipts[0],refundRequestId='approved-refund-isolated';
 state.refundRequests.push({id:refundRequestId,owner:f.bill.owner,outlet:f.bill.outlet,status:'approved',billId:f.bill.id,receiptId:receipt.id,amount:100.01});
 f.store.transaction(()=>f.store.save(state));
 f.behavior.ambiguousRefund=true;
 await assert.rejects(f.service.refundPayment(hq,pay.paymentId,{refundRequestId},'first-confirmation','lost-transport'),{code:'PAY_PROVIDER_UNAVAILABLE'});
 f.behavior.ambiguousRefund=false;
 const pending=await f.service.refundPayment(hq,pay.paymentId,{refundRequestId},'second-confirmation','duplicate-confirmation');
 assert.notEqual(pending.id,refundRequestId);
 assert.equal(pending.status,'pending');
 assert.equal(f.calls.filter(row=>row.method==='alipay.trade.refund').length,1);
 assert.equal(f.service.refundChannel(hq,refundRequestId).order.id,pending.id);
 assert.throws(()=>f.service.refundChannel(owner,refundRequestId),{code:'FORBIDDEN'});
 f.behavior.refund='REFUND_SUCCESS';
 f.store.db.prepare('UPDATE payment_refund_orders SET next_query_at=? WHERE id=?').run(expired,pending.id);
 const result=await f.service.reconcile(1);
 assert.equal(result.processed,1);
 assert.equal(f.service.refundChannel(hq,refundRequestId).order.status,'success');
 const recorded=f.store.load().refundRequests.filter(row=>row.status==='recorded');
 assert.equal(recorded.length,1);
 assert.equal(recorded[0].amount,100.01);
 assert.ok(recorded[0].customerReference);
 assert.equal(f.store.load().bills[0].refundAmount,100.01);
 assert.equal(f.store.load().receipts.length,1);
 assert.equal(f.calls.filter(row=>row.method==='alipay.trade.refund').length,1);
});

test('production callback with formatted merchant IDs cannot post without confirmation from the configured production query',async t=>{
 const f=fixture(t,{NODE_ENV:'production',ALIPAY_APP_ID:'2026000000000001',ALIPAY_MERCHANT_ID:'2088000000000001'});
 const order=await f.checkout('production-signed-fixture'),trade=f.tradeId(order.paymentId);
 const pay=f.notice(trade,'isolated-production-callback');
 await assert.rejects(async()=>f.service.notify({},pay,'absent-production-query','alipay'),{code:'PAY_CONFIRMATION_PENDING'});
 assert.equal(f.store.load().receipts.length,0);
 f.behavior.trade='TRADE_SUCCESS';
 assert.equal((await f.service.notify({},pay,'signed-production-query','alipay')).payment.status,'success');
 assert.equal((await f.service.notify({},pay,'duplicate-production-query','alipay')).payment.status,'success');
 assert.equal(f.store.load().receipts.length,1);
 assert.equal(f.calls.filter(x=>x.method==='alipay.trade.query').length,2);
});

test('a verified success stays in the HQ exception queue if the original collection mapping is no longer in effect',async t=>{
 const f=fixture(t),order=await f.checkout('before-mapping-change'),trade=f.tradeId(order.paymentId);
 f.env.PAYMENT_MERCHANT_MAPPINGS='{}';
 const outcome=f.service.notify({},f.notice(trade,'old-merchant-notice'),'mapping-rotated','alipay');
 assert.equal(outcome.reconciliationRequired,true);
 assert.equal(outcome.payment.status,'pending');
 assert.equal(f.service.paymentExceptions(hq).items[0].reason,'PAY_MERCHANT_MAPPING');
 assert.equal(f.store.load().receipts.length,0);
});

test('refund recovery stops after eight due queries and records a finance escalation',async t=>{
 const f=fixture(t),order=await f.checkout('refund-backoff-payment');
 f.service.notify({},f.notice(f.tradeId(order.paymentId),'paid-before-backoff'),'backoff','alipay');
 const state=f.store.load(),receipt=state.receipts[0],refundRequestId='approved-refund-backoff';
 state.refundRequests.push({id:refundRequestId,owner:f.bill.owner,outlet:f.bill.outlet,status:'approved',billId:f.bill.id,receiptId:receipt.id,amount:100.01});
 f.store.transaction(()=>f.store.save(state));
 const refund=await f.service.refundPayment(hq,order.paymentId,{refundRequestId},'retry-backoff-refund','refund-initial');
 f.behavior.refund='UNAVAILABLE';
 for(let attempt=1;attempt<=8;attempt++){
  f.store.db.prepare('UPDATE payment_refund_orders SET next_query_at=? WHERE id=?').run(expired,refund.id);
  assert.equal((await f.service.reconcile(1)).processed,1);
  assert.equal(f.service.refundChannel(hq,refundRequestId).order.queryAttempts,attempt);
 }
 f.store.db.prepare('UPDATE payment_refund_orders SET next_query_at=? WHERE id=?').run(expired,refund.id);
 assert.equal((await f.service.reconcile(1)).processed,0);
 assert.equal(f.service.refundChannel(hq,refundRequestId).order.manualReview,true);
 assert.equal(f.store.load().audit.filter(x=>x.command==='payment.refund.manual_review_required').length,1);
 assert.equal(f.store.load().refundRequests[0].status,'approved');
 assert.equal(f.calls.filter(x=>x.method==='alipay.trade.refund').length,1);
});

test('migration 020 preserves legacy booked cents and backfills keys for pending refunds across restart',t=>{
 const {DatabaseSync}=require('node:sqlite');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jy-v33-payment-migrate-')),file=path.join(dir,'legacy.db');
 const legacy=new DatabaseSync(file),at='2026-11-17T00:00:00.000Z';
 t.after(()=>fs.rmSync(dir,{recursive:true}));
 try{
  legacy.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const sqlDir=path.resolve(__dirname,'../database');
  for(const name of fs.readdirSync(sqlDir).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&Number(name.slice(0,3))<20).sort()){
   legacy.exec(fs.readFileSync(path.join(sqlDir,name),'utf8'));
   legacy.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(name.slice(0,3)),name.slice(0,-4),at);
  }
  legacy.prepare("INSERT INTO users(actor,role,status) VALUES('partnerA','partner','active')").run();
  for(const [table,id,status,amount,metadata] of [['bills','legacy-bill','paid',12345,{}],['payments','legacy-pay','success',12345,{billId:'legacy-bill'}],
   ['receipts','legacy-receipt','success',12345,{billId:'legacy-bill',paymentId:'legacy-pay'}],
   ['refundRequests','legacy-request','approved',1101,{billId:'legacy-bill',receiptId:'legacy-receipt'}]]){
   legacy.prepare('INSERT INTO '+table+'(id,status,amount_cents,data,created_at) VALUES(?,?,?,?,?)')
    .run(id,status,amount,JSON.stringify({id,status,amount:amount/100,...metadata}),at);
  }
  legacy.prepare(`INSERT INTO payment_provider_orders(payment_id,bill_id,out_trade_no,merchant_id,app_id,actor,binding_version,payer_hash,
   status,amount_cents,provider_transaction,created_at,expires_at,updated_at)
   VALUES('legacy-pay','legacy-bill','legacy-trade','legacy-merchant','legacy-app','partnerA',1,'hash','success',12345,'legacy-confirmed',?,?,?)`)
   .run(at,at,at);
  legacy.prepare(`INSERT INTO payment_refund_orders(id,payment_id,bill_id,receipt_id,refund_request_id,channel,adapter_mode,
   amount_cents,currency,status,merchant_id,app_id,requested_by,request_key,created_at,updated_at)
   VALUES('legacy-refund','legacy-pay','legacy-bill','legacy-receipt','legacy-request','wechat','real',1101,'CNY','pending',
    'legacy-merchant','legacy-app','finance','legacy-confirmation',?,?)`).run(at,at);
 } finally{legacy.close();}
 for(let attempt=0;attempt<2;attempt++){
  const store=openStore(file,{seed:false});
  try{
   assert.equal(store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=20').get().n,1);
   assert.equal(store.db.prepare('SELECT amount_cents FROM receipts WHERE id=?').get('legacy-receipt').amount_cents,12345);
   assert.equal(store.db.prepare('SELECT provider_transaction FROM payment_provider_orders').get().provider_transaction,'legacy-confirmed');
   assert.equal(store.db.prepare('SELECT gateway_environment FROM payment_provider_orders').get().gateway_environment,null);
   assert.deepEqual({...store.db.prepare('SELECT status,amount_cents,query_attempts FROM payment_refund_orders').get()},{status:'pending',amount_cents:1101,query_attempts:0});
   assert.equal(store.db.prepare('SELECT refund_id FROM payment_refund_idempotency WHERE subject=? AND request_key=?').get('finance','legacy-confirmation').refund_id,'legacy-refund');
   assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
   assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally{store.close();}
 }
});

test('HQ-only refund detail starts an approved channel order, blocks manual booking, then queries it without a duplicate refund',async t=>{
 const f=fixture(t);
 const {createServer}=require('../server/index.cjs'),{authentication}=require('../server/auth.cjs');
 const app=createServer({dbPath:f.dbPath,env:f.env,integrationFetch:f.fetcher});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 try {
  const auth=authentication(app.store,f.env);
  const tokens=Object.fromEntries(['finance','manager','partnerA','ops'].map(actor=>[actor,auth.session(actor).token]));
  const base='http://127.0.0.1:'+app.server.address().port;
  const call=async(actor,route,body)=>{
   const res=await fetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens[actor],
    ...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}:{})},body:body&&JSON.stringify(body)});
   return {status:res.status,...await res.json()};
  };
  const pay=await f.checkout('http-refund-payment');
  f.service.notify({},f.notice(f.tradeId(pay.paymentId),'paid-before-http'),'fixture','alipay');
  const s=f.store.load(),receipt=s.receipts[0],id='hq-approved-channel-refund';
  s.refundRequests.push({id,owner:f.bill.owner,outlet:f.bill.outlet,status:'approved',billId:f.bill.id,receiptId:receipt.id,amount:100.01});
  f.store.transaction(()=>f.store.save(s));
  const path='/api/payment-refunds/requests/'+id;
  for(const actor of ['partnerA','ops']){
   assert.equal((await call(actor,path)).status,403);
   assert.equal((await call(actor,'/api/payments/exceptions')).status,403);
  }
  const view=await call('finance',path);
  assert.equal(view.status,200);
  assert.deepEqual(view.data,{refundRequestId:id,requestStatus:'approved',amountCents:10001,
   paymentId:pay.paymentId,channel:'alipay',canStart:true,order:null});
  const setReceiptStatus=status=>f.store.db.prepare("UPDATE receipts SET status=?,data=json_set(data,'$.status',?) WHERE id=?").run(status,status,receipt.id);
  setReceiptStatus('failed');
  assert.equal((await call('finance',path)).data.canStart,false);
  assert.equal(f.calls.filter(x=>x.method==='alipay.trade.refund').length,0);
  setReceiptStatus('success');
  const manual=await call('finance','/api/commands',{command:'refund.record',payload:{id,reference:'cannot-book-channel-by-hand'}});
  assert.equal(manual.error.code,'PAYMENT_CHANNEL');
  const refundCollection='/api/collections/refundRequests/'+id;
  const billSection='/api/finance/bills/'+f.bill.id+'?section=refundRequests&recordId='+id;
  assert.equal((await call('partnerA',refundCollection)).data.channelRefundStatus,undefined);
  const start=await call('finance','/api/payments/'+pay.paymentId+'/refund',{refundRequestId:id});
  assert.equal(start.status,200);
  assert.equal(start.data.status,'pending');
  assert.notEqual(start.data.id,id);
  assert.equal((await call('manager',path)).data.order.id,start.data.id);
  const partnerPending=(await call('partnerA',refundCollection)).data;
  assert.equal(partnerPending.status,'approved');
  assert.equal(partnerPending.channelRefundStatus,'pending');
  assert.equal(partnerPending.providerRefundOrderId,undefined);
  assert.equal((await call('partnerA',billSection)).data.selectedRecord.channelRefundStatus,'pending');
  for(const actor of ['finance','manager']){
   const ledger=(await call(actor,billSection)).data;
   assert.equal(ledger.selectedRecord.status,'approved');
   assert.equal(ledger.selectedRecord.channelRefundStatus,'pending');
   assert.equal(ledger.bill.ledger.refundedCents,0);
  }
  f.behavior.refund='REFUND_SUCCESS';
  assert.equal((await call('finance','/api/payment-refunds/'+start.data.id+'/query',{})).data.status,'success');
  const partnerRecorded=(await call('partnerA',refundCollection)).data;
  assert.equal(partnerRecorded.status,'recorded');
  assert.equal(partnerRecorded.channelRefundStatus,undefined);
  assert.equal(partnerRecorded.refundRecordSource,'channel');
  assert.equal((await call('partnerA',billSection)).data.selectedRecord.refundRecordSource,'channel');
  for(const actor of ['finance','manager']){
   const ledger=(await call(actor,billSection)).data;
   assert.equal(ledger.selectedRecord.refundRecordSource,'channel');
   assert.equal(ledger.bill.ledger.refundedCents,10001);
  }
  assert.equal(f.calls.filter(x=>x.method==='alipay.trade.refund').length,1);
  assert.equal((await call('finance','/api/payments/exceptions')).status,200);
 } finally {
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
});

if(process.env.JY_PAYMENT_BROWSER==='1')test('HQ browser confirms original-channel refund, queries it and opens verified payment exceptions',async t=>{
 const f=fixture(t);
 const {createServer}=require('../server/index.cjs'),{authentication}=require('../server/auth.cjs');
 const {chromium}=require('playwright');
 const app=createServer({dbPath:f.dbPath,env:f.env,integrationFetch:f.fetcher});
 const abandoned=await f.checkout('browser-initial-checkout');
 f.store.db.prepare('UPDATE payment_provider_orders SET expires_at=? WHERE payment_id=?').run(expired,abandoned.paymentId);
 await f.service.close(owner,abandoned.paymentId,'browser-expired');
 const pay=await f.checkout('browser-replacement-checkout');
 f.service.notify({},f.notice(f.tradeId(pay.paymentId),'paid-before-browser'),'browser-paid','alipay');
 f.service.notify({},f.notice(f.tradeId(abandoned.paymentId),'late-before-browser'),'browser-late','alipay');
 const state=f.store.load(),receipt=state.receipts[0],id='browser-approved-refund';
 state.refundRequests.push({id,owner:f.bill.owner,outlet:f.bill.outlet,status:'approved',billId:f.bill.id,receiptId:receipt.id,amount:100.01});
 f.store.transaction(()=>f.store.save(state));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const session=authentication(app.store,f.env).session('finance');
  const page=await browser.newPage({viewport:{width:1360,height:1000}});
  page.setDefaultTimeout(4500);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(payload=>sessionStorage.setItem('jy-session',JSON.stringify(payload)),session);
  await page.goto('http://127.0.0.1:'+app.server.address().port);
  await page.locator('.nav [data-page=financeops]').click();
  await page.locator('[data-action=op-tab][data-tab=refundRequests]').click();
  await page.getByRole('button',{name:'处理退款'}).click();
  assert.equal(f.calls.filter(x=>x.method==='alipay.trade.refund').length,0);
  await page.getByRole('button',{name:'确认发起渠道退款'}).click();
  const dialog=page.locator('dialog[open]');
  await dialog.getByText('退款处理中',{exact:true}).waitFor();
  f.behavior.refund='REFUND_SUCCESS';
  await dialog.getByRole('button',{name:'查询渠道退款'}).click();
  await dialog.getByText('已核验退款',{exact:true}).waitFor();
  assert.equal(f.store.load().refundRequests.find(x=>x.id===id).status,'recorded');
  assert.equal(f.calls.filter(x=>x.method==='alipay.trade.refund').length,1);
  await page.screenshot({path:path.resolve(__dirname,'../../evidence/payment-hq-refund.png')});
  await dialog.getByRole('button',{name:'关闭'}).click();
  await page.getByRole('button',{name:'支付对账异常'}).click();
  await dialog.getByText(abandoned.paymentId,{exact:true}).waitFor();
  await dialog.getByText('关单后确认收款',{exact:true}).waitFor();
  await page.screenshot({path:path.resolve(__dirname,'../../evidence/payment-hq-exception.png')});
  assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
});
