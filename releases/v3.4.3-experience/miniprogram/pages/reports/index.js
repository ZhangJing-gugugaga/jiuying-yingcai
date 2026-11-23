const {define,go,api,fmt}=require('../../utils/page');
const reportFilters=new Set(['all','pending','finance','approved','returned','late']);
const specialFilters={draft:'drafts',missing:'businessTasks',exempt:'exemptions'};

Page(define({
 collections:[
  {name:'outlets',visible(){return !this.data.isPublic;}},
  {name:'reports',visible(){return !this.data.isPublic&&reportFilters.has(this.data.filter);},
   filters(){const {month,filter,outlet}=this.data;return {month,outlet,status:filter==='late'?'all':filter,includeVersionNumbers:'true'};}},
  {name:'drafts',visible(){return !this.data.isPublic&&['all','draft'].includes(this.data.filter)&&this.data.session?.role==='partner';},
   filters(){return {month:this.data.month,outlet:this.data.outlet};}},
  {name:'businessTasks',visible(){return !this.data.isPublic&&this.data.filter==='missing';},
   filters(){return {month:this.data.month,outlet:this.data.outlet,status:'open'};}},
  {name:'exemptions',visible(){return !this.data.isPublic&&this.data.filter==='exempt';},
   filters(){return {month:this.data.month,outlet:this.data.outlet};}}
 ],
 data:{rows:[],draftRows:[],specialRows:[],month:fmt.month(-1),monthDisplay:'',filter:'all',outlet:'all',outletIndex:0,options:[]},
 async select(values){this.setData({...values,rows:[],draftRows:[],specialRows:[]});await this.refresh();},
 async changeMonth(e){await this.select({month:e.detail.value});},
 async filter(e){await this.select({filter:e.currentTarget.dataset.value});},
 async pickOutlet(e){const outlet=this.data.options[Number(e.detail.value)];if(outlet)await this.select({outlet:outlet.id});},
 loaded(state){
  if(this.data.isPublic)return;
  const {month,filter,outlet}=this.data;
  const options=[{id:'all',name:'全部网点'},...state.outlets.filter(row=>row.owner)];
  const visible=state.reports.filter(row=>row.month===month&&(filter!=='late'||row.lateSubmission||row.late));
  const rows=visible.map(row=>{
   const {effective,latest}=row.versionNumbers||{};
   return {...row,monthDisplay:fmt.monthText(row.month),
    effectiveText:effective==null?(row.versionNumbers?'暂无已通过版本':'查看当前有效版本'):'当前有效版本：V'+effective,
    submittedText:latest==null?(row.versionNumbers?'尚未提交':'查看最近提交版本'):'最近提交：V'+latest};
  });
  const draftRows=state.drafts.filter(row=>row.month===month).map(row=>({...row,monthDisplay:fmt.monthText(row.month)}));
  const specialRows=(specialFilters[filter]&&filter!=='draft'?state[specialFilters[filter]]||[]:[])
   .filter(row=>row.month===month&&(filter!=='missing'||row.kind==='report_missing'))
   .map(row=>({...row,monthDisplay:fmt.monthText(row.month),statusText:filter==='missing'?'待填写':'已免报',
    statusTone:fmt.statusTone(filter==='missing'?'missing':'exempt','report')}));
  this.setData({options,outletIndex:Math.max(0,options.findIndex(row=>row.id===outlet)),
   monthDisplay:fmt.monthText(month),rows,draftRows,specialRows,specialCollection:specialFilters[filter]||''});
 },
 newReport(){if(!this.data.state||this.data.isPublic)return;go('report',api.query({month:this.data.month,outlet:this.data.outlet==='all'?'':this.data.outlet}));},
 open(e){
  if(!this.data.state||this.data.isPublic)return;
  const {outlet,month=this.data.month,id}=e.currentTarget.dataset;
  go('report',api.query({outlet,month,id}));
 }
}));
