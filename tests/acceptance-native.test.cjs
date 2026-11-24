const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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
    setData(values, done) {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts.at(-1)] = value;
      }
      done?.();
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
    pageScrollTo(options) { calls.push({ scrollTo: options.selector }); },
    showToast() {},
    showModal(o) { o.success({confirm:true}); },
    reLaunch(options) { calls.push({ reLaunch: options.url }); },
    switchTab(options) { calls.push({ switchTab: options.url }); options.success?.(); },
    navigateTo(options) { calls.push({ navigateTo: options.url }); options.success?.(); },
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
      calls.push({ url: options.url, method: options.method, status: result.statusCode, requestId: result.data.requestId });
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

test('workbench business history paginates three authorized record types and opens their original records', () => nativeRun(async ({ calls }) => {
  const write = (route, body) => api.request(route, 'POST', body, { 'Idempotency-Key': randomUUID() });
  await api.login('manager');
  const course = await write('/api/training/courses', { title: '独立课程', content: '隔离验收材料' });
  await write('/api/training/courses/' + course.id, { status: 'published' });
  await api.login('partnerA');
  const report = (await api.command('report.submit', { outlet:'cs', month:'2026-10',
    revenue:1200, orders:4, traffic:6, enroll:0, note:'仅原单显示的经营说明' })).result;
  const ticket = (await api.command('support.ticket', { outlet:'cs', category:'aftersale',
    title:'设备无法使用', description:'仅原单显示的工单详情', contact:'仅原单显示的联系方式' })).result;
  const training = await write('/api/training/records', { courseId:course.id, outletId:'cs', learner:'仅培训原单显示的学员' });
  await api.visitor();
  await api.command('support.ticket', { outlet:'cs', category:'complaint', title:'消费者投诉私有标题', description:'消费者投诉详情' });
  const recordsUrl='/api/workbench/records';
  await assert.rejects(api.request(recordsUrl), {status:403});
  await api.login('support');
  await assert.rejects(api.request(recordsUrl), {status:403});
  await api.login('partnerA');
  const list = await api.request(recordsUrl+'?outlet=cs&limit=3');
  assert.deepEqual(list.items.map(row=>row.id), [training.id,ticket.id,report.id]);
  assert.deepEqual(list.items.map(row=>row.kind), ['training','support','report']);
  assert.ok(list.items.every(row=>row.outlet==='cs'&&row.outletName&&row.occurredAt));
  assert.doesNotMatch(JSON.stringify(list), /仅原单显示|仅培训原单显示|消费者投诉/);
  const second = await api.request(recordsUrl+'?outlet=cs&limit=1&offset=1');
  assert.equal(second.items[0].id,ticket.id);
  assert.equal(second.total,list.total);
  assert.equal(second.hasMore,true);
  const home=page('home');
  await home.onShow();
  home.toggleWorkbenchScope();
  await home.chooseWorkbenchOutlet(tap({ id:'cs' }));
  assert.deepEqual(home.data.recentRows.map(row=>row.id),[training.id,ticket.id,report.id]);
  home.openWorkbenchList(tap({section:'records'}));
  assert.equal(calls.at(-1).navigateTo,'/pages/tasks/index?section=records&outlet=cs');
  const history=page('tasks',{section:'records',outlet:'cs'});
  await history.onShow();
  assert.equal(history.data.businessTotal,list.total);
  for(const [kind,id,route] of [['report',report.id,'report'],['support',ticket.id,'support'],['training',training.id,'training']]){
    await history.open(tap({id:kind+':'+id}));
    assert.match(calls.at(-1).navigateTo,new RegExp('^/pages/'+route+'/index\\?'));
    assert.equal(new URL(calls.at(-1).navigateTo,'http://localhost').searchParams.get('id'),id);
  }
  await api.login('partnerB');
  assert.deepEqual((await api.request(recordsUrl+'?outlet=cs')).items,[]);
  for(const [kind,id] of [['reports',report.id],['supportTickets',ticket.id]]){
    await assert.rejects(api.detail(kind,id), {status:404});
  }
  await assert.rejects(api.request('/api/training/records/'+training.id+'?outlet=cs'), {status:404});
  await history.onShow();
  assert.deepEqual(history.data.businessRows,[]);
}));

