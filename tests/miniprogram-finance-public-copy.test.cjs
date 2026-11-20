const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {stripDevelopment}=require('../scripts/wechat-build.cjs');

const pageFile=(page,extension)=>fs.readFileSync(path.join(__dirname,'../miniprogram/pages',page,'index.'+extension),'utf8');

test('release fees keep real payment status access and remove the simulation controls and handlers',()=>{
 const template=pageFile('fees','wxml');
 const js=pageFile('fees','js');
 assert.match(template,/模拟成功/);
 assert.match(js,/api\.simulatePayment/);
 assert.doesNotMatch(stripDevelopment(template),/模拟|测试支付|bindtap="resolve"/);
 assert.doesNotMatch(stripDevelopment(js),/simulatePayment|payment\.resolve|simulation:\s*true/);
 assert.match(stripDevelopment(template),/bindtap="resume"[^>]*>查看付款状态/);
 assert.match(stripDevelopment(js),/api\.queryPayment/);
});

test('the public sections describe unpublished services without inventing business names',()=>{
 const template=pageFile('discover','wxml');
 assert.match(template,/该栏目内容暂未发布，欢迎联系总部了解。/);
 assert.match(template,/我同意将上述联系方式和留言提供给总部，仅用于本次合作联系。/);
 assert.doesNotMatch(pageFile('discover','js'),/title:'业务 '\+slot/);
});
