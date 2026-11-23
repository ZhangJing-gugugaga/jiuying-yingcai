const {define,go,api,fmt}=require('../../utils/page');
const {checkout,moneyFromCents,paymentNotice,paymentScope,confirmationPending,paymentResults}=require('../finance/checkout');

const feePageSize=50;
const feeSections={bills:['bills'],records:['payments','receipts'],adjustments:['adjustments']};
const scopedCollections=Object.values(feeSections).flat().map(name=>({
 name,limit:feePageSize,
 visible(){
  const recent=name==='receipts'&&this.data.section==='bills'&&this.data.payment?.status==='success';
  return recent||!this.query.id&&feeSections[this.data.section].includes(name);
 },
 filters(){
  if(name==='receipts'&&this.data.section==='bills')return {outlet:this.data.payment.outlet||this.data.selected,month:this.data.payment.month||this.data.filterMonthValue};
  return {outlet:this.data.selected,...(name==='bills'?{month:this.data.filterMonthValue,status:this.data.statusFilter}:{})};
 }
}));
/* DEV_ONLY_START */
const simulatedChannels=new Set(['wechat','alipay']);
const simulationResults={success:'支付成功',failed:'支付未完成，请重试',cancelled:'已取消支付',closed:'已取消支付'};
/* DEV_ONLY_END */
const paymentFilter=(payment,statusFilter)=>payment?.status==='success'&&statusFilter==='unpaid'?'all':statusFilter;

function outletPicker(rows,selected){
 const labels=new Map();
 const options=rows.map(outlet=>{
  const label=fmt.outletOptionLabel(outlet);
  labels.set(label,(labels.get(label)||0)+1);
  return {...outlet,label};
 });
 for(const option of options)if(labels.get(option.label)>1)option.label+=' · '+option.id;
 const outlets=[{id:'',name:'全部网点',label:'全部网点'},...options];
 if(selected&&!rows.some(row=>row.id===selected))outlets.unshift({id:null,label:'所选网点待核验'});
 return {outlets,outletIndex:Math.max(0,outlets.findIndex(row=>row.id===selected))};
}

function feeScope({section,selected,filterMonthValue,statusFilter}) {
 return JSON.stringify([section,selected,filterMonthValue,statusFilter]);
}

function captureFeeRange({data}) {
 const token=api.session()?.token;
 if(!token||token!==data.session?.token||!data.scopeReady||data.exactBill)return null;
 const loaded=feeSections[data.section].map(name=>[name,data.pagers[name]])
  .filter(([,pager])=>pager&&pager.loaded>feePageSize).map(([name,pager])=>[name,pager.loaded]);
 return loaded.length?{token,scope:feeScope(data),loaded}:null;
}

async function restoreFeeRange(page,range,serial) {
 const current=()=>range&&serial===page._serial&&range.token===api.session()?.token&&
  range.scope===feeScope(page.data)&&!page.query.id;
 if(!current())return;
 for(const [name,loaded] of range.loaded){
  while(current()&&page.data.pagers[name]?.hasMore&&page.data.pagers[name].loaded<loaded){
   try {
    await page.fetchCollection(name,false,serial,false);
   } catch {
    // Keep pages already refreshed. The section still exposes its load-more action.
    return;
   }
  }
 }
}

function billAmountDisplay(bill){
 if(bill.status==='reversed')return {label:'原账单金额',value:bill.amountText==='—'?'':bill.amountText};
 if(bill.status==='unpaid')return {label:'待支付金额',value:moneyFromCents(bill.ledger?.unpaidCents)};
 return {label:'应付金额',value:moneyFromCents(bill.ledger?.receivableCents)};
}

