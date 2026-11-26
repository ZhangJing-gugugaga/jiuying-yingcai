'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {mkdtempSync,readFileSync,readdirSync,rmSync,rmdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('../server/index.cjs');
const core=require('../shared/core.cjs');

const env={NODE_ENV:'test',ADAPTER_MODE:'mock'};
const report={outlet:'cs',month:'2026-10',revenue:123.45,orders:9,traffic:25,enroll:4};

async function setup(t,restart=false){
 const dir=restart?mkdtempSync(join(tmpdir(),'jiuying-v32-audit-')):null;
 const dbPath=dir?join(dir,'test.db'):':memory:';
 let app=createServer({dbPath,env}),base;
 async function start(){await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;}
 async function close(){await new Promise(resolve=>app.server.close(resolve));app.store.close();}
 await start();
 t.after(async()=>{await close();if(dir){for(const file of [dbPath,dbPath+'-wal',dbPath+'-shm'])rmSync(file,{force:true});rmdirSync(dir);}});
 const req=async(path,token,body,key)=>{const headers={...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})};const res=await fetch(base+path,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return {status:res.status,...await res.json()};};
 const login=async actor=>{const response=await req('/api/auth/dev',null,{actor});assert.equal(response.status,200,JSON.stringify(response));return response.data.token;};
 const command=(token,command,payload,key=randomUUID())=>req('/api/commands',token,{command,payload},key);
 const act=async(...args)=>{const response=await command(...args);assert.equal(response.status,200,JSON.stringify(response));return response;};
 const history=(token,collection,id,query='')=>req('/api/approval-history/'+collection+'/'+id+query,token);
 const events=async(...args)=>{const response=await history(...args);assert.equal(response.status,200,JSON.stringify(response));return response.data.items;};
 return {get app(){return app;},req,login,command,act,history,events,async restart(){await close();app=createServer({dbPath,env});await start();}};
}

test('approval history persists true report events, keeps raw aligned and leaves status-only seeds empty',async t=>{
 const f=await setup(t,true),partner=await f.login('partnerA'),ops=await f.login('ops'),finance=await f.login('finance'),manager=await f.login('manager');
 const old=f.app.store.load().reports.find(r=>r.outlet==='cs'&&r.month==='2026-09');
 assert.deepEqual(await f.events(manager,'reports',old.id),[]);
 const key=randomUUID(),submitted=await f.act(partner,'report.submit',report,key),id=submitted.data.result.id;
 const failed=await f.command(finance,'review.report',{id,decision:'approve'});
 assert.equal(failed.status,403);
 assert.equal((await f.act(partner,'report.submit',report,key)).data.replayed,true);
 const returned=await f.act(ops,'review.report',{id,decision:'return',note:'补充经营说明 13812345678'});
 await f.restart();
 const items=await f.events(manager,'reports',id);
 assert.deepEqual(items.map(x=>x.action),['review.report','report.submit']);
 assert.deepEqual(items.map(x=>x.requestId),[returned.requestId,submitted.requestId]);
 assert.equal(items[0].before.status,'pending');
 assert.equal(items[0].after.status,'returned');
 assert.equal(items[0].after.revenue,report.revenue);
 assert.equal(items[0].version,1);
 assert.equal(items[0].role,'ops');
 assert.equal(items[0].next,'加盟商负责人');
 assert.match(items[0].note,/138\*\*\*\*5678/);
 assert.equal(items[0].source,'command-api');
 for(const item of items){
  for(const key of ['at','actor','role','action','objectType','objectId','version','note','before','after','requestId','source'])assert.deepEqual(item[key],item.raw[key],key);
 }
 assert.deepEqual((await f.events(manager,'reports',id,'?limit=1&offset=1')).map(x=>x.id),[items[1].id]);
 assert.equal((await f.history(manager,'reports',id,'?limit=201')).status,400);
 assert.throws(()=>f.app.store.db.exec("UPDATE approval_events SET data='{}'"),/immutable/);
 assert.throws(()=>f.app.store.db.exec('DELETE FROM approval_events'),/immutable/);
 assert.throws(()=>f.app.store.db.exec('INSERT OR REPLACE INTO approval_events SELECT * FROM approval_events LIMIT 1'),/immutable/);
 assert.equal((await f.req('/api/approval-history/reports/'+id,manager,{})).status,404);
 const revised=await f.act(partner,'report.submit',{...report,note:'已按退回意见补充'});
 const lineage=await f.events(manager,'reports',revised.data.result.id,'?lineage=1');
 assert.deepEqual(lineage.map(x=>[x.action,x.version]),[['report.submit',2],['review.report',1],['report.submit',1]]);
});

