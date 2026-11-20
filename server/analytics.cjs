'use strict';
const core=require('../shared/core.cjs'),operations=require('../shared/operations.cjs');

function settlementStatus(db,months,scope,params,reports,settled){
 const periods=db.prepare(`
  SELECT DISTINCT s.month,s.status FROM settlements s
  WHERE s.month IN (SELECT value FROM json_each(?)) AND (
   (s.status='approved' AND EXISTS (
    SELECT 1 FROM json_each(s.data,'$.affectedOutletIds') affected
    JOIN outlets o ON o.id=affected.value WHERE ${scope}
   )) OR (s.status='invalidated' AND json_extract(s.data,'$.supersededBy') IS NULL AND EXISTS (
    SELECT 1 FROM businessTasks t, json_each(t.data,'$.affectedOutletIds') affected
    JOIN outlets o ON o.id=affected.value
    WHERE json_extract(t.data,'$.kind')='report_resettlement' AND json_extract(t.data,'$.businessId')=s.id
      AND t.status IN ('open','in_progress') AND ${scope}
   ))
  ) ORDER BY s.month`).all(months,...params,...params);
 const pendingMonths=periods.filter(row=>row.status==='invalidated').map(row=>row.month);
 const updatedMonths=periods.filter(row=>row.status==='approved').map(row=>row.month);
 const hasUnsettled=reports.some(report=>!settled.has(report.month+'|'+report.id));
 const state=pendingMonths.length?'pending_resettlement':updatedMonths.length?'resettled':hasUnsettled?'unsettled':settled.size?'settled':'no_data';
 // Explain missing formal data only where an authorized report belonged to the invalidated snapshot.
 const refreshingMonths=db.prepare(`
  SELECT DISTINCT s.month FROM settlements s
  WHERE s.month IN (SELECT value FROM json_each(?))
   AND s.status='invalidated' AND json_extract(s.data,'$.supersededBy') IS NULL
   AND EXISTS (
    SELECT 1 FROM businessTasks t
    WHERE json_extract(t.data,'$.kind')='report_resettlement'
      AND json_extract(t.data,'$.businessId')=s.id AND t.status IN ('open','in_progress')
   )
   AND EXISTS (
    SELECT 1 FROM json_each(s.data,'$.reportIds') ref
    JOIN reports r ON r.id=ref.value AND r.month=s.month
    JOIN outlets o ON o.id=r.outlet AND o.owner=r.owner
    WHERE ${scope}
   )
  ORDER BY s.month`).all(months,...params)
  .map(row=>row.month).filter(month=>!pendingMonths.includes(month));
 return {state,pendingMonths,updatedMonths,...(refreshingMonths.length?{refreshingMonths}:{})};
}