const page=define({
 collections:[{name:'outlets',metadata(){
  this.setData(outletPicker(this.data.state.outlets,this.data.selected));
 }},...scopedCollections],
 data:{filterMonthValue:'',filterMonthText:'',statusFilter:'all',bills:[],payments:[],receipts:[],adjustments:[],outlets:[],outletIndex:0,section:'bills',filtersOpen:false,historyOpen:false,
  payment:null,selected:'',scopeReady:null,exactBill:false,paymentEnabled:false,paymentNotice:'',paymentErrorBill:'',ledgerTotals:null,
  /* DEV_ONLY_START */
  simulationPrompt:null,
  /* DEV_ONLY_END */
 },
 load(q){
  const selected=q.outlet==='all'?'':q.outlet||'';
  this.setData({selected,filterMonthValue:q.month||'',exactBill:Boolean(q.id),...outletPicker([],selected)});
 },
 async loaded(s){
  const serial=this._serial;
  const range=this._restoreFeeRange;
  this._restoreFeeRange=null;
  if(range){
   await restoreFeeRange(this,range,serial);
   if(serial!==this._serial)return;
   s=this.data.state;
  }
  const config=this.data.section==='bills'?await api.request('/api/config').catch(()=>null):null;
  if(serial!==this._serial)return;
  let rows=s.outlets,exactBill;
  let {selected,filterMonthValue}=this.data;
  if(this.query.id){
   const bill=await api.detail('bills',this.query.id);
   if(serial!==this._serial)return;
   if(bill.id!==this.query.id||(selected&&bill.outlet!==selected)||(filterMonthValue&&bill.month!==filterMonthValue)){
    throw new Error('原账单与所选网点或账期不一致，请从账单入口重新打开。');
   }
   selected=bill.outlet;
   filterMonthValue=bill.month;
   exactBill=bill;
  }
  if(selected&&!rows.some(row=>row.id===selected)){
   this.setData({scopeReady:false,bills:[],payments:[],receipts:[],adjustments:[]});
   const outlet=await api.detail('outlets',selected).catch(error=>{
    throw new Error('暂无法核验所选网点，请重试或重新选择。',{cause:error});
   });
   if(serial!==this._serial)return;
   rows=[outlet,...rows];
  }
  const bills=exactBill?fmt.decorate({bills:[exactBill],outlets:rows}).bills:s.bills;
  const filter=row=>!selected||row.outlet===selected;
  const picker=outletPicker(rows,selected);
  this.setData({
   ...picker,selected,filterMonthValue,filterMonthText:fmt.monthText(filterMonthValue),scopeReady:true,paymentEnabled:config?.paymentEnabled===true,
   bills:bills.filter(filter).map(bill=>({...bill,monthText:fmt.monthText(bill.month),displayOutlet:picker.outlets.find(outlet=>outlet.id===bill.outlet)?.label||bill.outletName,
    dueText:fmt.dateText(bill.dueOn),displayAmount:billAmountDisplay(bill),
    payableText:moneyFromCents(bill.ledger?.receivableCents),
    paidText:moneyFromCents(bill.ledger?.grossReceivedCents),
    unpaidText:moneyFromCents(bill.ledger?.unpaidCents),
   })),
   payments:s.payments.filter(filter).map(row=>({...row,dateText:fmt.monthText(row.month)||fmt.timeText(row.createdAt)})),
   receipts:s.receipts.filter(filter).map(row=>({...row,dateText:row.paidOn?fmt.dateText(row.paidOn):fmt.timeText(row.createdAt)})),
   adjustments:s.adjustments.filter(filter).map(row=>({...row,offsetMonthText:fmt.monthText(row.offsetMonth),serviceUntilText:fmt.dateText(row.serviceUntil)})),
  });
  if(!exactBill&&this.data.section==='bills'){
   let totals;
   try{({totals}=await api.request('/api/finance/summary?'+api.query({outlet:selected,month:filterMonthValue,limit:1})));}
   catch{ /* Billing remains available if its aggregate is temporarily unavailable. */ }
   if(serial===this._serial)this.setData({ledgerTotals:totals?{
    receivable:moneyFromCents(totals.receivableCents),unpaid:moneyFromCents(totals.unpaidCents)
   }:null});
  }
 },
 chooseSection(e){
  const {section}=e.currentTarget.dataset;
  if(this.data.loading||this.data.busy||this.data.exactBill||!['bills','records','adjustments'].includes(section)||section===this.data.section)return;
  if(this.data.section==='bills')this._billRange=captureFeeRange(this);
  if(section==='bills'){
   this._restoreFeeRange=this._billRange;
   this._billRange=null;
  }
  this.setData({section,filtersOpen:false,historyOpen:false});
  return this.refresh();
 },
 toggleFilters(){
  if(this.data.section!=='bills'||this.data.exactBill||this.data.loading||this.data.busy)return;
  this.setData({filtersOpen:!this.data.filtersOpen,historyOpen:false});
 },
 toggleHistory(){
  if(!this.data.scopeReady||this.data.section!=='bills'||this.data.exactBill||this.data.loading||this.data.busy)return;
  this.setData({historyOpen:!this.data.historyOpen,filtersOpen:false});
 },
 openFinance(){
  if(this.data.scopeReady===false||this.data.loading)return;
  const month=this.data.section==='records'?undefined:this.data.filterMonthValue;
  return go('finance',api.query({outlet:this.data.selected,month}));
 },
 openAgreements(){
  if(this.data.scopeReady===false)return;
  return go('agreements',api.query({outlet:this.data.selected}));
 },
 openBillLedger(scope,anchor){
  const token=this.data.session?.token;
  const origin=anchor&&token?{...anchor,token,scope:feeScope(this.data)}:null;
  const open=()=>go('finance',api.query(scope),()=>{this._feeReturnAnchor=origin;});
  const previous=typeof getCurrentPages==='function'?getCurrentPages().at(-2):null;
  const existingBill=previous?.data?.ledgerBill;
  const plainDetail=!scope.section&&!scope.type&&!scope.ledgerRecordId;
  if(plainDetail&&previous?.route==='pages/finance/index'&&previous.data.financeView==='bill'&&
   !previous.data.sourceLocked&&existingBill?.id===scope.ledgerBillId&&typeof wx.navigateBack==='function'){
   return wx.navigateBack({delta:1,fail:open});
  }
  return open();
 },
 openBill(e){
  const {id,section,type,record}=e.currentTarget.dataset;
  if(this.data.loading||this.data.scopeReady===false)return;
  const fromReceipt=['refund','invoice'].includes(type);
  const receiptRecord=fromReceipt||record==='receipt';
  const collection=receiptRecord?'receipts':record?'payments':'bills';
  const rows=this.data[collection];
  const row=rows.find(item=>item.id===id);
  if(!row)return;
  if(type==='offline'&&row.status!=='unpaid')return;
  if(fromReceipt&&(row.status!=='success'||row.adapterMode==='mock'))return;
  const ledgerBillId=record||receiptRecord?row.billId:row.id;
  if(!ledgerBillId)return;
  return this.openBillLedger({outlet:row.outlet,month:row.month,ledgerBillId,section,type,
   billId:type==='offline'?ledgerBillId:undefined,receiptId:fromReceipt?row.id:undefined,
   ledgerRecordId:record||receiptRecord?row.id:undefined},{collection,id:row.id});
 },
 setFilters(patch){
  if(this.data.busy||(this.data.exactBill&&this.data.scopeReady===false&&patch.selected===undefined))return;
  const selected=patch.selected??this.data.selected;
  const month=patch.filterMonthValue??this.data.filterMonthValue;
  const scopeChanged=selected!==this.data.selected||month!==this.data.filterMonthValue;
  const paymentState=scopeChanged?{payment:null,paymentNotice:'',paymentErrorBill:''}:{};
  /* DEV_ONLY_START */
  if(scopeChanged)paymentState.simulationPrompt=null;
  /* DEV_ONLY_END */
  this.query={outlet:selected,month};
  this.setData({...patch,...paymentState,exactBill:false});
  return this.refresh();
 },
 async filterOutlet(e){
  const outletIndex=Number(e.detail.value);
  const outlet=this.data.outlets[outletIndex];
  if(!outlet||outlet.id===null)return;
  await this.setFilters({selected:outlet.id,outletIndex});
 },
 async filterMonth(e){
  await this.setFilters({filterMonthValue:e.detail.value});
 },
 async filterStatus(e){
  await this.setFilters({statusFilter:e.currentTarget.dataset.status});
 },
 async clearFilters(){
  await this.setFilters({filterMonthValue:'',statusFilter:'all'});
 },
 async pay(e){
  const {id:billId}=e.currentTarget?.dataset||{};
  if(this.data.busy||this.data.loading||this.data.scopeReady===false||
   (this.data.scopeReady&& !this.data.bills.some(row=>row.id===billId&&row.status==='unpaid')))return;
  /* DEV_ONLY_START */
  if(this.data.state?.adapterMode==='mock')return this.simulate(billId,e.currentTarget?.dataset?.channel??'wechat');
  /* DEV_ONLY_END */
  this.setData({paymentErrorBill:billId});
  if(this.data.state?.adapterMode!=='real'||!this.data.paymentEnabled){
   this.setData({error:'微信支付暂未开放，请联系总部或登记线下付款。'});
   return;
  }
  this.setData({busy:true,error:'',paymentNotice:''});
  const attempt={};
  const isCurrent=paymentScope(this,()=>!this.data.scopeReady||this.data.bills.some(row=>row.id===billId));
  try{
   const result=await checkout(billId,attempt,payment=>this.setData({payment}),isCurrent);
   if(!result||!isCurrent())return;
   this.setData({payment:result.payment,paymentErrorBill:'',statusFilter:paymentFilter(result.payment,this.data.statusFilter),
    paymentNotice:paymentNotice(result.payment,attempt)});
   await this.refresh();
  }catch(error){
   if(isCurrent())this.setData({error:error.message,paymentNotice:attempt.paymentId?paymentNotice(null,attempt):''});
  }finally{
   if(!this._paymentUnloaded)this.setData({busy:false});
  }
 },
 openConfirmedBill(){
  const payment=this.data.payment;
  if(this.data.scopeReady&&payment?.status==='success'&&payment.billId)
   return this.openBillLedger({ledgerBillId:payment.billId,outlet:payment.outlet||this.data.selected,month:payment.month||this.data.filterMonthValue});
 },
 /* DEV_ONLY_START */
 confirmSimulation(e){
  if(this.data.busy||this.data.loading||!this.data.scopeReady||this.data.simulationPrompt||this.data.payment?.status==='pending')return;
  const {id,channel}=e.currentTarget?.dataset||{};
  const bill=this.data.bills.find(row=>row.id===id&&row.status==='unpaid');
  const error=this.data.state?.adapterMode!=='mock'?'当前无法模拟支付，请刷新后重试。'
   :!bill||!simulatedChannels.has(channel)?'账单状态或支付方式已更新，请刷新后重试。':'';
  if(error){
   this.setData({error});
   wx.showToast({title:error,icon:'none'});
   return;
  }
  this.setData({simulationPrompt:{id,channel,outletName:bill.outletName,monthText:bill.monthText,payableText:bill.unpaidText||bill.payableText},error:'',paymentNotice:''});
 },
 cancelSimulationPrompt(){
  if(this.data.busy||!this.data.simulationPrompt)return;
  this.setData({simulationPrompt:null,error:'',paymentNotice:'已取消支付'});
  wx.showToast({title:'已取消支付',icon:'none'});
 },
 async startSimulation(){
  const selection=this.data.simulationPrompt;
  if(selection)await this.simulate(selection.id,selection.channel);
 },
 async simulate(id,channel){
  if(this.data.busy||this.data.loading||!this.data.scopeReady||!this.data.bills.some(row=>row.id===id&&row.status==='unpaid'))return;
  if(this.data.state?.adapterMode!=='mock'||!id||!simulatedChannels.has(channel)){
   this.setData({error:'当前无法模拟支付，请刷新账单后重试。'});
   return;
  }
  this.setData({busy:true,error:'',paymentNotice:''});
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
  if(this.data.state?.adapterMode!=='mock'||this.data.busy||this.data.loading||!this.data.scopeReady)return;
  const payment=this.data.payments.find(row=>row.id===e.currentTarget?.dataset?.id&&row.status==='pending');
  if(!payment){
   this.setData({error:'付款记录已更新，请刷新后查看。'});
   return;
  }
  this.setData({simulationPrompt:null,payment,paymentNotice:'',error:''});
 },
 dismissSimulation(){
  if(this.data.busy||this.data.payment?.status!=='pending')return;
  this.setData({payment:null,error:'',paymentNotice:'付款结果尚未确认，可在付款记录中继续。'});
 },
 async resolve(e){
  if(this.data.state?.adapterMode!=='mock'||this.data.payment?.status!=='pending'||this.data.busy)return;
  const outcome=e.currentTarget?.dataset?.outcome;
  if(!['success','failed','cancelled'].includes(outcome)){
   this.setData({error:'请选择一种支付结果。'});
   return;
  }
  this.setData({busy:true,error:''});
  try{
   const {id,channel}=this.data.payment;
   const response=channel?await api.simulatePayment(id,outcome):await api.command('payment.resolve',{id,outcome});
   const result=channel?response.payment:response.result;
   const status=result?.status;
   const notice=simulationResults[status];
   if(!notice){
    this.setData({paymentNotice:confirmationPending});
    wx.showToast({title:confirmationPending,icon:'none'});
    await this.refresh();
    return;
   }
   const paid=status==='success';
   this.setData({
    payment:paid?result:null,paymentNotice:notice,
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
  if(this.data.busy||this.data.loading||!this.data.scopeReady||this.data.state?.adapterMode!=='real')return;
  const isCurrent=paymentScope(this,()=>this.data.scopeReady);
  this.setData({busy:true,error:'',paymentErrorBill:''});
  try{
   const result=await api.closePayment(e.currentTarget.dataset.id);
   if(!isCurrent())return;
   this.setData({payment:result.payment,statusFilter:paymentFilter(result.payment,this.data.statusFilter),
    paymentNotice:result.payment?.status==='closed'?'过期付款已关闭。':paymentResults[result.payment?.status]||confirmationPending});
   await this.refresh();
  }catch(error){
   if(isCurrent())this.setData({error:error.message});
  }finally{
   if(!this._paymentUnloaded)this.setData({busy:false});
  }
 },
 async resume(e){
  if(this.data.busy||this.data.loading||!this.data.scopeReady||this.data.state?.adapterMode!=='real')return;
  const isCurrent=paymentScope(this,()=>this.data.scopeReady);
  this.setData({busy:true,error:'',paymentErrorBill:''});
  try{
   const result=await api.queryPayment(e.currentTarget.dataset.id);
   if(!isCurrent())return;
   this.setData({payment:result.payment,statusFilter:paymentFilter(result.payment,this.data.statusFilter),
    paymentNotice:paymentResults[result.payment?.status]||confirmationPending});
   await this.refresh();
  }catch(error){
   if(isCurrent())this.setData({error:error.message});
  }finally{
   if(!this._paymentUnloaded)this.setData({busy:false});
  }
 }
});

Page({...page,async onShow(){
 this._paymentHidden=false;
 this._restoreFeeRange=this._hiddenFeeRange;
 this._hiddenFeeRange=null;
 const anchor=this._feeReturnAnchor;
 this._feeReturnAnchor=null;
 await page.onShow.call(this);
 if(anchor&&!this._paymentHidden&&!this._paymentUnloaded&&anchor.token===api.session()?.token&&
    anchor.scope===feeScope(this.data)&&this.data.scopeReady&&this.data[anchor.collection].some(row=>row.id===anchor.id)){
  wx.pageScrollTo?.({selector:'#fee-'+anchor.collection+'-'+anchor.id,duration:0});
 }
},onHide(){
 this._paymentHidden=true;
 this._hiddenFeeRange=captureFeeRange(this);
},
onUnload(){this._paymentUnloaded=true;page.onUnload.call(this);},async refresh(){
 this.setData({scopeReady:false,bills:[],payments:[],receipts:[],adjustments:[],ledgerTotals:null});
 const pending=page.refresh.call(this);
 const serial=this._serial;
 await pending;
 if(serial!==this._serial||this.data.scopeReady||!this.data.error)return;
 const {selected,outlets,outletIndex}=this.data;
 if(selected&&outlets[outletIndex]?.id!==selected){
  this.setData({error:'暂无法核验所选网点。请重试，或重新选择网点。'+this.data.error});
 }
}});
