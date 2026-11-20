const {define,go,api,fmt}=require('../../utils/page');
const reportFilters=new Set(['all','todo','reviewing','pending','finance','approved','returned','late']);
const specialFilters={draft:'drafts',missing:'businessTasks',exempt:'exemptions'};
function calendarMonth(page){return page.data.state?.today?.slice(0,7)||fmt.month();}
function selectedMonth(page){
 return page.query.month||fmt.addMonth(calendarMonth(page),-1);
}

Page(define({
 collections:[
  {name:'outlets',visible(){return !this.data.isPublic;}},
  {name:'reports',visible(){return !this.data.isPublic&&reportFilters.has(this.data.filter);},
   filters(){
    const {filter,outlet}=this.data;
    const status=filter==='todo'?'returned':['late','reviewing'].includes(filter)?'all':filter;
    return {month:selectedMonth(this),outlet,status,includeVersionNumbers:'true',latestOnly:'true'};
   }},
  {name:'drafts',visible(){return !this.data.isPublic&&selectedMonth(this)<calendarMonth(this)&&['all','todo','draft'].includes(this.data.filter)&&this.data.session?.role==='partner';},
   filters(){return {month:selectedMonth(this),outlet:this.data.outlet};}},
  {name:'businessTasks',visible(){return this.data.session?.role==='partner'&&selectedMonth(this)<calendarMonth(this)&&['all','todo','missing'].includes(this.data.filter);},
   filters(){return {month:selectedMonth(this),outlet:this.data.outlet,status:'open',kind:'report_missing'};}},
  {name:'exemptions',visible(){return !this.data.isPublic&&selectedMonth(this)<calendarMonth(this)&&['all','exempt'].includes(this.data.filter);},
   filters(){return {month:selectedMonth(this),outlet:this.data.outlet};}}
 ],
 data:{
  rows:[],draftRows:[],reportRows:[],month:'',monthDisplay:'',currentMonth:'',previousMonth:'',
  periodHint:'',canOpenEditor:false,filter:'all',displayFilter:'all',outlet:'all',outletIndex:0,options:[],
  moreCollections:[],loadingReports:false,coverage:null
 },
 load(query){
  if(query.month&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(query.month))delete query.month;
  this._selectedFilter=false;
  this.setData({outlet:query.outlet||'all',month:query.month||'',filter:'all',displayFilter:'all',coverage:null});
 },
 async select(values){
  if(this.data.loading||this.data.loadingReports)return;
  if(values.outlet)this.query.outlet=values.outlet;
  if(values.month)this.query.month=values.month;
  this.setData({...values,rows:[],draftRows:[],reportRows:[],moreCollections:[],coverage:null});
  await this.refresh();
 },
 async changeMonth(e){await this.select({month:e.detail.value});},
 async pickMonthShortcut(e){
  const month=e.currentTarget.dataset.value==='current'?this.data.currentMonth:this.data.previousMonth;
  if(month)await this.select({month});
 },
 async filter(e){
  const filter=e.currentTarget.dataset.value;
  if(!reportFilters.has(filter)&&!Object.hasOwn(specialFilters,filter))return;
  this._selectedFilter=true;
  await this.select({filter,displayFilter:filter});
 },
 async pickOutlet(e){const outlet=this.data.options[Number(e.detail.value)];if(outlet)await this.select({outlet:outlet.id});},
 clearOutlet(){return this.select({outlet:'all'});},
 loaded(state){
  if(this.data.isPublic)return;
  const {filter,outlet}=this.data;
  const month=selectedMonth(this),currentMonth=calendarMonth(this),previousMonth=fmt.addMonth(currentMonth,-1);
  const options=[{id:'all',label:'全部网点'},...state.outlets.filter(row=>row.owner)
   .map(row=>({...row,label:fmt.outletOptionLabel(row)}))];
  const outletIndex=options.findIndex(row=>row.id===outlet);
  const rows=state.reports.filter(row=>row.month===month&&
   (row.versionNumbers?.latest==null||row.version===row.versionNumbers.latest)&&
   (filter!=='late'||row.lateSubmission||row.late)&&
   (filter!=='reviewing'||['pending','finance'].includes(row.status))).map(row=>{
   const returned=row.status==='returned'&&!row.revoked;
   return {...row,kind:'report',actionText:returned?'查看退回原因':'查看月报',returned,
    submittedText:fmt.dateText(row.submittedAt||row.createdAt)};
  });
  const currentByOutlet=new Map(rows.map(row=>[row.outlet,row]));
  const draftRows=state.drafts.filter(row=>row.month===month).map(row=>{
   const returned=currentByOutlet.get(row.outlet);
   return {...row,kind:'draft',statusText:'草稿',statusTone:'wait',actionText:'继续填写',review:returned?.returned?returned.review:''};
  });
  const exemptions=state.exemptions.filter(row=>row.month===month).map(row=>({
   ...row,kind:'exemption',statusText:'已免报',statusTone:'ok',actionText:'查看详情'
  }));
  const covered=new Set([...rows,...draftRows,...exemptions].map(row=>row.outlet));
  const missing=state.businessTasks.filter(row=>row.kind==='report_missing'&&row.month===month&&!covered.has(row.outlet)).map(row=>({
   ...row,kind:'missing',statusText:'待填写',statusTone:'wait',actionText:'去填写',dueText:fmt.dateText(row.dueOn||row.dueAt)
  }));
  const drafted=new Set(draftRows.map(row=>row.outlet));
  const todo=[...draftRows,...rows.filter(row=>row.returned&&!drafted.has(row.outlet)),...missing];
  const displayFilter=!this._selectedFilter&&filter==='all'&&todo.length?'todo':filter;
  const reportRows=displayFilter==='todo'?todo:[
   ...draftRows,...rows.filter(row=>!drafted.has(row.outlet)),...missing,...exemptions
  ];
  const activeCollections=['reports','drafts','businessTasks','exemptions'];
  const moreCollections=activeCollections.filter(name=>this.data.pagers[name]?.hasMore&&(displayFilter!=='todo'||name!=='exemptions'));
  const periodHint=month>=currentMonth?'本经营月份尚未开放填报。月报填报已结束的自然月。':
   !this.query.month?'本月尚未结束，当前显示上月经营月报。':'';
  this.setData({options,outletIndex,month,currentMonth,previousMonth,periodHint,monthDisplay:fmt.monthText(month),
   canOpenEditor:month<currentMonth&&outletIndex>=0,rows,draftRows,reportRows,displayFilter,moreCollections});
  if(month<currentMonth&&this.data.session?.role==='partner')void this.loadCoverage(month,outlet);
 },
 async loadCoverage(month,outlet){
  const serial=this._serial,token=api.session()?.token;
  if(this._coverageSerial===serial)return;
  this._coverageSerial=serial;
  this.setData({coverage:null});
  try{
   const {reportingCoverage}=await api.request('/api/dashboard?'+api.query({period:month,outlet,kind:'month',mode:'process',limit:1}));
   if(serial!==this._serial||token!==api.session()?.token)return;
   const {expected,submitted,exempt}=reportingCoverage||{};
   if(![expected,submitted,exempt].every(value=>Number.isSafeInteger(value)&&value>=0)||submitted>expected)return;
   this.setData({coverage:{expected,submitted,exempt,percent:expected?Math.round(submitted/expected*100):0}});
  }catch{}
 },
 async moreReports(){
  if(this.data.loading||this.data.loadingReports)return;
  this.setData({loadingReports:true});
  const serial=this._serial;
  try{
   for(const name of this.data.moreCollections){
    if(serial!==this._serial)return;
    await this.fetchCollection(name);
   }
  }catch{}finally{this.setData({loadingReports:false});}
 },
 newReport(){
  if(!this.data.state||this.data.loading||this.data.error||!this.data.canOpenEditor||this.data.session?.role!=='partner')return;
  go('report',api.query({month:selectedMonth(this),outlet:this.data.outlet==='all'?'':this.data.outlet}));
 },
 open(e){
  if(!this.data.state||this.data.isPublic||this.data.loading||this.data.error)return;
  const {outlet,month=this.data.month,id}=e.currentTarget.dataset;
  go('report',api.query({outlet,month,id}));
 }
}));
