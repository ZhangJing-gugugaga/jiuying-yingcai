const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../miniprogram');
function page(name,q={}){let def;global.Page=d=>def=d;const file=path.join(root,'pages',name,'index.js');delete require.cache[require.resolve(file)];require(file);const p={...def,data:structuredClone(def.data),setData(v){for(const [k,value]of Object.entries(v)){const keys=k.split('.');let t=this.data;for(const x of keys.slice(0,-1))t=t[x]||(t[x]={});t[keys.at(-1)]=value;}}};p.onLoad?.(q);return p;}
async function harness(fn){const {createServer}=require('../server/index.cjs');const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const config=require('../miniprogram/config'),old=config.apiBase;config.apiBase='http://127.0.0.1:'+app.server.address().port;const storage=new Map(),calls=[],downloads=[],opened=[];global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast(){},showModal(o){o.success({confirm:true});},reLaunch(){},navigateTo(o){calls.push({navigate:o.url});o.success?.();},switchTab(o){o.success?.();},stopPullDownRefresh(){},pageScrollTo(){},request:async o=>{calls.push({url:o.url,method:o.method});try{const r=await fetch(o.url,{method:o.method,headers:o.header,...(o.method==='GET'?{}:{body:JSON.stringify(o.data)})});o.success({statusCode:r.status,data:await r.json()});}catch(e){o.fail(e);}},downloadFile:async o=>{const r=await fetch(o.url,{headers:o.header});downloads.push({url:o.url,bytes:Buffer.from(await r.arrayBuffer()),status:r.status,authorization:o.header.Authorization});o.success({statusCode:r.status,tempFilePath:'/tmp/export.'+new URL(o.url).searchParams.get('format')});},openDocument:o=>{opened.push(o);o.success();}};const api=require('../miniprogram/utils/api');try{await api.login('partnerA');await fn({app,api,storage,calls,downloads,opened});}finally{config.apiBase=old;await new Promise(r=>app.server.close(r));app.store.close();}}

test('native lists page beyond 200 with server filters and retain no hidden rows after empty filter',()=>harness(async({app,calls})=>{const s=app.store.load(),base=s.outlets.find(o=>o.owner==='p1');for(let i=0;i<230;i++)s.outlets.push({...structuredClone(base),id:'page-'+i,name:'分页网点'+i,city:i===229?'终页城市':'分页城市'});app.store.save(s);const p=page('outlets');await p.onShow();assert.equal(p.data.error,'');assert.equal(p.data.rows.length,50);assert.equal(p.data.pagers.outlets.total,233);while(p.data.pagers.outlets.hasMore)await p.more({currentTarget:{dataset:{collection:'outlets'}}});assert.equal(p.data.rows.length,233);assert.ok(p.data.rows.some(x=>x.id==='page-229'));await p.search({detail:{value:'终页城市'}});assert.equal(p.data.rows.length,1);await p.search({detail:{value:'完全不存在的地区'}});assert.equal(p.data.rows.length,0);assert.equal(p.data.pagers.outlets.hasMore,false);assert.ok(!calls.some(c=>c.url?.includes('/api/state')));const detail=page('outlet',{id:'page-229'});await detail.onShow();assert.equal(detail.data.outlet.id,'page-229');}));

test('native dashboard downloads real authenticated XLSX/PDF and opens native document',()=>harness(async({downloads,opened})=>{const p=page('dashboard');await p.onShow();await p.export({currentTarget:{dataset:{format:'xlsx'}}});await p.export({currentTarget:{dataset:{format:'pdf'}}});assert.equal(p.data.error,'');assert.equal(downloads.length,2);assert.equal(downloads[0].bytes.subarray(0,2).toString(),'PK');assert.equal(downloads[1].bytes.subarray(0,5).toString(),'%PDF-');assert.deepEqual(opened.map(x=>x.fileType),['xlsx','pdf']);assert.ok(downloads.every(x=>x.authorization.startsWith('Bearer ')));}));

test('native login accepts username/password and activation without retaining password',async()=>{const config=require('../miniprogram/config'),old=config.development,oldBase=config.apiBase;config.development=false;config.apiBase='https://native-auth.example.test';const stored=new Map(),calls=[];global.wx={getStorageSync:k=>stored.get(k),setStorageSync:(k,v)=>stored.set(k,v),removeStorageSync:k=>stored.delete(k),reLaunch(){},request:o=>{calls.push(o);o.success({statusCode:200,data:{data:{token:'identity-token',actor:'partner:p1',mode:'password'}}});}};try{const p=page('login');assert.equal(typeof p.passwordLogin,'function');p.setData({username:'manager@example.test',password:'Example-Strong-123!'});await p.passwordLogin();assert.ok(calls.some(x=>x.url.endsWith('/api/auth/password')&&x.data.username==='manager@example.test'));assert.equal(p.data.password,'');p.setData({activationToken:'activation-token',password:'Another-Strong-123!',confirmPassword:'Another-Strong-123!'});await p.activate();assert.ok(calls.some(x=>x.url.endsWith('/api/auth/activate')));assert.ok(!JSON.stringify([...stored]).includes('Strong'));assert.equal(p.data.activationToken,'');}finally{config.development=old;config.apiBase=oldBase;}});

module.exports={harness,page};

test('native agreement history keeps both contracts’ own dates, parties and prices after renewal',()=>harness(async({app,api,storage})=>{
 app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify('2027-03-15'));
 const previousSession=api.session();
 await api.login('manager');
 const oldPlan=(await api.command('plan.publish',{name:'首期样例方案',amount:1200,serviceEntity:'首期服务主体',collectionEntity:'首期收款主体',invoiceEntity:'首期开票主体',terms:'首期条款',reason:'隔离合同历史'})).result;
 const renewedPlan=(await api.command('plan.publish',{name:'续签样例方案',amount:1500,serviceEntity:'续签服务主体',collectionEntity:'续签收款主体',invoiceEntity:'续签开票主体',terms:'续签条款',reason:'隔离合同历史'})).result;
 const common={outlet:'cs',billDay:1,dueDay:5,reason:'隔离历史日期测试'};
 const original=(await api.command('agreement.create',{...common,planId:oldPlan.id,startMonth:'2026-10',endMonth:'2027-02',reference:'TERM-ORIGINAL'})).result;
 const renewed=(await api.command('agreement.create',{...common,planId:renewedPlan.id,startMonth:'2027-03',endMonth:'2028-02',reference:'TERM-RENEWED'})).result;
 app.store.db.prepare("UPDATE agreements SET data=json_remove(data,'$.startOn','$.endOn') WHERE id=?").run(original.id);
 storage.set('jyyc.session',previousSession);
 const agreements=page('agreements');await agreements.onShow();
 assert.equal(agreements.data.error,'');
 const old=agreements.data.rows.find(row=>row.id===original.id),current=agreements.data.rows.find(row=>row.id===renewed.id);
 assert.deepEqual([old.agreementStart,old.agreementEnd,old.statusText],['2026年10月01日','2027年02月28日','已到期']);
 assert.deepEqual([current.agreementStart,current.agreementEnd,current.statusText],['2027年03月01日','2028年02月29日','生效中']);
 assert.deepEqual([old.plan.serviceEntity,old.plan.collectionEntity,old.plan.invoiceEntity,old.amount,old.plan.version],['首期服务主体','首期收款主体','首期开票主体',1200,oldPlan.version]);
 assert.deepEqual([current.plan.serviceEntity,current.plan.collectionEntity,current.plan.invoiceEntity,current.amount,current.plan.version],['续签服务主体','续签收款主体','续签开票主体',1500,renewedPlan.version]);
 assert.equal((await api.request('/api/collections/agreements/'+original.id)).endOn,'2027-02-28');
 assert.equal(renewed.endOn,'2028-02-29');
}));

