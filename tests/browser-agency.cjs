'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const {createServer}=require('../server/index.cjs');
const {openWorkspacePage}=require('./workspace-nav-helper.cjs');
const output=path.resolve(__dirname,'../var/agency-acceptance/round-01/chrome');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+app.server.address().port;
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],evidence=[];
 page.on('pageerror',error=>errors.push(error.message));
 const record=(id,detail)=>{evidence.push({id,detail,status:'passed'});console.log('PASS',id,detail);};
 const login=async actor=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(url);await page.locator('.side, select[name="actor"]').first().waitFor();
  if(await page.locator('[data-action="logout"]').count())await page.locator('[data-action="logout"]').click();
  await page.locator('select[name="actor"]').selectOption(actor);
  await page.locator('form[data-command="login"] button[type="submit"]').click();
  await page.locator('.side').waitFor();await page.waitForTimeout(150);
 };
 const nav=async name=>{await openWorkspacePage(page,name);await page.waitForTimeout(200);};
 const submit=async(command,fill={},selects={})=>{
  const form=page.locator(`form[data-command="${command}"]`).first();
  await form.waitFor({state:'visible'});
  for(const [name,value] of Object.entries(fill))await form.locator(`[name="${name}"]`).fill(String(value));
  for(const [name,value] of Object.entries(selects))await form.locator(`[name="${name}"]`).selectOption(value);
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(300);
 };
 try{
  await login('manager');
  await nav('accounts');
  await page.screenshot({path:path.join(output,'01-accounts-before.png'),fullPage:true});
  assert.ok(await page.getByText('代理层级与直属关系',{exact:true}).count());
  assert.ok(await page.getByText('未设置（历史主体）',{exact:false}).count());
  record('AGT-WEB-01','总部「网点与账号」显示主体级别与直属关系面板；历史主体标记未设置');

  await submit('agency.level',{reason:'总部确认一级代理'},{owner:'p1',level:'1'});
  await submit('agency.level',{reason:'总部确认二级代理'},{owner:'p2',level:'2'});
  await page.waitForTimeout(300);
  assert.equal(app.store.load().organizations.find(org=>org.id==='p1').level,1);
  assert.equal(app.store.load().organizations.find(org=>org.id==='p2').level,2);
  await submit('agency.bind',{reason:'总部确认直属绑定'},{parentOwner:'p1',childOwner:'p2'});
  await page.waitForTimeout(400);
  const relations=app.store.load().agencyRelations;
  assert.equal(relations.length,1);
  assert.deepEqual({parent:relations[0].parentOwner,child:relations[0].childOwner,status:relations[0].status},{parent:'p1',child:'p2',status:'active'});
  assert.ok(await page.getByText('示范加盟商甲 → 示范加盟商乙',{exact:false}).count());
  assert.ok(await page.getByText('一级代理',{exact:false}).count());
  assert.ok(await page.getByText('二级代理',{exact:false}).count());
  await page.screenshot({path:path.join(output,'02-accounts-bound.png'),fullPage:true});
  record('AGT-WEB-02','管理层通过真实表单设置一级/二级并绑定直属关系，数据库保留生效关系');

  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(250);
  await page.screenshot({path:path.join(output,'03-accounts-390.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  record('AGT-WEB-03','390px 总部账号页无横向溢出，代理关系面板可读');

  await login('partnerA');
  await nav('accounts');
  assert.equal(await page.getByText('代理层级与直属关系',{exact:true}).count(),0);
  assert.equal(await page.getByText('总部维护',{exact:true}).count(),0);
  record('AGT-WEB-04','加盟商账号看不到总部代理关系维护面板');

  assert.deepEqual(errors,[]);
  assert.deepEqual(evidence.filter(row=>row.status!=='passed'),[]);
 }catch(error){
  console.error(error);evidence.push({status:'failed',error:error.stack});
  await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});process.exitCode=1;
 }finally{
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({evidence,errors},null,2));
  await browser.close();await new Promise(resolve=>app.server.close(resolve));app.store.close();
 }
})();