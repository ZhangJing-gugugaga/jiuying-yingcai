'use strict';

const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {mkdirSync}=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {createServer}=require('../server/index.cjs');

async function run(){
 const folder=path.resolve(process.argv[2]||'execution/v33-monthly-browser');
 mkdirSync(folder,{recursive:true});
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  const base='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[];
  const page=async()=>{
   const tab=await browser.newPage({viewport:{width:1440,height:1000}});
   tab.on('pageerror',error=>errors.push(error.message));
   return tab;
  };
  const manager=await page(),partner=await page(),ops=await page();
  async function api(route,token,body){
   const response=await fetch(base+'/api/'+route,{headers:{...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{}),...(token?{Authorization:'Bearer '+token}:{})},method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
   const data=await response.json();
   assert.equal(response.status,200,JSON.stringify(data));
   return data.data;
  }
  const tokens={};
  for(const actor of ['manager','partnerA','ops','finance'])tokens[actor]=(await api('auth/dev',null,{actor})).token;
  const command=async(actor,command,payload)=>(await api('commands',tokens[actor],{command,payload})).result;
  async function login(tab,actor){
   await tab.goto(base);
   await tab.locator('select[name=actor]').selectOption(actor);
   await tab.locator('form[data-command=login] button[type=submit]').click();
   await tab.locator('.side').waitFor();
  }
  const shot=(tab,name)=>tab.screenshot({path:path.join(folder,name+'.png'),fullPage:true});

  const month='2026-09',outlet='cs';
  const initial=(await api('reports/context?outlet='+outlet+'&month='+month,tokens.partnerA)).currentApprovedVersion;
  await command('partnerA','report.correct',{id:initial.id,reason:'浏览器复核收入更正'});
  const corrected=await command('partnerA','report.submit',{outlet,month,revenue:246.80,orders:9,traffic:19,enroll:2});
  await command('ops','review.report',{id:corrected.id,decision:'approve'});
  await command('finance','review.report',{id:corrected.id,decision:'approve'});
  await login(manager,'manager');
  await manager.goto(base+'/#queue=hq&kind=report_resettlement');
  await manager.getByRole('link',{name:'查看业务',exact:true}).click();
  await manager.getByRole('heading',{name:'影响记录',exact:true}).waitFor();
  await manager.getByText('长沙示范网点A · 月报更正通过',{exact:true}).waitFor();
  await shot(manager,'01-历史月报重结算待办');
  await manager.getByRole('button',{name:'确认重新结算',exact:true}).click();
  await manager.getByRole('heading',{name:'新结算快照',exact:true}).waitFor();
  await manager.getByText('V2 · ',{exact:false}).first().waitFor();
  await shot(manager,'02-重结算完成快照');
  const official=await api('dashboard?period='+month+'&outlet='+outlet,tokens.partnerA);
  assert.equal(official.totals.revenue,246.80);
  console.log('PASS D04 浏览器经理确认重结，原快照和影响记录保留，加盟商的已结算金额更新。');

  const req=await command('partnerA','request.submit',{type:'pauseFee',outlet, data:{from:'2026-10-01',to:'2026-10-31',reason:'浏览器私密申请演练'}});
  const pub='请补充本期申请材料',secret='HQ_FINANCE_BROWSER_PRIVATE';
  await command('finance','review.request',{id:req.id,decision:'supplement',note:secret,publicNote:pub});
  await manager.locator('.nav [data-page=requests]').click();
  await manager.getByText(secret,{exact:true}).waitFor();
  await manager.getByRole('button',{name:'审批与处理历史'}).click();
  await manager.getByRole('dialog').getByText(secret,{exact:true}).waitFor();
  await shot(manager,'03-总部审批分栏');
  await login(partner,'partnerA');
  await partner.locator('.nav [data-page=requests]').click();
  await partner.getByText(pub,{exact:true}).waitFor();
  await partner.getByRole('button',{name:'审批与处理历史'}).click();
  await partner.getByRole('dialog').getByText(pub,{exact:true}).waitFor();
  assert.equal(await partner.getByText(secret,{exact:true}).count(),0);
  assert.equal(await partner.getByText('查看原始审计',{exact:true}).count(),0);
  await shot(partner,'04-加盟商仅见处理说明');
  console.log('PASS D03 浏览器总部可复核内部及对外说明，加盟商详情和时间轴仅展示对外说明。');

  await command('ops','jobs.run',{outlet,limit:1});
  await login(ops,'ops');
  await ops.goto(base+'/#queue=ops&kind=report_missing&outlet='+outlet);
  await ops.getByText('已超期',{exact:true}).waitFor();
  assert.match(await ops.locator('.task-queue table').innerText(),/2026-11-05/);
  await shot(ops,'05-总部队列统一截止');
  console.log('PASS D08 浏览器运营队列按同一服务端日历口径展示 2026-11-05 截止和超期。');
  assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();
  await new Promise(resolve=>app.server.close(resolve));
  app.store.close();
 }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
