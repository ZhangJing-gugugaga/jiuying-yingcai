'use strict';

const {isRoutable}=require('./task-routing.cjs');

const QUEUES=['ops','finance','partner','hq'];
const TARGETS={
 outlets:'outlets',reports:'reports',settlements:'reports',requests:'requests',verifications:'location',
 summaryAdjustments:'reports',adjustments:'fees',feeProposals:'fees',bills:'fees',
 supportTickets:'support',supportChats:'support'
};
const SOURCE_ROLES={
 outlets:['manager','ops','finance','location'],reports:['manager','ops','finance'],settlements:['manager'],
 requests:['manager','ops','finance','location'],verifications:['manager','location'],
 bills:['manager','finance'],adjustments:['manager','ops','finance'],feeProposals:['manager','ops','finance'],
 summaryAdjustments:['manager','ops','finance'],supportTickets:['manager','support'],
 supportChats:['manager','support']
};
const MANUAL_KINDS=new Set(['headquarters_followup','metric_anomaly','no_data']);
const PARTNER_KINDS=['report_missing','report_returned','location_missing','location_exception','request_supplement','bill_unpaid','support_waiting','support_reply','training_material_returned'];

function sourceRoles(type,source){
 if(!source)return [];
 if(type==='requests'){
  if(source.type==='accountChange')return ['manager'];
  if(['pauseFee','exemptException','reportRevoke'].includes(source.type))return ['manager','finance'];
  if(['newOutlet','locationChange'].includes(source.type))return ['manager','ops','location'];
  return ['manager','ops'];
 }
 return SOURCE_ROLES[type]||[];
}
function responsibilityKey(type,id,outlet,month){
 if(type==='reports'&&outlet&&month)return JSON.stringify(['reports',outlet,month]);
 if(type==='verifications'&&outlet&&month)return JSON.stringify(['verifications',outlet,month]);
 if(['no_data','report_missing'].includes(type))return JSON.stringify([type,outlet,month]);
 return JSON.stringify([type,id]);
}
function sourceKey(type,source){
 const typeForKey=type==='feeProposals'?'adjustments':type;
 const id=type==='feeProposals'?source.adjustmentId:source.id;
 return responsibilityKey(typeForKey,id,source.outlet,source.month||source.data?.month||null);
}
function active(task){return ['open','in_progress'].includes(task.status);}
function assignee(task){return {role:task.assigneeRole||task.role,userId:task.assigneeUserId||task.assignee||null};}
function matchesAssignee(task,actor,subject){
 const assigned=assignee(task);
 return assigned.role===actor&&(!assigned.userId||assigned.userId===subject);
}
function belongsToPartner(task,owner,subject){
 return task.queue==='partner'&&task.assigneeType==='franchisee'&&task.owner===owner&&task.assigneeFranchiseeId===owner
  &&!task.internal&&PARTNER_KINDS.includes(task.kind)&&matchesAssignee(task,'partner',subject);
}
function partnerKey(kind,source){
 const scope=kind==='support_waiting'||kind==='support_reply'?'support':kind;
 return JSON.stringify(['partner',scope,...(kind==='report_missing'||kind==='location_missing'?[source.outlet,source.month]:[source.id])]);
}
function rolesForTask(task,source){
 if(!active(task))return [];
 const role=assignee(task).role;
 if(task.queue!=='hq'&&(!['ops','finance'].includes(task.queue)||!isRoutable(task.kind,role)))return [];
 if(task.kind==='headquarters_followup')return sourceRoles(task.businessType,source);
 return sourceRoles(task.businessType,source).includes(role)?[role]:[];
}
function manual(task){return task.queue==='hq'&&MANUAL_KINDS.has(task.kind);}

function metadata({kind,role,queue,businessType,businessId,outlet,month,owner,dueAt=null,key,scopeKey,ctx={},assigneeUserId=null}){
 return {
  queue,businessType,businessId,currentStage:kind,
  responsibilityKey:queue?scopeKey:null,
  assigneeType:role==='partner'?'franchisee':assigneeUserId?'user':'role',
  assigneeRole:role,assigneeUserId,assigneeFranchiseeId:role==='partner'?owner:null,
  dueAt,eventId:ctx.requestId||null,idempotencyKey:key,completedAt:null,closeReason:null,transferHistory:[]
 };
}
function assign(task,to,{actor,subject,at,requestId,note}){
 const from=assignee(task);
 if(from.role===to.role&&from.userId===to.userId)return;
 task.transferHistory||=[];
 task.transferHistory.push({at,actor,subject,requestId:requestId||null,note,from,to});
 task.role=task.assigneeRole=to.role;
 task.assignee=task.assigneeUserId=to.userId;
 task.assigneeType=to.userId?'user':'role';
}
function close(task,at,reason){
 task.status='resolved';
 task.updatedAt=task.resolvedAt=task.completedAt=at;
 task.closeReason=task.resolution=reason;
}

module.exports={QUEUES,TARGETS,PARTNER_KINDS,sourceRoles,responsibilityKey,sourceKey,active,assignee,matchesAssignee,belongsToPartner,partnerKey,rolesForTask,manual,metadata,assign,close};
