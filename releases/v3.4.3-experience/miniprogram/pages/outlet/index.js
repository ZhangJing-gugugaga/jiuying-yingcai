const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');

const statusNotes={
  preparing:'网点正在筹备，开业后由总部确认营业状态。',
  open:'网点当前处于正常营业状态。',
  paused:'网点当前暂停营业。恢复营业请按流程提交申请。',
  closed:'网点已关闭，历史经营和财务记录仍可查看。'
};

const page=define({
  data:{outlet:null,history:[],locationHistory:[],internal:false,organizationName:'',summary:null,summaryError:false,workContact:null,workContactLoading:false,workContactDialing:false},
  async loaded(s){
    const serial=this._serial;
    const directory=this.data.isPublic||this.query.scope==='public';
    const raw=await api.detail('outlets',this.query.id,directory?{scope:'public'}:undefined);
    if(serial!==this._serial)return;
    wx.setNavigationBarTitle?.({title:raw.name||'网点详情'});
    if(directory){
      this.setData({outlet:{id:raw.id,name:raw.name,address:raw.address,phone:'',statusText:fmt.label(raw.status,'outlet'),statusTone:fmt.statusTone(raw.status,'outlet'),
        area:[raw.countryName,raw.province,raw.city,raw.district].filter((label,index,all)=>label&&all.indexOf(label)===index).join(' · ')}});
      return;
    }
    const internal=!!raw.owner;
    const outlet={
      name:raw.name,id:raw.id,address:raw.address,phone:internal?raw.phone:'',
      status:raw.status,statusText:fmt.label(raw.status,'outlet'),statusTone:fmt.statusTone(raw.status,'outlet'),statusNote:statusNotes[raw.status]||'',
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
    this.setData({outlet,internal,history,locationHistory});
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
  ...workContactBehavior(function(){return this.data.internal&&this.data.outlet?{outlet:this.data.outlet.id}:null;}),
  action(e){
    const outlet=this.data.outlet;
    if(!outlet||!this.data.internal)return;
    const {page,history,type,status}=e.currentTarget.dataset;
    go(page,api.query({outlet:outlet.id,filterOutlet:page==='requests'&&history?outlet.id:undefined,
      section:history?'history':undefined,type:page==='requests'?type:undefined,
      status:page==='requests'&&type==='statusChange'?status:undefined}));
  },
  copy(){if(this.data.outlet?.address)wx.setClipboardData({data:this.data.outlet.address});}
});
const refresh=page.refresh;
page.refresh=function(){
  this.setData({outlet:null,history:[],locationHistory:[],internal:false,organizationName:'',summary:null,summaryError:false,workContact:null,workContactLoading:false,workContactDialing:false});
  return refresh.call(this);
};
Page(page);
