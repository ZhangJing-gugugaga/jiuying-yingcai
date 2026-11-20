const {define,api,fmt}=require('../../utils/page');
const metrics=[['revenue','营业收入 · 元'],['orders','有效完成订单 · 单'],['traffic','到店人次'],['enroll','实际招生人数']];
function outletPicker(rows,selected){
 const outlets=[{id:'all',name:'全部网点'},...rows.filter(row=>row.owner).map(row=>({...row,name:fmt.outletOptionLabel(row)}))];
 if(!outlets.some(row=>row.id===selected))outlets.unshift({id:null,name:'所选网点待核验'});
 const outletIndex=Math.max(0,outlets.findIndex(row=>row.id===selected));
 return {outlets,outletIndex};
}
function periodLabel(data){
 const months=data.months||[data.period];
 const first=fmt.monthText(months[0]),last=fmt.monthText(months[months.length-1]);
 return first===last?first:[first,last].filter(Boolean).join(' 至 ');
}
const page=define({collections:[{name:'outlets',metadata(){
 this.setData(outletPicker(this.data.state.outlets,this.data.selectedOutlet));
}}],load(q){
 const selectedOutlet=q.outlet||'all';
 this._useDefaultPeriod=!q.period;
 this.setData({selectedOutlet,...outletPicker([],selectedOutlet),...(q.period?{period:q.period,filterPeriodDisplay:fmt.monthText(q.period)}:{})});
},data:{period:fmt.month(),filterPeriodDisplay:fmt.monthText(fmt.month()),dashboardLoading:false,ready:false,exportError:'',exportMenu:false,
 kind:'month',kindIndex:0,kinds:['月度','季度','年度'],kindValues:['month','quarter','year'],mode:'settled',selectedOutlet:'all',outletIndex:0,
 outlets:[{id:'all',name:'全部网点'}],metrics:[],rows:[],trend:[],trendLoading:false,trendError:'',partial:false,coverage:null,
 showComparisons:false,comparisonLoading:false,comparisonError:'',comparisons:[]},async loaded(s){
 this.setData(outletPicker(s.outlets,this.data.selectedOutlet));
 await this.loadDashboard();
},
 dashboard(params){return api.request('/api/dashboard?'+api.query(params));},
 async loadDashboard(){
  const serial=(this.serial||0)+1;this.serial=serial;
  const params=this.params();
  const auto=this._useDefaultPeriod&&(!this._defaultDisplayedPeriod||params.period===this._defaultDisplayedPeriod)&&params.kind==='month'&&params.mode==='settled';
  if(auto)params.period=this.data.state?.today?.slice(0,7)||fmt.month();
  this.setData({dashboardLoading:true,ready:false,error:'',exportError:'',exportMenu:false,showComparisons:false,comparisons:[],comparisonLoading:false,comparisonError:'',trend:[],trendLoading:false,trendError:''});
  try{
   let data=await this.dashboard({...params,includeSettlementMonths:auto?true:undefined});
   if(this.serial!==serial)return;
   const candidate=data.settlementMonths?.latestPriorMonth;
   const refreshing=data.settlementStatus?.state==='pending_resettlement'||data.settlementStatus?.refreshingMonths?.length;
   const fallback=auto&&!data.settlementMonths?.hasCurrent&&candidate&&!refreshing;
   if(fallback){
    params.period=candidate;
    data=await this.dashboard(params);
    if(this.serial!==serial)return;
   }
   const totals=data.totals||{};
   const hasData=metrics.some(([key])=>totals[key]!=null);
   const state=data.settlementStatus?.state;
   const settlementPending=state==='pending_resettlement'||Boolean(data.settlementStatus?.refreshingMonths?.length);
   const settlementUpdated=state==='resettled'&&!settlementPending;
   const dataStatus=settlementPending?'经营数据更新中，总部正在重新核算。'
    :settlementUpdated?'已结算数据已更新。':fallback?'显示最近有已结算数据的月份。'
    :hasData?(data.partial?'部分网点或月份暂无数据。':'')
    :state==='unsettled'?'所选期间的数据尚未结算。':'当前范围暂无可统计数据。';
   const rows=(data.rows||[]).filter(row=>row.revenue!=null);
   const max=Math.max(1,...rows.map(row=>Number(row.revenue)||0));
   if(auto)this._defaultDisplayedPeriod=params.period;
   this._dashboard={serial,params,data,history:new Map(params.kind==='month'?[[params.period,data]]:[])};
   this.setData({period:params.period,filterPeriodDisplay:fmt.monthText(params.period),ready:true,dashboardLoading:false,hasData,dataStatus,settlementPending,settlementUpdated,
    periodDisplay:periodLabel(data),partial:data.partial,coverage:data.reportingCoverage||null,
    metrics:metrics.map(([key,label])=>({label,value:key==='revenue'?fmt.money(totals[key]):totals[key]??'—'})),
    rows:rows.map(row=>({...row,name:row.name||row.outletName||this.data.state?.outlets.find(outlet=>outlet.id===row.outlet)?.name||'所属网点',
     revenueText:fmt.money(row.revenue),width:Math.round((Number(row.revenue)||0)/max*100)}))});
   await this.loadTrend();
  }catch(error){if(this.serial===serial)this.setData({error:error.message});}
  finally{if(this.serial===serial)this.setData({dashboardLoading:false});}
 },
 async loadTrend(){
  const dashboard=this._dashboard;
  if(!dashboard||this.data.trendLoading)return;
  const {serial,params,history}=dashboard;
  const periods=Array.from({length:6},(_,index)=>fmt.addMonth(params.period,index-5)).filter(period=>period>='2000-01');
  this.setData({trendLoading:true,trendError:''});
  try{
   for(let start=0;start<periods.length;start+=3){
    const group=periods.slice(start,start+3).filter(period=>!history.has(period));
    const results=await Promise.all(group.map(period=>this.dashboard({...params,period,kind:'month',limit:1})));
    if(this.serial!==serial)return;
    for(const [index,data] of results.entries())history.set(group[index],data);
   }
   const max=Math.max(1,...periods.map(period=>Number(history.get(period)?.totals?.revenue)||0));
   this.setData({trendMax:fmt.money(max),trend:periods.map(month=>{
    const data=history.get(month),value=data.totals?.revenue;
    return {month,monthDisplay:fmt.monthText(month),value:fmt.money(value),hasValue:value!=null,partial:data.partial,width:Math.round((Number(value)||0)/max*100)};
   })});
  }catch(error){if(this.serial===serial)this.setData({trendError:error.message});}
  finally{if(this.serial===serial)this.setData({trendLoading:false});}
 },
 async toggleComparisons(){
  this.setData({showComparisons:!this.data.showComparisons});
  if(this.data.showComparisons&&!this.data.comparisons.length)await this.loadComparisons();
 },
 async loadComparisons(){
  const dashboard=this._dashboard;
  if(!dashboard||dashboard.params.kind!=='month'||this.data.comparisonLoading)return;
  const {serial,params,data,history}=dashboard;
  const previous=fmt.addMonth(params.period,-1),priorYear=fmt.addMonth(params.period,-12);
  this.setData({comparisonLoading:true,comparisonError:''});
  try{
   const [mom,yoy]=await Promise.all([previous,priorYear].map(period=>period<'2000-01'?{}:history.get(period)||this.dashboard({...params,period,limit:1})));
   if(this.serial!==serial)return;
   const comparisons=metrics.map(([key,label])=>({key,label,
    mom:fmt.change(data.totals?.[key],mom.totals?.[key],data.partial||mom.partial),
    yoy:fmt.change(data.totals?.[key],yoy.totals?.[key],data.partial||yoy.partial)}));
   this.setData({comparisons,momDisplay:fmt.monthText(previous),yoyDisplay:fmt.monthText(priorYear),
    incomparable:comparisons.some(row=>row.mom==='不可比'||row.yoy==='不可比')});
  }catch(error){if(this.serial===serial)this.setData({comparisonError:error.message});}
  finally{if(this.serial===serial)this.setData({comparisonLoading:false});}
 },
 params(){return {period:this.data.period,kind:this.data.kind,mode:this.data.mode,outlet:this.data.selectedOutlet};},
 async period(e){
  this._useDefaultPeriod=false;
  this.setData({period:e.detail.value,filterPeriodDisplay:fmt.monthText(e.detail.value)});
  await this.loadDashboard();
 },
 async kind(e){
  const i=Number(e.detail.value);
  if(!this.data.kindValues[i])return;
  this.setData({kindIndex:i,kind:this.data.kindValues[i]});
  await this.loadDashboard();
 },
 async mode(e){this.setData({mode:e.currentTarget.dataset.mode});await this.loadDashboard();},
 async outlet(e){
  const i=Number(e.detail.value),outlet=this.data.outlets[i];
  if(!outlet?.id)return;
  this.query.outlet=outlet.id;
  this.setData({selectedOutlet:outlet.id,outletIndex:i});
  await this.loadDashboard();
 },
 toggleExports(){this.setData({exportMenu:!this.data.exportMenu});},
async export(e){if(this.data.busy||this.data.dashboardLoading||this.data.loading||this.data.error||!this.data.ready||this.data.state?.capabilities?.export===false)return;
const params=this.params(),serial=this.serial;
this.setData({busy:true,exportError:'',exportMenu:false});
try{
 const format=e?.currentTarget?.dataset?.format||'xlsx';
 await api.openDocument('/api/export?'+api.query({...params,format}),format);
}catch(e){if(this.serial===serial)this.setData({exportError:e.message});}
finally{this.setData({busy:false});}}
});
Page({...page,async refresh(){
 this.serial=(this.serial||0)+1;
 this.setData({ready:false,dashboardLoading:false});
 const pending=page.refresh.call(this);
 const serial=this._serial;
 await pending;
 if(serial!==this._serial||!this.data.error)return;
 const {selectedOutlet,outlets,outletIndex}=this.data;
 if(selectedOutlet!=='all'&&!outlets[outletIndex]?.id){
  this.setData({error:'暂无法核验所选网点。请重试，或重新选择网点。'+this.data.error});
 }
}});
