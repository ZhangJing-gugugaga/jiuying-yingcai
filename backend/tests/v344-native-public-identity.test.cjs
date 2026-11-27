const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');
const config = require('../../miniprogram/config');
const api = require('../../miniprogram/utils/api');
const native = path.resolve(__dirname, '../../miniprogram');

function page(name, query = {}) {
  let definition;
  const previous = global.Page;
  const filename = path.join(native, 'pages', name, 'index.js');
  global.Page = value => { definition = value; };
  try {
    delete require.cache[require.resolve(filename)];
    require(filename);
  } finally {
    global.Page = previous;
  }
  const result = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        const fields = key.split('.');
        let target = this.data;
        for (const name of fields.slice(0, -1)) target = target[name] ||= {};
        target[fields.at(-1)] = value;
      }
    },
  };
  result.onLoad(query);
  return result;
}

async function runtime(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock', SMS_PROVIDER: 'disabled' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const priorBase = config.apiBase;
  const priorWx = global.wx;
  const storage = new Map();
  const routes = [];
  const requests = [];
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const navigate = method => ({ url, success }) => { routes.push({ method, url }); success?.(); };
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    navigateTo: navigate('navigateTo'),
    reLaunch: navigate('reLaunch'),
    switchTab: navigate('switchTab'),
    async request(options) {
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        const data = await response.json();
        requests.push({ path: new URL(options.url).pathname, status: response.status, requestId: data.requestId });
        options.success({ statusCode: response.status, data });
      } catch (error) {
        options.fail(error);
      }
    },
  };
  t.after(async () => {
    global.wx = priorWx;
    config.apiBase = priorBase;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  return { storage, routes, requests };
}

const tap = dataset => ({ currentTarget: { dataset } });
const wxml = name => fs.readFileSync(path.join(native, 'pages', name, 'index.wxml'), 'utf8');

test('public business and details stay usable when the FAQ service fails', async t => {
  const { routes } = await runtime(t);
  await api.login('manager');
  await api.command('content.service.save', {
    slot: 1, title: '隔离验证业务', summary: '隔离验证摘要', body: '隔离验证正文',
    published: true, reason: '隔离回归',
  });
  await api.visitor();
  const transport = wx.request;
  let faqCalls = 0;
  wx.request = options => {
    if (new URL(options.url).pathname !== '/api/collections/faqEntries') return transport(options);
    faqCalls++;
    options.fail({ errMsg: 'request:fail connection reset' });
  };
  const discover = page('discover', { section: 'services' });
  await discover.onShow();
  assert.equal(discover.data.error, '');
  assert.equal(faqCalls, 0);
  const service = discover.data.serviceRows.find(item => item.available);
  assert.equal(service.title, '隔离验证业务');
  discover.openService(tap({ id: service.id }));
  assert.equal(routes.at(-1).url, '/pages/service-detail/index?id=' + service.id);
  const detail = page('service-detail', { id: service.id });
  await detail.onShow();
  assert.equal(detail.data.service.body, '隔离验证正文');
  await discover.selectSection(tap({ section: 'faq' }));
  assert.equal(faqCalls, 1);
  assert.match(discover.data.error, /网络/);
  await discover.selectSection(tap({ section: 'services' }));
  assert.equal(discover.data.error, '');
  assert.equal(discover.data.serviceRows.find(item => item.available).id, service.id);
});

test('an unavailable member map exposes the same authorised address list and can retry', async t => {
  const { routes } = await runtime(t);
  await api.login('partnerA');
  const outlets = page('outlets', { scope: 'private' });
  await outlets.onShow();
  assert.equal(outlets.data.directory, false);
  assert.match(wxml('outlets'), /!directory && mode==='list'[\s\S]*?data-mode="map" bindtap="mode"/);
  await outlets.mode(tap({mode:'map'}));
  assert.equal(outlets.data.mode, 'map');
  assert.ok(outlets.data.markers.length);
  const rows = outlets.data.rows;
  const expectedIds = rows.map(row => row.id);
  outlets.mapFailed();
  assert.match(outlets.data.mapError, /网点地址/);
  assert.deepEqual(outlets.data.rows.map(row => row.id), expectedIds);
  assert.match(wxml('outlets'), /mode==='list' \|\| mapError/);
  assert.match(wxml('outlets'), /wx:if="{{mapError}}"[\s\S]*?bindtap="modeUnavailable">返回网点列表/);
  outlets.open(tap({ id: rows[0].id }));
  assert.equal(routes.at(-1).url, '/pages/outlet/index?id=' + rows[0].id);
  await outlets.retryMap();
  assert.equal(outlets.data.mapError, '');
  assert.deepEqual(outlets.data.rows.map(row => row.id), expectedIds);
  assert.ok(outlets.data.markers.length);
  outlets.mapFailed();
  const search = outlets.data.search;
  outlets.modeUnavailable();
  assert.equal(outlets.data.mode, 'list');
  assert.equal(outlets.data.mapError, '');
  assert.equal(outlets.data.search, search);
  assert.deepEqual(outlets.data.rows.map(row => row.id), expectedIds);
});

test('public home exposes directory and login, with a guest login action in profile', async t => {
  const { routes, requests } = await runtime(t);
  const home = page('home');
  await home.onShow();
  assert.equal(home.data.isPublic, true);
  assert.equal(home.data.publicView, true);
  assert.equal(home.data.session.role, 'public');
  const homeMarkup = wxml('home');
  assert.match(homeMarkup, /<button wx:if="{{!session \|\| session.role==='public'}}"[^>]*data-page="login"[^>]*>[\s\S]*?加盟商登录/);
  home.nav(tap({ page: 'login' }));
  assert.deepEqual(routes.at(-1), { method: 'navigateTo', url: '/pages/login/index' });
  assert.match(homeMarkup, /data-page="outlets" data-query="scope=public&mode=list&geo=mainland"[^>]*>[\s\S]*?国内网点/);
  assert.ok(homeMarkup.indexOf('>五大业务</view>') < homeMarkup.indexOf('>国内网点</text>'));
  home.nav(tap({ page: 'outlets', query: 'scope=public&mode=list' }));
  assert.deepEqual(routes.at(-1), { method: 'switchTab', url: '/pages/outlets/index' });
  assert.equal(requests.filter(row => row.path === '/api/auth/visitor').length, 1);
  const profile = page('profile');
  await profile.onShow();
  assert.equal(profile.data.isPublic, true);
  assert.match(wxml('profile'), /wx:if="{{isPublic}}"[^>]*data-page="login"[^>]*>加盟商登录/);
  assert.match(wxml('profile'), /wx:if="{{session && !isPublic}}"[^>]*bindtap="logout"/);
});

test('login offers a separate activation action, only configured login methods and reachable help', async t => {
  const { routes, requests } = await runtime(t);
  const login = page('login');
  await login.onShow();
  assert.equal(login.data.smsEnabled, false);
  assert.equal(login.data.wechatEnabled, false);
  login.mode(tap({ mode: 'sms' }));
  assert.equal(login.data.mode, 'password');
  login.mode(tap({ mode: 'wechat' }));
  assert.equal(login.data.mode, 'password');
  login.mode(tap({ mode: 'activate' }));
  assert.equal(login.data.mode, 'activate');
  const markup = wxml('login');
  assert.match(markup, /data-mode="activate"[^>]*>首次激活/);
  assert.match(markup, /wx:if="{{smsEnabled}}"[^>]*data-mode="sms"/);
  assert.match(markup, /wx:if="{{wechatEnabled}}"[^>]*data-mode="wechat"/);
  login.contact();
  assert.deepEqual(routes.at(-1), { method: 'navigateTo', url: '/pages/support/index?section=home' });
  assert.deepEqual(requests.map(row => row.path), ['/api/config']);
});

test('first activation reaches the workbench and returning password sign-in resumes the guarded record', async t => {
  const { storage, routes, requests } = await runtime(t);
  await api.login('manager');
  const username = 'v344-native-owner';
  const invitation = await api.request('/api/auth/activation', 'POST', { actor: 'partnerA', username });
  const password = 'Native-Test-Password-344!';
  storage.delete('jyyc.session');
  const activation = page('login', { token: invitation.token });
  assert.equal(activation.data.mode, 'activate');
  activation.setData({ password, confirmPassword: password });
  await activation.activate();
  assert.equal(api.session().role, 'partner');
  assert.equal(activation.data.password, '');
  assert.equal(activation.data.activationToken, '');
  assert.deepEqual(routes.at(-1), { method: 'reLaunch', url: '/pages/home/index' });

  storage.delete('jyyc.session');
  await api.ensureVisitor();
  const visitor = api.session().token;
  const next = 'report?outlet=cs&month=2026-10';
  const browse = page('login', { next });
  await browse.visitor();
  assert.ok(api.session().token === visitor, 'returning to public browsing keeps the visitor session');
  assert.deepEqual(routes.at(-1), { method: 'reLaunch', url: '/pages/home/index' });
  const login = page('login', { next: encodeURIComponent(next) });
  login.setData({ username, password });
  await login.passwordLogin();
  assert.equal(api.session().actor, 'partnerA');
  assert.deepEqual(routes.slice(-2), [
    { method: 'reLaunch', url: '/pages/home/index' },
    { method: 'navigateTo', url: '/pages/report/index?outlet=cs&month=2026-10' },
  ]);
  const home = page('home');
  await home.onShow();
  assert.equal(home.data.isPublic, false);
  assert.equal(home.data.outletCount, 3);
  t.diagnostic(JSON.stringify(requests.filter(row => ['/api/auth/activate', '/api/auth/password', '/api/context'].includes(row.path))));
});
