'use strict';

const crypto = require('node:crypto');
const core = require('../shared/core.cjs');
const {paymentProviders} = require('./payment-providers.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();
const uid = prefix => prefix + '-' + crypto.randomUUID();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
 ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => hash(JSON.stringify(stable(value)));
const shanghaiDate = at => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const terminalTrade = {CLOSED:'cancelled',PAYERROR:'failed'};
const maxQueryAttempts = 8;
const financeWorker = {actor:'finance'};

function paymentService(store, env, identity, fetcher) {
 const db = store.db;
 const providers = paymentProviders(env, fetcher);
 const inflight = new Set();
 const capabilities = {wechat:providers.real.wechat.ready, alipay:providers.real.alipay.ready, mock:providers.mock.wechat.ready};

 function row(table,id) {
  const record = db.prepare('SELECT data FROM '+table+' WHERE id=?').get(id);
  core.check(record,'NOT_FOUND','业务记录不存在',404);
  return JSON.parse(record.data);
 }

 function save(table,record) {
  db.prepare('INSERT INTO '+table+'(id,owner,outlet,status,month,amount_cents,data,created_at) VALUES(?,?,?,?,?,?,?,?)'
   +' ON CONFLICT(id) DO UPDATE SET status=excluded.status,amount_cents=excluded.amount_cents,data=excluded.data')
   .run(record.id,record.owner||null,record.outlet||null,record.status,record.month||null,
    record.amount==null?null:Math.round(record.amount*100),JSON.stringify(record),record.createdAt||iso());
 }

 function audit(record,command,requestId,subject,details={}) {
  save('audit',{id:uid('audit'),owner:record.owner,outlet:record.outlet,status:'completed',command,subject,requestId,
   recordId:record.id,channel:record.channel,...details,createdAt:iso()});
  store.sealAudit();
 }

 function inspect(who,id) {
  const payment = row('payments',id);
  core.check(core.own(who.actor)===payment.owner||['finance','manager'].includes(who.actor),'FORBIDDEN','无权查看该支付订单',403);
  return {payment,bill:row('bills',payment.billId)};
 }

 function billAmount(id) {
  return db.prepare('SELECT amount_cents FROM bills WHERE id=?').get(id)?.amount_cents;
 }

 function paidReceipt(bill) {
  return db.prepare("SELECT id FROM receipts WHERE json_extract(data,'$.billId')=? LIMIT 1").get(bill.id);
 }

 function paymentHold(billId) {
  return db.prepare("SELECT 1 FROM payment_exceptions WHERE bill_id=? AND status='open' AND adapter_mode='real' LIMIT 1").get(billId);
 }

 function keyCheck(key) {
  core.check(typeof key==='string'&&key.length>=8&&key.length<=128,'IDEMPOTENCY_KEY','请求须提供8—128字符幂等键');
 }

 function activeBill(who,billId) {
  core.check(core.own(who.actor),'FORBIDDEN','仅加盟商负责人可以付款',403);
  core.check(typeof billId==='string'&&billId.length<=128,'INPUT','账单编号无效');
  const b = row('bills',billId);
  core.check(b.owner===core.own(who.actor),'FORBIDDEN','无权支付其他加盟商账单',403);
  core.check(b.status==='unpaid'&&!paidReceipt(b),'CONFLICT','账单不是待支付状态或已有实收',409);
  core.check(!paymentHold(b.id),'PAYMENT_RECONCILIATION_REQUIRED','账单存在待核对的支付，请联系总部',409);
  const a = JSON.parse(db.prepare('SELECT data FROM accounts WHERE owner=?').get(b.owner)?.data||'null');
  core.check(a?.status==='active','ACCOUNT','负责人账号未激活或已停用',403);
  core.check(!db.prepare("SELECT 1 FROM adjustments WHERE outlet=? AND status='待财务核算调整' AND substr(json_extract(data,'$.from'),1,7)<=? AND substr(json_extract(data,'$.to'),1,7)>=?").get(b.outlet,b.month,b.month),
   'CONFLICT','费用调整待核算，暂不可付款',409);
  core.check(!db.prepare("SELECT 1 FROM offlinePayments WHERE json_extract(data,'$.billId')=? AND status='pending'").get(b.id),
   'CONFLICT','线下实收正在核验，请先完成核验',409);
  return {b,a};
 }

 function contract(bill,channel,provider) {
  const serialized = bill.agreementId && db.prepare('SELECT data FROM agreements WHERE id=?').get(bill.agreementId)?.data;
  const agreement = serialized && JSON.parse(serialized);
  const entity = agreement?.priceSnapshot?.collectionEntity;
  core.check(typeof entity==='string'&&entity.length>0&&entity===bill.collectionEntity&&agreement.owner===bill.owner&&agreement.outlet===bill.outlet&&bill.currency==='CNY',
   'PAY_CONTRACT_MISMATCH','账单收款主体与协议快照不一致，请联系总部核对',409);
  let map;
  try { map=JSON.parse(env.PAYMENT_MERCHANT_MAPPINGS||'{}'); }
  catch { core.fail('PAY_MERCHANT_MAPPING','支付主体映射配置格式无效，请联系总部',503); }
  const mapping = map && Object.hasOwn(map,entity) && map[entity] && Object.hasOwn(map[entity],channel) && map[entity][channel];
  core.check(mapping?.merchantId && mapping?.appId,'PAY_MERCHANT_MAPPING','该签约收款主体尚未配置所选支付渠道',503);
  core.check(mapping.merchantId===provider.merchantId&&mapping.appId===provider.appId,
   'PAY_MERCHANT_MISMATCH','所选渠道的实际商户与签约收款主体不匹配',409);
  return {entity,agreementId:agreement.id};
 }

 function orderProvider(order) {
  const provider = providers[order.adapter_mode][order.channel];
  provider.config();
  core.check(order.merchant_id===provider.merchantId&&order.app_id===provider.appId,'PAY_MERCHANT_MISMATCH','支付渠道配置与原订单商户不一致，须人工核对',409);
  if (order.adapter_mode==='real') {
   const legacyWeChat = order.channel==='wechat'&&!order.gateway_environment;
   core.check(order.gateway_environment ? order.gateway_environment===provider.gatewayEnvironment : env.NODE_ENV!=='production'||legacyWeChat,
    'PAYMENT_ENVIRONMENT_MISMATCH','原订单的支付环境无法确认，请联系总部核对',409);
  }
  return provider;
 }

 function orderContract(order,bill,provider) {
  if(order.adapter_mode==='real'){
   const binding = contract(bill,order.channel,provider);
   core.check((!order.collection_entity||order.collection_entity===binding.entity)&&(!order.agreement_id||order.agreement_id===binding.agreementId),
    'PAY_CONTRACT_MISMATCH','支付订单的协议或收款主体已变化，须人工核对',409);
  }
 }

 function routeOrder(order,bill) {
  const provider=orderProvider(order);
  orderContract(order,bill,provider);
  return provider;
 }

 function checkout(record, provider, response) {
  const info = {paymentId:record.payment_id,channel:record.channel,adapterMode:record.adapter_mode,expiresAt:record.expires_at};
  if (record.adapter_mode==='mock') return info;
  if (record.channel==='wechat') return {...info,requestPayment:response?.requestPayment||provider.clientParams(record.prepay_id)};
  return {...info,checkout:response?.checkout||provider.clientParams(record.prepay_id)};
 }

 async function prepay(who,p,key,requestId,reauth) {
  keyCheck(key);
  const channel = p.channel ?? 'wechat';
  core.check(['wechat','alipay'].includes(channel)&&(p.simulation===undefined||typeof p.simulation==='boolean'),'INPUT','支付渠道或模式无效');
  const mode = p.simulation===true ? 'mock' : 'real';
  const provider = providers[mode][channel];
  if (mode==='mock') provider.config();
  let b,a,binding;
  try {
   ({b,a}=activeBill(who,p.billId));
   if (mode==='real') {
    provider.config();
    binding=contract(b,channel,provider);
   }
  }
  catch (error) {
   if(b&&mode==='real') store.transaction(()=>audit({...b,channel},'payment.merchant.rejected',requestId,who.subject,{code:error.code}));
   throw error;
  }
  const openid = mode==='real'&&channel==='wechat' ? identity.openid(who.actor) : null;
  const payerHash = hash(openid||('account:'+who.actor));
  let record;
  store.transaction(()=>{
   const latest=activeBill(who,b.id);
   core.check(latest.a.bindingVersion===a.bindingVersion,'PAY_OWNERSHIP_CHANGED','付款人绑定已变化',409);
   if(mode==='real'){
    const verified=contract(latest.b,channel,provider);
    core.check(verified.entity===binding.entity&&verified.agreementId===binding.agreementId,'PAY_CONTRACT_MISMATCH','账单收款主体已变化，请重新核实',409);
   }
   const previous = db.prepare('SELECT * FROM payment_idempotency WHERE subject=? AND request_key=?').get(who.subject,key);
   core.check(!previous||previous.bill_id===b.id,'IDEMPOTENCY_CONFLICT','同一请求编号不能用于其他账单',409);
   record = previous
    ? db.prepare('SELECT * FROM payment_provider_orders WHERE payment_id=?').get(previous.payment_id)
    : db.prepare("SELECT * FROM payment_provider_orders WHERE bill_id=? AND status IN ('creating','pending','success')").get(b.id);
   if (record) {
    core.check(record.channel===channel&&record.adapter_mode===mode,previous?'IDEMPOTENCY_CONFLICT':'PAYMENT_IN_PROGRESS',
     previous?'同一请求编号不能切换支付渠道或模式':'该账单有其他渠道的在途订单，请先查询并关闭',409);
    routeOrder(record,b);
   } else {
    core.check(!db.prepare("SELECT 1 FROM payments WHERE json_extract(data,'$.billId')=? AND status='pending'").get(b.id),
     'CONFLICT','该账单已有待确认支付订单',409);
    const id = uid('pay'), at = iso(), outTradeNo = 'JY'+crypto.randomBytes(15).toString('hex'), amount = billAmount(b.id);
    core.check(Number.isSafeInteger(amount)&&amount>0,'INPUT','支付金额必须大于0分');
    save('payments',{id,owner:b.owner,outlet:b.outlet,month:b.month,billId:b.id,amount:amount/100,currency:'CNY',
     channel,adapterMode:mode,collectionEntity:binding?.entity,status:'pending',createdAt:at,requestedBy:who.subject});
    db.prepare('INSERT INTO payment_provider_orders(payment_id,bill_id,out_trade_no,merchant_id,app_id,actor,binding_version,payer_hash,status,amount_cents,created_at,expires_at,updated_at,channel,adapter_mode,collection_entity,agreement_id,gateway_environment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
     .run(id,b.id,outTradeNo,provider.merchantId,provider.appId,who.actor,a.bindingVersion,payerHash,'creating',amount,at,new Date(Date.now()+30*60*1000).toISOString(),at,channel,mode,binding?.entity||null,binding?.agreementId||null,provider.gatewayEnvironment);
    record=db.prepare('SELECT * FROM payment_provider_orders WHERE payment_id=?').get(id);
    audit(row('payments',id),'payment.'+mode+'.created',requestId,who.subject,{collectionEntity:binding?.entity,gatewayEnvironment:provider.gatewayEnvironment});
   }
   db.prepare('INSERT OR IGNORE INTO payment_idempotency VALUES(?,?,?,?)').run(who.subject,key,b.id,record.payment_id);
  });
  core.check(record.binding_version===a.bindingVersion&&record.payer_hash===payerHash,'PAY_OWNERSHIP_CHANGED','付款人绑定已变化，请总部先核实未完成支付',409);
  core.check(['creating','pending'].includes(record.status),'CONFLICT','该支付尝试已结束，请刷新账单',409);
  core.check(record.expires_at>iso(),'PAY_EXPIRED','预支付已到期，请先查询并关闭旧订单后重试',409);
  if (record.prepay_id) return checkout(record,provider);
  core.check(!inflight.has(record.payment_id),'PAY_BUSY','支付请求正在处理中，请稍后查单',409);
  inflight.add(record.payment_id);
  try {
   const result=await provider.prepay({outTradeNo:record.out_trade_no,amount:record.amount_cents,openid,description:'九盈英才 '+b.month+' 咨询服务费',expiresAt:record.expires_at});
   db.prepare("UPDATE payment_provider_orders SET prepay_id=?,status=CASE WHEN status='creating' THEN 'pending' ELSE status END,last_error=NULL,updated_at=? WHERE payment_id=?").run(result.prepayId,iso(),record.payment_id);
   reauth?.();
   activeBill(who,b.id);
   return checkout(record,provider,result);
  } catch (error) {
   db.prepare('UPDATE payment_provider_orders SET last_error=?,updated_at=? WHERE payment_id=?').run(error.providerCode||error.code||'INTERNAL',iso(),record.payment_id);
   throw error;
  } finally {
   inflight.delete(record.payment_id);
  }
 }

 function forPayment(id) {
  const order = db.prepare('SELECT * FROM payment_provider_orders WHERE payment_id=?').get(id);
  core.check(order,'NOT_FOUND','无渠道支付订单',404);
  return order;
 }

 function notificationEntry(table,notice,tableIdKey,expectedId,origin) {
  if (!notice) return false;
  const key = origin=== 'real:wechat'&&table==='payment_notifications' ? notice.id : origin+':'+notice.id;
  const old = db.prepare('SELECT * FROM '+table+' WHERE id=?').get(key);
  core.check(!old||old[tableIdKey]===expectedId&&old.body_digest===notice.digest,'PAY_NOTIFICATION_CONFLICT','重复通知内容发生变化',409);
  if (old) return true;
  db.prepare('INSERT INTO '+table+' VALUES(?,?,?,?)').run(key,expectedId,notice.digest,iso());
  return false;
 }

 function validateTrade(data,order) {
  const amount = data.amount;
  const success = data.trade_state==='SUCCESS';
  const record = value => value!==null&&typeof value==='object'&&!Array.isArray(value);
  core.check((amount===undefined||record(amount))&&(data.payer===undefined||record(data.payer)),
   'PAY_RESPONSE','支付响应字段结构无效',502);
  const totals = (!success&&amount?.total===undefined)||amount?.total===order.amount_cents;
  const currency = (!success&&amount?.currency===undefined)||amount?.currency===order.currency;
  const openid = data.payer?.openid;
  core.check(data.appid===order.app_id&&data.mchid===order.merchant_id&&totals&&currency
   &&(openid===undefined||typeof openid==='string'&&hash(openid)===order.payer_hash),'PAY_MISMATCH','支付主体或金额不匹配，须人工核实',409);
 }

 function postSuccess(payment,bill,order,data,requestId,notice,contractError) {
  const reference = data.transaction_id;
  core.check(typeof reference==='string'&&reference.length>0&&reference.length<=64
   &&data.trade_type===(order.channel==='wechat'?'JSAPI':'WAP')&&Number.isFinite(Date.parse(data.success_time)),
   'PAY_RESPONSE','支付成功凭证字段不完整',502);
  const providerReference = order.channel==='wechat'&&order.adapter_mode==='real' ? reference : order.adapter_mode+':'+order.channel+':'+reference;
  if (order.status==='success'&&order.provider_transaction===providerReference) return false;
  const anotherOrder=db.prepare('SELECT 1 FROM payment_provider_orders WHERE provider_transaction=?').get(providerReference);
  const reason=contractError||(order.status==='success'?'PAYMENT_REFERENCE_CHANGED'
   : !['creating','pending'].includes(order.status)?'LATE_PAYMENT_SUCCESS'
   : bill.status!=='unpaid'||billAmount(bill.id)!==order.amount_cents||paidReceipt(bill)?'BILL_CHANGED'
   : anotherOrder?'PAYMENT_REFERENCE_CONFLICT':null);
  if (reason) {
   core.check(order.adapter_mode==='real','PAY_MISMATCH','该模拟付款不能变更已确定结果',409);
   const exceptionId=uid('payment-exception'), at=iso();
   const created=db.prepare(`INSERT INTO payment_exceptions(id,payment_id,bill_id,provider_transaction,channel,adapter_mode,merchant_id,app_id,
    reason,amount_cents,currency,provider_paid_at,observed_by,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(payment_id,provider_transaction) DO NOTHING`)
    .run(exceptionId,payment.id,bill.id,reference,order.channel,order.adapter_mode,order.merchant_id,order.app_id,reason,order.amount_cents,
     order.currency,data.success_time,notice?'notification':'query',requestId,at);
   if(created.changes){
    db.prepare('UPDATE payment_provider_orders SET last_error=?,updated_at=? WHERE payment_id=?').run(reason,at,payment.id);
    audit(payment,'payment.real.reconciliation_required',requestId,order.channel+'-provider',{exceptionId,reason});
   }
   return true;
  }
  const at = iso();
  Object.assign(payment,{status:'success',resolvedAt:at,externalReference:reference,channel:order.channel});
  bill.status='paid';
  save('payments',payment);
  save('bills',bill);
  save('receipts',{id:uid('receipt'),owner:bill.owner,outlet:bill.outlet,month:bill.month,status:'success',paymentId:payment.id,billId:bill.id,
   amount:order.amount_cents/100,currency:order.currency,adapterMode:order.adapter_mode,channel:order.channel,collectionEntity:order.collection_entity,
   merchantId:order.merchant_id,appId:order.app_id,externalReference:reference,paidOn:data.success_time,verified:true,createdAt:at});
  db.prepare("UPDATE payment_provider_orders SET status='success',provider_transaction=?,last_error=NULL,updated_at=? WHERE payment_id=?").run(providerReference,at,payment.id);
  save('messages',{id:uid('msg'),owner:bill.owner,outlet:bill.outlet,status:'unread',read:false,target:'fees',recordId:bill.id,paymentId:payment.id,
   title:order.adapter_mode==='mock'?'模拟付款已确认':'服务费付款已核验到账',body:'付款结果已更新，可查看账单详情',createdAt:at});
  db.prepare("UPDATE businessTasks SET status='resolved',data=json_set(data,'$.status','resolved','$.resolvedAt',?,'$.updatedAt',?,'$.completedAt',?,'$.closeReason','business_fact','$.resolution','business_fact') WHERE json_extract(data,'$.recordId')=? AND json_extract(data,'$.kind') IN ('bill_unpaid','bill_overdue') AND status<>'resolved'").run(at,at,at,bill.id);
  audit(payment,'payment.'+order.adapter_mode+'.verified',requestId,order.channel+'-provider');
  return false;
 }

 function apply(data,requestId,origin,notice,expectedTradeNo) {
  return store.transaction(()=>{
   core.check(typeof data?.out_trade_no==='string','PAY_RESPONSE','支付响应缺少商户订单号',502);
   core.check(!expectedTradeNo||data.out_trade_no===expectedTradeNo,'PAY_MISMATCH','查单返回的商户订单号不匹配',409);
   const order = db.prepare('SELECT * FROM payment_provider_orders WHERE out_trade_no=?').get(data.out_trade_no);
   core.check(order&&origin===order.adapter_mode+':'+order.channel,'NOT_FOUND','该渠道无对应支付订单',404);
   const payment = row('payments',order.payment_id), bill = row('bills',order.bill_id);
   const provider=orderProvider(order);
   validateTrade(data,order);
   let contractError;
   try{orderContract(order,bill,provider);}
   catch(error){
    if(data.trade_state!=='SUCCESS'||!['PAY_CONTRACT_MISMATCH','PAY_MERCHANT_MAPPING','PAY_MERCHANT_MISMATCH'].includes(error.code))throw error;
    contractError=error.code;
   }
   if (notificationEntry('payment_notifications',notice,'payment_id',payment.id,origin)) {
    const reconciliationRequired=!!db.prepare('SELECT 1 FROM payment_exceptions WHERE payment_id=? LIMIT 1').get(payment.id);
    return reconciliationRequired?{payment,bill,reconciliationRequired}:{payment,bill};
   }
   if (data.trade_state==='SUCCESS') {
    const reconciliationRequired=postSuccess(payment,bill,order,data,requestId,notice,contractError);
    if(reconciliationRequired)return {payment,bill,reconciliationRequired};
   }
   else if (Object.hasOwn(terminalTrade,data.trade_state)) {
    const status = data.trade_state==='CLOSED'?'closed':'failed';
    core.check(order.status===status||['creating','pending'].includes(order.status),'PAY_MISMATCH','已结束订单不能改写结果',409);
    if (order.status!==status) {
     payment.status=terminalTrade[data.trade_state];
     payment.resolvedAt=iso();
     save('payments',payment);
     db.prepare('UPDATE payment_provider_orders SET status=?,last_error=NULL,updated_at=? WHERE payment_id=?').run(status,payment.resolvedAt,payment.id);
     audit(payment,'payment.'+order.adapter_mode+'.'+status,requestId,order.channel+'-provider');
    }
   } else core.check(['NOTPAY','NOT_FOUND','USERPAYING','REFUND'].includes(data.trade_state),'PAY_RESPONSE','未知支付状态，未修改实收',502);
   return {payment,bill};
  });
 }

 async function readTrade(order) {
  const provider = orderProvider(order);
  if (order.adapter_mode==='real') {
   const data=await provider.query(order.out_trade_no);
   if(order.channel==='alipay'&&order.status==='success'&&data.trade_state==='CLOSED'){
    core.check(order.provider_transaction==='real:alipay:'+data.transaction_id,'PAY_MISMATCH','支付宝已退款交易的原流水不匹配',409);
    return {...data,trade_state:'REFUND'};
   }
   return data;
  }
  return provider.trade(order,{success:'SUCCESS',closed:'CLOSED',failed:'PAYERROR'}[order.status]||'NOTPAY');
 }

 async function query(who,id,requestId) {
  inspect(who,id);
  const order = forPayment(id), data = await readTrade(order);
  return {...apply(data,requestId,order.adapter_mode+':'+order.channel,null,order.out_trade_no),providerTradeState:data.trade_state};
 }

 async function close(who,id,requestId,reauth) {
  const current = await query(who,id,requestId);
  reauth?.();
  return closeObserved(who,id,current,requestId);
 }

 function closeAbsent(id,current,requestId) {
  return store.transaction(()=>{
   const order=forPayment(id),payment=row('payments',id),bill=row('bills',order.bill_id);
   routeOrder(order,bill);
   if (order.status==='closed') return {...current,payment,bill};
   core.check(['creating','pending'].includes(order.status)&&order.expires_at<=iso(),'PAY_CLOSE_UNSAFE','订单状态变化，请查单核实',409);
   const at=iso();
   Object.assign(payment,{status:'cancelled',resolvedAt:at});
   save('payments',payment);
   db.prepare("UPDATE payment_provider_orders SET status='closed',last_error=NULL,updated_at=? WHERE payment_id=?").run(at,id);
   audit(payment,'payment.real.closed',requestId,order.channel+'-provider',{providerState:'NOT_FOUND',reason:'expired_absent'});
   logReconciliation(order,'NOT_FOUND',null,requestId,true);
   return {...current,payment,bill};
  });
 }

 async function closeObserved(who,id,current,requestId) {
  if(current.providerTradeState==='CLOSED')return current;
  if(current.providerTradeState==='SUCCESS')return current;
  core.check(['NOTPAY','NOT_FOUND'].includes(current.providerTradeState),'PAY_CLOSE_UNSAFE','订单处理中或已结束，请查单核实',409);
  const order = forPayment(id);
  core.check(order.expires_at<=iso(),'PAY_NOT_EXPIRED','请在订单支付有效期结束后关闭',409);
  core.check(!inflight.has(id),'PAY_BUSY','支付请求正在处理中，请稍后查单',409);
  if(current.providerTradeState==='NOT_FOUND')return closeAbsent(id,current,requestId);
  const provider = routeOrder(order,current.bill);
  if (order.adapter_mode==='mock') return simulate(who,id,'cancelled',requestId);
  core.check(['creating','pending'].includes(order.status),'PAY_CLOSE_UNSAFE','订单状态变化，请查单核实',409);
  try { await provider.close(order.out_trade_no); }
  catch(error) {
   if(error.code!=='PAY_PROVIDER_REJECTED') throw error;
   const observed=await query(who,id,requestId);
   if(observed.providerTradeState==='SUCCESS'||observed.providerTradeState==='CLOSED')return observed;
   if(observed.providerTradeState==='NOT_FOUND')return closeAbsent(id,observed,requestId);
   throw error;
  }
  const observed=await query(who,id,requestId);
  if(observed.providerTradeState==='NOT_FOUND')return closeAbsent(id,observed,requestId);
  return observed;
 }

 function notify(headers,raw,requestId,channel='wechat') {
  const provider = providers.real[channel];
  const notice = provider.notification(headers,raw);
  if(notice.refund) return acceptRefundNotice(notice.refund,requestId,channel);
  core.check(notice.data.trade_state==='SUCCESS','PAY_NOTIFICATION','非支付成功通知');
  const entry={id:notice.id,digest:digest(notice.data)};
  if(env.NODE_ENV==='production'&&channel==='alipay')return confirmAlipayNotice(notice.data,requestId,entry);
  return apply(notice.data,requestId,'real:'+channel,entry);
 }

 async function confirmAlipayNotice(data,requestId,notice) {
  const order=db.prepare("SELECT * FROM payment_provider_orders WHERE out_trade_no=? AND channel='alipay' AND adapter_mode='real'")
   .get(data.out_trade_no??'');
  core.check(order,'NOT_FOUND','该渠道无对应支付订单',404);
  orderProvider(order);
  validateTrade(data,order);
  const seen=db.prepare('SELECT 1 FROM payment_notifications WHERE id=?').get('real:alipay:'+notice.id);
  if(!seen){
   // Production WAP checkout is signed locally. Confirm the fact with the production gateway before accepting the callback.
   const confirmation=await readTrade(order);
   core.check(confirmation.trade_state==='SUCCESS','PAY_CONFIRMATION_PENDING','支付宝正式渠道尚未确认付款，请稍后查单',503);
   core.check(confirmation.out_trade_no===order.out_trade_no&&confirmation.transaction_id===data.transaction_id,
    'PAY_MISMATCH','支付宝正式查单凭证与通知不一致',409);
   validateTrade(confirmation,order);
  }
  return apply(data,requestId,'real:alipay',notice,order.out_trade_no);
 }

 function simulate(who,id,outcome,requestId) {
  const {bill,payment}=inspect(who,id),order=forPayment(id);
  core.check(core.own(who.actor)===payment.owner,'FORBIDDEN','仅本人可操作模拟付款',403);
  core.check(order.adapter_mode==='mock','MOCK_DISABLED','仅模拟订单允许此操作',403);
  const states={success:'SUCCESS',failed:'PAYERROR',cancelled:'CLOSED'};
  core.check(Object.hasOwn(states,outcome),'INPUT','模拟结果无效');
  const provider=routeOrder(order,bill), data=provider.trade(order,states[outcome]);
  const notice = {id:order.out_trade_no+'-'+outcome,digest:digest({...data,success_time:undefined})};
  return apply(data,requestId,'mock:'+order.channel,notice,order.out_trade_no);
 }

 function forRefund(id) {
  const refund = db.prepare('SELECT * FROM payment_refund_orders WHERE id=?').get(id);
  core.check(refund,'NOT_FOUND','退款订单不存在',404);
  return refund;
 }

 function refundView(refund) {
  return {id:refund.id,paymentId:refund.payment_id,billId:refund.bill_id,refundRequestId:refund.refund_request_id,
   channel:refund.channel,adapterMode:refund.adapter_mode,amountCents:refund.amount_cents,currency:refund.currency,status:refund.status,updatedAt:refund.updated_at};
 }

 function channelRefund(requestId) {
  return db.prepare(`SELECT * FROM payment_refund_orders WHERE refund_request_id=?
   ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'success' THEN 1 ELSE 2 END,created_at DESC,id DESC LIMIT 1`).get(requestId);
 }

 function refundChannel(who,id) {
  core.check(['finance','manager'].includes(who.actor),'FORBIDDEN','仅总部财务或管理层可以查看渠道退款',403);
  const business=row('refundRequests',id),receipt=row('receipts',business.receiptId);
  const refund=channelRefund(id);
  const order=receipt.paymentId&&db.prepare("SELECT p.payment_id,p.channel,r.status AS receipt_status FROM payment_provider_orders p JOIN receipts r ON r.id=? WHERE p.payment_id=? AND p.adapter_mode='real' AND p.status='success'").get(receipt.id,receipt.paymentId);
  return {refundRequestId:business.id,requestStatus:business.status,amountCents:Math.round(business.amount*100),paymentId:order?.payment_id||null,
   channel:order?.channel||null,canStart:!!(order?.receipt_status==='success'&&business.status==='approved'&&!refund&&!hasInvoice(receipt.id)),
   order:refund?{...refundView(refund),queryAttempts:refund.query_attempts,manualReview:refund.status==='pending'&&refund.query_attempts>=maxQueryAttempts}:null};
 }

 function hasInvoice(receiptId) {
  return db.prepare("SELECT 1 FROM invoiceRequests WHERE json_extract(data,'$.receiptId')=? AND status IN ('pending','issued','red_pending') LIMIT 1").get(receiptId);
 }

 async function refundPayment(who,id,p,key,requestId,reauth) {
  keyCheck(key);
  core.check(['finance','manager'].includes(who.actor),'FORBIDDEN','仅总部财务或管理层可以发起退款',403);
  const {payment,bill}=inspect(who,id), order=forPayment(id);
  const provider=routeOrder(order,bill), simulated=order.adapter_mode==='mock';
  core.check(p.simulation===undefined||typeof p.simulation==='boolean','INPUT','退款模式无效');
  core.check(simulated ? p.simulation===true : p.simulation!==true,'INPUT','退款模式与支付订单不一致');
  core.check(order.status==='success','CONFLICT','仅已核验实收可以退款',409);
  const receipt = db.prepare("SELECT id FROM receipts WHERE json_extract(data,'$.paymentId')=? AND status='success'").get(id);
  core.check(receipt,'CONFLICT','实收流水不存在',409);
  if (!simulated) core.check(typeof p.refundRequestId==='string'&&p.refundRequestId.length<=128,'INPUT','请指定已核准的退款申请');
  let refund,created=false;
  store.transaction(()=>{
   const business = simulated ? null : row('refundRequests',p.refundRequestId);
   const amount = simulated ? p.amountCents : Math.round(business.amount*100);
   core.check(Number.isSafeInteger(amount)&&amount>0,'INPUT','退款金额须为正整数分');
   const previous = db.prepare(`SELECT r.* FROM payment_refund_idempotency i JOIN payment_refund_orders r ON r.id=i.refund_id
    WHERE i.subject=? AND i.request_key=?`).get(who.subject,key);
   if (previous) {
    core.check(previous.payment_id===id&&previous.amount_cents===amount&&previous.refund_request_id===(business?.id||null),
     'IDEMPOTENCY_CONFLICT','同一请求编号不能用于不同退款',409);
    refund=previous;
    return;
   }
   core.check(!business||business.receiptId===receipt.id&&business.billId===bill.id,'CONFLICT','退款申请与本付款不一致',409);
   refund=business&&channelRefund(business.id);
   if(refund){
    core.check(refund.payment_id===id&&refund.amount_cents===amount,'PAY_MISMATCH','退款申请与渠道订单不一致',409);
    db.prepare('INSERT INTO payment_refund_idempotency VALUES(?,?,?)').run(who.subject,key,refund.id);
    return;
   }
   core.check(!business||business.status==='approved','CONFLICT','退款申请须经复核批准',409);
   core.check(!hasInvoice(receipt.id),'CONFLICT','须先处理相应发票',409);
   const recorded = db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM refundRequests WHERE json_extract(data,'$.receiptId')=? AND status IN ('approved','pending','recorded') AND id<>?").get(receipt.id,business?.id||'').n;
   const simulatedPending = simulated ? db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payment_refund_orders WHERE receipt_id=? AND status='pending'").get(receipt.id).n : 0;
   core.check(recorded+simulatedPending+amount<=order.amount_cents,'CONFLICT','退款金额超出可退余额',409);
   const refundId='JR'+crypto.randomBytes(15).toString('hex'),at=iso();
   db.prepare('INSERT INTO payment_refund_orders(id,payment_id,bill_id,receipt_id,refund_request_id,channel,adapter_mode,amount_cents,currency,status,merchant_id,app_id,requested_by,request_key,created_at,updated_at,next_query_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(refundId,id,bill.id,receipt.id,business?.id||null,order.channel,order.adapter_mode,amount,order.currency,'pending',order.merchant_id,order.app_id,who.subject,key,at,at,new Date(Date.now()+60000).toISOString());
   db.prepare('INSERT INTO payment_refund_idempotency VALUES(?,?,?)').run(who.subject,key,refundId);
   audit({...payment,id:refundId},'payment.refund.created',requestId,who.subject,{paymentId:id,adapterMode:order.adapter_mode});
   refund=forRefund(refundId);
   created=true;
  });
  if (simulated||!created) return refundView(refund);
  if (inflight.has(refund.id)) return refundView(refund);
  inflight.add(refund.id);
  try {
   reauth?.();
   await provider.refund(order.out_trade_no,refund.id,refund.amount_cents,order.amount_cents);
   reauth?.();
   return await queryRefund(who,refund.id,requestId);
  } catch (error) {
   db.prepare("UPDATE payment_refund_orders SET last_error=?,updated_at=? WHERE id=? AND status='pending'").run(error.providerCode||error.code||'INTERNAL',iso(),refund.id);
   throw error;
  } finally {
   inflight.delete(refund.id);
  }
 }

 function applyRefund(expectedId,order,data,requestId,notice) {
  return store.transaction(()=>{
   const refund=forRefund(expectedId), bill=row('bills',refund.bill_id);
   routeOrder(order,bill);
   core.check(refund.payment_id===order.payment_id&&data.id===refund.id&&data.tradeNo===order.out_trade_no
    &&data.merchantId===refund.merchant_id&&data.appId===refund.app_id&&data.amount===refund.amount_cents&&data.currency===refund.currency,
    'PAY_MISMATCH','退款订单、币种、金额或商户不匹配',409);
   core.check(['success','pending','failed'].includes(data.state),'PAY_RESPONSE','退款状态未知',502);
   if (notificationEntry('payment_refund_notifications',notice,'refund_id',refund.id,refund.adapter_mode+':'+refund.channel)) return refundView(refund);
   if (refund.status!=='pending') {
    core.check(refund.status===data.state&&(!data.reference||data.reference===refund.provider_refund_id),
     'PAY_MISMATCH','已确认退款的结果或流水发生变化',409);
    return refundView(refund);
   }
   if (data.state==='pending') return refundView(refund);
   const at=iso();
   if (data.state==='success') {
    core.check(typeof data.reference==='string'&&data.reference.length>=1&&data.reference.length<=128,'PAY_RESPONSE','退款成功缺少渠道凭证',502);
    const reference=refund.channel+':'+refund.adapter_mode+':'+data.reference;
    core.check(!db.prepare("SELECT 1 FROM refundRequests WHERE json_extract(data,'$.reference')=?").get(reference),'PAY_MISMATCH','该退款流水已登记',409);
    const recorded = db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM refundRequests WHERE json_extract(data,'$.receiptId')=? AND status='recorded'").get(refund.receipt_id).n;
    core.check(recorded+refund.amount_cents<=order.amount_cents,'PAY_MISMATCH','退款总额超出已付款金额，须人工核对',409);
    const business = refund.refund_request_id ? row('refundRequests',refund.refund_request_id) : {id:'refund-mock-'+refund.id,owner:bill.owner,outlet:bill.outlet,
     month:bill.month,receiptId:refund.receipt_id,billId:bill.id,amount:refund.amount_cents/100,reason:'模拟退款',createdAt:at};
    core.check(!refund.refund_request_id||business.status==='approved'&&business.receiptId===refund.receipt_id&&Math.round(business.amount*100)===refund.amount_cents,
     'PAY_MISMATCH','已核准退款申请发生变化，须人工核对',409);
    Object.assign(business,{status:'recorded',reference,customerReference:data.reference,refundedOn:shanghaiDate(at),externalExecuted:refund.adapter_mode==='real',adapterMode:refund.adapter_mode,
     providerRefundOrderId:refund.id,recordedBy:refund.channel+'-provider'});
    save('refundRequests',business);
    bill.refundAmount=db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM refundRequests WHERE json_extract(data,'$.billId')=? AND status='recorded'").get(bill.id).n/100;
    save('bills',bill);
    save('messages',{id:uid('msg'),owner:bill.owner,outlet:bill.outlet,status:'unread',read:false,target:'fees',recordId:bill.id,
     refundId:refund.id,refundRequestId:business.id,
     title:refund.adapter_mode==='mock'?'模拟退款已确认':'服务费退款已核验',body:'可查看本账单的退款记录',createdAt:at});
   }
   db.prepare('UPDATE payment_refund_orders SET status=?,provider_refund_id=?,updated_at=?,last_error=NULL WHERE id=?')
    .run(data.state,data.reference||null,at,refund.id);
   audit({...bill,id:refund.id,channel:refund.channel},'payment.refund.'+data.state,requestId,refund.channel+'-provider',{paymentId:order.payment_id,adapterMode:refund.adapter_mode});
   return refundView(forRefund(refund.id));
  });
 }

 async function queryRefund(who,id,requestId,notice) {
  const refund=forRefund(id), {bill}=inspect(who,refund.payment_id), order=forPayment(refund.payment_id), provider=routeOrder(order,bill);
  if (refund.adapter_mode==='mock') return refundView(refund);
  const result=await provider.queryRefund(order.out_trade_no,id);
  return applyRefund(id,order,result,requestId,notice);
 }

 function simulateRefund(who,id,outcome,requestId) {
  core.check(['finance','manager'].includes(who.actor),'FORBIDDEN','仅总部财务或管理层可以模拟退款',403);
  const refund=forRefund(id);
  core.check(refund.adapter_mode==='mock','MOCK_DISABLED','仅模拟订单允许此操作',403);
  core.check(['success','failed'].includes(outcome),'INPUT','模拟退款结果无效');
  const order=forPayment(refund.payment_id), {bill}=inspect(who,refund.payment_id),provider=routeOrder(order,bill);
  const data=provider.refundResult(refund,order,outcome);
  return applyRefund(id,order,data,requestId,{id:id+'-'+outcome,digest:digest(data)});
 }

 function notifyRefund(headers,raw,requestId,channel) {
  return acceptRefundNotice(providers.real[channel].refundNotification(headers,raw),requestId,channel);
 }

 async function acceptRefundNotice(notice,requestId,channel) {
  const refund=forRefund(notice.refundId),order=forPayment(refund.payment_id);
  core.check(refund.adapter_mode==='real'&&refund.channel===channel&&order.out_trade_no===notice.tradeNo
   &&refund.merchant_id===notice.merchantId&&refund.app_id===notice.appId,'PAY_MISMATCH','退款通知与原渠道订单不匹配',409);
  const input={id:notice.id,digest:digest(notice)};
  const seen=db.prepare('SELECT refund_id,body_digest FROM payment_refund_notifications WHERE id=?').get('real:'+channel+':'+input.id);
  if(seen){
   core.check(seen.refund_id===refund.id&&seen.body_digest===input.digest,'PAY_NOTIFICATION_CONFLICT','重复通知内容发生变化',409);
   return refundView(refund);
  }
  if (notice.result) return applyRefund(refund.id,order,notice.result,requestId,input);
  return queryRefund({actor:'finance'},refund.id,requestId,input);
 }

 function guard(command,p) {
  if (command==='payment.resolve'&&db.prepare('SELECT 1 FROM payment_provider_orders WHERE payment_id=?').get(p.id??'')){
   core.fail('PAYMENT_CHANNEL','渠道支付仅支持服务端核验结果',409);
  }
  if (command==='payment.start'&&db.prepare("SELECT 1 FROM payment_provider_orders WHERE bill_id=? AND status IN ('creating','pending')").get(p.billId??'')){
   core.fail('PAYMENT_IN_PROGRESS','请继续处理现有支付订单',409);
  }
  if (command==='refund.record'){
   const linked=db.prepare(`SELECT p.payment_id FROM refundRequests f JOIN receipts r ON r.id=json_extract(f.data,'$.receiptId')
    JOIN payment_provider_orders p ON p.payment_id=json_extract(r.data,'$.paymentId')
    WHERE f.id=? AND p.adapter_mode='real'`).get(p.id??'');
   if(linked)core.fail('PAYMENT_CHANNEL','渠道实收须从原支付渠道核验退款，请查看退款处理入口',409);
  }
  let billId=null;
  if(command==='offline.submit')billId=p.billId;
  if(command==='offline.review'&&p.decision==='approve'&&typeof p.id==='string')billId=JSON.parse(db.prepare('SELECT data FROM offlinePayments WHERE id=?').get(p.id)?.data||'null')?.billId;
  if(command==='billing.correct.review'&&p.decision==='approve'&&typeof p.id==='string')billId=JSON.parse(db.prepare('SELECT data FROM billCorrections WHERE id=?').get(p.id)?.data||'null')?.billId;
  if(billId){
   core.check(!paymentHold(billId),'PAYMENT_RECONCILIATION_REQUIRED','账单存在待核对的支付，请联系总部',409);
   core.check(!db.prepare("SELECT 1 FROM payment_provider_orders WHERE bill_id=? AND status IN ('creating','pending')").get(billId),
    'PAYMENT_IN_PROGRESS','存在未确认的支付订单，请先查单并关闭后再处理账单或线下收款',409);
  }
 }

 function logReconciliation(order,state,error,requestId,closed=false) {
  const status=error?'exception':state==='SUCCESS'?'matched':state==='CLOSED'||closed?'closed':'pending';
  db.prepare('INSERT INTO payment_reconciliation_records VALUES(?,?,?,?,?,?,?,?,?)')
   .run(uid('reconciliation'),order.payment_id,order.channel,order.adapter_mode,status,state||null,error||null,requestId,iso());
  return {paymentId:order.payment_id,channel:order.channel,status,providerState:state||null};
 }

 async function reconcilePayment(who,id,requestId) {
  core.check(['manager','finance'].includes(who.actor),'FORBIDDEN','仅总部财务或管理层可以对账',403);
  const order=forPayment(id);
  try {
   const result=await query(who,id,requestId);
   return logReconciliation(order,result.providerTradeState,result.reconciliationRequired?'RECONCILIATION_REQUIRED':null,
    requestId,result.payment.status==='cancelled');
  } catch(error) {
   logReconciliation(order,null,error.code||'INTERNAL',requestId);
   throw error;
  }
 }

 function paymentExceptions(who,{limit='25',offset='0'}={}) {
  core.check(['finance','manager'].includes(who.actor),'FORBIDDEN','仅总部财务或管理层可以查看支付对账异常',403);
  const size=Number(limit),start=Number(offset);
  core.check(/^\d+$/.test(String(limit))&&Number.isInteger(size)&&size>=1&&size<=100
   &&/^\d+$/.test(String(offset))&&Number.isSafeInteger(start)&&start>=0,'INPUT','支付异常分页参数无效');
  const rows=db.prepare(`SELECT id,payment_id paymentId,bill_id billId,provider_transaction providerReference,channel,reason,amount_cents amountCents,
   currency,provider_paid_at paidAt,observed_by observedBy,request_id requestId,status,created_at createdAt
   FROM payment_exceptions WHERE adapter_mode='real' AND status='open' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
   .all(size+1,start);
  return {items:rows.slice(0,size),offset:start,nextOffset:rows.length>size?start+size:null};
 }

 async function reconcile(limit=1) {
  core.check(Number.isInteger(limit)&&limit>=1&&limit<=10,'INPUT','查单批次为1—10');
  const channels=Object.keys(providers.real).filter(key=>providers.real[key].ready);
  if(!channels.length)return {processed:0};
  const at=iso(),placeholders=channels.map(()=>'?').join(',');
  const rows=db.prepare(`SELECT 'payment' kind,payment_id id,channel,query_attempts,COALESCE(next_query_at,created_at) due_at
    FROM payment_provider_orders WHERE adapter_mode='real' AND channel IN (${placeholders}) AND status IN ('creating','pending')
      AND query_attempts<? AND COALESCE(next_query_at,created_at)<=?
    UNION ALL
   SELECT 'refund' kind,id,channel,query_attempts,COALESCE(next_query_at,created_at) due_at
    FROM payment_refund_orders WHERE adapter_mode='real' AND channel IN (${placeholders}) AND status='pending'
      AND query_attempts<? AND COALESCE(next_query_at,created_at)<=?
   ORDER BY due_at,id LIMIT ?`).all(...channels,maxQueryAttempts,at,...channels,maxQueryAttempts,at,limit);
  let processed=0;
  for (const job of rows) {
   if(inflight.has(job.id))continue;
   const refund=job.kind==='refund';
   const table=refund?'payment_refund_orders':'payment_provider_orders';
   const idColumn=refund?'id':'payment_id';
   const status=refund?"status='pending'":"status IN ('creating','pending')";
   const delay=Math.min(60,2**job.query_attempts)*60000;
   const claimed=db.prepare("UPDATE "+table+" SET query_attempts=query_attempts+1,last_query_at=?,next_query_at=? WHERE "+idColumn+"=? AND query_attempts=? AND "+status)
    .run(at,new Date(Date.now()+delay).toISOString(),job.id,job.query_attempts);
   if (!claimed.changes) continue;
   const requestId=uid('reconcile'),order=refund?null:forPayment(job.id);
   try {
    if(refund){
     const result=await queryRefund(financeWorker,job.id,requestId);
     if(result.status==='pending'&&job.query_attempts+1===maxQueryAttempts)recordRefundEscalation(result,requestId);
    } else {
     let result=await query(financeWorker,job.id,requestId);
     const expired=['NOTPAY','NOT_FOUND'].includes(result.providerTradeState)&&order.expires_at<=iso();
     if(expired)result=await closeObserved(financeWorker,job.id,result,requestId);
     // The expiry transition for signed absence is logged atomically with the close.
     if(!(expired&&result.providerTradeState==='NOT_FOUND'&&result.payment.status==='cancelled'))
      logReconciliation(order,result.providerTradeState,result.reconciliationRequired?'RECONCILIATION_REQUIRED':null,requestId);
    }
   } catch(error) {
    db.prepare("UPDATE "+table+" SET last_error=?,updated_at=? WHERE "+idColumn+"=? AND "+status)
     .run(error.providerCode||error.code||'INTERNAL',iso(),job.id);
    if(refund){
     if(job.query_attempts+1===maxQueryAttempts)recordRefundEscalation(refundView(forRefund(job.id)),requestId);
    } else logReconciliation(order,null,error.code||'INTERNAL',requestId);
   }
   processed++;
  }
  return {processed};
 }

 function recordRefundEscalation(refund,requestId) {
  if(refund.status!=='pending')return;
  store.transaction(()=>{
   const bill=row('bills',refund.billId);
   audit({...bill,id:refund.id,channel:refund.channel},'payment.refund.manual_review_required',requestId,'payment-worker',{paymentId:refund.paymentId});
  });
 }

 function queueHealth() {
  const summary=table=>db.prepare("SELECT status,count(*) count,sum(CASE WHEN status IN ('creating','pending') AND query_attempts>=? THEN 1 ELSE 0 END) manualReview FROM "+table+" GROUP BY status")
   .all(maxQueryAttempts);
  return {payments:summary('payment_provider_orders'),refunds:summary('payment_refund_orders'),
   paymentExceptions:db.prepare("SELECT count(*) count FROM payment_exceptions WHERE status='open' AND adapter_mode='real'").get().count};
 }

 return {ready:capabilities.wechat||capabilities.alipay,capabilities,prepay,query,close,inspect,notify,guard,reconcile,
  simulate,refundPayment,queryRefund,notifyRefund,simulateRefund,reconcilePayment,paymentExceptions,refundChannel,queueHealth};
}

module.exports={paymentService};
