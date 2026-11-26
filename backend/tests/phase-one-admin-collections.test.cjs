'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');

async function fixture(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function get(route, token) {
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer ' + token } });
    const body = await response.json();
    assert.ok(body.requestId);
    return { status: response.status, ...body };
  }
  async function login(actor) {
    const response = await fetch(base + '/auth/dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data.token;
  }
  return { get, login, app };
}

test('direct collection requests distinguish invalid states from legal empty queries', async t => {
  const { get, login } = await fixture(t);
  const [manager, visitor, partner] = await Promise.all(['manager', 'public', 'partnerA'].map(login));
  for (const [name, status] of [['outlets', 'paid'], ['verifications', 'closed'], ['requests', 'finance'],
    ['support.tickets', 'bot'], ['support.chats', 'paid'], ['bills', 'queued']]) {
    const result = await get(`/collections/${name}?status=${status}`, manager);
    assert.equal(result.status, 400, name);
    assert.equal(result.error.code, 'INPUT');
  }
  assert.equal((await get('/collections/outlets?scope=public&status=paid', visitor)).status, 400);
  const empty = await get('/collections/outlets?status=preparing', manager);
  assert.deepEqual(empty.data, { items: [], total: 0, offset: 0, limit: 50, hasMore: false });
  const owned = await get('/collections/outlets?status=open&includeStatusOptions=true', partner);
  assert.equal(owned.data.total, 2);
  assert.deepEqual(owned.data.items.map(row => row.owner), ['p1', 'p1']);
  assert.deepEqual(owned.data.statusOptions, ['open', 'paused', 'preparing', 'closed']);
  assert.equal((await get('/collections/bills?status=queued&includeStatusOptions=true', visitor)).status, 403);
  assert.equal((await get('/collections/audit?includeStatusOptions=true', manager)).data.statusOptions, undefined);
  assert.equal((await get('/collections/outlets?status=all', manager)).data.total, 4);
  assert.equal((await get('/collections/outlets?status=', manager)).data.total, 4);
  const snapshot = await get('/state?status=paid', manager);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.pagination.outlets.total, 0);
  assert.equal(snapshot.data.pagination.outlets.statusOptions, undefined);
});

test('location request scope filters by business type before counting and paging', async t => {
  const { get, login, app } = await fixture(t);
  const manager = await login('manager');
  const state = app.store.load();
  for (const [id, type, owner, outlet] of [['location-a', 'locationChange', 'p1', 'cs'],
    ['location-b', 'newOutlet', 'p2', null], ['fee-pause', 'pauseFee', 'p1', 'cs']]) {
    state.requests.push({ id, owner, outlet, type, status: 'pending', data: { address: '验收地址' }, trail: [] });
  }
  app.store.transaction(() => app.store.save(state));
  const scoped = await get('/collections/requests?scope=location&limit=1&status=pending', manager);
  assert.equal(scoped.data.total, 2);
  assert.deepEqual(scoped.data.items.map(row => row.id), ['location-b']);
  const general = await get('/collections/requests?status=pending', manager);
  assert.equal(general.data.total, 3);
  const partner = await login('partnerA');
  assert.deepEqual((await get('/collections/requests?scope=location', partner)).data.items.map(row => row.id), ['location-a']);
  const finance = await login('finance');
  assert.equal((await get('/collections/requests?scope=location', finance)).data.total, 0);
});
