'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('../server/index.cjs');
const config = require('../../miniprogram/config');
const api = require('../../miniprogram/utils/api');
const { openRecord } = require('../../miniprogram/utils/page');
const editorPath = require.resolve('../../miniprogram/pages/report/index.js');
const markup = readFileSync(path.join(path.dirname(editorPath), 'index.wxml'), 'utf8');

const october = { outlet: 'cs', month: '2026-10' };
const monthlyValues = { revenue: 123456789.01, orders: 21, traffic: 31, enroll: 5, note: '隔离验收说明' };
const change = value => ({ detail: { value } });
const input = (editor, field, value) => editor.input({ currentTarget: { dataset: { field } }, ...change(value) });
const context = (scope = october) => api.request('/api/reports/context?' + api.query(scope));

async function nativeReport(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previousBase = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map();
  const requests = [];
  const controls = { modals: [], choices: [], leaveAlerts: [], routes: [], responses: [], afterResponse: null };

  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    navigateTo(options) { controls.routes.push(options.url); options.success?.(); },
    reLaunch(options) { controls.routes.push(options.url); options.success?.(); },
    enableAlertBeforeUnload(options) { controls.leaveAlerts.push(options.message); },
    disableAlertBeforeUnload() { controls.leaveAlerts.push(false); },
    showModal(options) {
      controls.modals.push({ title: options.title, confirmText: options.confirmText, cancelText: options.cancelText });
      const select = controls.choices.shift();
      if (typeof select === 'function') select(options);
      else options.success({ confirm: select === 'confirm', cancel: select === 'cancel' });
    },
    async request(options) {
      const { url, method, header, data } = options;
      requests.push(options);
      let result;
      try {
        const response = await fetch(url, { method, headers: header, body: method === 'GET' ? undefined : JSON.stringify(data) });
        result = { statusCode: response.status, data: await response.json() };
        controls.responses.push({ url, command: data?.command, requestId: result.data.requestId, recordId: result.data.data?.result?.id });
        await controls.afterResponse?.(options, result);
      } catch (error) {
        options.fail(error);
        return;
      }
      options.success(result);
    },
  };

  async function open(query = october) {
    let definition;
    global.Page = value => { definition = value; };
    delete require.cache[editorPath];
    require(editorPath);
    const page = {
      ...definition,
      route: 'pages/report/index',
      data: structuredClone(definition.data),
      setData(values) {
        for (const [key, value] of Object.entries(values)) {
          const parts = key.split('.');
          let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part] ||= {};
          target[parts.at(-1)] = value;
        }
      },
    };
    global.getCurrentPages = () => [page];
    page.onLoad({ ...query });
    await page.onShow();
    return page;
  }

  async function staffRequest(actor, route, method = 'GET', body) {
    const { token } = await api.request('/api/auth/dev', 'POST', { actor });
    return api.request(route, method, body, {
      Authorization: 'Bearer ' + token,
      'Idempotency-Key': require('node:crypto').randomUUID(),
    });
  }

  async function staff(actor, command, payload) {
    const response = await staffRequest(actor, '/api/commands', 'POST', { command, payload });
    return response.result;
  }

  try {
    await api.login('partnerA');
    await run({ app, open, requests, controls, staff, staffRequest });
  } finally {
    config.apiBase = previousBase;
    delete global.wx;
    delete global.Page;
    delete global.getCurrentPages;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('report workbench entry requires an explicit outlet and does not query or write a default outlet', () => nativeReport(async ({ open, requests }) => {
  const editor = await open({ month: october.month });
  assert.ok(editor.data.outlets.length > 1);
  assert.equal(editor.data.outletId, '');
  assert.equal(editor.data.canEdit, false);
  assert.equal(requests.some(request => request.url.includes('/api/reports/context?')), false);
  await editor.draft();
  assert.equal(requests.some(request => request.data?.command === 'report.draft'), false);
  const index = editor.data.outlets.findIndex(outlet => outlet.id === 'zz');
  await editor.chooseOutletFromPicker(change(index + 1));
  assert.equal(editor.data.outletId, 'zz');
  assert.equal(editor.data.month, october.month);
  assert.ok(requests.some(request => request.url.includes('/api/reports/context?outlet=zz&month=2026-10')));
  const invalid = await open({ outlet: 'missing-unauthorized-outlet', month: october.month });
  assert.equal(invalid.data.outletId, '');
  assert.equal(invalid.data.canEdit, false);
  assert.ok(invalid.data.error);
}));

test('session expiry after switching month resumes the chosen outlet and month without moving a draft', () => nativeReport(async ({ app, open, controls }) => {
  const editor = await open(october);
  const chosen = { outlet: 'cs', month: '2026-07' };
  await editor.chooseMonth(change(chosen.month));
  assert.equal(editor.data.month, chosen.month);
  assert.equal(editor.data.canEdit, true);
  input(editor, 'orders', '18');
  await editor.draft();
  assert.equal((await context(chosen)).draft.orders, 18);

  app.store.db.prepare('UPDATE sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  await editor.refresh();
  const login = new URL(controls.routes.at(-1), 'https://native.invalid');
  assert.equal(login.pathname, '/pages/login/index');
  assert.equal(login.searchParams.get('next'), 'report?outlet=cs&month=2026-07');

  await api.login('partnerA');
  const restored = await open(chosen);
  assert.equal(restored.data.form.orders, 18);
  assert.equal((await context()).draft, null);
}));

test('editing a report protects ordinary native back and successful save removes the warning', () => nativeReport(async ({ open, controls }) => {
  const editor = await open();
  assert.deepEqual(controls.leaveAlerts, []);
  input(editor, 'revenue', '12.34');
  input(editor, 'traffic', '3');
  assert.equal(controls.leaveAlerts.length, 1);
  assert.match(controls.leaveAlerts[0], /尚未保存.*草稿/);
  await editor.draft();
  assert.equal(controls.leaveAlerts.at(-1), false);
  assert.equal((await open()).data.form.revenue, 12.34);
}));

test('native returned task opens the precise outlet and month, saves, reopens and submits a new version to HQ', t => nativeReport(async ({ app, open, controls, staff, staffRequest }) => {
  const outlets = await api.collection('outlets');
  assert.equal(outlets.total, 3);
  const original = (await api.command('report.submit', { ...october, ...monthlyValues })).result;
  await staff('ops', 'review.report', { id: original.id, decision: 'approve' });
  await api.command('report.correct', { id: original.id, reason: '隔离并核对订单', correctionType: 'field', fields: ['orders'] });
  const returned = (await api.command('report.submit', { ...october, ...monthlyValues, orders: 22 })).result;
  await staff('ops', 'review.report', { id: returned.id, decision: 'return', note: '请核对订单凭证' });
  const tasks = await api.collection('businessTasks', { status: 'open' });
  const task = tasks.items.find(item => item.kind === 'report_returned' && item.recordId === returned.id);
  assert.ok(task);
  await openRecord(task);
  const route = new URL(controls.routes.at(-1), 'https://local.invalid');
  assert.equal(route.pathname, '/pages/report/index');
  assert.deepEqual(Object.fromEntries(route.searchParams), { ...october, id: returned.id });
  const returnedQuery = Object.fromEntries(route.searchParams);
  const editor = await open(returnedQuery);
  assert.equal(editor.data.returnedReason, '请核对订单凭证');
  assert.equal(editor.data.currentAction, '修改并重新提交');
  assert.equal(editor.data.currentApprovedVersion.id, original.id);
  assert.equal(editor.data.canEdit, false);
  await editor.continueReport();
  assert.equal(editor.data.outletId, october.outlet);
  assert.equal(editor.data.month, october.month);
  assert.equal(editor.data.returnedReason, '请核对订单凭证');
  assert.equal(editor.data.form.orders, 22);
  assert.equal(editor.data.editableFields.orders, true);
  input(editor, 'orders', '23');
  assert.match(controls.leaveAlerts.at(-1), /尚未保存/);
  await editor.draft();
  assert.equal(editor.data.error, '');
  editor.onUnload();
  const resumed = await open(returnedQuery);
  await resumed.continueReport();
  assert.equal(resumed.data.form.orders, 23);
  await resumed.submit();
  await resumed.confirmSubmit();
  assert.equal(resumed.data.error, '');
  const current = await context();
  assert.equal(current.draft, null);
  assert.equal(current.currentApprovedVersion.id, original.id);
  const replacement = current.latestSubmittedVersion;
  assert.equal(replacement.version, returned.version + 1);
  assert.equal(replacement.status, 'pending');
  assert.equal(replacement.orders, 23);
  const hq = await staffRequest('ops', '/api/tasks?queue=ops&status=open');
  const reviewTask = hq.items.find(item => item.kind === 'report_review' && item.recordId === replacement.id);
  assert.ok(reviewTask);
  assert.equal(reviewTask.outlet, october.outlet);
  assert.equal(reviewTask.month, october.month);
  assert.equal(app.store.db.prepare('SELECT status FROM reports WHERE id=?').get(replacement.id).status, 'pending');
  const submitRequest = controls.responses.find(row => row.command === 'report.submit' && row.recordId === replacement.id);
  const queueRequest = controls.responses.find(row => new URL(row.url).searchParams.get('queue') === 'ops');
  assert.ok(submitRequest?.requestId);
  assert.ok(queueRequest?.requestId);
  t.diagnostic(JSON.stringify({
    ...october, returned: returned.id, previousTask: task.id, replacement: replacement.id, reviewTask: reviewTask.id,
    submitRequestId: submitRequest.requestId, queueRequestId: queueRequest.requestId,
  }));
}));

test('dirty month switch cancels first and discards only after explicit confirmation', () => nativeReport(async ({ open, controls }) => {
  const editor = await open();
  input(editor, 'revenue', '12.34');
  controls.choices.push('cancel', 'cancel');
  await editor.chooseMonth(change('2026-07'));
  assert.equal(editor.data.month, '2026-10');
  assert.equal(editor.data.form.revenue, '12.34');
  assert.deepEqual(controls.modals.map(({ confirmText, cancelText }) => [confirmText, cancelText]), [
    ['保存草稿', '其他选项'], ['放弃修改', '继续编辑'],
  ]);
  controls.choices.push('cancel', 'confirm');
  await editor.chooseMonth(change('2026-07'));
  assert.equal(editor.data.month, '2026-07');
  assert.equal(editor.data.form.revenue, '');
  assert.equal((await context()).draft, null);
}));

test('dirty outlet switch waits for draft confirmation and retries the same write after a lost response', () => nativeReport(async ({ app, open, requests, controls }) => {
  const editor = await open();
  const target = editor.data.outlets.findIndex(outlet => outlet.id === 'zz');
  input(editor, 'revenue', '12.34');
  let release;
  let reached;
  const blocked = new Promise(resolve => { reached = resolve; });
  controls.afterResponse = async request => {
    if (request.data?.command !== 'report.draft') return;
    controls.afterResponse = null;
    await new Promise(resolve => { release = resolve; reached(); });
    throw new Error('验收模拟服务端已提交但客户端未收到响应');
  };

  controls.choices.push('confirm');
  const switching = editor.chooseOutlet(change(target));
  await Promise.race([blocked, switching]);
  assert.equal(editor.data.outletId, 'cs');
  try {
    assert.equal(editor.data.form.revenue, '12.34');
    await editor.chooseMonth(change('2026-07'));
    assert.equal(editor.data.month, '2026-10');
    assert.equal(controls.modals.length, 1);
  } finally {
    release?.();
  }
  await switching;
  assert.equal(editor.data.outletId, 'cs');
  assert.equal(editor.data.form.revenue, '12.34');
  assert.match(editor.data.error, /保存失败，您填写的内容已保留，请重试。/);
  assert.equal((await context()).draft.revenue, 12.34);

  controls.choices.push('confirm');
  await editor.chooseOutlet(change(target));
  assert.equal(editor.data.outletId, 'zz');
  assert.equal(editor.data.form.revenue, '');
  const writes = requests.filter(request => request.data?.command === 'report.draft');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].header['Idempotency-Key'], writes[1].header['Idempotency-Key']);
  assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM drafts WHERE outlet=? AND month=?').get('cs', '2026-10').count, 1);
}));

