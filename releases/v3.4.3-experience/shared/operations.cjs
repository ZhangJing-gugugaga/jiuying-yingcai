'use strict';
const {randomUUID}=require('node:crypto');
const responsibility=require('./responsibilities.cjs');
const taskRouting=require('./task-routing.cjs');
const regions=require('./outlet-regions.cjs');
const COLLECTIONS=['policies','pricePlans','agreements','billCorrections','feeProposals','offlinePayments','refundRequests','invoiceRequests','businessTasks','jobRuns','faqEntries','publicProfiles','importBatches','staffAccounts','handovers','cooperationRequests','contentVersions','taskRoutingRules'];
const COMMANDS=new Set(['policy.configure','plan.publish','agreement.create','billing.generate','billing.correct.propose','billing.correct.review','fee.adjust.propose','fee.adjust.review','offline.submit','offline.review','refund.request','refund.review','refund.record','invoice.request','invoice.update','jobs.run','task.update','faq.save','public.profile','import.preview','import.commit','staff.create','staff.update','staff.handover','cooperation.submit','cooperation.update']);
const STAFF_ROLES=['ops','manager','finance','location','support','regional'];
const METRICS=['revenue','orders','traffic','enroll'];
const clone=x=>JSON.parse(JSON.stringify(x));
const own=a=>({partnerA:'p1',partnerB:'p2'})[a]||(/^partner:p-[a-f0-9-]{36}$/.test(a)?a.slice(8):null);
function check(ok,code,message,status=400){if(!ok)throw Object.assign(new Error(message),{code,status});}
function text(x,label){check(typeof x==='string'&&x.trim().length>0&&x.length<=2000,'INPUT',label+'不能为空或超长');return x.trim();}
function money(x,positive=false){check((typeof x==='number'||typeof x==='string')&&/^\d+(\.\d{1,2})?$/.test(String(x))&&Number.isFinite(+x)&&+x<=1e10&&(!positive||+x>0),'INPUT','金额须为'+(positive?'正数':'非负数')+'、最多两位小数');return Math.round(+x*100);}
function month(x){check(typeof x==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(x),'INPUT','月份格式无效');return x;}
function date(x){check(typeof x==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x,'INPUT','日期无效');return x;}
function agreementDates({startMonth,endMonth,startOn,endOn}){
 const calendarMonth=/^20\d{2}-(0[1-9]|1[0-2])$/;
 return {
  startOn:startOn??(calendarMonth.test(startMonth)?startMonth+'-01':null),
  endOn:endOn??(calendarMonth.test(endMonth)?new Date(Date.UTC(+endMonth.slice(0,4),+endMonth.slice(5),0)).toISOString().slice(0,10):null)
 };
}
function day(x,label){check(Number.isInteger(x)&&x>=1&&x<=28,'INPUT',label+'须为1—28');return x;}
function list(x,label,max=40){check(Array.isArray(x)&&x.length<=max,'INPUT',label+'格式无效');return [...new Set(x.map(v=>text(v,label)))];}
function bool(x,label){check(typeof x==='boolean','INPUT',label+'须为布尔值');return x;}
function publicCoordinates(value, code) {
 if (value===null) return null;
 const coordinateSystem=regions.coordinateSystem(code);
 check(regions.validPublicCoordinates(value,code),'INPUT','公开坐标须为有效的 '+coordinateSystem+' 经纬度，未授权请清除坐标');
 return {lat:value.lat,lng:value.lng,coordinateSystem};
}
function publicOutlet(outlet,profile){
 const {id,status}=outlet;
 const {province,city,district}=profile??outlet;
 const code=regions.countryCode(profile?.countryCode);
 const result={id,outlet:id,name:profile?profile.title:outlet.name,address:profile?.address??null,province,city,district,status};
 if(code){result.countryCode=code;result.countryName=regions.countryName(code);}
 const coords=profile?.publicCoords;
 if(regions.validPublicCoordinates(coords,code||'CN')){
  result.publicCoords={lat:coords.lat,lng:coords.lng,coordinateSystem:coords.coordinateSystem};
  result.publicLocation={latitude:coords.lat,longitude:coords.lng,coordinateSystem:coords.coordinateSystem,precision:'public'};
 }
 return result;
}
function role(a,roles){check(roles.includes(a)||(own(a)&&roles.includes('partner')),'FORBIDDEN','当前身份无此操作权限',403);}
function get(s,k,id){const r=(s[k]||[]).find(x=>x.id===id);check(r,'NOT_FOUND','记录不存在',404);return r;}
function getOutlet(s,id,a){const o=get(s,'outlets',id);if(own(a))check(o.owner===own(a),'FORBIDDEN','无权操作其他加盟商网点',403);return o;}
function scoped(s,k,id,a){const r=get(s,k,id);if(own(a))check(r.owner===own(a),'FORBIDDEN','记录不属于本人',403);return r;}
function time(s,ctx){if(ctx.now){check(Number.isFinite(Date.parse(ctx.now)),'INPUT','执行时间无效');return new Date(ctx.now).toISOString();}return new Date().toISOString();}
function ensure(s){COLLECTIONS.forEach(k=>s[k]||=[]);return s;}
function context(s,a,ctx={}){ensure(s);const staff=s.staffAccounts.find(x=>x.id===ctx.subject||x.subject===ctx.subject);if(staff)check(staff.status==='active'&&staff.role===a,'FORBIDDEN','员工身份已停用或岗位已变化',403);return staff;}
function effectiveGrants(g,ctx={}){const at=Date.parse(ctx.now||new Date().toISOString());return !g||g.revokedAt||g.validFrom&&at<Date.parse(g.validFrom)||g.validUntil&&at>Date.parse(g.validUntil)?{outlets:[],metrics:[],reviewOutlets:[]}:g;}
function scopedGrants(s,a,ctx={}){const staff=context(s,a,ctx);return effectiveGrants(a==='regional'&&staff?staff.grants:s.grants,{today:s.today,...ctx});}
function entity(s,p,o,status,a,ctx){const at=time(s,ctx);return {id:p+'-'+randomUUID(),owner:o?.owner||null,outlet:o?.id||null,status,createdAt:at,updatedAt:at,initiator:ctx.subject||a,trail:[]};}
function record(s,r,a,c,p,ctx){r.updatedAt=time(s,ctx);r.trail||=[];r.trail.push({actor:a,subject:ctx.subject||a,action:c,note:String(p.reason||p.note||'').replace(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g,'$1****$2'),status:r.status,at:r.updatedAt});return r;}
function put(s,k,prefix,o,status,a,ctx,data){const r={...entity(s,prefix,o,status,a,ctx),...data};s[k].push(r);return r;}
function independent(r,a,ctx){check(r.initiator!==(ctx.subject||a),'FORBIDDEN','须由另一自然人独立复核',403);}
function decision(p){check(['approve','return'].includes(p.decision),'INPUT','审核动作无效');return text(p.note,'审核说明');}
function notification(s,r,title,target,ctx,extra={}){const msg={...entity(s,'msg',{id:r.outlet,owner:r.owner},'unread','system',ctx),title,body:'',target,recordId:r.id,read:false,...extra};s.messages.push(msg);return msg;}
function note(r){return {id:r.id,status:r.status};}
function sum(xs){return xs.reduce((n,x)=>n+money(x.amount),0);}
function refunded(s,id,statuses=['recorded']){return sum(s.refundRequests.filter(x=>x.receiptId===id&&statuses.includes(x.status)));}
function confirmedReceipt(receipt,mockMessage='仅已核验的实收凭证可办理退款或开票'){
 check(receipt.adapterMode!=='mock','CONFLICT',mockMessage,409);
 check(receipt.status==='success','CONFLICT','仅已核验的实收凭证可办理退款或开票',409);
 return receipt;
}
function invoiceBusy(s,id){return s.invoiceRequests.some(x=>x.receiptId===id&&['pending','issued','red_pending'].includes(x.status));}
function verifyGrants(s,g){check(g&&Array.isArray(g.outlets)&&Array.isArray(g.metrics)&&Array.isArray(g.reviewOutlets)&&g.outlets.every(id=>s.outlets.some(o=>o.id===id))&&g.metrics.every(k=>METRICS.includes(k))&&g.reviewOutlets.every(id=>g.outlets.includes(id)),'INPUT','区域授权范围无效');const dates={};for(const k of ['validFrom','validUntil']){check(g[k]==null||typeof g[k]==='string'&&Number.isFinite(Date.parse(g[k])),'INPUT','授权有效期须ISO时间或null');dates[k]=g[k]==null?null:new Date(g[k]).toISOString();}check(!dates.validFrom||!dates.validUntil||dates.validFrom<=dates.validUntil,'INPUT','授权结束不得早于开始');return {outlets:[...new Set(g.outlets)],metrics:[...new Set(g.metrics)],reviewOutlets:[...new Set(g.reviewOutlets)],...dates};}
function activeAssignments(s,id){const found=[];for(const k of ['supportTickets','supportChats','businessTasks'])for(const r of s[k]||[])if((k==='businessTasks'?responsibility.assignee(r).userId:r.assignee)===id&&!['closed','resolved','cancelled'].includes(r.status))found.push({collection:k,record:r});return found;}
function billParties(b,agreement){
 const price=agreement?.priceSnapshot;
 return {agreementId:b.agreementId??agreement?.id??null,agreementReference:b.agreementReference??agreement?.reference??null,
  currency:b.currency??price?.currency??'CNY',serviceEntity:b.serviceEntity??price?.serviceEntity??null,
  collectionEntity:b.collectionEntity??price?.collectionEntity??null,invoiceEntity:b.invoiceEntity??price?.invoiceEntity??null};
}
function originalBill(s,bill){
 const visited=new Set();
 let row=bill;
 while(row.replaces&&!visited.has(row.id)){
  visited.add(row.id);
  const previous=s.bills.find(x=>x.id===row.replaces&&x.outlet===bill.outlet&&x.owner===bill.owner&&x.month===bill.month);
  if(!previous)break;
  row=previous;
 }
 return row;
}
function billAmounts(b){
 return {billId:b.id,grossAmount:b.grossAmount??null,creditAmount:b.creditAmount??null,adjustmentIds:[...(b.adjustmentIds??[])]};
}
function invoiceSource(s,r){const b=get(s,'bills',r.billId);const a=s.agreements.find(x=>x.id===b.agreementId);check(a?.priceSnapshot?.invoiceEntity,'POLICY_REQUIRED','该实收未关联已确认开票主体的服务协议',409);return {bill:b,agreement:a};}
for(const c of ['enrollment.confirm','location.baseline.confirm','grant.revoke','content.service.save','content.publication'])COMMANDS.add(c);
for(const c of ['task.create','task.assign','task.complete','routing.set'])COMMANDS.add(c);
function enrollmentFor(o,m){const entry=(o.enrollmentHistory||[]).filter(x=>x.effectiveMonth<=m).sort((a,b)=>b.effectiveMonth.localeCompare(a.effectiveMonth)||String(b.at).localeCompare(String(a.at)))[0];if(entry)return entry.applicable?'applicable':'not_applicable';if(o.enrollmentHistory?.length)return o.enrollmentInitialStatus||'pending';if(o.enrollmentStatus==='pending')return 'pending';return o.enrollmentApplicable===true?'applicable':o.enrollmentApplicable===false?'not_applicable':'pending';}
function changeIdentity(s,r,p,a,ctx,requestId=null){const managerName=text(p.managerName,'负责人'),mobile=text(p.mobile,'手机');check(/^1\d{10}$/.test(mobile),'INPUT','手机号无效');check(!s.accounts.some(x=>x.id!==r.id&&x.mobile===mobile),'DUPLICATE','手机号已绑定其他负责人',409);if(r.managerName===managerName&&r.mobile===mobile)return false;r.ownerHistory||=[];r.ownerHistory.push({managerName:r.managerName,mobile:r.mobile,bindingVersion:r.bindingVersion,requestId,changedBy:ctx.subject||a,changedAt:time(s,ctx)});r.managerName=managerName;r.mobile=mobile;r.bindingVersion=(r.bindingVersion||0)+1;r.authenticationResetVersion=r.bindingVersion;r.status='pending';return true;}
function locationAssessment(s,o,coords,ctx={}){const baseline=o.confirmedLocation,threshold=policyFor(s,ctx.today||s.today)?.locationThresholdMeters??null,result={distanceMeters:null,thresholdMeters:threshold,result:'baseline_unconfirmed',methodVersion:'haversine-v1',baselineConfirmedAt:baseline?.confirmedAt||null};if(coords.source!=='gps'){result.result='manual';return result;}if(!baseline)return result;if(baseline.coords.coordinateSystem!=='GCJ-02'||coords.coordinateSystem!=='GCJ-02'){result.result='coordinate_mismatch';return result;}const rad=x=>x*Math.PI/180,c=baseline.coords,dl=rad(coords.lat-c.lat),dn=rad(coords.lng-c.lng),h=Math.sin(dl/2)**2+Math.cos(rad(c.lat))*Math.cos(rad(coords.lat))*Math.sin(dn/2)**2;result.distanceMeters=Math.round(6371008.8*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)))*100)/100;result.result=threshold===null?'unconfigured':result.distanceMeters>threshold?'outside_threshold':'within_threshold';return result;}
function publicContent(record){
 const snapshot=record.publishedSnapshot||record;
 if(snapshot.status!=='published')return null;
 const {id,key,title,text,body,intro,summary,imageId,status,version,createdAt,updatedAt}=snapshot;
 return {id,key,title,text,body,intro,summary,imageId,status,version,createdAt,updatedAt};
}
function appendContentVersion(s,a,ctx,r,snapshot,reason,details={}){
 put(s,'contentVersions','contentversion',null,snapshot.status,a,ctx,{contentId:r.id,key:r.key,version:snapshot.version,snapshot:clone(snapshot),createdBy:ctx.subject||a,reason,...details});
}
function saveContent(s,a,p,ctx,key){
 const body=text(p.body??p.text??p.intro,'正文'),title=text(p.title,'标题'),reason=text(p.reason,'修改依据');
 check(typeof p.published==='boolean','INPUT','发布状态须布尔值');
 check(p.imageId==null||typeof p.imageId==='string'&&p.imageId.startsWith('file-'),'INPUT','封面须已上传附件ID');
 let r=s.contents.find(x=>x.key===key);
 if(p.expectedVersion!==undefined){
  check(Number.isInteger(p.expectedVersion)&&p.expectedVersion>=0,'INPUT','内容版本号无效');
  check(p.expectedVersion===(r?.version||(r?.title?1:0)),'CONFLICT','栏目内容已变更，请刷新后重试',409);
 }
 if(!r)r=put(s,'contents','content',null,'draft',a,ctx,{key});
 if(r.title&&!r.version){
  r.version=1;
  const {publishedSnapshot,trail,...legacy}=r;
  appendContentVersion(s,a,ctx,r,legacy,'兼容迁移：保留首次版本化前已存内容',{createdBy:null});
 }
 if(r.status==='published'&&!r.publishedSnapshot)r.publishedSnapshot=publicContent(r);
 const version=(r.version||0)+1,snapshot={id:r.id,key,title,text:body,body,intro:body,summary:p.summary==null?'':String(p.summary).slice(0,2000),imageId:p.imageId||null,status:p.published?'published':'draft',version};
 Object.assign(r,snapshot);
 if(p.published)r.publishedSnapshot=clone(snapshot);
 appendContentVersion(s,a,ctx,r,snapshot,reason,{publicationAction:p.published?'publish':'draft'});
 return r;
}
function changeContentPublication(s,a,ctx,p){
 check(typeof p.key==='string'&&/^(brand|service-[1-5])$/.test(p.key),'INPUT','公开内容栏目无效');
 check(['withdraw','restore'].includes(p.action),'INPUT','发布处理动作无效');
 check(Number.isInteger(p.expectedVersion)&&p.expectedVersion>=1,'INPUT','内容版本号无效');
 const reason=text(p.reason,'发布处理依据'),r=s.contents.find(x=>x.key===p.key);
 check(r,'NOT_FOUND','公开内容栏目不存在',404);
 check((r.version||(r.title?1:0))===p.expectedVersion,'CONFLICT','栏目内容已变更，请刷新后重试',409);
 const live=publicContent(r);
 let source=live;
 if(p.action==='withdraw')check(live,'TRANSITION','该栏目没有可撤回的发布版本',409);
 else{
  check(Number.isInteger(p.sourceVersion)&&p.sourceVersion>=1,'INPUT','恢复来源版本号无效');
  const selected=s.contentVersions.find(row=>row.contentId===r.id&&row.version===p.sourceVersion);
  check(selected?.status==='published'&&selected.snapshot?.status==='published'&&selected.version!==live?.version,'TRANSITION','只能恢复其他历史已发布版本',409);
  source=publicContent(selected.snapshot);
 }
 if(!r.version){
  r.version=1;
  const {publishedSnapshot,trail,...legacy}=r;
  appendContentVersion(s,a,ctx,r,legacy,'兼容迁移：保留首次版本化前已存内容',{createdBy:null});
 }
 const status=p.action==='withdraw'?'withdrawn':'published',snapshot={...source,id:r.id,key:r.key,version:r.version+1,status};
 Object.assign(r,snapshot,{publishedSnapshot:status==='published'?clone(snapshot):null});
 appendContentVersion(s,a,ctx,r,snapshot,reason,{publicationAction:p.action,sourceVersion:source.version||1});
 return r;
}
function rankings(rows){return Object.fromEntries(METRICS.map(k=>{const sorted=rows.filter(r=>typeof r[k]==='number').slice().sort((a,b)=>b[k]-a[k]||a.outlet.localeCompare(b.outlet));let rank=0;return [k,sorted.slice(0,20).map((r,i)=>{if(!i||r[k]!==sorted[i-1][k])rank=i+1;return {...r,rank};})];}));}
function reportMonthStatus(s,o,m){
 const current=s.today.slice(0,7);
 if(m>=current)return m===current?'current_month':'future_month';
 if(s.exemptions.some(row=>row.outlet===o.id&&row.month===m&&row.status==='approved'))return 'exempt';
 const start=m+'-01',end=new Date(Date.UTC(+m.slice(0,4),+m.slice(5),0)).toISOString().slice(0,10);
 const events=(o.events||[]).filter(row=>row.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
 const initial=events.findLast(row=>row.date<=start);
 if(initial?.status==='paused'&&!events.some(row=>row.date>start&&row.status!=='paused'))return 'full_pause';
 return initial?.status==='open'||events.some(row=>row.date>=start&&row.status==='open')?null:'no_operation';
}
function coverage(s,outlets,months){
 const counts={expected:0,submitted:0,pendingReview:0,approved:0,exempt:0,overdue:0,lateSubmitted:0,overdueExemptReview:0,notApplicable:0,awaitingEnrollment:0,notRequired:0,settled:0,complete:false};
 const deadlines=reportDeadlines(s,months);
 for(const o of outlets)for(const m of months){
  const reason=reportMonthStatus(s,o,m);
  if(reason&&reason!=='full_pause'&&reason!=='exempt'){counts.notRequired++;continue;}
  const enrollment=enrollmentFor(o,m);
  if(enrollment==='not_applicable')counts.notApplicable++;
  if(enrollment==='pending')counts.awaitingEnrollment++;
  if(reason==='exempt'){counts.exempt++;continue;}
  counts.expected++;
  const versions=s.reports.filter(row=>row.outlet===o.id&&row.month===m);
  const newest=versions.reduce((recent,row)=>!recent||row.version>recent.version?row:recent,null);
  const approved=versions.find(row=>row.current&&row.status==='approved'&&!row.revoked);
  const latest=newest?.revoked?approved:newest;
  if(latest){
   counts.submitted++;
   if(latest.late===true)counts.lateSubmitted++;
   if(['pending','finance'].includes(latest.status))counts.pendingReview++;
  }else if(deadlines[m].late===true){
   if(reason==='full_pause')counts.overdueExemptReview++;
   else counts.overdue++;
  }
  if(approved){
   counts.approved++;
   if(s.settlements.some(row=>row.status==='approved'&&row.month===m&&row.reportIds.includes(approved.id)))counts.settled++;
  }
 }
 counts.complete=counts.expected===counts.approved;
 return counts;
}
function execute(s,a,c,p={},ctx={}){
 ensure(s);context(s,a,ctx);const today=ctx.today?date(ctx.today):s.today,subject=ctx.subject||a;let r;
 switch(c){
 case 'enrollment.confirm':{role(a,['manager','ops']);r=getOutlet(s,p.outlet,a);const applicable=bool(p.applicable,'招生适用性'),effectiveMonth=month(p.effectiveMonth),reason=text(p.reason,'确认依据');r.enrollmentHistory||=[];if(!r.enrollmentHistory.length)r.enrollmentInitialStatus=enrollmentFor(r,effectiveMonth);r.enrollmentHistory.push({applicable,effectiveMonth,reason,at:time(s,ctx),subject});r.enrollmentApplicable=applicable;r.enrollmentStatus=applicable?'applicable':'not_applicable';break;}
 case 'location.baseline.confirm':{role(a,['location']);r=getOutlet(s,p.outlet,a);const coords=publicCoordinates(p.coords,'CN');check(coords,'INPUT','基准坐标不能为空');check(['gps','manual'].includes(p.coords.source),'INPUT','基准来源须明确');r.confirmedLocation={coords:{...coords,source:p.coords.source,accuracy:p.coords.accuracy??null},reference:text(p.reference,'核验材料来源'),reason:text(p.reason,'核验依据'),confirmedBy:subject,confirmedAt:time(s,ctx)};break;}
 case 'grant.revoke':{role(a,['manager']);r=get(s,'staffAccounts',p.id);check(r.role==='regional','INPUT','仅区域人员有网点授权');r.grants={outlets:[],metrics:[],reviewOutlets:[],validFrom:null,validUntil:null,revokedAt:time(s,ctx),reason:text(p.reason,'撤权依据')};r.bindingVersion++;break;}
 case 'content.service.save':{role(a,['manager']);check(Number.isInteger(p.slot)&&p.slot>=1&&p.slot<=5,'INPUT','业务栏位须1—5');r=saveContent(s,a,p,ctx,'service-'+p.slot);break;}
 case 'content.publication':{role(a,['manager']);r=changeContentPublication(s,a,ctx,p);break;}
 case 'policy.configure':{
  role(a,['manager']);const effectiveFrom=date(p.effectiveFrom);const nullable=(v,max,label)=>{if(v===undefined||v===null)return null;check(typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=max,'INPUT',label+'无效');return v;};
  const sla={};for(const k of ['complaint','aftersale','exception']){sla[k]=nullable(p.slaMinutes?.[k],10080,'SLA');check(sla[k]===null||Number.isInteger(sla[k]),'INPUT','SLA须为整数分钟');}
  const reportDueDay=p.reportDueDay==null?null:day(p.reportDueDay,'月报截止日'),locationDueDay=p.locationDueDay==null?null:day(p.locationDueDay,'位置截止日'),noDataMonths=nullable(p.noDataMonths,120,'无数据月份');check(noDataMonths===null||Number.isInteger(noDataMonths),'INPUT','月份阈值须整数');
  r=put(s,'policies','policy',null,'published',a,ctx,{name:text(p.name,'制度名称'),effectiveFrom,version:s.policies.reduce((n,x)=>Math.max(n,x.version||0),0)+1,reportDueDay,locationDueDay,anomalyPercent:nullable(p.anomalyPercent,100000,'异常比例'),noDataMonths,locationThresholdMeters:nullable(p.locationThresholdMeters,1000000,'位置距离阈值'),slaMinutes:sla,partialMonthRule:null,transferRule:null,reason:text(p.reason,'依据')});break;
 }
 case 'plan.publish':role(a,['manager']);r=put(s,'pricePlans','plan',null,'published',a,ctx,{name:text(p.name,'方案名'),amount:money(p.amount)/100,currency:'CNY',frequency:'month',serviceEntity:text(p.serviceEntity,'服务主体'),collectionEntity:text(p.collectionEntity,'收款主体'),invoiceEntity:text(p.invoiceEntity,'开票主体'),terms:text(p.terms,'服务内容'),version:s.pricePlans.reduce((n,x)=>Math.max(n,x.version||0),0)+1,methodVersion:'full-calendar-month-cents-v1',reason:text(p.reason,'依据')});break;
 case 'agreement.create':{
  role(a,['manager']);const o=getOutlet(s,p.outlet,a),plan=get(s,'pricePlans',p.planId),startMonth=month(p.startMonth),endMonth=month(p.endMonth),billDay=day(p.billDay,'出账日'),dueDay=day(p.dueDay,'截止日');check(startMonth<=endMonth&&billDay<=dueDay,'INPUT','协议起止月份或出账截止日无效');check(!s.agreements.some(x=>x.outlet===o.id&&x.status==='active'&&x.startMonth<=endMonth&&x.endMonth>=startMonth),'CONFLICT','同网点存在重叠服务协议',409);
  r=put(s,'agreements','agreement',o,'active',a,ctx,{planId:plan.id,startMonth,endMonth,...agreementDates({startMonth,endMonth}),billDay,dueDay,reference:text(p.reference,'协议编号'),priceSnapshot:clone(plan),amount:plan.amount,reason:text(p.reason,'依据'),partialMonthRule:null});o.agreementEnd=r.endOn;break;
 }
 case 'billing.generate':{
  role(a,['manager','finance']);const agreement=get(s,'agreements',p.agreementId),m=month(p.month),o=getOutlet(s,agreement.outlet,a);check(agreement.status==='active'&&m>=agreement.startMonth&&m<=agreement.endMonth,'CONFLICT','月份不在有效协议范围',409);const old=s.bills.find(b=>b.agreementId===agreement.id&&b.month===m&&b.status!=='reversed');if(old)return old;
  check(today>=m+'-'+String(agreement.billDay).padStart(2,'0'),'CONFLICT','尚未到协议出账日',409);check(!s.bills.some(b=>b.outlet===o.id&&b.month===m),'CONFLICT','网点该月已有账单或冲正记录，请先复核旧账',409);
  check(!s.adjustments.some(x=>x.outlet===o.id&&x.status==='待财务核算调整'&&x.from?.slice(0,7)<=m&&x.to?.slice(0,7)>=m),'CONFLICT','本月有待核算调整',409);const credits=s.adjustments.filter(x=>x.outlet===o.id&&x.status==='approved'&&x.offsetMonth===m);const gross=money(agreement.priceSnapshot.amount),deduct=sum(credits);check(deduct<=gross,'CONFLICT','抵扣超过本月应收，须财务明确分月处理',409);
  r=put(s,'bills','bill',o,gross===deduct?'settled_zero':'unpaid',a,ctx,{month:m,...billParties({},agreement),amount:(gross-deduct)/100,grossAmount:gross/100,creditAmount:deduct/100,adjustmentIds:credits.map(x=>x.id),priceVersion:agreement.priceSnapshot.id,methodVersion:'full-calendar-month-cents-v1',billOn:m+'-'+String(agreement.billDay).padStart(2,'0'),dueOn:m+'-'+String(agreement.dueDay).padStart(2,'0'), ...(ctx.billingGeneration?{generation:clone(ctx.billingGeneration)}:{})});credits.forEach(x=>{x.status='applied';x.appliedBillId=r.id;record(s,x,a,c,p,ctx);});notification(s,r,'月度账单已生成','fees',ctx,{billId:r.id});break;
 }
 case 'billing.correct.propose':{
  role(a,['manager','ops']);const b=get(s,'bills',p.billId);check(!['reversed'].includes(b.status),'TRANSITION','账单已冲正',409);check(!s.billCorrections.some(x=>x.billId===b.id&&x.status==='pending'),'DUPLICATE','已有待审账单更正',409);r=put(s,'billCorrections','bc',getOutlet(s,b.outlet,a),'pending',a,ctx,{billId:b.id,amount:money(p.amount)/100,beforeAmount:b.amount,beforeStatus:b.status,reason:text(p.reason,'纠错原因'),replacementBillId:null});break;
 }
 case 'billing.correct.review':{
  role(a,['finance']);r=get(s,'billCorrections',p.id);check(r.status==='pending','TRANSITION','提案已处理',409);independent(r,a,ctx);decision(p);const b=get(s,'bills',r.billId);check(b.status===r.beforeStatus&&b.amount===r.beforeAmount,'CONFLICT','原账单已变化',409);
  if(p.decision==='approve'){
   check(!s.offlinePayments.some(x=>x.billId===b.id&&x.status==='pending')&&!s.payments.some(x=>x.billId===b.id&&x.status==='pending'),'CONFLICT','存在在途付款，先核实付款结果',409);
   const receipts=s.receipts.filter(x=>x.billId===b.id&&x.status==='success');
   check(receipts.every(x=>refunded(s,x.id)>=money(x.amount)&&!invoiceBusy(s,x.id)),'CONFLICT','已有实收，须先完成退款与发票处理',409);
   const original=originalBill(s,b),agreement=s.agreements.find(x=>x.id===b.agreementId&&x.outlet===b.outlet&&x.owner===b.owner);
   const parties=billParties(b,agreement),originalCredit=b.originalCredit??billAmounts(original);
   r.originalBillSnapshot={...parties,...billAmounts(b),originalCredit,amount:b.amount,status:b.status,priceVersion:b.priceVersion??null};
   b.status='reversed';b.correctionId=r.id;b.reversedAt=time(s,ctx);record(s,b,a,c,p,ctx);
   if(r.amount>0){
    const replacement=put(s,'bills','bill',getOutlet(s,b.outlet,a),'unpaid',a,ctx,{
     month:b.month,...parties,amount:r.amount,grossAmount:null,creditAmount:0,adjustmentIds:[],originalCredit,adjustmentTreatment:'reviewed_net_no_reapplication',
     priceVersion:b.priceVersion??original.priceVersion??null,dueOn:b.dueOn??null,billOn:today,
     replaces:b.id,rootBillId:original.id,correctionId:r.id,methodVersion:'finance-reviewed-correction-v2',
     ...(b.simulation===true?{simulation:true}:{}),
    });
    r.replacementBillId=replacement.id;b.replacementBillId=replacement.id;
    r.replacementBillSnapshot={...parties,...billAmounts(replacement),amount:replacement.amount,status:replacement.status,rootBillId:original.id};
   }
  }
  r.status=p.decision==='approve'?'approved':'returned';r.reviewedBy=subject;r.reviewNote=p.note;notification(s,r,'账单纠错已'+(r.status==='approved'?'批准':'退回'),'fees',ctx,{billId:b.id});break;
 }
 case 'fee.adjust.propose':{
  role(a,['manager','ops']);const adj=get(s,'adjustments',p.adjustmentId);check(adj.status==='待财务核算调整','TRANSITION','调整已核算或应用',409);check(!s.feeProposals.some(x=>x.adjustmentId===adj.id&&x.status==='pending'),'DUPLICATE','已有待审核算',409);check(Object.hasOwn(p,'serviceUntil'),'INPUT','须明确顺延日期或null');r=put(s,'feeProposals','fee',getOutlet(s,adj.outlet,a),'pending',a,ctx,{adjustmentId:adj.id,amount:money(p.amount)/100,offsetMonth:month(p.offsetMonth),serviceUntil:p.serviceUntil===null?null:date(p.serviceUntil),reason:text(p.reason,'核算依据'),methodVersion:'manual-reviewed-cents-v1'});break;
 }
 case 'fee.adjust.review':{
  role(a,['finance']);r=get(s,'feeProposals',p.id);check(r.status==='pending','TRANSITION','提案已处理',409);independent(r,a,ctx);decision(p);const adj=get(s,'adjustments',r.adjustmentId);check(adj.status==='待财务核算调整','CONFLICT','原调整已变化',409);
  if(p.decision==='approve'){check(!s.bills.some(x=>x.outlet===r.outlet&&x.month===r.offsetMonth&&x.status!=='reversed'),'CONFLICT','抵扣月已有账单，请先账单纠错或改提案月份',409);Object.assign(adj,{amount:r.amount,offsetMonth:r.offsetMonth,serviceUntil:r.serviceUntil,status:'approved',proposalId:r.id,methodVersion:r.methodVersion});if(r.serviceUntil)getOutlet(s,r.outlet,a).serviceUntil=r.serviceUntil;record(s,adj,a,c,p,ctx);}
  r.status=p.decision==='approve'?'approved':'returned';r.reviewedBy=subject;r.reviewNote=p.note;notification(s,r,'费用核算已复核','fees',ctx,{adjustmentId:adj.id});break;
 }
 case 'offline.submit':{
  role(a,['partner','finance','manager']);const b=scoped(s,'bills',p.billId,a);check(b.status==='unpaid','TRANSITION','账单当前不可收款',409);const amount=money(p.amount,true),reference=text(p.reference,'外部流水');check(amount===money(b.amount),'CONFLICT','本入口仅登记与账单等额的全额收款',409);check(!s.offlinePayments.some(x=>x.reference===reference),'DUPLICATE','外部流水已登记',409);check(!s.offlinePayments.some(x=>x.billId===b.id&&x.status==='pending'),'DUPLICATE','账单已有待核验线下款',409);const paidOn=date(p.paidOn);check(paidOn<=today,'INPUT','收款日期不能晚于今日');r=put(s,'offlinePayments','offline',getOutlet(s,b.outlet,a),'pending',a,ctx,{billId:b.id,amount:amount/100,reference,paidOn,reason:text(p.reason,'收款说明')});break;
 }
 case 'offline.review':{
  role(a,['finance']);r=get(s,'offlinePayments',p.id);check(r.status==='pending','TRANSITION','收款申请已处理',409);independent(r,a,ctx);decision(p);const b=get(s,'bills',r.billId);
  if(p.decision==='approve'){check(b.status==='unpaid'&&money(b.amount)===money(r.amount)&&!s.receipts.some(x=>x.billId===b.id),'CONFLICT','账单金额或实收状态已变化',409);check(!s.payments.some(x=>x.billId===b.id&&x.status==='pending'),'CONFLICT','存在在途在线支付，请先核验',409);const receipt=put(s,'receipts','receipt',getOutlet(s,b.outlet,a),'success',a,ctx,{billId:b.id,amount:r.amount,month:b.month,offlinePaymentId:r.id,adapterMode:'manual',externalReference:r.reference,paidOn:r.paidOn});b.status='paid';b.paidAt=time(s,ctx);r.receiptId=receipt.id;}
  r.status=p.decision==='approve'?'approved':'returned';r.reviewedBy=subject;r.reviewNote=p.note;notification(s,r,'线下收款核验结果','fees',ctx);break;
 }
 case 'refund.request':{
  role(a,['partner','manager','finance']);const receipt=confirmedReceipt(scoped(s,'receipts',p.receiptId,a),'模拟实收不能登记真实退款');const amount=money(p.amount,true),reserved=refunded(s,receipt.id,['pending','approved','recorded']);check(amount<=money(receipt.amount)-reserved,'CONFLICT','申请退款超过可退实收余额',409);r=put(s,'refundRequests','refund',getOutlet(s,receipt.outlet,a),'pending',a,ctx,{receiptId:receipt.id,billId:receipt.billId,amount:amount/100,reason:text(p.reason,'退款原因'),externalExecuted:false});break;
 }
 case 'refund.review':{
  role(a,['finance']);r=get(s,'refundRequests',p.id);check(r.status==='pending','TRANSITION','退款申请已处理',409);independent(r,a,ctx);decision(p);if(p.decision==='approve'){const receipt=confirmedReceipt(get(s,'receipts',r.receiptId));check(!invoiceBusy(s,r.receiptId),'CONFLICT','须先取消待开票申请或完成已开票冲红',409);check(refunded(s,receipt.id,['pending','approved','recorded'])<=money(receipt.amount),'CONFLICT','可退余额已变化',409);}r.status=p.decision==='approve'?'approved':'returned';r.reviewedBy=subject;r.reviewNote=p.note;notification(s,r,r.status==='approved'?'退款申请已通过，等待退款办理':'退款申请已退回','fees',ctx,{refundRequestId:r.id});break;
 }
 case 'refund.record':{
  role(a,['finance']);r=get(s,'refundRequests',p.id);check(r.status==='approved','TRANSITION','须先通过退款审核',409);const receipt=confirmedReceipt(get(s,'receipts',r.receiptId));check(!invoiceBusy(s,r.receiptId),'CONFLICT','发票状态变化，须先完成发票核实',409);const reference=text(p.reference,'退款凭证');check(!s.refundRequests.some(x=>x.reference===reference),'DUPLICATE','退款凭证已登记',409);const refundedOn=date(p.refundedOn);check(refundedOn<=today,'INPUT','退款日期不能晚于今日');check(refunded(s,receipt.id)+money(r.amount)<=money(receipt.amount),'CONFLICT','退款超出实收',409);Object.assign(r,{status:'recorded',reference,refundedOn,externalExecuted:true,recordedBy:subject,note:text(p.note,'核验说明')});const b=get(s,'bills',r.billId);b.refundAmount=sum(s.refundRequests.filter(x=>x.billId===b.id&&x.status==='recorded'))/100;notification(s,r,'退款已完成','fees',ctx,{refundRequestId:r.id});break;
 }
 case 'invoice.request':{
  role(a,['partner','manager','finance']);const receipt=confirmedReceipt(scoped(s,'receipts',p.receiptId,a),'模拟实收不能申请真实发票');const {agreement}=invoiceSource(s,receipt),amount=money(p.amount,true),reserved=sum(s.invoiceRequests.filter(x=>x.receiptId===receipt.id&&['pending','issued','red_pending'].includes(x.status))),refunds=refunded(s,receipt.id,['pending','approved','recorded']);check(amount<=money(receipt.amount)-refunds-reserved,'CONFLICT','申请开票超过可开票净实收',409);r=put(s,'invoiceRequests','invoice',getOutlet(s,receipt.outlet,a),'pending',a,ctx,{receiptId:receipt.id,billId:receipt.billId,agreementId:agreement.id,amount:amount/100,title:text(p.title,'发票抬头'),taxId:text(p.taxId,'纳税识别号'),invoiceEntity:agreement.priceSnapshot.invoiceEntity,reason:text(p.reason,'开票说明')});break;
 }
 case 'invoice.update':{
  role(a,['finance']);r=get(s,'invoiceRequests',p.id);check(({pending:['issued','rejected','cancelled'],issued:['red_pending'],red_pending:['red_issued']})[r.status]?.includes(p.status),'TRANSITION','发票状态迁移无效',409);text(p.note,'凭证说明');
  if(p.status==='issued'){confirmedReceipt(get(s,'receipts',r.receiptId));check(!s.refundRequests.some(x=>x.receiptId===r.receiptId&&['pending','approved'].includes(x.status)),'CONFLICT','存在退款申请，请先协调',409);const number=text(p.number,'发票号码'),issuedOn=date(p.issuedOn);check(issuedOn<=today,'INPUT','开票日期不能晚于今日');check(!s.invoiceRequests.some(x=>x.number===number),'DUPLICATE','发票号码已登记',409);Object.assign(r,{number,issuedOn});}
  if(p.status==='red_issued'){const redNumber=text(p.redNumber,'红字发票号'),redOn=date(p.redOn);check(redOn<=today&&redOn>=r.issuedOn,'INPUT','红票日期无效');check(!s.invoiceRequests.some(x=>x.redNumber===redNumber),'DUPLICATE','红票号码已登记',409);Object.assign(r,{redNumber,redOn});}
  r.status=p.status;r.recordedBy=subject;notification(s,r,'发票状态已更新','fees',ctx);break;
 }
 case 'faq.save':{
  role(a,['manager','support']);const data={question:text(p.question,'问题'),answer:text(p.answer,'回答'),keywords:list(p.keywords,'关键词'),status:bool(p.published,'发布状态')?'published':'draft',reason:text(p.reason,'依据')};r=p.id?get(s,'faqEntries',p.id):put(s,'faqEntries','faq',null,'draft',a,ctx,{});Object.assign(r,data);break;
 }
 case 'public.profile':{
  role(a,['manager','ops']);
  const o=getOutlet(s,p.outlet,a);
  r=s.publicProfiles.find(x=>x.outlet===o.id)||put(s,'publicProfiles','profile',o,'draft',a,ctx,{publicCoords:null});
  const explicit=Object.hasOwn(p,'countryCode');
  const before=regions.countryCode(r.countryCode)||'CN';
  const code=explicit?regions.countryCode(p.countryCode):(regions.countryCode(r.countryCode)||regions.countryCode(o.countryCode)||'CN');
  check(code,'INPUT','请填写有效的国家或地区代码');
  if (Object.hasOwn(p,'publicCoords')) r.publicCoords=publicCoordinates(p.publicCoords,code);
  else check(!r.publicCoords||code===before,'INPUT','变更国家或地区时，请重新授权公开坐标或清除现有坐标');
  const location=code==='CN'?{province:o.province,city:o.city,district:o.district}:{
   province:'',city:text(p.city??r.city??o.city,'城市'),district:''
  };
  Object.assign(r,{...location,title:text(p.title,'名称'),description:text(p.description,'公开介绍'),services:list(p.services,'服务项目'),contact:p.contact?text(p.contact,'公开电话'):null,contactPublished:p.contactPublished===true,address:text(p.address,'公开地址'),status:bool(p.published,'发布状态')?'published':'draft',reason:text(p.reason,'授权依据')});
  if(explicit||code!=='CN')r.countryCode=code;
  break;
 }
 case 'cooperation.submit':{
  role(a,['partner','public']);const owner=own(a)||ctx.subject;check(typeof owner==='string'&&owner.length>0,'FORBIDDEN','提交合作留言须有有效个人会话',403);check(p.privacyConsented===true,'INPUT','请明确同意为本次合作联络处理所填联系资料');const short=(value,label)=>{const result=text(value,label);check(result.length<=200,'INPUT',label+'不得超过200字');return result;};const data={company:short(p.company,'单位名称'),name:short(p.name,'联系人'),contact:short(p.contact,'联系方式'),message:text(p.message,'留言内容')};check(!s.cooperationRequests.some(x=>x.owner===owner&&x.status!=='closed'&&x.company===data.company&&x.contact===data.contact&&x.message===data.message),'DUPLICATE','同一合作留言已在处理中',409);r=put(s,'cooperationRequests','cooperation',{owner},'submitted',a,ctx,{...data,privacyConsented:true,consentedAt:time(s,ctx),consentVersion:'cooperation-contact-v1'});notification(s,{...r,owner:'ops'},'收到新的合作留言','cooperation',ctx);break;
 }
 case 'cooperation.update':{
  role(a,['ops','manager']);r=get(s,'cooperationRequests',p.id);check(({submitted:['received'],received:['contacted'],contacted:['closed']})[r.status]?.includes(p.status),'TRANSITION','合作留言状态须依次接收、联系、关闭',409);r.processingNote=text(p.note,'处理说明');r.handledBy=subject;r.status=p.status;if(p.status==='closed')r.closedAt=time(s,ctx);notification(s,r,'合作留言进度已更新','cooperation',ctx);break;
 }
 case 'import.preview':{
  role(a,['manager']);check(['accounts','outlets'].includes(p.kind),'INPUT','导入类型无效');check(Array.isArray(p.rows)&&p.rows.length>=1&&p.rows.length<=200,'INPUT','单批须1—200行');const rows=validateRows(s,p.kind,p.rows,today);r=put(s,'importBatches','import',null,'preview',a,ctx,{kind:p.kind,rows,validCount:rows.filter(x=>!x.errors.length).length,errorCount:rows.filter(x=>x.errors.length).length,reason:text(p.reason,'资料授权依据'),createdIds:[]});break;
 }
 case 'import.commit':{
  role(a,['manager']);r=get(s,'importBatches',p.id);if(r.status==='committed')return r;check(r.status==='preview'&&!r.errorCount,'INPUT','预览存在错误，修正后重新预览');const rows=validateRows(s,r.kind,r.rows.map(x=>x.data),today);check(rows.every(x=>!x.errors.length),'CONFLICT','资料已变化，请重新预览核对重复或主体状态',409);
  for(const row of rows){const d=row.data;if(r.kind==='accounts'){const owner='p-'+randomUUID();put(s,'organizations','org',null,'active',a,ctx,{id:owner,owner,name:d.name});const acc=put(s,'accounts','acc',null,'active',a,ctx,{owner,actor:'partner:'+owner,managerName:d.managerName,mobile:d.mobile,bindingVersion:1,sourceBatchId:r.id});r.createdIds.push(acc.id);}else{const o=put(s,'outlets','out',{owner:d.owner},d.status,a,ctx,{...d,coords:null,locationStatus:'pending',agreementEnd:null,serviceUntil:null,events:[{date:d.opening,status:d.status,actor:a,subject,reason:'经授权批量建档'}],locationHistory:[],sourceBatchId:r.id});o.outlet=o.id;r.createdIds.push(o.id);}}
  r.status='committed';r.committedAt=time(s,ctx);break;
 }
 case 'routing.set':{
  role(a,['manager']);
  const {outlet,kind,assigneeRole,assigneeUserId,enabled}=p;
  check(typeof outlet==='string'&&outlet.length>0&&outlet.length<=120,'INPUT','请选择有效网点');
  check(taskRouting.isRoutable(kind,assigneeRole),'INPUT','分派岗位与业务阶段不匹配');
  bool(enabled,'分派规则启用状态');
  text(p.reason,'分派规则变更依据');
  const office=getOutlet(s,outlet,a);
  check(!enabled||office.status!=='closed','CONFLICT','已关闭网点不能启用自动分派',409);
  const existing=s.taskRoutingRules.find(item=>item.outlet===outlet&&item.kind===kind&&item.assigneeRole===assigneeRole);
  check(enabled||existing,'NOT_FOUND','分派规则不存在',404);
  if(enabled){
   check(typeof assigneeUserId==='string'&&assigneeUserId.length>0&&assigneeUserId.length<=120,'INPUT','请选择个人负责人');
   const recipient=get(s,'staffAccounts',assigneeUserId);
   check(recipient.status==='active'&&recipient.role===assigneeRole,'FORBIDDEN','接收人须为对应岗位的在职人员',403);
   check(taskRouting.isActivatedStaff(s,recipient.id),'ACCOUNT_NOT_ACTIVATED','接收人须先激活个人总部账号',409);
  }
  const status=enabled?'active':'disabled';
  r=existing||put(s,'taskRoutingRules','route',office,status,a,ctx,{kind,assigneeRole});
  r.status=status;
  if(enabled)r.assigneeUserId=assigneeUserId;
  break;
 }
 case 'staff.create':{
  role(a,['manager']);check(typeof p.subject==='string'&&/^[a-zA-Z0-9_-]{3,80}$/.test(p.subject)&&!['manager','finance','ops','support','location','regional','public','partnerA','partnerB'].includes(p.subject),'INPUT','员工个人主体须3—80位字母数字下划线，且不能占用岗位名');check(!s.staffAccounts.some(x=>x.id===p.subject),'DUPLICATE','个人主体已存在',409);check(STAFF_ROLES.includes(p.role),'INPUT','岗位无效');r=put(s,'staffAccounts','staff',null,'active',a,ctx,{id:p.subject,subject:p.subject,principal:p.subject,name:text(p.name,'姓名'),role:p.role,bindingVersion:1,grants:p.role==='regional'?verifyGrants(s,p.grants):{outlets:[],metrics:[],reviewOutlets:[]},reason:text(p.reason,'任命依据')});break;
 }
 case 'staff.update':{
  role(a,['manager']);r=get(s,'staffAccounts',p.id);check(['active','disabled'].includes(p.status),'INPUT','员工状态无效');text(p.reason,'变更依据');check(!(r.id===subject&&(p.status==='disabled'||p.role&&p.role!==r.role)),'FORBIDDEN','不可自行停用或调整本人岗位',403);if(p.status==='disabled'||p.role&&p.role!==r.role)check(!activeAssignments(s,r.id).length,'CONFLICT','存在个人未完待办，须先交接',409);if(p.role){check(STAFF_ROLES.includes(p.role),'INPUT','岗位无效');r.role=p.role;}if(p.name)r.name=text(p.name,'姓名');if(p.grants||r.role==='regional')r.grants=verifyGrants(s,p.grants||r.grants);r.status=p.status;r.bindingVersion++;break;
 }
 case 'staff.handover':{
  role(a,['manager']);const from=get(s,'staffAccounts',p.fromSubject),to=get(s,'staffAccounts',p.toSubject);check(from.id!==to.id&&from.id!==subject&&to.status==='active'&&from.role===to.role,'CONFLICT','须交接给另一在职同岗位人员，不能停用本人',409);check(taskRouting.isActivatedStaff(s,to.id),'ACCOUNT_NOT_ACTIVATED','接收人须先激活个人总部账号',409);const reason=text(p.reason,'交接依据'),assignments=activeAssignments(s,from.id);for(const x of assignments){if(to.role==='regional')check(effectiveGrants(to.grants,ctx).outlets.includes(x.record.outlet),'FORBIDDEN','接收人无对应网点授权',403);if(x.collection==='businessTasks')responsibility.assign(x.record,{role:to.role,userId:to.id},{actor:a,subject,at:time(s,ctx),requestId:ctx.requestId,note:privateTaskNote(reason)});else x.record.assignee=to.id;record(s,x.record,a,c,p,ctx);}r=put(s,'handovers','handover',null,'completed',a,ctx,{fromSubject:from.id,toSubject:to.id,reason,moved:assignments.map(x=>({collection:x.collection,id:x.record.id}))});from.status='disabled';from.bindingVersion++;from.handoverId=r.id;record(s,from,a,c,p,ctx);break;
 }
 case 'jobs.run':role(a,['manager','ops','finance']);r=runJobs(s,a,p,{...ctx,today});break;
 case 'task.create':{
  role(a,['manager']);
  check(typeof p.businessType==='string'&&Object.hasOwn(responsibility.TARGETS,p.businessType)&&typeof p.businessId==='string'&&p.businessId.length>0&&p.businessId.length<=120,'INPUT','请选择有效的关联业务对象');
  const source=get(s,p.businessType,p.businessId);
  check(!p.businessType.startsWith('support')||source.severe,'FORBIDDEN','只能为已升级客服记录创建总部跟进任务',403);
  const outletId=p.businessType==='outlets'?source.id:source.outlet;
  const m=source.month||source.data?.month||null;
  const key=responsibility.sourceKey(p.businessType,{...source,outlet:outletId,month:m});
  check(!s.businessTasks.some(t=>responsibility.active(t)&&t.responsibilityKey===key),'DUPLICATE','此业务已有当前责任待办',409);
  const title=text(p.title,'待办标题'),note=text(p.note,'登记说明');
  check(title.length<=120,'INPUT','待办标题不得超过120字');
  let dueAt=null;
  if(p.dueAt!=null){
   check(typeof p.dueAt==='string'&&/^20\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(p.dueAt)&&Number.isFinite(Date.parse(p.dueAt)),'INPUT','截止日期须为自然日或带时区的时间');
   date(p.dueAt.slice(0,10));
   dueAt=p.dueAt.length===10?p.dueAt:new Date(p.dueAt).toISOString();
  }
  r=addResponsibility(s,{kind:'headquarters_followup',source:{...source,outlet:outletId,month:m},roleName:'manager',queue:'hq',businessType:p.businessType,internal:true,dueAt,extra:{title,note:privateTaskNote(note)},occurrence:randomUUID()},ctx);
  break;
 }
 case 'task.assign':case 'task.complete':case 'task.update':{
  r=get(s,'businessTasks',p.id);
  const assigned=responsibility.assignee(r);
  const isAssignee=responsibility.matchesAssignee(r,a,subject);
  const source=s[r.businessType]?.find(x=>x.id===r.businessId);
  if(c==='task.assign'||p.assignee){
   role(a,['manager']);
   const requestedRole=c==='task.assign'?p.assigneeRole:assigned.role;
   const userId=(c==='task.assign'?p.assigneeUserId:p.assignee)??null;
   const allowed=responsibility.rolesForTask(r,source);
   check(allowed.includes(requestedRole),'FORBIDDEN','目标岗位不具备该待办的业务权限',403);
   if(userId!==null){
    check(typeof userId==='string'&&userId.length<=120,'INPUT','人员账号无效');
    const staff=get(s,'staffAccounts',userId);
    check(staff.status==='active'&&staff.role===requestedRole,'FORBIDDEN','接收人须为有效对应岗位',403);
    check(taskRouting.isActivatedStaff(s,staff.id),'ACCOUNT_NOT_ACTIVATED','接收人须先激活个人总部账号',409);
   }
   if(r.businessType?.startsWith('support')&&requestedRole==='support'&&source.assignee)
    check(userId===source.assignee,'FORBIDDEN','客服待办须由当前工单接单人处理',403);
   const note=text(p.note,'分派说明');
   responsibility.assign(r,{role:requestedRole,userId},{actor:a,subject,at:time(s,ctx),requestId:ctx.requestId,note:privateTaskNote(note)});
   if(c==='task.assign')break;
  }
  check(c==='task.complete'?isAssignee:a==='manager'||isAssignee,'FORBIDDEN','当前身份不是待办责任人',403);
  check(!own(a)&&a!=='public'&&a!=='regional','FORBIDDEN','此类待办须通过业务操作处理',403);
  check(responsibility.active(r),'TRANSITION','待办已经终结',409);
  const next=c==='task.complete'?'resolved':p.status;
  check(['open','in_progress','resolved'].includes(next),'INPUT','待办状态无效');
  check(next!=='open'||r.status==='open','TRANSITION','办理中的待办不能直接重新打开',409);
  if(next==='resolved'){
   if(responsibility.manual(r))check(isAssignee&&source&&(!r.businessType.startsWith('support')||a==='manager'&&source.severe||a==='support'&&(!source.assignee||source.assignee===subject)),'FORBIDDEN','只能由具有业务访问权的当前责任人完成',403);
   else check(c==='task.update'&&taskResolved(s,r),'CONFLICT','业务事实尚未完成，不能只改待办状态',409);
   responsibility.close(r,time(s,ctx),responsibility.manual(r)?'completed':'business_fact');
  }else r.status=next;
  r.note=privateTaskNote(text(p.note,'处理说明'));
  break;
 }
 default:check(false,'UNKNOWN_COMMAND','未知业务命令');
 }
 record(s,r,a,c,p,ctx);return r;
}
function validateRows(s,kind,input,today){
 const seen=new Set();return input.map((raw,index)=>{const errors=[];let data={};try{check(raw&&typeof raw==='object'&&!Array.isArray(raw),'INPUT','行须为对象');if(kind==='accounts'){data={name:text(raw.name,'加盟商名称'),managerName:text(raw.managerName,'负责人'),mobile:text(raw.mobile,'手机')};check(/^1\d{10}$/.test(data.mobile),'INPUT','手机格式无效');check(!s.accounts.some(x=>x.mobile===data.mobile)&&!seen.has(data.mobile),'INPUT','手机号重复');seen.add(data.mobile);}else{data={owner:text(raw.owner,'加盟商主体'),name:text(raw.name,'网点名'),...regions.administrativeArea(raw,text),address:text(raw.address,'地址'),phone:text(raw.phone,'公开电话'),opening:date(raw.opening),status:raw.status,enrollmentApplicable:bool(raw.enrollmentApplicable,'招生适用性')};check(s.accounts.some(x=>x.owner===data.owner&&x.status==='active'),'INPUT','加盟商主体不存在或停用');check(['preparing','open','paused'].includes(data.status),'INPUT','网点初始状态无效');check(data.status==='preparing'||data.opening<=today,'INPUT','已营业/暂停网点开业日不得为未来');const key=data.owner+'|'+data.name;check(!s.outlets.some(x=>x.owner===data.owner&&x.name===data.name)&&!seen.has(key),'INPUT','同主体网点名重复');seen.add(key);}}catch(e){errors.push(e.message);data=clone(raw||{});}return {row:index+1,data,errors};});
}
function policyFor(s,today){return s.policies.filter(x=>x.status==='published'&&x.effectiveFrom<=today).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom)||b.version-a.version)[0]||null;}
function reportDueDay(policy){return policy?policy.reportDueDay??null:5;}
function reportDueOn(month,day){
 return typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)&&Number.isInteger(day)&&day>=1&&day<=28?new Date(Date.UTC(+month.slice(0,4),+month.slice(5),day)).toISOString().slice(0,10):null;
}
function reportTiming(s,m,policy=policyFor(s,s.today)){
 const dueOn=reportDueOn(m,reportDueDay(policy));
 return {dueOn,late:dueOn?s.today>dueOn:null,policyId:policy?.id||null};
}
function reportDeadlines(s,months){
 const policy=policyFor(s,s.today);
 return Object.fromEntries(months.map(month=>[month,reportTiming(s,month,policy)]));
}
function timedReportTask(task){return ['report_missing','exemption_review'].includes(task.kind);}
function updateReportTaskTiming(task,timing){
 task.dueOn=task.dueAt=timing.dueOn;
 task.overdue=timing.late===true;
 task.policyId=timing.policyId;
 return task;
}
function previousMonth(m){return new Date(Date.UTC(+m.slice(0,4),+m.slice(5)-2,1)).toISOString().slice(0,7);}
const privateTaskNote=note=>note.replace(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g,'$1****$2');
function addResponsibility(s,{kind,source:r,roleName,queue=null,businessType,scopeKey=responsibility.sourceKey(businessType,r),internal=false,dueAt=null,extra={},occurrence='',key:taskKey},ctx){
 taskKey||=[kind,r.id,occurrence].join('|');
 const existing=s.businessTasks.find(t=>responsibility.active(t)&&t.queue===(queue||null)&&(t.taskKey===taskKey||t.kind===kind&&t.recordId===r.id&&t.queue));
 const at=time(s,ctx),m=r.month||r.data?.month||null,assigneeUserId=extra.assignee||null;
 if(existing?.businessType)return existing;
 const metadata=responsibility.metadata({kind,role:roleName,queue,businessType,businessId:r.id,outlet:r.outlet,month:m,owner:r.owner,dueAt,key:taskKey,scopeKey,ctx,assigneeUserId:existing?.assignee||assigneeUserId});
 if(existing){Object.assign(existing,metadata);return existing;}
 if(queue)for(const t of s.businessTasks)if(responsibility.active(t)&&t.responsibilityKey===metadata.responsibilityKey)
  responsibility.close(t,at,t.kind==='headquarters_followup'?'superseded_by_workflow':'business_fact');
 const task={kind,month:m,role:roleName,target:responsibility.TARGETS[businessType],recordId:r.id,taskKey,internal,dueOn:dueAt?.length===10?dueAt:null,assignee:assigneeUserId,...extra,...metadata};
 const recipient=queue&&queue!=='partner'&&!assigneeUserId&&taskRouting.resolveAssignee(s,r.outlet,kind,roleName);
 if(recipient){
  task.routingRuleId=taskRouting.resolveRule(s,r.outlet,kind,roleName).id;
  responsibility.assign(task,{role:roleName,userId:recipient.id},{
   actor:'system',subject:'system',at,requestId:ctx.requestId,note:'按网点和业务阶段自动分派'
  });
 }
 return put(s,'businessTasks','task',{id:r.outlet,owner:r.owner},'open','system',ctx,task);
}
function queueResettlement(s,previous,ctx){
 return addResponsibility(s,{kind:'report_resettlement',source:previous,roleName:'manager',queue:'hq',businessType:'settlements',internal:true,extra:{title:'历史月报待重新结算',impacts:[],affectedOutletIds:[]}},ctx);
}
const needsManagement=t=>!!(t?.assignee&&t.severe&&!t.managementHandled&&t.status!=='closed');
function taskResolved(s,t){
 const report=s.reports.find(x=>x.id===t.recordId),request=s.requests.find(x=>x.id===t.recordId),ticket=[...s.supportTickets,...s.supportChats].find(x=>x.id===t.recordId);
 if(t.kind==='report_review')return !!report&&report.status!=='pending';
 if(t.kind==='report_finance_review')return !!report&&report.status!=='finance';
 if(t.kind==='report_returned')return !!report&&(report.status!=='returned'||s.reports.some(x=>x.outlet===report.outlet&&x.month===report.month&&x.version>report.version));
 if(t.kind==='request_review')return !!request&&(request.status!=='pending'||['newOutlet','locationChange'].includes(request.type)&&request.data?.locationStatus==='pending');
 if(t.kind==='location_request_review')return !!request&&(request.status!=='pending'||request.data?.locationStatus!=='pending');
 if(t.kind==='request_supplement')return !!request&&!['supplement','returned'].includes(request.status);
 if(t.kind==='fee_calculation')return s.adjustments.some(x=>x.id===t.recordId&&x.status!=='待财务核算调整')||s.feeProposals.some(x=>x.adjustmentId===t.recordId&&x.status==='pending');
 if(t.kind==='fee_proposal_review'){
  const proposal=s.feeProposals.find(x=>x.id===t.recordId);
  return !!proposal&&(proposal.status!=='pending'||s.adjustments.some(x=>x.id===proposal.adjustmentId&&x.status!=='待财务核算调整'));
 }
 if(t.kind==='support_management')return !!ticket&&!needsManagement(ticket);
 if(t.kind==='support_queue')return !!ticket&&ticket.status!=='queued';
 if(t.kind==='support_waiting')return !!ticket&&ticket.status!=='waiting';
 if(t.kind==='support_reply')return !!ticket&&(['closed','waiting'].includes(ticket.status)||(t.replySequence?ticket.replyAcknowledgedCount>=t.replySequence:ticket.replyAcknowledgedAt&&ticket.replyAcknowledgedAt>=(t.replyAt||''))||ticket.messages.some((x,i)=>!['support','manager','faq'].includes(x.actor)&&(t.replySequence?i>=t.replySequence:x.at>(t.replyAt||''))));
 if(t.kind==='bill_unpaid')return s.bills.some(x=>x.id===t.recordId&&x.status!=='unpaid');
 if(['report_missing','exemption_review'].includes(t.kind))return s.reports.some(x=>x.outlet===t.outlet&&x.month===t.month&&!x.revoked&&['pending','finance','returned','approved'].includes(x.status))||s.exemptions.some(x=>x.outlet===t.outlet&&x.month===t.month&&x.status==='approved');
 if(t.kind==='location_missing')return s.verifications.some(x=>x.outlet===t.outlet&&x.month===t.month)||s.outlets.some(x=>x.id===t.outlet&&!['open','paused'].includes(x.status));
 if(t.kind==='metric_anomaly')return !!report&&(!report.current||report.status!=='approved');
 if(['location_verification','location_exception'].includes(t.kind)){
  const v=s.verifications.find(x=>x.id===t.recordId);
  return !!v&&(v.status!==(t.kind==='location_verification'?'pending':'exception')||s.verifications.some(x=>x.previousId===v.id));
 }
 if(['summary_review','summary_finance_review'].includes(t.kind)){
  const a=s.summaryAdjustments.find(x=>x.id===t.recordId);
  return !!a&&a.status!==(t.kind==='summary_review'?'pending':'finance');
 }
 if(t.kind==='bill_overdue')return s.bills.some(x=>x.id===t.recordId&&['paid','reversed','settled_zero'].includes(x.status));
 if(t.kind==='support_sla')return s.supportTickets.some(x=>x.id===t.recordId&&(x.status==='closed'||!!x.firstResponseAt||needsManagement(x)));return false;
}
function reconcile(s,ctx={}, {openBills=false,outlets=null}={}){
 ensure(s);
 for(const t of s.businessTasks)if(responsibility.active(t)&&taskResolved(s,t))responsibility.close(t,time(s,ctx),'business_fact');
 const add=(kind,r,roleName,queue,businessType,internal=false,extra={},occurrence='',scopeKey)=>{
  const task={kind,outlet:r.outlet,month:r.month||null,recordId:r.id,...extra};
  if(taskResolved(s,task))return;
  const row=addResponsibility(s,{kind,source:r,roleName,queue,businessType,scopeKey,internal,dueAt:kind==='bill_unpaid'?r.dueOn||null:null,extra,occurrence},ctx);
  if(queue==='partner'){
   const message=s.messages.filter(x=>x.owner===r.owner&&x.recordId===r.id&&x.target===row.target).at(-1);
   if(message&&!message.taskId)message.taskId=row.id;
  }
 };
 for(const r of s.reports){
  if(r.status==='pending')add('report_review',r,'ops','ops','reports',true);
  if(r.status==='finance')add('report_finance_review',r,'finance','finance','reports',true);
  if(r.status==='returned')add('report_returned',r,'partner','partner','reports');
 }
 for(const r of s.requests){
  const occurrence=r.trail?.length||0;
  if(r.status==='pending'){
   if(['newOutlet','locationChange'].includes(r.type)&&r.data?.locationStatus==='pending')add('location_request_review',r,'location','hq','requests',true,{},occurrence);
   else{
    const roleName=r.type==='accountChange'?'manager':['pauseFee','exemptException','reportRevoke'].includes(r.type)?'finance':'ops';
    add('request_review',r,roleName,roleName==='finance'?'finance':'hq','requests',true,{},occurrence);
   }
  }
  if(['supplement','returned'].includes(r.status)){
   if(r.type!=='reportRevoke')add('request_supplement',r,'partner','partner','requests',false,{},occurrence);
  }
 }
 for(const r of s.verifications){
  if(r.status==='pending')add('location_verification',r,'location','hq','verifications',true);
  if(r.status==='exception'){
   add('location_exception',r,'location','hq','verifications',true);
   add('location_exception',r,'partner','partner','verifications',false,{},'partner',responsibility.partnerKey('location_exception',r));
  }
 }
 for(const r of s.summaryAdjustments){
  if(r.status==='pending')add('summary_review',r,'ops','hq','summaryAdjustments',true);
  if(r.status==='finance')add('summary_finance_review',r,'finance','finance','summaryAdjustments',true);
 }
 const pendingProposals=new Map(s.feeProposals.filter(p=>p.status==='pending').map(p=>[p.adjustmentId,p]));
 for(const r of s.adjustments)if(r.status==='待财务核算调整'){
  const proposal=pendingProposals.get(r.id);
  if(proposal)add('fee_proposal_review',{...proposal,month:proposal.offsetMonth},'finance','finance','feeProposals',true);
  else add('fee_calculation',r,'ops','hq','adjustments',true);
 }
 if(openBills)for(const r of s.bills)if(r.status==='unpaid'&&(!outlets||outlets.has(r.outlet)))add('bill_unpaid',r,'partner','partner','bills',false,{},'',responsibility.partnerKey('bill_unpaid',r));
 for(const collection of ['supportTickets','supportChats'])for(const r of s[collection]){
  const escalation=collection==='supportTickets'&&s.businessTasks.find(t=>t.kind==='support_sla'&&t.recordId===r.id&&responsibility.active(t));
  if(escalation&&r.assignee&&responsibility.assignee(escalation).userId!==r.assignee){
   const at=time(s,ctx);
   responsibility.assign(escalation,{role:'support',userId:r.assignee},{actor:ctx.actor||'system',subject:ctx.subject||'system',at,requestId:ctx.requestId,note:'同步当前工单负责人'});
   escalation.updatedAt=at;
  }
  if(needsManagement(r))add('support_management',r,'manager','hq',collection,true);
  else if(r.status==='queued'&&!escalation)add('support_queue',r,'support','hq',collection,true);
  const franchisee=r.owner==='p1'||r.owner==='p2'||own('partner:'+r.owner)===r.owner;
  const customerQueue=franchisee?'partner':null;
  const customerKey=responsibility.partnerKey('support_waiting',r);
  if(r.status==='waiting')add('support_waiting',r,'partner',customerQueue,collection,false,{},'',customerKey);
  const reply=r.messages.filter(x=>['support','manager'].includes(x.actor)).at(-1);
  if(reply){const replySequence=r.messages.lastIndexOf(reply)+1;add('support_reply',r,'partner',customerQueue,collection,false,{replyAt:reply.at,replySequence},replySequence,customerKey);}
 }
}
function runJobs(s,a,p,ctx){
 const today=ctx.today;if(p.today)check(p.today===today,'INPUT','作业日期必须为服务端业务日期');const limit=p.limit===undefined?100:p.limit,cursor=p.cursor===undefined?0:p.cursor;check(Number.isInteger(limit)&&limit>0&&limit<=200&&Number.isInteger(cursor)&&cursor>=0,'INPUT','批次limit须1—200，cursor须非负整数');
 const all=s.outlets.filter(x=>!p.outlet||x.id===p.outlet).slice().sort((x,y)=>x.id.localeCompare(y.id));if(p.outlet)check(all.length,'NOT_FOUND','网点不存在',404);if(ctx.jobScope)check(ctx.jobScope.cursor===cursor&&Number.isInteger(ctx.jobScope.total)&&ctx.jobScope.total>=0&&all.length<=limit,'INPUT','可信作业批次元数据无效');const batch=ctx.jobScope?all:all.slice(cursor,cursor+limit),scopeTotal=ctx.jobScope?ctx.jobScope.total:all.length,key=today+'|'+(p.outlet||'all')+'|'+cursor+'|'+limit,existing=s.jobRuns.find(x=>x.jobKey===key);const outletIds=new Set(batch.map(o=>o.id));reconcile(s,ctx,{openBills:true,outlets:outletIds});
 const policy=policyFor(s,today),current=today.slice(0,7),last=previousMonth(current);let created=0;
 const add=(kind,o,month,roleName,recordId,dueOn,extra={})=>{
  const key=[kind,o.id,month,recordId||''].join('|');
  const old=s.businessTasks.find(t=>t.taskKey===key&&(responsibility.active(t)||['metric_anomaly','no_data'].includes(kind)));
  const target=kind==='location_missing'?'location':kind==='bill_overdue'?'fees':kind==='support_sla'?'support':'reports';
  const businessType=kind==='bill_overdue'?'bills':kind==='support_sla'?'supportTickets':kind==='metric_anomaly'?'reports':'outlets';
  const scopeType=({location_missing:'verifications',exemption_review:'reports',report_missing:'report_missing',no_data:'no_data'})[kind]||businessType;
  const source={id:recordId||o.id,owner:kind==='support_sla'?null:o.owner,outlet:o.id,month};
  const queue=kind==='report_missing'?'ops':'hq';
  const props={kind,outlet:o.id,month,role:roleName,recordId:recordId||null,dueOn:dueOn||null,overdue:!!dueOn&&today>dueOn,policyId:policy?.id||null,target,...extra};
  if(taskResolved(s,props))return;
  const scopeKey=responsibility.responsibilityKey(scopeType,source.id,source.outlet,source.month);
  let task=old;
  if(!task&&(kind==='support_sla'||!s.businessTasks.some(t=>responsibility.active(t)&&t.responsibilityKey===scopeKey))){
   task=addResponsibility(s,{kind,source,roleName,queue,businessType,scopeKey,internal:!!extra.internal,dueAt:extra.deadlineAt||dueOn||null,extra:props,key},ctx);
   created++;
  }
  let partnerTask;
  if(['report_missing','location_missing'].includes(kind)&&o.owner){
   const scopeKey=responsibility.partnerKey(kind,source);
   partnerTask=s.businessTasks.find(t=>responsibility.active(t)&&t.responsibilityKey===scopeKey);
   if(!partnerTask){
    partnerTask=addResponsibility(s,{kind,source,roleName:'partner',queue:'partner',businessType,scopeKey,dueAt:dueOn||null,extra:{...props,role:'partner'},key:'partner|'+key},ctx);
    created++;
   }
  }
  if(old){if(responsibility.active(old)&&!timedReportTask(old))old.overdue=!!old.dueOn&&today>old.dueOn;return;}
  if(!task)return;
  notification(s,kind==='support_sla'?{...task,owner:'support'}:task,({report_missing:'上月月报待报送',exemption_review:'暂停月份待核验免报',location_missing:'本月位置待核验',bill_overdue:'账单逾期待处理',support_sla:'客服首响超时待处理',metric_anomaly:'经营指标达到已配置复核阈值',no_data:'连续缺数据待核实'})[kind],target,ctx,{taskId:task.id,...(['report_missing','location_missing','exemption_review','bill_overdue'].includes(kind)?{month,recordId:recordId||null}:{}),...(partnerTask?{partnerTaskId:partnerTask.id}:{})});
 };
 for(const o of batch){
  const reportStatus=reportMonthStatus(s,o,last);
  if(reportStatus===null||reportStatus==='full_pause')add(reportStatus==='full_pause'?'exemption_review':'report_missing',o,last,'ops',null,reportTiming(s,last,policy).dueOn);
  if(['open','paused'].includes(o.status))add('location_missing',o,current,'location',null,policy?.locationDueDay?current+'-'+String(policy.locationDueDay).padStart(2,'0'):null);
  for(const b of s.bills.filter(x=>x.outlet===o.id&&x.status==='unpaid'&&x.dueOn&&x.dueOn<today))add('bill_overdue',o,b.month,'finance',b.id,b.dueOn);
  const reports=s.reports.filter(x=>x.outlet===o.id&&x.status==='approved'&&x.current).sort((x,y)=>y.month.localeCompare(x.month));if(policy?.anomalyPercent&&reports.length>=2&&reports[1].month===previousMonth(reports[0].month)){const changes={};for(const k of METRICS){const before=reports[1][k],after=reports[0][k];if(typeof before==='number'&&typeof after==='number'&&before!==0){const percent=(after-before)/Math.abs(before)*100;if(Math.abs(percent)>=policy.anomalyPercent)changes[k]=Math.round(percent*100)/100;}}if(Object.keys(changes).length)add('metric_anomaly',o,reports[0].month,'ops',reports[0].id,null,{changes,methodVersion:'relative-change-v1'});}
  if(policy?.noDataMonths&&o.status==='open'){const expected=Array.from({length:policy.noDataMonths},(_,i)=>new Date(Date.UTC(+current.slice(0,4),+current.slice(5)-2-i,1)).toISOString().slice(0,7));if(expected.every(m=>!s.reports.some(x=>x.outlet===o.id&&x.month===m&&x.current&&x.status==='approved')&&!s.exemptions.some(x=>x.outlet===o.id&&x.month===m&&x.status==='approved'))&&o.events?.some(e=>e.status==='open'&&e.date<=expected.at(-1)+'-01'))add('no_data',o,last,'ops',null,null,{months:expected});}
 }
 for(const t of s.supportTickets.filter(x=>batch.some(o=>o.id===x.outlet)&&x.status!=='closed'&&!x.firstResponseAt&&!needsManagement(x))){
  const minutes=policy?policy.slaMinutes[t.category]:s.supportSettings?.sla?.[t.category];
  if(!minutes||Date.parse(time(s,ctx))-Date.parse(t.createdAt)<=minutes*60000)continue;
  const previous=s.businessTasks.find(task=>task.recordId===t.id&&task.kind==='support_queue'&&responsibility.active(task));
  add('support_sla',getOutlet(s,t.outlet,a),current,'support',t.id,null,{
   owner:null,internal:true,assignee:t.assignee||(previous?responsibility.assignee(previous).userId:null),
   ...(previous?.routingRuleId?{routingRuleId:previous.routingRuleId}:{}),
   deadlineAt:new Date(Date.parse(t.createdAt)+minutes*60000).toISOString()
  });
 }
 const observedAt=time(s,ctx);
 for(const task of s.businessTasks){
  if(!responsibility.active(task)||!outletIds.has(task.outlet))continue;
  if(timedReportTask(task))updateReportTaskTiming(task,reportTiming(s,task.month,policy));
  if(!task.dueAt)continue;
  task.overdue=task.dueAt<(task.dueAt.length===10?today:observedAt);
  if(task.overdue&&!task.overdueObservedAt){
   task.overdueObservedAt=observedAt;
   record(s,task,'system','task.overdue',{note:'首次观测到已超过服务端记录的截止时间'},ctx);
  }
 }
 if(existing){existing.createdTasks+=created;existing.finishedAt=time(s,ctx);existing.attempts++;return existing;}
 return put(s,'jobRuns','job',null,'completed',a,ctx,{jobKey:key,today,month:current,cursor,limit,processed:batch.length,nextCursor:cursor+batch.length<scopeTotal?cursor+batch.length:null,createdTasks:created,policyId:policy?.id||null,startedAt:time(s,ctx),finishedAt:time(s,ctx),attempts:1,requestId:ctx.requestId||null});
}
function publicRefundReference(row){
 if(typeof row.customerReference==='string'&&row.customerReference)return row.customerReference;
 return typeof row.reference==='string'?(row.providerRefundOrderId?row.reference.replace(/^(wechat|alipay):(real|mock):/,''):row.reference):null;
}
function refundRecordSource(row){
 if(row.status!=='recorded')return undefined;
 return row.adapterMode==='mock'?'simulation':row.providerRefundOrderId?'channel':'manual';
}
function extendView(s,v,a,ctx={}){
 ensure(s);context(s,a,ctx);const owner=own(a),manager=a==='manager',finance=a==='finance',ops=a==='ops',ids=new Set(v.outlets.map(x=>x.id));const scoped=x=>owner?x.owner===owner:ids.has(x.outlet);const without=(x,keys)=>{const y=clone(x);for(const k of keys)delete y[k];return y;};
 for(const k of COLLECTIONS)v[k]=[];
 if(manager||finance||ops||owner){v.policies=s.policies.map(x=>without(x,owner?['trail','initiator','reason']:[]));v.pricePlans=s.pricePlans.filter(x=>!owner||s.agreements.some(y=>y.owner===owner&&y.planId===x.id)).map(x=>without(x,owner?['trail','initiator','reason']:[]));v.agreements=s.agreements.filter(scoped).map(x=>{const y=without(x,owner?['trail','initiator','reason']:[]);Object.assign(y,agreementDates(x));if(owner)y.priceSnapshot=without(y.priceSnapshot,['trail','initiator','reason']);return y;});}
 for(const k of ['billCorrections','feeProposals','offlinePayments','refundRequests','invoiceRequests'])if(manager||finance||owner||ops&&['billCorrections','feeProposals'].includes(k))v[k]=s[k].filter(scoped).map(x=>without(x,owner?['trail','initiator','reviewedBy','recordedBy']:[]));
 if(owner)for(const refund of v.refundRequests){
  const reference=publicRefundReference(refund);
  if(reference)Object.assign(refund,{reference,customerReference:reference});
  if(refund.status==='recorded')refund.refundRecordSource=refundRecordSource(refund);
  delete refund.providerRefundOrderId;
 }
 v.businessTasks=s.businessTasks.filter(x=>{
  if(manager)return true;
  if(owner)return responsibility.belongsToPartner(x,owner,ctx.subject)&&(x.outlet==null||ids.has(x.outlet));
  if(a==='public')return x.owner===ctx.subject&&!x.internal&&['support_waiting','support_reply'].includes(x.kind);
  return responsibility.matchesAssignee(x,a,ctx.subject||a)&&(a!=='regional'||ids.has(x.outlet));
 }).map(x=>without(x,owner||a==='public'?['trail','initiator','assignee','assigneeUserId','transferHistory','eventId','idempotencyKey','responsibilityKey','note']:[]));
 if(manager||finance||ops)v.jobRuns=clone(s.jobRuns);
 v.faqEntries=s.faqEntries.filter(x=>manager||a==='support'||x.status==='published').map(x=>without(x,manager||a==='support'?[]:['trail','initiator','reason','owner']));
 v.publicProfiles=s.publicProfiles.filter(x=>manager||ops||x.status==='published'&&s.outlets.some(o=>o.id===x.outlet&&o.status!=='closed')).map(x=>without(x,manager||ops?[]:['trail','initiator','reason','owner',...(!x.contactPublished?['contact']:[])]));
 if(manager||ops||owner||a==='public')v.cooperationRequests=s.cooperationRequests.filter(x=>manager||ops||x.owner===(owner||ctx.subject)).map(x=>without(x,manager||ops?[]:['trail','initiator','processingNote','handledBy']));
 if(manager){v.taskRoutingRules=clone(s.taskRoutingRules);v.contentVersions=clone(s.contentVersions);v.importBatches=clone(s.importBatches);v.staffAccounts=clone(s.staffAccounts);v.handovers=clone(s.handovers);}else v.staffAccounts=s.staffAccounts.filter(x=>x.id===ctx.subject).map(x=>without(x,['trail','reason']));
 return v;
}
function faqAnswer(s,input){const normalized=String(input).toLowerCase();return (s.faqEntries||[]).filter(x=>x.status==='published').find(x=>x.question===input||x.keywords.some(k=>normalized.includes(k.toLowerCase())))?.answer||'暂未找到相关答复，您可以选择转人工客服。具体费用和办理时限以已确认的协议、账单和规定为准。';}
module.exports={rankings,enrollmentFor,changeIdentity,locationAssessment,saveContent,publicContent,publicOutlet,publicRefundReference,refundRecordSource,coverage,effectiveGrants,COLLECTIONS,COMMANDS,ensure,context,scopedGrants,execute,extendView,reconcile,faqAnswer,policyFor,reportDueDay,reportDueOn,reportTiming,reportDeadlines,reportMonthStatus,previousMonth,timedReportTask,updateReportTaskTiming,queueResettlement};
