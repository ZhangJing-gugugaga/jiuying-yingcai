'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openStore}=require('../server/storage.cjs');
const {repository}=require('../server/repository.cjs');
const manager={actor:'manager',subject:'manager'},affiliate={actor:'partnerA',subject:'partnerA'};
const localToday=()=> '2026-12-03';

function ledgerFixture(store){
 const state=store.load();
 state.bills=state.bills.filter(b=>b.outlet==='gz');
 const makeBill=(id,outlet,amount,status,month='2026-11')=>({id,outlet,owner:'p1',amount,month,status,dueOn:month+'-05'});
 state.bills.push(makeBill('bill-many','cs',209.07,'paid'),makeBill('bill-full','zz',10,'paid'),
  makeBill('bill-due','hy',42.10,'unpaid'),makeBill('bill-other-month','cs',12,'unpaid','2026-12'),
  makeBill('bill-reversed','zz',15,'reversed','2026-10'),makeBill('bill-replacement','zz',20,'unpaid','2026-10'));
 const receipt=(id,billId,outlet,amount,status='success')=>({id,billId,outlet,owner:'p1',status,amount});
 for(let i=0;i<207;i++)state.receipts.push(receipt('receipt-spread-'+i,'bill-many','cs',1.01));
 state.receipts.push(receipt('receipt-failed','bill-many','cs',1900,'failed'),
  receipt('receipt-full','bill-full','zz',10),receipt('receipt-reversed','bill-reversed','zz',15));
 const refund=(id,billId,receiptId,outlet,amount,status='recorded')=>({id,billId,receiptId,outlet,owner:'p1',status,amount});
 state.refundRequests.push(refund('refund-partial','bill-many','receipt-spread-0','cs',0.01),
  refund('refund-pending','bill-many','receipt-spread-1','cs',1.01,'approved'),
  refund('refund-full','bill-full','receipt-full','zz',10),
  refund('refund-reversed','bill-reversed','receipt-reversed','zz',15));
 state.adjustments.push({id:'pending-unknown',outlet:'hy',owner:'p1',status:'待财务核算调整',from:'2026-11-02',to:'2026-11-05',amount:null});
 // Existing live writers accept one final receipt per bill. Simulate imported legacy splits only in this isolated database.
 store.db.exec('DROP INDEX receipt_bill_unique');
 store.transaction(()=>{store.db.exec("DELETE FROM bills WHERE outlet<>'gz'");store.save(state);});
}

test('bill collection carries full receipt totals independently of the first 200 receipts',()=>{
 const store=openStore(':memory:');
 try{
  ledgerFixture(store);
  const repo=repository(store,{today:localToday});
  const page=repo.list('receipts',manager,{limit:200});
  const partial=page.items.filter(x=>x.billId==='bill-many'&&x.status==='success').length;
  assert.ok(partial<207);
  assert.equal(repo.detail('bills','bill-many',manager).ledger?.grossReceivedCents,20907);
 }finally{store.close();}
});

test('finance aggregates all posted receipts by bill, retains refund cash, and exposes collectible overdue balance consistently',()=>{
 const store=openStore(':memory:');
 try{
  ledgerFixture(store);
  const {finance}=require('../server/finance.cjs');
  const ledger=finance(store,{today:localToday}),params={month:'2026-11',limit:1};
  const hq=ledger.summary(manager,params),mine=ledger.summary(affiliate,params);
  assert.equal(hq.totals.receivableCents-mine.totals.receivableCents,198000);
  assert.equal(hq.outlets.total,4);
  assert.equal(mine.outlets.hasMore,true);
  assert.equal(mine.outlets.total,3);
  assert.deepEqual(mine.totals,{receivableCents:26117,grossReceivedCents:21907,refundedCents:1001,netReceivedCents:20906,unpaidCents:4210,overdueCents:4210,pendingAdjustmentCount:1,pendingAdjustmentCents:null,unknownAdjustmentCount:1});
  const detail=ledger.detail(affiliate,'bill-many',{limit:200});
  assert.equal(detail.bill.ledger.grossReceivedCents,20907);
  assert.equal(detail.bill.ledger.refundedCents,1);
  assert.equal(detail.bill.ledger.netReceivedCents,20906);
  assert.equal(detail.bill.ledger.unpaidCents,0);
  assert.equal(detail.receipts.total,208);
  assert.equal(detail.receipts.items.length,200);
  assert.equal(ledger.detail(affiliate,'bill-many',{section:'receipts',limit:200,offset:200}).receipts.items.length,8);
  assert.equal(ledger.detail(affiliate,'bill-full').bill.ledger.netReceivedCents,0);
  assert.equal(ledger.detail(affiliate,'bill-full').bill.ledger.unpaidCents,0);
  const billView=repository(store,{today:localToday}).detail('bills','bill-many',affiliate);
  assert.deepEqual(billView.ledger,detail.bill.ledger);
  assert.equal(ledger.summary(affiliate,{month:'2026-10'}).totals.grossReceivedCents,1500);
  assert.equal(ledger.summary(affiliate,{month:'2026-10'}).totals.receivableCents,2000);
  const exported=ledger.exportData(affiliate,params);
  assert.equal(exported.rows.length,3);
  assert.deepEqual(exported.totals,mine.totals);
  assert.match(exported.csv,/"bill-many","cs","2026-11","paid","209\.07","209\.07","0\.01","209\.06","0\.00","0\.00"/);
  assert.match(exported.csv,/"汇总","","2026-11","","261\.17","219\.07","10\.01","209\.06","42\.10","42\.10","1","","1"/);
  assert.doesNotMatch(exported.csv,/"gz"/);
  assert.throws(()=>ledger.summary(affiliate,{outlet:'gz'}),{code:'FORBIDDEN'});
  assert.throws(()=>ledger.summary({actor:'ops',subject:'ops'}),{code:'FORBIDDEN'});
  assert.throws(()=>ledger.detail({actor:'partnerB',subject:'partnerB'},'bill-many'),{code:'NOT_FOUND'});
 }finally{store.close();}
});


