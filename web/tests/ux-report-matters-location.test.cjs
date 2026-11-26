'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const api = require('../../miniprogram/utils/api');

const outlet = { id: 'cs', name: '长沙网点', owner: 'p1', status: 'open', address: '长沙市某路' };
const session = { role: 'partner', token: 'test-token', subject: 'partner-test', expiresAt: '2099-01-01T00:00:00Z' };
const pageResult = items => ({ items, total: items.length, offset: 0, limit: 50, hasMore: false });
const reportWorklist = (month, items) => ({ ...pageResult(items), month, limit: 25,
  summary: { expected: 2, submitted: 2, exempt: 0, actionable: 0, awaitingExemption: 0, inReview: 2 } });
const tap = dataset => ({ currentTarget: { dataset } });

function page(t, name, query = {}) {
  let definition;
  const previous = { Page: global.Page, wx: global.wx };
  const scrolls = [];
  const routes = [];
  global.Page = value => { definition = value; };
  global.wx = {
    getStorageSync() {},
    switchTab({ url, success }) { routes.push(url); success?.(); },
    navigateTo({ url, success }) { routes.push(url); success?.(); },
    pageScrollTo({ selector }) { scrolls.push(selector); },
    showToast() {},
  };
  t.after(() => Object.assign(global, previous));
  t.mock.method(api, 'session', () => session);
  const file = require.resolve('../../miniprogram/pages/' + name + '/index.js');
  delete require.cache[file];
  require(file);
  const open = input => {
  const instance = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(updates, callback) {
      for (const [key, value] of Object.entries(updates)) {
        const parts = key.split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts.at(-1)] = value;
      }
      callback?.();
    },
  };
  instance.onLoad(input);
  return instance;
  };
  return { instance: open(query), open, routes, scrolls };
}

test('location resumes the same authorized scope after interruption and requires new field evidence', async t => {
  const { instance, open } = page(t, 'location', { outlet: 'cs', month: '2026-11' });
  const storage = new Map();
  wx.getStorageSync = key => storage.get(key);
  wx.setStorageSync = (key, value) => storage.set(key, value);
  wx.removeStorageSync = key => storage.delete(key);
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => pageResult(name === 'outlets' ? [outlet] : []));
  await instance.onShow();
  instance.input({ ...tap({ field: 'explanation' }), detail: { value: '修改后的经营地址说明' } });
  instance.setData({ coords: { lat: 28.1, lng: 112.8, source: 'gps' }, photo: { id: 'file-old' } });
  instance.onHide();
  instance.onUnload();

  const different = open({ outlet: 'cs', month: '2026-10' });
  await different.onShow();
  assert.equal(different.data.recoveryAvailable, false);
  const same = open({ outlet: 'cs', month: '2026-11' });
  await same.onShow();
  assert.equal(same.data.recoveryAvailable, true);
  assert.equal(same.data.form.explanation, '');
  same.restoreRecovery();
  assert.equal(same.data.form.explanation, '修改后的经营地址说明');
  assert.equal(same.data.coords, null);
  assert.equal(same.data.photo, null);
  const submit = t.mock.method(api, 'command', async () => assert.fail('Draft must not replace evidence'));
  await same.submit();
  assert.equal(submit.mock.callCount(), 0);
  assert.match(same.data.error, /定位/);
});

test('a newer verification record suppresses a saved address and supplement', async t => {
  const { instance, open } = page(t, 'location', { outlet: 'cs', month: '2026-11' });
  const storage = new Map();
  wx.getStorageSync = key => storage.get(key);
  wx.setStorageSync = (key, value) => storage.set(key, value);
  wx.removeStorageSync = key => storage.delete(key);
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  let latest = [];
  t.mock.method(api, 'collection', async name => pageResult(name === 'outlets' ? [outlet] : latest));
  await instance.onShow();
  instance.input({ ...tap({ field: 'address' }), detail: { value: '填写中的地址' } });
  instance.onHide();
  latest = [{ id: 'loc-fresh', outlet: 'cs', month: '2026-11', status: 'pending', trail: [] }];
  const reopened = open({ outlet: 'cs', month: '2026-11' });
  await reopened.onShow();
  assert.equal(reopened.data.recoveryAvailable, false);
  assert.equal(reopened.data.canSubmitEvidence, false);
  assert.equal(reopened.data.form.address, outlet.address);
  assert.equal(storage.has('jyyc.localDraft.location'), false);
});

