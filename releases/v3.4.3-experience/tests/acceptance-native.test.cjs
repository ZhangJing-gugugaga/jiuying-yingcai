const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');
const { go } = require('../miniprogram/utils/page');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=';
const native = path.resolve(__dirname, '../miniprogram');
const change = value => ({ detail: { value } });
const tap = dataset => ({ currentTarget: { dataset } });

function page(name, query = {}) {
  let definition;
  global.Page = value => { definition = value; };
  const file = path.join(native, 'pages', name, 'index.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const instance = {
    ...definition,
    data: structuredClone(definition.data),
    route: 'pages/' + name + '/index',
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts.at(-1)] = value;
      }
    }
  };
  global.getCurrentPages = () => [instance];
  instance.onLoad(query);
  return instance;
}

async function nativeRun(fn) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previousBase = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map();
  const calls = [];
  const wx = global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    stopPullDownRefresh() {},
    pageScrollTo() {},
    showToast() {},
    showModal(o) { o.success({confirm:true}); },
    reLaunch(options) { calls.push({ reLaunch: options.url }); },
    switchTab(options) { calls.push({ switchTab: options.url }); },
    navigateTo(options) { calls.push({ navigateTo: options.url }); },
    getLocation(options) { options.success({ latitude: 28.2, longitude: 113.1, accuracy: 12 }); },
    chooseLocation(options) { options.success({ latitude: 28.3, longitude: 113.2, address: '手选地址' }); },
    chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: '/photo.png', size: 105 }] }); },
    getFileSystemManager() { return { readFile: options => options.success({ data: png }) }; },
    async request(options) {
      let result;
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        result = { statusCode: response.status, data: await response.json() };
      } catch (error) {
        options.fail(error);
        return;
      }
      calls.push({ url: options.url, method: options.method, status: result.statusCode });
      options.success(result);
    },
  };
  try {
    await api.login('partnerA');
    await fn({ app, wx, calls });
  } finally {
    config.apiBase = previousBase;
    delete global.getCurrentPages;
    delete global.wx;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

function seedPagedOutlets(app) {
  const state = app.store.load();
  const outlet = state.outlets.find(item => item.id === 'cs');
  for (let index = 0; index < 52; index++) {
    const id = 'audit-outlet-' + index;
    state.outlets.push({ ...structuredClone(outlet), id, outlet: id, name: '验收网点 ' + index });
  }
  app.store.save(state);
}

test('report keeps a second-page outlet through refresh and switching back', () => nativeRun(async ({ app }) => {
  seedPagedOutlets(app);
  const report = page('report', { outlet: 'cs', month: '2026-10' });
  await report.onShow();
  assert.equal(report.data.outletId, 'cs');
  assert.equal(report.data.pagers.outlets.loaded, 50);
  await report.more(tap({ collection: 'outlets' }));
  assert.equal(report.data.pagers.outlets.loaded, 55);
  assert.equal(report.data.outlets.length, 55);
  await report.chooseOutlet(change(report.data.outlets.findIndex(outlet => outlet.id === 'zz')));
  assert.equal(report.data.outletId, 'zz');
  assert.equal(report.data.outlets[report.data.outletIndex].id, 'zz');
  await report.onPullDownRefresh();
  assert.equal(report.data.outletId, 'zz');
  assert.equal(report.data.applicable, false);
  await report.outletSearch(change('长沙示范网点A'));
  await report.chooseOutlet(change(report.data.outlets.findIndex(outlet => outlet.id === 'cs')));
  assert.equal(report.data.outletId, 'cs');
  assert.equal(report.data.applicable, true);
}));

test('report search can be cleared when no authorized outlet matches', () => nativeRun(async () => {
  const report = page('report', { month: '2026-10' });
  report.setData({ outletSearch: '验收不存在' });
  await report.onShow();
  assert.equal(report.data.outlets.length, 0);
  const markup = fs.readFileSync(path.join(native, 'pages/report/index.wxml'), 'utf8');
  assert.ok(markup.indexOf('bindconfirm="outletSearch"') < markup.indexOf('<block wx:if="{{outlets.length}}">'));
  await report.outletSearch(change(''));
  assert.ok(report.data.outlets.length > 0);
}));

test('dashboard keeps a second-page outlet selected through search', () => nativeRun(async ({ app }) => {
  seedPagedOutlets(app);
  const dashboard = page('dashboard', { period: '2026-10' });
  await dashboard.onShow();
  await dashboard.more(tap({ collection: 'outlets' }));
  await dashboard.outlet(change(dashboard.data.outlets.findIndex(outlet => outlet.id === 'zz')));
  assert.equal(dashboard.params().outlet, 'zz');
  await dashboard.outletSearch(change('验收不存在'));
  assert.equal(dashboard.params().outlet, 'zz');
  assert.equal(dashboard.data.pagers.outlets.total, 0);
  assert.equal(dashboard.data.outlets[dashboard.data.outletIndex].id, 'zz');
}));

test('location persists capture time, scopes history by outlet and recovers from denied capture and photos', () => nativeRun(async ({ app, wx, calls }) => {
  const location = page('location', { outlet: 'zz', month: '2026-11' });
  const getLocation = wx.getLocation;
  const filesystem = wx.getFileSystemManager;
  await location.onShow();
  assert.equal(calls.some(call => call.url?.includes('/api/files')), false);
  wx.getLocation = options => options.fail({ errMsg: 'getLocation:fail auth deny' });
  await location.locate(tap({ manual: 'false' }));
  assert.match(location.data.error, /权限/);
  assert.equal(location.data.coords, null);
  await location.locate(tap({ manual: 'true' }));
  assert.equal(location.data.coords.source, 'manual');
  assert.equal(location.data.coords.accuracy, null);
  wx.getLocation = options => options.success({ latitude: 120, longitude: 113.1, accuracy: -2 });
  await location.locate(tap({ manual: 'false' }));
  assert.match(location.data.error, /坐标|精度/);
  wx.getLocation = getLocation;
  await location.locate(tap({ manual: 'false' }));
  const capturedAt = location.data.coords.capturedAt;
  wx.getFileSystemManager = () => ({ readFile: options => options.fail({ errMsg: 'readFile:fail' }) });
  await location.photo();
  assert.match(location.data.error, /读取失败/);
  assert.equal(location.data.photo, null);
  await location.submit();
  assert.equal(app.store.load().verifications.length, 0);
  wx.getFileSystemManager = filesystem;
  await location.photo();
  await location.submit();
  assert.equal(location.data.error, '');
  const persisted = app.store.load().verifications[0];
  assert.equal(persisted.outlet, 'zz');
  assert.equal(persisted.capturedAt, capturedAt);
  assert.equal(persisted.coords.coordinateSystem, 'GCJ-02');
  assert.equal(persisted.coords.accuracy, 12);
  assert.equal(location.data.history[0].id, persisted.id);
  await location.chooseOutlet(change(location.data.outlets.findIndex(outlet => outlet.id === 'cs')));
  assert.equal(location.data.history.length, 0);
  assert.equal(location.data.coords, null);
  assert.equal(location.data.photo, null);
  assert.deepEqual(location.data.markers, []);
}));

test('location discards delayed capture from a different outlet or period', () => nativeRun(async ({ wx }) => {
  const location = page('location', { outlet: 'zz', month: '2026-10' });
  await location.onShow();
  let gps;
  wx.getLocation = options => { gps = options; };
  const capture = location.locate(tap({ manual: 'false' }));
  await location.chooseOutlet(change(location.data.outlets.findIndex(outlet => outlet.id === 'cs')));
  gps.success({ latitude: 28.2, longitude: 113.1, accuracy: 12 });
  await capture;
  assert.equal(location.data.coords, null);
  let camera;
  wx.chooseMedia = options => { camera = options; };
  const photoUpload = location.photo();
  location.chooseMonth(change('2026-11'));
  camera.success({ tempFiles: [{ tempFilePath: '/photo.png', size: 105 }] });
  await photoUpload;
  assert.equal(location.data.photo, null);
}));

test('location cannot submit previous coordinates after replacement GPS fails', () => nativeRun(async ({ app, wx }) => {
  const location = page('location', { outlet: 'zz', month: '2026-11' });
  await location.onShow();
  await location.locate(tap({ manual: 'false' }));
  await location.photo();
  const photoId = location.data.photo.id;
  const address = '隔离试用保留的经营地址';
  location.input({ ...tap({ field: 'address' }), detail: { value: address } });

  wx.getLocation = options => options.fail({ errMsg: 'getLocation:fail location unavailable' });
  await location.locate(tap({ manual: 'false' }));
  assert.match(location.data.error, /未获得定位/);
  await location.submit();
  assert.equal(app.store.load().verifications.length, 0, 'failed replacement must not save old coordinates');
  assert.equal(location.data.coords, null);
  assert.deepEqual(location.data.markers, []);
  assert.equal(location.data.form.address, address);
  assert.equal(location.data.photo.id, photoId);

  wx.getLocation = options => options.success({ latitude: 28.45, longitude: 113.05, accuracy: 7 });
  await location.locate(tap({ manual: 'false' }));
  await location.submit();
  const [result] = app.store.load().verifications;
  assert.equal(result.coords.lat, 28.45);
  assert.equal(result.photo.id, photoId);
}));

test('location cannot submit previous photo after replacement photo fails', () => nativeRun(async ({ app, wx }) => {
  const location = page('location', { outlet: 'zz', month: '2026-11' });
  await location.onShow();
  await location.locate(tap({ manual: 'false' }));
  await location.photo();
  const originalId = location.data.photo.id;
  const coordinates = structuredClone(location.data.coords);
  const filesystem = wx.getFileSystemManager;

  wx.getFileSystemManager = () => ({ readFile: options => options.fail({ errMsg: 'readFile:fail' }) });
  await location.photo();
  assert.match(location.data.error, /照片读取失败/);
  await location.submit();
  assert.equal(app.store.load().verifications.length, 0, 'failed replacement must not save old photo');
  assert.equal(location.data.photo, null);
  assert.equal(location.data.preview, '');
  assert.deepEqual(location.data.coords, coordinates);

  wx.getFileSystemManager = filesystem;
  await location.photo();
  const newId = location.data.photo.id;
  assert.notEqual(newId, originalId);
  await location.submit();
  assert.equal(app.store.load().verifications[0].photo.id, newId);
}));

test('location waits for replacement GPS before submitting an existing draft', () => nativeRun(async ({ app, wx }) => {
  const location = page('location', { outlet: 'zz', month: '2026-11' });
  await location.onShow();
  await location.locate(tap({ manual: 'false' }));
  await location.photo();

  let gps;
  wx.getLocation = options => { gps = options; };
  const capture = location.locate(tap({ manual: 'false' }));
  try {
    await location.submit();
    assert.equal(app.store.load().verifications.length, 0);
  } finally {
    gps.success({ latitude: 28.45, longitude: 113.05, accuracy: 7 });
    await capture;
  }
  await location.submit();
  assert.equal(app.store.load().verifications[0].coords.lat, 28.45);
}));

test('location waits for the replacement photo and submits the new attachment once', () => nativeRun(async ({ app, wx, calls }) => {
  const location = page('location', { outlet: 'zz', month: '2026-11' });
  await location.onShow();
  await location.locate(tap({ manual: 'false' }));
  await location.photo();
  const originalId = location.data.photo.id;

  const readQueue = [];
  wx.getFileSystemManager = () => ({ readFile: options => { readQueue.push(options); } });
  const replacement = location.photo();
  try {
    await location.submit();
    assert.equal(app.store.load().verifications.length, 0);
    const repeated = location.photo();
    assert.equal(readQueue.length, 1);
    await repeated;
  } finally {
    for (const read of readQueue) read.success({ data: png });
    await replacement;
  }

  const selectedId = location.data.photo.id;
  assert.notEqual(selectedId, originalId);
  await location.submit();
  assert.equal(app.store.load().verifications[0].photo.id, selectedId);
  assert.equal(calls.filter(call => call.method === 'POST' && call.url?.endsWith('/api/files')).length, 2);
}));


test('new-outlet form can ask for active GPS after manual selection and stores source', () => nativeRun(async ({ app }) => {
  const requests = page('requests');
  const markup = fs.readFileSync(path.join(native, 'pages/requests/index.wxml'), 'utf8');
  assert.match(markup, /data-manual="false"\s+bindtap="locate"/);
  await requests.onShow();
  requests.setData({ form: { name: '独立验收网点', province: '湖南', city: '长沙', district: '岳麓', address: '岳麓区验收路', phone: '13800001111', opening: '2026-12-01', reason: '新增经营网点' } });
  await requests.locate(tap({ manual: 'true' }));
  assert.equal(requests.data.coords.source, 'manual');
  await requests.locate(tap({ manual: 'false' }));
  assert.equal(requests.data.coords.source, 'gps');
  await requests.photo();
  await requests.submit();
  assert.equal(requests.data.error, '');
  const record = app.store.load().requests[0];
  assert.equal(record.type, 'newOutlet');
  assert.equal(record.data.coords.source, 'gps');
  assert.equal(record.data.coords.coordinateSystem, 'GCJ-02');
  assert.ok(record.data.photo.id);
}));

test('support tab switches to the requested ticket when another ticket is open', () => nativeRun(async ({ calls }) => {
  const create = async title => (await api.command('support.ticket', { outlet: 'cs', category: 'exception', title, description: '用于独立验收消息跳转', channel: 'miniprogram' })).result;
  const first = await create('已打开的工单');
  const second = await create('新消息指向的工单');
  const support = page('support');
  await support.onShow();
  await support.open(tap({ id: first.id }));
  assert.equal(support.data.ticket.id, first.id);
  go('support', 'id=' + encodeURIComponent(second.id));
  assert.ok(calls.some(call => call.switchTab === '/pages/support/index'));
  await support.onShow();
  assert.equal(support.data.tab, 'ticket');
  assert.equal(support.data.ticket.id, second.id);
}));

test('location reminders open the exact verification month or the application requiring evidence', () => nativeRun(async ({ wx, calls }) => {
  const location = page('location', { outlet: 'zz', month: '2026-10' });
  await location.onShow();
  await location.locate(tap({ manual: 'false' }));
  await location.photo();
  await location.submit();
  const verification = location.data.history[0];
  assert.ok(verification);

  const photo = (await api.uploadPhoto()).file;
  const request = (await api.command('request.submit', {
    type: 'locationChange', outlet: 'cs', data: {
      address: '验收新地址', coords: { lat: 28.2, lng: 113.1, source: 'gps', coordinateSystem: 'GCJ-02' }, photo, reason: '测试位置核验结果消息',
    },
  })).result;
  const prior = api.session();
  await api.login('location');
  await api.command('location.review', { id: request.id, decision: 'exception', note: '请补充现场证明' });
  wx.setStorageSync('jyyc.session', prior);
  const inbox = page('messages');
  await inbox.onShow();
  const openMessage = async id => {
    const message = inbox.data.state.messages.find(row => row.target === 'location' && row.recordId === id);
    assert.ok(message);
    await inbox.open(tap({ id: message.id }));
    return new URL(calls.filter(call => call.navigateTo).at(-1).navigateTo, 'http://local');
  };
  const verificationLink = await openMessage(verification.id);
  assert.equal(verificationLink.pathname, '/pages/location/index');
  assert.equal(verificationLink.searchParams.get('month'), '2026-10');
  const linkedPage = page('location', Object.fromEntries(verificationLink.searchParams));
  await linkedPage.onShow();
  assert.equal(linkedPage.data.history[0].id, verification.id);

  const requestLink = await openMessage(request.id);
  assert.equal(requestLink.pathname, '/pages/requests/index');
  const linkedRequest = page('requests', Object.fromEntries(requestLink.searchParams));
  await linkedRequest.onShow();
  assert.equal(linkedRequest.data.state.requests[0].id, request.id);
  assert.equal(linkedRequest.data.state.requests[0].status, 'supplement');
}));

test('location-change form never reuses evidence across two authorized outlets', () => nativeRun(async ({ app }) => {
  const requests = page('requests', { type: 'locationChange', outlet: 'zz' });
  await requests.onShow();
  await requests.locate(tap({ manual: 'true' }));
  await requests.photo();
  requests.input({ ...tap({ field: 'reason' }), detail: { value: '更换经营场地' } });
  requests.chooseOutlet(change(requests.data.outlets.findIndex(outlet => outlet.id === 'cs')));
  assert.equal(requests.data.coords, null);
  assert.equal(requests.data.photo, null);
  await requests.submit();
  assert.equal(app.store.load().requests.length, 0);
}));

test('location-change request waits for the new coordinates and requires retry on failure', () => nativeRun(async ({app,wx}) => {
  const requests = page('requests', {type:'locationChange',outlet:'zz'});
  await requests.onShow();
  requests.input({...tap({field:'reason'}),detail:{value:'隔离验证地址更新'}});
  await requests.locate(tap({manual:'true'}));
  await requests.photo();
  const photoId=requests.data.photo.id;
  let gps;
  wx.getLocation = options => { gps=options; };
  const pending=requests.locate(tap({manual:'false'}));
  try {
    await requests.submit();
    assert.equal(app.store.load().requests.length,0,'cannot save location-change request while GPS is in progress');
  } finally {
    gps.fail({errMsg:'getLocation:fail'});
    await pending;
  }
  assert.match(requests.data.error,/未获得定位/);
  assert.equal(requests.data.coords,null);
  await requests.submit();
  assert.equal(app.store.load().requests.length,0);
  wx.getLocation = options => options.success({latitude:28.45,longitude:113.05,accuracy:7});
  await requests.locate(tap({manual:'false'}));
  await requests.submit();
  const [record]=app.store.load().requests;
  assert.equal(record.outlet,'zz');
  assert.equal(record.data.coords.lat,28.45);
  assert.equal(record.data.photo.id,photoId);
}));

test('location-change request waits for replacement photo and requires retry on failure', () => nativeRun(async ({app,wx}) => {
  const requests = page('requests', {type:'locationChange',outlet:'zz'});
  await requests.onShow();
  requests.input({...tap({field:'reason'}),detail:{value:'隔离验证地址更新'}});
  await requests.locate(tap({manual:'true'}));
  await requests.photo();
  const originalId=requests.data.photo.id,filesystem=wx.getFileSystemManager;
  const reads=[];
  wx.getFileSystemManager = () => ({readFile:options=>{reads.push(options);}});
  const pending=requests.photo();
  try {
    await requests.submit();
    assert.equal(app.store.load().requests.length,0,'cannot save location-change request while photo is in progress');
    const repeated=requests.photo();
    assert.equal(reads.length,1);
    await repeated;
  } finally {
    for(const read of reads)read.fail({errMsg:'readFile:fail'});
    await pending;
  }
  assert.match(requests.data.error,/照片读取失败/);
  assert.equal(requests.data.photo,null);
  await requests.submit();
  assert.equal(app.store.load().requests.length,0);
  wx.getFileSystemManager=filesystem;
  await requests.photo();
  const newId=requests.data.photo.id;
  assert.notEqual(newId,originalId);
  await requests.submit();
  assert.equal(app.store.load().requests[0].data.photo.id,newId);
}));

test('expired session from a write redirects once and cannot persist the command', () => nativeRun(async ({ app, calls }) => {
  const report = page('report', { outlet: 'zz', month: '2026-10' });
  await report.onShow();
  report.input({ ...tap({ field: 'revenue' }), detail: { value: '150.00' } });
  app.store.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  await Promise.all([report.draft(), api.detail('outlets', 'zz').catch(error => assert.equal(error.status, 401))]);
  assert.equal(api.session(), null);
  assert.match(report.data.error, /登录已失效/);
  assert.equal(calls.filter(call => call.reLaunch === '/pages/login/index').length, 1);
  assert.equal(app.store.load().drafts.length, 0);
}));

test('a late 401 from a previous session leaves the new login in storage', () => nativeRun(async ({ app, wx, calls }) => {
  const original = wx.request;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  wx.request = options => options.url.includes('/api/collections/outlets/zz')
    ? original({ ...options, success: result => waiting.then(() => options.success(result)) })
    : original(options);
  app.store.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const stale = api.detail('outlets', 'zz');
  const newSession = await api.login('partnerB');
  release();
  await assert.rejects(stale, { code: 'UNAUTHENTICATED' });
  assert.equal(api.session()?.token, newSession.token);
  assert.equal(calls.some(call => call.reLaunch), false);
}));

test('mock payment cancel leaves bill unpaid, creates no receipt and permits retry', () => nativeRun(async ({ app }) => {
  const fees = page('fees', { outlet: 'zz' });
  await fees.onShow();
  const bill = fees.data.bills[0];
  assert.equal(bill.outlet, 'zz');
  await fees.pay(tap({ id: bill.id }));
  const payment = fees.data.payment;
  await fees.resolve(tap({ outcome: 'cancelled' }));
  assert.equal(fees.data.error, '');
  const state = app.store.load();
  assert.equal(state.payments.find(row => row.id === payment.id).status, 'cancelled');
  assert.equal(state.bills.find(row => row.id === bill.id).status, 'unpaid');
  assert.equal(state.receipts.some(row => row.billId === bill.id), false);
  await fees.pay(tap({ id: bill.id }));
  assert.notEqual(fees.data.payment.id, payment.id);
}));

test('monthly list resumes only the owner draft, then pending and approved versions lock the form', () => nativeRun(async ({app,calls}) => {
  const month = '2026-10';
  await api.command('report.draft',{outlet:'zz',month,revenue:123.45,note:'草稿回填验收'});
  let list=page('reports');
  await list.onShow();
  assert.deepEqual(list.data.draftRows.map(row=>[row.outlet,row.month,row.revenue]),[['zz',month,123.45]]);
  list.open(tap({outlet:'zz',month}));
  assert.match(calls.at(-1).navigateTo,/outlet=zz&month=2026-10$/);
  let report=page('report',{outlet:'zz',month});
  await report.onShow();
  assert.equal(report.data.form.revenue,123.45);
  assert.equal(report.data.form.orders,'');
  assert.equal(report.data.canEdit,true);
  await report.submit({detail:{value:{revenue:'123.45',orders:'12',traffic:'34',note:'草稿回填验收'}}});
  assert.equal(report.data.latestSubmittedVersion.status,'pending');
  assert.equal(report.data.currentApprovedVersion,null);
  assert.equal(report.data.canEdit,false);
  const id=report.data.latestSubmittedVersion.id;
  await api.login('ops');
  await api.command('review.report',{id,decision:'approve',note:'独立运营审核'});
  await api.login('partnerA');
  list=page('reports');
  await list.onShow();
  assert.equal(list.data.draftRows.length,0);
  assert.equal(list.data.rows.find(row=>row.id===id).status,'approved');
  report=page('report',{outlet:'zz',month});
  await report.onShow();
  assert.equal(report.data.currentApprovedVersion.id,id);
  assert.equal(report.data.canEdit,false);
  assert.equal(app.store.db.prepare("SELECT json_extract(data,'$.revenue') AS revenue FROM reports WHERE id=?").get(id).revenue,123.45);
  await api.command('report.draft',{outlet:'cs',month,revenue:10});
  await api.login('partnerB');
  list=page('reports');
  await list.onShow();
  assert.equal(list.data.draftRows.length,0);
}));

test('the visitor month-report tab offers sign-in and a public destination without private requests', () => nativeRun(async ({calls}) => {
  await api.visitor();
  calls.length = 0;
  const reports = page('reports');
  await reports.onShow();
  assert.equal(reports.data.isPublic, true);
  assert.equal(reports.data.error, '');
  assert.ok(!calls.some(call => /\/api\/collections\/(reports|drafts|businessTasks|exemptions|outlets)/.test(call.url || '')));
  const template = fs.readFileSync(path.join(native,'pages/reports/index.wxml'),'utf8');
  assert.match(template,/data-page="login"[^>]*bindtap="nav">使用账号登录/);
  assert.match(template,/data-page="outlets"[^>]*data-query="scope=public"[^>]*bindtap="nav">查看服务网点/);
  assert.match(template,/wx:elif="{{state && !isPublic}}"/);
  reports.newReport();
  reports.open(tap({outlet:'cs',month:'2026-10',id:'rpt-private'}));
  assert.ok(!calls.some(call => call.navigateTo?.includes('/pages/report/index')));
  reports.nav(tap({page:'login'}));
  reports.nav(tap({page:'outlets',query:'scope=public'}));
  assert.ok(calls.some(call => call.navigateTo==='/pages/login/index'));
  assert.ok(calls.some(call => call.switchTab==='/pages/outlets/index'));
}));
