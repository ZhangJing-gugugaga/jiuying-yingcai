'use strict';
const {randomUUID}=require('node:crypto');
const core=require('../shared/core.cjs');
const {actions,labels,roles,roleOf,supportCollections,feeRequestTypes,outletLocationTypes,safeNote,fields,snapshot,outcome}=require('../shared/approval-events.cjs');
const {canReadReviewNote}=require('../shared/request-projection.cjs');

const primaryCollections={
 'report.submit':'reports','report.correct':'reports','review.report':'reports','report.revoke.request':'requests','review.revoke':'requests','report.exempt':'exemptions',
 'request.submit':'requests','request.supplement':'requests','review.request':'requests','location.submit':'verifications','location.review':['verifications','requests'],
 'summary.adjust':'summaryAdjustments','review.adjust':'summaryAdjustments','fee.adjust.propose':'feeProposals','fee.adjust.review':'feeProposals',
 'billing.correct.propose':'billCorrections','billing.correct.review':'billCorrections','support.ticket':'supportTickets','support.human':'supportChats',
 'cooperation.submit':'cooperationRequests','cooperation.update':'cooperationRequests'
};
const additionalCommands=new Set(['billing.generate','staff.handover']);
const customerSupportActions=new Set(['support.ticket','support.human','support.claim','support.reply','support.supplement','support.close','support.rate']);
const regionalActions=new Set(['report.submit','report.correct','review.report']);
const locationRequestActions=new Set(['request.submit','request.supplement','location.review']);
const find=(state,collection,id)=>state[collection]?.find(row=>row.id===id);

function captureTargets(before,after,command,result){
 const candidates=[];
 const add=(collection,id,action=command,relation=null)=>{
  const current=find(after,collection,id);
  if(current)candidates.push({collection,previous:find(before,collection,id),current,action,relation});
 };
 const primary=primaryCollections[command]||(command.startsWith('support.')?['supportTickets','supportChats']:[]);
 const main=[primary].flat().find(collection=>actions[collection].includes(command)&&find(after,collection,result.id));
 if(main)add(main,result.id);
 if(command==='report.revoke.request'||command==='review.revoke')add('reports',result.data.reportId,command==='review.revoke'&&result.status==='approved'?'report.revoked':command,{collection:'requests',id:result.id,status:result.status});
 if(command==='review.report'&&result.current&&result.correctionOf)add('reports',result.correctionOf,'report.superseded',{collection:'reports',id:result.id,status:result.status});
 if(command==='review.report'||command==='review.revoke'){
  for(const adjustment of after.summaryAdjustments||[]){
   const prior=find(before,'summaryAdjustments',adjustment.id);
   if(prior&&prior.status!==adjustment.status)add('summaryAdjustments',adjustment.id,command,{collection:main,id:result.id,status:result.status});
  }
 }
 if(command==='review.request'&&result.type==='pauseFee'&&result.status==='approved'){
  const discovered=after.adjustments.find(row=>row.requestId===result.id);
  if(discovered)add('adjustments',discovered.id,command,{collection:'requests',id:result.id,status:result.status});
 }
 if(command==='fee.adjust.propose'||command==='fee.adjust.review')add('adjustments',result.adjustmentId,command,{collection:'feeProposals',id:result.id,status:result.status});
 if(command==='billing.generate'){
  for(const id of result.adjustmentIds||[]){
   if(find(before,'adjustments',id)?.status!==find(after,'adjustments',id)?.status)add('adjustments',id,command,{collection:'bills',id:result.id,status:result.status});
  }
 }
 if(command==='staff.handover')for(const item of result.moved||[])if(supportCollections.has(item.collection))add(item.collection,item.id,command,{collection:'handovers',id:result.id,status:result.status});
 return candidates;
}