test('V3.3 specialist review notes follow the same role visibility in request lists, details and history',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),other=await f.login('partnerB'),manager=await f.login('manager'),ops=await f.login('ops'),location=await f.login('location');
 const photo=(await f.req('/api/files',partner,{name:'evidence.png',type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII='})).data;
 const data={name:'证据完整新店',province:'湖南',city:'长沙',district:'雨花',address:'原核验地址',phone:'15700000000',opening:'2026-12-01',coords:{lat:28.3,lng:113.2,source:'manual',coordinateSystem:'GCJ-02'},photo};
 const {id}=(await f.act(partner,'request.submit',{type:'newOutlet',data})).data.result;
 await f.act(location,'location.review',{id,decision:'approve',note:'专员内部依据-仅专员及管理层',publicNote:'位置资料已核验'});
 for(const token of [ops,partner]){
  assert.doesNotMatch(JSON.stringify((await f.req('/api/collections/requests/'+id,token)).data),/专员内部依据/);
  assert.doesNotMatch(JSON.stringify((await f.req('/api/collections/requests',token)).data.items.find(row=>row.id===id)),/专员内部依据/);
  assert.doesNotMatch(JSON.stringify(await f.events(token,'requests',id)),/专员内部依据/);
 }
 assert.equal((await f.req('/api/collections/requests/'+id,other)).status,404);
 for(const token of [manager,location])assert.match(JSON.stringify((await f.req('/api/collections/requests/'+id,token)).data),/专员内部依据/);
 await f.act(ops,'review.request',{id,decision:'supplement',note:'运营内部意见-仅运营及管理层',publicNote:'请补充联系电话'});
 const own=(await f.req('/api/collections/requests/'+id,ops)).data;
 assert.equal(own.internalReviewNote,'运营内部意见-仅运营及管理层');
 assert.equal(own.publicNote,'请补充联系电话');
 assert.doesNotMatch(JSON.stringify((await f.req('/api/collections/requests/'+id,location)).data),/运营内部意见/);
});

test('V3.3 regional history filters both correction field names and values using active grants',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),manager=await f.login('manager'),ops=await f.login('ops'),region=await f.login('regional');
 const original=(await f.act(partner,'report.submit',report)).data.result;
 await f.act(ops,'review.report',{id:original.id,decision:'approve'});
 await f.act(partner,'report.correct',{id:original.id,correctionType:'full',fields:['revenue','orders'],reason:'核对全部经营数据'});
 const revised=(await f.act(partner,'report.submit',{...report,revenue:234.56,orders:12})).data.result;
 await f.act(manager,'grant.set',{outlets:['cs'],metrics:['orders'],reviewOutlets:['cs']});
 const event=(await f.events(region,'reports',revised.id))[0];
 assert.deepEqual(event.after.correctionFields,['orders']);
 assert.deepEqual(event.raw.after,event.after);
 assert.deepEqual(Object.keys(event.raw.after.correctionDiff),['orders']);
 assert.doesNotMatch(JSON.stringify(event),/revenue|234\.56/);
 assert.ok((await f.events(manager,'reports',revised.id))[0].after.correctionFields.includes('revenue'));
});