/** Aggregate the requested periods and authorized outlets without loading state or audit logs. */
function aggregateSQL(store,actor,query={},ctx={}){
 const {db}=store,ownerId=core.own(actor);
 core.check(ownerId||['manager','ops','finance','regional'].includes(actor),'FORBIDDEN','当前身份无统计权限',403);
 const settings=Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('today','grants')").all().map(x=>[x.key,JSON.parse(x.value)]));
 const staff=ctx.subject?db.prepare('SELECT data FROM staffAccounts WHERE id=?').get(ctx.subject):null;
 const principal=staff?JSON.parse(staff.data):null;
 if(principal)core.check(principal.status==='active'&&principal.role===actor,'FORBIDDEN','员工身份已停用或岗位已变化',403);
 const grants=operations.effectiveGrants(principal?.grants||settings.grants,{today:settings.today,...ctx});
 const period=query.period??(ctx.today||settings.today||new Date().toISOString().slice(0,10)).slice(0,7),kind=query.kind??'month',mode=query.mode??'settled',outlet=query.outlet??'all',owner=query.owner??'all';
 core.check(typeof period==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(period),'INPUT','月份格式无效');
 core.check(['month','quarter','year'].includes(kind)&&['settled','process'].includes(mode),'INPUT','统计模式无效');
 const limit=Number(query.limit??200),offset=Number(query.offset??0);
 core.check(Number.isInteger(limit)&&limit>=1&&limit<=1000&&Number.isInteger(offset)&&offset>=0,'INPUT','统计limit须1—1000，offset须非负整数');
 const metrics=actor==='regional'?grants.metrics:core.METRICS;
 core.check(Array.isArray(metrics)&&metrics.every(k=>core.METRICS.includes(k))&&Array.isArray(grants.outlets),'FORBIDDEN','统计授权配置无效',403);
 const conditions=[],params=[];
 if(ownerId){conditions.push('o.owner=?');params.push(ownerId);}
 else if(actor==='regional'){conditions.push('o.id IN (SELECT value FROM json_each(?))');params.push(JSON.stringify(grants.outlets));}
 const scope=()=>conditions.length?conditions.map(x=>'('+x+')').join(' AND '):'1';
 if(outlet!=='all'){
  core.check(typeof outlet==='string'&&!!db.prepare(`SELECT o.id FROM outlets o WHERE ${scope()} AND o.id=?`).get(...params,outlet),'FORBIDDEN','无网点权限',403);
  conditions.push('o.id=?');params.push(outlet);
 }
 if(owner!=='all'){
  core.check(typeof owner==='string'&&(!ownerId||ownerId===owner)&&!!db.prepare('SELECT id FROM organizations WHERE id=?').get(owner),'FORBIDDEN','无主体权限',403);
  conditions.push('o.owner=?');params.push(owner);
 }
 const monthNumber=+period.slice(5),year=period.slice(0,4),start=kind==='year'?1:kind==='quarter'?Math.floor((monthNumber-1)/3)*3+1:monthNumber,n=kind==='year'?12:kind==='quarter'?3:1;
 const months=Array.from({length:n},(_,i)=>year+'-'+String(start+i).padStart(2,'0')),monthsJSON=JSON.stringify(months);
 const outlets=db.prepare(`SELECT o.id,o.owner,o.data,json_extract(o.data,'$.name') name FROM outlets o WHERE ${scope()} ORDER BY o.rowid`).all(...params);
 // Only approved current rows for this month/quarter/year enter calculations. Old revisions are never fetched.
 const reports=db.prepare(`SELECT r.id,r.outlet,r.month${metrics.map(k=>`,json_extract(r.data,'$.${k}') AS ${k}`).join('')} FROM reports r JOIN outlets o ON o.id=r.outlet WHERE r.month IN (SELECT value FROM json_each(?)) AND r.status='approved' AND r.current=1 AND ${scope()} ORDER BY r.rowid`).all(monthsJSON,...params);
 const reportIds=new Set(reports.map(x=>x.id)),settled=new Set(),frozen=new Map();
 let periodSettlements=[];if(reports.length){
  const periods=db.prepare("SELECT month,json_extract(data,'$.reportIds') ids,json_extract(data,'$.reportValues') frozen FROM settlements WHERE month IN (SELECT value FROM json_each(?)) AND status='approved'").all(monthsJSON);
  for(const entry of periods){
   const ids=JSON.parse(entry.ids||'[]'),values=mode==='settled'&&entry.frozen?JSON.parse(entry.frozen):null;
   periodSettlements.push({month:entry.month,status:'approved',reportIds:ids});
   for(const id of ids)if(reportIds.has(id)){
    settled.add(entry.month+'|'+id);
    if(values&&Object.hasOwn(values,id))frozen.set(id,values[id].values);
   }
  }
 }
 let settlementMonths;
 if(query.includeSettlementMonths==='true'&&kind==='month'&&mode==='settled'){
  const latest=db.prepare(`SELECT st.month FROM settlements st
    WHERE st.status='approved' AND st.month<? AND EXISTS (
      SELECT 1 FROM json_each(st.data,'$.reportIds') ref
      JOIN reports r ON r.id=ref.value AND r.month=st.month AND r.current=1 AND r.status='approved'
      JOIN outlets o ON o.id=r.outlet WHERE ${scope()}
    ) ORDER BY st.month DESC LIMIT 1`).get(period,...params);
  settlementMonths={hasCurrent:reports.some(r=>settled.has(period+'|'+r.id)),latestPriorMonth:latest?.month??null};
 }
 // Later approved partial adjustments overwrite only their explicit metric fields, in persisted row order.
 if(reports.length&&metrics.length){
  const adjustments=db.prepare(`SELECT json_extract(a.data,'$.sourceReportId') sourceReportId${metrics.map(k=>`,json_type(a.data,'$.values.${k}') AS ${k}_type,json_extract(a.data,'$.values.${k}') AS ${k}`).join('')} FROM summaryAdjustments a JOIN outlets o ON o.id=a.outlet WHERE a.month IN (SELECT value FROM json_each(?)) AND a.status='approved' AND ${scope()} ORDER BY a.rowid`).all(monthsJSON,...params);
  const byId=new Map(reports.map(r=>[r.id,r]));
  for(const adjustment of adjustments){const r=byId.get(adjustment.sourceReportId);if(!r||frozen.has(r.id))continue;for(const metric of metrics)if(adjustment[metric+'_type']!==null)r[metric]=adjustment[metric];}
 }
 for(const report of reports)if(frozen.has(report.id))for(const metric of metrics)report[metric]=frozen.get(report.id)[metric];
 const byOutlet=new Map();
 for(const r of reports){if(mode==='settled'&&!settled.has(r.month+'|'+r.id))continue;if(!byOutlet.has(r.outlet))byOutlet.set(r.outlet,[]);byOutlet.get(r.outlet).push(r);}
 const sum=(values,metric)=>values.length?(metric==='revenue'?values.reduce((total,value)=>total+Math.round(value*100),0)/100:values.reduce((total,value)=>total+value,0)):null;
 const covState={today:ctx.today||settings.today,outlets:outlets.map(x=>JSON.parse(x.data)),reports:db.prepare(`SELECT r.data FROM reports r JOIN outlets o ON o.id=r.outlet WHERE r.month IN (SELECT value FROM json_each(?)) AND ${scope()} AND (r.current=1 OR r.version=(SELECT max(v.version) FROM reports v WHERE v.outlet=r.outlet AND v.month=r.month))`).all(monthsJSON,...params).map(x=>JSON.parse(x.data)),exemptions:db.prepare(`SELECT e.data FROM exemptions e JOIN outlets o ON o.id=e.outlet WHERE e.month IN (SELECT value FROM json_each(?)) AND ${scope()}`).all(monthsJSON,...params).map(x=>JSON.parse(x.data)),settlements:periodSettlements,policies:db.prepare("SELECT data FROM policies WHERE status='published'").all().map(x=>JSON.parse(x.data))};
 const complete=outlets.map(o=>{const values=byOutlet.get(o.id)||[],row={outlet:o.id,owner:o.owner,name:o.name,coverage:values.length,expectedMonths:n,reportingCoverage:operations.coverage(covState,[JSON.parse(o.data)],months)};for(const metric of metrics)row[metric]=sum(values.map(r=>r[metric]).filter(x=>x!==null&&x!==undefined),metric);return row;});
 const reportDeadlines=operations.reportDeadlines(covState,months);
 const totals={};for(const metric of metrics)totals[metric]=sum(complete.map(r=>r[metric]).filter(x=>x!==null&&x!==undefined),metric);
 const rows=complete.slice(offset,offset+limit),hasMore=offset+rows.length<complete.length;
 const status=mode==='settled'&&query.includeSettlementStatus===true?settlementStatus(db,monthsJSON,scope(),params,reports,settled):null;
 return {rows,totals,months,kind,period,mode,reportDeadlines,...(settlementMonths?{settlementMonths}:{}),...(status?{settlementStatus:status}:{}),...(actor==='manager'?{rankings:operations.rankings(complete)}:{}),reportingCoverage:operations.coverage(covState,covState.outlets,months),partial:complete.some(r=>r.coverage<n),methodVersion:'integer-cents-v1',pagination:{total:complete.length,offset,limit,hasMore,nextOffset:hasMore?offset+rows.length:null}};
}
module.exports={aggregateSQL};
