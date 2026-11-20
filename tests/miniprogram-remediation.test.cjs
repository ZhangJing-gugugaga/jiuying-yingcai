const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),native=path.join(root,'miniprogram');
function page(name,q={}){let definition;global.Page=d=>definition=d;const file=path.join(native,'pages',name,'index.js');delete require.cache[require.resolve(file)];require(file);const p={...definition,data:structuredClone(definition.data),setData(values){for(const [key,value]of Object.entries(values)){let o=this.data;const parts=key.split('.');for(const k of parts.slice(0,-1))o=o[k]||(o[k]={});o[parts.at(-1)]=value;}}};p.onLoad?.(q);return p;}
async function harness(fn,options={}){const {createServer}=require('../server/index.cjs');const app=createServer({dbPath:':memory:',...options,env:{NODE_ENV:'test',ADAPTER_MODE:'mock',...options.env}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const config=require('../miniprogram/config'),prior=config.apiBase;config.apiBase='http://127.0.0.1:'+app.server.address().port;const storage=new Map(),calls=[];global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast(){},reLaunch(o){calls.push({reLaunch:o.url});},navigateTo(o){calls.push({navigate:o.url});},switchTab(o){calls.push({tab:o.url});},request:async o=>{calls.push({url:o.url,method:o.method,data:o.data});try{const r=await fetch(o.url,{method:o.method,headers:o.header,...(o.method==='GET'?{}:{body:JSON.stringify(o.data)})});o.success({statusCode:r.status,data:await r.json()});}catch(e){o.fail(e);}}};const api=require('../miniprogram/utils/api');try{await api.login('partnerA');await fn({app,api,calls,storage});}finally{config.apiBase=prior;await new Promise(r=>app.server.close(r));app.store.close();}}

test('non-development login strips the role picker and mock SMS details',()=>{
  const {stripDevelopment}=require('../scripts/wechat-build.cjs');
  const files=['index.js','index.wxml'].map(file=>stripDevelopment(fs.readFileSync(path.join(native,'pages','login',file),'utf8'))).join('\n');
  assert.doesNotMatch(files,/customActor|devCode|smsMode|测试验证码|本地开发账号|开发Mock/);
});

test('login shows the approved guidance when a WeChat identity is unbound',()=>harness(async({storage})=>{
  global.wx.login=o=>o.success({code:'unbound-test-identity'});
  storage.delete('jyyc.session');
  const login=page('login');
  await login.onShow();
  assert.equal(login.data.wechatEnabled,true);
  await login.wechatLogin();
  assert.equal(login.data.error,'该微信账号尚未绑定负责人身份，请使用已登记的账号登录后联系总部办理绑定。');
},{env:{WECHAT_AUTH_MODE:'real',WECHAT_APP_ID:'wx-contract-only',WECHAT_APP_SECRET:'contract-only-secret'},integrationFetch:async()=>new Response(JSON.stringify({openid:'unbound-test-openid'}),{status:200})}));

test('profile uses scoped organization and outlet counts and leaves the visitor view public',()=>harness(async({api,calls})=>{
  const profile=page('profile');
  const [account,organization,outlets]=await Promise.all([
    api.collection('accounts'),api.collection('organizations'),api.collection('outlets',{limit:1})
  ]);
  await profile.onShow();
  assert.equal(profile.data.managerName,account.items[0].managerName);
  assert.equal(profile.data.organizationName,organization.items[0].name);
  assert.equal(profile.data.outletCount,outlets.total);

  await api.visitor();
  const marker=calls.length;
  const visitor=page('profile');
  await visitor.onShow();
  assert.equal(visitor.data.isPublic,true);
  assert.equal(visitor.data.outletCount,null);
  assert.ok(calls.slice(marker).every(call=>!call.url?.includes('/api/collections/')));
}));

test('support replaces unset service hours and presents customer-facing ticket status',()=>harness(async({api,storage})=>{
  const support=page('support');
  await support.onShow();
  assert.equal(support.data.serviceHours,'客服服务时间请以总部通知为准。');
  const original=api.session();
  await api.login('manager');
  try {
    await api.command('support.settings',{hours:'周一至周五 9:00–18:00',sla:{complaint:null,aftersale:null,exception:null}});
  } finally {
    storage.set('jyyc.session',original);
  }
  await support.refresh();
  assert.equal(support.data.serviceHours,'客服服务时间：周一至周五 9:00–18:00');
  await support.prepareTicket();
  await support.outlet({detail:{value:String(support.data.outlets.findIndex(row=>row.id==='cs'))}});
  support.setData({'form.title':'需要总部处理','form.description':'请核对服务信息',categoryIndex:2});
  await support.create();
  const row=support.data.tickets[0];
  assert.equal(row.statusText,'等待客服接单');
  await support.open({currentTarget:{dataset:{id:row.id}}});
  assert.equal(support.data.ticket.id,row.id);
  assert.equal(support.data.ticket.canRate,false);
}));

test('P0-01 build validates real-device configuration and removes dev identities physically',t=>{const filename=path.join(root,'scripts/wechat-build.cjs');assert.ok(fs.existsSync(filename),'reproducible native environment build exists');const {validateConfig,build}=require(filename);assert.throws(()=>validateConfig({environment:'production',target:'device',apiBase:'http://127.0.0.1:8787',appId:'touristappid'}));assert.throws(()=>validateConfig({environment:'test',target:'device',apiBase:'https://localhost:8787',appId:'wx1234567890abcdef'}));const out=path.join(root,'execution','wechat-test-build-'+Date.now());t.after(()=>{const resolved=path.resolve(out);assert.ok(resolved.startsWith(path.join(root,'execution')+path.sep));fs.rmSync(resolved,{recursive:true,force:true});});const manifest=build({environment:'production',target:'device',apiBase:'https://api.example.test',appId:'wx1234567890abcdef',out});assert.equal(manifest.environment,'production');const config=JSON.parse(fs.readFileSync(path.join(out,'project.config.json')));assert.equal(config.setting.urlCheck,true);assert.equal(config.compileType,'miniprogram');assert.equal(config.miniprogramRoot,'./');for(const f of fs.readdirSync(path.join(out,'pages','login')))assert.doesNotMatch(fs.readFileSync(path.join(out,'pages','login',f),'utf8'),/partnerA|partnerB|customActor|data-field="actor"/);assert.ok(!fs.existsSync(path.join(out,'development')));const built=require(path.join(out,'config.js'));assert.equal(built.development,false);assert.equal(built.apiBase,'https://api.example.test');});

test('P0-01 tab navigation uses switchTab and carries deep-link query to native tab page',async()=>{const storage=new Map(),calls=[];global.wx={setStorageSync:(k,v)=>storage.set(k,v),getStorageSync:k=>storage.get(k),removeStorageSync:k=>storage.delete(k),switchTab:o=>calls.push({type:'tab',url:o.url}),navigateTo:o=>calls.push({type:'normal',url:o.url})};require('../miniprogram/utils/page').go('reports','outlet=zz&month=2026-10');assert.deepEqual(calls,[{type:'tab',url:'/pages/reports/index'}]);assert.deepEqual(storage.get('jyyc.route.reports'),{outlet:'zz',month:'2026-10'});});

test('P0-04 partial report drafts preserve null and recover through real HTTP storage',()=>harness(async({api})=>{const p=page('report',{outlet:'cs',month:'2026-10'});await p.onShow();p.input({currentTarget:{dataset:{field:'revenue'}},detail:{value:'123.45'}});await p.draft();assert.equal(p.data.error,'');const draft=(await api.collection('drafts',{outlet:'cs',month:'2026-10'})).items[0];assert.equal(draft.revenue,123.45);assert.equal(draft.orders,null);const restored=page('report',{outlet:'cs',month:'2026-10'});await restored.onShow();assert.equal(restored.data.form.revenue,123.45);assert.equal(restored.data.form.orders,'');await restored.submit({detail:{value:restored.data.form}});assert.match(restored.data.error,/整数|必填/);}));

test('P0-05 native report distinguishes current approved and latest submitted versions',()=>harness(async({api,storage})=>{async function staff(actor,c,p){const old=api.session();await api.login(actor);try{return await api.command(c,p);}finally{storage.set('jyyc.session',old);}}const first=await api.command('report.submit',{outlet:'cs',month:'2026-10',revenue:100,orders:1,traffic:2,enroll:0,note:'原版'});await staff('ops','review.report',{id:first.result.id,decision:'approve'});await api.command('report.correct',{id:first.result.id,reason:'核实订单',correctionType:'field',fields:['orders']});await api.command('report.submit',{outlet:'cs',month:'2026-10',revenue:100,orders:2,traffic:2,enroll:0,note:'原版'});const p=page('report',{outlet:'cs',month:'2026-10'});await p.onShow();assert.equal(p.data.error,'');assert.equal(p.data.currentApprovedVersion.version,1);assert.equal(p.data.latestSubmittedVersion.version,2);assert.equal(p.data.currentApprovedVersion.current,true);assert.notEqual(p.data.latestSubmittedVersion.status,'approved');}));

test('P1-06 location capture preserves zero accuracy and records source/time',async()=>{global.wx={getLocation:o=>o.success({latitude:28.2,longitude:113.1,accuracy:0}),chooseLocation:o=>o.success({latitude:28.1,longitude:113,address:'手选地址'})};const api=require('../miniprogram/utils/api');const gps=await api.locate(false),manual=await api.locate(true);assert.equal(gps.coords.accuracy,0);assert.equal(gps.coords.source,'gps');assert.ok(Number.isFinite(Date.parse(gps.coords.capturedAt)));assert.equal(manual.coords.source,'manual');assert.equal(manual.coords.accuracy,null);});

test('P0-02 WeChat and SMS platform bridge sends identity proofs and never a selected role',async()=>{const calls=[],storage=new Map();global.wx={login:o=>o.success({code:'wx-platform-code'}),getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),reLaunch(){},request:o=>{calls.push(o);const data=o.url.endsWith('/sms/send')?{challengeId:'challenge-1',expiresIn:300,resendAfter:60,mode:'mock',devCode:'123456'}:{token:'verified-session',actor:'partner:p1',subject:'person-1'};o.success({statusCode:200,data:{data}});}};const api=require('../miniprogram/utils/api');assert.equal(typeof api.wechatLogin,'function');await api.wechatLogin();assert.deepEqual(calls.at(-1).data,{code:'wx-platform-code'});const p=page('login');p.setData({mobile:'13800000001'});assert.equal(typeof p.sendSms,'function');await p.sendSms();assert.equal(p.data.challengeId,'challenge-1');p.setData({smsCode:'123456'});await p.smsLogin();assert.ok(calls.some(x=>x.url.endsWith('/sms/verify')&&x.data.challengeId==='challenge-1'&&x.data.mobile==='13800000001'));assert.ok(calls.every(x=>!Object.hasOwn(x.data||{},'actor')));p.onUnload?.();});


