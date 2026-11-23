'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');

async function isolated(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const trace = [];
  async function call(path, token, body, status = 200) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    trace.push({ path, status: response.status, requestId: response.headers.get('x-request-id') });
    assert.ok(trace.at(-1).requestId);
    assert.equal(response.status, status, JSON.stringify(result.error));
    return result.data;
  }
  const login = async actor => (await call(actor === 'public' ? '/auth/visitor' : '/auth/dev', null, { actor })).token;
  const command = (token, name, payload, status) => call('/commands', token, { command: name, payload }, status);
  try { await run({ app, call, login, command, trace }); }
  finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('public map point pages skip unapproved, closed and private data and include overseas explicit coordinates', t => isolated(async ({ app, login, call, command, trace }) => {
  const [visitor, partner, manager] = await Promise.all(['public', 'partnerA', 'manager'].map(login));
  const s = app.store.load();
  const sample = s.outlets.find(row => row.id === 'gz');
  const add = (id, status = 'open') => s.outlets.push({ ...sample, id, outlet: id, status, phone: 'TEST-INTERNAL', address: '内部地址', coords: { lat: 12, lng: 32 }, photo: 'TEST-INTERNAL' });
  for (let i = 0; i < 207; i++) {
    const id = `test-map-mainland-${i}`;
    add(id);
    s.publicProfiles.push({ id: `profile-${id}`, outlet: id, status: 'published', title: `公开网点 ${i}`, city: '广州', province: '广东', address: '可公开服务地址', contact: 'TEST-INTERNAL', publicCoords: { lat: 23.12, lng: 113.34 + i / 10000, coordinateSystem: 'GCJ-02' } });
  }
  add('test-map-foreign');
  add('test-map-text');
  add('test-map-draft');
  add('test-map-closed', 'closed');
  app.store.transaction(() => app.store.save(s));
  const profile = (outlet, overrides = {}) => ({ outlet, published: true, title: outlet, address: `对外地址 ${outlet}`, description: '隔离地图验收资料', services: ['公开服务'], reason: '合成授权记录', ...overrides });
  const foreign = { countryCode: 'SG', city: '新加坡', publicCoords: { lat: 1.3, lng: 103.8, coordinateSystem: 'WGS-84' } };
  await command(partner, 'public.profile', profile('test-map-foreign', foreign), 403);
  await command(manager, 'public.profile', profile('test-map-foreign', { ...foreign, countryCode: 'ZZ' }), 400);
  await command(manager, 'public.profile', profile('test-map-foreign', { ...foreign, publicCoords: { ...foreign.publicCoords, coordinateSystem: 'GCJ-02' } }), 400);
  await command(manager, 'public.profile', profile('test-map-foreign', foreign));
  await command(manager, 'public.profile', profile('test-map-text', { countryCode: 'NZ', city: '奥克兰', publicCoords: null }));
  await command(manager, 'public.profile', profile('test-map-draft', { ...foreign, published: false }));
  await command(manager, 'public.profile', profile('test-map-closed', foreign));
  await command(manager, 'public.profile', profile('test-map-foreign', { countryCode: 'NZ', city: '奥克兰' }), 400);

  const directory = '/collections/outlets?scope=public';
  const map = `${directory}&spatial=points`;
  const first = await call(`${map}&limit=200`, visitor);
  const second = await call(`${map}&limit=200&offset=200`, partner);
  const points = [...first.items, ...second.items];
  assert.deepEqual([first.total,first.items.length,first.hasMore,second.items.length,second.hasMore], [208,200,true,8,false]);
  assert.equal(new Set(points.map(x => x.id)).size, 208);
  assert.ok(points.some(x => x.id === 'test-map-mainland-0'));
  assert.ok(points.every(x => !('owner' in x || 'coords' in x || 'address' in x || 'photo' in x || 'contact' in x || 'phone' in x)));
  assert.ok(points.every(x => !JSON.stringify(x).includes('TEST-INTERNAL')));
  const sg = (await call(`${map}&geo=overseas&countryCode=SG`, visitor)).items[0];
  assert.equal(sg.id, 'test-map-foreign');
  assert.equal(sg.countryCode, 'SG');
  assert.deepEqual(sg.publicLocation, { latitude: 1.3, longitude: 103.8, coordinateSystem: 'WGS-84', precision: 'public' });
  assert.equal((await call(`${map}&geo=mainland`, visitor)).total, 207);
  assert.equal((await call(`${map}&geo=overseas&countryCode=NZ`, visitor)).total, 0);
  await call(`${map}&owner=p2`, visitor, undefined, 403);
  await call(`${map}&limit=201`, visitor, undefined, 400);
  assert.deepEqual((await call(`${directory}&includeCountries=true`, visitor)).countries.map(x => x.code).sort(), ['CN', 'NZ', 'SG']);
  const overseas = await call(`${directory}&geo=overseas`, visitor);
  assert.deepEqual(overseas.items.map(x => x.id).sort(), ['test-map-foreign','test-map-text']);
  assert.equal(overseas.items.find(x => x.id === 'test-map-text').publicCoords, undefined);
  const detail = await call('/collections/outlets/test-map-foreign?scope=public', partner);
  assert.deepEqual([detail.city,detail.province,detail.district,detail.address], ['新加坡','','','对外地址 test-map-foreign']);
  await call('/collections/outlets/test-map-foreign', partner, undefined, 404);
  await command(manager, 'public.profile', profile('test-map-foreign', { ...foreign, published: false }));
  assert.equal((await call(`${map}&geo=overseas`, visitor)).total, 0);
  await call('/collections/outlets/test-map-foreign?scope=public', visitor, undefined, 404);
  t.diagnostic(JSON.stringify({ mapPointCount: points.length, countryCodes: ['CN','NZ','SG'], overseasOutlet: sg.id, trace }));
}));

