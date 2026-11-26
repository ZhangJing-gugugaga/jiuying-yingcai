'use strict';
const core=require('../shared/core.cjs');
const {publicRefundReference,refundRecordSource}=require('../shared/operations.cjs');

const methodVersion='bill-ledger-cents-v1';
const totalsFields=['receivableCents','grossReceivedCents','refundedCents','netReceivedCents','unpaidCents','overdueCents'];
const relations={
 receipts:['id','amount','status','paymentId','offlinePaymentId','externalReference','paidOn','adapterMode','createdAt'],
 payments:['id','amount','status','channel','adapterMode','createdAt','resolvedAt'],
 offlinePayments:['id','amount','status','reference','receiptId','paidOn','createdAt'],
 refundRequests:['id','receiptId','amount','status','reference','customerReference','refundedOn','adapterMode','createdAt'],
 invoiceRequests:['id','receiptId','amount','status','number','issuedOn','redNumber','redOn','invoiceEntity','createdAt'],
};
const supportedMonth=/^20\d{2}-(0[1-9]|1[0-2])$/;
const canRead=actor=>['manager','finance'].includes(actor)||!!core.own(actor);
const equalBill=(table,bill='b')=>"json_extract("+table+".data,'$.billId')="+bill+".id AND "+table+".owner="+bill+".owner AND "+table+".outlet="+bill+".outlet";
const selectTotals=(alias='')=>totalsFields.map(key=>"COALESCE(SUM("+alias+key+"),0) "+key).join(',');
const pick=(data,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]]));
function totals(row){
 const result=pick(row,totalsFields);
 core.check(Object.values(result).every(Number.isSafeInteger),'LEDGER_RANGE','账务金额超出安全统计范围',409);
 return result;
}

function billLedgerSQL(where){
 return `bill_cash AS (
  SELECT b.id,b.owner,b.outlet,b.month,b.status,b.data,b.rowid AS sequence,b.amount_cents AS billedCents,
    COALESCE((SELECT SUM(r.amount_cents) FROM receipts r WHERE ${equalBill('r')} AND r.status='success'),0) grossReceivedCents,
    COALESCE((SELECT SUM(f.amount_cents) FROM refundRequests f JOIN receipts r
       ON r.id=json_extract(f.data,'$.receiptId') AND ${equalBill('r')} AND r.status='success'
       WHERE ${equalBill('f')} AND f.status='recorded'),0) refundedCents
  FROM bills b WHERE ${where}
 ), balances AS (
   SELECT *,CASE WHEN status='reversed' THEN 0 ELSE billedCents END receivableCents,
     grossReceivedCents-refundedCents netReceivedCents,
     CASE WHEN status='unpaid' THEN MAX(0,billedCents-(grossReceivedCents-refundedCents)) ELSE 0 END unpaidCents
   FROM bill_cash
 ), ledger AS (
   SELECT *,CASE WHEN json_extract(data,'$.dueOn') < ? THEN unpaidCents ELSE 0 END overdueCents
   FROM balances
 )`;
}

function billMetrics(db,ids,today){
 if(!ids.length)return new Map();
 const sql='WITH '+billLedgerSQL('b.id IN (SELECT value FROM json_each(?))');
 return new Map(db.prepare(sql+' SELECT * FROM ledger').all(JSON.stringify(ids),today).map(row=>[row.id,totals(row)]));
}

function markPendingRefunds(db,requests){
 const approved=requests.filter(row=>row.status==='approved');
 if(!approved.length)return;
 const pending=new Set(db.prepare(`SELECT refund_request_id id FROM payment_refund_orders
  WHERE refund_request_id IN (SELECT value FROM json_each(?)) AND adapter_mode='real' AND status='pending'`)
  .all(JSON.stringify(approved.map(row=>row.id))).map(row=>row.id));
 for(const row of approved)if(pending.has(row.id))row.channelRefundStatus='pending';
}

function pagination(params){
 const limit=Number(params.limit??50),offset=Number(params.offset??0);
 core.check(Number.isInteger(limit)&&limit>0&&limit<=200&&Number.isSafeInteger(offset)&&offset>=0,'INPUT','limit须1—200，offset非负');
 return {limit,offset};
}

function page(items,total,{limit,offset}){
 return {items,total,limit,offset,hasMore:offset+items.length<total};
}

