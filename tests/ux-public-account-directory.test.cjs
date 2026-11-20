const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');

function page(name, query = {}) {
  let definition;
  const file = require.resolve('../miniprogram/pages/' + name + '/index.js');
  const previous = global.Page;
  global.Page = value => { definition = value; };
  try {
    delete require.cache[file];
    require(file);
  } finally {
    global.Page = previous;
  }
  const instance = {
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
  instance.onLoad(query);
  return instance;
}

async function runtime(t, { failPath } = {}) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock', SMS_PROVIDER: 'disabled' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previousBase = config.apiBase;
  const previousWx = global.wx;
  const storage = new Map();
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    async request(options) {
      const requestPath = new URL(options.url).pathname;
      if (requestPath === failPath) return options.fail();
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        options.success({ statusCode: response.status, data: await response.json() });
      } catch (error) {
        options.fail(error);
      }
    },
  };
  t.after(async () => {
    global.wx = previousWx;
    config.apiBase = previousBase;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  return { app, storage };
}

test('account entry stays visible when the optional organization lookup fails', async t => {
  await runtime(t, { failPath: '/api/collections/organizations/p1' });
  await api.login('partnerA');
  const profile = page('profile');
  await profile.onShow();
  assert.equal(profile.data.error, '');
  assert.ok(profile.data.managerName);
  assert.equal(profile.data.organizationName, '');
  assert.equal(profile.data.outletCount, 3);
});

test('public directory loads the country options before the visitor selects a country', async t => {
  const { app } = await runtime(t);
  await api.login('manager');
  const body = {
    owner: 'p1', countryCode: 'SG', city: '新加坡', name: '公开目录隔离网点',
    address: '公开目录隔离地址', phone: '0000', opening: '2026-11-10',
    enrollmentApplicable: false, status: 'open',
  };
  const id = 'ux-public-directory-outlet';
  const state = app.store.load();
  state.outlets.push({ ...state.outlets.find(outlet => outlet.id === 'gz'), ...body, id, outlet: id });
  app.store.save(state);
  await api.command('public.profile', {
    outlet: id, countryCode: 'SG', city: '新加坡', title: body.name, address: body.address,
    description: '公开目录隔离资料', services: ['公开服务'], published: true, reason: '目录回归隔离记录',
  });
  await api.visitor();
  const directory = page('outlets', {scope:'public', mode:'list'});
  await directory.onShow();
  assert.equal(directory.data.error, '');
  const index = directory.data.countryChoices.findIndex(choice => choice.code === 'SG');
  assert.ok(index > 0, 'Singapore is selectable on the first tap');
  await directory.filterCountry({ detail: { value: index } });
  assert.deepEqual(directory.data.rows.map(outlet => [outlet.id, outlet.address]), [[id, body.address]]);
});

test('cooperation success and notification spotlight the same authorized record', async t => {
  const { storage } = await runtime(t);
  await api.visitor();
  const visitorSession = api.session();
  const form = page('discover', { section: 'cooperation' });
  await form.onShow();
  form.setData({ privacyConsented: true, form: {
    company: '隔离合作验收', name: '验收联系人', contact: '13800005555', message: '请告知合作资料提交渠道。',
  } });
  await form.submitCooperation();
  const id = form.data.cooperationRows[0].id;
  assert.equal(form.data.selectedCooperation?.id, id);
  assert.equal(form.data.selectedCooperation.status, 'submitted');
  await api.login('ops');
  await api.command('cooperation.update', { id, status: 'received', note: '内部记录隔离' });
  storage.set('jyyc.session', visitorSession);
  const detail = page('discover', { section: 'cooperation', id });
  await detail.onShow();
  assert.equal(detail.data.selectedCooperation?.id, id);
  assert.equal(detail.data.selectedCooperation.status, 'received');
  assert.equal(detail.data.selectedCooperation.processingNote, undefined);
  await api.visitor();
  const otherVisitor = page('discover', { section: 'cooperation', id });
  await otherVisitor.onShow();
  assert.equal(otherVisitor.data.selectedCooperation, null);
  assert.ok(otherVisitor.data.error);
});
