'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../server/index.cjs');
const api=require('../../miniprogram/utils/api');
const config=require('../../miniprogram/config');

function screen(name,query={}){
  let definition;
  global.Page=value=>{definition=value;};
  const modulePath=require.resolve('../../miniprogram/pages/'+name+'/index');
  delete require.cache[modulePath];
  require(modulePath);
  const page={...definition,data:structuredClone(definition.data),route:'pages/'+name+'/index',
    setData(patch,callback){
      for(const [path,value] of Object.entries(patch)){
        const fields=path.split('.');
        const parent=fields.slice(0,-1).reduce((data,key)=>data[key]||={},this.data);
        parent[fields.at(-1)]=value;
      }
      callback?.();
    }
  };
  page.onLoad(query);
  return page;
}
const tap=id=>({currentTarget:{dataset:{id}}});

async function isolated(run){
  const app=createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const previous=config.apiBase;
  config.apiBase='http://127.0.0.1:'+app.server.address().port;
  const storage=new Map(),reads=[];
  global.wx={
    getStorageSync:key=>storage.get(key),
    setStorageSync:(key,value)=>storage.set(key,value),
    removeStorageSync:key=>storage.delete(key),
    showToast(){},pageScrollTo(){},
    async request(options){
      try{
        reads.push(new URL(options.url));
        const response=await fetch(options.url,{method:options.method,headers:options.header,
          ...(options.method==='GET'?{}:{body:JSON.stringify(options.data)})});
        options.success({statusCode:response.status,data:await response.json()});
      }catch(error){options.fail(error);}
    }
  };
  try{
    await api.login('partnerA');
    await run(app,reads);
  }finally{
    config.apiBase=previous;
    delete global.wx;
    delete global.Page;
    app.server.closeAllConnections();
    await new Promise(resolve=>app.server.close(resolve));
    app.store.close();
  }
}

test('opening a specific application retrieves its own approval timeline automatically',()=>isolated(async(app,reads)=>{
  const month=app.store.load().today;
  const {result}=await api.command('request.submit',{type:'statusChange',outlet:'zz',data:{status:'paused',effectiveDate:month,reason:'房屋修缮'}});
  const page=screen('requests',{id:result.id,outlet:'zz',type:'statusChange'});
  await page.onShow();
  assert.equal(page.data.historyId,result.id);
  assert.ok(page.data.historyRows.some(row=>row.label==='已提交申请'));
  assert.ok(reads.some(url=>url.pathname==='/api/approval-history/requests/'+result.id));
}));

test('location reads an approved month beyond its outlet history page',()=>isolated(async(app,reads)=>{
  const state=app.store.load();
  const outlet=state.outlets.find(row=>row.id==='zz');
  for(let index=0;index<51;index++){
    const month=new Date(Date.UTC(2022,index,1)).toISOString().slice(0,7);
    state.verifications.push({id:'loc-pagination-'+index,outlet:outlet.id,owner:outlet.owner,month,status:'approved',address:outlet.address});
  }
  app.store.save(state);
  const page=screen('location',{outlet:'zz',month:'2022-01'});
  await page.onShow();
  assert.equal(page.data.pagers.verifications.hasMore,true);
  assert.equal(page.data.state.verifications.some(row=>row.id==='loc-pagination-0'),false);
  assert.equal(page.data.history[0].id,'loc-pagination-0');
  assert.deepEqual(page.data.monthHistory.map(row=>row.id),['loc-pagination-0']);
  assert.equal(page.data.canSubmitEvidence,false);
  assert.match(page.data.monthStatus,/核验已通过/);
  assert.ok(reads.some(url=>url.pathname==='/api/collections/verifications'
    && url.searchParams.get('outlet')==='zz' && url.searchParams.get('month')==='2022-01'
    && url.searchParams.get('limit')==='1'));
  await page.chooseMonth({detail:{value:'2024-10'}});
  assert.ok(reads.some(url=>url.pathname==='/api/collections/verifications' && url.searchParams.get('month')==='2024-10'));
  assert.deepEqual(page.data.monthHistory.map(row=>row.id),['loc-pagination-33']);
}));

test('exiting a ticket detail keeps the selected list filter and allows reopening the same ticket',()=>isolated(async()=>{
  const {result}=await api.command('support.ticket',{outlet:'zz',category:'aftersale',title:'业务记录查找',description:'请协助查询记录'});
  const page=screen('support');
  await page.onShow();
  await page.tab({currentTarget:{dataset:{tab:'ticket'}}});
  await page.filterStatus({currentTarget:{dataset:{status:'queued'}}});
  await page.open(tap(result.id));
  assert.equal(page.data.ticket.id,result.id);
  assert.equal(typeof page.backToTicketList,'function');
  await page.backToTicketList();
  assert.equal(page.data.ticket,null);
  assert.equal(page.data.statusFilter,'queued');
  await page.open(tap(result.id));
  assert.equal(page.data.ticket.id,result.id);
}));
