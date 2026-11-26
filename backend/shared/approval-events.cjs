'use strict';
const {METRICS,own}=require('./core.cjs');
const {safeNote}=require('./audit-redaction.cjs');

const actions={
 reports:['report.submit','report.correct','review.report','report.superseded','report.revoke.request','review.revoke','report.revoked'],
 requests:['request.submit','request.supplement','review.request','location.review','report.revoke.request','review.revoke'],
 verifications:['location.submit','location.review'],
 exemptions:['report.exempt'],
 adjustments:['review.request','fee.adjust.propose','fee.adjust.review','billing.generate'],
 feeProposals:['fee.adjust.propose','fee.adjust.review'],
 summaryAdjustments:['summary.adjust','review.adjust','review.report','review.revoke'],
 billCorrections:['billing.correct.propose','billing.correct.review'],
 supportTickets:['support.ticket','support.claim','support.reply','support.management','support.supplement','support.collaborate','support.escalate','support.close','support.rate','staff.handover'],
 supportChats:['support.human','support.claim','support.reply','support.management','support.supplement','support.collaborate','support.escalate','support.close','support.rate','staff.handover'],
 cooperationRequests:['cooperation.submit','cooperation.update']
};
const labels={
 'report.submit':'提交月报','report.correct':'发起月报更正','review.report':'审核月报','report.superseded':'原月报版本被替代','report.revoke.request':'发起误审批撤销','review.revoke':'复核误审批撤销','report.revoked':'撤销原月报审批',
 'request.submit':'提交申请','request.supplement':'提交补件','review.request':'审核申请','location.submit':'提交位置核验','location.review':'核验位置','report.exempt':'登记独立免报',
 'fee.adjust.propose':'提交服务费核算提案','fee.adjust.review':'复核服务费核算','billing.generate':'应用服务费调整','summary.adjust':'提交汇总调整','review.adjust':'复核汇总调整',
 'billing.correct.propose':'提交账单纠错','billing.correct.review':'复核账单纠错','cooperation.submit':'提交合作留言','cooperation.update':'处理合作留言',
 'support.ticket':'提交客服工单','support.human':'转人工客服','support.claim':'接单','support.reply':'客服回复','support.management':'管理层处理','support.supplement':'补充工单资料','support.collaborate':'登记协作','support.escalate':'升级工单','support.close':'关闭客服记录','support.rate':'评价人工服务','staff.handover':'交接客服记录'
};
const roles={partner:'加盟商负责人',ops:'总部运营',finance:'总部财务',manager:'总部管理层',location:'位置核验专员',support:'总部客服',regional:'区域运营',public:'消费者'};
const statuses={pending:'待审核',finance:'待财务复核',approved:'审核通过',returned:'已退回',supplement:'待补件',exception:'位置异常',needsReview:'待重新复核',queued:'待接单',active:'处理中',waiting:'待用户补充',closed:'已关闭',bot:'自动咨询',submitted:'已提交',received:'已接收',contacted:'已联系',applied:'已应用',待财务核算调整:'待财务核算'};
const supportCollections=new Set(['supportTickets','supportChats']);
const outletLocationTypes=new Set(['newOutlet','locationChange']);
const feeRequestTypes=new Set(['pauseFee','exemptException','reportRevoke']);
const roleOf=actor=>own(actor)?'partner':actor;

function fields(value,keys){
 const result={};
 for(const key of keys){
  const field=value?.[key];
  if(field===null||typeof field==='boolean'||Number.isFinite(field))result[key]=field;
  else if(typeof field==='string'&&field.length<=160&&/^[\p{L}\p{N}_.:-]+$/u.test(field))result[key]=field;
 }
 return result;
}