test('native finance uses real agreement, offline review, invoice and refund state machines',()=>harness(async({api,storage})=>{
 async function staff(actor,command,payload){const old=api.session();await api.login(actor);try{return await api.command(command,payload);}finally{storage.set('jyyc.session',old);}}
 const plan=await staff('manager','plan.publish',{name:'测试整月服务',amount:1200,serviceEntity:'测试服务主体',collectionEntity:'测试收款主体',invoiceEntity:'测试开票主体',terms:'验收使用的整月服务条款',reason:'自动化验收资料'});
 const agreement=await staff('manager','agreement.create',{outlet:'cs',planId:plan.result.id,startMonth:'2026-10',endMonth:'2027-10',billDay:1,dueDay:5,reference:'NATIVE-AGREEMENT',reason:'自动化验收'});
 const bill=await staff('finance','billing.generate',{agreementId:agreement.result.id,month:'2026-10'});
 const agreements=page('agreements');await agreements.onShow();assert.equal(agreements.data.error,'');assert.equal(agreements.data.rows[0].plan.invoiceEntity,'测试开票主体');
 const p=page('finance',{type:'offline',billId:bill.result.id});await p.onShow();assert.equal(p.data.error,'');p.setData({'form.amount':'1200','form.reference':'NATIVE-OFFLINE-001','form.paidOn':'2026-10-05','form.reason':'测试登记线下付款'});await p.submit();assert.equal(p.data.error,'');assert.equal(p.data.state.offlinePayments[0].status,'pending');
 const targeted=page('finance',{id:p.data.state.offlinePayments[0].id});
 await targeted.onShow();
 assert.equal(targeted.data.selectedApplication.id,p.data.state.offlinePayments[0].id);
 assert.equal(targeted.data.selectedApplication.statusText,'待财务核验');
 const offline=p.data.state.offlinePayments[0];await staff('finance','offline.review',{id:offline.id,decision:'approve',note:'已核验测试凭证'});await p.refresh();const receipt=p.data.receipts.find(x=>x.billId===bill.result.id);assert.ok(receipt);
 p.selectType({detail:{value:'2'}});p.selectReceipt({detail:{value:String(p.data.receipts.findIndex(x=>x.id===receipt.id))}});p.setData({'form.amount':'1200','form.title':'测试开票抬头','form.taxId':'TEST-TAX-ID','form.reason':'测试申请发票'});await p.submit();assert.equal(p.data.error,'');assert.equal(p.data.state.invoiceRequests[0].status,'pending');
 await staff('finance','invoice.update',{id:p.data.state.invoiceRequests[0].id,status:'cancelled',note:'测试取消后退款'});p.selectType({detail:{value:'1'}});p.setData({'form.amount':'100','form.reason':'测试退款申请'});await p.submit();assert.equal(p.data.error,'');assert.equal(p.data.state.refundRequests[0].status,'pending');
 await api.login('partnerB');const other=page('finance');await other.onShow();assert.equal(other.data.state.offlinePayments.length,0);assert.equal(other.data.state.invoiceRequests.length,0);assert.equal(other.data.state.refundRequests.length,0);
}));

test('native public content and FAQ show published data while unconfigured cases stay empty',()=>harness(async({api})=>{
 await api.login('manager');await api.command('content.update',{key:'brand',title:'测试集团资料',text:'经审核发布的测试内容',published:true,reason:'自动化验收'});await api.command('faq.save',{question:'如何联系服务？',answer:'通过在线客服提交问题。',keywords:['联系','服务'],published:true,reason:'自动化验收'});await api.command('content.update',{key:'news',title:'内部草稿',text:'不允许公开',published:false,reason:'测试隔离'});
 await api.visitor();const p=page('discover');await p.onShow();assert.equal(p.data.error,'');assert.equal(p.data.articles[0].title,'测试集团资料');assert.equal(p.data.faqs[0].question,'如何联系服务？');p.selectSection({currentTarget:{dataset:{section:'cases'}}});assert.equal(p.data.articles.length,0);p.selectSection({currentTarget:{dataset:{section:'news'}}});assert.equal(p.data.articles.length,0);assert.equal(p.data.isPublic,true);
}));


