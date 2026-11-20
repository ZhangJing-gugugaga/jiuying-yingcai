'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const api = require('../miniprogram/utils/api');

const tap = dataset => ({ currentTarget: { dataset } });
const collection = items => ({ items, total: items.length, offset: 0, limit: 50, hasMore: false });
const markup = name => fs.readFileSync(require.resolve('../miniprogram/pages/' + name + '/index').replace(/\.js$/, '.wxml'), 'utf8');

function mount(t, name, query = {}, options = {}) {
  const original = { request: api.request, collection: api.collection, session: api.session, passwordLogin: api.passwordLogin };
  const previousWx = global.wx;
  const previousPage = global.Page;
  const routes = [];
  const calls = [];
  const role = options.role || 'partner';
  api.session = () => ({ role });
  api.request = async route => route === '/api/context'
    ? { actor: role === 'public' ? 'public' : 'partnerA', today: '2026-11-20', support: { settings: { phone: '400-123-4567' } } }
    : options.request?.(route) || {};
  api.collection = async (name, filters) => collection(options.rows?.(name, filters) || []);
  global.wx = {
    getStorageSync() {},
    makePhoneCall({ phoneNumber }) { calls.push(phoneNumber); },
    navigateTo({ url, success }) { routes.push(url); success?.(); }
  };
  let definition;
  global.Page = page => { definition = page; };
  const entry = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[entry];
  require(entry);
  t.after(() => {
    Object.assign(api, original);
    global.wx = previousWx;
    global.Page = previousPage;
    delete require.cache[entry];
  });
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    route: 'pages/' + name + '/index',
    setData(update, done) {
      for (const [path, value] of Object.entries(update)) {
        const keys = path.split('.');
        const target = keys.slice(0, -1).reduce((obj, key) => obj[key] ||= {}, this.data);
        target[keys.at(-1)] = value;
      }
      done?.();
    }
  };
  page.onLoad(query);
  return { page, routes, calls };
}

test('workbench previews at most three actionable tasks by due date and marks an overdue row', async t => {
  const common = { outlet: 'zz', outletName: '株洲网点', month: '2026-11', target: 'location', status: 'open' };
  const { page, routes } = mount(t, 'home', {}, {
    rows: (name, filters) => name === 'businessTasks' && filters.status === 'open' ? [
      { ...common, id: 'missing', kind: 'location_missing', dueAt: '2026-11-30' },
      { ...common, id: 'returned', kind: 'report_returned', dueAt: '2026-11-22' },
      { ...common, id: 'overdue', kind: 'location_missing', dueAt: '2026-11-19', overdue: true },
      { ...common, id: 'today', kind: 'location_missing', dueAt: '2026-11-20' },
      { ...common, id: 'invalid', target: 'private-unknown', dueAt: '2026-11-01', overdue: true }
    ] : []
  });
  await page.onShow();
  assert.equal(page.data.openTotal, 5);
  assert.deepEqual(page.data.todoPreview.map(row => row.id), ['overdue', 'today', 'returned']);
  assert.match(page.data.todoPreview[0].dueText, /已超期/);
  assert.equal(page.data.todoPreview[1].dueText, '今天截止');
  await page.openTodo(tap({ id: 'today' }));
  assert.deepEqual(routes, ['/pages/location/index?outlet=zz&month=2026-11']);
});

test('workbench loads the latest verified settlement when the current month has none', async t => {
  const periods = [];
  const { page } = mount(t, 'home', {}, {
    request(route) {
      const query = new URL(route, 'https://native.invalid').searchParams;
      periods.push(query.get('period'));
      assert.equal(query.get('mode'), 'settled');
      if (periods.length === 1) return { settlementMonths: { hasCurrent: false, latestPriorMonth: '2026-10' } };
      return { settlementMonths: { hasCurrent: true }, totals: { revenue: 1200, orders: 4 } };
    }
  });
  await page.onShow();
  assert.deepEqual(periods, ['2026-11', '2026-10']);
  assert.equal(page.data.hasCurrentSettlement, false);
  assert.equal(page.data.latestSettledMonth, '2026-10');
  assert.equal(page.data.latestMetrics[1].value, 4);
});

test('workbench tasks can open while the fallback settlement snapshot is loading', async t => {
  let startSnapshot,finishSnapshot;
  const snapshotStarted = new Promise(resolve => { startSnapshot = resolve; });
  const snapshot = new Promise(resolve => { finishSnapshot = resolve; });
  const { page, routes } = mount(t, 'home', {}, {
    rows: (name, filters) => name === 'businessTasks' && filters.status === 'open'
      ? [{ id: 'task', outlet: 'zz', month: '2026-11', target: 'location', kind: 'location_missing', status: 'open' }] : [],
    request(route) {
      if (!route.includes('period=2026-10')) return { settlementMonths: { hasCurrent: false, latestPriorMonth: '2026-10' } };
      startSnapshot();
      return snapshot;
    }
  });
  const refresh = page.onShow();
  try {
    await snapshotStarted;
    await page.openTodo(tap({ id: 'task' }));
    assert.deepEqual(routes, ['/pages/location/index?outlet=zz&month=2026-11']);
  } finally {
    finishSnapshot({});
    await refresh;
  }
});