test('editor defaults to the server business month and follows write eligibility for current, future and paused periods', () => nativeReport(async ({ app, open, staff }) => {
  const state = app.store.load();
  state.today = '2026-12-01';
  state.outlets.find(outlet => outlet.id === 'zz').events = [{ date: '2026-09-01', status: 'preparing' }];
  app.store.save(state);
  const editor = await open({ outlet: 'cs' });
  assert.equal(editor.data.month, '2026-11');
  assert.equal(editor.data.canEdit, true);

  for (const [scope, code, message] of [
    [{ outlet: 'cs', month: '2026-12' }, 'INPUT', /当前月份暂未开放填报/],
    [{ outlet: 'cs', month: '2027-01' }, 'INPUT', /当前月份暂未开放填报/],
    [{ outlet: 'zz', month: '2026-10' }, 'NO_OPERATION', /无营业记录/],
    [{ outlet: 'hy', month: '2026-10' }, 'PAUSE_REVIEW', /整月暂停/],
  ]) {
    const readonly = await open(scope);
    assert.equal(readonly.data.canEdit, false);
    assert.match(readonly.data.editNotice, message);
    await assert.rejects(api.command('report.draft', scope), { code });
  }

  await staff('ops', 'report.exempt', { outlet: 'hy', month: '2026-10', reason: '隔离整月暂停核验' });
  const exempt = await open({ outlet: 'hy', month: '2026-10' });
  assert.equal(exempt.data.canEdit, false);
  assert.equal(exempt.data.editNotice,'该网点本月已由总部确认免报。');
  await assert.rejects(api.command('report.draft', { outlet: 'hy', month: '2026-10' }), { code: 'CONFLICT' });
}));