function record(store,{before,after,result,command,payload,session,requestId,at,source='command-api'}){
 if(!Object.hasOwn(primaryCollections,command)&&!additionalCommands.has(command)&&!Object.values(actions).some(list=>list.includes(command)))return;
 if(command==='support.human'&&find(before,'supportChats',result.id)?.human)return;
 const targets=captureTargets(before,after,command,result);
 if(!targets.length)return;
 const audit=after.audit.at(-1);
 core.check(audit?.command===command&&audit.requestId===requestId&&audit.subject===session.subject&&audit.actor===session.actor&&audit.recordId===result.id,'INTERNAL','审批审计事件缺少关联来源',500);
 const submitter=command==='report.submit'&&session.subject===session.principal
  ?before.accounts?.find(account=>account.actor===session.principal&&account.owner===result.owner):null;
 const submitterName=typeof submitter?.managerName==='string'?submitter.managerName.trim()||null:null;
 const insert=store.db.prepare('INSERT INTO approval_events(id,collection,object_id,audit_record_id,original_entry,action,role,occurred_at,data,submitter_name) VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(const target of targets){
  const {collection,previous,current,action,relation}=target;
  const entry=current.trail?.length>(previous?.trail?.length||0)?current.trail.at(-1):null;
  const collaboration=action==='support.collaborate'&&current.collaborations?.length>(previous?.collaborations?.length||0)?current.collaborations.at(-1):null;
  const originalEntry=collaboration?`collaboration:${current.collaborations.length-1}`:entry?`trail:${current.trail.length-1}`:null;
  const oldState=snapshot(collection,previous),newState=snapshot(collection,current);
  if(collaboration)newState.department=safeNote(collaboration.department);
  const primaryRelation=collection==='requests'&&current.type==='reportRevoke'?{collection:'reports',id:current.data.reportId}:collection==='feeProposals'?{collection:'adjustments',id:current.adjustmentId}:collection==='summaryAdjustments'?{collection:'reports',id:current.sourceReportId}:null;
  const note=action==='report.revoked'?result.reviewNote:collaboration?.note??entry?.note??payload.note??payload.reason??(action==='location.submit'?current.explanation:'');
  const event={id:'approval-'+randomUUID(),objectType:collection,objectId:current.id,version:current.version??current.data?.version??find(after,'reports',current.sourceReportId)?.version??null,
   role:roleOf(session.actor),actorId:session.subject,at:audit.executedAt||at,action,before:oldState,after:newState,
   note:safeNote(note),
   ...((collection==='requests'&&['review.request','review.revoke','location.review'].includes(action)||collection==='verifications'&&action==='location.review')&&current.publicNote?{publicNote:current.publicNote}:{}),
   decision:['approve','return','supplement','exception'].includes(payload.decision)?payload.decision:null,
   requestId,source,related:relation||primaryRelation,auditId:audit.id};
  insert.run(event.id,collection,current.id,audit.id,originalEntry,action,event.role,event.at,JSON.stringify(event),
   collection==='reports'&&action==='report.submit'?submitterName:null);
 }
}

const financeReport=`(json_type(r.data,'$.correctionDiff.revenue')='object'
 OR EXISTS (SELECT 1 FROM json_each(r.data, '$.trail') entry WHERE json_extract(entry.value,'$.actor')='finance')
 OR EXISTS (SELECT 1 FROM requests q WHERE q.outlet=r.outlet AND json_extract(q.data,'$.type')='reportRevoke' AND json_extract(q.data,'$.data.reportId')=r.id))`;

function authorize(db,repo,session,collection,record){
 const actor=session.actor;
 if(actor==='regional'){
  const grants=repo.context(session).grants;
  core.check(collection==='reports'&&grants.outlets.includes(record.outlet)&&grants.reviewOutlets.includes(record.outlet),'FORBIDDEN','无此网点月报审批历史授权',403);
  return {role:actor,metrics:grants.metrics};
 }
 if(actor==='finance'&&collection==='reports')core.check(db.prepare(`SELECT 1 FROM reports r WHERE r.id=? AND ${financeReport}`).get(record.id),'FORBIDDEN','此月报与财务复核无关',403);
 if(actor==='ops'&&collection==='requests')core.check(!feeRequestTypes.has(record.type),'FORBIDDEN','该申请由其他岗位审批',403);
 if(core.own(actor)||actor==='public')return {role:roleOf(actor),limited:true};
 core.check(Object.hasOwn(roles,actor),'FORBIDDEN','无权访问业务审批历史',403);
 return {role:actor};
}

function eventActions(collection,access){
 const {role,limited}=access;
 if(role==='regional')return actions[collection].filter(action=>regionalActions.has(action));
 if(role==='location'&&collection==='requests')return actions[collection].filter(action=>locationRequestActions.has(action));
 if(['ops','finance'].includes(role)&&collection==='requests')return actions[collection].filter(action=>action!=='location.review');
 if(limited&&supportCollections.has(collection))return actions[collection].filter(action=>customerSupportActions.has(action));
 return actions[collection];
}

