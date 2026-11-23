const {define,go,api,fmt,openRecord,canOpenRecord}=require('../../utils/page');
const {recordErrorText}=require('../../utils/navigation');
const {workbenchTask}=require('../tasks/matters');
const {loadBusinessRecords,businessRecord,openBusinessRecord}=require('../../utils/workbench-records');
const {withPublicCover,retainPublicCover}=require('../../utils/public-content');
const {publicShare}=require('../../utils/public-share');
/* DEV_ONLY_START */
const roleTrial=require('../../development/role-trial');
/* DEV_ONLY_END */
const homeShare={title:'九盈英才集团与网点服务',path:'/pages/home/index?scope=public',query:'scope=public'};
const serviceTiles=[
  ['education','blue'],['book-open','sky'],['service','violet'],['layers','gold'],['chart-bar','green']
];
const firstOutletLoading={status:'loading',detail:'正在确认申请进度…'};
const firstOutletError={status:'error',detail:'暂时无法确认申请进度。'};
const firstOutletStages={
  pending:{detail:'等待总部处理。您可以查看已提交的资料和办理进度。',actionText:'查看申请进度'},
  returned:{detail:'需要补充。请查看总部退回原因，补齐资料后提交。',actionText:'查看原因并补充'},
  supplement:{detail:'需要补充。请按总部说明补齐资料。',actionText:'查看原因并补充'},
  approved:{detail:'已审批。可查看原申请，或刷新网点列表确认是否已更新。',actionText:'查看已通过申请'}
};

async function firstOutletProgress(page){
  try{
    const {items,total}=await api.collection('requests',{type:'newOutlet',limit:1},page);
    if(total===0&&items.length===0)return {status:'empty',detail:'提交网点资料后，可在这里查看总部处理进度。',actionText:'申请新增网点'};
    const latest=items[0];
    if(total>0&&latest?.type==='newOutlet'&&typeof latest.id==='string'&&latest.id&&Object.hasOwn(firstOutletStages,latest.status)){
      return {status:latest.status,id:latest.id,...firstOutletStages[latest.status]};
    }
  }catch{
    // Keep the application action unavailable until its status is known.
  }
  return firstOutletError;
}

