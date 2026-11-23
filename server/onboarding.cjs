'use strict';

const {createHash, createHmac, randomUUID, timingSafeEqual} = require('node:crypto');
const core = require('../shared/core.cjs');
const applicationIdPattern=/^join-[a-f0-9-]{36}$/;

function text(value,label,min,max) {
 const normalized=typeof value==='string'?value.trim():'';
 core.check(normalized.length>=min&&normalized.length<=max,'INPUT',label+'格式无效');
 return normalized;
}

function service(store,repo) {
 const {db}=store;
 const configRow=()=>db.prepare('SELECT * FROM onboarding_config WHERE id=1').get();
 const applicationDetails=`SELECT record.*, member.status AS account_status, credential.actor IS NOT NULL AS has_credentials,
   invitation.created_at AS activation_issued_at, invitation.expires_at AS activation_expires_at
   FROM onboarding_applications record
   LEFT JOIN accounts member ON member.owner=substr(record.account_actor,9)
   LEFT JOIN credentials credential ON credential.actor=record.account_actor
   LEFT JOIN activation_tokens invitation ON invitation.digest=(SELECT token.digest FROM activation_tokens token
     WHERE token.actor=record.account_actor AND token.consumed_at IS NULL ORDER BY token.created_at DESC,token.rowid DESC LIMIT 1)`;
 const find=id=>db.prepare(applicationDetails+' WHERE record.id=?').get(id);
 const invitee=who=>who.actor==='public';
 const hasAccess=(row,who)=>row&&(who.actor==='manager'||row.applicant_subject===who.subject||row.account_actor===who.principal);
 const managerOnly=who=>core.check(who.actor==='manager','FORBIDDEN','仅总管理员可管理加盟申请',403);
 const applicantOnly=who=>core.check(invitee(who),'FORBIDDEN','请从访客入口提交或找回加盟申请',403);
 function tracking(row) {
  const signature=createHmac('sha256',configRow().tracking_key).update(row.id).digest('base64url');
  return row.id+'.'+signature;
 }
 function activationStatus(row,who) {
  if(row.status!=='approved')return undefined;
  if(!['pending','active'].includes(row.account_status))return 'unavailable';
  if(row.account_status==='active'&&row.has_credentials)return 'activated';
  if(!row.activation_issued_at)return 'not_issued';
  return row.activation_expires_at>who.now?'issued':'expired';
 }
 function present(row,who) {
  const activation=activationStatus(row,who);
  return {id:row.id,status:row.status,version:row.version,name:row.name,mobile:row.mobile,
   organization:row.organization,fileId:row.file_id,payee:row.payee,note:row.applicant_note,
   reviewNote:row.review_note,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,
   ...(activation?{activationStatus:activation}:{}),
   ...(who.actor==='manager'?{accountActor:row.account_actor,settlementReference:row.settlement_reference,
    ...(activation?{accountStatus:row.account_status,activationIssuedAt:row.activation_issued_at,
     activationExpiresAt:row.activation_expires_at}:{})}:{}),
   ...(invitee(who)?{trackingCode:tracking(row)}:{})};
 }
 function audit(who,command,requestId,recordId,details={}) {
  const id='audit-'+randomUUID();
  const record={id,actor:who.actor,subject:who.subject,command,requestId,recordId,status:'completed',
   createdAt:who.now,executedAt:who.now,...details};
  db.prepare('INSERT INTO audit(id,status,data,created_at) VALUES(?,?,?,?)')
   .run(id,record.status,JSON.stringify(record),who.now);
  store.sealAudit();
 }
 function notify(who,row,owner,title,body) {
  const id='msg-'+randomUUID();
  const message={id,owner,status:'unread',read:false,recordId:row.id,target:'join',title,body,createdAt:who.now};
  db.prepare('INSERT INTO messages(id,owner,status,data,created_at) VALUES(?,?,?,?,?)')
   .run(id,owner,message.status,JSON.stringify(message),who.now);
 }
 function write(who,key,action,payload,fn) {
  core.check(typeof key==='string'&&key.length>=8&&key.length<=128,'IDEMPOTENCY_KEY','请重新提交申请操作');
  const fingerprint=createHash('sha256').update(JSON.stringify([action,payload])).digest('hex');
  return store.transaction(()=>{
   const prior=db.prepare('SELECT request_hash,result FROM idempotency WHERE subject=? AND key=?').get(who.subject,key);
   if(prior)core.check(prior.request_hash===fingerprint,'CONFLICT','请重新发起已修改的操作',409);
   const row=prior?find(JSON.parse(prior.result).onboardingId):fn();
   core.check(hasAccess(row,who),'NOT_FOUND','加盟申请不存在或无权查看',404);
   if(!prior)db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)')
    .run(who.subject,key,fingerprint,JSON.stringify({onboardingId:row.id}),who.now);
   return present(row,who);
  });
 }
 function configuration(who) {
  const row=configRow();
  if(!row.enabled&&who.actor!=='manager')return {enabled:false};
  return {enabled:Boolean(row.enabled),qrFileId:row.qr_file_id,payee:row.payee};
 }
 function returnedApplication(who,id,version) {
  applicantOnly(who);
  core.check(typeof id==='string'&&applicationIdPattern.test(id),'INPUT','原加盟申请编号无效');
  const row=find(id);
  core.check(row?.applicant_subject===who.subject,'NOT_FOUND','可补交的原申请不存在',404);
  core.check(row.status==='returned','CONFLICT','原申请状态已更新，请重新查看',409);
  if(version!==undefined){
   core.check(Number.isSafeInteger(version)&&version>0,'INPUT','申请版本无效');
   core.check(row.version===version,'CONFLICT','原申请状态已更新，请重新查看',409);
  }
  return row;
 }
 function authorizeProofUpload(who,id,version) {
  applicantOnly(who);
  if(id===undefined&&version===undefined){
   core.check(configRow().enabled,'CONFLICT','加盟申请暂未开放',409);
   return null;
  }
  core.check(id!==undefined&&version!==undefined,'INPUT','补交截图须提供原申请与版本');
  const row=returnedApplication(who,id,version);
  return {id:row.id,version:row.version};
 }
 function configure(who,p,requestId) {
  managerOnly(who);
  return store.transaction(()=>{
   if(p.enabled===false){
    db.prepare('UPDATE onboarding_config SET enabled=0 WHERE id=1').run();
   }else{
    const payee=text(p.payee,'收款主体',2,120);
    core.check(p.confirmed===true,'INPUT','请确认收款码属于所列收款主体');
    const qr=db.prepare(`SELECT f.id FROM onboarding_files o JOIN files f ON f.id=o.file_id
     JOIN file_metadata m ON m.file_id=f.id WHERE f.id=? AND f.subject=? AND o.purpose='onboarding-qr'`).get(String(p.qrFileId||''),who.subject);
    core.check(qr,'INPUT','请选择当前账号上传的集团收款码');
    db.prepare('UPDATE onboarding_config SET enabled=1,qr_file_id=?,payee=? WHERE id=1').run(qr.id,payee);
   }
   const result=configuration(who);
   audit(who,'onboarding.configure',requestId,result.qrFileId,{enabled:result.enabled});
   return result;
  });
 }
 function list(who,query) {
  const {status='all',offset='0',limit='25',id}=query;
  const start=Number(offset),size=Number(limit);
  core.check(['all','pending','returned','approved'].includes(status)&&Number.isSafeInteger(start)&&start>=0&&Number.isInteger(size)&&size>=1&&size<=50,
   'INPUT','筛选或分页范围有误');
  const clause=who.actor==='manager'?'1':invitee(who)?'record.applicant_subject=?':'record.account_actor=?';
  const args=who.actor==='manager'?[]:[invitee(who)?who.subject:who.principal];
  const where=clause+(status==='all'?'':' AND record.status=?')+(id?' AND record.id=?':'');
  if(status!=='all')args.push(status);
  if(id)args.push(id);
  const total=db.prepare('SELECT count(*) n FROM onboarding_applications record WHERE '+where).get(...args).n;
  const rows=db.prepare(applicationDetails+' WHERE '+where+
   ' ORDER BY record.submitted_at DESC,record.id DESC LIMIT ? OFFSET ?').all(...args,size,start);
  return {items:rows.map(row=>present(row,who)),total,offset:start,limit:size,hasMore:start+rows.length<total};
 }
 function submit(who,p,key,requestId) {
  applicantOnly(who);
  return write(who,key,'onboarding.submit',p,()=>{
   const prior=p.id===undefined?null:returnedApplication(who,p.id,p.version);
   const scopedSupplement=!!prior&&p.version!==undefined;
   let cfg;
   if(!scopedSupplement){
    core.check(prior||p.version===undefined,'INPUT','新申请不可指定补交版本');
    cfg=configRow();
    core.check(cfg.enabled&&cfg.qr_file_id===p.qrFileId&&(!prior||(cfg.qr_file_id===prior.qr_file_id&&cfg.payee===prior.payee)),
     'CONFLICT',prior?'请通过原申请补交付款截图':'收款信息已更新，请重新核对后提交',409);
   }
   const name=text(p.name,'申请人姓名',1,80),organization=text(p.organization,'加盟主体',2,120);
   const mobile=text(p.mobile,'手机号',11,11),note=text(p.note,'申请说明',0,500);
   core.check(/^1[3-9]\d{9}$/.test(mobile),'INPUT','请填写有效的手机号');
   const upload=db.prepare(`SELECT f.id,f.digest,o.application_id,o.target_application_id,o.target_application_version FROM onboarding_files o JOIN files f ON f.id=o.file_id
     JOIN file_metadata m ON m.file_id=f.id WHERE f.id=? AND f.subject=? AND o.purpose='onboarding-proof'`).get(String(p.fileId||''),who.subject);
   core.check(upload&&!upload.application_id,'FORBIDDEN','请选择本次上传的付款凭证',403);
   core.check(scopedSupplement?upload.target_application_id===prior.id&&upload.target_application_version===prior.version:
    upload.target_application_id===null,'FORBIDDEN','请选择本次上传的付款凭证',403);
   const id=prior?.id||'join-'+randomUUID();
   core.check(!db.prepare("SELECT 1 FROM onboarding_applications WHERE id<>? AND mobile=? AND status IN ('pending','approved')").get(id,mobile)
    &&!db.prepare("SELECT 1 FROM accounts WHERE json_extract(data,'$.mobile')=?").get(mobile),
    'CONFLICT','该手机号已有加盟申请或账号，请联系总部核实',409);
   core.check(!db.prepare('SELECT 1 FROM onboarding_files o JOIN files f ON f.id=o.file_id WHERE o.application_id<>? AND f.digest=?').get(id,upload.digest),
    'CONFLICT','这张凭证已用于另一笔申请，请核对',409);
   if(prior)db.prepare(`UPDATE onboarding_applications SET name=?,mobile=?,organization=?,status='pending',version=version+1,
    file_id=?,applicant_note=?,submitted_at=?,review_note=NULL,reviewed_at=NULL,reviewed_by=NULL WHERE id=?`)
    .run(name,mobile,organization,upload.id,note,who.now,id);
   else db.prepare(`INSERT INTO onboarding_applications
    (id,applicant_subject,name,mobile,organization,status,qr_file_id,payee,file_id,applicant_note,submitted_at)
    VALUES(?,?,?,?,?,'pending',?,?,?,?,?)`).run(id,who.subject,name,mobile,organization,cfg.qr_file_id,cfg.payee,upload.id,note,who.now);
   db.prepare('UPDATE onboarding_files SET application_id=? WHERE file_id=?').run(id,upload.id);
   audit(who,prior?'onboarding.resubmit':'onboarding.submit',requestId,id,{fileId:upload.id,statusAfter:'pending'});
   return find(id);
  });
 }
 function review(who,id,p,key,requestId) {
  managerOnly(who);
  return write(who,key,'onboarding.review:'+id,p,()=>{
   const row=find(id);
   core.check(row,'NOT_FOUND','加盟申请不存在',404);
   core.check(row.status==='pending'&&row.version===p.version,'CONFLICT','申请状态或版本已更新，请刷新核对',409);
   core.check(['approve','return'].includes(p.decision),'INPUT','请选择审批结果');
   const approved=p.decision==='approve',status=approved?'approved':'returned';
   const note=text(p.note,'申请人可见说明',approved?0:1,800);
   let account=null,reference=null;
   if(approved){
    reference=text(p.settlementReference,'实际收款凭据编号',4,100);
    core.check(!db.prepare('SELECT 1 FROM onboarding_applications WHERE settlement_reference=? COLLATE NOCASE').get(reference),
     'CONFLICT','该收款凭据已用于其他申请',409);
    const payload={name:row.organization,managerName:row.name,mobile:row.mobile};
    const before=repo.commandState(who,'account.create',payload);
    const {state,result}=core.execute(before,who.actor,'account.create',payload,{...who,requestId});
    account=state.accounts.find(item=>item.id===result.id);
    account.status='pending';
    store.save(state,{before});
   }
   db.prepare(`UPDATE onboarding_applications SET status=?,reviewed_by=?,reviewed_at=?,review_note=?,
    settlement_reference=?,account_actor=? WHERE id=?`).run(status,who.subject,who.now,note,reference,account?.actor||null,id);
   const title=approved?'加盟申请已通过':'加盟申请待补充';
   const body=approved?'请联系总部领取本人一次性激活码，完成加盟商账号激活。':'请查看总部意见并补充付款凭证。';
   notify(who,row,row.applicant_subject,title,body);
   if(account)notify(who,row,account.owner,title,'加盟审核已通过，可查看原申请结果。');
   audit(who,'onboarding.review',requestId,id,{statusAfter:status,version:row.version,fileId:row.file_id});
   return find(id);
  });
 }
 function recover(who,p,requestId) {
  applicantOnly(who);
  const code=typeof p.trackingCode==='string'?p.trackingCode.trim():'';
  const parts=/^(join-[a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(code);
  const row=parts&&find(parts[1]);
  core.check(row&&timingSafeEqual(Buffer.from(tracking(row)),Buffer.from(code)),'NOT_FOUND','申请查询码无效',404);
  return store.transaction(()=>{
   if(row.applicant_subject!==who.subject){
    db.prepare('UPDATE onboarding_applications SET applicant_subject=? WHERE id=?').run(who.subject,row.id);
    db.prepare(`UPDATE messages SET owner=?,data=json_set(data,'$.owner',?) WHERE owner=?
      AND json_extract(data,'$.target')='join' AND json_extract(data,'$.recordId')=?`)
     .run(who.subject,who.subject,row.applicant_subject,row.id);
    audit(who,'onboarding.recover',requestId,row.id);
   }
   return present(find(row.id),who);
  });
 }
 return {configuration,configure,list,submit,review,recover,authorizeProofUpload};
}

module.exports={service};