test('V3.3 repeat support handoff keeps one genuine event across pagination and restart',async t=>{
 const f=await setup(t,true),partner=await f.login('partnerA'),support=await f.login('support');
 const chat=(await f.act(partner,'support.chat',{text:'请转人工咨询'})).data.result;
 const first=await f.act(partner,'support.human',{id:chat.id});
 await f.act(partner,'support.human',{id:chat.id});
 await f.act(support,'support.claim',{id:chat.id});
 await f.act(partner,'support.human',{id:chat.id});
 await f.restart();
 const events=await f.events(support,'supportChats',chat.id);
 assert.deepEqual(events.map(row=>[row.action,row.before.status,row.after.status]),[['support.claim','queued','active'],['support.human','bot','queued']]);
 assert.equal(events[1].raw.requestId,first.requestId);
 assert.deepEqual(await f.events(support,'supportChats',chat.id,'?limit=1&offset=2'),[]);
 assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM audit WHERE json_extract(data,'$.command')='support.human'").get().n,3);
 assert.equal(f.app.store.db.prepare("SELECT count(*) n FROM approval_events WHERE action='support.human'").get().n,1);
});

test('V3.3 supplements preserve approved location for unchanged evidence and reopen changed evidence',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),ops=await f.login('ops'),location=await f.login('location');
 const photo=(await f.req('/api/files',partner,{name:'evidence.png',type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII='})).data;
 const data={name:'补件新店',province:'湖南',city:'长沙',district:'雨花',address:'原核验地址',phone:'15700000000',opening:'2026-12-01',coords:{lat:28.3,lng:113.2,source:'manual',coordinateSystem:'GCJ-02'},photo};
 const {id}=(await f.act(partner,'request.submit',{type:'newOutlet',data})).data.result;
 const reviewed=(await f.act(location,'location.review',{id,decision:'approve'})).data.result;
 await f.act(ops,'review.request',{id,decision:'supplement',note:'补联系电话'});
 const resubmitted=await f.act(partner,'request.supplement',{id,note:'已补联系电话',data:{phone:'15700000001',address:'  原核验地址  ',coords:data.coords,photo}});
 assert.equal(resubmitted.data.result.data.locationStatus,'approved');
 const unchanged=(await f.req('/api/collections/requests/'+id,location)).data;
 assert.equal(unchanged.data.locationReviewedBy,reviewed.data.locationReviewedBy);
 assert.equal(unchanged.data.locationReviewedAt,reviewed.data.locationReviewedAt);
 assert.equal((await f.events(location,'requests',id))[0].next,'总部运营');
 await f.act(ops,'review.request',{id,decision:'supplement',note:'重新核实地址'});
 const changed=await f.act(partner,'request.supplement',{id,note:'地址已变化',data:{address:'另一地址'}});
 assert.equal(changed.data.result.data.locationStatus,'pending');
 assert.equal((await f.req('/api/collections/requests/'+id,location)).data.data.locationReviewedBy,undefined);
 assert.equal((await f.events(location,'requests',id))[0].next,'位置核验专员');
 assert.equal((await f.command(ops,'review.request',{id,decision:'approve'})).status,409);
 await f.act(location,'location.review',{id,decision:'approve'});
 await f.act(ops,'review.request',{id,decision:'approve'});
});

test('approval history enforces current role, outlet, metric and record permission',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),other=await f.login('partnerB'),manager=await f.login('manager'),ops=await f.login('ops'),finance=await f.login('finance'),regional=await f.login('regional'),support=await f.login('support');
 const id=(await f.act(partner,'report.submit',report)).data.result.id;
 await f.act(ops,'review.report',{id,decision:'approve',note:'总部内部意见 secure-only'});
 for(const token of [other,finance,regional,support])assert.ok([403,404].includes((await f.history(token,'reports',id)).status));
 assert.equal((await f.history(null,'reports',id)).status,401);
 const ownerHistory=await f.events(partner,'reports',id);
 assert.ok(!JSON.stringify(ownerHistory).includes('secure-only'));
 assert.equal(ownerHistory[0].raw.actorId,null);
 await f.act(manager,'grant.set',{outlets:['cs'],metrics:['orders'],reviewOutlets:['cs']});
 const regionHistory=await f.events(regional,'reports',id);
 assert.equal(regionHistory[0].after.orders,report.orders);
 assert.equal(Object.hasOwn(regionHistory[0].after,'revenue'),false);
 assert.equal(regionHistory[0].raw.requestId,null);
 assert.ok(!JSON.stringify(regionHistory).includes('secure-only'));
 await f.act(manager,'grant.set',{outlets:['cs'],metrics:['orders'],reviewOutlets:[]});
 assert.ok([403,404].includes((await f.history(regional,'reports',id)).status));
});

