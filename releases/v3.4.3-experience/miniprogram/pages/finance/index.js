const {define,go,api,fmt}=require('../../utils/page');

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
 ['payments','付款记录','payment'],['refundRequests','退款申请','refund'],['invoiceRequests','发票申请','invoice'],
];
const cents=value=>value==null?'待确认':'¥ '+fmt.money(value/100);
function ledgerRows(record){return metrics.map(([key,label])=>({key,label,value:cents(record[key])}));}
const outletFilters={name:'bills',filters(){return {outlet:this.data.ledgerOutlet,month:this.data.ledgerMonth};}};
const financeChannels={wechat:'微信支付',alipay:'支付宝',offline:'线下付款'};
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
 return {...row,reference:displayReference(row),amountText:fmt.money(row.amount),statusTone:fmt.statusTone(row.status,group.context),
  ...(group.type==='refund'?refundDisplay(row):{statusText:fmt.label(row.status,group.context)}),
  dateText:fmt.dateText(row.paidOn)||fmt.timeText(row.createdAt)};
}

async function originalPayment(application){
 if(!application.receiptId)return null;
 const receipt=await api.detail('receipts',application.receiptId);
 if(receipt.billId!==application.billId||receipt.outlet!==application.outlet||receipt.owner!==application.owner)throw new Error('原付款记录无法核实，请联系总部客服。');
 return {id:receipt.id,paymentId:receipt.paymentId,billId:receipt.billId,outlet:receipt.outlet,
  amountText:fmt.money(receipt.amount),dateText:fmt.dateText(receipt.paidOn)||fmt.timeText(receipt.createdAt),
  channelText:financeChannels[receipt.channel]||(receipt.offlinePaymentId?'线下付款':'')};
}

