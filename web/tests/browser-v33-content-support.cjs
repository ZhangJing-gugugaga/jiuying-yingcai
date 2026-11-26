'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {createServer}=require('../server/index.cjs'),{officialCrypto}=require('../server/official-account.cjs');
const output=process.env.V33_BROWSER_EVIDENCE||path.resolve(__dirname,'../execution/browser-v33-content-support');

(async()=>{
 const env={NODE_ENV:'test',ADAPTER_MODE:'mock',WECHAT_OFFICIAL_ENABLED:'1',WECHAT_OFFICIAL_TOKEN:'fixture-only',
  WECHAT_OFFICIAL_APP_ID:'fixture-official',WECHAT_OFFICIAL_ENCODING_KEY:Buffer.alloc(32,2).toString('base64').slice(0,-1)};
 const app=createServer({dbPath:':memory:',env});
 let browser;
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1280,height:920}});
  page.setDefaultTimeout(5000);
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const waitStore=async check=>{for(let n=0;n<80;n++){if(check())return;await new Promise(r=>setTimeout(r,50));}assert.fail('数据库未出现预期记录');};
  const token=async actor=>(await (await page.request.post(url+'/api/auth/dev',{data:{actor}})).json()).data.token;
  const login=async actor=>{
   if(await page.locator('[data-action=logout]').count())await page.locator('[data-action=logout]').click();
   await page.locator('select[name=actor]').selectOption(actor);
   await page.locator('form[data-command=login] button[type=submit]').click();
   await page.locator('.nav').waitFor();
  };
  const nav=key=>page.locator('.nav [data-page="'+key+'"]').click();
  const form=command=>page.locator('form[data-command="'+command+'"]');
  const submitted=locator=>locator.locator('button[type=submit]').click();
  const fill=async(locator,fields)=>{for(const [name,value] of Object.entries(fields))await locator.locator('[name='+name+']').fill(value);};
  const current=()=>app.store.load().contents.find(x=>x.key==='service-1');
  await page.goto(url);
  await login('manager');
  await nav('content');
  await page.locator('[data-action=content-slot][data-key=service-1]').click();
  const edit=form('content.service.save');
  await fill(edit,{title:'验收测试业务栏目',summary:'验收测试摘要',body:'验收测试正文',reason:'受控测试发布'});
  await edit.locator('[name=published]').selectOption('true');
  await submitted(edit);
  await waitStore(()=>current()?.publishedSnapshot?.version===1);
  const withdraw=form('content.publication').filter({has:page.locator('[name=action][value=withdraw]')});
  await fill(withdraw,{reason:'受控测试撤回'});
  await submitted(withdraw);
  await waitStore(()=>current()?.status==='withdrawn');
  const restore=form('content.publication').filter({has:page.locator('[name=action][value=restore]')});
  await fill(restore,{reason:'受控测试恢复'});
  await submitted(restore);
  await waitStore(()=>current()?.publishedSnapshot?.version===3);
  await page.getByText('当前公开版本 V3', {exact:false}).last().waitFor();
  fs.mkdirSync(output,{recursive:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(output,'V33-D07-HQ-release.png'),fullPage:true});
  console.log('PASS D07 总部界面经发布、撤回和恢复，产生 V1、V2、V3');

  // Exercise the V3.4.2 editor with Chrome UI, then inspect the visitor API projection and SQLite.
  const evidence=[];
  const visitorResponse=await page.request.post(url+'/api/auth/visitor',{data:{}});
  assert.equal(visitorResponse.status(),200);
  const visitor=(await visitorResponse.json()).data.token;
  const headers={Authorization:'Bearer '+visitor};
  const directory=async()=>{
   const response=await page.request.get(url+'/api/collections/publicContents',{headers});
   assert.equal(response.status(),200);
   const result=await response.json();
   return {items:result.data.items,requestId:result.requestId};
  };
  const save=async(command,locator)=>{
   const result=page.waitForResponse(response=>response.url().endsWith('/api/commands')&&response.request().postDataJSON()?.command===command);
   await submitted(locator);
   const response=await result;
   const payload=await response.json();
   assert.equal(response.status(),200,JSON.stringify(payload.error));
   const {id,key,version,status}=payload.data.result;
   assert.ok(payload.requestId);
   await waitStore(()=>app.store.load().contents.some(record=>record.id===id&&record.version===version&&record.status===status));
   return {id,key,version,status,requestId:payload.requestId};
  };
  const launchEditor=async key=>{
   if(key==='brand')await page.locator('[data-filter=contentKey]').selectOption('brand');
   else await page.locator('[data-action=content-slot][data-key='+key+']').click();
   const editor=form(key==='brand'?'content.update':'content.service.save');
   await editor.locator(key==='brand'?'[name=intro]':'[name=body]').waitFor();
   return editor;
  };
  const cover=async(editor,shade,name)=>{
   const buffer=await require('sharp')({create:{width:300,height:180,channels:3,background:shade}}).png().toBuffer();
   const previous=await editor.locator('[name=imageId]').inputValue();
   await editor.locator('#contentImage').setInputFiles({name,mimeType:'image/png',buffer});
   await page.waitForFunction(old=>{
    const image=document.querySelector('[name=imageId]');
    return image?.value.startsWith('file-')&&image.value!==old;
   },previous);
   return editor.locator('[name=imageId]').inputValue();
  };
  const assertProjection=async(key,title,coverId,expectedStatus=200)=>{
   const data=await directory();
   const visible=data.items.find(row=>row.key===key);
   if(title){
    assert.equal(visible?.title,title);
    assert.equal(visible?.imageId,coverId);
   }else assert.equal(visible,undefined);
   if(coverId)assert.equal((await page.request.get(url+'/api/files/'+coverId,{headers})).status(),expectedStatus);
   return data.requestId;
  };
  const brand=await launchEditor('brand');
  const firstCover=await cover(brand,'#1677d2','isolated-brand-v1.png');
  await fill(brand,{title:'隔离集团介绍',intro:'用于验收的集团介绍正文',reason:'隔离环境保存草稿'});
  await brand.locator('[name=published]').selectOption('false');
  const draft=await save('content.update',brand);
  evidence.push({...draft,readRequestId:await assertProjection('brand',null,firstCover,403)});
  await brand.locator('[name=expectedVersion][value="'+draft.version+'"]').waitFor({state:'attached'});
  await page.screenshot({path:path.join(output,'V342-01-HQ-brand-draft.png'),fullPage:true});
  await fill(brand,{reason:'隔离环境发布集团介绍'});
  await brand.locator('[name=published]').selectOption('true');
  const published=await save('content.update',brand);
  evidence.push({...published,readRequestId:await assertProjection('brand','隔离集团介绍',firstCover)});
  await brand.locator('[name=expectedVersion][value="'+published.version+'"]').waitFor({state:'attached'});
  await page.screenshot({path:path.join(output,'V342-02-HQ-brand-published.png'),fullPage:true});

  const revisedCover=await cover(brand,'#174a80','isolated-brand-v2.png');
  await fill(brand,{title:'隔离集团介绍更新',intro:'新版集团介绍正文',reason:'隔离环境发布更新'});
  await brand.locator('[name=published]').selectOption('true');
  const updated=await save('content.update',brand);
  evidence.push({...updated,readRequestId:await assertProjection('brand','隔离集团介绍更新',revisedCover)});
  assert.equal((await page.request.get(url+'/api/files/'+firstCover,{headers})).status(),403);
  const withdrawBrand=form('content.publication').filter({has:page.locator('[name=action][value=withdraw]')});
  await fill(withdrawBrand,{reason:'隔离环境撤回'});
  const withdrawn=await save('content.publication',withdrawBrand);
  evidence.push({...withdrawn,readRequestId:await assertProjection('brand',null,revisedCover,403)});
  await page.getByText('当前暂无公开版本',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'V342-03-HQ-brand-withdrawn.png'),fullPage:true});
  const restoreBrand=form('content.publication').filter({has:page.locator('[name=action][value=restore]')});
  await restoreBrand.locator('[name=sourceVersion]').selectOption(String(published.version));
  await fill(restoreBrand,{reason:'隔离环境恢复历史发布'});
  const restored=await save('content.publication',restoreBrand);
  evidence.push({...restored,sourceVersion:published.version,readRequestId:await assertProjection('brand','隔离集团介绍',firstCover)});
  await page.getByText('当前公开版本 V'+restored.version+' · 隔离集团介绍',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'V342-04-HQ-brand-restored.png'),fullPage:true});

  for(let slot=1;slot<=5;slot++){
   const editor=await launchEditor('service-'+slot);
   await editor.locator('[name=slot][value="'+slot+'"]').waitFor({state:'attached'});
   const title='隔离业务栏目 '+slot;
   const imageId=slot===1?await cover(editor,'#3a87ce','isolated-service.png'):null;
   await fill(editor,{title,summary:'隔离业务摘要 '+slot,body:'仅用于验收的业务介绍正文 '+slot,reason:'隔离环境发布业务栏目'});
   await editor.locator('[name=published]').selectOption('true');
   const publishedService=await save('content.service.save',editor);
   evidence.push({...publishedService,readRequestId:await assertProjection('service-'+slot,title,imageId)});
   await editor.locator('[name=expectedVersion][value="'+publishedService.version+'"]').waitFor({state:'attached'});
  }
  const final=await directory();
  assert.equal(final.items.filter(record=>/^service-[1-5]$/.test(record.key)).length,5);
  await page.screenshot({path:path.join(output,'V342-05-HQ-five-services.png'),fullPage:true});
  fs.writeFileSync(path.join(output,'V342-content-requests.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('PASS V3.4.2 总部 Chrome 经正常表单核对集团介绍草稿、发布、更新、撤回、恢复和五大业务公开读取');

  const crypt=officialCrypto(env),timestamp=String(Math.floor(Date.now()/1000)),nonce='fixture';
  const encrypted=crypt.encrypt('<xml><ToUserName>fixture</ToUserName><FromUserName>fixture-only-user</FromUserName><MsgType>text</MsgType><MsgId>7755123</MsgId><Content>人工</Content></xml>');
  const callback=await page.request.post(url+'/api/wechat/official/callback?'+new URLSearchParams({timestamp,nonce,msg_signature:crypt.signature(timestamp,nonce,encrypted)}),{headers:{'Content-Type':'text/xml'},data:'<xml><Encrypt>'+encrypted+'</Encrypt></xml>'});
  assert.equal(callback.status(),200);
  const id=app.store.load().supportChats[0].id;
  const chat=()=>app.store.load().supportChats.find(x=>x.id===id);
  await login('support');
  await nav('support');
  await page.locator('[data-action=claim][data-id="'+id+'"]').click();
  await waitStore(()=>chat()?.status==='active');
  await page.getByText('升级管理层处理',{exact:true}).click();
  const escalation=form('support.escalate');
  await fill(escalation,{reason:'受控升级测试'});
  await submitted(escalation);
  await waitStore(()=>chat()?.severe);
  await login('manager');
  await nav('support');
  const management=form('support.management');
  await fill(management,{note:'受控内部处理意见',customerReply:'已收到您的咨询，核查完成。'});
  await submitted(management);
  await waitStore(()=>app.store.db.prepare('SELECT count(*) n FROM official_outbox').get().n===1);
  const dispatch=await page.request.post(url+'/api/wechat/official/dispatch',{headers:{Authorization:'Bearer '+await token('manager')},data:{}});
  assert.equal(dispatch.status(),200);
  await page.locator('[data-action=official-delivery]').click();
  const dialog=page.locator('dialog[open]');
  await dialog.getByText('已模拟发送',{exact:true}).waitFor();
  assert.equal(await dialog.getByText('平台已接受',{exact:true}).count(),0);
  assert.equal(await dialog.getByText('受控内部处理意见',{exact:true}).count(),0);
  await dialog.screenshot({path:path.join(output,'V33-D06-HQ-delivery.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS D06 总部界面明确填写客户回复，Mock 留痕与真实平台状态分开');
 }finally{
  await browser?.close();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
