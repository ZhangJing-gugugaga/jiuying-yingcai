const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readWxml } = require('../scripts/wechat-validate.cjs');
const { getNativeRoutes } = require('../scripts/wechat-routes.cjs');
const root = path.resolve(__dirname, '../miniprogram');

test('native pages exist, event handlers resolve, and no WebView substitutes native UI', () => {
  assert.ok(fs.existsSync(path.join(root, 'app.json')), 'native app.json must exist');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
  const { routes } = getNativeRoutes(app);
  assert.deepEqual(app.requiredPrivateInfos.sort(), ['chooseLocation', 'getLocation'].sort());
  const registeredWxml = new Set(routes.map(page => path.join(root, page + '.wxml')));
  for (const page of routes) {
    for (const suffix of ['.js','.json','.wxml','.wxss']) assert.ok(fs.existsSync(path.join(root,page+suffix)),page+suffix);
    const code = fs.readFileSync(path.join(root,page+'.js'),'utf8');
    new vm.Script(code, {filename:page});
    const xml=readWxml(path.join(root,page+'.wxml'),registeredWxml);
    assert.doesNotMatch(xml, /<web-view|<iframe|<script/i);
    for(const [,expression]of xml.matchAll(/wx:(?:if|elif|for)="([^"]*)"/g)) assert.ok(expression.startsWith('{{')&&expression.endsWith('}}'),page+' directive must use WXML expression binding: '+expression);
    let definition;
    const sandbox={Page:d=>definition=d,require:p=>require(path.resolve(root,path.dirname(page),p)),wx:global.wx,console};
    vm.runInNewContext(code,sandbox);
    assert.ok(definition, page+' registers Page');
    for(const [,handler] of xml.matchAll(/(?:bind|catch)(?::)?[\w-]+="([A-Za-z_]\w*)"/g)) assert.equal(typeof definition[handler],'function',page+': '+handler);
    const stack=[];
    for(const tag of xml.matchAll(/<\/?([a-z][\w-]*)(?:\s[^>]*?)?\s*\/?>/gi)){
      assert.ok(['view','text','label','button','input','textarea','form','block','picker','switch','map','image','scroll-view'].includes(tag[1]),page+' uses native component '+tag[1]);
      if(tag[0].startsWith('</')) assert.equal(stack.pop(),tag[1],page+' balanced native markup');
      else if(!tag[0].endsWith('/>')) stack.push(tag[1]);
    }
    assert.equal(stack.length,0,page+' unclosed tags');
    JSON.parse(fs.readFileSync(path.join(root,page+'.json')));
  }
});

test('financial inputs reject blank values and preserve not applicable enrollment',()=>{
  assert.ok(fs.existsSync(path.join(root,'utils/format.js')),'shared validation exists');
  const f=require('../miniprogram/utils/format');
  assert.throws(()=>f.reportInput({revenue:'',orders:'1',traffic:'2',enroll:'3'},true));
  assert.throws(()=>f.reportInput({revenue:'1.001',orders:'1',traffic:'2',enroll:'3'},true));
  assert.throws(()=>f.reportInput({revenue:'1',orders:'1.5',traffic:'2',enroll:'3'},true));
  assert.equal(f.reportInput({revenue:'0',orders:'0',traffic:'0',enroll:''},false).enroll,null);
  assert.equal(f.money(null),'—');
  assert.equal(f.change(null,100),'不可比');
  assert.equal(f.change(100,0),'不可比');
  assert.equal(f.change(100,90,true),'不可比');
  assert.equal(f.change(120,100),'+20.0%');
});

test('API sends bearer and reuses idempotency key after transport failure',async()=>{
  assert.ok(fs.existsSync(path.join(root,'utils/api.js')),'real API client exists');
  const calls=[];let fail=true;
  global.wx={getStorageSync:k=>k==='jyyc.session'?{token:'test-token'}:null,request:o=>{calls.push(o);if(fail)o.fail({errMsg:'offline'});else o.success({statusCode:200,data:{data:{result:{id:'x'},state:{outlets:[]}}}})},removeStorageSync(){},setStorageSync(){}};
  const api=require('../miniprogram/utils/api');
  await assert.rejects(()=>api.command('report.submit',{outlet:'cs',month:'2026-10'}));
  fail=false;
  await api.command('report.submit',{outlet:'cs',month:'2026-10'});
  assert.equal(calls[0].header.Authorization,'Bearer test-token');
  assert.equal(calls[0].header['Idempotency-Key'],calls[1].header['Idempotency-Key']);
  assert.equal(calls[1].data.command,'report.submit');
  assert.ok(calls[1].timeout>0);
});

function nativePage(name,query={}){
  let definition;global.Page=d=>{definition=d;};
  const filename=path.join(root,'pages',name,'index.js');delete require.cache[require.resolve(filename)];require(filename);
  const p={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(values){for(const [key,value]of Object.entries(values)){const keys=key.split('.');let target=this.data;for(const k of keys.slice(0,-1))target=target[k]||(target[k]={});target[keys.at(-1)]=value;}}};
  p.onLoad?.(query);return p;
}

