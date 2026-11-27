const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const app = require('../../miniprogram/app.json');
const { getNativeRoutes } = require('../scripts/wechat-routes.cjs');
const { go, memberLoginUrl, resumeAfterLogin, tabBarView } = require('../../miniprogram/utils/navigation');
const api = require('../../miniprogram/utils/api');
const config = require('../../miniprogram/config');

function markup(name) {
  return readFileSync(require.resolve('../../miniprogram/pages/' + name + '/index.wxml'), 'utf8');
}

function navigation(t) {
  const calls = [];
  const previous = global.wx;
  const storage = new Map();
  const navigate = method => ({ url, success }) => { calls.push({ method, url }); success(); };
  global.wx = {
    navigateTo: navigate('navigateTo'), switchTab: navigate('switchTab'), reLaunch: navigate('reLaunch'),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
  };
  t.after(() => { global.wx = previous; });
  return calls;
}

function nativePage(name, t) {
  const previous = global.Page;
  const entry = require.resolve('../../miniprogram/pages/' + name + '/index.js');
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[entry];
  try { require(entry); } finally { global.Page = previous; }
  t.after(() => { delete require.cache[entry]; });
  return {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(values, done) { Object.assign(this.data, values); done?.(); },
  };
}

test('the four native tabs include the registered member report list', t => {
  const calls = navigation(t);
  go('reports');
  assert.deepEqual(calls, [{ method: 'switchTab', url: '/pages/reports/index' }]);
  assert.deepEqual(app.tabBar.list.map(item => [item.pagePath, item.text]), [
    ['pages/home/index', '首页'], ['pages/outlets/index', '网点'],
    ['pages/reports/index', '月报'], ['pages/profile/index', '我的'],
  ]);
  const { routes, mainPages } = getNativeRoutes(app);
  assert.equal(routes.length, 22);
  assert.ok(mainPages.includes('pages/reports/index'));
  assert.ok(routes.includes('pages/training/index'));
  assert.ok(routes.includes('pages/join/index'));
});

test('workbench exposes scoped shortcuts, notices, and direct work on records', () => {
  const home = markup('home').split('class="home-public-hero"')[0];
  const cards = [...home.matchAll(/class="home-tool" data-page="([a-z-]+)"/g)];
  assert.deepEqual(cards.map(match => match[1]), ['reports', 'fees', 'support', 'outlets']);
  assert.match(home, /data-page="tasks" data-query="section=notices" bindtap="nav"/);
  assert.match(home, /<t-badge count="\{\{unreadNoticeCount\}\}" max-count="\{\{99\}\}"/);
  assert.match(home, /wx:if="{{trainingRecord}}"[^>]*bindtap="openTrainingSupplement"/);
  assert.match(home, /data-status="open" bindtap="openWorkbenchList"/);
  assert.match(home, /data-section="records" bindtap="openWorkbenchList"/);
  assert.match(home, /data-id="{{item.id}}" bindtap="openWorkbenchTask"/);
  const matters = markup('tasks');
  assert.match(matters, /bindtap="openLocation"[^>]*>月度位置核验/);
  assert.match(matters, /data-status="in_progress"/);
  assert.match(matters, /data-section="notices"/);
});

test('a fresh contact view ignores the old tab context and a ticket keeps its exact route', t => {
  const calls = navigation(t);
  const key = 'jyyc.route.support';
  const storage = new Map([[key, { id: 'ticket-previous' }]]);
  Object.assign(global.wx, {
    getStorageSync: name => storage.get(name),
    setStorageSync: (name, data) => storage.set(name, data),
    removeStorageSync: name => storage.delete(name),
  });
  go('support');
  go('support', 'id=ticket-exact&returnStatus=unread');
  assert.deepEqual(storage.get(key), { id: 'ticket-previous' });
  assert.deepEqual(calls, [
    { method: 'navigateTo', url: '/pages/support/index?section=home' },
    { method: 'navigateTo', url: '/pages/support/index?id=ticket-exact&returnStatus=unread' },
  ]);
});

