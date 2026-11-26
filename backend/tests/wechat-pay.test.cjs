'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),dir=path.resolve(__dirname,'../execution/test-databases/pay-crypto');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'test-private.pem'),privateKey);fs.writeFileSync(path.join(dir,'test-public.pem'),publicKey);
const env={NODE_ENV:'test',ADAPTER_MODE:'real',WECHAT_PAY_ENABLED:'1',WECHAT_APP_ID:'wx-test',WECHAT_MCH_ID:'test-merchant',WECHAT_API_V3_KEY:'01234567890123456789012345678901',WECHAT_CERT_SERIAL:'TESTSERIAL',WECHAT_PRIVATE_KEY_PATH:path.join(dir,'test-private.pem'),WECHAT_PAY_PUBLIC_KEY_ID:'PUB_KEY_ID_TEST',WECHAT_PAY_PUBLIC_KEY_PATH:path.join(dir,'test-public.pem'),WECHAT_PAY_NOTIFY_URL:'https://example.test/api/payments/notify'};
// Install matching agreement snapshots and explicit channel configuration in isolated provider fixtures.
env.PAYMENT_MERCHANT_MAPPINGS=JSON.stringify({'测试协议主体':{wechat:{merchantId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID}}});
function attachTestContracts(store){
 const state=store.load();
 for(const bill of state.bills){
  const id='agreement-test-'+bill.id;
  bill.agreementId=id;
  bill.collectionEntity='测试协议主体';
  bill.currency='CNY';
  state.agreements.push({id,owner:bill.owner,outlet:bill.outlet,status:'active',priceSnapshot:{collectionEntity:bill.collectionEntity}});
 }
 store.transaction(()=>store.save(state));
 return store;
}
test('bounded reconciliation recovers missed callbacks and backs off without fabricating receipts on provider failure',async()=>{const {openStore}=require('../server/storage.cjs'),{paymentService}=require('../server/payments.cjs'),store=attachTestContracts(openStore(':memory:'));let orderBody,queries=0,fail=false;const providerFetch=async(url,options)=>{if(options.method==='POST'){orderBody=JSON.parse(options.body);const raw='{"prepay_id":"reconcile-test"}';return new Response(raw,{headers:signed(raw)});}queries++;if(fail)throw new Error('network unavailable');const raw=JSON.stringify({appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,out_trade_no:orderBody.out_trade_no,transaction_id:'reconciliation-transaction',trade_state:'SUCCESS',trade_type:'JSAPI',amount:{total:198000,currency:'CNY'},payer:{openid:'test-openid'},success_time:new Date().toISOString()});return new Response(raw,{headers:signed(raw)});};const svc=paymentService(store,env,{openid:()=> 'test-openid'},providerFetch);try{const bills=store.load().bills,who={actor:'partnerA',subject:'partnerA'};await svc.prepay(who,{billId:bills[0].id},'reconciliation-order-one','request');assert.equal((await svc.reconcile()).processed,1);assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n,1);assert.equal((await svc.reconcile()).processed,0);await svc.prepay(who,{billId:bills[1].id},'reconciliation-order-two','request');fail=true;assert.equal((await svc.reconcile()).processed,1);const first=store.db.prepare("SELECT * FROM payment_provider_orders WHERE status='pending'").get();assert.equal(first.query_attempts,1);assert.equal(first.last_error,'PAY_PROVIDER_UNAVAILABLE');assert.ok(first.next_query_at>new Date().toISOString());assert.equal((await svc.reconcile()).processed,0);for(let i=1;i<8;i++){store.db.prepare("UPDATE payment_provider_orders SET next_query_at='2000-01-01T00:00:00.000Z' WHERE status='pending'").run();await svc.reconcile();}store.db.prepare("UPDATE payment_provider_orders SET next_query_at='2000-01-01T00:00:00.000Z' WHERE status='pending'").run();assert.equal((await svc.reconcile()).processed,0);assert.equal(queries,9);assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n,1);}finally{store.close();}});
function signed(body,seconds=Math.floor(Date.now()/1000)){const nonce=crypto.randomBytes(12).toString('hex');return {'wechatpay-serial':'PUB_KEY_ID_TEST','wechatpay-timestamp':String(seconds),'wechatpay-nonce':nonce,'wechatpay-signature':crypto.sign('RSA-SHA256',Buffer.from(seconds+'\n'+nonce+'\n'+body+'\n'),privateKey).toString('base64')};}
function notification(data){const nonce=crypto.randomBytes(9).toString('base64'),aad='transaction',cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(env.WECHAT_API_V3_KEY),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final(),cipher.getAuthTag()]).toString('base64');return JSON.stringify({id:'notice-test',event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext}});}
test('real HTTP payment pipeline authenticates payer, blocks conflicting writes and verifies callback idempotency',async()=>{const {createServer}=require('../server/index.cjs');let orderBody;const app=createServer({dbPath:':memory:',env:{...env,WECHAT_AUTH_MODE:'real',WECHAT_APP_SECRET:'test-only'},integrationFetch:async(url,options)=>{if(new URL(url).hostname==='api.weixin.qq.com')return new Response('{"openid":"http-test-openid"}');orderBody=JSON.parse(options.body);const raw='{"prepay_id":"http-prepay"}';return new Response(raw,{headers:signed(raw)});}});attachTestContracts(app.store);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,{authentication}=require('../server/auth.cjs'),token=authentication(app.store,env).session('partnerA').token;const post=(p,b,auth=token,headers={})=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{}),'Idempotency-Key':'http-pay-test-0001',...headers},body:typeof b==='string'?b:JSON.stringify(b)});try{assert.equal((await post('/api/auth/wechat/bind',{code:'http-code'})).status,200);const bill=app.store.load().bills[0],res=await post('/api/payments/prepay',{billId:bill.id});assert.equal(res.status,200);const payment=(await res.json()).data;assert.ok(payment.requestPayment.paySign);assert.equal((await post('/api/commands',{command:'payment.resolve',payload:{id:payment.paymentId,outcome:'success'}})).status,503);assert.equal((await post('/api/commands',{command:'offline.submit',payload:{billId:bill.id,amount:1980,reference:'conflict',paidOn:'2026-11-18',reason:'核验'}},token,{'Idempotency-Key':'offline-conflict-0001'})).status,409);const raw=notification({appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,out_trade_no:orderBody.out_trade_no,transaction_id:'http-transaction',trade_state:'SUCCESS',trade_type:'JSAPI',amount:{total:198000,currency:'CNY'},payer:{openid:'http-test-openid'},success_time:new Date().toISOString()});assert.equal((await post('/api/payments/notify',raw,null,signed(raw))).status,204);assert.equal((await post('/api/payments/notify',raw,null,signed(raw))).status,204);assert.equal((await post('/api/payments/notify',raw+' ',null,signed(raw))).status,401);assert.equal(app.store.load().receipts.length,1);}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();}});
test('WeChat Pay signs outbound requests and verifies response/notification before AES-GCM decoding',async()=>{const {wechatPay}=require('../server/wechat-pay.cjs');const provider=wechatPay(env,async(url,options)=>{assert.equal(new URL(url).hostname,'api.mch.weixin.qq.com');assert.match(options.headers.Authorization,/WECHATPAY2-SHA256-RSA2048/);const body=JSON.stringify({prepay_id:'verified-prepay'});return new Response(body,{headers:signed(body)});});const result=await provider.prepay({outTradeNo:'JYtest',amount:198000,openid:'test-openid',description:'咨询服务费'});assert.equal(result.prepayId,'verified-prepay');assert.ok(crypto.verify('RSA-SHA256',Buffer.from(env.WECHAT_APP_ID+'\n'+result.requestPayment.timeStamp+'\n'+result.requestPayment.nonceStr+'\n'+result.requestPayment.package+'\n'),publicKey,Buffer.from(result.requestPayment.paySign,'base64')));const payload=notification({trade_state:'SUCCESS',amount:{total:198000,currency:'CNY'}});assert.equal(provider.notification(signed(payload),payload).data.trade_state,'SUCCESS');assert.throws(()=>provider.notification(signed(payload),payload+' '),e=>e.code==='PAY_SIGNATURE');assert.throws(()=>provider.notification(signed(payload,1),payload),e=>e.code==='PAY_SIGNATURE');const forged=wechatPay(env,async()=>new Response('{"prepay_id":"forged"}',{headers:signed('{}')}));await assert.rejects(()=>forged.prepay({outTradeNo:'JYbad',amount:1,openid:'test',description:'费用'}),e=>e.code==='PAY_SIGNATURE');});
test('verified payment callback atomically posts one receipt, rejects amount/app mismatches, and query recovers state',async()=>{const {openStore}=require('../server/storage.cjs'),{paymentService}=require('../server/payments.cjs');const store=attachTestContracts(openStore(':memory:'));let trade,lastBody;const providerFetch=async(url,options)=>{if(options.method==='POST'){lastBody=JSON.parse(options.body);const body=JSON.stringify({prepay_id:'pay-test'});return new Response(body,{headers:signed(body)});}const body=JSON.stringify(trade);return new Response(body,{headers:signed(body)});};const svc=paymentService(store,env,{openid:()=> 'test-openid'},providerFetch);try{const bill=store.load().bills[0],who={actor:'partnerA',subject:'partnerA',principal:'partnerA'},order=await svc.prepay(who,{billId:bill.id},'idempotency-pay-test','request-pay-test');const again=await svc.prepay(who,{billId:bill.id},'idempotency-pay-test','request-pay-retry');assert.equal(again.paymentId,order.paymentId);assert.equal(store.db.prepare('SELECT count(*) n FROM payment_provider_orders').get().n,1);trade={appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,out_trade_no:lastBody.out_trade_no,transaction_id:'provider-tx-001',trade_state:'SUCCESS',trade_type:'JSAPI',amount:{total:198000,currency:'CNY'},payer:{openid:'test-openid'},success_time:new Date().toISOString()};let raw=notification({...trade,amount:{total:1,currency:'CNY'}});assert.throws(()=>svc.notify(signed(raw),raw,'bad'),e=>e.code==='PAY_MISMATCH');assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n,0);const queried=await svc.query(who,order.paymentId,'query');assert.equal(queried.bill.status,'paid');raw=notification(trade);svc.notify(signed(raw),raw,'callback');svc.notify(signed(raw),raw,'callback-replay');raw=notification(trade);svc.notify(signed(raw),raw,'callback-reencrypted');assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n,1);assert.equal(store.load().receipts[0].adapterMode,'real');assert.equal(store.load().receipts[0].externalReference,'provider-tx-001');assert.throws(()=>svc.inspect({actor:'partnerB'},order.paymentId),e=>e.status===403);}finally{store.close();}});

