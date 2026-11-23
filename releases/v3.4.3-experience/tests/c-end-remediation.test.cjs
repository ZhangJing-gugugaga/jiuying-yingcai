const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const config = require('../miniprogram/config');
const tap = dataset => ({currentTarget:{dataset}});
const result = (items, {offset=0, hasMore=false}={}) => ({items, offset, limit:50, hasMore, total:items.length});

function nativePage(name, query={}) {
  let page;
  const entry = require.resolve('../miniprogram/pages/'+name+'/index');
  delete require.cache[entry];
  global.Page = definition => {
    page = {...definition, data:structuredClone(definition.data), setData(update, callback) {
      for(const [path, value] of Object.entries(update)) {
        const keys = path.split('.');
        const target = keys.slice(0,-1).reduce((obj, key) => obj[key] ||= {}, this.data);
        target[keys.at(-1)] = value;
      }
      callback?.();
    }};
  };
  try { require(entry); } finally { delete global.Page; }
  page.onLoad(query);
  return page;
}

function wxHarness(t, actor, respond) {
  const storage = new Map([['jyyc.session', {actor, role:actor==='public'?'public':'partner', token:'local-fixture'}]]);
  const requests = [], navigation = [];
  const originalBase = config.apiBase;
  config.apiBase = 'https://example.test';
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    setNavigationBarTitle() {},
    pageScrollTo() {},
    navigateTo: ({url}) => navigation.push(url),
    switchTab: ({url}) => navigation.push(url),
    request(options) {
      const url = new URL(options.url);
      requests.push(url);
      if(url.pathname==='/api/context')return options.success({statusCode:200, data:{data:{actor, today:'2026-11-18'}}});
      const data = respond(url);
      if(data===undefined)return options.success({statusCode:404, data:{error:{code:'NOT_FOUND'}}});
      options.success({statusCode:200, data:{data}});
    }
  };
  t.after(() => {config.apiBase=originalBase; delete global.wx; delete global.getCurrentPages;});
  return {requests, navigation, storage};
}

test('signed-in public directory uses the same public scope for search, pagination and detail', async t => {
  const published = {id:'shared', name:'公开名称', address:'公开地址', status:'open', publicLocation:{latitude:28.2,longitude:113.1}};
  const {requests,navigation,storage} = wxHarness(t,'partnerA',url => {
    if(url.searchParams.get('scope')!=='public')return result([{id:'private',owner:'p1',coords:{lat:31,lng:120}}]);
    if(url.pathname.endsWith('/shared'))return published;
    return url.searchParams.get('offset')==='50' ? result([{id:'second', name:'另一网点', status:'paused'}],{offset:50}) : result([published],{hasMore:true});
  });
  const view = fs.readFileSync(require.resolve('../miniprogram/pages/discover/index.wxml'),'utf8');
  const query = view.match(/data-page="outlets"(?: data-query="([^"]+)")? bindtap="nav">查找服务网点/);
  assert.ok(query);
  nativePage('discover',{section:'outlets'}).nav(tap({page:'outlets',query:query[1]}));
  assert.deepEqual(storage.get('jyyc.route.outlets'), {scope:'public'});
  const directory = nativePage('outlets');
  global.getCurrentPages = () => [{route:'pages/outlets/index'}];
  await directory.onShow();
  await directory.search({detail:{value:'公开'}});
  await directory.more(tap({collection:'outlets'}));
  assert.deepEqual(directory.data.rows.map(row=>row.id), ['shared','second']);
  assert.equal(directory.data.markers[0].latitude, 28.2);
  const collections = requests.filter(url=>url.pathname.endsWith('/outlets'));
  assert.equal(collections.length,3);
  assert.ok(collections.every(url=>url.searchParams.get('scope')==='public'&&!url.searchParams.has('includeSummary')));
  assert.equal(collections.at(-1).searchParams.get('q'),'公开');
  assert.equal(collections.at(-1).searchParams.get('offset'),'50');
  directory.marker({detail:{markerId:directory.data.markers[0].id}});
  const target = new URL(navigation.at(-1),'https://example.test');
  assert.equal(target.pathname,'/pages/outlet/index');
  assert.equal(target.searchParams.get('scope'),'public');
  const detail = nativePage('outlet',Object.fromEntries(target.searchParams));
  await detail.refresh();
  assert.equal(detail.data.outlet.address,'公开地址');
  assert.equal(detail.data.internal,false);
  assert.equal(requests.at(-1).searchParams.get('scope'),'public');
  assert.ok(!requests.some(url=>/dashboard|organizations|publicProfiles/.test(url.pathname)));
});

