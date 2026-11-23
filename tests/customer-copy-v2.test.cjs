'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fmt=require('../miniprogram/utils/format');
const api=require('../miniprogram/utils/api');

test('customer statuses are contextual, unknown codes never become copy, and zero remains a value',()=>{
 assert.equal(fmt.label('pending','report'),'总部审核中');
 assert.equal(fmt.label('finance','report'),'财务复核中');
 assert.equal(fmt.label('returned','report'),'待我修改');
 assert.equal(fmt.label('pending','location'),'等待总部核验');
 assert.equal(fmt.label('open','outlet'),'营业中');
 assert.equal(fmt.label('open','task'),'待处理');
 assert.equal(fmt.label('pending','request'),'待总部处理');
 assert.equal(fmt.label('approved','refund'),'退款处理中');
 assert.equal(fmt.label('recorded','refund'),'已退款');
 assert.equal(fmt.label('approved','invoice'),'已通过');
 assert.equal(fmt.label('ticket_internal_v42','support'),'状态暂不可查看');
 assert.equal(fmt.money(0),'0.00');
 assert.equal(fmt.money(null),'—');
 assert.equal(fmt.monthText('2026-09'),'2026年09月');
 assert.equal(fmt.dateText('2026-09-01T18:30:00.000Z'),'2026年09月02日');
 const report=fmt.decorate({reports:[{status:'approved',revoked:true,enroll:0}]}).reports[0];
 assert.equal(report.statusText,'已撤销');
 assert.equal(report.enrollText,0);
});

test('production messages never present raw provider diagnostics, and valid form feedback is retained',()=>{
 assert.equal(api.errorText({code:'REAL_ADAPTER_UNAVAILABLE',message:'API adapter error mock'}),'此服务暂未开放，请联系总部。');
 assert.equal(api.errorText({status:403,message:'FORBIDDEN SQL'}),'当前账号暂无权限查看此内容。');
 assert.equal(api.errorText({status:500,message:'invalid JSON at input.sql'}),'暂时无法获取信息，请稍后重试。');
 assert.equal(api.errorText({status:400,code:'INPUT',message:'请填写营业收入。'}),'请填写营业收入。');
 assert.equal(api.errorText({status:400,code:'INPUT',message:'字段 gcj-02 fieldId 错误'}),'操作未成功，请稍后重试；如问题持续，请联系总部客服。');
});

test('message and task links retain the precise outlet, ledger, and service route',async t=>{
 const {openRecord,canOpenRecord}=require('../miniprogram/utils/page');
 const urls=[];
 global.wx={navigateTo({url}){urls.push(url);}};
 t.after(()=>{delete global.wx;});
 await openRecord({target:'outlets',outlet:'cs',recordId:'was-not-the-outlet'});
 await openRecord({kind:'bill_unpaid',outlet:'cs',month:'2026-09',recordId:'bill-10'});
 await openRecord({target:'refundRequests',recordId:'refund-10'});
 assert.deepEqual(urls,[
  '/pages/outlet/index?id=cs',
  '/pages/fees/index?outlet=cs&month=2026-09&id=bill-10',
  '/pages/finance/index?id=refund-10&type=refund'
 ]);
 assert.equal(canOpenRecord({target:'system_internal_code'}),false);
 assert.equal(fmt.dateText('2026-02-31'),'');
});

test('production native templates physically omit developer identities and payment controls',()=>{
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const {build}=require('../scripts/wechat-build.cjs');
 const out=path.resolve(__dirname,'../execution/customer-copy-release-'+crypto.randomUUID());
 const result=build({environment:'production',target:'device',out,appId:'wx1234567890abcdef',apiBase:'https://miniprogram-acceptance.example.test'});
 assert.equal(result.developmentRemoved,true);
 assert.equal(result.checks.pages,21);
 assert.ok(result.checks.routeManifest.routes.includes('pages/join/index'));
 assert.ok(result.checks.routeManifest.routes.includes('pages/training/index'));
 assert.ok(fs.existsSync(path.join(out,'pages/training/index.wxml')));
 assert.equal(fs.existsSync(path.join(out,'development')),false);
 const login=fs.readFileSync(path.join(out,'pages/login/index.wxml'),'utf8');
 const fees=fs.readFileSync(path.join(out,'pages/fees/index.wxml'),'utf8');
 const api=fs.readFileSync(path.join(out,'utils/api.js'),'utf8');
 assert.doesNotMatch(login,/开发|Mock|验证码{{devCode}}/);
 assert.doesNotMatch(fees,/模拟微信|模拟支付|模拟成功|测试支付/);
 assert.doesNotMatch(api,/module\.exports\.simulatePayment|\/api\/auth\/dev/);
 assert.match(fees,/微信支付/);
});
