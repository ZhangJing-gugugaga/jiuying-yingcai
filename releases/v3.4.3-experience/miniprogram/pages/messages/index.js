const {define,api,fmt,openRecord,canOpenRecord}=require('../../utils/page');
const {recordErrorText}=require('../../utils/navigation');
const categories={
 reports:'经营月报',report:'经营月报',report_missing:'经营月报',report_returned:'经营月报',dashboard:'经营月报',
 outlets:'网点事项',outlet:'网点事项',requests:'网点事项',
 bills:'咨询服务费',fees:'咨询服务费',billing:'咨询服务费',agreements:'咨询服务费',
 offlinePayments:'咨询服务费',refundRequests:'咨询服务费',invoiceRequests:'咨询服务费',
 location:'位置核验',location_missing:'位置核验',support:'客服回复',training:'业务学习与培训'
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
 return {...message,title,body,category,displayTime:fmt.timeText(message.createdAt||message.at),hasLink:canOpenRecord(message)};
}

Page(define({
 collections:[{name:'messages',filters(){return {status:this.data.statusFilter};}}],
 data:{statusFilter:'all',messages:[]},
 load(q){if(['unread','read'].includes(q.status))this.setData({statusFilter:q.status});},
 async loaded(state){
  const serial=this._serial,id=this.query.id;
  let messages=state.messages;
  if(id?.startsWith('msg-')&&!messages.some(row=>row.id===id)){
   let record;
   try{record=await api.detail('messages',id);}catch(error){if(![403,404].includes(error.status))throw error;}
   if(serial!==this._serial)return;
   if(record&&(this.data.statusFilter==='all'||record.status===this.data.statusFilter))messages=[record,...messages];
  }
  this.setData({messages:messages.map(customerMessage)},()=>{
   if(id&&!this._scrolledToNotice&&messages.some(row=>row.id===id)){
    this._scrolledToNotice=true;
    wx.pageScrollTo?.({selector:'#notice-'+id,duration:0});
   }
  });
 },
 async filterStatus(e){this.query.id='';this.setData({statusFilter:e.currentTarget.dataset.status});await this.refresh();},
 async open(e){
  const record=this.data.messages.find(row=>row.id===e.currentTarget.dataset.id);
  if(!record?.hasLink||this._openingNotice)return;
  this._openingNotice=true;
  this.setData({error:''});
  try{await openRecord(record,{returnStatus:this.data.statusFilter});}
  catch(error){this.setData({error:recordErrorText(error)});}
  finally{this._openingNotice=false;}
 },
 async read(e){await this.mutate('message.read',{id:e.currentTarget.dataset.id},'已标为已读。');}
}));
