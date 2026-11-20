'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');
const pagePath = require.resolve('../miniprogram/pages/report/index.js');

const restoreScope = { outlet: 'cs', month: '2026-10' };
const testFields = { revenue: '1000.00', orders: '20', traffic: '80', enroll: '2', note: '本月正常营业' };
const modalCopy = {
  title: '提交月报', content: '提交后，本次内容将进入总部审核。确认提交吗？',
  confirmText: '确认提交', cancelText: '取消',
};
const tap = { type: 'tap', currentTarget: { dataset: {} } };

async function withReport(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const originalBase = config.apiBase;
  const base = 'http://127.0.0.1:' + app.server.address().port;
  config.apiBase = base;
  const state = { calls: [], responses: [], modals: [], choices: [], toasts: [], afterResponse: null };
  const storage = new Map();
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast: options => state.toasts.push(options.title),
    showModal(options) {
      const { title, content, confirmText, cancelText } = options;
      state.modals.push({ title, content, confirmText, cancelText });
      const choice = state.choices.shift();
      if (choice === 'fail') options.fail({ errMsg: 'showModal:fail synthetic' });
      else if (typeof choice === 'function') choice(options);
      else options.success({ confirm: choice === 'confirm', cancel: choice === 'cancel' });
    },
    async request(options) {
      const { url, method, data, header } = options;
      state.calls.push({ path: new URL(url).pathname, method, data, key: header['Idempotency-Key'] });
      try {
        const response = await fetch(url, { method, headers: header, body: method === 'GET' ? undefined : JSON.stringify(data) });
        const body = await response.json();
        state.responses.push({ command: data?.command, path: new URL(url).pathname, status: response.status, body });
        await state.afterResponse?.(options, body);
        options.success({ statusCode: response.status, data: body });
      } catch (error) {
        options.fail(error);
      }
    },
  };
  async function open(query = restoreScope) {
    let definition;
    global.Page = value => { definition = value; };
    delete require.cache[pagePath];
    require(pagePath);
    const page = {
      ...definition, data: structuredClone(definition.data), route: 'pages/report/index',
      setData(values) {
        for (const [key, value] of Object.entries(values)) {
          const fields = key.split('.');
          let model = this.data;
          for (const field of fields.slice(0, -1)) model = model[field] ||= {};
          model[fields.at(-1)] = value;
        }
      },
    };
    global.getCurrentPages = () => [page];
    page.onLoad({ ...query });
    await page.onShow();
    return page;
  }
  async function staff(actor, route, data) {
    const originalSession = api.session();
    const authenticated = await api.login(actor);
    storage.set('jyyc.session', originalSession);
    const response = await fetch(base + route, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + authenticated.token, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data && JSON.stringify(data),
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error?.message);
    return body;
  }
  try {
    await api.login('partnerA');
    await run({ open, state, staff, db: app.store.db });
  } finally {
    config.apiBase = originalBase;
    delete global.wx;
    delete global.Page;
    delete global.getCurrentPages;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

function fill(editor, fields = testFields) {
  for (const [field, value] of Object.entries(fields)) {
    editor.input({ currentTarget: { dataset: { field } }, detail: { value } });
  }
}

test('the last unsaved monthly report can be recovered only after checking the same outlet and account', () => withReport(async ({ open, state }) => {
  const editor = await open();
  fill(editor);
  editor.onHide();
  const different = await open({ ...restoreScope, outlet: 'zz' });
  assert.equal(different.data.recoveryAvailable, false);
  assert.notEqual(different.data.form.note, testFields.note);
  const reopened = await open();
  assert.equal(reopened.data.recoveryAvailable, true);
  assert.notEqual(reopened.data.form.note, testFields.note);
  reopened.restoreRecovery();
  assert.equal(reopened.data.form.note, testFields.note);
  assert.equal(reopened.data.form.revenue, testFields.revenue);
  assert.equal(state.calls.filter(row => row.data?.command === 'report.draft').length, 0);
  await reopened.draft();
  assert.equal((await open()).data.recoveryAvailable, false);
  fill(reopened, { note: '本机未保存内容' });
  reopened.onHide();
  await api.login('partnerB');
  const forbidden = await open();
  assert.equal(forbidden.data.recoveryAvailable, false);
  assert.notEqual(forbidden.data.form.note, '本机未保存内容');
}));

test('a newer server draft prevails over recovery data from the same account and month', () => withReport(async ({ open }) => {
  const earlier = await open();
  fill(earlier);
  earlier.onHide();
  await api.command('report.draft', { ...restoreScope, revenue: 92, note: '已在另一端保存' });
  const reopened = await open();
  assert.equal(reopened.data.recoveryAvailable, false);
  assert.equal(reopened.data.form.revenue, 92);
  assert.equal(reopened.data.form.note, '已在另一端保存');
}));
const submissions = state => state.calls.filter(row => row.data?.command === 'report.submit');
const currentReport = async (scope = restoreScope) => api.request('/api/reports/context?' + api.query(scope));

test('monthly submit in WXML uses the same real tap event mechanism as draft and keeps feedback next to actions', () => {
  const text = readFileSync(pagePath.replace(/\.js$/, '.wxml'), 'utf8');
  assert.match(text, /<button\b[^>]*\bbindtap="submit"[^>]*>[\s\S]*?提交月报/);
  assert.doesNotMatch(text, /\bform-type="submit"/);
  assert.match(text, /id="report-actions"[\s\S]*?提交中…[\s\S]*?showActionError/);
});

test('restored fields submit through a tap with no form event object, can cancel, then enter the HQ queue once', t => withReport(async ({ open, state, staff, db }) => {
  const original = await api.command('report.submit', {
    ...restoreScope, revenue: 147.56, orders: 6, traffic: 25, enroll: 2, note: '需补充',
  });
  await staff('ops', '/api/commands', { command: 'review.report', payload: { id: original.result.id, decision: 'return', note: '核对本月数据' } });
  const initial = await open();
  fill(initial);
  await initial.draft();
  assert.equal(state.toasts.at(-1), '已保存草稿');
  initial.onUnload();
  const editor = await open();
  assert.deepEqual(editor.data.form, { revenue: 1000, orders: 20, traffic: 80, enroll: 2, note: '本月正常营业' });
  const writes = submissions(state).length;
  await editor.submit(tap);
  assert.equal(editor.data.inlineConfirmation, true);
  assert.equal(editor.data.submitConfirmationContent, modalCopy.content);
  assert.equal(state.modals.length, 0);
  editor.cancelSubmit();
  assert.equal(submissions(state).length, writes);
  assert.equal((await currentReport()).draft.note, '本月正常营业');
  assert.equal(editor.data.busy, false);

  await editor.submit(tap);
  await editor.confirmSubmit();
  assert.equal(submissions(state).length, writes + 1);
  assert.deepEqual(submissions(state).at(-1).data.payload, { ...restoreScope, revenue: 1000, orders: 20, traffic: 80, enroll: 2, note: '本月正常营业' });
  assert.equal(editor.data.displayStatus, '总部审核中');
  assert.equal(editor.data.canEdit, false);
  assert.equal(editor.data.canSubmit, false);
  assert.equal(state.toasts.at(-1), '经营月报已提交，等待总部审核。');
  const result = (await currentReport()).latestSubmittedVersion;
  assert.equal(result.version, 2);
  assert.equal(result.status, 'pending');
  assert.equal((await currentReport()).draft, null);
  const response = state.responses.find(item => item.command === 'report.submit' && item.body.data?.result.id === result.id);
  assert.ok(response?.body.requestId);
  const queue = await staff('ops', '/api/collections/businessTasks');
  assert.ok(queue.data.items.some(task => task.kind === 'report_review' && task.recordId === result.id && task.status === 'open'));
  const message = (await api.collection('messages')).items.find(message => message.recordId === result.id && message.title === '月报已提交');
  assert.ok(message);
  assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(result.id).status, 'pending');
  const review = await staff('ops', '/api/commands', { command: 'review.report', payload: { id: result.id, decision: 'approve' } });
  const approved = await open();
  assert.equal(approved.data.currentApprovedVersion.id, result.id);
  assert.equal(approved.data.currentApprovedVersion.status, 'approved');
  assert.equal(approved.data.versions.find(row => row.id === original.result.id).status, 'returned');
  assert.equal(db.prepare('SELECT status FROM reports WHERE id=?').get(result.id).status, 'approved');
  t.diagnostic(JSON.stringify({
    scope: restoreScope, priorReportId: original.result.id, reportId: result.id, version: result.version,
    submitRequestId: response.body.requestId, queueRequestId: queue.requestId, reviewRequestId: review.requestId,
    noticeId: message.id, transition: ['draft', 'pending', 'approved'],
  }));
}));

