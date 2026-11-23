'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const api = require('../miniprogram/utils/api');

function page(name, query, t, responses) {
  const original = { request: api.request, collection: api.collection, session: api.session };
  const previousPage = global.Page;
  const previousWx = global.wx;
  t.after(() => {
    Object.assign(api, original);
    global.Page = previousPage;
    global.wx = previousWx;
  });
  api.session = () => ({ role: 'partner' });
  api.request = responses.request;
  api.collection = responses.collection;
  const scrolls = [], routes = [];
  global.wx = {
    getStorageSync() {},
    pageScrollTo: options => scrolls.push(options.selector),
    navigateTo(options) { routes.push(options.url); options.success?.(); },
  };

  const path = require.resolve('../miniprogram/pages/' + name + '/index.js');
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[path];
  require(path);
  const instance = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(values, callback) {
      for (const [key, value] of Object.entries(values)) {
        const path = key.split('.');
        let target = this.data;
        for (const field of path.slice(0, -1)) target = target[field] ||= {};
        target[path.at(-1)] = value;
      }
      callback?.();
    },
  };
  instance.onLoad(query);
  return { instance, scrolls, routes };
}

const entries = items => ({ items, total: items.length, offset: 0, limit: 50, hasMore: false });
const markup = pageName => readFileSync(require.resolve('../miniprogram/pages/' + pageName + '/index.js').replace(/\.js$/, '.wxml'), 'utf8');
const outlets = [
  { id: 'cs', name: '九盈网点', owner: 'p1', city: '长沙市', district: '岳麓区' },
  { id: 'zz', name: '九盈网点', owner: 'p1', city: '株洲市', district: '天元区' },
  { id: 'hy', name: '衡阳网点', owner: 'p1', city: '衡阳市', district: '蒸湘区' },
];
const today = '2027-03-04';
const tap = dataset => ({ currentTarget: { dataset } });
const summary = { expected: 8, submitted: 3, exempt: 1, actionable: 2, awaitingExemption: 1, inReview: 1 };
const worklistRow = (month, outletId = 'cs') => ({ outletId, outletName: '九盈网点', month, status: 'missing', reason: null,
  reportId: null, latestVersion: null, effectiveVersion: null, dueOn: '2027-03-05', canSubmit: true });
const worklistPage = (month, items = [], overrides = {}) => ({ month, items, total: items.length, offset: 0, limit: 25, hasMore: false, summary, ...overrides });

test('workbench keeps the pending count when unread notices cannot load', async t => {
  const tasks = [
    { id: 'missing-1', kind: 'report_missing', outlet: 'cs', month: '2027-02', status: 'open' },
    { id: 'returned', kind: 'report_returned', outlet: 'zz', month: '2027-02', status: 'open', dueAt: '2027-03-05' },
    { id: 'missing-2', kind: 'location_missing', outlet: 'hy', month: '2027-03', status: 'open' },
    { id: 'unpaid', kind: 'bill_unpaid', outlet: 'cs', month: '2027-02', status: 'open' },
  ];
  const { instance } = page('home', {}, t, {
    async request(route) {
      if (route === '/api/context') return { actor: 'partnerA', today };
      assert.fail('unexpected workbench request: '+route);
    },
    async collection(name, filters) {
      if (name === 'outlets') return entries(outlets);
      if (name === 'accounts') return entries([{ managerName: '测试负责人' }]);
      if (name === 'businessTasks') return entries(filters.status === 'open' ? tasks : []);
      throw new Error('消息暂不可用');
    },
  });
  await instance.onShow();
  assert.equal(instance.data.error, '');
  assert.equal(instance.data.taskError, false);
  assert.equal(instance.data.openTotal, 4);
  assert.equal(instance.data.hasUnreadNotices, false);
  assert.equal(instance.data.managerName, '测试负责人');
});

test('my matters opens a task by ID and ignores the ID of a stale refreshed row', async t => {
  const first = { id: 'task-a', kind: 'report_missing', outlet: 'cs', month: '2027-02', status: 'open' };
  const second = { id: 'task-b', kind: 'report_missing', outlet: 'zz', month: '2027-02', status: 'open' };
  const { instance, routes } = page('tasks', {}, t, {
    async request(route) { return route === '/api/context' ? { actor: 'partnerA', today } : {}; },
    async collection(name, filters) {
      if (name === 'outlets') return entries(outlets);
      return entries(name === 'businessTasks' && filters.status === 'open' ? [second, first] : []);
    },
  });
  await instance.onShow();
  await instance.open({ currentTarget: { dataset: { id: first.id, index: 0 } } });
  assert.deepEqual(routes, ['/pages/report/index?outlet=cs&month=2027-02']);
  await instance.open({ currentTarget: { dataset: { id: 'task-stale', index: 1 } } });
  assert.equal(routes.length, 1);
});

