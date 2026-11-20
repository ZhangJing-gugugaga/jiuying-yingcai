'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index.cjs');
const api = require('../miniprogram/utils/api');
const fmt = require('../miniprogram/utils/format');

const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=', 'base64');

test('amount formatting is deterministic without the device locale', t => {
  t.mock.method(Number.prototype, 'toLocaleString', () => { throw new Error('Device locale unavailable'); });
  assert.equal(fmt.money(123456789.01), '123,456,789.01');
  assert.equal(fmt.money(-1256.2), '-1,256.20');
  assert.equal(fmt.money(0), '0.00');
  assert.equal(fmt.money(null), '—');
});

test('concurrent identical reads share a transport and cannot cross a changed session', async t => {
  let current = { token: 'account-one' };
  const calls = [];
  const original = global.wx;
  global.wx = { getStorageSync: () => current, request: options => calls.push(options) };
  t.after(() => { global.wx = original; });
  const first = api.request('/api/context');
  const parallel = api.request('/api/context');
  current = { token: 'account-two' };
  const second = api.request('/api/context');
  const sends = calls.length;
  for (const call of calls) {
    call.success({ statusCode: 200, data: { data: { subject: call.header.Authorization } } });
  }
  const values = await Promise.allSettled([first, parallel, second]);
  assert.equal(sends, 2);
  assert.deepEqual(calls.map(call => call.header.Authorization), ['Bearer account-one', 'Bearer account-two']);
  assert.equal(values[0].status, 'rejected');
  assert.equal(values[0].reason.code, 'SESSION_CHANGED');
  assert.equal(values[0].reason, values[1].reason);
  assert.deepEqual(values[2], { status: 'fulfilled', value: { subject: 'Bearer account-two' } });
});

test('native photo upload uses multipart, reports progress, and does not read a base64 copy', async t => {
  const original = global.wx;
  const progress = [];
  let transport, readBase64;
  global.wx = {
    getStorageSync: () => ({ token: 'isolation-only' }),
    chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: '/test.png', size: photo.length }] }); },
    getFileSystemManager() { readBase64 = true; throw new Error('Base64 path used'); },
    uploadFile(options) {
      transport = options;
      return { onProgressUpdate(listener) { listener({ progress: 57 }); } };
    },
  };
  t.after(() => { global.wx = original; });
  const upload = api.uploadPhoto({ onProgress: value => progress.push(value) }).catch(error => error);
  await Promise.resolve();
  if (transport) transport.success({ statusCode: 201, data: JSON.stringify({ data: { id: 'file-fixture' } }) });
  const result = await upload;
  assert.equal(readBase64, undefined);
  assert.deepEqual(progress, [57]);
  assert.equal(transport.name, 'file');
  assert.equal(transport.header.Authorization, 'Bearer isolation-only');
  assert.equal(result.file.id, 'file-fixture');
});

test('multipart files use the same image sanitation and owner isolation as old uploads', async t => {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function login(actor) {
    const response = await fetch(base + '/api/auth/dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor }),
    });
    return { Authorization: 'Bearer ' + (await response.json()).data.token };
  }
  function form(bytes, type = 'image/png') {
    const upload = new FormData();
    upload.append('file', new Blob([bytes], { type }), 'photo.png');
    upload.append('type', type);
    upload.append('name', '现场照片.png');
    return upload;
  }
  const owner = await login('partnerA');
  const other = await login('partnerB');
  const response = await fetch(base + '/api/files', { method: 'POST', headers: owner, body: form(photo) });
  const result = await response.json();
  assert.equal(response.status, 201, result.error?.message);
  assert.equal(result.data.sanitized, true);
  assert.ok(result.requestId);
  assert.equal((await fetch(base + result.data.url, { headers: owner })).status, 200);
  assert.equal((await fetch(base + result.data.url, { headers: other })).status, 403);
  const mismatch = await fetch(base + '/api/files', { method: 'POST', headers: owner, body: form(photo, 'image/jpeg') });
  assert.equal(mismatch.status, 400);
  assert.equal(app.store.db.prepare('SELECT count(*) n FROM files').get().n, 1);
});
test('C端仅展示经过审核的业务错误文案，并保留用户可执行的下一步', () => {
  const api = require('../miniprogram/utils/api');
  assert.equal(api.errorText({status: 400, code: 'INPUT', message: '内部调度失败，由数据组重跑全量数据'}), '操作未成功，请稍后重试；如问题持续，请联系总部客服。');
  assert.equal(api.errorText({status: 401, code: 'INVALID_CREDENTIALS', message: '当前密码不正确'}), '当前密码不正确');
  assert.equal(api.errorText({status: 409, code: 'CONFLICT', message: '线下实收正在核验，请先完成核验'}), '线下实收正在核验，请先完成核验');
});
