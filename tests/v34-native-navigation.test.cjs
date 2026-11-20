const test = require('node:test');
const assert = require('node:assert/strict');
const { define, go, api } = require('../miniprogram/utils/page');
const app = require('../miniprogram/app.json');
const { getNativeRoutes } = require('../scripts/wechat-routes.cjs');

function screen(t) {
  const previous = global.wx;
  const page = {
    storage: new Map(),
    calls: [],
    toasts: [],
    setStorageSync(key, value) { this.storage.set(key, value); },
    getStorageSync(key) { return this.storage.get(key); },
    removeStorageSync(key) { this.storage.delete(key); },
    showToast(options) { this.toasts.push(options.title); },
    navigateTo(options) { this.calls.push({ action: 'page', ...options }); },
    switchTab(options) { this.calls.push({ action: 'tab', ...options }); }
  };
  global.wx = page;
  t.after(() => { global.wx = previous; });
  return page;
}

test('shared native navigation uses the original API for each registered page', t => {
  const page = screen(t);
  const tabs = new Set(app.tabBar.list.map(item => item.pagePath));
  const { routes } = getNativeRoutes(app);
  for (const route of routes) {
    go(route.split('/')[1], 'outlet=zz');
    const call = page.calls.at(-1);
    const tab = tabs.has(route);
    assert.equal(call.action, tab ? 'tab' : 'page');
    assert.equal(call.url, '/' + route + (tab ? '' : '?outlet=zz'));
    if (tab) assert.deepEqual(page.storage.get('jyyc.route.' + route.split('/')[1]), { outlet: 'zz' });
    call.success();
  }
});

test('a failed tap is explained on the current page and a retry keeps the original route', t => {
  const page = screen(t);
  const source = define({ data: { form: { revenue: '' } } });
  source.setData = changes => { source.data.form.revenue = changes['form.revenue']; };
  source.input({ currentTarget: { dataset: { field: 'revenue' } }, detail: { value: '141.72' } });
  const event = { currentTarget: { dataset: { page: 'report', query: 'outlet=zz&month=2026-10' } } };
  source.nav(event);
  source.nav(event);
  assert.equal(page.calls.length, 1);
  page.calls[0].fail({ errMsg: 'navigateTo:fail network timeout' });
  assert.match(page.toasts[0], /网络.*重试/);
  go('report', 'outlet=zz&month=2026-10');
  assert.equal(page.calls.length, 2);
  assert.equal(page.calls[1].url, page.calls[0].url);
  assert.deepEqual(source.data.form, { revenue: '141.72' });
  assert.equal(source._dirty, true);
});

test('a failed Tab jump removes its pending deep link and invalid input never dispatches', t => {
  const page = screen(t);
  const tabKey = 'jyyc.route.reports';
  page.storage.set(tabKey, { month: '2026-10' });
  go('reports', 'month=2026-09');
  assert.equal(page.storage.get(tabKey).month, '2026-09');
  page.calls[0].fail({ errMsg: 'switchTab:fail page not found' });
  assert.deepEqual(page.storage.get(tabKey), { month: '2026-10' });
  assert.match(page.toasts[0], /暂时无法打开/);
  go('ghost');
  go('support', 'id=%ZZ');
  assert.equal(page.calls.length, 1);
  assert.match(page.toasts.at(-1), /页面信息有误/);
  assert.equal(page.storage.get(tabKey).month, '2026-10');
});

test('notice opening distinguishes stale objects and keeps the original card available for retry', async t => {
  const page = screen(t);
  const previousDetail = api.detail;
  const priorPage = global.Page;
  let instance;
  global.Page = value => { instance = value; };
  const modulePath = require.resolve('../miniprogram/pages/messages/index.js');
  delete require.cache[modulePath];
  require(modulePath);
  t.after(() => { global.Page = priorPage; api.detail = previousDetail; });
  const message = { id: 'msg-1', recordId: 'rpt-1', target: 'reports', hasLink: true };
  instance.data = { messages: [message], error: '', statusFilter: 'unread' };
  instance.setData = value => Object.assign(instance.data, value);
  const event = { currentTarget: { dataset: { id: message.id } } };
  api.detail = async () => { throw Object.assign(new Error('not found'), { status: 404 }); };
  await instance.open(event);
  assert.match(instance.data.error, /该记录已更新或暂不可查看/);
  api.detail = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await instance.open(event);
  assert.match(instance.data.error, /暂无权限/);
  api.detail = async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK' }); };
  await instance.open(event);
  assert.match(instance.data.error, /网络连接失败/);
  api.detail = async () => ({ id: 'rpt-1', outlet: 'zz', month: '2026-10' });
  await instance.open(event);
  assert.equal(instance.data.error, '');
  assert.deepEqual(instance.data.messages, [message]);
  assert.match(page.calls[0].url, /outlet=zz&month=2026-10&id=rpt-1$/);
});