test('the activation form reports errors at the corresponding field and redeems the invitation once', () => nativeRun(async ({ calls }) => {
  await api.login('manager');
  const invitation = await api.request('/api/auth/activation', 'POST', { actor: 'partnerB', username: 'activation.review' });
  await api.visitor();
  const login = page('login', { mode: 'activate' });
  await login.onShow();
  const activationRequests = () => calls.filter(call => call.method === 'POST' && call.url?.endsWith('/api/auth/activate'));
  login.confirmActivationField({ ...tap({ field: 'activationToken' }), detail: { value: ' ' } });
  assert.equal(login.data.activationField, 'activationToken');
  assert.equal(login.data.activationFocus, '');
  await login.activate();
  assert.equal(login.data.activationField, 'activationToken');
  assert.equal(calls.at(-1).scrollTo, '#activation-field-activationToken');
  login.confirmActivationField({ ...tap({ field: 'activationToken' }), detail: { value: invitation.token } });
  assert.equal(login.data.error, '');
  assert.equal(login.data.activationFocus, 'password');
  login.blurActivationField(tap({ field: 'activationToken' }));
  assert.equal(login.data.activationFocus, 'password');
  login.confirmActivationField({ ...tap({ field: 'password' }), detail: { value: 'short' } });
  assert.equal(login.data.activationFocus, 'password');
  assert.equal(login.data.activationField, 'password');
  login.setData({ password: 'short', confirmPassword: 'short' });
  await login.activate();
  assert.equal(login.data.activationField, 'password');
  assert.equal(login.data.activationFocus, '');
  assert.equal(calls.at(-1).scrollTo, '#activation-field-password');
  login.confirmActivationField({ ...tap({ field: 'password' }), detail: { value: 'Isolated-Activation-24!' } });
  assert.equal(login.data.activationField, '');
  assert.equal(login.data.activationFocus, 'confirmPassword');
  login.setData({ password: 'Isolated-Activation-24!', confirmPassword: 'Different-Activation-24!' });
  await login.activate();
  assert.equal(login.data.activationField, 'confirmPassword');
  assert.equal(activationRequests().length, 0);

  login.toggleActivationVisibility(tap({ field: 'confirmPassword' }));
  assert.equal(login.data.visibleActivationFields.confirmPassword, true);
  assert.equal(login.data.visibleActivationFields.password, undefined);
  await login.confirmActivationField({ ...tap({ field: 'confirmPassword' }), detail: { value: login.data.password } });
  assert.equal(api.session().actor, 'partnerB');
  assert.equal(login.data.password, '');
  assert.equal(login.data.confirmPassword, '');
  assert.equal(login.data.activationToken, '');
  assert.deepEqual(login.data.visibleActivationFields, {});
  assert.equal(activationRequests().at(-1).status, 200);

  await api.visitor();
  const replay = page('login', { mode: 'activate' });
  replay.setData({ activationToken: invitation.token, password: 'Isolated-Activation-24!', confirmPassword: 'Isolated-Activation-24!' });
  await replay.activate();
  assert.equal(replay.data.activationField, 'activationToken');
  assert.equal(calls.at(-1).scrollTo, '#activation-field-activationToken');
  assert.match(replay.data.error, /激活码已失效/);
  assert.equal(activationRequests().at(-1).status, 409);
}));

