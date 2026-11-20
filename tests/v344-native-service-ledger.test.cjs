'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const api = require('../miniprogram/utils/api');
const config = require('../miniprogram/config');

const tap = dataset => ({ currentTarget: { dataset } });
const change = value => ({ detail: { value: String(value) } });

function page(name, query = {}) {
  let definition;
  global.Page = options => { definition = options; };
  const modulePath = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[modulePath];
  require(modulePath);
  const native = {
    ...definition,
    route: 'pages/' + name + '/index',
    data: structuredClone(definition.data),
    setData(values, callback) {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.');
        let parent = this.data;
        for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
        parent[parts.at(-1)] = value;
      }
      callback?.();
    },
  };
  global.getCurrentPages = () => [native];
  native.onLoad(query);
  return native;
}

async function fixture(t, scenario) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = { apiBase: config.apiBase, wx: global.wx, Page: global.Page, getCurrentPages: global.getCurrentPages };
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map(), navigation = [], scrolls = [], writes = [];
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    navigateTo({ url, success }) { navigation.push(new URL(url, 'https://isolated.invalid')); success?.(); },
    showToast() {},
    pageScrollTo({ selector }) { if (selector) scrolls.push(selector); },
    async request(options) {
      let response;
      try {
        const fetched = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        const body = await fetched.json();
        if (options.data?.command) writes.push({ command: options.data.command, requestId: body.requestId, status: fetched.status, id: body.data?.result?.id });
        response = { statusCode: fetched.status, data: body };
      } catch (error) {
        return options.fail(error);
      }
      options.success(response);
    },
  };
  t.after(async () => {
    config.apiBase = previous.apiBase;
    global.wx = previous.wx;
    global.Page = previous.Page;
    global.getCurrentPages = previous.getCurrentPages;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  await api.login('partnerA');
  async function staff(actor, command, payload) {
    const prior = api.session();
    await api.login(actor);
    try { return (await api.command(command, payload)).result; }
    finally { storage.set('jyyc.session', prior); }
  }
  function openLast() {
    const route = navigation.at(-1);
    return page(route.pathname.split('/')[2], Object.fromEntries(route.searchParams));
  }
  await scenario({ app, staff, navigation, scrolls, writes, openLast });
}

test('a submitted pause-business request opens its own progress and links to a separate fee request for the same outlet', async t => fixture(t, async ({ app, staff, navigation, scrolls, writes, openLast }) => {
  const requests = page('requests', { type: 'statusChange' });
  await requests.onShow();
  requests.setData({ 'form.reason': '门店施工停业', 'form.effectiveDate': app.store.load().today });
  await requests.submit();
  assert.equal(app.store.load().requests.length, 0, 'multiple outlets require a selection');
  assert.match(requests.data.error, /选择申请网点/);
  await requests.chooseOutlet(change(requests.data.outlets.findIndex(outlet => outlet.id === 'zz')));
  requests.setData({ 'form.reason': '门店施工停业', 'form.effectiveDate': app.store.load().today });
  await requests.submit();
  const [business] = app.store.load().requests;
  assert.deepEqual([business.outlet, business.type, business.status], ['zz', 'statusChange', 'pending']);
  assert.equal(scrolls.at(-1), '#request-' + business.id);
  assert.equal(requests.data.requestRows.find(row => row.id === business.id).canApplyPauseFee, true);
  requests.applyPauseFee(tap({ id: business.id }));
  assert.equal(navigation.at(-1).searchParams.get('outlet'), 'zz');
  assert.equal(navigation.at(-1).searchParams.get('type'), 'pauseFee');
  assert.equal(app.store.load().requests.length, 1);

  const fees = openLast();
  await fees.onShow();
  assert.equal(fees.data.outlets[fees.data.outletIndex].id, 'zz');
  assert.equal(fees.data.type, 'pauseFee');
  fees.setData({ 'form.from': '2026-11-18', 'form.to': '2026-11-20', 'form.reason': '施工期间暂停咨询服务' });
  await fees.submit();
  const feeRequest = app.store.load().requests.find(row => row.type === 'pauseFee');
  assert.equal(feeRequest.outlet, business.outlet);
  assert.notEqual(feeRequest.id, business.id);
  await staff('ops', 'review.request', { id: business.id, decision: 'approve', note: '确认停业日期' });
  assert.equal(app.store.load().requests.find(row => row.id === feeRequest.id).status, 'pending');
  assert.equal(app.store.load().adjustments.length, 0);
  t.diagnostic(JSON.stringify({ outlet: 'zz', business: business.id, feeRequest: feeRequest.id, writes }));
}));

test('bill actions preserve original bill or receipt and expose the exact submitted application', async t => fixture(t, async ({ app, staff, navigation, scrolls, writes, openLast }) => {
  const plan = await staff('manager', 'plan.publish', { name: '隔离测试方案', amount: 1200, serviceEntity: '隔离服务主体',
    collectionEntity: '隔离收款主体', invoiceEntity: '隔离开票主体', terms: '用于测试的协议条款', reason: '财务链路验收' });
  const agreement = await staff('manager', 'agreement.create', { outlet: 'cs', planId: plan.id, startMonth: '2026-10', endMonth: '2027-10',
    billDay: 1, dueDay: 5, reference: 'ISOLATED-V344-AGREEMENT', reason: '财务链路验收' });
  const bill = await staff('finance', 'billing.generate', { agreementId: agreement.id, month: '2026-10' });
  const ledger = page('finance', { outlet: bill.outlet, ledgerBillId: bill.id });
  await ledger.onShow();
  assert.equal(ledger.data.ledgerBill.id, bill.id);
  await ledger.openBillAction(tap({ type: 'offline' }));
  const offline = openLast();
  await offline.onShow();
  assert.equal(offline.data.formBill.id, bill.id);
  assert.equal(scrolls.at(-1), '#finance-application-form');
  offline.setData({ 'form.amount': String(bill.amount), 'form.reference': 'ISOLATED-V344-LEDGER', 'form.paidOn': '2026-11-15', 'form.reason': '核对线下记录' });
  await offline.submit();
  const [offlineRequest] = app.store.load().offlinePayments;
  assert.equal(offline.data.selectedApplication.id, offlineRequest.id);
  assert.equal(scrolls.at(-1), '#finance-application-result');
  offline.openApplicationBill();
  assert.equal(navigation.at(-1).searchParams.get('ledgerBillId'), bill.id);
  await staff('finance', 'offline.review', { id: offlineRequest.id, decision: 'approve', note: '隔离实收登记核验' });
  const state = app.store.load();
  const receipt = state.receipts.find(row => row.billId === bill.id);
  const paidBill = state.bills.find(row => row.id === bill.id);
  for (let index = 0; index <= 50; index++) {
    const month = new Date(Date.UTC(2020, index, 1)).toISOString().slice(0, 7);
    state.bills.push({ ...paidBill, id: 'bill-isolated-page-' + index, month, status: 'unpaid' });
  }
  app.store.transaction(() => app.store.save(state));
  const firstPage = await api.collection('bills', { outlet: bill.outlet, limit: 50 });
  assert.equal(firstPage.hasMore, true);
  assert.ok(!firstPage.items.some(row => row.id === bill.id));
  await ledger.ledgerSection(tap({ section: 'receipts' }));
  assert.equal(ledger.data.ledgerBill.records.find(row => row.id === receipt.id).canRequest, true);

  for (const type of ['invoice', 'refund']) {
    await ledger.openBillAction(tap({ type, id: receipt.id }));
    const form = openLast();
    await form.onShow();
    assert.equal(form.data.formBill.id, bill.id);
    assert.equal(form.data.receipts[form.data.receiptIndex].id, receipt.id);
    const currentPages = global.getCurrentPages;
    const stackLength = navigation.length;
    const backSteps = [];
    global.getCurrentPages = () => [ledger, form];
    global.wx.navigateBack = options => backSteps.push(options.delta);
    try {
      form.openApplicationBill();
      assert.deepEqual(backSteps, [1]);
      assert.equal(navigation.length, stackLength);
    } finally {
      global.getCurrentPages = currentPages;
      delete global.wx.navigateBack;
    }
    form.openApplicationBill();
    assert.equal(navigation.at(-1).searchParams.get('ledgerBillId'), bill.id);
    form.setData({ 'form.amount': '10.00', 'form.title': '隔离抬头', 'form.taxId': 'ISOLATED-TAX', 'form.reason': '账单归属链路验收' });
    await form.submit();
    assert.equal(form.data.error, '', type);
    const [record] = app.store.load()[type + 'Requests'];
    assert.deepEqual([record.billId, record.receiptId, form.data.selectedApplication.id], [bill.id, receipt.id, record.id]);
    form.openApplicationBill();
    assert.equal(navigation.at(-1).searchParams.get('ledgerBillId'), bill.id);
    if (type === 'invoice') await staff('finance', 'invoice.update', { id: record.id, status: 'cancelled', note: '结束隔离发票申请' });
  }
  const mismatch = page('finance', { outlet: bill.outlet, ledgerBillId: firstPage.items[0].id, type: 'refund', receiptId: receipt.id });
  await mismatch.onShow();
  assert.equal(mismatch.data.formBill, null);
  mismatch.setData({ 'form.amount': '5.00', 'form.reason': '错配不得提交' });
  await mismatch.submit();
  assert.match(mismatch.data.error, /返回原账单/);
  assert.equal(app.store.load().refundRequests.length, 1);
  t.diagnostic(JSON.stringify({ bill: bill.id, receipt: receipt.id, writes }));
}));

test('the only payable bill can be identified for a generic offline application', async t => fixture(t, async () => {
  const outlet = 'cs';
  const { items } = await api.collection('bills', { outlet, status: 'unpaid' });
  assert.equal(items.length, 1);
  const finance = page('finance', { outlet });
  await finance.onShow();
  assert.equal(finance.data.billIndex, 0);
  assert.equal(finance.data.formBill?.id, items[0].id);
}));