test('enrollment pending allows saving a partial draft and prevents submission', () => nativeReport(async ({ app, open, requests }) => {
  const state = app.store.load();
  state.outlets.find(outlet => outlet.id === 'cs').enrollmentStatus = 'pending';
  app.store.save(state);
  const editor = await open();
  assert.equal(editor.data.canEdit, true);
  assert.equal(editor.data.canSubmit, false);
  input(editor, 'revenue', '0.01');
  await editor.draft();
  assert.equal((await context()).draft.revenue, 0.01);
  await editor.submit(change(monthlyValues));
  assert.equal(requests.some(request => request.data?.command === 'report.submit'), false);
}));

test('single-field correction preserves approved baseline in draft and submit even when disabled fields are omitted', () => nativeReport(async ({ open, staff, requests }) => {
  const initial = (await api.command('report.submit', { ...october, ...monthlyValues })).result;
  await staff('ops', 'review.report', { id: initial.id, decision: 'approve' });
  const editor = await open();
  editor.setData({ reason: '核对有效订单', correctionFieldIndex: 1 });
  await editor.correct();
  assert.equal(editor.data.canCorrect, false);
  assert.match(editor.data.editNotice, /有效完成订单/);
  assert.deepEqual(editor.data.editableFields, { revenue: false, orders: true, traffic: false, enroll: false, note: false });
  assert.deepEqual(editor.data.nextNumericField, {});
  for (const field of ['revenue', 'orders', 'traffic', 'enroll']) {
    assert.match(markup, new RegExp(`<number-field[^>]*field="${field}"[^>]*disabled="[^"]*!editableFields\\.${field}[^"]*"`));
  }
  assert.match(markup, /<textarea[^>]*disabled="[^"]*!editableFields\.note[^"]*"[^>]*name="note"/);

  editor.setData({ reason: '重复申请' });
  await editor.correct();
  assert.equal(requests.filter(request => request.data?.command === 'report.correct').length, 1);
  input(editor, 'revenue', '9.99');
  assert.equal(editor.data.form.revenue, monthlyValues.revenue);
  input(editor, 'orders', '22');
  await editor.draft();
  assert.equal((await context()).draft.revenue, monthlyValues.revenue);
  const reopened = await open();
  await reopened.submit(change({ orders: '22' }));
  await reopened.confirmSubmit();
  assert.equal(reopened.data.error, '');
  const persisted = (await context()).latestSubmittedVersion;
  assert.equal(persisted.revenue, monthlyValues.revenue);
  assert.equal(persisted.traffic, monthlyValues.traffic);
  assert.equal(persisted.enroll, monthlyValues.enroll);
  assert.equal(persisted.note, monthlyValues.note);
  assert.deepEqual(persisted.correctionDiff, { orders: { before: 21, after: 22 } });
}));

