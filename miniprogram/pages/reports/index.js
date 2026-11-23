const {define,go,api,fmt}=require('../../utils/page');

const pageSize=25;
const filters=new Set(['all','action','reviewing','approved']);
const states={
 missing:['待填写','wait','去填写'],
 draft:['草稿','wait','继续填写'],
 returned:['待修改','wait','查看退回原因'],
 pending:['总部审核中','wait','查看月报'],
 finance:['财务复核中','wait','查看月报'],
 approved:['已通过','ok','查看月报'],
 exemption_pending:['免报待核实','wait','查看免报说明'],
 exempt:['已免报','ok','查看免报说明'],
 not_required:['该月无需报送','gray','查看说明'],
 not_open:['尚未开放','gray','查看说明'],
};
const reasons={
 enrollment_pending:'招生适用性待总部确认，可以先保存草稿。',
 full_pause:'该网点整月暂停营业，等待总部核验免报。',
 exempt:'总部已确认该网点当月免报。',
 no_operation:'该网点当月没有营业记录。',
};
const summaryKeys=['expected','submitted','exempt','actionable','awaitingExemption','inReview'];
const emptyListing={reportRows:[],coverage:null,worklist:null,worklistError:'',canOpenEditor:false};
const validMonth=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const sessionKey=()=>{
 const session=api.session();
 return JSON.stringify([session?.role,session?.subject,session?.token]);
};

function formatRow(row,today){
 const [statusText,statusTone,action]=states[row.status];
 const actionText=!row.canSubmit&&row.reason!=='enrollment_pending'&&['missing','draft'].includes(row.status)?'查看填报说明':action;
 const showDue=['missing','draft','returned','exemption_pending'].includes(row.status);
 return {...row,statusText,statusTone,actionText,reasonText:reasons[row.reason]||'',
  displayVersion:row.status==='approved'?row.effectiveVersion:row.reportId?row.latestVersion:null,
  dueText:showDue?fmt.dateText(row.dueOn):'',late:row.late||!!(showDue&&row.dueOn&&today>row.dueOn)};
}

