'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {createServer}=require('../server/index.cjs');
const output=path.resolve(process.env.FINANCE_BROWSER_OUTPUT||path.join(__dirname,'../../evidence/finance-browser'));

(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 let browser;
 try{
  const state=app.store.load(),bill=state.bills.find(x=>x.outlet==='cs');
  Object.assign(bill,{status:'paid',amount:209.07});
  for(let i=0;i<207;i++)state.receipts.push({id:'finance-browser-receipt-'+String(i).padStart(3,'0'),billId:bill.id,
   owner:bill.owner,outlet:bill.outlet,status:'success',amount:1.01,adapterMode:'mock'});
  state.refundRequests.push({id:'finance-browser-refund',receiptId:state.receipts[0].id,billId:bill.id,owner:bill.owner,
   outlet:bill.outlet,status:'recorded',amount:0.01,adapterMode:'mock'});
  // Only the isolated imported-ledger fixture can have multiple receipts for the same bill.
  app.store.db.exec('DROP INDEX receipt_bill_unique');
  app.store.transaction(()=>app.store.save(state));
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1440,height:1050},acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  async function login(actor){
   await page.goto(url);
   await page.locator('.side, select[name=actor]').first().waitFor();
   if(await page.locator('[data-action=logout]').count())await page.locator('[data-action=logout]').click();
   await page.locator('select[name=actor]').selectOption(actor);
   await page.locator('form[data-command=login] button[type=submit]').click();
   await page.locator('.nav [data-page=billing]').click();
   await page.getByRole('heading',{name:'服务费管理',exact:true}).waitFor();
  }
  await login('manager');
  await page.getByRole('heading',{name:'账务汇总',exact:true}).waitFor();
  const row=page.locator('tr').filter({has:page.getByText(bill.id,{exact:false})});
  assert.match(await row.textContent(),/209\.07.*209\.07.*0\.01.*209\.06/);
  await page.screenshot({path:path.join(output,'01-hq-ledger.png'),fullPage:true});
  await row.getByRole('button',{name:'账单详情'}).click();
  const dialog=page.locator('dialog[open]');
  await dialog.getByRole('button',{name:'原实收流水 207'}).click();
  await dialog.getByText('finance-browser-receipt-206',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'下一页',exact:true}).click();
  await dialog.getByText('finance-browser-receipt-186',{exact:true}).waitFor();
  assert.match(await dialog.textContent(),/209\.07.*0\.01.*209\.06/);
  await page.screenshot({path:path.join(output,'02-hq-receipt-page.png'),fullPage:true});
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出账务 CSV'}).click();
  const exported=await download;
  const dest=path.join(output,'03-hq-ledger.csv');
  await exported.saveAs(dest);
  assert.match(fs.readFileSync(dest,'utf8'),/209\.07","209\.07","0\.01","209\.06/);
  await login('ops');
  assert.equal(await page.getByRole('heading',{name:'账务汇总',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'导出账务 CSV'}).count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS HQ billing shows complete cash totals, receipt detail pagination, exported CSV and ops scope');
 }finally{
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});

