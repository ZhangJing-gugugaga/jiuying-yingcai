const {define,go,api,fmt,openRecord,canOpenRecord}=require('../../utils/page');
const {recordErrorText}=require('../../utils/navigation');
const {withPublicCover,markCoverUnavailable}=require('../../utils/public-content');
const {publicShare}=require('../../utils/public-share');
const homeShare={title:'九盈英才集团与网点服务',path:'/pages/home/index?scope=public',query:'scope=public'};

const actions={
 report_returned:{category:'待我修改',hint:'请根据总部意见修改后重新提交。',button:'去修改'},
 report_missing:{category:'待我提交',button:'去填写'},
 location_missing:{category:'待我提交',hint:'请提交本月位置资料。',button:'去核验'},
 location_exception:{category:'待我补充',button:'去补充'},
 request_supplement:{category:'待我补充',button:'去补充'},
 training_material_returned:{category:'待我补充',button:'补交材料'},
 support_waiting:{category:'待我补充',button:'去补充'},
 bill_unpaid:{category:'待我提交',button:'查看账单'},
 bill_overdue:{category:'待我提交',button:'查看账单'}
};
function compareTasks(first,second){
  const deadline=task=>task.dueAt?.length===10?Date.parse(task.dueAt+'T23:59:59+08:00'):Date.parse(task.dueAt);
  return Number(second.overdue===true)-Number(first.overdue===true)||
    (deadline(first)||Infinity)-(deadline(second)||Infinity)||
    (second.createdAt||'').localeCompare(first.createdAt||'');
}
function dueText(task,today){
  const due=fmt.dateText(task.dueAt);
  if(!due)return '';
  if(task.overdue)return '已超期 · '+due+'截止';
  if(due===fmt.dateText(today))return '今天截止';
  const tomorrow=Date.parse(today+'T00:00:00Z')+86400000;
  if(Number.isFinite(tomorrow)&&due===fmt.dateText(new Date(tomorrow).toISOString().slice(0,10)))return '明天截止';
  return due+'截止';
}
function dashboardFor(period){
  return '/api/dashboard?'+api.query({period,kind:'month',mode:'settled',outlet:'all',limit:1,includeSettlementMonths:'true'});
}
function settlementMetrics(totals={}){
  return [
    {label:'营业收入 · 元',value:fmt.money(totals.revenue)},
    {label:'有效完成订单 · 单',value:totals.orders??'—'},
    {label:'到店人次',value:totals.traffic??'—'},
    {label:'实际招生人数',value:totals.enroll??'—'}
  ];
}