function readRows(db,collection,scope,access,limit,offset){
 const allowed=JSON.stringify(eventActions(collection,access));
 const source=scope.lineage?{where:`r.outlet=? AND r.month=? AND r.owner IS ?${access.role==='finance'?' AND '+financeReport:''}`,args:[scope.record.outlet,scope.record.month,scope.record.owner]}:{where:'r.id=?',args:[scope.record.id]};
 return db.prepare(`
  WITH objects AS (
   SELECT r.id,r.data FROM ${collection} r WHERE ${source.where}
  ), allowed AS (SELECT value AS action FROM json_each(?)),
  originals AS (
   SELECT o.id AS object_id,'trail:'||x.key AS entry_key,CAST(x.key AS INTEGER) AS ordinal,x.value AS entry,
          json_extract(x.value,'$.actor') AS actor,json_extract(x.value,'$.action') AS action,
          COALESCE(json_extract(x.value,'$.executedAt'),json_extract(x.value,'$.at')) AS at,'legacy-trail' AS source
     FROM objects o,json_each(o.data,'$.trail') x WHERE x.type='object'
   UNION ALL
   SELECT o.id,'collaboration:'||x.key,CAST(x.key AS INTEGER),x.value,json_extract(x.value,'$.actor'),'support.collaborate',json_extract(x.value,'$.at'),'legacy-collaboration'
     FROM objects o,json_each(o.data,'$.collaborations') x WHERE x.type='object' AND ?
  ), legacy_entries AS (
   SELECT original.*,row_number() OVER (PARTITION BY object_id,actor,action,at ORDER BY ordinal) AS occurrence
     FROM originals original JOIN allowed USING(action)
    WHERE original.actor IS NOT NULL AND julianday(original.at) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM approval_events event WHERE event.collection=? AND event.object_id=original.object_id AND event.original_entry=original.entry_key)
  ), legacy_logs AS (
   SELECT a.id,a.rowid AS ordinal,o.id AS object_id,a.data AS log,json_extract(a.data,'$.actor') AS actor,
          json_extract(a.data,'$.command') AS action,json_extract(a.data,'$.executedAt') AS at
     FROM objects o JOIN audit a ON json_extract(a.data,'$.recordId')=o.id JOIN allowed ON json_extract(a.data,'$.command')=allowed.action
    WHERE json_extract(a.data,'$.recordId') IS NOT NULL AND json_extract(a.data,'$.actor') IS NOT NULL
      AND julianday(json_extract(a.data,'$.executedAt')) IS NOT NULL
      AND COALESCE(json_extract(a.data,'$.outcome'),'')<>'no_change'
      AND NOT EXISTS (SELECT 1 FROM approval_events event WHERE event.collection=? AND event.object_id=o.id AND event.audit_record_id=a.id)
  ), legacy_audit AS (
   SELECT *,row_number() OVER (PARTITION BY object_id,actor,action,at ORDER BY ordinal) AS occurrence FROM legacy_logs
  ), events AS (
   SELECT e.id,e.object_id,e.seq AS ordinal,e.occurred_at AS at,e.role,e.action,e.data AS data,NULL AS entry,NULL AS log,NULL AS source
     FROM objects o JOIN approval_events e ON e.collection=? AND e.object_id=o.id JOIN allowed USING(action)
   UNION ALL
   SELECT 'legacy-'||a.id,a.object_id,a.ordinal,a.at,a.actor,a.action,NULL,
          (SELECT t.entry FROM legacy_entries t WHERE t.object_id=a.object_id AND t.actor=a.actor AND t.action=a.action AND t.at=a.at AND t.occurrence=a.occurrence),
          a.log,'legacy-audit' FROM legacy_audit a
   UNION ALL
   SELECT 'legacy-'||t.object_id||'-'||t.entry_key,t.object_id,t.ordinal,t.at,t.actor,t.action,NULL,t.entry,NULL,t.source FROM legacy_entries t
    WHERE NOT EXISTS (SELECT 1 FROM legacy_audit a WHERE t.object_id=a.object_id AND t.actor=a.actor AND t.action=a.action AND t.at=a.at AND t.occurrence=a.occurrence)
  )${collection==='supportChats'?`, support_events AS (
     SELECT *,row_number() OVER(PARTITION BY object_id,action ORDER BY at,ordinal,id) AS occurrence
     FROM events WHERE action<>'support.human' OR COALESCE(json_extract(data,'$.before.human'),0)=0
   )`:''}
  SELECT e.*,json_extract(o.data,'$.version') AS version, json_extract(o.data,'$.data.version') AS linked_version
  FROM ${collection==='supportChats'?"support_events e JOIN objects o ON o.id=e.object_id WHERE e.action<>'support.human' OR e.occurrence=1":`events e JOIN objects o ON o.id=e.object_id ${access.role==='regional'?"WHERE e.role <> 'finance'":''}`}
   ORDER BY e.at DESC,e.ordinal DESC,e.id DESC LIMIT ? OFFSET ?
 `).all(...source.args,allowed,supportCollections.has(collection)?1:0,collection,collection,collection,limit,offset);
}

function legacyEvent(row,collection){
 const entry=row.entry?JSON.parse(row.entry):{},log=row.log?JSON.parse(row.log):{};
 const actor=log.actor||entry.actor;
 const status=entry.after?.status??entry.status;
 const before=entry.before&&(row.action==='summary.adjust'?{beforeValues:fields(entry.before,core.METRICS)}:
  row.action==='request.supplement'?snapshot(collection,{data:entry.before}):snapshot(collection,entry.before));
 const department=row.action==='support.collaborate'?safeNote(entry.department):'';
 const after=status?fields({status},['status']):department?{department}:null;
 return {id:row.id,objectType:collection,objectId:row.object_id,version:row.version??row.linked_version??null,
  actorId:log.subject||entry.subject||null,role:roleOf(actor),at:row.at,action:row.action,
  // The legacy report-side revocation trail copied the manager's initiation reason.
  before:before&&Object.keys(before).length?before:null,after,note:row.action==='report.revoked'?'':safeNote(entry.note||log.reason),decision:null,
  requestId:log.requestId||null,source:row.source,related:null,auditId:log.id||null};
}

