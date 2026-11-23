'use strict';

const core=require('../shared/core.cjs');
const operations=require('../shared/operations.cjs');
const model=require('../shared/responsibilities.cjs');
const value=key=>"json_extract(businessTasks.data,'$."+key+"')";
const active="businessTasks.status IN ('open','in_progress')";
const queueField=value('queue'),roleField=value('assigneeRole'),userField=value('assigneeUserId'),due="(CASE WHEN "+value('kind')+" IN ('report_missing','exemption_review') AND "+active+" THEN report_due_on(businessTasks.month,report_clock.due_day) ELSE COALESCE("+value('dueAt')+","+value('dueOn')+") END)";
const isOverdue="CASE WHEN "+due+" IS NULL THEN 0 WHEN length("+due+")=10 THEN "+due+"<report_clock.today ELSE "+due+"<report_clock.now END";
const reportClock='WITH report_clock(today,now,due_day) AS (VALUES (?,?,?))';

function partnerTaskAccess(session){
 const owner=core.own(session.actor);
 return {where:`${queueField}='partner' AND ${roleField}='partner' AND ${value('assigneeType')}='franchisee'
   AND businessTasks.owner=? AND ${value('assigneeFranchiseeId')}=? AND (${userField} IS NULL OR ${userField}=?)
   AND ${value('kind')} IN (SELECT value FROM json_each(?)) AND COALESCE(${value('internal')},0)=0
   AND (businessTasks.outlet IS NULL OR businessTasks.outlet IN (SELECT id FROM outlets WHERE owner=?))`,args:[owner,owner,session.subject,JSON.stringify(model.PARTNER_KINDS),owner]};
}