test('my account keeps account actions without duplicating workbench destinations', () => {
  const profile = markup('profile');
  assert.deepEqual([...profile.matchAll(/data-page="([a-z-]+)"/g)].map(match => match[1]), ['login']);
  assert.deepEqual([...profile.matchAll(/<navigator\b[^>]*\burl="([^"]+)"/g)].map(match => match[1]), [
    '/pages/security/index', '/pages/discover/index?section=brand',
    '/pages/discover/index?section=faq', '/pages/support/index?section=home',
  ]);
  assert.match(profile, /bindtap="privacy"/);
  assert.match(profile, /bindtap="logout"/);
});

test('group updates, cases and cooperation use a secondary group entrance', () => {
  const home = markup('home');
  assert.doesNotMatch(home, /openPublicUpdate/);
  assert.match(home, /data-page="discover" data-query="section=cooperation"/);
  assert.match(home, /data-page="discover" data-query="section=brand"/);
  assert.match(home, /data-page="support"[^>]*>[\s\S]*?<text>联系总部<\/text>/);
  const discover = markup('discover');
  assert.ok(discover.indexOf('discover-more') > discover.indexOf('showArticles'));
  assert.match(discover, /wx:if="{{isPublic}}"[^>]*data-page="messages"[^>]*>合作留言通知/);
});

test('public home follows the prototype order and retains public navigation', () => {
  const home = markup('home');
  const sections = ['home-public-hero', 'home-services', 'home-network"', '>集团介绍<', '>联系我们<', 'home-signin"'];
  const positions = sections.map(section => home.indexOf(section));
  assert.ok(positions[0] >= 0);
  assert.deepEqual(positions, [...new Set(positions)].sort((a, b) => a - b));
  assert.match(home, /data-page="discover" data-query="section=services"[^>]*>了解更多业务/);
  assert.match(home, /data-query="scope=public&mode=list&geo=mainland"[^>]*>[\s\S]*?国内网点/);
  assert.match(home, /data-query="scope=public&mode=list&geo=overseas"[^>]*>[\s\S]*?境外网点/);
  assert.match(home, /data-query="scope=public&mode=map"/);
  assert.match(home, /data-page="join"[^>]*>[\s\S]*?<text>申请加盟<\/text>/);
  assert.match(home, /wx:if="{{session && session.role==='public'}}"[^>]*data-page="messages"[^>]*>\s*<t-badge wx:if="{{unreadNoticeCount}}" dot="{{true}}"/);
  assert.match(home, /bindtap="openService"/);
});

test('opening another group section from a long article returns to the new content', async t => {
  const discover = nativePage('discover', t);
  const previous = global.wx;
  const scrolls = [];
  global.wx = { pageScrollTo: ({ scrollTop }) => scrolls.push(scrollTop) };
  t.after(() => { global.wx = previous; });
  discover.onLoad({ section: 'brand' });
  discover.data.state = { publicContents: [{ key: 'news', title: '发布动态' }] };
  await discover.selectSection({ currentTarget: { dataset: { section: 'news' } } });
  assert.equal(discover.data.articles[0].title, '发布动态');
  assert.deepEqual(scrolls, [0]);
});

test('sign-in shows configured methods up front with a password fallback and a separate activation and franchise link', () => {
  const login = markup('login');
  const methodGroup = login.slice(login.indexOf('class="login-methods"'), login.indexOf('data-field="password"'));
  assert.match(methodGroup, /wx:if="{{smsEnabled}}"[^>]*data-mode="sms"[^>]*>手机验证码登录/);
  assert.match(methodGroup, /wx:if="{{wechatEnabled}}"[^>]*bindtap="wechatLogin"[^>]*>微信登录/);
  assert.match(methodGroup, /data-mode="password"[^>]*>账号密码登录/);
  assert.match(login, /data-mode="activate"[^>]*>首次激活/);
  assert.match(login, /data-mode="methods"[^>]*>返回登录/);
  assert.match(login, /bindtap="applyForFranchise"[^>]*>申请加盟/);
  assert.match(login, /总部发放的一次性激活码/);
  assert.match(login, /class="activation-visibility"[^>]*data-field="{{item.name}}"[^>]*bindtap="toggleActivationVisibility"/);
  assert.match(login, /class="primary activation-submit"[^>]*bindtap="activate"/);
  assert.equal([...login.matchAll(/bindtap="wechatLogin"/g)].length, 1);
});