test('linked correction, revocation and fee decisions retain real snapshots on each affected object',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),manager=await f.login('manager'),ops=await f.login('ops'),finance=await f.login('finance');
 const source=f.app.store.load().reports.find(r=>r.outlet==='cs'&&r.month==='2026-09');
 await f.act(partner,'report.correct',{id:source.id,reason:'核对收入'});
 const corrected=(await f.act(partner,'report.submit',{...report,month:source.month,note:'营业说明 API key: hidden-test-key'})).data.result;
 await f.act(ops,'review.report',{id:corrected.id,decision:'approve'});
 const approved=await f.act(finance,'review.report',{id:corrected.id,decision:'approve'});
 const lineage=await f.events(manager,'reports',corrected.id,'?lineage=1');
 assert.deepEqual(new Set(lineage.map(x=>x.version)),new Set([1,2]));
 assert.ok(lineage.some(x=>x.action==='report.superseded'&&x.version===1));
 assert.deepEqual(lineage.find(x=>x.action==='report.submit').raw.after.correctionDiff.note,{before:source.note,after:'营业说明 API key: [已脱敏]'});
 const recent=await f.events(finance,'reports',corrected.id);
 assert.equal(recent[0].before.status,'finance');
 assert.equal(recent[0].after.status,'approved');
 assert.equal(recent[1].next,'总部财务');
 assert.equal((await f.events(manager,'reports',source.id))[0].requestId,approved.requestId);
 const revocation=await f.act(manager,'report.revoke.request',{id:corrected.id,reason:'审批错误'});
 await f.act(finance,'review.revoke',{id:revocation.data.result.id,decision:'approve',note:'独立复核完成'});
 const revoked=(await f.events(manager,'reports',corrected.id))[0];
 assert.equal(revoked.action,'report.revoked');
 assert.equal(revoked.note,'独立复核完成');
 assert.equal(revoked.before.revenue,report.revenue);
 assert.equal(revoked.after.revenue,report.revenue);
 assert.equal(revoked.after.revoked,true);
 const opsRevoked=(await f.events(ops,'reports',corrected.id))[0];
 assert.equal(opsRevoked.after.revoked,true);
 assert.equal(opsRevoked.raw.note,'');
 assert.equal(opsRevoked.raw.requestId,null);
 assert.equal(opsRevoked.raw.related.id,undefined);
 assert.equal(opsRevoked.raw.after.revocationRequestId,undefined);
 assert.deepEqual((await f.events(finance,'requests',revocation.data.result.id)).map(x=>x.action),['review.revoke','report.revoke.request']);
 const pause=(await f.act(partner,'request.submit',{type:'pauseFee',outlet:'hy',data:{from:'2026-10-01',to:'2026-10-31',reason:'暂停核算申请'}})).data.result;
 const adjustment=(await f.act(finance,'review.request',{id:pause.id,decision:'approve'})).data.state.adjustments.find(r=>r.requestId===pause.id);
 const proposal=(await f.act(ops,'fee.adjust.propose',{adjustmentId:adjustment.id,amount:66.50,offsetMonth:'2026-12',serviceUntil:null,reason:'财务依据'})).data.result;
 await f.act(finance,'fee.adjust.review',{id:proposal.id,decision:'approve',note:'核对通过'});
 const adjustmentHistory=await f.events(finance,'adjustments',adjustment.id);
 assert.deepEqual(adjustmentHistory.map(x=>x.action),['fee.adjust.review','fee.adjust.propose','review.request']);
 assert.equal(adjustmentHistory[0].before.amount,null);
 assert.equal(adjustmentHistory[0].after.amount,66.50);
 assert.equal(adjustmentHistory[1].next,'总部财务');
 assert.equal(adjustmentHistory[2].next,'总部运营');
});

