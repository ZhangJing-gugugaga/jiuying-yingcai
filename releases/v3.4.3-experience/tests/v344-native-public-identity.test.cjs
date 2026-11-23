const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');
const native = path.resolve(__dirname, '../miniprogram');

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

test('public home exposes directory and login, with a guest login action in profile', async t => {
  const { routes, requests } = await runtime(t);
  const home = page('home');
  await home.onShow();
  assert.equal(home.data.isPublic, true);
  const homeMarkup = wxml('home');
  assert.match(homeMarkup, /wx:if="{{isPublic}}"[^>]*data-page="login"[^>]*>加盟商登录/);
  assert.match(homeMarkup, /data-page="outlets" data-query="scope=public&mode=list"[^>]*>查找服务网点/);
  assert.ok(homeMarkup.indexOf('查找服务网点') < homeMarkup.indexOf('五大业务'));
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
  assert.deepEqual(routes.at(-1), { method: 'switchTab', url: '/pages/support/index' });
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

test('cooperation submission shows its own record and can be reopened after using a different filter', async t => {
  const { requests } = await runtime(t);
  const discover = page('discover', { section: 'cooperation' });
  await discover.onShow();
  await discover.filterCooperation(tap({ status: 'closed' }));
  assert.equal(discover.data.cooperationStatus, 'closed');
  discover.setData({
    privacyConsented: true,
    form: { company: '隔离验收机构', name: '业务负责人', contact: '13800001234', message: '隔离环境合作咨询' },
  });
  await discover.submitCooperation();
  const selected = discover.data.selectedCooperation;
  assert.equal(discover.data.cooperationStatus, 'all');
  assert.equal(selected.company, '隔离验收机构');
  assert.equal(selected.status, 'submitted');
  assert.equal(discover.query.id, selected.id);
  assert.match(wxml('discover'), /id="cooperation-current"/);
  await discover.filterCooperation(tap({ status: 'closed' }));
  assert.equal(discover.data.selectedCooperation, null);
  const reopened = page('discover', { section: 'cooperation', id: selected.id });
  await reopened.onShow();
  assert.equal(reopened.data.selectedCooperation.id, selected.id);
  const command = requests.find(row => row.path === '/api/commands');
  assert.equal(command.status, 200);
  t.diagnostic(JSON.stringify({ recordId: selected.id, requestId: command.requestId, status: selected.status }));
});
