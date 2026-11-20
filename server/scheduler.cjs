'use strict';
const core=require('../shared/core.cjs');
const {scopedCommandState}=require('./command-scope.cjs');
const {randomUUID}=require('node:crypto');
const shanghai=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
const monthPattern=/^20\d{2}-(0[1-9]|1[0-2])$/;

function currentCandidates(db,current,today,lastId,limit){
 const scope=`status='active' AND json_extract(data,'$.startMonth')<=? AND json_extract(data,'$.endMonth')>=?
  AND json_extract(data,'$.billDay')<=?
  AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.outlet=agreements.outlet AND b.month=?)
  AND NOT EXISTS (SELECT 1 FROM billing_catchup_reviews r WHERE r.agreement_id=agreements.id AND r.month=?)`;
 const args=[current,current,Number(today.slice(8)),current,current];
 const select=(order)=>db.prepare(`SELECT id agreementId,? month FROM agreements WHERE ${scope} AND id ${order} ? ORDER BY id LIMIT ?`);
 const rows=select('>').all(current,...args,lastId,limit);
 if(rows.length<limit&&lastId) rows.push(...select('<=').all(current,...args,lastId,limit-rows.length));
 return rows;
}

function historicalCandidates(db,start,current,position,limit){
 if(!start||start>=current)return [];
 const months=`WITH RECURSIVE months(month) AS (
  SELECT ? UNION ALL
  SELECT substr(date(month||'-01','+1 month'),1,7) FROM months WHERE month<substr(date(?||'-01','-1 month'),1,7)
 )`;
 const conditions=`a.status='active' AND json_extract(a.data,'$.startMonth')<=m.month AND json_extract(a.data,'$.endMonth')>=m.month
  AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.outlet=a.outlet AND b.month=m.month)
  AND NOT EXISTS (SELECT 1 FROM billing_catchup_reviews r WHERE r.agreement_id=a.id AND r.month=m.month)`;
 const cursorMonth=position.historyMonth||'',cursorAgreement=position.historyAgreementId||'';
 const query=order=>db.prepare(months+` SELECT m.month,a.id agreementId FROM months m JOIN agreements a WHERE ${conditions}
  AND (m.month,a.id) ${order} (?,?) ORDER BY m.month,a.id LIMIT ?`);
 const rows=query('>').all(start,current,cursorMonth,cursorAgreement,limit);
 if(rows.length<limit&&cursorMonth)rows.push(...query('<=').all(start,current,cursorMonth,cursorAgreement,limit-rows.length));
 return rows;
}

function unsupportedPeriod(agreement,outlet,month,historical){
 const start=month+'-01',end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
 const events=outlet?.events||[],before=events.filter(event=>event.date<start).at(-1);
 const during=events.filter(event=>event.date>=start&&event.date<=end);
 const recordedBeforeMonth=agreement.createdAt&&Number.isFinite(Date.parse(agreement.createdAt))&&shanghai(agreement.createdAt)<start;
 const knownRule=agreement.priceSnapshot?.methodVersion==='full-calendar-month-cents-v1'&&agreement.partialMonthRule==null;
 if(month===agreement.startMonth&&(historical||!recordedBeforeMonth||!knownRule||before?.status!=='open'))return 'FIRST_AGREEMENT_MONTH';
 if(historical){
  if(month===agreement.endMonth)return 'FINAL_AGREEMENT_MONTH';
  if(!recordedBeforeMonth)return 'AGREEMENT_TIMING_UNKNOWN';
  if(!knownRule)return 'FULL_MONTH_POLICY_UNCONFIRMED';
 }
 if(during.some(event=>event.status==='closed')||before?.status==='closed'||(!historical&&outlet?.status==='closed'))return 'CLOSURE_REVIEW';
 if(before?.status==='preparing'||during.some(event=>event.status==='preparing')||(!historical&&outlet?.status==='preparing'))return 'PREPARATION_REVIEW';
 if(during.some(event=>event.status==='open')&&before?.status!=='open')return 'PARTIAL_MONTH_REVIEW';
 if(historical&&(before?.status!=='open'||during.some(event=>event.status!=='open')))return 'FULL_MONTH_OPERATION_UNCONFIRMED';
 return null;
}