test('workbench keeps the selected outlet across preview and task list and clears rows after an account switch', () => nativeRun(async ({ calls }) => {
  const month = '2026-10';
  const submit = async (outlet, enroll) => (await api.command('report.submit', {
    outlet, month, revenue: 1200, orders: 4, traffic: 6, enroll, note: '工作台隔离验证',
  })).result;
  const reports = await Promise.all([submit('cs', 0), submit('zz', null)]);
  await api.login('manager');
  for (const report of reports) {
    await api.command('review.report', { id: report.id, decision: 'return', note: '仅 ' + report.outlet + ' 原单可见的退回原因' });
  }
  await api.login('partnerA');
  const home = page('home');
  await home.onShow();
  assert.equal(home.data.scopeName, '全部授权网点');
  home.toggleWorkbenchScope();
  await home.chooseWorkbenchOutlet(tap({ id:'zz' }));
  assert.equal(home.data.scopeOutlet, 'zz');
  assert.equal(home.data.scopeStatus, '营业中');
  const item = home.data.activeRows.find(row => row.reason.includes('仅 zz'));
  assert.ok(item);
  assert.doesNotMatch(JSON.stringify(home.data.activeRows), /仅 cs/);
  await home.openWorkbenchTask(tap({ id: item.id }));
  assert.match(calls.at(-1).navigateTo, new RegExp('outlet=zz&month='+month+'&id='+reports[1].id+'&edit=returned$'));
  const editor = page('report', { outlet: 'zz', month, id: reports[1].id, edit: 'returned' });
  await editor.onShow();
  assert.equal(editor.data.directReturnedEdit, true);
  assert.equal(editor.data.linkedVersion, null);
  assert.equal(editor.data.latestSubmittedVersion.id, reports[1].id);
  assert.equal(editor.data.canEdit, true);
  assert.match(editor.data.returnedReason, /仅 zz/);
  home.openWorkbenchList(tap({ status: 'open' }));
  assert.equal(calls.at(-1).navigateTo, '/pages/tasks/index?status=open&outlet=zz');
  const tasks = page('tasks', { status: 'open', outlet: 'zz' });
  await tasks.onShow();
  assert.equal(tasks.data.pagers.businessTasks.total, home.data.openTotal);
  assert.ok(tasks.data.taskRows.some(row => row.id === item.id));
  assert.ok(tasks.data.state.businessTasks.every(row => row.outlet === 'zz'));

  await api.login('partnerB');
  await assert.rejects(api.detail('businessTasks', item.id), { status: 404 });
  const forbidden = await api.collection('businessTasks', { status: 'open', outlet: 'zz' });
  assert.equal(forbidden.total, 0);
  await home.onShow();
  assert.notEqual(home.data.scopeOutlet, 'zz');
  assert.doesNotMatch(JSON.stringify(home.data.activeRows), /仅 zz/);
}));

test('private directory opens the exact returned report and keeps a superseded version read-only', () => nativeRun(async ({ calls }) => {
  const { today } = await api.request('/api/context');
  const [year, monthNumber] = today.slice(0, 7).split('-').map(Number);
  const month = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
  const payload = { outlet: 'cs', month, revenue: 1200, orders: 4, traffic: 6, enroll: 0, note: '目录原单复验' };
  const { result: original } = await api.command('report.submit', payload);
  await api.login('manager');
  await api.command('review.report', { id: original.id, decision: 'return', note: '仅本人可查看的退回原因' });
  await api.command('public.profile', { outlet: 'cs', title: '隔离公开网点', address: '隔离地址',
    description: '隔离公开资料', services: ['咨询'], published: true, reason: '隔离验收' });

  await api.login('partnerA');
  const directory = page('outlets');
  await directory.onShow();
  const privateRow = directory.data.rows.find(row => row.id === 'cs');
  assert.equal(privateRow.summary.report.returnedVersionId, original.id);
  directory.outletAction(tap({ id: 'cs' }));
  const destination = new URL(calls.at(-1).navigateTo, 'https://native.invalid');
  const query = Object.fromEntries(destination.searchParams);
  assert.equal(destination.pathname, '/pages/report/index');
  assert.deepEqual(query, { outlet: 'cs', month, id: original.id, edit: 'returned' });

  const editor = page('report', { ...query });
  await editor.onShow();
  assert.equal(editor.data.directReturnedEdit, true);
  assert.equal(editor.data.latestSubmittedVersion.id, original.id);
  assert.match(editor.data.returnedReason, /仅本人/);
  const { result: replacement } = await api.command('report.submit', { ...payload, orders: 5 });
  assert.notEqual(replacement.id, original.id);
  const history = page('report', query);
  await history.onShow();
  assert.equal(history.data.linkedVersion.id, original.id);
  assert.equal(history.data.canEdit, false);
  assert.equal(history.data.directReturnedEdit, false);

  await api.visitor();
  const published = await api.detail('outlets', 'cs', { scope: 'public', includeSummary: 'true' });
  assert.equal(published.summary, undefined);
  assert.doesNotMatch(JSON.stringify(published), new RegExp(original.id));
  await api.login('partnerB');
  await assert.rejects(api.detail('outlets', 'cs', { includeSummary: 'true' }), { status: 404 });
  await assert.rejects(api.request('/api/reports/context?' + api.query({ outlet: 'cs', month })), { status: 403 });
}));

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
  assert.ok(markup.indexOf('bindconfirm="searchOutlets"') < markup.indexOf('<block wx:if="{{outlets.length}}">'));
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