test('the month shortcuts distinguish the open reporting period from the current calendar month', async t => {
  const { instance, routes } = page(t, 'reports', { outlet: 'cs' });
  let today = '2027-01-03';
  t.mock.method(api, 'request', async path => {
    if (path === '/api/context') return { actor: 'partnerA', today };
    const month = new URL(path, 'https://native.invalid').searchParams.get('month');
    const status = month < today.slice(0, 7) ? 'missing' : 'not_open';
    const row = { outletId: 'cs', month, status, reportId: null };
    return reportWorklist(month, [row]);
  });
  t.mock.method(api, 'collection', async name => pageResult(name === 'outlets' ? [outlet] : []));
  await instance.onShow();
  assert.equal(instance.data.month, '2026-12');
  assert.equal(instance.data.currentMonth, '2027-01');
  assert.equal(instance.data.canOpenEditor, true);
  await instance.pickMonthShortcut(tap({ value: 'current' }));
  assert.equal(instance.data.month, '2027-01');
  assert.match(instance.data.periodHint, /尚未开放填报/);
  instance.newReport();
  assert.deepEqual(routes, []);
  await instance.pickMonthShortcut(tap({ value: 'previous' }));
  assert.equal(instance.data.month, '2026-12');
  instance.newReport();
  assert.match(routes.at(-1), /month=2026-12&outlet=cs$/);
  today = '2027-02-01';
  await instance.onShow();
  assert.equal(instance.data.month, '2026-12');
});

test('reviewing shows the current operations and finance submissions without resurfacing an old returned version', async t => {
  const { instance } = page(t, 'reports');
  const month = '2026-10';
  const reports = [
    { reportId: 'rpt-latest', outletId: 'cs', month, status: 'finance', latestVersion: 2, effectiveVersion: null },
    { reportId: 'rpt-review', outletId: 'zz', month, status: 'pending', latestVersion: 1, effectiveVersion: null },
  ];
  const requests = [];
  t.mock.method(api, 'request', async path => {
    if (path === '/api/context') return { actor: 'partnerA', today: '2026-11-18' };
    const url = new URL(path, 'https://native.invalid');
    assert.equal(url.pathname, '/api/reports/worklist');
    requests.push(url.searchParams.get('status'));
    return reportWorklist(month, reports);
  });
  t.mock.method(api, 'collection', async name => pageResult(name === 'outlets' ? [outlet] : []));
  await instance.onShow();
  await instance.filter(tap({ value: 'reviewing' }));
  assert.deepEqual(requests, ['all', 'reviewing']);
  assert.deepEqual(instance.data.reportRows.map(row => [row.reportId, row.statusText]), [['rpt-latest', '财务复核中'], ['rpt-review', '总部审核中']]);
});

test('a successful notice destination issues only a read command and preserves access to completed history', async t => {
  const { instance, routes } = page(t, 'messages');
  const notice = { id: 'msg-rpt', read: false, status: 'unread', target: 'report_missing', outlet: 'cs', month: '2026-10', recordId: 'cs' };
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => pageResult(name === 'messages' ? [notice] : []));
  const writes = [];
  t.mock.method(api, 'command', async (command, payload) => { writes.push({ command, payload }); });
  await instance.onShow();
  await instance.open(tap({ id: notice.id }));
  assert.match(routes.at(-1), /^\/pages\/report\/index\?/);
  assert.deepEqual(writes, [{ command: 'message.read', payload: { id: notice.id } }]);
  await instance.status(tap({ status: 'resolved' }));
  assert.equal(instance.data.section, 'tasks');
  assert.equal(instance.data.status, 'resolved');
});

test('a notice stays unread when platform navigation fails', async t => {
  const { instance } = page(t, 'tasks', { section: 'notices' });
  const notice = { id: 'msg-unavailable', read: false, status: 'unread', target: 'report_missing' };
  global.wx.navigateTo = ({ fail }) => fail({ errMsg: 'navigateTo:fail' });
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => pageResult(name === 'messages' ? [notice] : []));
  const writes = t.mock.method(api, 'command', async () => {});
  await instance.onShow();
  await instance.open(tap({ id: notice.id }));
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(instance.data.noticeRows[0].read, false);
});

test('a linked notice cannot navigate or mark itself read after its source page unloads', async t => {
  const { instance, routes } = page(t, 'messages');
  const notice = { id: 'msg-delayed', read: false, target: 'reports', recordId: 'rpt-delayed', outlet: 'cs', month: '2026-10' };
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => pageResult(name === 'messages' ? [notice] : []));
  let finish;
  t.mock.method(api, 'detail', () => new Promise(resolve => { finish = resolve; }));
  const writes = t.mock.method(api, 'command', async () => {});
  await instance.onShow();
  const opening = instance.open(tap({ id: notice.id }));
  instance.onUnload();
  finish({ id: notice.recordId, outlet: 'cs', month: notice.month });
  await opening;
  assert.deepEqual(routes, []);
  assert.equal(writes.mock.callCount(), 0);
});