function snapshot(collection,record){
 if(!record)return null;
 const status=fields(record,['status']);
 if(collection==='reports'){
  const value={...status,...fields(record,['current','revoked','correctionAllowed','correctionOf','correctionType','supersededBy','revocationRequestId',...METRICS])};
  if(Array.isArray(record.correctionFields))value.correctionFields=record.correctionFields.filter(field=>METRICS.includes(field)||field==='note');
  if(record.correctionDiff){
   value.correctionDiff=Object.fromEntries(METRICS.filter(field=>Object.hasOwn(record.correctionDiff,field)).map(field=>[field,fields(record.correctionDiff[field],['before','after'])]));
   const note=record.correctionDiff.note;
   if(note)value.correctionDiff.note={before:safeNote(note.before),after:safeNote(note.after)};
  }
  return value;
 }
 if(collection==='requests'){
  const value={...status,...fields(record,['type','policyPending']),...fields(record.data,['locationStatus','reportId','month','version','from','to','applicable','effectiveDate','createdOutletId']),...fields({photoId:record.data?.photo?.id},['photoId'])};
  if(record.data?.originalValues)value.originalValues=fields(record.data.originalValues,METRICS);
  return value;
 }
 if(collection==='verifications')return {...status,...fields(record,['previousId']),...fields({photoId:record.photo?.id,assessment:record.assessment?.result,coordinateSource:record.coords?.source},['photoId','assessment','coordinateSource'])};
 if(collection==='summaryAdjustments')return {...status,...fields(record,['sourceReportId']),beforeValues:fields(record.before,METRICS),values:fields(record.values,METRICS)};
 if(collection==='adjustments'||collection==='feeProposals')return {...status,...fields(record,['amount','offsetMonth','serviceUntil','adjustmentId','requestId','proposalId','appliedBillId','methodVersion'])};
 if(collection==='billCorrections')return {...status,...fields(record,['amount','beforeAmount','beforeStatus','billId','replacementBillId'])};
 if(supportCollections.has(collection))return {...status,...fields(record,['severe','human','managementHandled','assignee','linkedTicketId','category']),...fields({rating:record.rating?.score},['rating'])};
 return status;
}

function outcome(action,collection,after,decision,relatedStatus){
 if(action==='report.revoked')return {result:'原审批已撤销',next:null};
 if(action==='report.superseded')return {result:'已由新版本替代',next:null};
 if(action==='report.correct')return {result:'允许重新报送',next:roles.partner};
 if(action==='report.revoke.request'||action==='review.revoke'){
  const status=relatedStatus||after?.status;
  return {result:statuses[status]||null,next:action==='report.revoke.request'?roles.finance:null};
 }
 if(action==='support.collaborate')return {result:'协作已登记',next:roles.support};
 if(action==='staff.handover')return {result:'已交接',next:roles.support};
 if(action==='support.escalate')return {result:'已升级',next:roles.manager};
 const status=outletLocationTypes.has(after?.type)&&action==='location.review'?after.locationStatus:after?.status;
 let next=null;
 if(status==='returned'&&['reports','requests'].includes(collection)||status==='supplement'||status==='waiting'||status==='exception')next=collection==='supportTickets'||collection==='supportChats'?'工单发起人':roles.partner;
 if(status==='exception'&&collection==='verifications')next=roles.location;
 if(status==='finance')next=roles.finance;
 if(status==='待财务核算调整'&&collection==='adjustments')next=roles.ops;
 if(supportCollections.has(collection)&&['queued','active'].includes(status))next=roles.support;
 if(status==='pending'){
  if(collection==='reports')next=roles.ops;
  if(collection==='feeProposals'||collection==='billCorrections')next=roles.finance;
  if(collection==='verifications'||outletLocationTypes.has(after?.type)&&after?.locationStatus==='pending')next=roles.location;
  if(collection==='requests'&&!next)next=feeRequestTypes.has(after?.type)?roles.finance:after?.type==='accountChange'?roles.manager:roles.ops;
  if(collection==='summaryAdjustments')next=roles.ops;
 }
 if(action==='location.review'&&collection==='requests'&&status==='approved'&&after.status==='pending')next=roles.ops;
 if(action==='fee.adjust.propose')next=roles.finance;
 if(action==='fee.adjust.review'&&['adjustments','feeProposals'].includes(collection)&&decision==='return')return {result:'核算提案已退回',next:roles.ops};
 return {result:statuses[status]||null,next};
}

module.exports={actions,labels,roles,statuses,roleOf,supportCollections,outletLocationTypes,feeRequestTypes,safeNote,fields,snapshot,outcome};
