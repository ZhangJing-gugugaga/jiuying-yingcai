'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');

async function withServer(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function request(path, token, body, status = 200) {
    const response = await fetch(address + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result.error));
    return { ...result, requestId: response.headers.get('x-request-id') };
  }
  const get = async (path, token) => (await request(path, token)).data;
  const login = async actor => (await request('/auth/dev', null, { actor })).data.token;
  const apply = async (token, command, payload, status = 200) => {
    const result = await request('/commands', token, { command, payload }, status);
    assert.ok(result.requestId);
    return status === 200 ? result.data.result : result.error;
  };
  const photo = async token => (await request('/files', token, {
    name: 'onsite.png', type: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=',
  }, 201)).data;

  try { await run({ app, request, get, login, apply, photo }); }
  finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('registration mobile change is a distinct managed request and never replaces the responsible person', () => withServer(async f => {
  const [manager, ops] = await Promise.all(['manager', 'ops'].map(f.login));
  const credentials = (await f.request('/auth/activation', manager, { actor: 'partnerA', username: 'v34.original.owner' })).data;
  const originalPassword = 'Original-C34-Password-19!';
  const revisedPassword = 'Revised-C34-Password-28!';
  const oldDevice = (await f.request('/auth/activate', null, { token: credentials.token, password: originalPassword })).data.token;
  const anotherDevice = (await f.request('/auth/password', null, { username: credentials.username, password: originalPassword })).data.token;
  await f.request('/auth/change-password', oldDevice, { currentPassword: originalPassword, password: revisedPassword });
  await f.request('/context', oldDevice, null, 401);
  await f.request('/context', anotherDevice, null, 401);
  const currentSession = (await f.request('/auth/password', null, { username: credentials.username, password: revisedPassword })).data.token;
  const original = (await f.get('/collections/accounts?owner=p1', manager)).items[0];

  const mobileChange = await f.apply(currentSession, 'request.submit', {
    type: 'accountChange', outlet: 'cs',
    data: { change: 'mobile', mobile: '13900000801', reason: '更新已经核实的登记号码' },
  });
  assert.equal((await f.get('/collections/requests/' + mobileChange.id, currentSession)).data.change, 'mobile');
  await f.apply(ops, 'review.request', { id: mobileChange.id, decision: 'approve' }, 403);
  const competing = await f.apply(currentSession, 'request.submit', {
    type: 'accountChange', outlet: 'zz',
    data: { change: 'manager', managerName: '历史申请中的负责人', mobile: '13900000802', reason: '独立的旧交接申请' },
  });
  await f.apply(manager, 'review.request', { id: mobileChange.id, decision: 'supplement', note: '初审过程信息', publicNote: '请补充号码变更说明。' });
  const mismatch = await f.apply(currentSession, 'request.supplement', {
    id: mobileChange.id, note: '申请类型不能改变',
    data: { change: 'manager', managerName: '不能替换的姓名', mobile: '13900000801' },
  }, 400);
  assert.equal(mismatch.code, 'INPUT');
  await f.apply(currentSession, 'request.supplement', { id: mobileChange.id, note: '已补充号码核验说明', data: { mobile: '13900000801', reason: '补充核验' } });
  await f.apply(manager, 'review.request', { id: mobileChange.id, decision: 'approve', note: '已核实号码及身份' });
  const stale = await f.apply(manager, 'review.request', { id: competing.id, decision: 'approve' }, 409);
  assert.equal(stale.code, 'CONFLICT');
  await f.request('/context', currentSession, null, 401);
  assert.equal((await f.request('/auth/password', null, { username: credentials.username, password: revisedPassword }, 401)).error.code, 'INVALID_CREDENTIALS');
  const phoneOnly = (await f.get('/collections/accounts?owner=p1', manager)).items[0];
  assert.equal(phoneOnly.managerName, original.managerName);
  assert.equal(phoneOnly.mobile, '139****0801');
  assert.equal(JSON.parse(f.app.store.db.prepare("SELECT data FROM accounts WHERE owner='p1'").get().data).mobile, '13900000801');
  assert.equal(phoneOnly.ownerHistory.at(-1).requestId, mobileChange.id);
  const newActivation = (await f.request('/auth/activation', manager, { actor: 'partnerA', username: 'v34.reactivated.owner' })).data;
  const reactivated = (await f.request('/auth/activate', null, { token: newActivation.token, password: 'Reactivated-C34-Password-37!' })).data.token;
  const result = await f.get('/collections/requests/' + mobileChange.id, reactivated);
  assert.match(result.publicNote, /登记手机号已更新/);
  assert.equal((await f.get('/collections/outlets', reactivated)).total, 3);
  assert.ok((await f.get('/collections/reports?outlet=cs&month=2026-09', reactivated)).items[0]);
}));

