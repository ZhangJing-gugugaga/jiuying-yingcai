const {define,go,api,fmt,openRecord,canOpenRecord}=require('../../utils/page');
const {recordErrorText}=require('../../utils/navigation');

const taskStatuses=new Set(['open','in_progress','resolved','all']);
const noticeStatuses=new Set(['all','unread','read']);
const taskLabels={
  report_missing:{subject:'经营月报',action:'填写月报'},
  report_returned:{subject:'经营月报',action:'修改月报'},
  location_missing:{subject:'位置核验',action:'提交核验资料'},
  location_exception:{subject:'位置核验',action:'补交核验资料'},
  request_supplement:{subject:'业务申请',action:'补交申请材料'},
  bill_unpaid:{subject:'账单',action:'查看账单'},
  bill_overdue:{subject:'账单',action:'查看账单'},
  support_waiting:{subject:'客服记录',action:'补充客服资料'},
  training_material_returned:{subject:'学员资料',action:'补交学员材料'}
};
function taskTitle(row,month){
  switch(row.kind){
    case 'report_missing':return '请填写'+month+'经营月报';
    case 'report_returned':return '请修改'+month+'经营月报';
    case 'location_missing':return '请提交网点位置核验资料';
    case 'location_exception':return '请补充网点位置核验资料';
    case 'request_supplement':return row.outlet?'请补充业务申请材料':'请补充新增网点申请材料';
    case 'bill_unpaid':
    case 'bill_overdue':return '请查看咨询服务费账单';
    case 'support_waiting':return row.businessType==='supportChats'?'请补充咨询资料':'请补充客服工单资料';
    case 'training_material_returned':return '请补充学员培训资料';
    default:return row.typeText;
  }
}

function taskCopy(row,month){
  const labels=taskLabels[row.kind];
  const subject=labels?.subject;
  const topic=row.kind==='request_supplement'&&!row.outlet?'新增网点申请补件':subject;
  return {
    title:row.status==='open'||!topic?taskTitle(row,month):topic,
    actionText:row.status==='open'&&labels?labels.action:subject==='经营月报'?'查看月报':subject?'查看'+subject:'查看事项'
  };
}

const categories={
 reports:'经营月报',report:'经营月报',report_missing:'经营月报',report_returned:'经营月报',dashboard:'经营月报',
 outlets:'网点事项',outlet:'网点事项',requests:'网点事项',
 bills:'咨询服务费',fees:'咨询服务费',billing:'咨询服务费',agreements:'咨询服务费',
 offlinePayments:'咨询服务费',refundRequests:'咨询服务费',invoiceRequests:'咨询服务费',
 location:'位置核验',location_missing:'位置核验',support:'客服回复',training:'业务学习与培训'
};
const destinations={
 reports:'查看月报',report:'查看月报',report_missing:'填写月报',report_returned:'查看月报',
 dashboard:'查看经营看板',outlets:'查看网点',outlet:'查看网点',requests:'查看申请',
 bills:'查看账单',fees:'查看账单',billing:'查看账单',agreements:'查看协议',
 offlinePayments:'查看付款记录',refundRequests:'查看退款进度',invoiceRequests:'查看发票进度',
 location:'查看位置核验',location_missing:'查看位置核验',support:'查看客服记录',training:'查看学员培训'
};
function customerMessage(message){
 const category=categories[message.target]||'系统通知';
 let title=message.title||category,body=message.body||message.content||message.text||'';
 const equivalents={
  '上月月报待报送':'经营月报待填写',
  '独立免报已登记，未生成零报':'本月已免报',
  '暂停月份待核验免报':'免报申请待总部确认',
  '本月位置待核验':'网点位置待核验',
  '账单逾期待处理':'咨询服务费待支付',
  '服务费付款已核验到账':'付款状态已更新',
  '外部退款凭证已登记':'退款已完成',
  '退款审核结果；实际退款须外部处理':'退款申请进度已更新',
  'Mock支付成功（无真实资金）':'模拟付款已确认'
 };
 title=equivalents[title]||title;
 if(title==='消费者投诉待协助核实')body='总部客服正在处理。如需网点协助核实，客服会与您联系。';
 if(message.linkUnavailable)body='此通知暂无法打开，请联系总部客服核实。';
 if(/快照|幂等|结构化审计|回调|渠道流水核对|接口|请求编号/.test(body))body='可以查看此事项的最新状态。';
 const outletName=message.outlet&&message.outletName!==message.outlet?message.outletName:'';
 const scopeText=[outletName,fmt.monthText(message.month)].filter(Boolean).join(' · ');
 const actionText=message.settlementId?'查看经营看板':destinations[message.target]||'查看详情';
 return {...message,title,body,category,scopeText,actionText,displayTime:fmt.timeText(message.createdAt||message.at),hasLink:canOpenRecord(message)};
}

