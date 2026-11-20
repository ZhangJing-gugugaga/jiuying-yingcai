'use strict';
const crypto=require('node:crypto'),core=require('../shared/core.cjs'),{fetchJson}=require('./auth-providers.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const iso=()=>new Date().toISOString();
const maxAttempts=3,replyWindowMs=48*3600000;
const expiredTokenCodes=new Set([40001,40014,42001]);
function fields(xml){core.check(typeof xml==='string'&&xml.length<=65536&&!/<!DOCTYPE|<!ENTITY/i.test(xml)&&/^\s*<xml>[\s\S]*<\/xml>\s*$/.test(xml),'WECHAT_XML','消息XML格式无效');const result={};const body=xml.trim().slice(5,-6);let rest=body;const re=/<([A-Za-z][A-Za-z0-9]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<>]*))<\/\1>/g;for(const m of body.matchAll(re)){core.check(!(m[1] in result),'WECHAT_XML','消息字段重复');result[m[1]]=m[2]??m[3].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');rest=rest.replace(m[0],'');}core.check(!rest.trim(),'WECHAT_XML','不支持的XML结构');return result;}
function officialCrypto(env){const token=env.WECHAT_OFFICIAL_TOKEN,appid=env.WECHAT_OFFICIAL_APP_ID,key=Buffer.from((env.WECHAT_OFFICIAL_ENCODING_KEY||'')+'=','base64');const ready=env.WECHAT_OFFICIAL_ENABLED==='1'&&!!token&&!!appid&&key.length===32;function config(){core.check(ready,'REAL_ADAPTER_UNAVAILABLE','公众号消息接入尚未配置',503);}function signature(timestamp,nonce,encrypted){config();return crypto.createHash('sha1').update([token,String(timestamp),nonce,...(encrypted?[encrypted]:[])].sort().join('')).digest('hex');}function verify(query,encrypted){config();core.check(/^\d{10}$/.test(query.timestamp||'')&&Math.abs(Date.now()/1000-Number(query.timestamp))<=300&&typeof query.nonce==='string'&&query.nonce.length<=128,'WECHAT_SIGNATURE','公众号请求已过期或格式无效',401);const supplied=encrypted?query.msg_signature:query.signature,expected=signature(query.timestamp,query.nonce,encrypted);core.check(/^[a-f0-9]{40}$/.test(supplied||'')&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)),'WECHAT_SIGNATURE','公众号消息签名校验失败',401);}function decrypt(encrypted){config();try{const decipher=crypto.createDecipheriv('aes-256-cbc',key,key.subarray(0,16));decipher.setAutoPadding(false);const decoded=Buffer.concat([decipher.update(Buffer.from(encrypted,'base64')),decipher.final()]),pad=decoded.at(-1);core.check(pad>=1&&pad<=32&&decoded.subarray(-pad).every(x=>x===pad),'WECHAT_ENCRYPTION','填充错误');const bytes=decoded.subarray(0,-pad),length=bytes.readUInt32BE(16);core.check(length<=65536&&bytes.length>=20+length&&bytes.subarray(20+length).toString()===appid,'WECHAT_ENCRYPTION','消息接收方不匹配');return bytes.subarray(20,20+length).toString('utf8');}catch{core.fail('WECHAT_ENCRYPTION','公众号消息无法安全解密',400);}}function encrypt(xml){config();const content=Buffer.from(xml),length=Buffer.alloc(4);length.writeUInt32BE(content.length);const data=Buffer.concat([crypto.randomBytes(16),length,content,Buffer.from(appid)]),pad=32-data.length%32,cipher=crypto.createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);return Buffer.concat([cipher.update(Buffer.concat([data,Buffer.alloc(pad,pad)])),cipher.final()]).toString('base64');}function envelope(xml){const encrypted=encrypt(xml),timestamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(12).toString('hex');return `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt><MsgSignature><![CDATA[${signature(timestamp,nonce,encrypted)}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;}return {ready,config,signature,verify,decrypt,encrypt,envelope};}
function officialAccount(store,env,fetcher=fetch){const db=store.db,crypt=officialCrypto(env);let accessToken=null,tokenUntil=0,flushing=false;
 const mode=crypt.ready&&env.WECHAT_OFFICIAL_APP_SECRET?'wechat':crypt.ready&&env.NODE_ENV!=='production'&&(env.ADAPTER_MODE||'mock')==='mock'?'mock':null;
 const subject=openid=>'official-'+sha(env.WECHAT_OFFICIAL_APP_ID+':'+openid),safe=x=>String(x).replaceAll(']]>',']]]]><![CDATA[>');
 function handshake(query){crypt.verify(query);core.check(typeof query.echostr==='string'&&query.echostr.length<=1024,'INPUT','公众号校验回显无效');return query.echostr;}
 function inbound(query,raw,requestId){
  crypt.config();const outer=fields(raw);core.check(outer.Encrypt,'WECHAT_ENCRYPTION','公众号只接受安全模式加密推送',400);crypt.verify(query,outer.Encrypt);
  const decoded=crypt.decrypt(outer.Encrypt),p=fields(decoded);
  core.check(typeof p.FromUserName==='string'&&p.FromUserName.length>=6&&p.FromUserName.length<=128&&typeof p.ToUserName==='string','WECHAT_MESSAGE','公众号身份字段无效');
  if(p.MsgType!=='text')return 'success';
  core.check(/^\d{1,32}$/.test(p.MsgId||'')&&p.Content?.trim()&&p.Content.length<=2000,'WECHAT_MESSAGE','公众号文本消息无效');
  return store.transaction(()=>{
   const old=db.prepare('SELECT * FROM official_inbound WHERE message_id=?').get(p.MsgId),digest=sha(decoded);
   core.check(!old||old.body_digest===digest,'WECHAT_REPLAY','相同消息编号内容不同',409);if(old)return old.response_xml;
   const who=subject(p.FromUserName),existing=db.prepare('SELECT * FROM official_contacts WHERE subject=?').get(who),at=new Date().toISOString();
   const chatId=existing?.chat_id||'';
   const selection={
    supportChats:{where:'id=?',params:[chatId]},faqEntries:{where:"status='published'"},
    businessTasks:{where:"json_extract(data,'$.recordId')=? AND status IN ('open','in_progress')",params:[chatId]}
   },before=store.load(selection);
   db.prepare('INSERT INTO official_contacts VALUES(?,?,NULL,?) ON CONFLICT(subject) DO UPDATE SET last_inbound_at=excluded.last_inbound_at').run(who,crypt.encrypt(p.FromUserName),at);
   const oldChat=before.supportChats.find(x=>x.id===existing?.chat_id),id=oldChat?.status==='closed'?null:existing?.chat_id;
   const session={actor:'public',subject:who},ctx={...session,requestId,now:at};
   const chat=core.execute(before,'public','support.chat',{...(id?{id}:{}),text:p.Content,channel:'wechat'},ctx);
   const payload={id:chat.result.id},handoff=['人工','转人工','人工客服'].includes(p.Content.trim())&&!chat.result.human;
   const changed=handoff?core.execute(chat.state,'public','support.human',payload,ctx):chat;
   store.save(changed.state,{before});
   if(handoff)require('./approval-history.cjs').record(store,{before:chat.state,after:changed.state,result:changed.result,command:'support.human',payload,session,requestId,at,source:'wechat-official'});
   db.prepare('UPDATE official_contacts SET chat_id=? WHERE subject=?').run(changed.result.id,who);
   const reply=changed.result.human?'已交由总部人工客服处理。投诉、售后或业务异常可在小程序提交正式工单。':changed.result.messages.at(-1)?.text||'请在小程序查看服务资料。';
   const response=crypt.envelope(`<xml><ToUserName><![CDATA[${safe(p.FromUserName)}]]></ToUserName><FromUserName><![CDATA[${safe(p.ToUserName)}]]></FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${safe(reply)}]]></Content></xml>`);
   db.prepare('INSERT INTO official_inbound VALUES(?,?,?,?)').run(p.MsgId,digest,response,at);return response;
  });
 }
 function enqueue(command,result,payload={}){
  if(result.channel!=='wechat'||command!=='support.reply'&&(command!=='support.management'||!payload.customerReply?.trim()))return;
  const contact=db.prepare('SELECT subject FROM official_contacts WHERE chat_id=? AND subject=?').get(result.id,result.owner);
  if(!contact)return;
  const message=result.messages.at(-1);
  if(!message||!['support','manager'].includes(message.actor))return;
  const id='outbox-'+sha(JSON.stringify([result.id,result.messages.length,message.at,message.text])),at=iso();
  db.prepare("INSERT OR IGNORE INTO official_outbox(id,chat_id,subject,content,status,created_at,updated_at,provider_mode) VALUES(?,?,?,?,'pending',?,?,?)")
   .run(id,result.id,contact.subject,message.text,at,at,mode||'wechat');
 }
 async function token(){core.check(env.WECHAT_OFFICIAL_APP_SECRET,'REAL_ADAPTER_UNAVAILABLE','公众号主动回复凭证尚未配置',503);if(accessToken&&tokenUntil>Date.now())return accessToken;const response=await fetchJson(fetcher,'https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credential',appid:env.WECHAT_OFFICIAL_APP_ID,secret:env.WECHAT_OFFICIAL_APP_SECRET,force_refresh:false})});core.check(typeof response.access_token==='string'&&Number.isFinite(response.expires_in),'WECHAT_TOKEN','公众号访问凭证申请失败',503);accessToken=response.access_token;tokenUntil=Date.now()+Math.max(0,Math.min(7000,response.expires_in-120))*1000;return accessToken;}
 function setDelivery(row,status,errorCode=null,providerCode=null,nextAttempt=null,acceptedAt=null){
  db.prepare(`UPDATE official_outbox SET status=?,error_code=?,provider_code=?,next_attempt_at=?,provider_accepted_at=?,updated_at=?
   WHERE id=? AND status='sending' AND attempts=?`)
   .run(status,errorCode,providerCode,nextAttempt,acceptedAt,iso(),row.id,row.attempts+1);
 }
 function retry(row,errorCode,providerCode=null){
  const next=Date.now()+60000*2**row.attempts;
  if(row.attempts+1<maxAttempts&&next<Date.parse(row.last_inbound_at)+replyWindowMs){
   setDelivery(row,'pending',errorCode,providerCode,new Date(next).toISOString());
  }else setDelivery(row,'failed',errorCode,providerCode);
 }
 async function deliver(row){
  if(!(Date.now()<Date.parse(row.last_inbound_at)+replyWindowMs))return setDelivery(row,'failed','WECHAT_WINDOW');
  if(mode==='mock')return setDelivery(row,'simulated');
  let sendStarted=false;
  try{
   const access=await token(),recipient=crypt.decrypt(row.encrypted_id);
   sendStarted=true;
   const response=await fetchJson(fetcher,'https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token='+encodeURIComponent(access),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({touser:recipient,msgtype:'text',text:{content:row.content}})});
   core.check(Number.isSafeInteger(response?.errcode),'PROVIDER_RESPONSE','公众号发送响应缺少状态码',502);
   const code=response.errcode;
   if(code===0)return setDelivery(row,'sent',null,code,null,iso());
   if(expiredTokenCodes.has(code))accessToken=null;
   if(code===-1||expiredTokenCodes.has(code))return retry(row,'WECHAT_SEND_REJECTED',code);
   setDelivery(row,'failed','WECHAT_SEND_REJECTED',code);
  }catch(error){
   const code=error.code||'INTERNAL';
   if(['PROVIDER_UNAVAILABLE','PROVIDER_RESPONSE'].includes(code)){
    if(sendStarted)setDelivery(row,'uncertain',code);
    else retry(row,code);
   }else setDelivery(row,'failed',code);
  }
 }
 async function flush(limit=10){
  core.check(mode,'REAL_ADAPTER_UNAVAILABLE','公众号主动回复适配器尚未配置',503);
  core.check(Number.isInteger(limit)&&limit>0&&limit<=20,'INPUT','消息批次为1—20');
  if(flushing)return {processed:0};
  flushing=true;
  let processed=0;
  try{
   const at=iso();
   db.prepare("UPDATE official_outbox SET status='uncertain',error_code='PROCESS_INTERRUPTED',next_attempt_at=NULL,updated_at=? WHERE provider_mode=? AND status='sending' AND updated_at<?")
    .run(at,mode,new Date(Date.now()-120000).toISOString());
   const rows=db.prepare(`SELECT o.*,c.encrypted_id,c.last_inbound_at FROM official_outbox o JOIN official_contacts c ON c.subject=o.subject
    WHERE o.provider_mode=? AND o.status='pending' AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=?) ORDER BY o.created_at,o.id LIMIT ?`).all(mode,at,limit);
   for(const row of rows){
    const claimed=db.prepare("UPDATE official_outbox SET status='sending',attempts=attempts+1,next_attempt_at=NULL,updated_at=? WHERE id=? AND status='pending' AND attempts=?")
     .run(iso(),row.id,row.attempts);
    if(!claimed.changes)continue;
    await deliver(row);
    processed++;
   }
   return {processed};
  }finally{flushing=false;}
 }
 function status(who,id){
  core.check(['manager','support'].includes(who.actor),'FORBIDDEN','无公众号处理权限',403);
  core.check(typeof id==='string'&&id.length>0&&id.length<=128,'INPUT','公众号会话编号无效');
  const chatRow=db.prepare('SELECT data FROM supportChats WHERE id=?').get(id),chat=chatRow&&JSON.parse(chatRow.data);
  core.check(chat?.channel==='wechat'&&core.supportRecordVisible(chat,who.actor,who,false),'FORBIDDEN','无该会话处理权限',403);
  return db.prepare(`SELECT id,status,attempts,error_code,provider_mode,provider_code,provider_accepted_at,next_attempt_at,created_at,updated_at
   FROM official_outbox WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50`).all(id);
 }
 return {ready:!!mode,handshake,inbound,enqueue,flush,status};
}
module.exports={officialCrypto,officialAccount,fields};
