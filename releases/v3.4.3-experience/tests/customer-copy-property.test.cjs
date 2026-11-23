const assert = require('node:assert/strict');
const test = require('node:test');

test.before(() => { global.wx = {}; });
test.after(() => { delete global.wx; });

function page(name, query = {}) {
  let instance;
  const module = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[module];
  global.Page = definition => {
    instance = {
      ...definition,
      data: structuredClone(definition.data),
      setData(update) {
        for(const [path,value] of Object.entries(update)){
          const keys=path.split('.');
          const target=keys.slice(0,-1).reduce((part,key)=>part[key] ||= {},this.data);
          target[keys.at(-1)]=value;
        }
      }
    };
  };
  try { require(module); } finally { delete global.Page; }
  instance.onLoad(query);
  return instance;
}

test('private outlet list sends the chosen status while public browsing ignores it', async t => {
  const api = require('../miniprogram/utils/api');
  let actor = 'partnerA';
  let filters;
  t.mock.method(api, 'request', async () => ({actor}));
  t.mock.method(api, 'session', () => ({actor}));
  t.mock.method(api, 'collection', async (name, params) => {
    assert.equal(name, 'outlets');
    filters = params;
    return {items:[],total:0,offset:0,limit:50,hasMore:false};
  });
  const outlets = page('outlets');
  await outlets.filterStatus({currentTarget:{dataset:{status:'paused'}}});
  assert.equal(filters.status, 'paused');
  assert.equal(filters.includeSummary, 'true');
  assert.equal(outlets.data.statusFilters.find(item => item.value === 'paused').label, '暂停营业');
  actor = 'public';
  await outlets.refresh();
  assert.equal(filters.status, 'all');
  assert.equal(filters.scope, 'public');
  assert.equal(filters.includeSummary, undefined);
});

test('outlet details use the scoped settled summary and hide business data from visitors', async t => {
  const api = require('../miniprogram/utils/api');
  const calls = [];
  let actor = 'partnerA';
  t.mock.method(api, 'session', () => ({actor}));
  t.mock.method(api, 'request', async path => {
    if(path === '/api/context')return {actor,today:'2026-11-18'};
    calls.push(path);
    return {settlementMonths:{hasCurrent:true},totals:{revenue:410,orders:12,traffic:35,enroll:null}};
  });
  t.mock.method(api, 'collection', async name => assert.fail('Unexpected collection request: '+name));
  t.mock.method(api, 'detail', async (name, id, filters) => {
    calls.push(name+':'+id+(filters?.scope?':'+filters.scope:''));
    if(name === 'organizations')return {name:'真实加盟商'};
    if(filters?.scope === 'public')return {id,name:'公开网点',status:'paused',address:'公开地址'};
    return {id,name:'授权网点',owner:'p1',status:'paused',address:'经营地址',phone:'13800001111',events:[{status:'paused',date:'2026-11-11'}]};
  });
  const detail = page('outlet', {id:'cs'});
  await detail.refresh();
  assert.equal(detail.data.outlet.name, '授权网点');
  assert.equal(detail.data.organizationName, '真实加盟商');
  assert.equal(detail.data.summary.revenueText, '410.00 元');
  assert.equal(detail.data.summary.enrollText, '暂无数据');
  assert.equal(detail.data.outlet.statusText, '暂停营业');
  assert.equal(detail.data.outlet.statusSince, '2026年11月11日');
  assert.match(calls.find(path => path.startsWith('/api/dashboard?')), /period=2026-11.*mode=settled.*outlet=cs/);
  actor = 'public';
  calls.length = 0;
  await detail.refresh();
  assert.equal(detail.data.outlet.name, '公开网点');
  assert.equal(detail.data.outlet.address, '公开地址');
  assert.equal(detail.data.outlet.phone, '');
  assert.equal(detail.data.summary, null);
  assert.equal(detail.data.organizationName, '');
  assert.deepEqual(calls, ['outlets:cs:public']);
});

test('request form shows the intended change with the existing accountChange contract', () => {
  const requests = page('requests', {type:'accountChange', change:'mobile'});
  assert.equal(requests.data.types[requests.data.typeIndex].name, '变更登记手机号');
  assert.equal(requests.data.type, 'accountChange');
});

test('a revised outlet status keeps the original application being supplemented', async () => {
  const requests = page('requests', {type:'statusChange'});
  requests.setData({supplementId:'req-original'});
  const resume = requests.data.types.findIndex(item => item.status === 'open');
  await requests.chooseType({detail:{value:resume}});
  assert.equal(requests.data.supplementId, 'req-original');
  assert.equal(requests.data.form.status, 'open');
});

test('location page shows only a configured GPS distance and distinguishes exception from pending', async t => {
  const api = require('../miniprogram/utils/api');
  t.mock.method(api, 'request', async () => ({actor:'partnerA', today:'2026-11-18'}));
  t.mock.method(api, 'session', () => ({actor:'partnerA'}));
  t.mock.method(api, 'collection', async name => {
    const items = ({outlets:[{id:'cs',name:'授权网点',owner:'p1',status:'open'}],verifications:[
      {id:'loc-1',outlet:'cs',status:'pending',month:'2026-11',coords:{source:'gps',accuracy:3},assessment:{result:'unconfigured',distanceMeters:5,thresholdMeters:null}},
      {id:'loc-2',outlet:'cs',status:'exception',month:'2026-10',coords:{source:'gps',accuracy:8},assessment:{result:'outside_threshold',distanceMeters:123.4,thresholdMeters:100}},
      {id:'loc-3',outlet:'cs',status:'pending',month:'2026-09',coords:{source:'manual'},assessment:{result:'manual',distanceMeters:4,thresholdMeters:100}}
    ]})[name] || [];
    return {items,total:items.length,offset:0,limit:50,hasMore:false};
  });
  const location = page('location', {outlet:'cs'});
  await location.refresh();
  assert.deepEqual(location.data.history.map(row => [row.statusText, row.distanceText]), [
    ['已提交，等待总部核验', ''],
    ['位置待核实，请补充说明', '与登记位置相差约123米'],
    ['已提交，等待总部核验', '']
  ]);
});

test('customer task cards show business dates and avoid internal queue descriptions', async t => {
  const api = require('../miniprogram/utils/api');
  t.mock.method(api, 'request', async () => ({actor:'partnerA'}));
  t.mock.method(api, 'session', () => ({actor:'partnerA'}));
  t.mock.method(api, 'collection', async () => ({total:2,limit:50,offset:0,hasMore:false,items:[
    {id:'1',kind:'report_missing',status:'open',outlet:'cs',outletName:'授权网点',month:'2026-10',dueAt:'2026-11-05',description:'内部队列',createdAt:'2026-11-01T00:00:00Z'},
    {id:'2',kind:'request_supplement',status:'resolved',outlet:null,dueAt:'2026-02-31'}
  ]}));
  const tasks = page('tasks');
  await tasks.refresh();
  const [report, request] = tasks.data.taskRows;
  assert.equal(report.title, '请填写2026年10月经营月报');
  assert.equal(report.dueText, '2026年11月05日');
  assert.equal(request.title, '请补充新增网点申请材料');
  assert.equal(request.dueText, '');
  assert.equal(request.statusText, '已完成');
});
