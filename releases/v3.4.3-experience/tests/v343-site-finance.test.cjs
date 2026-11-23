'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');

function mount(t, name, query = {}) {
  const globals = { Page:global.Page, wx:global.wx };
  t.after(() => {
    for (const [key, value] of Object.entries(globals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  global.wx = {};
  let definition;
  global.Page = page => { definition = page; };
  const path = require.resolve('../miniprogram/pages/' + name + '/index');
  delete require.cache[path];
  require(path);
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(values) { Object.assign(this.data, values); },
  };
  page.onLoad(query);
  return page;
}
const tap = dataset => ({currentTarget:{dataset}});

test('confirmed payment restores the paid bill and links the exact original bill', async t => {
  const page = mount(t, 'fees');
  const payment = {id:'payment-2',billId:'bill-2',outlet:'zz',status:'success'};
  global.wx.requestPayment = options => options.success();
  t.mock.method(api,'prepay',billId => {
    assert.equal(billId,'bill-2');
    return {paymentId:payment.id,requestPayment:{}};
  });
  t.mock.method(api,'queryPayment',id => {
    assert.equal(id,payment.id);
    return {payment};
  });
  t.mock.method(api,'session',() => ({token:'owner-session'}));
  page.setData({state:{adapterMode:'real'},paymentEnabled:true,selected:'zz',filterMonthValue:'2026-10',statusFilter:'unpaid'});
  page.refresh = async () => { assert.equal(page.data.statusFilter,'all'); };

  await page.pay(tap({id:'bill-2'}));
  assert.equal(page.data.paymentNotice,'支付成功');
  assert.equal(page.data.paymentBillQuery,'ledgerBillId=bill-2&outlet=zz&section=payments&ledgerRecordId=payment-2');
  assert.equal(page.data.selected,'zz');
  assert.equal(page.data.filterMonthValue,'2026-10');

  page.setData({statusFilter:'unpaid',paymentBillQuery:''});
  await page.resume(tap({id:payment.id}));
  assert.equal(page.data.statusFilter,'all');
  assert.match(page.data.paymentBillQuery,/^ledgerBillId=bill-2&/);
});

test('failed dashboard scope hides the old figures, prevents export and can recover', async t => {
  const page = mount(t,'dashboard',{period:'2026-10'});
  t.mock.method(api,'session',() => ({token:'owner-session'}));
  const dashboardData = period => ({
    period,
    totals:{revenue:30,orders:3,traffic:5,enroll:null},
    rows:[],
  });
  let fail = false;
  let rejectRequest;
  t.mock.method(api,'request',url => {
    const params = new URL(url,'http://127.0.0.1').searchParams;
    if (fail) return new Promise((resolve,reject) => { rejectRequest = reject; });
    return Promise.resolve(dashboardData(params.get('period')));
  });
  const exportFile = t.mock.method(api,'openDocument',async () => {});

  await page.loadDashboard();
  assert.equal(page.data.dashboardReady,true);
  await page.export(tap({format:'pdf'}));
  assert.equal(exportFile.mock.callCount(),1);

  fail = true;
  const change = page.period({detail:{value:'2026-09'}});
  assert.equal(page.data.dashboardReady,false);
  assert.equal(page.data.dashboardLoading,true);
  await page.export(tap({format:'xlsx'}));
  rejectRequest(Error('新账期暂时无法加载'));
  await change;
  assert.equal(page.data.dashboardReady,false);
  assert.equal(page.data.dashboardLoading,false);
  assert.equal(page.data.error,'新账期暂时无法加载');
  await page.export(tap({format:'xlsx'}));
  assert.equal(exportFile.mock.callCount(),1);

  fail = false;
  await page.loadDashboard();
  assert.equal(page.data.dashboardReady,true);
  assert.equal(page.data.periodDisplay,'2026年09月');
});