test('sign-in lets the visitor switch to the password fallback or start a franchise application', async t => {
  const calls = navigation(t);
  t.mock.method(api, 'request', async () => ({ authCapabilities: { mode: 'real', wechat: true, sms: true } }));
  const login = nativePage('login', t);
  const select = mode => login.mode({ currentTarget: { dataset: { mode } } });
  await login.onShow();
  assert.equal(login.data.mode, 'methods');
  assert.equal(login.data.wechatEnabled, true);
  assert.equal(login.data.smsEnabled, true);
  select('password');
  assert.equal(login.data.mode, 'password');
  select('methods');
  select('sms');
  assert.equal(login.data.mode, 'sms');
  login.applyForFranchise();
  assert.deepEqual(calls, [{ method: 'navigateTo', url: '/pages/join/index' }]);
});

test('public home refreshes only the visitor unread state and clears it for a shared member view', async t => {
  navigation(t);
  global.wx.getStorageSync = () => undefined;
  const home = nativePage('home', t);
  home.route = 'pages/home/index';
  home.onLoad({ scope: 'public' });
  let session = { role: 'public', token: 'visitor' };
  t.mock.method(api, 'session', () => session);
  t.mock.method(api, 'request', async () => ({ actor: session.role === 'public' ? 'public' : 'partnerA' }));
  const reads = [];
  let total = 8;
  t.mock.method(api, 'collection', async (name, filters) => {
    if (name === 'messages') reads.push([name, filters]);
    return { items: [], total: name === 'messages' ? total : 0, limit: 1, offset: 0, hasMore: false };
  });
  await home.onShow();
  assert.equal(home.data.unreadNoticeCount, 8);
  total = 0;
  await home.onShow();
  assert.equal(home.data.unreadNoticeCount, 0);
  session = { role: 'partner', token: 'member' };
  home.setData({ unreadNoticeCount: 8 });
  await home.onShow();
  assert.equal(home.data.unreadNoticeCount, 0);
  assert.deepEqual(reads, [
    ['messages', { status: 'unread', limit: 1 }],
    ['messages', { status: 'unread', limit: 1 }],
  ]);
});

test('the notices switch uses a red-dot indicator without displaying the count', () => {
  const matters = markup('tasks');
  const switchButton = matters.match(/<button[^>]*data-section="notices"[^>]*>通知[\s\S]*?<\/button>/)?.[0];
  assert.ok(switchButton);
  assert.match(switchButton, /aria-label="{{hasLoaded && noticeUnread \? '通知，有未读消息' : '通知'}}"/);
  assert.match(switchButton, /<text wx:if="{{hasLoaded && noticeUnread}}" class="matters-unread" aria-hidden="true"\/>/);
  assert.doesNotMatch(switchButton, /{{noticeUnread}}/);
});

test('business records, tasks and notices render in mutually exclusive branches', () => {
  const matters = markup('tasks');
  assert.match(matters, /<block wx:if="{{hasLoaded && !loading && section==='records' && !isPublic}}">[\s\S]*?<\/block>\s*<block wx:elif="{{hasLoaded && section==='tasks' && !isPublic}}">/);
  assert.match(matters, /<block wx:elif="{{hasLoaded && section!=='records'}}">\s*<view class="filter">/);
});

test('sign-in resumes the exact guarded notices filter', t => {
  const calls = navigation(t);
  const loginUrl = memberLoginUrl('tasks', { section: 'notices', status: 'unread' });
  resumeAfterLogin(new URL(loginUrl, 'https://example.test').searchParams.get('next'));
  assert.deepEqual(calls, [
    { method: 'reLaunch', url: '/pages/home/index' },
    { method: 'navigateTo', url: '/pages/tasks/index?section=notices&status=unread' },
  ]);
});

