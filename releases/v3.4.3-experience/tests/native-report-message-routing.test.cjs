'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {createServer}=require('../server/index.cjs');
const config=require('../miniprogram/config');
const {openRecord}=require('../miniprogram/utils/page');
const api=require('../miniprogram/utils/api');

test('revocation notices link to the scoped report version, including notices written before the update',async()=>{
  const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const previous=config.apiBase;
  config.apiBase='http://127.0.0.1:'+app.server.address().port;
  const storage=new Map(),navigations=[];
  global.wx={
    getStorageSync:key=>storage.get(key),
    setStorageSync:(key,value)=>storage.set(key,value),
    removeStorageSync:key=>storage.delete(key),
    navigateTo:({url,success})=>{navigations.push(url);success?.();},
    switchTab:({url})=>navigations.push(url),
    request:async options=>{
      try{
        const response=await fetch(options.url,{method:options.method,headers:options.header,...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
        options.success({statusCode:response.status,data:await response.json()});
      }catch(error){options.fail(error);}
    }
  };
  try{
    await api.login('partnerA');
    const report=(await api.command('report.submit',{outlet:'cs',month:'2026-10',revenue:'106.59',orders:2,traffic:8,enroll:1,note:'隔离测试'})).result;
    await api.login('ops');
    await api.command('review.report',{id:report.id,decision:'approve'});
    await api.login('manager');
    const request=(await api.command('report.revoke.request',{id:report.id,reason:'模拟更正'})).result;
    await api.login('finance');
    await api.command('review.revoke',{id:request.id,decision:'approve'});
    await api.login('partnerA');
    const messages=(await api.collection('messages',{limit:20})).items.filter(x=>x.recordId===request.id);
    assert.equal(messages.length,2);
    const link='/pages/report/index?outlet=cs&month=2026-10&id='+report.id;
    for(const message of messages){
      await openRecord(message);
      await openRecord({target:'reports',recordId:message.recordId,outlet:message.outlet});
    }
    assert.deepEqual(navigations,[link,link,link,link]);
    assert.ok(messages.every(message=>message.reportId===report.id&&message.month==='2026-10'));
    const stored=await api.detail('reports',report.id);
    assert.equal(stored.revoked,true);
    assert.equal(stored.current,false);
    await api.login('partnerB');
    await assert.rejects(()=>openRecord(messages[0]),error=>error.status===404||error.status===403);
    await assert.rejects(()=>openRecord({target:'reports',recordId:request.id}),error=>error.status===404||error.status===403);
    assert.equal(navigations.length,4);
  }finally{
    config.apiBase=previous;
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.close();
  }
});
