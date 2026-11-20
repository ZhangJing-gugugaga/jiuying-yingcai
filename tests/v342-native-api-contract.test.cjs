'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { api, define } = require('../miniprogram/utils/page.js');

test('an unexpected HTTP 200 body must not display business success', async t => {
  const success = t.mock.fn();
  const refresh = t.mock.fn();
  global.wx = {
    getStorageSync: () => ({ token: 'isolated-api-contract' }),
    request: options => options.success({ statusCode: 200, data: '<html>暂时无法连接</html>' }),
    showToast: success,
  };
  t.after(() => { delete global.wx; });
  const page = { ...define({}), setData(values) { Object.assign(this.data, values); }, refresh };

  const result = await page.mutate('support.chat', { text: '隔离样例' }, '已发送');

  assert.equal(result, null);
  assert.match(page.data.error, /操作未成功/);
  assert.equal(page.data.busy, false);
  assert.equal(success.mock.callCount(), 0);
  assert.equal(refresh.mock.callCount(), 0);
});

test('a synchronous native request exception yields a safe retryable error', async t => {
  const headers = [];
  let fail = true;
  global.wx = {
    getStorageSync: () => ({ token: 'isolated-api-network' }),
    request(options) {
      headers.push(options.header['Idempotency-Key']);
      if (fail) throw new Error('raw bridge error: internal debug object');
      options.success({ statusCode: 200, data: { data: { result: { id: 'draft-isolated' } } } });
    },
  };
  t.after(() => { delete global.wx; });
  const payload = { outlet: 'cs', month: '2026-10', note: '隔离样例' };

  await assert.rejects(api.command('report.draft', payload), {
    code: 'NETWORK',
    message: '网络连接失败，请检查网络后重试。',
  });
  fail = false;
  assert.deepEqual(await api.command('report.draft', payload), { result: { id: 'draft-isolated' } });
  assert.equal(headers.length, 2);
  assert.ok(headers[0]);
  assert.equal(headers[0], headers[1]);
});
