'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = require('../miniprogram/utils/api');

function joinPage(t) {
  const previous = {Page:global.Page,wx:global.wx};
  t.after(() => {global.Page=previous.Page; global.wx=previous.wx;});
  const clipboard=new Map();
  global.wx={setStorageSync:(key,value)=>clipboard.set(key,value),getStorageSync:key=>clipboard.get(key)};
  let definition;
  global.Page=page=>{definition=page;};
  const file=require.resolve('../miniprogram/pages/join/index');
  delete require.cache[file];
  require(file);
  const view={...definition,data:structuredClone(definition.data),setData(patch){Object.assign(this.data,patch);}};
  view.onLoad({});
  return view;
}

test('returned onboarding loads and uploads for its exact original record when new payments are closed', async t => {
  const id = 'join-12345678-1234-1234-1234-123456789abc';
  const original = { id, version: 1, status: 'returned', payee: '原收款方', name: '隔离申请人', mobile: '13900004123', organization: '隔离主体' };
  const calls = [];
  t.mock.method(api, 'session', () => ({role:'public',token:'isolated-session'}));
  t.mock.method(api, 'request', async (path, method, body) => {
    calls.push({path,method,body});
    if (path === '/api/onboarding/config') throw new Error('补交与当前收款配置无关');
    if (method === 'POST') return {...original,status:'pending',version:2};
    return {items:[original]};
  });
  t.mock.method(api, 'uploadPhoto', async options => {
    assert.deepEqual(options, {purpose:'onboarding-proof',sourceType:['album'],applicationId:id,applicationVersion:1});
    return {file:{id:'file-isolated-supplement'},preview:'wxfile://qa-proof.png'};
  });
  t.mock.method(api, 'download', async () => {throw new Error('补交不得获取新收款码');});
  t.mock.method(api, 'newCommandKey', () => 'qa-stable-idempotency-key');
  const originalPage = global.Page, originalWx = global.wx;
  t.after(() => {global.Page = originalPage; global.wx = originalWx;});
  let registered;
  global.Page = page => { registered = page; };
  global.wx = {};
  const file = require.resolve('../miniprogram/pages/join/index');
  delete require.cache[file];
  require(file);
  const view = {...registered,data:structuredClone(registered.data),setData(values){Object.assign(this.data,values);}};
  view.onLoad({ id });
  await view.onShow();
  assert.equal(view.data.formMode,'supplement');
  assert.equal(view.data.record.payee,'原收款方');
  assert.equal(view.data.qrImage,'');
  await view.choosePhoto();
  await view.submit();
  assert.equal(view.data.record.version,2);
  assert.equal(view.data.formMode,'none');
  const post = calls.find(call => call.method === 'POST');
  assert.equal(post.body.id,id);
  assert.equal(post.body.version,1);
  assert.equal(post.body.fileId,'file-isolated-supplement');
  assert.equal(post.body.qrFileId,undefined);
});

test('an unaffiliated visitor can find an existing application before loading a payment QR', async t => {
  const id = 'join-12345678-1234-1234-1234-123456789abc';
  const record = { id, version: 1, status: 'returned', payee: '原收款方' };
  const calls = [];
  let recovered = false;
  t.mock.method(api, 'session', () => ({role:'public',token:'isolated-session'}));
  t.mock.method(api, 'request', async (path, method, body) => {
    calls.push(path);
    if (path === '/api/onboarding/recover') {
      assert.equal(body.trackingCode, 'existing-application');
      recovered = true;
      return record;
    }
    if (path === '/api/onboarding/config') return {enabled:true,qrFileId:'qr-isolated',payee:'集团收款'};
    return {items:recovered?[record]:[]};
  });
  t.mock.method(api, 'download', async () => 'wxfile://qr-isolated.png');
  const originalPage = global.Page, originalWx = global.wx;
  t.after(() => {global.Page = originalPage; global.wx = originalWx;});
  let registered;
  global.Page = page => { registered = page; };
  global.wx = {};
  const file = require.resolve('../miniprogram/pages/join/index');
  delete require.cache[file];
  require(file);
  const view = {...registered,data:structuredClone(registered.data),setData(values){Object.assign(this.data,values);}};
  view.onLoad({});
  await view.onShow();
  assert.equal(view.data.formMode, 'choose');
  assert.ok(!calls.includes('/api/onboarding/config'));
  await view.startApplication();
  assert.equal(view.data.formMode, 'new');
  assert.equal(view.data.qrImage, 'wxfile://qr-isolated.png');
  view.toggleRecovery();
  view.recoveryInput({detail:{value:'existing-application'}});
  await view.recover();
  assert.equal(view.data.record.id,id);
  assert.equal(view.data.formMode,'supplement');
  assert.equal(view.data.showRecovery,false);
  assert.equal(view.data.qrImage,'');
  assert.equal(calls.filter(path=>path==='/api/onboarding/config').length,1);
});

