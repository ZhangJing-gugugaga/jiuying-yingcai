import {createClient} from './client.js';
import {operations} from './operations.js';
import {readTaskRoute, taskDate, tasks} from './tasks.js';
import {approvalHistory} from './approval-history.js';
import {billingLedger} from './billing-ledger.js';
import {staffLoginUi} from './staff-login.js';
import {trainingDesk} from './training.js';
import {approvalExportUi} from './approval-export.js';
import {onboardingDesk} from './onboarding.js';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={home:'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',store:'M3 9h18l-2-5H5L3 9Zm2 1v10h14V10M9 20v-6h6v6',report:'M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h7',wallet:'M3 6h16v15H3V6Zm1 0V3h13M15 12h6v5h-6z',pin:'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',chat:'M3 4h18v13H8l-5 4V4Zm4 5h10M7 13h6',chart:'M4 20V4M4 20h17M8 16v-5M13 16V7M18 16V3',users:'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-3c0-5 14-5 14 0v3M17 4c5 0 5 8 0 8M19 15c3 0 3 3 3 6',check:'m5 12 4 4L20 5M20 12v8H3V3h12',bell:'M5 16h14l-2-3V8a5 5 0 0 0-10 0v5l-2 3Zm5 4h4',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 5l3 1 4-3 4 3 3-1 1 4-1 3 1 4-4 1-4 4-4-4-4-1 1-4-1-3z',arrow:'M4 12h16m-6-6 6 6-6 6',download:'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',plus:'M12 4v16M4 12h16',logout:'M10 3H3v18h7M8 12h13m-5-5 5 5-5 5',menu:'M3 5h18M3 12h18M3 19h18',audit:'M5 3h14v18H5zM8 7h8M8 12h8M8 17h5'};
const I=k=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[k]||paths.report}"/></svg>`;
const roles={manager:'总部管理层',ops:'总部运营',finance:'财务复核',location:'位置核验专岗',support:'总部客服',regional:'区域运营',partnerA:'加盟商甲负责人',partnerB:'加盟商乙负责人',public:'消费者'};
const routes={tasks:['业务待办','check'],home:['经营总览','home'],stores:['网点管理','store'],reports:['经营月报','report'],requests:['业务审批','check'],locations:['位置核验','pin'],billing:['服务费管理','wallet'],support:['客服中心','chat'],analytics:['经营看板','chart'],accounts:['账号与授权','users'],messages:['消息中心','bell'],content:['公开内容','report'],audit:['操作审计','audit']};
const labels={open:'营业中',paused:'暂停营业',preparing:'筹备中',closed:'已关闭',pending:'待审核',returned:'已退回',finance:'财务复核中',approved:'已通过',paid:'已支付',unpaid:'待支付',success:'支付成功',failed:'失败',cancelled:'已取消',queued:'待接单',processing:'处理中',waiting:'待补充',supplement:'待补充',exception:'异常',active:'正常',frozen:'已冻结',locked:'临时锁定',disabled:'停用',draft:'草稿',published:'已发布',withdrawn:'已撤回',reversed:'已冲正',recorded:'已登记凭证',issued:'已开票',rejected:'已驳回',red_pending:'待冲红',red_issued:'已冲红',in_progress:'办理中',resolved:'已解决',completed:'已完成',preview:'待确认导入',committed:'已导入',submitted:'待受理',received:'已受理',contacted:'已联系'};
const supportStatuses={bot:'常见问题答复',active:'处理中',closed:'已关闭'};
const collectionStatusLabels={
  verifications:{pending:'待核验',approved:'核验通过',exception:'核验异常'},
  'support.tickets':supportStatuses,'support.chats':supportStatuses,
  accounts:{pending:'待激活'},messages:{unread:'未读',read:'已读'},businessTasks:{open:'待办理'},
  bills:{settled_zero:'零金额结清'},payments:{pending:'待确认'},receipts:{success:'已确认实收'},
  adjustments:{applied:'已抵扣'},jobRuns:{running:'运行中',partially_completed:'部分完成'},
};
const reqNames={reportRevoke:'总部误审批纠正 / 撤销',newOutlet:'新增网点',pauseFee:'暂停收费',locationChange:'位置变更',enrollment:'招生适用性调整',statusChange:'营业状态变更',exemptException:'免报财务事项',accountChange:'负责人换绑'};
const metrics={revenue:'营业收入',orders:'有效订单',traffic:'到店客流',enroll:'实际招生'};const units={revenue:'元',orders:'单',traffic:'人次',enroll:'人'};
const fmt=(n,k='')=>n==null?'—':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:k==='revenue'?2:0});
const statusTones={
  open:'good', approved:'good', paid:'good', success:'good', active:'good', issued:'good', completed:'good', published:'good',
  pending:'warn', finance:'warn', queued:'warn', supplement:'warn', waiting:'warn', unpaid:'warn', paused:'warn',
  exception:'bad', returned:'bad', failed:'bad', rejected:'bad',
};
const chip=status=>'<span class="pill '+(Object.hasOwn(statusTones,status)?statusTones[status]:'')+'">'+esc(status==='revoked'?'已撤销':labels[status]||status)+'</span>';
const button=(text,action,data={},cls='',icon='')=>`<button type="button" class="button ${cls}" data-action="${action}" ${Object.entries(data).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${icon?I(icon):''}${esc(text)}</button>`;
const field=(n,label,v='',type='text',attrs='')=>type==='hidden'?`<input type="hidden" name="${n}" value="${esc(v)}">`:`<label class="field">${esc(label)}<input type="${type}" name="${n}" value="${esc(v)}" ${attrs}></label>`;
const select=(n,label,options,v='',attrs='')=>`<label class="field">${esc(label)}<select name="${n}" ${attrs}>${options.map(o=>{let [a,b]=Array.isArray(o)?o:[o,o];return `<option value="${esc(a)}" ${String(a)===String(v)?'selected':''}>${esc(b)}</option>`}).join('')}</select></label>`;
const area=(n,label,v='',attrs='required minlength="3" maxlength="1000"')=>`<label class="field">${esc(label)}<textarea name="${n}" ${attrs}>${esc(v)}</textarea></label>`;
const submit=t=>`<div class="form-actions"><button class="button primary" type="submit">${esc(t)} ${I('arrow')}</button></div>`;
const form=(cmd,body)=>`<form data-command="${cmd}">${body}</form>`;
const pair=(k,v)=>`<div class="pair"><span>${esc(k)}</span><b>${esc(v??'—')}</b></div>`;
const notice=(t,info=false)=>`<div class="notice ${info?'info':''}">${esc(t)}</div>`;
const empty=t=>`<div class="empty">${esc(t)}</div>`;
const panel=(title,body,sub='')=>`<section class="panel"><div class="panel-head"><h3>${title}</h3><small>${sub}</small></div><div class="panel-body">${body}</div></section>`;
let session=null;try{session=JSON.parse(sessionStorage.getItem('jy-session')||'null')}catch{}
let config={devLoginEnabled:false,mode:'production'},state={},data={},ui={page:'home',period:'2026-11',kind:'month',mode:'settled',outlet:'all',owner:'all',shop:'',month:'2026-10',requestType:'newOutlet',detail:null,history:[],busy:false,offset:0,limit:25,collectionStatus:'',collectionQ:'',collectionCity:'',pageInfo:null,loginMode:null};
const own=()=>session?.actor==='partnerA'||session?.actor==='partnerB'||session?.actor?.startsWith('partner:'),staff=()=>['ops','manager','finance'].includes(session?.actor),name=id=>state.outlets?.find(o=>o.id===id)?.name||id||'—';
const baseNavList=()=>session.actor==='public'?['stores','support']:session.actor==='support'?['support','messages']:session.actor==='location'?['locations','messages']:own()?['home','stores','reports','billing','requests','locations','support','analytics','messages','accounts']:session.actor==='regional'?['home','reports','analytics','messages']:['home','stores','reports','requests','locations','billing','analytics','messages',...(session.actor==='manager'?['support','accounts','content','audit']:[])];
const navGroups=[
  ['工作台',['home','tasks','analytics','messages']],
  ['网点与账号',['stores','accounts','team']],
  ['月报',['reports']],
  ['业务审批',['requests','onboarding','approvalExports','operations']],
  ['位置核验',['locations']],
  ['服务费与财务',['billing','contracts','financeops']],
  ['客服与公开内容',['support','content','knowledge']],
];
const managementPages=['audit','imports','training'];
function toast(t){$('toast').textContent=t;$('toast').classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.remove('show'),6000)}
const client=createClient({token:()=>session?.token||'',storage:sessionStorage,onUnauthorized:expiredToken=>{if(session?.token===expiredToken){sessionStorage.removeItem('jy-session');renderLogin()}}});
const api=(path,options)=>client.request(path,options);
const staffIdentity=staffLoginUi({
  api,form,field,button,notice,pair,submit,modal,config:()=>config,session:()=>session,toast,
  resetSession(){sessionStorage.removeItem('jy-session');renderLogin();},
});
const staffWechatCallback=staffIdentity.takeCallback();
async function acceptStaffSession(result){
  session=result;
  sessionStorage.setItem('jy-session',JSON.stringify(result));
  ui.page='home';
  await refresh();
}
let switchingTrialRole=false;
function roleTrialPanel(){
  const trial=config.devLoginEnabled&&config.roleTrial;
  if(!trial)return '';
  const roles=trial.profiles.map(profile=>{
    const native=profile.surface==='miniprogram';
    const active=!native&&session?.subject===profile.actor;
    return `<button class="trial-role" type="button" data-action="trial-role" data-actor="${esc(profile.actor)}"
      aria-label="${esc(profile.label)}" ${native?'aria-haspopup="dialog"':'aria-pressed="'+active+'"'} ${active?'disabled':''}>
      <strong>${esc(profile.label)}</strong><span>${esc(profile.responsibility)}</span></button>`;
  }).join('');
  return `<section class="role-trial" aria-label="三角色试用">
    <div class="trial-heading"><strong>九盈英才 · 三角色试用</strong><span>隔离账号 · 操作会保留</span></div>
    <div class="trial-roles" role="group" aria-label="切换试用身份">${roles}</div>
    <div class="trial-example"><span>同一笔业务 · ${esc(trial.report.outletName)} · ${esc(trial.report.month)} 月报</span>
      ${session&&navList().includes('reports')?button('查看这笔月报','trial-open-report',{},'outline'):''}</div>
    <div class="trial-example trial-payment"><span>加盟付款试用 · ${esc(trial.onboarding.organization)}</span>
      ${session?.role==='manager'?button('查看这笔加盟申请','trial-open-onboarding',{},'outline'):''}</div>
  </section>`;
}
function showTrialNative(){
  const project=config.roleTrial?.nativeProject;
  modal('打开加盟商小程序',notice('在微信开发者工具中打开原生小程序。工作台顶部可切换到加盟付款样例，并查看申请人的通知。',true)+
    '<div class="actions">'+button('打开微信模拟器','trial-native-launch',{},'primary')+'</div>'+
    (project?'<details><summary>手动导入项目</summary><p>在微信开发者工具的新项目窗口选择以下目录，确认后点击编译。</p><p><code class="trial-project">'+esc(project)+'</code></p></details>':'')+
    '<p data-trial-native-status role="status"></p>');
}
async function openTrialNative(control){
  const status=$('modalBody').querySelector('[data-trial-native-status]');
  if(!status||control.disabled)return;
  control.disabled=true;
  status.textContent='正在打开微信开发者工具…';
  try{
    await api('/role-trial/open',{method:'POST',body:{},ignoreUnauthorized:true});
    status.textContent='已发送打开指令。请在微信开发者工具切到模拟器，网页可留作管理员端。';
  }catch(error){
    status.textContent=error.message;
    $('modalBody').querySelector('details')?.setAttribute('open','');
  }finally{control.disabled=false;}
}
async function switchTrialRole(actor){
  const profile=config.devLoginEnabled&&config.roleTrial?.profiles.find(item=>item.actor===actor);
  if(!profile||switchingTrialRole)return;
  if(ui.busy)return toast('等本次操作保存后再切换身份。');
  if(profile.surface==='miniprogram'){
    showTrialNative();
    return openTrialNative($('modalBody').querySelector('[data-action="trial-native-launch"]'));
  }
  if(session?.subject===actor)return;
  switchingTrialRole=true;
  const controls=[...document.querySelectorAll('.trial-role')];
  controls.forEach(control=>{control.disabled=true;});
  try{
    const next=await api('/auth/dev',{method:'POST',body:{actor},ignoreUnauthorized:true});
    if(next.subject!==profile.actor||next.role!==profile.role)throw new Error('试用账号身份已变化，请联系项目组。');
    if(session)await api('/auth/logout',{method:'POST',body:{},ignoreUnauthorized:true}).catch(()=>{});
    sessionStorage.setItem('jy-session',JSON.stringify(next));
    location.replace(location.pathname+location.search);
  }finally{
    switchingTrialRole=false;
    controls.forEach(control=>{control.disabled=control.dataset.actor===session?.subject;});
  }
}
const formExports=approvalExportUi({api,button,field,select,submit,form,notice,panel,pair,empty,esc,modal,
  heading:(...args)=>heading(...args),download,toast,roles,session:()=>session});
routes.approvalExports=['审批表单导出','download'];
const onboarding=onboardingDesk({api,button,field,select,area,submit,notice,panel,pair,chip,empty,esc,modal,refresh,toast,
  heading:(...args)=>heading(...args),session:()=>session,active:()=>ui.page==='onboarding',dialog:()=>$('modal'),
  trialRecord:()=>config.roleTrial?.onboarding.id});