test('service directory shows the unpublished notice only when no service is public', async ()=>{
 const catalog=page('discover',{section:'services'});
 const markup=require('node:fs').readFileSync(path.join(root,'pages','discover','index.wxml'),'utf8');
 for(const [publicContents,empty] of [[[],true],[[{id:'service-test',key:'service-1',title:'样例'}],false]]) {
  await catalog.renderContent({publicContents});
  assert.equal(catalog.data.serviceRows.filter(row=>row.available).length,publicContents.length);
  const notice=markup.match(/wx:if="{{state && (\w+) && !loading && !error}}" class="empty">该栏目内容暂未发布/);
  assert.ok(notice);
  assert.equal(catalog.data[notice[1]],empty);
 }
});
test('V3.3 five-service publication reaches native visitor details, isolates drafts and revokes old covers',()=>harness(async({api,storage,calls,downloads})=>{
 const cover=async()=>{const bytes=await require('sharp')({create:{width:3,height:3,channels:3,background:'#143f3a'}}).png().toBuffer();return (await api.request('/api/files','POST',{name:'测试封面.png',type:'image/png',base64:bytes.toString('base64')})).id;};
 const partnerImage=await cover();
 await api.login('manager');
 const manager=api.session();
 const imageV1=await cover(),imageV2=await cover();
 const save=(slot,title,published,imageId=null)=>api.command('content.service.save',{slot,title,summary:title+'摘要',body:title+'正文',published,imageId,reason:'自动化验收专用'});
 await assert.rejects(()=>save(1,'私有图片拒绝',true,partnerImage),{code:'FORBIDDEN'});
 const one=(await save(1,'测试栏目一',true,imageV1)).result;
 for(let slot=2;slot<=5;slot++)await save(slot,'测试栏目'+slot,true);
 await save(1,'内部草稿内容',false,imageV2);
 const manage=page('discover',{section:'services'});await manage.onShow();
 assert.deepEqual(manage.data.serviceRows.map(x=>x.title),['测试栏目一','测试栏目2','测试栏目3','测试栏目4','测试栏目5']);
 await api.visitor();const visitor=api.session();
 const catalog=page('discover',{section:'services'});await catalog.onShow();
 assert.equal(catalog.data.error,'');
 assert.deepEqual(catalog.data.serviceRows.map(x=>x.slot),[1,2,3,4,5]);
 assert.equal(catalog.data.serviceRows[0].summary,'测试栏目一摘要');
 assert.ok(catalog.data.serviceRows[0].coverPath);
 assert.ok(downloads.some(x=>x.url.endsWith(imageV1)&&x.status===200&&x.bytes.subarray(1,4).toString()==='PNG'));
 assert.doesNotMatch(JSON.stringify(catalog.data),/内部草稿内容|publishedSnapshot/);
 await assert.rejects(()=>api.download('/api/files/'+imageV2));
 await assert.rejects(()=>api.collection('contentVersions'),{code:'FORBIDDEN'});
 catalog.openService({currentTarget:{dataset:{id:one.id}}});
 assert.ok(calls.some(x=>x.navigate==='/pages/service-detail/index?id='+one.id));
 const detail=page('service-detail',{id:one.id});await detail.onShow();
 assert.equal(detail.data.service.body,'测试栏目一正文');
 assert.ok(detail.data.coverPath);
 const change=(action,expectedVersion,sourceVersion)=>api.command('content.publication',{key:'service-1',action,expectedVersion,sourceVersion,reason:'自动化验收版本切换'});
 await assert.rejects(()=>change('withdraw',2),{code:'FORBIDDEN'});
 storage.set('jyyc.session',manager);
 const v3=(await save(1,'测试新版栏目',true,imageV2)).result;
 await assert.rejects(()=>change('restore',v3.version,2),{code:'TRANSITION'});
 await assert.rejects(()=>change('withdraw',2),{code:'CONFLICT'});
 storage.set('jyyc.session',visitor);await detail.refresh();
 assert.equal(detail.data.service.body,'测试新版栏目正文');
 await assert.rejects(()=>api.download('/api/files/'+imageV1));
 storage.set('jyyc.session',manager);
 const withdrawn=(await change('withdraw',v3.version)).result;
 storage.set('jyyc.session',visitor);await catalog.refresh();await detail.refresh();
 assert.equal(catalog.data.serviceRows.length,5);
 assert.equal(catalog.data.serviceRows[0].available,false);
 assert.equal(detail.data.service,null);
 assert.match(detail.data.error,/该业务资料不存在或尚未发布。/);
 await assert.rejects(()=>api.detail('contents',one.id),{code:'NOT_FOUND'});
 await assert.rejects(()=>api.download('/api/files/'+imageV2));
 storage.set('jyyc.session',manager);
 await change('restore',withdrawn.version,1);
 const history=(await api.collection('contentVersions',{limit:50})).items.filter(x=>x.key==='service-1').sort((a,b)=>a.version-b.version);
 assert.deepEqual(history.map(x=>x.status),['published','draft','published','withdrawn','published']);
 assert.equal(history.at(-1).sourceVersion,1);
 storage.set('jyyc.session',visitor);await detail.refresh();
 assert.equal(detail.data.error,'');
 assert.equal(detail.data.service.body,'测试栏目一正文');
 assert.equal(detail.data.service.version,5);
 assert.ok(detail.data.coverPath);
}));

test('native tasks and notifications deep link to the correct business record without read-completing tasks',()=>harness(async({api,storage,calls})=>{
 const old=api.session();await api.login('manager');await api.command('jobs.run',{});storage.set('jyyc.session',old);
 const p=page('tasks');await p.onShow();assert.equal(p.data.error,'');const task=p.data.state.businessTasks.find(x=>x.kind==='report_missing');assert.ok(task);await p.open({currentTarget:{dataset:{id:task.id}}});assert.ok(calls.some(x=>x.navigate?.startsWith('/pages/report/index?')&&x.navigate.includes('month='+task.month)));
 const messages=page('messages');await messages.onShow();const msg=messages.data.state.messages.find(x=>x.taskId===task.id);assert.ok(msg);await messages.read({currentTarget:{dataset:{id:msg.id}}});await messages.open({currentTarget:{dataset:{id:msg.id}}});const current=await api.detail('businessTasks',task.id);assert.equal(current.status,'open');
}));

test('V3.3 native workbench and tasks share the persisted current responsibility and bill amount',()=>harness(async({app,api,storage})=>{
 const partner=api.session();
 await api.login('manager');
 await api.command('jobs.run',{});
 const manager=api.session();
 const headquarters=await api.request('/api/tasks?queue=hq');
 const internal=headquarters.items.find(row=>row.kind==='location_missing'&&row.outlet==='cs');
 assert.ok(internal);
 storage.set('jyyc.session',partner);
 const legacy=await api.collection('businessTasks',{status:'open'});
 assert.ok(legacy.items.every(row=>row.queue==='partner'&&row.assigneeRole==='partner'));
 const current=await api.request('/api/tasks?queue=partner');
 assert.deepEqual(legacy.items.map(row=>row.id),current.items.map(row=>row.id));
 const bill=current.items.find(row=>row.kind==='bill_unpaid'&&row.outlet==='cs');
 const location=current.items.find(row=>row.kind==='location_missing'&&row.outlet==='cs');
 assert.notEqual(location.id,internal.id);
 assert.equal(bill.amount,(await api.detail('bills',bill.businessId)).amount);
 for(const route of ['/api/tasks/','/api/collections/businessTasks/'])await assert.rejects(()=>api.request(route+internal.id),{code:'NOT_FOUND'});
 app.store.db.prepare("UPDATE businessTasks SET status='in_progress',data=json_set(data,'$.status','in_progress') WHERE id=?").run(location.id);
 const home=page('home');await home.onShow();
 assert.equal(home.data.error,'');
 assert.equal(home.data.todoTotal,current.total);
 assert.equal(home.data.todos.find(row=>row.id===location.id).category,'处理中');
 assert.match(home.data.todos.find(row=>row.id===bill.id).detail,/应付/);
 const tasks=page('tasks');await tasks.onShow();
 await tasks.status({currentTarget:{dataset:{status:'in_progress'}}});
 assert.ok(tasks.data.taskRows.some(row=>row.id===location.id));
 assert.equal(tasks.data.pagers.businessTasks.total,1);
 const inbox=page('messages');await inbox.onShow();
 const message=inbox.data.state.messages.find(row=>row.taskId===location.id);
 assert.ok(message);
 await inbox.read({currentTarget:{dataset:{id:message.id}}});
 assert.equal((await api.detail('businessTasks',location.id)).status,'in_progress');
 await api.login('partnerB');
 for(const route of ['/api/tasks/','/api/collections/businessTasks/'])await assert.rejects(()=>api.request(route+location.id),{code:'NOT_FOUND'});
 storage.set('jyyc.session',manager);
 assert.equal((await api.request('/api/tasks/overview')).items.length,4);
}));