const viewData={
  outletCount:null,managerName:'',firstOutlet:null,displayDate:'',openTotal:null,taskError:false,
  scopeOutlet:'',scopeIndex:0,scopeOutlets:[],scopeLabels:[],scopeName:'',scopeStatus:'',scopeTone:'',
  activeRows:[],recentRows:[],recentError:false,taskLoading:false,recentLoading:false,openingTask:false,taskOpenError:'',
  trainingRecord:null,moreBusiness:false,
  hasUnreadNotices:false,groupIntro:null,publishedServices:[],headquartersPhone:''
};
const home=define({
  collections:[{name:'outlets',visible(){return !this.data.publicView&&!this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'accounts',visible(){return !this.data.publicView&&!this.data.isPublic&&this.data.session?.role==='partner';}},
   {name:'publicContents',visible(){return this.data.publicView||this.data.isPublic;}}],
  data:{publicView:false,publicLanding:false,...viewData},
  load(q){
    this.query=q.scope==='public'?{scope:'public'}:{};
    this.setData({publicLanding:q.scope==='public'});
  },
  /* DEV_ONLY_START */
  async openTrialApplication(){
    if(!roleTrial.enabled||this.data.roleTrialBusy)return;
    this.setData({roleTrialBusy:true,roleTrialError:''});
    try{
      const {roleTrial:trial}=await api.request('/api/config');
      if(!trial?.onboarding?.id)throw new Error('试用申请暂时无法打开，请重试。');
      await roleTrial.enter('applicant');
      go('join',api.query({id:trial.onboarding.id}));
    }
    catch(error){this.setData({roleTrialError:error.message});}
    finally{this.setData({roleTrialBusy:false});}
  },
  async openTrialWorkbench(){
    if(!roleTrial.enabled||this.data.roleTrialBusy)return;
    this.setData({roleTrialBusy:true,roleTrialError:''});
    try{await roleTrial.enter('partner');await this.onShow();}
    catch(error){this.setData({roleTrialError:error.message});}
    finally{this.setData({roleTrialBusy:false});}
  },
  async openTrialReport(){
    if(!roleTrial.enabled)return;
    try{
      const {roleTrial:trial}=await api.request('/api/config');
      if(trial?.report)go('report',api.query({outlet:trial.report.outlet,month:trial.report.month}));
    }catch(error){this.setData({roleTrialError:error.message});}
  },
  /* DEV_ONLY_END */
  ...publicShare(()=>homeShare,function(){return this.data.publicView;}),
  async loaded(state){
    const serial=this._serial;
    if(state.actor==='public'||this.data.publicView){
      const session=this.data.session;
      const isVisitor=state.actor==='public'&&session?.role==='public';
      const contents=state.publicContents||[];
      const groupIntro=retainPublicCover(contents.find(record=>record.key==='brand')||null,this.data.groupIntro);
      const publishedServices=contents.filter(record=>/^service-[1-5]$/.test(record.key))
        .sort((first,second)=>first.key.localeCompare(second.key))
        .map(record=>{
          const [tileIcon,tileTone]=serviceTiles[Number(record.key.slice(-1))-1];
          const previous=this.data.publishedServices.find(service=>service.id===record.id);
          return {...retainPublicCover(record,previous),tileIcon,tileTone};
        });
      const phone=String(state.support?.settings?.phone||'').replace(/[\s()-]/g,'');
      this.setData({publicView:true,groupIntro,publishedServices,headquartersPhone:/^\+?\d{5,20}$/.test(phone)?phone:'',
        openTotal:null,taskError:false,...(!isVisitor?{hasUnreadNotices:false}:{})});
      this.updatePublicShareMenu();
      await Promise.all([
        groupIntro?.imageId&&!groupIntro.coverPath?withPublicCover(groupIntro).then(record=>{
          if(serial===this._serial)this.setData({groupIntro:record});
        }):null,
        ...publishedServices.filter(service=>service.imageId&&!service.coverPath).map(async service=>{
          const loaded=await withPublicCover(service);
          if(serial===this._serial)this.setData({publishedServices:this.data.publishedServices.map(row=>row.id===loaded.id?loaded:row)});
        }),
        isVisitor?api.collection('messages',{status:'unread',limit:1},this).catch(()=>null).then(messages=>{
          if(serial===this._serial&&api.session()?.token===session.token){
            this.setData({hasUnreadNotices:messages?.total>0});
          }
        }):null
      ]);
      return;
    }
    const view=this._homeView;
    const isCurrent=()=>{
      const session=api.session();
      return serial===this._serial&&view===this._homeView&&session?.token===view?.token&&session?.role===view?.role;
    };
    if(!isCurrent())return;
    const outletCount=this.data.pagers.outlets?.total??null;
    const needsFirstOutlet=outletCount===0;
    const scopeOutlets=state.outlets||[];
    const prior=this.data.scopeOutlet;
    const retained=prior&&this.data.pagers.outlets?.hasMore&&!scopeOutlets.some(row=>row.id===prior)
      ?await api.detail('outlets',prior).catch(()=>null):null;
    if(!isCurrent())return;
    const choices=retained?.id===prior?[retained,...scopeOutlets]:scopeOutlets;
    this.setData({outletCount,scopeOutlets:choices,scopeLabels:['全部授权网点',...choices.map(row=>[row.name,row.city,row.district].filter(Boolean).join(' · '))],
      managerName:state.accounts?.[0]?.managerName||'',
      displayDate:fmt.dateText(state.today),firstOutlet:needsFirstOutlet?firstOutletLoading:null});
    this.setOutletScope(outletCount===1?choices[0]?.id:prior);
    const firstApplication=needsFirstOutlet?firstOutletProgress(this).then(firstOutlet=>{
      if(isCurrent())this.setData({firstOutlet});
    }):null;
    await Promise.all([firstApplication,this.loadWorkbenchTasks(),
      api.collection('messages',{status:'unread',limit:1},this).catch(()=>null).then(result=>{
        if(isCurrent())this.setData({hasUnreadNotices:result?.total>0});
      })]);
  },
  setOutletScope(id){
    const index=this.data.scopeOutlets.findIndex(outlet=>outlet.id===id);
    const outlet=index>=0?this.data.scopeOutlets[index]:null;
    this._selectedOutlet=outlet;
    this.setData({scopeOutlet:outlet?.id||'',scopeIndex:index+1,scopeName:outlet?.name||'全部授权网点',
      scopeStatus:outlet?.status?fmt.label(outlet.status,'outlet'):'',scopeTone:outlet?.status?fmt.statusTone(outlet.status,'outlet'):''});
  },
  chooseWorkbenchOutlet(e){
    const index=Number(e.detail.value);
    if(!this.isWorkbenchSession()||!Number.isInteger(index)||index<0||index>this.data.scopeOutlets.length||index===this.data.scopeIndex)return;
    this.setOutletScope(this.data.scopeOutlets[index-1]?.id);
    return this.loadWorkbenchTasks();
  },
  isWorkbenchSession(){
    const session=api.session();
    return !this.data.publicView&&session?.role==='partner'&&session.token===this._homeView?.token;
  },
  async loadWorkbenchTasks(){
    if(!this.isWorkbenchSession())return;
    const serial=this._serial,attempt={},outlet=this.data.scopeOutlet||undefined;
    this._workbenchLoad=attempt;
    this._workbenchRows=[];
    this.setData({taskLoading:true,recentLoading:true,activeRows:[],recentRows:[],openTotal:null,taskError:false,recentError:false,
      openingTask:false,taskOpenError:'',trainingRecord:null});
    this._workbenchOpen=null;
    const current=()=>serial===this._serial&&this._workbenchLoad===attempt&&this.isWorkbenchSession();
    await Promise.all([
      api.collection('businessTasks',{status:'open',outlet,limit:4},this).catch(()=>null).then(result=>{
        if(!current())return;
        this._workbenchRows=result?.items||[];
        this.setData({taskLoading:false,activeRows:this._workbenchRows.map(workbenchTask),
          openTotal:result?.total??null,taskError:!result});
      }),
      loadBusinessRecords(outlet,3,0,this).catch(()=>null).then(result=>{
        if(current())this.setData({recentLoading:false,recentRows:(result?.items||[]).map(businessRecord),recentError:!result});
      }),
      api.request('/api/training/records?'+api.query({outlet,limit:1,status:'returned'}),'GET',undefined,{},true,this).catch(()=>null).then(result=>{
        if(current())this.setData({trainingRecord:result?.items?.[0]||null});
      })
    ]);
  },
  async openWorkbenchTask(e){
    if(!this.isWorkbenchSession()||this.data.openingTask)return;
    const {id,key}=e.currentTarget.dataset;
    const recent=key&&this.data.recentRows.find(row=>row.rowKey===key);
    const task=id&&this._workbenchRows?.find(row=>row.id===id);
    if(!recent&&(!task||!canOpenRecord(task)))return;
    const attempt={},serial=this._serial;
    this._workbenchOpen=attempt;
    const current=()=>serial===this._serial&&this._workbenchOpen===attempt&&this.isWorkbenchSession();
    const settled=()=>{
      if(!current())return;
      this._workbenchOpen=null;
      this.setData({openingTask:false});
    };
    this.setData({openingTask:true,taskOpenError:''});
    try{
      const options={isCurrent:current,onSettled:settled};
      const started=recent?await openBusinessRecord(recent,options):await openRecord(task,{...options,
        editReturned:task.kind==='report_returned'&&task.status==='open'});
      if(!started)settled();
    }catch(error){
      if(current())this.setData({taskOpenError:recordErrorText(error)});
      settled();
    }
  },
  openWorkbenchList(e){
    if(!this.isWorkbenchSession())return;
    const {status,section}=e.currentTarget.dataset;
    go('tasks',api.query({section,status,outlet:this.data.scopeOutlet||undefined}));
  },
  openTrainingSupplement(){
    if(!this.isWorkbenchSession())return;
    const record=this.data.trainingRecord;
    if(record?.id&&record.outletId)go('training',api.query({id:record.id,outlet:record.outletId}));
  },
  openScopedTool(e){
    if(!this.isWorkbenchSession())return;
    const {page}=e.currentTarget.dataset;
    const outlet=this.data.scopeOutlet||undefined;
    if(page==='reports'||page==='fees'||page==='support')go(page,api.query({outlet:outlet||(page==='reports'?'all':undefined),
      section:page==='support'?'home':undefined}));
  },
  toggleMoreBusiness(){
    if(this.isWorkbenchSession())this.setData({moreBusiness:!this.data.moreBusiness});
  },
  openOutletBusiness(e){
    if(!this.isWorkbenchSession())return;
    const outlet=this._selectedOutlet;
    if(!outlet)return this.openOutlets();
    const {page,type}=e.currentTarget.dataset;
    if(page==='location')go(page,api.query({outlet:outlet.id,month:this.data.state?.today?.slice(0,7)}));
    if(page==='requests'&&['statusChange','pauseFee'].includes(type))go(page,api.query({outlet:outlet.id,
      filterOutlet:outlet.id,type,status:type==='statusChange'?'paused':undefined}));
  },
  returnWorkbench(){
    this.query={};
    this.setData({publicLanding:false});
    return this.refresh();
  },
  openService(e){
    const id=e.currentTarget.dataset.id;
    if(this.data.publishedServices.some(record=>record.id===id))go('service-detail',api.query({id}));
  },
  publicCoverFailed(e){
    const {id,coverPath}=e.currentTarget.dataset;
    const rows=this.data.publishedServices;
    if(rows.some(row=>row.id===id&&row.coverPath&&row.coverPath===coverPath)){
      this.setData({publishedServices:rows.map(row=>row.id===id?{...row,coverPath:'',coverUnavailable:true}:row)});
    }
  },
  groupCoverFailed(e){
    const {groupIntro}=this.data;
    const {id,coverPath}=e.currentTarget.dataset;
    if(groupIntro?.coverPath&&groupIntro.id===id&&groupIntro.coverPath===coverPath){
      this.setData({groupIntro:{...groupIntro,coverPath:'',coverUnavailable:true}});
    }
  },
  dialHeadquarters(){
    const phoneNumber=this.data.headquartersPhone;
    if(this.data.publicView&&phoneNumber)wx.makePhoneCall({phoneNumber,
      fail:()=>wx.showToast?.({title:'无法拨打电话，请稍后重试',icon:'none'})});
  },
  openOutlets(){
    if(this.data.firstOutlet?.actionText&&!this.data.error)return this.openFirstOutlet();
    go('outlets','scope=private');
  },
  openFirstOutlet(){
    const session=api.session();
    const firstOutlet=this.data.firstOutlet;
    if(!firstOutlet?.actionText||this.data.error||this.data.publicView||session?.role!=='partner'||session.token!==this._homeView?.token)return;
    go('requests',api.query(firstOutlet.id?{id:firstOutlet.id}:{type:'newOutlet'}));
  },
});
const refresh=home.refresh;
home.refresh=function(){
  const session=api.session();
  const publicView=this.data.publicLanding||!session||session.role==='public';
  const token=session?.token;
  const previous=this._homeView;
  const changed=!previous||previous.publicView!==publicView||previous.token!==token||previous.role!==session?.role;
  if(changed){
    this._homeView={publicView,token,role:session?.role};
    this._selectedOutlet=null;
  }
  this._workbenchRows=[];
  this._workbenchOpen=null;
  this.setData({publicView,session,...(changed?viewData:this.data.firstOutlet?{firstOutlet:firstOutletLoading}:{}),
    ...(!publicView?{taskLoading:true,recentLoading:true,activeRows:[],recentRows:[],trainingRecord:null,openingTask:false,taskOpenError:''}:{})});
  this.updatePublicShareMenu();
  return refresh.call(this);
};
/* DEV_ONLY_START */
if(roleTrial.enabled){
  const onShow=home.onShow;
  home.onShow=async function(){
    try{
      await roleTrial.resume();
      this.setData({roleTrial:true,roleTrialMode:roleTrial.mode(),roleTrialError:''});
      return onShow.call(this);
    }catch(error){this.setData({roleTrial:true,roleTrialError:error.message});}
  };
}
/* DEV_ONLY_END */
Page(home);