routes.onboarding=['加盟申请','users'];
$('modal').addEventListener('close',onboarding.releasePreview);
const approval=approvalHistory({api,esc,button,empty,modal,roles,metrics,pair});
const financeLedger=billingLedger({api,esc,pair,panel,button,modal,empty,labels});
const training=trainingDesk({api,esc,empty,panel});
routes.training=['已有培训记录','report'];
const canReadBillingLedger=()=>own()||['manager','finance'].includes(session?.actor);
const billingScope=()=>Object.fromEntries(Object.entries({month:ui.billingMonth,outlet:ui.billingOutlet}).filter(([,value])=>value));
const taskDesk=tasks({api,esc,button,field,select,area,form,submit,pair,empty,notice,modal,roles,I,session:()=>session,heading:(...args)=>heading(...args)});
const op=operations({approval,esc,field,select,area,form,submit,button,pair,notice,empty,panel,chip,heading:(...args)=>heading(...args),fmt,I,metrics,roles,state:()=>state,session:()=>session,ui:()=>ui,name,api,modal,download,toast,pageControls,collectionEmpty});
Object.entries(op.configs).forEach(([key,value])=>routes[key]=[value.title,value.icon]);
function navList(){
  const role=session.role||session.actor;
  const pages=baseNavList().filter(page=>page!=='locations'||!['ops','finance'].includes(role));
  if(role!=='public')pages.splice(1,0,'tasks');
  if(training.canOpen(role))pages.push('training');
  if(formExports.allowed(session))pages.push('approvalExports');
  if(onboarding.allowed(session))pages.push('onboarding');
  return [...pages,...Object.entries(op.configs).filter(([,definition])=>definition.roles.includes(role)).map(([key])=>key)];
}
function workspaceNav(allowed,notifications){
  const links=pages=>pages.filter(page=>allowed.includes(page)).map(page=>{
    const [label,icon]=page==='stores'&&session.actor==='public'?['服务网点','store']:routes[page];
    const current=ui.page===page?' active':'';
    return `<button type="button" data-action="nav" data-page="${page}" class="nav-link${current}" ${current?'aria-current="page"':''}>${I(icon)}${label}${page==='messages'&&notifications?`<span>${notifications}</span>`:''}</button>`;
  });
  const groups=navGroups.map(([label,pages])=>{
    const buttons=links(pages);
    return buttons.length?`<div class="nav-group" role="group" aria-label="${label}">${buttons.length>1?`<div class="nav-group-label" aria-hidden="true">${label}</div>`:''}${buttons.join('')}</div>`:'';
  }).join('');
  const more=links(managementPages);
  return groups+(more.length?`<details class="nav-more"${managementPages.includes(ui.page)?' open':''}>
    <summary>${I('settings')}更多管理</summary>${more.join('')}</details>`:'');
}
const browseChoices=()=>({billing:[['bills','应收账单'],['payments','支付尝试'],['receipts','实收流水'],['adjustments','调整来源']],support:[['support.tickets','正式工单'],['support.chats','咨询会话']],locations:[['verifications','月度核验'],['requests','业务申请位置']]}[ui.page]||[]).filter(([key])=>session.actor!=='ops'||!['payments','receipts'].includes(key));
const pageCollection=()=>op.collection()||(browseChoices().some(x=>x[0]===ui.browseCollection)?ui.browseCollection:null)||({stores:'outlets',reports:'reports',requests:'requests',locations:'verifications',billing:'bills',support:'support.tickets',accounts:'accounts',messages:'messages',audit:'audit'}[ui.page]);
const billingCollectionUsesMonth=()=>['bills','payments'].includes(pageCollection());
const hasCollectionFilters=()=>!!(ui.collectionQ||ui.collectionStatus||ui.collectionCity);
const showRelatedCollections=()=>!ui.browseCollection&&!ui.offset&&!hasCollectionFilters();
function resetCollectionFilters(){ui.collectionStatus='';ui.offset=0;ui.pageInfo=null;}
function collectionEmpty(message){
  const isFiltered=hasCollectionFilters()||(ui.page==='billing'&&(ui.billingOutlet||(billingCollectionUsesMonth()&&ui.billingMonth)));
  return `<div class="empty-state" role="status">${isFiltered?'当前筛选无匹配记录。':esc(message)}</div>`;
}
function pageControls(bottom=false){
  const key=pageCollection(),p=ui.pageInfo;
  if(!p||!key||(ui.page==='stores'&&ui.detail)||(bottom&&!p.offset&&!p.hasMore))return '';
  const choices=browseChoices();
  const statuses=(p.statusOptions||[]).map(status=>[status,collectionStatusLabels[key]?.[status]||labels[status]||status]);
  const filters=bottom?'':`<div class="list-search">
    ${choices.length?select('browseCollection','记录类型',choices,key,'data-filter="browseCollection"'):''}
    ${field('collectionQ','搜索记录',ui.collectionQ,'search','data-filter="collectionQ" placeholder="名称、编号或关键词"')}
    ${statuses.length?select('collectionStatus','记录状态',[['','全部状态'],...statuses],ui.collectionStatus,'data-filter="collectionStatus"'):''}
    ${ui.page==='stores'?field('collectionCity','城市',ui.collectionCity,'text','data-filter="collectionCity"'):''}</div>`;
  return `<div class="list-controls ${bottom?'bottom':''}">${filters}<div class="pagination">
    <span>共 <b>${p.total}</b> 条 · ${p.items.length?p.offset+1:0}—${p.items.length?Math.min(p.offset+p.limit,p.total):0}</span>
    <button class="button" data-action="page-prev" ${p.offset===0?'disabled':''} aria-label="上一页">←</button>
    <button class="button" data-action="page-next" ${!p.hasMore?'disabled':''} aria-label="下一页">→</button></div></div>`;
}
async function loadPage(isCurrent){
  const key=pageCollection();
  if(!key){ui.pageInfo=null;return;}
  if(key==='outlets'&&ui.detail){
    ui.pageInfo=null;
    const record=await api('/collections/outlets/'+encodeURIComponent(ui.detail));
    if(isCurrent())state.outlets=[record];
    return;
  }
  const params={limit:ui.limit,offset:ui.offset,includeStatusOptions:'true'};
  if(ui.collectionQ)params.q=ui.collectionQ;
  if(ui.collectionStatus)params.status=ui.collectionStatus;
  if(ui.collectionCity)params.city=ui.collectionCity;
  if(ui.page==='reports'){
    params.month=ui.month;
    if(own()&&ui.shop)params.outlet=ui.shop;
    if(['manager','ops','finance'].includes(session.actor)){
      params.includeRevenueComparison='true';
      params.includeSubmitter='true';
      params.includeOutletPhoto='true';
    }
  }
  if(ui.page==='locations'&&key==='requests')params.scope='location';
  if(ui.page==='billing'){
    if(ui.billingOutlet)params.outlet=ui.billingOutlet;
    if(ui.billingMonth&&billingCollectionUsesMonth())params.month=ui.billingMonth;
  }
  const p=await api('/collections/'+encodeURIComponent(key)+'?'+new URLSearchParams(params));
  if(!isCurrent())return;
  ui.pageInfo=p;
  if(key.startsWith('support.'))state.support[key.slice(8)]=p.items;
  else state[key]=p.items;
}

