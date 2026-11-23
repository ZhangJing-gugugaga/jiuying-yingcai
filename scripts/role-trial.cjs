'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');

const local = '127.0.0.1';
const trialEnvironment = { NODE_ENV:'test', ADAPTER_MODE:'mock' };
const defaultPort = 18974;
const defaultDirectory = path.resolve(__dirname, '../execution/role-trial');
const profiles = [
  {actor:'trial-director',role:'manager',surface:'web',label:'总管理员',responsibility:'后台 · 管理人员、审核加盟付款'},
  {actor:'trial-operator',role:'ops',surface:'web',label:'一级管理员',responsibility:'后台 · 接收指定网点任务、审核月报'},
  {actor:'partnerA',role:'partner',surface:'miniprogram',label:'加盟商',responsibility:'微信小程序 · 工作台、付款补交和通知'},
];
const trialApplicant={name:'试用申请人',mobile:'19900008972',organization:'九盈英才隔离加盟样例'};

async function open({ dbPath, roleTrial, roleTrialControls, port }) {
  const app = createServer({dbPath,env:trialEnvironment,roleTrial,roleTrialControls});
  try {
    await new Promise((resolve,reject)=>{
      app.server.once('error',reject);
      app.server.listen(port,local,()=>{
        app.server.removeListener('error',reject);
        resolve();
      });
    });
  } catch (error) {
    app.store.close();
    throw error;
  }
  let closing;
  return {
    app,url:'http://'+local+':'+app.server.address().port,
    stop(){
      closing ||= new Promise(resolve=>{
        app.server.close(()=>{app.store.close();resolve();});
        app.server.closeAllConnections();
      });
      return closing;
    },
  };
}

function apiRequest(base){
  return async (route,body,token) => {
    const response=await fetch(base+'/api'+route,{
      method:'POST',
      headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),
        ...(token?{Authorization:'Bearer '+token}:{})},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(10000),
    });
    const result=await response.json();
    if(!response.ok)throw new Error((result.error?.message||route)+' · 请求编号 '+result.requestId);
    return result.data;
  };
}

async function seed(dbPath) {
  const trial = await open({dbPath,port:0});
  const request = apiRequest(trial.url);
  const login=actor=>request('/auth/dev',{actor});
  const command=async (session,command,payload)=>(await request('/commands',{command,payload},session.token)).result;

  try {
    const state=trial.app.store.load();
    state.today='2026-11-21';
    trial.app.store.transaction(()=>trial.app.store.save(state));
    const root=await login('manager');
    for(const profile of profiles){
      if(profile.role!=='partner'){
        await command(root,'staff.create',{subject:profile.actor,name:'隔离试用'+profile.label,role:profile.role,reason:'建立三角色试用账号'});
      }
      const issued=await request('/auth/activation',{actor:profile.actor,username:profile.actor.toLowerCase()},root.token);
      await request('/auth/activate',{token:issued.token,password:randomUUID()+'-Trial!'});
    }
    const director=await login(profiles[0].actor);
    const partner=await login('partnerA');
    const reportScope={outlet:'zz',month:'2026-10'};
    await command(director,'routing.set',{outlet:reportScope.outlet,kind:'report_review',assigneeRole:'ops',
      assigneeUserId:profiles[1].actor,enabled:true,reason:'把株洲网点试用月报分派给指定的一级管理员'});
    const report=await command(partner,'report.submit',{...reportScope,revenue:1245.61,orders:12,traffic:25,enroll:null,
      note:'三角色试用月报，一级管理员可退回，加盟商可补充后重新提交。'});

    await command(director,'routing.set',{outlet:'cs',kind:'request_review',assigneeRole:'ops',
      assigneeUserId:profiles[1].actor,enabled:true,reason:'把长沙网点试用申请分派给指定的一级管理员'});
    const requestRecord=await command(partner,'request.submit',{outlet:'cs',type:'statusChange',
      data:{status:'paused',effectiveDate:state.today,reason:'隔离试用 · 长沙网点申请暂停营业'}});
    const bill=trial.app.store.load().bills.find(row=>row.outlet==='cs'&&row.month==='2026-11');
    if(!bill)throw new Error('试用账单缺失，请检查隔离样本。');
    return {report:{...reportScope,id:report.id,outletName:'株洲示范网点B'},
      bill:{id:bill.id,outlet:bill.outlet,month:bill.month},requestId:requestRecord.id};
  } finally {
    await trial.stop();
  }
}

