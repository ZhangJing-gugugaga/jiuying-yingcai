'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=';
const tap = dataset => ({ currentTarget: { dataset } });
const change = value => ({ detail: { value } });

function page(name, query = {}) {
  const previousPage = global.Page;
  let definition;
  global.Page = value => { definition = value; };
  try {
    const filename = require.resolve('../miniprogram/pages/' + name + '/index');
    delete require.cache[filename];
    require(filename);
  } finally {
    global.Page = previousPage;
  }
  const screen = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(values, updated) {
      for (const [path, value] of Object.entries(values)) {
        const parts = path.split('.');
        const current = parts.slice(0, -1).reduce((state, key) => state[key] ||= {}, this.data);
        current[parts.at(-1)] = value;
      }
      updated?.();
    },
  };
  screen.onLoad(query);
  return screen;
}

async function fixture(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  const storage = new Map();
  const navigations = [];
  const scrolls = [];
  const commands = [];
  const previous = { wx: global.wx, base: config.apiBase };
  t.after(async () => {
    global.wx = previous.wx;
    config.apiBase = previous.base;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    navigateTo: ({ url }) => navigations.push(url),
    pageScrollTo: ({ selector }) => scrolls.push(selector),
    showToast() {},
    chooseLocation: ({ success }) => success({ latitude: 28.3, longitude: 113.2, address: '隔离地图地址' }),
    chooseMedia: ({ success }) => success({ tempFiles: [{ tempFilePath: '/location.png', size: 68 }] }),
    getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: png }) }),
    async request(options) {
      try {
        const response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        const data = await response.json();
        if (options.url.endsWith('/api/commands')) {
          commands.push({
            command: options.data.command,
            resultId: data.data?.result?.id,
            requestId: response.headers.get('x-request-id'),
            status: response.status,
          });
        }
        options.success({ statusCode: response.status, data });
      } catch (error) {
        options.fail(error);
      }
    },
  };
  await api.login('partnerA');
  return { app, commands, navigations, scrolls };
}

test('operating pause leads back to the same outlet for a separate billing pause', async t => {
  const { app, commands, navigations } = await fixture(t);
  const generic = page('requests', { type: 'statusChange', status: 'paused' });
  await generic.onShow();
  assert.equal(generic.data.outlets.filter(outlet => outlet.id).length, 3);
  assert.equal(generic.data.outlets[generic.data.outletIndex].id, '');
  await generic.submit();
  assert.match(generic.data.error, /请选择申请网点/);
  assert.equal(app.store.load().requests.length, 0);

  const branch = page('requests', { type: 'statusChange', status: 'paused', outlet: 'zz' });
  await branch.onShow();
  assert.equal(branch.data.form.status, 'paused');
  assert.equal(branch.data.outlets[branch.data.outletIndex].id, 'zz');
  branch.setData({ 'form.effectiveDate': branch.data.state.today, 'form.reason': '隔离验证暂停营业' });
  await branch.submit();
  const operating = app.store.load().requests.find(record => record.type === 'statusChange');
  assert.equal(operating.outlet, 'zz');
  assert.equal(branch.query.id, operating.id);
  assert.equal(branch.data.requestRows.find(row => row.id === operating.id).canApplyPauseFee, true);
  assert.equal(app.store.load().requests.some(record => record.type === 'pauseFee'), false);

  await api.login('ops');
  await api.command('review.request', { id: operating.id, decision: 'approve' });
  assert.equal(app.store.load().outlets.find(outlet => outlet.id === 'zz').status, 'paused');
  await api.login('partnerA');
  await branch.onShow();
  branch.applyPauseFee(tap({ id: operating.id }));
  const destination = new URL(navigations.at(-1), 'https://example.invalid');
  assert.equal(destination.pathname, '/pages/requests/index');
  assert.deepEqual(Object.fromEntries(destination.searchParams), { outlet: 'zz', type: 'pauseFee' });

  const fee = page('requests', Object.fromEntries(destination.searchParams));
  await fee.onShow();
  assert.equal(fee.data.outlets[fee.data.outletIndex].id, 'zz');
  const from = fee.data.state.today;
  fee.setData({ 'form.from': from, 'form.to': from, 'form.reason': '隔离验证独立停费' });
  await fee.submit();
  const accounting = app.store.load().requests.find(record => record.type === 'pauseFee');
  assert.equal(accounting.outlet, operating.outlet);
  assert.notEqual(accounting.id, operating.id);
  assert.equal(fee.query.id, accounting.id);
  assert.equal(app.store.load().adjustments.some(row => row.requestId === accounting.id), false);
  await api.login('finance');
  await api.command('review.request', { id: accounting.id, decision: 'approve' });
  assert.ok(app.store.load().adjustments.some(row => row.requestId === accounting.id && row.amount === null));
  assert.ok(commands.every(entry => entry.status === 200 && entry.requestId));
  t.diagnostic(JSON.stringify({ outlet: 'zz', operating: operating.id, pauseFee: accounting.id, commands }));
});

test('location submission returns to the exact monthly record and manual coordinates never pass as GPS', async t => {
  const { app, commands, scrolls } = await fixture(t);
  const screen = page('location');
  await screen.onShow();
  assert.equal(screen.data.outlets.length, 3);
  assert.equal(screen.data.outletId, '');
  assert.equal(screen.data.canSubmitEvidence, false);
  const month = screen.data.state.today.slice(0, 7);
  const outletIndex = screen.data.outlets.findIndex(outlet => outlet.id === 'zz');
  await screen.chooseOutletFromPicker(change(outletIndex + 1));
  await screen.chooseMonth(change(month));
  await screen.locate(tap({ manual: 'true' }));
  await screen.photo();
  await screen.submit();
  const [record] = app.store.load().verifications;
  assert.equal(record.outlet, 'zz');
  assert.equal(record.month, month);
  assert.equal(record.coords.source, 'manual');
  assert.equal(record.status, 'pending');
  assert.equal(screen.query.id, record.id);
  assert.equal(scrolls.at(-1), '#verification-' + record.id);
  assert.match(screen.data.submissionNotice, /现场定位尚未完成/);
  const reopened = page('location', { outlet: 'zz', month, id: record.id });
  await reopened.onShow();
  assert.equal(reopened.data.history[0].id, record.id);
  assert.match(reopened.data.monthStatus, /现场定位尚未完成/);
  await api.login('location');
  await assert.rejects(() => api.command('location.review', { id: record.id, decision: 'approve' }), { code: 'GPS_REQUIRED' });
  assert.equal(app.store.load().verifications[0].status, 'pending');
  assert.ok(commands.every(entry => entry.requestId));
  t.diagnostic(JSON.stringify({ outlet: 'zz', month, record: record.id, commands }));
});
