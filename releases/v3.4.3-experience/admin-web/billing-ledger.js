const amounts=[
 ['receivableCents','应收金额'],['grossReceivedCents','累计实收'],['refundedCents','已退款金额'],
 ['netReceivedCents','净实收'],['unpaidCents','未收金额'],['overdueCents','逾期金额'],
];
const sections={
 lineage:['冲正链',['id','账单'],['replaces','替换来源'],['replacementBillId','替换账单'],['amount','金额']],
 corrections:['冲正审批',['id','审批编号'],['billId','原账单'],['replacementBillId','替换账单'],['amount','复核净额']],
 credits:['原抵扣来源',['id','调整编号'],['appliedBillId','实际抵扣账单'],['amount','原抵扣金额']],
 receipts:['原实收流水',['id','实收编号'],['paymentId','支付订单'],['offlinePaymentId','线下付款申请'],['externalReference','凭证'],['amount','金额'],['adapterMode','来源']],
 payments:['支付尝试',['id','支付订单'],['amount','金额'],['channel','渠道'],['adapterMode','来源']],
 offlinePayments:['线下付款',['id','申请编号'],['amount','金额'],['reference','凭证']],
 refundRequests:['退款记录',['id','退款编号'],['receiptId','原实收'],['amount','金额'],['reference','凭证'],['refundedOn','退款日期']],
 invoiceRequests:['发票记录',['id','发票申请'],['receiptId','原实收'],['number','蓝票'],['redNumber','红票'],['invoiceEntity','开票主体']],
};
const reviewReasons={
 FIRST_AGREEMENT_MONTH:'协议首月待确认',FINAL_AGREEMENT_MONTH:'协议末月待确认',
 AGREEMENT_TIMING_UNKNOWN:'合同在当时的生效证据不足',FULL_MONTH_POLICY_UNCONFIRMED:'整月规则待确认',
 CLOSURE_REVIEW:'关闭期间待复核',PREPARATION_REVIEW:'筹备期待复核',
 PARTIAL_MONTH_REVIEW:'部分月待复核',FULL_MONTH_OPERATION_UNCONFIRMED:'完整经营月证据不足',
};
const cents=value=>value==null?'待确认':'¥ '+(value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function financialStatus(section,row,labels){
 if(section==='refundRequests'){
  if(row.status==='approved')return row.channelRefundStatus==='pending'?'退款办理中':'退款申请已通过';
  if(row.status==='recorded')return ({channel:'渠道已确认退款',manual:'已登记外部退款凭证',simulation:'模拟退款已确认'})[row.refundRecordSource]||'已登记退款凭证';
 }
 if(section==='invoiceRequests'&&row.status==='pending')return '发票申请待处理';
 return labels[row.status]||row.status;
}
export function billingLedger({api,esc,pair,panel,button,modal,empty,labels}){
 function metrics(ledger){
  return `<div class="coverage-grid">${amounts.map(([k,label])=>pair(label,cents(ledger[k]))).join('')}</div>`;
 }

 function overview(snapshot,filters){
  if(!snapshot)return '';
  const {totals,outlets}=snapshot;
  const outletRows=outlets.items.map(row=>`<tr><td>${button(row.name||row.outlet,'billing-outlet',{outlet:row.outlet})}</td>${amounts.map(([key])=>`<td>${esc(cents(row[key]))}</td>`).join('')}</tr>`).join('');
  const table=`<div class="table-wrap"><table><thead><tr><th>网点</th>${amounts.map(([,label])=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${outletRows}</tbody></table></div>`;
  return panel('账务汇总',filters+metrics(totals)+pair('待核算调整',totals.pendingAdjustmentCount+' 笔 · '+cents(totals.pendingAdjustmentCents))+
   `<h4>网点账务</h4>${outletRows?table:empty('当前范围没有网点')}<div class="actions">${outlets.offset?button('上一页网点','billing-outlet-page',{offset:Math.max(0,outlets.offset-outlets.limit)}):''}${outlets.hasMore?button('下一页网点','billing-outlet-page',{offset:outlets.offset+outlets.limit}):''}</div>`,
   esc(snapshot.month||'全部账期'));
 }
 async function readBill(id,section='lineage',offset=0){
  const detail=await api('/finance/bills/'+encodeURIComponent(id)+'?'+new URLSearchParams({section,offset,limit:20}));
  const b=detail.bill,[sectionLabel,...fields]=sections[section],p=detail[section];
  const tabs=Object.entries(sections).map(([key,[label]])=>button(label+' '+detail[key].total,'billing-detail',{id,section:key},key===section?'primary':'')).join('');
  const rows=p.items.map(row=>`<article class="record">${fields.map(([key,label])=>key==='id'&&section==='lineage'&&row.id!==id?button(row.id,'billing-detail',{id:row.id,section}):pair(label,row[key])).join('')}${pair('状态',financialStatus(section,row,labels))}</article>`).join('');
  const previous=p.offset?button('上一页','billing-detail',{id,section,offset:Math.max(0,p.offset-p.limit)}):'';
  const next=p.hasMore?button('下一页','billing-detail',{id,section,offset:p.offset+p.limit}):'';
  const financial=metrics(b.ledger)+pair('原账抵扣',b.originalCredit?cents(b.originalCredit.creditAmount==null?null:Math.round(b.originalCredit.creditAmount*100)):'—');
  const identities=pair('服务协议',b.agreementReference||b.agreementId)+pair('合同服务主体',b.serviceEntity)+pair('收款主体',b.collectionEntity)+pair('开票主体',b.invoiceEntity);
  modal('账单详情',panel(esc(b.month)+' · '+esc(b.id),identities+financial)+`<div class="actions">${tabs}</div><h3>${sectionLabel}</h3>${rows||empty('暂无关联记录')}<div class="actions">${previous}${next}</div>`);
 }
 async function reviewQueue(offset=0){
  const result=await api('/finance/catch-up?'+new URLSearchParams({limit:25,offset}));
  const cards=result.items.map(row=>`<article class="record">${pair('网点 / 账期',(row.outletName||row.outlet)+' · '+row.month)}${pair('复核原因',reviewReasons[row.reason]||row.reason)}${pair('协议',row.agreementId)}${pair('请求编号',row.requestId)}${button('打开人工出账表单','billing-review-generate',{id:row.agreementId,month:row.month})}</article>`).join('');
  modal('账单追补待复核',cards||empty('暂无待复核账期'));
  if(result.offset||result.hasMore)document.getElementById('modalBody').insertAdjacentHTML('beforeend',`<div class="actions">${result.offset?button('上一页','billing-catchup',{offset:Math.max(0,result.offset-result.limit)}):''}${result.hasMore?button('下一页','billing-catchup',{offset:result.offset+result.limit}):''}</div>`);
 }
 return {overview,readBill,reviewQueue,amounts,cents};
}

