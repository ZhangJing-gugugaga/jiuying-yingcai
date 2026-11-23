const {define,go,api,fmt,openRecord}=require('../../utils/page');
const {withPublicCover,markCoverUnavailable}=require('../../utils/public-content');

const actions={
 report_returned:{category:'待我修改',hint:'请根据总部意见修改后重新提交。',button:'去修改'},
 report_missing:{category:'待我提交',button:'去填写'},
 location_missing:{category:'待我提交',hint:'请提交本月位置资料。',button:'去核验'},
 location_exception:{category:'待我补充',button:'去补充'},
 request_supplement:{category:'待我补充',button:'去补充'},
 support_waiting:{category:'待我补充',button:'去补充'},
 bill_unpaid:{category:'待我提交',button:'查看账单'},
 bill_overdue:{category:'待我提交',button:'查看账单'}
};

const home=define({
  collections:[{name:'outlets',visible(){return !this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'accounts',visible(){return !this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'publicContents',visible(){return this.data.isPublic;}}],
  data:{period:'',hasCurrentSettlement:false,latestSettledMonth:'',outletCount:null,managerName:'',displayDate:'',asOf:'',reviewing:false,metrics:[],todos:[],todoGroups:[],todoTotal:0,unread:0,groupIntro:null,publishedServices:[],publicUpdates:[]},
  async loaded(state){
    const serial=this._serial;
    const isPublic=state.actor==='public';
    const unreadRequest=api.collection('messages',{status:'unread',limit:1});
    if(isPublic){
      const contents=state.publicContents||[];
      const groupIntro=contents.find(record=>record.key==='brand')||null;
      const publishedServices=contents.filter(record=>/^service-[1-5]$/.test(record.key))
        .sort((first,second)=>first.key.localeCompare(second.key));
      const publicUpdates=contents.filter(record=>['news','cases'].includes(record.key));
      this.setData({groupIntro,publishedServices,publicUpdates,todos:[],todoGroups:[],todoTotal:0,metrics:[],hasCurrentSettlement:false,latestSettledMonth:''});
      const [intro,services,messages]=await Promise.all([
        withPublicCover(groupIntro),Promise.all(publishedServices.map(withPublicCover)),unreadRequest.catch(()=>({total:0}))
      ]);
      if(serial===this._serial)this.setData({groupIntro:intro,publishedServices:services,unread:messages.total});
      return;
    }
    const period=state.today?.slice(0,7)||fmt.month();
    const dashboard='/api/dashboard?'+api.query({period,kind:'month',mode:'settled',outlet:'all',limit:1,includeSettlementMonths:'true'});
    const [messages,data,open,inProgress]=await Promise.all([
      unreadRequest,
      api.request(dashboard),
      api.collection('businessTasks',{status:'open',limit:8}),
      api.collection('businessTasks',{status:'in_progress',limit:8})
    ]);
    if(serial!==this._serial)return;
    const totals=data.totals||{};
    const hasCurrentSettlement=data.settlementMonths?.hasCurrent===true;
    const monthEnd=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);
    const todos=[...open.items,...inProgress.items].map(task=>({
      ...task,
      title:fmt.taskLabel(task.kind),
      category:task.status==='in_progress'?'处理中':actions[task.kind]?.category||'待处理',
      actionText:actions[task.kind]?.button||'查看详情',
      helpText:actions[task.kind]?.hint||'',
      detail:[task.outletName,fmt.monthText(task.month),...(Number.isFinite(task.amount)?['应付'+fmt.money(task.amount)+'元']:[])].filter(Boolean).join(' · ')
    }));
    this.setData({
      period,
      managerName:state.accounts[0]?.managerName||'',
      outletCount:this.data.pagers.outlets?.total??null,
      displayDate:fmt.dateText(state.today),
      asOf:hasCurrentSettlement?fmt.dateText(monthEnd):'',
      reviewing:data.reportingCoverage?.pendingReview>0,
      hasCurrentSettlement,
      latestSettledMonth:data.settlementMonths?.latestPriorMonth||'',
      unread:messages.total,
      metrics:hasCurrentSettlement?[
        {label:'营业收入 · 元',value:fmt.money(totals.revenue)},
        {label:'有效完成订单 · 单',value:totals.orders??'—'},
        {label:'到店人次',value:totals.traffic??'—'},
        {label:'实际招生人数',value:totals.enroll??'—'}
      ]:[],
      partial:data.partial,
      todoTotal:open.total+inProgress.total,
      todos,
      todoGroups:open.items.length ? [{status:'open',items:todos.slice(0,Math.min(2,open.items.length))}]
        : inProgress.items.length ? [{status:'in_progress',items:todos.slice(0,2)}] : []
    });
  },
  openService(e){
    const id=e.currentTarget.dataset.id;
    if(this.data.publishedServices.some(record=>record.id===id))go('service-detail',api.query({id}));
  },
  openPublicUpdate(e){
    const section=e.currentTarget.dataset.section;
    if(this.data.publicUpdates.some(record=>record.key===section))go('discover',api.query({section}));
  },
  publicCoverFailed(e){
    const id=e.currentTarget.dataset.id;
    this.setData({groupIntro:markCoverUnavailable(this.data.groupIntro?[this.data.groupIntro]:[],id)[0]||null,
      publishedServices:markCoverUnavailable(this.data.publishedServices,id)});
  },
  openSettled(){
    const period=this.data.latestSettledMonth;
    if(period)go('dashboard',api.query({period}));
  },
  async openTodo(e){
    if(this.data.loading||this.data.isPublic||!this.data.session?.token||this.data.session.token!==api.session()?.token)return;
    try{
      const task=this.data.todos.find(item=>item.id===e.currentTarget.dataset.id);
      if(task)await openRecord(task);
    }catch(error){
      this.setData({error:error.message});
    }
  }
});
const refresh=home.refresh;
home.refresh=function(){
  if(this.data.isPublic)this.setData({groupIntro:null,publishedServices:[],publicUpdates:[]});
  return refresh.call(this);
};
Page(home);
