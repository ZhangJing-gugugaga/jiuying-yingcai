const {define,api,fmt}=require('../../utils/page');
const validMonth=/^20\d{2}-(0[1-9]|1[0-2])$/;
const tones={approved:'ok',pending:'wait',finance:'wait',returned:'red',draft:'wait',missing:'red',overdue:'red',
 exempt:'gray',not_required:'gray',exemption_pending:'wait',awaiting_enrollment:'wait',not_open:'gray'};
function previousMonth(today){
 const year=Number(today.slice(0,4)),month=Number(today.slice(5,7));
 return month===1?(year-1)+'-12':year+'-'+String(month-1).padStart(2,'0');
}
Page(define({
 data:{month:'',monthDisplay:'',progressLoading:false,ready:false,progressError:'',children:[],summary:null,urgeBusy:'',urgeNotice:''},
 load(query){
  if(validMonth.test(query.month||''))this._month=query.month;
 },
 async loaded(state){
  const token=api.session()?.token;
  if(this._token&&this._token!==token){
   this._month='';
   this.setData({urgeNotice:''});
  }
  this._token=token;
  const today=state?.today||fmt.month();
  const month=this._month||previousMonth(today);
  this.setData({month,monthDisplay:fmt.monthText(month)});
  await this.loadProgress();
 },
 async loadProgress(){
  const {month}=this.data,serial=this._serial;
  const active=this._progressRequest;
  if(active&&active.serial===serial&&active.month===month)return;
  const request={serial,month};
  this._progressRequest=request;
  const current=()=>this._progressRequest===request&&serial===this._serial;
  this.setData({progressLoading:true,ready:false,progressError:'',children:[],summary:null});
  try{
   const data=await api.request('/api/agency/progress?'+api.query({month}),'GET',undefined,{},true,this);
   if(!current())return;
   const children=(data.children||[]).map(child=>({...child,
    outletRows:(child.outlets||[]).map(row=>({...row,tone:tones[row.status]||'gray',
     dueText:row.dueOn?'应于 '+fmt.dateText(row.dueOn)+' 前报送':'',
     versionText:row.effectiveVersion&&row.latestVersion>row.effectiveVersion?'最新提交 V'+row.latestVersion+' · 当前有效 V'+row.effectiveVersion:row.effectiveVersion?'当前有效 V'+row.effectiveVersion:row.latestVersion?'最新提交 V'+row.latestVersion:'尚未提交'})),
    summaryText:child.summary.actionable?child.summary.actionable+' 个网点待报送':'本月无待催报网点',
    urgedText:child.lastUrgedAt?'最近催报 '+fmt.timeText(child.lastUrgedAt):''}));
   this.setData({children,summary:data.summary,ready:true});
  }catch(error){if(current())this.setData({progressError:error.message});}
  finally{
   if(this._progressRequest===request){
    this._progressRequest=null;
    this.setData({progressLoading:false});
   }
  }
 },
 async month(e){
  const value=e.detail.value;
  if(!validMonth.test(value)||value===this.data.month)return;
  this._monthRevision=(this._monthRevision||0)+1;
  this._month=value;
  this.setData({month:value,monthDisplay:fmt.monthText(value),urgeNotice:''});
  await this.loadProgress();
 },
 async urge(e){
  const childOwner=e.currentTarget.dataset.owner;
  if(!childOwner||this.data.urgeBusy||this.data.busy)return;
  const {month}=this.data,serial=this._serial,revision=this._monthRevision,token=api.session()?.token;
  const current=()=>serial===this._serial&&revision===this._monthRevision&&token===api.session()?.token;
  this.setData({urgeBusy:childOwner,urgeNotice:'',progressError:''});
  try{
   const result=await api.command('agency.urge',{childOwner,month});
   if(!current())return;
   const count=result.result.agencyUrgeSummary.outletCount;
   this.setData({urgeNotice:'已向直属二级代理发送 '+count+' 条站内催报。'});
   await this.loadProgress();
  }catch(error){if(current())this.setData({progressError:error.message});}
  finally{this.setData({urgeBusy:''});}
 },
 async retry(){await this.loadProgress();}
}));