test('personal activation sends partners back to their report and keeps both HQ roles at the HQ handoff', async t => {
  const calls = navigation(t);
  const { createServer } = require('../server/index.cjs');
  const { server, store } = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    config.apiBase = base;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const reads = [];
  global.wx.request = options => {
    const path = new URL(options.url).pathname;
    reads.push({ path, authorization: options.header.Authorization });
    fetch(options.url, {
      method: options.method, headers: options.header,
      body: options.method === 'GET' ? undefined : JSON.stringify(options.data),
    }).then(async response => options.success({ statusCode: response.status, data: await response.json() }), options.fail);
  };
  const manager = await api.login('manager');
  const credentials = [
    { actor: 'partnerA', role: 'partner' },
    { actor: 'native_hq_manager', role: 'manager' },
    { actor: 'native_hq_ops', role: 'ops' },
  ];
  const adminHeaders = { Authorization: 'Bearer ' + manager.token };
  for (const { actor, role } of credentials) {
    if (role !== 'partner') {
      await api.request('/api/commands', 'POST', {
        command: 'staff.create', payload: { subject: actor, role, name: '隔离身份验证', reason: '验收个人激活入口' },
      }, { ...adminHeaders, 'Idempotency-Key': randomUUID() });
    }
    const invite = await api.request('/api/auth/activation', 'POST', { actor, username: actor }, adminHeaders);
    const login = nativePage('login', t);
    const next = 'report?outlet=zz&month=2026-10';
    const password = 'Isolated-Activation-2026';
    wx.removeStorageSync('jyyc.session');
    login.onLoad({ token: invite.token, next, role: role === 'partner' ? 'manager' : 'partner', staffPortalUrl: 'https://untrusted.test/' });
    await login.onShow();
    login.setData({ password, confirmPassword: password });
    calls.length = 0;
    await login.activate();
    if (role === 'partner') {
      assert.equal(api.session().role, 'partner');
      assert.deepEqual(calls, [
        { method: 'reLaunch', url: '/pages/home/index' },
        { method: 'navigateTo', url: '/pages/report/index?outlet=zz&month=2026-10' },
      ]);
      continue;
    }
    assert.equal(login.data.mode, 'staff');
    assert.equal(login.data.staffPortalUrl, '');
    assert.equal(login.data.sessionCleanupError, '');
    assert.equal(api.session(), null);
    assert.deepEqual(calls, []);
    const logout = reads.findLast(call => call.path === '/api/auth/logout');
    await assert.rejects(api.request('/api/context', 'GET', undefined, { Authorization: logout.authorization }), { status: 401 });
    const webSession = await api.request('/api/auth/password', 'POST', { username: invite.username, password });
    const webHeaders = { Authorization: 'Bearer ' + webSession.token };
    assert.equal(webSession.role, role);
    assert.equal((await api.request('/api/context', 'GET', undefined, webHeaders)).actor, role);
    const otherLogin = nativePage('login', t);
    otherLogin.onLoad({ next });
    otherLogin.setData({ username: invite.username, password });
    await otherLogin.passwordLogin();
    assert.equal(otherLogin.data.mode, 'staff');
    assert.equal(api.session(), null);
    assert.deepEqual(calls, []);
    assert.equal((await api.request('/api/context', 'GET', undefined, webHeaders)).actor, role);
    login.returnToPublic();
    assert.deepEqual(calls, [{ method: 'reLaunch', url: '/pages/home/index' }]);
  }
});