test('public home dials the configured headquarters number and keeps published business cards available', async t => {
  const { page, calls } = mount(t, 'home', {}, {
    role: 'public',
    rows: name => name === 'publicContents' ? [
      { id: 's3', key: 'service-3', title: '业务三', status: 'published' },
      { id: 's1', key: 'service-1', title: '业务一', status: 'published' }
    ] : []
  });
  await page.onShow();
  assert.deepEqual(page.data.publishedServices.map(row => row.id), ['s1', 's3']);
  page.dialHeadquarters();
  assert.deepEqual(calls, ['4001234567']);
  assert.match(markup('home'), /bindtap="dialHeadquarters"/);
});

test('the member outlet tab defaults to its list and scopes each action to its row', async t => {
  const { page, routes } = mount(t, 'outlets', { scope: 'private' }, {
    rows: name => name === 'outlets' ? [
      { id: 'cs', name: '长沙网点', owner: 'p1', status: 'open' },
      { id: 'zz', name: '株洲网点', owner: 'p1', status: 'open' }
    ] : []
  });
  await page.onShow();
  assert.equal(page.data.mode, 'list');
  await page.mode(tap({ mode: 'map' }));
  assert.equal(page.data.mode, 'list');
  page.outletAction(tap({ id: 'zz', page: 'location' }));
  page.outletAction(tap({ id: 'cs', page: 'agreements' }));
  page.outletAction(tap({ id: 'missing', page: 'fees' }));
  assert.deepEqual(routes, ['/pages/location/index?outlet=zz&month=2026-11', '/pages/agreements/index?outlet=cs']);
  page.setData({ directory: true });
  page.outletAction(tap({ id: 'cs', page: 'agreements' }));
  assert.equal(routes.length, 2);
});

test('public outlet list groups domestic cities and international locations without requesting GPS', async t => {
  const { page } = mount(t, 'outlets', {}, {
    role: 'public',
    rows: name => name === 'outlets' ? [
      { id: 'cs1', name: '长沙网点一', countryCode: 'CN', countryName: '中国', province: '湖南省', city: '长沙市', status: 'open' },
      { id: 'sg', name: '新加坡网点', countryCode: 'SG', countryName: '新加坡', city: '新加坡', status: 'open' },
      { id: 'cs2', name: '长沙网点二', countryCode: 'CN', countryName: '中国', province: '湖南省', city: '长沙市', status: 'open' }
    ] : []
  });
  await page.onShow();
  assert.deepEqual(page.data.groups.map(group => [group.label, group.rows.map(row => row.id)]),
    [['长沙市', ['cs1', 'cs2']], ['境外 · 新加坡', ['sg']]]);
});

test('login retains credentials on a wrong password and keeps optional methods behind one control', async t => {
  const { page } = mount(t, 'login');
  api.passwordLogin = async () => { throw Object.assign(new Error('登录名或密码不正确'), { code: 'INVALID_CREDENTIALS' }); };
  page.setData({ username: 'outlet-manager', password: 'typed-password' });
  await page.passwordLogin();
  assert.equal(page.data.password, 'typed-password');
  assert.equal(page.data.error, '账号或密码不正确');
  page.toggleMethods();
  assert.equal(page.data.methodsExpanded, false);
  page.updateChannels({ smsEnabled: true, wechatEnabled: false });
  page.toggleMethods();
  assert.equal(page.data.methodsExpanded, true);
  page.mode(tap({ mode: 'sms' }));
  assert.equal(page.data.mode, 'sms');
  assert.equal(page.data.methodsExpanded, false);
  assert.equal(page.data.password, '');
});

test('account help links to published group information and frequently asked questions', () => {
  const profile = markup('profile');
  assert.match(profile, /data-page="discover" data-query="section=brand"/);
  assert.match(profile, /data-page="discover" data-query="section=faq"/);
});

test('published business details offer contact and sharing after the content', () => {
  const service = markup('service-detail');
  assert.match(service, /class="service-cover"[^>]*lazy-load/);
  assert.ok(service.indexOf('class="article"') < service.indexOf('class="service-actions"'));
  assert.match(service, /data-page="support"[^>]*>联系总部咨询/);
  assert.match(service, /open-type="share"[^>]*>分享/);
});

test('group content provides directory and headquarters navigation as actions', () => {
  const group = markup('discover');
  assert.match(group, /class="discover-contact-actions actions"[\s\S]*?data-page="outlets"[\s\S]*?data-page="support"/);
});

test('outlet details explain when the public contact phone is unavailable', () => {
  const outlet = markup('outlet');
  assert.match(outlet, /disabled="{{!outlet.publicPhone}}"[^>]*>拨打网点电话/);
  assert.match(outlet, /publicRecord && !outlet.publicPhone[^>]*>该网点暂未公开电话/);
});
