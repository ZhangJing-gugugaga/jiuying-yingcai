'use strict';
const core=require('../shared/core.cjs');
function supportUpload(store,id){return store.db.prepare('SELECT ticket_id FROM support_ticket_files WHERE file_id=?').get(id);}
function onboardingUpload(store,id){return store.db.prepare('SELECT purpose,application_id FROM onboarding_files WHERE file_id=?').get(id);}
function sameUploader(file,who){return file.subject===who.subject&&file.owner===(core.own(who.actor)||null);}
function checkUploadPurpose(purpose,who){
 core.check(purpose===undefined||['support-ticket','onboarding-proof','onboarding-qr'].includes(purpose),'INPUT','附件用途无效');
 if(purpose==='onboarding-qr')core.check(who.actor==='manager','FORBIDDEN','仅总管理员可上传集团收款码',403);
 if(purpose==='onboarding-proof')core.check(who.actor==='public','FORBIDDEN','请在本人加盟申请中上传付款凭证',403);
}
function registerUploadPurpose(store,id,purpose,target){
 if(purpose==='support-ticket')store.db.prepare('INSERT INTO support_ticket_files(file_id) VALUES(?)').run(id);
 else store.db.prepare('INSERT INTO onboarding_files(file_id,purpose,target_application_id,target_application_version) VALUES(?,?,?,?)')
  .run(id,purpose,target?.id??null,target?.version??null);
}
function supportTicketEvidence(store,who,value){
 const ids=core.supportAttachmentIds(value);
 if(!ids.length)return ids;
 const getFile=store.db.prepare('SELECT f.subject,f.owner,s.ticket_id FROM support_ticket_files s JOIN files f ON f.id=s.file_id JOIN file_metadata m ON m.file_id=f.id WHERE s.file_id=?');
 for(const id of ids){
  const file=getFile.get(id);
  core.check(file&&sameUploader(file,who),'FORBIDDEN','请选择本人上传的工单图片',403);
  core.check(!file.ticket_id,'ATTACHMENT_IN_USE','图片已随工单提交，请重新选择',409);
 }
 return ids;
}
function bindSupportTicketFiles(store,ticketId,ids){
 if(!ids.length)return;
 const link=store.db.prepare('UPDATE support_ticket_files SET ticket_id=? WHERE file_id=? AND ticket_id IS NULL');
 for(const id of ids)core.check(link.run(ticketId,id).changes===1,'ATTACHMENT_IN_USE','图片已随工单提交，请重新选择',409);
}
function fileAccess(store,file,who,repo){
 core.check(file,'NOT_FOUND','附件不存在',404);
 const joining=onboardingUpload(store,file.id);
 if(joining){
  const application=joining.application_id&&store.db.prepare('SELECT applicant_subject,account_actor FROM onboarding_applications WHERE id=?').get(joining.application_id);
  const visible=who.actor==='manager'||(joining.purpose==='onboarding-qr'
   ?store.db.prepare('SELECT 1 FROM onboarding_config WHERE enabled=1 AND qr_file_id=?').get(file.id)
   :application?application.applicant_subject===who.subject||application.account_actor===who.principal:sameUploader(file,who));
  core.check(visible,'FORBIDDEN','当前账号无权查看该加盟附件',403);
  return joining.purpose;
 }
 const scope=supportUpload(store,file.id);
 if(scope){
  const permitted=scope.ticket_id
   ?repo.list('supportTickets',who,{id:scope.ticket_id,limit:1},false).items.length===1
   :sameUploader(file,who);
  core.check(permitted,'FORBIDDEN','当前账号无权查看这张工单图片',403);
  return 'support-ticket';
 }
 if(file.subject===who.subject||file.owner&&file.owner===core.own(who.actor)||who.actor==='manager')return;
 const publicImage=store.db.prepare("SELECT 1 FROM contents WHERE (json_extract(data,'$.publishedSnapshot.status')='published' AND json_extract(data,'$.publishedSnapshot.imageId')=?) OR (json_extract(data,'$.publishedSnapshot') IS NULL AND status='published' AND json_extract(data,'$.imageId')=?)").get(file.id,file.id);if(publicImage)return;
 if(who.actor==='location'){const record=store.db.prepare("SELECT 1 FROM verifications WHERE json_extract(data,'$.photo.id')=? UNION ALL SELECT 1 FROM requests WHERE json_extract(data,'$.type') IN ('newOutlet','locationChange') AND json_extract(data,'$.data.photo.id')=? LIMIT 1").get(file.id,file.id);if(record)return;}
 core.fail('FORBIDDEN','当前岗位无权访问该私有附件',403);
}
function publicImageEvidence(store,command,p){
 let id=null;
 if(['content.service.save','content.update'].includes(command)&&typeof p.imageId==='string')id=p.imageId;
 if(command==='content.publication'&&p.action==='restore'&&typeof p.key==='string'&&Number.isInteger(p.sourceVersion)){
  id=store.db.prepare(`SELECT json_extract(v.data,'$.snapshot.imageId') AS id FROM contentVersions v
   JOIN contents c ON c.id=json_extract(v.data,'$.contentId')
   WHERE json_extract(c.data,'$.key')=? AND v.version=? AND v.status='published'`).get(p.key,p.sourceVersion)?.id;
 }
 if(!id)return;
 const file=store.db.prepare('SELECT id,owner,subject FROM files WHERE id=?').get(id);
 const uploader=file&&store.db.prepare('SELECT role FROM users WHERE actor=?').get(file.subject);
 core.check(file&&!supportUpload(store,id)&&!onboardingUpload(store,id)&&!file.owner&&(uploader?.role==='manager'||file.subject==='manager'),'FORBIDDEN','公开素材须由总部管理账号独立上传，不能使用私有附件',403);
}
module.exports={fileAccess,publicImageEvidence,checkUploadPurpose,registerUploadPurpose,supportTicketEvidence,bindSupportTicketFiles};
