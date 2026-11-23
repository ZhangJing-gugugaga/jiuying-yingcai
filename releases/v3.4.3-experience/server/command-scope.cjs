'use strict';
const core=require('../shared/core.cjs');
const responsibilities=require('../shared/responsibilities.cjs');
const {activatedStaffIds}=require('./staff-activation.cjs');
const groups={
 'routing.set':['taskRoutingRules'],
 'report':['reports','drafts','exemptions','summaryAdjustments','settlements','requests','policies'],
 'review.report':['reports','summaryAdjustments','settlements'], 'review.revoke':['reports','requests','settlements','summaryAdjustments'],
 'request':['requests','adjustments'], 'review.request':['requests','adjustments'],
 'outlet':['requests'], 'enrollment':[], 'location':['verifications','requests','policies'],
 'payment':['bills','payments','receipts','adjustments'],
 'grant':['staffAccounts'], 'account':['accounts','organizations'], 'settle':['reports','settlements','exemptions','policies','summaryAdjustments'],
 'summary':['reports','summaryAdjustments','settlements'], 'review.adjust':['reports','summaryAdjustments','settlements'],
 'message':['messages'], 'content':['contents','contentVersions'], 'support.settings':[],
 'support':['supportChats','supportTickets','faqEntries'],
 'policy':['policies'],'plan':['pricePlans'],'agreement':['agreements','pricePlans'],
 'billing':['agreements','bills','adjustments','billCorrections','payments','receipts','offlinePayments','refundRequests','invoiceRequests'],
 'fee':['adjustments','feeProposals','bills'], 'offline':['bills','offlinePayments','payments','receipts'],
 'refund':['receipts','bills','refundRequests','invoiceRequests'],'invoice':['receipts','bills','agreements','invoiceRequests','refundRequests'],
 'jobs':['policies','jobRuns','reports','exemptions','verifications','bills','supportTickets','supportChats','requests','adjustments','feeProposals','summaryAdjustments','businessTasks'],
 'task':['businessTasks','reports','exemptions','verifications','bills','supportTickets'],
 'cooperation':['cooperationRequests'],'faq':['faqEntries'],'public':['publicProfiles'],'import':['importBatches','accounts','organizations'],
 'staff':['staffAccounts','businessTasks','supportChats','supportTickets','handovers']
};
function includeStaffActivation(db,state){
 state.activatedStaffIds=activatedStaffIds(db,state.staffAccounts.map(staff=>staff.id));
}

