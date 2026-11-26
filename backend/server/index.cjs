'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const {randomBytes,randomUUID,createHash}=require('node:crypto');
const core=require('../shared/core.cjs');const {openStore}=require('./storage.cjs');const {adapters}=require('./adapters.cjs');
const {aggregateSQL}=require('./analytics.cjs');const {authentication}=require('./auth.cjs');const {repository}=require('./repository.cjs');
const approvalHistory=require('./approval-history.cjs');
const {scopedGrants}=require('../shared/operations.cjs');
const hash=x=>createHash('sha256').update(x).digest('hex');const ROOT=path.resolve(__dirname,'..');
function createServer({dbPath=process.env.DB_PATH||path.join(ROOT,'var/local.db'),env=process.env,seed=true,integrationFetch,roleTrial,roleTrialControls}={}){
 const adapter=adapters(env);const development=env.NODE_ENV!=='production';const rate=new Map();
 const trialProfiles=env.NODE_ENV==='test'&&adapter.mode==='mock'&&roleTrial?{roleTrial}:{};
 const trialControls=trialProfiles.roleTrial&&roleTrialControls;
 if(!development)core.check(env.PUBLIC_ORIGIN&&/^https:\/\//.test(env.PUBLIC_ORIGIN),'CONFIG','生产环境须配置HTTPS PUBLIC_ORIGIN');
 let staffPortalUrl=null;
 if(!development){
  try{const origin=new URL(env.PUBLIC_ORIGIN);if(origin.protocol==='https:'&&origin.origin===env.PUBLIC_ORIGIN)staffPortalUrl=origin.href;}catch{}
 }
 const store=openStore(dbPath,{seed:seed&&development,productionRuntime:!development});
 const auth=authentication(store,env),today=()=>env.NODE_ENV==='test'?store.settings().today:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),repo=repository(store,{today});
 const external=require('./external-auth.cjs').externalAuth(store,auth,env,integrationFetch);
 const staffIdentity=require('./staff-login.cjs').staffLogin(store,auth,env,integrationFetch);
 const payments=require('./payments.cjs').paymentService(store,env,external,integrationFetch);
 const official=require('./official-account.cjs').officialAccount(store,env,integrationFetch);
 const finances=require('./finance.cjs').finance(store,{today});
 const {trainingService,PREFIX:trainingPrefix}=require('./training.cjs');
 const training=trainingService(store);
 const formExports=require('./approval-export.cjs').approvalExport(store,repo);
 const contacts=require('./work-contacts.cjs').workContacts(store);
 const onboarding=require('./onboarding.cjs').service(store,repo);
 const uploads=require('./file-access.cjs');
 function readAnalyticsSnapshot(read){
  // Collect the entire view from one WAL snapshot, then release it before rendering or writing the audit.
  store.db.exec('BEGIN');
  try{const value=read();store.db.exec('COMMIT');return value;}
  catch(error){store.db.exec('ROLLBACK');throw error;}
 }
 async function rawBody(req,limit,types=['application/json']){core.check(types.includes((req.headers['content-type']||'').split(';')[0]),'CONTENT_TYPE','请求内容类型不受支持',415);let count=0,chunks=[];for await(const chunk of req){count+=chunk.length;core.check(count<=limit,'PAYLOAD_TOO_LARGE','请求过大',413);chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
 function sessionFor(req){return {...auth.identify(req),now:new Date().toISOString(),today:today()};}
 function exportAudit(session,data,format,requestId,query){store.transaction(()=>{const record={id:'audit-'+randomUUID(),actor:session.actor,subject:session.subject,owner:core.own(session.actor),outlet:null,status:'completed',command:'export.generated',requestId,format,scope:{period:data.period,kind:data.kind,mode:data.mode,outlet:query.outlet??'all',owner:query.owner??core.own(session.actor)??'all'},rowCount:data.rows.length,methodVersion:data.methodVersion,createdAt:new Date().toISOString()};store.db.prepare('INSERT INTO audit(id,owner,status,data,created_at) VALUES(?,?,?,?,?)').run(record.id,record.owner,record.status,JSON.stringify(record),record.createdAt);store.sealAudit();});}
 async function json(req,limit=7*1024*1024){core.check((req.headers['content-type']||'').split(';')[0]==='application/json','CONTENT_TYPE','仅接受application/json',415);core.check(!req.headers['content-length']||+req.headers['content-length']<=limit,'PAYLOAD_TOO_LARGE','请求过大',413);let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;core.check(size<=limit,'PAYLOAD_TOO_LARGE','请求过大',413);chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));core.check(value&&typeof value==='object'&&!Array.isArray(value),'JSON','请求体须为JSON对象');return value;}catch{core.fail('JSON','请求体须为合法JSON对象');}}
 async function protectedJson(req,limit){const value=await json(req,limit);sessionFor(req);return value;}
 async function imageUpload(req){
  const contentType=req.headers['content-type']||'';
  if(contentType.split(';')[0].trim().toLowerCase()!=='multipart/form-data'){
   const p=await protectedJson(req);
   core.check(typeof p.base64==='string'&&p.base64.length<=7*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(p.base64),'INPUT','附件内容无效');
   const {name,type,purpose,applicationId,applicationVersion}=p;
   return {name,type,purpose,applicationId,applicationVersion,bytes:Buffer.from(p.base64,'base64')};
  }
  const limit=5*1024*1024+64*1024;
  core.check(contentType.length<=256&&(!req.headers['content-length']||Number(req.headers['content-length'])<=limit),'PAYLOAD_TOO_LARGE','附件请求过大',413);
  let size=0;
  const chunks=[];
  for await(const chunk of req){
   size+=chunk.length;
   core.check(size<=limit,'PAYLOAD_TOO_LARGE','附件请求过大',413);
   chunks.push(chunk);
  }
  let form;
  try{form=await new Response(Buffer.concat(chunks),{headers:{'Content-Type':contentType}}).formData();}
  catch{core.fail('INPUT','请重新选择照片后上传');}
  const keys=[...form.keys()];
  core.check(keys.every(key=>['file','name','type','purpose','applicationId','applicationVersion'].includes(key))&&keys.length===new Set(keys).size,'INPUT','附件字段无效');
  const file=form.get('file');
  core.check(file instanceof File&&file.size>0&&file.size<=5*1024*1024,'INPUT','附件须在5MB内');
  const version=form.get('applicationVersion');
  core.check(version===null||(typeof version==='string'&&/^[1-9]\d{0,15}$/.test(version)),'INPUT','申请版本无效');
  sessionFor(req);
  return {name:form.get('name')??file.name,type:form.get('type')??file.type,purpose:form.get('purpose')??undefined,
   applicationId:form.get('applicationId')??undefined,applicationVersion:version===null?undefined:Number(version),bytes:Buffer.from(await file.arrayBuffer())};
 }
 function fileAccess(f,session,options){return uploads.fileAccess(store,f,session,repo,options);}
 function evidence(p,session){for(const obj of [p.photo,p.data?.photo])if(obj){const f=store.db.prepare('SELECT id,subject,owner FROM files WHERE id=?').get(obj.id||'');core.check(!fileAccess(f,session),'FORBIDDEN','此类图片仅可在原业务使用',403);}}
 function visibleResult(state,session,raw){const v=core.view(state,session.actor,{subject:session.subject});for(const rows of [...Object.values(v).filter(Array.isArray),v.support.chats,v.support.tickets]){const found=rows.find(x=>x.id===raw.id);if(found)return found;}if(raw.agencyUrgeSummary&&raw.agencyUrgeSummary.parentOwner===core.own(session.actor))return raw;core.check(session.actor==='manager'&&['regional','support-settings'].includes(raw.id),'FORBIDDEN','当前权限不允许读取此操作结果',403);return raw;}
 const server=http.createServer(async(req,res)=>{const requestId=randomUUID(),started=Date.now();res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');if(!development)res.setHeader('Strict-Transport-Security','max-age=31536000');res.on('finish',()=>{for(const [key,value] of [['requests.total',1],['requests.duration_ms',Date.now()-started],['requests.errors',res.statusCode>=400?1:0]])store.db.prepare('INSERT INTO runtime_metrics(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(key,value);});
  const respond=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  try{
   const origin=req.headers.origin;if(origin){let u;try{u=new URL(origin);}catch{core.fail('ORIGIN','来源无效',403);}core.check(development?(['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)||u.protocol==='https:'&&origin===env.PUBLIC_ORIGIN):origin===env.PUBLIC_ORIGIN,'ORIGIN','来源不在允许列表',403);res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,Idempotency-Key');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');}
   if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}const url=new URL(req.url,'http://localhost'),route=url.pathname;
   if(route==='/health'&&req.method==='GET'){store.db.prepare('SELECT 1').get();return respond(200,{data:{status:'ok',database:'sqlite',adapterMode:adapter.mode,productionReady:false},requestId});}
   if(route==='/api/config'&&req.method==='GET')return respond(200,{data:{mode:development?'development':'production',adapterMode:adapter.mode,devLoginEnabled:development&&adapter.mode==='mock',passwordLoginEnabled:true,visitorEnabled:true,authCapabilities:external.capabilities,staffLogin:staffIdentity.capabilities,staffPortalUrl,wechatLoginEnabled:external.capabilities.wechat,smsLoginEnabled:external.capabilities.sms,paymentEnabled:payments.capabilities.wechat,paymentChannels:payments.capabilities,...trialProfiles},requestId});
   if(trialControls&&route.startsWith('/api/role-trial/')){
    core.check(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress),'FORBIDDEN','仅限本机隔离试用',403);
    if(route==='/api/role-trial/open'&&req.method==='POST'){
     core.check(req.headers.origin==='http://127.0.0.1:'+req.socket.localPort,'ORIGIN','请从本机试用窗口打开',403);
     await json(req,1024);
     core.check(trialControls.openNative,'TRIAL_NATIVE_UNAVAILABLE','请在微信开发者工具中导入试用工程',503);
     try{await trialControls.openNative();}catch(error){core.fail('TRIAL_NATIVE_UNAVAILABLE',error.message,503);}
     return respond(200,{data:{opened:true},requestId});
    }
    if(route==='/api/role-trial/applicant'&&req.method==='POST'){
     await json(req,1024);
     const key='trial-applicant:'+req.socket.remoteAddress;
     auth.rate(key,60);auth.failure(key,60);
     return respond(200,{data:auth.session('public',true,trialControls.applicantSubject),requestId});
    }
    if(route==='/api/role-trial/proof'&&req.method==='GET'){
     core.check(sessionFor(req).subject===trialControls.applicantSubject,'NOT_FOUND','找不到试用付款截图',404);
     res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});
     return res.end(trialControls.supplementImage);
    }
   }
   if(req.method==='POST'&&['/api/payments/notify','/api/payments/wechat/refund-notify','/api/payments/alipay/notify','/api/payments/alipay/refund-notify'].includes(route)){
    const channel=route.includes('/alipay/')?'alipay':'wechat',refund=route.endsWith('/refund-notify');
    const raw=await rawBody(req,131072,channel==='alipay'?['application/x-www-form-urlencoded']:['application/json']);
    if(refund)await payments.notifyRefund(req.headers,raw,requestId,channel);
    else await payments.notify(req.headers,raw,requestId,channel);
    if(channel==='alipay'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end('success');}
    res.writeHead(204);return res.end();
   }
   if(route==='/api/wechat/official/callback'&&['GET','POST'].includes(req.method)){const query=Object.fromEntries(url.searchParams),output=req.method==='GET'?official.handshake(query):official.inbound(query,await rawBody(req,65536,['text/xml','application/xml']),requestId);res.writeHead(200,{'Content-Type':output.startsWith('<xml>')?'application/xml; charset=utf-8':'text/plain; charset=utf-8'});return res.end(output);}
   if(route==='/api/auth/wechat'&&req.method==='POST')return respond(200,{data:await external.wechat(await json(req,8192),req.socket.remoteAddress),requestId});
   if(route==='/api/auth/sms/send'&&req.method==='POST')return respond(200,{data:await external.send(await json(req,8192),req.socket.remoteAddress),requestId});
   if(route==='/api/auth/sms/verify'&&req.method==='POST')return respond(200,{data:external.verify(await json(req,8192),req.socket.remoteAddress),requestId});
   if(route==='/api/auth/staff/sms/send'&&req.method==='POST')return respond(200,{data:await staffIdentity.sendSms(await json(req,8192),req.socket.remoteAddress),requestId});
   if(route==='/api/auth/staff/sms/verify'&&req.method==='POST')return respond(200,{data:staffIdentity.verifySms(await json(req,8192),req.socket.remoteAddress,requestId),requestId});
   if(route==='/api/auth/staff/wechat/start'&&req.method==='POST'){await json(req,8192);return respond(200,{data:staffIdentity.startWechat(req.socket.remoteAddress),requestId});}
   if(route==='/api/auth/staff/wechat/finish'&&req.method==='POST')return respond(200,{data:await staffIdentity.finishWechat(await json(req,8192),req.socket.remoteAddress,()=>sessionFor(req),requestId),requestId});
   if(route==='/api/auth/password'&&req.method==='POST')return respond(200,{data:await auth.login(await json(req,8192),req.socket.remoteAddress),requestId});
   if(route==='/api/auth/activate'&&req.method==='POST')return respond(200,{data:await auth.activate(await json(req,8192)),requestId});
   if(route==='/api/auth/visitor'&&req.method==='POST'){const key='visitor:'+hash(req.socket.remoteAddress||'local');auth.rate(key,60);auth.failure(key,60);store.db.prepare("INSERT OR IGNORE INTO users(actor,role,status) VALUES('public','public','active')").run();return respond(200,{data:auth.session('public',true),requestId});}
   if(route==='/api/auth/dev'&&req.method==='POST'){
    core.check(development&&adapter.mode==='mock','DEV_DISABLED','开发登录只在开发Mock模式开放',403);const key=req.socket.remoteAddress||'local',entry=rate.get(key)||{count:0,at:Date.now()};if(Date.now()-entry.at>60000){entry.count=0;entry.at=Date.now();}entry.count++;rate.set(key,entry);core.check(entry.count<=60,'RATE_LIMIT','登录请求过多，请稍后再试',429);const p=await json(req,8192);core.check(typeof p.actor==='string','INPUT','开发身份无效');return respond(200,{data:auth.session(p.actor,p.actor==='public'),requestId});
   }
   if(route.startsWith('/api/')){
    const session=sessionFor(req),ctx={...session,requestId,today:today(),now:new Date().toISOString()};
    if(route==='/api/onboarding/config'){
     if(req.method==='GET')return respond(200,{data:onboarding.configuration(ctx),requestId});
     if(req.method==='POST')return respond(200,{data:onboarding.configure(ctx,await protectedJson(req,8192),requestId),requestId});
    }
    if(route==='/api/onboarding/applications'&&req.method==='GET')return respond(200,{data:onboarding.list(ctx,Object.fromEntries(url.searchParams)),requestId});
    if(route.startsWith('/api/onboarding/')&&req.method==='POST'){
     const review=/^\/api\/onboarding\/applications\/(join-[a-f0-9-]{36})\/review$/.exec(route);
     if(review||['/api/onboarding/applications','/api/onboarding/recover'].includes(route)){
      const input=await protectedJson(req,8192),key=req.headers['idempotency-key'];
      if(route==='/api/onboarding/recover'){
       const rateKey='onboarding-recover:'+hash(req.socket.remoteAddress||'local');
       auth.rate(rateKey,60);auth.failure(rateKey,60);
       return respond(200,{data:onboarding.recover(ctx,input,requestId),requestId});
      }
      if(!review&&session.actor==='public'){
       const rateKey='onboarding-submit:'+session.subject;
       auth.rate(rateKey,24);auth.failure(rateKey,24);
      }
      const data=review?onboarding.review(ctx,review[1],input,key,requestId):onboarding.submit(ctx,input,key,requestId);
      return respond(200,{data,requestId});
     }
    }
    if(route==='/api/approval-exports'&&req.method==='GET')return respond(200,{data:formExports.details(session,Object.fromEntries(url.searchParams)),requestId});
    if(route==='/api/approval-exports/grants'&&req.method==='POST')return respond(200,{data:formExports.save(session,await protectedJson(req,8192),requestId),requestId});
    if(route==='/api/approval-exports/csv'&&req.method==='GET'){
     const csv=formExports.file(session,Object.fromEntries(url.searchParams),requestId);
     res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="jiuying-approval-forms.csv"'});
     return res.end(csv);
    }
    if(route==='/api/auth/staff/profile'&&req.method==='GET')return respond(200,{data:staffIdentity.profile(session,url.searchParams.get('actor')),requestId});
    if(route==='/api/auth/staff/mobile'&&req.method==='POST')return respond(200,{data:await staffIdentity.configureMobile(session,await protectedJson(req,8192),()=>sessionFor(req),requestId),requestId});
    if(route==='/api/auth/staff/wechat/bind'&&req.method==='POST')return respond(200,{data:await staffIdentity.beginBinding(session,await protectedJson(req,8192),req.socket.remoteAddress,()=>sessionFor(req)),requestId});
    if(route==='/api/work-contacts'&&req.method==='GET')return respond(200,{data:contacts.lookup(ctx,Object.fromEntries(url.searchParams)),requestId});
    if(route==='/api/work-contacts/manage'&&req.method==='GET')return respond(200,{data:contacts.manage(ctx,Object.fromEntries(url.searchParams)),requestId});
    if(route==='/api/work-contacts/manage'&&req.method==='POST')return respond(200,{data:contacts.save(ctx,await protectedJson(req,8192),requestId),requestId});
    if(route==='/api/auth/wechat/bind'&&req.method==='POST')return respond(200,{data:await external.bind(session,await protectedJson(req,8192),()=>sessionFor(req)),requestId});
    if(route==='/api/auth/bindings'&&req.method==='GET')return respond(200,{data:external.bindings(session),requestId});
    if(route.startsWith(trainingPrefix))return await training({
     route,req,res,query:url.searchParams,session,requestId,respond,
     readJson:limit=>protectedJson(req,limit),reauthorize:()=>sessionFor(req)
    });
    if(route==='/api/reports/context'&&req.method==='GET')return respond(200,{data:repo.reportContext(session,Object.fromEntries(url.searchParams)),requestId});
    if(route==='/api/agency/progress'&&req.method==='GET')return respond(200,{data:readAnalyticsSnapshot(()=>repo.agencyProgress(session,Object.fromEntries(url.searchParams))),requestId});
    if(route==='/api/reports/worklist'&&req.method==='GET')return respond(200,{data:readAnalyticsSnapshot(()=>repo.reportWorklist(session,Object.fromEntries(url.searchParams))),requestId});
    if(route==='/api/workbench/records'&&req.method==='GET')return respond(200,{data:readAnalyticsSnapshot(()=>repo.workbenchRecords(session,Object.fromEntries(url.searchParams))),requestId});
    if(route==='/api/payments/prepay'&&req.method==='POST')return respond(200,{data:await payments.prepay(session,await protectedJson(req,8192),req.headers['idempotency-key'],requestId,()=>sessionFor(req)),requestId});
    if(route==='/api/payments/exceptions'&&req.method==='GET')return respond(200,{data:payments.paymentExceptions(session,Object.fromEntries(url.searchParams)),requestId});
    const channelRefundRequest=/^\/api\/payment-refunds\/requests\/([^/]+)$/.exec(route);
    if(channelRefundRequest&&req.method==='GET')return respond(200,{data:payments.refundChannel(session,decodeURIComponent(channelRefundRequest[1])),requestId});
    if(/^\/api\/payments\/[^/]+\/(query|close)$/.test(route)&&req.method==='POST'){await protectedJson(req,8192);const [,id,action]=route.slice('/api/payments'.length).split('/'),rateKey='payment-query:'+session.subject;auth.rate(rateKey,60);auth.failure(rateKey,60);const result=await payments[action](session,decodeURIComponent(id),requestId,()=>sessionFor(req));sessionFor(req);return respond(200,{data:result,requestId});}
    const paymentAction=/^\/api\/payments\/([^/]+)\/(simulate|refund|reconcile)$/.exec(route);
    const refundAction=/^\/api\/payment-refunds\/([^/]+)\/(query|simulate)$/.exec(route);
    if(req.method==='POST'&&(paymentAction||refundAction)){
     const [,encoded,action]=paymentAction||refundAction,id=decodeURIComponent(encoded),p=await protectedJson(req,8192);
     const rateKey='payment-actions:'+session.subject;
     auth.rate(rateKey,60);auth.failure(rateKey,60);
     const data=paymentAction
      ? action==='simulate'?payments.simulate(session,id,p.outcome,requestId)
       : action==='reconcile'?await payments.reconcilePayment(session,id,requestId)
        : await payments.refundPayment(session,id,p,req.headers['idempotency-key'],requestId,()=>sessionFor(req))
      : action==='simulate'?payments.simulateRefund(session,id,p.outcome,requestId)
       : await payments.queryRefund(session,id,requestId);
     sessionFor(req);
     return respond(200,{data,requestId});
    }
    if(route==='/api/wechat/official/delivery'&&req.method==='GET')return respond(200,{data:official.status(session,url.searchParams.get('chatId')),requestId});
    if(route==='/api/wechat/official/dispatch'&&req.method==='POST'){core.check(session.actor==='manager','FORBIDDEN','仅管理层可触发外部消息队列',403);await protectedJson(req,8192);return respond(200,{data:await official.flush(1),requestId});}
    if(route==='/api/auth/activation'&&req.method==='POST')return respond(200,{data:auth.issueActivation(session,await protectedJson(req,8192)),requestId});
    if(route==='/api/auth/change-password'&&req.method==='POST')return respond(200,{data:await auth.change(session,await protectedJson(req,8192),()=>sessionFor(req)),requestId});
    if(route==='/api/operations/health'&&req.method==='GET'){core.check(session.actor==='manager','FORBIDDEN','仅管理层可访问运行状态',403);const metrics=Object.fromEntries(store.db.prepare('SELECT key,value FROM runtime_metrics').all().map(x=>[x.key,x.value]));return respond(200,{data:{metrics,integrity:store.db.prepare('PRAGMA quick_check').get().quick_check,audit:require('./maintenance.cjs').verifyAudit(store.db),externalMode:adapter.mode,queues:{...payments.queueHealth(),official:store.db.prepare('SELECT status,count(*) count FROM official_outbox GROUP BY status').all()}},requestId});}
    if(req.method==='GET'&&(route==='/api/tasks'||route==='/api/tasks/overview'||/^\/api\/tasks\/[^/]+$/.test(route))){
     const params=Object.fromEntries(url.searchParams);
     const data=route==='/api/tasks/overview'?repo.taskOverview(session,params):route==='/api/tasks'?repo.taskList(session,params):repo.taskDetail(session,decodeURIComponent(route.slice('/api/tasks/'.length)));
     return respond(200,{data,requestId});
    }
    if(req.method==='GET'&&/^\/api\/approval-history\/[^/]+\/[^/]+$/.test(route)){
     const [collection,id]=route.slice('/api/approval-history/'.length).split('/').map(decodeURIComponent);
     const data=approvalHistory.read(store,repo,session,collection,id,Object.fromEntries(url.searchParams));
     return respond(200,{data,requestId});
    }
    if(req.method==='GET'&&route.startsWith('/api/finance/')){
     const query=Object.fromEntries(url.searchParams);
     if(route==='/api/finance/summary')return respond(200,{data:finances.summary(session,query),requestId});
     if(route==='/api/finance/catch-up')return respond(200,{data:finances.catchUpReviews(session,query),requestId});
     if(/^\/api\/finance\/bills\/[^/]+$/.test(route))return respond(200,{data:finances.detail(session,decodeURIComponent(route.slice('/api/finance/bills/'.length)),query),requestId});
     if(route==='/api/finance/export'){
      const data=finances.exportData(session,query);
      exportAudit(session,{...data,period:data.month,kind:'finance',mode:'ledger'},'csv',requestId,query);
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="jiuying-finance.csv"'});
      return res.end(data.csv);
     }
    }
    if(route==='/api/context'&&req.method==='GET')return respond(200,{data:{...repo.context(session),adapterMode:adapter.mode},requestId});
    if(route.startsWith('/api/collections/')&&req.method==='GET'){const [raw,id]=route.slice(17).split('/').map(decodeURIComponent),name=({'support.tickets':'supportTickets','support.chats':'supportChats'})[raw]||raw,params=Object.fromEntries(url.searchParams);return respond(200,{data:id?repo.detail(name,id,session,params):repo.list(name,session,params),requestId});}
    if(route==='/api/auth/logout'&&req.method==='POST'){store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.headers.authorization.slice(7)));return respond(200,{data:{loggedOut:true},requestId});}
    if(route==='/api/state'&&req.method==='GET')return respond(200,{data:{...repo.snapshot(session,{limit:200,...Object.fromEntries(url.searchParams)}),adapterMode:adapter.mode},requestId});
    if(route==='/api/dashboard'&&req.method==='GET')return respond(200,{data:readAnalyticsSnapshot(()=>aggregateSQL(store,session.actor,{...Object.fromEntries(url.searchParams),limit:Math.min(Number(url.searchParams.get('limit')||200),200),includeSettlementStatus:true},ctx)),requestId});
    if(route==='/api/export'&&req.method==='GET'){
     core.check(core.own(session.actor)||session.actor==='manager','FORBIDDEN','仅加盟商本人或总部管理层可以导出',403);
     const query=Object.fromEntries(url.searchParams),format=query.format||'csv';core.check(['csv','xlsx','pdf'].includes(format),'INPUT','导出格式无效');
     const {data,rows}=readAnalyticsSnapshot(()=>{
      const data=aggregateSQL(store,session.actor,{...query,limit:1000,offset:0,includeSettlementStatus:true},ctx);core.check(data.pagination.total<=1000,'EXPORT_LIMIT','单份报告最多1000个网点，请缩小筛选范围',413);
      if(format==='csv')return {data};
      const history=Array.from({length:6},(_,i)=>{const period=new Date(Date.UTC(+data.period.slice(0,4),+data.period.slice(5)-6+i,1)).toISOString().slice(0,7);return aggregateSQL(store,session.actor,{...query,period,kind:'month',limit:1},ctx)});
      const periods=JSON.stringify(data.months),outletIds=JSON.stringify(data.rows.map(x=>x.outlet));
      const businessTasks=store.db.prepare("SELECT data FROM businessTasks WHERE status<>'resolved' AND month IN (SELECT value FROM json_each(?)) AND outlet IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.kind') IN ('report_missing','metric_anomaly','no_data','exemption_review')").all(periods,outletIds).map(x=>JSON.parse(x.data));
      const reports=store.db.prepare(`
       SELECT r.data FROM reports r
       WHERE r.current=1 AND r.status='approved'
         AND r.month IN (SELECT value FROM json_each(?))
         AND r.outlet IN (SELECT value FROM json_each(?))
         AND (?='process' OR EXISTS (
           SELECT 1 FROM settlements s, json_each(s.data,'$.reportIds') ids
           WHERE s.month=r.month AND s.status='approved' AND ids.value=r.id
         ))
      `).all(periods,outletIds,data.mode).map(x=>JSON.parse(x.data));
      const rows=require('./exports.cjs').reportRows(data,{businessTasks,reports,today:ctx.today},session.actor,history);
      return {data,rows};
     });
     if(format==='csv'){sessionFor(req);exportAudit(session,data,format,requestId,query);const safe=x=>'"'+String(x==null?'':x).replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';const csv='\uFEFF'+[['网点ID','名称','营业收入（元）','有效订单','到店客流','实际招生','覆盖月份','预期月份','应报网点月','逾期未报网点月','逾期补报网点月','逾期待免报核实网点月'],...data.rows.map(r=>[r.outlet,r.name,r.revenue,r.orders,r.traffic,r.enroll,r.coverage,r.expectedMonths,r.reportingCoverage?.expected,r.reportingCoverage?.overdue,r.reportingCoverage?.lateSubmitted,r.reportingCoverage?.overdueExemptReview])].map(row=>row.map(safe).join(',')).join('\r\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="jiuying-statistics.csv"'});return res.end(csv);}
     const exporter=require('./exports.cjs');
     const bytes=format==='xlsx'?await exporter.exportXlsx(rows):await exporter.exportPdf(rows,{development});
     sessionFor(req);exportAudit(session,data,format,requestId,query);
     res.writeHead(200,{'Content-Type':format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="jiuying-report.${format}"`,'Content-Length':bytes.length});
     return res.end(bytes);
    }
    if(route==='/api/files'&&req.method==='POST'){
     const {name:submittedName,type,purpose,bytes,applicationId,applicationVersion}=await imageUpload(req);
     core.check(typeof submittedName==='string'&&submittedName.trim().length>0&&submittedName.length<=200,'INPUT','附件名称无效');
     core.check(['image/png','image/jpeg','image/webp'].includes(type),'INPUT','仅支持PNG/JPEG/WebP图片');
     uploads.checkUploadPurpose(purpose,session);
     core.check(purpose==='onboarding-proof'||(applicationId===undefined&&applicationVersion===undefined),'INPUT','附件字段无效');
     if(purpose==='onboarding-proof'){
      const rateKey='onboarding-proof:'+hash(req.socket.remoteAddress||'local');
      auth.rate(rateKey,60);auth.failure(rateKey,60);
      onboarding.authorizeProofUpload(ctx,applicationId,applicationVersion);
     }
     core.check(bytes.length>0&&bytes.length<=5*1024*1024,'INPUT','附件须在5MB内');
     const magic=type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
     core.check(magic,'INPUT','附件MIME和文件魔数不一致');
     const sanitized=await require('./uploads.cjs').sanitizeImage(bytes,type,submittedName);
     const id='file-'+randomUUID(),name=sanitized.name;
     core.check(name.length>0,'INPUT','附件名称无效');
     store.transaction(()=>{
      const fresh=sessionFor(req);
      uploads.checkUploadPurpose(purpose,fresh);
      const target=purpose==='onboarding-proof'?onboarding.authorizeProofUpload(fresh,applicationId,applicationVersion):null;
      store.db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?)').run(id,session.subject,core.own(session.actor),name,type,sanitized.bytes.length,hash(sanitized.bytes),sanitized.bytes,new Date().toISOString());
      store.db.prepare('INSERT INTO file_metadata VALUES(?,?,?,?,?)').run(id,sanitized.originalDigest,sanitized.width,sanitized.height,sanitized.transformVersion);
      if(purpose)uploads.registerUploadPurpose(store,id,purpose,target);
     });
     return respond(201,{data:{id,name,type,size:sanitized.bytes.length,url:'/api/files/'+id,sanitized:true,width:sanitized.width,height:sanitized.height},requestId});
    }
    if(route.startsWith('/api/files/')&&req.method==='GET'){
     const id=route.slice(11);
     const readFile=store.db.prepare('SELECT * FROM files WHERE id=?');
     const options={publishedOutletPhoto:url.searchParams.get('publishedOutletPhoto')};
     let f=readFile.get(id),purpose=fileAccess(f,session,options);
     if(!store.db.prepare('SELECT 1 FROM file_metadata WHERE file_id=?').get(id)){
      const safe=await require('./uploads.cjs').sanitizeImage(Buffer.from(f.bytes),f.mime,f.name);
      store.transaction(()=>{
       purpose=fileAccess(f,sessionFor(req),options);
       store.db.prepare('UPDATE files SET bytes=?,size=?,digest=? WHERE id=?').run(safe.bytes,safe.bytes.length,hash(safe.bytes),id);
       store.db.prepare('INSERT OR IGNORE INTO file_metadata VALUES(?,?,?,?,?)').run(id,safe.originalDigest,safe.width,safe.height,safe.transformVersion);
      });
      f=readFile.get(id);
     }
     res.writeHead(200,{'Content-Type':f.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(f.name),'Content-Length':f.size,
      ...(purpose?{'Cache-Control':'private, no-store'}:{})});
     return res.end(Buffer.from(f.bytes));
    }
    if(route==='/api/commands'&&req.method==='POST'){
     const p=await protectedJson(req,256*1024),key=req.headers['idempotency-key'];core.check(typeof key==='string'&&key.length>=8&&key.length<=128,'IDEMPOTENCY_KEY','Idempotency-Key必填，8—128字符');core.check(p&&typeof p.command==='string'&&p.payload&&typeof p.payload==='object'&&!Array.isArray(p.payload),'INPUT','command和payload必填');adapter.assertCommand(p.command);evidence(p.payload,session);require('./file-access.cjs').publicImageEvidence(store,p.command,p.payload);const fingerprint=hash(JSON.stringify({command:p.command,payload:p.payload}));
     const data=store.transaction(()=>{
      payments.guard(p.command,p.payload);
      const state=repo.commandState(session,p.command,p.payload);
      const cached=store.db.prepare('SELECT * FROM idempotency WHERE subject=? AND key=?').get(session.subject,key);
      const isTask=p.command.startsWith('task.');
      if(cached){
       if(p.command==='agency.urge')require('../shared/agency.cjs').authorizeUrge(state,session.actor,p.payload);
       core.check(cached.request_hash===fingerprint,'IDEMPOTENCY_CONFLICT','同一幂等键不能用于不同请求',409);
       if(session.actor==='regional'&&p.command==='review.report'){
        const report=state.reports.find(row=>row.id===p.payload.id);
        const grants=scopedGrants(state,session.actor,session);
        core.check(report&&grants.outlets.includes(report.outlet)&&grants.reviewOutlets.includes(report.outlet),'FORBIDDEN','无此网点审核授权',403);
       }
       const prior=JSON.parse(cached.result);
       const result=isTask?repo.assertTaskReplay(session,p.command,p.payload,prior)
        :p.command==='support.ticket'?repo.detail('supportTickets',prior.id,session):visibleResult(state,session,prior);
       return {result,state:{...repo.snapshot(session,{limit:200}),adapterMode:adapter.mode},replayed:true};
      }
      const filePolicy=require('./file-access.cjs');
      const supportAttachments=p.command==='support.ticket'?filePolicy.supportTicketEvidence(store,session,p.payload.attachmentIds):[];
      const updated=core.execute(state,session.actor,p.command,p.payload,{...ctx,jobScope:state.__jobScope});
      store.save(updated.state,{before:state});
      filePolicy.bindSupportTicketFiles(store,updated.result?.id,supportAttachments);
      approvalHistory.record(store,{before:state,after:updated.state,result:updated.result,command:p.command,payload:p.payload,session,requestId,at:ctx.now});
      official.enqueue(p.command,updated.result,p.payload);
      const result=isTask?repo.assertTaskReplay(session,p.command,p.payload,updated.result):visibleResult(updated.state,session,updated.result);
      const snapshot={...repo.snapshot(session,{limit:200}),adapterMode:adapter.mode};
      store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)').run(session.subject,key,fingerprint,JSON.stringify(result),ctx.now);
      return {result,state:snapshot,replayed:false};
     });
     return respond(200,{data,requestId});
    }
    core.fail('NOT_FOUND','API不存在',404);
   }
   if(req.method==='GET'){const web=path.join(ROOT,'../web'),relative=route==='/'?'index.html':decodeURIComponent(route.slice(1)),target=path.resolve(web,relative);core.check(target.startsWith(web+path.sep),'NOT_FOUND','资源不存在',404);const ext=path.extname(target),mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'}[ext];core.check(mime&&fs.existsSync(target)&&fs.statSync(target).isFile(),'NOT_FOUND','资源不存在',404);res.writeHead(200,{'Content-Type':mime});return fs.createReadStream(target).pipe(res);}
   core.fail('NOT_FOUND','路由不存在',404);
  }catch(e){if(e.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint failed/.test(e.message)){e.status=409;e.code='DUPLICATE';e.message='唯一记录已存在，请刷新后查看';}const status=e.status||500;respond(status,{error:{code:e.code||'INTERNAL',message:status===500?'服务内部错误，已记录requestId':e.message},requestId});if(status===500)console.error(JSON.stringify({requestId,errorType:e.name,code:e.code||'INTERNAL'}));}
  finally{if(env.REQUEST_LOG==='1'||!development)console.log(JSON.stringify({requestId,method:req.method,path:(req.url||'').split('?')[0],durationMs:Date.now()-started,status:res.statusCode}));}
 });server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;return {server,store,official,payments};
}
if(require.main===module){const app=createServer(),paymentWorker=require('./payment-worker.cjs').startPaymentWorker(app.payments),officialWorker=require('./official-worker.cjs').startOfficialWorker(app.official),scheduler=process.env.SCHEDULER_ENABLED==='0'?null:require('./scheduler.cjs').startScheduler(app.store),host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8787);if((process.env.ADAPTER_MODE||'mock')==='mock'&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('开发账号模式只能绑定loopback');app.server.listen(port,host,()=>console.log(JSON.stringify({event:'listening',host,port,mode:process.env.NODE_ENV==='production'?'production':'local-development',productionReady:false})));let stopping=false;async function shutdown(){if(stopping)return;stopping=true;await scheduler?.stop();await officialWorker.stop();await paymentWorker.stop();app.server.close(()=>{app.store.close();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);}
module.exports={createServer};

