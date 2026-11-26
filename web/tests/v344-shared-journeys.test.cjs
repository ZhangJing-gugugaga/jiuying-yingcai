const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');
const config = require('../../miniprogram/config');
const { define, api, openRecord, canOpenRecord } = require('../../miniprogram/utils/page');
const navigation = require('../../miniprogram/utils/navigation');

async function useNativeRuntime(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = { wx: global.wx, apiBase: config.apiBase };
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map();
  const requests = [];
  const routes = [];
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    reLaunch({ url, success }) { routes.push(url); success?.(); },
    navigateTo({ url, success }) { routes.push(url); success?.(); },
    async request(options) {
      const url = new URL(options.url);
      requests.push(url.pathname + url.search);
      try {
        const response = await fetch(url, {
          method: options.method,
          headers: options.header,
          ...(options.method !== 'GET' ? { body: JSON.stringify(options.data) } : {}),
        });
        options.success({ statusCode: response.status, data: await response.json() });
      } catch (error) {
        options.fail(error);
      }
    },
  };
  t.after(async () => {
    global.wx = previous.wx;
    config.apiBase = previous.apiBase;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  return { requests, routes };
}

function instance(name, query = {}) {
  const page = define({});
  page.route = 'pages/' + name + '/index';
  page.setData = values => Object.assign(page.data, values);
  page.onLoad(query);
  return page;
}

test('a clean public launch and concurrent public access share one authenticated visitor request', async t => {
  const { requests, routes } = await useNativeRuntime(t);
  const home = instance('home');
  const directory = instance('outlets');
  await Promise.all([home.onShow(), directory.onShow()]);
  assert.deepEqual(routes, []);
  assert.equal(requests.filter(path => path === '/api/auth/visitor').length, 1);
  assert.equal(home.data.isPublic, true);
  assert.equal(directory.data.isPublic, true);
  assert.equal(home.data.session.role, 'public');
});

test('visitor opening a private report preserves its safe destination for member login', async t => {
  const { requests, routes } = await useNativeRuntime(t);
  await api.visitor();
  await instance('report', { outlet: 'cs', month: '2026-10', id: 'rpt-example' }).onShow();
  const login = new URL(routes[0], 'https://www.example.invalid');
  assert.equal(login.pathname, '/pages/login/index');
  assert.equal(login.searchParams.get('next'), 'report?outlet=cs&month=2026-10&id=rpt-example');
  assert.deepEqual(requests, ['/api/auth/visitor']);
  await api.login('partnerA');
  navigation.resumeAfterLogin(login.searchParams.get('next'));
  assert.deepEqual(routes.slice(1), ['/pages/home/index', '/pages/report/index?outlet=cs&month=2026-10&id=rpt-example']);
  navigation.resumeAfterLogin('https://www.example.invalid/report');
  navigation.resumeAfterLogin('report?token=example');
  assert.deepEqual(routes.slice(3), ['/pages/home/index', '/pages/home/index']);
});

test('training notice opens the authorized record and preserves the recorded outlet', async t => {
  const { routes, requests } = await useNativeRuntime(t);
  const write = (path, body) => api.request(path, 'POST', body, { 'Idempotency-Key': randomUUID() });
  await api.login('manager');
  const draft = await write('/api/training/courses', {
    title: '九盈隔离培训', content: '请补交清晰的培训示例图片。',
  });
  const course = await write('/api/training/courses/' + draft.id, { status: 'published', version: draft.version });
  await api.login('partnerA');
  const record = await write('/api/training/records', {
    courseId: course.id, outletId: 'cs', learner: '隔离学员 V344',
  });
  const recordPath = '/api/training/records/' + record.id;
  const png = await sharp({ create: { height: 30, width: 30, channels: 3, background: '#e7f2ff' } }).png().toBuffer();
  const image = { name: '隔离图片.png', type: 'image/png', base64: png.toString('base64') };
  const first = await write(recordPath + '/materials', image);
  await api.login('manager');
  const reason = '请补交培训记录第一页。';
  await write(recordPath + '/review', { action: 'return', version: first.version, note: reason });
  await api.login('partnerA');
  const inbox = await api.collection('messages');
  const notice = inbox.items.find(item => item.target === 'training' && item.recordId === record.id);
  assert.ok(notice);
  assert.equal(canOpenRecord(notice), true);
  await openRecord(notice);
  assert.ok(requests.includes(recordPath + '?outlet=cs'));
  assert.deepEqual(routes, ['/pages/training/index?outlet=cs&id=' + record.id]);
  assert.equal((await api.request(recordPath + '?outlet=cs')).note, reason);
  await api.login('partnerB');
  await assert.rejects(() => openRecord(notice), error => error.status === 404);
  assert.equal(routes.length, 1);
  await api.login('partnerA');
  const replacement = await write(recordPath + '/materials', image);
  assert.equal(replacement.id, record.id);
  const tasks = await api.collection('businessTasks', { status: 'resolved' });
  assert.ok(tasks.items.some(task => task.id === notice.taskId && task.recordId === record.id));
  await api.login('manager');
  await write(recordPath + '/review', { action: 'accept', version: replacement.version, note: '资料已核对。' });
  await api.login('partnerA');
  assert.equal((await api.request(recordPath + '?outlet=cs')).status, 'materials_approved');
});
