const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const app = require('../miniprogram/app.json');
const { getNativeRoutes } = require('../scripts/wechat-routes.cjs');
const { go, memberLoginUrl, resumeAfterLogin } = require('../miniprogram/utils/navigation');

function markup(name) {
  return readFileSync(require.resolve('../miniprogram/pages/' + name + '/index.wxml'), 'utf8');
}

function navigation(t) {
  const calls = [];
  const previous = global.wx;
  const navigate = method => ({ url, success }) => { calls.push({ method, url }); success(); };
  global.wx = { navigateTo: navigate('navigateTo'), switchTab: navigate('switchTab'), reLaunch: navigate('reLaunch') };
  t.after(() => { global.wx = previous; });
  return calls;
}

function nativePage(name, t) {
  const previous = global.Page;
  const entry = require.resolve('../miniprogram/pages/' + name + '/index.js');
  let definition;
  global.Page = value => { definition = value; };
  try { require(entry); } finally { global.Page = previous; }
  t.after(() => { delete require.cache[entry]; });
  return {
    ...definition,
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
  assert.equal(routes.length, 20);
  assert.ok(mainPages.includes('pages/reports/index'));
  assert.ok(routes.includes('pages/training/index'));
});

test('workbench keeps non-Tab journeys and opens the unified matters filters', () => {
  const home = markup('home');
  assert.deepEqual([...home.matchAll(/class="home-tool" data-page="([a-z-]+)"/g)].map(match => match[1]),
    ['location', 'fees', 'tasks']);
  assert.match(home, /class="home-tool" data-page="location"[^>]*>月度位置核验/);
  assert.match(home, /class="home-tool" data-page="tasks"[^>]*>.*我的事项/);
  assert.match(home, /data-page="tasks" data-query="section=notices&status=unread"/);
  assert.match(home, /data-page="tasks" data-query="status=in_progress"/);
  assert.match(home, /bindtap="openTodo"/);
  assert.doesNotMatch(home, /data-page="(?:messages|training|requests|finance|agreements)"/);
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
  assert.deepEqual([...profile.matchAll(/data-page="([a-z-]+)"/g)].map(match => match[1]), ['login', 'security', 'discover', 'discover', 'support']);
  assert.match(profile, /bindtap="privacy"/);
  assert.match(profile, /bindtap="logout"/);
});

test('group updates, cases and cooperation use a secondary group entrance', () => {
  const home = markup('home');
  assert.doesNotMatch(home, /openPublicUpdate/);
  assert.match(home, /data-page="discover" data-query="section=cooperation"/);
  assert.match(home, /data-page="discover" data-query="section=brand"/);
  assert.match(home, /data-page="support"[^>]*>联系总部/);
  const discover = markup('discover');
  assert.ok(discover.indexOf('discover-more') > discover.indexOf('showArticles'));
  assert.match(discover, /wx:if="{{isPublic}}"[^>]*data-page="messages"[^>]*>合作留言通知/);
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

test('sign-in shows one available method group and a single separate activation or return action', () => {
  const login = markup('login');
  const modeButtons = [...login.matchAll(/<button\b[^>]*data-mode="password"[^>]*>([^<]+)<\/button>/g)];
  assert.deepEqual(modeButtons.map(match => match[1]), ['返回登录']);
  assert.match(login, /wx:if="{{mode==='password'}}"[^>]*data-mode="activate"[^>]*>首次激活/);
  assert.match(login, /wx:else[^>]*data-mode="password"[^>]*>返回登录/);
  assert.match(login, /wx:if="{{smsEnabled}}"[^>]*data-mode="sms"/);
  assert.match(login, /wx:if="{{wechatEnabled}}"[^>]*bindtap="wechatLogin"/);
  assert.equal([...login.matchAll(/bindtap="wechatLogin"/g)].length, 1);
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

test('an earlier settled month is dated separately from the current month overview', () => {
  const home = markup('home');
  assert.match(home, /本月数据尚未结算/);
  assert.match(home, /wx:if="{{latestSettledMonth}}"[^>]*bindtap="openSettled"[^>]*>查看\s*{{latestSettledMonthText}}\s*已结算数据/);
});
