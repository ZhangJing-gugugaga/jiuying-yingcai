const {define,go,api,fmt}=require('../../utils/page');
const {withPublicCover,markCoverUnavailable}=require('../../utils/public-content');
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
  hasUnreadNotices:false,groupIntro:null,publishedServices:[],headquartersPhone:''
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
      const groupIntro=contents.find(record=>record.key==='brand')||null;
      const publishedServices=contents.filter(record=>/^service-[1-5]$/.test(record.key))
        .sort((first,second)=>first.key.localeCompare(second.key))
        .map(record=>{
          const [tileIcon,tileTone]=serviceTiles[Number(record.key.slice(-1))-1];
          return {...record,tileIcon,tileTone};
        });
      const phone=String(state.support?.settings?.phone||'').replace(/[\s()-]/g,'');
      this.setData({publicView:true,groupIntro,publishedServices,headquartersPhone:/^\+?\d{5,20}$/.test(phone)?phone:'',
        openTotal:null,taskError:false,...(!isVisitor?{hasUnreadNotices:false}:{})});
      this.updatePublicShareMenu();
      await Promise.all([
        withPublicCover(groupIntro).then(record=>{
          if(serial===this._serial)this.setData({groupIntro:record});
        }),
        Promise.all(publishedServices.map(withPublicCover)).then(services=>{
          if(serial===this._serial)this.setData({publishedServices:services});
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
    const needsFirstOutlet=view?.role==='partner'&&outletCount===0;
    this.setData({outletCount,firstOutlet:needsFirstOutlet?firstOutletLoading:null});
    const firstApplication=needsFirstOutlet?firstOutletProgress(this).then(firstOutlet=>{
      if(isCurrent())this.setData({firstOutlet});
    }):null;
    const [messageResult,taskResult]=await Promise.allSettled([
      api.collection('messages',{status:'unread',limit:1},this),
      api.collection('businessTasks',{status:'open',limit:1},this)
    ]);
    if(!isCurrent())return;
    this.setData({
      managerName:state.accounts[0]?.managerName||'',
      displayDate:fmt.dateText(state.today),
      openTotal:taskResult.value?.total??null,
      taskError:taskResult.status==='rejected',
      hasUnreadNotices:messageResult.value?.total>0
    });
    await firstApplication;
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
  groupCoverFailed(e){
    const {groupIntro}=this.data;
    if(groupIntro&&groupIntro.id===e.currentTarget.dataset.id){
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
  if(changed)this._homeView={publicView,token,role:session?.role};
  this.setData({publicView,session,...(changed?viewData:this.data.firstOutlet?{firstOutlet:firstOutletLoading}:{})});
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
