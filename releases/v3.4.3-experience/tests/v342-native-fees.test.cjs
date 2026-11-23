const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');

const tap = dataset => ({ currentTarget: { dataset } });

function openFeePage(query = {}) {
  const entry = require.resolve('../miniprogram/pages/fees/index.js');
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
