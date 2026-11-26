'use strict';
// 分级代理报送：主体级别、直属关系、进度与催报。权限和归属只以当前生效关系为准。
const {randomUUID}=require('node:crypto');
const operations=require('./operations.cjs');
const serviceCatalog=require('./service-catalog.cjs');

function fail(code,message,status=400){throw Object.assign(new Error(message),{code,status});}
function check(ok,code,message,status=400){if(!ok)fail(code,message,status);}
const own=a=>({partnerA:'p1',partnerB:'p2'})[a]||(/^partner:p-[a-f0-9-]{36}$/.test(a)?a.slice(8):null);
const monthPattern=/^20\d{2}-(0[1-9]|1[0-2])$/;
function text(x,label,required=true){check(typeof x==='string'&&x.length<=2000&&(!required||x.trim()),'INPUT',label+'不能为空或超长');return x.trim();}
function month(x){check(typeof x==='string'&&monthPattern.test(x),'INPUT','月份格式无效');return x;}
function at(ctx={}){return ctx.now?new Date(ctx.now).toISOString():new Date().toISOString();}
function previousMonth(today){return new Date(Date.UTC(+today.slice(0,4),+today.slice(5)-2,1)).toISOString().slice(0,7);}
function relations(s){return s.agencyRelations||(s.agencyRelations=[]);}
function organization(s,id){return (s.organizations||[]).find(row=>row.id===id)||null;}
function activeRelationFor(s,childOwner){return relations(s).find(row=>row.childOwner===childOwner&&row.status==='active')||null;}
function activeChildren(s,parentOwner){return relations(s).filter(row=>row.parentOwner===parentOwner&&row.status==='active');}
function ancestors(s,ownerId){
 const chain=[];const seen=new Set();
 let current=ownerId;
 while(current&&!seen.has(current)){
  seen.add(current);
  const relation=activeRelationFor(s,current);
  if(!relation)break;
  chain.push(relation.parentOwner);
  current=relation.parentOwner;
 }
 return chain;
}
function levelLabel(level){return level===1?'一级代理':level===2?'二级代理':'未设置';}
function entitlementFor(s,owner,code){
 const month=String(s.today||'').slice(0,7);
 const all=(s.agreements||[]).filter(row=>row.owner===owner&&row.status==='active');
 if(!all.length)return {allowed:false,reason:'missing'};
 const current=all.filter(row=>row.startMonth<=month&&row.endMonth>=month);
 if(!current.length){
  if(all.every(row=>row.endMonth<month))return {allowed:false,reason:'expired'};
  if(all.every(row=>row.startMonth>month))return {allowed:false,reason:'not_started'};
  return {allowed:false,reason:'inactive'};
 }
 // 历史协议快照没有 services 字段时，服务范围未知，保持原权限；新协议明确声明后按声明执行。
 if(current.some(row=>!(row.priceSnapshot&&Object.hasOwn(row.priceSnapshot,'services'))))return {allowed:true,reason:'legacy'};
 if(current.some(row=>Array.isArray(row.priceSnapshot.services)&&row.priceSnapshot.services.includes(code)))return {allowed:true,reason:'included'};
 return {allowed:false,reason:'not_included'};
}
function requireService(s,owner,code){
 const state=entitlementFor(s,owner,code);
 if(state.allowed)return state;
 const name=serviceCatalog.SERVICES[code];
 const messages={
  missing:'当前主体尚未签订服务协议，不能使用「'+name+'」，请联系总部确认',
  expired:'当前服务协议已到期，续签前不能使用「'+name+'」，请联系总部确认',
  not_started:'当前服务协议尚未生效，暂不能使用「'+name+'」，请联系总部确认',
  inactive:'当前主体没有生效中的服务协议，不能使用「'+name+'」，请联系总部确认',
  not_included:'当前服务协议不包含「'+name+'」，请联系总部确认'
 };
 fail({missing:'AGREEMENT_MISSING',expired:'AGREEMENT_EXPIRED',not_started:'AGREEMENT_NOT_STARTED',inactive:'AGREEMENT_INACTIVE',not_included:'SERVICE_NOT_INCLUDED'}[state.reason],messages[state.reason],403);
}