test('password rotation retires outstanding activation codes for that account only', () => withServer(async f => {
  const manager = await f.login('manager');
  const createCode = actor => f.request('/auth/activation', manager, { actor });
  const original = (await createCode('partnerA')).data;
  const originalPassword = 'Owner-Lifecycle-Test-14!';
  const updatedPassword = 'Owner-Lifecycle-Test-28!';
  const session = (await f.request('/auth/activate', null, { token: original.token, password: originalPassword })).data.token;
  const outstanding = (await createCode('partnerA')).data;
  const other = (await createCode('partnerB')).data;

  await f.request('/auth/change-password', session, { currentPassword: originalPassword, password: updatedPassword });
  const expired = await f.request('/auth/activate', null, { token: outstanding.token, password: originalPassword }, 409);
  assert.equal(expired.error.code, 'ACTIVATION_INVALID');
  await f.request('/auth/password', null, { username: original.username, password: updatedPassword });
  await f.request('/auth/activate', null, { token: other.token, password: originalPassword });
}));

test('account freezing and reopening retire previously issued activation codes', () => withServer(async f => {
  const manager = await f.login('manager');
  const issue = async actor => (await f.request('/auth/activation', manager, { actor })).data;
  const redeem = (token, status = 200) => f.request('/auth/activate', null, { token, password: 'Identity-Workflow-Test-72!' }, status);

  const priorCode = await issue('partnerA');
  await f.apply(manager, 'account.update', { owner: 'p1', status: 'frozen', reason: '核验期间暂停账号' });
  await f.apply(manager, 'account.update', { owner: 'p1', status: 'active', reason: '核验结束恢复账号' });
  assert.equal((await redeem(priorCode.token, 409)).error.code, 'ACTIVATION_INVALID');
  assert.equal((await redeem((await issue('partnerA')).token)).data.actor, 'partnerA');

}));

test('an authorization change requires a fresh staff activation code', () => withServer(async f => {
  const manager = await f.login('manager');
  const issue = async actor => (await f.request('/auth/activation', manager, { actor })).data;
  const redeem = (token, status = 200) => f.request('/auth/activate', null, { token, password: 'Identity-Workflow-Test-72!' }, status);

  const staff = 'identity_followup_staff';
  await f.apply(manager, 'staff.create', { subject: staff, name: '隔离客服用户', role: 'support', reason: '首次岗位授权' });
  const staleStaffCode = await issue(staff);
  await f.apply(manager, 'staff.update', { id: staff, status: 'active', role: 'finance', reason: '重新授权财务岗位' });
  assert.equal((await redeem(staleStaffCode.token, 409)).error.code, 'ACTIVATION_INVALID');
  assert.equal((await redeem((await issue(staff)).token)).data.role, 'finance');
}));

test('monthly location exception closes the partner task when the same outlet and month is resubmitted; history and outcome remain', () => withServer(async f => {
  const [partner, other, specialist, regional] = await Promise.all(['partnerA', 'partnerB', 'location', 'regional'].map(f.login));
  const photo = await f.photo(partner);
  const base = { outlet: 'cs', month: '2026-11', address: '隔离实例地址', photo };
  const first = await f.apply(partner, 'location.submit', { ...base, coords: { lat: 28.2, lng: 113.1, source: 'manual', coordinateSystem: 'GCJ-02' } });
  assert.equal((await f.apply(specialist, 'location.review', { id: first.id, decision: 'approve' }, 409)).code, 'GPS_REQUIRED');
  await f.apply(regional, 'location.review', { id: first.id, decision: 'exception', note: '无此权限' }, 403);
  await f.apply(specialist, 'location.review', { id: first.id, decision: 'exception', note: '专岗内部说明', publicNote: '请现场定位并说明。' });
  const task = (await f.get('/tasks?queue=partner&kind=location_exception', partner)).items.find(row => row.recordId === first.id);
  assert.ok(task);
  const firstDetail = await f.get('/collections/verifications/' + first.id, partner);
  assert.equal(firstDetail.publicNote, '请现场定位并说明。');
  assert.equal(firstDetail.trail, undefined);
  await f.request('/collections/verifications/' + first.id, other, null, 404);
  const gps = { lat: 28.2, lng: 113.1, source: 'gps', coordinateSystem: 'GCJ-02', accuracy: 12 };
  const after = await f.apply(partner, 'location.submit', { ...base, coords: gps, explanation: '已按提示重新采集现场位置' });
  assert.equal(after.previousId, first.id);
  assert.equal(after.status, 'pending');
  assert.equal((await f.get('/tasks/' + task.id, partner)).status, 'resolved');
  await f.apply(specialist, 'location.review', { id: after.id, decision: 'approve', publicNote: '位置资料已确认。' });
  const records = (await f.get('/collections/verifications?outlet=cs', partner)).items.filter(row => row.month === base.month);
  assert.deepEqual(records.map(x => [x.id, x.status]), [[after.id, 'approved'], [first.id, 'exception']]);
  assert.equal(records[0].publicNote, '位置资料已确认。');
  assert.equal(records[0].coords.source, 'gps');
}));

