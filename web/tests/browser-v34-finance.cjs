'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {createServer}=require('../server/index.cjs');

async function run(){
 const folder=path.resolve(process.argv[2]||'execution/v34-finance-browser');
 fs.mkdirSync(folder,{recursive:true});
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 const evidence=[];
 let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[];
  async function login(actor){
   const tab=await browser.newPage({viewport:{width:1440,height:1000}});
   tab.setDefaultTimeout(9000);
   tab.on('pageerror',error=>errors.push(error.message));
   await tab.goto(base);
   await tab.locator('select[name=actor]').selectOption(actor);
   await tab.locator('form[data-command=login] button[type=submit]').click();
   await tab.locator('.side').waitFor();
   return tab;
  }
  function shot(tab,name){return tab.screenshot({path:path.join(folder,name+'.png'),fullPage:true});}
  async function nav(tab,page,heading){
   await tab.locator(`.nav [data-page=${page}]`).click();
   await tab.getByRole('heading',{name:heading,exact:true}).waitFor();
  }
  async function commandAction(tab,command,button){
   const response=tab.waitForResponse(r=>r.url().endsWith('/api/commands')&&r.request().postDataJSON()?.command===command);
   await button.click();
   const result=await response,body=await result.json();
   assert.equal(result.status(),200,JSON.stringify(body));
   evidence.push({command,requestId:body.requestId,id:body.data.result.id,status:body.data.result.status});
   return body.data.result;
  }
  async function submit(tab,command,fields={}){
   const form=tab.locator(`form[data-command="${command}"]`);
   for(const [field,value] of Object.entries(fields))await form.locator(`[name="${field}"]`).fill(String(value));
   const submitButton=command==='review.report'
     ? form.locator('button[name="decision"][value="approve"]')
     : form.locator('button[type=submit]');
   return commandAction(tab,command,submitButton);
  }
  async function analytics(tab,month,outlet){
   await nav(tab,'analytics','经营数据看板');
   const period=tab.locator('[data-filter=period]');
   await period.fill(month);
   await period.dispatchEvent('change');
   await tab.locator('[data-filter=outlet]').selectOption(outlet);
   await tab.getByText('统计范围',{exact:true}).waitFor();
   await tab.locator('.pair').filter({hasText:'统计范围'}).getByText(month,{exact:true}).waitFor();
  }
  async function download(tab,format){
   const result=tab.waitForResponse(res=>{
    const url=new URL(res.url());return url.pathname==='/api/export'&&url.searchParams.get('format')===format;
   });
   const downloaded=tab.waitForEvent('download');
   await tab.locator(`[data-action=export][data-format=${format}]`).click();
   const res=await result;
   const file=path.join(folder,'B01-经营报告.'+format);
   await (await downloaded).saveAs(file);
   assert.equal(res.status(),200);
   evidence.push({action:'download',format,file:path.basename(file),requestId:res.headers()['x-request-id']});
   return fs.readFileSync(file);
  }
  async function billDetail(tab,billId,actor){
   const response=tab.waitForResponse(res=>new URL(res.url()).pathname==='/api/finance/bills/'+billId);
   await tab.locator(`[data-action=billing-detail][data-id="${billId}"]`).click();
   const res=await response;
   assert.equal(res.status(),200);
   evidence.push({action:'bill_detail',actor,billId,requestId:res.headers()['x-request-id']});
   return tab.getByRole('dialog');
  }

  const [partner,ops,finance,manager]=await Promise.all(['partnerA','ops','finance','manager'].map(login));
  const month='2026-10',outlet='cs';
  await Promise.all([partner,ops,finance].map(tab=>nav(tab,'reports','经营月报')));
  await partner.locator('select[name=shop]').selectOption(outlet);
  const baseReport=await submit(partner,'report.submit',{revenue:123.45,orders:9,traffic:19,enroll:2,note:'首版浏览器验收'});
  assert.equal(baseReport.month,month);assert.equal(baseReport.outlet,outlet);assert.equal(baseReport.version,1);
  await ops.reload();
  await nav(ops,'reports','经营月报');
  await submit(ops,'review.report',{note:'运营审批首份月报'});
  await analytics(manager,month,outlet);
  const original=await submit(manager,'settle');
  assert.ok(original.reportIds.includes(baseReport.id));
  await partner.reload();
  await nav(partner,'reports','经营月报');
  await partner.locator('select[name=shop]').selectOption(outlet);
  await partner.locator(`[data-action=correct][data-id="${baseReport.id}"]`).click();
  await submit(partner,'report.correct',{reason:'经营收入核对后更正'});
  await partner.getByRole('heading',{name:'提交更正版本'}).waitFor();
  const corrected=await submit(partner,'report.submit',{revenue:246.8,note:'正式统计采用的更正说明'});
  assert.equal(corrected.version,2);assert.equal(corrected.outlet,outlet);assert.equal(corrected.month,month);
  await ops.reload();
  await nav(ops,'reports','经营月报');
  await submit(ops,'review.report',{note:'运营审批收入更正'});
  assert.equal(app.store.load().reports.find(row=>row.id===corrected.id).status,'finance');
  await finance.reload();
  await nav(finance,'reports','经营月报');
  await finance.getByRole('button',{name:'财务复核通过'}).waitFor();
  await submit(finance,'review.report',{note:'财务确认修正收入'});
  const task=app.store.load().businessTasks.find(row=>row.kind==='report_resettlement'&&row.businessId===original.id);
  assert.equal(task.status,'open');assert.equal(task.impacts[0].previousReportId,baseReport.id);assert.equal(task.impacts[0].reportId,corrected.id);
  await analytics(partner,month,outlet);
  await partner.getByText('经营数据更新中。',{exact:false}).waitFor();
  assert.equal(await partner.locator('.metrics .metric b').filter({hasText:'246.8'}).count(),0);
  await shot(partner,'01-加盟商更新中');
  await analytics(manager,month,outlet);
  await manager.getByRole('link',{name:'查看重结算待办'}).click();
  await manager.getByRole('link',{name:'查看业务',exact:true}).click();
  await manager.getByRole('heading',{name:'影响记录',exact:true}).waitFor();
  await shot(manager,'02-总部重结算待办');
  const response=manager.waitForResponse(r=>r.url().endsWith('/api/commands')&&r.request().postDataJSON()?.command==='settle');
  await manager.getByRole('button',{name:'确认重新结算',exact:true}).click();
  const res=await response,body=await res.json();
  assert.equal(res.status(),200,JSON.stringify(body));
  const current=body.data.result;
  evidence.push({command:'settle',requestId:body.requestId,id:current.id,taskId:task.id,status:current.status});
  await manager.getByRole('heading',{name:'新结算快照',exact:true}).waitFor();
  assert.equal(current.previousSettlementId,original.id);assert.deepEqual(current.reportIds,[corrected.id]);
  const after=app.store.load();
  assert.equal(after.settlements.find(row=>row.id===original.id).status,'invalidated');
  assert.equal(after.settlements.find(row=>row.id===original.id).reportValues[baseReport.id].values.revenue,123.45);
  assert.equal(after.settlements.find(row=>row.id===current.id).reportValues[corrected.id].values.revenue,246.8);
  assert.equal(after.businessTasks.find(row=>row.id===task.id).status,'resolved');
  await shot(manager,'03-总部新旧快照');
  await analytics(partner,month,outlet);
  await partner.getByText('经营数据已更新。',{exact:true}).waitFor();
  await partner.locator('tbody tr').filter({hasText:'长沙示范网点A'}).getByText('246.8',{exact:true}).waitFor();
  await shot(partner,'04-加盟商更新后看板');
  await analytics(manager,month,outlet);
  await manager.getByText('经营数据已更新。',{exact:true}).waitFor();
  const ranking=manager.locator('section.panel').filter({has:manager.getByRole('heading',{name:'全范围四项排名 · 前20名',exact:true})});
  await ranking.getByText('246.8',{exact:true}).waitFor();
  await shot(manager,'05-总部更新后排名');
  const xlsx=await download(partner,'xlsx');
  assert.match(xlsx.toString('utf8'),/<v>246\.8<\/v>/);
  assert.match(xlsx.toString('utf8'),/正式统计采用的更正说明/);
  assert.equal((await download(partner,'pdf')).subarray(0,5).toString(),'%PDF-');
  const lineage={outlet,month,originalReport:baseReport.id,correctedReport:corrected.id,oldSettlement:original.id,newSettlement:current.id,task:task.id};
  fs.writeFileSync(path.join(folder,'B01-请求及业务编号.json'),JSON.stringify({lineage,evidence},null,2));
  console.log('PASS V34-B01 同一网点月报首报→运营审批→结算→收入更正→财务复核→重结→双方看板和真实双格式导出。加盟商使用 Chrome 界面。',lineage);
  evidence.length=0;

  // The sample adjustment is a reviewed amount supplied to an isolated fixture. No proration formula is implied.
  const openForm=(tab,command)=>tab.locator(`.actions [data-action=op-form][data-cmd="${command}"]`).first().click();
  await nav(manager,'contracts','协议与定价');
  await openForm(manager,'plan.publish');
  const plan=await submit(manager,'plan.publish',{name:'隔离整月服务方案',amount:'315.25',serviceEntity:'隔离服务主体',collectionEntity:'隔离收款主体',invoiceEntity:'隔离开票主体',terms:'整月样例条款',reason:'仅用于本地闭环验证'});
  await openForm(manager,'agreement.create');
  const agreement=await submit(manager,'agreement.create',{outlet,planId:plan.id,startMonth:'2026-10',endMonth:'2027-01',billDay:1,dueDay:5,reference:'V34-ISOLATED-B02',reason:'仅用于本地闭环验证'});
  await nav(finance,'contracts','协议与定价');
  await openForm(finance,'billing.generate');
  const bill=await submit(finance,'billing.generate',{agreementId:agreement.id,month});
  assert.equal(bill.amount,315.25);assert.equal(bill.status,'unpaid');
  await nav(partner,'billing','服务费管理');
  const payment=await commandAction(partner,'payment.start',partner.locator(`[data-action=pay][data-id="${bill.id}"]`));
  await commandAction(partner,'payment.resolve',partner.locator(`[data-action=payment-result][data-id="${payment.id}"][data-outcome=success]`));
  const paid=app.store.load();
  const receipts=paid.receipts.filter(row=>row.billId===bill.id);
  assert.equal(receipts.length,1);assert.equal(receipts[0].amount,315.25);assert.equal(receipts[0].adapterMode,'mock');
  await nav(finance,'billing','服务费管理');
  const paidDialog=await billDetail(finance,bill.id,'finance');
  assert.match(await paidDialog.locator('.pair').filter({hasText:'累计实收'}).innerText(),/315\.25/);
  await shot(finance,'06-总部核对模拟实收');
  await finance.locator('dialog [data-action=close]').click();
  await partner.getByRole('button',{name:'申请暂停收费',exact:true}).click();
  await partner.locator('form[data-command="request.submit"] [name=outlet]').selectOption(outlet);
  const pause=await submit(partner,'request.submit',{from:'2026-11-10',to:'2026-11-19',reason:'隔离演练暂停十天，不授权自动折算'});
  async function requestStage(tab,label){
   await nav(tab,'requests','业务申请与审批');
   const card=tab.locator('.record').filter({hasText:pause.id});
   await card.getByText(label,{exact:true}).waitFor();
   return card;
  }
  await nav(finance,'requests','业务申请与审批');
  await submit(finance,'review.request',{note:'审批暂停申请，金额须后续核算'});
  await requestStage(finance,'待核算费用');
  await requestStage(partner,'待核算费用');
  const adjustment=app.store.load().adjustments.find(row=>row.requestId===pause.id);
  assert.equal(adjustment.status,'待财务核算调整');assert.equal(adjustment.amount,null);assert.equal(adjustment.serviceUntil,null);
  await ops.goto(base+'/#queue=hq&kind=fee_calculation');
  await ops.getByRole('link',{name:'查看业务',exact:true}).click();
  await ops.getByRole('button',{name:'提出费用调整',exact:true}).click();
  const proposal=await submit(ops,'fee.adjust.propose',{amount:'30.25',offsetMonth:'2026-12',reason:'隔离凭据样例已核准抵扣 30.25 元，不按暂停天数计算'});
  assert.equal(proposal.adjustmentId,adjustment.id);
  await requestStage(partner,'待财务复核');
  await finance.goto(base+'/#queue=finance&kind=fee_proposal_review');
  await finance.getByRole('link',{name:'查看业务',exact:true}).click();
  await finance.getByRole('button',{name:'复核处理',exact:true}).click();
  await submit(finance,'fee.adjust.review',{note:'独立核对隔离核准抵扣金额和账期'});
  await finance.getByText('复核服务费核算',{exact:true}).waitFor();
  await shot(finance,'07-费用复核历史');
  await requestStage(partner,'待抵扣入账');
  app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify('2026-12-01'));
  await nav(finance,'contracts','协议与定价');
  await openForm(finance,'billing.generate');
  const adjustedBill=await submit(finance,'billing.generate',{agreementId:agreement.id,month:'2026-12'});
  assert.equal(adjustedBill.grossAmount,315.25);assert.equal(adjustedBill.creditAmount,30.25);assert.equal(adjustedBill.amount,285);
  assert.deepEqual(adjustedBill.adjustmentIds,[adjustment.id]);
  const credited=await requestStage(partner,'已抵扣入账');
  await shot(partner,'08a-加盟商暂停收费实效');
  const [creditDetail]=await Promise.all([
   partner.waitForResponse(response=>new URL(response.url()).pathname==='/api/finance/bills/'+adjustedBill.id),
   credited.getByRole('button',{name:'查看原抵扣账单'}).click(),
  ]);
  assert.equal(creditDetail.status(),200);
  await partner.locator('dialog [data-action=close]').click();
  for(const [tab,actor,label] of [[partner,'partnerA','08-加盟商抵扣账单'],[finance,'finance','09-总部抵扣账单']]){
   await tab.reload();
   await nav(tab,'billing','服务费管理');
   const dialog=await billDetail(tab,adjustedBill.id,actor);
   assert.match(await dialog.locator('.pair').filter({hasText:'应收金额'}).innerText(),/285\.00/);
   await dialog.getByRole('button',{name:'原抵扣来源 1'}).click();
   assert.match(await dialog.locator('.pair').filter({hasText:'原抵扣金额'}).innerText(),/30\.25/);
   await shot(tab,label);
  }
  const reconciled=app.store.load();
  assert.equal(reconciled.adjustments.find(row=>row.id===adjustment.id).appliedBillId,adjustedBill.id);
  assert.equal(reconciled.bills.find(row=>row.id===bill.id).status,'paid');
  assert.deepEqual(reconciled.receipts.filter(row=>row.billId===bill.id).map(row=>row.id),[receipts[0].id]);
  assert.deepEqual(errors,[]);
  const financialLineage={outlet,agreement:agreement.id,originalBill:bill.id,payment:payment.id,receipt:receipts[0].id,pause:pause.id,adjustment:adjustment.id,proposal:proposal.id,adjustedBill:adjustedBill.id};
  fs.writeFileSync(path.join(folder,'B02-请求及业务编号.json'),JSON.stringify({lineage:financialLineage,evidence},null,2));
  console.log('PASS V34-B02 同一协议下自然月账单→隔离模拟收款→暂停收费→待核算、提案、独立复核→后续账期抵扣→双方账单一致。',financialLineage);
 }finally{
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