test('native visitor profile stays public and draft input survives list reload',()=>harness(async({api})=>{
 const p=page('report',{outlet:'cs',month:'2026-10'});await p.onShow();p.input({currentTarget:{dataset:{field:'revenue'}},detail:{value:'998.12'}});await p.reloadCollection('outlets');assert.equal(p.data.form.revenue,'998.12');
 await api.visitor();const profile=page('profile');await profile.onShow();assert.equal(profile.data.error,'');assert.equal(profile.data.isPublic,true);
}));

test('native activation, password login and password rotation run against real identity storage',()=>harness(async({api})=>{
 await api.login('manager');const activation=await api.request('/api/auth/activation','POST',{actor:'partnerA',username:'native.partner'});const login=page('login');login.setData({activationToken:activation.token,password:'Native-Initial-12345',confirmPassword:'Native-Initial-12345'});await login.activate();assert.equal(login.data.error,'');assert.equal(api.session().actor,'partnerA');assert.equal(login.data.password,'');
 const security=page('security');await security.onShow();security.setData({form:{currentPassword:'Native-Initial-12345',password:'Native-Rotated-12345',confirmPassword:'Native-Rotated-12345'}});await security.changePassword();assert.equal(security.data.error,'');assert.equal(api.session(),null);assert.equal(security.data.form.password,'');login.setData({username:'native.partner',password:'Native-Rotated-12345'});await login.passwordLogin();assert.equal(login.data.error,'');assert.equal(api.session().actor,'partnerA');assert.equal(login.data.password,'');
}));

test('native bill and request filters are server-side and render empty results explicitly',()=>harness(async({app})=>{
 const s=app.store.load();const b=s.bills.find(x=>x.owner==='p1');for(let i=0;i<220;i++){s.outlets.push({...structuredClone(s.outlets[0]),id:'bill-outlet-'+i,outlet:'bill-outlet-'+i});s.bills.push({...structuredClone(b),outlet:'bill-outlet-'+i,id:'bill-paged-'+i,month:'2026-10'});}app.store.save(s);const fees=page('fees');await fees.onShow();assert.equal(typeof fees.filterMonth,'function');await fees.filterMonth({detail:{value:'2026-10'}});assert.equal(fees.data.pagers.bills.total,220);while(fees.data.pagers.bills.hasMore)await fees.more({currentTarget:{dataset:{collection:'bills'}}});assert.equal(fees.data.bills.length,220);await fees.filterStatus({currentTarget:{dataset:{status:'paid'}}});assert.equal(fees.data.bills.length,0);assert.equal(fees.data.pagers.bills.total,0);
 const requests=page('requests');await requests.onShow();assert.equal(typeof requests.filterStatus,'function');await requests.filterStatus({currentTarget:{dataset:{status:'supplement'}}});assert.equal(requests.data.state.requests.length,0);
}));

test('native public map uses explicitly published coordinates and marker opens the outlet',()=>harness(async({api,calls})=>{
 await api.login('manager');await api.command('public.profile',{outlet:'cs',title:'测试公开网点',description:'已审核公开资料',services:['测试服务'],contact:'000-00000000',address:'测试公开地址',published:true,publicCoords:{lat:28.2,lng:113.1,coordinateSystem:'GCJ-02'},reason:'明确授权公开的测试坐标'});await api.visitor();const p=page('outlets');await p.onShow();assert.equal(p.data.error,'');const marker=p.data.markers.find(x=>x.outletId==='cs');assert.ok(marker);assert.equal(marker.latitude,28.2);assert.ok(!p.data.rows.find(x=>x.id==='cs').coords,'private GPS must not leak');p.marker({detail:{markerId:marker.id}});assert.ok(calls.some(x=>x.navigate==='/pages/outlet/index?id=cs'));
}));

test('native partner can browse a different partner published outlet without mixing private data',()=>harness(async({api,calls})=>{
 await api.login('manager');
 await api.command('public.profile',{outlet:'gz',title:'验收公开服务网点',description:'公开介绍',services:['验收服务'],
  address:'验收公开服务地址',published:true,publicCoords:{lat:23.1,lng:113.2,coordinateSystem:'GCJ-02'},reason:'隔离环境的显式公开授权'});
 await api.login('partnerA');
 const pageList=page('outlets');
 await pageList.onShow();
 assert.equal(pageList.data.error,'');
 assert.ok(pageList.data.rows.every(row=>row.owner==='p1'&&row.summaryRows.length===3));
 assert.ok(!pageList.data.rows.some(row=>row.id==='gz'));
 await pageList.changeScope({currentTarget:{dataset:{scope:'public'}}});
 await pageList.search({detail:{value:'验收公开'}});
 assert.equal(pageList.data.error,'');
 assert.deepEqual(pageList.data.rows.map(row=>row.id),['gz']);
 assert.equal(pageList.data.markers[0].latitude,23.1);
 assert.equal(pageList.data.rows[0].summary,undefined);
 pageList.marker({detail:{markerId:pageList.data.markers[0].id}});
 assert.ok(calls.some(call=>call.navigate==='/pages/outlet/index?id=gz&scope=public'));
 const detail=page('outlet',{id:'gz',scope:'public'});
 await detail.onShow();
 assert.equal(detail.data.error,'');
 assert.equal(detail.data.outlet.name,'验收公开服务网点');
 assert.equal(detail.data.outlet.address,'验收公开服务地址');
 assert.equal(detail.data.internal,false);
 assert.equal(detail.data.summary,null);
 const privateDetail=page('outlet',{id:'gz'});
 await privateDetail.onShow();
 assert.ok(privateDetail.data.error);
 assert.equal(privateDetail.data.outlet,null);
}));

test('native outlet detail starts separate business pause and fee pause applications for the same outlet',()=>harness(async({calls})=>{
 const detail=page('outlet',{id:'zz'});
 await detail.onShow();
 assert.equal(detail.data.error,'');
 assert.equal(detail.data.outlet.id,'zz');
 detail.action({currentTarget:{dataset:{page:'requests',type:'statusChange',status:'paused'}}});
 detail.action({currentTarget:{dataset:{page:'requests',type:'pauseFee'}}});
 const routes=calls.filter(call=>call.navigate?.startsWith('/pages/requests/index?'));
 assert.deepEqual(routes.map(call=>Object.fromEntries(new URL(call.navigate,'http://localhost').searchParams)),[
  {outlet:'zz',type:'statusChange',status:'paused'}, {outlet:'zz',type:'pauseFee'},
 ]);
}));