async function command(command,payload){if(ui.busy)throw Error('上一项操作仍在提交，请稍候');ui.busy=true;try{return await client.command(command,payload)}finally{ui.busy=false}}
function initializeClock(context){
  if(config.devLoginEnabled||ui.clockInitialized)return;
  ui.period=context.today.slice(0,7);
  const previous=new Date(context.today+'T00:00:00Z');
  previous.setUTCDate(1);
  previous.setUTCMonth(previous.getUTCMonth()-1);
  ui.month=previous.toISOString().slice(0,7);
  ui.clockInitialized=true;
}
async function loadContextForPage(isCurrent){
 const context=await api('/context');if(!isCurrent())return;
  initializeClock(context);
  let deps=({home:['outlets','reports'],stores:['outlets','reports'],reports:['outlets'],requests:['outlets'],locations:['outlets',...(showRelatedCollections()?['requests']:[])],billing:['outlets',...(showRelatedCollections()?['payments','adjustments']:[])],support:['outlets',...(showRelatedCollections()?['support.chats']:[])],analytics:['outlets','organizations','summaryAdjustments','reports'],accounts:['outlets','organizations','agencyRelations'],messages:[],content:['contents','contentVersions'],audit:[],contracts:['outlets','pricePlans','agreements'],financeops:['outlets','bills','receipts','adjustments'],team:['outlets','staffAccounts'],operations:['outlets'],knowledge:['outlets'],imports:[]}[ui.page]||[]);
 if(session.actor==='ops')deps=deps.filter(k=>!['payments','receipts'].includes(k));if(session.actor==='regional')deps=deps.filter(k=>!['requests','bills','drafts','summaryAdjustments','organizations'].includes(k));if(session.actor==='public')deps=deps.filter(k=>!['reports'].includes(k));if(session.actor!=='manager')deps=deps.filter(k=>k!=='agencyRelations');
 const next={...context,outlets:[],reports:[],requests:[],bills:[],messages:[],support:{...context.support,chats:[],tickets:[]},pagination:{}};
 const relatedCollection=k=>({locations:['requests'],billing:['payments','adjustments'],support:['support.chats']}[ui.page]||[]).includes(k);
 const financeRequests=ui.page==='billing'&&canReadBillingLedger()?[api('/finance/summary?'+new URLSearchParams({...billingScope(),limit:20,offset:ui.billingOutletOffset||0})).then(value=>{next.finance=value;})]:[];
 await Promise.all([...financeRequests,...[...new Set([...deps,'messages'])].map(async k=>{const p=await api('/collections/'+encodeURIComponent(k)+'?'+new URLSearchParams({limit:relatedCollection(k)?ui.limit:200,offset:0,...(ui.page==='locations'&&k==='requests'?{scope:'location',status:'pending'}:{}),...(k==='reports'&&['home','stores'].includes(ui.page)?{month:ui.month,latestOnly:'true'}:{}),...(k==='contentVersions'?{key:ui.contentKey||'brand'}:{}),...(ui.page==='analytics'&&['outlets','organizations'].includes(k)&&ui.scopeQ?{q:ui.scopeQ}:{})}));if(k.startsWith('support.'))next.support[k.slice(8)]=p.items;else next[k]=p.items;next.pagination[k]=p})]);if(!isCurrent())return;if(ui.page==='analytics'){for(const [key,id]of [['outlets',ui.outlet],['organizations',ui.owner]]){if(id&&id!=='all'&&next[key]&&!next[key].some(x=>x.id===id)){const selected=await api('/collections/'+key+'/'+encodeURIComponent(id));next[key].unshift(selected)}}}if(!isCurrent())return;if(ui.page==='reports'&&own()&&ui.shop){
  const outlet=ui.shop,month=ui.month;
  if(!next.outlets.some(row=>row.id===outlet)){
   const record=await api('/collections/outlets/'+encodeURIComponent(outlet));
   if(!isCurrent())return;
   next.outlets.unshift(record);
  }
  next.reportContext=await api('/reports/context?'+new URLSearchParams({outlet,month}));
 }
 if(isCurrent())state=next;
}
let viewRevision=0;
let renderedAnalyticsRevision=-1;
async function loadDashboard(){
  const {period,kind,mode,outlet,owner,analyticsOffset,page}=ui;
  const shift=(value,count)=>new Date(Date.UTC(Number(value.slice(0,4)),Number(value.slice(5))-1+count,1)).toISOString().slice(0,7);
  const requests=new Map();
  const dashboard=(forPeriod,forKind,options={})=>{
    const key=forKind+'|'+forPeriod;
    if(!requests.has(key))requests.set(key,api('/dashboard?'+new URLSearchParams({period:forPeriod,kind:forKind,mode,outlet,owner,...options})));
    return requests.get(key);
  };
  const current=dashboard(period,kind,{limit:50,offset:analyticsOffset||0});
  const history=Promise.all(Array.from({length:6},(_,index)=>{
    const trendPeriod=shift(period,index-5);
    return dashboard(trendPeriod,'month').then(item=>({period:trendPeriod,...item}));
  }));
  const comparison=page==='analytics'?Promise.all([kind==='quarter'?-3:kind==='year'?-12:-1,-12].map(count=>dashboard(shift(period,count),kind))):[];
  return Promise.all([current,history,comparison]);
}
function openTaskRoute(){
  const route=readTaskRoute(location.hash);
  if(route){ui.page='tasks';ui.detail=null}
  return route;
}
function queueError(message,status){return Object.assign(Error(message),{status})}
async function refreshTasks(route,isCurrent){
  if(!route){
    const {overview,error}=await overviewRequest();
    if(isCurrent())shell(heading('业务待办','按当前职责查看和处理待办。')+taskDesk.cards(overview,error,false)+(overview&&!overview.items.length?empty('当前账号没有可查看的待办队列。'):''));
    return;
  }
  if(route.task){
    try{
      const [row,context]=await Promise.all([taskDesk.detail(route.task),api('/context')]);
      if(!isCurrent())return;
      if(row.queue!==route.queue||!row.canViewBusiness||!row.businessType||!row.businessId)throw queueError('无权查看关联业务',403);
      const [record,replacement]=await Promise.all([
        api('/collections/'+encodeURIComponent(row.businessType)+'/'+encodeURIComponent(row.businessId)
          +(row.businessType==='reports'&&['manager','ops','finance'].includes(session.actor)?'?includeRevenueComparison=true&includeSubmitter=true&includeOutletPhoto=true':'')),
        row.resultSettlementId?api('/collections/settlements/'+encodeURIComponent(row.resultSettlementId)):null
      ]);
      if(!isCurrent())return;
      initializeClock(context);
      state={...state,...context};
      shell(taskDesk.focused(route,row,focusedBusiness(row,record,replacement)));
      approval.load(document.querySelector('.focused-business .approval-history'));
    }catch(error){if(isCurrent())shell(taskDesk.focused(route,null,'',error))}
    return;
  }
  try{
    const result=await taskDesk.list(route);
    if(isCurrent()){
      shell(taskDesk.queue(route,result));
      const position=history.state?.taskQueueScroll??(ui.queueReturn?.hash===location.hash?ui.queueReturn.position:0);
      if(position)requestAnimationFrame(()=>{if(isCurrent())window.scrollTo(0,position)});
    }
  }catch(error){if(isCurrent())shell(taskDesk.queue(route,null,error))}
}
function overviewRequest(){
  return taskDesk.summary().then(overview=>({overview}),error=>({error}));
}
async function refresh(){
  if(!session)return renderLogin();
  const revision=++viewRevision,owner=session;
  const isCurrent=()=>revision===viewRevision&&owner===session;
  const taskRoute=openTaskRoute();
  if(!taskRoute&&!navList().includes(ui.page))ui.page=navList()[0];
  if(ui.page==='tasks')return refreshTasks(taskRoute,isCurrent);
  if(ui.page==='training')return renderTraining();
  if(ui.page==='approvalExports'){
    await formExports.load(isCurrent);
    if(isCurrent())shell(formExports.render());
    return;
  }
  if(ui.page==='onboarding'){
    await onboarding.load(isCurrent);
    if(isCurrent())shell(onboarding.render());
    return;
  }
  const taskOverview=ui.page==='home'?overviewRequest():null;
  await loadContextForPage(isCurrent);
  if(!isCurrent())return;
  if(['home','analytics'].includes(ui.page)){
    const [[dashboard,history,comparison],overview]=await Promise.all([loadDashboard(),taskOverview]);
    if(!isCurrent())return;
    data=dashboard;
    ui.history=history;
    ui.comparison=comparison;
    ui.taskOverview=overview;
  }
  await loadPage(isCurrent);
  if(isCurrent())render();
}
async function nav(page,options={}){
  if(!navList().includes(page))return toast('当前账号无此权限');
  if(readTaskRoute(location.hash))history.pushState({workspacePage:page},'',location.pathname+location.search);
  else history.replaceState({...history.state,workspacePage:page},'');
  Object.assign(ui,{page,detail:null,offset:0,analyticsOffset:0,collectionQ:'',collectionStatus:'',collectionCity:'',opTab:null,browseCollection:null,...(page==='reports'?{shop:''}:{}),...options});
  setWorkspaceMenu(false);
  const owner=session;
  const result=refresh();
  const revision=viewRevision;
  const isCurrent=()=>session===owner&&viewRevision===revision;
  try {
    await result;
  } catch (error) {
    if (!isCurrent()) return;
    toast(error.message);
    shell(notice(error.message)+button('重新加载','refresh'));
  }
  if (!isCurrent()) return;
  const workspace=$('workspace-body');
  const destination=workspace?.querySelector('h1')||workspace;
  destination?.setAttribute('tabindex','-1');
  window.scrollTo(0,0);
  destination?.focus({preventScroll:true});
}
window.addEventListener('hashchange',async event=>{
  if(!session)return;
  const route=readTaskRoute(location.hash);
  if(!route&&!readTaskRoute(new URL(event.oldURL).hash))return;
  if($('modal').open)$('modal').close();
  if(!route){const page=history.state?.workspacePage;ui.page=navList().includes(page)?page:navList()[0];ui.detail=null}
  try{await refresh()}catch(e){if(session)shell(notice(e.message)+button('重新加载','refresh'))}
});
function renderLogin(){
  formExports.reset();
  onboarding.reset();
  resetCollectionFilters();
  Object.assign(ui,{shop:'',collectionQ:'',collectionCity:'',browseCollection:null,opTab:null,billingMonth:'',billingOutlet:'',billingOutletOffset:0,detail:null});
  session=null;
  viewRevision++;
  state={};
  data={};
  ui.taskOverview=null;
  ui.queueReturn=null;
  if($('modal').open)$('modal').close();
  $('modalBody').innerHTML='';
  const mode=ui.loginMode||(config.devLoginEnabled?'dev':'password');
  const tabs=[['password','账号密码'],...staffIdentity.tabs(),...(config.devLoginEnabled?[['dev','开发测试']]:[])];
  const body=staffIdentity.loginForm(mode)||(
    mode==='dev'
      ?form('login',select('actor','开发环境测试账号',Object.entries(roles),'manager')+
        field('customActor','个人开发账号标识（选填）','','text','placeholder="账号标识"')+submit('登录工作空间'))
      :mode==='activate'
        ?form('activate',field('token','总部签发的激活码','','text','required autocomplete="off"')+
          field('password','设置密码','','password','required minlength="12" maxlength="128" autocomplete="new-password"')+
          field('confirmPassword','再次输入密码','','password','required minlength="12" maxlength="128" autocomplete="new-password"')+submit('激活账号'))
        :form('password-login',field('username','个人登录账号','','text','required autocomplete="username"')+
          field('password','密码','','password','required autocomplete="current-password"')+submit('登录工作空间'))
  );
  const choices=tabs.map(([key,label])=>'<button type="button" data-action="login-mode" data-mode="'+key+
    '" class="'+(mode===key?'active':'')+'" aria-pressed="'+(mode===key)+'">'+label+'</button>').join('');
  $('app').innerHTML=`<main class="login">
    <section class="login-art" aria-hidden="true">
      <div class="brand"><div class="brand-mark">九</div><strong>九盈英才</strong></div>
      <div class="login-art-body">
        <p>网点 · 月报 · 服务费</p>
        <div class="login-art-title">经营协作平台</div>
      </div>
    </section>
    <section class="login-form">
      <div class="login-box">
        <div class="login-mobile-mark" aria-hidden="true">九</div>
        ${roleTrialPanel()}
        <h1>${mode==='activate'?'首次激活':'登录九盈英才'}</h1>
        <p class="subtitle">${mode==='activate'?'使用总部发放的激活码设置密码。':'使用总部登记的个人账号登录。'}</p>
        ${mode!=='activate'?'<div class="tabs login-tabs" aria-label="登录方式">'+choices+'</div>':''}
        ${body}
        <div class="login-help">
          <button class="text-button" type="button" data-action="login-mode" data-mode="${mode==='activate'?'password':'activate'}">${mode==='activate'?'返回登录':'首次激活'}</button>
          <span>账号问题请联系总部</span>
        </div>
        ${mode==='dev'?notice('隔离测试环境 · 请使用测试账号',true):''}
      </div>
    </section>
  </main>`;
}
function shell(body){
  const allowed=navList();
  const notifications=(state.messages||[]).filter(row=>!row.read).length;
  const role=roles[session.actor]||roles[session.role]||'加盟商负责人';
  const workspace=own()?'加盟商工作台':session.role==='public'?'集团与网点服务':'总部工作台';
  $('app').innerHTML=`<div class="layout">
    <aside class="side" id="workspace-navigation">
      <div class="brand"><div class="brand-mark">九</div><div><strong>九盈英才</strong><small>经营协作平台</small></div></div>
      <nav class="nav" aria-label="工作空间">${workspaceNav(allowed,notifications)}</nav>
    </aside>
    <button type="button" class="nav-dismiss" data-action="menu-close" aria-label="关闭功能菜单" hidden></button>
    <div class="main">
      <header class="topbar">
        <div class="workspace-context">
          <button type="button" class="iconbtn mobile-menu" data-action="menu" aria-label="打开功能菜单" aria-controls="workspace-navigation" aria-expanded="false">${I('menu')}</button>
          <span class="breadcrumb">${workspace}</span>
        </div>
        <div class="top-actions">
          ${config.devLoginEnabled?'<span class="environment-notice">隔离测试</span>':''}
          ${allowed.includes('messages')?'<button type="button" class="iconbtn" data-action="nav" data-page="messages" aria-label="消息中心">'+I('bell')+'</button>':''}
          <div class="user"><span class="avatar" aria-hidden="true">${role.slice(0,1)}</span><strong class="user-text">${esc(role)}</strong></div>
          ${staffIdentity.isPersonalStaff(session)?button('登录安全','staff-login-profile'):''}
          <button type="button" class="iconbtn" data-action="logout" aria-label="退出登录">${I('logout')}</button>
        </div>
      </header>
      ${roleTrialPanel()}
      <main class="content" id="workspace-body">${body}</main>
    </div>
  </div>`;
  loadReportOutletPhotos($('workspace-body'));
}
function loadReportOutletPhotos(workspace){
  const photos=new Map();
  for(const frame of workspace.querySelectorAll('[data-report-outlet-photo]')){
    const query=new URLSearchParams({publishedOutletPhoto:frame.dataset.outlet});
    const path='/files/'+encodeURIComponent(frame.dataset.reportOutletPhoto)+'?'+query;
    if(!photos.has(path))photos.set(path,api(path,{binary:true,ignoreUnauthorized:true}));
    photos.get(path).then(async ({blob})=>{
      if(!frame.isConnected)return;
      const url=URL.createObjectURL(blob);
      try{
        const image=new Image();
        image.alt='';
        image.src=url;
        await image.decode();
        if(frame.isConnected)frame.replaceChildren(image);
      }finally{URL.revokeObjectURL(url);}
    }).catch(()=>{});
  }
}
const mobileWorkspace=window.matchMedia('(max-width: 760px)');
function setWorkspaceMenu(open,restoreFocus=false){
  const trigger=$('app').querySelector('.mobile-menu');
  if(!trigger)return;
  const menu=$('workspace-navigation');
  const dismiss=$('app').querySelector('.nav-dismiss');
  menu.classList.toggle('open',open);
  dismiss.hidden=!open;
  trigger.setAttribute('aria-expanded',String(open));
  $('workspace-body').inert=open;
  $('app').querySelector('.top-actions').inert=open;
  if(open)menu.querySelector('[aria-current="page"],.nav-link')?.focus();
  else if(restoreFocus)trigger.focus();
}
mobileWorkspace.addEventListener('change',event=>{
  if(!event.matches)setWorkspaceMenu(false);
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('workspace-navigation')?.classList.contains('open')){
    event.preventDefault();
    setWorkspaceMenu(false,true);
  }
});
const heading=(title,sub,action='')=>`<div class="page-heading"><div><h1>${title}</h1>${sub?'<p class="subtitle">'+sub+'</p>':''}</div>${action}</div>`;
function statCards(t=data.totals||{}){return `<div class="metrics">${Object.entries(metrics).filter(([k])=>Object.hasOwn(t,k)).map(([k,n],i)=>`<div class="metric"><div class="metric-top">${n}<span class="micon">${I(['wallet','report','users','chart'][i])}</span></div><b>${fmt(t[k],k)}<span class="unit">${units[k]}</span></b><small>${t[k]==null?'当期尚无已结算数据':'<em>●</em> '+(ui.mode==='settled'?'已结算正式数据':'已审过程数据')}</small></div>`).join('')}</div>`}
function chart(){const max=Math.max(1,...ui.history.map(x=>x.totals?.revenue||0));return `<div class="legend"><span><i></i>营业收入 · 已授权范围</span><span>无数据月份不补零</span></div><div class="chart"><div class="chart-axis"><span>${fmt(max)}</span><span>${fmt(max/2)}</span><span>0</span></div><div class="chart-lines"><i></i><i></i><i></i></div><div class="bars">${ui.history.map(x=>`<div class="bar-group"><i style="height:${(x.totals?.revenue||0)/max*90}%"></i><b style="bottom:${(x.totals?.revenue||0)/max*90+3}%">${x.totals?.revenue==null?'—':''}</b><span>${x.period.slice(5)}月</span></div>`).join('')}</div></div>`}
function storeTable(outlets=state.outlets||[],publicOnly=false){
  const scope=publicOnly?'':'<th>'+esc(ui.month)+' 月报</th>';
  const rows=outlets.map(outlet=>{
    const report=publicOnly?null:state.reports?.find(record=>record.outlet===outlet.id&&record.month===ui.month);
    const reportLabel=report?chip(report.revoked?'revoked':report.status):state.pagination?.reports?.hasMore
      ?'<span class="muted">请查看经营月报</span>':'<span class="muted">暂无提交记录</span>';
    const reporting=publicOnly?'':'<td class="outlet-report-state">'+reportLabel+'</td>';
    return '<tr><td><strong>'+esc(outlet.name)+'</strong><small>'+esc(outlet.city)+' · '+esc(outlet.address)+
      '</small></td><td>'+chip(outlet.status)+'</td>'+reporting+'<td><button class="table-action" data-action="store" data-id="'+
      esc(outlet.id)+'">查看详情 ↗</button></td></tr>';
  }).join('');
  return '<div class="table-wrap"><table><thead><tr><th>网点名称 / 位置</th><th>经营状态</th>'+scope+
    '<th>操作</th></tr></thead><tbody>'+(rows||'<tr><td colspan="'+(publicOnly?3:4)+'">暂无关联网点</td></tr>')+'</tbody></table></div>';
}
function home(){
  const canViewStores=navList().includes('stores');
  const recent=ui.history.findLast(row=>row.reportingCoverage?.settled>0);
  return heading('经营总览',esc(state.today)+' · 当前授权范围',button('刷新数据','refresh',{},'','chart'))+
    taskDesk.cards(ui.taskOverview?.overview,ui.taskOverview?.error)+statCards()+
    `<div class="actions" style="margin:-8px 0 23px"><small>${esc(ui.period)} · ${ui.mode==='settled'?'已结算正式数据':'已审过程数据'}</small>${recent?button('查看最近已结算月份','recent',{period:recent.period}):''}</div>`+
    panel('经营趋势',chart(),esc(ui.period)+' · 近六月')+
    (canViewStores?`<section class="panel"><div class="panel-head"><h3>网点一览</h3>${button('全部网点','nav',{page:'stores'},'','arrow')}</div>${storeTable((state.outlets||[]).slice(0,5))}</section>`:'')
}
function outletOptions(){
  return [['','请选择网点'],...(state.outlets||[]).map(o=>[o.id,[...new Set([o.name,o.city,o.district].filter(Boolean))].join(' · ')])];
}
function shopSelect(){return select('shop','选择网点',outletOptions(),ui.shop,'data-filter="shop"')}
function writeOutletSelect(label){return select('outlet',label,outletOptions(),'','required')}
function enrollmentLabel(o){return o?.enrollmentStatus==='pending'||o?.enrollmentApplicable==null?'待总部确认':o.enrollmentApplicable?'适用':'不适用'}
function enrollmentForm(o){return panel('招生指标适用性',notice('请按实际业务明确确认适用性与生效月份。待确认不等于不适用，历史月报不会回写。',true)+form('enrollment.confirm',field('outlet','',o.id,'hidden')+select('applicable','确认结论',[['','请选择核实结论'],['true','适用：月报填写实际招生人数'],['false','不适用：以不适用展示']],'','required')+field('effectiveMonth','生效月份',ui.period,'month','required')+area('reason','业务核实依据')+submit('确认招生适用性')))}
function ownerHistory(a){return (a?.ownerHistory||[]).length?panel('负责人绑定历史',(a.ownerHistory||[]).map(h=>`<div class="record">${Object.entries(h).map(([k,v])=>pair(({managerName:'原负责人',mobile:'原手机号',requestId:'换绑申请',changedAt:'变更时间',actor:'处理岗位',subject:'处理人',bindingVersion:'原绑定版本'}[k]||k),typeof v==='object'?JSON.stringify(v):v)).join('')}</div>`).join('')):''}
function stores(){let os=state.outlets||[];if(ui.detail){let o=os.find(x=>x.id===ui.detail);if(!o)return empty('网点不可访问');return heading(o.name,'网点档案与营业状态',button('返回列表','nav',{page:'stores'}))+panel('基础资料',pair('营业状态',labels[o.status])+pair('对外地址',o.address)+pair('所在地区',[o.countryCode&&o.countryCode!=='CN'?o.countryCode:'',o.province,o.city,o.district].filter(Boolean).join(' / '))+(session.actor==='public'?'':pair('招生指标',enrollmentLabel(o))+((own()||['manager','location'].includes(session.actor))?pair('内部坐标',o.coords?`${o.coords.lat}, ${o.coords.lng}`:'尚未提供'):'')+pair('协议结束',o.agreementEnd||'待集团确认')+pair('已付服务使用期',o.serviceUntil||'待财务核算')))+(['manager','ops'].includes(session.actor)?panel('登记实际状态',form('outlet.status',field('outlet','',o.id,'hidden')+select('status','新状态',['open','paused','closed'].map(x=>[x,labels[x]]))+field('effectiveDate','实际生效日期','2026-11-18','date','required')+area('reason','核验依据')+submit('登记状态变化')))+panel('整月停业免报',form('report.exempt',field('outlet','',o.id,'hidden')+field('month','免报月份','2026-10','month','required')+area('reason','完整停业核验依据')+submit('登记独立免报状态'))):'')+(['manager','ops'].includes(session.actor)?enrollmentForm(o):'')+panel('状态历史',(o.events||[]).map(e=>pair(e.date,labels[e.status]+' · '+(e.reason||''))).join('')||empty('无可见内部历史'))}
return heading(own()?'我的网点':session.actor==='public'?'服务网点':'网点管理',session.actor==='public'?'查询公开服务网点及地址。':'持续记录每个网点的经营历程。',own()?button('申请新增网点','new-request',{type:'newOutlet'},'primary','plus'):'')+pageControls()+(os.length?`<section class="panel">${storeTable(os,session.actor==='public')}</section>`:collectionEmpty('暂无可查看的网点。'))}
function reportValues(r){
 const values=Object.entries(metrics).filter(([key])=>Object.hasOwn(r,key)).map(([key,label])=>
  pair(label+'（'+units[key]+'）',r[key]===null&&key==='enroll'?'不适用':fmt(r[key],key))).join('');
 const note=r.note===undefined?'':`<div class="report-note"><span>经营说明</span><p class="report-note-value">${esc(r.note||'未填写')}</p></div>`;
 return values+note;
}
function assignmentNotice(record, action) {
 return record.unavailableActions?.includes(action) ? notice('此事项已分派，当前账号可查看进度。') : '';
}
function canReviewReport(report){
 if(report.unavailableActions?.includes('review.report'))return false;
 const role=session.actor;
 if(report.status==='finance')return role==='finance';
 if(report.status!=='pending')return false;
 if(role==='regional'){
  const grants=state.grants;
  return grants?.outlets?.includes(report.outlet)&&grants?.reviewOutlets?.includes(report.outlet);
 }
 return ['manager','ops'].includes(role);
}
function ensureReportWriteScope(payload){
  const loaded=state.reportContext;
  if(ui.page!=='reports'||payload.outlet!==ui.shop||payload.month!==ui.month||
     loaded?.outlet!==ui.shop||loaded?.month!==ui.month)throw Error('网点或月份正在切换，请等待所选记录加载。');
}
function reportRevenueComparison(comparison) {
  if(!comparison)return '';
  const {month, percent}=comparison;
  const label='营业收入较上月（'+month+'）';
  if(!Number.isFinite(percent))return pair(label,'暂无可比数据');
  const text=Intl.NumberFormat('zh-CN',{
    style:'percent',signDisplay:'exceptZero',maximumFractionDigits:2
  }).format(percent/100);
  const direction=percent>0?' is-up':percent<0?' is-down':'';
  return `<div class="pair report-revenue-comparison"><span>${esc(label)}</span><b class="report-revenue-change${direction}">${esc(text)}</b></div>`;
}
function reportCard(r, withHistory = false) {
  const version = [
    'V' + r.version,
    r.current ? '当前有效版' : '',
    r.late ? '逾期补报' : ''
  ].filter(Boolean).join(' · ');
  const values = r.summaryOnly
    ? notice('历史版本仅展示处理摘要；完整原始数据与内部审批记录由总部保留。', true)
    : `<section class="report-record-values"><h4>本期数据</h4>${reportValues(r)}${reportRevenueComparison(r.revenueComparison)}</section>`;
  const diff = Object.entries(r.correctionDiff || {});
  const financeReview = r.status === 'finance';
  const review = canReviewReport(r) ? form('review.report',
    field('id', '', r.id, 'hidden')
      + area('note', '审批意见（退回必填）', '', 'maxlength="800"')
      + `<div class="form-actions report-review-actions">
        <button class="button" type="submit" name="decision" value="return">退回修改</button>
        <button class="button primary" type="submit" name="decision" value="approve">${financeReview ? '财务复核通过' : '审核通过'}</button>
      </div>`
  ) : '';
  return `<section class="record report-record">
    <div class="report-record-context">
      <div class="record-top">
        <div class="report-record-identity">
          <span class="report-record-icon"${r.outletPhotoId ? ` data-report-outlet-photo="${esc(r.outletPhotoId)}" data-outlet="${esc(r.outlet)}"` : ''}>${I('store')}</span>
          <div>
            <h3>${esc(r.outletName || name(r.outlet))} · ${esc(r.month)}</h3>
            <small>${esc(version)}${r.dueOn ? ` <span class="report-record-deadline">· 报送截止 ${esc(r.dueOn)}</span>` : ''}</small>
          </div>
        </div>
        ${chip(r.status)}
      </div>
      ${Object.hasOwn(r, 'submitterName') ? pair('提交人', r.submitterName || '未留存姓名') : ''}
      ${r.createdAt ? pair('提交时间', taskDate(r.createdAt)) : ''}
    </div>
    ${values}
    ${r.correctionType ? pair('更正分类', r.correctionType === 'field' ? '单字段更正' : '整表更正') : ''}
    ${diff.length ? panel('本次变更对照', diff.map(([key, value]) =>
      pair(metrics[key] || (key === 'note' ? '经营说明' : key), String(value.before ?? '未填') + ' → ' + String(value.after ?? '未填'))
    ).join('')) : ''}
    ${r.reviewNote ? notice('处理意见：' + r.reviewNote) : ''}
    ${r.revoked ? notice('该版本已走复核撤销流程，原数据和审批记录保留；不再计入有效统计。') : ''}
    ${own() && r.current ? button('发起更正', 'correct', {id: r.id}) : ''}
    ${session.actor === 'manager' && r.current ? button('发起误审批纠正 / 撤销', 'revoke', {id: r.id}) : ''}
    ${assignmentNotice(r, 'review.report')}
    ${review}
    ${withHistory ? approval.mount('reports', r.id) : approval.trigger('reports', r.id)}
  </section>`;
}
function reports(){
  const partner=own();
  const rs=(state.reports||[]).filter(r=>r.month===ui.month&&(!partner||!ui.shop||r.outlet===ui.shop)).sort((a,b)=>b.version-a.version);
  const context=state.reportContext;
  const scoped=context?.outlet===ui.shop&&context?.month===ui.month;
  const last=scoped?context.latestSubmittedVersion:null,cur=scoped?context.currentApprovedVersion:null;
  const draft=(scoped&&context.draft)||last||{};
  const enrollment=scoped?context.enrollmentStatus:null;
  const editor=partner&&scoped&&context.eligibility.canEdit?panel(cur?'提交更正版本':'报送本月经营情况',form('report.submit',
    field('outlet','',context.outlet,'hidden')+field('month','',context.month,'hidden')+
    `<div class="form-grid">${field('revenue','营业收入（人民币元）',draft.revenue??'','number','required min="0" step="0.01"')}
      ${field('orders','完成有效订单数',draft.orders??'','number','required min="0" step="1"')}
      ${field('traffic','到店客流人次',draft.traffic??'','number','required min="0" step="1"')}
      ${enrollment==='applicable'?field('enroll','实际招生人数',draft.enroll??'','number','required min="0" step="1"')
        :notice(enrollment==='pending'?'招生适用性待总部确认。可先保存草稿，确认后再正式提交。':'招生指标不适用，不以0代替。',true)}</div>`+
    area('note','经营说明（选填）',draft.note||'','maxlength="600"')+
    `<div class="form-actions">${button('保存草稿','draft')}${context.eligibility.canSubmit?submit('提交总部审核'):''}</div>`)):'';
  return heading('经营月报','一网点、一自然月、一份当前有效数据。')+
    `<div class="filters">${partner?shopSelect():''}${field('month','经营月份',ui.month,'month','data-filter="month"')}</div>`+
    (partner&&!ui.shop?notice('请选择要填报的网点。下方可查看本月的已有记录。',true):'')+
    notice('按总部公布的期限报送，逾期仍可补报。收入含税与退款归属待集团财务确认。',true)+editor+
    (partner&&scoped?`<div class="version-summary"><div><small>正式口径</small><b>${cur?'当前有效版本 · V'+cur.version:'当前无有效审核版本'}</b></div><div><small>提交进度</small><b>${last?'最新提交版本 · V'+last.version:'尚未提交'}</b>${last?chip(last.status):''}</div></div>`:'')+
    pageControls()+rs.map(r=>reportCard(r)).join('')+(rs.length?'':collectionEmpty('本月暂无报表记录。'));
}
function mapFields(){return `<div class="mapbox">${I('pin')}<small>主动采集位置 · 不进行持续定位</small></div><div class="actions">${config.devLoginEnabled?button('选择开发模拟坐标','coordinates'):''}${button('主动获取浏览器定位','gps')}</div><details><summary>手动录入已核实地图位置（不能代替现场 GPS）</summary><div class="form-grid">${field('manualLat','GCJ-02 纬度','','number','min="-90" max="90" step="any"')}${field('manualLng','GCJ-02 经度','','number','min="-180" max="180" step="any"')}</div>${button('确认手动位置','manual-coordinates')}</details><small id="coordsLabel">未选位置</small><label class="field">现场照片（JPEG / PNG / WebP，最大2MB）<input id="photo" type="file" accept="image/png,image/jpeg,image/webp"></label><small id="photoLabel">尚未上传</small>`}
const locationEvidence=new WeakMap();
function evidenceFor(form){
  if(form.elements.outlet&&!form.elements.outlet.value)throw Error('请先选择网点。');
  if(form.elements.month&&!form.elements.month.value)throw Error('请先选择月份。');
  if(!locationEvidence.has(form))locationEvidence.set(form,{coords:null,photo:null});
  return locationEvidence.get(form);
}
function resetLocationScope(input){
  const form=input.form,photo=form?.querySelector('#photo');
  if(!photo||!['outlet','month'].includes(input.name))return;
  const previous=locationEvidence.get(form);
  locationEvidence.delete(form);
  photo.value='';
  form.querySelector('#coordsLabel').textContent='未选位置';
  form.querySelector('#photoLabel').textContent='尚未上传';
  form.elements.manualLat.value='';
  form.elements.manualLng.value='';
  if(input.name==='outlet'&&form.dataset.command==='location.submit'){
    form.elements.address.value=state.outlets.find(outlet=>outlet.id===input.value)?.address||'';
  }
  if(previous?.coords||previous?.photo||previous?.capture||previous?.upload)toast('网点或月份已变更，请重新获取位置并上传照片。');
}
function captureLocation(button){
  const form=button.form,evidence=evidenceFor(form),label=form.querySelector('#coordsLabel');
  const capture=Symbol();
  const current=()=>form.isConnected&&locationEvidence.get(form)===evidence&&evidence.capture===capture;
  const update=(coords,description)=>{
    evidence.coords=coords;
    evidence.capture=null;
    label.textContent=`${coords.lat}, ${coords.lng} · ${description}`;
  };
  if(button.dataset.action==='manual-coordinates'){
    const lat=form.elements.manualLat.value,lng=form.elements.manualLng.value;
    if(lat===''||lng===''||!Number.isFinite(Number(lat))||!Number.isFinite(Number(lng))||Math.abs(Number(lat))>90||Math.abs(Number(lng))>180)throw Error('请填写有效的完整经纬度');
    return update({lat:Number(lat),lng:Number(lng),source:'manual',coordinateSystem:'GCJ-02',accuracy:null,capturedAt:new Date().toISOString()},'手动位置（非现场 GPS）');
  }
  if(button.dataset.action==='coordinates'){
    update({lat:28.2282,lng:112.9388,source:'simulated',coordinateSystem:'WGS-84',accuracy:null,capturedAt:new Date().toISOString()},'明确标记的模拟坐标');
    return toast('已选择开发示例坐标，非真实GPS');
  }
  if(!navigator.geolocation)throw Error('当前浏览器不支持定位');
  evidence.coords=null;
  evidence.capture=capture;
  label.textContent='正在获取位置…';
  navigator.geolocation.getCurrentPosition(pos=>{
    if(!current())return;
    update({lat:pos.coords.latitude,lng:pos.coords.longitude,source:'gps',coordinateSystem:'WGS-84',accuracy:pos.coords.accuracy,capturedAt:new Date(pos.timestamp).toISOString()},'用户主动授权定位');
  },err=>{
    if(!current())return;
    evidence.capture=null;
    label.textContent='未选位置';
    toast(err.code===1?'定位授权已拒绝，请在设备设置中重新授权，或提交标为手动的资料供人工核实。':'定位失败，请检查设备权限或稍后再试。');
  },{timeout:8000,maximumAge:0});
}
async function uploadLocationPhoto(input){
  const form=input.form,evidence=evidenceFor(form),label=form.querySelector('#photoLabel');
  evidence.photo=null;
  evidence.upload=null;
  label.textContent='尚未上传';
  const file=input.files?.[0];
  if(!file)return;
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024)throw Error('仅支持2MB以内PNG/JPEG/WebP图片');
  const upload=Symbol();
  evidence.upload=upload;
  const current=()=>form.isConnected&&locationEvidence.get(form)===evidence&&evidence.upload===upload;
  label.textContent='正在上传照片…';
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(!current())return;
    let binary='';
    for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    const photo=await api('/files',{method:'POST',body:{name:file.name,type:file.type,base64:btoa(binary)}});
    if(!current())return;
    evidence.photo=photo;
    label.textContent='已上传私有附件：'+photo.name;
  }catch(error){
    if(!current())return;
    label.textContent='尚未上传';
    input.value='';
    throw error;
  }finally{
    if(current())evidence.upload=null;
  }
}
function locationEvidenceForWrite(form){
  const evidence=evidenceFor(form);
  if(evidence.capture||evidence.upload)throw Error('请等待位置和照片采集完成。');
  return evidence;
}
function canReviewRequest(r){
  if(r.unavailableActions?.includes(r.type==='reportRevoke'?'review.revoke':'review.request'))return false;
  if(r.status!=='pending')return false;
  if(r.type==='reportRevoke')return session.actor==='finance';
  if(r.type==='accountChange')return session.actor==='manager';
  if(['pauseFee','exemptException'].includes(r.type))return ['manager','finance'].includes(session.actor);
  return ['manager','ops'].includes(session.actor);
}
function requestCard(r,withHistory=false){
 const progress=r.progress;
 const badge=progress?'<span class="pill '+(progress.stage==='credited'?'good':'warn')+'">'+esc(progress.label)+'</span>':chip(r.status);
 const guidance=progress?notice(progress.description+(progress.month?' 账期 '+progress.month+'。':'')):'';
 const creditBill=progress?.billId&&canReadBillingLedger()?button('查看原抵扣账单','billing-detail',{id:progress.billId}):'';
 const title=r.type==='accountChange'&&r.data?.change==='mobile'?'变更登记手机号':reqNames[r.type]||r.type;return `<section class="record"><div class="record-top"><div><h3>${esc(title)}</h3><small>${esc(r.id)} · ${esc(r.data?.name||name(r.outlet))}</small></div>${badge}</div>${guidance}${creditBill}${Object.entries(r.data||{}).filter(([k])=>!['coords','photo','attachments','change'].includes(k)).map(([k,val])=>pair(({reason:'申请原因',address:'地址',name:'名称',from:'开始日期',to:'结束日期',locationStatus:'位置核验',countryCode:'国家或地区代码',province:'省',city:'城市',district:'区县',opening:'预计开业',phone:'联系电话',note:'说明',managerName:'申请新负责人',mobile:'申请新手机号',evidenceReference:'核验材料索引'}[k]||k),typeof val==='object'?JSON.stringify(val):labels[val]||val)).join('')}${r.publicNote?pair('申请人可见说明',r.publicNote):''}${r.internalReviewNote?pair('总部内部审批意见',r.internalReviewNote):''}${r.financeReviewNote?pair('财务内部复核备注',r.financeReviewNote):''}${assignmentNotice(r,r.type==="reportRevoke"?"review.revoke":"review.request")}${canReviewRequest(r)?form(r.type==='reportRevoke'?'review.revoke':'review.request',field('id','',r.id,'hidden')+select('decision','处理决定',[['approve','审批通过'],['return','退回'],...(r.type==='reportRevoke'?[]:[['supplement','要求补充']])])+area('note','内部审批意见（退回或补件必填）','','maxlength="800"')+area('publicNote','申请人可见处理说明（选填）','','maxlength="800"')+submit('记录审批结果')):''}${own()&&r.type!=='reportRevoke'&&['returned','supplement'].includes(r.status)?form('request.supplement',field('id','',r.id,'hidden')+area('note','补充解释 / 证明说明')+submit('重新提交补充资料')):''}${withHistory?approval.mount('requests',r.id):approval.trigger('requests',r.id)}</section>`}
