'use strict';
const core=require('../shared/core.cjs');
function fileAccess(store,file,who){core.check(file,'NOT_FOUND','附件不存在',404);if(file.subject===who.subject||file.owner&&file.owner===core.own(who.actor)||who.actor==='manager')return;
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
 core.check(file&&!file.owner&&(uploader?.role==='manager'||file.subject==='manager'),'FORBIDDEN','公开素材须由总部管理账号独立上传，不能公开加盟商现场照片',403);
}
module.exports={fileAccess,publicImageEvidence};