test('outlet application preserves one lifecycle history through opening, partial pause, full pause, reopening and final closure', () => withServer(async f => {
  const [partner, manager, ops, specialist, finance] = await Promise.all(['partnerA', 'manager', 'ops', 'location', 'finance'].map(f.login));
  const photo = await f.photo(partner);
  const setToday = date => f.app.store.db.prepare("UPDATE settings SET value=? WHERE key='today'").run(JSON.stringify(date));
  setToday('2026-06-02');
  const proposed = await f.apply(partner, 'request.submit', { type: 'newOutlet', data: {
    name: '隔离生命周期样例', province: '湖南', city: '长沙', district: '示范区', address: '隔离地址', phone: '000-00000000',
    opening: '2026-06-02', coords: { lat: 28.2, lng: 113.1, source: 'manual', coordinateSystem: 'GCJ-02' }, photo,
  } });
  await f.apply(ops, 'review.request', { id: proposed.id, decision: 'approve' }, 409);
  await f.apply(specialist, 'location.review', { id: proposed.id, decision: 'approve' });
  const approved = await f.apply(ops, 'review.request', { id: proposed.id, decision: 'approve' });
  const outlet = approved.data.createdOutletId;
  const path = '/collections/outlets/' + outlet;
  const preparing = await f.get(path, partner);
  assert.equal(preparing.status, 'preparing');
  const openDate = '2026-06-02', pauseDate = '2026-07-16', resumeDate = '2026-09-02', closeDate = '2026-09-20';
  const change = (token, status, effectiveDate, expected = 200) => f.apply(token, 'outlet.status', { outlet, status, effectiveDate, reason: '隔离生命周期核对' }, expected);
  await change(finance, 'open', openDate, 403);
  await change(manager, 'open', openDate);
  await f.apply(ops, 'enrollment.confirm', { outlet, applicable: false, effectiveMonth: '2026-06', reason: '隔离营业样例不招生' });
  const beforeBilling = (await f.get('/collections/bills?outlet=' + outlet, partner)).total;
  setToday('2026-07-16');
  const pause = await f.apply(partner, 'request.submit', { type: 'statusChange', outlet, data: { status: 'paused', effectiveDate: pauseDate, reason: '隔离样例暂停' } });
  assert.equal((await f.get(path, partner)).status, 'open');
  await f.apply(ops, 'review.request', { id: pause.id, decision: 'approve' });
  assert.equal((await f.get(path, partner)).status, 'paused');
  setToday('2026-09-01');
  const sampleReport = { outlet, month: '2026-07', revenue: 456.78, orders: 2, traffic: 4, enroll: null };
  const partialReport = await f.apply(partner, 'report.submit', sampleReport);
  assert.equal(partialReport.enroll, null);
  await f.apply(ops, 'review.report', { id: partialReport.id, decision: 'approve' });
  const blocked = await f.apply(partner, 'report.submit', { ...sampleReport, month: '2026-08' }, 409);
  assert.equal(blocked.code, 'PAUSE_REVIEW');
  await f.apply(ops, 'report.exempt', { outlet, month: '2026-08', reason: '整月暂停核验' });
  assert.equal((await f.get('/collections/bills?outlet=' + outlet, partner)).total, beforeBilling);
  setToday(resumeDate);
  await change(ops, 'open', resumeDate);
  setToday(closeDate);
  await change(manager, 'closed', closeDate);
  setToday('2026-11-18');
  await change(manager, 'open', '2026-09-21', 409);
  const lifecycle = await f.get(path, partner);
  assert.equal(lifecycle.status, 'closed');
  assert.deepEqual(lifecycle.events.map(event => [event.status, event.date]), [
    ['preparing', openDate], ['open', openDate], ['paused', pauseDate], ['open', resumeDate], ['closed', closeDate],
  ]);
  assert.equal((await f.get('/collections/reports/' + partialReport.id, partner)).status, 'approved');
  assert.equal((await f.apply(partner, 'report.submit', { ...sampleReport, month: '2026-10' }, 409)).code, 'NO_OPERATION');
}));

