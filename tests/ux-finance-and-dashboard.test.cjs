const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');

const tap = dataset => ({ currentTarget: { dataset } });

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
  const instance = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  instance.onLoad(query);
  return instance;
}

test('service-fee entry points preserve both the current scope and the original bill scope', () => {
  const previousWx = global.wx;
  const destinations = [];
  global.wx = {
    navigateTo({ url, success }) {
      destinations.push(new URL(url, 'http://local'));
      success();
    },
  };
  try {
    const fees = page('fees', { outlet: 'branch-b', month: '2026-10' });
    fees.data.bills = [{ id: 'bill-original', outlet: 'branch-b', month: '2026-09', status: 'unpaid' }];
    fees.openFinance(tap({}));
    fees.openBill(tap({ id: 'bill-original', section: 'payments' }));
    fees.openAgreements();
    assert.deepEqual(destinations.map(url => [url.pathname, Object.fromEntries(url.searchParams)]), [
      ['/pages/finance/index', { outlet: 'branch-b', month: '2026-10' }],
      ['/pages/finance/index', { outlet: 'branch-b', month: '2026-09', ledgerBillId: 'bill-original', section: 'payments' }],
      ['/pages/agreements/index', { outlet: 'branch-b' }],
    ]);
  } finally {
    global.wx = previousWx;
  }
});

test('the original bill cannot be cleared by a scope change during a refund application', async () => {
  const finance = page('finance', { outlet: 'branch-b', month: '2026-10', type: 'refund',
    receiptId: 'receipt-b', ledgerBillId: 'bill-b' });
  let refreshed = false;
  finance.refresh = async () => { refreshed = true; };
  await finance.chooseLedgerOutlet(tap({ outlet: 'branch-a' }));
  assert.deepEqual([finance.data.ledgerOutlet, finance.data.ledgerMonth, finance.data.ledgerBillId, refreshed],
    ['branch-b', '2026-10', 'bill-b', false]);
});

test('the agreement list requests the selected outlet and groups the currently effective agreements first', async () => {
  const agreements = page('agreements', { outlet: 'branch-b' });
  assert.equal(agreements.data.selectedOutlet, 'branch-b');
  assert.equal(agreements.agreementScope().outlet, 'branch-b');
  const previousWx = global.wx;
  const previousRequest = api.request;
  const previousCollection = api.collection;
  const lookups = [];
  global.wx = { getStorageSync: () => ({ role: 'partner' }) };
  api.request = async () => ({ today: '2026-11-19', actor: 'partner:b' });
  api.collection = async (name, filters) => {
    lookups.push([name, filters.outlet]);
    const items = {
      outlets: [{ id: 'branch-b', name: '乙网点' }],
      pricePlans: [],
      agreements: [
        { id: 'prior', outlet: 'branch-b', status: 'active', startMonth: '2025-11', endMonth: '2026-10' },
        { id: 'current', outlet: 'branch-b', status: 'active', startMonth: '2026-11', endMonth: '2027-10' },
      ],
    }[name];
    return { items, total: items.length, offset: 0, limit: 50, hasMore: false };
  };
  try {
    await agreements.onShow();
    assert.ok(lookups.some(([name, outlet]) => name === 'agreements' && outlet === 'branch-b'));
    assert.deepEqual(agreements.data.agreementGroups.map(group => group.rows.map(row => row.id)), [['current'], ['prior']]);
  } finally {
    global.wx = previousWx;
    api.request = previousRequest;
    api.collection = previousCollection;
  }
});

test('statistics export is blocked until the displayed filter request succeeds', async () => {
  const previousRequest = api.request;
  const previousOpenDocument = api.openDocument;
  const exported = [];
  let completeRequest;
  api.request = async url => {
    const month = new URL(url, 'http://local').searchParams.get('period');
    if (month === '2026-11' && !completeRequest) {
      await new Promise((_, reject) => { completeRequest = reject; });
    }
    return { period: month, totals: { revenue: 20, orders: 2 }, rows: [] };
  };
  api.openDocument = async url => { exported.push(new URL(url, 'http://local').searchParams.get('period')); };
  try {
    const dashboard = page('dashboard', { period: '2026-10' });
    dashboard.data.state = { outlets: [] };
    await dashboard.loadDashboard();
    await dashboard.export(tap({ format: 'xlsx' }));
    const next = dashboard.period({ detail: { value: '2026-11' } });
    await dashboard.export(tap({ format: 'xlsx' }));
    completeRequest(new Error('网络连接失败'));
    await next;
    await dashboard.export(tap({ format: 'xlsx' }));
    assert.deepEqual(exported, ['2026-10']);
    await dashboard.loadDashboard();
    await dashboard.export(tap({ format: 'xlsx' }));
    assert.deepEqual(exported, ['2026-10', '2026-11']);
  } finally {
    api.request = previousRequest;
    api.openDocument = previousOpenDocument;
  }
});