test('private outlet cards display authoritative month, review, settlement and missing status', async t => {
  const outlet = {id:'own',name:'自己的网点',owner:'p1',status:'open',summary:{period:'2026-11',
    report:{month:'2026-10',status:'finance',settlementStatus:'unsettled'},
    location:{month:'2026-11',status:'missing'},fee:{month:'2026-11',status:'missing'}}};
  const exempt = {id:'another',name:'另一网点',owner:'p1',status:'open',summary:{period:'2026-11',
    report:{month:'2026-10',status:'exempt',settlementStatus:'not_applicable'},
    location:{month:'2026-11',status:'not_required'},fee:{month:'2026-11',status:'settled_zero'}}};
  const {requests} = wxHarness(t,'partnerA',() => result([outlet,exempt,{id:'legacy',owner:'p1',status:'open'}]));
  const page = nativePage('outlets');
  await page.refresh();
  assert.equal(requests.at(-1).searchParams.get('includeSummary'),'true');
  assert.equal(requests.at(-1).searchParams.get('scope'),null);
  const [current, notRequired, legacy] = page.data.rows;
  assert.deepEqual(current.summaryRows.map(row=>[row.monthText,row.statusText]), [
    ['2026年10月','财务复核中 · 尚未结算'],['2026年11月','待提交位置资料'],['2026年11月','暂无账单']
  ]);
  assert.deepEqual(notRequired.summaryRows.map(row=>row.statusText), ['已免报','本月无需核验','已结清']);
  assert.equal(legacy.summaryRows.length,0);
});

test('public outlet markers never use private GPS or retain it when switching to the directory', async t => {
  const {requests} = wxHarness(t,'partnerA',url => result(url.searchParams.get('scope')==='public'?[{
    id:'public',name:'服务网点',address:'公开地址',status:'open',coords:{lat:31,lng:120},owner:'unexpected',summary:{fee:{status:'unpaid'}}
  }]:[{id:'private',name:'我的网点',owner:'p1',status:'open',coords:{lat:31,lng:120}}]));
  const page = nativePage('outlets');
  await page.refresh();
  assert.equal(page.data.markers[0].latitude,31);
  await page.changeScope(tap({scope:'public'}));
  assert.deepEqual(page.data.markers,[]);
  assert.deepEqual(page.data.rows.map(row=>row.id),['public']);
  assert.equal(page.data.rows[0].owner,undefined);
  assert.equal(page.data.rows[0].coords,undefined);
  assert.equal(page.data.rows[0].summary,undefined);
  await page.changeScope(tap({scope:'private'}));
  assert.equal(page.data.markers[0].outletId,'private');
  assert.deepEqual(requests.filter(url=>url.pathname.endsWith('/outlets')).map(url=>url.searchParams.get('scope')),[null,'public',null]);
});

test('unpublished public detail does not fall back to an authorized private record', async t => {
  const {requests} = wxHarness(t,'partnerA',url => url.searchParams.get('scope')==='public'?undefined:{name:'内部网点',owner:'p1'});
  const page = nativePage('outlet',{scope:'public',id:'withheld'});
  await page.refresh();
  assert.ok(page.data.error);
  assert.equal(page.data.outlet,null);
  assert.equal(page.data.internal,false);
  assert.equal(requests.length,2);
  assert.equal(requests.at(-1).searchParams.get('scope'),'public');
});