function sampleImage(title,detail){
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="390">
    <rect width="640" height="390" fill="#f0f6ff"/><rect x="39" y="40" width="562" height="310" rx="22" fill="white"/>
    <rect x="39" y="40" width="562" height="10" fill="#1a64bd"/>
    <g fill="#18325a" font-family="sans-serif"><text x="75" y="110" font-size="23" fill="#1762b6">JIUYING · TEST ONLY</text>
    <text x="75" y="172" font-size="34" font-weight="bold">${title}</text>
    <text x="75" y="220" font-size="21">${detail}</text>
    <text x="75" y="305" font-size="22" fill="#9b3c21">SAMPLE · NO REAL PAYMENT</text></g></svg>`)).png().toBuffer();
}

async function seedOnboarding(dbPath){
  const trial=await open({dbPath,port:0});
  try{
    const stored=trial.app.store.db.prepare('SELECT id,applicant_subject AS subject FROM onboarding_applications WHERE mobile=?').get(trialApplicant.mobile);
    if(stored)return {...stored};
    const request=apiRequest(trial.url);
    const manager=await request('/auth/dev',{actor:'trial-director'});
    const applicant=await request('/auth/visitor',{});
    const upload=(session,purpose,name,bytes)=>request('/files',{purpose,name,type:'image/png',base64:bytes.toString('base64')},session.token);
    const [poster,receipt]=await Promise.all([
      sampleImage('Demo collection sign','Non-scannable training image'),
      sampleImage('Payment screenshot V1','Original sample · payment time missing'),
    ]);
    const qr=await upload(manager,'onboarding-qr','隔离收款示意.png',poster);
    await request('/onboarding/config',{qrFileId:qr.id,payee:'九盈英才试用收款主体（无真实付款）',confirmed:true},manager.token);
    const proof=await upload(applicant,'onboarding-proof','加盟付款试用截图.png',receipt);
    const record=await request('/onboarding/applications',{...trialApplicant,fileId:proof.id,qrFileId:qr.id,
      note:'三角色试用。请退回核对付款时间，再补交图片并审批。'},applicant.token);
    return {id:record.id,subject:applicant.subject};
  }finally{await trial.stop();}
}

async function startRoleTrial({directory=defaultDirectory,port=defaultPort,native}={}){
  fs.mkdirSync(directory,{recursive:true});
  const marker=path.join(directory,'trial-state.json');
  let fixture;
  if(fs.existsSync(marker)){
    fixture=JSON.parse(fs.readFileSync(marker,'utf8'));
    if(!/^trial-[a-f0-9-]{36}\.sqlite$/.test(fixture.database)||!fixture.report?.id||
      !fs.existsSync(path.join(directory,fixture.database)))throw new Error('试用数据索引无效，请核对试用目录。');
  } else {
    const database='trial-'+randomUUID()+'.sqlite';
    fixture={database,...await seed(path.join(directory,database))};
  }
  const dbPath=path.join(directory,fixture.database);
  if(!fixture.onboarding){
    fixture.onboarding=await seedOnboarding(dbPath);
    const staging=path.join(directory,'trial-state-'+randomUUID()+'.json');
    fs.writeFileSync(staging,JSON.stringify(fixture,null,2),{flag:'wx'});
    fs.renameSync(staging,marker);
  }
  const {report,bill}=fixture;
  return open({dbPath,roleTrial:{profiles,report,bill,activationProgress:true,onboarding:{id:fixture.onboarding.id,organization:trialApplicant.organization},
    nativeProject:native?.project},roleTrialControls:{applicantSubject:fixture.onboarding.subject,openNative:native?.open,
    supplementImage:await sampleImage('Payment screenshot V2','Sample payment time · 2026-11-21 10:30')},port});
}

if(require.main===module){
  const {prepareNative}=require('./role-trial-native.cjs');
  Promise.resolve().then(()=>startRoleTrial({native:prepareNative(defaultDirectory,defaultPort)})).then(trial=>{
    console.log(JSON.stringify({status:'ready',url:trial.url,directory:defaultDirectory}));
    process.once('SIGINT',()=>trial.stop().catch(console.error));
    process.once('SIGTERM',()=>trial.stop().catch(console.error));
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}

module.exports={startRoleTrial};