test('the only confirmation is inline and it can cancel or confirm the exact pending action', () => withReport(async ({ open, state }) => {
  const editor = await open();
  fill(editor);
  await editor.submit(tap);
  assert.equal(editor.data.inlineConfirmation, true);
  assert.equal(editor.data.submitConfirmationContent, modalCopy.content);
  assert.equal(editor.data.busy, false);
  assert.equal(state.modals.length, 0);
  assert.equal(submissions(state).length, 0);
  editor.cancelSubmit();
  assert.equal(editor.data.inlineConfirmation, false);
  assert.equal(editor.data.busy, false);
  assert.equal(editor.data.form.note, '本月正常营业');

  await editor.submit(tap);
  await editor.confirmSubmit();
  assert.equal(editor.data.inlineConfirmation, false);
  assert.equal(submissions(state).length, 1);
  assert.equal((await currentReport()).latestSubmittedVersion.status, 'pending');
}));

test('a late confirmation tap after cancel or page unload cannot write', () => withReport(async ({ open, state }) => {
  const editor = await open();
  fill(editor);
  await editor.submit(tap);
  assert.equal(editor.data.inlineConfirmation, true);
  editor.cancelSubmit();
  assert.equal(editor.data.busy, false);
  await editor.confirmSubmit();
  await editor.submit(tap);
  editor.onUnload();
  await editor.confirmSubmit();
  assert.equal(submissions(state).length, 0);
}));