function requests(){let t=ui.requestType;return heading('业务申请与审批','提交、核验、审批、结果通知，保持同一条业务记录。')+pageControls()+(own()?panel('发起申请',select('requestType','申请类型',Object.entries(reqNames).filter(([k])=>k!=='reportRevoke'),t,'data-filter="requestType"')+form('request.submit',field('type','',t,'hidden')+(t==='newOutlet'?field('name','网点名称','','text','required')+field('countryCode','国家或地区代码（选填）','','text','maxlength="2" pattern="[A-Za-z]{2}" placeholder="留空为中国大陆，例如境外填写 SG"')+`<div class="form-grid">${field('province','省（境外可留空）','','text')}${field('city','城市','','text','required')}</div>`+field('district','区县（境外可留空）','','text')+field('address','实际地址','','text','required')+field('phone','联系电话','','tel','required')+field('opening','预计开业日期','2026-12-01','date','required')+mapFields():writeOutletSelect('关联网点')+(t==='pauseFee'?field('from','暂停开始','2026-11-20','date','required')+field('to','暂停结束','2026-11-30','date','required'):t==='locationChange'?field('address','申请新地址','','text','required')+mapFields():t==='enrollment'?select('applicable','招生业务适用性',[['true','适用'],['false','不适用']]):t==='statusChange'?select('status','新状态',[['paused','暂停营业'],['open','恢复营业'],['closed','关闭']])+field('effectiveDate','生效日期','2026-11-18','date','required'):t==='exemptException'?field('month','原免报月份','2026-10','month','required'):field('managerName','新负责人','','text','required')+field('mobile','新手机号','','tel','required')+field('evidenceReference','身份核验材料编号 / 受控档案位置（如适用）','','text','maxlength="500"')))+area('reason','申请说明与依据')+submit('提交申请'))):'') +((state.requests||[]).slice().reverse().map(r=>requestCard(r)).join('')||collectionEmpty('暂无业务申请记录。'))+notice('停费批准只进入待财务核算；招生适用性生效、免报财务例外、换绑核验等细则未确定时保留待集团确认。')}
function verificationReview(id,isRequest=false){
  return form('location.review',field('id','',id,'hidden')+select('decision','核验结论',[['approve','核验通过'],['exception','异常，要求解释证明']])+area('note','人工核验依据')+area('publicNote',isRequest?'申请人可见处理说明（选填）':'用户可见处理说明（选填）','','maxlength="800"')+submit('记录位置核验'));
}
function requestLocationCard(r,withHistory=false){return panel('申请位置核验 · '+esc(r.id),pair('地址',r.data.address)+pair('坐标来源',r.data.coords?.source)+pair('照片',r.data.photo?.name||'无')+(r.data.photo?.id?button('查看现场照片','view-photo',{id:r.data.photo.id}):'')+(assignmentNotice(r,'location.review')||(session.actor==='location'&&(withHistory||r.status==='pending')&&r.data.locationStatus==='pending'?verificationReview(r.id,true):chip(r.data.locationStatus)))+(withHistory?'':approval.trigger('requests',r.id)))}
function verificationCard(r,withHistory=false){return panel(esc(r.outletName||name(r.outlet))+' · '+esc(r.month),pair('状态',labels[r.status]||r.status)+pair('地址',r.address)+pair('位置来源',r.coords?.source==='gps'?'主动现场GPS':r.coords?.source==='manual'?'手动选点（非现场GPS）':'开发模拟坐标')+pair('坐标系',r.coords?.coordinateSystem||'未明确')+pair('定位精度（米）',r.coords?.accuracy)+pair('采集时间',r.coords?.capturedAt||r.capturedAt)+pair('与基准距离（米）',fmt(r.assessment?.distanceMeters,'revenue'))+pair('已配置阈值（米）',r.assessment?.thresholdMeters)+pair('偏差判定',({pending:'待人工核验',manual:'手动选点，不能替代现场GPS',unconfigured:'阈值未配置，待人工核验',outside_threshold:'超出已配置偏差范围',coordinate_mismatch:'坐标系不同，未计算偏差，待人工核验',baseline_unconfirmed:'尚无已确认基准，未计算偏差'}[r.assessment?.result]||r.assessment?.result||'待核验'))+pair('现场照片',r.photo?.name||'附件')+(r.photo?.id?button('查看现场照片','view-photo',{id:r.photo.id}):'')+pair('说明',r.explanation||'—')+(session.actor==='location'&&r.status==='pending'?(assignmentNotice(r,'location.review')||verificationReview(r.id)):'')+(withHistory?approval.mount('verifications',r.id):approval.trigger('verifications',r.id)))}
function locations(){
 const showingRequests=pageCollection()==='requests';
 const requests=state.requests||[];
 const verifications=state.verifications||[];
 const mainRows=showingRequests?requests.map(r=>requestLocationCard(r)):verifications.slice().reverse().map(r=>verificationCard(r));
 const related=!showingRequests&&showRelatedCollections()&&requests.length
  ? '<section aria-label="待处理的位置申请"><h2 class="section-title">待处理的位置申请</h2>'+requests.map(r=>requestLocationCard(r)).join('')+'</section>' : '';
 return heading('位置核验','主动提交位置与现场照片，由专岗完成人工核验。')+pageControls()+notice('手动选点与现场 GPS 分开留痕；只有坐标系明确且已确认基准后才计算偏差。未配置阈值时保持待人工核验，系统不自动判定通过。',true)+(session.actor==='location'?panel('确认网点位置基准',form('location.baseline.confirm',writeOutletSelect('确认网点')+notice('请填写经核验的 GCJ-02 基准坐标及受控材料编号。浏览器 GPS 原始数据为 WGS-84，不能直接标记为 GCJ-02。',true)+`<div class="form-grid">${field('latitude','GCJ-02 纬度','','number','required min="-90" max="90" step="any"')}${field('longitude','GCJ-02 经度','','number','required min="-180" max="180" step="any"')}</div>`+field('reference','核验材料 / 地图基准来源','','text','required')+area('reason','确认依据')+submit('记录已确认位置基准'))):'')+(own()?panel('提交月度核验',form('location.submit',writeOutletSelect('核验网点')+field('month','核验月份',state.today.slice(0,7),'month','required')+field('address','当前实际经营地址','','text','required')+mapFields()+area('explanation','异常解释 / 证明说明（如适用）','','maxlength="1000"')+submit('提交核验资料'))):'')+related+(mainRows.join('')||collectionEmpty(showingRequests?'暂无位置相关申请记录。':'暂无月度位置核验记录。'));}
