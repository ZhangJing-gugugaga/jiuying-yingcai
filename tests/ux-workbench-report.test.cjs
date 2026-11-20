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

test('workbench keeps current tasks if the management summary or unread total cannot load', async t => {
  const tasks = [
    { id: 'missing-1', kind: 'report_missing', outlet: 'cs', month: '2027-02', status: 'open' },
    { id: 'returned', kind: 'report_returned', outlet: 'zz', month: '2027-02', status: 'open', dueAt: '2027-03-05' },
    { id: 'missing-2', kind: 'location_missing', outlet: 'hy', month: '2027-03', status: 'open' },
    { id: 'unpaid', kind: 'bill_unpaid', outlet: 'cs', month: '2027-02', status: 'open' },
  ];
  const { instance } = page('home', {}, t, {
    async request(route) {
      if (route === '/api/context') return { actor: 'partnerA', today };
      throw new Error('统计暂不可用');
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
  assert.equal(instance.data.summaryError, true);
  assert.equal(instance.data.todoTotal, 4);
  assert.equal(instance.data.todoPreview.length, 3);
  assert.equal(instance.data.todoPreview[0].id, 'returned');
  assert.equal(instance.data.managerName, '测试负责人');
});

test('workbench handles an action by task ID and does not open a different refreshed row', async t => {
  const first = { id: 'task-a', kind: 'report_missing', outlet: 'cs', month: '2027-02', status: 'open' };
  const second = { id: 'task-b', kind: 'report_missing', outlet: 'zz', month: '2027-02', status: 'open' };
  const { instance, routes } = page('home', {}, t, {
    async request(route) { return route === '/api/context' ? { actor: 'partnerA', today } : {}; },
    async collection(name, filters) {
      if (name === 'outlets') return entries(outlets);
      return entries(name === 'businessTasks' && filters.status === 'open' ? [second, first] : []);
    },
  });
  await instance.onShow();
  await instance.openTodo({ currentTarget: { dataset: { id: first.id, index: 0 } } });
  assert.deepEqual(routes, ['/pages/report/index?outlet=cs&month=2027-02']);
  await instance.openTodo({ currentTarget: { dataset: { id: 'task-stale', index: 1 } } });
  assert.equal(routes.length, 1);
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

test('public home exposes group services in the entry card and report lists lead with filling', () => {
  const home = markup('home');
  assert.match(home, /home-map-actions[\s\S]*?data-page="discover" data-query="section=services"[^>]*>集团业务<\/button>/);
  assert.match(home, /data-page="outlets" data-query="scope=public&mode=list"[^>]*>查找服务网点/);
  const reports = markup('reports');
  assert.ok(reports.indexOf('bindtap="newReport"') < reports.indexOf('bindchange="pickOutlet"'));
});

test('month report list requests the last month of the server calendar', async t => {
  const filters = [];
  const { instance } = page('reports', {}, t, {
    async request(path) {
      if (path.startsWith('/api/dashboard')) {
        assert.match(path, /[?&]period=2027-02&outlet=all&kind=month&mode=process&limit=1$/);
        return { reportingCoverage: { expected: 8, submitted: 3, exempt: 1 } };
      }
      return { actor: 'partnerA', today };
    },
    async collection(name, params) {
      if (name === 'outlets') return entries(outlets);
      filters.push([name, params.month]);
      return entries([]);
    },
  });
  await instance.onShow();
  assert.deepEqual(filters, ['reports', 'drafts', 'businessTasks', 'exemptions'].map(name => [name, '2027-02']));
  assert.equal(instance.data.month, '2027-02');
  assert.deepEqual(instance.data.coverage, { expected: 8, submitted: 3, exempt: 1, percent: 38 });
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
