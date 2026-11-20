'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');

async function withServer(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;

  async function call(path, token, body, expected = 200) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result.error));
    assert.ok(response.headers.get('x-request-id'));
    return result.data;
  }

  async function login(actor) {
    return (await call(actor === 'public' ? '/auth/visitor' : '/auth/dev', null, { actor })).token;
  }

  try { await run({ app, call, login }); }
  finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('published outlet directory uses the same public projection for every session', () => withServer(async ({ call, login }) => {
  const visitor = await login('public'), partner = await login('partnerA'), other = await login('partnerB'), ops = await login('ops');
  const publish = (outlet, title, address, published, publicCoords) => call('/commands', ops, {
    command: 'public.profile',
    payload: { outlet, title, address, published, publicCoords, description: '对外服务介绍', services: ['咨询'], reason: '已核对公开资料' },
  });
  const publicCoords = { lat: 23.19, lng: 113.31, coordinateSystem: 'GCJ-02' };
  await publish('gz', '公开服务网点', '授权服务地址', true, publicCoords);
  await publish('cs', '拟发布网点', '待审核地址', false, null);
  const directory = '/collections/outlets';
  const expected = {
    id: 'gz', outlet: 'gz', name: '公开服务网点', address: '授权服务地址',
    province: '广东', city: '广州', district: '示范区', status: 'open', publicCoords,
    publicLocation: { latitude: 23.19, longitude: 113.31, coordinateSystem: 'GCJ-02', precision: 'public' },
  };
  for (const session of [visitor, partner, other, ops]) {
    const page = await call(`${directory}?scope=public&limit=1&q=${encodeURIComponent('授权服务')}`, session);
    assert.deepEqual(page, { items: [expected], total: 1, limit: 1, offset: 0, hasMore: false });
    assert.deepEqual(await call(`${directory}/gz?scope=public`, session), expected);
    await call(`${directory}/cs?scope=public`, session, undefined, 404);
  }
  const owned = await call(`${directory}/cs`, partner);
  assert.equal(owned.owner, 'p1');
  assert.ok(owned.coords);
  await call(`${directory}/gz`, partner, undefined, 404);
  const legacy = await call(`${directory}/gz`, visitor);
  assert.equal(legacy.address, expected.address);
  assert.equal(legacy.coords, undefined);
  await publish('gz', '公开服务网点', '授权服务地址', false, publicCoords);
  assert.equal((await call(`${directory}?scope=public`, partner)).total, 0);
  await publish('zz', '已公开资料的网点', '授权文字地址', true, null);
  const withoutCoordinates = await call(`${directory}/zz?scope=public`, visitor);
  assert.equal(withoutCoordinates.address, '授权文字地址');
  assert.equal(withoutCoordinates.publicLocation, undefined);
  assert.equal(withoutCoordinates.coords, undefined);
}));

test('private outlet summaries resolve previous reporting month, current verification and bill independently', () => withServer(async ({ app, call, login }) => {
  const owner = await login('partnerA'), other = await login('partnerB'), visitor = await login('public');
  const state = app.store.load(), cs = state.outlets.find(x => x.id === 'cs'), reportMonth = '2026-10', month = '2026-11';
  const effective = { id: 'summary-v1', outlet: cs.id, owner: cs.owner, month: reportMonth, version: 1, current: true, status: 'approved' };
  state.reports.push(effective, { ...effective, id: 'summary-v2', version: 2, current: false, status: 'finance' });
  state.settlements.push({ id: 'summary-settlement', status: 'approved', month: reportMonth, reportIds: [effective.id] });
  state.exemptions.push({ id: 'summary-exemption', outlet: 'zz', owner: cs.owner, month: reportMonth, status: 'approved' });
  state.verifications.push({ id: 'summary-location', outlet: cs.id, owner: cs.owner, month, status: 'approved' });
  state.bills.find(bill => bill.outlet === 'hy').status = 'reversed';
  app.store.transaction(() => app.store.save(state));

  const path = '/collections/outlets?includeSummary=true&limit=1';
  const pages = await Promise.all([0, 1, 2].map(offset => call(`${path}&offset=${offset}`, owner)));
  assert.ok(pages.every(page => page.total === 3 && page.items.length === 1));
  const summaries = Object.fromEntries(pages.flatMap(page => page.items).map(({ id, summary }) => [id, summary]));
  assert.deepEqual(summaries.cs, {
    period: month,
    report: { month: reportMonth, status: 'finance', settlementStatus: 'settled' },
    location: { month, status: 'approved' },
    fee: { month, status: 'unpaid' },
  });
  assert.deepEqual(summaries.zz.report, { month: reportMonth, status: 'exempt', settlementStatus: 'not_applicable' });
  assert.deepEqual(summaries.hy.report, { month: reportMonth, status: 'exemption_pending', settlementStatus: 'unsettled' });
  assert.deepEqual(summaries.hy.fee, { month, status: 'reversed' });
  assert.equal(summaries.zz.location.status, 'missing');
  const another = await call(path, other);
  assert.deepEqual(another.items.map(x => x.id), ['gz']);
  assert.deepEqual(another.items[0].summary.report, { month: reportMonth, status: 'missing', settlementStatus: 'unsettled' });
  assert.equal((await call('/collections/outlets/cs', owner)).summary, undefined);
  const publicPage = await call(`${path}&scope=public`, visitor);
  assert.ok(publicPage.items.every(x => x.summary === undefined));
}));

test('all five business slots support publication, withdrawal and historical restoration', () => withServer(async ({ call, login }) => {
  const manager = await login('manager'), visitor = await login('public'), partner = await login('partnerA');
  const command = async (name, payload) => (await call('/commands', manager, { command: name, payload })).result;
  const directory = '/collections/publicContents';
  const released = [];
  for (let slot = 1; slot <= 5; slot++) {
    const input = { slot, title: `验收服务 ${slot}`, summary: `服务 ${slot} 摘要`, body: `服务 ${slot} 说明`, reason: '隔离验收发布' };
    const first = await command('content.service.save', { ...input, published: true });
    const detail = `${directory}/${first.id}`;
    assert.equal((await call(detail, visitor)).body, input.body);
    const draft = await command('content.service.save', { ...input, body: '未审核改稿', published: false });
    assert.equal((await call(detail, partner)).body, input.body);
    const withdrawn = await command('content.publication', { key: first.key, action: 'withdraw', expectedVersion: draft.version, reason: '隔离验收撤回' });
    await call(detail, visitor, undefined, 404);
    const restored = await command('content.publication', { key: first.key, action: 'restore', expectedVersion: withdrawn.version, sourceVersion: first.version, reason: '隔离验收恢复' });
    const live = await call(detail, visitor);
    assert.equal(live.body, input.body);
    assert.equal(live.version, restored.version);
    released.push(first.id);
  }
  assert.deepEqual((await call(directory, visitor)).items.map(item => item.id).sort(), released.sort());
}));
