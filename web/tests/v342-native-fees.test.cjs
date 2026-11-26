const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const config = require('../../miniprogram/config');
const api = require('../../miniprogram/utils/api');

const tap = dataset => ({ currentTarget: { dataset } });

test('the bill scope and amount lead the page and filters and history open one at a time', () => runTest(async ({app, fees, bill}) => {
  const template = require('node:fs').readFileSync(require.resolve('../../miniprogram/pages/fees/index.wxml'), 'utf8');
  assert.ok(template.indexOf('fees-overview') >= 0);
  assert.ok(template.indexOf('待付合计') < template.indexOf('筛选账单'));
  assert.match(template, /class="fees-scope"/);
  const set = { selected: fees.data.selected, month: fees.data.filterMonthValue, status: fees.data.statusFilter };
  fees.toggleFilters();
  assert.equal(fees.data.filtersOpen, true);
  assert.equal(fees.data.historyOpen, false);
  fees.toggleHistory();
  assert.equal(fees.data.filtersOpen, false);
  assert.equal(fees.data.historyOpen, true);
  fees.toggleFilters();
  assert.equal(fees.data.filtersOpen, true);
  assert.equal(fees.data.historyOpen, false);
  assert.deepEqual({ selected: fees.data.selected, month: fees.data.filterMonthValue, status: fees.data.statusFilter }, set);
  assert.equal(fees.data.bills.find(row => row.id === bill.id).unpaidText,'120.00');
  assert.deepEqual(fees.data.bills.find(row => row.id === bill.id).displayAmount, { label: '待支付金额', value: '120.00' });
  const sourceBill = await api.detail('bills', bill.id);
  assert.equal(sourceBill.ledger.unpaidCents, 12000);
  await fees.chooseSection(tap({ section: 'records' }));
  assert.equal(fees.data.filtersOpen, false);
  assert.equal(fees.data.historyOpen, false);
  let opened;
  wx.navigateTo = ({ url, success }) => { opened = url; success(); };
  fees.openFinance();
  assert.equal(opened, '/pages/finance/index?outlet=cs');
  await fees.chooseSection(tap({ section: 'bills' }));
  assert.deepEqual({ selected: fees.data.selected, month: fees.data.filterMonthValue, status: fees.data.statusFilter }, set);

  const state = app.store.load();
  state.adjustments.push({id:'adj-isolated-unknown',outlet:'cs',owner:'p1',status:'待财务核算调整',
    from:'2026-09-01',to:'2026-09-02',amount:null,offsetMonth:null});
  app.store.transaction(()=>app.store.save(state));
  await fees.chooseSection(tap({ section: 'adjustments' }));
  const unknown = fees.data.adjustments.find(row => row.id === 'adj-isolated-unknown');
  assert.equal(unknown.amount, null);
  assert.equal(unknown.amountText, '—');
  assert.equal(app.store.db.prepare('SELECT amount_cents FROM adjustments WHERE id=?').get(unknown.id).amount_cents,null);
  await fees.chooseSection(tap({ section: 'bills' }));
  assert.deepEqual({ selected: fees.data.selected, month: fees.data.filterMonthValue, status: fees.data.statusFilter }, set);
}));

function openFeePage(query = {}) {
  const entry = require.resolve('../../miniprogram/pages/fees/index.js');
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[entry];
  require(entry);
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    route: 'pages/fees/index',
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
  page.onLoad(query);
  return page;
}

test('a failed outlet switch clears the previous bill and amount until the new scope is verified', () => runTest(async ({ fees, bill }) => {
  const outletIndex = fees.data.outlets.findIndex(outlet => outlet.id === 'zz');
  assert.ok(outletIndex >= 0);
  assert.equal(fees.data.ledgerTotals.unpaid, '120.00');
  const request = wx.request;
  wx.request = options => {
    const url = new URL(options.url);
    if (url.pathname === '/api/context') {
      options.fail({ errMsg: 'request:fail network unavailable' });
      return;
    }
    return request(options);
  };
  try {
    await fees.filterOutlet({ detail: { value: outletIndex } });
    assert.equal(fees.data.selected, 'zz');
    assert.equal(fees.data.outlets[fees.data.outletIndex].id, 'zz');
    assert.ok(fees.data.error);
    assert.equal(fees.data.scopeReady, false);
    assert.deepEqual(fees.data.bills, []);
    assert.equal(fees.data.ledgerTotals, null);
  } finally {
    wx.request = request;
  }
  await fees.refresh();
  assert.equal(fees.data.scopeReady, true);
  assert.equal(fees.data.selected, 'zz');
  assert.ok(fees.data.bills.every(row => row.id !== bill.id));
}));