function csvLine(cells){
 return cells.map(cell=>{
  const value=typeof cell==='string'?cell.replace(/^[=+@\-\t\r\n]/,"'$&"):String(cell??'');
  return '"'+value.replaceAll('"','""')+'"';
 }).join(',');
}

function centsText(cents){
 if(cents==null)return null;
 const digits=String(Math.abs(cents)).padStart(3,'0');
 return (cents<0?'-':'')+digits.slice(0,-2)+'.'+digits.slice(-2);
}

function finance(store,{today=()=>store.settings().today}={}){
 const db=store.db;
 function read(run){
  db.exec('BEGIN');
  try{const result=run();db.exec('COMMIT');return result;}
  catch(error){db.exec('ROLLBACK');throw error;}
 }

 function authorize(session){
  core.check(canRead(session.actor),'FORBIDDEN','当前岗位无账务流水权限',403);
  return core.own(session.actor);
 }

 function searchScope(session,params){
  const own=authorize(session),month=params.month||null;
  const owner=params.owner==='all'?null:params.owner||null;
  const outlet=params.outlet==='all'?null:params.outlet||null;
  core.check(!month||typeof month==='string'&&supportedMonth.test(month),'INPUT','月份格式无效');
  core.check(!own||!owner||own===owner,'FORBIDDEN','无主体权限',403);
  core.check(!owner||typeof owner==='string'&&owner.length<=120,'INPUT','主体编号无效');
  core.check(!outlet||typeof outlet==='string'&&outlet.length<=120,'INPUT','网点编号无效');
  if(outlet)core.check(db.prepare('SELECT id FROM outlets WHERE id=? AND (? IS NULL OR owner=?)')
   .get(outlet,own||owner,own||owner),'FORBIDDEN','无网点权限',403);
  const filters={owner:own||owner,id:outlet};
  const conditions=Object.entries(filters).filter(([,value])=>!!value);
  const args=conditions.map(([,value])=>value);
  const parts=conditions.map(([key])=>'o.'+key+'=?');
  return {month,where:parts.join(' AND ')||'1',args,today:today()};
 }

 function aggregates(scope){
  const filters=['EXISTS (SELECT 1 FROM eligible_outlets o WHERE o.id=b.outlet AND o.owner=b.owner)'];
  if(scope.month)filters.push('b.month=?');
  const sql=billLedgerSQL(filters.join(' AND '));
  const cte='WITH eligible_outlets AS (SELECT id,owner,data FROM outlets o WHERE '+scope.where+'), '+sql+`, pending_adjustments AS (
    SELECT a.outlet,count(*) pendingAdjustmentCount,count(*)-count(a.amount_cents) unknownAdjustmentCount,
        SUM(a.amount_cents) pendingAdjustmentCents
    FROM adjustments a JOIN eligible_outlets o ON o.id=a.outlet AND o.owner=a.owner
    WHERE a.status='待财务核算调整' ${scope.month?`AND substr(json_extract(a.data,'$.from'),1,7)<=?
        AND substr(json_extract(a.data,'$.to'),1,7)>=?`:''}
    GROUP BY a.outlet
  )`;
  const args=[...scope.args,...(scope.month?[scope.month]:[]),scope.today,...(scope.month?[scope.month,scope.month]:[])];
  return {cte,args};
 }

 function summaryTotals(cte,args){
  const result=db.prepare(cte+` SELECT ${selectTotals()},
   COALESCE((SELECT SUM(pendingAdjustmentCount) FROM pending_adjustments),0) pendingAdjustmentCount,
   COALESCE((SELECT SUM(unknownAdjustmentCount) FROM pending_adjustments),0) unknownAdjustmentCount,
   (SELECT SUM(pendingAdjustmentCents) FROM pending_adjustments) pendingAdjustmentCents
   FROM ledger`).get(...args);
  return withAdjustments(result);
 }

 function withAdjustments(result){
  return {...totals(result),pendingAdjustmentCount:result.pendingAdjustmentCount,
   pendingAdjustmentCents:result.unknownAdjustmentCount?null:(result.pendingAdjustmentCents??0),unknownAdjustmentCount:result.unknownAdjustmentCount};
 }

 function summary(session,params={}){
  return read(()=>{
   const scope=searchScope(session,params),pager=pagination(params),{cte,args}=aggregates(scope);
   const total=db.prepare('SELECT count(*) n FROM outlets o WHERE '+scope.where).get(...scope.args).n;
   const items=db.prepare(cte+`, page_outlets AS (SELECT * FROM eligible_outlets ORDER BY id LIMIT ? OFFSET ?)
    SELECT o.id outlet,o.owner,json_extract(o.data,'$.name') name,${selectTotals('l.')},
      COALESCE(pa.pendingAdjustmentCount,0) pendingAdjustmentCount,
      COALESCE(pa.unknownAdjustmentCount,0) unknownAdjustmentCount,pa.pendingAdjustmentCents
    FROM page_outlets o LEFT JOIN ledger l ON l.outlet=o.id LEFT JOIN pending_adjustments pa ON pa.outlet=o.id
    GROUP BY o.id ORDER BY o.id`).all(...args,pager.limit,pager.offset)
    .map(row=>({...pick(row,['outlet','owner','name']),...withAdjustments(row)}));
   return {methodVersion,currency:'CNY',today:scope.today,month:scope.month,totals:summaryTotals(cte,args),outlets:page(items,total,pager)};
  });
 }

 function detail(session,id,params={}){
  return read(()=>{
   const owner=authorize(session);
   core.check(typeof id==='string'&&id.length>0&&id.length<=120,'INPUT','账单编号无效');
   const row=db.prepare('SELECT data FROM bills WHERE id=? AND (? IS NULL OR owner=?)').get(id,owner,owner);
   core.check(row,'NOT_FOUND','记录不存在或无权访问',404);
   const bill=JSON.parse(row.data),pager=pagination(params),section=params.section||'receipts';
   core.check(Object.hasOwn(relations,section)||['lineage','credits','corrections'].includes(section),'INPUT','账单详情分类无效');
   core.check(params.recordId===undefined||typeof params.recordId==='string'&&params.recordId.length>0&&params.recordId.length<=160,'INPUT','账单明细编号无效');
   const metadata=['id','owner','outlet','month','status','amount','grossAmount','creditAmount','adjustmentIds','originalCredit','adjustmentTreatment',
    'agreementId','agreementReference','priceVersion','serviceEntity','collectionEntity','invoiceEntity','currency','dueOn','billOn',
    'replaces','rootBillId','replacementBillId','correctionId','generation','methodVersion','simulation'];
   const lineagePrefix=`WITH RECURSIVE related(id) AS (
    SELECT ? UNION
    SELECT x.id FROM bills x JOIN related r ON json_extract(x.data,'$.replaces')=r.id WHERE x.owner=? AND x.outlet=? AND x.month=?
    UNION
    SELECT previous.id FROM bills x JOIN related r ON x.id=r.id
    JOIN bills previous ON previous.id=json_extract(x.data,'$.replaces')
    WHERE previous.owner=? AND previous.outlet=? AND previous.month=?
   )`;
   const lineageArgs=[id,bill.owner,bill.outlet,bill.month,bill.owner,bill.outlet,bill.month];
   const sections={};
   let selectedRecord;
   function loadSection(key,{prefix='',table,filter,args,fields}){
    const p=key===section?pager:{limit:pager.limit,offset:0};
    const project=row=>{
     const data=JSON.parse(row.data),result=pick(data,fields);
     if(key==='refundRequests'){
      if(owner){
       const reference=publicRefundReference(data);
       if(reference)Object.assign(result,{reference,customerReference:reference});
      }
      if(data.status==='recorded')result.refundRecordSource=refundRecordSource(data);
     }
     return result;
    };
    const total=db.prepare(prefix+' SELECT count(*) n FROM '+table+' WHERE '+filter).get(...args).n;
    const items=db.prepare(prefix+' SELECT data FROM '+table+' WHERE '+filter+' ORDER BY rowid DESC LIMIT ? OFFSET ?')
     .all(...args,p.limit,p.offset).map(project);
    sections[key]=page(items,total,p);
    if(key===section&&params.recordId){
     const exact=db.prepare(prefix+' SELECT data FROM '+table+' WHERE ('+filter+') AND id=?').get(...args,params.recordId);
     core.check(exact,'NOT_FOUND','账单明细不存在或无权访问',404);
     selectedRecord=project(exact);
    }
    if(key==='refundRequests')markPendingRefunds(db,section===key&&selectedRecord?[...items,selectedRecord]:items);
   }
   loadSection('lineage',{prefix:lineagePrefix,table:'bills',filter:'id IN (SELECT id FROM related)',args:lineageArgs,fields:metadata});
   loadSection('credits',{
    prefix:lineagePrefix,table:'adjustments',
    filter:"owner=? AND outlet=? AND (json_extract(data,'$.appliedBillId') IN (SELECT id FROM related) OR id IN (SELECT a.value FROM bills b, json_each(b.data,'$.adjustmentIds') a WHERE b.id IN (SELECT id FROM related)))",
    args:[...lineageArgs,bill.owner,bill.outlet],
    fields:['id','appliedBillId','requestId','proposalId','status','amount','offsetMonth','from','to','methodVersion'],
   });
   loadSection('corrections',{
    prefix:lineagePrefix,table:'billCorrections',filter:"owner=? AND outlet=? AND json_extract(data,'$.billId') IN (SELECT id FROM related)",
    args:[...lineageArgs,bill.owner,bill.outlet],fields:['id','billId','replacementBillId','status','beforeAmount','amount','createdAt','updatedAt'],
   });
   for(const [key,fields] of Object.entries(relations))loadSection(key,{
    table:key,filter:"json_extract(data,'$.billId')=? AND owner=? AND outlet=?",args:[id,bill.owner,bill.outlet],fields,
   });
   return {methodVersion,bill:{...pick(bill,metadata),ledger:billMetrics(db,[id],today()).get(id)},...sections,...(selectedRecord?{selectedRecord}:{})};
  });
 }

 function catchUpReviews(session,params={}){
  return read(()=>{
   core.check(['manager','finance'].includes(session.actor),'FORBIDDEN','当前岗位无补账复核权限',403);
   const scope=searchScope(session,params),pager=pagination(params),status=params.status||'pending';
   core.check(['pending','handled','all'].includes(status),'INPUT','补账复核状态无效');
   const filters=[scope.where];
   const args=[...scope.args];
   if(scope.month){filters.push('r.month=?');args.push(scope.month);}
   const handled='EXISTS (SELECT 1 FROM bills b WHERE b.outlet=r.outlet AND b.month=r.month)';
   if(status!=='all')filters.push(status==='pending'?'NOT '+handled:handled);
   const from=' FROM billing_catchup_reviews r JOIN outlets o ON o.id=r.outlet WHERE '+filters.join(' AND ');
   const total=db.prepare('SELECT count(*) n'+from).get(...args).n;
   const items=db.prepare("SELECT r.agreement_id agreementId,r.month,r.outlet,json_extract(o.data,'$.name') outletName,r.reason,"+
    'r.request_id requestId,r.created_at createdAt,CASE WHEN '+handled+" THEN 'handled' ELSE 'pending' END status"+from+
    ' ORDER BY r.month,r.agreement_id LIMIT ? OFFSET ?').all(...args,pager.limit,pager.offset);
   return page(items,total,pager);
  });
 }

 function exportData(session,params={}){
  return read(()=>{
   const scope=searchScope(session,params),{cte,args}=aggregates(scope);
   const max=10000;
   const data=db.prepare(cte+' SELECT id,outlet,month,status,'+totalsFields.join(',')+' FROM ledger ORDER BY month,outlet,sequence LIMIT ?')
    .all(...args,max+1);
   core.check(data.length<=max,'INPUT','账单超过导出上限，请按月或网点缩小范围');
   const rows=data.map(row=>({...pick(row,['id','outlet','month','status']),...totals(row)}));
   const total=summaryTotals(cte,args);
   const cells=['账单','网点','账期','状态','应收金额（CNY）','累计实收（CNY）','已退款（CNY）','净实收（CNY）','未收金额（CNY）',
    '逾期金额（CNY）','待核算调整笔数','待核算调整金额（CNY）','金额待确认笔数','运行环境'];
   const environment=store.settings().mode==='production'?'生产环境':'开发测试环境';
   const dataCells=value=>totalsFields.map(key=>centsText(value[key]));
   const csv='\uFEFF'+[
    csvLine(cells),
    ...rows.map(row=>csvLine([row.id,row.outlet,row.month,row.status,...dataCells(row),'','','',environment])),
    csvLine(['汇总','',scope.month,'',...dataCells(total),total.pendingAdjustmentCount,centsText(total.pendingAdjustmentCents),total.unknownAdjustmentCount,environment]),
   ].join('\r\n');
   return {csv,rows,totals:total,month:scope.month,methodVersion};
  });
 }
 return {summary,detail,exportData,catchUpReviews};
}

module.exports={finance,billMetrics,markPendingRefunds,canRead};