Page(define({
 // Fetch the picker independently so an unavailable outlet never prevents a scoped worklist response.
 collections:[{name:'outlets',errorKey:'outletChoiceError',visible(){return false;}}],
 data:{...emptyListing,month:'',monthDisplay:'',currentMonth:'',previousMonth:'',periodHint:'',filter:'all',
  outlet:'all',outletIndex:0,options:[],outletChoiceError:'',loadingReports:false},
 load(query){
  if(!validMonth(query.month))delete query.month;
  this.setData({...emptyListing,outlet:query.outlet||'all',month:query.month||'',filter:'all'});
 },
 setPeriod(month,currentMonth=this.data.currentMonth){
  const periodHint=month>=currentMonth?'本经营月份尚未开放填报。月报填报已结束的自然月。':
   !this.query.month?'本月尚未结束，当前显示上月经营月报。':'';
  this.setData({month,currentMonth,previousMonth:fmt.addMonth(currentMonth,-1),monthDisplay:fmt.monthText(month),periodHint});
 },
 async loaded(state){
  if(this.data.isPublic||this.data.session?.role!=='partner')return;
  const currentMonth=state.today.slice(0,7);
  this.setPeriod(this.query.month||fmt.addMonth(currentMonth,-1),currentMonth);
  await Promise.all([this.loadOutletChoices(true),this.loadWorklist()]);
 },
 async loadOutletChoices(reset){
  const serial=this._serial,key=sessionKey();
  const current=()=>serial===this._serial&&key===sessionKey();
  if(reset)this.setData({options:[],outletIndex:-1,outletChoiceError:''});
  try{
   await this.fetchCollection('outlets',reset,serial,false);
   if(!current())return;
   const {outlet}=this.data;
   const outlets=this.data.state.outlets.filter(row=>row.owner);
   if(outlet!=='all'&&this.data.pagers.outlets.hasMore&&!outlets.some(row=>row.id===outlet)){
    try{
     const record=await api.detail('outlets',outlet);
     if(!current())return;
     outlets.unshift(record);
    }catch(error){if(![403,404].includes(error.status))throw error;}
   }
   if(!current())return;
   const options=[{id:'all',label:'全部网点'},...outlets.map(row=>({id:row.id,label:fmt.outletOptionLabel(row)}))];
   this.setData({options,outletIndex:options.findIndex(row=>row.id===this.data.outlet)});
  }catch(error){if(current())this.setData({outletChoiceError:error.message});}
 },
 async select(values){
  if(values.outlet)this.query.outlet=values.outlet;
  if(values.month)this.query.month=values.month;
  this.setData({...emptyListing,...values});
  if(!this.data.currentMonth||this.data.session?.role!=='partner'||this.data.error)return this.refresh();
  this.setPeriod(this.data.month);
  this.setData({outletIndex:this.data.options.findIndex(row=>row.id===this.data.outlet)});
  return this.loadWorklist();
 },
 changeMonth(e){if(validMonth(e.detail.value))return this.select({month:e.detail.value});},
 pickMonthShortcut(e){
  const month=e.currentTarget.dataset.value==='current'?this.data.currentMonth:this.data.previousMonth;
  if(month)return this.select({month});
 },
 filter(e){
  const filter=e.currentTarget.dataset.value;
  if(filters.has(filter))return this.select({filter});
 },
 pickOutlet(e){const outlet=this.data.options[Number(e.detail.value)];if(outlet)return this.select({outlet:outlet.id});},
 clearOutlet(){return this.select({outlet:'all'});},
 clearFilter(){return this.select({filter:'all'});},
 moreOutlets(){return this.loadOutletChoices(false);},
 retryOutletChoices(){return this.loadOutletChoices(!this.data.options.length);},
 async loadWorklist(offset=0){
  const serial=this._serial,session=sessionKey();
  const {month,outlet,filter:status}=this.data;
  const request={serial,session,month,outlet,status};
  this._worklistRequest=request;
  const current=()=>this._worklistRequest===request&&serial===this._serial&&session===sessionKey();
  const prior=offset?this.data.reportRows:[];
  this.setData({...(offset?{}:emptyListing),loadingReports:true,worklistError:''});
  try{
   const result=await api.request('/api/reports/worklist?'+api.query({month,outlet,status,limit:pageSize,offset}),'GET',undefined,{},true,this);
   if(!current())return;
   const {items,total,summary,hasMore}=result||{};
   if(result?.month!==month||result.offset!==offset||result.limit!==pageSize||!Array.isArray(items)||
    !items.every(row=>row.month===month&&typeof row.outletId==='string'&&(outlet==='all'||row.outletId===outlet)&&Object.hasOwn(states,row.status))||
    !Number.isSafeInteger(total)||total<0||typeof hasMore!=='boolean'||
    !summaryKeys.every(key=>Number.isSafeInteger(summary?.[key])&&summary[key]>=0)||summary.submitted>summary.expected){
    throw new Error('暂时无法获取经营月报，请重试。');
   }
   const seen=new Set(prior.map(row=>row.outletId));
   const reportRows=[...prior,...items.filter(row=>!seen.has(row.outletId)).map(row=>formatRow(row,this.data.state.today))];
   const coverage={...summary,percent:summary.expected?Math.round(summary.submitted/summary.expected*100):0};
   const canOpenEditor=month<this.data.currentMonth;
   this._worklistSession=session;
   this.setData({reportRows,coverage,worklist:{total,hasMore,nextOffset:offset+pageSize},canOpenEditor});
  }catch(error){if(current())this.setData({worklistError:error.status===403?'无网点权限':error.message});}
  finally{if(current())this.setData({loadingReports:false});}
 },
 retryReports(){return this.loadWorklist(this.data.worklist?.nextOffset||0);},
 moreReports(){
  if(this.data.loading||this.data.loadingReports||!this.data.worklist?.hasMore||this._worklistSession!==sessionKey())return;
  return this.loadWorklist(this.data.worklist.nextOffset);
 },
 newReport(){
  if(this.data.loading||this.data.error||this.data.worklistError||!this.data.canOpenEditor||this._worklistSession!==sessionKey())return;
  const {month,outlet}=this.data;
  go('report',api.query({month,outlet:outlet==='all'?'':outlet}));
 },
 open(e){
  if(this.data.isPublic||this.data.loading||this.data.error||this._worklistSession!==sessionKey())return;
  const {outlet,month,reportId}=e.currentTarget.dataset;
  const row=this.data.reportRows.find(record=>record.outletId===outlet);
  if(row&&row.month===month&&row.reportId===(reportId||null))go('report',api.query({outlet,month,id:row.reportId}));
 }
}));