test('editor focuses the scoped linked version and distinguishes revoked latest from current effective', () => nativeReport(async ({ open, staff }) => {
  const first = (await api.command('report.submit', { ...october, ...monthlyValues })).result;
  await staff('ops', 'review.report', { id: first.id, decision: 'approve' });
  await api.command('report.correct', { id: first.id, reason: '核对有效订单', correctionType: 'field', fields: ['orders'] });
  const latest = (await api.command('report.submit', { ...october, ...monthlyValues, orders: 22 })).result;
  await staff('ops', 'review.report', { id: latest.id, decision: 'approve' });

  const linked = await open({ ...october, id: first.id });
  assert.equal(linked.data.linkedVersion.id, first.id);
  assert.equal(linked.data.currentApprovedVersion.id, latest.id);
  assert.equal(linked.data.latestSubmittedVersion.id, latest.id);
  assert.match(markup, /所选版本/);
  await linked.chooseMonth(change('2026-07'));
  assert.equal(linked.data.linkedVersion, null);

  const revoke = await staff('manager', 'report.revoke.request', { id: latest.id, reason: '隔离误审批验证' });
  await staff('finance', 'review.revoke', { id: revoke.id, decision: 'approve' });
  const revoked = await open({ ...october, reportId: latest.id });
  assert.equal(revoked.data.currentApprovedVersion, null);
  assert.equal(revoked.data.linkedVersion.id, latest.id);
  assert.equal(revoked.data.latestSubmittedVersion.statusText, '已撤销');

  const mismatched = await open({ outlet: 'zz', month: '2026-10', id: latest.id });
  assert.equal(mismatched.data.linkedVersion, null);
}));