test('a delayed task read cannot navigate after the matters page has closed', async t=>{
  const task={id:'task-delayed',taskId:'task-delayed',kind:'report_returned',outlet:'zz',month:'2027-02',status:'open'};
  let completeRead;
  const {instance,routes}=page('tasks',{},t,{
    async request(route){return route==='/api/context'?{actor:'partnerA',today}:{};},
    async collection(name,filters){
      if(name==='outlets')return entries(outlets);
      return entries(name==='businessTasks'&&filters.status==='open'?[task]:[]);
    }
  });
  t.mock.method(api,'detail',async()=>await new Promise(resolve=>{completeRead=resolve;}));
  await instance.onShow();
  const open=instance.open(tap({id:task.id}));
  assert.equal(instance.data.openingRecord,true);
  instance.onUnload();
  completeRead(task);
  await open;
  assert.deepEqual(routes,[]);

  const {instance: reopened,routes: reopenedRoutes}=page('tasks',{},t,{
    async request(){return {actor:'partnerA',today};},
    async collection(name,filters){return entries(name==='businessTasks'&&filters.status==='open'?[task]:[]);}
  });
  await reopened.onShow();
  const retry=reopened.open(tap({id:task.id}));
  completeRead(task);
  await retry;
  assert.deepEqual(reopenedRoutes,['/pages/report/index?outlet=zz&month=2027-02']);
});

test('month report selector disambiguates outlets by city and district while scoped records keep the exact ID', async t => {
  const requested = [];
  const { instance, scrolls } = page('report', { outlet: 'zz', month: '2027-02', id: 'rpt-test' }, t, {
    async request(route) {
      if (route === '/api/context') return { actor: 'partnerA', today };
      requested.push(route);
      const report = { id: 'rpt-test', status: 'returned', version: 1, publicNote: '请核对本月客流' };
      return { historyVersions: [report], latestSubmittedVersion: report, eligibility: { canEdit: true }, enrollmentStatus: 'applicable' };
    },
    async collection() { return entries(outlets); },
  });
  await instance.onShow();
  assert.equal(instance.data.outletId, 'zz');
  assert.match(instance.data.outletNames[1], /长沙市.*岳麓区/);
  assert.match(instance.data.outletNames[2], /株洲市.*天元区/);
  assert.equal(instance.data.returnedReason, '请核对本月客流');
  assert.equal(instance.data.currentAction, '修改并重新提交');
  assert.equal(instance.data.canEdit, false);
  assert.deepEqual(requested, ['/api/reports/context?outlet=zz&month=2027-02']);
  assert.equal(instance.data.historyExpanded, false);
  instance.showVersions();
  assert.equal(instance.data.historyExpanded, true);
  assert.deepEqual(scrolls, ['#report-history']);
});

test('report lists lead with filling', () => {
  const reports = markup('reports');
  assert.ok(reports.indexOf('bindtap="newReport"') < reports.indexOf('bindchange="pickOutlet"'));
});

test('month report list requests the last month of the server calendar', async t => {
  const requests = [], collections = [];
  const { instance } = page('reports', {}, t, {
    async request(path) {
      requests.push(path);
      if (path === '/api/context') return { actor: 'partnerA', today };
      return worklistPage('2027-02', [worklistRow('2027-02')]);
    },
    async collection(name) {
      collections.push(name);
      return entries(outlets);
    },
  });
  await instance.onShow();
  assert.deepEqual(collections, ['outlets']);
  assert.deepEqual(requests, ['/api/context', '/api/reports/worklist?month=2027-02&outlet=all&status=all&limit=25&offset=0']);
  assert.equal(instance.data.month, '2027-02');
  assert.equal(instance.data.reportRows[0].statusText, '待填写');
  assert.deepEqual(instance.data.coverage, { ...summary, percent: 38 });
});

test('month report remains usable for a valid exact outlet when only its selector fails', async t=>{
  let selectorUnavailable=true;
  let reads=0;
  const {instance,routes}=page('reports',{outlet:'zz',month:'2027-02'},t,{
    async request(route){
      if(route==='/api/context')return {actor:'partnerA',today};
      const query=new URL(route,'https://native.invalid').searchParams;
      assert.equal(query.get('outlet'),'zz');
      reads++;
      return worklistPage('2027-02',[worklistRow('2027-02','zz')]);
    },
    async collection(){
      if(selectorUnavailable)throw new Error('网点列表暂不可用');
      return entries(outlets);
    }
  });
  await instance.onShow();
  assert.equal(instance.data.error,'');
  assert.match(instance.data.outletChoiceError,/网点列表暂不可用/);
  assert.equal(instance.data.reportRows[0].outletId,'zz');
  instance.open(tap({outlet:'zz',month:'2027-02'}));
  assert.deepEqual(routes,['/pages/report/index?outlet=zz&month=2027-02']);
  selectorUnavailable=false;
  await instance.retryOutletChoices();
  assert.equal(instance.data.outletChoiceError,'');
  assert.equal(instance.data.options[instance.data.outletIndex].id,'zz');
  assert.equal(reads,1);
});

