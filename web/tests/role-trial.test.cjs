'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('../server/index.cjs');

async function response(base, route, { token, body, status = 200 } = {}) {
  const result = await fetch(base + '/api' + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await result.json();
  assert.equal(result.status, status, data.error?.message);
  return data.data;
}

test('three trial identities use one persisted set of records and the real role permissions', async t => {
  const launcher = path.resolve(__dirname, '../scripts/role-trial.cjs');
  assert.ok(fs.existsSync(launcher), '缺少隔离三角色试用入口');
  const { startRoleTrial } = require(launcher);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuying-role-trial-test-'));
  let trial = await startRoleTrial({ directory, port: 0 });
  t.after(async () => { await trial.stop(); });
  const config = await response(trial.url, '/config');
  assert.equal(config.roleTrial.profiles.find(row=>row.actor==='partnerA').surface,'miniprogram');
  assert.match(config.roleTrial.onboarding.id,/^join-/);
  assert.equal(config.roleTrial.onboarding.subject,undefined);
  assert.deepEqual(config.roleTrial.profiles.map(row => [row.actor, row.role]),
    [['trial-director','manager'],['trial-operator','ops'],['partnerA','partner']]);
  const login = async actor => (await response(trial.url, '/auth/dev', {body:{actor}}));
  const [director, operator, partner] = await Promise.all(config.roleTrial.profiles.map(row=>login(row.actor)));
  assert.deepEqual([director.subject,operator.subject,partner.subject],['trial-director','trial-operator','partnerA']);
  const reportId = config.roleTrial.report.id;
  const get = (route, token) => response(trial.url,route,{token});
  const command = (command,payload,token,status) => response(trial.url,'/commands',{token,body:{command,payload},status});
  const partnerStores = await get('/collections/outlets',partner.token);
  assert.deepEqual(partnerStores.items.map(row=>row.id).sort(),['cs','hy','zz']);
  await response(trial.url,'/collections/outlets/gz',{token:partner.token,status:404});
  assert.deepEqual((await get('/collections/staffAccounts',partner.token)).items,[]);
  const personnel = await get('/collections/staffAccounts',director.token);
  assert.ok(personnel.items.some(row=>row.id===operator.subject));
  await command('staff.create',{subject:'trial-unauthorized',name:'越权样例',role:'ops',reason:'验证不可创建岗位'},operator.token,403);
  const reviewQueue = await get('/tasks?queue=ops&kind=report_review',operator.token);
  assert.ok(reviewQueue.items.some(row=>row.businessId===reportId&&row.assigneeUserId===operator.subject));
  await command('review.report',{id:reportId,decision:'return',note:'隔离样例补充说明'},partner.token,403);
  await command('review.report',{id:reportId,decision:'return',note:'隔离样例补充说明'},operator.token,200);
  const returned = await get('/collections/reports/'+reportId,partner.token);
  assert.equal(returned.status,'returned');
  const approved = await command('report.submit',{outlet:returned.outlet,month:returned.month,revenue:returned.revenue,
    orders:returned.orders,traffic:returned.traffic+1,enroll:returned.enroll,note:'加盟商已按试用意见补充'},partner.token,200);
  assert.equal(approved.result.version,2);

  await trial.stop();
  trial = await startRoleTrial({ directory, port: 0 });
  assert.equal((await response(trial.url,'/config')).roleTrial.report.id,reportId);
  const renewed = await login('trial-director');
  const report = await get('/collections/reports/'+approved.result.id,renewed.token);
  assert.equal(report.status,'pending');
});

test('regular development configuration omits the role trial', async t => {
  const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.close();
  });
  const base='http://127.0.0.1:'+app.server.address().port;
  const config=await response(base,'/config');
  assert.equal(config.roleTrial,undefined);
  assert.equal(config.devLoginEnabled,true);
  await response(base,'/role-trial/applicant',{body:{},status:401});
});