Page(define({
 collections:['outlets',outletFilters,'receipts',...applications.map(({name})=>({
  name,
  filters(){return {status:this.data.statusFilter};}
 }))],
 data:{statusFilter:'all',ledgerOutlet:'',ledgerMonth:'',ledgerOffset:0,ledgerOverview:null,ledgerBillId:'',ledgerBill:null,
  ledgerSection:'lineage',ledgerSectionOffset:0,ledgerRecordId:'',types,type:'offline',typeIndex:0,bills:[],payableBills:[],receipts:[],
   billIndex:0,receiptIndex:0,applicationGroups:[],selectedApplication:null,selectedFinanceChange:null,
   sourceLocked:false,formBill:null,form:{amount:'',reference:'',paidOn:fmt.date(),reason:'',title:'',taxId:''}},
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
  const sourceLocked=!selected&&Boolean(q.ledgerBillId&&(q.type==='offline'?q.billId:['refund','invoice'].includes(q.type)&&q.receiptId));
  this.setData({ledgerOutlet:q.outlet==='all'?'':q.outlet||'',ledgerMonth:q.month||'',ledgerBillId:q.ledgerBillId||'',
   sourceLocked,formBill:null,ledgerRecordId:q.ledgerRecordId||'',ledgerSection:billSections.some(([section])=>section===q.section)?q.section:'lineage'});
 },
 async loaded(s){
  const serial=this._serial;
  await this.loadLedger();
  if(serial!==this._serial)return;
  let bills=s.bills,receipts=s.receipts;
  if(this.billId&&!bills.some(x=>x.id===this.billId)){
   const selected=await api.detail('bills',this.billId);
   bills=[...fmt.decorate({bills:[selected]}).bills,...bills];
  }
  if(this.receiptId&&!receipts.some(x=>x.id===this.receiptId)){
   const selected=await api.detail('receipts',this.receiptId);
   receipts=[...fmt.decorate({receipts:[selected]}).receipts,...receipts];
  }
  let exactApplication;
  if(this.applicationId&&!s[this.applicationCollection].some(x=>x.id===this.applicationId)){
   exactApplication=await api.detail(this.applicationCollection,this.applicationId);
  }
  if(serial!==this._serial)return;
  const payableBills=bills.filter(x=>x.status==='unpaid').map(x=>({...x,pickerName:x.month+' · '+x.outletName+' · ¥'+fmt.money(x.amount)}));
  const realReceipts=receipts.filter(x=>x.status==='success'&&x.adapterMode!=='mock').map(x=>({...x,
   pickerName:[x.outletName,fmt.dateText(x.paidOn)||fmt.monthText(x.month)||fmt.timeText(x.createdAt),'¥'+fmt.money(x.amount)].filter(Boolean).join(' · '),
  }));
  let selectedApplication=null;
  const applicationGroups=applications.map(group=>{
   const all=s[group.name]||[];
   const selected=all.find(row=>row.id===this.applicationId)||(group.name===this.applicationCollection?exactApplication:null);
   if(selected)selectedApplication={...displayApplication(selected,group),title:group.title,type:group.type};
   return {...group,rows:all.map(row=>displayApplication(row,group))};
  });
  if(selectedApplication?.type==='refund')selectedApplication.originalPayment=await originalPayment(selectedApplication);
  let selectedFinanceChange=null;
  if(this.feeProposalId){
   const proposal=await api.detail('feeProposals',this.feeProposalId);
   const adjustment=await api.detail('adjustments',proposal.adjustmentId);
   if(adjustment.outlet!==proposal.outlet||adjustment.owner!==proposal.owner)throw new Error('费用调整记录无法核实，请联系总部客服。');
   selectedFinanceChange={id:proposal.id,amountText:fmt.money(proposal.amount),statusText:fmt.label(proposal.status,'finance'),statusTone:fmt.statusTone(proposal.status,'finance'),
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
  const matchesReceipt=row=>Boolean(row&&receipt?.billId&&row.id===receipt.billId&&row.outlet===receipt.outlet);
  const bill=type==='offline'?payableBills[billIndex]:bills.find(matchesReceipt);
  const ledger=this.data.ledgerBill;
  const original=bill||(matchesReceipt(ledger)?ledger:null);
  if(!original||(this.data.sourceLocked&&original.id!==this.query.ledgerBillId))return null;
  return {id:original.id,outlet:original.outlet,outletName:original.outletName,
   month:bill?fmt.monthText(bill.month):ledger.month,receiptId:receipt?.id};
 },
 async loadLedger(){
  const serial=this._serial,{ledgerOutlet,ledgerMonth,ledgerOffset,ledgerBillId,ledgerSection,ledgerSectionOffset,ledgerRecordId}=this.data;
  const [summary,detail]=await Promise.all([
   api.request('/api/finance/summary?'+api.query({outlet:ledgerOutlet,month:ledgerMonth,limit:20,offset:ledgerOffset})),
   ledgerBillId?api.request('/api/finance/bills/'+encodeURIComponent(ledgerBillId)+'?'+api.query({section:ledgerSection,offset:ledgerSectionOffset,limit:20,recordId:ledgerRecordId})):null,
  ]);
  if(serial!==this._serial)return;
  const rollup={...summary,metrics:ledgerRows(summary.totals),adjustment:summary.totals.pendingAdjustmentCount+' 笔 · '+cents(summary.totals.pendingAdjustmentCents)};
  let selected=null;
  if(detail){
   const b=detail.bill,p=detail[ledgerSection];
   const context=billSections.find(([key])=>key===ledgerSection)[2];
   const rows=detail.selectedRecord?[detail.selectedRecord,...p.items.filter(row=>row.id!==detail.selectedRecord.id)]:p.items;
   selected={id:b.id,outlet:b.outlet,month:fmt.monthText(b.month),outletName:this.data.state.outlets.find(row=>row.id===b.outlet)?.name,
    canRegisterPayment:b.status==='unpaid',
    metrics:ledgerRows(b.ledger),heading:fmt.label(b.status,'bill'),statusTone:fmt.statusTone(b.status,'bill'),
    fields:billFields.filter(([key])=>b[key]).map(([key,label])=>({key,label,value:['billOn','dueOn'].includes(key)?fmt.dateText(b[key]):b[key]})),
    sections:billSections.map(([key,label])=>({key,label,count:detail[key].total})),pager:p,
    records:rows.map(row=>{
     const refund=context==='refund'?refundDisplay(row):null;
     return {id:row.id,status:refund?.statusText||fmt.label(row.status,context),amount:row.amount==null?'':'¥ '+fmt.money(row.amount),
     caption:fmt.dateText(row.billOn||row.paidOn||row.refundedOn||row.issuedOn)||fmt.monthText(row.offsetMonth||row.month)||fmt.timeText(row.createdAt),
     beforeAmount:row.beforeAmount==null?'':fmt.money(row.beforeAmount),replacementBillId:row.replacementBillId,
     reference:displayReference(row),refundNote:refund?.refundNote,referenceLabel:refund?.referenceLabel,simulation:row.adapterMode==='mock',
     canRequest:ledgerSection==='receipts'&&row.status==='success'&&row.adapterMode!=='mock'};
    })};
  }
  this.setData({ledgerOverview:rollup,ledgerBill:selected},()=>{
   if(selected&&this.query.ledgerBillId===selected.id&&!this._scrolledToBill&&!this.data.sourceLocked&&!this.applicationId){
    this._scrolledToBill=true;
    wx.pageScrollTo?.({selector:'#bill-ledger-detail',duration:0});
   }
  });
 },
 async chooseLedgerOutlet(e){this.setData({ledgerOutlet:e.currentTarget.dataset.outlet||'',ledgerOffset:0,ledgerBillId:'',ledgerBill:null});await this.refresh();},
 async chooseLedgerMonth(e){this.setData({ledgerMonth:e.detail.value,ledgerOffset:0,ledgerBillId:'',ledgerBill:null});await this.refresh();},
 async clearLedgerMonth(){this.setData({ledgerMonth:'',ledgerOffset:0,ledgerBillId:'',ledgerBill:null});await this.refresh();},
 async ledgerPage(e){this.setData({ledgerOffset:Number(e.currentTarget.dataset.offset)});await this.refresh();},
 async chooseLedgerBill(e){this.setData({ledgerBillId:e.currentTarget.dataset.id,ledgerSection:'lineage',ledgerSectionOffset:0,ledgerRecordId:''});await this.refresh();},
 openBillAction(e){
  const {type,id}=e.currentTarget.dataset;
  const {ledgerBill:bill,busy,loading}=this.data;
  if(!bill||busy||loading)return;
  const scope={outlet:bill.outlet,ledgerBillId:bill.id,type};
  if(type==='offline'&&bill.canRegisterPayment)return go('finance',api.query({...scope,billId:bill.id}));
  if(['refund','invoice'].includes(type)&&bill.records.some(row=>row.id===id&&row.canRequest)){
   return go('finance',api.query({...scope,receiptId:id,section:'receipts',ledgerRecordId:id}));
  }
 },
 openApplicationBill(){
  const {selectedApplication,formBill}=this.data;
  const bill=selectedApplication?.billId
    ? {id:selectedApplication.billId,outlet:selectedApplication.outlet,receiptId:selectedApplication.receiptId}
    : formBill;
  if(!bill)return;
  const showBill=()=>go('finance',api.query({outlet:bill.outlet,ledgerBillId:bill.id,section:bill.receiptId?'receipts':undefined,ledgerRecordId:bill.receiptId}));
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
  if(row)go('finance',api.query({id:row.id,outlet:row.outlet,ledgerBillId:row.billId}));
 },
 openOriginalPayment(){
  const payment=this.data.selectedApplication?.originalPayment;
  if(payment)go('finance',api.query({outlet:payment.outlet,ledgerBillId:payment.billId,section:'receipts',ledgerRecordId:payment.id}));
 },
 closeLedgerBill(){this.setData({ledgerBillId:'',ledgerBill:null});},
 async ledgerSection(e){this.setData({ledgerSection:e.currentTarget.dataset.section,ledgerSectionOffset:Number(e.currentTarget.dataset.offset)||0,ledgerRecordId:''});await this.refresh();},
 async filterStatus(e){
  this.applicationId='';
  this.setData({statusFilter:e.currentTarget.dataset.status});
  await this.refresh();
 },
 selectType(e){
  const i=Number(e.detail.value);
  if(this.data.sourceLocked||!types[i])return;
  this.applicationId='';
  this.setData({typeIndex:i,type:types[i].id,selectedApplication:null,'form.amount':'',error:'',
   formBill:this.getFormBill(types[i].id,this.data)});
 },
 selectBill(e){
  const i=Number(e.detail.value),bill=this.data.payableBills[i];
  if(this.data.sourceLocked||!bill)return;
  this.billId=bill?.id;
  this.setData({billIndex:i,'form.amount':String(bill.amount??''),formBill:this.getFormBill('offline',{...this.data,billIndex:i})});
 },
 selectReceipt(e){
  const i=Number(e.detail.value);
  if(this.data.sourceLocked||!this.data.receipts[i])return;
  this.receiptId=this.data.receipts[i]?.id;
  this.setData({receiptIndex:i,formBill:this.getFormBill(this.data.type,{...this.data,receiptIndex:i})});
 },
 async submit(){
  if(this.data.busy||this.data.loading)return;
  const f=this.data.form;
  if(!/^\d+(\.\d{1,2})?$/.test(f.amount)||Number(f.amount)<=0||!f.reason.trim()){
   return this.setData({error:'请填写大于零且最多两位小数的申请金额，并填写申请原因或补充说明。'});
  }
  const type=this.data.type;
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
  this.setData({'form.reason':'','form.reference':'',selectedApplication:{...displayApplication(selected,group),type,title:group.title}},()=>{
   wx.pageScrollTo?.({selector:'#finance-application-result',duration:0});
  });
 }
}));
