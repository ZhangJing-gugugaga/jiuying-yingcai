'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');

test('onboarding separates private screenshots, booked-payment review, account activation and notification', async t => {
  const app = createServer({ dbPath: ':memory:', env: {NODE_ENV:'test', ADAPTER_MODE:'mock'} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const png = await sharp({create:{width:48,height:48,channels:3,background:'#dbeeff'}}).png().toBuffer();
  const proof = await sharp({create:{width:48,height:48,channels:3,background:'#cee2fa'}}).png().toBuffer();
  async function send(path, status, token, payload, key = randomUUID()) {
    const response = await fetch(base + '/api' + path, {
      method: payload ? 'POST' : 'GET',
      headers: {...(token ? {Authorization:'Bearer '+token}:{}),
        ...(payload ? {'Content-Type':'application/json','Idempotency-Key':key}:{})},
      ...(payload ? {body:JSON.stringify(payload)}:{})
    });
    assert.equal(response.status,status,(await response.clone().text()).slice(0,200));
    if (response.headers.get('content-type').startsWith('application/json')) return (await response.json()).data;
  }
  const manager = (await send('/auth/dev',200,null,{actor:'manager'})).token;
  const finance = (await send('/auth/dev',200,null,{actor:'finance'})).token;
  const visitor = (await send('/auth/visitor',200,null,{})).token;
  const secondVisitor = (await send('/auth/visitor',200,null,{})).token;
  assert.equal((await send('/onboarding/config',200,visitor)).enabled,false);
  const upload = (token,purpose,data) => send('/files',201,token,{name:'隔离验收.png',type:'image/png',purpose,base64:data.toString('base64')});
  const qr = await upload(manager,'onboarding-qr',png);
  await send('/files',409,visitor,{name:'隔离验收.png',type:'image/png',purpose:'onboarding-proof',base64:proof.toString('base64')});
  await send('/onboarding/config',403,finance,{qrFileId:qr.id,payee:'隔离验证主体',confirmed:true});
  await send('/files/'+qr.id,403,visitor);
  await send('/onboarding/config',200,manager,{qrFileId:qr.id,payee:'隔离验证主体',confirmed:true});
  await send('/files/'+qr.id,200,visitor);
  const receipt = await upload(visitor,'onboarding-proof',proof);
  await send('/files/'+receipt.id,403,secondVisitor);

  const application = {name:'隔离申请人',mobile:'13900001234',organization:'隔离加盟主体',fileId:receipt.id,qrFileId:qr.id};
  await send('/onboarding/applications',403,secondVisitor,application);
  const key = randomUUID();
  const first = await send('/onboarding/applications',200,visitor,application,key);
  const retry = await send('/onboarding/applications',200,visitor,application,key);
  assert.equal(first.id,retry.id);
  assert.equal(first.status,'pending');
  assert.equal(first.accountActor,undefined);
  assert.ok(first.trackingCode);
  assert.equal((await send('/onboarding/applications',200,secondVisitor)).items.length,0);
  assert.equal((await send('/onboarding/applications',200,manager)).items[0].trackingCode,undefined);
  const review='/onboarding/applications/'+first.id+'/review';
  await send(review,403,finance,{decision:'approve',version:first.version,settlementReference:'BOOKED-LOCAL-001'});
  await send(review,400,manager,{decision:'approve',version:first.version});
  const approve={decision:'approve',version:first.version,settlementReference:'BOOKED-LOCAL-001'};
  const approved=await send(review,200,manager,approve,'onboarding-approval-key');
  assert.equal(approved.status,'approved');
  assert.equal(approved.activationStatus,'not_issued');
  assert.equal((await send(review,200,manager,approve,'onboarding-approval-key')).accountActor,approved.accountActor);
  assert.equal(app.store.db.prepare('SELECT status FROM accounts WHERE owner=?').get(approved.accountActor.slice(8)).status,'pending');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM receipts').get().n,0);
  const originally=(await send('/collections/messages?status=unread',200,visitor)).items.find(item=>item.recordId===first.id);
  assert.equal(originally.target,'join');
  await send('/onboarding/recover',200,secondVisitor,{trackingCode:first.trackingCode});
  assert.equal((await send('/onboarding/applications',200,visitor)).items.length,0);
  assert.equal((await send('/collections/messages?status=unread',200,secondVisitor)).items.some(item=>item.id===originally.id),true);
  const byId=token=>send('/onboarding/applications?id='+first.id,200,token);
  const issuedBeforeExpiry=await send('/auth/activation',200,manager,{actor:approved.accountActor,username:'approved-trial-person'});
  const managerProgress=(await byId(manager)).items[0];
  assert.equal(managerProgress.activationStatus,'issued');
  assert.equal(managerProgress.activationExpiresAt,issuedBeforeExpiry.expiresAt);
  const applicantProgress=(await byId(secondVisitor)).items[0];
  assert.equal(applicantProgress.activationStatus,'issued');
  assert.equal(applicantProgress.activationExpiresAt,undefined);
  assert.equal(applicantProgress.accountActor,undefined);
  assert.equal(applicantProgress.settlementReference,undefined);
  assert.ok(!JSON.stringify([managerProgress,applicantProgress]).includes(issuedBeforeExpiry.token));
  app.store.db.prepare('UPDATE activation_tokens SET expires_at=? WHERE actor=?').run('2000-01-01T00:00:00.000Z',approved.accountActor);
  assert.equal((await byId(manager)).items[0].activationStatus,'expired');
  const issued=await send('/auth/activation',200,manager,{actor:approved.accountActor,username:'approved-trial-person'});
  const activated=await send('/auth/activate',200,null,{token:issued.token,password:'Local-Once-Only-3847'});
  assert.equal(activated.role,'partner');
  assert.equal((await byId(manager)).items[0].activationStatus,'activated');
  assert.equal((await byId(activated.token)).items[0].activationStatus,'activated');
  assert.equal((await byId(visitor)).items.length,0);
  await send('/auth/activate',409,null,{token:issued.token,password:'Local-Once-Only-3847'});
  assert.equal((await send('/collections/outlets',200,activated.token)).total,0);
  assert.ok((await send('/collections/messages?status=unread',200,activated.token)).items.some(item=>item.target==='join'));
  const otherProof=await sharp({create:{width:12,height:12,channels:3,background:'#B24961'}}).png().toBuffer();
  const copy=await upload(visitor,'onboarding-proof',proof);
  const other={...application,mobile:'13900001236',fileId:copy.id};
  await send('/onboarding/applications',409,visitor,other);
  const replacement=await upload(visitor,'onboarding-proof',otherProof);
  const second=await send('/onboarding/applications',200,visitor,{...other,fileId:replacement.id});
  const secondReview='/onboarding/applications/'+second.id+'/review';
  const returned=await send(secondReview,200,manager,{decision:'return',version:second.version,note:'请补充付款时间'});
  assert.equal(returned.status,'returned');
  const retryProof=await upload(visitor,'onboarding-proof',otherProof);
  const resubmitted=await send('/onboarding/applications',200,visitor,{...other,id:second.id,fileId:retryProof.id});
  assert.equal(resubmitted.id,second.id);
  assert.equal(resubmitted.version,2);
  assert.equal(resubmitted.status,'pending');
  await send(secondReview,409,manager,{decision:'approve',version:second.version,settlementReference:'BOOKED-LOCAL-002'});
  await send(secondReview,409,manager,{decision:'approve',version:resubmitted.version,settlementReference:'booked-local-001'});
  await send(secondReview,200,manager,{decision:'return',version:resubmitted.version,note:'另一个隔离申请'});

  let currentQr=qr;
  for (const [index, change] of ['disable','replace'].entries()) {
    await send('/onboarding/config',200,manager,{qrFileId:currentQr.id,payee:'隔离原收款方',confirmed:true});
    const image=await sharp({create:{width:20+index,height:12,channels:3,background:'#AC835E'}}).png().toBuffer();
    const initial=await upload(visitor,'onboarding-proof',image);
    const payload={...application,mobile:'1390000124'+index,fileId:initial.id,qrFileId:currentQr.id};
    const created=await send('/onboarding/applications',200,visitor,payload);
    const reviewPath='/onboarding/applications/'+created.id+'/review';
    await send(reviewPath,200,manager,{decision:'return',version:created.version,note:'请补充原付款时间'});
    if(change==='disable')await send('/onboarding/config',200,manager,{enabled:false});
    else{
      currentQr=await upload(manager,'onboarding-qr',png);
      await send('/onboarding/config',200,manager,{qrFileId:currentQr.id,payee:'隔离新收款方',confirmed:true});
    }
    const target={applicationId:created.id,applicationVersion:created.version};
    const imageFields={name:'隔离补交.png',type:'image/png',purpose:'onboarding-proof'};
    const body={...imageFields,base64:image.toString('base64'),...target};
    const supplement=await send('/files',201,visitor,body);
    await send('/files',404,secondVisitor,body);
    await send('/files',409,visitor,{...body,applicationVersion:created.version+1});
    await send('/files',400,visitor,{...body,applicationVersion:undefined});
    const parts=new FormData();
    for(const [name,value] of Object.entries({...imageFields,...target}))parts.set(name,String(value));
    parts.set('file',new Blob([image],{type:'image/png'}),'隔离补交.png');
    const multipart=await fetch(base+'/api/files',{method:'POST',headers:{Authorization:'Bearer '+visitor},body:parts});
    assert.equal(multipart.status,201,(await multipart.clone().text()).slice(0,180));
    const scope=app.store.db.prepare('SELECT target_application_id,target_application_version,application_id FROM onboarding_files WHERE file_id=?').get((await multipart.json()).data.id);
    assert.deepEqual({...scope},{target_application_id:created.id,target_application_version:created.version,application_id:null});
    await send('/onboarding/applications',403,visitor,{...other,id:second.id,fileId:supplement.id,version:resubmitted.version});
    const retryFields={...payload,id:created.id,fileId:supplement.id,version:created.version};
    delete retryFields.qrFileId;
    const retryKey=randomUUID();
    const retried=await send('/onboarding/applications',200,visitor,retryFields,retryKey);
    assert.equal(retried.id,created.id);
    assert.equal(retried.status,'pending');
    assert.equal(retried.version,created.version+1);
    assert.equal(retried.payee,'隔离原收款方');
    assert.equal((await send('/onboarding/applications',200,visitor,retryFields,retryKey)).version,retried.version);
    assert.equal(app.store.db.prepare('SELECT qr_file_id FROM onboarding_applications WHERE id=?').get(created.id).qr_file_id,payload.qrFileId);
    for(const id of [initial.id,supplement.id])assert.equal(app.store.db.prepare('SELECT application_id FROM onboarding_files WHERE file_id=?').get(id).application_id,created.id);
    await send('/onboarding/applications',409,visitor,retryFields);
    await send(reviewPath,200,manager,{decision:'approve',version:retried.version,settlementReference:'BOOKED-LOCAL-RETRY-'+index});
    assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM receipts').get().n,0);
  }
});
