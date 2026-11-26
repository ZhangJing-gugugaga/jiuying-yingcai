'use strict';
const core=require('../shared/core.cjs'),operations=require('../shared/operations.cjs'),agency=require('../shared/agency.cjs');
const {taskQueries,partnerTaskAccess}=require('./tasks.cjs');
const {partnerKey}=require('../shared/responsibilities.cjs');
const {routingOptions,hasAssignedAction}=require('../shared/task-routing.cjs');
const {activatedStaffIds}=require('./staff-activation.cjs');
const {billMetrics,markPendingRefunds,canRead:canReadLedger}=require('./finance.cjs');
const {addOutletSummaries}=require('./outlet-summaries.cjs');
const {qualifiedOutletLabels}=require('./workbench-outlets.cjs');
const regions=require('../shared/outlet-regions.cjs');
const approvalCommandsByCollection = {
  reports: ['review.report'],
  requests: ['review.request', 'review.revoke', 'location.review'],
  verifications: ['location.review'],
};
const all=['manager','ops','finance'];
const privateFinance=['bills','payments','receipts','adjustments','drafts','summaryAdjustments','agreements','billCorrections','feeProposals','offlinePayments','refundRequests','invoiceRequests'];
const published=['contents','faqEntries','publicProfiles'];
const reportWorklistFilters={action:['missing','draft','returned'],reviewing:['pending','finance','exemption_pending'],approved:['approved']};
const blockedReportStatuses={current_month:'not_open',future_month:'not_open',exempt:'exempt',full_pause:'exemption_pending',no_operation:'not_required'};
const publishedContentWhere="(json_extract(data,'$.publishedSnapshot.status')='published' OR (json_extract(data,'$.publishedSnapshot') IS NULL AND status='published'))";
const collectionStatuses={
 outlets:['open','paused','preparing','closed'],
 reports:['pending','finance','returned','approved'],
 requests:['pending','supplement','returned','approved'],
 verifications:['pending','approved','exception'],
 supportTickets:['queued','active','processing','waiting','closed'],
 supportChats:['bot','queued','active','processing','waiting','closed'],
 bills:['unpaid','paid','settled_zero','reversed'],
 payments:['pending','success','failed','cancelled'],
 receipts:['success'],
 adjustments:['待财务核算调整','approved','applied'],
 accounts:['pending','active','locked','frozen','disabled'],
 messages:['unread','read'],
 agreements:['active'],
 pricePlans:['published'],
 offlinePayments:['pending','approved','returned'],
 refundRequests:['pending','approved','returned','recorded'],
 invoiceRequests:['pending','issued','rejected','cancelled','red_pending','red_issued'],
 billCorrections:['pending','approved','returned'],
 feeProposals:['pending','approved','returned'],
 staffAccounts:['active','disabled'],
 handovers:['completed'],
 taskRoutingRules:['active','disabled'],
 businessTasks:['open','in_progress','resolved','cancelled'],
 cooperationRequests:['submitted','received','contacted','closed'],
 policies:['published'],
 jobRuns:['running','partially_completed','completed','failed'],
 faqEntries:['draft','published'],
 publicProfiles:['draft','published'],
 importBatches:['preview','committed'],
 agencyRelations:['active','revoked']
};
function checkCollectionStatus(name,status){
 const options=collectionStatuses[name];
 if(options&&status&&status!=='all')core.check(options.includes(status),'INPUT','当前集合不支持此状态筛选');
}
function includeStatusOptions(result,name,params){
 const options=collectionStatuses[name];
 return params.includeStatusOptions==='true'&&options?{...result,statusOptions:options}:result;
}
function repository(store,{today}={}){const db=store.db;
 function contextState(session){const s=store.settings();s.today=typeof today==='function'?today():s.today;s.staffAccounts=has('staffAccounts')?db.prepare('SELECT data FROM staffAccounts WHERE id=?').all(session.subject).map(r=>JSON.parse(r.data)):[];return s;}
 function reportPolicy(date){
  const row=db.prepare("SELECT data FROM policies WHERE status='published' AND json_extract(data,'$.effectiveFrom')<=? ORDER BY json_extract(data,'$.effectiveFrom') DESC,version DESC LIMIT 1").get(date);
  return row?JSON.parse(row.data):null;
 }
 function has(name){return core.COLLECTIONS.includes(name)&&!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);}
 function restoreNoticeLinks(records,session){
  const scheduled=new Map([['上月月报待报送','report_missing'],['暂停月份待核验免报','exemption_review'],['本月位置待核验','location_missing'],['账单逾期待处理','bill_overdue']]);
  const legacy=records.filter(row=>row.taskId&&row.recordId===row.taskId&&scheduled.has(row.title));
  if(legacy.length){
   const rows=db.prepare('SELECT data FROM businessTasks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify([...new Set(legacy.map(row=>row.taskId))]));
   const tasks=new Map(rows.map(row=>{const task=JSON.parse(row.data);return [task.id,task];}));
   const owner=core.own(session.actor),partnerLinks=new Map();
   for(const message of legacy){
    const task=tasks.get(message.taskId);
    if(task?.kind===scheduled.get(message.title)&&task.owner===message.owner&&task.outlet===message.outlet&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(task.month||'')){
     message.month=task.month;
     message.recordId=task.recordId||null;
     if(owner===message.owner&&['report_missing','location_missing'].includes(task.kind))partnerLinks.set(message,partnerKey(task.kind,task));
    }else message.linkUnavailable=true;
   }
   if(partnerLinks.size){
    const own=partnerTaskAccess(session);
    const rows=db.prepare(`SELECT id,json_extract(data,'$.responsibilityKey') scope FROM businessTasks WHERE (${own.where})
     AND status IN ('open','in_progress') AND json_extract(data,'$.responsibilityKey') IN (SELECT value FROM json_each(?))`)
     .all(...own.args,JSON.stringify([...new Set(partnerLinks.values())]));
    const ids=new Map(rows.map(row=>[row.scope,row.id]));
    for(const [message,key] of partnerLinks){message.partnerTaskId=ids.get(key);delete message.taskId;}
   }
  }
  for(const message of records){
   if(message.target!=='fees'||!message.recordId?.startsWith('bill-'))continue;
   const {recordId,owner,outlet,createdAt}=message;
   if(!message.refundRequestId&&['服务费退款已核验','模拟退款已确认'].includes(message.title)){
    const matches=db.prepare(`SELECT f.id FROM receipts receipt JOIN payment_refund_orders r ON r.receipt_id=receipt.id
     JOIN refundRequests f ON f.id=COALESCE(r.refund_request_id,'refund-mock-'||r.id)
     WHERE r.bill_id=? AND r.updated_at=? AND r.status='success' AND f.status='recorded' AND f.owner=? AND f.outlet=?
      AND json_extract(receipt.data,'$.billId')=? AND receipt.owner=f.owner AND receipt.outlet=f.outlet AND receipt.status='success'
      AND json_extract(f.data,'$.billId')=r.bill_id AND json_extract(f.data,'$.receiptId')=r.receipt_id LIMIT 2`).all(recordId,createdAt??null,owner??null,outlet??null,recordId);
    if(matches.length===1)message.refundRequestId=matches[0].id;
    else message.linkUnavailable=true;
   }
   if(!message.paymentId&&['服务费付款已核验到账','模拟付款已确认'].includes(message.title)){
    const matches=db.prepare(`SELECT id FROM payments WHERE owner=? AND outlet=? AND status='success'
     AND json_extract(data,'$.billId')=? LIMIT 2`).all(owner??null,outlet??null,recordId);
    if(matches.length===1)message.paymentId=matches[0].id;
   }
  }
 }
 function grant(s,session){return operations.scopedGrants(s,session.actor,{today:s.today,...session});}
 function access(name,session,s){const a=session.actor,owner=core.own(a);
  if(name==='supportChats'||name==='supportTickets'){
   if(a==='manager')return {where:"json_extract(data,'$.severe')=1",params:[]};
   if(a==='support')return {
    where:(name==='supportChats'?"json_extract(data,'$.human')=1 AND ":'')
      +"(json_extract(data,'$.assignee') IS NULL OR json_extract(data,'$.assignee')=?)"
      +` AND NOT EXISTS (SELECT 1 FROM businessTasks task
       WHERE task.status IN ('open','in_progress') AND json_extract(task.data,'$.recordId')=${name}.id
        AND json_extract(task.data,'$.kind') IN ('support_queue','support_sla')
        AND json_extract(task.data,'$.assigneeUserId') IS NOT NULL AND json_extract(task.data,'$.assigneeUserId')<>?)`,
    params:[session.subject,session.subject]
   };
   return {where:'owner=?',params:[owner||session.subject]};
  }
  if(a==='manager')return {where:'1',params:[]};const owned={where:'owner=?',params:[owner]};const ids=grant(s,session).outlets||[];const regional={where:`${name==='outlets'?'id':'outlet'} IN (SELECT value FROM json_each(?))`,params:[JSON.stringify(ids)]};
  if(name==='outlets')return owner?owned:a==='public'?{where:"status<>'closed'",params:[]}:a==='regional'?regional:{where:'1',params:[]};
  if(name==='reports'||name==='exemptions')return owner?owned:all.includes(a)?{where:'1',params:[]}:a==='regional'?regional:null;
  if(name==='settlements'){
   if(all.includes(a))return {where:'1',params:[]};
   const reportScope=owner?owned:a==='regional'?regional:null;
   return reportScope&&{where:`(EXISTS (SELECT 1 FROM json_each(settlements.data,'$.reportIds') ref JOIN reports ON reports.id=ref.value WHERE ${reportScope.where}) OR EXISTS (SELECT 1 FROM json_each(settlements.data,'$.affectedOutletIds') ref JOIN outlets ON outlets.id=ref.value WHERE ${owner?'outlets.owner=?':'outlets.id IN (SELECT value FROM json_each(?))'}))`,params:[...reportScope.params,...reportScope.params]};
  }
  if(['offlinePayments','refundRequests','invoiceRequests','payments','receipts'].includes(name)&&a==='ops')return null;
  if(name==='pricePlans'&&owner)return {where:'id IN (SELECT json_extract(data,\'$.planId\') FROM agreements WHERE owner=?)',params:[owner]};
  if(name==='cooperationRequests')return a==='ops'?{where:'1',params:[]}:{where:'owner=?',params:[owner||session.subject]};
  if(privateFinance.includes(name))return owner?owned:all.includes(a)?{where:'1',params:[]}:null;
  if(name==='requests')return owner?owned:a==='ops'?{where:"json_extract(data,'$.type')<>'accountChange'",params:[]}:a==='finance'?{where:"json_extract(data,'$.type') IN ('pauseFee','exemptException','reportRevoke')",params:[]}:a==='location'?{where:"json_extract(data,'$.type') IN ('newOutlet','locationChange')",params:[]}:null;
  if(name==='verifications')return owner?owned:a==='location'?{where:'1',params:[]}:null;
  if(name==='organizations'&&['ops','finance'].includes(a))return {where:'id IN (SELECT owner FROM outlets)',params:[]};if(name==='accounts'||name==='organizations')return owner?owned:null;
  if(name==='staffAccounts')return {where:'id=?',params:[session.subject]};
  if(name==='publicProfiles'&&a==='ops')return {where:'1',params:[]};
  if(name==='publicProfiles'&&!['manager','ops'].includes(a))return {where:"status='published' AND outlet IN (SELECT id FROM outlets WHERE status<>'closed')",params:[]};
  if(published.includes(name))return a==='support'&&name==='faqEntries'?{where:'1',params:[]}:{where:name==='contents'?publishedContentWhere:"status='published'",params:[]};
  if(name==='policies'||name==='pricePlans')return owner||all.includes(a)?{where:'1',params:[]}:null;
  if(name==='businessTasks'&&a==='regional')return {where:"outlet IN (SELECT value FROM json_each(?)) AND json_extract(data,'$.role')='regional'",params:[JSON.stringify(ids)]};
  if(name==='businessTasks'&&owner){const scope=partnerTaskAccess(session);return {where:scope.where,params:scope.args};}
  if(name==='businessTasks')return a==='public'?{where:"owner=? AND COALESCE(json_extract(data,'$.internal'),0)=0 AND json_extract(data,'$.kind') IN ('support_waiting','support_reply')",params:[session.subject]}:{where:"COALESCE(json_extract(data,'$.assigneeRole'),json_extract(data,'$.role'))=? AND (COALESCE(json_extract(data,'$.assigneeUserId'),json_extract(data,'$.assignee')) IS NULL OR COALESCE(json_extract(data,'$.assigneeUserId'),json_extract(data,'$.assignee'))=?)",params:[a,session.subject]};
  if(name==='jobRuns')return all.includes(a)?{where:'1',params:[]}:null;
  if(name==='messages'){if(owner)return owned;if(a==='public')return {where:'owner=?',params:[session.subject]};const targets={ops:['reports','requests','outlets'],finance:['fees','dashboard'],location:['location'],support:['support'],regional:[]}[a]||[];return {where:"json_extract(data,'$.target') IN (SELECT value FROM json_each(?))"+(a==='support'?' AND owner=?':a==='ops'?" AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.id=json_extract(messages.data,'$.recordId') AND json_extract(q.data,'$.type')='accountChange')":''),params:[JSON.stringify(targets),...(a==='support'?[session.subject]:[])]};}
  return null;
 }
 function query(name,session,params={},publishedOnly=false,validateStatus=true){
  core.check(has(name),'NOT_FOUND','集合不存在',404);
  const s=contextState(session),scope=publishedOnly?{where:publishedContentWhere,params:[]}:access(name,session,s);
  core.check(scope,'FORBIDDEN','无权访问此集合',403);
  const limit=Number(params.limit||50),offset=Number(params.offset||0),supportDirectory=name==='outlets'&&session.actor==='support';
  core.check(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset非负');
  const conditions=['('+scope.where+')'],args=[...scope.params];
  const countOutletStatuses=validateStatus&&name==='outlets'&&params.includeStatusCounts==='true'&&!!core.own(session.actor);
  if(supportDirectory&&params.owner&&params.owner!=='all')core.fail('FORBIDDEN','客服网点目录不提供主体筛选',403);
  if(validateStatus){
   checkCollectionStatus(name,params.status);
   if(name==='requests'&&params.scope==='location')conditions.push("json_extract(data,'$.type') IN ('newOutlet','locationChange')");
  }
  for(const key of ['status','month','outlet','owner'])if(params[key]&&params[key]!=='all'&&!(countOutletStatuses&&key==='status')){
   conditions.push(key+'=?');args.push(String(params[key]));
  }
  if(name==='reports'&&validateStatus&&params.latestOnly!==undefined){
   core.check(['true','false'].includes(params.latestOnly),'INPUT','仅查询最新版本的筛选值无效');
   if(params.latestOnly==='true')conditions.push(
    'NOT EXISTS (SELECT 1 FROM reports newer WHERE newer.outlet=reports.outlet AND newer.month=reports.month AND newer.owner IS reports.owner AND newer.version>reports.version)'
   );
  }
  for(const key of ['province','city','district','type'])if(params[key]&&params[key]!=='all'){
   conditions.push(`json_extract(data,'$.${key}')=?`);args.push(String(params[key]));
  }
  if((name==='contentVersions'||name==='contents')&&params.key){
   core.check(typeof params.key==='string'&&/^(brand|brand-logo|headquarters-address|official-wechat|services|news|cases|cooperation|service-[1-5])$/.test(params.key),'INPUT','内容栏目无效');
   conditions.push("json_extract(data,'$.key')=?");args.push(params.key);
  }
  if(params.id){conditions.push('id=?');args.push(params.id);}
  if(params.q){
   core.check(typeof params.q==='string'&&params.q.length<=100,'INPUT','搜索词过长');
   const names=supportDirectory?['name','province','city','district']:['name','managerName','subject','province','city','district'];
   const asText=key=>`COALESCE(json_extract(data,'$.${key}'),'')`;
   const fields=[names.map(asText).join("||' '||"),...(!supportDirectory?['title','question','address'].map(asText):[]),'id'];
   conditions.push('('+fields.map(field=>`${field} LIKE ? ESCAPE '\\'`).join(' OR ')+')');
   const term='%'+params.q.replace(/[\\%_]/g,'\\$&')+'%';
   args.push(...fields.map(()=>term));
  }
  let statusCounts;
  if(countOutletStatuses){
   statusCounts={all:0,...Object.fromEntries(collectionStatuses.outlets.map(status=>[status,0]))};
   const groups=db.prepare(`SELECT status,count(*) n FROM outlets WHERE ${conditions.join(' AND ')} GROUP BY status`).all(...args);
   for(const {status,n} of groups){
    statusCounts.all+=n;
    if(collectionStatuses.outlets.includes(status))statusCounts[status]=n;
   }
   if(params.status&&params.status!=='all'){conditions.push('status=?');args.push(String(params.status));}
  }
  const where=conditions.join(' AND ');
  const total=statusCounts?statusCounts[params.status||'all']??0:
   db.prepare(`SELECT count(*) n FROM ${name} WHERE ${where}`).get(...args).n;
  const payload=name==='settlements'&&!params.id?"json_remove(data,'$.reportValues') AS data":'data';
  const records=db.prepare(`SELECT ${payload} FROM ${name} WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args,limit,offset).map(x=>JSON.parse(x.data));
  return {s,records,total,offset,limit,hasMore:offset+records.length<total,statusCounts};
 }
 function project(name,records,s,session){const ids=new Set(records.map(x=>x.id));s[name]=records;const related=[...new Set(records.flatMap(x=>[x.outlet]).filter(Boolean))];if(name!=='outlets')s.outlets=db.prepare('SELECT data FROM outlets WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(related)).map(x=>JSON.parse(x.data));if(name==='settlements'&&session.actor!=='manager'){const reportIds=[...new Set(records.flatMap(x=>x.reportIds||[]))];s.reports=db.prepare('SELECT data FROM reports WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(reportIds)).map(x=>JSON.parse(x.data));const oids=[...new Set([...s.reports.map(x=>x.outlet),...records.flatMap(record=>record.affectedOutletIds||[])])];s.outlets=db.prepare('SELECT data FROM outlets WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(oids)).map(x=>JSON.parse(x.data));}
  if(name==='reports'&&core.own(session.actor)&&records.length){const groups=records.map(r=>r.outlet+'|'+r.month);const latest=db.prepare("SELECT r.data FROM reports r JOIN (SELECT outlet,month,max(version) v FROM reports WHERE outlet||'|'||month IN (SELECT value FROM json_each(?)) GROUP BY outlet,month) x ON r.outlet=x.outlet AND r.month=x.month AND r.version=x.v").all(JSON.stringify(groups)).map(x=>JSON.parse(x.data));s.reports=[...records,...latest.filter(r=>!ids.has(r.id))];}
  if(name==='messages'){const requestIds=[...new Set(records.map(row=>row.recordId).filter(Boolean))];s.requests=db.prepare('SELECT data FROM requests WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(requestIds)).map(row=>JSON.parse(row.data));restoreNoticeLinks(records,session);}
  if(name==='businessTasks'&&records.some(row=>operations.timedReportTask(row))){
   const policy=reportPolicy(s.today);
   for(const row of records)if(operations.timedReportTask(row)&&['open','in_progress'].includes(row.status))operations.updateReportTaskTiming(row,operations.reportTiming(s,row.month,policy));
  }
  if(name==='organizations')s.outlets=db.prepare('SELECT data FROM outlets WHERE owner IN (SELECT value FROM json_each(?))').all(JSON.stringify(records.map(x=>x.id))).map(x=>JSON.parse(x.data));
  if(name==='pricePlans'&&core.own(session.actor))s.agreements=db.prepare('SELECT data FROM agreements WHERE owner=?').all(core.own(session.actor)).map(x=>JSON.parse(x.data));
  if(name==='outlets')s.publicProfiles=db.prepare("SELECT data FROM publicProfiles WHERE status='published' AND outlet IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(JSON.stringify(records.map(x=>x.id))).map(x=>JSON.parse(x.data));
  const v=core.view(s,session.actor,session),rows=name==='supportChats'?v.support.chats:name==='supportTickets'?v.support.tickets:v[name];
  return (rows||[]).filter(x=>ids.has(x.id)).map(x=>x.outlet?{...x,outletName:s.outlets.find(o=>o.id===x.outlet)?.name||x.outlet}:x);
 }
 function locationTasks(session,params={}){
  core.check(core.own(session.actor)||['manager','location'].includes(session.actor),'FORBIDDEN','当前岗位无位置待办权限',403);
  const s=contextState(session);core.view(s,session.actor,session);const month=s.today.slice(0,7),scope=access('outlets',session,s),limit=Number(params.limit??50),offset=Number(params.offset??0),status=params.status||'all';
  core.check(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset非负');
  core.check(['all','missing','pending','exception','approved'].includes(status),'INPUT','位置待办status须为missing/pending/exception/approved/all');
  core.check(!params.month||params.month===month,'INPUT','位置待办仅查询当前业务月份');
  const conditions=['('+scope.where+')',"o.status IN ('open','paused')"],args=[...scope.params];
  for(const key of ['outlet','owner'])if(params[key]&&params[key]!=='all'){conditions.push('o.'+(key==='outlet'?'id':'owner')+'=?');args.push(String(params[key]));}
  for(const key of ['province','city','district'])if(params[key]&&params[key]!=='all'){conditions.push(`json_extract(o.data,'$.${key}')=?`);args.push(String(params[key]));}
  if(params.id){conditions.push('o.id=?');args.push(String(params.id).replace(/^location-/,''));}
  if(params.q){core.check(typeof params.q==='string'&&params.q.length<=100,'INPUT','搜索词过长');conditions.push("(COALESCE(json_extract(o.data,'$.name'),'')||' '||COALESCE(json_extract(o.data,'$.address'),'')||' '||COALESCE(json_extract(o.data,'$.city'),'')) LIKE ? ESCAPE '\\'");args.push('%'+params.q.replace(/[\\%_]/g,'\\$&')+'%');}
  const base=`WITH candidates AS (SELECT o.data,o.rowid sequence,COALESCE((SELECT v.status FROM verifications v WHERE v.outlet=o.id AND v.month=? ORDER BY v.rowid DESC LIMIT 1),'missing') task_status FROM outlets o WHERE ${conditions.join(' AND ')})`,where="task_status<>'approved'"+(status==='all'?'':' AND task_status=?'),bound=[month,...args,...(status==='all'?[]:[status])];
  const total=db.prepare(`${base} SELECT count(*) n FROM candidates WHERE ${where}`).get(...bound).n;
  s.outlets=db.prepare(`${base} SELECT data FROM candidates WHERE ${where} ORDER BY sequence DESC LIMIT ? OFFSET ?`).all(...bound,limit,offset).map(x=>JSON.parse(x.data));
  s.verifications=db.prepare('SELECT data FROM verifications WHERE month=? AND outlet IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(month,JSON.stringify(s.outlets.map(x=>x.id))).map(x=>JSON.parse(x.data));
  const items=core.view(s,session.actor,session).locationTasks.map(x=>({...x,outletName:s.outlets.find(o=>o.id===x.outlet)?.name||x.outlet}));
  return {items,total,offset,limit,hasMore:offset+items.length<total};
 }
 function reportVersionNumbers(items){
  if(!items.length)return;
  const groups=items.map(({outlet,month,owner})=>({outlet,month,owner}));
  const rows=db.prepare(
   "WITH visible AS (SELECT DISTINCT json_extract(value,'$.outlet') outlet,json_extract(value,'$.month') month,json_extract(value,'$.owner') owner FROM json_each(?)) "+
   "SELECT v.outlet,v.month,v.owner,"+
   "(SELECT r.version FROM reports r WHERE r.outlet=v.outlet AND r.month=v.month AND r.owner IS v.owner AND r.current=1 AND r.status='approved' AND NOT COALESCE(json_extract(r.data,'$.revoked'),0) ORDER BY r.version DESC LIMIT 1) effective,"+
   "(SELECT r.version FROM reports r WHERE r.outlet=v.outlet AND r.month=v.month AND r.owner IS v.owner ORDER BY r.version DESC LIMIT 1) latest FROM visible v"
  ).all(JSON.stringify(groups));
  const key=row=>JSON.stringify([row.outlet,row.month,row.owner]);
  const numbers=new Map(rows.map(row=>[key(row),{effective:row.effective,latest:row.latest}]));
  for(const item of items)item.versionNumbers=numbers.get(key(item));
 }
 function addReportRevenueComparisons(items){
  const visible=items.filter(item=>Number.isFinite(item.revenue)&&item.outlet&&/^\d{4}-(0[1-9]|1[0-2])$/.test(item.month));
  if(!visible.length)return;
  const keys=visible.map(item=>({id:item.id,outlet:item.outlet,owner:item.owner,month:operations.previousMonth(item.month)}));
  const prior=new Map(db.prepare(`
    WITH periods AS (
      SELECT json_extract(value,'$.id') id,json_extract(value,'$.outlet') outlet,
        json_extract(value,'$.owner') owner,json_extract(value,'$.month') month
      FROM json_each(?)
    )
    SELECT p.id,p.month,json_extract(r.data,'$.revenue') revenue
    FROM periods p LEFT JOIN reports r ON r.outlet=p.outlet AND r.owner IS p.owner AND r.month=p.month
      AND r.current=1 AND r.status='approved' AND NOT COALESCE(json_extract(r.data,'$.revoked'),0)
  `).all(JSON.stringify(keys)).map(row=>[row.id,row]));
  for(const item of visible){
   const baseline=prior.get(item.id);
   const previous=Number.isFinite(baseline.revenue)?Math.round(baseline.revenue*100):null;
   const current=Math.round(item.revenue*100);
   const comparison={month:baseline.month,percent:null};
   if(Number.isSafeInteger(previous)&&previous>0&&Number.isSafeInteger(current)){
    const denominator=BigInt(previous);
    const delta=(BigInt(current)-denominator)*10000n;
    const magnitude=((delta<0n?-delta:delta)+denominator/2n)/denominator;
    comparison.percent=Number(delta<0n?-magnitude:magnitude)/100;
   }
   item.revenueComparison=comparison;
  }
 }
 function addReportSubmitterNames(items){
  if(!items.length)return;
  const rows=db.prepare(`
   SELECT requested.value id, (
    SELECT event.submitter_name
    FROM approval_events event
    WHERE event.collection='reports' AND event.object_id=requested.value AND event.action='report.submit'
    ORDER BY event.seq LIMIT 1
   ) submitterName
   FROM json_each(?) requested
  `).all(JSON.stringify(items.map(item=>item.id)));
  const names=new Map(rows.map(row=>[row.id,row.submitterName]));
  for(const item of items)item.submitterName=names.get(item.id);
 }
 function addReportOutletPhotos(items){
  if(!items.length)return;
  const ids=[...new Set(items.map(item=>item.outlet))];
  const rows=db.prepare(`
   SELECT o.id, photo.file_id imageId
   FROM outlets o
   JOIN publicProfiles p ON p.id=(
    SELECT candidate.id FROM publicProfiles candidate
    WHERE candidate.outlet=o.id AND candidate.status='published' ORDER BY candidate.rowid DESC LIMIT 1
   )
   JOIN public_outlet_photos photo ON photo.file_id=json_extract(p.data,'$.imageId')
   WHERE o.status<>'closed' AND o.id IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(ids));
  const photos=new Map(rows.map(row=>[row.id,row.imageId]));
  for(const item of items)if(photos.has(item.outlet))item.outletPhotoId=photos.get(item.outlet);
 }
 function publicOutlets(params,publishedOnly){
  const limit=Number(params.limit??50),offset=Number(params.offset??0);
  core.check(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset非负');
  core.check(!params.owner||params.owner==='all','FORBIDDEN','公开网点目录不提供主体筛选',403);
  const from=`FROM outlets o LEFT JOIN publicProfiles p ON p.id=(
   SELECT candidate.id FROM publicProfiles candidate WHERE candidate.outlet=o.id AND candidate.status='published'
   ORDER BY candidate.rowid DESC LIMIT 1)`;
  const points=params.spatial==='points';
  const countryCode=params.countryCode?regions.countryCode(params.countryCode):null;
  const geo=params.geo||'all';
  core.check(!params.spatial||points,'INPUT','网点查询模式无效');
  core.check(['all','mainland','overseas'].includes(geo)&&(!params.countryCode||countryCode),'INPUT','网点地区筛选无效');
  const country="COALESCE(json_extract(p.data,'$.countryCode'),'CN')";
  const conditions=["o.status<>'closed'"];
  if(publishedOnly||points)conditions.push('p.id IS NOT NULL');
  if(geo==='mainland')conditions.push(country+"='CN'");
  if(geo==='overseas')conditions.push(country+"<>'CN'");
  if(points)conditions.push("json_extract(p.data,'$.publicCoords.lat') BETWEEN -90 AND 90",
   "json_extract(p.data,'$.publicCoords.lng') BETWEEN -180 AND 180",
   "json_extract(p.data,'$.publicCoords.coordinateSystem')=CASE WHEN "+country+"='CN' THEN 'GCJ-02' ELSE 'WGS-84' END");
  const args=[];
  if(countryCode){conditions.push(country+'=?');args.push(countryCode);}
  const locationField=key=>`CASE WHEN p.id IS NULL THEN json_extract(o.data,'$.${key}') ELSE json_extract(p.data,'$.${key}') END`;
  for(const [key,field] of Object.entries({id:'o.id',outlet:'o.id',status:'o.status',province:locationField('province'),city:locationField('city'),district:locationField('district')})){
   if(params[key]&&(key==='id'||params[key]!=='all')){conditions.push(`(${field})=?`);args.push(String(params[key]));}
  }
  if(params.q){
   core.check(typeof params.q==='string'&&params.q.length<=100,'INPUT','搜索词过长');
   const fields=["CASE WHEN p.id IS NULL THEN json_extract(o.data,'$.name') ELSE json_extract(p.data,'$.title') END",
    "json_extract(p.data,'$.address')",...['province','city','district'].map(locationField),'o.id'];
   conditions.push('('+fields.map(field=>`(${field}) LIKE ? ESCAPE '\\'`).join(' OR ')+')');
   const term='%'+params.q.replace(/[\\%_]/g,'\\$&')+'%';
   args.push(...fields.map(()=>term));
  }
  const where=conditions.join(' AND ');
  const total=db.prepare(`SELECT count(*) n ${from} WHERE ${where}`).get(...args).n;
  let items;
  if(points){
   const rows=db.prepare(`SELECT o.id,o.status,${country} countryCode,json_extract(p.data,'$.title') name,
    json_extract(p.data,'$.publicCoords.lat') latitude,json_extract(p.data,'$.publicCoords.lng') longitude,
    json_extract(p.data,'$.publicCoords.coordinateSystem') coordinateSystem ${from}
    WHERE ${where} ORDER BY o.rowid DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
   items=rows.map(({id,status,countryCode,name,latitude,longitude,coordinateSystem})=>({
    id,status,countryCode,name,publicLocation:{latitude,longitude,coordinateSystem,precision:'public'}
   }));
  }else{
   const rows=db.prepare(`SELECT o.data outlet,p.data profile ${from} WHERE ${where} ORDER BY o.rowid DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
   items=rows.map(row=>operations.publicOutlet(JSON.parse(row.outlet),row.profile?JSON.parse(row.profile):null));
  }
  const result={items,total,offset,limit,hasMore:offset+items.length<total};
  if(params.includeCountries==='true'){
   const codes=db.prepare(`SELECT DISTINCT ${country} code ${from} WHERE o.status<>'closed' AND p.id IS NOT NULL`).all();
   result.countries=codes.filter(row=>regions.countryCode(row.code)).map(({code})=>({code,name:regions.countryName(code)}))
    .sort((left,right)=>left.name.localeCompare(right.name,'zh-CN'));
  }
  return result;
 }
 function markUnavailableAssignedActions(name, items, session) {
  const actions = approvalCommandsByCollection[name];
  if (!actions || !items.length || !['ops', 'finance', 'location', 'regional'].includes(session.actor)) return;
  const activeTasks = db.prepare(
    "SELECT data FROM businessTasks WHERE status IN ('open','in_progress') AND json_extract(data,'$.recordId') IN (SELECT value FROM json_each(?))"
  ).all(JSON.stringify(items.map(item => item.id))).map(row => JSON.parse(row.data));
  const tasksByRecord = new Map();
  for (const task of activeTasks) {
    if (!tasksByRecord.has(task.recordId)) tasksByRecord.set(task.recordId, []);
    tasksByRecord.get(task.recordId).push(task);
  }
  for (const item of items) {
    const businessTasks = tasksByRecord.get(item.id);
    if (!businessTasks) continue;
    const unavailableActions = actions.filter(action => hasAssignedAction({businessTasks}, action, {id:item.id}, session.subject));
    if (unavailableActions.length) item.unavailableActions = unavailableActions;
  }
 }
 function addRequestProgress(items) {
  const paused=items.filter(item=>item.type==='pauseFee'&&item.status==='approved');
  const adjustments=paused.length?db.prepare(`
   SELECT r.id requestId,a.status,json_extract(a.data,'$.offsetMonth') offsetMonth,
    b.id billId,b.month billMonth,b.status billStatus,
    EXISTS(SELECT 1 FROM feeProposals p WHERE p.outlet=a.outlet AND p.owner IS a.owner
     AND p.status='pending' AND json_extract(p.data,'$.adjustmentId')=a.id) pendingReview
   FROM requests r JOIN adjustments a ON a.outlet=r.outlet AND a.owner IS r.owner
    AND json_extract(a.data,'$.requestId')=r.id
   LEFT JOIN bills b ON b.id=json_extract(a.data,'$.appliedBillId') AND b.outlet=a.outlet AND b.owner IS a.owner
   WHERE r.id IN (SELECT value FROM json_each(?)) ORDER BY a.rowid
  `).all(JSON.stringify(paused.map(item=>item.id))):[];
  const byRequest=new Map(adjustments.map(row=>[row.requestId,row]));
  for(const item of items){
   if(item.status!=='approved')continue;
   if(item.policyPending===true){
    item.progress={stage:'awaiting_policy',label:'待确认生效规则',description:'总部已审批。现有经营或报送规则继续适用，请等待总部确认生效。'};
    continue;
   }
   if(item.type!=='pauseFee')continue;
   const adjustment=byRequest.get(item.id);
   if(adjustment?.status==='applied'&&adjustment.billId){
    const reversed=adjustment.billStatus==='reversed';
    item.progress={stage:reversed?'credit_bill_reversed':'credited',label:reversed?'抵扣账单已冲正':'已抵扣入账',
     description:reversed?'请查看原抵扣账单和关联的后续账单。':'费用调整已计入对应账期，可查看原抵扣账单。',
     billId:adjustment.billId,month:adjustment.billMonth};
   }else if(adjustment?.status==='approved'){
    item.progress={stage:'awaiting_credit_bill',label:'待抵扣入账',description:'财务已复核核算结果，抵扣将计入对应账期。',month:adjustment.offsetMonth};
   }else if(adjustment?.status==='待财务核算调整'){
    item.progress=adjustment.pendingReview
     ?{stage:'awaiting_finance_review',label:'待财务复核',description:'总部已提交费用核算方案，等待财务确认。'}
     :{stage:'awaiting_calculation',label:'待核算费用',description:'总部已审批停费申请，正在核算实际费用。'};
   }else{
    item.progress={stage:'adjustment_unavailable',label:'待核实费用进度',description:'暂无可核实的费用调整进度，请联系总部。'};
   }
  }
 }
 function list(name,session,params={},validateStatus=true){
  if(name==='outlets'&&(params.scope==='public'||session.actor==='public')){
   if(validateStatus)checkCollectionStatus(name,params.status);
   const result=publicOutlets(params,params.scope==='public'||store.settings().mode==='production');
   return validateStatus?includeStatusOptions(result,name,params):result;
  }
  if(name==='locationTasks')return locationTasks(session,params);
  if(name==='businessTasks'&&core.own(session.actor))return tasks.taskList(session,{...params,queue:'partner',status:params.status||'all'});
  if(name==='publicContents'){
   const p=query('contents',session,{id:params.id,key:params.key,limit:params.limit,offset:params.offset},true);
   return {items:p.records.map(operations.publicContent).filter(Boolean),total:p.total,offset:p.offset,limit:p.limit,hasMore:p.hasMore};
  }
  const p=query(name,session,params,false,validateStatus),items=project(name,p.records,p.s,session);
  markUnavailableAssignedActions(name,items,session);
  if(name==='requests')addRequestProgress(items);
  if(name==='staffAccounts'&&session.actor==='manager'){
   const activated=new Set(activatedStaffIds(db,items.map(staff=>staff.id)));
   for(const staff of items)staff.activated=activated.has(staff.id);
  }
  if(name==='outlets'&&params.includeSummary==='true'&&core.own(session.actor)){
   addOutletSummaries(db,items,core.own(session.actor),p.s.today);
   const profiles=new Map(p.s.publicProfiles.map(profile=>[profile.outlet,profile]));
   for(const item of items){
    const photo=profiles.get(item.id)?.imageId;
    if(photo&&item.status!=='closed')item.publishedImageId=photo;
   }
  }
  if(name==='reports'&&params.includeVersionNumbers==='true')reportVersionNumbers(items);
  if(name==='reports'&&params.includeRevenueComparison==='true'&&all.includes(session.actor))addReportRevenueComparisons(items);
  if(name==='reports'&&params.includeSubmitter==='true'&&all.includes(session.actor))addReportSubmitterNames(items);
  if(name==='reports'&&params.includeOutletPhoto==='true'&&all.includes(session.actor))addReportOutletPhotos(items);
  if(name==='refundRequests'&&core.own(session.actor))markPendingRefunds(db,items);
  if(name==='bills'&&canReadLedger(session.actor)){const metrics=billMetrics(db,items.map(b=>b.id),p.s.today);for(const bill of items)bill.ledger=metrics.get(bill.id);}
  const result={items,total:p.total,offset:p.offset,limit:p.limit,hasMore:p.hasMore,
   ...(p.statusCounts?{statusCounts:p.statusCounts}:{})};
  return validateStatus?includeStatusOptions(result,name,params):result;
 }
 function detail(name,id,session,{scope,includeSummary,includeRevenueComparison,includeSubmitter,includeOutletPhoto}={}){if(name==='businessTasks'&&core.own(session.actor))return tasks.taskDetail(session,id);const result=list(name,session,{id,limit:1,scope,includeSummary,includeRevenueComparison,includeSubmitter,includeOutletPhoto});core.check(result.items.length,'NOT_FOUND','记录不存在或无权访问',404);return result.items[0];}
 function approvalRecord(name,id,session){const page=query(name,session,{id,limit:1});core.check(page.records.length,'NOT_FOUND','记录不存在或无权访问',404);return page.records[0];}
 function agencyInfo(session){
  const owner=core.own(session.actor);if(!owner)return null;
  const row=db.prepare('SELECT data FROM organizations WHERE id=?').get(owner);if(!row)return null;
  const org=JSON.parse(row.data),parent=db.prepare("SELECT json_extract(data,'$.parentOwner') parentOwner FROM agencyRelations WHERE owner=? AND status='active'").get(owner);
  const childCount=db.prepare("SELECT count(*) n FROM agencyRelations WHERE status='active' AND json_extract(data,'$.parentOwner')=?").get(owner).n;
  return {level:org.level??null,isPrimary:org.level===1,parentOwner:parent?.parentOwner||null,childCount};
 }
 function entitlements(session){
  const owner=core.own(session.actor);if(!owner)return null;
  const current=typeof today==='function'?today():store.settings().today,month=current.slice(0,7);
  const rows=db.prepare("SELECT data FROM agreements WHERE owner=? AND status='active'").all(owner).map(row=>JSON.parse(row.data));
  const items=rows.filter(row=>row.startMonth<=month&&row.endMonth>=month).map(row=>{
   const price=row.priceSnapshot||{};
   return {agreementId:row.id,outlet:row.outlet,reference:row.reference??null,
    services:Array.isArray(price.services)?price.services:[],terms:price.terms??null,
    amountCents:row.amount==null?null:Math.round(Number(row.amount)*100),currency:price.currency||'CNY',
    priceVersion:price.id??row.priceVersion??null,planName:price.name??null,
    serviceEntity:price.serviceEntity??null,collectionEntity:price.collectionEntity??null,invoiceEntity:price.invoiceEntity??null,
    startMonth:row.startMonth??null,endMonth:row.endMonth??null};
  });
  return {month,items,services:[...new Set(items.flatMap(item=>item.services))]};
 }
 function context(session){const s=contextState(session),v=core.view(s,session.actor,session);return {actor:session.actor,subject:session.subject,today:s.today,mode:s.mode,capabilities:v.capabilities,grants:v.grants,support:{settings:v.support.settings},agency:agencyInfo(session),entitlements:entitlements(session),...(session.actor==='manager'?{routingOptions}:{})};}
 // The legacy snapshot applies the same status to every collection. Individual lists validate their own enum.
 function snapshot(session,params={}){const v=context(session);v.support={...v.support,chats:[],tickets:[]};v.pagination={};for(const name of core.COLLECTIONS){if(!access(name,session,contextState(session))){if(!name.startsWith('support'))v[name]=[];continue;}const page=list(name,session,params,false);if(name==='supportChats')v.support.chats=page.items;else if(name==='supportTickets')v.support.tickets=page.items;else v[name]=page.items;v.pagination[name]={...page,items:undefined};}v.locationTasks=core.own(session.actor)||['manager','location'].includes(session.actor)?list('locationTasks',session,{limit:params.limit,offset:params.offset}).items:[];return v;}
 function commandState(session,command,payload){const {scopedCommandState}=require('./command-scope.cjs');const loaded=scopedCommandState(store,session,command,payload,typeof today==='function'?today():store.settings().today);Object.defineProperty(loaded.state,'__jobScope',{value:loaded.jobScope,enumerable:false});return loaded.state;}

 function reportEligibility(s,outlet,month,currentApprovedVersion,actor){
  const enrollmentStatus=operations.enrollmentFor(outlet,month);
  const isOwner=core.own(actor)===outlet.owner&&!!outlet.owner;
  const reviewing=s.reports.some(x=>['pending','finance'].includes(x.status));
  const block=core.reportMonthBlock(s,outlet,month);
  const canCorrect=isOwner&&!block&&!reviewing&&!!currentApprovedVersion&&!currentApprovedVersion.correctionAllowed;
  const reason=!isOwner?'read_only':block?.reason||(reviewing?'reviewing':canCorrect?'correction_required':null);
  const canEdit=reason===null;
  return {block,enrollmentStatus,eligibility:{canEdit,canSubmit:canEdit&&enrollmentStatus!=='pending',canCorrect,reason}};
 }

 function reportWorklist(session,params={}){
  core.check(session.role==='partner'&&core.own(session.actor),'FORBIDDEN','仅加盟商可查看经营月报清单',403);
  const {month,outlet='all',status:filter='all'}=params;
  const limit=Number(params.limit??25),offset=Number(params.offset??0);
  core.check(typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month),'INPUT','月份格式无效');
  core.check(typeof outlet==='string'&&outlet.length>0&&outlet.length<=128,'INPUT','网点格式无效');
  core.check(filter==='all'||Object.hasOwn(reportWorklistFilters,filter),'INPUT','月报筛选状态无效');
  core.check((params.limit===undefined||/^\d+$/.test(String(params.limit)))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=50&&
   (params.offset===undefined||/^\d+$/.test(String(params.offset)))&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','limit须1—50，offset非负');

  const s=contextState(session),scope=access('outlets',session,s),exact=outlet!=='all';
  const outlets=db.prepare(`SELECT data FROM outlets WHERE (${scope.where})${exact?' AND id=?':''} ORDER BY id`)
   .all(...scope.params,...(exact?[outlet]:[])).map(row=>JSON.parse(row.data));
  core.check(!exact||outlets.length,'FORBIDDEN','无网点权限',403);
  const summary={expected:0,submitted:0,exempt:0,actionable:0,awaitingExemption:0,inReview:0};
  if(!outlets.length)return {month,items:[],total:0,offset,limit,hasMore:false,summary};

  const ids=JSON.stringify(outlets.map(row=>row.id)),policy=reportPolicy(s.today);
  s.policies=policy?[policy]:[];
  const {dueOn}=operations.reportTiming(s,month,policy);
  function monthRows(name,fields,suffix=''){
   const accessScope=access(name,session,s);
   return db.prepare(`SELECT ${fields} FROM ${name} WHERE (${accessScope.where}) AND month=?
    AND outlet IN (SELECT value FROM json_each(?)) ${suffix}`).all(...accessScope.params,month,ids);
  }
  // Pick only the latest, effective and reviewing versions. Worklist rows don't use report values or trails.
  const reports=monthRows('reports',`id,outlet,month,version,status,current,
   json_extract(data,'$.revoked') revoked,json_extract(data,'$.correctionAllowed') correctionAllowed,
   json_extract(data,'$.dueOn') dueOn,json_extract(data,'$.late') late,
   CASE WHEN status='returned' THEN json_extract(data,'$.reviewNote') END returnNote`,
  `AND (current=1 OR status IN ('pending','finance') OR version=(SELECT max(v.version) FROM reports v
    WHERE v.outlet=reports.outlet AND v.month=reports.month AND v.owner=reports.owner))`);
  const versionsByOutlet=Map.groupBy(reports,row=>row.outlet);
  const drafts=new Set(monthRows('drafts','outlet').map(row=>row.outlet));
  const exemptions=Map.groupBy(monthRows('exemptions','outlet,month,status',"AND status='approved'"),row=>row.outlet);
  const items=[];
  let total=0;
  for(const record of outlets){
   const state={...s,reports:versionsByOutlet.get(record.id)||[],exemptions:exemptions.get(record.id)||[]};
   const {newest,approved,latest}=operations.reportVersions(state.reports);
   const {block,enrollmentStatus,eligibility}=reportEligibility(state,record,month,approved,session.actor);
   const status=block?blockedReportStatuses[block.reason]:
    ['pending','finance'].includes(latest?.status)?latest.status:
    drafts.has(record.id)?'draft':latest?.status==='returned'?'returned':approved?'approved':'missing';
   const related=status==='approved'?approved:['pending','finance','returned'].includes(status)?latest:null;
   const counts=operations.coverage(state,[record],[month]);
   summary.expected+=counts.expected;
   summary.submitted+=counts.submitted;
   summary.exempt+=counts.exempt;
   if(reportWorklistFilters.action.includes(status))summary.actionable++;
   if(status==='exemption_pending')summary.awaitingExemption++;
   if(['pending','finance'].includes(status))summary.inReview++;

   if(filter!=='all'&&!reportWorklistFilters[filter].includes(status))continue;
   if(total++<offset||items.length>=limit)continue;
   const reason=eligibility.reason||(enrollmentStatus==='pending'?'enrollment_pending':null);
   items.push({outletId:record.id,outletName:record.name,month,status,reason,reportId:related?.id??null,
    latestVersion:newest?.version??null,effectiveVersion:approved?.version??null,
    dueOn:status==='not_open'||status==='not_required'||status==='exempt'?null:related?.dueOn??dueOn,canSubmit:eligibility.canSubmit,
    returnNote:['draft','returned'].includes(status)&&latest?.status==='returned'?latest.returnNote:null,
    late:related?.late===1});
  }
  return {month,items,total,offset,limit,hasMore:offset+items.length<total,summary};
 }

 function reportContext(session,params={}){
  const s=contextState(session),scope=access('reports',session,s);
  core.check(scope,'FORBIDDEN','无月报权限',403);
  const {outlet,month}=params;
  core.check(typeof outlet==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month),'INPUT','网点和月份必填');
  const outScope=access('outlets',session,s),o=db.prepare('SELECT data FROM outlets WHERE ('+outScope.where+') AND id=?').get(...outScope.params,outlet);
  core.check(o,'FORBIDDEN','无网点权限',403);
  const outletRecord=JSON.parse(o.data);
  s.outlets=[outletRecord];
  s.reports=db.prepare('SELECT data FROM reports WHERE outlet=? AND month=? ORDER BY version').all(outlet,month).map(x=>JSON.parse(x.data));
  s.drafts=db.prepare('SELECT data FROM drafts WHERE outlet=? AND month=?').all(outlet,month).map(x=>JSON.parse(x.data));
  s.exemptions=db.prepare('SELECT data FROM exemptions WHERE outlet=? AND month=?').all(outlet,month).map(x=>JSON.parse(x.data));
  const v=core.view(s,session.actor,session),historyVersions=v.reports;
  const currentApprovedVersion=historyVersions.find(x=>x.current&&x.status==='approved'&&!x.revoked)||null;
  const {enrollmentStatus,eligibility}=reportEligibility(s,outletRecord,month,currentApprovedVersion,session.actor);
  return {outlet,month,draft:v.drafts[0]||null,currentApprovedVersion,latestSubmittedVersion:historyVersions.at(-1)||null,historyVersions,enrollmentStatus,timing:operations.reportTiming(s,month,reportPolicy(s.today)),eligibility};
 }
 function agencyProgress(session,params={}){
  const owner=core.own(session.actor);
  core.check(owner,'FORBIDDEN','仅加盟主体可查看下级报送',403);
  const s=contextState(session),today=s.today;
  const orgRow=db.prepare('SELECT data FROM organizations WHERE id=?').get(owner);
  core.check(orgRow,'FORBIDDEN','当前主体没有加盟档案',403);
  core.check(JSON.parse(orgRow.data).level===1,'FORBIDDEN','当前主体未设为主代理，不能查看下级报送',403);
  const raw=params.month===undefined||params.month===null||params.month===''?agency.previousMonth(today):String(params.month);
  core.check(agency.monthPattern.test(raw),'INPUT','月份格式无效');
  core.check(raw<=today.slice(0,7),'INPUT','不能查看未来月份的报送进度');
  s.organizations=db.prepare('SELECT data FROM organizations').all().map(row=>JSON.parse(row.data));
  s.agencyRelations=db.prepare("SELECT data FROM agencyRelations WHERE status='active'").all().map(row=>JSON.parse(row.data));
  s.agreements=db.prepare('SELECT data FROM agreements WHERE owner=?').all(owner).map(row=>JSON.parse(row.data));
  const childOwners=s.agencyRelations.filter(row=>row.parentOwner===owner).map(row=>row.childOwner);
  s.outlets=db.prepare('SELECT data FROM outlets WHERE owner IN (SELECT value FROM json_each(?))').all(JSON.stringify([owner,...childOwners])).map(row=>JSON.parse(row.data));
  const outletIds=JSON.stringify(s.outlets.map(row=>row.id));
  s.reports=db.prepare('SELECT data FROM reports WHERE month=? AND outlet IN (SELECT value FROM json_each(?))').all(raw,outletIds).map(row=>JSON.parse(row.data));
  s.drafts=db.prepare('SELECT data FROM drafts WHERE month=? AND outlet IN (SELECT value FROM json_each(?))').all(raw,outletIds).map(row=>JSON.parse(row.data));
  s.exemptions=db.prepare('SELECT data FROM exemptions WHERE month=? AND outlet IN (SELECT value FROM json_each(?))').all(raw,outletIds).map(row=>JSON.parse(row.data));
  s.messages=db.prepare("SELECT data FROM messages WHERE json_extract(data,'$.agencyUrge.parentOwner')=? AND json_extract(data,'$.agencyUrge.month')=?").all(owner,raw).map(row=>JSON.parse(row.data));
  const policy=reportPolicy(today);s.policies=policy?[policy]:[];
  return agency.progress(s,session.actor,{month:raw},today);
 }
 const tasks=taskQueries(db,{contextState,access,detail,reportPolicy});
 function workbenchRecords(session,params){
  const owner=core.own(session.actor);
  core.check(owner,'FORBIDDEN','仅加盟商可查看本方业务记录',403);
  const outlet=params.outlet&&params.outlet!=='all'?params.outlet:null;
  const limit=Number(params.limit??20),offset=Number(params.offset??0);
  core.check(Number.isSafeInteger(limit)&&limit>=1&&limit<=100&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','业务记录分页参数无效');
  if(outlet)core.check(/^[\w-]{1,128}$/.test(outlet),'INPUT','网点编号无效');
  const state=contextState(session);
  const reports=access('reports',session,state),tickets=access('supportTickets',session,state);
  const sql=`WITH activity AS (
    SELECT 'report' AS kind,id,outlet,month,NULL AS title,
      CASE WHEN json_extract(data,'$.revoked') THEN 'revoked' ELSE status END AS status,
      COALESCE(json_extract(data,'$.trail[#-1].executedAt'),created_at) AS occurredAt
    FROM reports WHERE (${reports.where})
      AND NOT EXISTS (SELECT 1 FROM reports newer WHERE newer.owner IS reports.owner
        AND newer.outlet=reports.outlet AND newer.month=reports.month AND newer.version>reports.version)
    UNION ALL
    SELECT 'support',id,outlet,NULL,json_extract(data,'$.title'),status,
      MAX(created_at,COALESCE(json_extract(data,'$.closedAt'),''),COALESCE(json_extract(data,'$.firstResponseAt'),''),
        COALESCE(json_extract(data,'$.messages[#-1].at'),''))
    FROM supportTickets WHERE (${tickets.where})
    UNION ALL
    SELECT 'training',r.id,r.outlet_id,NULL,c.title,r.status,r.updated_at
    FROM training_records r JOIN training_courses c ON c.id=r.course_id WHERE r.owner=?
  ), visible AS (
    SELECT activity.*,json_extract(o.data,'$.name') AS outletName
    FROM activity LEFT JOIN outlets o ON o.id=activity.outlet
    WHERE (activity.outlet IS NULL OR o.owner=?) AND (? IS NULL OR activity.outlet=?)
  )`;
  const args=[...reports.params,...tickets.params,owner,owner,outlet,outlet];
  const total=db.prepare(sql+' SELECT count(*) AS total FROM visible').get(...args).total;
  const items=db.prepare(sql+` SELECT kind,id,outlet,outletName,month,title,status,occurredAt FROM visible
    ORDER BY julianday(occurredAt) DESC,kind,id LIMIT ? OFFSET ?`).all(...args,limit,offset);
  const outletLabels=qualifiedOutletLabels(db,owner,items.map(item=>item.outlet));
  for(const item of items){
   const outletLabel=outletLabels.get(item.outlet);
   if(outletLabel)item.outletLabel=outletLabel;
  }
  return {items,total,offset,limit,hasMore:offset+items.length<total};
 }
 return {reportContext,reportWorklist,workbenchRecords,agencyProgress,list,detail,approvalRecord,context,snapshot,commandState,contextState,access,...tasks};
}
module.exports={repository};
