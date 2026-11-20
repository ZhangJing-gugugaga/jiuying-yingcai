'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const api = require('../miniprogram/utils/api');
const config = require('../miniprogram/config');

const tap = dataset => ({ currentTarget: { dataset } });
const change = value => ({ detail: { value: String(value) } });

function page(name, query = {}) {
  const filename = require.resolve('../miniprogram/pages/' + name + '/index');
  let definition;
  global.Page = value => { definition = value; };
  try {
    delete require.cache[filename];
    require(filename);
  } finally {
    delete global.Page;
  }
  const native = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(patch, callback) {
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part] ||= {};
        target[parts.at(-1)] = value;
      }
      callback?.();
    },
  };
  native.onLoad(query);
  return native;
}

async function fixture(t, run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = { apiBase: config.apiBase, wx: global.wx };
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map(), requests = [], destinations = [], exports = [];
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    navigateTo({ url, success }) {
      destinations.push(new URL(url, 'http://local'));
      success?.();
    },
    showToast() {},
    async request(options) {
      let response, body;
      try {
        response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        body = await response.json();
      } catch (error) {
        return options.fail(error);
      }
      requests.push({ method: options.method, url: new URL(options.url), status: response.status, requestId: body.requestId });
      options.success({ statusCode: response.status, data: body });
    },
  };
  const previousOpenDocument = api.openDocument;
  api.openDocument = async (url, format) => exports.push([new URL(url, 'http://local'), format]);
  t.after(async () => {
    api.openDocument = previousOpenDocument;
    config.apiBase = previous.apiBase;
    global.wx = previous.wx;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  await api.login('partnerA');
  async function staff(actor, command, payload) {
    const session = api.session();
    await api.login(actor);
    try { return (await api.command(command, payload)).result; }
    finally { storage.set('jyyc.session', session); }
  }
  await run({ app, requests, destinations, exports, staff });
}

test('confirmed real-channel payment and status recheck leave the unpaid filter without expanding bill scope', async () => {
  const previous = { wx: global.wx, prepay: api.prepay, queryPayment: api.queryPayment };
  global.wx = { requestPayment: ({ success }) => success() };
  try {
    const fees = page('fees', { outlet: 'cs', month: '2026-11' });
    const bill = { id: 'bill-isolated', outlet: 'cs', status: 'unpaid' };
    fees.setData({ state: { adapterMode: 'real' }, paymentEnabled: true, scopeReady: true, bills: [bill], statusFilter: 'unpaid' });
    const filters = [];
    fees.refresh = () => { filters.push([fees.data.statusFilter, fees.data.selected, fees.data.filterMonthValue]); };
    api.prepay = async () => ({ paymentId: 'pay-isolated', requestPayment: {} });
    let status = 'pending';
    api.queryPayment = async () => ({ payment: { id: 'pay-isolated', status } });
    const event = id => tap({ id });
    await fees.pay(event(bill.id));
    assert.equal(fees.data.statusFilter, 'unpaid');
    status = 'success';
    await fees.resume(event('pay-isolated'));
    fees.setData({ statusFilter: 'unpaid' });
    await fees.pay(event(bill.id));
    assert.deepEqual(filters, [['unpaid', 'cs', '2026-11'], ['all', 'cs', '2026-11'], ['all', 'cs', '2026-11']]);
  } finally {
    global.wx = previous.wx;
    api.prepay = previous.prepay;
    api.queryPayment = previous.queryPayment;
  }
});

test('fee filters preserve the outlet across pages and same-name choices until an explicit selection of all outlets', t => fixture(t, async ({ app, requests }) => {
  const state = app.store.load();
  const cs = state.outlets.find(row => row.id === 'cs');
  for (let index = 0; index < 52; index++) {
    const id = 'phase-one-outlet-' + index;
    state.outlets.push({ ...cs, id, outlet: id });
  }
  app.store.transaction(() => app.store.save(state));
  const first = await api.collection('outlets', { limit: 50 });
  assert.equal(first.hasMore, true);
  assert.ok(!first.items.some(row => row.id === 'cs'));
  requests.length = 0;

  const fees = page('fees', { outlet: 'cs', month: '2026-11' });
  await fees.onShow();
  assert.equal(fees.data.error, '');
  assert.equal(fees.data.outlets[fees.data.outletIndex].id, 'cs');
  assert.ok(requests.some(row => row.url.pathname === '/api/collections/outlets/cs' && row.status === 200 && row.requestId));
  const duplicate = fees.data.outlets.find(row => row.id === 'phase-one-outlet-51');
  assert.notEqual(fees.data.outlets[fees.data.outletIndex].label, duplicate.label);
  await fees.filterOutlet(change(fees.data.outlets.indexOf(duplicate)));
  assert.equal(fees.data.selected, duplicate.id);
  assert.equal(fees.data.bills.length, 0);

  await fees.clearFilters();
  assert.equal(fees.data.selected, duplicate.id);
  assert.equal(fees.data.filterMonthValue, '');
  assert.equal(fees.data.bills.length, 0);
  await fees.filterOutlet(change(fees.data.outlets.findIndex(row => row.id === '')));
  assert.equal(fees.data.selected, '');
  assert.ok(fees.data.bills.some(row => row.outlet === 'cs'));
  assert.ok(fees.data.bills.every(row => row.owner === 'p1'));
}));

test('an unavailable fee outlet keeps the failed scope and disables stale bill actions', t => fixture(t, async ({ app, requests, destinations }) => {
  const fees = page('fees', { outlet: 'cs', month: '2026-11' });
  await fees.onShow();
  const bill = fees.data.bills[0];
  assert.equal(bill.outlet, 'cs');
  const state = app.store.load();
  state.outlets.find(row => row.id === 'cs').owner = 'p2';
  app.store.transaction(() => app.store.save(state));
  requests.length = 0;

  await fees.refresh();
  assert.equal(fees.data.selected, 'cs');
  assert.match(fees.data.error, /网点/);
  assert.notEqual(fees.data.outlets[fees.data.outletIndex]?.label, '全部网点');
  assert.equal(fees.data.bills.length, 0);
  assert.ok(requests.some(row => row.url.pathname === '/api/collections/outlets/cs' && row.status === 404 && row.requestId));
  assert.ok(!requests.some(row => row.url.pathname === '/api/collections/bills'));
  await fees.openBill(tap({ id: bill.id }));
  await fees.pay(tap({ id: bill.id, channel: 'wechat' }));
  assert.equal(destinations.length, 0);
  assert.ok(!requests.some(row => row.url.pathname === '/api/payments/prepay'));

  const unauthorized = page('fees', { outlet: 'gz' });
  await unauthorized.onShow();
  assert.match(unauthorized.data.error, /网点/);
  assert.notEqual(unauthorized.data.outlets[unauthorized.data.outletIndex]?.label, '全部网点');
  await unauthorized.clearFilters();
  assert.equal(unauthorized.data.selected, 'gz');
  await unauthorized.filterOutlet(change(unauthorized.data.outlets.findIndex(row => row.id === '')));
  assert.equal(unauthorized.data.error, '');
  assert.ok(unauthorized.data.bills.every(row => row.outlet !== 'gz'));
}));

test('historical fee links keep the original bill and reject a conflicting month or outlet', t => fixture(t, async ({ app, requests, destinations }) => {
  const bill = app.store.load().bills.find(row => row.outlet === 'cs');
  const historical = page('fees', { id: bill.id });
  requests.length = 0;
  await historical.onShow();
  assert.equal(historical.data.error, '');
  assert.deepEqual(historical.data.bills.map(row => row.id), [bill.id]);
  assert.equal(historical.data.selected, bill.outlet);
  assert.equal(historical.data.filterMonthValue, bill.month);
  await historical.openBill(tap({ id: bill.id }));
  assert.deepEqual(Object.fromEntries(destinations.at(-1).searchParams), { outlet: bill.outlet, month: bill.month, ledgerBillId: bill.id });
  assert.ok(!requests.some(row => row.url.pathname === '/api/collections/bills' && !row.url.searchParams.get('outlet')));

  for (const query of [{ outlet: 'zz', month: bill.month }, { outlet: bill.outlet, month: '2026-10' }]) {
    const mismatch = page('fees', { ...query, id: bill.id });
    await mismatch.onShow();
    assert.match(mismatch.data.error, /原账单/);
    assert.equal(mismatch.data.bills.length, 0);
    await mismatch.pay(tap({ id: bill.id, channel: 'wechat' }));
  }
  assert.ok(!requests.some(row => row.url.pathname === '/api/payments/prepay'));
}));

test('outlet pagination cannot unlock a fee view whose original outlet is unauthorized', t => fixture(t, async ({ app, requests, destinations }) => {
  const state = app.store.load();
  const outlet = state.outlets.find(row => row.id === 'cs');
  for (let index = 0; index < 52; index++) {
    const id = 'fee-recover-' + index;
    state.outlets.push({ ...outlet, id, outlet: id });
  }
  app.store.transaction(() => app.store.save(state));
  const fees = page('fees', { outlet: 'gz', month: '2026-11' });
  await fees.onShow();
  assert.equal(fees.data.scopeReady, false);
  assert.equal(fees.data.pagers.outlets.hasMore, true);
  await fees.more(tap({ collection: 'outlets' }));
  assert.equal(fees.data.scopeReady, false);
  assert.match(fees.data.error, /网点/);
  await fees.openFinance();
  assert.equal(destinations.length, 0);
  assert.ok(!requests.some(row => row.url.pathname === '/api/collections/bills'));
  const agreements = page('agreements', { outlet: 'gz' });
  await agreements.onShow();
  assert.match(agreements.data.error, /网点/);
  await agreements.more(tap({ collection: 'outlets' }));
  assert.match(agreements.data.error, /网点/);
  assert.equal(agreements.data.rows.length, 0);
  assert.ok(!requests.some(row => row.url.pathname === '/api/collections/agreements'));
  await fees.filterOutlet(change(fees.data.outlets.findIndex(row => row.id === 'cs')));
  assert.equal(fees.data.scopeReady, true);
  assert.equal(fees.data.selected, 'cs');
  assert.ok(fees.data.bills.length && fees.data.bills.every(row => row.outlet === 'cs'));
}));

test('simulated payment returns to its exact bill, and switching outlets clears the result without deleting the receipt', t => fixture(t, async ({ app, destinations }) => {
  const fees = page('fees', { outlet: 'cs' });
  await fees.onShow();
  const current = fees.data.bills.find(row => row.status === 'unpaid' && row.simulation);
  assert.ok(current);
  await fees.pay(tap({ id: current.id, channel: 'wechat' }));
  await fees.resolve(tap({ outcome: 'success' }));
  assert.equal(fees.data.paymentNotice, '支付成功');
  assert.equal(fees.data.payment.status, 'success');
  assert.equal(fees.data.payment.billId, current.id);
  fees.openConfirmedBill();
  assert.equal(destinations.at(-1).searchParams.get('ledgerBillId'), current.id);
  assert.equal(destinations.at(-1).searchParams.get('outlet'), current.outlet);
  assert.equal(destinations.at(-1).searchParams.get('month'), current.month);
  assert.equal(app.store.load().receipts.filter(row => row.billId === current.id).length, 1);
  await fees.filterOutlet(change(fees.data.outlets.findIndex(row => row.id === 'zz')));
  assert.equal(fees.data.selected, 'zz');
  assert.equal(fees.data.paymentNotice, '');
  assert.equal(fees.data.payment, null);
  assert.equal(app.store.load().receipts.filter(row => row.billId === current.id).length, 1);
}));

test('finance cannot act on authorized bills or receipts that conflict with the route scope', t => fixture(t, async ({ app, requests, destinations }) => {
  const state = app.store.load();
  const bill = state.bills.find(row => row.outlet === 'cs');
  const receipt = { id: 'receipt-phase-one', billId: bill.id, outlet: bill.outlet, owner: bill.owner,
    month: bill.month, amount: bill.amount, status: 'success', channel: 'offline', adapterMode: 'manual' };
  state.receipts.push(receipt);
  app.store.transaction(() => app.store.save(state));
  const otherBill = state.bills.find(row => row.outlet === 'zz');
  const otherReceipt = { ...receipt, id: 'receipt-other-phase-one', outlet: otherBill.outlet, billId: otherBill.id };
  state.receipts.push(otherReceipt);
  app.store.transaction(() => app.store.save(state));
  requests.length = 0;

  for (const query of [
    { outlet: 'zz', month: bill.month, ledgerBillId: bill.id, type: 'offline', billId: bill.id },
    { outlet: bill.outlet, month: '2026-10', ledgerBillId: bill.id, type: 'refund', receiptId: receipt.id },
    { outlet: bill.outlet, month: bill.month, ledgerBillId: bill.id, section: 'receipts', ledgerRecordId: otherReceipt.id },
    { outlet: 'gz', month: bill.month, ledgerBillId: bill.id, type: 'offline', billId: bill.id },
  ]) {
    const finance = page('finance', query);
    await finance.onShow();
    assert.ok(finance.data.error);
    assert.equal(finance.data.ledgerBill, null);
    assert.equal(finance.data.formBill, null);
    finance.setData({ 'form.amount': '5', 'form.reference': 'ISOLATED', 'form.reason': '范围校验' });
    await finance.submit();
    await finance.openBillAction(tap({ type: 'offline' }));
  }
  assert.equal(destinations.length, 0);
  assert.ok(!requests.some(row => row.method === 'POST'));
  assert.equal(app.store.load().offlinePayments.length, 0);
  assert.equal(app.store.load().refundRequests.length, 0);
}));

test('dashboard keeps the authorized scope, period range and export permission', t => fixture(t, async ({ exports, requests }) => {
  const invalid = page('dashboard', { outlet: 'gz', period: '2026-09' });
  await invalid.onShow();
  assert.equal(invalid.data.ready, false);
  assert.equal(invalid.params().outlet, 'gz');
  await invalid.export(tap({ format: 'xlsx' }));
  assert.equal(exports.length, 0);
  assert.ok(!requests.some(row => row.url.pathname === '/api/dashboard' && row.url.searchParams.get('outlet') === 'all'));

  const partner = page('dashboard', { outlet: 'cs', period: '2026-08' });
  await partner.onShow();
  await partner.kind(change(1));
  assert.equal(partner.data.periodDisplay, '2026年07月 至 2026年09月');
  await partner.export(tap({ format: 'xlsx' }));
  assert.deepEqual(Object.fromEntries(exports[0][0].searchParams), {
    period: '2026-08', kind: 'quarter', mode: 'settled', outlet: 'cs', format: 'xlsx',
  });

  await api.login('finance');
  const staff = page('dashboard', { period: '2026-09' });
  await staff.onShow();
  assert.equal(staff.data.ready, true);
  assert.equal(staff.data.state.capabilities.export, false);
  await staff.export(tap({ format: 'pdf' }));
  assert.equal(exports.length, 1);
}));

test('a bill opens its exact historical agreement and an inaccessible outlet clears the displayed contract', t => fixture(t, async ({ app, requests, destinations, staff }) => {
  const plan = await staff('manager', 'plan.publish', { name: '隔离验收服务方案', amount: 1980, serviceEntity: '验收服务主体',
    collectionEntity: '验收收款主体', invoiceEntity: '验收开票主体', terms: '隔离测试协议', reason: '验证协议历史' });
  const agreement = { outlet: 'cs', planId: plan.id, billDay: 1, dueDay: 5, reason: '验证协议历史' };
  const historical = await staff('manager', 'agreement.create', { ...agreement, startMonth: '2025-11', endMonth: '2026-10', reference: 'PHASE-ONE-OLD' });
  await staff('manager', 'agreement.create', { ...agreement, startMonth: '2026-11', endMonth: '2027-10', reference: 'PHASE-ONE-CURRENT' });
  const bill = await staff('finance', 'billing.generate', { agreementId: historical.id, month: '2026-10' });

  const finance = page('finance', { outlet: bill.outlet, month: bill.month, ledgerBillId: bill.id });
  await finance.onShow();
  await finance.openBillAgreement();
  assert.deepEqual(Object.fromEntries(destinations.at(-1).searchParams), { outlet: bill.outlet, id: bill.agreementId });
  const original = page('agreements', Object.fromEntries(destinations.at(-1).searchParams));
  await original.onShow();
  assert.equal(original.data.expandedAgreement, bill.agreementId);
  assert.deepEqual(original.data.rows.map(row => row.id), [bill.agreementId]);

  const state = app.store.load();
  state.outlets.find(row => row.id === 'cs').owner = 'p2';
  app.store.transaction(() => app.store.save(state));
  requests.length = 0;
  await original.refresh();
  assert.match(original.data.error, /网点/);
  assert.equal(original.data.rows.length, 0);
  assert.notEqual(original.data.outletOptions[original.data.outletIndex]?.label, '全部网点');
  assert.ok(!requests.some(row => row.url.pathname === '/api/collections/agreements'));
}));