test('payment credentials stay unavailable on every call when verification key loading fails', async () => {
  const {wechatPay} = require('../server/wechat-pay.cjs');
  let calls = 0;
  const provider = wechatPay({...env, WECHAT_PAY_PUBLIC_KEY_PATH: path.join(dir, 'missing-verification-key.pem')}, async () => {
    calls++;
    return new Response('{}');
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => provider.query('local-test-order'), {code: 'CONFIG'});
  }
  assert.equal(calls, 0);
});

test('signed unpaid and closed responses can omit amount and repeated closed checks preserve audit', async () => {
  const {openStore} = require('../server/storage.cjs');
  const {paymentService} = require('../server/payments.cjs');
  const store = attachTestContracts(openStore(':memory:'));
  let tradeState = 'NOTPAY', orderNo;
  const providerFetch = async (url, options) => {
    let raw;
    if (options.method === 'POST' && !url.endsWith('/close')) {
      orderNo = JSON.parse(options.body).out_trade_no;
      raw = JSON.stringify({prepay_id: 'test-expand'});
    } else if (options.method === 'POST') {
      tradeState = 'CLOSED';
      return new Response(null, {status: 204, headers: signed('')});
    } else {
      raw = JSON.stringify({appid: env.WECHAT_APP_ID, mchid: env.WECHAT_MCH_ID, out_trade_no: orderNo, trade_state: tradeState});
    }
    return new Response(raw, {headers: signed(raw)});
  };
  const service = paymentService(store, env, {openid: () => 'local-test-payer'}, providerFetch);
  try {
    const bill = store.load().bills[0], who = {actor: 'partnerA', subject: 'partnerA'};
    const payment = await service.prepay(who, {billId: bill.id}, 'independent-checkout-1', 'prepay');
    const unpaid = await service.query(who, payment.paymentId, 'query');
    assert.equal(unpaid.payment.status, 'pending');
    store.db.prepare('UPDATE payment_provider_orders SET expires_at=? WHERE payment_id=?').run('2000-01-01T00:00:00.000Z', payment.paymentId);
    assert.equal((await service.close(who, payment.paymentId, 'close')).payment.status, 'cancelled');
    assert.equal((await service.close(who, payment.paymentId, 'check-closed')).payment.status, 'cancelled');
    assert.equal(store.db.prepare("SELECT count(*) n FROM audit WHERE json_extract(data,'$.command')='payment.real.closed'").get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n, 0);
  } finally {
    store.close();
  }
});

