'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../server/storage.cjs');
const {runScheduledBatch}=require('../server/scheduler.cjs');
const {scopedCommandState}=require('../server/command-scope.cjs');
const core=require('../shared/core.cjs');
const manager={actor:'manager',subject:'manager'},finance={actor:'finance',subject:'finance'};
function write(store,who,command,payload,now){
 const today=now.slice(0,10);
 return store.transaction(()=>{
  const {state}=scopedCommandState(store,who,command,payload,today);
  const update=core.execute(state,who.actor,command,payload,{...who,today,now});
  store.save(update.state,{before:state});
  return update.result;
 });
}
function agreement(store,outlet,{startMonth='2026-06',endMonth='2026-12',signed='2026-05-01T00:00:00Z'}={}){
 const plan=write(store,manager,'plan.publish',{name:'整月服务方案',amount:100.10,serviceEntity:'协议服务公司',collectionEntity:'协议收款公司',invoiceEntity:'协议开票公司',terms:'整月',reason:'授权制度'},signed);
 return write(store,manager,'agreement.create',{outlet,planId:plan.id,startMonth,endMonth,billDay:5,dueDay:10,reference:'正式参考号',reason:'确认协议'},signed);
}

test('catch-up issues only a documented complete historical period, survives reruns and durably queues ambiguous periods',async()=>{
 const store=openStore(':memory:');
 try{
  const confirmed=agreement(store,'cs'),partial=agreement(store,'zz'),first=agreement(store,'gz',{startMonth:'2026-08'});
  const closing=agreement(store,'hy',{endMonth:'2026-08'});
  const s=store.load();
  s.outlets.find(x=>x.id==='zz').events=[{date:'2026-08-05',status:'open'}];
  s.outlets.find(x=>x.id==='hy').events.push({date:'2026-08-22',status:'closed'});
  s.outlets.find(x=>x.id==='hy').events.sort((a,b)=>a.date.localeCompare(b.date));
  s.outlets.find(x=>x.id==='hy').status='closed';
  store.transaction(()=>store.save(s));
  const opts={now:'2026-09-02T00:00:00Z',catchUpFromMonth:'2026-08',batchSize:20};
  const result=await runScheduledBatch(store,opts);
  assert.equal(result.billed,1);
  const bills=store.load().bills.filter(b=>b.month==='2026-08');
  assert.equal(bills.length,1);
  assert.equal(bills[0].agreementId,confirmed.id);
  assert.equal(bills[0].generation.source,'scheduler_catchup');
  assert.equal(bills[0].generation.reason,'missed_calendar_month');
  assert.equal(bills[0].generation.scheduledOn,'2026-08-05');
  assert.equal(result.billingOutcomes.find(x=>x.agreementId===partial.id).status,'needs_review');
  assert.equal(result.billingOutcomes.find(x=>x.agreementId===first.id).code,'FIRST_AGREEMENT_MONTH');
  assert.equal(result.billingOutcomes.find(x=>x.agreementId===closing.id).status,'needs_review');
  assert.equal((await runScheduledBatch(store,opts)).billed,0);
  assert.equal(store.load().bills.filter(b=>b.month==='2026-08').length,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM billing_catchup_reviews').get().n,3);
  const ledger=require('../server/finance.cjs').finance(store);
  const review=ledger.catchUpReviews(finance,{month:'2026-08'});
  assert.equal(review.total,3);
  assert.throws(()=>ledger.catchUpReviews({actor:'partnerA',subject:'partnerA'}),{code:'FORBIDDEN'});
  const confirmedManual=write(store,finance,'billing.generate',{agreementId:first.id,month:'2026-08',reason:'该合同首月整月服务已人工核实'},'2026-09-03T04:00:00Z');
  assert.equal(confirmedManual.agreementId,first.id);
  assert.equal(ledger.catchUpReviews(finance,{month:'2026-08'}).total,2);
  assert.equal(ledger.catchUpReviews(finance,{month:'2026-08',status:'handled'}).items[0].agreementId,first.id);
 }finally{store.close();}
});

test('scheduler recovers prior observed month even without historical configuration and never regenerates a voided period',async()=>{
 const store=openStore(':memory:');
 try{
  const a=agreement(store,'cs'),b=agreement(store,'zz');
  const shipment=write(store,finance,'billing.generate',{agreementId:b.id,month:'2026-08'},'2026-08-06T04:00:00Z');
  const voided=write(store,manager,'billing.correct.propose',{billId:shipment.id,amount:0,reason:'无应收'},'2026-08-06T04:01:00Z');
  write(store,finance,'billing.correct.review',{id:voided.id,decision:'approve',note:'无应收'},'2026-08-06T04:02:00Z');
  const first=await runScheduledBatch(store,{now:'2026-08-02T00:00:00Z'});
  assert.equal(first.billed,0);
  const resumed=await runScheduledBatch(store,{now:'2026-09-02T00:00:00Z'});
  assert.equal(resumed.billed,1);
  assert.equal(store.load().bills.find(x=>x.agreementId===a.id).month,'2026-08');
  assert.equal(store.load().bills.filter(x=>x.agreementId===b.id).length,1);
  assert.equal(store.load().bills.find(x=>x.agreementId===b.id).status,'reversed');
 }finally{store.close();}
});

test('correction preserves confirmed parties and original applied credit without applying it to the approved replacement again',()=>{
 const store=openStore(':memory:');
 try{
  const a=agreement(store,'cs'),s=store.load();
  s.adjustments.push({id:'credit-reused',outlet:'cs',owner:'p1',status:'approved',offsetMonth:'2026-08',amount:10.01});
  store.transaction(()=>store.save(s));
  const b=write(store,finance,'billing.generate',{agreementId:a.id,month:'2026-08'},'2026-08-05T04:00:00Z');
  assert.equal(b.amount,90.09);
  assert.equal(b.serviceEntity,'协议服务公司');
  assert.equal(b.agreementReference,'正式参考号');
  const p=write(store,manager,'billing.correct.propose',{billId:b.id,amount:70.08,reason:'复核净应收'},'2026-08-06T04:00:00Z');
  const r=write(store,finance,'billing.correct.review',{id:p.id,decision:'approve',note:'净额已独立复核'},'2026-08-06T05:00:00Z');
  const final=store.load(),original=final.bills.find(x=>x.id===b.id),replacement=final.bills.find(x=>x.id===r.replacementBillId);
  assert.equal(original.creditAmount,10.01);
  assert.deepEqual(original.adjustmentIds,['credit-reused']);
  assert.equal(original.status,'reversed');
  assert.equal(replacement.replaces,b.id);
  assert.equal(replacement.rootBillId,b.id);
  assert.equal(replacement.currency,'CNY');
  assert.equal(replacement.agreementReference,'正式参考号');
  assert.equal(replacement.serviceEntity,'协议服务公司');
  assert.equal(replacement.collectionEntity,'协议收款公司');
  assert.equal(replacement.invoiceEntity,'协议开票公司');
  assert.equal(replacement.amount,70.08);
  assert.equal(replacement.grossAmount,null);
  assert.equal(replacement.creditAmount,0);
  assert.deepEqual(replacement.adjustmentIds,[]);
  assert.deepEqual(replacement.originalCredit,{billId:b.id,grossAmount:100.10,creditAmount:10.01,adjustmentIds:['credit-reused']});
  assert.equal(final.adjustments.find(x=>x.id==='credit-reused').appliedBillId,b.id);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{store.close();}
});


test('fully refunded and red-invoiced original remains discoverable through the replacement bill lineage',()=>{
 const store=openStore(':memory:');
 try{
  const at='2026-08-06T04:00:00Z',a=agreement(store,'cs');
  const bill=write(store,finance,'billing.generate',{agreementId:a.id,month:'2026-08'},at);
  const offline=write(store,manager,'offline.submit',{billId:bill.id,amount:bill.amount,reference:'LOCAL-OFFLINE-V33',paidOn:'2026-08-06',reason:'外部付款核验夹具'},at);
  const receipt=write(store,finance,'offline.review',{id:offline.id,decision:'approve',note:'款项已独立核验'},at).receiptId;
  const invoice=write(store,manager,'invoice.request',{receiptId:receipt,amount:bill.amount,title:'测试企业',taxId:'LOCAL-INVOICE-ID',reason:'隔离测试票据'},at);
  write(store,finance,'invoice.update',{id:invoice.id,status:'issued',number:'BLUE-V33',issuedOn:'2026-08-06',note:'票据测试凭证'},at);
  write(store,finance,'invoice.update',{id:invoice.id,status:'red_pending',note:'已登记冲红'},at);
  write(store,finance,'invoice.update',{id:invoice.id,status:'red_issued',redNumber:'RED-V33',redOn:'2026-08-06',note:'红票复核'},at);
  const refund=write(store,manager,'refund.request',{receiptId:receipt,amount:bill.amount,reason:'原应收纠错'},at);
  write(store,finance,'refund.review',{id:refund.id,decision:'approve',note:'已核对红字发票'},at);
  write(store,finance,'refund.record',{id:refund.id,reference:'LOCAL-REFUND-V33',refundedOn:'2026-08-06',note:'退款已独立核验'},at);
  const proposal=write(store,manager,'billing.correct.propose',{billId:bill.id,amount:70.08,reason:'复核收款依据'},at);
  const corrected=write(store,finance,'billing.correct.review',{id:proposal.id,decision:'approve',note:'净应收已复核'},at);
  const who={actor:'partnerA',subject:'partnerA'},ledger=require('../server/finance.cjs').finance(store,{today:()=> '2026-08-07'});
  const replacement=ledger.detail(who,corrected.replacementBillId);
  assert.equal(replacement.bill.ledger.grossReceivedCents,0);
  assert.equal(replacement.corrections.items[0].id,proposal.id);
  assert.equal(replacement.lineage.items.find(x=>x.id===bill.id).replacementBillId,replacement.bill.id);
  const original=ledger.detail(who,bill.id);
  assert.equal(original.bill.ledger.grossReceivedCents,10010);
  assert.equal(original.bill.ledger.refundedCents,10010);
  assert.equal(original.bill.ledger.netReceivedCents,0);
  assert.equal(original.bill.ledger.receivableCents,0);
  assert.equal(original.receipts.items[0].id,receipt);
  assert.equal(original.offlinePayments.items[0].id,offline.id);
  assert.equal(original.refundRequests.items[0].receiptId,receipt);
  assert.equal(original.invoiceRequests.items[0].number,'BLUE-V33');
  assert.equal(original.invoiceRequests.items[0].redNumber,'RED-V33');
  assert.throws(()=>ledger.detail({actor:'partnerB',subject:'partnerB'},corrected.replacementBillId),{code:'NOT_FOUND'});
 }finally{store.close();}
});


test('current schedule queues a first month when the agreement was entered after the month started',async()=>{
 const store=openStore(':memory:');
 try{
  const late=agreement(store,'cs',{startMonth:'2026-08',signed:'2026-08-04T00:00:00Z'});
  const confirmed=agreement(store,'zz',{startMonth:'2026-08',signed:'2026-07-25T00:00:00Z'});
  const run=await runScheduledBatch(store,{now:'2026-08-08T00:00:00Z'});
  assert.equal(run.billingOutcomes.find(x=>x.agreementId===late.id).code,'FIRST_AGREEMENT_MONTH');
  assert.equal(run.billingOutcomes.find(x=>x.agreementId===confirmed.id).status,'billed');
  assert.equal(store.load().bills.some(b=>b.agreementId===late.id),false);
 }finally{store.close();}
});