test('viewing a paid bill returns to the matching ledger page without stacking another copy', () => runTest(async ({ fees, bill }) => {
  const original = { route: 'pages/finance/index', data: { financeView: 'bill', ledgerBill: bill } };
  const routes = [];
  let backs = 0;
  wx.navigateBack = ({ delta }) => { backs += delta; };
  wx.navigateTo = ({ url, success }) => { routes.push(url); success(); };
  global.getCurrentPages = () => [original, fees];
  fees.setData({ payment: { status: 'success', billId: bill.id, outlet: bill.outlet, month: bill.month } });

  fees.openConfirmedBill();
  assert.equal(backs, 1);
  assert.deepEqual(routes, []);

  fees.openBill(tap({ id: bill.id }));
  assert.equal(backs, 2);
  assert.deepEqual(routes, []);

  original.data.ledgerBill = { ...bill, id: 'different-bill' };
  fees.openConfirmedBill();
  assert.equal(backs, 2);
  assert.equal(routes[0], '/pages/finance/index?ledgerBillId=' + bill.id + '&outlet=cs&month=2026-09');
}));

test('returning from a later bill or from history restores the visible pages only for the same scope', () => runTest(async ({ app, fees, bill }) => {
  const state = app.store.load();
  const original = state.bills.find(row => row.id === bill.id);
  for (let index = 0; index < 54; index++) {
    const month = new Date(Date.UTC(2026, 7 - index, 1)).toISOString().slice(0, 7);
    state.bills.push({ ...original, id: 'return-scope-bill-' + index, month });
  }
  app.store.transaction(() => app.store.save(state));

  await fees.clearFilters();
  await fees.filterStatus(tap({ status: 'unpaid' }));
  assert.equal(fees.data.bills.length, 50);
  const total = fees.data.pagers.bills.total;
  assert.ok(total > 50);
  await fees.more(tap({ collection: 'bills' }));
  assert.equal(fees.data.bills.length, total);
  const target = fees.data.bills.at(-1);
  let destination;
  const scrolls = [];
  wx.pageScrollTo = options => scrolls.push(options.selector);
  wx.navigateTo = ({ url, success }) => { destination = new URL(url, 'https://native.invalid'); success(); };
  fees.openBill(tap({ id: target.id }));
  assert.equal(destination.searchParams.get('ledgerBillId'), target.id);

  fees.onHide();
  await fees.onShow();
  assert.equal(fees.data.bills.length, total);
  assert.equal(fees.data.bills.at(-1).id, target.id);
  assert.deepEqual(scrolls, ['#fee-bills-' + target.id]);
  assert.equal(fees.data.statusFilter, 'unpaid');
  await fees.chooseSection(tap({ section: 'records' }));
  await fees.chooseSection(tap({ section: 'bills' }));
  assert.equal(fees.data.bills.length, total);
  assert.equal(fees.data.selected, 'cs');

  fees.onHide();
  await api.login('partnerB');
  await fees.onShow();
  assert.deepEqual(fees.data.bills, []);
  assert.equal(fees.data.scopeReady, false);
  assert.equal(scrolls.length, 1);
}));