test('P0-03 real payment SDK success only queries provider state; cancel does not confirm or fail funds',async()=>{const api=require('../miniprogram/utils/api'),original={prepay:api.prepay,query:api.queryPayment};const calls=[];let cancel=false;global.wx={requestPayment:o=>{calls.push('sdk');if(cancel)o.fail({errMsg:'requestPayment:fail cancel'});else o.success({});},getStorageSync(){},setStorageSync(){},showToast(){}};api.prepay=async()=>{calls.push('prepay');return {paymentId:'pay-1',requestPayment:{timeStamp:'1',nonceStr:'n',package:'prepay_id=x',signType:'RSA',paySign:'signature'}};};api.queryPayment=async()=>{calls.push('query');return {payment:{id:'pay-1',status:'pending'},bill:{id:'bill-1',status:'unpaid'}};};try{const p=page('fees');p.setData({state:{adapterMode:'real'},paymentEnabled:true});p.refresh=async()=>{};p.mutate=async()=>{throw Error('real payment must not invoke command mock confirmation');};await p.pay({currentTarget:{dataset:{id:'bill-1'}}});assert.deepEqual(calls,['prepay','sdk','query']);assert.match(p.data.paymentNotice,/确认|查询/);calls.length=0;cancel=true;await p.pay({currentTarget:{dataset:{id:'bill-1'}}});assert.deepEqual(calls,['prepay','sdk','query']);assert.equal(p.data.payment.status,'pending');assert.match(p.data.paymentNotice,/取消/);}finally{api.prepay=original.prepay;api.queryPayment=original.query;}});

