'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const sharp=require('sharp');
const {createServer}=require('../server/index.cjs');

const output=process.env.V34_SUPPORT_EVIDENCE||path.join(__dirname,'../execution/browser-v34-support');

(async()=>{
 const requests=[],errors=[];
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 const shot=(tab,name)=>tab.screenshot({path:path.join(output,name+'.png'),fullPage:true});
 let browser,customer;
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  fs.mkdirSync(output,{recursive:true});
  async function login(actor){
   const tab=await browser.newPage({viewport:{width:1350,height:1000}});
   tab.setDefaultTimeout(7000);
   tab.on('pageerror',error=>errors.push(error.message));
   await tab.goto(url);
   await tab.locator('select[name=actor]').selectOption(actor);
   await tab.locator('form[data-command=login] button[type=submit]').click();
   await tab.locator('.nav').waitFor();
   return tab;
  }
  const navigate=(tab,page)=>tab.locator('.nav [data-page="'+page+'"]').click();
  const form=(scope,name)=>scope.locator('form[data-command="'+name+'"]');
  const card=(tab,title)=>tab.locator('.record').filter({has:tab.getByRole('heading',{name:title,exact:true})});
  async function command(tab,name,action){
   const expected=tab.waitForResponse(response=>response.url()===url+'/api/commands'&&
    response.request().method()==='POST'&&response.request().postDataJSON()?.command===name);
   await action();
   const response=await expected,body=await response.json();
   assert.equal(response.status(),200,JSON.stringify(body.error));
   const id=response.headers()['x-request-id'];
   assert.ok(id);
   requests.push({command:name,id,objectId:body.data.result.id,status:body.data.result.status});
   return body.data.result;
  }
  async function submit(tab,name,fields={},selects={},scope=tab,sent=name){
   const target=form(scope,name);
   for(const [key,val] of Object.entries(fields))await target.locator('[name='+key+']').fill(val);
   for(const [key,val] of Object.entries(selects))await target.locator('[name='+key+']').selectOption(val);
   return command(tab,sent,()=>target.locator('button[type=submit]').click());
  }
  const snapshot=()=>app.store.load();
  const financialRecords=({bills,receipts,requests,outlets})=>({bills,receipts,requests,outlets});
  const before=financialRecords(snapshot());

  customer=await login('partnerA');
  await navigate(customer,'support');
  const chat=await submit(customer,'support.chat',{text:'请问如何查询业务进度？'});
  assert.equal(snapshot().supportTickets.length,0);
  const human=await command(customer,'support.human',()=>customer.locator('[data-action=human][data-id="'+chat.id+'"]').click());
  assert.equal(human.status,'queued');
  assert.equal(snapshot().supportTickets.length,0);

  const originalTitle='株洲网点的服务问题';
  const original=await submit(customer,'support.ticket',{title:originalTitle,description:'请协助处理隔离演练事项。'},{outlet:'zz',category:'aftersale'});
  const existing=()=>snapshot().supportTickets.find(ticket=>ticket.id===original.id);
  assert.equal(existing().status,'queued');

  const staff=await login('support');
  await navigate(staff,'support');
  await command(staff,'support.claim',()=>card(staff,originalTitle).getByRole('button',{name:'自行接单'}).click());
  assert.equal(existing().status,'active');
  assert.ok(existing().assignee);
  const secret='内部协作样例：仅客服可见';
  await submit(staff,'support.action',{text:secret},{operation:'collaborate',department:'运营'},card(staff,originalTitle),'support.collaborate');
  const reply='请补充服务问题的处理情况。';
  await submit(staff,'support.action',{text:reply},{operation:'requestSupplement'},card(staff,originalTitle),'support.reply');
  assert.equal(existing().status,'waiting');
  await card(staff,originalTitle).getByText(secret,{exact:true}).waitFor();
  await shot(staff,'01-HQ-assignee-and-internal-note');

  await navigate(customer,'messages');
  await customer.getByText('总部客服已回复',{exact:true}).first().waitFor();
  await shot(customer,'02-partner-notice');
  await navigate(customer,'support');
  await card(customer,originalTitle).getByText(reply,{exact:true}).waitFor();
  assert.equal(await card(customer,originalTitle).getByText(secret,{exact:true}).count(),0);
  const supplement='已补充，等待最终结果。';
  await submit(customer,'support.supplement',{text:supplement},{},card(customer,originalTitle));
  assert.equal(existing().status,'active');
  await staff.reload();
  await navigate(staff,'support');
  await card(staff,originalTitle).getByText(supplement,{exact:true}).waitFor();
  await submit(staff,'support.action',{text:'已完成处理。'},{operation:'close'},card(staff,originalTitle),'support.close');
  assert.equal(existing().status,'closed');

  await customer.reload();
  await navigate(customer,'support');
  await submit(customer,'support.rate',{}, {rating:'5'},card(customer,originalTitle));
  assert.equal(existing().rating.score,5);
  const newTitle='株洲网点服务问题复查';
  const linked=await submit(customer,'support.ticket',{title:newTitle,description:'同一网点原问题仍需复查。'},{outlet:'zz',category:'aftersale',linkedTicketId:original.id});
  assert.equal(linked.linkedTicketId,original.id);
  assert.equal(linked.status,'queued');
  await card(customer,newTitle).getByText('关联原工单',{exact:true}).waitFor();
  await shot(customer,'03-partner-closed-rated-and-linked');
  assert.equal(existing().status,'closed');
  assert.equal(snapshot().supportTickets.find(ticket=>ticket.id===linked.id).outlet,'zz');
  assert.deepEqual(financialRecords(snapshot()),before);
  assert.deepEqual(errors,[]);

  const db=app.store.db;
  const statements=db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.recordId')=? ORDER BY rowid").all(original.id).map(row=>JSON.parse(row.data));
  const claim=statements.find(row=>row.command==='support.claim');
  assert.equal(claim.subject,existing().assignee);
  assert.equal(claim.requestId,requests.find(row=>row.command==='support.claim').id);
  const history=db.prepare("SELECT action,audit_record_id FROM approval_events WHERE collection='supportTickets' AND object_id=? ORDER BY seq").all(original.id);
  assert.deepEqual(history.map(row=>row.action),['support.ticket','support.claim','support.collaborate','support.reply','support.supplement','support.close','support.rate']);
  assert.deepEqual(history.map(row=>row.audit_record_id),statements.map(row=>row.id));
  const closed=existing();
  const photoData=(await sharp({create:{width:12,height:12,channels:3,background:'#174a80'}}).png().toBuffer()).toString('base64');
  const photoFixture=await customer.evaluate(async photo=>{
   const token=JSON.parse(sessionStorage.getItem('jy-session')).token;
   const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
   const upload=await fetch('/api/files',{method:'POST',headers,
    body:JSON.stringify({purpose:'support-ticket',name:'isolated-ticket.png',type:'image/png',base64:photo})});
   if(!upload.ok)throw new Error('Isolated ticket image upload returned '+upload.status);
   const {data:file,requestId:uploadRequestId}=await upload.json();
   const submitted=await fetch('/api/commands',{method:'POST',headers:{...headers,'Idempotency-Key':crypto.randomUUID()},
    body:JSON.stringify({command:'support.ticket',payload:{outlet:'zz',category:'aftersale',title:'隔离工单附件',
     description:'用来核对客服预览同一工单的图片。',attachmentIds:[file.id]}})});
   if(!submitted.ok)throw new Error('Isolated ticket submission returned '+submitted.status);
   const {data:{result:ticket},requestId:submitRequestId}=await submitted.json();
   return {fileId:file.id,ticketId:ticket.id,uploadRequestId,submitRequestId};
  },photoData);
  await navigate(staff,'support');
  const waitingPhoto=staff.waitForResponse(response=>response.url()===url+'/api/files/'+photoFixture.fileId);
  await card(staff,'隔离工单附件').getByRole('button',{name:'查看图片 1',exact:true}).click();
  const photoResponse=await waitingPhoto;
  assert.equal(photoResponse.status(),200);
  assert.equal(photoResponse.headers()['cache-control'],'private, no-store');
  await staff.waitForFunction(()=>document.querySelector('dialog img[alt="工单图片"]')?.naturalWidth>0);
  await shot(staff,'support-private-attachment');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({
   mode:'Chrome browser operating both authorized Web roles. No WeChat Simulator or external systems.',
   chatId:chat.id,original:{id:closed.id,outlet:closed.outlet,status:closed.status,assignee:closed.assignee,rating:closed.rating.score},
   followUp:{id:linked.id,outlet:linked.outlet,status:linked.status,linkedTicketId:linked.linkedTicketId},
   attachment:{...photoFixture,previewRequestId:photoResponse.headers()['x-request-id']},history,requests,errors
  },null,2));
  console.log('PASS D01 同一隔离工单完成咨询、转人工、创建、接单、公开回复、补充、关闭、5分评价及同网点关联。财务和网点数据相同。');
 }catch(error){
  if(customer)await shot(customer,'failure').catch(()=>{});
  throw error;
 }finally{
  await browser?.close();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