test('overseas outlets can be created by request and import without domestic province or district', () => {
  const core = require('../shared/core.cjs');
  let state = core.createState();
  const run = (actor, command, payload) => {
    const execution = core.execute(state, actor, command, payload, { today: '2026-11-18', subject: actor });
    state = execution.state;
    return execution.result;
  };
  const source = {
    countryCode: 'sg', city: '新加坡', name: '隔离新增境外网点', address: '合成地址',
    phone: '+65-0000-0000', opening: '2026-11-10',
    coords: { lat: 1.3, lng: 103.8, source: 'gps', coordinateSystem: 'WGS-84' }, photo: { id: 'file-fixture' },
  };
  assert.throws(() => run('partnerA', 'request.submit', { type: 'newOutlet', data: {...source, countryCode: 'CN'} }), { code: 'INPUT' });
  const request = run('partnerA', 'request.submit', { type: 'newOutlet', data: source });
  assert.deepEqual([request.data.countryCode, request.data.city, request.data.province, request.data.district], ['SG','新加坡','','']);
  run('location', 'location.review', { id: request.id, decision: 'approve' });
  const approved = run('ops', 'review.request', { id: request.id, decision: 'approve' });
  const outlet = state.outlets.find(row => row.id === approved.data.createdOutletId);
  assert.equal(outlet.countryCode, 'SG');
  assert.equal(outlet.status, 'preparing');
  assert.equal(outlet.confirmedLocation, null);
  const preview = run('manager', 'import.preview', {
    kind: 'outlets', reason: '隔离样例',
    rows: [{ countryCode: 'MY', city: '吉隆坡', owner: 'p1', name: '隔离导入境外网点', address: '合成地址', phone: '0000', opening: '2026-11-10', enrollmentApplicable: false, status: 'open' }],
  });
  assert.equal(preview.errorCount, 0);
  const imported = run('manager', 'import.commit', { id: preview.id });
  const importedOutlet = state.outlets.find(row => row.id === imported.createdIds[0]);
  assert.deepEqual([importedOutlet.countryCode, importedOutlet.province, importedOutlet.city, importedOutlet.district], ['MY','','吉隆坡','']);
  const published = run('manager', 'public.profile', {
    outlet: importedOutlet.id, title: importedOutlet.name, description: '隔离发布', address: '合成公开地址',
    services: ['咨询'], published: true, reason: '隔离测试', publicCoords: {lat: 3.13, lng: 101.68, coordinateSystem: 'WGS-84'},
  });
  assert.equal(published.countryCode, 'MY');
  assert.equal(published.city, '吉隆坡');
});
