'use strict';

const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {writeFileSync}=require('node:fs');
const path=require('node:path');
const {createServer}=require('../server/index.cjs');

async function main(){
  const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+app.server.address().port;
  async function get(route,token,status=200){
    const response=await fetch(origin+route,{headers:{Authorization:'Bearer '+token}});
    const body=await response.json();
    assert.equal(response.status,status,JSON.stringify(body));
    return body.data;
  }
  async function post(route,data,token){
    const headers={'Content-Type':'application/json'};
    if(token)Object.assign(headers,{Authorization:'Bearer '+token,'Idempotency-Key':randomUUID()});
    const response=await fetch(origin+route,{method:'POST',headers,body:JSON.stringify(data)});
    const body=await response.json();
    assert.equal(response.status,200,JSON.stringify(body));
    return body.data;
  }
  try{
    const signIn=async actor=>(await post('/api/auth/dev',{actor})).token;
    const [manager,partner,ops]=await Promise.all(['manager','partnerA','ops'].map(signIn));
    const {result}=await post('/api/commands',{command:'report.submit',payload:{outlet:'cs',month:'2026-10',revenue:'220.25',orders:12,traffic:24,enroll:3,note:'合成容量验证'}},partner);
    const candidate=app.store.db.prepare("SELECT data FROM businessTasks WHERE json_extract(data,'$.recordId')=? AND status='open'").get(result.id);
    assert.ok(candidate,'Expected one persisted task after report submission');
    const template=JSON.parse(candidate.data);
    assert.equal(template.queue,'ops');
    const filter='/api/tasks?queue=ops&month=2026-10';
    const before=await get(filter+'&limit=1',manager);
    const fixtures=3600;
    const seedOutlet=JSON.parse(app.store.db.prepare("SELECT data FROM outlets WHERE id='cs'").get().data);
    const insertOutlet=app.store.db.prepare('INSERT INTO outlets(id,owner,status,data,created_at) VALUES(?,?,?,?,?)');
    const insertReport=app.store.db.prepare('INSERT INTO reports(id,owner,outlet,status,month,version,data,created_at) VALUES(?,?,?,?,?,?,?,?)');
    const insertTask=app.store.db.prepare('INSERT INTO businessTasks(id,owner,outlet,status,month,data,created_at) VALUES(?,?,?,?,?,?,?)');
    app.store.transaction(()=>{
      for(let i=0;i<fixtures;i++){
        const outlet='outlet-capacity-'+i,month='2026-10',recordId='rpt-capacity-'+i;
        const outletData={...seedOutlet,id:outlet,name:'合成网点 '+i};
        const reportData={...result,id:recordId,outlet,month};
        insertOutlet.run(outlet,template.owner,outletData.status,JSON.stringify(outletData),template.createdAt);
        insertReport.run(recordId,template.owner,outlet,reportData.status,month,1,JSON.stringify(reportData),template.createdAt);
        for(const status of ['open','resolved']){
          const taskId='task-capacity-'+i+'-'+status,eventId='capacity|'+recordId+'|'+status;
          const task={...template,id:taskId,taskId,recordId,businessId:recordId,outlet,outletId:outlet,month,reportMonth:month,status,responsibilityKey:'capacity|'+recordId,taskKey:eventId,idempotencyKey:eventId,eventId};
          insertTask.run(task.id,template.owner,outlet,status,month,JSON.stringify(task),template.createdAt);
        }
      }
    });
    const expected=before.total+fixtures;
    const page=await get(filter+'&limit=25',manager);
    assert.equal(page.total,expected);
    assert.equal(page.items.length,25);
    const exact=await get(filter+'&outlet=cs&limit=25',manager);
    assert.ok(exact.items.some(item=>item.recordId===result.id));
    assert.ok(exact.items.every(item=>item.outlet==='cs'));
    const initial=await get('/api/tasks/overview',manager);
    const globalOps=initial.items.find(item=>item.queue==='ops').total;
    const globalPage=await get('/api/tasks?queue=ops&limit=1',manager);
    assert.equal(globalOps,globalPage.total);
    await get('/api/tasks?queue=finance',ops,403);
    const samples=[],count=120,concurrency=8;
    let next=0;
    const begin=performance.now();
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(next<count){
        const i=next++,start=performance.now();
        if(i%2===0){
          const data=await get('/api/tasks/overview',manager);
          assert.equal(data.items.find(item=>item.queue==='ops').total,globalOps);
          assert.equal(data.items.length,4);
        }else{
          const data=await get(filter+'&limit=25&offset='+i,ops);
          assert.equal(data.total,expected);
          assert.equal(data.items.length,25);
          assert.ok(data.items.every(item=>item.month==='2026-10'&&item.status==='open'&&item.canViewBusiness));
        }
        samples.push(performance.now()-start);
      }
    }));
    samples.sort((a,b)=>a-b);
    const report={status:'passed',scope:'合成任务、SQLite 内存库、127.0.0.1 HTTP，不用于生产容量承诺',syntheticCurrentTasks:fixtures,syntheticHistoricalTasks:fixtures,requests:count,concurrency,failed:0,durationMs:Math.round(performance.now()-begin),latencyMs:{p50:Math.round(samples[Math.floor(count*.50)]),p95:Math.round(samples[Math.floor(count*.95)]),max:Math.round(samples.at(-1))},node:process.version};
    const raw=JSON.stringify(report,null,2)+'\n';
    writeFileSync(path.join(__dirname,'../execution/v32-load.json'),raw);
    console.log(raw);
  }finally{
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.close();
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
