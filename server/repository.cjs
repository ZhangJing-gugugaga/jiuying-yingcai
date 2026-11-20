'use strict';
const core=require('../shared/core.cjs'),operations=require('../shared/operations.cjs');
const {taskQueries,partnerTaskAccess}=require('./tasks.cjs');
const {partnerKey}=require('../shared/responsibilities.cjs');
const {routingOptions,hasAssignedAction}=require('../shared/task-routing.cjs');
const {activatedStaffIds}=require('./staff-activation.cjs');
const {billMetrics,markPendingRefunds,canRead:canReadLedger}=require('./finance.cjs');
const {addOutletSummaries}=require('./outlet-summaries.cjs');
const regions=require('../shared/outlet-regions.cjs');
const approvalCommandsByCollection = {
  reports: ['review.report'],
  requests: ['review.request', 'review.revoke', 'location.review'],
  verifications: ['location.review'],
};
const all=['manager','ops','finance'];
const privateFinance=['bills','payments','receipts','adjustments','drafts','summaryAdjustments','agreements','billCorrections','feeProposals','offlinePayments','refundRequests','invoiceRequests'];
const published=['contents','faqEntries','publicProfiles'];
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
 importBatches:['preview','committed']
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
  if(supportDirectory&&params.owner&&params.owner!=='all')core.fail('FORBIDDEN','客服网点目录不提供主体筛选',403);
  if(validateStatus){
   checkCollectionStatus(name,params.status);
   if(name==='requests'&&params.scope==='location')conditions.push("json_extract(data,'$.type') IN ('newOutlet','locationChange')");
  }
  for(const key of ['status','month','outlet','owner'])if(params[key]&&params[key]!=='all'){
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
  if(name==='contentVersions'&&params.key){
   core.check(typeof params.key==='string'&&/^(brand|services|news|cases|cooperation|service-[1-5])$/.test(params.key),'INPUT','内容栏目无效');
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
  const where=conditions.join(' AND ');
  const total=db.prepare(`SELECT count(*) n FROM ${name} WHERE ${where}`).get(...args).n;
  const payload=name==='settlements'&&!params.id?"json_remove(data,'$.reportValues') AS data":'data';
  const records=db.prepare(`SELECT ${payload} FROM ${name} WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args,limit,offset).map(x=>JSON.parse(x.data));
  return {s,records,total,offset,limit,hasMore:offset+records.length<total};
 }
 function project(name,records,s,session){const ids=new Set(records.map(x=>x.id));s[name]=records;const related=[...new Set(records.flatMap(x=>[x.outlet]).filter(Boolean))];if(name!=='outlets')s.outlets=db.prepare('SELECT data FROM outlets WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(related)).map(x=>JSON.parse(x.data));if(name==='settlements'&&session.actor!=='manager'){const reportIds=[...new Set(records.flatMap(x=>x.reportIds||[]))];s.reports=db.prepare('SELECT data FROM reports WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(reportIds)).map(x=>JSON.parse(x.data));const oids=[...new Set([...s.reports.map(x=>x.outlet),...records.flatMap(record=>record.affectedOutletIds||[])])];s.outlets=db.prepare('SELECT data FROM outlets WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(oids)).map(x=>JSON.parse(x.data));}
  if(name==='reports'&&core.own(session.actor)&&records.length){const groups=records.map(r=>r.outlet+'|'+r.month);const latest=db.prepare("SELECT r.data FROM reports r JOIN (SELECT outlet,month,max(version) v FROM reports WHERE outlet||'|'||month IN (SELECT value FROM json_each(?)) GROUP BY outlet,month) x ON r.outlet=x.outlet AND r.month=x.month AND r.version=x.v").all(JSON.stringify(groups)).map(x=>JSON.parse(x.data));s.reports=[...records,...latest.filter(r=>!ids.has(r.id))];}
  if(name==='messages'){const requestIds=[...new Set(records.map(row=>row.recordId).filter(Boolean))];s.requests=db.prepare('SELECT data FROM requests WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(requestIds)).map(row=>JSON.parse(row.data));restoreNoticeLinks(records,session);}
  if(name==='businessTasks'&&records.some(row=>operations.timedReportTask(row))){
   const policy=reportPolicy(s.today);
   for(const row of records)if(operations.timedReportTask(row)&&['open','in_progress'].includes(row.status))operations.updateReportTaskTiming(row,operations.reportTiming(s,row.month,policy));
  }
  if(name==='organizations')s.outlets=db.prepare('SELECT data FROM outlets WHERE owner IN (SELECT value FROM json_each(?))').all(JSON.stringify(records.map(x=>x.id))).map(x=>JSON.parse(x.data));
  if(name==='pricePlans'&&core.own(session.actor))s.agreements=db.prepare('SELECT data FROM agreements WHERE owner=?').all(core.own(session.actor)).map(x=>JSON.parse(x.data));if(name==='outlets')s.publicProfiles=db.prepare("SELECT data FROM publicProfiles WHERE status='published' AND outlet IN (SELECT value FROM json_each(?))").all(JSON.stringify(records.map(x=>x.id))).map(x=>JSON.parse(x.data));const v=core.view(s,session.actor,session),rows=name==='supportChats'?v.support.chats:name==='supportTickets'?v.support.tickets:v[name];return (rows||[]).filter(x=>ids.has(x.id)).map(x=>x.outlet?{...x,outletName:s.outlets.find(o=>o.id===x.outlet)?.name||x.outlet}:x);}
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
 function list(name,session,params={},validateStatus=true){
  if(name==='outlets'&&(params.scope==='public'||session.actor==='public')){
   if(validateStatus)checkCollectionStatus(name,params.status);
   const result=publicOutlets(params,params.scope==='public'||store.settings().mode==='production');
   return validateStatus?includeStatusOptions(result,name,params):result;
  }
  if(name==='locationTasks')return locationTasks(session,params);
  if(name==='businessTasks'&&core.own(session.actor))return tasks.taskList(session,{...params,queue:'partner',status:params.status||'all'});
  if(name==='publicContents'){
   const p=query('contents',session,{id:params.id,limit:params.limit,offset:params.offset},true);
   return {items:p.records.map(operations.publicContent).filter(Boolean),total:p.total,offset:p.offset,limit:p.limit,hasMore:p.hasMore};
  }
  const p=query(name,session,params,false,validateStatus),items=project(name,p.records,p.s,session);
  markUnavailableAssignedActions(name,items,session);
  if(name==='staffAccounts'&&session.actor==='manager'){
   const activated=new Set(activatedStaffIds(db,items.map(staff=>staff.id)));
   for(const staff of items)staff.activated=activated.has(staff.id);
  }
  if(name==='outlets'&&params.includeSummary==='true'&&core.own(session.actor))addOutletSummaries(db,items,core.own(session.actor),p.s.today);
  if(name==='reports'&&params.includeVersionNumbers==='true')reportVersionNumbers(items);
  if(name==='refundRequests'&&core.own(session.actor))markPendingRefunds(db,items);
  if(name==='bills'&&canReadLedger(session.actor)){const metrics=billMetrics(db,items.map(b=>b.id),p.s.today);for(const bill of items)bill.ledger=metrics.get(bill.id);}
  const result={items,total:p.total,offset:p.offset,limit:p.limit,hasMore:p.hasMore};
  return validateStatus?includeStatusOptions(result,name,params):result;
 }
 function detail(name,id,session,{scope,includeSummary}={}){if(name==='businessTasks'&&core.own(session.actor))return tasks.taskDetail(session,id);const result=list(name,session,{id,limit:1,scope,includeSummary});core.check(result.items.length,'NOT_FOUND','记录不存在或无权访问',404);return result.items[0];}
 function approvalRecord(name,id,session){const page=query(name,session,{id,limit:1});core.check(page.records.length,'NOT_FOUND','记录不存在或无权访问',404);return page.records[0];}
 function context(session){const s=contextState(session),v=core.view(s,session.actor,session);return {actor:session.actor,subject:session.subject,today:s.today,mode:s.mode,capabilities:v.capabilities,grants:v.grants,support:{settings:v.support.settings},...(session.actor==='manager'?{routingOptions}:{})};}
 // The legacy snapshot applies the same status to every collection. Individual lists validate their own enum.
 function snapshot(session,params={}){const v=context(session);v.support={...v.support,chats:[],tickets:[]};v.pagination={};for(const name of core.COLLECTIONS){if(!access(name,session,contextState(session))){if(!name.startsWith('support'))v[name]=[];continue;}const page=list(name,session,params,false);if(name==='supportChats')v.support.chats=page.items;else if(name==='supportTickets')v.support.tickets=page.items;else v[name]=page.items;v.pagination[name]={...page,items:undefined};}v.locationTasks=core.own(session.actor)||['manager','location'].includes(session.actor)?list('locationTasks',session,{limit:params.limit,offset:params.offset}).items:[];return v;}
 function commandState(session,command,payload){const {scopedCommandState}=require('./command-scope.cjs');const loaded=scopedCommandState(store,session,command,payload,typeof today==='function'?today():store.settings().today);Object.defineProperty(loaded.state,'__jobScope',{value:loaded.jobScope,enumerable:false});return loaded.state;}

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
  const enrollmentStatus=operations.enrollmentFor(outletRecord,month);
  const isOwner=!!core.own(session.actor)&&core.own(session.actor)===outletRecord.owner;
  const reviewing=s.reports.some(x=>['pending','finance'].includes(x.status));
  const block=core.reportMonthBlock(s,outletRecord,month);
  const canCorrect=isOwner&&!block&&!reviewing&&!!currentApprovedVersion&&!currentApprovedVersion.correctionAllowed;
  const reason=!isOwner?'read_only':block?.reason||(reviewing?'reviewing':canCorrect?'correction_required':null);
  const canEdit=reason===null;
  return {outlet,month,draft:v.drafts[0]||null,currentApprovedVersion,latestSubmittedVersion:historyVersions.at(-1)||null,historyVersions,enrollmentStatus,timing:operations.reportTiming(s,month,reportPolicy(s.today)),eligibility:{canEdit,canSubmit:canEdit&&enrollmentStatus!=='pending',canCorrect,reason}};
 }
 const tasks=taskQueries(db,{contextState,access,detail,reportPolicy});
 return {reportContext,list,detail,approvalRecord,context,snapshot,commandState,contextState,access,...tasks};
}
module.exports={repository};