test('P0-06 pending enrollment never becomes applicable by boolean fallback',async()=>{const api=require('../miniprogram/utils/api'),original=api.request;api.request=async()=>({draft:{revenue:1},currentApprovedVersion:null,latestSubmittedVersion:null,historyVersions:[],enrollmentStatus:'pending'});try{const p=page('report',{outlet:'cs',month:'2026-10'});p.setData({outletId:'cs'});await p.loadMonth();assert.equal(p.data.applicable,false);assert.equal(p.data.enrollmentStatus,'pending');await p.submit({detail:{value:{revenue:1,orders:1,traffic:1,enroll:1}}});assert.match(p.data.error,/待总部确认/);}finally{api.request=original;}});

test('P1-09 dashboard exposes exact server coverage counts and never treats missing as zero',()=>harness(async()=>{const p=page('dashboard',{period:'2026-10'});await p.onShow();assert.equal(p.data.error,'');assert.equal(typeof p.data.coverage.expected,'number');assert.equal(typeof p.data.coverage.pendingReview,'number');assert.equal(typeof p.data.coverage.overdue,'number');}));


test('P0-02 native SMS and wx.login bridge use real HTTP identity storage and authenticated binding',()=>harness(async({api,storage,calls})=>{global.wx.login=o=>o.success({code:'contract-only-wx-code'});const login=page('login');await login.onShow();login.setData({mobile:'13800000001'});await login.sendSms();login.onUnload();assert.equal(login.data.error,'');assert.equal(login.data.smsMode,'mock');assert.match(login.data.devCode,/^\d{6}$/);login.setData({smsCode:login.data.devCode});await login.smsLogin();assert.equal(api.session().actor,'partnerA');assert.equal(login.data.smsCode,'');const security=page('security');await security.onShow();assert.equal(security.data.bindings.wechatBound,false);await security.bindWechat();assert.equal(security.data.error,'');assert.equal(security.data.bindings.wechatBound,true);storage.delete('jyyc.session');await login.wechatLogin();assert.equal(api.session().actor,'partnerA');assert.ok(calls.some(c=>c.url?.includes('/api/auth/wechat')));login.onUnload();},{env:{WECHAT_AUTH_MODE:'real',WECHAT_APP_ID:'wx-contract-only',WECHAT_APP_SECRET:'contract-only-secret'},integrationFetch:async()=>new Response(JSON.stringify({openid:'contract-only-openid',session_key:'not-for-client'}),{status:200})}));

