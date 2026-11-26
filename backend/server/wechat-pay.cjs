'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),core=require('../shared/core.cjs');
function wechatPay(env,fetcher=fetch){const fields=['WECHAT_APP_ID','WECHAT_MCH_ID','WECHAT_API_V3_KEY','WECHAT_CERT_SERIAL','WECHAT_PRIVATE_KEY_PATH','WECHAT_PAY_PUBLIC_KEY_ID','WECHAT_PAY_PUBLIC_KEY_PATH','WECHAT_PAY_NOTIFY_URL'];const enabled=env.WECHAT_PAY_ENABLED==='1'&&env.ADAPTER_MODE==='real'&&fields.every(k=>env[k]);const production=env.NODE_ENV==='production',validIdentity=!production||(/^wx[0-9a-z]{16}$/.test(env.WECHAT_APP_ID||'')&&/^[1-9][0-9]{7,31}$/.test(env.WECHAT_MCH_ID||''));let privateKey,publicKey;
 function config(){
  core.check(enabled,'REAL_ADAPTER_UNAVAILABLE','微信支付未开通或凭证不完整，未执行真实扣款',503);
  core.check(validIdentity&&Buffer.byteLength(env.WECHAT_API_V3_KEY)===32&&/^https:\/\//.test(env.WECHAT_PAY_NOTIFY_URL),'CONFIG','微信商户应用、APIv3密钥或HTTPS回调地址无效',503);
  if(privateKey&&publicKey)return;
  try{
   const merchantKey=crypto.createPrivateKey(fs.readFileSync(env.WECHAT_PRIVATE_KEY_PATH));
   const verificationKey=crypto.createPublicKey(fs.readFileSync(env.WECHAT_PAY_PUBLIC_KEY_PATH));
   core.check(merchantKey.asymmetricKeyType==='rsa'&&verificationKey.asymmetricKeyType==='rsa'&&merchantKey.asymmetricKeyDetails.modulusLength>=2048&&verificationKey.asymmetricKeyDetails.modulusLength>=2048,'CONFIG','支付密钥须RSA2048或更高',503);
   privateKey=merchantKey;
   publicKey=verificationKey;
  }catch{
   core.fail('CONFIG','支付证书/公钥文件不可读取或格式无效',503);
  }
 }
 function sign(text){config();return crypto.sign('RSA-SHA256',Buffer.from(text),privateKey).toString('base64');}
 function verify(headers,body){config();const get=k=>headers.get?headers.get(k):Object.entries(headers).find(([key])=>key.toLowerCase()===k)?.[1],timestamp=get('wechatpay-timestamp'),nonce=get('wechatpay-nonce'),serial=get('wechatpay-serial'),signature=get('wechatpay-signature');core.check(/^\d{10}$/.test(timestamp||'')&&Math.abs(Date.now()/1000-Number(timestamp))<=300&&typeof nonce==='string'&&nonce.length>=1&&nonce.length<=128&&serial===env.WECHAT_PAY_PUBLIC_KEY_ID&&typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature),'PAY_SIGNATURE','支付服务签名校验失败',401);core.check(crypto.verify('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),publicKey,Buffer.from(signature,'base64')),'PAY_SIGNATURE','支付服务签名校验失败',401);}
 async function request(method,route,payload){config();const body=payload?JSON.stringify(payload):'',timeStamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex'),signature=sign(`${method}\n${route}\n${timeStamp}\n${nonce}\n${body}\n`);let response;try{response=await fetcher('https://api.mch.weixin.qq.com'+route,{method,headers:{'Content-Type':'application/json',Accept:'application/json',Authorization:`WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHAT_MCH_ID}",nonce_str="${nonce}",timestamp="${timeStamp}",serial_no="${env.WECHAT_CERT_SERIAL}",signature="${signature}"`},...(body?{body}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});}catch{core.fail('PAY_PROVIDER_UNAVAILABLE','支付服务连接失败，订单结果待查单确认',503);}let count=0,chunks=[];for await(const chunk of response.body||[]){count+=chunk.length;core.check(count<=131072,'PAY_RESPONSE','支付响应过大',502);chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');verify(response.headers,raw);let data;try{data=raw?JSON.parse(raw):{};}catch{core.fail('PAY_RESPONSE','支付响应不是合法JSON',502);}if(!response.ok){const error=Object.assign(new Error('支付服务未接受请求，请查单或联系总部核实'),{code:'PAY_PROVIDER_REJECTED',providerCode:String(data.code||'UNKNOWN').slice(0,100),providerHttpStatus:response.status,status:503});throw error;}return data;}
 function refundResult(data){
  const state={SUCCESS:'success',PROCESSING:'pending',CLOSED:'failed',ABNORMAL:'pending'}[data.status||data.refund_status];
  core.check(state,'PAY_RESPONSE','微信退款状态未知',502);
  return {id:data.out_refund_no,tradeNo:data.out_trade_no,reference:data.refund_id,amount:data.amount?.refund,
   currency:data.amount?.currency,merchantId:data.mchid||env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID,state};
 }
 function clientParams(prepayId){core.check(typeof prepayId==='string'&&prepayId.length>=1&&prepayId.length<=128,'PAY_RESPONSE','预支付标识无效',502);const timeStamp=String(Math.floor(Date.now()/1000)),nonceStr=crypto.randomBytes(16).toString('hex'),pkg='prepay_id='+prepayId;return {timeStamp,nonceStr,package:pkg,signType:'RSA',paySign:sign(`${env.WECHAT_APP_ID}\n${timeStamp}\n${nonceStr}\n${pkg}\n`)};}
 async function query(outTradeNo){
  try{
   const data=await request('GET','/v3/pay/transactions/out-trade-no/'+encodeURIComponent(outTradeNo)+'?mchid='+encodeURIComponent(env.WECHAT_MCH_ID));
   core.check(data?.trade_state!=='NOT_FOUND','PAY_RESPONSE','微信查单状态未知',502);
   return data;
  }
  catch(error){
   if(error.code!=='PAY_PROVIDER_REJECTED'||error.providerCode!=='ORDER_NOT_EXIST'||error.providerHttpStatus!==404)throw error;
   return {out_trade_no:outTradeNo,trade_state:'NOT_FOUND',appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID};
  }
 }
 return {ready:!!(enabled&&validIdentity),gatewayEnvironment:production?'production':'test',config,clientParams,async prepay(p){const response=await request('POST','/v3/pay/transactions/jsapi',{appid:env.WECHAT_APP_ID,mchid:env.WECHAT_MCH_ID,description:p.description,out_trade_no:p.outTradeNo,notify_url:env.WECHAT_PAY_NOTIFY_URL,...(p.expiresAt?{time_expire:p.expiresAt}:{}),amount:{total:p.amount,currency:'CNY'},payer:{openid:p.openid}});return {prepayId:response.prepay_id,requestPayment:clientParams(response.prepay_id)};},query,close(outTradeNo){return request('POST','/v3/pay/transactions/out-trade-no/'+encodeURIComponent(outTradeNo)+'/close',{mchid:env.WECHAT_MCH_ID});},refund(outTradeNo,refundId,amount,total){return request('POST','/v3/refund/domestic/refunds',{out_trade_no:outTradeNo,out_refund_no:refundId,...(env.WECHAT_PAY_REFUND_NOTIFY_URL?{notify_url:env.WECHAT_PAY_REFUND_NOTIFY_URL}:{}),amount:{refund:amount,total,currency:'CNY'}});},async queryRefund(_outTradeNo,refundId){return refundResult(await request('GET','/v3/refund/domestic/refunds/'+encodeURIComponent(refundId)));},billLink(day){return request('GET','/v3/bill/tradebill?bill_date='+encodeURIComponent(day));},refundNotification(headers,raw){const n=decodeNotification(headers,raw);core.check(/^REFUND\.(SUCCESS|ABNORMAL|CLOSED)$/.test(n.eventType)&&n.data.mchid===env.WECHAT_MCH_ID,'PAY_NOTIFICATION','退款通知类型或商户无效');const result=refundResult(n.data);return {id:n.id,refundId:result.id,tradeNo:result.tradeNo,merchantId:result.merchantId,appId:result.appId,result};},notification(headers,raw){const n=decodeNotification(headers,raw);core.check(n.eventType==='TRANSACTION.SUCCESS','PAY_NOTIFICATION','不支持的支付回调类型');return n;}};
 function decodeNotification(headers,raw){verify(headers,raw);let envelope,data;try{envelope=JSON.parse(raw);const r=envelope.resource;core.check(r?.algorithm==='AEAD_AES_256_GCM'&&typeof r.nonce==='string'&&Buffer.byteLength(r.nonce)===12,'PAY_NOTIFICATION','支付回调加密格式无效');const encrypted=Buffer.from(r.ciphertext,'base64');core.check(encrypted.length>16,'PAY_NOTIFICATION','支付回调密文无效');const cipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(env.WECHAT_API_V3_KEY),Buffer.from(r.nonce));cipher.setAAD(Buffer.from(r.associated_data||''));cipher.setAuthTag(encrypted.subarray(-16));data=JSON.parse(Buffer.concat([cipher.update(encrypted.subarray(0,-16)),cipher.final()]).toString('utf8'));}catch{core.fail('PAY_NOTIFICATION','支付回调无法验证解密',400);}core.check(typeof envelope.id==='string'&&envelope.id.length>=1&&envelope.id.length<=128,'PAY_NOTIFICATION','通知编号无效');return {id:envelope.id,eventType:envelope.event_type,data};}
}
module.exports={wechatPay};