function setLevel(s,a,p,ctx={}){
 const owner=text(p.owner,'加盟主体'),org=organization(s,owner);
 check(org,'NOT_FOUND','加盟主体不存在',404);
 const raw=p.level;
 check(raw===null||raw===undefined||raw===''||String(raw)==='1'||String(raw)==='2','INPUT','代理级别仅可为一级、二级或未设置');
 const next=raw===null||raw===undefined||raw===''?null:Number(raw);
 check(next===null||[1,2].includes(next),'INPUT','代理级别仅可为一级、二级或未设置');
 check((org.level??null)!==next,'UNCHANGED','主体级别未变化',409);
 const parent=activeRelationFor(s,owner),children=activeChildren(s,owner);
 if(next===null||next===1)check(!parent,'CONFLICT','该主体仍绑定其他一级代理，请先解除直属关系',409);
 if(next===null||next===2)check(!children.length,'CONFLICT','该主体仍有直属二级代理，请先解除下级绑定',409);
 org.levelHistory||=[];
 org.levelHistory.push({level:next,previous:org.level??null,reason:text(p.reason,'设置依据'),at:at(ctx),by:ctx.subject||a});
 org.level=next;
 return org;
}

function bind(s,a,p,ctx={}){
 const parentOwner=text(p.parentOwner,'一级代理'),childOwner=text(p.childOwner,'二级代理');
 const parent=organization(s,parentOwner),child=organization(s,childOwner);
 check(parent,'NOT_FOUND','一级代理主体不存在',404);
 check(child,'NOT_FOUND','二级代理主体不存在',404);
 check(parentOwner!==childOwner,'INPUT','不能把主体绑定到自身');
 check(parent.status==='active'&&child.status==='active','CONFLICT','主体账号不可用，不能建立直属关系',409);
 check(parent.level===1,'INPUT','请先将上级主体设为一级代理');
 check(child.level===2,'INPUT','请先将下级主体设为二级代理');
 check(!ancestors(s,parentOwner).includes(childOwner),'CONFLICT','不能形成循环的直属关系',409);
 const existing=activeRelationFor(s,childOwner);
 if(existing){
  check(existing.parentOwner!==parentOwner,'DUPLICATE','该直属关系已存在',409);
  check(p.replaceActive===true,'CONFLICT','该主体已绑定其他一级代理，请先解绑或确认换绑',409);
 }
 const now=at(ctx),subject=ctx.subject||a;
 if(existing){
  existing.status='revoked';
  existing.revokedAt=now;
  existing.revokedBy=subject;
  existing.revokedReason=text(p.reason,'换绑依据');
  existing.trail||=[];
  existing.trail.push({actor:a,subject,action:'revoked_by_rebind',from:existing.parentOwner,to:parentOwner,reason:existing.revokedReason,at:now});
 }
 const relation={id:'agency-'+randomUUID(),owner:childOwner,outlet:null,status:'active',parentOwner,childOwner,level:2,
  effectiveAt:s.today||now.slice(0,10),createdAt:now,createdBy:subject,reason:text(p.reason,'绑定依据'),trail:[]};
 relation.trail.push({actor:a,subject,action:existing?'rebind':'bind',from:existing?existing.parentOwner:null,to:parentOwner,reason:relation.reason,at:now});
 relations(s).push(relation);
 return relation;
}

function unbind(s,a,p,ctx={}){
 const relation=p.id?relations(s).find(row=>row.id===p.id):p.childOwner?activeRelationFor(s,text(p.childOwner,'二级代理')):null;
 check(relation,'NOT_FOUND','直属关系不存在',404);
 check(relation.status==='active','TRANSITION','直属关系已解除',409);
 const now=at(ctx),subject=ctx.subject||a,reason=text(p.reason,'解绑依据');
 relation.status='revoked';
 relation.revokedAt=now;
 relation.revokedBy=subject;
 relation.revokedReason=reason;
 relation.trail||=[];
 relation.trail.push({actor:a,subject,action:'unbind',from:relation.parentOwner,to:null,reason,at:now});
 return relation;
}

