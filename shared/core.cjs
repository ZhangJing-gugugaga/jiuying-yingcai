'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const operations=require('./operations.cjs');
const taskRouting=require('./task-routing.cjs');
const {administrativeArea}=require('./outlet-regions.cjs');
const settlements=require('./report-settlements.cjs');
const {projectRequest,setPublicNote,requestNotice}=require('./request-projection.cjs');
const {safeNote}=require('./audit-redaction.cjs');
const {AsyncLocalStorage}=require('node:async_hooks');const executionClock=new AsyncLocalStorage();
const ACTORS=['partnerA','partnerB','ops','manager','finance','location','support','regional','public'];
const METRICS=['revenue','orders','traffic','enroll'];
const COLLECTIONS=['outlets','reports','requests','bills','payments','receipts','adjustments','verifications','exemptions','messages','audit','accounts','settlements','drafts','summaryAdjustments','supportChats','supportTickets','contents','organizations',...operations.COLLECTIONS];
const clone=x=>JSON.parse(JSON.stringify(x));
function fail(code,message,status=400){throw Object.assign(new Error(message),{code,status});}
function check(ok,code,msg,status=400){if(!ok)fail(code,msg,status);}
function role(a,rs){check(rs.includes(a)||(own(a)&&rs.includes('partnerA')),'FORBIDDEN','当前身份无此操作权限',403);}
const own=a=>({partnerA:'p1',partnerB:'p2'})[a]||(/^partner:p-[a-f0-9-]{36}$/.test(a)?a.slice(8):null);
const now=()=>executionClock.getStore()?.now?new Date(executionClock.getStore().now).toISOString():new Date().toISOString();
const clean=v=>typeof v==='string'?v.replace(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g,'$1****$2'):Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='base64'||k==='dataUrl'?'[附件内容省略]':clean(x)])):v;
function txt(x,label,required=true){check(typeof x==='string'&&x.length<=2000&&(!required||x.trim()),'INPUT',label+'不能为空或超长');return x.trim();}
function month(x){check(typeof x==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(x),'INPUT','月份格式无效');return x;}
function date(x){check(typeof x==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(x)&&!isNaN(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x,'INPUT','日期无效');return x;}
function num(x,money=false){check((typeof x==='number'||typeof x==='string')&&(money?/^\d+(\.\d{1,2})?$/:/^\d+$/).test(String(x))&&Number.isFinite(+x)&&+x<=1e10,'INPUT',money?'金额须非负、最多两位小数':'数量须为非负整数');return +x;}
function coord(x){check(x?.accuracy==null||Number.isFinite(x.accuracy)&&x.accuracy>=0,'INPUT','定位精度须非负数或null');check(x&&Number.isFinite(x.lat)&&Number.isFinite(x.lng)&&Math.abs(x.lat)<=90&&Math.abs(x.lng)<=180,'INPUT','坐标无效');check(!x.source||['gps','manual','simulated'].includes(x.source),'INPUT','坐标采集来源无效');check(!x.coordinateSystem||['GCJ-02','WGS-84','unknown'].includes(x.coordinateSystem),'INPUT','坐标基准无效');return {lat:x.lat,lng:x.lng,source:x.source||'simulated',coordinateSystem:x.coordinateSystem||'unknown',accuracy:Number.isFinite(x.accuracy)?x.accuracy:null};}
function photo(x){check(x&&typeof x.id==='string'&&x.id.startsWith('file-'),'INPUT','请先上传现场照片');return {id:x.id,name:x.name,type:x.type,size:x.size,url:'/api/files/'+x.id};}
function entity(s,p,o,status='pending'){return {id:p+'-'+randomUUID(),outlet:o?.id||null,owner:o?.owner||null,status,createdAt:now()};}
function trail(e,a,action,note,before=null){e.trail||=[];e.trail.push(clean({actor:a,subject:executionClock.getStore()?.subject||a,action,note:safeNote(note),before,after:{status:e.status},executedAt:now()}));}
function notice(s,e,title,target='reports',body='',extra={}){s.messages.push({...entity(s,'msg',{id:e.outlet||e.id,owner:e.owner},'unread'),title,body,target,read:false,recordId:e.id,...extra});}
function get(s,k,id){const r=s[k].find(x=>x.id===id);check(r,'NOT_FOUND','记录不存在',404);return r;}
function outlet(s,id,a,partner=false){const o=get(s,'outlets',id);if(partner)check(own(a),'FORBIDDEN','仅加盟商负责人可提交',403);if(own(a))check(o.owner===own(a),'FORBIDDEN','无权操作其他加盟商网点',403);return o;}
function current(s,id,m){return s.reports.find(r=>r.outlet===id&&r.month===m&&r.current&&r.status==='approved')||null;}
function invalidate(s,report,impact,a,ctx){settlements.invalidate(s,report.month,{outlet:report.outlet,...impact},{...ctx,actor:a},{now:now(),createTask:previous=>operations.queueResettlement(s,previous,ctx)});}

function reportMonthBlock(s,o,m){
 const reason=operations.reportMonthStatus(s,o,m);
 const reasonMap={
  current_month:['INPUT','只能报已结束自然月',400],future_month:['INPUT','只能报已结束自然月',400],
  exempt:['CONFLICT','已免报，财务事项请另申请',409],full_pause:['PAUSE_REVIEW','完整暂停，请总部核验免报或财务例外',409],
  no_operation:['NO_OPERATION','该月无营业历史，筹备期不能报送',409],
 };
 if(!reason)return null;
 const [code,message,status]=reasonMap[reason];
 return {reason,code,message,status};
}
function createState(){const s={schemaVersion:3,today:'2026-11-18',mode:'development',grants:{outlets:['cs'],metrics:['orders'],reviewOutlets:[]},supportSettings:{hours:'待集团配置',sla:{complaint:null,aftersale:null,exception:null}}};COLLECTIONS.forEach(k=>s[k]=[]);
 for(const [id,name,owner,city,enrollmentApplicable] of [['cs','长沙示范网点A','p1','长沙',true],['zz','株洲示范网点B','p1','株洲',false],['hy','衡阳示范网点C','p1','衡阳',false],['gz','广州示范网点D','p2','广州',true]]){const o={id,outlet:id,owner,name,status:id==='hy'?'paused':'open',createdAt:now(),province:id==='gz'?'广东':'湖南',city,district:'示范区',address:city+'市模拟路1号',phone:'000-00000000',coords:{lat:28.2,lng:113.1,source:'simulated',accuracy:null},enrollmentApplicable,agreementEnd:'2027-12-31',serviceUntil:null,events:[{date:'2025-01-01',status:'open',reason:'开发种子数据',actor:'manager'}],locationHistory:[]};if(id==='hy')o.events.push({date:'2026-09-25',status:'paused',reason:'开发种子暂停',actor:'manager'});s.outlets.push(o);s.bills.push({...entity(s,'bill',o,'unpaid'),month:'2026-11',amount:1980,priceVersion:'历史演示价格-待确认',simulation:true});notice(s,o,'本月位置核验：请主动提交定位与现场照片','location');}
 for(const owner of ['p1','p2']){s.accounts.push({...entity(s,'acc',null,'active'),owner,actor:owner==='p1'?'partnerA':'partnerB',managerName:owner==='p1'?'示范负责人甲':'示范负责人乙',mobile:owner==='p1'?'13800000001':'13800000002',bindingVersion:1,trail:[]});s.organizations.push({id:owner,outlet:null,owner,status:'active',createdAt:now(),name:owner==='p1'?'示范加盟商甲':'示范加盟商乙'});}
 for(const m of ['2025-11','2026-08','2026-09']){for(const [i,o] of s.outlets.entries())s.reports.push({...entity(s,'rpt',o,'approved'),month:m,version:1,revenue:10000+i*2000,orders:100+i*20,traffic:300+i*30,enroll:o.enrollmentApplicable?20+i:null,note:'开发历史样本',current:true,late:false,trail:[]});s.settlements.push({...entity(s,'set',null,'approved'),month:m,reportIds:s.reports.filter(r=>r.month===m).map(r=>r.id)});}
 notice(s,s.outlets[0],'10月月报待报送，当前业务样本日期11月18日','reports');notice(s,s.outlets[2],'完整暂停月份请总部核验免报；财务事项另申请','reports');return s;
}
function values(p,o,m,draft=false,previous={}){const enrollmentStatus=operations.enrollmentFor(o,m),v={};if(!draft)check(enrollmentStatus!=='pending','ENROLLMENT_PENDING','请总部确认该月招生适用性后提交',409);for(const k of METRICS){const x=Object.hasOwn(p,k)?p[k]:draft?previous[k]:undefined;v[k]=k==='enroll'&&enrollmentStatus!=='applicable'?null:draft&&(x===null||x===undefined||x==='')?null:num(x,k==='revenue');}v.note=p.note===undefined?(draft?previous.note||'':''):txt(p.note,'经营说明',false);v.enrollmentStatus=enrollmentStatus;return v;}
function setStatus(s,a,p){const o=outlet(s,p.outlet,a),d=date(p.effectiveDate);check(d<=s.today&&d>=o.events.at(-1).date,'INPUT','生效日期超出可登记范围');check(({preparing:['open','closed'],open:['paused','closed'],paused:['open','closed'],closed:[]})[o.status]?.includes(p.status),'TRANSITION','状态迁移无效，关闭后重开待确认',409);const before=o.status;o.status=p.status;o.events.push({date:d,status:p.status,reason:txt(p.reason,'变更原因'),actor:a});trail(o,a,'status',p.reason,before);return o;}
function requestData(t,d,s){check(d&&typeof d==='object'&&!Array.isArray(d),'INPUT','申请资料无效');if(t==='newOutlet')return {name:txt(d.name,'名称'),...administrativeArea(d,txt),address:txt(d.address,'地址'),phone:txt(d.phone,'电话'),opening:date(d.opening||d.plannedOpening),coords:coord(d.coords),photo:photo(d.photo),note:txt(d.note??'','说明',false),locationStatus:'pending'};
 if(t==='locationChange')return {address:txt(d.address,'地址'),coords:coord(d.coords),photo:photo(d.photo),reason:txt(d.reason,'原因'),locationStatus:'pending'};
 if(t==='pauseFee'){const from=date(d.from),to=date(d.to);check(from<=to,'INPUT','结束不得早于开始');return {from,to,reason:txt(d.reason,'原因')};}
 if(t==='statusChange'){check(['open','paused','closed'].includes(d.status),'INPUT','状态无效');return {status:d.status,effectiveDate:date(d.effectiveDate),reason:txt(d.reason,'原因')};}
 if(t==='enrollment'){check(typeof d.applicable==='boolean','INPUT','适用性必须为布尔值');return {applicable:d.applicable,reason:txt(d.reason,'原因')};}
 if(t==='exemptException')return {month:month(d.month),reason:txt(d.reason,'财务事项')};
 if(t==='accountChange'){
  const change=d.change===undefined?'manager':d.change;
  check(['manager','mobile'].includes(change),'INPUT','请选择正确的账号变更类型');
  check(/^1\d{10}$/.test(d.mobile),'INPUT','登记手机号无效');
  return {change,...(change==='manager'?{managerName:txt(d.managerName,'新负责人')}:{}),mobile:d.mobile,reason:txt(d.reason,'原因'),evidenceReference:d.evidenceReference?txt(d.evidenceReference,'核验资料编号'):null};
 }fail('INPUT','不支持该申请类型');
}
function supportOwner(a,ctx){return own(a)||ctx.subject||a;}
function supportRecordVisible(record,actor,ctx,ticket){
 const subject=ctx.subject||actor;
 if(actor==='manager')return record.severe===true;
 if(actor==='support')return (ticket||record.human===true)&&(!record.assignee||record.assignee===subject);
 return record.owner===supportOwner(actor,ctx);
}
function supportAttachmentIds(value){
 if(value===undefined)return [];
 const fileId=/^file-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
 const valid=Array.isArray(value)&&value.length<=3&&
  value.every(id=>typeof id==='string'&&fileId.test(id))&&new Set(value).size===value.length;
 check(valid,'INPUT','工单最多可添加 3 张不同的图片');
 return value;
}
function supportCommand(s,a,c,p,ctx){const owner=supportOwner(a,ctx);let r;if(c==='support.management')role(a,['manager']);
 if(c==='support.settings'){role(a,['manager']);check(p.sla&&['complaint','aftersale','exception'].every(k=>p.sla[k]===null||Number.isInteger(p.sla[k])&&p.sla[k]>0&&p.sla[k]<=10080),'INPUT','SLA须为空或1—10080分钟');s.supportSettings={hours:txt(p.hours,'客服时间'),sla:clone(p.sla),phone:Object.hasOwn(p,'phone')?(p.phone===null?null:txt(p.phone,'客服电话')):s.supportSettings?.phone||null};return {id:'support-settings',status:'configured',...s.supportSettings};}
 if(c==='support.chat'){role(a,['partnerA','partnerB','public']);const channel=p.channel||'miniprogram';check(['wechat','miniprogram','phone'].includes(channel),'INPUT','来源渠道无效');r=p.id?get(s,'supportChats',p.id):{...entity(s,'chat',null,'bot'),owner,channel,human:false,messages:[]};check(r.owner===owner,'FORBIDDEN','无权查看咨询',403);check(r.status!=='closed','TRANSITION','咨询已关闭，请新建咨询，历史记录保持不变',409);r.messages.push({actor:a,text:txt(p.text,'咨询内容'),at:now()});if(!r.human)r.messages.push({actor:'faq',text:operations.faqAnswer(s,p.text),at:now()});if(!p.id)s.supportChats.push(r);return r;}
 if(c==='support.ticket'){
  role(a,['partnerA','partnerB','public','support']);
  const attachmentIds=supportAttachmentIds(p.attachmentIds);
  check(p.customerType==null||['consumer','partner'].includes(p.customerType),'INPUT','客户类型无效');
  const customerType=a==='support'?p.customerType||'consumer':own(a)?'partner':'consumer';
  check(!p.customerType||p.customerType===customerType,'FORBIDDEN','客户类型与当前身份不符',403);
  check(['complaint','aftersale','exception'].includes(p.category),'INPUT','普通咨询不自动创建工单');
  const o=outlet(s,p.outlet,a);
  if(p.linkedTicketId){
   const old=s.supportTickets.find(item=>item.id===p.linkedTicketId);
   check(old&&supportRecordVisible(old,a,ctx,true)&&old.status==='closed','FORBIDDEN','只能关联有权查看的已关闭工单',403);
   check(old.outlet===o.id,'INPUT','请使用原工单涉及的网点重新提交');
  }
  const channel=p.channel||'miniprogram';
  check(['wechat','miniprogram','phone'].includes(channel),'INPUT','渠道无效');
  const ticketOwner=a==='support'?(customerType==='partner'?o.owner:'phone-visitor-'+randomUUID()):owner;
  r={...entity(s,'ticket',o,'queued'),owner:ticketOwner,customerType,registeredBy:a==='support'?ctx.subject||a:null,
   storeOwner:o.owner,category:p.category,title:txt(p.title,'标题'),description:txt(p.description,'问题详情'),
   contact:p.contact?txt(p.contact,'联系方式'):null,channel,assignee:null,messages:[],collaborations:[],
   severe:false,linkedTicketId:p.linkedTicketId||null,rating:null,trail:[],...(attachmentIds.length?{attachmentIds}:{})};
  s.supportTickets.push(r);
  if(customerType==='consumer'&&r.category==='complaint'){
   notice(s,{...r,owner:o.owner},'消费者投诉待协助核实','support','总部客服负责处理；通知不包含消费者联系方式和原始描述',{ticketId:r.id});
  }
  return r;
 }
 const ticket=s.supportTickets.find(x=>x.id===p.id);
 r=ticket||s.supportChats.find(x=>x.id===p.id);check(r,'NOT_FOUND','客服记录不存在',404);check(supportRecordVisible(r,a,ctx,!!ticket),'FORBIDDEN','无权访问客服记录',403);
 if(c==='support.ack'){check(r.owner===owner,'FORBIDDEN','仅本人可确认客服回复',403);r.replyAcknowledgedAt=now();r.replyAcknowledgedCount=r.messages.length;return r;}
 if(c==='support.human'){check(r.owner===owner&&s.supportChats.includes(r),'FORBIDDEN','仅本人咨询可转人工',403);check(r.status!=='closed','TRANSITION','已关闭咨询须新建会话',409);if(r.human)return r;r.human=true;r.status='queued';return r;}
 if(c==='support.claim'){role(a,['support']);check(r.status==='queued'&&!r.assignee,'TRANSITION','该记录已接单',409);r.assignee=ctx.subject||a;r.human=true;r.status='active';trail(r,a,c,'接单');return r;}
 if(c==='support.supplement'){check(r.owner===owner&&r.status==='waiting','TRANSITION','当前不需要补充',409);r.messages.push({actor:a,text:txt(p.text,'补充内容'),at:now()});r.status='active';return r;}
 if(c==='support.rate'){check(r.owner===owner&&r.status==='closed'&&r.assignee&&!r.rating,'TRANSITION','只能对已完成人工服务评价一次',409);check(Number.isInteger(p.rating)&&p.rating>=1&&p.rating<=5,'INPUT','评价为1—5分');r.rating={score:p.rating,comment:p.comment?txt(p.comment,'评价',false):'',at:now()};return r;}
 role(a,['support','manager']);check(r.assignee&&r.status!=='closed','TRANSITION','需由总部客服接单且尚未关闭',409);if(a==='support')check(r.assignee===(ctx.subject||a),'FORBIDDEN','工单由另一客服人员负责',403);if(a==='manager')check(r.severe,'FORBIDDEN','高级管理仅处理升级工单',403);
 if(c==='support.management'){
  const note=txt(p.note,'内部处理结论'),reply=p.customerReply==null?'':txt(p.customerReply,'用户可见回复',false);
  r.managementHandled=true;
  trail(r,a,c,note);
  if(!reply)return r;
  p={...p,text:reply};
  c='support.reply';
 }
 if(c==='support.reply'){r.messages.push({actor:a,text:txt(p.text,'回复'),at:now()});if(a==='manager')r.managementHandled=true;r.status=p.requestSupplement?'waiting':'active';r.firstResponseAt||=now();notice(s,r,'总部客服已回复','support','请查看客服记录',{ticketId:r.id});}
 else if(c==='support.collaborate'){r.collaborations||=[];r.collaborations.push({department:txt(p.department,'协作部门'),note:txt(p.note,'协作事项'),at:now(),actor:a});}
 else if(c==='support.escalate'){r.severe=true;trail(r,a,c,txt(p.reason,'升级原因'));}
 else if(c==='support.close'){check(!r.severe||r.managementHandled,'TRANSITION','严重投诉须高级管理人员先处理',409);r.status='closed';r.closedAt=now();trail(r,a,c,txt(p.note,'处理结果'));notice(s,r,ticket?'客服工单已完成，可评价或关联新工单':'人工咨询已结束','support','',{ticketId:r.id});}
 else fail('UNKNOWN_COMMAND','未知客服命令');return r;
}
function execute(state,a,command,p={},ctx={}){check(!ctx.now||typeof ctx.now==='string'&&Number.isFinite(Date.parse(ctx.now)),'INPUT','执行时间无效');if(ctx.now&&!ctx.today)ctx={...ctx,today:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ctx.now))};return executionClock.run(ctx,()=>executeInner(state,a,command,p,ctx));}
function executeInner(state,a,command,p={},ctx={}){check(ACTORS.includes(a)||own(a),'FORBIDDEN','身份无效',403);check(p&&typeof p==='object'&&!Array.isArray(p),'INPUT','参数无效');const s=operations.ensure(clone(state)),owner=own(a);operations.context(s,a,ctx);if(ctx.today)s.today=date(ctx.today);const grants=operations.scopedGrants(s,a,ctx);if(owner)check(s.accounts.find(x=>x.owner===owner)?.status==='active','ACCOUNT','账号不可用',403);let r;
 if(['ops','finance','location','support','regional'].includes(a))
  check(!taskRouting.hasAssignedAction(s,command,p,ctx.subject||a),'FORBIDDEN','该业务已分派给其他办理人',403);
 if(operations.COMMANDS.has(command))r=operations.execute(s,a,command,p,ctx);else if(command.startsWith('support.'))r=supportCommand(s,a,command,p,ctx);else switch(command){
 case 'report.draft':case 'report.submit':{const o=outlet(s,p.outlet,a,true),m=month(p.month),block=reportMonthBlock(s,o,m);if(block)fail(block.code,block.message,block.status);const all=s.reports.filter(x=>x.outlet===o.id&&x.month===m),old=current(s,o.id,m),v=values(p,o,m,command==='report.draft',s.drafts.find(x=>x.outlet===o.id&&x.month===m));check(!all.some(x=>['pending','finance'].includes(x.status)),'DUPLICATE','已有待审核版本',409);check(!old||old.correctionAllowed,'CONFLICT','请先申请更正有效版本',409);
 if(command==='report.draft'){r=s.drafts.find(x=>x.outlet===o.id&&x.month===m);if(!r){r={...entity(s,'draft',o,'draft'),month:m};s.drafts.push(r);}Object.assign(r,v);break;}
 if(old?.correctionType==='field')check([...METRICS,'note'].every(k=>old.correctionFields.includes(k)||v[k]===old[k]),'CORRECTION_SCOPE','单字段更正不能修改声明范围外的字段',409);
 const latest=all.slice().sort((a,b)=>b.version-a.version)[0];check(latest?.status!=='returned'||[...METRICS,'note'].some(k=>v[k]!==latest[k]),'UNCHANGED','请按退回意见改值或补充经营说明',409);r={...entity(s,'rpt',o),month:m,version:Math.max(0,...all.map(x=>x.version))+1,...v,current:false,...operations.reportTiming(s,m),correctionOf:old?.id||null,correctionType:old?.correctionType||null,correctionFields:old?.correctionFields||[],correctionDiff:old?Object.fromEntries([...METRICS,'note'].filter(k=>v[k]!==old[k]).map(k=>[k,{before:old[k],after:v[k]}])):{},trail:[]};s.reports.push(r);s.drafts=s.drafts.filter(x=>!(x.outlet===o.id&&x.month===m));trail(r,a,command,old?.correctionReason);notice(s,r,'月报已提交');break;}
 case 'report.correct':{r=get(s,'reports',p.id);const o=outlet(s,r.outlet,a,true),block=reportMonthBlock(s,o,r.month);if(block)fail(block.code,block.message,block.status);check(r.current&&r.status==='approved'&&!r.correctionAllowed,'TRANSITION','当前报表不可发起重复更正',409);r.correctionReason=txt(p.reason,'原因');r.correctionType=p.correctionType||'full';check(['field','full'].includes(r.correctionType),'INPUT','请选择单字段更正或整份月报更正。');r.correctionFields=p.fields||[];check(Array.isArray(r.correctionFields)&&r.correctionFields.every(k=>[...METRICS,'note'].includes(k))&&(r.correctionType!=='field'||r.correctionFields.length===1),'INPUT','单字段更正须明确一个字段');r.correctionAllowed=true;trail(r,a,command,p.reason);break;}
 case 'report.revoke.request':{role(a,['manager']);const source=get(s,'reports',p.id);check(source.current&&source.status==='approved','TRANSITION','仅当前有效报表可发起误审批撤销',409);check(!s.requests.some(x=>x.type==='reportRevoke'&&x.data.reportId===source.id&&x.status==='pending'),'DUPLICATE','该报表已有待复核撤销申请',409);r={...entity(s,'req',outlet(s,source.outlet,a)),type:'reportRevoke',data:{reportId:source.id,month:source.month,version:source.version,reason:txt(p.reason,'误审批原因'),originalValues:Object.fromEntries(METRICS.map(k=>[k,source[k]]))},initiator:a,trail:[],policy:'高级管理发起、财务复核为开发执行路径；正式独立复核制度待集团确认'};s.requests.push(r);trail(r,a,command,p.reason);notice(s,r,'总部已发起撤销复核','reports','复核完成前，当前月报仍有效。',{reportId:source.id,month:source.month});break;}
 case 'review.revoke':{role(a,['finance']);r=get(s,'requests',p.id);check(r.type==='reportRevoke'&&r.status==='pending','TRANSITION','无待复核撤销申请',409);check(['approve','return'].includes(p.decision),'INPUT','审批动作无效');const source=get(s,'reports',r.data.reportId);check(current(s,r.outlet,r.data.month)?.id===source.id,'CONFLICT','当前有效版本已变化，请重新发起核实',409);check(!s.reports.some(x=>x.correctionOf===source.id&&['pending','finance'].includes(x.status)),'CONFLICT','存在待审更正版本，请先完成版本核实',409);const note=p.decision==='return'?txt(p.note,'退回原因'):p.note||'财务复核通过';r.status=p.decision==='approve'?'approved':'returned';r.reviewNote=note;r.reviewRole=a;setPublicNote(r,p.publicNote,check);if(p.decision==='approve'){source.current=false;source.revoked=true;source.correctionAllowed=false;source.revocationRequestId=r.id;source.revokedAt=now();trail(source,a,'report.revoked',r.data.reason);invalidate(s,source,{kind:'report_revoked',eventId:r.id,previousReportId:source.id,reportId:null},a,ctx);s.summaryAdjustments.filter(x=>x.sourceReportId===source.id).forEach(x=>x.status='needsReview');}trail(r,a,command,note);notice(s,r,p.decision==='approve'?'总部已撤销月报审批':'总部保留原有效月报','reports',p.decision==='approve'?'该版本已撤销。打开月报查看详情。':'撤销申请已退回。打开月报查看详情。',{reportId:source.id,month:source.month,requestOutcome:{status:r.status,publicNote:r.publicNote}});break;}
 case 'review.report':{r=get(s,'reports',p.id);if(r.status==='finance')role(a,['finance']);else {check(r.status==='pending','TRANSITION','已处理',409);if(a==='regional')check(grants.reviewOutlets.includes(r.outlet)&&grants.outlets.includes(r.outlet),'FORBIDDEN','无此网点审核授权',403);else role(a,['ops','manager']);}check(['approve','return'].includes(p.decision),'INPUT','审批动作无效');const note=p.decision==='return'?txt(p.note,'退回原因'):p.note||'审核通过';if(p.decision==='return')r.status='returned';else {const old=r.correctionOf?get(s,'reports',r.correctionOf):null;if(old&&old.revenue!==r.revenue&&r.status!=='finance')r.status='finance';else{r.status='approved';r.current=true;if(old){old.current=false;old.correctionAllowed=false;old.supersededBy=r.id;s.summaryAdjustments.filter(x=>x.outlet===r.outlet&&x.month===r.month).forEach(x=>x.status='needsReview');}invalidate(s,r,{kind:old?'report_corrected':'report_approved',eventId:r.id,previousReportId:old?.id||null,reportId:r.id},a,ctx);}}r.reviewNote=note;trail(r,a,command,note);notice(s,r,r.status==='finance'?'财务复核中':r.status==='returned'?'月报退回':'月报批准，待结算','reports',r.status==='returned'?note:'');break;}
 case 'request.submit':{check(owner,'FORBIDDEN','仅加盟商可提交申请',403);const o=p.type==='newOutlet'?{id:null,owner}:outlet(s,p.outlet,a,true),data=requestData(p.type,p.data,s);check(!s.requests.some(x=>x.owner===owner&&x.outlet===o.id&&x.type===p.type&&['pending','supplement'].includes(x.status)&&(p.type!=='newOutlet'||x.data.name===data.name)),'DUPLICATE','已有处理中同类申请',409);r={...entity(s,'req',o),type:p.type,data,trail:[]};
 if(p.type==='accountChange'){
  const account=s.accounts.find(x=>x.owner===owner);
  check(account,'NOT_FOUND','负责人账号不存在',404);
  if(data.change==='mobile')check(data.mobile!==account.mobile,'UNCHANGED','请输入新的登记手机号');
  r.expectedBindingVersion=account.bindingVersion??0;
 }
 s.requests.push(r);trail(r,a,command,data.reason);notice(s,r,'申请已提交','requests');break;}
 case 'request.supplement':{
  r=get(s,'requests',p.id);
  check(r.owner===owner&&r.type!=='reportRevoke','FORBIDDEN','该申请不能由加盟商补件',403);
  check(['supplement','returned'].includes(r.status),'TRANSITION','无需补件',409);
  const note=txt(p.note,'补充说明'),before=clone(r.data);
  if(p.data||before.locationStatus==='exception'){
   if(r.type==='accountChange'&&p.data?.change!==undefined)check(p.data.change===(before.change||'manager'),'INPUT','补充资料不能改变账号变更类型');
   const next=requestData(r.type,{...before,...p.data},s);
   const sameLocation=before.locationStatus==='approved'&&next.locationStatus==='pending'
    &&['province','city','district','address'].every(key=>before[key]===next[key])
    &&isDeepStrictEqual(before.coords,next.coords)&&before.photo?.id===next.photo?.id;
   if(sameLocation){
    next.locationStatus='approved';
    next.locationReviewedBy=before.locationReviewedBy;
    next.locationReviewedAt=before.locationReviewedAt;
   }
   r.data=next;
  }
  r.status='pending';delete r.publicNote;trail(r,a,command,note,before);break;
 }
 case 'review.request':{r=get(s,'requests',p.id);check(r.type!=='reportRevoke','INPUT','误审批撤销须使用财务复核专用入口');role(a,r.type==='accountChange'?['manager']:['pauseFee','exemptException'].includes(r.type)?['manager','finance']:['manager','ops']);check(r.status==='pending','TRANSITION','申请已处理',409);check(['approve','return','supplement'].includes(p.decision),'INPUT','审批动作无效');const d=r.data,note=p.decision==='approve'?p.note||'审核通过':txt(p.note,'原因');if(p.decision==='approve'){
 if(['newOutlet','locationChange'].includes(r.type))check(d.locationStatus==='approved','LOCATION_REVIEW','请位置核验专员先核验',409);
 if(r.type==='newOutlet'){const o={...entity(s,'out',{id:null,owner:r.owner},'preparing'),name:d.name,...administrativeArea(d,txt),address:d.address,phone:d.phone,opening:d.opening,coords:d.coords,confirmedLocation:d.coords.coordinateSystem==='GCJ-02'?{coords:d.coords,confirmedBy:d.locationReviewedBy,confirmedAt:d.locationReviewedAt,reference:r.id}:null,enrollmentApplicable:null,enrollmentStatus:'pending',enrollmentHistory:[],agreementEnd:null,serviceUntil:null,events:[{date:s.today,status:'preparing',actor:a,reason:'申请批准'}],locationHistory:[]};o.outlet=o.id;s.outlets.push(o);d.createdOutletId=o.id;}
 else if(r.type==='pauseFee')s.adjustments.push({...entity(s,'adj',outlet(s,r.outlet,a),'待财务核算调整'),requestId:r.id,from:d.from,to:d.to,amount:null,offsetMonth:null,serviceUntil:null});
 else if(r.type==='locationChange'){const o=outlet(s,r.outlet,a);o.locationHistory.push({before:{coords:o.coords,address:o.address},after:{coords:d.coords,address:d.address},requestId:r.id,actor:a,at:now()});o.coords=d.coords;o.address=d.address;o.confirmedLocation=d.coords.coordinateSystem==='GCJ-02'?{coords:d.coords,confirmedBy:d.locationReviewedBy,confirmedAt:d.locationReviewedAt,reference:r.id}:null;}
 else if(r.type==='accountChange'){
  const account=s.accounts.find(x=>x.owner===r.owner);
  check(account,'NOT_FOUND','负责人账号不存在',404);
  check(r.expectedBindingVersion==null||r.expectedBindingVersion===(account.bindingVersion??0),'CONFLICT','账号登记信息已更新，请退回此申请并通知负责人重新提交',409);
  const mobileOnly=d.change==='mobile';
  const changed=operations.changeIdentity(s,account,{...d,managerName:mobileOnly?account.managerName:d.managerName},a,ctx,r.id);
  r.identityChanged=changed;
  r.outcome=!changed?'账号登记信息未变化。':mobileOnly?'登记手机号已更新，原登录权限已撤销；请重新激活账号。':'负责人绑定已更新，旧认证已撤销；新负责人须重新激活';
 }
 else if(r.type==='statusChange')setStatus(s,a,{...d,outlet:r.outlet});else {r.policyPending=true;r.outcome='待集团确认生效规则；原数据未改变';}}
 r.status=p.decision==='approve'?'approved':p.decision==='return'?'returned':'supplement';r.reviewNote=note;r.reviewRole=a;setPublicNote(r,p.publicNote,check);trail(r,a,command,note);notice(s,r,'业务申请处理进度已更新','requests','',{requestOutcome:{status:r.status,publicNote:r.publicNote}});break;}
 case 'outlet.status':role(a,['manager','ops']);r=setStatus(s,a,p);notice(s,r,'网点状态已更新','outlets');break;
 case 'report.exempt':{role(a,['manager','ops']);const o=outlet(s,p.outlet,a),m=month(p.month);check(operations.reportMonthStatus(s,o,m)==='full_pause','CONFLICT','须完整历史自然月暂停',409);check(!s.reports.some(x=>x.outlet===o.id&&x.month===m)&&!s.exemptions.some(x=>x.outlet===o.id&&x.month===m),'CONFLICT','已有月报或免报',409);r={...entity(s,'exempt',o,'approved'),month:m,reason:txt(p.reason,'原因'),trail:[]};trail(r,a,command,p.reason);s.exemptions.push(r);notice(s,r,'本月已免报','reports','',{month:r.month});break;}
 case 'location.submit':{const o=outlet(s,p.outlet,a,true),m=month(p.month),old=s.verifications.filter(x=>x.outlet===o.id&&x.month===m).at(-1);check(m<=s.today.slice(0,7),'INPUT','不能核验未来月份');check(!old||old.status==='exception','DUPLICATE','本月已有核验',409);r={...entity(s,'loc',o),month:m,coords:coord(p.coords),address:txt(p.address,'地址'),photo:photo(p.photo),explanation:old?txt(p.explanation,'异常解释'):p.explanation||'',previousId:old?.id||null,trail:[]};if(p.capturedAt!==undefined)check(typeof p.capturedAt==='string'&&Number.isFinite(Date.parse(p.capturedAt))&&Date.parse(p.capturedAt)<=Date.parse(now()),'INPUT','采集时间无效或晚于提交时间');r.capturedAt=p.capturedAt||null;r.submittedBy=ctx.subject||a;r.submittedAt=now();r.assessment=operations.locationAssessment(s,o,r.coords,ctx);if(r.assessment.result==='outside_threshold')r.status='exception';s.verifications.push(r);notice(s,r,r.status==='exception'?'位置待核实，请补充说明':'已提交，等待总部核验','location','',{month:r.month,verificationOutcome:{status:r.status}});break;}
 case 'location.review':{role(a,['location']);r=s.verifications.find(x=>x.id===p.id)||s.requests.find(x=>x.id===p.id&&['newOutlet','locationChange'].includes(x.type));check(r,'NOT_FOUND','无核验资料',404);check((r.data?r.data.locationStatus:r.status)==='pending','TRANSITION','已核验',409);check(['approve','exception'].includes(p.decision),'INPUT','核验动作无效');if(!r.data&&p.decision==='approve')check(r.coords.source==='gps','GPS_REQUIRED','月度现场核验须提供真实GPS，手工坐标不能替代',409);const status=p.decision==='approve'?'approved':'exception',note=p.decision==='exception'?txt(p.note,'异常说明'):p.note||'核验通过';if(r.data){r.data.locationStatus=status;r.data.locationReviewedBy=ctx.subject||a;r.data.locationReviewedAt=now();if(status==='exception')r.status='supplement';r.reviewRole=a;r.reviewNote=note;setPublicNote(r,p.publicNote,check);}else {r.status=status;setPublicNote(r,p.publicNote,check,'用户可见说明');}trail(r,a,command,note);if(r.data)notice(s,r,status==='approved'?'位置核验通过':'位置异常，请解释补件','location','',{requestOutcome:{status:r.status,publicNote:r.publicNote}});else notice(s,r,status==='approved'?'位置已核验':'位置待核实，请补充说明','location','',{month:r.month,verificationOutcome:{status,publicNote:r.publicNote}});break;}
 case 'payment.start':{const b=get(s,'bills',p.billId),o=outlet(s,b.outlet,a,true);check(b.status==='unpaid','CONFLICT','账单已付',409);check(!s.adjustments.some(x=>x.outlet===o.id&&x.status==='待财务核算调整'&&x.from.slice(0,7)<=b.month&&x.to.slice(0,7)>=b.month),'CONFLICT','存在待财务核算调整',409);check(!s.payments.some(x=>x.billId===b.id&&x.status==='pending'&&x.adapterMode!=='mock'),'CONFLICT','存在真实在途付款，请先查询支付状态',409);r=s.payments.find(x=>x.billId===b.id&&x.status==='pending'&&x.adapterMode==='mock');if(!r){r={...entity(s,'pay',o),billId:b.id,month:b.month,amount:b.amount,adapterMode:'mock'};s.payments.push(r);}break;}
 case 'payment.resolve':{r=get(s,'payments',p.id);check(r.adapterMode==='mock','FORBIDDEN','真实支付结果仅由支付服务核验',403);outlet(s,r.outlet,a,true);const b=get(s,'bills',r.billId);check(['success','stale','failed','cancelled'].includes(p.outcome),'INPUT','支付结果无效');check(r.amount===b.amount,'CONFLICT','金额不一致',409);if(r.status==='success'){check(['success','stale'].includes(p.outcome),'TRANSITION','成功付款不可改失败',409);break;}check(r.status==='pending','TRANSITION','支付尝试已结束',409);r.status=['success','stale'].includes(p.outcome)?'success':p.outcome;r.uiStale=p.outcome==='stale';r.resolvedAt=now();if(r.status==='success'){check(!s.receipts.some(x=>x.billId===b.id),'DUPLICATE','账单已有实收',409);b.status='paid';s.receipts.push({...entity(s,'receipt',outlet(s,b.outlet,a),'success'),paymentId:r.id,billId:b.id,amount:r.amount,adapterMode:'mock'});notice(s,r,'模拟付款已确认','fees','',{billId:b.id,paymentId:r.id});}break;}
 case 'grant.set':role(a,['manager']);check(Array.isArray(p.outlets)&&Array.isArray(p.metrics)&&Array.isArray(p.reviewOutlets)&&p.outlets.every(id=>s.outlets.some(x=>x.id===id))&&p.metrics.every(k=>METRICS.includes(k))&&p.reviewOutlets.every(id=>p.outlets.includes(id)),'INPUT','授权范围无效');r={id:'regional',status:'configured',before:clone(s.grants)};s.grants={outlets:[...new Set(p.outlets)],metrics:[...new Set(p.metrics)],reviewOutlets:[...new Set(p.reviewOutlets)]};Object.assign(r,s.grants);break;
 case 'account.update':{role(a,['manager']);r=s.accounts.find(x=>x.owner===p.owner);check(r,'NOT_FOUND','账号不存在',404);check(['pending','active','locked','frozen','disabled'].includes(p.status),'INPUT','账号状态无效');const before=clean(clone(r));const identityChanged=operations.changeIdentity(s,r,{managerName:p.managerName??r.managerName,mobile:p.mobile??r.mobile},a,ctx);if(!identityChanged){r.status=p.status;r.bindingVersion++;}trail(r,a,command,txt(p.reason,'核实原因'),{status:before.status,managerName:before.managerName,mobile:before.mobile});break;}
 case 'account.create':{role(a,['manager']);const name=txt(p.name,'加盟商名称'),managerName=txt(p.managerName,'负责人');check(/^1\d{10}$/.test(p.mobile),'INPUT','手机号无效');check(!s.accounts.some(x=>x.mobile===p.mobile),'DUPLICATE','手机号已绑定负责人账号',409);const owner='p-'+randomUUID();s.organizations.push({id:owner,outlet:null,owner,status:'active',createdAt:now(),name});r={...entity(s,'acc',null,'active'),owner,actor:'partner:'+owner,managerName,mobile:p.mobile,bindingVersion:1,trail:[]};s.accounts.push(r);trail(r,a,command,'总部创建开发加盟商账号；正式身份核验待真实认证接入');break;}
 case 'settle':{role(a,['manager']);const m=month(p.month);check(m<s.today.slice(0,7),'INPUT','自然月未结束');check(p.taskId===undefined||typeof p.taskId==='string'&&p.taskId.length>0&&p.taskId.length<=120,'INPUT','重结算待办编号无效');r=settlements.settle(s,m,p.taskId,ctx,{now:now(),check,make:()=>entity(s,'set',null,'approved'),coverage:operations.coverage,effective,notify:(o,snapshot,included)=>notice(s,{id:snapshot.id,outlet:o.id,owner:o.owner},m+' 月经营报表已重新结算','reports',included?'请查看本人网点的最新已结算数据。':'本人网点本期暂无有效月报，结算结果保持缺失。',{month:m,settlementId:snapshot.id})});break;}
 case 'summary.adjust':{role(a,['manager']);const o=outlet(s,p.outlet,a),m=month(p.month),source=current(s,o.id,m),keys=Object.keys(p.values||{});check(source&&keys.length&&keys.every(k=>METRICS.includes(k)),'INPUT','须有效源报表与合法调整字段');check(!s.summaryAdjustments.some(x=>x.outlet===o.id&&x.month===m&&['pending','finance'].includes(x.status)),'DUPLICATE','已有待复核调整',409);const before=effective(s,source),v={};keys.forEach(k=>{check(k!=='enroll'||source.enroll!==null,'INPUT','招生不适用不能改值');v[k]=num(p.values[k],k==='revenue');});r={...entity(s,'sadj',o,keys.includes('revenue')?'finance':'pending'),month:m,sourceReportId:source.id,before,values:v,reason:txt(p.reason,'原因'),trail:[],initiator:a,policy:'非收入复核岗位仅开发流程，正式制度待确认'};s.summaryAdjustments.push(r);trail(r,a,command,p.reason,before);break;}
 case 'review.adjust':{r=get(s,'summaryAdjustments',p.id);check(['pending','finance'].includes(r.status),'TRANSITION','调整已处理',409);role(a,r.status==='finance'?['finance']:['ops','manager']);check(['approve','return'].includes(p.decision),'INPUT','审批动作无效');check(current(s,r.outlet,r.month)?.id===r.sourceReportId,'CONFLICT','原始版本已变化',409);r.status=p.decision==='approve'?'approved':'returned';trail(r,a,command,p.decision==='return'?txt(p.note,'退回原因'):p.note);if(r.status==='approved'){const source=get(s,'reports',r.sourceReportId);invalidate(s,source,{kind:'summary_adjusted',eventId:r.id,previousReportId:source.id,reportId:source.id},a,ctx);}break;}
 case 'message.read':r=get(s,'messages',p.id);check(view(s,a,ctx).messages.some(x=>x.id===r.id),'FORBIDDEN','无权读取',403);r.read=true;r.status='read';break;
 case 'content.update':{role(a,['manager']);const key=p.key||'brand';check(['brand','services','news','cases','cooperation'].includes(key),'INPUT','内容栏目无效');r=operations.saveContent(s,a,p,ctx,key);trail(r,a,command,p.reason);break;}
 default:fail('UNKNOWN_COMMAND','命令未支持，未执行任何业务动作');}
 const repeatedHandoff=command==='support.human'&&state.supportChats.some(chat=>chat.id===r.id&&chat.human);
 if(command!=='message.read'&&command!=='routing.set'&&!command.startsWith('task.')&&!repeatedHandoff)operations.reconcile(s,ctx,{openBills:['billing.generate','billing.correct.review'].includes(command)});
 s.audit.push({...entity(s,'audit',{id:r?.outlet,owner:r?.owner},'completed'),actor:a,subject:ctx.subject||a,command,recordId:r?.id||null,executedAt:now(),requestId:ctx.requestId||null,reason:safeNote(p.reason||p.note||''),...(repeatedHandoff?{outcome:'no_change'}:{})});return {state:s,result:clone(r)};
}
function view(s,a,ctx={}){operations.context(s,a,ctx);const grants=operations.scopedGrants(s,a,ctx);const owner=own(a),hq=['ops','manager','finance','location'].includes(a),business=['ops','manager','finance'].includes(a),v={schemaVersion:3,today:s.today,mode:s.mode,capabilities:{export:!!owner||a==='manager',ranking:a==='manager'},grants:{outlets:[],metrics:[],reviewOutlets:[]},locationTasks:[],support:{chats:[],tickets:[],settings:clone(s.supportSettings)}};COLLECTIONS.forEach(k=>{if(!k.startsWith('support'))v[k]=[];});const os=s.outlets.filter(o=>owner?o.owner===owner:a==='regional'?grants.outlets.includes(o.id):a==='public'?o.status!=='closed':true),ids=new Set(os.map(o=>o.id)),scope=x=>owner?x.owner===owner:ids.has(x.outlet);
 const publicProfiles=a==='public'?new Map(s.publicProfiles.filter(profile=>profile.status==='published').map(profile=>[profile.outlet,profile])):null;
 v.outlets=os.filter(o=>!publicProfiles||s.mode!=='production'||publicProfiles.has(o.id)).map(o=>{if(hq||owner)return clone(o);if(publicProfiles)return operations.publicOutlet(o,publicProfiles.get(o.id));const common={id:o.id,outlet:o.id,name:o.name,status:o.status,province:o.province,city:o.city,district:o.district};return a==='support'?common:{...common,address:o.address,phone:o.phone,publicMarker:{city:o.city,label:'城市级示意标记'}};});
 if(owner||business||a==='regional'){const rs=s.reports.filter(scope);v.reports=rs.map(r=>{if(business){const row=clone(r);if(a==='finance'&&r.status!=='finance'&&!r.correctionDiff?.revenue&&!r.revocationRequestId&&!r.trail?.some(entry=>entry.actor==='finance'))delete row.trail;return row;}const x={id:r.id,outlet:r.outlet,owner:r.owner,month:r.month,version:r.version,status:r.status,current:r.current,revoked:!!r.revoked,late:r.late,dueOn:r.dueOn||null,policyId:r.policyId||null,createdAt:r.createdAt};if(a==='regional'){grants.metrics.forEach(k=>x[k]=r[k]);return x;}const latest=rs.filter(x=>x.outlet===r.outlet&&x.month===r.month).sort((a,b)=>b.version-a.version)[0];if(r.current||r.id===latest.id)Object.assign(x,{...Object.fromEntries([...METRICS,'note','correctionAllowed','correctionType','correctionFields','correctionDiff','enrollmentStatus'].map(k=>[k,r[k]])),reviewNote:r.status==='returned'?r.reviewNote:undefined});else x.summaryOnly=true;return x;});v.exemptions=s.exemptions.filter(scope).map(x=>{const y=clone(x);if(owner||a==='regional')delete y.trail;return y;});
  const reportIds=new Set(rs.map(r=>r.id));
  v.settlements=s.settlements.flatMap(x=>{
   if(a==='manager')return [clone(x)];
   const visibleReports=x.reportIds.filter(id=>reportIds.has(id));
   const affected=(x.affectedOutletIds||[]).filter(id=>ids.has(id));
   if(!visibleReports.length&&!affected.length&&!business)return [];
   const {id,month,status,createdAt,invalidatedAt,version}=x;
   return [{id,month,status,createdAt,invalidatedAt,version,reportIds:visibleReports,...(affected.length?{affectedOutletIds:affected}:{})}];
  });
 }
 if(owner||business){for(const k of ['bills','payments','receipts','adjustments','drafts'])if(a!=='ops'||!['payments','receipts'].includes(k))v[k]=clone(s[k].filter(scope));v.summaryAdjustments=s.summaryAdjustments.filter(scope).map(x=>{const y=clone(x);if(owner){delete y.trail;delete y.initiator;}return y;});}
 if(owner||hq){v.requests=s.requests.filter(x=>owner?x.owner===owner:a==='location'?['newOutlet','locationChange'].includes(x.type):a==='finance'?['pauseFee','exemptException','reportRevoke'].includes(x.type):a==='ops'?x.type!=='accountChange':true).map(x=>projectRequest(x,a,owner));v.verifications=s.verifications.filter(scope).map(x=>{const y=clone(x);if(owner){delete y.trail;delete y.review;delete y.reviewNote;delete y.internalReviewNote;}return y;});v.locationTasks=os.filter(o=>['open','paused'].includes(o.status)).map(o=>{const latest=s.verifications.filter(x=>x.outlet===o.id&&x.month===s.today.slice(0,7)).at(-1);return {id:'location-'+o.id,outlet:o.id,owner:o.owner,month:s.today.slice(0,7),status:latest?.status||'missing',recordId:latest?.id||null,deadline:null};}).filter(x=>x.status!=='approved');}
 if(owner||a==='manager'){v.accounts=s.accounts.filter(x=>!owner||x.owner===owner).map(x=>{const y=clean(clone(x));if(owner)delete y.trail;return y;});v.organizations=clone(s.organizations.filter(x=>!owner||x.id===owner));}
 if(['ops','finance'].includes(a))v.organizations=s.organizations.filter(x=>os.some(o=>o.owner===x.id)).map(x=>({id:x.id,name:x.name,owner:x.owner,status:x.status}));
 if(['ops','finance'].includes(a)){for(const o of v.outlets){delete o.coords;delete o.confirmedLocation;delete o.locationHistory;}v.verifications=[];v.locationTasks=[];}
 if(a==='manager'||a==='regional')v.grants=clone(grants);if(a==='manager')v.audit=s.audit.map(row=>({...clone(row),...(row.reason===undefined?{}:{reason:safeNote(row.reason)})}));
 const so=supportOwner(a,ctx),staff=['support','manager'].includes(a);const supportCopy=x=>{const y=clone(x);y.messages=y.messages.map(m=>({...m,by:m.actor}));if(!staff){delete y.trail;delete y.contact;delete y.collaborations;}return y;};v.support.chats=s.supportChats.filter(x=>supportRecordVisible(x,a,ctx,false)).map(supportCopy);v.support.tickets=s.supportTickets.filter(x=>supportRecordVisible(x,a,ctx,true)).map(supportCopy);
 const requestById=new Map(s.requests.map(row=>[row.id,row]));
 v.messages=s.messages.filter(x=>owner?x.owner===owner:a==='public'?x.owner===so:a==='manager'?true:a==='ops'?['reports','requests','outlets','cooperation'].includes(x.target)&&!s.requests.some(r=>r.id===x.recordId&&r.type==='accountChange'):a==='finance'?['fees','dashboard'].includes(x.target):a==='location'?x.target==='location':a==='support'?x.target==='support'&&x.owner==='support':false).map(({partnerTaskId,...message})=>requestNotice(owner&&partnerTaskId?{...message,taskId:partnerTaskId}:message,requestById.get(message.recordId)));
 v.contents=a==='manager'?s.contents.map(clone):s.contents.map(operations.publicContent).filter(Boolean);
 return operations.extendView(s,v,a,ctx);
}
function effective(s,r){const v=Object.fromEntries(METRICS.map(k=>[k,r[k]]));s.summaryAdjustments.filter(x=>x.status==='approved'&&x.sourceReportId===r.id).forEach(x=>Object.assign(v,x.values));return v;}
function aggregate(s,a,{period=s.today.slice(0,7),kind='month',outlet:oid='all',owner='all',mode='settled'}={},ctx={}){role(a,['partnerA','partnerB','ops','manager','finance','regional']);month(period);check(['month','quarter','year'].includes(kind)&&['settled','process'].includes(mode),'INPUT','统计模式无效');const v=view(s,a,ctx),ms=a==='regional'?operations.scopedGrants(s,a,ctx).metrics:METRICS;check(oid==='all'||v.outlets.some(x=>x.id===oid),'FORBIDDEN','无网点权限',403);check((owner==='all'||s.organizations.some(x=>x.id===owner))&&(!own(a)||owner==='all'||owner===own(a)),'FORBIDDEN','无主体权限',403);const y=period.slice(0,4),m=+period.slice(5),start=kind==='year'?1:kind==='quarter'?Math.floor((m-1)/3)*3+1:m,n=kind==='year'?12:kind==='quarter'?3:1,months=Array.from({length:n},(_,i)=>y+'-'+String(start+i).padStart(2,'0'));const sum=(xs,k)=>xs.length?(k==='revenue'?xs.reduce((n,x)=>n+Math.round(x*100),0)/100:xs.reduce((n,x)=>n+x,0)):null;
 const rows=v.outlets.filter(o=>(oid==='all'||o.id===oid)&&(owner==='all'||s.outlets.find(x=>x.id===o.id).owner===owner)).map(o=>{const rs=months.map(m=>{const r=current(s,o.id,m);return r&&(mode==='process'||s.settlements.some(x=>x.month===m&&x.status==='approved'&&x.reportIds.includes(r.id)))?r:null;}).filter(Boolean),r={outlet:o.id,owner:s.outlets.find(x=>x.id===o.id).owner,name:o.name,coverage:rs.length,expectedMonths:n,reportingCoverage:operations.coverage(s,[s.outlets.find(x=>x.id===o.id)],months)};ms.forEach(k=>r[k]=sum(rs.map(x=>(mode==='settled'&&s.settlements.find(set=>set.month===x.month&&set.status==='approved'&&set.reportIds.includes(x.id))?.reportValues?.[x.id]?.values||effective(s,x))[k]).filter(x=>x!==null&&x!==undefined),k));return r;});const totals={};ms.forEach(k=>totals[k]=sum(rows.map(r=>r[k]).filter(x=>x!==null&&x!==undefined),k));return {rows,totals,months,kind,period,mode,reportDeadlines:operations.reportDeadlines(s,months),...(a==='manager'?{rankings:operations.rankings(rows)}:{}),reportingCoverage:operations.coverage(s,s.outlets.filter(o=>rows.some(r=>r.outlet===o.id)),months),partial:rows.some(x=>x.coverage<n),methodVersion:'integer-cents-v1'};}
module.exports={ACTORS,METRICS,COLLECTIONS,createState,execute,view,aggregate,current,own,fail,check,clone,clean,supportRecordVisible,supportAttachmentIds,reportMonthBlock};