test('prototype preview builds an isolated package with published content and scoped rework samples', async t => {
  const { startPrototypePreview } = require('../scripts/prototype-preview.cjs');
  const trial = await startPrototypePreview({ port: 0, appId: 'touristappid' });
  t.after(async () => {
    await trial.stop();
    const dist = path.resolve(__dirname, '../dist');
    assert.equal(path.dirname(trial.project), dist);
    assert.match(path.basename(trial.project), /^ui-prototype-preview-/);
    assert.equal(fs.existsSync(trial.project), false);
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(trial.project, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.apiBase, trial.url);
  assert.equal(manifest.checks.pages, 22);
  assert.equal(trial.app.server.address().address, '127.0.0.1');
  const get = (route, token) => response(trial.url, route, { token });
  const visitor = await response(trial.url, '/auth/visitor', { body: {} });
  const published = (await get('/collections/publicContents', visitor.token)).items;
  assert.equal(published.filter(row => /^service-/.test(row.key) && row.summary).length, 5);
  assert.ok(published.find(row => row.key === 'brand')?.imageId);
  for (const [geo, city] of [['mainland', '长沙'], ['overseas', '新加坡']]) {
    const { items } = await get('/collections/outlets?scope=public&geo=' + geo, visitor.token);
    assert.ok(items.some(row => row.city === city && row.publicCoords));
    assert.ok(items.every(row => !row.summary));
  }
  const login = actor => response(trial.url, '/auth/dev', { body: { actor } });
  const partner = await login('partnerA');
  const other = await login('partnerB');
  const tasks = (await get('/tasks?queue=partner&outlet=cs', partner.token)).items;
  assert.ok(tasks.some(row => row.kind === 'report_returned'));
  assert.ok(tasks.some(row => row.kind === 'training_material_returned'));
  const scoped = (await get('/collections/outlets?includeSummary=true', partner.token)).items.find(row => row.id === 'cs');
  assert.ok(scoped.summary.report.returnedVersionId);
  await response(trial.url, '/collections/outlets/cs', { token: other.token, status: 404 });
});

test('trial payment proof is returned and supplemented by the same private applicant', async t => {
  const {startRoleTrial}=require('../scripts/role-trial.cjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'jiuying-role-trial-onboarding-'));
  const trial=await startRoleTrial({directory,port:0});
  t.after(()=>trial.stop());
  const get=(route,token)=>response(trial.url,route,{token});
  const login=actor=>response(trial.url,'/auth/dev',{body:{actor}});
  const config=await get('/config');
  const id=config.roleTrial.onboarding.id;
  const manager=await login('trial-director');
  const operator=await login('trial-operator');
  const applicant=await response(trial.url,'/role-trial/applicant',{body:{}});
  const record=(await get('/onboarding/applications?id='+id,applicant.token)).items[0];
  assert.equal(record.status,'pending');
  assert.equal(record.version,1);
  const review=(token,body,status=200)=>response(trial.url,'/onboarding/applications/'+id+'/review',{token,body,status});
  const returned={decision:'return',version:1,note:'请补充完整的付款时间'};
  await review(operator.token,returned,403);
  await review(manager.token,returned);
  const renewed=await response(trial.url,'/role-trial/applicant',{body:{}});
  assert.equal(renewed.subject,applicant.subject);
  assert.ok((await get('/collections/messages?status=unread',renewed.token)).items.some(item=>item.recordId===id&&item.target==='join'));
  const picture=await fetch(trial.url+'/api/role-trial/proof',{headers:{Authorization:'Bearer '+renewed.token}});
  assert.equal(picture.status,200);
  assert.equal(picture.headers.get('content-type'),'image/png');
  const uploaded=await response(trial.url,'/files',{token:renewed.token,status:201,body:{name:'试用补交.png',type:'image/png',
    purpose:'onboarding-proof',applicationId:id,applicationVersion:1,base64:Buffer.from(await picture.arrayBuffer()).toString('base64')}});
  const {name,mobile,organization}=record;
  const supplemented=await response(trial.url,'/onboarding/applications',{token:renewed.token,body:{id,version:1,name,mobile,organization,fileId:uploaded.id}});
  assert.equal(supplemented.version,2);
  assert.equal((await review(manager.token,{decision:'approve',version:2,settlementReference:'TRIAL-ONLY-20261121'})).status,'approved');
  const notices=await get('/collections/messages?status=unread',renewed.token);
  assert.ok(notices.items.some(item=>item.recordId===id&&item.title==='加盟申请已通过'));
  assert.equal(trial.app.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count,0);
});

test('two named operators and two franchisees keep assignment, handover and export scopes separate', async t => {
  const {startRoleTrial}=require('../scripts/role-trial.cjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'jiuying-role-trial-assignment-'));
  const trial=await startRoleTrial({directory,port:0});
  t.after(()=>trial.stop());
  const send=(route,options)=>response(trial.url,route,options);
  const login=async actor=>(await send('/auth/dev',{body:{actor}})).token;
  const [manager,first,partnerA,partnerB]=await Promise.all(['trial-director','trial-operator','partnerA','partnerB'].map(login));
  const command=async (token,command,payload,status)=>
    (await send('/commands',{token,body:{command,payload},status}))?.result;
  const roster='/collections/staffAccounts';
  const peer='trial-ops-peer';
  await command(manager,'staff.create',{subject:peer,name:'隔离试用一级管理员乙',role:'ops',reason:'核对两个同岗人员的分派边界'});
  const invite=await send('/auth/activation',{token:manager,body:{actor:peer,username:peer}});
  const {token:second}=await send('/auth/activate',{body:{token:invite.token,password:randomUUID()+'-Local!'}});
  await command(manager,'routing.set',{outlet:'gz',kind:'report_review',assigneeRole:'ops',assigneeUserId:peer,enabled:true,reason:'广州网点交给第二个一级管理员'});
  const other=await command(partnerB,'report.submit',{outlet:'gz',month:'2026-10',revenue:200,orders:5,traffic:12,enroll:1});
  const primary=(await send('/config')).roleTrial.report;
  const queue='/tasks?queue=ops&kind=report_review';
  const firstQueue=await send(queue,{token:first});
  const secondQueue=await send(queue,{token:second});
  const assigned=firstQueue.items.find(row=>row.businessId===primary.id);
  assert.equal(assigned.assigneeUserId,'trial-operator');
  assert.ok(secondQueue.items.some(row=>row.businessId===other.id&&row.assigneeUserId===peer));
  assert.ok(!firstQueue.items.some(row=>row.businessId===other.id));
  await send('/tasks/'+assigned.id,{token:second,status:404});
  await send('/collections/reports/'+primary.id,{token:partnerB,status:404});
  await send('/collections/reports/'+other.id,{token:partnerA,status:404});
  await command(second,'review.report',{id:primary.id,decision:'approve'},403);
  await command(first,'review.report',{id:other.id,decision:'approve'},403);
  const grant={subject:peer,outlet:'gz',category:'reports',fields:['orders'],enabled:true};
  const grants='/approval-exports/grants';
  await send(grants,{token:first,body:grant,status:403});
  await send(grants,{token:manager,body:grant});
  const csv=trial.url+'/api/approval-exports/csv?category=reports&status=pending&month=2026-10&outlet=';
  const exportAs=(token,outlet,fields='orders')=>fetch(csv+outlet+'&fields='+fields,{headers:{Authorization:'Bearer '+token}});
  assert.equal((await exportAs(first,'gz')).status,403);
  assert.equal((await exportAs(second,'zz')).status,403);
  assert.equal((await exportAs(second,'gz','orders,revenue')).status,403);
  const exported=await exportAs(second,'gz');
  assert.equal(exported.status,200);
  assert.equal((await exported.text()).trim(),'"有效订单"\r\n"5"');
  const members=await send(roster,{token:manager});
  assert.ok(members.items.some(row=>row.id===peer));
  await command(manager,'task.assign',{id:assigned.id,assigneeRole:'ops',assigneeUserId:peer,note:'交接株洲月报给二号负责人'});
  await command(first,'review.report',{id:primary.id,decision:'approve'},403);
  assert.equal((await send('/tasks/'+assigned.id,{token:second})).assigneeUserId,peer);
  const result=await command(second,'review.report',{id:primary.id,decision:'approve'});
  assert.equal(result.status,'approved');
  const finished=await send('/tasks/'+assigned.id,{token:manager});
  assert.equal(finished.status,'resolved');
  assert.ok(finished.transferHistory.some(event=>event.to?.userId===peer));
});