test('a verification deep link with only a record ID shows its exact month and outlet', async t => {
  const record = { id: 'loc-scoped', outlet: 'zz', month: '2026-09', status: 'approved' };
  const branch = { ...outlet, id: 'zz', name: '株洲网点' };
  const { instance, scrolls } = page(t, 'location', { id: record.id });
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'detail', async (name, id) => {
    assert.equal(name, 'verifications');
    assert.equal(id, record.id);
    return record;
  });
  t.mock.method(api, 'collection', async (name, filters) => {
    if (name === 'outlets') return pageResult([outlet, branch]);
    assert.equal(filters.outlet, branch.id);
    if (filters.month) assert.equal(filters.month, record.month);
    return pageResult([record]);
  });
  await instance.onShow();
  assert.equal(instance.data.outletId, branch.id);
  assert.equal(instance.data.month, record.month);
  assert.equal(instance.data.canSubmitEvidence, false);
  assert.match(instance.data.monthStatus, /已通过/);
  assert.equal(scrolls.at(-1), '#verification-' + record.id);
});

test('an unloaded verification page discards a delayed location result and delayed photo progress', async t => {
  const { instance } = page(t, 'location', { outlet: 'cs', month: '2026-11' });
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => pageResult(name === 'outlets' ? [outlet] : []));
  let finishLocation, finishPhoto, photoProgress;
  t.mock.method(api, 'locate', () => new Promise(resolve => { finishLocation = resolve; }));
  t.mock.method(api, 'uploadPhoto', ({ onProgress }) => new Promise(resolve => { finishPhoto = resolve; photoProgress = onProgress; }));
  await instance.onShow();
  const locating = instance.locate(tap({ manual: 'false' }));
  const uploading = instance.photo();
  instance.onUnload();
  photoProgress(50);
  finishLocation({ coords: { lat: 28, lng: 113, source: 'gps' } });
  finishPhoto({ file: { id: 'file-1' }, preview: 'preview' });
  await Promise.all([locating, uploading]);
  assert.equal(instance.data.coords, null);
  assert.equal(instance.data.photo, null);
  assert.equal(instance.data.photoProgress, null);
});

test('report field validation prevents writes and offers a confirmation summary of the checked snapshot', async t => {
  const { instance, scrolls } = page(t, 'report', { outlet: 'cs', month: '2026-10' });
  t.mock.method(api, 'request', async path => path.startsWith('/api/reports/context') ? {
    enrollmentStatus: 'not_applicable', eligibility: { canEdit: true, canSubmit: true }, historyVersions: [],
  } : { actor: 'partnerA', today: '2026-11-18' });
  t.mock.method(api, 'collection', async () => pageResult([outlet]));
  t.mock.method(api, 'command', async () => assert.fail('An unfinished or unconfirmed form performed a write.'));
  await instance.onShow();
  assert.deepEqual(instance.data.missingFields, ['营业收入', '有效完成订单', '到店客流']);
  instance.submit();
  assert.deepEqual(instance.data.fieldErrors, {
    revenue: '请填写营业收入',
    orders: '请填写有效完成订单',
    traffic: '请填写到店客流',
  });
  assert.equal(scrolls.at(-1), '#report-field-revenue');
  assert.equal(instance.data.inlineConfirmation, false);
  assert.equal(instance.data.showActionError, false);
  const set = (field, value) => instance.input({ ...tap({ field }), detail: { value } });
  const confirm = (field, value) => instance.confirmField({ ...tap({ field }), detail: { value } });
  assert.deepEqual(instance.data.nextNumericField, { revenue: 'orders', orders: 'traffic' });
  confirm('revenue', '12.345');
  assert.equal(instance.data.focusField, '');
  assert.match(instance.data.fieldErrors.revenue, /两位小数/);
  confirm('revenue', '12.34');
  assert.equal(instance.data.focusField, 'orders');
  instance.blurField(tap({ field: 'revenue' }));
  assert.equal(instance.data.focusField, 'orders');
  confirm('orders', '0');
  assert.equal(instance.data.form.orders, '0');
  assert.equal(instance.data.focusField, 'traffic');
  confirm('traffic', '1');
  instance.blurField(tap({ field: 'traffic' }));
  assert.equal(instance.data.focusField, '');
  assert.equal(instance.data.inlineConfirmation, false);
  set('revenue', '12.345');
  set('orders', '0');
  set('traffic', '1');
  instance.submit();
  assert.match(instance.data.fieldErrors.revenue, /两位小数/);
  assert.equal(scrolls.at(-1), '#report-field-revenue');
  set('revenue', '12.34');
  instance.submit();
  assert.deepEqual(instance.data.confirmationRows.map(row => row.value), ['¥12.34', '0 单', '1 人次', '不适用']);
});
