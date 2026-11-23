const {define,api,fmt}=require('../../utils/page');

const scopedCollections=['bills','payments','receipts','adjustments'].map(name=>({
 name,
 filters(){
  return {outlet:this.data.selected,...(name==='bills'?{month:this.data.filterMonthValue,status:this.data.statusFilter}:{})};
 }
}));
const confirmationPending='正在确认支付结果，请稍后刷新。';
const paymentResults={success:'支付成功',failed:'支付未完成',closed:'支付未完成',cancelled:'已取消支付'};
/* DEV_ONLY_START */
const simulatedChannels=new Set(['wechat','alipay']);
const simulationResults={success:'支付成功',failed:'支付未完成，请重试',cancelled:'已取消支付',closed:'已取消支付'};
/* DEV_ONLY_END */
const moneyFromCents=value=>Number.isSafeInteger(value)?fmt.money(value/100):'';

Page(define({
 collections:['outlets',...scopedCollections],
 data:{filterMonthValue:'',statusFilter:'all',bills:[],payments:[],receipts:[],adjustments:[],outlets:[],outletIndex:0,
  payment:null,selected:'',paymentEnabled:false,paymentNotice:'',paymentBillQuery:'',
  /* DEV_ONLY_START */
  simulationPrompt:null,
  /* DEV_ONLY_END */
 },
 load(q){
  this.setData({selected:q.outlet==='all'?'':q.outlet||'',filterMonthValue:q.month||''});
 },
 async loaded(s){
  const serial=this._serial;
  const config=await api.request('/api/config');
  if(serial!==this._serial)return;
  let bills=s.bills;
  const id=this.query.id;
  if(id?.startsWith('bill-')&&!bills.some(x=>x.id===id)){
   const bill=await api.detail('bills',id);
   if(serial!==this._serial)return;
   bills=[...fmt.decorate({bills:[bill]}).bills,...bills];
  }
  const filter=row=>!this.data.selected||row.outlet===this.data.selected;
  const outlets=[{id:'',name:'全部网点'},...s.outlets];
  this.setData({
   paymentEnabled:config.paymentEnabled===true,
   bills:bills.filter(filter).map(bill=>({...bill,monthText:fmt.monthText(bill.month),
    payableText:moneyFromCents(bill.ledger?.receivableCents),
    paidText:moneyFromCents(bill.ledger?.grossReceivedCents),
    unpaidText:moneyFromCents(bill.ledger?.unpaidCents),
   })),
   payments:s.payments.filter(filter).map(row=>({...row,dateText:fmt.monthText(row.month)||fmt.timeText(row.createdAt)})),
   receipts:s.receipts.filter(filter).map(row=>({...row,dateText:row.paidOn?fmt.dateText(row.paidOn):fmt.timeText(row.createdAt)})),
   adjustments:s.adjustments.filter(filter).map(row=>({...row,offsetMonthText:fmt.monthText(row.offsetMonth),serviceUntilText:fmt.dateText(row.serviceUntil)})),
   outlets,outletIndex:Math.max(0,outlets.findIndex(row=>row.id===this.data.selected)),
  });
 },
 async filterOutlet(e){
  const outlet=this.data.outlets[Number(e.detail.value)];
  if(!outlet)return;
  this.query={};
  this.setData({selected:outlet.id});
  await this.refresh();
 },
 async filterMonth(e){
  this.query.id='';
  this.setData({filterMonthValue:e.detail.value});
  await this.refresh();
 },
 async filterStatus(e){
  this.query.id='';
  this.setData({statusFilter:e.currentTarget.dataset.status});
  await this.refresh();
 },
 async clearFilters(){
  this.query={};
  this.setData({filterMonthValue:'',statusFilter:'all',selected:'',outletSearch:''});
  await this.refresh();
 },
 showPaymentResult(payment, fallback=confirmationPending){
  const confirmed=payment?.status==='success';
  this.setData({
   payment,paymentNotice:paymentResults[payment?.status]||fallback,
   paymentBillQuery:confirmed&&payment.billId?api.query({
    ledgerBillId:payment.billId,outlet:payment.outlet,section:'payments',ledgerRecordId:payment.id,
   }):'',
   ...(confirmed&&this.data.statusFilter==='unpaid'?{statusFilter:'all'}:{}),
  });
 },
 async pay(e){
  if(this.data.busy)return;
  const {id:billId}=e.currentTarget?.dataset||{};
  /* DEV_ONLY_START */
  if(this.data.state?.adapterMode==='mock')return this.simulate(billId,e.currentTarget?.dataset?.channel??'wechat');
  /* DEV_ONLY_END */
  if(this.data.state?.adapterMode!=='real'||!this.data.paymentEnabled){
   this.setData({error:'微信支付暂未开放，请联系总部或登记线下付款。'});
   return;
  }
  this.setData({busy:true,error:'',paymentNotice:'',paymentBillQuery:''});
  let paymentId,operationNotice='';
  try{
   const r=await api.prepay(billId);
   paymentId=r.paymentId;
   this.setData({payment:{id:paymentId,billId,status:'pending'}});
   try{
    await new Promise((resolve,reject)=>wx.requestPayment({...r.requestPayment,success:resolve,fail:reject}));
   }catch(error){
    operationNotice=/cancel/i.test(error.errMsg||error.message||'')?'已取消支付':'支付未完成';
   }
   const result=await api.queryPayment(paymentId);
   this.showPaymentResult(result.payment,(operationNotice?operationNotice+'。':'')+confirmationPending);
   await this.refresh();
  }catch(error){
   this.setData({error:error.message,paymentNotice:paymentId?(operationNotice?operationNotice+'。':'')+confirmationPending:''});
  }finally{
   this.setData({busy:false});
  }
 },
 /* DEV_ONLY_START */
 confirmSimulation(e){
  if(this.data.busy||this.data.loading||this.data.simulationPrompt||this.data.payment?.status==='pending')return;
  const {id,channel}=e.currentTarget?.dataset||{};
  const bill=this.data.bills.find(row=>row.id===id&&row.status==='unpaid');
  const error=this.data.state?.adapterMode!=='mock'?'当前无法模拟支付，请刷新后重试。'
   :!bill||!simulatedChannels.has(channel)?'账单状态或支付方式已更新，请刷新后重试。':'';
  if(error){
   this.setData({error});
   wx.showToast({title:error,icon:'none'});
   return;
  }
  this.setData({simulationPrompt:{id,channel,outletName:bill.outletName,monthText:bill.monthText,payableText:bill.unpaidText||bill.payableText},error:'',paymentNotice:'',paymentBillQuery:''});
 },
 cancelSimulationPrompt(){
  if(this.data.busy||!this.data.simulationPrompt)return;
  this.setData({simulationPrompt:null,error:'',paymentNotice:'已取消支付',paymentBillQuery:''});
  wx.showToast({title:'已取消支付',icon:'none'});
 },
 async startSimulation(){
  const selection=this.data.simulationPrompt;
  if(selection)await this.simulate(selection.id,selection.channel);
 },
 async simulate(id,channel){
  if(this.data.busy||this.data.loading)return;
  if(this.data.state?.adapterMode!=='mock'||!id||!simulatedChannels.has(channel)){
   this.setData({error:'当前无法模拟支付，请刷新账单后重试。'});
   return;
  }
  this.setData({busy:true,error:'',paymentNotice:'',paymentBillQuery:''});
  try{
   const result=await api.prepay(id,{channel,simulation:true});
   this.setData({simulationPrompt:null,payment:{id:result.paymentId,billId:id,channel:result.channel,status:'pending'}});
   await this.refresh();
  }catch(error){
   this.setData({error:error.message});
  }finally{
   this.setData({busy:false});
  }
 },
 resumeSimulation(e){
  if(this.data.state?.adapterMode!=='mock'||this.data.busy||this.data.loading)return;
  const payment=this.data.payments.find(row=>row.id===e.currentTarget?.dataset?.id&&row.status==='pending');
  if(!payment){
   this.setData({error:'付款记录已更新，请刷新后查看。'});
   return;
  }
  this.setData({simulationPrompt:null,payment,paymentNotice:'',error:''});
 },
 dismissSimulation(){
  if(this.data.busy||!this.data.payment)return;
  this.setData({payment:null,error:'',paymentNotice:'付款结果尚未确认，可在付款记录中继续。',paymentBillQuery:''});
 },
 async resolve(e){
  if(this.data.state?.adapterMode!=='mock'||!this.data.payment||this.data.busy)return;
  const outcome=e.currentTarget?.dataset?.outcome;
  if(!['success','failed','cancelled'].includes(outcome)){
   this.setData({error:'请选择一种支付结果。'});
   return;
  }
  this.setData({busy:true,error:''});
  try{
   const {id,channel,billId}=this.data.payment;
   const response=channel?await api.simulatePayment(id,outcome):await api.command('payment.resolve',{id,outcome});
   const status=(channel?response.payment:response.result)?.status;
   const notice=simulationResults[status];
   if(!notice){
    this.setData({paymentNotice:confirmationPending});
    wx.showToast({title:confirmationPending,icon:'none'});
    await this.refresh();
    return;
   }
   const paid=status==='success';
   this.setData({
    payment:null,paymentNotice:notice,
    paymentBillQuery:paid&&billId?api.query({ledgerBillId:billId,section:'payments',ledgerRecordId:id}):'',
    ...(paid&&this.data.statusFilter==='unpaid'?{statusFilter:'all'}:{}),
   });
   wx.showToast({title:notice,icon:paid?'success':'none'});
   await this.refresh();
  }catch(error){
   this.setData({error:error.message});
  }finally{
   this.setData({busy:false});
  }
 },
 /* DEV_ONLY_END */
 async closeExpired(e){
  if(this.data.busy||this.data.state?.adapterMode!=='real')return;
  this.setData({busy:true,error:''});
  try{
   const result=await api.closePayment(e.currentTarget.dataset.id);
   if(result.payment?.status==='closed')this.setData({payment:result.payment,paymentNotice:'过期付款已关闭。',paymentBillQuery:''});
   else this.showPaymentResult(result.payment);
   await this.refresh();
  }catch(error){
   this.setData({error:error.message});
  }finally{
   this.setData({busy:false});
  }
 },
 async resume(e){
  if(this.data.busy||this.data.state?.adapterMode!=='real')return;
  this.setData({busy:true,error:''});
  try{
   const result=await api.queryPayment(e.currentTarget.dataset.id);
   this.showPaymentResult(result.payment);
   await this.refresh();
  }catch(error){
   this.setData({error:error.message});
  }finally{
   this.setData({busy:false});
  }
 }
}));
