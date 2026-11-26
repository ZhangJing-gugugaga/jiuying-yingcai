'use strict';

const assert = require('node:assert/strict');
const { mkdtempDisposableSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createServer } = require('../server/index.cjs');
const config = require('../../miniprogram/config');
const api = require('../../miniprogram/utils/api');
const { validate } = require('../scripts/wechat-validate.cjs');

const tap = dataset => ({ currentTarget: { dataset } });
const command = async (name, input) => (await api.command(name, input)).result;
const worklist = (params = {}) => api.request('/api/reports/worklist?' + api.query({ month: '2026-10', ...params }));
const pageFile = name => require.resolve('../../miniprogram/pages/' + name + '/index');
const markup = name => readFileSync(pageFile(name).replace(/\.js$/, '.wxml'), 'utf8');

async function run(work) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const originalBase = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map(), routes = [], scrolls = [];
  const navigate = action => ({ url, success }) => { routes.push({ action, url }); success?.(); };
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), showToast() {},
    navigateTo: navigate('page'), switchTab: navigate('tab'), reLaunch: navigate('reLaunch'),
    pageScrollTo: ({ selector }) => scrolls.push(selector),
    async request({ url, method, header, data, success, fail }) {
      try {
        const result = await fetch(url, { method, headers: header, body: method === 'GET' ? undefined : JSON.stringify(data) });
        success({ statusCode: result.status, data: await result.json() });
      } catch (error) { fail(error); }
    },
  };

  async function show(name, query = {}) {
    let definition;
    global.Page = page => { definition = page; };
    const file = pageFile(name);
    delete require.cache[file];
    require(file);
    const page = {
      ...definition, route: 'pages/' + name + '/index', data: structuredClone(definition.data),
      setData(values, callback) {
        for (const [key, value] of Object.entries(values)) {
          const fields = key.split('.');
          let target = this.data;
          for (const field of fields.slice(0, -1)) target = target[field] ||= {};
          target[fields.at(-1)] = value;
        }
        callback?.();
      },
    };
    global.getCurrentPages = () => [page];
    page.onLoad(query);
    await page.onShow();
    assert.equal(page.data.error, '');
    return page;
  }

  async function destination() {
    const url = new URL(routes.at(-1).url, 'https://native.invalid');
    return show(url.pathname.split('/')[2], Object.fromEntries(url.searchParams));
  }

  try {
    await api.login('partnerA');
    await work({ app, show, destination, routes, scrolls });
  } finally {
    config.apiBase = originalBase;
    delete global.wx;
    delete global.Page;
    delete global.getCurrentPages;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('the same matters page shows due tasks and notification filters while marking a notice read leaves its task open', () => run(async ({ show }) => {
  await api.login('manager');
  await command('jobs.run', {});
  await api.login('partnerA');
  const page = await show('tasks');
  const task = page.data.state.businessTasks.find(row => row.kind === 'report_missing');
  assert.ok(task);
  assert.equal(page.data.section, 'tasks');
  assert.match(markup('tasks'), /月度位置核验[\s\S]*待我处理[\s\S]*处理中[\s\S]*通知/);
  assert.ok(page.data.taskRows.find(row => row.id === task.id).unreadNoticeIds.length);
  await page.selectSection(tap({ section: 'notices' }));
  await page.filterStatus(tap({ status: 'unread' }));
  const notice = page.data.messages.find(row => row.taskId === task.id);
  assert.ok(notice);
  assert.ok(!page.data.noticeRows.some(row => row.id === notice.id));
  await page.read(tap({ id: notice.id }));
  assert.equal((await api.detail('messages', notice.id)).read, true);
  assert.equal((await api.detail('businessTasks', task.id)).status, 'open');
  await page.selectSection(tap({ section: 'tasks' }));
  assert.equal(page.data.status, 'open');
  assert.ok(page.data.taskRows.some(row => row.id === task.id));
  await page.selectSection(tap({ section: 'notices' }));
  assert.equal(page.data.statusFilter, 'unread');
  assert.ok(!page.data.messages.some(row => row.id === notice.id));
}));

test('notifications load later pages and restore the original matters section, notice and filter after support', () => run(async ({ app, show, destination, routes, scrolls }) => {
  const chat = await command('support.chat', { text: '查询我的网点' });
  await command('support.human', { id: chat.id });
  await api.login('support');
  await command('support.claim', { id: chat.id });
  await command('support.reply', { id: chat.id, text: '请查看总部回复' });
  const state = app.store.load();
  const notice = state.messages.find(row => row.recordId === chat.id);
  assert.ok(notice);
  for (let index = 0; index < 52; index++) {
    state.messages.push({ ...notice, id: 'msg-new-' + index, target: 'outlets', recordId: 'cs' });
  }
  app.store.save(state);
  await api.login('partnerA');

  const page = await show('tasks', { section: 'notices', status: 'unread' });
  assert.equal(page.data.statusFilter, 'unread');
  assert.ok(page.data.pagers.messages.hasMore);
  assert.ok(!page.data.messages.some(row => row.id === notice.id));
  await page.more(tap({ collection: 'messages' }));
  assert.ok(page.data.messages.some(row => row.id === notice.id));
  assert.equal(page.data.pagers.messages.hasMore, false);
  await page.open(tap({ id: notice.id }));
  assert.equal(routes.at(-1).action, 'page');
  assert.equal((await api.detail('messages', notice.id)).read, true);
  const support = await destination();
  assert.equal(support.data.chat.id, chat.id);
  support.backToMessages();
  assert.equal(routes.at(-1).url, '/pages/tasks/index?section=notices&status=unread&id=' + notice.id);
  const returned = await destination();
  assert.equal(returned.data.section, 'notices');
  assert.equal(returned.data.statusFilter, 'unread');
  assert.equal(returned.data.messages[0].id, notice.id);
  assert.equal(returned.data.messages[0].read, true);
  assert.equal(scrolls.at(-1), '#notice-' + notice.id);
  await returned.selectSection(tap({ section: 'tasks' }));
  assert.equal(returned.data.section, 'tasks');
}));

test('all responsibility pages remain available after switching between notices and tasks', () => run(async ({ app, show }) => {
  await api.login('manager');
  await command('jobs.run', {});
  const state = app.store.load();
  const assigned = state.businessTasks.find(row => row.queue === 'partner' && row.kind === 'location_missing' && row.outlet === 'zz');
  assert.ok(assigned);
  for (let index = 0; index < 52; index++) {
    const id = 'task-pager-' + index;
    state.businessTasks.push({ ...assigned, id, responsibilityKey: id, status: 'resolved' });
  }
  app.store.save(state);
  await api.login('partnerA');

  const page = await show('tasks', { status: 'resolved' });
  await page.selectSection(tap({ section: 'notices' }));
  await page.selectSection(tap({ section: 'tasks' }));
  assert.equal(page.data.status, 'resolved');
  assert.equal(page.data.taskRows.length, 50);
  assert.ok(page.data.pagers.businessTasks.hasMore);
  await page.more(tap({ collection: 'businessTasks' }));
  assert.equal(page.data.taskRows.filter(row => row.id.startsWith('task-pager-')).length, 52);
  assert.equal(page.data.pagers.businessTasks.hasMore, false);
}));

test('the generic verification link keeps the server month and requires an outlet choice while an assigned task is exact', () => run(async ({ app, show, destination, routes }) => {
  await api.login('manager');
  await command('jobs.run', {});
  await api.login('partnerA');
  const page = await show('tasks');
  const assigned = page.data.state.businessTasks.find(row => row.kind === 'location_missing' && row.outlet === 'zz');
  assert.ok(assigned);
  await page.open(tap({ id: assigned.id }));
  assert.match(routes.at(-1).url, /^\/pages\/location\/index\?outlet=zz&month=/);
  const exact = await destination();
  assert.equal(exact.data.outletId, assigned.outlet);
  assert.equal(exact.data.month, assigned.month);

  const month = page.data.state.today.slice(0, 7);
  const state = app.store.load();
  const source = state.outlets.find(row => row.id === 'zz');
  for (const count of [3, 6, 20]) {
    const extra = count - state.outlets.filter(row => row.owner === source.owner).length;
    for (let index = 0; index < extra; index++) {
      const id = 'outlet-verification-' + count + '-' + index;
      state.outlets.push({ ...source, id, city: '测试地区' + count + '-' + index });
    }
    if (extra) app.store.save(state);
    page.openLocation();
    assert.equal(routes.at(-1).url, '/pages/location/index?month=' + month);
    const generic = await destination();
    assert.equal(generic.data.outlets.length, count);
    assert.equal(generic.data.outletId, '');
    const selectedIndex = generic.data.outlets.findIndex(row => row.id === 'zz');
    await generic.chooseOutletFromPicker({ detail: { value: selectedIndex + 1 } });
    assert.equal(generic.data.outletId, 'zz');
    assert.equal(generic.data.month, month);
  }
}));

test('a returned report leads with its reason and edit action, and full versions expand on demand', () => run(async ({ show, scrolls }) => {
  const scope = { outlet: 'zz', month: '2026-10' };
  const report = await command('report.submit', { ...scope, revenue: 1245.61, orders: 12, traffic: 25, enroll: null, note: '复验' });
  await api.login('ops');
  await command('review.report', { id: report.id, decision: 'return', note: '请核对本月客流' });
  await api.login('partnerA');

  const page = await show('report', { ...scope, id: report.id });
  const detail = markup('report');
  const list = markup('reports');
  const history = detail.indexOf('wx:if="{{historyExpanded && versions.length}}"');
  assert.ok(history > detail.indexOf('{{returnedReason}}'));
  assert.ok(history > detail.indexOf('bindtap="continueReport"'));
  assert.ok(history < detail.indexOf('V{{linkedVersion.version}}'));
  assert.match(list, /总部退回意见/);
  assert.doesNotMatch(list, /查看版本摘要/);
  assert.equal(page.data.returnedReason, '请核对本月客流');
  assert.equal(page.data.formExpanded, false);
  assert.equal(page.data.historyExpanded, false);
  page.showVersions();
  assert.equal(page.data.historyExpanded, true);
  assert.equal(scrolls.at(-1), '#report-history');
  await page.continueReport();
  assert.equal(page.data.canEdit, true);
  assert.equal(page.data.formExpanded, true);
  assert.equal(page.data.historyExpanded, false);
  assert.equal(page.data.outletId, scope.outlet);
  assert.equal(page.data.month, scope.month);
  assert.deepEqual(page.data.form, { revenue: 1245.61, orders: 12, traffic: 25, enroll: '', note: '复验' });
  assert.equal(scrolls.at(-1), '#report-edit');
}));

test('a real return notice reaches the right monthly editor and stays usable after a single resubmission', () => run(async ({ app, show, destination }) => {
  const scope = { outlet: 'zz', month: '2026-10' };
  const initial = await command('report.submit', { ...scope, revenue: 1245.61, orders: 12, traffic: 25, enroll: null, note: '隔离验收' });
  await api.login('ops');
  await command('review.report', { id: initial.id, decision: 'return', note: '请核对本月客流' });
  await api.login('partnerA');

  const messages = await api.collection('messages', { limit: 200 });
  const notice = messages.items.find(row => row.title === '月报退回' && row.recordId === initial.id);
  assert.ok(notice);
  const inbox = await show('tasks', { section: 'notices', id: notice.id });
  await inbox.open(tap({ id: notice.id }));
  const editor = await destination();
  assert.ok(editor.data.outlets.length >= 3);
  assert.equal(editor.data.linkedVersion.id, initial.id);
  assert.equal(editor.data.returnedReason, '请核对本月客流');
  assert.equal(editor.data.canEdit, false);
  assert.match(markup('report'), /class="report-identity"/);

  await editor.continueReport();
  assert.equal(editor.data.outletId, scope.outlet);
  assert.equal(editor.data.month, scope.month);
  assert.equal(editor.data.canEdit, true);
  editor.input({ ...tap({ field: 'traffic' }), detail: { value: '26' } });
  editor.submit();
  await editor.confirmSubmit();
  await editor.confirmSubmit();
  const lineage = app.store.load().reports.filter(row => row.outlet === scope.outlet && row.month === scope.month);
  assert.deepEqual(lineage.map(row => [row.version, row.status, row.traffic]), [[1, 'returned', 25], [2, 'pending', 26]]);
  await api.login('ops');
  assert.equal((await api.detail('reports', lineage[1].id)).status, 'pending');
  assert.ok(app.store.load().businessTasks.some(row => row.recordId === lineage[1].id && row.kind === 'report_review' && row.status === 'open'));
  await api.login('partnerA');

  const oldNotice = await show('report', { ...scope, id: initial.id });
  assert.equal(oldNotice.data.linkedVersion.id, initial.id);
  assert.equal(oldNotice.data.canEdit, false);
  assert.equal(oldNotice.data.currentAction, '查看当前月报');
  await oldNotice.continueReport();
  assert.equal(oldNotice.data.latestSubmittedVersion.id, lineage[1].id);
  assert.equal(oldNotice.data.canEdit, false);
  assert.equal(oldNotice.data.formExpanded, true);
  assert.equal(oldNotice.data.form.traffic, 26);
}));

test('completed matters open as a separate view and return to the original notice filter', () => run(async ({ show }) => {
  const page = await show('tasks', { section: 'notices', status: 'read' });
  await page.status(tap({ status: 'resolved' }));
  const template = markup('tasks');
  assert.match(template, /class="title"[^>]*>[^<]*已完成的事项/);
  assert.match(template, /section==='notices'\?'active':''/);
  assert.doesNotMatch(template, /section==='notices'\s*\|\|\s*status==='resolved'/);
  assert.equal(page.data.section, 'tasks');
  assert.equal(page.data.status, 'resolved');
  await page.selectSection(tap({ section: 'notices' }));
  assert.equal(page.data.section, 'notices');
  assert.equal(page.data.statusFilter, 'read');
}));

test('returned report filter finds the latest actionable version beyond a page of historical returns', () => run(async ({ app, show }) => {
  const month = '2026-10';
  const pendingChange = await command('report.submit', { outlet: 'zz', month, revenue: 452, orders: 12, traffic: 25, enroll: null });
  await api.login('ops');
  await command('review.report', { id: pendingChange.id, decision: 'return', note: '请按实际订单修改' });
  await api.login('partnerA');
  const inReview = await command('report.submit', { outlet: 'cs', month, revenue: 452, orders: 12, traffic: 25, enroll: 0 });
  const state = app.store.load();
  const csReport = state.reports.find(row => row.id === inReview.id);
  csReport.version = 53;
  for (let version = 1; version < csReport.version; version++) {
    state.reports.push({ ...csReport, id: 'rpt-historical-return-' + version, version, status: 'returned', reviewNote: '前次处理意见' });
  }
  app.store.save(state);

  const unfiltered = await api.collection('reports', { month, status: 'returned', includeVersionNumbers: 'true' });
  assert.equal(unfiltered.total, 53);
  assert.ok(unfiltered.hasMore);
  const exact = await api.collection('reports', { month, status: 'returned', latestOnly: 'true', includeVersionNumbers: 'true' });
  assert.equal(exact.total, 1);
  assert.deepEqual(exact.items.map(row => row.id), [pendingChange.id]);
  const historical = await api.detail('reports', 'rpt-historical-return-1');
  assert.equal(historical.summaryOnly, true);
  assert.equal(historical.status, 'returned');

  const list = await show('reports');
  assert.ok(!list.data.reportRows.some(row => row.reportId?.startsWith('rpt-historical-return-')));
  await list.filter(tap({ value: 'action' }));
  assert.deepEqual(list.data.reportRows.map(row => row.reportId), [pendingChange.id]);
  assert.equal(list.data.worklist.total, 1);

  await api.login('partnerB');
  assert.equal((await api.collection('reports', { month, status: 'returned', latestOnly: 'true' })).total, 0);
  await assert.rejects(api.detail('reports', pendingChange.id), { status: 404 });
}));

test('the report worklist and its summary include all scoped outlets before jobs run', () => run(async ({ show, destination, routes }) => {
  const rows = await worklist();
  assert.equal(rows.month, '2026-10');
  assert.deepEqual(rows.summary, { expected: 3, submitted: 0, exempt: 0, actionable: 2, awaitingExemption: 1, inReview: 0 });
  assert.equal(rows.total, 3);
  assert.deepEqual(rows.items.map(row => [row.outletId, row.status, row.canSubmit]), [
    ['cs', 'missing', true], ['hy', 'exemption_pending', false], ['zz', 'missing', true],
  ]);
  assert.ok(rows.items.every(row => row.dueOn === '2026-11-05'));
  assert.equal(rows.items[1].reason, 'full_pause');

  const page = await show('reports');
  assert.deepEqual(page.data.reportRows.map(row => row.outletId), ['cs', 'hy', 'zz']);
  page.open(tap({ outlet: 'zz', month: rows.month }));
  assert.equal(routes.at(-1).url, '/pages/report/index?outlet=zz&month=2026-10');
  const editor = await destination();
  assert.equal(editor.data.outletId, 'zz');
  assert.equal(editor.data.canEdit, true);
  page.open(tap({ outlet: 'hy', month: rows.month }));
  const pause = await destination();
  assert.equal(pause.data.outletId, 'hy');
  assert.match(pause.data.editNotice, /整月暂停营业/);
  assert.equal(pause.data.canSubmit, false);
}));

test('the report worklist preserves returned and effective versions without exposing finance fields or audit', () => run(async ({ app, show, destination, routes }) => {
  const month = '2026-10';
  const scope = { outlet: 'cs', month };
  const values = { ...scope, revenue: 254.3, orders: 5, traffic: 8, enroll: 0 };
  const original = await command('report.submit', values);
  await api.login('ops');
  await command('review.report', { id: original.id, decision: 'approve' });
  await api.login('partnerA');
  await command('report.correct', { id: original.id, reason: '测试更正' });
  const revised = await command('report.submit', { ...values, revenue: 255.3 });

  const pending = (await worklist({ outlet: 'cs', status: 'reviewing' })).items[0];
  assert.deepEqual([pending.status, pending.reportId, pending.latestVersion, pending.effectiveVersion], ['pending', revised.id, 2, 1]);
  await api.login('ops');
  await command('review.report', { id: revised.id, decision: 'approve' });
  await api.login('partnerA');
  const finance = (await worklist({ outlet: 'cs', status: 'reviewing' })).items[0];
  assert.deepEqual([finance.status, finance.reason, finance.canSubmit], ['finance', 'reviewing', false]);
  await api.login('finance');
  await command('review.report', { id: revised.id, decision: 'return', note: '请核对营业收入' });
  await api.login('partnerA');

  const list = await show('reports', { outlet: 'cs', month });
  const returned = list.data.reportRows[0];
  assert.deepEqual([returned.status, returned.reportId, returned.latestVersion, returned.effectiveVersion, returned.returnNote],
    ['returned', revised.id, 2, 1, '请核对营业收入']);
  list.open(tap({ outlet: 'cs', month, reportId: revised.id }));
  assert.equal(routes.at(-1).url, `/pages/report/index?outlet=cs&month=${month}&id=${revised.id}`);
  const editor = await destination();
  assert.equal(editor.data.returnedReason, '请核对营业收入');
  assert.equal(editor.data.currentApprovedVersion.id, original.id);

  await command('report.draft', { ...scope, orders: 6 });
  const draft = (await worklist({ outlet: 'cs', status: 'action' })).items[0];
  assert.deepEqual([draft.status, draft.reportId, draft.effectiveVersion, draft.returnNote], ['draft', null, 1, '请核对营业收入']);
  assert.ok(!['trail', 'revenue', 'orders', 'traffic', 'enroll'].some(key => Object.hasOwn(draft, key)));
  await list.onShow();
  list.open(tap({ outlet: 'cs', month }));
  const draftEditor = await destination();
  assert.equal(draftEditor.data.hasDraft, true);
  assert.equal(draftEditor.data.form.orders, 6);

  const state = app.store.load();
  state.drafts = state.drafts.filter(row => row.outlet !== 'cs' || row.month !== month);
  const revoked = state.reports.find(row => row.id === revised.id);
  Object.assign(revoked, { status: 'approved', revoked: true, current: false });
  app.store.save(state);
  const approved = (await worklist({ outlet: 'cs', status: 'approved' })).items[0];
  assert.deepEqual([approved.status, approved.reportId, approved.latestVersion, approved.effectiveVersion], ['approved', original.id, 2, 1]);
  await list.onShow();
  list.open(tap({ outlet: 'cs', month, reportId: original.id }));
  const approvedEditor = await destination();
  assert.equal(approvedEditor.data.linkedVersion.id, original.id);
  approvedEditor.showVersions();
  await approvedEditor.selectVersion(tap({ id: revised.id }));
  assert.equal(approvedEditor.data.linkedVersion.revoked, true);

  Object.assign(state.reports.find(row => row.id === original.id), { revoked: true, current: false });
  app.store.save(state);
  const missing = await worklist({ outlet: 'cs', status: 'action' });
  assert.deepEqual([missing.summary.submitted, missing.items[0].status, missing.items[0].reportId], [0, 'missing', null]);
}));

test('report worklist filters and paginates within owner scope while coverage keeps full scope', () => run(async ({ app }) => {
  const state = app.store.load(), source = state.outlets.find(row => row.id === 'cs');
  for (let index = 0; index < 26; index++) {
    const id = 'report-worklist-' + String(index).padStart(2, '0');
    state.outlets.push({ ...source, id, outlet: id });
  }
  const future = state.outlets.find(row => row.id === 'report-worklist-00');
  future.events = [{ date: '2026-11-10', status: 'open' }];
  const enrollment = state.outlets.find(row => row.id === 'report-worklist-01');
  enrollment.enrollmentStatus = 'pending';
  app.store.save(state);

  const first = await worklist();
  const second = await worklist({ offset: 25 });
  assert.deepEqual([first.items.length, first.total, first.offset, first.limit, first.hasMore], [25, 29, 0, 25, true]);
  assert.deepEqual([second.items.length, second.total, second.offset, second.hasMore], [4, 29, 25, false]);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.outletId)).size, 29);
  assert.deepEqual(second.summary, first.summary);
  const dashboard = await api.request('/api/dashboard?period=2026-10&outlet=all&kind=month&mode=process&limit=1');
  for (const key of ['expected', 'submitted', 'exempt']) assert.equal(first.summary[key], dashboard.reportingCoverage[key]);

  const reviewing = await worklist({ status: 'reviewing' });
  assert.deepEqual(reviewing.items.map(row => row.outletId), ['hy']);
  assert.deepEqual(reviewing.summary, first.summary);
  const onlyFuture = await worklist({ outlet: future.id });
  assert.deepEqual([onlyFuture.items[0].status, onlyFuture.items[0].reason, onlyFuture.summary.expected], ['not_required', 'no_operation', 0]);
  const onlyEnrollment = await worklist({ outlet: enrollment.id, status: 'action' });
  assert.deepEqual([onlyEnrollment.items[0].status, onlyEnrollment.items[0].reason, onlyEnrollment.items[0].canSubmit], ['missing', 'enrollment_pending', false]);
  assert.deepEqual((await worklist({ outlet: 'cs', month: '2026-11' })).items.map(row => [row.status, row.reason]), [['not_open', 'current_month']]);
  assert.deepEqual((await worklist({ outlet: 'cs', month: '2026-12' })).items.map(row => [row.status, row.reason]), [['not_open', 'future_month']]);

  await assert.rejects(worklist({ outlet: 'gz' }), { status: 403 });
  for (const query of [{ month: '2026-13' }, { status: 'pending' }, { limit: 51 }, { offset: -1 }, { offset: '1.5' }]) {
    await assert.rejects(worklist(query), { status: 400 });
  }
  await api.login('manager');
  await command('report.exempt', { outlet: 'hy', month: '2026-10', reason: '测试核实整月停业' });
  await assert.rejects(worklist(), { status: 403 });
  await api.login('partnerA');
  const exempt = await worklist({ outlet: 'hy' });
  assert.equal(exempt.items[0].status, 'exempt');
  assert.deepEqual(exempt.summary, { expected: 0, submitted: 0, exempt: 1, actionable: 0, awaitingExemption: 0, inReview: 0 });
}));