test('monthly worklist ignores older month and account responses and appends only the selected page', async t => {
  const updates = [], calls = [];
  const { instance, routes } = page('reports', { month: '2027-02' }, t, {
    async request(path) {
      if (path === '/api/context') return { actor: 'partnerA', today };
      const query = new URL(path, 'https://native.invalid').searchParams;
      const [month, outlet, status, offset] = ['month', 'outlet', 'status', 'offset'].map(key => query.get(key));
      calls.push([month, outlet, status, offset]);
      return new Promise(resolve => updates.push(resolve));
    },
    async collection() { return entries(outlets); },
  });
  let account = { role: 'partner', token: 'first', subject: 'first' };
  api.session = () => account;
  const requestFor = async count => {
    for (let attempt = 0; updates.length < count && attempt < 30; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(updates.length >= count, `worklist request ${count} was issued`);
    return updates[count - 1];
  };
  const initial = instance.onShow();
  const lastMonth = await requestFor(1);
  const newer = instance.changeMonth({ detail: { value: '2027-03' } });
  const newMonth = await requestFor(2);
  assert.deepEqual(instance.data.reportRows, []);
  assert.equal(instance.data.coverage, null);
  newMonth(worklistPage('2027-03', [worklistRow('2027-03', 'zz')], { total: 26, hasMore: true }));
  await newer;
  lastMonth(worklistPage('2027-02', [worklistRow('2027-02')]));
  await initial;
  assert.deepEqual(instance.data.reportRows.map(row => row.outletId), ['zz']);
  instance.open(tap({ outlet: 'zz', month: '2027-02' }));
  assert.deepEqual(routes, []);

  const loadingMore = instance.moreReports();
  const additional = await requestFor(3);
  additional(worklistPage('2027-03', [worklistRow('2027-03', 'hy')], { offset: 25, total: 26 }));
  await loadingMore;
  assert.deepEqual(instance.data.reportRows.map(row => row.outletId), ['zz', 'hy']);
  assert.deepEqual(calls[2], ['2027-03', 'all', 'all', '25']);

  const filtering = instance.filter(tap({ value: 'reviewing' }));
  const delayedFilter = await requestFor(4);
  account = { role: 'partner', token: 'second', subject: 'second' };
  const loginRefresh = instance.onShow();
  const newAccount = await requestFor(5);
  newAccount(worklistPage('2027-03'));
  await loginRefresh;
  delayedFilter(worklistPage('2027-03', [worklistRow('2027-03', 'zz')]));
  await filtering;
  assert.deepEqual(instance.data.reportRows, []);
  assert.equal(instance.data.worklist.total, 0);
  instance.open(tap({ outlet: 'zz', month: '2027-03' }));
  assert.deepEqual(routes, []);
});

test('a failed exact outlet query retains scope and can retry without fetching every outlet worklist', async t => {
  const calls = [];
  let unavailable = true;
  const { instance } = page('reports', { outlet: 'cs' }, t, {
    async request(path) {
      if (path === '/api/context') return { actor: 'partnerA', today };
      calls.push(new URL(path, 'https://native.invalid').searchParams.get('outlet'));
      if (unavailable) throw Object.assign(new Error('无网点权限'), { status: 403 });
      return worklistPage('2027-02', [worklistRow('2027-02')]);
    },
    async collection() { return entries(outlets); },
  });
  await instance.onShow();
  assert.equal(instance.data.worklistError, '无网点权限');
  assert.equal(instance.data.outlet, 'cs');
  assert.equal(instance.data.month, '2027-02');
  assert.deepEqual(instance.data.reportRows, []);
  assert.equal(instance.data.coverage, null);
  unavailable = false;
  await instance.retryReports();
  assert.deepEqual(calls, ['cs', 'cs']);
  assert.equal(instance.data.worklistError, '');
  assert.equal(instance.data.reportRows[0].outletId, 'cs');
});

test('a workbench link can open the processing queue directly', async t => {
  const task = { id: 'returned', kind: 'report_returned', outlet: 'zz', outletName: '株洲网点', month: '2027-02', status: 'in_progress' };
  const filters = [];
  const { instance } = page('tasks', { status: 'in_progress' }, t, {
    async request() { return { actor: 'partnerA', today }; },
    async collection(name, params) {
      filters.push([name, params.status]);
      return entries(name === 'businessTasks' ? [task] : []);
    },
  });
  await instance.onShow();
  assert.deepEqual(filters, [['businessTasks', 'in_progress'], ['messages', 'unread']]);
  assert.equal(instance.data.taskRows[0].title, '经营月报');
  assert.equal(instance.data.taskRows[0].actionText, '查看月报');
  assert.equal(instance.data.taskRows[0].statusTone, 'wait');
});

test('a scoped report notice shows its destination and the outlet and month', async t => {
  const notice = { id: 'message', target: 'reports', title: '月报退回', recordId: 'rpt-test', outlet: 'zz', outletName: '株洲网点', month: '2027-02' };
  const inbox = page('messages', {}, t, {
    async request() { return { actor: 'partnerA', today }; },
    async collection() { return entries([notice]); },
  }).instance;
  await inbox.onShow();
  assert.equal(inbox.data.messages[0].actionText, '查看月报');
  assert.equal(inbox.data.messages[0].scopeText, '株洲网点 · 2027年02月');
});