function taskCommandState(store,session,command,p,today){
 if(command!=='task.create')core.check(typeof p.id==='string'&&p.id.length>0&&p.id.length<=120,'INPUT','待办编号无效');
 const db=store.db,task=command==='task.create'?null:db.prepare('SELECT data FROM businessTasks WHERE id=?').get(p.id||null);
 const existing=task?JSON.parse(task.data):null,type=existing?.businessType||p.businessType,key=existing?.businessId||p.businessId;
 const selected={staffAccounts:{where:'id IN (SELECT value FROM json_each(?))',params:[JSON.stringify([session.subject,p.assigneeUserId,p.assignee].filter(Boolean))]}};
 if(typeof type==='string'&&Object.hasOwn(responsibilities.TARGETS,type)&&typeof key==='string'&&key.length<=120){
  selected[type]={where:'id=?',params:[key]};
  if(type==='adjustments')selected.feeProposals={where:"json_extract(data,'$.adjustmentId')=? AND status='pending'",params:[key]};
  if(command==='task.create'){
   const row=db.prepare(`SELECT data FROM ${type} WHERE id=?`).get(key);
   if(row){
    const source=JSON.parse(row.data);
    if(type==='outlets')source.outlet=key;
    const same=responsibilities.sourceKey(type,source);
    selected.businessTasks={where:"status IN ('open','in_progress') AND json_extract(data,'$.responsibilityKey') IS NOT NULL AND json_extract(data,'$.responsibilityKey')=?",params:[same]};
   }
  }
 }
 if(command!=='task.create')selected.businessTasks={where:'id=?',params:[p.id||null]};
 const state=store.load(selected);state.today=today;
 if(command==='task.assign'||command==='task.update'&&p.assignee)includeStaffActivation(db,state);
 return {state};
}
function scopedCommandState(store,session,command,p,today){const db=store.db,owner=core.own(session.actor),needed=groups[command]||groups[command.split('.')[0]]||[],selection={staffAccounts:{where:'id=?',params:[session.subject]},accounts:owner?{where:'owner=?',params:[owner]}:{where:'0'},outlets:{where:'0'}};for(const k of needed)selection[k]={};
 if(command.startsWith('task.'))return taskCommandState(store,session,command,p,today);
 if(command==='routing.set'){
  core.check(session.actor==='manager','FORBIDDEN','当前身份无此操作权限',403);
  core.check(typeof p.outlet==='string'&&p.outlet.length>0&&p.outlet.length<=120,'INPUT','请选择有效网点');
 }
 let oid=command==='request.submit'&&p.type==='newOutlet'?null:p.outlet,m=p.month;const reference=p.id||p.billId||p.receiptId||p.adjustmentId||p.agreementId;
 if(!oid&&reference)for(const k of core.COLLECTIONS){if(!needed.includes(k)&&!['reports','requests','bills','receipts','adjustments','agreements','businessTasks'].includes(k))continue;const r=db.prepare(`SELECT outlet,month FROM ${k} WHERE id=?`).get(reference);if(r){oid=r.outlet;m||=r.month;if(oid)break;}}
 if(command==='review.revoke'&&p.id&&!m){
  const request=db.prepare("SELECT json_extract(data,'$.data.month') month FROM requests WHERE id=?").get(p.id);
  m=request?.month;
 }
 if(oid){const o=db.prepare('SELECT owner FROM outlets WHERE id=?').get(oid);if(o&&owner)core.check(o.owner===owner,'FORBIDDEN','无权操作其他加盟商网点',403);selection.outlets={where:'id=?',params:[oid]};for(const k of needed)if(!['policies','pricePlans','staffAccounts','handovers','faqEntries','contents','contentVersions','jobRuns','importBatches','settlements'].includes(k))selection[k]={where:'outlet=?',params:[oid]};}
 else if(owner)selection.outlets={where:'owner=?',params:[owner]};
 if(owner)for(const k of needed)if(!oid&&!['policies','pricePlans','faqEntries','contents','contentVersions','publicProfiles','staffAccounts','settlements'].includes(k))selection[k]={where:'owner=?',params:[owner]};
 if(m&&oid)for(const k of ['reports','drafts','exemptions','summaryAdjustments'])if(selection[k])selection[k]={where:'outlet=? AND month=?',params:[oid,m]};
 if(m&&selection.settlements)selection.settlements={where:'month=?',params:[m]};
 if(command==='settle'){selection.reports={where:'month=? AND (current=1 OR version=(SELECT max(r.version) FROM reports r WHERE r.outlet=reports.outlet AND r.month=reports.month))',params:[p.month]};selection.outlets={};selection.exemptions={where:'month=?',params:[p.month]};selection.settlements={where:'month=?',params:[p.month]};selection.summaryAdjustments={where:"month=? AND status='approved'",params:[p.month]};selection.businessTasks={where:"month=? AND status IN ('open','in_progress')",params:[p.month]};}
 if(command==='account.create'){selection.accounts={where:"json_extract(data,'$.mobile')=?",params:[p.mobile]};selection.organizations={where:'0'};}
 if(command==='account.update'){selection.accounts={where:"owner=? OR json_extract(data,'$.mobile')=?",params:[p.owner,p.mobile||'']};selection.organizations={where:'id=?',params:[p.owner]};}
 if(command==='grant.revoke')selection.staffAccounts={where:'id IN (?,?)',params:[p.id,session.subject]};
 if(command==='request.submit'&&p.type==='accountChange'&&owner)selection.accounts={where:'owner=?',params:[owner]};
 if(command==='review.request'){const req=db.prepare('SELECT data FROM requests WHERE id=?').get(p.id);if(req){const r=JSON.parse(req.data);if(r.type==='accountChange')selection.accounts={where:"owner=? OR json_extract(data,'$.mobile')=?",params:[r.owner,r.data.mobile]};}}
 if(command==='grant.set'||command==='staff.create'||command==='staff.update'){selection.outlets={where:'id IN (SELECT value FROM json_each(?))',params:[JSON.stringify(p.grants?.outlets||p.outlets||[])]};}
 if(command.startsWith('staff.')){
  selection.staffAccounts={};
  const subjects=JSON.stringify([p.fromSubject,p.toSubject,p.id].filter(Boolean));
  const assigned="json_extract(data,'$.assignee') IN (SELECT value FROM json_each(?)) AND status NOT IN ('closed','resolved','cancelled')";
  for(const k of ['supportTickets','supportChats'])if(selection[k])selection[k]={where:assigned,params:[subjects]};
  if(selection.businessTasks)selection.businessTasks={where:"status IN ('open','in_progress') AND ("+assigned+" OR json_extract(data,'$.recordId') IN (SELECT id FROM supportTickets WHERE "+assigned+" UNION SELECT id FROM supportChats WHERE "+assigned+"))",params:[subjects,subjects,subjects]};
  selection.handovers={where:'0'};
 }
 if(command==='import.preview'||command==='import.commit'){const previous=p.id?db.prepare('SELECT data FROM importBatches WHERE id=?').get(p.id):null,batch=previous?JSON.parse(previous.data):null,kind=p.kind||batch?.kind,rows=p.rows||batch?.rows?.map(x=>x.data)||[];selection.importBatches=p.id?{where:'id=?',params:[p.id]}:{where:'0'};selection.accounts=kind==='accounts'?{where:"json_extract(data,'$.mobile') IN (SELECT value FROM json_each(?))",params:[JSON.stringify(rows.map(x=>x.mobile))]}:{where:'owner IN (SELECT value FROM json_each(?))',params:[JSON.stringify(rows.map(x=>x.owner))]};selection.outlets=kind==='outlets'?{where:'owner IN (SELECT value FROM json_each(?))',params:[JSON.stringify(rows.map(x=>x.owner))]}:{where:'0'};selection.organizations={where:'0'};}
 if(command==='cooperation.submit')selection.cooperationRequests={where:'owner=?',params:[owner||session.subject]};if(command==='cooperation.update')selection.cooperationRequests={where:'id=?',params:[p.id]};
 if(command.startsWith('content.')){
  const key=command==='content.service.save'?'service-'+p.slot:typeof p.key==='string'?p.key:'brand';
  selection.contents={where:"json_extract(data,'$.key')=?",params:[key]};
  selection.contentVersions=command==='content.publication'&&p.action==='restore'&&Number.isInteger(p.sourceVersion)
   ?{where:"json_extract(data,'$.contentId') IN (SELECT id FROM contents WHERE json_extract(data,'$.key')=?) AND version=?",params:[key,p.sourceVersion]}
   :{where:'0'};
 }
 if(command==='message.read'){selection.messages={where:'id=?',params:[p.id]};selection.requests={where:"id=(SELECT json_extract(data,'$.recordId') FROM messages WHERE id=?)",params:[p.id]};}
 if(command.startsWith('support.')&&p.id)for(const k of ['supportChats','supportTickets'])selection[k]={where:'id=?',params:[p.id]};
 if(command==='support.ticket'){selection.supportTickets=p.linkedTicketId?{where:'id=?',params:[p.linkedTicketId]}:{where:'0'};selection.supportChats={where:'0'};}
 if(command==='support.chat'&&!p.id){selection.supportChats={where:'0'};selection.supportTickets={where:'0'};}
 if(oid&&!command.startsWith('jobs.')&&!command.startsWith('staff.')){selection.businessTasks={where:"outlet=? AND status<>'resolved'",params:[oid]};for(const k of ['reports','exemptions','verifications','bills','supportTickets','supportChats','requests','adjustments'])if(!selection[k])selection[k]={where:'outlet=?',params:[oid]};if(!selection.feeProposals)selection.feeProposals={where:"outlet=? AND status='pending'",params:[oid]};}
 if(m&&oid&&['review.report','review.revoke','review.adjust'].includes(command)){
  selection.businessTasks={where:"status IN ('open','in_progress') AND (outlet=? OR (month=? AND json_extract(data,'$.kind')='report_resettlement'))",params:[oid,m]};
 }
 if(command.startsWith('support.')&&p.id&&!oid)selection.businessTasks={where:"json_extract(data,'$.recordId')=?",params:[p.id]};
 if(['request.submit','request.supplement','review.request','location.review'].includes(command)&&!oid){
  if(p.id)selection.requests={where:'id=?',params:[p.id]};
  if(selection.adjustments)selection.adjustments={where:'0'};
  if(selection.verifications)selection.verifications={where:'0'};
  selection.businessTasks=p.id?{where:"json_extract(data,'$.recordId')=?",params:[p.id]}:{where:'0'};
  if(command==='request.submit'&&p.type==='newOutlet'&&owner){
   selection.requests={where:'owner=? AND outlet IS NULL',params:[owner]};
   selection.businessTasks={where:"owner=? AND outlet IS NULL AND status IN ('open','in_progress')",params:[owner]};
  }
 }
 let jobScope;
 if(command==='jobs.run'){const cursor=Number(p.cursor||0),limit=Number(p.limit||100);core.check(Number.isInteger(cursor)&&cursor>=0&&Number.isInteger(limit)&&limit>0&&limit<=200,'INPUT','批次参数无效');const total=db.prepare('SELECT count(*) n FROM outlets'+(p.outlet?' WHERE id=?':'')).get(...(p.outlet?[p.outlet]:[])).n,ids=db.prepare('SELECT id FROM outlets'+(p.outlet?' WHERE id=?':'')+' ORDER BY id LIMIT ? OFFSET ?').all(...(p.outlet?[p.outlet]:[]),limit,cursor).map(r=>r.id);selection.outlets={where:'id IN (SELECT value FROM json_each(?))',params:[JSON.stringify(ids)]};for(const k of needed)if(!['policies','jobRuns'].includes(k))selection[k]={where:'outlet IN (SELECT value FROM json_each(?))'+(k==='reports'?" AND (current=1 OR status IN ('pending','finance','returned') OR (status='approved' AND version=(SELECT max(latest.version) FROM reports latest WHERE latest.outlet=reports.outlet AND latest.month=reports.month) AND EXISTS (SELECT 1 FROM reports earlier WHERE earlier.outlet=reports.outlet AND earlier.month=reports.month AND earlier.status='returned')))":''),params:[JSON.stringify(ids)]};const key=today+'|'+(p.outlet||'all')+'|'+cursor+'|'+limit;selection.jobRuns={where:"json_extract(data,'$.jobKey')=?",params:[key]};jobScope={cursor,total};}
 if(command==='jobs.run')selection.feeProposals.where+=" AND status='pending'";
 if(command==='routing.set'){
  selection.staffAccounts={where:'id IN (?,?)',params:[session.subject,typeof p.assigneeUserId==='string'&&p.assigneeUserId.length<=120?p.assigneeUserId:null]};
 }else if(!command.startsWith('staff.')&&(oid||jobScope)){
  const outletScope=selection.outlets;
  const ruleScope='outlet IN (SELECT id FROM outlets WHERE '+outletScope.where+')';
  selection.taskRoutingRules={where:ruleScope+" AND status='active'",params:outletScope.params};
  if(selection.staffAccounts.where==='id=?'){
   selection.staffAccounts={
    where:"id=? OR id IN (SELECT json_extract(data,'$.assigneeUserId') FROM taskRoutingRules WHERE "+selection.taskRoutingRules.where+")",
    params:[session.subject,...outletScope.params]
   };
  }
 }
 const s=store.load(selection);s.today=today;
 if(command==='routing.set'||command==='staff.handover'||s.taskRoutingRules.length)includeStaffActivation(db,s);
 return {state:s,jobScope};
}
module.exports={scopedCommandState};