function nativeLocation() {
  let definition;
  const previous = global.Page;
  const modulePath = require.resolve('../../miniprogram/pages/location/index.js');
  global.Page = page => { definition = page; };
  try {
    delete require.cache[modulePath];
    require(modulePath);
  } finally {
    global.Page = previous;
  }
  return {
    ...definition, route: 'pages/location/index', query: { outlet: 'cs' }, data: structuredClone(definition.data),
    setData(changes, callback) {
      for (const [path, value] of Object.entries(changes)) {
        const key = path.split('.');
        const object = key.slice(0, -1).reduce((target, name) => target[name], this.data);
        object[key.at(-1)] = value;
      }
      callback?.();
    },
  };
}

test('when location permission was denied, the owner can open settings then retry an explicit onsite capture', async t => {
  const previous = global.wx;
  t.after(() => { global.wx = previous; });
  let allowed = false;
  let captures = 0;
  global.wx = {
    getLocation({ success, fail }) {
      captures++;
      if (allowed) success({ latitude: 28.2, longitude: 113.1, accuracy: 18 });
      else fail();
    },
    getSetting({ success }) { success({ authSetting: { 'scope.userLocation': allowed } }); },
    openSetting({ success }) {
      allowed = true;
      success({ authSetting: { 'scope.userLocation': allowed } });
    },
  };
  const page = nativeLocation();
  const api = require('../../miniprogram/utils/api');
  t.mock.method(api, 'session', () => ({ actor: 'partnerA', role: 'partner', token: 'location-permission-test' }));
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => {
    const items = name === 'outlets' ? [{ id: 'cs', owner: 'p1', status: 'open' }] : [];
    return { items, total: items.length, offset: 0, limit: 50, hasMore: false };
  });
  await page.refresh();
  const gps = { currentTarget: { dataset: { manual: 'false' } } };
  await page.locate(gps);
  assert.equal(page.data.gpsPermissionDenied, true);
  assert.match(page.data.error, /允许使用位置信息/);
  assert.equal(page.data.coords, null);
  page.openLocationSettings();
  assert.equal(page.data.gpsPermissionDenied, false);
  assert.equal(captures, 1);
  await page.locate(gps);
  assert.equal(captures, 2);
  assert.equal(page.data.error, '');
  assert.equal(page.data.coords.source, 'gps');
});

test('only the newest attempt asks for location supplements; a completed old exception stays visible as history', async t => {
  const previous = global.wx;
  global.wx = {};
  t.after(() => {global.wx=previous;});
  const page = nativeLocation();
  const outlet = { id: 'cs', owner: 'p1', status: 'open', address: '隔离地址' };
  const older = { id: 'loc-first', status: 'exception', month: '2026-11', outlet: 'cs' };
  const current = { id: 'loc-after', previousId: older.id, status: 'approved', month: '2026-11', outlet: 'cs' };
  const api = require('../../miniprogram/utils/api');
  t.mock.method(api, 'session', () => ({ actor: 'partnerA', role: 'partner', token: 'location-history-test' }));
  t.mock.method(api, 'request', async () => ({ actor: 'partnerA', today: '2026-11-18' }));
  t.mock.method(api, 'collection', async name => {
    const items = name === 'outlets' ? [outlet] : [current, older];
    return { items, total: items.length, offset: 0, limit: 50, hasMore: false };
  });
  page.data.month = '2026-11';
  await page.refresh();
  assert.equal(page.data.needsExplanation, false);
  assert.equal(page.data.history[1].needsExplanation, false);
  assert.equal(page.data.history[1].status, 'exception');
  assert.equal(page.data.history[1].statusText, '已补交，原记录保留');
});