test('verified official-account handoff records its real source and survives inbound replay',()=>{
 const {officialCrypto,officialAccount}=require('../server/official-account.cjs');
 const {openStore}=require('../server/storage.cjs');
 const store=openStore(':memory:');
 const config={WECHAT_OFFICIAL_ENABLED:'1',WECHAT_OFFICIAL_TOKEN:'test-approval-token',WECHAT_OFFICIAL_APP_ID:'wx-test-approval',WECHAT_OFFICIAL_ENCODING_KEY:Buffer.alloc(32,3).toString('base64').slice(0,-1),WECHAT_OFFICIAL_APP_SECRET:'test-approval-secret'};
 try{
  const crypt=officialCrypto(config),service=officialAccount(store,config);
  const xml='<xml><ToUserName>gh_audit</ToUserName><FromUserName>private-openid</FromUserName><MsgType>text</MsgType><MsgId>23456789</MsgId><Content>人工</Content></xml>';
  const ciphertext=crypt.encrypt(xml),timestamp=String(Math.floor(Date.now()/1000)),nonce='approval-test';
  const query={timestamp,nonce,msg_signature:crypt.signature(timestamp,nonce,ciphertext)},body='<xml><Encrypt>'+ciphertext+'</Encrypt></xml>';
  assert.equal(service.inbound(query,body,'signed-original'),service.inbound(query,body,'signed-retry'));
  const rows=store.db.prepare('SELECT data FROM approval_events').all().map(row=>JSON.parse(row.data));
  assert.equal(rows.length,1);
  assert.equal(rows[0].requestId,'signed-original');
  assert.equal(rows[0].source,'wechat-official');
  assert.equal(rows[0].before.status,'bot');
  assert.equal(rows[0].after.status,'queued');
  assert.doesNotMatch(JSON.stringify(rows),/private-openid/);
  const nextCipher=crypt.encrypt(xml.replace('23456789','23456790').replace('<Content>人工</Content>','<Content>继续咨询</Content>'));
  service.inbound({...query,msg_signature:crypt.signature(timestamp,nonce,nextCipher)},'<xml><Encrypt>'+nextCipher+'</Encrypt></xml>','signed-followup');
  const state=store.load(),chat=state.supportChats[0];
  assert.equal(chat.messages.at(-1).text,'继续咨询');
  assert.equal(state.supportChats.length,1);
  assert.equal(state.businessTasks.filter(task=>task.recordId===chat.id&&task.status==='open').length,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM approval_events').get().n,1);
 }finally{store.close();}
});

test('scheduled billing records the actual approved service credit it applies',async()=>{
 const {openStore}=require('../server/storage.cjs');
 const {runScheduledBatch}=require('../server/scheduler.cjs');
 const store=openStore(':memory:');
 try{
  let state=store.load();
  const act=(actor,command,payload)=>{const x=core.execute(state,actor,command,payload,{now:'2026-11-18T06:00:00Z',subject:actor,requestId:randomUUID()});state=x.state;return x.result;};
  const plan=act('manager','plan.publish',{name:'调度价格',amount:100,serviceEntity:'服务公司',collectionEntity:'收款公司',invoiceEntity:'开票公司',terms:'整月服务',reason:'规则依据'});
  act('manager','agreement.create',{outlet:'cs',planId:plan.id,startMonth:'2026-12',endMonth:'2027-12',billDay:1,dueDay:5,reference:'AUDIT-AGR',reason:'已确认'});
  const request=act('partnerA','request.submit',{outlet:'cs',type:'pauseFee',data:{from:'2026-11-01',to:'2026-11-15',reason:'服务暂停'}});
  act('finance','review.request',{id:request.id,decision:'approve'});
  const adjustment=state.adjustments.find(x=>x.requestId===request.id);
  const proposal=act('ops','fee.adjust.propose',{adjustmentId:adjustment.id,amount:25,offsetMonth:'2026-12',serviceUntil:null,reason:'已核实'});
  act('finance','fee.adjust.review',{id:proposal.id,decision:'approve',note:'已确认'});
  store.transaction(()=>store.save(state));
  const run=await runScheduledBatch(store,{now:'2026-12-02T02:00:00Z'});
  assert.equal(run.billed,1);
  const row=store.db.prepare('SELECT data FROM approval_events WHERE object_id=?').get(adjustment.id);
  assert.ok(row,'the scheduler writes its immutable credit audit in the billing transaction');
  const event=JSON.parse(row.data);
  assert.equal(event.source,'scheduler');
  assert.equal(event.action,'billing.generate');
  assert.equal(event.requestId,run.billingOutcomes[0].requestId);
  assert.equal(event.before.status,'approved');
  assert.equal(event.after.status,'applied');
  assert.equal(event.after.amount,25);
  assert.equal(event.after.appliedBillId,run.billingOutcomes[0].billId);
 }finally{store.close();}
});

test('location and support approvals preserve genuine steps without copying sensitive evidence',async t=>{
 const f=await setup(t),partner=await f.login('partnerA'),manager=await f.login('manager'),ops=await f.login('ops'),location=await f.login('location'),support=await f.login('support'),visitor=await f.login('public'),otherVisitor=await f.login('public');
 const file=await f.req('/api/files',partner,{name:'evidence.png',type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII='});
 assert.equal(file.status,201);
 const verification=(await f.act(partner,'location.submit',{outlet:'cs',month:'2026-11',coords:{lat:28.318001,lng:113.226701,source:'gps'},address:'PRIVATE EXACT ADDRESS',photo:file.data})).data.result;
 await f.act(location,'location.review',{id:verification.id,decision:'exception',note:'请重拍照片'});
 const locationHistory=await f.events(location,'verifications',verification.id);
 assert.deepEqual(locationHistory.map(x=>x.action),['location.review','location.submit']);
 assert.equal(locationHistory[0].next,'位置核验专员');
 assert.equal(locationHistory[1].raw.after.photoId,file.data.id);
 assert.doesNotMatch(JSON.stringify(locationHistory),/28\.318001|PRIVATE EXACT ADDRESS|base64/);
 assert.ok([403,404].includes((await f.history(ops,'verifications',verification.id)).status));
 const ticket=(await f.act(visitor,'support.ticket',{outlet:'cs',category:'complaint',title:'投诉',description:'PRIVATE COMPLAINT',contact:'13912345678'})).data.result;
 await f.act(support,'support.claim',{id:ticket.id});
 await f.act(support,'support.collaborate',{id:ticket.id,department:'运营',note:'内部协作细节'});
 const supportHistory=await f.events(support,'supportTickets',ticket.id);
 assert.deepEqual(supportHistory.map(x=>x.action),['support.collaborate','support.claim','support.ticket']);
 assert.equal(supportHistory[0].after.department,'运营');
 assert.doesNotMatch(JSON.stringify(supportHistory),/PRIVATE COMPLAINT|13912345678/);
 assert.doesNotMatch(JSON.stringify(await f.events(visitor,'supportTickets',ticket.id)),/内部协作细节|support\.collaborate/);
 for(const token of [partner,ops,manager,otherVisitor])assert.ok([403,404].includes((await f.history(token,'supportTickets',ticket.id)).status));
});

test('actual pre-upgrade command and trail remain visible once without invented state',async t=>{
 const f=await setup(t),manager=await f.login('manager');
 const before=f.app.store.load(),at='2026-11-18T06:05:02.000Z',context={today:'2026-11-18',now:at,subject:'partnerA',requestId:'historical-request'};
 const old=core.execute(before,'partnerA','report.submit',report,context);
 f.app.store.transaction(()=>f.app.store.save(old.state,{before}));
 const items=await f.events(manager,'reports',old.result.id);
 assert.equal(items.length,1);
 assert.equal(items[0].requestId,'historical-request');
 assert.equal(items[0].at,at);
 assert.equal(items[0].before,null);
 assert.equal(items[0].after.status,'pending');
 assert.equal(items[0].raw.actorId,'partnerA');
 const ticket=core.execute(old.state,'public','support.ticket',{outlet:'cs',category:'complaint',title:'历史记录',description:'旧记录内容'},{...context,subject:'visitor-historical',requestId:'historical-ticket'});
 f.app.store.transaction(()=>f.app.store.save(ticket.state,{before:old.state}));
 const support=await f.login('support');
 const legacyTicket=(await f.events(support,'supportTickets',ticket.result.id))[0];
 assert.equal(legacyTicket.action,'support.ticket');
 assert.equal(legacyTicket.requestId,'historical-ticket');
 assert.equal(legacyTicket.after,null);
 const claim=core.execute(ticket.state,'support','support.claim',{id:ticket.result.id},{...context,subject:'support',requestId:'historical-claim'});
 const first=core.execute(claim.state,'support','support.collaborate',{id:ticket.result.id,department:'运营',note:'首次协作'},{...context,subject:'support',requestId:'historical-collaboration-1'});
 const second=core.execute(first.state,'support','support.collaborate',{id:ticket.result.id,department:'位置',note:'第二次协作'},{...context,subject:'support',requestId:'historical-collaboration-2'});
 f.app.store.transaction(()=>f.app.store.save(second.state,{before:ticket.state}));
 const collaborations=(await f.events(support,'supportTickets',ticket.result.id)).filter(x=>x.action==='support.collaborate');
 assert.deepEqual(collaborations.map(x=>[x.requestId,x.note,x.after.department]),[
  ['historical-collaboration-2','第二次协作','位置'],['historical-collaboration-1','首次协作','运营']
 ]);
});

test('approval migration upgrades pre-V3.2 data without updating the original report or audit',()=>{
 const {DatabaseSync}=require('node:sqlite');
 const {openStore}=require('../server/storage.cjs');
 const dir=mkdtempSync(join(tmpdir(),'jiuying-v32-upgrade-')),dbPath=join(dir,'legacy.db');
 const migrationDir=join(__dirname,'../database');
 const legacy=new DatabaseSync(dbPath);
 try{
  legacy.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const file of readdirSync(migrationDir).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&Number(name.slice(0,3))<15).sort()){
   legacy.exec(readFileSync(join(migrationDir,file),'utf8'));
   legacy.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(Number(file.slice(0,3)),file.slice(0,-4),'2026-11-18T04:00:00.000Z');
  }
  const past='2026-11-18T05:04:03.000Z',context={today:'2026-11-18',now:past,subject:'partnerA',requestId:'legacy-linked-id'};
  const saved=core.execute(core.createState(),'partnerA','report.submit',report,context),source=saved.result,original=saved.state.audit.at(-1);
  const originals=[['reports',source],['audit',original]];
  for(const [table,item] of originals)legacy.prepare(`INSERT INTO ${table}(id,owner,outlet,status,month,data,created_at) VALUES(?,?,?,?,?,?,?)`).run(item.id,item.owner,item.outlet,item.status,item.month||null,JSON.stringify(item),item.createdAt);
  legacy.close();
  for(let index=0;index<2;index++){
   const store=openStore(dbPath,{seed:false});
   try{
    assert.equal(store.db.prepare('SELECT name FROM schema_migrations WHERE version=15').get().name,'015_approval_events');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM approval_events').get().n,0);
    for(const [table,item] of originals)assert.equal(store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(item.id).data,JSON.stringify(item));
    const plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM audit WHERE json_extract(data,'$.recordId')=?").all(source.id);
    assert.ok(plan.some(row=>row.detail.includes('approval_legacy_audit_object')));
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
   }finally{store.close();}
  }
 }finally{
  if(legacy.isOpen)legacy.close();
  for(const file of [dbPath,dbPath+'-wal',dbPath+'-shm'])rmSync(file,{force:true});
  rmdirSync(dir);
 }
});