function reportStatus(s,outletRecord,m){
 const block=operations.reportMonthStatus(s,outletRecord,m);
 const enrollment=operations.enrollmentFor(outletRecord,m);
 const versions=(s.reports||[]).filter(row=>row.outlet===outletRecord.id&&row.month===m);
 const {newest,approved,latest}=operations.reportVersions(versions);
 const timing=operations.reportTiming(s,m);
 let status;
 if(block==='current_month'||block==='future_month')status='not_open';
 else if(block==='exempt')status='exempt';
 else if(block==='no_operation')status='not_required';
 else if(block==='full_pause')status='exemption_pending';
 else if(latest&&['pending','finance'].includes(latest.status))status=latest.status;
 else if(latest?.status==='returned')status='returned';
 else if(approved)status='approved';
 else if((s.drafts||[]).some(row=>row.outlet===outletRecord.id&&row.month===m))status='draft';
 else if(enrollment==='pending')status='awaiting_enrollment';
 else status=timing.late?'overdue':'missing';
 return {status,dueOn:timing.dueOn,late:timing.late===true,
  latestVersion:newest?.version??null,effectiveVersion:approved?.version??null};
}

const labels={approved:'已通过',pending:'待总部审核',finance:'财务复核中',returned:'已退回待重提',draft:'草稿未提交',
 missing:'未报送',overdue:'逾期未报',exempt:'本月免报',not_required:'本月无需报送',exemption_pending:'暂停待核验免报',
 awaiting_enrollment:'待确认招生适用性',not_open:'未到报送期'};
const actionableStatuses=new Set(['missing','overdue','draft','returned']);

function summarize(rows){
 const summary={outlets:rows.length,expected:0,submitted:0,approved:0,pending:0,finance:0,returned:0,draft:0,missing:0,overdue:0,notApplicable:0,actionable:0};
 for(const row of rows){
  const status=row.status;
  if(status in summary)summary[status]++;
  if(['exempt','not_required','exemption_pending','awaiting_enrollment','not_open'].includes(status))summary.notApplicable++;
  if(['pending','finance','approved','returned'].includes(status))summary.submitted++;
  if(['approved','pending','finance','returned','draft','missing','overdue'].includes(status))summary.expected++;
  if(actionableStatuses.has(status))summary.actionable++;
 }
 return summary;
}

function outletRow(s,outletRecord,m){
 const state=reportStatus(s,outletRecord,m);
 return {outlet:outletRecord.id,outletName:outletRecord.name,status:state.status,statusLabel:labels[state.status],
  dueOn:state.dueOn,late:state.late,latestVersion:state.latestVersion,effectiveVersion:state.effectiveVersion};
}

function childProgress(s,childOwner,m){
 const child=organization(s,childOwner);
 const outlets=(s.outlets||[]).filter(row=>row.owner===childOwner).sort((left,right)=>left.id.localeCompare(right.id));
 const rows=outlets.map(row=>outletRow(s,row,m));
 const summary=summarize(rows);
 const urged=(s.messages||[]).filter(row=>row.agencyUrge?.childOwner===childOwner&&row.agencyUrge?.month===m)
  .reduce((latest,row)=>!latest||String(row.createdAt)>latest?String(row.createdAt):latest,null);
 return {childOwner,name:child?.name||childOwner,level:child?.level??null,outlets:rows,summary,
  actionableOutlets:rows.filter(row=>actionableStatuses.has(row.status)),lastUrgedAt:urged};
}