test('verified payment updates both unpaid and overdue business tasks in the posting transaction', async () => {
  const {openStore} = require('../server/storage.cjs');
  const {paymentService} = require('../server/payments.cjs');
  const store = attachTestContracts(openStore(':memory:'));
  let orderNo;
  const service = paymentService(store, env, {openid: () => 'local-test-payer'}, async (url, options) => {
    orderNo = JSON.parse(options.body).out_trade_no;
    const raw = JSON.stringify({prepay_id: 'test-tasks'});
    return new Response(raw, {headers: signed(raw)});
  });
  try {
    const state = store.load(), bill = state.bills[0];
    for (const kind of ['bill_unpaid','bill_overdue']) {
      state.businessTasks.push({id: 'independent-'+kind, kind, owner: bill.owner, outlet: bill.outlet, month: bill.month, recordId: bill.id, status: 'open'});
    }
    store.transaction(() => store.save(state));
    await service.prepay({actor: 'partnerA', subject: 'partnerA'}, {billId: bill.id}, 'independent-checkout-2', 'prepay');
    const raw = notification({appid: env.WECHAT_APP_ID, mchid: env.WECHAT_MCH_ID, out_trade_no: orderNo, transaction_id: 'independent-tx', trade_state: 'SUCCESS', trade_type: 'JSAPI', amount: {total: 198000, currency: 'CNY'}, payer: {openid: 'local-test-payer'}, success_time: new Date().toISOString()});
    assert.equal(service.notify(signed(raw), raw, 'notify').bill.status, 'paid');
    const tasks = store.load().businessTasks.filter(t => t.id.startsWith('independent-'));
    assert.deepEqual(tasks.map(t => t.status), ['resolved','resolved']);
    assert.ok(tasks.every(t=>t.completedAt&&t.completedAt===t.resolvedAt&&t.closeReason==='business_fact'));
    assert.equal(store.db.prepare('SELECT count(*) n FROM receipts').get().n, 1);
  } finally {
    store.close();
  }
});
