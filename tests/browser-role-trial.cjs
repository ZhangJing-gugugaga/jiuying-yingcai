'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { startRoleTrial } = require('../scripts/role-trial.cjs');

function nativePages(base){
  Object.assign(require('../miniprogram/config'),{apiBase:base,development:true,roleTrial:true});
  const storage=new Map(),files=new Map(),requests=[];
  let shown,destination;
  const navigate=options=>{destination=options.url;options.success?.();};
  global.getCurrentPages=()=>shown?[shown]:[];
  global.wx={
    getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value),removeStorageSync:key=>storage.delete(key),
    navigateTo:navigate,reLaunch:navigate,switchTab:navigate,showToast(){},pageScrollTo(){},
    showModal(options){options.success({confirm:true});},
    request:async options=>{
      try{
        const result=await fetch(options.url,{method:options.method,headers:options.header,
          ...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
        const body=await result.json();
        requests.push({path:new URL(options.url).pathname,status:result.status,id:body.requestId,command:options.data?.command});
        options.success({statusCode:result.status,data:body});
      }catch(error){options.fail(error);}
    },
    downloadFile:async options=>{
      const result=await fetch(options.url,{headers:options.header});
      const tempFilePath='wxfile://sample-'+files.size;
      files.set(tempFilePath,await result.blob());
      options.success({statusCode:result.status,tempFilePath});
    },
    uploadFile:async options=>{
      const form=new FormData();
      for(const [key,value] of Object.entries(options.formData))form.set(key,value);
      form.set(options.name,files.get(options.filePath),'proof.png');
      const result=await fetch(options.url,{method:'POST',headers:options.header,body:form});
      const body=await result.json();
      requests.push({path:new URL(options.url).pathname,status:result.status,id:body.requestId});
      options.success({statusCode:result.status,data:JSON.stringify(body)});
    },
  };
  async function show(url){
    const next=new URL(url,base);
    let definition;
    global.Page=page=>{definition=page;};
    const file=require.resolve('../miniprogram'+next.pathname);
    delete require.cache[file];
    require(file);
    const view={...definition,route:next.pathname.slice(1),data:structuredClone(definition.data),setData(values){
      for(const [key,value] of Object.entries(values)){
        const keys=key.split('.');
        const leaf=keys.pop();
        const parent=keys.reduce((node,field)=>node[field]??={},this.data);
        parent[leaf]=value;
      }
    }};
    shown?.onHide?.();
    shown=view;
    view.onLoad?.(Object.fromEntries(next.searchParams));
    await view.onShow?.();
    return view;
  }
  return {show,requests,destination:()=>destination};
}

async function run() {
  let nativeOpenRequests=0;
  const trial = await startRoleTrial({
    directory:fs.mkdtempSync(path.join(os.tmpdir(),'jiuying-role-trial-ui-')),
    port:0,
    native:{project:'C:\\trial-native-project',open:async()=>{nativeOpenRequests+=1;}},
  });
  let browser;
  try {
    // The returned report is deliberately older than the report tab's default month.
    trial.app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify('2026-12-03'));
    browser = await chromium.launch({channel:'chrome',headless:true});
    const page = await browser.newPage({viewport:{width:1280,height:850}});
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(trial.url);
    const bar = page.getByRole('region',{name:'三角色试用'});
    const reportLink = bar.getByRole('button',{name:'查看这笔月报',exact:true});
    async function switchTo(name) {
      await bar.getByRole('button',{name,exact:true}).click();
      await bar.getByRole('button',{name,exact:true,pressed:true}).waitFor();
    }
    async function submitCommand(name, action) {
      const [response] = await Promise.all([
        page.waitForResponse(result=>result.url().endsWith('/api/commands')&&
          result.request().postDataJSON().command===name),
        action.click(),
      ]);
      assert.equal(response.status(),200);
      return (await response.json()).requestId;
    }

    await switchTo('一级管理员');
    assert.equal(await page.locator('.nav [data-page="team"]').count(),0);
    await reportLink.click();
    const review = page.locator('form[data-command="review.report"]');
    await review.locator('[name="decision"]').selectOption('return');
    await review.locator('[name="note"]').fill('请补充三角色试用的客流说明');
    const returnRequest = await submitCommand('review.report',review.getByRole('button',{name:'确认审核',exact:true}));
    await page.getByText('已保存至后台数据库',{exact:true}).waitFor();

    assert.equal(await bar.getByRole('button',{name:'查看这笔加盟申请'}).count(),0);
    await bar.getByRole('button',{name:'加盟商',exact:true}).click();
    const modal=page.getByRole('dialog');
    await modal.getByText(/已发送打开指令/).waitFor();
    assert.equal(nativeOpenRequests,1);
    await modal.getByRole('button',{name:'关闭',exact:true}).click();
    assert.equal(await bar.getByRole('button',{name:'一级管理员',pressed:true}).count(),1);

    const native=nativePages(trial.url);
    const home=await native.show('/pages/home/index');
    assert.equal(home.data.session.role,'partner');
    assert.equal(home.data.outletCount,3);
    const tap=dataset=>({currentTarget:{dataset}});
    const otherReports=()=>trial.app.store.db.prepare(
      "SELECT id,outlet,month,version,status,amount_cents FROM reports WHERE outlet<>'zz' OR month<>'2026-10' ORDER BY id"
    ).all();
    const otherScopeBefore=otherReports();
    home.nav(tap({page:'tasks'}));
    assert.equal(native.destination(),'/pages/tasks/index');
    const matters=await native.show(native.destination());
    const returnedTask=matters.data.state.businessTasks.find(row=>row.kind==='report_returned');
    assert.equal(returnedTask?.outlet,'zz');
    assert.equal(returnedTask?.month,'2026-10');
    await matters.open(tap({id:returnedTask.id}));
    const returnedUrl=native.destination();
    const returnedScope=new URL(returnedUrl,trial.url).searchParams;
    assert.equal(returnedScope.get('outlet'),'zz');
    assert.equal(returnedScope.get('month'),'2026-10');
    const returned=await native.show(returnedUrl);
    assert.equal(returned.data.linkedVersion?.id,returnedTask.recordId);
    assert.equal(returned.data.returnedReason,'请补充三角色试用的客流说明');
    assert.equal(returned.data.currentAction,'修改并重新提交');
    await returned.continueReport();
    const report=returned;
    assert.equal(report.data.outletId,'zz');
    assert.equal(report.data.month,'2026-10');
    assert.equal(report.data.canSubmit,true);
    report.submit({detail:{value:{...report.data.form,traffic:'26'}}});
    assert.equal(report.data.inlineConfirmation,true,report.data.error);
    await report.confirmSubmit();
    const submitRequest=native.requests.find(row=>row.command==='report.submit'&&row.status===200)?.id;
    assert.ok(submitRequest);
    const resubmitted=report.data.latestSubmittedVersion;
    assert.equal(resubmitted.version,2);
    assert.equal(resubmitted.status,'pending');
    assert.equal(resubmitted.traffic,26);
    assert.deepEqual(otherReports(),otherScopeBefore);

    const backHome=await native.show('/pages/home/index');
    backHome.nav(tap({page:'reports',query:'outlet=all'}));
    const list=await native.show(native.destination());
    assert.equal(list.data.month,'2026-11');
    await list.changeMonth({detail:{value:'2026-10'}});
    assert.equal(list.data.month,'2026-10');
    assert.equal(list.data.outlet,'all');
    const row=list.data.reportRows.find(item=>item.outletId==='zz');
    assert.equal(row?.reportId,resubmitted.id);
    list.open(tap({outlet:'zz',month:'2026-10',reportId:row.reportId}));
    const reopenedMonthly=await native.show(native.destination());
    assert.equal(reopenedMonthly.data.linkedVersion?.id,resubmitted.id);
    assert.equal(reopenedMonthly.data.linkedVersion?.status,'pending');
    const history=await native.show('/pages/tasks/index?section=notices');
    const originalNotice=history.data.noticeRows.find(item=>item.recordId===returnedTask.recordId&&item.title==='月报退回');
    assert.ok(originalNotice);
    await history.open(tap({id:originalNotice.id}));
    assert.equal(native.destination(),returnedUrl);
    const original=await native.show(native.destination());
    assert.equal(original.data.linkedVersion?.id,returnedTask.recordId);
    assert.equal(original.data.linkedVersion?.version,1);
    assert.equal(original.data.currentAction,'查看当前月报');
    assert.equal(original.data.canSubmit,false);

    await switchTo('总管理员');
    assert.equal(await page.locator('.nav [data-page="team"]').count(),1);
    await reportLink.click();
    await page.locator('.record').filter({hasText:'株洲示范网点B'}).filter({hasText:/V2/}).waitFor();

    const openApplication=()=>bar.getByRole('button',{name:'查看这笔加盟申请',exact:true}).click();
    async function reviewApplication(action,name){
      const [result]=await Promise.all([page.waitForResponse(response=>response.url().endsWith('/review')&&response.request().method()==='POST'),
        modal.getByRole('button',{name,exact:true}).click()]);
      assert.equal(result.status(),200);
      const body=await result.json();
      assert.equal(body.data.status,action);
      return body.requestId;
    }
    await openApplication();
    await modal.getByAltText('申请人提交的付款截图').waitFor({state:'visible'});
    await modal.locator('[name="note"]').fill('请补充完整付款时间');
    const paymentReturn=await reviewApplication('returned','退回补充');
    await modal.waitFor({state:'hidden'});
    const partnerHome=await native.show('/pages/home/index');
    await partnerHome.openTrialApplication();
    const applicantUrl=native.destination();
    const join=await native.show(applicantUrl);
    assert.equal(join.data.formMode,'supplement');
    assert.equal(join.data.record.reviewNote,'请补充完整付款时间');
    await join.choosePhoto({currentTarget:{dataset:{sample:'1'}}});
    assert.ok(join.data.photo?.file.id,join.data.formError);
    await join.submit();
    assert.equal(join.data.record.version,2);
    assert.equal(join.data.record.status,'pending');
    const proofUpload=native.requests.find(row=>row.path==='/api/files'&&row.status===201)?.id;
    assert.ok(proofUpload);

    await openApplication();
    await modal.getByAltText('申请人提交的付款截图').waitFor({state:'visible'});
    await modal.getByRole('button',{name:'通过审核',exact:true}).click();
    await modal.getByRole('alert').getByText('请核对试用付款截图，并填写 4 至 100 个字符的试用凭证号。').waitFor();
    await modal.locator('[name="settlementReference"]').fill('TRIAL-20261121-01');
    await modal.getByLabel('我已核对试用付款截图').check();
    const paymentApproval=await reviewApplication('approved','通过审核');
    join.trialNotices();
    const notices=await native.show(native.destination());
    const approval=notices.data.noticeRows.find(row=>row.title==='加盟申请已通过');
    assert.equal(approval?.recordId,join.data.record.id);
    assert.equal(approval.read,false);
    await notices.open({currentTarget:{dataset:{id:approval.id,kind:'message'}}});
    assert.equal(native.destination(),applicantUrl);
    const approved=await native.show(native.destination());
    assert.equal(approved.data.record.status,'approved');
    assert.equal(approved.data.record.activationStatus,'not_issued');
    await modal.getByText('待签发激活码',{exact:true}).waitFor();
    const [activationResponse]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/auth/activation')&&response.request().method()==='POST'),
      modal.getByRole('button',{name:'签发激活码',exact:true}).click(),
    ]);
    assert.equal(activationResponse.status(),200);
    const {data:invite,requestId:activationIssue}=await activationResponse.json();
    const activationToken=await modal.locator('[name="activationToken"]').inputValue();
    assert.equal(activationToken,invite.token);
    await modal.getByRole('button',{name:'返回原申请',exact:true}).click();
    await modal.getByText('已签发，待激活',{exact:true}).waitFor();
    await approved.refresh();
    assert.equal(approved.data.record.activationStatus,'issued');
    approved.login();
    const activationPage=await native.show(native.destination());
    assert.equal(activationPage.data.mode,'activate');
    assert.ok(!native.destination().includes(activationToken));
    const password='Temporary-Role-Trial-Pass-243!';
    activationPage.setData({activationToken,password,confirmPassword:password});
    await activationPage.activate();
    const activated=await native.show(native.destination());
    assert.equal(activated.data.session?.subject,invite.actor);
    assert.equal(activated.data.publicView,false);
    assert.equal(activated.data.firstOutlet?.actionText,'申请新增网点');
    const reopened=await native.show('/pages/home/index');
    assert.equal(reopened.data.session?.subject,invite.actor);
    await require('../miniprogram/utils/api').logout({navigate:false});
    const anonymous=await native.show('/pages/home/index');
    assert.equal(anonymous.data.publicView,true);
    assert.notEqual(anonymous.data.session?.subject,'partnerA');
    const signIn=await native.show('/pages/login/index');
    signIn.setData({username:invite.username,password});
    await signIn.passwordLogin();
    const signedIn=await native.show(native.destination());
    assert.equal(signedIn.data.session?.subject,invite.actor);
    await modal.getByRole('button',{name:'关闭',exact:true}).click();
    await openApplication();
    await modal.getByText('账号已激活',{exact:true}).waitFor();
    assert.equal(await modal.getByRole('button',{name:'签发激活码',exact:true}).count(),0);
    const activationRedeem=native.requests.find(row=>row.path==='/api/auth/activate'&&row.status===200)?.id;
    assert.ok(activationRedeem);
    assert.deepEqual(errors,[]);
    const evidence = {status:'passed',independentFixture:true,nativeVerification:'Page handlers with HTTP, SQLite and multipart upload',
      monthlyReport:{outlet:'zz',month:'2026-10',originalId:returnedTask.recordId,latestId:resubmitted.id,
        originalNoticeId:originalNotice.id,latestStatus:resubmitted.status,defaultListMonth:'2026-11',otherScopesUnchanged:true},
      requestIds:{returnRequest,submitRequest,paymentReturn,proofUpload,paymentApproval,activationIssue,activationRedeem}};
    if(process.env.JIUYING_ROLE_TRIAL_EVIDENCE){
      const output=path.resolve(process.env.JIUYING_ROLE_TRIAL_EVIDENCE);
      fs.mkdirSync(output,{recursive:true});
      await page.screenshot({path:path.join(output,'三角色试用窗.png')});
      fs.writeFileSync(path.join(output,'browser-check.json'),JSON.stringify(evidence,null,2));
    }
    console.log(JSON.stringify(evidence));
  } finally {
    if(browser)await browser.close();
    await trial.stop();
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
