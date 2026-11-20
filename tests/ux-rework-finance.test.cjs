'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('../server/index.cjs');
const api = require('../miniprogram/utils/api');
const config = require('../miniprogram/config');

const tap = dataset => ({ currentTarget: { dataset } });
const picker = value => ({ detail: { value: String(value) } });

async function fixture(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = { apiBase: config.apiBase, wx: global.wx, Page: global.Page };
  const storage = new Map(), requests = [], navigation = [];
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    navigateTo({ url, success }) { navigation.push(new URL(url, 'http://local')); success?.(); },
    async request({ url, method, header, data, success, fail }) {
      try {
        const response = await fetch(url, { method, headers: header, body: method === 'GET' ? undefined : JSON.stringify(data) });
        const body = await response.json();
        requests.push({ url: new URL(url), method, requestId: body.requestId });
        success({ statusCode: response.status, data: body });
      } catch (error) { fail(error); }
    },
  };
  t.after(async () => {
    config.apiBase = previous.apiBase;
    global.wx = previous.wx;
    global.Page = previous.Page;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  await api.login('partnerA');
  async function open(name, query = {}) {
    const path = require.resolve('../miniprogram/pages/' + name + '/index');
    let definition;
    global.Page = value => { definition = value; };
    delete require.cache[path];
    require(path);
    const page = {
      ...definition, route: 'pages/' + name + '/index', data: structuredClone(definition.data),
      setData(values, callback) {
        for (const [key, value] of Object.entries(values)) {
          const fields = key.split('.');
          let target = this.data;
          for (const part of fields.slice(0, -1)) target = target[part] ||= {};
          target[fields.at(-1)] = value;
        }
        callback?.();
      },
    };
    page.onLoad(query);
    await page.onShow();
    return page;
  }
  async function staff(actor, command, payload) {
    const session = api.session();
    await api.login(actor);
    try { return (await api.command(command, payload)).result; }
    finally { storage.set('jyyc.session', session); }
  }
  return { app, requests, navigation, open, staff };
}

test('service fees use the entire authorized ledger while history loads only on demand', async t => {
  const { app, requests, open } = await fixture(t);
  const state = app.store.load();
  const source = state.bills.find(row => row.outlet === 'cs');
  for (let index = 0; index < 51; index++) {
    const month = new Date(Date.UTC(2020, index, 1)).toISOString().slice(0, 7);
    state.bills.push({ ...source, id: 'ux-fees-paged-' + index, month, amount: 0.01, status: 'unpaid' });
  }
  app.store.transaction(() => app.store.save(state));
  const fees = await open('fees', { outlet: 'cs' });
  assert.equal(fees.data.bills.length, 50);
  assert.equal(fees.data.pagers.bills.hasMore, true);
  assert.equal(fees.data.ledgerTotals.unpaid, '1,980.51');
  assert.ok(!requests.some(({ url }) => /\/api\/collections\/(payments|receipts|adjustments)$/.test(url.pathname)));
  assert.ok(requests.some(({ url }) => url.pathname === '/api/finance/summary' && !url.searchParams.has('month')));
  await fees.chooseSection(tap({ section: 'records' }));
  assert.ok(requests.some(({ url }) => url.pathname === '/api/collections/payments' && url.searchParams.get('outlet') === 'cs'));
  await fees.chooseSection(tap({ section: 'adjustments' }));
  assert.ok(requests.some(({ url }) => url.pathname === '/api/collections/adjustments' && url.searchParams.get('outlet') === 'cs'));
});

test('inline invoicing is attached to the displayed original receipt and its bill', async t => {
  const { app, navigation, requests, open, staff } = await fixture(t);
  const plan = await staff('manager', 'plan.publish', { name: '隔离服务方案', amount: 120, serviceEntity: '隔离服务主体',
    collectionEntity: '隔离收款主体', invoiceEntity: '隔离开票主体', terms: '隔离测试协议', reason: '原账单验收' });
  const agreement = await staff('manager', 'agreement.create', { outlet: 'cs', planId: plan.id, startMonth: '2026-10',
    endMonth: '2026-10', billDay: 1, dueDay: 5, reference: 'UX-FINANCE-AGREEMENT', reason: '原账单验收' });
  const generated = await staff('finance', 'billing.generate', { agreementId: agreement.id, month: '2026-10' });
  const state = app.store.load();
  const bill = state.bills.find(row => row.id === generated.id);
  bill.status = 'paid';
  const receipt = { id: 'receipt-ux-finance', billId: bill.id, outlet: bill.outlet, owner: bill.owner,
    month: bill.month, amount: bill.amount, status: 'success', channel: 'offline', adapterMode: 'manual' };
  state.receipts.push(receipt);
  app.store.transaction(() => app.store.save(state));
  const finance = await open('finance', { ledgerBillId: bill.id });
  assert.equal(finance.data.ledgerSection, 'receipts');
  assert.equal(finance.data.ledgerBill.dueText, '2026年10月05日');
  assert.equal(finance.data.ledgerBill.canPay, false);
  await finance.openBillSheet(tap({ type: 'invoice', id: receipt.id }));
  assert.equal(finance.data.financeView, 'bill');
  assert.equal(finance.data.billSheet, true);
  assert.deepEqual([finance.data.formBill.id, finance.data.formBill.outlet, finance.data.formBill.rawMonth, finance.data.formBill.receiptId],
    [bill.id, bill.outlet, bill.month, receipt.id]);
  assert.equal(navigation.length, 0);
  finance.setData({ 'form.amount': '10.00', 'form.title': '隔离测试', 'form.taxId': 'ISOLATED-TAX', 'form.reason': '隔离测试账单' });
  await finance.submit();
  assert.equal(finance.data.error, '');
  const created = app.store.load().invoiceRequests.find(row => row.receiptId === receipt.id);
  assert.deepEqual([created.billId, created.receiptId], [bill.id, receipt.id]);
  assert.equal(finance.data.selectedApplication.id, created.id);
  await finance.openApplicationBill();
  assert.equal(finance.data.ledgerBill.id, bill.id);
  assert.equal(navigation.length, 0);
  assert.ok(requests.every(({ url }) => !url.pathname.startsWith('/api/payments/')));
});

test('bill checkout keeps the original detail open until the provider confirms payment', async t => {
  const { app, requests, open } = await fixture(t);
  const bill = app.store.load().bills.find(row => row.outlet === 'cs');
  const payment = { id: 'pay-isolated-display', billId: bill.id, channel: 'wechat', status: 'pending' };
  const previous = { prepay: api.prepay, queryPayment: api.queryPayment };
  const nativeRequest = global.wx.request;
  const steps = [];
  global.wx.request = options => new URL(options.url).pathname === '/api/config'
    ? options.success({ statusCode: 200, data: { data: { adapterMode: 'real', paymentEnabled: true } } })
    : nativeRequest(options);
  global.wx.requestPayment = options => { steps.push('native-sheet'); options.success(); };
  api.prepay = async id => {
    assert.equal(id, bill.id);
    steps.push('prepay');
    return { paymentId: payment.id, requestPayment: {} };
  };
  api.queryPayment = async id => {
    assert.equal(id, payment.id);
    steps.push('query');
    return { payment: { ...payment } };
  };
  try {
    const finance = await open('finance', { outlet: bill.outlet, month: bill.month, ledgerBillId: bill.id });
    assert.equal(finance.data.ledgerBill.canPay, true);
    await finance.payBill();
    assert.equal(finance.data.ledgerBill.heading, '待支付');
    assert.match(finance.data.paymentMessage, /正在确认/);
    const state = app.store.load();
    state.bills.find(row => row.id === bill.id).status = 'paid';
    state.receipts.push({ id: 'receipt-isolated-display', billId: bill.id, outlet: bill.outlet, owner: bill.owner,
      month: bill.month, amount: bill.amount, status: 'success', paymentId: payment.id, adapterMode: 'real' });
    app.store.transaction(() => app.store.save(state));
    payment.status = 'success';
    await finance.checkBillPayment(tap({}));
    assert.equal(finance.data.financeView, 'bill');
    assert.equal(finance.data.ledgerBill.id, bill.id);
    assert.equal(finance.data.ledgerBill.heading, '已支付');
    assert.equal(finance.data.paymentMessage, '支付成功');
    assert.equal(finance.data.ledgerBill.records[0].id, 'receipt-isolated-display');
    assert.deepEqual(steps, ['prepay', 'native-sheet', 'query', 'query']);
    assert.ok(requests.every(({ url }) => !url.pathname.startsWith('/api/payments/')));
  } finally {
    api.prepay = previous.prepay;
    api.queryPayment = previous.queryPayment;
  }
});

test('a delayed prepay response cannot launch a native payment sheet after leaving a bill', async t => {
  const { app, open } = await fixture(t);
  const bill = app.store.load().bills.find(row => row.outlet === 'cs');
  const previous = api.prepay;
  const nativeRequest = global.wx.request;
  let resolvePrepay, sheets = 0;
  global.wx.request = options => new URL(options.url).pathname === '/api/config'
    ? options.success({ statusCode: 200, data: { data: { adapterMode: 'real', paymentEnabled: true } } })
    : nativeRequest(options);
  global.wx.requestPayment = options => { sheets++; options.success(); };
  api.prepay = id => {
    assert.equal(id, bill.id);
    return new Promise(resolve => { resolvePrepay = resolve; });
  };
  try {
    const finance = await open('finance', { ledgerBillId: bill.id });
    const starting = finance.payBill();
    finance.onHide();
    resolvePrepay({ paymentId: 'pay-isolated-late', requestPayment: {} });
    await starting;
    assert.equal(sheets, 0);
    assert.equal(finance.data.payment, null);
    assert.equal(finance.data.paymentMessage, '');
  } finally { api.prepay = previous; }
});

test('an outlet supplied by a request link remains locked during a new application', async t => {
  const { open } = await fixture(t);
  const requests = await open('requests', { outlet: 'cs', type: 'pauseFee' });
  assert.equal(requests.data.boundOutlet, 'cs');
  assert.equal(requests.data.outlets[requests.data.outletIndex].id, 'cs');
  await requests.chooseOutlet(picker(requests.data.outlets.findIndex(row => row.id === 'zz')));
  assert.equal(requests.data.outlets[requests.data.outletIndex].id, 'cs');
  await requests.backToRecords();
  assert.equal(requests.data.viewMode, 'list');
  assert.equal(requests.query.filterOutlet, 'cs');
});

test('dashboard defaults to the latest settled month and requests year-over-year data only when expanded', async t => {
  const { requests, open } = await fixture(t);
  const dashboard = await open('dashboard', { outlet: 'cs' });
  assert.equal(dashboard.data.period, '2026-09');
  assert.equal(dashboard.data.hasData, true);
  assert.equal(dashboard.data.showComparisons, false);
  const months = () => requests.filter(({ url }) => url.pathname === '/api/dashboard').map(({ url }) => url.searchParams.get('period'));
  assert.ok(!months().includes('2025-09'));
  await dashboard.toggleComparisons();
  assert.equal(dashboard.data.showComparisons, true);
  assert.ok(months().includes('2025-09'));
  assert.ok(requests.filter(({ url }) => url.pathname === '/api/dashboard').every(({ url }) => url.searchParams.get('outlet') === 'cs'));
  const selected = await open('dashboard', { outlet: 'cs', period: '2026-10' });
  assert.equal(selected.data.period, '2026-10');
});