function billing(){
 const paymentVisible=canReadBillingLedger(),selected=pageCollection(),rows=state.bills||[];
 const showRelated=showRelatedCollections();
 const filters=`<div class="filters">${field('billingMonth','账单与汇总账期',ui.billingMonth||'','month','data-filter="billingMonth" aria-describedby="billing-month-scope"')}<span id="billing-month-scope">${ui.billingMonth?esc(ui.billingMonth):'全部账期'}</span>${ui.billingOutlet?pair('网点范围',name(ui.billingOutlet))+button('全部网点','billing-outlet'):''}${paymentVisible?button('导出账务 CSV','billing-export',{},'','download'):''}</div>`;
 const controls=['manager','finance'].includes(session.actor)?button('账单追补待复核','billing-catchup'):''; 
 const overview=paymentVisible?financeLedger.overview(state.finance)+controls:'';
 const billAmounts=paymentVisible?financeLedger.amounts:[['amount','应收金额']];
 const bills=selected==='bills'?`<section class="panel"><div class="panel-head"><h3>自然月应收账单</h3></div>
  ${rows.length?`<div class="table-wrap"><table><thead><tr><th>网点 / 账期</th>${billAmounts.map(([,label])=>`<th>${label}</th>`).join('')}<th>状态</th><th>操作</th></tr></thead><tbody>
  ${rows.map(b=>`<tr><td><strong>${esc(b.outletName||name(b.outlet))}</strong><small>${esc(b.month)} · ${esc(b.id)}</small></td>
  ${billAmounts.map(([key])=>`<td>${esc(financeLedger.cents(paymentVisible?b.ledger?.[key]:Math.round(b.amount*100)))}</td>`).join('')}<td>${chip(b.status)}</td>
  <td>${paymentVisible?button('账单详情','billing-detail',{id:b.id}):''}${own()&&b.status==='unpaid'&&config.devLoginEnabled?button('模拟付款','pay',{id:b.id}):''}</td></tr>`).join('')}</tbody></table></div>`:collectionEmpty('暂无应收账单。')}</section>`:'';
 const receipts=selected==='receipts'?panel('实收流水',(state.receipts||[]).map(r=>`<article class="record">${pair('凭证编号',r.id)}${pair('实收金额',financeLedger.cents(Math.round(r.amount*100)))}${pair('登记来源',r.adapterMode)}${button('关联账单','billing-detail',{id:r.billId})}</article>`).join('')||collectionEmpty('暂无实收流水。')):'';
 const payments=paymentVisible&&(selected==='payments'||showRelated)?panel('付款尝试与结果',(state.payments||[]).slice().reverse().map(p=>`<div class="record">${pair('支付订单',p.id)}${pair('关联账单',p.billId)}${pair('金额',fmt(p.amount,'revenue'))}${pair('状态',p.status==='pending'?'待确认':labels[p.status]||p.status)}${p.adapterMode==='real'&&(own()||['manager','finance'].includes(session.actor))?`<div class="actions">${button('核验支付状态','payment-query',{id:p.id},'primary')}${p.status==='pending'?button('关闭已到期订单','payment-close',{id:p.id}):''}</div>`:''}${own()&&p.adapterMode!=='real'&&p.status==='pending'&&config.devLoginEnabled?`<div class="actions">${button('模拟成功','payment-result',{id:p.id,outcome:'success'},'primary')}${button('模拟失败','payment-result',{id:p.id,outcome:'failed'})}${button('取消','payment-result',{id:p.id,outcome:'cancelled'})}</div>`:''}</div>`).join('')||(selected==='payments'?collectionEmpty('暂无付款尝试。'):empty('还没有付款尝试'))):'';
 const adjustments=selected==='adjustments'||showRelated?panel('独立费用调整',(state.adjustments||[]).map(a=>adjustmentCard(a)).join('')||(selected==='adjustments'?collectionEmpty('暂无费用调整。'):empty('暂无待核算调整'))):'';
 return heading('服务费管理','按账期和授权网点核对服务费账务。')+
  (config.devLoginEnabled?notice('开发环境中的测试账单及模拟交易只用于验证。',true):'')+filters+
  overview+pageControls()+bills+receipts+payments+adjustments+(own()?button('申请暂停收费','new-request',{type:'pauseFee'}):'');
}
function supportManagement(record,manager){
  if(!manager||!record.severe||!record.assignee||record.status==='closed')return '';
  const recipient=record.channel==='wechat'?'用户可见回复（选填，进入公众号发送队列）':'用户可见回复（选填）';
  return form('support.management',field('id','',record.id,'hidden')+
    area('note','内部处理结论（仅总部可见）')+
    area('customerReply',recipient,'','maxlength="2000"')+submit('登记处理结论'));
}
function supportChat(c,{service,manager,user},withHistory=false){
  const actions=service&&c.status==='active'
    ?form('support.reply',field('id','',c.id,'hidden')+field('text','人工回复','','text','required')+submit('回复咨询'))
    :service&&c.status==='queued'?button('接待人工咨询','claim',{id:c.id}):'';
  const escalation=service&&c.assignee===session.subject&&!c.severe&&['active','waiting'].includes(c.status)
    ?'<details><summary>升级管理层处理</summary>'+form('support.escalate',field('id','',c.id,'hidden')+
      area('reason','内部升级原因')+submit('确认升级'))+'</details>':'';
  return panel('会话 '+esc(c.id),
    ((service||manager)&&c.channel==='wechat'?button('查看公众号送达状态','official-delivery',{id:c.id}):'')+
    (c.messages||[]).map(m=>`<div class="chat ${['support','manager','faq'].includes(m.by)?'staff':''}">${esc(m.text)}</div>`).join('')+
    (user?button('自主选择转人工','human',{id:c.id}):'')+actions+escalation+supportManagement(c,manager)+
    (withHistory?approval.mount('supportChats',c.id):approval.trigger('supportChats',c.id)));
}
function supportTicketImages(ids){
 return ids?.length?'<div class="actions" aria-label="工单图片">'+ids.map((id,index)=>button('查看图片 '+(index+1),'view-photo',{id,context:'support'})).join('')+'</div>':'';
}
function supportTicket(t,{service,manager,user},withHistory=false){return `<section class="record"><div class="record-top"><div><h3>${esc(t.title)}</h3><small>${esc(t.id)} · ${esc(name(t.outlet))} · ${esc(t.channel)}</small></div>${chip(t.status)}</div><p>${esc(t.description)}</p>${supportTicketImages(t.attachmentIds)}${pair('客服负责人',t.assignee||t.assignedTo||'待自行接单')}${t.channel==='phone'?pair('电话登记人',t.registeredBy||'历史记录未注明')+pair('来电人类型',t.customerType==='partner'?'加盟商负责人':'消费者'):''}${t.linkedTicketId?pair('关联原工单',t.linkedTicketId):''}${(service||manager)&&t.contact?pair('回访联系方式',t.contact):''}${(service||manager)&&t.collaborations?.length?'<h4>内部协作记录</h4>'+t.collaborations.map(item=>pair(item.department,item.note)).join(''):''}${(t.messages||t.trail||[]).map(m=>`<div class="chat">${esc(m.text||m.note||m.action)}</div>`).join('')}${service&&t.status==='queued'?button('自行接单','claim',{id:t.id},'primary'):''}${service&&['active','processing','waiting'].includes(t.status)?form('support.action',field('id','',t.id,'hidden')+select('operation','处理动作',[['reply','人工回复'],['requestSupplement','请用户补充资料'],['collaborate','内部协作'],['escalate','升级管理层'],['close','标记完成并关闭']])+select('department','协作部门',['运营','财务','加盟商'])+area('text','处理说明')+submit('记录处理')):''}${supportManagement(t,manager)}${user&&t.status==='waiting'?form('support.supplement',field('id','',t.id,'hidden')+area('text','补充资料')+submit('提交补充')):''}${user&&t.status==='closed'&&!t.rating?form('support.rate',field('id','',t.id,'hidden')+select('rating','仅评价人工客服服务',[['5','5分 满意'],['4','4分'],['3','3分'],['2','2分'],['1','1分 不满意']])+submit('提交评价')):''}${t.rating?pair('人工服务评价',(t.rating.score||t.rating)+'分'):''}${withHistory?approval.mount('supportTickets',t.id):approval.trigger('supportTickets',t.id)}</section>`}
function support(){
 const q=state.support||{tickets:[],chats:[],settings:{}},service=session.actor==='support',manager=session.actor==='manager',user=own()||session.actor==='public';
 const showingChats=pageCollection()==='support.chats';
 const chats=q.chats.map(c=>supportChat(c,{service,manager,user})).join('');
 const tickets=q.tickets.slice().reverse().map(t=>supportTicket(t,{service,manager,user})).join('');
 const chatList=showingChats?(chats||collectionEmpty('暂无咨询会话。'))
  :showRelatedCollections()&&chats?'<section aria-label="近期咨询会话"><h2 class="section-title">近期咨询会话</h2>'+chats+'</section>':'';
 const ticketList=showingChats?'':tickets||collectionEmpty('暂无正式工单。');
 return heading(service?'客服统一队列':'客服中心','普通咨询与正式工单分开；内部协作不转移客服负责人。')+pageControls()+panel('电话服务',q.settings.phone?`<a class="button" href="tel:${esc(q.settings.phone)}">${I('chat')} ${esc(q.settings.phone)}</a><p class="muted">服务时间：${esc(q.settings.hours||'尚未配置')}</p>`:notice('客服电话尚未配置，请使用在线人工咨询。',true))+notice('外部公众号与电话由实际接入状态决定；电话代登记仅记录工作人员接听后的业务事实。',true)+(user?panel('常见问题与人工咨询',`<div class="actions">${button('月报报送说明','faq',{text:'请按总部公布的期限报送。逾期仍可补报，退回后按意见修改并重新提交。'})}${button('服务费规则','faq',{text:'暂停营业不自动停费。单独申请停费，批准后进入待财务核算。'})}</div>`+form('support.chat',field('text','普通咨询内容','','text','required')+submit('发送咨询'))):'')+chatList+(user||service?panel(service?'电话客服代登记':'新建正式工单',form('support.ticket',writeOutletSelect('关联网点')+select('category','业务类型',[['complaint','投诉'],['aftersale','售后'],['exception','业务异常']])+select('channel','来源渠道',service?[['phone','电话客服代登记']]:session.actor==='public'?[['miniprogram','消费者小程序'],['wechat','微信公众号（开发适配）']]:[['miniprogram','加盟商小程序'],['phone','电话客服（开发登记）']])+(service?select('customerType','来电人类型',[['consumer','消费者来电'],['partner','加盟商负责人来电']]):'')+field('title','问题标题','','text','required minlength="2"')+area('description','具体问题（不要填写真实敏感信息）')+field('contact','回访联系方式（选填）')+select('linkedTicketId','关联已关闭旧单',[['','不关联'],...(q.tickets||[]).filter(x=>x.status==='closed').map(x=>[x.id,x.id])])+submit('提交正式工单'))):'')+ticketList+(manager?panel('服务时间与响应配置',form('support.settings',field('phone','客服电话（留空表示未配置）',q.settings.phone||'','tel','maxlength="40"')+field('hours','客服服务时间',q.settings.hours||'待集团确认','text','required')+field('complaint','投诉首次响应时限',q.settings.sla?.complaint||'待集团确认')+field('aftersale','售后首次响应时限',q.settings.sla?.aftersale||'待集团确认')+field('exception','异常首次响应时限',q.settings.sla?.exception||'待集团确认')+submit('保存客服配置'))):'')}