test('P0-01 static validation rejects HTML entities inside native WXML expressions',()=>{const {validate}=require('../scripts/wechat-validate.cjs');const dir=path.join(root,'execution','wechat-static-fixture-'+Date.now());assert.ok(dir.startsWith(path.join(root,'execution')+path.sep));try{fs.cpSync(native,dir,{recursive:true});const file=path.join(dir,'pages/report/index.wxml');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('{{loading}}','{{loading &amp;&amp; busy}}'));const result=validate(dir);assert.equal(result.valid,false);assert.ok(result.errors.some(x=>/HTML实体/.test(x)));}finally{fs.rmSync(dir,{recursive:true,force:true});}});


test('native support active filter follows rendered control and displays translated detail messages',()=>harness(async({api,storage})=>{async function staff(command,payload){const previous=api.session();await api.login('support');try{return await api.command(command,payload);}finally{storage.set('jyyc.session',previous);}}const p=page('support');await p.onShow();await p.prepareTicket();await p.outlet({detail:{value:String(p.data.outlets.findIndex(row=>row.id==='cs'))}});p.setData({'form.title':'接单筛选回归','form.description':'请核对账单',categoryIndex:2});await p.create();assert.equal(p.data.error,'');const ticket=p.data.tickets[0];await staff('support.claim',{id:ticket.id});await staff('support.reply',{id:ticket.id,text:'正在核对，请稍候'});const wxml=fs.readFileSync(path.join(native,'pages/support/index.wxml'),'utf8'),filter=wxml.match(/data-status="([^"]+)" bindtap="filterStatus">处理中/)[1];await p.filterStatus({currentTarget:{dataset:{status:filter}}});assert.equal(p.data.error,'');assert.equal(p.data.tickets.length,1);assert.equal(p.data.tickets[0].status,'active');await p.open({currentTarget:{dataset:{id:ticket.id}}});assert.equal(p.data.ticket.statusText,'处理中');assert.equal(p.data.ticket.messages.at(-1).actorText,'总部客服');}));

test('native support sending or requesting human from closed chat creates and selects a new conversation',()=>harness(async({api,storage})=>{async function staff(command,payload){const previous=api.session();await api.login('support');try{return await api.command(command,payload);}finally{storage.set('jyyc.session',previous);}}const p=page('support');await p.onShow();p.setData({text:'首次咨询'});await p.send();const original=p.data.chat.id;await p.human();await staff('support.claim',{id:original});await staff('support.close',{id:original,note:'本次咨询结束'});await p.loadChat({currentTarget:{dataset:{id:original}}});const closed=await api.detail('supportChats',original),originalMessages=closed.messages.length;p.setData({text:'有新的咨询事项'});await p.send();assert.equal(p.data.error,'');assert.notEqual(p.data.chat.id,original);const newChat=p.data.chat.id;assert.equal(p.data.chat.messages[0].text,'有新的咨询事项');assert.equal((await api.detail('supportChats',original)).messages.length,originalMessages);assert.equal((await api.detail('supportChats',original)).status,'closed');await p.loadChat({currentTarget:{dataset:{id:original}}});await p.human();assert.equal(p.data.error,'');assert.notEqual(p.data.chat.id,original);assert.notEqual(p.data.chat.id,newChat);assert.equal(p.data.chat.status,'queued');assert.equal(p.data.chat.human,true);assert.equal((await api.detail('supportChats',original)).status,'closed');assert.equal((await api.collection('supportChats')).total,3);}));

test('opening a ticket updated by headquarters refreshes stale list badges and filters',()=>harness(async({api,storage})=>{
 const owner=api.session();
 const ticket=(await api.command('support.ticket',{outlet:'cs',category:'complaint',title:'列表状态验证',description:'核对总部更新后的工单列表',channel:'miniprogram'})).result;
 await api.login('support');await api.command('support.claim',{id:ticket.id});storage.set('jyyc.session',owner);
 const support=page('support');await support.onShow();
 assert.equal(support.data.tickets.find(row=>row.id===ticket.id).status,'active');
 await api.login('support');await api.command('support.reply',{id:ticket.id,text:'请提供补充说明',requestSupplement:true});storage.set('jyyc.session',owner);
 await support.open({currentTarget:{dataset:{id:ticket.id}}});
 assert.equal(support.data.ticket.status,'waiting');
 assert.equal(support.data.tickets.find(row=>row.id===ticket.id).status,'waiting');
 await support.filterStatus({currentTarget:{dataset:{status:'waiting'}}});
 await api.login('support');await api.command('support.close',{id:ticket.id,note:'已核对资料，无需再次提交'});storage.set('jyyc.session',owner);
 await support.open({currentTarget:{dataset:{id:ticket.id}}});
 assert.equal(support.data.ticket.status,'closed');
 assert.equal(support.data.tickets.some(row=>row.id===ticket.id),false);
}));

test('native support keeps a linked new ticket at the original outlet and displays both records',()=>harness(async({api,storage,app})=>{
 const owner=api.session();
 async function asSupport(command,payload){
  await api.login('support');
  try{return (await api.command(command,payload)).result;}
  finally{storage.set('jyyc.session',owner);}
 }
 const state=app.store.load();
 const finances={bills:state.bills,receipts:state.receipts,requests:state.requests};
 const support=page('support');
 await support.onShow();
 support.setData({text:'有一个经营问题'});
 await support.send();
 const chatId=support.data.chat.id;
 assert.equal((await api.collection('supportTickets')).total,0);
 await support.human();
 assert.equal((await api.detail('supportChats',chatId)).status,'queued');
 assert.equal((await api.collection('supportTickets')).total,0);
 await support.prepareTicket();
 await support.outlet({detail:{value:String(support.data.outlets.findIndex(outlet=>outlet.id==='zz'))}});
 support.setData({categoryIndex:1,
  'form.title':'株洲业务待核实','form.description':'同一工单追溯样例'});
 await support.create();
 assert.equal(support.data.error,'');
 const original=(await api.collection('supportTickets')).items[0];
 assert.equal(original.outlet,'zz');
 assert.equal(original.status,'queued');
 await asSupport('support.claim',{id:original.id});
 await asSupport('support.collaborate',{id:original.id,department:'运营',note:'仅客服可见的核实记录'});
 await asSupport('support.reply',{id:original.id,text:'请补充处理情况',requestSupplement:true});
 const ticketButton={currentTarget:{dataset:{id:original.id}}};
 await support.open(ticketButton);
 assert.equal(support.data.ticket.status,'waiting');
 assert.deepEqual(support.data.ticket.messages.map(message=>message.text),['请补充处理情况']);
 support.setData({'form.supplement':'已补充处理情况'});
 await support.supplement();
 assert.equal(support.data.ticket.status,'active');
 await asSupport('support.close',{id:original.id,note:'确认完成'});
 await support.open(ticketButton);
 await support.rate();
 assert.equal(support.data.ticket.rating.score,5);

 // A previous filter can show only a different outlet when reopening the original.
 await support.outletSearch({detail:{value:'长沙'}});
 assert.equal(support.data.outlets.some(outlet=>outlet.id==='zz'),false);
 support.link();
 support.setData({'form.description':'原事项仍需确认'});
 await support.create();
 assert.equal(support.data.error,'');
 const followUp=support.data.ticket;
 assert.ok(followUp);
 assert.equal(followUp.outlet,'zz');
 assert.equal(followUp.linkedTicketId,original.id);
 assert.equal(followUp.category,'aftersale');
 assert.equal(followUp.status,'queued');
 assert.equal((await api.detail('supportTickets',original.id)).status,'closed');
 assert.equal((await api.detail('supportTickets',followUp.id)).linkedTicketId,original.id);
 support.tab({currentTarget:{dataset:{tab:'ticket'}}});
 assert.equal(support.data.ticket,null);
 assert.equal(support.data.linkedTicket,null);
 const finalState=app.store.load();
 for(const [collection,previous] of Object.entries(finances))assert.deepEqual(finalState[collection],previous,collection);
}));