async function runTest(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV:'test', ADAPTER_MODE:'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const before = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map(), actions = [], notices = [], modals = [];
  let loseNextPrepay = false;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast(options) { notices.push(options.title); },
    showModal(options) { modals.push(options); },
    async request(options) {
      const path = new URL(options.url).pathname;
      if (loseNextPrepay && path === '/api/payments/prepay') {
        loseNextPrepay = false;
        options.fail({ errMsg: 'request:fail network unavailable' });
        return;
      }
      let response, body;
      try {
        response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        body = await response.json();
      } catch (error) {
        options.fail(error);
        return;
      }
      actions.push({ method: options.method, path, requestId: body.requestId, status: response.status });
      options.success({ statusCode: response.status, data: body });
    },
  };
  try {
    await api.login('manager');
    const { result: plan } = await api.command('plan.publish', {
      name:'隔离验证月度服务', amount:120,
      serviceEntity:'隔离服务主体',collectionEntity:'隔离收款主体',invoiceEntity:'隔离开票主体',
      terms:'仅用于本地隔离测试',reason:'隔离验收',
    });
    const { result: agreement } = await api.command('agreement.create', {
      outlet:'cs',planId:plan.id,startMonth:'2026-09',endMonth:'2026-09',billDay:1,dueDay:5,reference:'V342-PAYMENT-TEST',reason:'隔离验收',
    });
    const { result: bill } = await api.command('billing.generate', { agreementId:agreement.id,month:'2026-09' });
    await api.login('partnerA');
    const fees = openFeePage({ outlet:'cs',month:'2026-09' });
    await fees.onShow();
    assert.equal(fees.data.state.adapterMode, 'mock');
    assert.equal(fees.data.bills.find(row => row.id===bill.id).payableText, '120.00');
    return await run({ app, fees, bill, actions, modals, notices, dropNextPrepay() { loseNextPrepay = true; } });
  } finally {
    config.apiBase = before;
    delete global.Page;
    delete global.getCurrentPages;
    delete global.wx;
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('native Mock confirmation keeps the selected bill and channel without retaining the original tap event', () => runTest(async ({fees,bill,modals,actions}) => {
  const react = fees.pay;
  let deferred;
  fees.pay = event => { deferred = react.call(fees, event); return deferred; };
  const event = tap({ id:bill.id, channel:'alipay' });
  await fees.confirmSimulation(event);
  delete event.currentTarget;
  if (modals.length) {
    modals[0].success({ confirm:true });
    await deferred;
  }
  assert.equal(fees.data.simulationPrompt.id, bill.id);
  assert.equal(fees.data.simulationPrompt.channel, 'alipay');
  assert.equal(fees.data.simulationPrompt.payableText, '120.00');
  assert.equal(actions.filter(a => a.path==='/api/payments/prepay').length, 0);
  fees.cancelSimulationPrompt();
  assert.equal(fees.data.simulationPrompt, null);
  assert.equal(actions.filter(a => a.path==='/api/payments/prepay').length, 0);
}));

test('native Mock checkout distinguishes outcomes, permits retry and posts exactly one receipt', t => runTest(async ({app,fees,bill,actions,notices}) => {
  const executions = [];
  for (const [channel,outcome,message] of [
    ['alipay','cancelled','已取消支付'],
    ['wechat','failed','支付未完成，请重试'],
    ['wechat','success','支付成功'],
  ]) {
    await fees.confirmSimulation(tap({ id:bill.id, channel }));
    await fees.startSimulation();
    const id = fees.data.payment.id;
    assert.equal(fees.data.payment.channel, channel);
    await Promise.all([fees.resolve(tap({ outcome })),fees.resolve(tap({ outcome }))]);
    const state = app.store.load();
    assert.equal(state.payments.find(row => row.id===id).status, outcome);
    assert.equal(fees.data.paymentNotice, message);
    assert.equal(notices.at(-1), message);
    assert.equal(state.bills.find(row => row.id===bill.id).status, outcome==='success'?'paid':'unpaid');
    assert.equal(state.receipts.filter(row => row.billId===bill.id).length, outcome==='success'?1:0);
    executions.push({ channel,outcome,id });
  }
  const { id } = executions.at(-1);
  await api.simulatePayment(id, 'success');
  assert.equal(app.store.load().receipts.filter(row => row.billId===bill.id).length, 1);
  await api.login('finance');
  const [ledger, receipts] = await Promise.all([
    api.detail('bills', bill.id),
    api.collection('receipts',{ outlet:'cs',limit:20 }),
  ]);
  assert.equal(ledger.status, 'paid');
  assert.equal(ledger.ledger.grossReceivedCents, 12000);
  assert.deepEqual(receipts.items.filter(row => row.billId===bill.id).map(row => row.paymentId), [id]);
  await api.login('partnerA');
  const reopened = openFeePage({ outlet:'cs',month:'2026-09' });
  await reopened.onShow();
  assert.equal(reopened.data.bills.find(row => row.id===bill.id).status, 'paid');
  assert.equal(reopened.data.bills.find(row => row.id===bill.id).paidText, '120.00');
  const trace = actions.filter(a => a.method==='POST' && a.path.startsWith('/api/payments/'));
  assert.equal(trace.filter(a => a.path==='/api/payments/prepay' && a.status===200).length, 3);
  assert.equal(trace.filter(a => a.path.endsWith('/simulate') && a.status===200).length, 4);
  assert.ok(trace.every(a => a.requestId));
  t.diagnostic(JSON.stringify({ bill:bill.id, cents:12000, executions, trace }));
}));

test('Mock confirmation shows failure without clearing the bill, then starts one order after retry', () => runTest(async ({fees,bill,app,actions,dropNextPrepay}) => {
  await fees.confirmSimulation(tap({ id:bill.id,channel:'wechat' }));
  dropNextPrepay();
  await fees.startSimulation();
  assert.match(fees.data.error, /网络连接失败/);
  assert.equal(fees.data.simulationPrompt.id, bill.id);
  assert.equal(fees.data.payment, null);
  assert.equal(app.store.load().payments.filter(row => row.billId===bill.id).length, 0);
  await Promise.all([fees.startSimulation(),fees.startSimulation()]);
  assert.equal(fees.data.error, '');
  assert.equal(fees.data.simulationPrompt, null);
  assert.equal(fees.data.payment.billId, bill.id);
  assert.equal(actions.filter(a => a.path==='/api/payments/prepay' && a.status===200).length, 1);
  assert.equal(app.store.load().payments.filter(row => row.billId===bill.id).length, 1);
}));

test('when a line-item receipt is being reviewed the native Mock prompt preserves the backend refusal', () => runTest(async ({fees,bill,app,actions}) => {
  await api.command('offline.submit',{
    billId:bill.id,amount:120,reference:'V342-ISOLATED-OFFLINE',paidOn:'2026-09-06',reason:'隔离验收凭证未实际付款',
  });
  await fees.confirmSimulation(tap({ id:bill.id,channel:'wechat' }));
  await fees.startSimulation();
  assert.match(fees.data.error,/线下实收正在核验，请先完成核验/);
  assert.equal(fees.data.simulationPrompt.id,bill.id);
  assert.equal(fees.data.payment,null);
  assert.equal(actions.filter(a => a.path==='/api/payments/prepay' && a.status===409).length,1);
  assert.equal(app.store.load().payments.filter(row => row.billId===bill.id).length,0);
  assert.equal(app.store.load().receipts.filter(row => row.billId===bill.id).length,0);
}));