test('an outstanding confirmation or a submission in flight rejects another tap and retains the confirmed field snapshot', () => withReport(async ({ open, state }) => {
  const editor = await open();
  fill(editor);
  await editor.submit(tap);
  {
    assert.equal(editor.data.inlineConfirmation, true);
    await editor.submit(tap);
    await editor.chooseMonth({ detail: { value: '2026-09' } });
    fill(editor, { note: '未经过确认的变动' });
    assert.equal(editor.data.form.note, '本月正常营业');
    assert.equal(editor.data.month, '2026-10');
    assert.equal(state.modals.length, 0);
    assert.equal(submissions(state).length, 0);
    let submittingDuringRequest;
    state.afterResponse = async options => {
      if (options.data?.command !== 'report.submit' || submittingDuringRequest !== undefined) return;
      submittingDuringRequest = editor.data.submitting;
      await editor.submit(tap);
    };
    await editor.confirmSubmit();
    assert.equal(submittingDuringRequest, true);
    assert.equal(state.modals.length, 0);
    assert.equal(submissions(state).length, 1);
    assert.equal(editor.data.submitting, false);
  }
}));

test('lost HTTP response preserves values and the same API idempotency key only recovers one pending version', () => withReport(async ({ open, state, db }) => {
  const editor = await open();
  fill(editor);
  state.afterResponse = async options => {
    if (options.data?.command === 'report.submit') throw new Error('synthetic lost HTTP response after commit');
  };
  await editor.submit(tap);
  await editor.confirmSubmit();
  assert.equal(editor.data.showActionError, true);
  assert.match(editor.data.error, /网络/);
  assert.equal(editor.data.form.note, '本月正常营业');
  assert.equal(editor.data.busy, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reports WHERE month=? AND outlet=?').get(restoreScope.month, restoreScope.outlet).n, 1);

  state.afterResponse = null;
  await editor.submit(tap);
  await editor.confirmSubmit();
  const [failedTransport, replay] = submissions(state);
  assert.ok(failedTransport.key);
  assert.equal(failedTransport.key, replay.key);
  assert.equal(state.responses.filter(row => row.command === 'report.submit').at(-1).body.data.replayed, true);
  assert.equal(editor.data.canEdit, false);
  assert.equal(editor.data.error, '');
  assert.equal(db.prepare('SELECT count(*) AS n FROM reports WHERE month=? AND outlet=?').get(restoreScope.month, restoreScope.outlet).n, 1);
}));

test('validation stays at the button for insufficient data, locks pending and prohibited periods, and preserves enrollment null', () => withReport(async ({ open, state }) => {
  const editor = await open({ outlet: 'zz', month: '2026-10' });
  assert.equal(editor.data.enrollmentStatus, 'not_applicable');
  assert.equal(editor.data.applicable, false);
  fill(editor, { ...testFields, traffic: '' });
  await editor.submit(tap);
  assert.equal(editor.data.showActionError, true);
  assert.match(editor.data.error, /非负整数/);
  assert.equal(state.modals.length, 0);
  fill(editor, { traffic: '80' });
  await editor.submit(tap);
  await editor.confirmSubmit();
  assert.equal(submissions(state).at(-1).data.payload.enroll, null);
  assert.equal(editor.data.canEdit, false);
  await editor.submit(tap);
  assert.match(editor.data.error, /等待总部审核/);
  assert.equal(submissions(state).length, 1);

  const current = await open({ outlet: 'cs', month: '2026-11' });
  await current.submit(tap);
  assert.equal(current.data.canSubmit, false);
  assert.match(current.data.error, /暂未开放填报/);
  const paused = await open({ outlet: 'hy', month: '2026-10' });
  await paused.submit(tap);
  assert.equal(paused.data.canSubmit, false);
  assert.match(paused.data.error, /暂停营业/);
  assert.equal(submissions(state).length, 1);
}));