test('native cooperation requires consent, persists real requests and isolates separate visitors',()=>harness(async({api,storage,calls})=>{
 await api.visitor();const original=api.session();const p=page('discover',{section:'cooperation'});await p.onShow();assert.equal(typeof p.submitCooperation,'function');p.setData({form:{company:'自动化测试机构',name:'测试联系人',contact:'13800005555',message:'希望了解正式合作流程和所需资料。'}});const before=calls.filter(x=>x.method==='POST').length;await p.submitCooperation();assert.match(p.data.error,/同意/);assert.equal(calls.filter(x=>x.method==='POST').length,before);
 p.consent({detail:{value:true}});p.setData({'form.contact':'not-a-phone'});await p.submitCooperation();assert.match(p.data.error,/电话/);assert.equal(calls.filter(x=>x.method==='POST').length,before);p.setData({'form.contact':'13800005555'});await p.submitCooperation();assert.equal(p.data.error,'');assert.equal(p.data.cooperationRows.length,1);assert.equal(p.data.cooperationRows[0].status,'submitted');assert.equal(p.data.privacyConsented,false);assert.equal(p.data.form.contact,'');const id=p.data.cooperationRows[0].id;
 await api.login('ops');await api.command('cooperation.update',{id,status:'received',note:'已接收测试合作留言'});storage.set('jyyc.session',original);await p.refresh();assert.equal(p.data.cooperationRows[0].status,'received');const notifications=page('messages');await notifications.onShow();const note=notifications.data.state.messages.find(x=>x.recordId===id);assert.ok(note);await notifications.open({currentTarget:{dataset:{id:note.id}}});assert.ok(calls.some(x=>x.navigate?.startsWith('/pages/discover/index?')&&x.navigate.includes('section=cooperation')));
 await api.visitor();const other=page('discover',{section:'cooperation'});await other.onShow();assert.equal(other.data.error,'');assert.equal(other.data.cooperationRows.length,0);await assert.rejects(()=>api.detail('cooperationRequests',id),e=>e.status===404||e.status===403);
}));

test('native operational pages register real financial and account handlers',()=>{for(const [name,handlers]of [['finance',['submit','selectType']],['agreements',['more']],['tasks',['open']],['discover',['selectSection']],['security',['changePassword']]]){assert.ok(require('node:fs').existsSync(path.join(root,'pages',name,'index.js')),name+' native page exists');const p=page(name);for(const handler of handlers)assert.equal(typeof p[handler],'function');}});

test('native workspace reads only persisted task records and does not synthesize a returned report task',()=>harness(async({app,calls})=>{
 const state=app.store.load();
 state.reports.push({id:'rpt-legacy-without-task',outlet:'cs',owner:'p1',month:'2026-10',version:1,status:'returned',reviewNote:'请核对经营凭证'});
 app.store.save(state);
 const home=page('home');await home.onShow();
 assert.equal(home.data.error,'');
 assert.equal(home.data.todoTotal,0);
 assert.deepEqual(home.data.todos,[]);
 assert.ok(!calls.some(x=>x.url?.includes('/api/state')));
}));

