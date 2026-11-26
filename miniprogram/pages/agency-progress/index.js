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
  if(this._token&&this._token!==token)this._month='';
  this._token=token;
  const today=state?.today||fmt.month();
  const month=this._month||previousMonth(today);
  this.setData({month,monthDisplay:fmt.monthText(month)});
  await this.loadProgress();
 },
 async loadProgress(){
  const serial=this._serial;
  if(this.data.progressLoading&&this._progressSerial===serial)return;
  this._progressSerial=serial;
  this.setData({progressLoading:true,ready:false,progressError:'',children:[],summary:null});
  try{
   const data=await api.request('/api/agency/progress?'+api.query({month:this.data.month}),'GET',undefined,{},true,this);
   if(serial!==this._serial)return;
   const children=(data.children||[]).map(child=>({...child,
    outletRows:(child.outlets||[]).map(row=>({...row,tone:tones[row.status]||'gray',
     dueText:row.dueOn?'应于 '+fmt.dateText(row.dueOn)+' 前报送':'',
     versionText:row.effectiveVersion&&row.latestVersion>row.effectiveVersion?'最新提交 V'+row.latestVersion+' · 当前有效 V'+row.effectiveVersion:row.effectiveVersion?'当前有效 V'+row.effectiveVersion:row.latestVersion?'最新提交 V'+row.latestVersion:'尚未提交'})),
    summaryText:child.summary.actionable?child.summary.actionable+' 个网点待报送':'本月无待催报网点',
    urgedText:child.lastUrgedAt?'最近催报 '+fmt.timeText(child.lastUrgedAt):''}));
   this.setData({children,summary:data.summary,ready:true});
  }catch(error){if(serial===this._serial)this.setData({progressError:error.message});}
  finally{if(this._progressSerial===serial)this.setData({progressLoading:false});}
 },
 async month(e){
  const value=e.detail.value;
  if(!validMonth.test(value))return;
  this._month=value;
  this.setData({month:value,monthDisplay:fmt.monthText(value),urgeNotice:''});
  await this.loadProgress();
 },
 async urge(e){
  const childOwner=e.currentTarget.dataset.owner;
  if(!childOwner||this.data.urgeBusy||this.data.busy)return;
  this.setData({urgeBusy:childOwner,urgeNotice:'',progressError:''});
  try{
   const result=await api.command('agency.urge',{childOwner,month:this.data.month});
   const count=result.result.agencyUrgeSummary.outletCount;
   this.setData({urgeNotice:'已向直属二级代理发送 '+count+' 条站内催报。'});
   await this.loadProgress();
  }catch(error){this.setData({progressError:error.message});}
  finally{this.setData({urgeBusy:''});}
 },
 async retry(){await this.loadProgress();}
}));