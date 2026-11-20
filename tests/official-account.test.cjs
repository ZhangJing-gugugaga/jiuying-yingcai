'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const env={WECHAT_OFFICIAL_ENABLED:'1',WECHAT_OFFICIAL_TOKEN:'test-only-token',WECHAT_OFFICIAL_APP_ID:'wx-test-official',WECHAT_OFFICIAL_ENCODING_KEY:Buffer.alloc(32,7).toString('base64').slice(0,-1),WECHAT_OFFICIAL_APP_SECRET:'test-only-secret'};
test('official account callback checks signature, AES recipient, XML safety, deduplicates and maps a stable private contact',async()=>{const {officialCrypto,officialAccount,fields}=require('../server/official-account.cjs'),{openStore}=require('../server/storage.cjs'),store=openStore(':memory:'),crypt=officialCrypto(env),svc=officialAccount(store,env);try{const xml='<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[openid-private]]></FromUserName><MsgType><![CDATA[text]]></MsgType><MsgId>12345678</MsgId><Content><![CDATA[人工]]></Content></xml>',encrypted=crypt.encrypt(xml),query={timestamp:String(Math.floor(Date.now()/1000)),nonce:'test-nonce',msg_signature:''};query.msg_signature=crypt.signature(query.timestamp,query.nonce,encrypted);const raw='<xml><Encrypt><![CDATA['+encrypted+']]></Encrypt></xml>';const first=svc.inbound(query,raw,'request1');assert.equal(svc.inbound(query,raw,'request2'),first);const chats=store.load().supportChats;assert.equal(chats.length,1);assert.equal(chats[0].channel,'wechat');assert.equal(chats[0].human,true);assert.ok(!JSON.stringify(chats).includes('openid-private'));assert.throws(()=>svc.inbound({...query,msg_signature:'0'.repeat(40)},raw,'bad'),e=>e.status===401);assert.throws(()=>fields('<!DOCTYPE foo><xml><x>bad</x></xml>'),e=>e.code==='WECHAT_XML');const other=officialCrypto({...env,WECHAT_OFFICIAL_APP_ID:'wx-wrong-app'});assert.throws(()=>other.decrypt(encrypted),e=>e.code==='WECHAT_ENCRYPTION');assert.match(crypt.decrypt(fields(first).Encrypt),/人工客服/);}finally{store.close();}});
test('official outbound queue is idempotent, preserves HQ ownership and reports uncertain transport instead of false delivery',async()=>{const {officialCrypto,officialAccount}=require('../server/official-account.cjs'),{openStore}=require('../server/storage.cjs'),core=require('../shared/core.cjs'),store=openStore(':memory:'),crypt=officialCrypto(env);let fail=false;const svc=officialAccount(store,env,async(url)=>{if(String(url).endsWith('/stable_token'))return new Response('{"access_token":"test-token","expires_in":7200}');if(fail)throw new Error('timeout');return new Response('{"errcode":0}');});try{const encrypted=crypt.encrypt('<xml><ToUserName>gh_test</ToUserName><FromUserName>openid-person</FromUserName><MsgType>text</MsgType><MsgId>456789</MsgId><Content>人工</Content></xml>'),timestamp=String(Math.floor(Date.now()/1000)),nonce='nonce';svc.inbound({timestamp,nonce,msg_signature:crypt.signature(timestamp,nonce,encrypted)},'<xml><Encrypt>'+encrypted+'</Encrypt></xml>','inbound');let state=store.load();const id=state.supportChats[0].id;state=core.execute(state,'support','support.claim',{id},{subject:'support'}).state;let result=core.execute(state,'support','support.reply',{id,text:'总部正在处理'},{subject:'support'});store.transaction(()=>{store.save(result.state);svc.enqueue('support.reply',result.result);svc.enqueue('support.reply',result.result);});assert.equal(dbCount(),1);await svc.flush();assert.equal(svc.status({actor:'support',subject:'support'},id)[0].status,'sent');fail=true;result=core.execute(result.state,'support','support.reply',{id,text:'第二条回复'},{subject:'support'});store.transaction(()=>{store.save(result.state);svc.enqueue('support.reply',result.result);});await svc.flush();assert.equal(svc.status({actor:'support',subject:'support'},id)[0].status,'uncertain');assert.equal(store.load().supportChats[0].assignee,'support');store.db.prepare("UPDATE official_outbox SET status='sending',updated_at=? WHERE status='uncertain'").run(new Date(Date.now()-180000).toISOString());await svc.flush();assert.equal(svc.status({actor:'support',subject:'support'},id).find(x=>x.status==='uncertain').error_code,'PROCESS_INTERRUPTED');assert.throws(()=>svc.status({actor:'partnerA'},id),e=>e.status===403);function dbCount(){return store.db.prepare('SELECT count(*) n FROM official_outbox').get().n;}}finally{store.close();}});

test('official delivery summaries follow the same consultation scope as chat details', () => {
  const {officialAccount} = require('../server/official-account.cjs');
  const {openStore} = require('../server/storage.cjs');
  const store = openStore(':memory:');
  try {
    const state = store.load();
    state.supportChats.push(
      {id: 'official-bot', owner: 'fixture-subject', status: 'bot', channel: 'wechat', human: false, messages: []},
      {id: 'official-human', owner: 'fixture-subject', status: 'active', channel: 'wechat', human: true, assignee: 'support', messages: []},
      {id: 'official-severe', owner: 'fixture-subject', status: 'active', channel: 'wechat', human: true, assignee: 'support', severe: true, messages: []}
    );
    store.transaction(() => store.save(state));
    const service = officialAccount(store, env);
    const manager = {actor: 'manager', subject: 'manager'}, support = {actor: 'support', subject: 'support'};
    assert.throws(() => service.status(support, 'official-bot'), {code: 'FORBIDDEN'});
    assert.throws(() => service.status(manager, 'official-human'), {code: 'FORBIDDEN'});
    assert.throws(() => service.status({...support, subject: 'unassigned-staff'}, 'official-human'), {code: 'FORBIDDEN'});
    assert.deepEqual(service.status(support, 'official-human'), []);
    assert.deepEqual(service.status(manager, 'official-severe'), []);
  } finally {
    store.close();
  }
});

test('unmatched official-account FAQ uses the same public reply saved to consultation history',()=>{
 const {officialCrypto,officialAccount,fields}=require('../server/official-account.cjs');
 const {openStore}=require('../server/storage.cjs');
 const store=openStore(':memory:');
 try{
  const config={...env,NODE_ENV:'production'},crypt=officialCrypto(config),service=officialAccount(store,config);
  const message='<xml><ToUserName>gh_test</ToUserName><FromUserName>openid-fixture</FromUserName><MsgType>text</MsgType><MsgId>839498</MsgId><Content>独立夹具无匹配问题</Content></xml>';
  const encrypted=crypt.encrypt(message),timestamp=String(Math.floor(Date.now()/1000)),nonce='faq-fixture';
  const response=service.inbound({timestamp,nonce,msg_signature:crypt.signature(timestamp,nonce,encrypted)},'<xml><Encrypt>'+encrypted+'</Encrypt></xml>','faq-fixture');
  const content=fields(crypt.decrypt(fields(response).Encrypt)).Content;
  assert.equal(content,'暂未找到相关答复，您可以选择转人工客服。具体费用和办理时限以已确认的协议、账单和规定为准。');
  assert.equal(store.load().supportChats[0].messages.at(-1).text,content);
 }finally{store.close();}
});