test('changed collection information retains the form and requires a new receipt if the applicant explicitly has not paid', async t=>{
  const view=joinPage(t);
  let config={enabled:true,qrFileId:'qr-before',payee:'原收款方'};
  const downloaded=[];
  t.mock.method(api,'session',()=>({role:'public',token:'same-visitor'}));
  t.mock.method(api,'request',async url=>url==='/api/onboarding/config'?config:{items:[]});
  t.mock.method(api,'download',async url=>{downloaded.push(url);return 'wxfile://'+config.qrFileId;});
  await view.onShow();
  await view.startApplication();
  view.setData({form:{name:'测试申请人',mobile:'13900004123',organization:'隔离主体',note:'已填写'},
    photo:{file:{id:'file-old'},preview:'wxfile://old-proof'}});
  config={enabled:true,qrFileId:'qr-after',payee:'新收款方'};
  await view.onShow();
  assert.equal(view.data.formMode,'payment_changed');
  assert.equal(view.data.qrImage,'');
  assert.equal(view.data.photo.file.id,'file-old');
  await view.onShow();
  assert.deepEqual(downloaded,['/api/files/qr-before']);
  await view.restartUnpaidApplication?.();
  assert.equal(view.data.formMode,'new');
  assert.equal(view.data.qrImage,'wxfile://qr-after');
  assert.equal(view.data.form.note,'已填写');
  assert.equal(view.data.photo,null);
});

test('switching visitor accounts clears the previous draft and ignores late application submission responses', async t=>{
  const view=joinPage(t);
  let token='visitor-first';
  let finishSubmission;
  t.mock.method(api,'session',()=>({role:'public',token}));
  t.mock.method(api,'request',async (url,method)=>{
    if(method==='POST')return await new Promise(resolve=>{finishSubmission=resolve;});
    if(url==='/api/onboarding/config')return {enabled:true,qrFileId:'qr-current',payee:'隔离集团'};
    return {items:[]};
  });
  t.mock.method(api,'download',async ()=>'wxfile://qr');
  await view.onShow();
  await view.startApplication();
  view.setData({form:{name:'旧账号资料',mobile:'13900004123',organization:'旧账号主体',note:''},
    photo:{file:{id:'old-photo'},preview:'wxfile://old-photo'}});
  const submission=view.submit();
  assert.equal(typeof finishSubmission,'function');
  token='visitor-next';
  await view.onShow();
  finishSubmission({id:'join-12345678-1234-1234-1234-123456789abc',status:'pending',trackingCode:'old-private-code'});
  await submission;
  assert.equal(view.data.formMode,'choose');
  assert.equal(view.data.form.name,'');
  assert.equal(view.data.photo,null);
  assert.equal(view.data.record,null);
  assert.equal(view.data.busy,false);
  assert.equal(wx.getStorageSync('jyyc.joinTracking'),undefined);
});

test('a saved application tracking code can only be reused without typing by its original visitor',async t=>{
  const view=joinPage(t);
  const id='join-12345678-1234-1234-1234-123456789abc';
  let session={role:'public',token:'visitor-next',subject:'next-subject'};
  const submitted=[];
  t.mock.method(api,'session',()=>session);
  t.mock.method(api,'request',async (url,method,body)=>{
    if(method==='POST'){
      submitted.push(body.trackingCode);
      return {id,status:'pending'};
    }
    return {items:url.includes('?id=')?[{id,status:'pending'}]:[]};
  });
  wx.setStorageSync('jyyc.joinTracking',{subject:'first-subject',code:'first-tracking-code'});
  await view.onShow();
  await view.recover();
  assert.deepEqual(submitted,[]);
  assert.match(view.data.recoveryError,/请输入/);
  session={role:'public',token:'visitor-first',subject:'first-subject'};
  await view.onShow();
  await view.recover();
  assert.deepEqual(submitted,['first-tracking-code']);
  assert.equal(view.data.record.id,id);
});