test('authenticated finance HTTP exposes signed scope, paged details and audited CSV without a client totals dependency',async()=>{
 const {createServer}=require('../server/index.cjs');
 const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
 ledgerFixture(app.store);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.server.address().port;
 const login=async actor=>{
  const response=await fetch(base+'/api/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor})});
  assert.equal(response.status,200);
  return (await response.json()).data.token;
 };
 const request=(path,token)=>fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});
 try{
  const [hq,partner,other]=await Promise.all(['finance','partnerA','partnerB'].map(login));
  const path='/api/finance/summary?month=2026-11&limit=1';
  const financeResponse=await request(path,hq);
  const partnerResponse=await request(path,partner);
  assert.equal(financeResponse.status,200);
  assert.equal(partnerResponse.status,200);
  const finance=(await financeResponse.json()).data,affiliate=(await partnerResponse.json()).data;
  assert.equal(finance.totals.grossReceivedCents,affiliate.totals.grossReceivedCents);
  assert.equal(affiliate.totals.receivableCents,26117);
  assert.equal(affiliate.outlets.items.length,1);
  const detail=await request('/api/finance/bills/bill-many?limit=200&offset=200',partner);
  assert.equal(detail.status,200);
  const record=(await detail.json()).data;
  assert.equal(record.receipts.items.length,8);
  assert.equal(record.bill.ledger.grossReceivedCents,20907);
  assert.equal((await request('/api/finance/bills/bill-many',other)).status,404);
  assert.equal((await request(path)).status,401);
  const csv=await request('/api/finance/export?month=2026-11',partner);
  assert.equal(csv.status,200);
  assert.match(csv.headers.get('content-type'),/^text\/csv/);
  assert.match(await csv.text(),/"汇总","","2026-11","","261\.17","219\.07","10\.01","209\.06"/);
  const row=app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.command')='export.generated'").get();
  const event=JSON.parse(row.data);
  assert.equal(event.subject,'partnerA');
  assert.equal(event.scope.kind,'finance');
  assert.equal(event.scope.owner,'p1');
  assert.equal(event.methodVersion,'bill-ledger-cents-v1');
 }finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();}
});

test('one final receipt per bill can span more than 200 bills without dropping the production-like uniqueness constraint',()=>{
 const store=openStore(':memory:');
 try{
  const state=store.load(),base=state.outlets.find(o=>o.id==='cs');
  for(let i=0;i<205;i++){
   const outlet='normal-outlet-'+i,billId='bill-normal-'+i;
   state.outlets.push({...base,id:outlet,outlet});
   state.bills.push({id:billId,outlet,owner:'p1',month:'2026-10',amount:0.15,status:'paid'});
   state.receipts.push({id:'receipt-normal-'+i,billId,outlet,owner:'p1',status:'success',amount:0.15});
  }
  store.transaction(()=>store.save(state));
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='receipt_bill_unique'").get());
  const {finance}=require('../server/finance.cjs');
  const result=finance(store,{today:localToday}).summary(affiliate,{month:'2026-10',limit:1});
  assert.equal(result.totals.grossReceivedCents,3075);
  assert.equal(result.totals.netReceivedCents,3075);
  assert.equal(result.totals.receivableCents,3075);
  assert.equal(result.outlets.total,208);
 }finally{store.close();}
});