function visibleSnapshot(value,access,collection,maskRevocation){
 if(!value)return null;
 const result={...value};
 if(!['manager','location','partner'].includes(access.role))for(const key of ['photoId','coordinateSource','assessment'])delete result[key];
 if(maskRevocation)delete result.revocationRequestId;
 if(access.role==='regional'||access.limited){
  const metrics=access.role==='regional'?access.metrics:[];
  for(const key of core.METRICS)if(!metrics.includes(key))delete result[key];
  if(access.role==='regional'&&Array.isArray(result.correctionFields))result.correctionFields=result.correctionFields.filter(field=>metrics.includes(field));
  if(result.correctionDiff)result.correctionDiff=Object.fromEntries(Object.entries(result.correctionDiff).filter(([key])=>metrics.includes(key)));
  for(const key of ['originalValues','beforeValues','values','assignee','department','revocationRequestId','appliedBillId','managementHandled','severe'])delete result[key];
  if(access.limited&&collection==='billCorrections')delete result.beforeStatus;
 }
 return result;
}

function visibleNote(event,access){
 if(access.role==='regional')return '';
 if(event.objectType==='verifications'&&event.action==='location.review'&&access.role==='partner')return event.publicNote||'';
 if(event.objectType==='requests'){
  if(access.limited)return event.role===access.role?event.note:event.publicNote||'';
  if(!canReadReviewNote(access.role,event.role)&&event.role!=='partner')return event.publicNote||'';
 }
 if(!access.limited)return event.note;
 const role=event.role,action=event.action,status=event.after?.status;
 if(role===access.role||action==='review.report'&&status==='returned'||action==='review.request'&&['returned','supplement'].includes(status)||action==='location.review'&&(event.after?.locationStatus||status)==='exception')return event.note;
 return '';
}

function project(event,access){
 const simplified=access.limited||access.role==='regional';
 const operationsReport=access.role==='ops'&&event.objectType==='reports';
 const hideRevocation=operationsReport&&['report.revoke.request','review.revoke','report.revoked'].includes(event.action);
 const hideTrace=simplified||hideRevocation||event.objectType==='requests'&&access.role!=='manager';
 const raw={id:event.id,objectType:event.objectType,objectId:event.objectId,version:event.version,
  actor:roles[event.role]||'历史操作人',actorId:hideTrace?null:event.actorId,role:event.role,
  at:event.at,action:event.action,before:visibleSnapshot(event.before,access,event.objectType,operationsReport),after:visibleSnapshot(event.after,access,event.objectType,operationsReport),
  note:hideRevocation?'':visibleNote(event,access),...(event.objectType==='requests'&&event.publicNote?{publicNote:event.publicNote}:{}),decision:event.decision,requestId:hideTrace?null:event.requestId,source:event.source,
  related:hideTrace?(event.related?.status?{status:event.related.status}:null):event.related,auditId:hideTrace?null:event.auditId};
 const {result,next}=outcome(raw.action,raw.objectType,raw.after,raw.decision,raw.related?.status);
 const label=['review.report','review.revoke'].includes(raw.action)&&raw.objectType==='summaryAdjustments'?'原月报版本变更':raw.action==='review.report'&&raw.role==='finance'?'财务复核月报':labels[raw.action];
 return {...raw,label,result,next,raw};
}

function read(store,repo,session,collection,id,params={}){
 core.check(Object.hasOwn(actions,collection),'NOT_FOUND','审批历史集合不存在',404);
 const limit=Number(params.limit??50),offset=Number(params.offset??0),lineage=params.lineage==='1';
 core.check(typeof id==='string'&&id.length>0&&id.length<=160&&/^[\w.:-]+$/.test(id),'INPUT','业务记录标识无效');
 core.check(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset须非负整数');
 core.check(params.lineage===undefined||collection==='reports'&&lineage,'INPUT','仅月报可查询同月版本历史');
 const record=repo.approvalRecord(collection,id,session),access=authorize(store.db,repo,session,collection,record);
 const rows=readRows(store.db,collection,{record,lineage},access,limit+1,offset);
 const items=rows.slice(0,limit).map(row=>project(row.data?JSON.parse(row.data):legacyEvent(row,collection),access));
 return {items,limit,offset,hasMore:rows.length>limit};
}

module.exports={record,read,financeReport};