test('native page handlers use real HTTP + SQLite for report review, payment, photo location and support',async()=>{
  const {createServer}=require('../server/index.cjs');
  const instance=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(r=>instance.server.listen(0,'127.0.0.1',r));
  const config=require('../miniprogram/config');const priorBase=config.apiBase;config.apiBase='http://127.0.0.1:'+instance.server.address().port;
  const storage=new Map();const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=';
  global.wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast(){},showModal(o){o.success({confirm:true});},reLaunch(){},switchTab(){},navigateTo(){},stopPullDownRefresh(){},pageScrollTo(){},
    chooseMedia:o=>o.success({tempFiles:[{tempFilePath:'/photo.png',size:68}]}),getFileSystemManager:()=>({readFile:o=>o.success({data:png})}),getLocation:o=>o.success({latitude:28.2,longitude:113.1,accuracy:12}),
    request:async o=>{try{const res=await fetch(o.url,{method:o.method,headers:o.header,...(o.method==='GET'?{}:{body:JSON.stringify(o.data)})});o.success({statusCode:res.status,data:await res.json()});}catch(e){o.fail({errMsg:e.message});}}};
  const api=require('../miniprogram/utils/api');
  async function staff(actor,command,payload){const old=api.session();await api.login(actor);const r=await api.command(command,payload);storage.set('jyyc.session',old);return r;}
  try{
    await api.login('partnerA');
    const form=nativePage('report',{outlet:'zz',month:'2026-10'});await form.onShow();
    assert.equal(form.data.applicable,false);
    await form.submit({detail:{value:{revenue:'123.45',orders:'2',traffic:'4',note:'初次报送'}}});await form.confirmSubmit();assert.equal(form.data.error,'');
    let report=form.data.state.reports.find(x=>x.outlet==='zz'&&x.month==='2026-10');assert.equal(report.enroll,null);
    await staff('ops','review.report',{id:report.id,decision:'return',note:'请核实收入'});await form.refresh();
    assert.equal(form.data.current.status,'returned');assert.equal(form.data.current.review,'请核实收入');
    await form.submit({detail:{value:{revenue:'125.45',orders:'2',traffic:'4',note:'已核实'}}});await form.confirmSubmit();assert.equal(form.data.error,'');
    report=form.data.state.reports.find(x=>x.outlet==='zz'&&x.month==='2026-10'&&x.version===2);assert.ok(report);
    await staff('ops','review.report',{id:report.id,decision:'approve'});await staff('manager','settle',{month:'2026-10'});
    const fees=nativePage('fees');await fees.onShow();const bill=fees.data.bills[0];await fees.pay({currentTarget:{dataset:{id:bill.id}}});assert.ok(fees.data.payment?.id);
    await fees.resolve({currentTarget:{dataset:{outcome:'success'}}});assert.equal(fees.data.error,'');assert.equal(fees.data.state.bills.find(x=>x.id===bill.id).status,'paid');assert.equal(fees.data.state.receipts.length,1);
    const location=nativePage('location',{outlet:'zz'});await location.onShow();await location.locate({currentTarget:{dataset:{manual:'false'}}});await location.photo();await location.submit();assert.equal(location.data.error,'');
    const verification=location.data.state.verifications.find(x=>x.outlet==='zz');assert.equal(verification.coords.source,'gps');assert.ok(verification.photo.id.startsWith('file-'));
    await staff('location','location.review',{id:verification.id,decision:'approve'});await location.refresh();assert.equal(location.data.history[0].status,'approved');
    const support=nativePage('support');await support.onShow();support.setData({text:'月报怎样填写'});await support.send();assert.equal(support.data.tickets.length,0);assert.ok(support.data.chat.id);await support.human();assert.equal(support.data.chat.human,true);
    await support.prepareTicket();await support.outlet({detail:{value:String(support.data.outlets.findIndex(row=>row.id==='cs'))}});
    support.setData({'form.title':'账单问题','form.description':'需要核查本月账单',categoryIndex:2});await support.create();assert.equal(support.data.error,'');assert.equal(support.data.tickets.length,1);
    const ticket=support.data.tickets[0];await staff('support','support.claim',{id:ticket.id});await staff('support','support.close',{id:ticket.id,note:'已说明'});support.setData({ticket});await support.refresh();await support.rate();assert.equal(support.data.ticket.rating.score,5);
    const dash=nativePage('dashboard');await dash.onShow();dash.setData({period:'2026-10'});await dash.loadDashboard();assert.equal(dash.data.metrics[0].value,'125.45');
    const requests=nativePage('requests',{type:'pauseFee',outlet:'zz'});await requests.onShow();requests.setData({'form.from':'2026-12-01','form.to':'2026-12-31','form.reason':'装修申请'});await requests.submit();assert.equal(requests.data.error,'');
    const request=requests.data.state.requests.find(r=>r.type==='pauseFee'&&r.outlet==='zz');assert.ok(request);await staff('finance','review.request',{id:request.id,decision:'supplement',note:'请补充恢复日期说明'});await requests.refresh();requests.supplement({currentTarget:{dataset:{id:request.id}}});requests.setData({'form.reason':'装修结束后恢复营业'});await requests.submit();assert.equal(requests.data.error,'');assert.equal(requests.data.state.requests.find(r=>r.id===request.id).status,'pending');
    await api.login('partnerB');const other=nativePage('reports');await other.onShow();assert.ok(other.data.state.reports.every(r=>r.owner==='p2'));
    const created=await staff('manager','account.create',{name:'原生新加盟商',managerName:'新负责人',mobile:'13900008888'});const actor=created.result.actor;assert.ok(actor.startsWith('partner:'));const login=nativePage('login');login.setData({customActor:actor});await login.enter();assert.equal(login.data.error,'');assert.equal(api.session().actor,actor);const home=nativePage('home');await home.onShow();assert.equal(home.data.isPublic,false);assert.equal(home.data.state.outlets.length,0);
  }finally{config.apiBase=priorBase;await new Promise(r=>instance.server.close(r));instance.store.close();}
});