test('location workbench entry waits for the selected outlet and records manual evidence separately', t => nativeRun(async ({ app, calls, wx }) => {
  const location = page('location', { month: '2026-11' });
  await location.onShow();
  assert.ok(location.data.outlets.length > 1);
  assert.equal(calls.some(call => call.url?.includes('/api/collections/verifications')), false);
  assert.equal(location.data.outletId, '');
  await location.locate(tap({ manual: 'false' }));
  await location.photo();
  assert.equal(location.data.coords, null);
  assert.equal(calls.some(call => call.url?.includes('/api/files')), false);
  const index = location.data.outlets.findIndex(outlet => outlet.id === 'zz');
  await location.chooseOutletFromPicker(change(index + 1));
  assert.equal(location.data.outletId, 'zz');
  await location.locate(tap({ manual: 'true' }));
  await location.photo();
  await location.submit();
  const [record] = app.store.load().verifications;
  assert.equal(record.outlet, 'zz');
  assert.equal(record.coords.source, 'manual');
  assert.equal(record.month, '2026-11');
  assert.equal(record.status, 'pending');
  assert.match(location.data.submissionNotice, /等待总部.*现场定位尚未完成/);
  assert.match(location.data.monthStatus, /现场定位尚未完成/);
  assert.equal(location.data.canSubmitEvidence, false);

  const partner = api.session();
  const submitted = calls.filter(call => call.method === 'POST' && call.url?.endsWith('/api/commands')).at(-1);
  await api.login('location');
  await assert.rejects(api.command('location.review', { id: record.id, decision: 'approve' }), { code: 'GPS_REQUIRED' });
  const denied = calls.at(-1);
  await api.command('location.review', { id: record.id, decision: 'exception', note: '请到现场补充定位', publicNote: '请到现场补充定位' });
  const returned = calls.at(-1);
  wx.setStorageSync('jyyc.session', partner);
  const reopened = page('location', { outlet: record.outlet, month: record.month, id: record.id });
  await reopened.onShow();
  assert.equal(reopened.data.history[0].id, record.id);
  assert.match(reopened.data.monthStatus, /需补充资料/);
  assert.equal(reopened.data.canSubmitEvidence, true);
  assert.equal(reopened.data.history[0].publicNote, '请到现场补充定位');
  await reopened.chooseMonth(change('2026-10'));
  reopened.toggleHistory();
  await reopened.supplementLocation(tap({ id: record.id }));
  assert.equal(reopened.data.month, record.month);
  await reopened.locate(tap({ manual: 'false' }));
  await reopened.photo();
  reopened.input({ ...tap({ field: 'explanation' }), detail: { value: '补交现场定位和照片' } });
  await reopened.submit();
  const [followup] = app.store.load().verifications.filter(row => row.id !== record.id);
  assert.equal(followup.previousId, record.id);
  assert.equal(followup.coords.source, 'gps');
  assert.match(reopened.data.monthStatus, /等待总部核验/);
  const supplement = calls.filter(call => call.method === 'POST' && call.url?.endsWith('/api/commands')).at(-1);
  await api.login('location');
  await api.command('location.review', { id: followup.id, decision: 'approve' });
  const approved = calls.at(-1);
  wx.setStorageSync('jyyc.session', partner);
  await reopened.onShow();
  assert.match(reopened.data.monthStatus, /核验已通过/);
  assert.equal(reopened.data.canSubmitEvidence, false);
  assert.equal(reopened.data.history.find(row => row.id === followup.id).status, 'approved');
  assert.match(reopened.data.history.find(row => row.id === record.id).statusText, /原记录保留/);
  for (const evidence of [submitted, denied, returned, supplement, approved]) assert.ok(evidence.requestId);
  t.diagnostic(JSON.stringify({ outlet: record.outlet, month: record.month, manualRecord: record.id, supplementRecord: followup.id,
    submit: submitted.requestId, manualApprovalDenied: denied.requestId, returned: returned.requestId,
    supplement: supplement.requestId, approved: approved.requestId }));
  const mismatched = page('location', { outlet: record.outlet, month: '2026-10', id: record.id });
  await mismatched.onShow();
  assert.match(mismatched.data.recordError, /无法查看这条核验记录/);
  assert.equal(mismatched.data.canSubmitEvidence, false);
}));