function progress(s,actor,params={},today=s.today){
 const owner=own(actor);
 check(owner,'FORBIDDEN','仅加盟主体可查看下级报送',403);
 const org=organization(s,owner);
 check(org,'FORBIDDEN','当前主体没有加盟档案',403);
 check(org.level===1,'FORBIDDEN','当前主体未设为主代理，不能查看下级报送',403);
 requireService(s,owner,'agency_reporting');
 const current=today.slice(0,7);
 const m=params.month===undefined||params.month===null||params.month===''?previousMonth(today):month(String(params.month));
 check(m<=current,'INPUT','不能查看未来月份的报送进度');
 const children=activeChildren(s,owner)
  .map(row=>childProgress(s,row.childOwner,m))
  .sort((left,right)=>left.name.localeCompare(right.name,'zh-CN')||left.childOwner.localeCompare(right.childOwner));
 const summary={children:children.length,outlets:0,expected:0,submitted:0,approved:0,pending:0,finance:0,returned:0,draft:0,missing:0,overdue:0,notApplicable:0,actionable:0};
 for(const child of children)for(const key of Object.keys(summary))if(key!=='children')summary[key]+=child.summary[key];
 return {month:m,level:org.level,summary,children,generatedAt:new Date().toISOString(),methodVersion:'agency-progress-v1'};
}

function authorizeUrge(s,a,p){
 const owner=own(a);
 check(owner,'FORBIDDEN','仅一级代理可催报',403);
 const org=organization(s,owner);
 check(org?.level===1,'FORBIDDEN','当前主体未设为主代理，不能催报',403);
 requireService(s,owner,'agency_reporting');
 const childOwner=text(p.childOwner,'直属主体');
 const relation=activeRelationFor(s,childOwner);
 check(relation&&relation.parentOwner===owner,'FORBIDDEN','该主体不是当前直属二级代理',403);
 const child=organization(s,childOwner);
 check(child?.status==='active'&&s.accounts.some(account=>account.owner===childOwner&&account.status==='active'),'CONFLICT','直属主体账号不可用',409);
 return {owner,childOwner,relation};
}

function urge(s,a,p,ctx={}){
 const {owner,childOwner,relation}=authorizeUrge(s,a,p);
 const m=month(p.month),current=String(s.today||'').slice(0,7);
 check(m<current,'INPUT','只能催报已结束的自然月');
 const data=childProgress(s,childOwner,m);
 check(data.outlets.length,'CONFLICT','直属主体尚无网点，无需催报',409);
 check(data.actionableOutlets.length,'CONFLICT','直属主体该月无需催报',409);
 const today=s.today;
 const duplicate=(s.messages||[]).find(row=>row.agencyUrge?.childOwner===childOwner&&row.agencyUrge?.month===m&&(row.agencyUrge?.urgedOn||String(row.createdAt).slice(0,10))===today);
 check(!duplicate,'DUPLICATE','本月已向该直属主体催报，请勿重复发送',409);
 const now=at(ctx),subject=ctx.subject||a,label=m.slice(0,4)+'年'+Number(m.slice(5))+'月';
 const created=[];
 for(const row of data.actionableOutlets){
  const outletRecord=(s.outlets||[]).find(item=>item.id===row.outlet);
  const message={id:'msg-'+randomUUID(),owner:outletRecord.owner,outlet:outletRecord.id,status:'unread',createdAt:now,
   title:'一级代理催报：请报送'+label+'经营月报',body:'直属一级代理查看报送进度后发来催报，请打开原网点与账期完成报送。',
   target:'reports',recordId:outletRecord.id,read:false,month:m,
   agencyUrge:{relationId:relation.id,parentOwner:owner,childOwner,month:m,outlet:outletRecord.id,status:row.status,urgedAt:now,urgedOn:today,urgedBy:subject}};
  s.messages.push(message);
  created.push(message);
 }
 return {...created[0],agencyUrgeSummary:{childOwner,month:m,outletCount:created.length,parentOwner:owner}};
}

module.exports={own,month,monthPattern,previousMonth,levelLabel,labels,actionableStatuses,organization,activeRelationFor,activeChildren,ancestors,setLevel,bind,unbind,reportStatus,childProgress,progress,authorizeUrge,urge,summarize,entitlementFor,requireService};