function taskQueries(db,{contextState,access,detail,reportPolicy}){
 db.function('report_due_on',{deterministic:true},operations.reportDueOn);
 function scope(session){
  const s=contextState(session),a=session.actor,owner=core.own(a);
  const grants=operations.scopedGrants(s,a,session);
  if(a==='manager')return {s,queues:model.QUEUES,where:'1',args:[]};
  if(owner)return {s,queues:['partner'],...partnerTaskAccess(session)};
  if(a==='regional'){
   const outlets=(grants.reviewOutlets||[]).filter(id=>grants.outlets?.includes(id));
   return {s,queues:outlets.length?['ops']:[],where:queueField+"='ops' AND "+value('kind')+"='report_review' AND "+userField+" IS NULL AND businessTasks.outlet IN (SELECT value FROM json_each(?))",args:[JSON.stringify(outlets)]};
  }
  const queues=({ops:['ops','hq'],finance:['finance','hq'],location:['hq'],support:['hq']})[a];
  return {s,queues:queues||[],where:roleField+'=? AND ('+userField+' IS NULL OR '+userField+'=?)',args:[a,session.subject]};
 }
 function filter(params,allStatuses=false){
  const conditions=[],args=[];
  const status=params.status||'current';
  core.check(['all','current','open','in_progress','resolved'].includes(status),'INPUT','待办状态筛选无效');
  if(status!=='all'&&(!allStatuses||params.status)){
   conditions.push(status==='current'?active:'businessTasks.status=?');
   if(status!=='current')args.push(status);
  }
  for(const key of ['outlet','month','owner','kind','businessType','assigneeRole','currentStage']){
   const val=params[key];
   if(val==null||val===''||val==='all')continue;
   core.check(typeof val==='string'&&val.length<=120,'INPUT','待办筛选值超长');
   if(key==='outlet'){
    conditions.push("(businessTasks.outlet=? OR ("+value('kind')+"='report_resettlement' AND ? IN (SELECT value FROM json_each(businessTasks.data,'$.affectedOutletIds'))))");
    args.push(val,val);
   }else{
    conditions.push((['month','owner'].includes(key)?'businessTasks.'+key:value(key))+'=?');
    args.push(val);
   }
  }
  if(params.id){conditions.push('businessTasks.id=?');args.push(params.id);}
  return {where:conditions.length?conditions.join(' AND '):'1',args};
 }
 function where(x,f,queue){
  return {where:`(${x.where}) AND (${f.where}) AND ${queueField} ${queue?'= ?':'IN (SELECT value FROM json_each(?))'}`,args:[...x.args,...f.args,queue||JSON.stringify(x.queues)]};
 }
 function clock(s,session){
  const today=s.today||session.today;
  return [today,new Date(session.now||Date.now()).toISOString(),operations.reportDueDay(reportPolicy(today))];
 }
 function taskOverview(session,params={}){
  const x=scope(session),f=filter({...params,status:'current'}),selection=where(x,f);
  const rows=db.prepare(`${reportClock} SELECT ${queueField} queue,count(*) total,sum(${isOverdue}) overdue,min(${due}) earliestDueAt FROM businessTasks CROSS JOIN report_clock WHERE ${selection.where} GROUP BY ${queueField}`).all(...clock(x.s,session),...selection.args);
  return {items:x.queues.map(queue=>rows.find(x=>x.queue===queue)||{queue,total:0,overdue:0,earliestDueAt:null}),canCreate:session.actor==='manager'};
 }
 function project(rows,x,session){
  const records=rows.map(row=>({...row,task:JSON.parse(row.data)}));
  const lookup=new Map();
  for(const type of new Set(records.map(({task})=>task.businessType))){
   if(!Object.hasOwn(model.TARGETS,type))continue;
   const permission=access(type,session,x.s);
   if(!permission)continue;
   const ids=records.filter(({task})=>task.businessType===type).map(({task})=>task.businessId);
   for(const source of db.prepare(`SELECT data FROM ${type} WHERE (${permission.where}) AND id IN (SELECT value FROM json_each(?))`).all(...permission.params,JSON.stringify(ids)).map(x=>JSON.parse(x.data)))
    lookup.set(type+':'+source.id,source);
  }
  const outside=!!core.own(session.actor);
  const impacted=session.actor==='manager'?new Set(records.flatMap(({task})=>task.kind==='report_resettlement'?task.affectedOutletIds||[]:[])):new Set();
  const outletNames=new Map(impacted.size?db.prepare("SELECT id,json_extract(data,'$.name') name FROM outlets WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...impacted])).map(row=>[row.id,row.name]):[]);
  return records.map(row=>{
   const t=row.task,source=lookup.get(t.businessType+':'+t.businessId);
   const assignee=model.assignee(t);
   const allowedAssigneeRoles=session.actor==='manager'?model.rolesForTask(t,source):[];
   const canComplete=!!source&&model.active(t)&&model.manual(t)&&model.matchesAssignee(t,session.actor,session.subject);
   const fields={id:t.id,queue:t.queue,kind:t.kind,businessType:t.businessType,businessId:t.businessId,recordId:t.recordId,target:t.target,outlet:t.outlet,outletName:row.outletName||t.outlet,month:t.month,status:t.status,currentStage:t.currentStage,assigneeType:t.assigneeType,assigneeRole:assignee.role,assigneeFranchiseeId:t.assigneeFranchiseeId,title:t.title||null,applicant:t.businessType?.startsWith('support')?null:row.applicant||t.owner||null,dueAt:row.dueAt,overdue:!!row.overdue,createdAt:t.createdAt,updatedAt:t.updatedAt,completedAt:t.completedAt,closeReason:t.closeReason,canViewBusiness:!!source,canAssign:allowedAssigneeRoles.length>0,canComplete,allowedAssigneeRoles};
   if(t.businessType==='bills'&&Number.isFinite(source?.amount))fields.amount=source.amount;
   if(outside){fields.dueOn=row.dueAt?.length===10?row.dueAt:null;fields.role=assignee.role;fields.resolution=t.resolution??t.closeReason??null;fields.resolvedAt=t.resolvedAt??t.completedAt??null;}
   if(t.kind==='report_resettlement'&&session.actor==='manager'){
    fields.affectedOutletIds=t.affectedOutletIds||[];
    fields.affectedOutlets=fields.affectedOutletIds.map(id=>({id,name:outletNames.get(id)||id}));
    fields.impacts=t.impacts||[];
    fields.resultSettlementId=t.resultSettlementId||null;
    fields.completedBy=t.completedBy||null;
    fields.canResettle=!!source&&model.active(t)&&model.matchesAssignee(t,session.actor,session.subject);
   }
   if(!outside){fields.routingRuleId=t.routingRuleId||null;fields.assigneeUserId=assignee.userId;fields.transferHistory=t.transferHistory||[];fields.note=t.note||null;}
   return fields;
  });
 }
 function rowsFor(x,session,selection,limit,offset){
  const rows=db.prepare(`${reportClock} SELECT businessTasks.data,${due} AS dueAt,
   CASE WHEN ${active} THEN ${isOverdue} ELSE 0 END overdue,
   json_extract(o.data,'$.name') outletName,json_extract(org.data,'$.name') applicant
   FROM businessTasks CROSS JOIN report_clock LEFT JOIN outlets o ON o.id=businessTasks.outlet LEFT JOIN organizations org ON org.id=businessTasks.owner
   WHERE ${selection.where}
   ORDER BY ${due} IS NULL,${due},businessTasks.created_at DESC,businessTasks.id
   LIMIT ? OFFSET ?`).all(...clock(x.s,session),...selection.args,limit,offset);
  return project(rows,x,session);
 }
 function taskList(session,params={}){
  const x=scope(session),queue=params.queue;
  core.check(model.QUEUES.includes(queue),'INPUT','待办队列筛选无效');
  core.check(x.queues.includes(queue),'FORBIDDEN','无权访问该待办队列',403);
  const limit=Number(params.limit??50),offset=Number(params.offset??0);
  core.check(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset须为非负整数');
  const selection=where(x,filter(params),queue);
  const total=db.prepare('SELECT count(*) n FROM businessTasks WHERE '+selection.where).get(...selection.args).n;
  const items=rowsFor(x,session,selection,limit,offset);
  return {items,total,offset,limit,hasMore:offset+items.length<total};
 }
 function taskDetail(session,id){
  core.check(typeof id==='string'&&id.length>0&&id.length<=120,'INPUT','待办编号无效');
  const x=scope(session),selection=where(x,filter({id},true));
  const task=rowsFor(x,session,selection,1,0)[0];
  core.check(task,'NOT_FOUND','待办不存在或无权访问',404);
  return task;
 }
 function assertTaskReplay(session,command,payload,cachedResult){
  const id=payload.id||cachedResult.id;
  const persisted=db.prepare('SELECT data FROM businessTasks WHERE id=?').get(id);
  core.check(persisted,'NOT_FOUND','待办不存在或无权访问',404);
  const row=JSON.parse(persisted.data);
  return row.queue?taskDetail(session,id):detail('businessTasks',id,session);
 }
 return {taskOverview,taskList,taskDetail,assertTaskReplay};
}

module.exports={taskQueries,partnerTaskAccess};