function linkedTask(message){return message.partnerTaskId||message.taskId;}

function dueGroup(row,today){
  if(row.overdue)return '已超期';
  if(!row.dueText)return '未设截止日期';
  const current=Date.parse(today+'T00:00:00Z');
  if(!Number.isFinite(current))return '待处理事项';
  if(row.dueText===fmt.dateText(today))return '今天到期';
  const localDay=new Date(current).getUTCDay()||7;
  const sunday=fmt.dateText(new Date(current+(7-localDay)*86400000).toISOString().slice(0,10));
  return row.dueText<=sunday?'本周到期':'之后到期';
}

function mattersPage(initialSection='tasks'){
  return define({
    collections:[
      {name:'businessTasks',visible(){return this.data.section==='tasks'&&!this.data.isPublic;},
        filters(){return {status:this.data.status};}},
      {name:'messages',visible(){return this.data.section==='notices'||this.data.isPublic;},
        filters(){return {status:this.data.statusFilter};}}
    ],
    data:{section:initialSection,status:'open',statusFilter:'all',taskRows:[],messages:[],noticeRows:[],noticeUnread:null,openingRecord:false},
    load(query){
      const section=query.section==='notices'||query.section==='tasks'?query.section:initialSection;
      this.setData({section,status:section==='tasks'&&taskStatuses.has(query.status)?query.status:'open',
        statusFilter:section==='notices'&&noticeStatuses.has(query.status)?query.status:'all'});
    },
    onUnload(){this._openAttempt=null;},
    async loaded(state){
      const notices=this.data.section==='notices'||this.data.isPublic;
      const serial=this._serial;
      const canReadTasks=this.data.session?.role==='partner';
      const unreadPromise=notices&&this.data.statusFilter==='unread'
        ? Promise.resolve({items:state.messages,total:this.data.pagers.messages?.total})
        : api.collection('messages',{status:'unread',limit:notices?1:50}).catch(()=>null);
      const activePromise=notices&&canReadTasks&&state.messages.some(linkedTask)
        ? api.collection('businessTasks',{status:'current',limit:200}).catch(()=>null)
        : Promise.resolve(null);
      const [unread,active]=await Promise.all([unreadPromise,activePromise]);
      if(serial!==this._serial)return;
      this.setData({noticeUnread:unread?.total??null});
      if(notices)await this.loadNotices(state.messages,active?.items||[]);
      else await this.loadTasks(state.businessTasks,unread?.items||[]);
    },
    async loadTasks(tasks,unread){
      const id=this.query.id,serial=this._serial;
      if(id&&!tasks.some(row=>row.id===id)){
        const row=await api.detail('businessTasks',id);
        if(serial!==this._serial||id!==this.query.id)return;
        tasks=fmt.decorate({businessTasks:[row,...tasks]}).businessTasks;
        this.setData({'state.businessTasks':tasks});
      }
      const noticesByTask=new Map();
      for(const notice of unread){
        const taskId=linkedTask(notice);
        if(taskId)noticesByTask.set(taskId,[...(noticesByTask.get(taskId)||[]),notice.id]);
      }
      const rows=tasks.map(row=>{
        const month=fmt.monthText(row.month);
        return {
          id:row.id,...taskCopy(row,month),outletName:row.outletName!==row.outlet&&row.outlet?row.outletName:'',
          month,notifiedText:fmt.timeText(row.createdAt),dueText:fmt.dateText(row.dueAt)||fmt.dateText(row.dueOn),overdue:row.overdue===true,
          unreadNoticeIds:noticesByTask.get(row.id)||[],
          finishedText:row.status==='resolved'?fmt.timeText(row.completedAt):'',
          statusText:fmt.label(row.status,'task'),statusTone:fmt.statusTone(row.status,'task'),canOpen:canOpenRecord(row)
        };
      });
      let group='';
      const taskRows=rows.map(row=>{
        if(this.data.status!=='open')return row;
        const nextGroup=dueGroup(row,this.data.state?.today);
        const groupHeading=nextGroup===group?'':nextGroup;
        group=nextGroup;
        return {...row,groupHeading};
      });
      this.setData({taskRows});
    },
    async loadNotices(messages,activeTasks){
      const id=this.query.id,serial=this._serial;
      if(id?.startsWith('msg-')&&!messages.some(row=>row.id===id)){
        let record;
        try{record=await api.detail('messages',id);}catch(error){if(![403,404].includes(error.status))throw error;}
        if(serial!==this._serial||id!==this.query.id)return;
        if(record)messages=[record,...messages];
      }
      const activeIds=new Set(activeTasks.filter(canOpenRecord).map(row=>row.id));
      const display=messages.map(customerMessage);
      this.setData({section:'notices',messages:display,noticeRows:display.filter(row=>row.id===id||!activeIds.has(linkedTask(row)))},()=>{
        if(serial===this._serial&&id&&this._focusedNotice!==id&&messages.some(row=>row.id===id)){
          this._focusedNotice=id;
          wx.pageScrollTo?.({selector:'#notice-'+id,duration:0});
        }
      });
    },
    async selectSection(e){
      const section=e.currentTarget.dataset.section;
      if(this.data.isPublic||!['tasks','notices'].includes(section)||section===this.data.section||this.data.busy||this.data.openingRecord)return;
      this.query.id='';
      this.setData({section,taskRows:[],messages:[],noticeRows:[]});
      await this.refresh();
    },
    async status(e){
      const status=e.currentTarget.dataset.status;
      if(this.data.isPublic||!taskStatuses.has(status)||this.data.section==='tasks'&&status===this.data.status||
        this.data.busy||this.data.openingRecord)return;
      this.query.id='';
      this.setData({section:'tasks',status,taskRows:[],messages:[],noticeRows:[]});
      await this.refresh();
    },
    async filterStatus(e){
      const statusFilter=e.currentTarget.dataset.status;
      if(!noticeStatuses.has(statusFilter)||statusFilter===this.data.statusFilter||this.data.busy||this.data.openingRecord)return;
      this.query.id='';
      this.setData({statusFilter,messages:[],noticeRows:[]});
      await this.refresh();
    },
    async open(e){
      if(this.data.busy||this.data.loading||this.data.openingRecord)return;
      const {id}=e.currentTarget.dataset;
      const notice=(this.data.section||initialSection)==='notices';
      const records=notice?this.data.messages:this.data.state?.businessTasks;
      const record=records?.find(row=>row.id===id);
      if(!record||(notice?!record.hasLink:!canOpenRecord(record)))return;
      const unreadIds=notice?(record.read?[]:[id]):this.data.taskRows.find(row=>row.id===id)?.unreadNoticeIds||[];
      const attempt={},serial=this._serial,token=api.session()?.token;
      this._openAttempt=attempt;
      const isCurrent=()=>serial===this._serial&&token===api.session()?.token;
      const settled=()=>{
        if(this._openAttempt!==attempt)return;
        this._openAttempt=null;
        this.setData({openingRecord:false});
      };
      let marking;
      this.setData({openingRecord:true,error:''});
      try{
        const started=await openRecord(record,{
          ...(notice?{returnStatus:this.data.statusFilter,returnPage:initialSection==='tasks'?'tasks':'messages'}:{}),
          isCurrent,
          onSuccess:()=>{if(isCurrent())marking=this.markOpenedNotices(unreadIds,isCurrent);},
          onSettled:settled
        });
        if(!started)settled();
        await marking;
      }catch(error){
        if(isCurrent())this.setData({error:recordErrorText(error)});
        settled();
      }
    },
    async markOpenedNotices(ids,isCurrent){
      const marked=new Set();
      for(const id of ids){
        if(!isCurrent())return;
        try{
          await api.command('message.read',{id});
          marked.add(id);
        }catch{}
      }
      if(!marked.size||!isCurrent())return;
      const update=rows=>rows.filter(row=>this.data.statusFilter!=='unread'||!marked.has(row.id)||row.id===this.query.id)
        .map(row=>marked.has(row.id)?{...row,read:true,status:'read'}:row);
      const {noticeUnread,messages,noticeRows,taskRows}=this.data;
      this.setData({messages:update(messages),noticeRows:update(noticeRows),'state.messages':update(this.data.state?.messages||[]),
        taskRows:taskRows.map(row=>({...row,unreadNoticeIds:row.unreadNoticeIds.filter(id=>!marked.has(id))})),
        noticeUnread:Number.isInteger(noticeUnread)?Math.max(0,noticeUnread-marked.size):null});
    },
    read(e){
      if(this.data.loading||this.data.openingRecord)return;
      const {id}=e.currentTarget.dataset;
      if(this.data.messages.some(row=>row.id===id&&!row.read))return this.mutate('message.read',{id},'已标为已读。');
    },
    openLocation(){
      const month=this.data.state?.today?.slice(0,7);
      if(month&&this.data.session&&this.data.session.role!=='public')go('location',api.query({month}));
    }
  });
}

module.exports=mattersPage;