test('public overseas map provides address access before a device error is reported', t => nativeRun(async ({ app, calls }) => {
  const state = app.store.load();
  const template = state.outlets.find(outlet => outlet.id === 'gz');
  const id = 'isolated-overseas-address';
  state.outlets.push({ ...template, id, outlet: id, status: 'open', address: '仅供内部核验的地址' });
  app.store.save(state);
  await api.login('manager');
  await api.command('public.profile', {
    outlet: id, title: '新加坡隔离验收网点', address: '新加坡公开验收地址', description: '公开网点信息',
    services: ['咨询'], reason: '已授权的隔离数据', published: true, countryCode: 'SG', city: '新加坡',
    publicCoords: { lat: 1.3, lng: 103.8, coordinateSystem: 'WGS-84' },
  });
  await api.visitor();
  const directory = page('outlets', { scope: 'public', mode: 'map' });
  await directory.onShow();
  await directory.filterGeography(tap({ geo: 'overseas' }));
  await directory.filterCountry(change(directory.data.countryChoices.findIndex(country => country.code === 'SG')));
  const markup = fs.readFileSync(path.join(native, 'pages/outlets/index.wxml'), 'utf8');
  assert.ok(markup.indexOf('bindtap="modeUnavailable"') >= 0);
  assert.ok(markup.indexOf('bindtap="modeUnavailable"') < markup.indexOf('wx:if="{{mapError}}"'));
  assert.equal(directory.data.mapError, '');
  directory.modeUnavailable();
  assert.equal(directory.data.mode, 'list');
  assert.equal(directory.data.countryCode, 'SG');
  assert.deepEqual(directory.data.rows.map(row => row.address), ['新加坡公开验收地址']);
  directory.open(tap({ id }));
  const route = calls.filter(call => call.navigateTo).at(-1).navigateTo;
  assert.equal(route, '/pages/outlet/index?id=' + id + '&scope=public');
  await api.login('partnerA');
  const detail = page('outlet', Object.fromEntries(new URL(route, 'https://example.test').searchParams));
  await detail.onShow();
  assert.equal(detail.data.outlet.address, '新加坡公开验收地址');
  assert.equal(detail.data.publicRecord, true);
  assert.equal(detail.data.internal, false);
  const observed = calls.filter(call => call.url?.includes('/api/collections/outlets')).at(-1);
  assert.ok(observed.requestId);
  t.diagnostic(JSON.stringify({ country: 'SG', outlet: id, publicDetail: observed.requestId }));
}));