function coverage(){const v=data.reportingCoverage;if(!v)return '';return panel('报送覆盖与业务完整性',`<div class="coverage-grid">${[['expected','应报网点月'],['submitted','已报送'],['pendingReview','待审核'],['approved','当前已通过'],['settled','已结算'],['exempt','已核验免报'],['overdue','逾期未报'],['lateSubmitted','逾期补报'],['overdueExemptReview','逾期未核验免报'],['notApplicable','招生不适用'],['awaitingEnrollment','招生待确认'],['notRequired','无报送义务']].map(([k,t])=>pair(t,v[k])).join('')}</div>`+notice(v.complete?'当前范围报送与核验完整；金额是否计入仍以所选数据层为准。':'当前范围尚未完整，请结合待审核、逾期与待确认分别处理。免报和不适用不作零值补齐。',true)+(data.reportDeadlines&&ui.kind==='month'?pair('报送截止日期',data.reportDeadlines[ui.period]?.dueOn||'待配置'):''),'单位为网点 × 月份')}
function analyticsPager(){const p=data.pagination;if(!p)return '';return `<div class="list-controls bottom"><div class="pagination"><span>共 <b>${p.total}</b> 家 · ${p.total?p.offset+1:0}—${Math.min(p.offset+p.limit,p.total)}；上方总额覆盖全部筛选范围</span>${button('上一页','analytics-prev',{},'', '')}${button('下一页','analytics-next',{},'', '')}</div></div>` .replace('data-action="analytics-prev"',`data-action="analytics-prev" ${p.offset===0?'disabled':''}`).replace('data-action="analytics-next"',`data-action="analytics-next" ${!p.hasMore?'disabled':''}`)}
function analyticsTable(){const keys=Object.keys(data.totals||{});return `<div class="table-wrap"><table><thead><tr><th>网点</th>${keys.map(k=>`<th>${metrics[k]}（${units[k]}）</th>`).join('')}<th>审核 / 应报</th><th>免报 / 逾期</th><th>招生不适用 / 待确认</th></tr></thead><tbody>${(data.rows||[]).map(r=>{const v=r.reportingCoverage;return `<tr><td>${esc(r.name)}</td>${keys.map(k=>`<td>${fmt(r[k],k)}</td>`).join('')}<td>${v?`${v.approved} / ${v.expected}`:`${r.coverage} / ${r.expectedMonths}`}</td><td>${v?`${v.exempt} / ${v.overdue}`:'—'}</td><td>${v?`${v.notApplicable} / ${v.awaitingEnrollment}`:'—'}</td></tr>`}).join('')}</tbody></table></div>`}
function adjustmentCard(record,withHistory=false){
  return `<article class="record"><h3>费用调整 · ${esc(record.outletName || name(record.outlet))}</h3>${pair('关联申请',record.requestId)}${pair('状态',labels[record.status]||record.status)}${record.amount!=null?pair('金额（元）',fmt(record.amount,'revenue')):''}${record.offsetMonth?pair('抵扣月份',record.offsetMonth):''}${withHistory?approval.mount('adjustments',record.id):approval.trigger('adjustments',record.id)}</article>`;
}
function summaryAdjustmentCard(record,withHistory=false){
  const canReview=record.status==='finance'?session.actor==='finance':
    record.status==='pending'&&['manager','ops'].includes(session.actor);
  const body=pair('记录编号',record.id)+pair('状态',labels[record.status]||record.status)+
    Object.entries(record.values||{}).map(([metric,value])=>pair(metrics[metric]||metric,fmt(record.before?.[metric],metric)+' → '+fmt(value,metric))).join('');
  const review=canReview?form('review.adjust',field('id','',record.id,'hidden')+
    select('decision','复核结果',[['approve','通过'],['return','退回']])+area('note','复核意见')+submit('确认复核')):'';
  const history=withHistory?approval.mount('summaryAdjustments',record.id):approval.trigger('summaryAdjustments',record.id);
  return `<article class="record">${body}${review}${history}</article>`;
}
function focusedBusiness(task,record,replacement){
  const kind=task.businessType;
  const supportRole={service:session.actor==='support',manager:session.actor==='manager',user:own()||session.actor==='public'};
  switch(kind){
    case 'reports':{
      const refile=own()&&record.status==='returned'?button('修改并重新报送','task-report-form',{outlet:record.outlet,month:record.month},'primary'):'';
      return reportCard(record,true)+refile;
    }
    case 'requests':{
      const locationRecord=session.actor==='location'&&['newOutlet','locationChange'].includes(record.type);
      return (locationRecord?requestLocationCard(record,true):'')+requestCard(record,true);
    }
    case 'verifications':return verificationCard(record,true);
    case 'summaryAdjustments':return summaryAdjustmentCard(record,true);
    case 'settlements':return taskDesk.resettlement(task,record,replacement);
    case 'supportTickets':return supportTicket(record,supportRole,true);
    case 'supportChats':return supportChat(record,supportRole,true);
    case 'adjustments':return adjustmentCard(record,true)+(record.status==='待财务核算调整'&&['manager','ops'].includes(session.actor)?button('提出费用调整','op-form',{cmd:'fee.adjust.propose',id:record.id,collection:'adjustments'}):'');
    case 'outlets':
      return panel('网点档案',pair('记录编号',record.id)+pair('网点',record.name)+pair('状态',labels[record.status]||record.status)+pair('地址',record.address)+button('打开网点档案','store',{id:record.id}));
    case 'bills':
      return panel('应收账单',pair('账单编号',record.id)+pair('网点',record.outletName||name(record.outlet))+pair('账期',record.month)+pair('应收（元）',fmt(record.amount,'revenue'))+pair('状态',labels[record.status]||record.status)+pair('账单截止',record.dueOn));
    default:return panel('业务记录',op.recordMarkup(kind,record)+op.focusedActions(kind,record)+approval.mount(kind,record.id));
  }
}
function settlementNotice(){
 const {state:status,pendingMonths=[],refreshingMonths=[]}=data.settlementStatus||{};
 const link=session.actor==='manager'?'<a class="button" href="#queue=hq&amp;kind=report_resettlement">查看重结算待办</a>':'';
 if(status==='pending_resettlement')return notice('经营数据更新中。'+pendingMonths.join('、')+' 的经营数据正在重新核算，完成后将更新经营看板。',true)+link;
 if(refreshingMonths.length)return notice('已结算数据更新中。'+refreshingMonths.join('、')+' 的已结算数据将在更新完成后恢复显示。',true)+link;
 return status==='resettled'?notice('经营数据已更新。',true):'';
}
function analytics(){return heading('经营数据看板','只汇总当前有效审核版本，正式数据须完成月度结算。',state.capabilities?.export?`<div class="actions">${button('Excel','export',{format:'xlsx'},'','download')}${button('PDF','export',{format:'pdf'},'primary','download')}</div>`:'')+`<div class="filters">${field('period','观察月份',ui.period,'month','data-filter="period"')}${select('kind','汇总周期',[['month','月度'],['quarter','季度'],['year','年度']],ui.kind,'data-filter="kind"')}${select('mode','数据层',[['settled','已结算正式'],['process','已审过程数据']],ui.mode,'data-filter="mode"')}${field('scopeQ','查找网点 / 加盟商',ui.scopeQ||'','search','data-filter="scopeQ" placeholder="输入名称或编号，检索全部授权记录"')}${select('outlet','网点范围',[['all','全部授权网点'],...(state.outlets||[]).map(o=>[o.id,o.name])],ui.outlet,'data-filter="outlet"')}${staff()?select('owner','汇总范围',[['all','全集团'],...(state.organizations||[]).map(org=>[org.id,org.name||org.id])],ui.owner,'data-filter="owner"'):''}</div>${(state.pagination?.outlets?.total>200||state.pagination?.organizations?.total>200)?notice('选择列表显示前200条匹配记录，请使用名称或编号检索缩小范围。统计仍按已选范围完整计算。',true):''}${settlementNotice()}${statCards()}${coverage()}${data.partial?notice('所选自然月并非均有可统计的有效数据。免报、无报送义务、未审核或未结算均可能产生空值；请结合报送覆盖分别判断，金额不补零。'):''}<div class="grid">${panel('近六月趋势',chart(),'人民币元')}${panel('数据与方法',pair('统计范围',(data.months||[]).join('、'))+pair('计算方法',data.methodVersion||'整数分求和')+pair('数据层',ui.mode==='settled'?'已结算正式数据':'审核通过过程数据')+Object.keys(data.totals||{}).map(k=>{const rate=b=>data.partial||b?.partial||data.totals[k]==null||b?.totals?.[k]==null?'数据周期不完整':b.totals[k]===0?'基期为零':((data.totals[k]-b.totals[k])/b.totals[k]*100).toFixed(1)+'%';return pair(metrics[k],`环比 ${rate(ui.comparison?.[0])} / 同比 ${rate(ui.comparison?.[1])}`)}).join('')+notice('退款归属、异常阈值及不可比口径待集团确认。',true))}</div><section class="panel"><div class="panel-head"><h3>${own()?'本人网点对比':'网点汇总'}</h3></div>${analyticsTable()}${analyticsPager()}</section>${session.actor==='manager'?panel(data.rankings?'全范围四项排名 · 前20名':'当前页四项排序',Object.keys(data.totals||{}).map(k=>`<h3 class="section-title">${metrics[k]}</h3>${(data.rankings?.[k]||(data.rows||[]).filter(r=>r[k]!=null).sort((a,b)=>b[k]-a[k])).map((r,i)=>pair(`${r.rank||i+1}. ${r.name}`,fmt(r[k],k))).join('')||empty('本期暂无可排名数据')}`).join(''),'仅总部管理层可见')+panel('月度统一结算',form('settle',field('month','结算月份',ui.period,'month','required')+submit('确认结算有效数据'))):''}${['finance','manager'].includes(session.actor)?panel('汇总层调整',notice('不覆盖原始月报；收入调整必须经过财务复核。')+(session.actor==='manager'?form('summary.adjust',select('outlet','调整网点',(state.outlets||[]).map(o=>[o.id,o.name]))+field('month','调整月份',ui.period,'month','required')+select('metric','指标',Object.entries(metrics))+field('value','调整后数值','','number','required min="0" step="0.01"')+area('reason','调整原因')+submit('提交汇总调整')):'')+(state.summaryAdjustments||[]).map(a=>summaryAdjustmentCard(a)).join('')):''}`}
function agencyPanel(){
 const orgs=state.organizations||[],rels=state.agencyRelations||[],orgName=id=>orgs.find(o=>o.id===id)?.name||id;
 const levelText=level=>level===1?'一级代理':level===2?'二级代理':'未设置（历史主体）';
 const active=rels.filter(r=>r.status==='active'),history=rels.filter(r=>r.status!=='active');
 const parentOptions=orgs.filter(o=>o.level===1).map(o=>[o.id,o.name||o.id]),childOptions=orgs.filter(o=>o.level===2).map(o=>[o.id,o.name||o.id]);
 return panel('代理层级与直属关系',notice('历史主体未设置级别时保持原业务，不推断级别。换绑或解绑后，原一级的下级进度查询与催报权限立即失效；历史关系保留审计记录。',true)+
  (orgs.length?orgs.map(o=>pair(o.name||o.id,levelText(o.level??null))).join(''):empty('暂无加盟主体。'))+
  form('agency.level',select('owner','加盟主体',orgs.map(o=>[o.id,o.name||o.id]))+select('level','代理级别',[['','未设置（历史主体）'],['1','一级代理'],['2','二级代理']])+area('reason','设置依据')+submit('保存主体级别'))+
  form('agency.bind',select('parentOwner','一级代理',parentOptions)+select('childOwner','二级代理',childOptions)+'<label class="check"><input name="replaceActive" type="checkbox" value="true">该二级已绑定其他一级时，确认换绑并撤销原关系</label>'+area('reason','绑定依据')+submit('绑定直属关系'))+
  (active.length?active.map(r=>'<div class="record"><div class="record-top"><h3>'+esc(orgName(r.parentOwner))+' → '+esc(orgName(r.childOwner))+'</h3>'+chip(r.status)+'</div><small>生效 '+esc(r.effectiveAt||String(r.createdAt||'').slice(0,10))+' · '+esc(r.reason||'')+'</small>'+form('agency.unbind',field('id','',r.id,'hidden')+area('reason','解绑依据')+submit('解除直属绑定'))+'</div>').join(''):notice('尚未建立直属绑定。',true))+
  (history.length?'<details><summary>历史直属关系（'+history.length+'）</summary>'+history.map(r=>pair(orgName(r.parentOwner)+' → '+orgName(r.childOwner),'已解除 · '+String(r.revokedAt||'').slice(0,10)+' · '+(r.revokedReason||''))).join('')+'</details>':''),'总部维护');
}
function accounts(){const manager=session.actor==='manager',q=state.grants||{outlets:[],metrics:[],reviewOutlets:[]};return heading('账号与权限','一个加盟商对应一个负责人，所有数据按主体隔离。')+pageControls()+((state.accounts||[]).map(a=>panel(a.managerName||a.owner,pair('主体',a.owner)+pair('账号状态',labels[a.status]||a.status)+pair('绑定版本',a.bindingVersion)+pair('手机号',a.mobile)+(manager?button('签发激活码','activation',{actor:a.actor||('partner:'+a.owner)}):'')+(manager?form('account.update',field('owner','',a.owner,'hidden')+field('managerName','当前负责人（变更须走换绑审批）',a.managerName,'text','readonly')+select('status','账号状态',[['active','正常'],['pending','待激活'],['locked','临时锁定'],['frozen','冻结'],['disabled','停用']],a.status)+area('reason','核验依据')+submit('更新账号状态')):'')+ownerHistory(a))).join('')||collectionEmpty('暂无账号记录。'))+(manager?panel('创建加盟商及唯一负责人',form('account.create',field('name','加盟商名称','','text','required')+field('managerName','负责人','','text','required')+field('mobile','手机号','','tel','required')+submit('创建主体与账号')))+agencyPanel()+(config.devLoginEnabled?panel('开发内置区域账号授权',form('grant.set',`<h3 class="section-title">可见网点</h3>${(state.outlets||[]).map(o=>`<label class="check"><input name="outlets" type="checkbox" value="${o.id}" ${q.outlets.includes(o.id)?'checked':''}>${esc(o.name)}</label>`).join('')}<h3 class="section-title">可见经营指标</h3>${Object.entries(metrics).map(([k,n])=>`<label class="check"><input name="metrics" type="checkbox" value="${k}" ${q.metrics.includes(k)?'checked':''}>${n}</label>`).join('')}<h3 class="section-title">额外月报审核权限</h3>${(state.outlets||[]).map(o=>`<label class="check"><input name="reviewOutlets" type="checkbox" value="${o.id}" ${q.reviewOutlets.includes(o.id)?'checked':''}>${esc(o.name)}</label>`).join('')}`+submit('保存授权范围'))):panel('区域运营个人授权',notice('按员工个人账号设置可见网点、指标、审核范围及有效期。',true)+button('管理个人授权','nav',{page:'team'}))):'')}
function messages(){return heading('消息中心','通知已读不等于业务完成。')+pageControls()+((state.messages||[]).slice().reverse().map(m=>`<div class="record"><div class="record-top"><h3>${esc(m.title)}</h3>${chip(m.read?'已读':'未读')}</div><p>${esc(m.body)}</p><small>${esc(m.createdAt)}</small><div class="actions">${m.read?'':button('标为已读','read',{id:m.id})}</div></div>`).join('')||collectionEmpty('暂无通知。'));}
function updateContentCover(editor,id){
 const actions=editor.querySelector('[data-content-cover-actions]');
 editor.querySelector('[name=imageId]').value=id;
 actions.querySelector('[data-action=view-photo]').dataset.id=id;
 const preview=actions.querySelector('[data-cover-preview]');
 if(preview){preview.hidden=true;preview.removeAttribute('src');}
 actions.style.display=id?'':'none';
}
async function uploadContentCover(input){
 const file=input.files?.[0];
 if(!file)return;
 const editor=input.closest('form'),save=editor.querySelector('button[type=submit]');
 try{
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024)throw Error('仅支持2MB以内PNG/JPEG/WebP图片');
  input.disabled=true;
  save.disabled=true;
  const bytes=new Uint8Array(await file.arrayBuffer());
  let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  const purpose=input.dataset.imagePurpose;
  const saved=await api('/files',{method:'POST',body:{name:file.name,type:file.type,base64:btoa(binary),...(purpose?{purpose}:{})}});
  updateContentCover(editor,saved.id);
  toast(purpose==='public-outlet-photo'?'店照已上传，保存并发布后公开':'封面已上传，保存并发布后公开');
 }finally{
  input.disabled=false;
  input.value='';
  save.disabled=false;
 }
}
function contentPublication(record,versions){
  if(!record)return '';
  const live=record.publishedSnapshot||(record.status==='published'?record:null);
  const sourceOptions=versions.filter(v=>v.status==='published'&&v.snapshot?.status==='published'&&v.version!==live?.version);
  const actionFields=action=>field('key','',record.key,'hidden')+field('action','',action,'hidden')+field('expectedVersion','',record.version||1,'hidden');
  const withdraw=live?form('content.publication',actionFields('withdraw')+area('reason','撤回原因')+submit('撤回公开资料')):'';
  const restore=sourceOptions.length?form('content.publication',actionFields('restore')+
    select('sourceVersion','恢复已发布的历史版本',sourceOptions.map(v=>[v.version,'V'+v.version+' · '+(v.snapshot.title||'历史内容')]))+
    area('reason','恢复原因')+submit('恢复并发布')):'';
  return panel('发布管理',notice(live?'当前公开版本 V'+(live.version||1)+' · '+live.title:'当前暂无公开版本',true)+withdraw+restore);
}
function content(){
  const key=ui.contentKey||'brand',r=state.contents?.find(x=>x.key===key),slot=Number(key.replace('service-','')),service=/^service-[1-5]$/.test(key);
  const logo=key==='brand-logo',address=key==='headquarters-address',wechat=key==='official-wechat';
  const withCover=service||key==='brand'||logo||wechat;
  const versions=(state.contentVersions||[]).filter(x=>x.key===key).sort((a,b)=>b.version-a.version);
  const slots=Array.from({length:5},(_,i)=>{
    const k='service-'+(i+1),v=state.contents?.find(x=>x.key===k);
    return '<button type="button" data-action="content-slot" data-key="'+k+'" class="service-slot '+(key===k?'active':'')+'"><small>业务 '+(i+1)+'</small><b>'+esc(v?.title||'待配置正式内容')+'</b><span>'+(v?'最新 V'+(v.version||1)+' · '+(labels[v.status]||v.status):'尚未配置')+'</span></button>';
  }).join('');
  const editor=form(service?'content.service.save':'content.update',
    field(service?'slot':'key','',service?slot:key,'hidden')+
    field('expectedVersion','',r?.version||(r?.title?1:0),'hidden')+
    field('title',address?'地区名称':wechat?'官方微信名称':'内容标题',r?.title||'','text',address?'required maxlength="60"':'required')+
    (service?field('summary','业务摘要',r?.summary||'','text','required maxlength="1000"')+
      area('body','业务详细介绍',r?.body||r?.text||'','required minlength="3" maxlength="2000"')
      :area('intro',address?'公开详细地址':wechat?'公开微信说明':logo?'公开标识说明':'公开正文',r?.text||'',address?'required maxlength="200"':undefined))+
    (withCover?field('imageId','',r?.imageId||'','hidden')+
      '<div data-content-cover-actions'+(r?.imageId?'':' style="display:none"')+'>'+
      button(wechat?'预览二维码':logo?'预览品牌标识':'预览编辑封面','view-photo',{id:r?.imageId||''})+
      button(wechat?'清除二维码':logo?'清除品牌标识':'清除封面','content-cover-clear')+
      (logo||wechat?'<img data-cover-preview alt="'+(wechat?'官方微信二维码':'集团品牌标识')+'" hidden style="max-width:100%;max-height:160px">':'')+'</div>'+
      '<label class="field">'+(wechat?'上传官方微信二维码':logo?'上传集团品牌标识':service?'上传业务封面':'上传集团介绍封面')+'<input id="contentImage" type="file" accept="image/png,image/jpeg,image/webp"><small>2MB 内 PNG、JPEG 或 WebP</small></label>':'')+
    select('published','发布状态',[['false','保存草稿'],['true','发布为公开信息']],'false')+
    area('reason','本次修改原因')+submit('保存栏目'));
  const history=versions.map(v=>{
    const version=v.snapshot||v;
    return '<article class="record"><div class="record-top"><h3>V'+esc(v.version)+' · '+esc(version.title||'内容版本')+'</h3>'+chip(v.status)+'</div>'+
      (v.sourceVersion?pair('来源版本','V'+v.sourceVersion):'')+pair('修改原因',v.reason)+pair('操作人',v.createdBy||v.actor)+pair('保存时间',v.createdAt)+
      '<details><summary class="muted">查看版本内容</summary><div class="version-copy"><h4>'+esc(version.title)+'</h4><p>'+esc(version.summary||'')+'</p><p>'+esc(version.body||version.text||'')+'</p></div></details></article>';
  }).join('');
  return heading('公开内容维护','五大业务分别编辑与发布，保存草稿期间当前公开版本继续有效。')+
    '<div class="service-slots">'+slots+'</div>'+
    select('contentKey','内容栏目',[['brand','集团介绍'],['brand-logo','集团品牌标识'],['headquarters-address','总部地址'],['official-wechat','官方微信'],...Array.from({length:5},(_,i)=>['service-'+(i+1),'五大业务 · '+(i+1)]),['services','业务总览说明'],['news','集团动态'],['cases','门店案例'],['cooperation','合作说明']],key,'data-filter="contentKey"')+
    panel(service?'编辑第 '+slot+' 项业务':'编辑栏目内容',editor)+
    (withCover||address?contentPublication(r,versions):'')+
    panel('栏目版本记录',history||empty('该栏目尚无版本记录。'),'该栏目最近 200 条版本');
}
async function showOfficialDelivery(chatId){
  const rows=await api('/wechat/official/delivery?'+new URLSearchParams({chatId}));
  const states={pending:'待发送',sending:'发送中',sent:'平台已接受',failed:'发送失败',uncertain:'发送结果未确认',simulated:'已模拟发送'};
  const records=rows.map(row=>'<article class="record">'+
    pair('发送状态',row.next_attempt_at?'等待重试':states[row.status]||row.status)+
    pair('发送方式',row.provider_mode==='mock'?'模拟':'微信公众平台')+pair('尝试次数',row.attempts)+
    pair('回复登记时间',row.created_at)+pair('最新处理时间',row.updated_at)+
    (row.next_attempt_at?pair('下次重试时间',row.next_attempt_at):'')+
    (row.provider_code!=null?pair('平台返回码',row.provider_code):'')+
    (row.provider_accepted_at?pair('平台接受时间',row.provider_accepted_at):'')+
    (row.error_code?pair('处理结果代码',row.error_code):'')+'</article>').join('');
  modal('公众号回复发送状态',notice('平台已接受表示微信返回成功，用户阅读状态由平台决定。发送结果未确认时请由客服核实。',true)+
    (records||empty('暂无外发消息记录。')));
}
function audit(){return heading('操作审计','业务写操作记录请求、对象、操作者和结果。')+pageControls()+(!(state.audit||[]).length?collectionEmpty('暂无审计记录。'):`<section class="panel"><div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th></tr></thead><tbody>${(state.audit||[]).slice().reverse().map(a=>`<tr><td>${esc(a.executedAt||a.at||a.createdAt)}</td><td>${esc(a.actor)}</td><td>${esc(a.command||a.action)}</td><td>${esc(a.object||a.entityId||a.id)}</td></tr>`).join('')}</tbody></table></div></section>`);}
function renderTraining(){
  shell(heading('已有培训记录','按授权查看学员记录、处理资料和核对审核进度。')+'<div id="training-desk"></div>');
  training.mount($('training-desk'),session);
}
function render(){if(!session)return renderLogin();if(!navList().includes(ui.page))ui.page=navList()[0];if(ui.page==='training')return renderTraining();try{const body=op.configs[ui.page]?op.render():({home,stores,reports,requests,locations,billing,support,analytics,accounts,messages,content,audit}[ui.page])();shell(body+(ui.page==='reports'?'':pageControls(true)));if(ui.page==='analytics')renderedAnalyticsRevision=viewRevision}catch(e){console.error(e);shell(notice('页面无法显示：'+e.message)+button('刷新重试','refresh'))}}
function modal(title,html){onboarding.releasePreview();$('modalBody').innerHTML=`<header><h2>${esc(title)}</h2>${button('关闭','close')}</header>${html}`;if(!$('modal').open)$('modal').showModal()}
function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}
async function exportData(format){
  if(!state.capabilities?.export)throw Error('当前身份没有导出权限');
  if(ui.page!=='analytics'||renderedAnalyticsRevision!==viewRevision)throw Error('所选范围尚未加载完成，请刷新后再导出');
  const {period,kind,mode,outlet,owner}=ui;
  const result=await api('/export?'+new URLSearchParams({format,period,kind,mode,outlet,owner}),{binary:true});
  download(result.blob,'九盈英才_经营报告.'+format,result.type);
  toast('已下载经营报告');
}
document.addEventListener('click',async e=>{const link=e.target.closest('[data-task-link]');
if(link&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){
  ui.queueReturn={hash:location.hash,position:window.scrollY};
  history.replaceState({...history.state,taskQueueScroll:ui.queueReturn.position},'');
}
const b=e.target.closest('[data-action]');if(!b)return;const d=b.dataset;try{if(d.action.startsWith('onboarding-'))return await onboarding.action(d);switch(d.action){case'initialize':return await initialize();case'login-mode':ui.loginMode=d.mode;renderLogin();return;
case'trial-role':return await switchTrialRole(d.actor);
case'trial-open-report':if(config.devLoginEnabled&&config.roleTrial){const report=config.roleTrial.report;return await nav('reports',{shop:report.outlet,month:report.month});}return;
case'trial-native-launch':if(config.devLoginEnabled&&config.roleTrial)return await openTrialNative(b);return;
case'trial-open-onboarding':if(config.devLoginEnabled&&config.roleTrial&&session?.role==='manager'){await nav('onboarding');return await onboarding.openRecord(config.roleTrial.onboarding.id);}return;
case'approval-export-page':formExports.action(d);return await refresh();
case'approval-export-grant-new':case'approval-export-grant-edit':case'approval-export-grant-revoke':case'approval-export-download':return await formExports.action(d);
case'staff-sms-send':return await staffIdentity.sendSms(b);
case'staff-login-profile':return await staffIdentity.myProfile();
case'staff-login-mobile':return await staffIdentity.manageMobile(d.actor);
case'content-slot':ui.contentKey=d.key;return await refresh();case'content-cover-clear':updateContentCover(b.closest('form'),'');return;case'task-create':return taskDesk.create();
case'task-detail':return await taskDesk.openDetails(d.id);
case'task-assign':return await taskDesk.assign(d.id);
case'task-complete':return await taskDesk.complete(d.id);
case'task-report-form':return await nav('reports',{shop:d.outlet,month:d.month});
case'approval-open':return await approval.open(d.collection,d.id);
case'approval-page':return await approval.load(b.closest('.approval-history'),Number(d.offset)||0);
case'channel-refund-open':case'payment-exceptions':return await op.financeAction(d,b);
case'channel-refund-confirm':case'channel-refund-query':await op.financeAction(d,b);return await refresh();
case'op-form':return await op.open(d.cmd,d.id,d.collection);case'op-tab':if(pageCollection()!==d.tab)resetCollectionFilters();ui.opTab=d.tab;return await refresh();case'record-detail':return await op.detail(d.collection,d.id);case'import-template':return op.template(d.kind);case'activation':{const result=await api('/auth/activation',{method:'POST',body:{actor:d.actor}});modal('一次性账号激活码',notice('请通过可信渠道将登录账号和激活码交给本人。激活码仅用于首次设置或重置密码。')+pair('登录账号',result.username)+field('activationToken','激活码',result.token||result.activationToken,'text','readonly')+pair('有效期',result.expiresAt)+button('复制激活码','copy-activation')+(d.recordId?button('返回原申请','onboarding-open-record',{id:d.recordId}):''));return}case'copy-activation':await navigator.clipboard.writeText(document.querySelector('[name="activationToken"]').value);toast('已复制一次性激活码');return;case'analytics-prev':ui.analyticsOffset=Math.max(0,(ui.analyticsOffset||0)-50);return await refresh();case'analytics-next':ui.analyticsOffset=(ui.analyticsOffset||0)+50;return await refresh();case'page-prev':ui.offset=Math.max(0,ui.offset-ui.limit);return await refresh();case'page-next':ui.offset+=ui.limit;return await refresh();case'nav':return await nav(d.page);case'menu':setWorkspaceMenu(b.getAttribute('aria-expanded')!=='true');return;case'menu-close':setWorkspaceMenu(false,true);return;case'close':$('modal').close();return;case'logout':await api('/auth/logout',{method:'POST',body:{}}).catch(()=>{});session=null;sessionStorage.removeItem('jy-session');$('printArea').innerHTML='';return renderLogin();case'refresh':return await refresh();case'recent':Object.assign(ui,{period:d.period,kind:'month',mode:'settled'});return await refresh();case'store':{if(readTaskRoute(location.hash))history.pushState({workspacePage:'stores'},'',location.pathname+location.search);const record=await api('/collections/outlets/'+encodeURIComponent(d.id));if(!state.outlets.some(o=>o.id===record.id))state.outlets.push(record)}ui.detail=d.id;ui.page='stores';render();return;case'new-request':ui.requestType=d.type;return await nav('requests');case'draft':{const payload=Object.fromEntries(new FormData(b.form));ensureReportWriteScope(payload);await command('report.draft',payload);break}case'revoke':modal('总部误审批纠正 / 撤销',notice('提交后须财务复核；复核前当前有效数据保持不变，原月报永不覆盖。')+form('report.revoke.request',field('id','',d.id,'hidden')+area('reason','误审批原因与核实依据')+submit('提交撤销复核')));return;case'correct':modal('发起已审核月报更正',form('report.correct',field('id','',d.id,'hidden')+select('correctionType','更正范围',[['full','整表更正（人工确认）'],['field','单字段更正']])+select('correctionField','单字段更正项目',[...Object.entries(metrics),['note','经营说明']],'note')+notice('单字段更正仅允许修改所选项目；收入变化仍须财务复核。更正期间原有效版本保持不变。',true)+area('reason','更正原因')+submit('发起更正')));return;case'official-delivery':return await showOfficialDelivery(d.id);case'view-photo':{
 const active=session;
 if(!active)return;
 const fileId=d.id;
 const response=await fetch('/api/files/'+encodeURIComponent(fileId),{headers:{Authorization:'Bearer '+active.token}});
 if(!response.ok)throw Error('没有附件查看权限');
 const image=await response.blob();
 if(session!==active)return;
 const preview=b.closest('form')?.querySelector('[data-cover-preview]');
 if(preview){
  if(!preview.isConnected||b.dataset.id!==fileId)return;
  const reader=new FileReader();
  reader.addEventListener('load',()=>{
   if(preview.isConnected&&b.dataset.id===fileId&&session===active){preview.src=reader.result;preview.hidden=false;}
  },{once:true});
  reader.readAsDataURL(image);
  return;
 }
 const title=d.context==='support'?'工单图片':'私有现场照片',url=URL.createObjectURL(image);
 modal(title,'<img src="'+url+'" style="max-width:100%;max-height:65vh" alt="'+title+'">');
 $('modal').addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});
 return;
}
case'manual-coordinates':case'coordinates':case'gps':return captureLocation(b);case'billing-outlet':ui.billingOutlet=d.outlet||'';ui.billingOutletOffset=0;if(pageCollection()!=='bills')resetCollectionFilters();ui.offset=0;ui.browseCollection='bills';return await refresh();
case'billing-outlet-page':ui.billingOutletOffset=Number(d.offset)||0;return await refresh();
case'billing-detail':return await financeLedger.readBill(d.id,d.section,Number(d.offset)||0);
case'billing-catchup':return await financeLedger.reviewQueue(Number(d.offset)||0);
case'billing-review-generate':modal('复核后人工出账',pair('协议',d.id)+pair('账期',d.month)+form('billing.generate',field('agreementId','',d.id,'hidden')+field('month','',d.month,'hidden')+area('reason','已确认整月收费依据')+submit('确认按协议出账')));return;
case'billing-export':{const result=await api('/finance/export?'+new URLSearchParams(billingScope()),{binary:true});download(result.blob,'九盈英才_财务对账.csv',result.type);return;}
case'payment-close':modal('确认关闭已到期订单',pair('支付订单',d.id)+notice('服务器会先核验订单未支付且已经到期，符合条件才向支付渠道申请关闭。关闭订单不等于退款；状态仍以渠道核验结果为准。',true)+button('确认核验并关闭','payment-close-confirm',{id:d.id},'primary'));return;case'payment-query':case'payment-close-confirm':{if(ui.busy)return toast('上一项操作仍在处理中，请稍候');ui.busy=true;b.disabled=true;try{const result=await api('/payments/'+encodeURIComponent(d.id)+(d.action==='payment-query'?'/query':'/close'),{method:'POST',body:{}});if($('modal').open)$('modal').close();await refresh();modal('支付核验结果',pair('支付订单',result.payment.id)+pair('支付状态',result.payment.status==='pending'?'待确认':labels[result.payment.status]||result.payment.status)+pair('账单状态',labels[result.bill.status]||result.bill.status)+notice('以上为服务端核验结果，付款与实收记录由服务端确认后更新。',true))}catch(error){const message='支付状态未确认：'+error.message+(error.requestId?' · 请求编号 '+error.requestId:'');if($('modal').open){let alert=$('modalBody').querySelector('.payment-error');if(!alert){alert=document.createElement('div');alert.className='form-error payment-error';alert.setAttribute('role','alert');$('modalBody').querySelector('header').after(alert)}alert.textContent=message}toast(message)}finally{ui.busy=false;b.disabled=false}return}case'pay':await command('payment.start',{billId:d.id});break;case'payment-result':await command('payment.resolve',{id:d.id,outcome:d.outcome});break;case'faq':toast(d.text);return;case'human':await command('support.human',{id:d.id});break;case'claim':await command('support.claim',{id:d.id});break;case'read':await command('message.read',{id:d.id});break;case'export':return await exportData(d.format)}toast('操作已保存');await refresh()}catch(err){toast(err.message)}});
document.addEventListener('submit',async e=>{
  const joiningForm=e.target.closest('form[data-onboarding-form]');
  if(joiningForm){e.preventDefault();return await onboarding.save(joiningForm,e.submitter)}
  const f=e.target.closest('form[data-command]');
  if(!f)return;
  e.preventDefault();
  let cmd=f.dataset.command,d=Object.fromEntries(new FormData(f));
  const submitButtons=[...f.querySelectorAll('button[type="submit"]:enabled')];
  if(e.submitter?.disabled||!submitButtons.length)return;
  try{
    for(const button of submitButtons)button.disabled=true;
    if(cmd==='review.report'){
      d.decision=e.submitter?.value;
      if(!['approve','return'].includes(d.decision))throw Error('请选择退回修改或审核通过。');
      if(d.decision==='return'&&!d.note?.trim()){
        f.elements.note.focus();
        throw Error('请填写退回意见。');
      }
    }
if(cmd.startsWith('approval-export-')){
 const outcome=await formExports.submitAction(cmd,f,d);
 if(outcome!=='refresh'&&$('modal').open)$('modal').close();
 if(outcome!=='downloaded')await refresh();
 return;
}
if(cmd==='staff-sms-login')return await acceptStaffSession(await staffIdentity.verifySms(d));
if(cmd==='staff-wechat-start'||cmd==='staff-wechat-bind')return await staffIdentity.beginWechat(d.password);
if(cmd==='staff-mobile-configure')return await staffIdentity.configureMobile(d);
if(['password-login','activate'].includes(cmd)){if(cmd==='activate'&&d.password!==d.confirmPassword)throw Error('两次输入的密码不一致');const result=await api(cmd==='activate'?'/auth/activate':'/auth/password',{method:'POST',body:cmd==='activate'?{token:d.token,password:d.password}:{username:d.username,password:d.password}});if(!result.token){ui.loginMode='password';renderLogin();toast('激活完成，请使用个人账号登录');return}session=result;sessionStorage.setItem('jy-session',JSON.stringify(session));ui.page='home';await refresh();return}if(cmd==='login'){const actor=d.customActor?.trim()||d.actor;const s=await api('/auth/dev',{method:'POST',body:{actor}});session=s;sessionStorage.setItem('jy-session',JSON.stringify(session));ui={...ui,page:'home',outlet:'all',owner:'all',detail:null};await refresh();return}if(cmd==='report.correct'){d.fields=d.correctionType==='field'?[d.correctionField]:[];delete d.correctionField}if(cmd==='enrollment.confirm')d.applicable=d.applicable==='true';if(cmd==='report.submit')ensureReportWriteScope(d);if(cmd==='request.submit'){const {type,outlet,...data}=d;if(type==='enrollment')data.applicable=data.applicable==='true';if(['newOutlet','locationChange'].includes(type)){const evidence=locationEvidenceForWrite(f);data.coords=evidence.coords;data.photo=evidence.photo;data.note=data.reason}d={type,outlet,data}}if(cmd==='location.submit'){const evidence=locationEvidenceForWrite(f);d={...d,coords:evidence.coords,photo:evidence.photo,capturedAt:evidence.coords?.capturedAt};}if(cmd==='location.baseline.confirm'){d={outlet:d.outlet,coords:{lat:Number(d.latitude),lng:Number(d.longitude),source:'manual',coordinateSystem:'GCJ-02'},reference:d.reference,reason:d.reason}}if(cmd==='content.service.save')d={...d,slot:Number(d.slot),expectedVersion:Number(d.expectedVersion),imageId:d.imageId||null,published:d.published==='true'};if(cmd==='content.publication')d={...d,expectedVersion:Number(d.expectedVersion),...(d.sourceVersion?{sourceVersion:Number(d.sourceVersion)}:{})};if(cmd==='grant.set'){const fd=new FormData(f);d={outlets:fd.getAll('outlets'),metrics:fd.getAll('metrics'),reviewOutlets:fd.getAll('reviewOutlets')}}if(cmd==='account.update'&&!d.mobile)delete d.mobile;if(cmd==='summary.adjust'){d={outlet:d.outlet,month:d.month,values:{[d.metric]:d.value},reason:d.reason}}if(cmd==='agency.level')d={owner:d.owner,level:d.level===''?null:Number(d.level),reason:d.reason};if(cmd==='agency.bind')d={parentOwner:d.parentOwner,childOwner:d.childOwner,replaceActive:d.replaceActive==='true',reason:d.reason};if(cmd==='support.action'){const requestSupplement=d.operation==='requestSupplement';cmd='support.'+(requestSupplement?'reply':d.operation);d={id:d.id,text:d.text,note:d.text,reason:d.text,department:d.department,...(requestSupplement?{requestSupplement:true}:{})}}if(cmd==='support.settings'){const minutes=x=>/^\d+$/.test(x)?Number(x):null;d={hours:d.hours,phone:d.phone?.trim()||null,sla:{complaint:minutes(d.complaint),aftersale:minutes(d.aftersale),exception:minutes(d.exception)}}}if(cmd==='support.rate')d.rating=Number(d.rating);if(cmd==='content.update')d={...d,key:d.key||'brand',expectedVersion:Number(d.expectedVersion),text:d.intro,imageId:d.imageId||null,published:d.published==='true'};if(cmd==='support.ticket'&&!d.linkedTicketId)delete d.linkedTicketId;d=taskDesk.normalize(cmd,op.normalize(cmd,d,f));const saved=await command(cmd,d);if(cmd==='import.preview'){await refresh();await op.detail('importBatches',saved.id);toast(saved.errorCount?'存在校验错误，请修正后重新预览':'校验通过，可在批次列表确认导入');return}if(cmd==='jobs.run'){await refresh();modal('周期检查结果',pair('批次编号',saved.id)+pair('状态',saved.status)+pair('后续游标',saved.nextCursor??'已处理完本批范围')+notice('业务待办与站内提醒已按已配置规则生成。外部推送取决于真实服务接入。',true));return}if(cmd==='account.create'){modal('负责人账号已创建',pair('个人登录账号',saved.actor||saved.account?.actor||'请查看账号记录')+notice('账号创建后，签发一次性激活码给本人设置密码。',true)+button('签发激活码','activation',{actor:saved.actor||saved.account?.actor}));await refresh();return}if($('modal').open)$('modal').close();toast('已保存至后台数据库');await refresh()}catch(err){let error=f.querySelector('.form-error');if(!error){error=document.createElement('div');error.className='form-error';error.setAttribute('role','alert');f.prepend(error)}error.textContent=err.message+(err.requestId?' · 请求编号 '+err.requestId:'');toast(err.message)}finally{for(const button of submitButtons)button.disabled=false}});
document.addEventListener('input',e=>{if(e.target.matches('form[data-onboarding-form="configure"] [name="payee"]'))onboarding.change(e.target)});
document.addEventListener('change',async e=>{const n=e.target;try{if(n.hasAttribute('data-onboarding-filter')||n.matches('form[data-onboarding-form="configure"] [name="qrFile"]'))return await onboarding.change(n);if(n.dataset.exportOptions||n.hasAttribute('data-export-category')){await formExports.change(n);return}if(n.dataset.taskFilter){const route=readTaskRoute(location.hash);if(route)taskDesk.filter(route,n.dataset.taskFilter,n.value);return}
if(n.hasAttribute('data-task-assignee')){const form=n.closest('form');form.elements.assigneeUserId.value='';for(const option of form.querySelectorAll('#task-staff-list option'))option.disabled=option.dataset.role!==n.value}
if(n.name==='role'&&n.closest('form')?.querySelector('.grant-editor'))n.closest('form').querySelector('.grant-editor').open=n.value==='regional';resetLocationScope(n);if(n.dataset.filter){if(n.dataset.filter==='browseCollection')resetCollectionFilters();ui[n.dataset.filter]=n.value;ui.offset=0;ui.analyticsOffset=0;if(n.dataset.filter==='billingMonth')ui.billingOutletOffset=0;await refresh()}if(n.id==='importFile'&&n.files?.[0])await op.readFile(n.files[0]);if(n.id==='contentImage'||n.id==='outletPhoto')await uploadContentCover(n);if(n.id==='photo')await uploadLocationPhoto(n)}catch(err){toast(err.message)}});
window.addEventListener('unhandledrejection',e=>{e.preventDefault();toast(e.reason?.message||'操作失败，请重试')});
let pendingStaffWechatCallback=staffWechatCallback;
async function initialize(){try{
  config=await api('/config');
  if(config.roleTrial&&!config.roleTrial.activationProgress&&['http://127.0.0.1:18972','http://127.0.0.1:18973'].includes(location.origin)){
    location.replace('http://127.0.0.1:18974/');
    return;
  }
  let identityMessage='';
  try{
    const callback=pendingStaffWechatCallback;
    pendingStaffWechatCallback=null;
    const identityResult=await staffIdentity.finishWechat(callback);
    if(identityResult?.token){await acceptStaffSession(identityResult);return;}
    if(identityResult?.wechatBound)identityMessage='微信绑定成功。下次可扫码登录。';
  }catch(error){identityMessage=error.message;}
  if(session)await refresh();else renderLogin();
  if(identityMessage)toast(identityMessage);
}catch(e){if(session)shell(notice(e.message)+button('重新连接','refresh'));else{$('app').innerHTML=notice('暂时无法连接服务：'+e.message)+button('重新连接','initialize')}}}initialize();
