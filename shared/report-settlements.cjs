'use strict';

const {assignee,assign,close,active}=require('./responsibilities.cjs');

function invalidate(s,month,impact,ctx,{now,createTask}){
 const records=s.settlements.filter(row=>row.month===month);
 const approved=records.findLast(row=>row.status==='approved');
 const previous=approved||records.at(-1);
 if(!previous||(!approved&&previous.supersededBy))return;
 if(approved){
  previous.status='invalidated';
  previous.invalidatedAt=now;
 }
 if(previous.status!=='invalidated')return;
 let task=s.businessTasks.find(row=>row.kind==='report_resettlement'&&row.businessId===previous.id&&active(row));
 if(!task)task=createTask(previous);
 if(!task.impacts.some(row=>row.kind===impact.kind&&row.eventId===impact.eventId)){
  task.impacts.push({...impact,at:now,actor:ctx.actor,subject:ctx.subject,requestId:ctx.requestId||null});
  task.affectedOutletIds=[...new Set([...task.affectedOutletIds,impact.outlet])];
  task.updatedAt=now;
 }
 previous.resettlementTaskId=task.id;
}

function settle(s,month,taskId,ctx,{now,check,make,coverage,effective,notify}){
 const records=s.settlements.filter(row=>row.month===month);
 check(!records.some(row=>row.status==='approved'),'DUPLICATE','已经结算',409);
 const previous=records.findLast(row=>row.status==='invalidated'&&!row.supersededBy);
 const task=previous?s.businessTasks.find(row=>row.kind==='report_resettlement'&&row.businessId===previous.id&&active(row)):null;
 check(!taskId||task?.id===taskId,'CONFLICT','待办与结算期间或当前版本不匹配',409);
 const subject=ctx.subject||'manager';
 if(task){
  const owner=assignee(task);
  check(!owner.userId||owner.userId===subject,'FORBIDDEN','请由重结算责任人确认，或先转派',403);
 }
 const reports=s.reports.filter(row=>row.month===month&&row.current&&row.status==='approved');
 check(reports.length||previous,'CONFLICT','无有效报表',409);
 const previousVersion=previous?.version??records.length;
 const rows=reports.map(report=>[report.id,{
  outlet:report.outlet,reportVersion:report.version,values:effective(s,report),
  adjustmentIds:s.summaryAdjustments.filter(row=>row.sourceReportId===report.id&&row.status==='approved').map(row=>row.id)
 }]);
 const reportingCoverage=coverage(s,s.outlets,[month]);
 reportingCoverage.settled=reports.length;
 const next={
  ...make(),month,version:previousVersion+1,reportIds:reports.map(row=>row.id),reportValues:Object.fromEntries(rows),
  methodVersion:'integer-cents-v1',reportingCoverage,coverageComplete:reportingCoverage.complete,settledBy:subject,
  ...(previous?{previousSettlementId:previous.id,affectedOutletIds:task?.affectedOutletIds||[],resettlementTaskId:task?.id||null}:{})
 };
 s.settlements.push(next);
 if(previous){
  previous.version=previousVersion;
  previous.supersededBy=next.id;
 }
 if(task){
  if(!assignee(task).userId)assign(task,{role:'manager',userId:subject},{actor:'manager',subject,at:now,requestId:ctx.requestId,note:'负责人确认重新结算'});
  task.completedBy=subject;
  task.resultSettlementId=next.id;
  close(task,now,'business_fact');
  for(const outlet of s.outlets.filter(row=>task.affectedOutletIds.includes(row.id)))notify(outlet,next,reports.some(row=>row.outlet===outlet.id));
 }
 return next;
}

module.exports={invalidate,settle};