test('location history labels GPS, map selection and unclassified timestamps from their actual source', async t => {
  const capturedAt = '2026-11-17T01:00:00Z';
  wxHarness(t,'partnerA',url => url.pathname.endsWith('/outlets')?result([{id:'own',name:'我的网点',owner:'p1',status:'open'}]):result([
    {id:'gps',outlet:'own',month:'2026-11',status:'pending',coords:{source:'gps',accuracy:0},capturedAt},
    {id:'manual',outlet:'own',month:'2026-10',status:'pending',coords:{source:'manual',accuracy:4},capturedAt},
    {id:'legacy',outlet:'own',month:'2026-09',status:'pending',coords:{source:'simulated',accuracy:5},capturedAt}
  ]));
  const page = nativePage('location',{outlet:'own'});
  await page.refresh();
  assert.deepEqual(page.data.history.map(({positionText,captureTimeLabel,accuracyText})=>[positionText,captureTimeLabel,accuracyText]),[
    ['现场定位','定位时间','0 米'],['地图选点','选点时间',''],['','采集时间','']
  ]);
  assert.match(fs.readFileSync(require.resolve('../miniprogram/pages/location/index.wxml'),'utf8'),/item\.captureTimeLabel/);
});

test('the latest location action wins when an older native GPS result arrives afterwards', async t => {
  wxHarness(t,'partnerA',url => result(url.pathname.endsWith('/outlets')?[{id:'own',owner:'p1'}]:[]));
  let gps;
  global.wx.getLocation = options => {gps=options;};
  global.wx.chooseLocation = options => options.success({latitude:28,longitude:113,address:'地图地址'});
  const page = nativePage('location',{outlet:'own'});
  await page.refresh();
  const first = page.locate(tap({manual:'false'}));
  await page.locate(tap({manual:'true'}));
  gps.success({latitude:35,longitude:120,accuracy:2});
  await first;
  assert.equal(page.data.coords.source,'manual');
  assert.equal(page.data.accuracy,'');
  assert.equal(page.data.form.address,'地图地址');
  assert.equal(page.data.markers[0].title,'地图选点');
  assert.ok(page.data.markers[0].width>0 && page.data.markers[0].height>0,'native map requires nonzero marker dimensions');
});

test('refund application and ledger distinguish approval, channel processing and voucher sources', async t => {
  const rows = [
    {id:'refund-approved',status:'approved'},
    {id:'refund-pending',status:'approved',channelRefundStatus:'pending'},
    {id:'refund-channel',status:'recorded',refundRecordSource:'channel',reference:'channel-voucher'},
    {id:'refund-manual',status:'recorded',refundRecordSource:'manual',reference:'manual-voucher'},
    {id:'refund-legacy',status:'recorded',reference:'legacy-voucher'}
  ];
  const expected = [
    ['退款申请已通过','',''],['退款办理中','',''],['已退款','支付渠道已确认退款。','渠道退款凭证号'],
    ['已退款','总部财务已登记外部退款凭证。','外部退款凭证号'],['已退款','','退款凭证号']
  ];
  wxHarness(t,'partnerA',url => {
    if(url.pathname.endsWith('/finance/summary'))return {totals:{},outlets:result([])};
    if(url.pathname.endsWith('/finance/bills/bill-1'))return {
      bill:{id:'bill-1',ledger:{}},lineage:result([]),corrections:result([]),credits:result([]),receipts:result([]),
      payments:result([]),refundRequests:result(rows),invoiceRequests:result([])
    };
    return result(url.pathname.endsWith('/refundRequests')?rows:[]);
  });
  const page = nativePage('finance',{id:'refund-channel',ledgerBillId:'bill-1',section:'refundRequests'});
  await page.refresh();
  const applications = page.data.applicationGroups.find(group=>group.type==='refund').rows;
  assert.deepEqual(applications.map(row=>[row.statusText,row.refundNote,row.referenceLabel]),expected);
  assert.deepEqual(page.data.ledgerBill.records.map(row=>[row.status,row.refundNote,row.referenceLabel]),expected);
  assert.equal(page.data.selectedApplication.referenceLabel,'渠道退款凭证号');
});