test('the exact report-list outlet remains visibly selected beyond the first outlet page', () => run(async ({ app, show, routes }) => {
  const list = await show('reports');
  const selected = list.data.options.findIndex(row => row.id === 'cs');
  assert.ok(selected > 0);
  await list.pickOutlet({ detail: { value: selected } });

  const state = app.store.load();
  const source = state.outlets.find(row => row.id === 'cs');
  for (let index = 0; index < 51; index++) {
    state.outlets.push({ ...source, id: 'out-same-owner-paginated-' + index });
  }
  app.store.save(state);

  await list.onShow();
  assert.notEqual(list.data.outletIndex, 0);
  assert.equal(list.data.options[list.data.outletIndex].id, 'cs');
  list.newReport();
  assert.match(routes.at(-1).url, /[?&]outlet=cs(?:&|$)/);
}));

test('static WXML validation checks a registered include against the consuming page handlers', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'jyyc-wxml-include-'));
  const write = (file, value) => writeFileSync(join(dir.path, file), value);
  write('app.json', '{"pages":["tasks","messages"]}');
  write('project.config.json', '{"compileType":"miniprogram","miniprogramRoot":"./"}');
  for (const page of ['tasks', 'messages']) {
    write(page + '.json', '{}');
    write(page + '.wxss', '');
  }
  write('tasks.js', 'Page({ open() {} });');
  write('tasks.wxml', '<button bindtap="open">查看</button>');
  write('messages.js', 'Page({});');
  write('messages.wxml', '<include src="tasks.wxml"/>');
  assert.ok(validate(dir.path).errors.includes('messages 事件缺失 open'));
  write('messages.js', 'Page({ open() {} });');
  assert.equal(validate(dir.path).valid, true);

  write('messages.wxml', '<include src="../out-of-project.wxml"/>');
  assert.match(validate(dir.path).errors[0], /WXML引用必须指向已注册/);
  write('messages.wxml', '<include src="messages.wxml"/>');
  assert.match(validate(dir.path).errors[0], /无循环/);
});
