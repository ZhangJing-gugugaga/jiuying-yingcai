const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');
const {publicShare,outletShare}=require('../../utils/public-share');
const {favorites,changeFavorite}=require('../../utils/public-outlet-preferences');
const {outletSummaryRows}=require('../../utils/outlet-summary');

const statusNotes={
  preparing:'网点正在筹备，开业后由总部确认营业状态。',
  open:'网点当前处于正常营业状态。',
  paused:'网点当前暂停营业。恢复营业请按流程提交申请。',
  closed:'网点已关闭，历史经营和财务记录仍可查看。'
};
const internalPages=new Set(['report','fees','location','requests','support','agreements']);

const page=define({
  data:{outlet:null,history:[],locationHistory:[],historyExpanded:false,internal:false,publicRecord:false,favorite:false,organizationName:'',businessSections:{},businessScope:null,summary:null,summaryError:false,workContact:null,workContactLoading:false,workContactDialing:false,mattersExpanded:false},
  ...publicShare(function(){return outletShare(this._publicOutlet);},function(){return this.data.publicRecord;}),
  async loaded(s){
    const serial=this._serial;
    const directory=this.data.isPublic||this.query.scope==='public';
    if(!this.query.id&&directory)return;
    const raw=await api.detail('outlets',this.query.id,directory?{scope:'public'}:{includeSummary:true});
    if(serial!==this._serial)return;
    wx.setNavigationBarTitle?.({title:raw.name||'网点详情'});
    if(directory){
      const publicPhone=String(raw.contact||'').replace(/[\s()-]/g,'');
      this._publicOutlet={id:raw.id,name:raw.name};
      this.setData({publicRecord:true,favorite:favorites().includes(raw.id),outlet:{id:raw.id,name:raw.name,address:raw.address,phone:'',publicPhone:/^\+?\d{5,20}$/.test(publicPhone)?publicPhone:'',
        businessHours:raw.businessHours||'',navigationPoint:raw.publicLocation?.coordinateSystem==='GCJ-02'?raw.publicLocation:null,
        statusText:fmt.label(raw.status,'outlet'),statusTone:fmt.statusTone(raw.status,'outlet'),
        area:[raw.countryName,raw.province,raw.city,raw.district].filter((label,index,all)=>label&&all.indexOf(label)===index).join(' · ')}});
      this.updatePublicShareMenu();
      return;
    }
    const internal=!!raw.owner;
    const outlet={
      name:raw.name,id:raw.id,address:raw.address,phone:internal?raw.phone:'',status:raw.status,
      statusText:fmt.label(raw.status,'outlet'),statusTone:fmt.statusTone(raw.status,'outlet'),statusNote:statusNotes[raw.status]||'',
      districtText:[raw.province,raw.city,raw.district].filter(Boolean).join(' · '),
      openingText:fmt.dateText(raw.opening||raw.plannedOpening),
      statusSince:fmt.dateText(raw.events?.at(-1)?.date||raw.events?.at(-1)?.effectiveDate),
      enrollmentText:raw.enrollmentStatus==='pending'?'待总部确认':raw.enrollmentApplicable===true?'适用':raw.enrollmentApplicable===false?'不适用':'待总部确认'
    };
    const history=internal?(raw.events||[]).map((event,index)=>({
      index,statusText:fmt.label(event.status,'outlet'),dateText:fmt.dateText(event.date||event.effectiveDate)
    })):[];
    const locationHistory=internal?(raw.locationHistory||[]).map((change,index)=>({
      index,at:fmt.dateText(change.at),before:change.before?.address,after:change.after?.address
    })):[];
    const businessSections=Object.fromEntries(outletSummaryRows(raw.summary).map(row=>[row.key,row]));
    this.setData({outlet,internal,history,locationHistory,businessSections,businessScope:raw.summary||null});
    if(!internal)return;

    const period=s.today?.slice(0,7)||fmt.month();
    const params=api.query({period,kind:'month',mode:'settled',outlet:raw.id,limit:1,includeSettlementMonths:'true'});
    const [organization,summary]=await Promise.allSettled([
      api.detail('organizations',raw.owner),
      api.request('/api/dashboard?'+params),
      this.refreshWorkContact()
    ]);
    if(serial!==this._serial)return;
    const settled=summary.value?.settlementMonths?.hasCurrent===true;
    const totals=summary.value?.totals;
    this.setData({
      organizationName:organization.value?.name||'',
      summaryError:summary.status==='rejected',
      summary:summary.status==='fulfilled'?{
        settled,
        revenueText:totals?.revenue==null?'暂无数据':fmt.money(totals.revenue)+' 元',
        ordersText:totals?.orders==null?'暂无数据':totals.orders+' 单',
        trafficText:totals?.traffic==null?'暂无数据':totals.traffic+' 人次',
        enrollText:totals?.enroll==null?'暂无数据':totals.enroll+' 人'
      }:null
    });
  },
  toggleFavorite(){
    const id=this._publicOutlet?.id;
    if(!this.data.publicRecord||!id||this.data.loading)return;
    try{
      const saved=changeFavorite(id,this.data.favorite);
      this.setData({favorite:saved.includes(id)});
    }catch(error){
      wx.showToast?.({title:error.message?.startsWith('最多可收藏')?error.message:'暂时无法保存收藏，请稍后重试。',icon:'none'});
    }
  },
  ...workContactBehavior(function(){return this.data.internal&&this.data.outlet?{outlet:this.data.outlet.id}:null;}),
  toggleMatters(){
    if(this.data.internal)this.setData({mattersExpanded:!this.data.mattersExpanded});
  },
  toggleHistory(){
    if(this.data.internal)this.setData({historyExpanded:!this.data.historyExpanded});
  },
  action(e){
    const outlet=this.data.outlet;
    const session=api.session();
    const {page,history,type,status,month:requestedMonth}=e.currentTarget.dataset;
    if(!outlet||!this.data.internal||this.data.isPublic||this.data.publicRecord||this.data.error||
      session?.role!=='partner'||session.token!==this.data.session?.token||!internalPages.has(page))return;
    const period=this.data.state.today?.slice(0,7)||fmt.month();
    const month=fmt.monthText(requestedMonth)&&['report','location','fees'].includes(page)?requestedMonth:
      page==='report'?fmt.addMonth(period,-1):page==='location'?period:undefined;
    go(page,api.query({outlet:outlet.id,month,type,status,filterOutlet:page==='requests'?outlet.id:undefined,section:history?'history':undefined}));
  },
  copy(){
    const address=this.data.outlet?.address;
    if(address)wx.setClipboardData({
      data:address,
      fail:()=>wx.showToast({title:'无法复制地址，请重试',icon:'none'})
    });
  },
  dialPublic(){
    const number=this.data.outlet?.publicPhone;
    if(!number)return;
    wx.makePhoneCall({phoneNumber:number,fail:()=>wx.showToast?.({title:'无法拨打电话，请稍后重试',icon:'none'})});
  },
  openNavigation(){
    const outlet=this.data.outlet;
    if(!outlet?.navigationPoint)return;
    const {latitude,longitude}=outlet.navigationPoint;
    wx.openLocation({latitude,longitude,name:outlet.name,address:outlet.address||'',scale:16,
      fail:()=>wx.showToast?.({title:'无法打开地图，可复制地址查询',icon:'none'})});
  }
});
const refresh=page.refresh;
page.refresh=function(){
  this._publicOutlet=null;
  this.setData({outlet:null,history:[],locationHistory:[],internal:false,publicRecord:false,favorite:false,organizationName:'',businessSections:{},businessScope:null,summary:null,summaryError:false,workContact:null,workContactLoading:false,workContactDialing:false});
  this.updatePublicShareMenu();
  return refresh.call(this);
};
Page(page);