const viewData={
  period:'',hasCurrentSettlement:false,latestSettledMonth:'',latestSettledMonthText:'',outletCount:null,managerName:'',
  displayDate:'',asOf:'',reviewing:false,metrics:[],latestMetrics:[],todos:[],todoPreview:[],taskPreviewReady:false,
  todoTotal:0,openTotal:0,inProgressTotal:0,openingTodo:false,todoError:'',taskError:false,summaryError:false,
  unread:0,groupIntro:null,publishedServices:[],headquartersPhone:''
};
const home=define({
  collections:[{name:'outlets',limit:1,visible(){return !this.data.publicView&&!this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'accounts',visible(){return !this.data.publicView&&!this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'publicContents',visible(){return this.data.publicView||this.data.isPublic;}}],
  data:{publicView:false,publicLanding:false,...viewData},
  load(q){
    this.query=q.scope==='public'?{scope:'public'}:{};
    this.setData({publicLanding:q.scope==='public'});
  },
  ...publicShare(()=>homeShare,function(){return this.data.publicView;}),
  async loaded(state){
    const serial=this._serial;
    if(state.actor==='public'||this.data.publicView){
      const contents=state.publicContents||[];
      const groupIntro=contents.find(record=>record.key==='brand')||null;
      const publishedServices=contents.filter(record=>/^service-[1-5]$/.test(record.key))
        .sort((first,second)=>first.key.localeCompare(second.key))
        .map(record=>({...record,initial:record.title?.trim().slice(0,1)||'九'}));
      const phone=String(state.support?.settings?.phone||'').replace(/[\s()-]/g,'');
      this.setData({publicView:true,groupIntro,publishedServices,headquartersPhone:/^\+?\d{5,20}$/.test(phone)?phone:'',
        todos:[],todoPreview:[],todoTotal:0,openTotal:0,inProgressTotal:0,taskError:false,summaryError:false,metrics:[],latestMetrics:[],
        hasCurrentSettlement:false,latestSettledMonth:'',latestSettledMonthText:'',unread:0});
      this.updatePublicShareMenu();
      const services=await Promise.all(publishedServices.map(withPublicCover));
      if(serial===this._serial)this.setData({publishedServices:services});
      return;
    }
    const period=state.today?.slice(0,7)||fmt.month();
    const [messageResult,summaryResult,openResult,inProgressResult]=await Promise.allSettled([
      api.collection('messages',{status:'unread',limit:1}),
      api.request(dashboardFor(period)),
      api.collection('businessTasks',{status:'open',limit:20}),
      api.collection('businessTasks',{status:'in_progress',limit:8})
    ]);
    if(serial!==this._serial)return;
    const data=summaryResult.value||{};
    const emptyTasks={items:[],total:0};
    const open=openResult.value||emptyTasks;
    const inProgress=inProgressResult.value||emptyTasks;
    const hasCurrentSettlement=data.settlementMonths?.hasCurrent===true;
    const latestSettledMonth=data.settlementMonths?.latestPriorMonth||'';
    const monthEnd=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).toISOString().slice(0,10);
    const todos=[...open.items,...inProgress.items].map(task=>({
      ...task,
      title:fmt.taskLabel(task.kind),
      category:task.status==='in_progress'?'处理中':actions[task.kind]?.category||'待处理',
      actionText:actions[task.kind]?.button||'查看详情',
      helpText:actions[task.kind]?.hint||'',
      dueText:dueText(task,state.today),
      detail:[task.outletName,fmt.monthText(task.month),...(Number.isFinite(task.amount)?['应付'+fmt.money(task.amount)+'元']:[])].filter(Boolean).join(' · ')
    }));
    this.setData({
      period,
      managerName:state.accounts[0]?.managerName||'',
      taskError:openResult.status==='rejected'||inProgressResult.status==='rejected',
      summaryError:summaryResult.status==='rejected',
      outletCount:this.data.pagers.outlets?.total??null,
      displayDate:fmt.dateText(state.today),
      asOf:hasCurrentSettlement?fmt.dateText(monthEnd):'',
      reviewing:data.reportingCoverage?.pendingReview>0,
      hasCurrentSettlement,
      latestSettledMonth,
      latestSettledMonthText:fmt.monthText(latestSettledMonth),
      unread:messageResult.value?.total??0,
      metrics:hasCurrentSettlement?settlementMetrics(data.totals):[],
      latestMetrics:[],
      partial:data.partial,
      todoTotal:open.total+inProgress.total,
      openTotal:open.total,
      inProgressTotal:inProgress.total,
      todos,
      taskPreviewReady:true,
      todoPreview:todos.filter(task=>task.status==='open'&&canOpenRecord(task))
        .sort(compareTasks).slice(0,3)
    });
    if(!hasCurrentSettlement&&latestSettledMonth){
      try{
        const latest=await api.request(dashboardFor(latestSettledMonth));
        if(serial!==this._serial)return;
        if(latest.settlementMonths?.hasCurrent===true)this.setData({latestMetrics:settlementMetrics(latest.totals)});
      }catch{
        // The dashboard link remains available for a fresh read if the snapshot cannot load.
      }
    }
  },
  returnWorkbench(){
    this.load({});
    return this.refresh();
  },
  openService(e){
    const id=e.currentTarget.dataset.id;
    if(this.data.publishedServices.some(record=>record.id===id))go('service-detail',api.query({id}));
  },
  publicCoverFailed(e){
    const id=e.currentTarget.dataset.id;
    this.setData({publishedServices:markCoverUnavailable(this.data.publishedServices,id)});
  },
  dialHeadquarters(){
    const phoneNumber=this.data.headquartersPhone;
    if(this.data.publicView&&phoneNumber)wx.makePhoneCall({phoneNumber,
      fail:()=>wx.showToast?.({title:'无法拨打电话，请稍后重试',icon:'none'})});
  },
  openSettled(){
    const period=this.data.latestSettledMonth;
    if(period)go('dashboard',api.query({period}));
  },
  async openTodo(e){
    if(!this.data.taskPreviewReady||this.data.openingTodo||this.data.publicView||this.data.isPublic)return;
    const task=this.data.todoPreview.find(row=>row.id===e.currentTarget.dataset.id);
    if(!task)return;
    const view=this._homeView;
    const isCurrent=()=>this._homeView===view&&api.session()?.token===view?.token;
    this.setData({openingTodo:true,todoError:''});
    try{
      await openRecord(task,{isCurrent});
    }catch(error){
      if(isCurrent())this.setData({todoError:recordErrorText(error)});
    }finally{
      if(isCurrent())this.setData({openingTodo:false});
    }
  }
});
const refresh=home.refresh;
home.refresh=function(){
  const session=api.session();
  const publicView=this.data.publicLanding||!session||session.role==='public';
  const token=publicView?undefined:session.token;
  const previous=this._homeView;
  const changed=!previous||previous.publicView!==publicView||previous.token!==token||previous.role!==session?.role;
  if(changed)this._homeView={publicView,token,role:session?.role};
  this.setData({publicView,session,todoError:'',...(changed?viewData:{})});
  this.updatePublicShareMenu();
  return refresh.call(this);
};
Page(home);