async function runScheduledBatch(store,{now=new Date().toISOString(),batchSize=100,catchUpFromMonth}={}){
 core.check(Number.isInteger(batchSize)&&batchSize>0&&batchSize<=200,'INPUT','调度批次为1—200');
 core.check(typeof now==='string'&&Number.isFinite(Date.parse(now)),'INPUT','调度执行时间无效');
 core.check(!catchUpFromMonth||typeof catchUpFromMonth==='string'&&monthPattern.test(catchUpFromMonth),'CONFIG','补账起始月份须为YYYY-MM',500);
 const today=shanghai(now),current=today.slice(0,7),session={actor:'manager',subject:'scheduler',principal:'scheduler'},db=store.db;
 const metric=(key,value)=>db.prepare('INSERT INTO runtime_metrics(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
 const cursor=db.prepare("SELECT value FROM runtime_metrics WHERE key='scheduler.cursor'").get()?.value||0;
 let result;
 store.transaction(()=>{
  const payload={limit:batchSize,cursor};
  const {state,jobScope}=scopedCommandState(store,session,'jobs.run',payload,today);
  const updated=core.execute(state,'manager','jobs.run',payload,{...session,jobScope,today,now,requestId:randomUUID()});
  store.save(updated.state,{before:state});result=updated.result;metric('scheduler.cursor',result.nextCursor??0);
 });

 const loadPosition=()=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='scheduler.billingCursor'").get()?.value||'{}');
 const savePosition=value=>db.prepare("INSERT INTO settings(key,value) VALUES('scheduler.billingCursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
 const position=loadPosition();
 const historicalStart=catchUpFromMonth||position.observedFromMonth||(monthPattern.test(position.month)?position.month:current);
 const sameMonth=position.month===current;
 const lastId=sameMonth&&typeof position.lastAgreementId==='string'?position.lastAgreementId:'';
 const currentFirst=!sameMonth||position.nextLane!=='historical';
 const loadCurrent=limit=>currentCandidates(db,current,today,lastId,limit);
 const loadHistorical=limit=>historicalCandidates(db,historicalStart,current,position,limit);
 const first=(currentFirst?loadCurrent:loadHistorical)(batchSize);
 const candidates=[...first,...(first.length<batchSize?(currentFirst?loadHistorical:loadCurrent)(batchSize-first.length):[])];
 const nextLane=currentFirst?'historical':'current';
 const writePosition=(candidate,complete=false)=>{
  // Merge the current row inside the same write transaction, preserving progress in the other lane.
  const saved=loadPosition();
  if(saved.month!==current){saved.month=current;saved.lastAgreementId='';}
  saved.observedFromMonth=saved.observedFromMonth||(monthPattern.test(position.month)?position.month:current);
  if(complete)saved.nextLane=nextLane;
  if(candidate?.month===current)saved.lastAgreementId=candidate.agreementId;
  else if(candidate){saved.historyMonth=candidate.month;saved.historyAgreementId=candidate.agreementId;}
  savePosition(saved);
 };

 let billed=0,blocked=0,needsReview=0;
 const billingRunId=candidates.length?'billing-run-'+randomUUID():null;
 const run=billingRunId?{id:billingRunId,jobKey:billingRunId,kind:'billing_batch',owner:null,outlet:null,status:'running',month:current,
  createdAt:now,updatedAt:now,startedAt:now,finishedAt:null,processed:0,limit:batchSize,cursorBefore:lastId,cursorAfter:lastId,
  billingOutcomes:[],requestId:randomUUID(),initiator:'scheduler',catchUpFromMonth:historicalStart}:null;
 const writeRun=()=>db.prepare('INSERT INTO jobRuns(id,owner,outlet,status,month,current,amount_cents,data,created_at) VALUES(?,NULL,NULL,?,?,0,NULL,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
  .run(run.id,run.status,current,JSON.stringify(run),run.createdAt);
 function checkpoint(candidate){
  run.processed=run.billingOutcomes.length;run.cursorAfter=candidate.agreementId;run.updatedAt=now;
  writePosition(candidate);writeRun();
 }
 if(run)store.transaction(writeRun);
 for(const candidate of candidates){
  const {agreementId,month}=candidate,requestId=randomUUID(),previous=run.billingOutcomes.length;
  const historical=month<current;
  try{
   const status=store.transaction(()=>{
    const command='billing.generate',payload={agreementId,month};
    const {state}=scopedCommandState(store,session,command,payload,today);
    const agreement=state.agreements.find(x=>x.id===agreementId);
    const outlet=state.outlets.find(x=>x.id===agreement?.outlet);
    const base={agreementId,month,requestId};
    if(!agreement||!outlet||agreement.status!=='active'||month<agreement.startMonth||month>agreement.endMonth||
     state.bills.some(bill=>bill.outlet===agreement.outlet&&bill.month===month)){
     run.billingOutcomes.push({...base,status:'skipped',code:'NO_LONGER_MISSING'});checkpoint(candidate);return 'skipped';
    }
    const review=unsupportedPeriod(agreement,outlet,month,historical);
    if(review){
     const registered=db.prepare('INSERT OR IGNORE INTO billing_catchup_reviews(agreement_id,month,outlet,reason,request_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(agreementId,month,outlet.id,review,requestId,now);
     run.billingOutcomes.push({...base,status:'needs_review',code:review,existingReview:registered.changes===0});
     checkpoint(candidate);return 'needs_review';
    }
    const billingGeneration={source:historical?'scheduler_catchup':'scheduler',reason:historical?'missed_calendar_month':'scheduled_calendar_month',
     scheduledOn:month+'-'+String(agreement.billDay).padStart(2,'0'),detectedOn:today,methodVersion:'calendar-billing-recovery-v1',requestId};
    const updated=core.execute(state,'manager',command,payload,{...session,today,now,requestId,billingGeneration});
    store.save(updated.state,{before:state});
    require('./approval-history.cjs').record(store,{before:state,after:updated.state,result:updated.result,command,payload,session,requestId,at:now,source:'scheduler'});
    run.billingOutcomes.push({...base,status:'billed',code:null,billId:updated.result.id,reason:billingGeneration.reason});
    checkpoint(candidate);return 'billed';
   });
   if(status==='billed')billed++;
   if(status==='needs_review')needsReview++;
  }catch(error){
   run.billingOutcomes.splice(previous);
   const expected=[400,403,409].includes(error.status);
   run.billingOutcomes.push({agreementId,month,status:expected?'blocked':'failed',code:error.code||'INTERNAL',requestId,
    detail:expected?core.clean(String(error.message)).slice(0,300):'内部处理失败，请按requestId核查'});
   if(!expected){run.status='failed';run.finishedAt=now;}
   store.transaction(()=>checkpoint(candidate));
   if(!expected){metric('scheduler.lastFailure',Date.parse(now));error.billingRunId=run.id;error.agreementId=agreementId;error.requestId=requestId;throw error;}
   blocked++;
  }
  await new Promise(resolve=>setImmediate(resolve));
 }
 store.transaction(()=>{
  if(run){run.status=blocked||needsReview?'partially_completed':'completed';run.finishedAt=now;writeRun();}
  writePosition(null,true);
 });
 metric('scheduler.lastSuccess',Date.parse(now));
 metric('scheduler.lastBlockedBills',blocked);
 metric('scheduler.lastBillingNeedsReview',needsReview);
 return {...result,billed,blocked,needsReview,billingRunId,billingOutcomes:run?.billingOutcomes||[]};
}
function startScheduler(store,{intervalMs=60000,batchSize=100,catchUpFromMonth=process.env.BILLING_CATCHUP_FROM_MONTH}={}){let running=false,stopped=false;const tick=async()=>{if(running||stopped)return;running=true;try{await runScheduledBatch(store,{batchSize,catchUpFromMonth});}catch(error){store.db.prepare("INSERT INTO runtime_metrics(key,value) VALUES('scheduler.failures',1) ON CONFLICT(key) DO UPDATE SET value=value+1").run();console.error(JSON.stringify({event:'scheduler_failed',code:error.code||'INTERNAL'}));}finally{running=false;}};const timer=setInterval(tick,Math.max(10000,intervalMs));timer.unref();void tick();return {stop:async()=>{stopped=true;clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,20));}};}
module.exports={runScheduledBatch,startScheduler,shanghai};
