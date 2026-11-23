'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const api = require('../miniprogram/utils/api');

const tap = dataset => ({ currentTarget: { dataset } });
const collection = (rows, { offset = 0, limit = 50 } = {}) => ({
  items: rows.slice(offset, offset + limit), total: rows.length, offset, limit, hasMore: offset + limit < rows.length
});
const markup = name => fs.readFileSync(require.resolve('../miniprogram/pages/' + name + '/index').replace(/\.js$/, '.wxml'), 'utf8');

function mount(t, name, query = {}, options = {}) {
  const original = { request: api.request, collection: api.collection, session: api.session, passwordLogin: api.passwordLogin };
  const previousWx = global.wx;
  const previousPage = global.Page;
  const routes = [];
  const calls = [];
  const role = options.role || 'partner';
  api.session = options.session || (() => ({ role }));
  api.request = async route => route === '/api/context'
    ? { actor: role === 'public' ? 'public' : 'partnerA', today: '2026-11-20', support: { settings: { phone: '400-123-4567' } } }
    : options.request?.(route) || {};
  api.collection = async (name, filters) => {
    const rows = await options.rows?.(name, filters);
    return collection(rows ?? (name === 'outlets' ? [{ id: 'cs', name: '长沙网点', owner: 'p1' }] : []), filters);
  };
  global.wx = {
    getStorageSync() {},
    makePhoneCall({ phoneNumber }) { calls.push(phoneNumber); },
    navigateTo({ url, success }) { routes.push(url); success?.(); },
    switchTab({ url, success }) { routes.push(url); success?.(); },
    setStorageSync() {}
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

test('workbench shows the full pending count with one route to matters', async t => {
  const common = { outlet: 'zz', outletName: '株洲网点', month: '2026-11', target: 'location', status: 'open' };
  const { page, routes } = mount(t, 'home', {}, {
    rows: (name, filters) => name === 'businessTasks' && filters.status === 'open' ? [
      { ...common, id: 'missing', kind: 'location_missing', dueAt: '2026-11-30' },
      { ...common, id: 'returned', kind: 'report_returned', dueAt: '2026-11-22' },
      { ...common, id: 'overdue', kind: 'location_missing', dueAt: '2026-11-19', overdue: true },
      { ...common, id: 'today', kind: 'location_missing', dueAt: '2026-11-20' },
      { ...common, id: 'invalid', target: 'private-unknown', dueAt: '2026-11-01', overdue: true }
    ] : undefined
  });
  await page.onShow();
  assert.equal(page.data.openTotal, 5);
  page.nav(tap({page:'tasks'}));
  assert.deepEqual(routes, ['/pages/tasks/index']);
});

test('the secondary dashboard opens the latest verified settlement when the current month has none', async t => {
  const periods = [];
  const { page } = mount(t, 'dashboard', {}, {
    request(route) {
      const query = new URL(route, 'https://native.invalid').searchParams;
      periods.push(query.get('period'));
      assert.equal(query.get('mode'), 'settled');
      if (periods.length === 1) return { settlementMonths: { hasCurrent: false, latestPriorMonth: '2026-10' } };
      return { settlementMonths: { hasCurrent: true }, totals: { revenue: 1200, orders: 4 } };
    }
  });
  await page.onShow();
  assert.deepEqual(periods.slice(0,2), ['2026-11', '2026-10']);
  assert.equal(page.data.period, '2026-10');
  assert.equal(page.data.metrics[1].value, 4);
});

test('workbench can open matters while its pending count is still loading', async t => {
  let startCount,finishCount;
  const countStarted = new Promise(resolve => { startCount = resolve; });
  const count = new Promise(resolve => { finishCount = resolve; });
  const { page, routes } = mount(t, 'home', {}, {
    rows(name, filters) {
      if (name !== 'businessTasks') return;
      assert.equal(filters.limit,1);
      startCount();
      return count;
    }
  });
  const refresh = page.onShow();
  try {
    await countStarted;
    page.nav(tap({page:'tasks'}));
    assert.deepEqual(routes, ['/pages/tasks/index']);
  } finally {
    finishCount([]);
    await refresh;
  }
});

for (const [status, actionText] of [
  ['empty', '申请新增网点'], ['pending', '查看申请进度'], ['returned', '查看原因并补充'],
  ['supplement', '查看原因并补充'], ['approved', '查看已通过申请']
]) {
  test('zero-outlet workbench opens the correct first-outlet destination for ' + status, async t => {
    const reads = [];
    const { page, routes } = mount(t, 'home', {}, {
      request(route) { reads.push(route); },
      rows(name, filters) {
        if (name === 'outlets') return [];
        if (name !== 'requests') return [];
        reads.push(filters);
        return status === 'empty' ? [] : [{ id: 'req-first', status, type: 'newOutlet' }];
      }
    });
    await page.onShow();
    assert.equal(page.data.outletCount, 0);
    assert.equal(page.data.firstOutlet?.actionText, actionText);
    assert.deepEqual(reads, [{ type: 'newOutlet', limit: 1 }]);
    page.openOutlets();
    assert.deepEqual(routes, [status === 'empty'
      ? '/pages/requests/index?type=newOutlet' : '/pages/requests/index?id=req-first']);
  });
}

test('zero-outlet workbench retries an unreadable application and keeps existing tasks and notices', async t => {
  let retry = false;
  const { page, routes } = mount(t, 'home', {}, {
    rows(name, filters) {
      if (name === 'outlets') return [];
      if (name === 'requests' && !retry) throw new Error('request unavailable');
      if (name === 'messages') return [{ id: 'msg-unread' }];
      if (name === 'businessTasks' && filters.status === 'open') {
        return [{ id: 'task-first', status: 'open', kind: 'request_supplement', recordId: 'req-first', target: 'requests' }];
      }
      return [];
    }
  });
  await page.onShow();
  assert.equal(page.data.firstOutlet?.status, 'error');
  assert.match(page.data.firstOutlet.detail, /暂时无法确认申请进度/);
  assert.equal(page.data.openTotal, 1);
  assert.equal(page.data.hasUnreadNotices, true);
  page.openFirstOutlet();
  assert.deepEqual(routes, []);
  retry = true;
  await page.refresh();
  assert.equal(page.data.firstOutlet?.status, 'empty');
});

test('workbench offers first-outlet guidance only after a successful zero count', async t => {
  let mode = 'offline';
  const reads = [];
  const { page } = mount(t, 'home', {}, {
    request(route) { reads.push(route); },
    rows(name) {
      if (name === 'outlets') {
        if (mode === 'offline') throw new Error('outlets unavailable');
        if (mode === 'new') return [];
        return [1, 2, 3].map(id => ({ id: 'test-' + id, owner: 'p1' }));
      }
      if (name === 'requests') reads.push('requests');
      return [];
    }
  });
  await page.onShow();
  assert.equal(page.data.firstOutlet, null);
  assert.deepEqual(reads, []);
  mode = 'new';
  await page.refresh();
  assert.equal(page.data.firstOutlet?.status, 'empty');
  mode = 'operating';
  await page.refresh();
  assert.equal(page.data.firstOutlet, null);
  assert.equal(page.data.outletCount, 3);
  assert.equal(reads.filter(read => read === 'requests').length, 1);
  assert.ok(!reads.some(read => typeof read==='string'&&read.startsWith('/api/dashboard?')));
  const template = markup('home');
  assert.match(template, /data-page="outlets" data-query="scope=private" bindtap="openOutlets"[\s\S]*?firstOutlet.actionText/);
  assert.match(template, /经营办理[\s\S]*?data-page="reports"[\s\S]*?data-page="fees"[\s\S]*?data-page="tasks"/);
});

test('a delayed first-outlet lookup cannot restore a previous account’s application', async t => {
  let token = 'first', startLookup, finishLookup;
  const lookupStarted = new Promise(resolve => { startLookup = resolve; });
  const lookup = new Promise(resolve => { finishLookup = resolve; });
  const { page, routes } = mount(t, 'home', {}, {
    session: () => ({ role: 'partner', token }),
    rows(name) {
      if (name === 'requests' && token === 'first') {
        startLookup();
        return lookup;
      }
      return [];
    }
  });
  const previousRefresh = page.onShow();
  await Promise.race([lookupStarted, previousRefresh]);
  assert.equal(page.data.firstOutlet?.status, 'loading');
  page.openFirstOutlet();
  assert.deepEqual(routes, []);
  token = 'second';
  await page.onShow();
  finishLookup([{ id: 'req-private', type: 'newOutlet', status: 'returned' }]);
  await previousRefresh;
  assert.equal(page.data.firstOutlet?.status, 'empty');
  page.openFirstOutlet();
  assert.deepEqual(routes, ['/pages/requests/index?type=newOutlet']);
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

test('the outlet tab picks one action by priority and offers detail for waiting rows', async t => {
  const returned = { month: '2026-10', status: 'returned' };
  const missing = { month: '2026-10', status: 'missing' };
  const exception = { month: '2026-11', status: 'exception' };
  const locationMissing = { month: '2026-11', status: 'missing' };
  const unpaid = { month: '2026-11', status: 'unpaid' };
  const partiallyPaid = { month: '2026-11', status: 'partially_paid' };
  const waitingReport = { month: '2026-10', status: 'exemption_pending' };
  const waitingLocation = { month: '2026-11', status: 'pending' };
  const scenarios = [
    ['cs', returned, exception, unpaid, 'report'],
    ['zz', missing, exception, unpaid, 'location'],
    ['hy', missing, locationMissing, unpaid, 'report'],
    ['cd', waitingReport, locationMissing, unpaid, 'location'],
    ['km', waitingReport, waitingLocation, unpaid, 'fees'],
    ['nn', waitingReport, waitingLocation, partiallyPaid, 'fees'],
    ['hz', waitingReport, waitingLocation, null, null],
    ['nj', null, waitingLocation, null, null]
  ];
  const { page, routes } = mount(t, 'outlets', { scope: 'private' }, {
    rows: name => name === 'outlets' ? scenarios.map(([id, report, location, fee]) => ({
      id, name: id + '网点', owner: 'p1', status: 'open', province: '湖南省', city: '长沙市', district: '岳麓区',
      summary: { report, location, fee }
    })) : []
  });
  await page.onShow();
  assert.equal(page.data.mode, 'list');
  await page.mode(tap({ mode: 'map' }));
  assert.equal(page.data.mode, 'list');
  assert.deepEqual(page.data.rows.map(row => row.nextAction?.page ?? null), scenarios.map(row => row[4]));
  assert.equal(page.data.rows[0].area, '长沙市 · 岳麓区');
  assert.match(page.data.rows.find(row => row.id === 'hz').waitingText, /免报待审核/);
  assert.match(page.data.rows.find(row => row.id === 'nj').waitingText, /等待总部核验/);
  page.outletAction(tap({ id: 'zz' }));
  page.outletAction(tap({ id: 'cs' }));
  page.outletAction(tap({ id: 'km' }));
  page.outletAction(tap({ id: 'hz' }));
  page.open(tap({ id: 'hz' }));
  page.outletAction(tap({ id: 'missing' }));
  assert.deepEqual(routes, ['/pages/location/index?outlet=zz&month=2026-11', '/pages/report/index?outlet=cs&month=2026-10',
    '/pages/fees/index?outlet=km&month=2026-11', '/pages/outlet/index?id=hz']);
  page.setData({ directory: true });
  page.outletAction(tap({ id: 'cs' }));
  assert.equal(routes.length, 4);
});

test('returning from an outlet restores the private list search and visible range', async t => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: 'cs-' + index, name: '长沙网点 ' + index, owner: 'p1' }));
  let token = 'first-account';
  const { page, routes } = mount(t, 'outlets', { scope: 'private' }, {
    session: () => ({ role: 'partner', token }),
    rows: (name, filters) => name === 'outlets' ? rows.filter(row => row.name.includes(filters.q || '')) : []
  });
  await page.onShow();
  await page.search({ detail: { value: '长沙' } });
  assert.equal(page.data.rows.length, 50);
  await page.more(tap({ collection: 'outlets' }));
  assert.equal(page.data.rows.length, 60);
  page.open(tap({ id: 'cs-59' }));
  assert.deepEqual(routes, ['/pages/outlet/index?id=cs-59']);
  await page.onShow();
  assert.equal(page.data.search, '长沙');
  assert.equal(page.data.rows.at(-1).id, 'cs-59');
  page.open(tap({ id: 'cs-59' }));
  token = 'second-account';
  page.open(tap({ id: 'cs-59' }));
  assert.equal(routes.length, 2);
  await page.onShow();
  assert.equal(page.data.rows.length, 50);
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

test('login retains credentials after a wrong password and clears them when switching to SMS', async t => {
  const { page } = mount(t, 'login', {}, {
    request: () => ({ authCapabilities: { mode: 'real', sms: true, wechat: false } })
  });
  await page.onShow();
  assert.equal(page.data.mode, 'methods');
  page.mode(tap({ mode: 'password' }));
  api.passwordLogin = async () => { throw Object.assign(new Error('登录名或密码不正确'), { code: 'INVALID_CREDENTIALS' }); };
  page.setData({ username: 'outlet-manager', password: 'typed-password' });
  await page.passwordLogin();
  assert.equal(page.data.password, 'typed-password');
  assert.equal(page.data.error, '账号或密码不正确');
  page.mode(tap({ mode: 'methods' }));
  page.mode(tap({ mode: 'sms' }));
  assert.equal(page.data.mode, 'sms');
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
