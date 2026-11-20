const {define,go,api,fmt}=require('../../utils/page');
const {checkout,moneyFromCents,paymentNotice,paymentScope}=require('./checkout');

const types=[{id:'offline',name:'线下付款登记'},{id:'refund',name:'退款申请'},{id:'invoice',name:'发票申请'}];
const applications=[
 {type:'offline',name:'offlinePayments',title:'线下付款申请',empty:'暂无线下付款申请。',context:'finance'},
 {type:'refund',name:'refundRequests',title:'退款申请',empty:'暂无退款申请。',context:'refund'},
 {type:'invoice',name:'invoiceRequests',title:'发票申请',empty:'暂无发票申请。',context:'invoice'},
];
const metrics=[
 ['receivableCents','应付金额'],['grossReceivedCents','已支付金额'],['refundedCents','已退款金额'],
 ['netReceivedCents','净实收'],['unpaidCents','待支付金额'],['overdueCents','逾期金额'],
];
const billFields=[
 ['agreementReference','协议编号'],['serviceEntity','服务主体'],['collectionEntity','收款主体'],['invoiceEntity','开票主体'],
 ['billOn','账单生成日期'],['dueOn','缴费截止日期'],
];
const billSections=[
 ['lineage','历史账单','bill'],['corrections','账单更正','finance'],['credits','费用抵扣','adjustment'],['receipts','实收记录','receipt'],
 ['payments','付款记录','payment'],['offlinePayments','线下登记','finance'],['refundRequests','退款申请','refund'],['invoiceRequests','发票申请','invoice'],
];
const mainSections=new Set(['receipts','refundRequests','invoiceRequests','credits']);
const cents=value=>Number.isSafeInteger(value)?'¥ '+moneyFromCents(value):'待确认';
function ledgerRows(record){return metrics.map(([key,label])=>({key,label,value:cents(record[key])}));}
const formCollections=function(){return !this.data.ledgerBillId||this.data.sourceLocked||this.data.billSheet;};
const outletFilters={name:'bills',visible:formCollections,filters(){
 return {id:this.data.ledgerBillId||this.billId,outlet:this.data.ledgerOutlet,month:this.data.ledgerMonth};
}};
const financeChannels={wechat:'微信支付',alipay:'支付宝',offline:'线下付款'};
const invalidOriginal='原账单与所选网点或账期不一致，请返回原账单重新办理。';
const initialForm=()=>({amount:'',reference:'',paidOn:fmt.date(),reason:'',title:'',taxId:''});
const receiptAllowed=row=>row.status==='success'&&row.adapterMode!=='mock';
function displayReference(row){
 return row.customerReference||row.externalReference||row.reference||row.redNumber||row.number||'';
}

function refundDisplay(row){
 const fields={statusText:fmt.label(row.status,'refund'),refundNote:'',referenceLabel:''};
 if(row.status==='approved'){
  fields.statusText=row.channelRefundStatus==='pending'?'退款办理中':'退款申请已通过';
 }
 if(row.status!=='recorded')return fields;
 fields.referenceLabel='退款凭证号';
 if(row.refundRecordSource==='channel'){
  fields.refundNote='支付渠道已确认退款。';
  fields.referenceLabel='渠道退款凭证号';
 }else if(row.refundRecordSource==='manual'){
  fields.refundNote='总部财务已登记外部退款凭证。';
  fields.referenceLabel='外部退款凭证号';
 }else if(row.refundRecordSource==='simulation'){
  fields.statusText='模拟退款已确认';
 }
 return fields;
}

function displayApplication(row,group){
 const nextStep=row.status==='pending'?'等待总部财务核对。'
  :row.status==='supplement'?'请按总部意见补充资料。'
  :group.type==='refund'&&row.status==='approved'?'退款仍在办理，可在此查看确认结果。':'';
 return {...row,reference:displayReference(row),amountText:fmt.money(row.amount),
  ...(group.type==='refund'?refundDisplay(row):{statusText:fmt.label(row.status,group.context)}),
  dateText:fmt.dateText(row.paidOn)||fmt.timeText(row.createdAt),monthText:fmt.monthText(row.month),nextStep};
}