test('restored HQ sessions reach the confirmation screen before a private or workbench read', async t => {
  const calls = navigation(t);
  const staff = { token: 'staff-token', role: 'regional' };
  wx.setStorageSync('jyyc.session', staff);
  t.mock.method(api, 'request', async path => {
    assert.equal(path, '/api/config');
    return { staffPortalUrl: 'https://headquarters.example.test/' };
  });
  t.mock.method(api, 'logout', async options => {
    assert.deepEqual(options, { token: staff.token, navigate: false });
    wx.removeStorageSync('jyyc.session');
    return { loggedOut: false, cleared: true };
  });
  assert.equal(tabBarView('reports', staff).selected, '');
  const report = nativePage('report', t);
  report.onLoad({ outlet: 'zz', month: '2026-10' });
  await report.onShow();
  assert.equal(report.data.state, null);
  assert.deepEqual(calls, [{ method: 'reLaunch', url: '/pages/login/index' }]);
  const home = nativePage('home', t);
  home.onLoad({});
  await home.onShow();
  assert.equal(home.data.state, null);
  assert.deepEqual(calls.at(-1), { method: 'reLaunch', url: '/pages/login/index' });
  const join = nativePage('join', t);
  join.onLoad({});
  await join.onShow();
  assert.deepEqual(join.data.applications, []);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), { method: 'reLaunch', url: '/pages/login/index' });
  const login = nativePage('login', t);
  login.onLoad({ staffPortalUrl: 'https://untrusted.test/' });
  await login.onShow();
  assert.equal(login.data.mode, 'staff');
  assert.match(login.data.sessionCleanupError, /服务器暂未确认/);
  const clipboard = [];
  wx.setClipboardData = options => clipboard.push(options.data);
  login.copyStaffPortal();
  assert.deepEqual(clipboard, ['https://headquarters.example.test/']);
  assert.equal(api.session(), null);
  login.returnToPublic();
  assert.deepEqual(calls.at(-1), { method: 'reLaunch', url: '/pages/home/index' });
});

test('the HQ handoff keeps public navigation blocked until local cleanup succeeds', async t => {
  const calls = navigation(t);
  wx.setStorageSync('jyyc.session', { token: 'old-finance-token', role: 'finance' });
  wx.request = ({ url, success }) => success({ statusCode: 200, data: { data:
    new URL(url).pathname === '/api/config' ? { staffPortalUrl: 'http://headquarters.example.test/' } : { loggedOut: true },
  } });
  const remove = wx.removeStorageSync;
  wx.removeStorageSync = key => {
    if (key === 'jyyc.session') throw new Error('local storage temporarily unavailable');
    remove(key);
  };
  const login = nativePage('login', t);
  login.onLoad({});
  await login.onShow();
  assert.equal(login.data.mode, 'staff');
  assert.equal(login.data.staffPortalUrl, '');
  assert.equal(login.data.sessionCleanupRequired, true);
  assert.match(login.data.sessionCleanupError, /本机登录状态暂未清除/);
  login.returnToPublic();
  assert.deepEqual(calls, []);
  wx.removeStorageSync = remove;
  await login.retrySessionCleanup();
  assert.equal(api.session(), null);
  assert.equal(login.data.sessionCleanupRequired, false);
  assert.equal(login.data.sessionCleanupError, '');
  login.returnToPublic();
  assert.deepEqual(calls, [{ method: 'reLaunch', url: '/pages/home/index' }]);
});

test('visitor sign-in drops the private destination and an unrecognized role stays at sign-in', async t => {
  const calls = navigation(t);
  const login = nativePage('login', t);
  const next = 'report?outlet=zz&month=2026-10';
  login.onLoad({ next, role: 'partner' });
  const unknown = { token: 'unexpected', role: 'futureRole' };
  t.mock.method(api, 'logout', async options => {
    assert.deepEqual(options, { token: unknown.token, navigate: false });
    wx.removeStorageSync('jyyc.session');
    return { loggedOut: true, cleared: true };
  });
  await login.run(async () => {
    wx.setStorageSync('jyyc.session', unknown);
    return unknown;
  });
  assert.match(login.data.error, /账号权限/);
  assert.notEqual(login.data.mode, 'staff');
  assert.equal(api.session(), null);
  assert.deepEqual(calls, []);
  const visitor = { role: 'public', token: 'new-visitor' };
  t.mock.method(api, 'ensureVisitor', async () => {
    wx.setStorageSync('jyyc.session', visitor);
    return visitor;
  });
  await login.visitor();
  assert.deepEqual(calls, [{ method: 'reLaunch', url: '/pages/home/index' }]);
});

test('settled figures stay available through the report list and are dated on the dashboard', () => {
  const home = markup('home');
  assert.doesNotMatch(home, /data-page="dashboard"/);
  assert.match(markup('reports'), /data-page="dashboard"[^>]*>查看经营看板/);
  assert.match(markup('dashboard'), /{{periodDisplay}}/);
});
