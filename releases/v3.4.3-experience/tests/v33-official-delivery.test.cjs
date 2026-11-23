'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createServer}=require('../server/index.cjs');
const {officialCrypto}=require('../server/official-account.cjs');

const officialEnv={
 NODE_ENV:'test',ADAPTER_MODE:'mock',WECHAT_OFFICIAL_ENABLED:'1',WECHAT_OFFICIAL_TOKEN:'fixture-token',
 WECHAT_OFFICIAL_APP_ID:'wx-fixture-official',WECHAT_OFFICIAL_ENCODING_KEY:Buffer.alloc(32,6).toString('base64').slice(0,-1)
};

async function fixture(integrationFetch,verify,{mock=false}={}){
 const env={...officialEnv,...(mock?{}:{WECHAT_OFFICIAL_APP_SECRET:'fixture-secret'})};
 const app=createServer({dbPath:':memory:',env,integrationFetch});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,{actor,body,key}={}){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(actor?{Authorization:'Bearer '+actor}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
  const json=await response.json();
  return {status:response.status,...json};
 }
 try{
  const crypt=officialCrypto(env),timestamp=String(Math.floor(Date.now()/1000)),nonce='fixture';
  const message=crypt.encrypt('<xml><ToUserName>gh_fixture</ToUserName><FromUserName>openid-fixture-only</FromUserName><MsgType>text</MsgType><MsgId>47123</MsgId><Content>人工</Content></xml>');
  const callback=await fetch(base+'/api/wechat/official/callback?'+new URLSearchParams({timestamp,nonce,msg_signature:crypt.signature(timestamp,nonce,message)}),{method:'POST',headers:{'Content-Type':'text/xml'},body:'<xml><Encrypt>'+message+'</Encrypt></xml>'});
  assert.equal(callback.status,200);
  const id=app.store.load().supportChats[0].id;
  const [support,manager,partner]=await Promise.all(['support','manager','partnerA'].map(async actor=>(await request('/api/auth/dev',{body:{actor}})).data.token));
  let n=0;
  const command=async(actor,command,payload,key='official-case-'+(++n))=>request('/api/commands',{actor,body:{command,payload:{id,...payload}},key});
  const delivery=actor=>request('/api/wechat/official/delivery?chatId='+id,{actor});
  const dispatch=()=>request('/api/wechat/official/dispatch',{actor:manager,body:{}});
  assert.equal((await command(support,'support.claim',{})).status,200);
  assert.equal((await command(support,'support.escalate',{reason:'升级处理测试'})).status,200);
  await verify({app,id,support,manager,partner,command,delivery,dispatch});
 }finally{
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
}

test('V3.3 only explicit management replies leave via WeChat, with idempotency and bounded confirmed-rejection retry',async()=>{
 const outgoing=[];
 const transport=async(url,opts)=>{
  if(url.endsWith('/stable_token'))return Response.json({access_token:'fixture-token',expires_in:7200});
  outgoing.push(JSON.parse(opts.body));
  return Response.json(outgoing.length===1?{errcode:-1,errmsg:'system busy'}:{errcode:0,errmsg:'ok'});
 };
 await fixture(transport,async({app,id,support,manager,partner,command,delivery,dispatch})=>{
  assert.equal((await command(support,'support.collaborate',{department:'总部',note:'内部协作细节'})).status,200);
  const internal=await command(manager,'support.management',{note:'内部管理处理结论'});
  assert.equal(internal.status,200);
  assert.equal(internal.data.result.managementHandled,true);
  assert.doesNotMatch(JSON.stringify(internal.data.result.messages),/内部管理处理结论|内部协作细节/);
  assert.deepEqual((await delivery(manager)).data,[]);
  assert.equal((await command(support,'support.management',{note:'越权',customerReply:'越权回复'})).status,403);
  const input={note:'不同的内部协作处理',customerReply:'已为您核实，稍后联系我们可继续处理。'};
  const first=await command(manager,'support.management',input,'management-reply-key');
  assert.equal(first.status,200);
  assert.equal(first.data.result.messages.at(-1).text,input.customerReply);
  assert.equal((await command(manager,'support.management',input,'management-reply-key')).data.replayed,true);
  assert.equal(app.store.db.prepare("SELECT count(*) n FROM official_outbox WHERE chat_id=?").get(id).n,1);
  assert.equal((await delivery(partner)).status,403);
  await dispatch();
  const [retry]= (await delivery(support)).data;
  assert.equal(retry.status,'pending');
  assert.equal(retry.attempts,1);
  assert.equal(retry.provider_code,-1);
  assert.ok(Date.parse(retry.next_attempt_at)>Date.now());
  assert.equal((await dispatch()).data.processed,0);
  app.store.db.prepare("UPDATE official_outbox SET next_attempt_at=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),retry.id);
  assert.equal((await dispatch()).data.processed,1);
  const [sent]=(await delivery(manager)).data;
  assert.equal(sent.status,'sent');
  assert.equal(sent.attempts,2);
  assert.equal(sent.provider_mode,'wechat');
  assert.equal(sent.provider_code,0);
  assert.ok(Date.parse(sent.provider_accepted_at)>0);
  assert.equal(sent.next_attempt_at,null);
  assert.deepEqual(outgoing.map(x=>x.text.content),[input.customerReply,input.customerReply]);
  assert.doesNotMatch(JSON.stringify(sent),/openid-fixture|内部/);
 });
});

test('V3.3 unavailable real credentials use development simulation with distinct delivery state',async()=>{
 await fixture(async()=>assert.fail('模拟公众号不得请求真实服务'),async({manager,command,delivery,dispatch})=>{
  assert.equal((await command(manager,'support.management',{note:'仅岗位审计',customerReply:'模拟客服回复'})).status,200);
  assert.equal((await dispatch()).data.processed,1);
  const [row]=(await delivery(manager)).data;
  assert.equal(row.status,'simulated');
  assert.equal(row.provider_mode,'mock');
  assert.equal(row.provider_code,null);
 },{mock:true});
});

test('V3.3 transient rejections stop after three attempts and permanent rejections fail immediately',async()=>{
 let rejection=-1,sends=0;
 const transport=async url=>{
  if(url.endsWith('/stable_token'))return Response.json({access_token:'fixture-token',expires_in:7200});
  sends++;
  return Response.json({errcode:rejection});
 };
 await fixture(transport,async({app,manager,command,delivery,dispatch})=>{
  await command(manager,'support.management',{note:'暂时错误测试',customerReply:'测试可恢复回复'});
  for(let i=0;i<3;i++){
   assert.equal((await dispatch()).data.processed,1);
   app.store.db.prepare("UPDATE official_outbox SET next_attempt_at=? WHERE status='pending'").run(new Date(Date.now()-1000).toISOString());
  }
  let [failed]=(await delivery(manager)).data;
  assert.deepEqual([failed.status,failed.attempts,failed.provider_code,failed.next_attempt_at],['failed',3,-1,null]);
  assert.equal((await dispatch()).data.processed,0);
  rejection=45015;
  await command(manager,'support.management',{note:'终止错误测试',customerReply:'测试终止回复'});
  assert.equal((await dispatch()).data.processed,1);
  [failed]=(await delivery(manager)).data;
  assert.deepEqual([failed.status,failed.attempts,failed.provider_code,failed.next_attempt_at],['failed',1,45015,null]);
  app.store.db.prepare('UPDATE official_contacts SET last_inbound_at=?').run(new Date(Date.now()-49*3600000).toISOString());
  await command(manager,'support.management',{note:'回复窗口测试',customerReply:'超窗测试回复'});
  assert.equal((await dispatch()).data.processed,1);
  [failed]=(await delivery(manager)).data;
  assert.deepEqual([failed.status,failed.error_code,failed.provider_code,failed.next_attempt_at],['failed','WECHAT_WINDOW',null,null]);
  assert.equal(sends,4);
 });
});

test('V3.3 delivery metadata migration preserves legacy outbox history across restart',()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{DatabaseSync}=require('node:sqlite');
 const {openStore}=require('../server/storage.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jiuying-official-upgrade-')),file=path.join(dir,'legacy.db');
 const migrationDir=path.resolve(__dirname,'../database'),at='2026-11-17T08:00:00.000Z';
 let legacy,store;
 try{
  legacy=new DatabaseSync(file);
  legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const name of fs.readdirSync(migrationDir).filter(x=>/^\d{3}_[a-z0-9_]+\.sql$/.test(x)&&Number(x.slice(0,3))<19).sort()){
   legacy.exec(fs.readFileSync(path.join(migrationDir,name),'utf8'));
   legacy.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(name.slice(0,3)),name.slice(0,-4),at);
  }
  const chat={id:'legacy-chat',owner:'legacy-contact',status:'active',human:true,assignee:'support',channel:'wechat',messages:[]};
  legacy.prepare('INSERT INTO supportChats(id,owner,status,data,created_at) VALUES(?,?,?,?,?)').run(chat.id,chat.owner,chat.status,JSON.stringify(chat),at);
  legacy.prepare('INSERT INTO official_contacts VALUES(?,?,?,?)').run(chat.owner,'fixture-encrypted',chat.id,at);
  legacy.prepare('INSERT INTO official_outbox VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-outbox',chat.id,chat.owner,'原回复','sent',1,null,at,at);
  legacy.close();legacy=null;
  for(let i=0;i<2;i++){
   store=openStore(file,{seed:false});
   const row=store.db.prepare('SELECT * FROM official_outbox WHERE id=?').get('legacy-outbox');
   assert.deepEqual([row.chat_id,row.subject,row.content,row.status,row.attempts,row.created_at], [chat.id,chat.owner,'原回复','sent',1,at]);
   assert.deepEqual([row.provider_mode,row.provider_code,row.provider_accepted_at,row.next_attempt_at],['wechat',null,null,null]);
   assert.equal(store.db.prepare('SELECT count(*) n FROM schema_migrations WHERE version=19').get().n,1);
   assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
   store.close();store=null;
  }
 }finally{
  legacy?.close();store?.close();
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('jiuying-official-upgrade-'));
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
