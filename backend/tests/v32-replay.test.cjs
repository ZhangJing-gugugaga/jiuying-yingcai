'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {createServer}=require('../server/index.cjs');

test('regional review replay requires the latest review grant even while report reads remain permitted',async()=>{
  const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  async function post(route,payload,token,key=randomUUID()){
    const headers={'Content-Type':'application/json','Idempotency-Key':key};
    if(token)headers.Authorization='Bearer '+token;
    const response=await fetch(base+route,{method:'POST',headers,body:JSON.stringify(payload)});
    return {status:response.status,...await response.json()};
  }
  async function signIn(actor){
    const output=await post('/api/auth/dev',{actor});
    assert.equal(output.status,200);
    return output.data.token;
  }
  function execute(token,command,payload,key){
    return post('/api/commands',{command,payload},token,key);
  }
  try{
    const [manager,regional,partner]=await Promise.all(['manager','regional','partnerA'].map(signIn));
    const scope={outlets:['cs'],metrics:[],reviewOutlets:['cs']};
    assert.equal((await execute(manager,'grant.set',scope)).status,200);
    const created=await execute(partner,'report.submit',{outlet:'cs',month:'2026-10',revenue:105.15,orders:10,traffic:20,enroll:2,note:'授权回归'});
    assert.equal(created.status,200,JSON.stringify(created));
    const queue=await fetch(base+'/api/tasks?queue=ops&outlet=cs',{headers:{Authorization:'Bearer '+regional}});
    assert.equal(queue.status,200);
    const task=(await queue.json()).data.items.find(x=>x.recordId===created.data.result.id);
    assert.ok(task);
    assert.equal(task.revenue,undefined);
    assert.equal(task.orders,undefined);

    const review={id:created.data.result.id,decision:'approve',note:'区域审核记录'};
    const requestKey=randomUUID();
    assert.equal((await execute(regional,'review.report',review,requestKey)).status,200);
    assert.equal((await execute(regional,'review.report',review,requestKey)).data.replayed,true);
    assert.equal((await execute(manager,'grant.set',{...scope,reviewOutlets:[]})).status,200);
    const detail=await fetch(base+'/api/collections/reports/'+review.id,{headers:{Authorization:'Bearer '+regional}});
    assert.equal(detail.status,200);
    assert.equal((await execute(regional,'review.report',review,requestKey)).status,403);
  }finally{
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.close();
  }
});
