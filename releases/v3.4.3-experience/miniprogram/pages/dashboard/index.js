const {define,go,api,fmt}=require('../../utils/page');
Page(define({collections:['outlets'],load(q){if(q.period)this.setData({period:q.period});},data:{period:fmt.month(),kind:'month',kindIndex:0,kinds:['月度','季度','年度'],kindValues:['month','quarter','year'],mode:'settled',outletIndex:0,outlets:[{id:'all',name:'全部网点'}],metrics:[],rows:[],trend:[],partial:false,coverage:null,dashboardReady:false,dashboardLoading:false,exportError:''},async loaded(s){const outlets=[{id:'all',name:'全部网点'},...s.outlets.filter(o=>o.owner)];this.setData({outlets,outletIndex:Math.max(0,outlets.findIndex(x=>x.id===this.query.outlet))});await this.loadDashboard();},
async loadDashboard(){const serial=(this.serial||0)+1;this.serial=serial;const params=this.params();
const pageSerial=this._serial,token=api.session()?.token;
const isCurrent=()=>this.serial===serial&&this._serial===pageSerial&&api.session()?.token===token;
this.setData({dashboardReady:false,dashboardLoading:true,error:'',exportError:''});
try{const get=p=>api.request('/api/dashboard?'+api.query(p));const d=await get(params),t=d.totals||{},max=Math.max(1,...(d.rows||[]).map(r=>Number(r.revenue)||0));
const periods=Array.from({length:6},(_,i)=>fmt.addMonth(params.period,i-5)),history=[];
for(let i=0;i<periods.length;i+=3){
 if(!isCurrent())return;
 history.push(...await Promise.all(periods.slice(i,i+3).map(period=>get({...params,period,kind:'month'}))));
}
if(!isCurrent())return;
let comparisons=[];if(params.kind==='month'){const previous=history[4],year=await get({...params,period:fmt.addMonth(params.period,-12)});comparisons=[['revenue','营业收入'],['orders','有效完成订单'],['traffic','到店人次'],['enroll','实际招生人数']].map(([key,label])=>({key,label,mom:fmt.change(t[key],previous.totals[key],d.partial||previous.partial),yoy:fmt.change(t[key],year.totals[key],d.partial||year.partial)}));}
if(!isCurrent())return;const maxTrend=Math.max(1,...history.map(h=>Number(h.totals.revenue)||0));
const hasData=['revenue','orders','traffic','enroll'].some(metric=>t[metric]!==null&&t[metric]!==undefined);
const coverage=d.reportingCoverage||null;
const settlementState=d.settlementStatus?.state;
const ownCorrectionPending=settlementState==='pending_resettlement';
const batchRefreshing=!!d.settlementStatus?.refreshingMonths?.length;
const settlementPending=ownCorrectionPending||batchRefreshing,settlementUpdated=settlementState==='resettled'&&!settlementPending;
const settlementScope=params.kind==='month'?'本月':'所选期间的部分';
const dataStatus=hasData||settlementPending?'':settlementState==='unsettled'
 ?(params.kind==='month'?'本月数据尚未结算':'所选期间的数据尚未结算'):'当前范围暂无可统计数据';
this.setData({dashboardReady:true,error:'',hasData,dataStatus,settlementPending,settlementUpdated,
 settlementDescription:ownCorrectionPending?settlementScope+'经营数据已发生更正，总部正在重新核算。完成后将更新经营看板。'
  :batchRefreshing?'已结算数据正在更新。完成后将恢复显示。':'',
 dueDisplay:fmt.dateText(d.reportDeadlines?.[d.period]?.dueOn),
 periodDisplay:fmt.monthText(d.period),momDisplay:fmt.monthText(fmt.addMonth(params.period,-1)),yoyDisplay:fmt.monthText(fmt.addMonth(params.period,-12)),
 incomparable:comparisons.some(row=>row.mom==='不可比'||row.yoy==='不可比'),coverage:d.reportingCoverage||null,reportTiming:d.reportDeadlines?.[d.period]||null,partial:d.partial,metrics:[{label:'营业收入 · 元',value:fmt.money(t.revenue)},{label:'有效完成订单 · 单',value:t.orders??'—'},{label:'到店人次',value:t.traffic??'—'},{label:'实际招生人数',value:t.enroll??'—'}],rows:(d.rows||[]).map(r=>({...r,name:r.name||r.outletName||this.data.state.outlets.find(o=>o.id===r.outlet)?.name||'所属网点',revenueText:fmt.money(r.revenue),width:Math.round((Number(r.revenue)||0)/max*100)})),trend:history.map(h=>({month:h.period,monthDisplay:fmt.monthText(h.period),value:fmt.money(h.totals.revenue),partial:h.partial,width:Math.round((Number(h.totals.revenue)||0)/maxTrend*100)})),comparisons,momPeriod:fmt.addMonth(params.period,-1),yoyPeriod:fmt.addMonth(params.period,-12)});
}catch(e){if(isCurrent())this.setData({error:e.message});}
finally{if(isCurrent())this.setData({dashboardLoading:false});}},
params(){return {period:this.data.period,kind:this.data.kind,mode:this.data.mode,outlet:this.data.outlets[this.data.outletIndex]?.id||'all'};},async period(e){this.setData({period:e.detail.value});await this.loadDashboard();},async kind(e){const i=Number(e.detail.value);this.setData({kindIndex:i,kind:this.data.kindValues[i]});await this.loadDashboard();},async mode(e){this.setData({mode:e.currentTarget.dataset.mode});await this.loadDashboard();},async outlet(e){const i=Number(e.detail.value),outlet=this.data.outlets[i];if(!outlet)return;this.query.outlet=outlet.id;this.setData({outletIndex:i});await this.loadDashboard();},
async export(e){
 if(this.data.busy||this.data.loading||this.data.dashboardLoading||!this.data.dashboardReady||this.data.error)return;
 const serial=this.serial,token=api.session()?.token;
 this.setData({busy:true,exportError:''});
 try{
  const format=e?.currentTarget?.dataset?.format||'xlsx';
  await api.openDocument('/api/export?'+api.query({...this.params(),format}),format);
 }catch(e){
  if(this.serial===serial&&api.session()?.token===token)this.setData({exportError:e.message});
 }finally{
  this.setData({busy:false});
 }
}
}));