test('V3.2 native draft, headquarters routing, read message, correction and effective report share the persisted task',()=>harness(async({api,calls,app})=>{
 const origin='http://127.0.0.1:'+app.server.address().port;
 const {randomUUID}=require('node:crypto');
 async function staff(actor){
  const response=await fetch(origin+'/api/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor})});
  assert.equal(response.status,200);
  return (await response.json()).data.token;
 }
 async function request(token,route,command,payload,expected=200){
  const headers={Authorization:'Bearer '+token};
  if(command)Object.assign(headers,{'Content-Type':'application/json','Idempotency-Key':randomUUID()});
  const http=await fetch(origin+route,command?{method:'POST',headers,body:JSON.stringify({command,payload})}:{headers});
  const body=await http.json();
  assert.equal(http.status,expected,JSON.stringify(body));
  return body.data;
 }
 const [ops,manager,finance]=await Promise.all(['ops','manager','finance'].map(staff));
 const where={outlet:'cs',month:'2026-10'};
 const initial={revenue:'100.15',orders:'21',traffic:'31',enroll:'5',note:'隔离测试的月报说明'};
 const inQueue=(queue)=>request(manager,'/api/tasks?'+api.query({...where,queue,limit:20}));
 const overview=()=>request(manager,'/api/tasks/overview');
 const review=(token,id,decision,note,expected=200)=>request(token,'/api/commands','review.report',{id,decision,note},expected);
 const submit=async(p,values)=>{await p.submit({detail:{value:values}});assert.equal(p.data.error,'');return p.data.latestSubmittedVersion;};

 const editor=page('report',where);await editor.onShow();
 editor.setData({form:{revenue:'100.15',orders:'',traffic:'',enroll:'',note:initial.note}});await editor.draft();
 assert.equal(editor.data.error,'');
 const reopened=page('report',where);await reopened.onShow();
 assert.equal(reopened.data.form.revenue,100.15);
 assert.equal(reopened.data.form.traffic,'');
 const v1=await submit(reopened,initial);
 assert.equal(v1.version,1);
 assert.equal(reopened.data.canEdit,false);
 assert.equal((await inQueue('ops')).items.some(t=>t.recordId===v1.id),true);
 await review(ops,v1.id,'approve','运营核对通过');
 await reopened.onShow();
 assert.equal(reopened.data.currentApprovedVersion.id,v1.id);

 reopened.setData({reason:'核对全部经营字段',correctionType:'full'});await reopened.correct();
 assert.equal(reopened.data.error,'');
 const v2=await submit(reopened,{...initial,orders:'22'});
 assert.equal(v2.version,2);
 assert.equal(reopened.data.currentApprovedVersion.id,v1.id);
 const before=await overview();
 await review(ops,v2.id,'return','请补充订单依据');
 const partnerQueue=await inQueue('partner');
 const todo=partnerQueue.items.find(t=>t.recordId===v2.id);
 assert.ok(todo);
 assert.equal((await overview()).items.find(x=>x.queue==='partner').total,before.items.find(x=>x.queue==='partner').total+1);
 assert.equal((await inQueue('ops')).items.some(t=>t.recordId===v2.id),false);

 const home=page('home');await home.onShow();
 assert.ok(home.data.todos.some(t=>t.id===todo.id));
 const routeCount=calls.filter(x=>x.navigate).length;
 await home.openTodo({currentTarget:{dataset:{id:'stale-task-id',index:0}}});
 assert.equal(calls.filter(x=>x.navigate).length,routeCount);
 await home.openTodo({currentTarget:{dataset:{id:todo.id}}});
 assert.ok(calls.some(x=>x.navigate==='/pages/report/index?outlet=cs&month=2026-10&id='+v2.id));
 const taskList=page('tasks');await taskList.onShow();
 assert.ok(taskList.data.state.businessTasks.some(t=>t.id===todo.id));
 const inbox=page('messages');await inbox.onShow();
 const notice=inbox.data.state.messages.find(m=>m.taskId===todo.id||m.recordId===v2.id);
 assert.ok(notice);
 await inbox.read({currentTarget:{dataset:{id:notice.id}}});
 assert.equal((await api.detail('businessTasks',todo.id)).status,'open');
 assert.ok((await inQueue('partner')).items.some(t=>t.id===todo.id));

 await reopened.onShow();
 assert.equal(reopened.data.latestSubmittedVersion.status,'returned');
 assert.equal(reopened.data.latestSubmittedVersion.review,'请补充订单依据');
 const v3=await submit(reopened,{...initial,orders:'23'});
 assert.equal(v3.version,3);
 assert.equal(reopened.data.currentApprovedVersion.id,v1.id);
 assert.equal((await inQueue('partner')).items.some(t=>t.id===todo.id),false);
 assert.equal((await api.detail('businessTasks',todo.id)).status,'resolved');
 assert.ok((await inQueue('ops')).items.some(t=>t.recordId===v3.id));
 await review(ops,v3.id,'approve','订单依据复核完成');
 await reopened.onShow();
 assert.equal(reopened.data.currentApprovedVersion.id,v3.id);

 reopened.setData({reason:'核对历史入账金额',correctionType:'field',correctionFieldIndex:0});await reopened.correct();
 const v4=await submit(reopened,{...initial,orders:'23',revenue:'120.35'});
 const opsTask=(await inQueue('ops')).items.find(t=>t.recordId===v4.id);
 assert.ok(opsTask);
 await review(ops,v4.id,'approve','运营通过，转财务复核');
 const financeTask=(await inQueue('finance')).items.find(t=>t.recordId===v4.id);
 assert.ok(financeTask);
 assert.notEqual(opsTask.id,financeTask.id);
 await reopened.onShow();
 assert.equal(reopened.data.currentApprovedVersion.id,v3.id);
 assert.equal(reopened.data.latestSubmittedVersion.status,'finance');
 await review(ops,v4.id,'approve','运营无财务权限',403);
 await review(finance,v4.id,'approve','财务复核完成');
 await reopened.onShow();
 assert.equal(reopened.data.currentApprovedVersion.id,v4.id);
 assert.equal(reopened.data.form.revenue,120.35);
 assert.equal((await inQueue('finance')).items.some(t=>t.id===financeTask.id),false);

 const other=await staff('partnerB');
 await request(other,'/api/collections/businessTasks/'+todo.id,null,null,404);
}));

test('native report list separates operations and finance review and opens an exact historical version',()=>harness(async({app,calls})=>{
 const fs=require('node:fs');
 const template=fs.readFileSync(path.join(root,'pages/reports/index.wxml'),'utf8');
 const state=app.store.load(),month='2026-10';
 const own=state.reports.find(r=>r.outlet==='cs'&&r.month==='2026-09');
 const other=state.reports.find(r=>r.outlet==='gz'&&r.month==='2026-09');
 state.reports.push(
   {...own,id:'rpt-old',month,status:'superseded',current:false},
   {...own,id:'rpt-ops',month,version:2,status:'pending',current:false},
   {...own,id:'rpt-finance',month,version:3,status:'finance',current:false},
   {...other,id:'rpt-private',month,status:'finance',current:false}
 );
 app.store.save(state);
 const list=page('reports');
 await list.changeMonth({detail:{value:month}});
 assert.equal(list.data.error,'');
 for(const [status,id,label] of [['pending','rpt-ops','总部审核中'],['finance','rpt-finance','财务复核中']]){
   await list.filter({currentTarget:{dataset:{value:status}}});
   assert.equal(list.data.pagers.reports.total,1);
   assert.deepEqual(list.data.rows.map(r=>[r.id,r.statusText]),[[id,label]]);
   assert.ok(calls.some(c=>c.url&&new URL(c.url).pathname==='/api/collections/reports'&&new URL(c.url).searchParams.get('status')===status));
   assert.match(template,new RegExp(`data-value="${status}"[^>]*>${label}<`));
 }
 await list.filter({currentTarget:{dataset:{value:'all'}}});
 const historical=list.data.rows.find(r=>r.id==='rpt-old');
 assert.ok(historical);
 assert.equal(historical.effectiveText,'暂无已通过版本');
 assert.equal(historical.submittedText,'最近提交：V3');
 assert.match(template,/data-id="\{\{item.id\}\}"[^>]*bindtap="open"/);
 list.open({currentTarget:{dataset:{outlet:historical.outlet,month:historical.month,id:historical.id}}});
 const route=calls.at(-1).navigate;
 assert.equal(route,'/pages/report/index?outlet=cs&month=2026-10&id=rpt-old');
 const record=page('report',Object.fromEntries(new URLSearchParams(route.split('?')[1])));
 await record.onShow();
 assert.equal(record.data.error,'');
 assert.equal(record.data.linkedVersion.id,'rpt-old');
 assert.equal(record.data.latestSubmittedVersion.id,'rpt-finance');
 list.open({currentTarget:{dataset:{outlet:'cs',month}}});
 assert.equal(calls.at(-1).navigate,'/pages/report/index?outlet=cs&month=2026-10');
}));

test('native home uses the service month and links to the latest valid settlement in the viewer scope',()=>harness(async({app,api,calls})=>{
 const fs=require('node:fs');
 const state=app.store.load();
 state.today='2027-03-14';
 const own=state.reports.find(r=>r.outlet==='cs'&&r.month==='2026-09');
 const other=state.reports.find(r=>r.outlet==='gz'&&r.month==='2026-09');
 function settlement(report,month,status='approved',current=true){
   const id='rpt-'+report.outlet+'-'+month;
   state.reports.push({...report,id,month,current});
   state.settlements.push({id:'set-'+id,month,status,reportIds:[id]});
 }
 settlement(other,'2026-12');
 settlement(own,'2027-01','approved',false);
 settlement(own,'2027-02','invalidated');
 settlement(own,'2027-04');
 app.store.save(state);
 const home=page('home');await home.onShow();
 assert.equal(home.data.error,'');
 assert.equal(home.data.period,'2027-03');
 assert.equal(home.data.hasCurrentSettlement,false);
 assert.equal(home.data.latestSettledMonth,'2026-09');
 assert.deepEqual(home.data.metrics,[]);
 const template=fs.readFileSync(path.join(root,'pages/home/index.wxml'),'utf8');
 assert.match(template,/本月数据尚未结算/);
 assert.match(template,/wx:if="\{\{latestSettledMonth\}\}"[^>]*bindtap="openSettled"/);
 home.openSettled();
 assert.equal(calls.at(-1).navigate,'/pages/dashboard/index?period=2026-09');
 const dashboard=page('dashboard',{period:'2026-09'});await dashboard.onShow();
 assert.equal(dashboard.data.error,'');
 assert.equal(dashboard.data.period,'2026-09');
 assert.ok(dashboard.data.metrics.some(m=>m.value!=='—'));
 const current=await api.request('/api/dashboard?period=2026-09&includeSettlementMonths=true');
 assert.deepEqual(current.settlementMonths,{hasCurrent:true,latestPriorMonth:'2026-08'});
 const all=await api.request('/api/dashboard?period=2027-03&includeSettlementMonths=true');
 const single=await api.request('/api/dashboard?period=2027-03&outlet=zz&includeSettlementMonths=true');
 assert.deepEqual(all.settlementMonths,single.settlementMonths);
 await assert.rejects(()=>api.request('/api/dashboard?period=2027-03&owner=p2&includeSettlementMonths=true'),{status:403});
 const base=await api.request('/api/dashboard?period=2027-03');
 assert.ok(!Object.hasOwn(base,'settlementMonths'));
 await api.login('partnerB');await home.onShow();
 assert.equal(home.data.latestSettledMonth,'2026-12');
 state.settlements.forEach(s=>{s.status='invalidated';});app.store.save(state);
 await home.onShow();
 assert.equal(home.data.latestSettledMonth,'');
 const before=calls.length;home.openSettled();assert.equal(calls.length,before);
 await api.visitor();await home.onShow();
 assert.equal(home.data.isPublic,true);
 assert.equal(home.data.latestSettledMonth,'');
}));

test('native affiliate finance switches from all authorized outlets to a scoped bill ledger',()=>harness(async({app,calls})=>{
 const state=app.store.load(),bill=state.bills.find(row=>row.outlet==='cs');
 bill.status='paid';
 state.receipts.push({id:'native-finance-receipt',billId:bill.id,outlet:bill.outlet,owner:bill.owner,status:'success',amount:bill.amount,adapterMode:'manual'});
 state.refundRequests.push({id:'native-finance-refund',billId:bill.id,receiptId:'native-finance-receipt',outlet:bill.outlet,owner:bill.owner,status:'recorded',amount:5,reference:'LOCAL-REFUND'});
 app.store.transaction(()=>app.store.save(state));
 const p=page('finance');
 await p.onShow();
 assert.equal(p.data.error,'');
 assert.equal(p.data.ledgerOverview.outlets.total,3);
 assert.equal(p.data.ledgerOverview.totals.refundedCents,500);
 await p.chooseLedgerOutlet({currentTarget:{dataset:{outlet:'cs'}}});
 assert.equal(p.data.error,'');
 assert.equal(p.data.ledgerOverview.outlets.total,1);
 assert.equal(p.data.ledgerOverview.totals.receivableCents,198000);
 assert.equal(p.data.bills.length,1);
 await p.chooseLedgerBill({currentTarget:{dataset:{id:bill.id}}});
 assert.equal(p.data.ledgerBill.id,bill.id);
 assert.equal(p.data.ledgerBill.metrics.find(x=>x.key==='netReceivedCents').value,'¥ 1,975.00');
 await p.ledgerSection({currentTarget:{dataset:{section:'refundRequests'}}});
 assert.equal(p.data.ledgerBill.records[0].reference,'LOCAL-REFUND');
 assert.equal(p.data.ledgerBill.records[0].status,'已退款');
 const fees=page('fees',{outlet:bill.outlet,month:bill.month,id:bill.id});
 await fees.onShow();
 const feeBill=fees.data.bills.find(row=>row.id===bill.id);
 assert.deepEqual([feeBill.payableText,feeBill.paidText,feeBill.unpaidText],['1,980.00','1,980.00','0.00']);
 assert.equal(fees.data.outlets[fees.data.outletIndex].id,bill.outlet);
 assert.ok(calls.some(record=>record.url?.includes('/api/finance/summary?outlet=cs')));
}));


test('native monthly list keeps effective and latest numbers independent of displayed history page size',()=>harness(async({app})=>{
 const state=app.store.load(),month='2026-10';
 const original=state.reports.find(row=>row.outlet==='cs'&&row.month==='2026-09');
 for(let version=1;version<=205;version++){
  state.reports.push({...original,month,version,id:'rpt-version-bound-'+version,current:version===1,
   status:version===1?'approved':version===205?'finance':'returned',revoked:false});
 }
 app.store.save(state);
 const list=page('reports');
 await list.changeMonth({detail:{value:month}});
 assert.equal(list.data.error,'');
 assert.equal(list.data.pagers.reports.total,205);
 assert.ok(list.data.rows.length>0);
 assert.ok(list.data.rows.every(row=>row.effectiveText==='当前有效版本：V1'));
 assert.ok(list.data.rows.every(row=>row.submittedText==='最近提交：V205'));
 await list.filter({currentTarget:{dataset:{value:'finance'}}});
 assert.equal(list.data.rows.length,1);
 assert.equal(list.data.rows[0].effectiveText,'当前有效版本：V1');
 assert.equal(list.data.rows[0].statusText,'财务复核中');
}));

async function seedReceiptsForFinance(app, api, storage) {
 const partnerSession=api.session();
 await api.login('manager');
 const plan=(await api.command('plan.publish',{name:'凭证复验样例',amount:120,serviceEntity:'隔离服务',collectionEntity:'隔离收款',invoiceEntity:'隔离开票',terms:'隔离测试服务',reason:'凭证状态复验'})).result;
 const agreement=(await api.command('agreement.create',{outlet:'cs',planId:plan.id,startMonth:'2026-06',endMonth:'2026-08',billDay:1,dueDay:5,reference:'NATIVE-RECEIPT-STATE',reason:'凭证状态复验'})).result;
 const bills=[];
 for(const month of ['2026-06','2026-07','2026-08'])bills.push((await api.command('billing.generate',{agreementId:agreement.id,month})).result);
 const receipts=bills.map((bill,index)=>({id:'receipt-status-'+index,billId:bill.id,outlet:bill.outlet,owner:bill.owner,status:['failed','pending','success'][index],amount:bill.amount,month:bill.month,adapterMode:'manual'}));
 const state=app.store.load();
 state.receipts.push(...receipts);
 app.store.save(state);
 storage.set('jyyc.session',partnerSession);
 return receipts;
}

test('only confirmed receipts qualify for an invoice or a refund and a valid receipt still works',()=>harness(async({app,api,storage})=>{
 const [failed,pending,confirmed]=await seedReceiptsForFinance(app,api,storage);
 const commands=[
  ['refund.request',{amount:50,reason:'凭证状态复验退款'}],
  ['invoice.request',{amount:50,reason:'凭证状态复验开票',title:'隔离开票',taxId:'TEST-TAX-ID'}],
 ];
 for(const receipt of [failed,pending]){
  for(const [command,values] of commands){
   await assert.rejects(()=>api.command(command,{...values,receiptId:receipt.id}),error=>error.status===409&&/已核验的实收凭证/.test(error.message));
  }
 }
 const valid=await api.command('invoice.request',{...commands[1][1],receiptId:confirmed.id});
 assert.equal(valid.result.status,'pending');
 assert.equal(valid.result.receiptId,confirmed.id);
 const state=app.store.load();
 assert.ok(!state.refundRequests.some(item=>[failed.id,pending.id].includes(item.receiptId)));
 assert.ok(!state.invoiceRequests.some(item=>[failed.id,pending.id].includes(item.receiptId)));
}));

test('finance cannot finalize old unverified records and can still return or cancel them',()=>harness(async({app,api,storage})=>{
 const [failed]=await seedReceiptsForFinance(app,api,storage);
 const state=app.store.load();
 const bad={owner:failed.owner,outlet:failed.outlet,billId:failed.billId,receiptId:failed.id,amount:5,initiator:'partnerA',trail:[]};
 state.refundRequests.push({id:'refund-status-pending',status:'pending',...bad},{id:'refund-status-approved',status:'approved',...bad});
 state.invoiceRequests.push({id:'invoice-status-pending',status:'pending',...bad});
 app.store.save(state);
 await api.login('finance');
 const cases=[
  ['refund.review',{id:'refund-status-pending',decision:'approve',note:'旧记录核验'}],
  ['refund.record',{id:'refund-status-approved',reference:'ISOLATED-STATE-CHECK',refundedOn:'2026-10-05',note:'旧记录核验'}],
  ['invoice.update',{id:'invoice-status-pending',status:'issued',number:'ISOLATED-STATE-INVOICE',issuedOn:'2026-10-05',note:'旧记录核验'}]
 ];
 for(const [command,values] of cases){
  await assert.rejects(()=>api.command(command,values),error=>error.status===409&&/已核验的实收凭证/.test(error.message));
 }
 assert.equal((await api.command('refund.review',{id:'refund-status-pending',decision:'return',note:'原凭证未核验'})).result.status,'returned');
 assert.equal((await api.command('invoice.update',{id:'invoice-status-pending',status:'cancelled',note:'原凭证未核验'})).result.status,'cancelled');
 assert.equal(app.store.load().refundRequests.find(item=>item.id==='refund-status-approved').status,'approved');
}));

test('a native finance link to an unconfirmed receipt shows no selected receipt and cannot submit on another',()=>harness(async({app,api,storage})=>{
 const [failed,pending,confirmed]=await seedReceiptsForFinance(app,api,storage);
 const p=page('finance',{type:'refund',receiptId:failed.id});
 await p.onShow();
 assert.ok(p.data.receipts.some(item=>item.id===confirmed.id));
 assert.ok(!p.data.receipts.some(item=>[failed.id,pending.id].includes(item.id)));
 assert.equal(p.data.receiptIndex,-1);
 p.setData({'form.amount':'5','form.reason':'核对指定付款'});
 await p.submit();
 assert.match(p.data.error,/请选择已核验的原付款记录/);
 assert.equal(p.data.state.refundRequests.length,0);
}));

test('visitor entry opens the public home with only published organization, services and news',()=>harness(async({api,storage,calls,downloads})=>{
 await api.login('manager');
 const manager=api.session();
 const file=async color=>{
  const bytes=await require('sharp')({create:{width:3,height:3,channels:3,background:color}}).png().toBuffer();
  return (await api.request('/api/files','POST',{name:'隔离发布封面.png',type:'image/png',base64:bytes.toString('base64')})).id;
 };
 const initial=await file('#1677d2'),updated=await file('#174a80');
 const publish=(key,title,imageId,published)=>api.command('content.update',{key,title,text:title+'正文',imageId,published,reason:'隔离发布验收'});
 const change=(action,expectedVersion,sourceVersion)=>api.command('content.publication',{key:'brand',action,expectedVersion,sourceVersion,reason:'隔离版本验收'});
 const first=(await publish('brand','隔离集团介绍',initial,true)).result;
 await publish('brand','隔离未发布介绍',updated,false);
 await publish('news','隔离已发布动态',null,true);
 await publish('cases','隔离未发布案例',null,false);
 for(let slot=1;slot<=5;slot++)await api.command('content.service.save',{
  slot,title:'隔离业务'+slot,summary:'独立样例摘要'+slot,body:'独立样例正文'+slot,imageId:slot===1?initial:null,published:true,reason:'隔离业务验收'
 });
 const login=page('login');
 const destinations=[];
 wx.reLaunch=options=>{destinations.push(options.url);options.success?.();};
 await login.visitor();
 assert.deepEqual(destinations,['/pages/home/index']);
 const visitor=api.session();
 calls.length=0;
 const home=page('home');await home.onShow();
 assert.equal(home.data.error,'');
 assert.equal(home.data.groupIntro.title,'隔离集团介绍');
 assert.equal(home.data.groupIntro.imageId,initial);
 assert.ok(home.data.groupIntro.coverPath);
 assert.deepEqual(home.data.publishedServices.map(x=>x.title),['隔离业务1','隔离业务2','隔离业务3','隔离业务4','隔离业务5']);
 assert.deepEqual(home.data.publicUpdates.map(x=>x.title),['隔离已发布动态']);
 assert.ok(!calls.some(x=>/collections\/(?:outlets|accounts)|\/api\/dashboard/.test(x.url||'')));
 assert.doesNotMatch(JSON.stringify(home.data),/隔离未发布/);
 const catalog=page('discover',{section:'services'});await catalog.onShow();
 for(const [index,record] of home.data.publishedServices.entries()){
  home.openService({currentTarget:{dataset:{id:record.id}}});
  assert.equal(calls.at(-1).navigate,'/pages/service-detail/index?id='+record.id);
  const detail=page('service-detail',{id:record.id});await detail.onShow();
  assert.equal(detail.data.error,'');
  assert.equal(detail.data.service.body,'独立样例正文'+(index+1));
  await catalog.onShow();
  assert.equal(catalog.data.section,'services');
 }
 const routes=[];
 wx.switchTab=options=>{routes.push(options.url);options.success?.();};
 home.nav({currentTarget:{dataset:{page:'outlets',query:'scope=public&mode=map'}}});
 assert.deepEqual(routes,['/pages/outlets/index']);
 assert.deepEqual(storage.get('jyyc.route.outlets'),{scope:'public',mode:'map'});
 const group=page('discover',{section:'brand'});await group.onShow();
 assert.equal(group.data.articles[0].body,'隔离集团介绍正文');
 assert.ok(group.data.articles[0].coverPath);
 assert.ok(downloads.some(x=>x.url.endsWith(initial)&&x.status===200));
 storage.set('jyyc.session',manager);
 const revised=(await publish('brand','隔离集团介绍更新',updated,true)).result;
 storage.set('jyyc.session',visitor);
 await home.onShow();await group.onShow();
 assert.equal(home.data.groupIntro.title,'隔离集团介绍更新');
 assert.equal(group.data.articles[0].imageId,updated);
 storage.set('jyyc.session',manager);
 const withdrawn=(await change('withdraw',revised.version)).result;
 storage.set('jyyc.session',visitor);
 await home.onShow();await group.onShow();
 assert.equal(home.data.groupIntro,null);
 assert.equal(group.data.articles.length,0);
 await assert.rejects(()=>api.download('/api/files/'+updated));
 storage.set('jyyc.session',manager);
 const restored=(await change('restore',withdrawn.version,first.version)).result;
 storage.set('jyyc.session',visitor);
 await home.onShow();await group.onShow();
 assert.equal(home.data.groupIntro.title,'隔离集团介绍');
 assert.equal(group.data.articles[0].version,restored.version);
 assert.ok(group.data.articles[0].coverPath);
}));