test('public home passes both regions on the first directory request and keeps search on return', () => nativeRun(async ({ app, calls }) => {
  const state = app.store.load();
  const template = state.outlets.find(outlet => outlet.id === 'gz');
  state.outlets.push({ ...template, id: 'review-sg', outlet: 'review-sg' });
  app.store.save(state);
  await api.login('manager');
  const samples = [
    { id: 'gz', geo: 'mainland', countryCode: 'CN', city: '广州' },
    { id: 'review-sg', geo: 'overseas', countryCode: 'SG', city: '新加坡' },
  ];
  for (const { id, countryCode, city } of samples) {
    await api.command('public.profile', {
      outlet: id, countryCode, city, title: city + '验收网点', address: city + '公开地址',
      description: '隔离验收网点', services: ['咨询'], reason: '隔离公开样本', published: true,
    });
  }
  await api.visitor();
  const directory = page('outlets');
  const home = page('home');
  const firstDirectoryRequest = () => new URL(calls.find(call =>
    call.url?.includes('/api/collections/outlets?')).url).searchParams;
  for (const { id, geo, city } of samples) {
    calls.length = 0;
    home.nav(tap({ page: 'outlets', query: 'scope=public&mode=list&geo=' + geo }));
    await directory.onShow();
    assert.equal(firstDirectoryRequest().get('geo'), geo);
    assert.equal(firstDirectoryRequest().get('scope'), 'public');
    assert.equal(directory.data.geo, geo);
    assert.deepEqual(directory.data.rows.map(row => row.id), [id]);
    assert.deepEqual(directory.data.rows[0].services, ['咨询']);
    assert.equal(directory.data.rows[0].businessChips, undefined);

    await directory.search(change(city));
    directory.openOutlet(id);
    assert.match(calls.at(-1).navigateTo, new RegExp('id=' + id));
    const detail = page('outlet', { id, scope: 'public' });
    await detail.onShow();
    assert.equal(detail.data.error, '');
    calls.length = 0;
    await directory.onShow();
    assert.equal(firstDirectoryRequest().get('geo'), geo);
    assert.equal(firstDirectoryRequest().get('q'), city);
    assert.equal(directory.data.searchDraft, city);
  }
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
  requests.beginRequest();
  await requests.pickRequestType(tap({ index: requests.data.types.findIndex(type => type.id === 'newOutlet') }));
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

test('opening a support deep link gives the requested ticket its own page above another ticket', () => nativeRun(async ({ calls }) => {
  const create = async title => (await api.command('support.ticket', { outlet: 'cs', category: 'exception', title, description: '用于独立验收消息跳转', channel: 'miniprogram' })).result;
  const first = await create('已打开的工单');
  const second = await create('新消息指向的工单');
  const support = page('support');
  await support.onShow();
  await support.open(tap({ id: first.id }));
  assert.equal(support.data.ticket.id, first.id);
  go('support', 'id=' + encodeURIComponent(second.id));
  const opened = new URL(calls.at(-1).navigateTo, 'https://example.test');
  assert.equal(opened.pathname, '/pages/support/index');
  const linked = page('support', Object.fromEntries(opened.searchParams));
  await linked.onShow();
  assert.equal(linked.data.tab, 'ticket');
  assert.equal(linked.data.ticket.id, second.id);
  assert.equal(support.data.ticket.id, first.id);
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
  await requests.chooseOutlet(change(requests.data.outlets.findIndex(outlet => outlet.id === 'cs')));
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
  const redirects = calls.filter(call => call.reLaunch?.startsWith('/pages/login/index'));
  assert.equal(redirects.length, 1);
  assert.equal(new URL(redirects[0].reLaunch, 'https://test.local').searchParams.get('next'), 'report?outlet=zz&month=2026-10');
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

test('an expired visitor renews once without leaving the public directory or replaying an old write', () => nativeRun(async ({ app, calls }) => {
  const original = await api.visitor();
  app.store.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const before = calls.length;
  const [context, outlets] = await Promise.all([
    api.request('/api/context'),
    api.collection('outlets', { scope: 'public' }),
  ]);
  assert.equal(context.actor, 'public');
  assert.ok(Array.isArray(outlets.items));
  assert.notEqual(api.session().token, original.token);
  assert.equal(calls.slice(before).filter(call => call.url?.endsWith('/api/auth/visitor')).length, 1);
  assert.ok(!calls.some(call => call.reLaunch));
  app.store.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  const writeBefore = calls.length;
  await assert.rejects(api.command('support.chat', { text: '旧会话下的咨询' }), { code: 'UNAUTHENTICATED' });
  assert.equal(calls.slice(writeBefore).filter(call => call.method === 'POST').length, 1);
  assert.ok(!calls.some(call => call.reLaunch));
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
  const drafts = list.data.reportRows.filter(row => row.status === 'draft');
  assert.deepEqual(drafts.map(row=>[row.outletId,row.month]),[['zz',month]]);
  assert.ok(!Object.hasOwn(drafts[0], 'revenue'));
  list.open(tap({outlet:'zz',month}));
  assert.match(calls.at(-1).navigateTo,/outlet=zz&month=2026-10$/);
  let report=page('report',{outlet:'zz',month});
  await report.onShow();
  assert.equal(report.data.form.revenue,123.45);
  assert.equal(report.data.form.orders,'');
  assert.equal(report.data.canEdit,true);
  await report.submit({detail:{value:{revenue:'123.45',orders:'12',traffic:'34',note:'草稿回填验收'}}});
  await report.confirmSubmit();
  assert.equal(report.data.latestSubmittedVersion.status,'pending');
  assert.equal(report.data.currentApprovedVersion,null);
  assert.equal(report.data.canEdit,false);
  const id=report.data.latestSubmittedVersion.id;
  await api.login('ops');
  await api.command('review.report',{id,decision:'approve',note:'独立运营审核'});
  await api.login('partnerA');
  list=page('reports');
  await list.onShow();
  assert.equal(list.data.reportRows.some(row=>row.status==='draft'),false);
  assert.equal(list.data.reportRows.find(row=>row.reportId===id).status,'approved');
  report=page('report',{outlet:'zz',month});
  await report.onShow();
  assert.equal(report.data.currentApprovedVersion.id,id);
  assert.equal(report.data.canEdit,false);
  assert.equal(app.store.db.prepare("SELECT json_extract(data,'$.revenue') AS revenue FROM reports WHERE id=?").get(id).revenue,123.45);
  await api.command('report.draft',{outlet:'cs',month,revenue:10});
  await api.login('partnerB');
  list=page('reports');
  await list.onShow();
  assert.equal(list.data.reportRows.some(row=>row.status==='draft'),false);
}));

test('the visitor report tab returns to public home with sign-in and directory actions before any private requests', () => nativeRun(async ({calls}) => {
  await api.visitor();
  calls.length = 0;
  const reports = page('reports');
  await reports.onShow();
  assert.ok(calls.some(call => call.reLaunch === '/pages/home/index'));
  assert.equal(reports.data.error, '');
  assert.ok(!calls.some(call => /\/api\/(?:reports\/worklist|collections\/(reports|drafts|businessTasks|exemptions|outlets))/.test(call.url || '')));
  const template = fs.readFileSync(path.join(native,'pages/home/index.wxml'),'utf8');
  assert.match(template,/data-page="login"[^>]*bindtap="nav"[\s\S]*?加盟商登录/);
  assert.match(template,/data-page="outlets"[^>]*data-query="scope=public&mode=list&geo=mainland"[^>]*bindtap="nav"[\s\S]*?国内网点/);
  const home=page('home');
  home.nav(tap({page:'login'}));
  home.nav(tap({page:'outlets',query:'scope=public&mode=list'}));
  assert.ok(calls.some(call => call.navigateTo==='/pages/login/index'));
  assert.ok(calls.some(call => call.switchTab==='/pages/outlets/index'));
}));