async function originalPayment(application){
 if(!application.receiptId)return null;
 const receipt=await api.detail('receipts',application.receiptId);
 if(receipt.billId!==application.billId||receipt.outlet!==application.outlet||receipt.owner!==application.owner||
  (application.month&&receipt.month&&application.month!==receipt.month))throw new Error('原付款记录无法核实，请联系总部客服。');
 return {id:receipt.id,paymentId:receipt.paymentId,billId:receipt.billId,outlet:receipt.outlet,month:receipt.month,
  amountText:fmt.money(receipt.amount),dateText:fmt.dateText(receipt.paidOn)||fmt.timeText(receipt.createdAt),
  channelText:financeChannels[receipt.channel]||(receipt.offlinePaymentId?'线下付款':'')};
}

const page=define({
 collections:['outlets',outletFilters,{name:'receipts',visible:formCollections,filters(){
  return {outlet:this.data.ledgerOutlet,id:this.data.sourceLocked||this.data.billSheet?this.receiptId:undefined};
 }},...applications.map(({name})=>({
  name,
  visible(){return !this.data.ledgerBillId||Boolean(this.applicationId);},
  filters(){return {outlet:this.data.ledgerOutlet,status:this.data.statusFilter};}
 }))],
 data:{financeView:'overview',statusFilter:'all',ledgerOutlet:'',ledgerMonth:'',ledgerOffset:0,ledgerOverview:null,ledgerBillId:'',ledgerBill:null,
  ledgerSection:'receipts',ledgerSectionOffset:0,ledgerRecordId:'',types,type:'offline',typeIndex:0,bills:[],payableBills:[],receipts:[],
   billIndex:0,receiptIndex:0,applicationGroups:[],selectedApplication:null,selectedFinanceChange:null,
   sourceLocked:false,billSheet:false,sheetLoading:false,billHistoryOpen:false,payment:null,paymentMessage:'',paymentError:'',
   formBill:null,form:initialForm()},
 load(q){
  const selected=applications.find(group=>q.id?.startsWith(group.type+'-'));
  const typeIndex=types.findIndex(t=>t.id===(selected?.type||q.type));
  if(typeIndex>=0)this.setData({type:types[typeIndex].id,typeIndex});
  this.billId=q.billId;
  this.receiptId=q.receiptId;
  this.applicationId=selected?q.id:'';
  this.applicationCollection=selected?.name;
  this.feeProposalId=q.feeProposalId;
  this._scrolledToForm=false;
  this._scrolledToBill=false;
  const sourceLocked=!selected&&Boolean(q.ledgerBillId&&(q.type==='offline'?q.billId:['refund','invoice'].includes(q.type)&&q.receiptId));
  this.setData({financeView:selected||this.feeProposalId?'result':sourceLocked?'form':q.ledgerBillId?'bill':typeIndex>=0?'form':'overview',
   ledgerOutlet:q.outlet==='all'?'':q.outlet||'',ledgerMonth:q.month||'',ledgerBillId:q.ledgerBillId||'',
   sourceLocked,formBill:null,ledgerRecordId:q.ledgerRecordId||'',ledgerSection:billSections.some(([section])=>section===q.section)?q.section:'receipts',
   billHistoryOpen:Boolean(q.section&&!mainSections.has(q.section))});
 },
 async loaded(s){
  const serial=this._serial;
  await this.loadLedger();
  if(serial!==this._serial)return;
  let bills=s.bills,receipts=s.receipts;
  if(this.billId&&!bills.some(x=>x.id===this.billId)){
   const selected=await api.detail('bills',this.billId);
   if(serial!==this._serial)return;
   if((this.data.ledgerOutlet&&selected.outlet!==this.data.ledgerOutlet)||(this.data.ledgerMonth&&selected.month!==this.data.ledgerMonth))throw new Error(invalidOriginal);
   bills=[...fmt.decorate({bills:[selected]}).bills,...bills];
  }
  if(this.receiptId&&!receipts.some(x=>x.id===this.receiptId)){
   const selected=await api.detail('receipts',this.receiptId);
   if(serial!==this._serial)return;
   if(this.data.ledgerOutlet&&selected.outlet!==this.data.ledgerOutlet)throw new Error(invalidOriginal);
   receipts=[...fmt.decorate({receipts:[selected]}).receipts,...receipts];
  }
  let exactApplication;
  if(this.applicationId&&!s[this.applicationCollection].some(x=>x.id===this.applicationId)){
   exactApplication=await api.detail(this.applicationCollection,this.applicationId);
  }
  if(serial!==this._serial)return;
  const outletNames=new Map(s.outlets.map(outlet=>[outlet.id,fmt.outletOptionLabel(outlet)]));
  const payableBills=bills.filter(x=>x.status==='unpaid').map(x=>({...x,pickerName:x.month+' · '+(outletNames.get(x.outlet)||x.outletName)+' · ¥'+fmt.money(x.amount)}));
  const realReceipts=receipts.filter(receiptAllowed).map(x=>({...x,
   pickerName:[outletNames.get(x.outlet)||x.outletName,fmt.dateText(x.paidOn)||fmt.monthText(x.month)||fmt.timeText(x.createdAt),'¥'+fmt.money(x.amount)].filter(Boolean).join(' · '),
  }));
  let selectedApplication=null;
  const applicationGroups=applications.map(group=>{
   const all=s[group.name]||[];
   const selected=all.find(row=>row.id===this.applicationId)||(group.name===this.applicationCollection?exactApplication:null);
   if(selected)selectedApplication={...displayApplication(selected,group),title:group.title,type:group.type};
   return {...group,rows:all.map(row=>displayApplication(row,group))};
  });
  if(selectedApplication?.type==='refund')selectedApplication.originalPayment=await originalPayment(selectedApplication);
  if(selectedApplication){
   if((this.data.ledgerBillId&&selectedApplication.billId&&selectedApplication.billId!==this.data.ledgerBillId)||
    (this.data.ledgerOutlet&&selectedApplication.outlet!==this.data.ledgerOutlet)||
    (this.data.ledgerMonth&&selectedApplication.month&&selectedApplication.month!==this.data.ledgerMonth))throw new Error(invalidOriginal);
   const linkedBill=bills.find(bill=>bill.id===selectedApplication.billId);
   selectedApplication.month=selectedApplication.month||linkedBill?.month||selectedApplication.originalPayment?.month||
    (selectedApplication.billId===this.data.ledgerBill?.id?this.data.ledgerBill?.rawMonth:undefined);
   selectedApplication.monthText=fmt.monthText(selectedApplication.month);
  }
  let selectedFinanceChange=null;
  if(this.feeProposalId){
   const proposal=await api.detail('feeProposals',this.feeProposalId);
   const adjustment=await api.detail('adjustments',proposal.adjustmentId);
   if(adjustment.outlet!==proposal.outlet||adjustment.owner!==proposal.owner)throw new Error('费用调整记录无法核实，请联系总部客服。');
   selectedFinanceChange={id:proposal.id,amountText:fmt.money(proposal.amount),statusText:fmt.label(proposal.status,'finance'),
    outletName:proposal.outletName,monthText:fmt.monthText(proposal.offsetMonth),serviceUntilText:fmt.dateText(proposal.serviceUntil),
    billId:adjustment.proposalId===proposal.id?adjustment.appliedBillId:null};
  }
  if(serial!==this._serial)return;
  const billIndex=this.billId?payableBills.findIndex(x=>x.id===this.billId):payableBills.length===1&&!this.data.pagers.bills?.hasMore?0:-1;
  const receiptIndex=this.receiptId?realReceipts.findIndex(x=>x.id===this.receiptId):realReceipts.length===1&&!this.data.pagers.receipts?.hasMore?0:-1;
  const formBill=this.getFormBill(this.data.type,{bills,payableBills,receipts:realReceipts,billIndex,receiptIndex});
  this.setData({bills,payableBills,receipts:realReceipts,applicationGroups,selectedApplication,selectedFinanceChange,
   billIndex,receiptIndex,formBill},()=>{
    if(this.data.sourceLocked&&!this._scrolledToForm){
     this._scrolledToForm=true;
     wx.pageScrollTo?.({selector:'#finance-application-form',duration:0});
    }
   });
 },
 getFormBill(type,{bills,payableBills,receipts,billIndex,receiptIndex}){
  const receipt=type==='offline'?null:receipts[receiptIndex];
  const matchesReceipt=row=>Boolean(row&&receipt?.billId&&row.id===receipt.billId&&row.outlet===receipt.outlet&&
   (!receipt.month||receipt.month===(row.rawMonth||row.month)));
  const bill=type==='offline'?payableBills[billIndex]:bills.find(matchesReceipt);
  const ledger=this.data.ledgerBill;
  const original=bill||(matchesReceipt(ledger)?ledger:null);
  if(!original||
   (this.data.ledgerOutlet&&original.outlet!==this.data.ledgerOutlet)||
   (this.data.ledgerMonth&&(original.rawMonth||original.month)!==this.data.ledgerMonth)||
   ((this.data.sourceLocked||this.data.billSheet)&&(!ledger||original.id!==ledger.id||original.outlet!==ledger.outlet||(original.rawMonth||original.month)!==ledger.rawMonth)))return null;
  return {id:original.id,outlet:original.outlet,outletName:original.outletName,
   month:bill?fmt.monthText(bill.month):ledger.month,rawMonth:bill?.month||ledger?.rawMonth,receiptId:receipt?.id};
 },
 async loadLedger(){
  const serial=this._serial,{ledgerOutlet,ledgerMonth,ledgerOffset,ledgerBillId,ledgerSection,ledgerSectionOffset,ledgerRecordId}=this.data;
  const detail=ledgerBillId?await api.request('/api/finance/bills/'+encodeURIComponent(ledgerBillId)+'?'+api.query({
   section:ledgerSection,offset:ledgerSectionOffset,limit:20,recordId:ledgerRecordId,
  })):null;
  if(serial!==this._serial)return;
  const b=detail?.bill;
  if(b&&(b.id!==ledgerBillId||(ledgerOutlet&&b.outlet!==ledgerOutlet)||(ledgerMonth&&b.month!==ledgerMonth)))throw new Error(invalidOriginal);
  if(ledgerRecordId&&detail?.selectedRecord?.id!==ledgerRecordId)throw new Error('原账单明细无法核实，请返回原账单重新办理。');
  const [summary,config]=await Promise.all([
   api.request('/api/finance/summary?'+api.query({outlet:ledgerOutlet||b?.outlet,month:ledgerMonth||b?.month,limit:20,offset:b?0:ledgerOffset})),
   b&&this.data.financeView==='bill'?api.request('/api/config').catch(()=>null):null,
  ]);
  if(serial!==this._serial)return;
  const rollup={...summary,metrics:ledgerRows(summary.totals),adjustment:summary.totals.pendingAdjustmentCount+' 笔 · '+cents(summary.totals.pendingAdjustmentCents)};
  let selected=null;
  if(detail){
   const p=detail[ledgerSection];
   const context=billSections.find(([key])=>key===ledgerSection)[2];
   const rows=detail.selectedRecord?[detail.selectedRecord,...p.items.filter(row=>row.id!==detail.selectedRecord.id)]:p.items;
   const outlet=this.data.state.outlets.find(row=>row.id===b.outlet);
   const outletName=outlet?fmt.outletOptionLabel(outlet):summary.outlets.items.find(row=>row.outlet===b.outlet)?.name||b.outlet;
   const partner=Boolean(this.data.session?.role==='partner');
   const dueText=fmt.dateText(b.dueOn);
   const pendingOffline=detail.offlinePayments?.items.some(row=>row.status==='pending');
   const paymentBlock=b.status!=='unpaid'?'当前账单无需付款。'
    :pendingOffline?'线下付款正在核验，可在更多账单记录中查看线下登记进度。'
    :!partner?'请由网点所属加盟商负责人付款。'
    :!config&&this.data.financeView==='bill'?'暂无法确认微信支付是否可用，请刷新后重试。'
    :config?.adapterMode!=='real'||config.paymentEnabled!==true?'微信支付暂未开放。':'';
   selected={id:b.id,owner:b.owner,outlet:b.outlet,month:fmt.monthText(b.month),rawMonth:b.month,outletName,agreementId:b.agreementId,
    status:b.status,dueText,paymentBlock,canPay:!paymentBlock,canRegisterPayment:b.status==='unpaid'&&!pendingOffline,
    pendingPayment:config?.adapterMode==='real'&&partner?detail.payments.items.find(row=>row.status==='pending'&&row.adapterMode!=='mock')||null:null,
    amount:cents(b.status==='unpaid'?b.ledger.unpaidCents:b.ledger.receivableCents),
    metrics:ledgerRows(b.ledger),heading:fmt.label(b.status,'bill'),statusTone:fmt.statusTone(b.status,'bill'),
    fields:billFields.filter(([key])=>b[key]).map(([key,label])=>({key,label,value:['billOn','dueOn'].includes(key)?fmt.dateText(b[key]):b[key]})),
    sections:billSections.filter(([key])=>mainSections.has(key)).map(([key,label])=>({key,label,count:detail[key].total})),
    historySections:billSections.filter(([key])=>!mainSections.has(key)&&detail[key]).map(([key,label])=>({key,label,count:detail[key].total})),pager:p,
    records:rows.map(row=>{
     const refund=context==='refund'?refundDisplay(row):null;
     return {id:row.id,status:refund?.statusText||fmt.label(row.status,context),amount:row.amount==null?'':'¥ '+fmt.money(row.amount),
     caption:fmt.dateText(row.billOn||row.paidOn||row.refundedOn||row.issuedOn)||fmt.monthText(row.offsetMonth||row.month)||fmt.timeText(row.createdAt),
     channelText:financeChannels[row.channel]||(row.offlinePaymentId?'线下付款':''),
     beforeAmount:row.beforeAmount==null?'':fmt.money(row.beforeAmount),replacementBillId:row.replacementBillId,
     reference:displayReference(row),refundNote:refund?.refundNote,referenceLabel:refund?.referenceLabel,simulation:row.adapterMode==='mock',
     canRequest:ledgerSection==='receipts'&&receiptAllowed(row)};
    })};
  }
  this.setData({ledgerOverview:rollup,ledgerBill:selected},()=>{
   if(selected&&this.query.ledgerBillId===selected.id&&!this._scrolledToBill&&!this.data.sourceLocked&&!this.applicationId){
    this._scrolledToBill=true;
    wx.pageScrollTo?.({selector:'#bill-ledger-detail',duration:0});
   }
  });
 },
 chooseFinanceView(e){
  const {view}=e.currentTarget.dataset;
  if(this.data.sourceLocked||this.data.busy)return;
  if(['overview','form','applications'].includes(view))this.setData({financeView:view});
 },
 async chooseLedgerOutlet(e){
  if(this.data.sourceLocked)return;
  const outlet=e.currentTarget.dataset.outlet||'';
  this.query.outlet=outlet;
  this.setData({ledgerOutlet:outlet,ledgerOffset:0,ledgerBillId:'',ledgerBill:null,ledgerRecordId:''});
  await this.refresh();
 },
 async chooseLedgerMonth(e){if(this.data.sourceLocked)return;this.setData({ledgerMonth:e.detail.value,ledgerOffset:0,ledgerBillId:'',ledgerBill:null,ledgerRecordId:''});await this.refresh();},
 async clearLedgerMonth(){if(this.data.sourceLocked)return;this.setData({ledgerMonth:'',ledgerOffset:0,ledgerBillId:'',ledgerBill:null,ledgerRecordId:''});await this.refresh();},
 async ledgerPage(e){this.setData({ledgerOffset:Number(e.currentTarget.dataset.offset)});await this.refresh();},
 async chooseLedgerBill(e){
  if(this.data.sourceLocked||this.data.billSheet||this.data.busy||this.data.loading)return;
  this.setData({financeView:'bill',ledgerBillId:e.currentTarget.dataset.id,ledgerSection:'receipts',ledgerSectionOffset:0,ledgerRecordId:'',
   payment:null,paymentMessage:'',paymentError:''});
  await this.refresh();
 },
 openBillAction(e){
  const {type,id}=e.currentTarget.dataset;
  const {ledgerBill:bill,busy,loading}=this.data;
  if(!bill||busy||loading||this.data.error)return;
  const scope={outlet:bill.outlet,month:bill.rawMonth,ledgerBillId:bill.id,type};
  if(type==='offline'&&bill.canRegisterPayment)return go('finance',api.query({...scope,billId:bill.id}));
  if(['refund','invoice'].includes(type)&&bill.records.some(row=>row.id===id&&row.canRequest)){
   return go('finance',api.query({...scope,receiptId:id,section:'receipts',ledgerRecordId:id}));
  }
 },
 openBillAgreement(){
  const {ledgerBill:bill,loading,error,busy}=this.data;
  if(!busy&&!loading&&!error&&bill?.agreementId)return go('agreements',api.query({outlet:bill.outlet,id:bill.agreementId}));
 },
 async openBillSheet(e){
  const {type,id}=e.currentTarget.dataset;
  const {ledgerBill:bill,busy,loading,error}=this.data;
  if(!bill||busy||loading||error||this.data.sheetLoading||this.data.billSheet||!['refund','invoice'].includes(type)||
   !bill.records.some(row=>row.id===id&&row.canRequest))return;
  const serial=this._serial;
  this.setData({sheetLoading:true,error:''});
  try{
   const receipt=await api.detail('receipts',id);
   if(serial!==this._serial||this.data.ledgerBill?.id!==bill.id)return;
   if(receipt.id!==id||!receiptAllowed(receipt)||receipt.billId!==bill.id||receipt.owner!==bill.owner||receipt.outlet!==bill.outlet||
    (receipt.month&&receipt.month!==bill.rawMonth))throw new Error(invalidOriginal);
   this.receiptId=id;
   this.setData({billSheet:true,type,typeIndex:types.findIndex(row=>row.id===type),form:initialForm(),receiptIndex:0,
    receipts:[{...receipt,pickerName:[financeChannels[receipt.channel],fmt.dateText(receipt.paidOn),'¥ '+fmt.money(receipt.amount)].filter(Boolean).join(' · ')}],
    formBill:{id:bill.id,outlet:bill.outlet,outletName:bill.outletName,month:bill.month,rawMonth:bill.rawMonth,receiptId:id}});
  }catch(error){if(serial===this._serial)this.setData({error:error.message});}
  finally{if(serial===this._serial)this.setData({sheetLoading:false});}
 },
 closeBillSheet(){
  if(!this.data.billSheet||this.data.busy||this.data.loading)return;
  const close=()=>{
   this.receiptId='';
   this._dirty=false;
   this.setData({billSheet:false,form:initialForm(),formBill:null,receiptIndex:-1,error:''});
  };
  if(!this._dirty)return close();
  wx.showModal?.({title:'放弃本次填写？',content:'尚未提交的申请内容将清空。',confirmText:'放弃',cancelText:'继续填写',
   success:result=>{if(result.confirm&&!this.data.busy)close();}});
 },
 async payBill(){
  const {ledgerBill:bill,busy,loading,payment,billSheet}=this.data;
  if(!bill?.canPay||busy||loading||billSheet||bill.pendingPayment||payment?.status==='pending')return;
  const attempt={};
  const isCurrent=paymentScope(this,()=>this.data.financeView==='bill'&&this.data.ledgerBill?.id===bill.id);
  this.setData({busy:true,paymentMessage:'',paymentError:''});
  try{
   const result=await checkout(bill.id,attempt,payment=>this.setData({payment}),isCurrent);
   if(result&&isCurrent())await this.applyPaymentResult(bill.id,result.payment,attempt);
  }catch(error){
   if(isCurrent())this.setData({paymentError:error.message,paymentMessage:attempt.paymentId?paymentNotice(null,attempt):''});
  }finally{if(!this._paymentUnloaded)this.setData({busy:false});}
 },
 async checkBillPayment(e){
  const {ledgerBill:bill,busy,loading,payment}=this.data;
  const id=payment?.status==='pending'?payment.id:bill?.pendingPayment?.id;
  if(!bill||busy||loading||!id)return;
  const isCurrent=paymentScope(this,()=>this.data.financeView==='bill'&&this.data.ledgerBill?.id===bill.id);
  this.setData({busy:true,paymentError:''});
  try{
   const result=e.currentTarget.dataset.action==='close'?await api.closePayment(id):await api.queryPayment(id);
   if(isCurrent())await this.applyPaymentResult(bill.id,result.payment);
  }catch(error){if(isCurrent())this.setData({paymentError:error.message});}
  finally{if(!this._paymentUnloaded)this.setData({busy:false});}
 },
 async applyPaymentResult(billId,payment,attempt){
  if(payment?.billId&&payment.billId!==billId)throw new Error(invalidOriginal);
  this.setData({payment,paymentMessage:paymentNotice(payment,attempt),ledgerSection:payment?.status==='success'?'receipts':'payments',
   ledgerSectionOffset:0,ledgerRecordId:'',billHistoryOpen:payment?.status!=='success'});
  await this.refresh();
 },
 toggleBillHistory(){this.setData({billHistoryOpen:!this.data.billHistoryOpen});},
 /* DEV_ONLY_START */
 openMockPayment(){
  const bill=this.data.ledgerBill;
  if(!this.data.busy&&!this.data.loading&&bill?.status==='unpaid'&&this.data.state?.adapterMode==='mock')
   return go('fees',api.query({id:bill.id,outlet:bill.outlet,month:bill.rawMonth}));
 },
 /* DEV_ONLY_END */
 openApplicationBill(){
  const {selectedApplication,formBill}=this.data;
  const bill=selectedApplication?.billId
    ? {id:selectedApplication.billId,outlet:selectedApplication.outlet,month:selectedApplication.month,receiptId:selectedApplication.receiptId}
    : formBill;
  if(!bill)return;
  if(!this.data.sourceLocked&&this.data.ledgerBillId===bill.id&&this.query.ledgerBillId===bill.id){
   this.applicationId='';
   this.receiptId='';
   this.setData({financeView:'bill',ledgerSection:bill.receiptId?'receipts':this.data.ledgerSection,ledgerSectionOffset:0,ledgerRecordId:bill.receiptId||''});
   return this.refresh();
  }
  const showBill=()=>go('finance',api.query({outlet:bill.outlet,month:bill.rawMonth||bill.month,ledgerBillId:bill.id,section:bill.receiptId?'receipts':undefined,ledgerRecordId:bill.receiptId}));
  const previous=typeof getCurrentPages==='function'?getCurrentPages().at(-2):null;
  const previousBill=previous?.data?.ledgerBill;
  const sameRecord=!bill.receiptId||(previous?.data?.ledgerSection==='receipts'&&previousBill?.records?.some(row=>row.id===bill.receiptId));
  if(previous?.route==='pages/finance/index'&&!previous.data.sourceLocked&&previousBill?.id===bill.id&&sameRecord&&typeof wx.navigateBack==='function'){
   return wx.navigateBack({delta:1,fail:showBill});
  }
  return showBill();
 },
 openApplication(e){
  const id=e.currentTarget.dataset.id;
  const row=this.data.applicationGroups.flatMap(group=>group.rows).find(item=>item.id===id);
  if(row)go('finance',api.query({id:row.id,outlet:row.outlet,month:row.month,ledgerBillId:row.billId}));
 },
 openOriginalPayment(){
  const payment=this.data.selectedApplication?.originalPayment;
  if(payment)go('finance',api.query({outlet:payment.outlet,month:payment.month,ledgerBillId:payment.billId,section:'receipts',ledgerRecordId:payment.id}));
 },
 async closeLedgerBill(){
  const bill=this.data.ledgerBill;
  if(!bill||this.data.loading)return;
  this.query.outlet=bill.outlet;
  this.setData({financeView:'overview',ledgerOutlet:bill.outlet,ledgerBillId:'',ledgerBill:null,ledgerRecordId:''});
  await this.refresh();
 },
 async ledgerSection(e){
  const {section,offset}=e.currentTarget.dataset;
  if(this.data.busy||this.data.loading||this.data.billSheet||!billSections.some(([key])=>key===section))return;
  this.setData({ledgerSection:section,ledgerSectionOffset:Number(offset)||0,ledgerRecordId:''});
  await this.refresh();
 },
 async filterStatus(e){
  this.applicationId='';
  this.setData({statusFilter:e.currentTarget.dataset.status});
  await this.refresh();
 },
 selectType(e){
  const i=Number(e.detail.value);
  if(this.data.sourceLocked||this.data.billSheet||!types[i])return;
  this.applicationId='';
  this.setData({financeView:'form',typeIndex:i,type:types[i].id,selectedApplication:null,'form.amount':'',error:'',
   formBill:this.getFormBill(types[i].id,this.data)});
 },
 selectBill(e){
  const i=Number(e.detail.value),bill=this.data.payableBills[i];
  if(this.data.sourceLocked||this.data.billSheet||!bill)return;
  this.billId=bill?.id;
  this.setData({billIndex:i,'form.amount':String(bill.amount??''),formBill:this.getFormBill('offline',{...this.data,billIndex:i})});
 },
 selectReceipt(e){
  const i=Number(e.detail.value);
  if(this.data.sourceLocked||this.data.billSheet||!this.data.receipts[i])return;
  this.receiptId=this.data.receipts[i]?.id;
  this.setData({receiptIndex:i,formBill:this.getFormBill(this.data.type,{...this.data,receiptIndex:i})});
 },
 async submit(){
  if(this.data.busy||this.data.loading||!(this.data.financeView==='form'||this.data.billSheet))return;
  const f=this.data.form;
  if(!/^\d+(\.\d{1,2})?$/.test(f.amount)||Number(f.amount)<=0||!f.reason.trim()){
   return this.setData({error:'请填写大于零且最多两位小数的申请金额，并填写申请原因或补充说明。'});
  }
  const type=this.data.type;
  if((this.data.sourceLocked||this.data.billSheet||this.data.ledgerOutlet||this.data.ledgerMonth)&&!this.data.formBill){
   return this.setData({error:'请返回原账单重新办理。'});
  }
  let command,payload;
  if(type==='offline'){
   const bill=this.data.payableBills[this.data.billIndex];
   if(!bill||!f.reference.trim()||!f.paidOn)return this.setData({error:'请选择应付账单，并填写交易流水号和付款日期。'});
   if(this.data.sourceLocked&&bill.id!==this.query.ledgerBillId)return this.setData({error:'请返回原账单重新办理。'});
   command='offline.submit';
   payload={billId:bill.id,amount:Number(f.amount),reference:f.reference.trim(),paidOn:f.paidOn,reason:f.reason.trim()};
  }else{
   const receipt=this.data.receipts[this.data.receiptIndex];
   if(!receipt)return this.setData({error:this.data.receipts.length?'请选择已核验的原付款记录。':'暂无可申请的原付款记录。'});
   if(this.data.sourceLocked&&receipt.billId!==this.query.ledgerBillId)return this.setData({error:'请返回原账单重新办理。'});
   if(this.data.billSheet&&(receipt.id!==this.data.formBill.receiptId||receipt.billId!==this.data.ledgerBillId))return this.setData({error:'请返回原账单重新办理。'});
   payload={receiptId:receipt.id,amount:Number(f.amount),reason:f.reason.trim()};
   command=type==='refund'?'refund.request':'invoice.request';
   if(type==='invoice'){
    if(!f.title.trim()||!f.taxId.trim())return this.setData({error:'请填写发票抬头和纳税人识别号。'});
    Object.assign(payload,{title:f.title.trim(),taxId:f.taxId.trim()});
   }
  }
  const result=await this.mutate(command,payload,'已提交申请。');
  if(!result?.result?.id)return;
  const group=applications.find(item=>item.type===type);
  const selected=fmt.decorate({[group.name]:[result.result],outlets:this.data.state.outlets})[group.name][0];
  this.applicationId=selected.id;
  this.applicationCollection=group.name;
  const application=displayApplication(selected,group);
  const month=application.month||this.data.formBill?.rawMonth;
  this.setData({financeView:'result',billSheet:false,'form.reason':'','form.reference':'',
   selectedApplication:{...this.data.selectedApplication,...application,month,monthText:fmt.monthText(month),type,title:group.title}},()=>{
   wx.pageScrollTo?.({selector:'#finance-application-result',duration:0});
  });
 }
});

Page({...page,onShow(){this._paymentHidden=false;return page.onShow.call(this);},onHide(){this._paymentHidden=true;},
onUnload(){this._paymentUnloaded=true;page.onUnload.call(this);},refresh(){
 this.setData({ledgerBill:null,ledgerOverview:null,formBill:null,selectedApplication:null,selectedFinanceChange:null,sheetLoading:false,
  bills:[],payableBills:[],receipts:[],applicationGroups:[]});
 return page.refresh.call(this);
}});
