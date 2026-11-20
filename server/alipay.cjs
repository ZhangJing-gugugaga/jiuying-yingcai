'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {check, fail} = require('../shared/core.cjs');
const productionGateway='https://openapi.alipay.com/gateway.do';
const sandboxGateway='https://openapi-sandbox.dl.alipaydev.com/gateway.do';

function canonical(fields) {
 return Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => key + '=' + value).join('&');
}

function cents(value) {
 const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
 check(match, 'PAY_RESPONSE', '支付宝金额格式无效', 502);
 return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

function yuan(amount) {
 return Math.floor(amount / 100) + '.' + String(amount % 100).padStart(2, '0');
}

function alipayAdapter(env, fetcher = fetch) {
 const fields = ['ALIPAY_APP_ID','ALIPAY_MERCHANT_ID','ALIPAY_PRIVATE_KEY_PATH','ALIPAY_PUBLIC_KEY_PATH','ALIPAY_GATEWAY','ALIPAY_NOTIFY_URL'];
 const enabled = env.ADAPTER_MODE === 'real' && env.ALIPAY_ENABLED === '1' && env.ALIPAY_PRODUCT === 'wap' && env.ALIPAY_PRODUCT_AUTHORIZED === '1' && fields.every(key => env[key]);
 const production = env.NODE_ENV==='production';
 const gateway=env.ALIPAY_GATEWAY,appId=env.ALIPAY_APP_ID,merchantId=env.ALIPAY_MERCHANT_ID;
 const validGateway = gateway===productionGateway||!production&&gateway===sandboxGateway;
 const validIdentity = !production||(/^2[0-9]{15}$/.test(appId||'')&&/^2088[0-9]{12}$/.test(merchantId||''));
 let merchantKey, alipayKey;
 function config() {
  check(enabled, 'REAL_ADAPTER_UNAVAILABLE', '支付宝未开通或凭证不完整', 503);
  check(validGateway&&validIdentity&&/^https:\/\/[^/]+\/.+/.test(env.ALIPAY_NOTIFY_URL),
   'CONFIG', '支付宝网关、商户应用或HTTPS通知地址无效', 503);
  if (merchantKey && alipayKey) return;
  try {
   const keys = [crypto.createPrivateKey(fs.readFileSync(env.ALIPAY_PRIVATE_KEY_PATH)), crypto.createPublicKey(fs.readFileSync(env.ALIPAY_PUBLIC_KEY_PATH))];
   if (keys.some(key => key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048)) throw new Error();
   [merchantKey, alipayKey] = keys;
  } catch {
   fail('CONFIG', '支付宝签名密钥文件无效', 503);
  }
 }
 const localDate = at => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(at)).replace(',','');
 function parameters(method, biz, extra = {}) {
  config();
  const fields = {app_id:appId,method,format:'JSON',charset:'utf-8',sign_type:'RSA2',timestamp:localDate(Date.now()),version:'1.0',biz_content:JSON.stringify(biz),...extra};
  return {...fields, sign:crypto.sign('RSA-SHA256', Buffer.from(canonical(fields)), merchantKey).toString('base64')};
 }
 function verify(raw, signature) {
  check(typeof signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature) && crypto.verify('RSA-SHA256', Buffer.from(raw), alipayKey, Buffer.from(signature,'base64')), 'PAY_SIGNATURE', '支付宝RSA2签名校验失败', 401);
 }
 async function request(method, biz) {
  const form = new URLSearchParams(parameters(method,biz));
  let response;
  try {
   response = await fetcher(gateway,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(8000)});
  } catch {
   fail('PAY_PROVIDER_UNAVAILABLE','支付宝暂时不可用，结果请查单确认',503);
  }
  let count = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
   count += chunk.length;
   check(count <= 131072,'PAY_RESPONSE','支付宝响应过大',502);
   chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  // Verify the exact response object substring sent by the provider.
  const responseKey = method.replaceAll('.','_') + '_response';
  const match = /^\s*\{\s*"([a-z_]+_response)"\s*:\s*(\{[\s\S]*\})\s*,\s*"sign"\s*:\s*"([A-Za-z0-9+/=]+)"\s*\}\s*$/.exec(raw);
  check(match?.[1] === responseKey || match?.[1] === 'error_response','PAY_RESPONSE','支付宝响应格式无效',502);
  verify(match[2],match[3]);
  let data;
  try { data = JSON.parse(match[2]); } catch { fail('PAY_RESPONSE','支付宝响应不是合法JSON',502); }
  if (!response.ok || data.code !== '10000') {
   throw Object.assign(new Error('支付宝请求未确认，请查单或联系总部核实'),{code:'PAY_PROVIDER_REJECTED',status:503,
    providerCode:String(data.sub_code || data.code || 'UNKNOWN').slice(0,80),providerResultCode:data.code,providerHttpOk:response.ok});
  }
  return data;
 }
 function payment(data, notification = false) {
  const state = {WAIT_BUYER_PAY:'NOTPAY',TRADE_SUCCESS:'SUCCESS',TRADE_FINISHED:'SUCCESS',TRADE_CLOSED:'CLOSED'}[data.trade_status];
  check(state,'PAY_RESPONSE','支付宝交易状态未知',502);
  const paidTime = data.gmt_payment || data.send_pay_date;
  return {
   out_trade_no:data.out_trade_no, transaction_id:data.trade_no, trade_type:'WAP', trade_state:state,
   appid:notification ? data.app_id : data.app_id || appId,
   mchid:notification ? data.seller_id : data.seller_id || merchantId,
   ...(data.total_amount !== undefined ? {amount:{total:cents(data.total_amount),currency:data.currency || 'CNY'}} : {}),
   ...(paidTime ? {success_time:paidTime.replace(' ','T')+(paidTime.includes('T')?'':'+08:00')} : {})
  };
 }
 function refundNotice(data) {
  return {id:data.notify_id,refundId:data.out_biz_no,tradeNo:data.out_trade_no,merchantId:data.seller_id,appId:data.app_id};
 }
 function parseNotice(raw) {
  config();
  const pairs = [...new URLSearchParams(raw)];
  check(new Set(pairs.map(([key])=>key)).size === pairs.length,'PAY_NOTIFICATION','支付宝回调字段重复');
  const {sign,sign_type,...fields} = Object.fromEntries(pairs);
  check(sign_type === 'RSA2','PAY_SIGNATURE','支付宝回调必须使用RSA2',401);
  verify(canonical(fields),sign);
  check(typeof fields.notify_id === 'string' && fields.notify_id.length>0 && fields.notify_id.length<=128,'PAY_NOTIFICATION','支付宝通知编号无效');
  return fields;
 }
 return {
  ready:!!(enabled&&validGateway&&validIdentity), config, merchantId, appId,
  gatewayEnvironment:gateway===sandboxGateway?'sandbox':production?'production':'test',
  clientParams(prepayId) { return {checkoutUrl:prepayId}; },
  async prepay({outTradeNo,amount,description,expiresAt}) {
   const form = parameters('alipay.trade.wap.pay',{out_trade_no:outTradeNo,total_amount:yuan(amount),subject:description,product_code:'QUICK_WAP_WAY',time_expire:localDate(expiresAt)},{notify_url:env.ALIPAY_NOTIFY_URL});
   const prepayId = gateway + '?' + new URLSearchParams(form);
   return {prepayId,checkout:{checkoutUrl:prepayId}};
  },
  async query(tradeNo) {
   try { return payment(await request('alipay.trade.query',{out_trade_no:tradeNo})); }
   catch (error) {
    if (error.code!=='PAY_PROVIDER_REJECTED'||error.providerCode!=='ACQ.TRADE_NOT_EXIST'||error.providerResultCode!=='40004'||!error.providerHttpOk) throw error;
    return {out_trade_no:tradeNo,trade_state:'NOT_FOUND',appid:appId,mchid:merchantId};
   }
  },
  close(tradeNo) { return request('alipay.trade.close',{out_trade_no:tradeNo}); },
  notification(_headers,raw) {
   const data=parseNotice(raw);
   if(data.out_biz_no&&(data.refund_fee||data.gmt_refund)) return {refund:refundNotice(data)};
   return {id:data.notify_id,data:payment(data,true)};
  },
  refund(tradeNo,refundId,amount) { return request('alipay.trade.refund',{out_trade_no:tradeNo,out_request_no:refundId,refund_amount:yuan(amount)}); },
  async queryRefund(tradeNo,refundId) {
   const result=await request('alipay.trade.fastpay.refund.query',{out_trade_no:tradeNo,out_request_no:refundId});
   return {id:result.out_request_no,tradeNo:result.out_trade_no,reference:result.trade_no?result.trade_no+'-'+refundId:undefined,
    amount:cents(result.refund_amount),currency:'CNY',state:{REFUND_SUCCESS:'success',REFUND_PROCESSING:'pending',REFUND_FAIL:'failed'}[result.refund_status]||'pending',
    merchantId:result.seller_id||merchantId,appId:result.app_id||appId};
  },
  refundNotification(_headers,raw) {
   const data=parseNotice(raw);
   // A signed refund hint alone is not final: the service queries the exact refund with the same credential.
   return refundNotice(data);
  },
  billLink(day) { return request('alipay.data.dataservice.bill.downloadurl.query',{bill_type:'trade',bill_date:day}); }
 };
}

module.exports = {alipayAdapter,canonical};
