'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const fmt = require('../miniprogram/utils/format.js');

test('failed private map keeps the authorized rows and offers a return to the same list', () => {
  let page;
  const originalPage = globalThis.Page;
  globalThis.Page = definition => { page = definition; };
  try {
    require('../miniprogram/pages/outlets/index.js');
  } finally {
    if (originalPage === undefined) delete globalThis.Page;
    else globalThis.Page = originalPage;
  }
  const rows = [{id:'cs', name:'隔离网点'}];
  page.data = {...page.data, mode:'map', directory:false, search:'长沙', rows};
  page.setData = values => Object.assign(page.data, values);

  page.mapFailed();
  assert.match(page.data.mapError, /网点列表/);
  const markup = readFileSync(require.resolve('../miniprogram/pages/outlets/index.wxml'), 'utf8');
  assert.match(markup, /wx:if="{{mapError}}"[\s\S]*?bindtap="modeUnavailable">返回网点列表/);
  page.modeUnavailable();
  assert.equal(page.data.mode, 'list');
  assert.equal(page.data.mapError, '');
  assert.equal(page.data.search, '长沙');
  assert.equal(page.data.rows, rows);
});

test('status tones convey waiting, failure, completion, and inactive status without changing labels', () => {
  assert.equal(fmt.statusTone('open', 'outlet'), 'success');
  assert.equal(fmt.statusTone('open', 'task'), 'wait');
  assert.equal(fmt.statusTone('closed', 'outlet'), 'gray');
  assert.equal(fmt.statusTone('closed', 'support'), 'success');
  assert.equal(fmt.statusTone('approved', 'refund'), 'wait');
  assert.equal(fmt.statusTone('unknown'), 'gray');
  const p = fmt.decorate({
    bills:[{status:'unpaid'}, {status:'paid'}, {status:'reversed'}],
    reports:[{status:'pending'}, {status:'returned'}, {status:'approved', revoked:true}],
  });
  assert.deepEqual(p.bills.map(row => [row.statusText,row.statusTone]), [
    ['待支付','wait'], ['已支付','success'], ['已冲正','gray'],
  ]);
  assert.deepEqual(p.reports.map(row => [row.statusText,row.statusTone]), [
    ['总部审核中','wait'], ['待我修改','red'], ['已撤销','gray'],
  ]);
});