test('monthly submit cancellation preserves form and confirmation is the only write', () => nativeReport(async ({ open, controls, requests }) => {
 const editor=await open();
 input(editor,'revenue','123.45');
 const entered={revenue:'123.45',orders:'1',traffic:'2',enroll:'0'};
 await editor.submit(change(entered));
 assert.equal(editor.data.inlineConfirmation,true);
 editor.cancelSubmit();
 assert.equal(editor.data.form.revenue,'123.45');
 assert.equal(requests.filter(row=>row.data?.command==='report.submit').length,0);
 assert.equal(controls.modals.length,0);
 await editor.submit(change(entered));
 await editor.confirmSubmit();
 assert.equal(requests.filter(row=>row.data?.command==='report.submit').length,1);
 assert.equal((await context()).latestSubmittedVersion.enroll,0);
}));

test('historical preview uses the authorized selected values even when a replacement and a new draft exist', () => nativeReport(async ({ open, staff, requests }) => {
 const original = (await api.command('report.submit', {...october, ...monthlyValues, revenue:10000})).result;
 await staff('ops','review.report',{id:original.id,decision:'approve'});
 await api.command('report.correct',{id:original.id,reason:'修正收入',correctionType:'field',fields:['revenue']});
 const replacement=(await api.command('report.submit',{...october,...monthlyValues,revenue:32123.45})).result;

 const preview=await open({...october,id:original.id});
 assert.equal(preview.data.linkedVersion.id,original.id);
 assert.equal(preview.data.currentApprovedVersion.id,original.id);
 assert.equal(preview.data.latestSubmittedVersion.id,replacement.id);
 assert.equal(preview.data.form.revenue,10000);
 assert.equal(preview.data.canEdit,false);
 const queued=(await api.request('/api/dashboard?period=2026-10&outlet=cs&mode=process')).totals;
 assert.equal(queued.revenue,10000);

 await staff('ops','review.report',{id:replacement.id,decision:'return',note:'请提供计入说明'});
 const afterReturn=await open({...october,reportId:original.id});
 assert.equal(afterReturn.data.currentApprovedVersion.id,original.id);
 assert.equal(afterReturn.data.latestSubmittedVersion.status,'returned');
 assert.equal(afterReturn.data.form.revenue,10000);
 assert.equal(afterReturn.data.canEdit,false);
 const count=requests.filter(row=>row.data?.command==='report.draft').length;
 await afterReturn.draft();
 assert.equal(requests.filter(row=>row.data?.command==='report.draft').length,count);
 await afterReturn.continueReport();
 assert.equal(afterReturn.data.linkedVersion,null);
 assert.equal(afterReturn.data.canEdit,true);
 assert.equal(afterReturn.data.form.revenue,32123.45);
}));

test('superseded history with a scoped summary never borrows another version values or edit capability', () => nativeReport(async ({ open, staff }) => {
 const original=(await api.command('report.submit',{...october,...monthlyValues,orders:1})).result;
 await staff('ops','review.report',{id:original.id,decision:'approve'});
 await api.command('report.correct',{id:original.id,reason:'重新核对订单',correctionType:'field',fields:['orders']});
 const second=(await api.command('report.submit',{...october,...monthlyValues,orders:2})).result;
 await staff('ops','review.report',{id:second.id,decision:'approve'});
 const preview=await open({...october,id:original.id});
 assert.equal(preview.data.currentApprovedVersion.id,second.id);
 assert.equal(preview.data.linkedVersion.id,original.id);
 assert.equal(preview.data.linkedVersion.summaryOnly,true);
 assert.equal(preview.data.form.orders,'');
 assert.equal(preview.data.canSubmit,false);
 assert.equal(preview.data.canCorrect,false);
 assert.match(markup,/该历史版本仅提供摘要/);
 const wrongScope=await open({outlet:'zz',month:october.month,id:original.id});
 assert.equal(wrongScope.data.linkedVersion,null);
 assert.equal(wrongScope.data.canEdit,false);
 assert.equal(wrongScope.data.form.orders,'');
}));
