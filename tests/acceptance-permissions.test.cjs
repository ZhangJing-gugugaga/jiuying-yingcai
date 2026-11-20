'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');

async function withServer(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  async function request(path, token, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    assert.ok(response.headers.get('x-request-id'));
    return { status: response.status, ...(!Buffer.isBuffer(result) ? result : { bytes: result }) };
  }
  async function data(path, token, body, status = 200) {
    const response = await request(path, token, body);
    assert.equal(response.status, status, JSON.stringify(response.error));
    return response.data;
  }
  async function login(actor) {
    const auth = actor === 'public'
      ? await data('/auth/visitor', null, {})
      : await data('/auth/dev', null, { actor });
    return auth.token;
  }
  const command = (token, name, payload) => request('/commands', token, { command: name, payload });
  const apply = async (token, name, payload) => (await data('/commands', token, { command: name, payload })).result;
  try {
    await run({ app, request, data, login, command, apply });
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('FAQ conversation remains with its owner until transfer to the human support queue', () => withServer(async f => {
  const visitor = await f.login('public');
  const support = await f.login('support');
  const chat = await f.apply(visitor, 'support.chat', { text: '查询服务时间' });
  const detail = '/collections/supportChats/' + chat.id;
  assert.equal((await f.data(detail, visitor)).status, 'bot');
  const before = await f.data('/collections/supportChats', support);
  assert.equal(before.total, 0);
  assert.deepEqual(before.items, []);
  assert.equal((await f.request(detail, support)).status, 404);
  await f.apply(visitor, 'support.human', { id: chat.id });
  assert.equal((await f.data(detail, support)).status, 'queued');
  assert.equal((await f.apply(support, 'support.claim', { id: chat.id })).status, 'active');
  assert.equal((await f.command(support, 'support.claim', { id: chat.id })).status, 409);
  await f.apply(support, 'support.reply', { id: chat.id, text: '请查看当前服务时间' });
  assert.equal((await f.data(detail, visitor)).messages.at(-1).text, '请查看当前服务时间');
}));

test('consumer ticket keeps internal collaboration notes in staff view and exposes escalated tickets to management', () => withServer(async f => {
  const visitor = await f.login('public');
  const other = await f.login('public');
  const manager = await f.login('manager');
  const owner = await f.login('partnerA');
  const support = await f.login('support');
  const ticket = await f.apply(visitor, 'support.ticket', { outlet: 'cs', category: 'complaint', title: '售后投诉', description: '消费咨询原文', contact: '13900000000' });
  const detail = '/collections/supportTickets/' + ticket.id;
  assert.equal((await f.request(detail, other)).status, 404);
  assert.equal((await f.request(detail, owner)).status, 404);
  assert.equal((await f.request(detail, manager)).status, 404);
  assert.equal((await f.data('/collections/supportTickets', manager)).total, 0);
  const notices = (await f.data('/collections/messages', owner)).items.filter(row => row.ticketId === ticket.id);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(JSON.stringify(notices), /13900000000|消费咨询原文/);
  await f.apply(support, 'support.claim', { id: ticket.id });
  await f.apply(support, 'support.collaborate', { id: ticket.id, department: '运营', note: '内部核实备注' });
  assert.equal((await f.data(detail, support)).collaborations[0].note, '内部核实备注');
  assert.equal((await f.data(detail, visitor)).collaborations, undefined);
  await f.apply(support, 'support.escalate', { id: ticket.id, reason: '需要高级管理确认' });
  assert.equal((await f.data(detail, manager)).id, ticket.id);
  await f.apply(manager, 'support.reply', { id: ticket.id, text: '已确认处理意见' });
  await f.apply(support, 'support.close', { id: ticket.id, note: '处理完成' });
  const old = await f.apply(visitor, 'support.rate', { id: ticket.id, rating: 5 });
  assert.equal(old.rating.score, 5);
  const followUp = await f.apply(visitor, 'support.ticket', { outlet: 'cs', category: 'complaint', title: '补充咨询', description: '继续核实', linkedTicketId: ticket.id });
  assert.equal(followUp.linkedTicketId, ticket.id);
  assert.equal((await f.data(detail, visitor)).status, 'closed');
}));

test('contact centre outlet directory is limited to fields needed for matching a ticket', () => withServer(async f => {
  const support = await f.login('support');
  const shop = await f.data('/collections/outlets/cs', support);
  assert.equal(shop.name, '长沙示范网点A');
  assert.equal(shop.district, '示范区');
  for (const field of ['owner', 'phone', 'address', 'coords', 'confirmedLocation', 'locationHistory']) {
    assert.equal(shop[field], undefined, field);
  }
  for (const name of ['reports', 'bills', 'payments', 'verifications']) {
    assert.equal((await f.request('/collections/' + name, support)).status, 403, name);
  }
}));

test('ticket directory search uses authorized fields', () => withServer(async f => {
  const support = await f.login('support');
  const search = '/collections/outlets?q=';
  assert.equal((await f.data(search + encodeURIComponent('长沙'), support)).total, 1);
  assert.equal((await f.data(search + encodeURIComponent('模拟路'), support)).total, 0);
  assert.equal((await f.request('/collections/outlets?owner=p1', support)).status, 403);
}));

test('settlements paginate only matching authorized reports and omit organization-wide coverage from restricted roles', () => withServer(async f => {
  const [manager, owner, other, regional] = await Promise.all(['manager', 'partnerA', 'partnerB', 'regional'].map(f.login));
  await f.apply(other, 'report.submit', { outlet: 'gz', month: '2026-10', revenue: 200, orders: 5, traffic: 12, enroll: 1 });
  const submitted = (await f.data('/collections/reports?outlet=gz&month=2026-10', manager)).items[0];
  await f.apply(manager, 'review.report', { id: submitted.id, decision: 'approve' });
  const created = await f.apply(manager, 'settle', { month: '2026-10' });
  assert.equal(created.reportingCoverage.approved, 1);
  assert.equal(created.reportingCoverage.expected, 4);
  const detail = '/collections/settlements/' + created.id;
  for (const token of [owner, regional]) {
    const page = await f.data('/collections/settlements?limit=1', token);
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1);
    assert.equal(page.hasMore, true);
    assert.notEqual(page.items[0].id, created.id);
    assert.equal((await f.request(detail, token)).status, 404);
  }
  const relevant = await f.data(detail, other);
  assert.deepEqual(relevant.reportIds, [submitted.id]);
  assert.equal(relevant.reportingCoverage, undefined);
  assert.equal(relevant.coverageComplete, undefined);
  assert.equal((await f.data(detail, manager)).coverageComplete, false);
}));

test('location application approval keeps private evidence and earlier location while the public profile stays unchanged', () => withServer(async f => {
  const [owner, other, specialist, ops, finance, regional, visitor] = await Promise.all(['partnerA', 'partnerB', 'location', 'ops', 'finance', 'regional', 'public'].map(f.login));
  const coords = { lat: 28.26, lng: 113.22, source: 'gps', coordinateSystem: 'GCJ-02', accuracy: 10 };
  const publicCoords = { lat: 28.29, lng: 113.23, coordinateSystem: 'GCJ-02' };
  await f.apply(ops, 'public.profile', { outlet: 'cs', title: '公开服务点', description: '公开服务介绍', services: ['公开服务'], address: '公开营业地址', publicCoords, published: true, reason: '授权公开' });
  const outletPath = '/collections/outlets/cs';
  const before = await f.data(outletPath, owner);
  const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQt7cQt7dggFAADxICOY+6F6cAAAAASUVORK5CYII=';
  const photo = await f.data('/files', owner, { name: 'location.png', type: 'image/png', base64: pixels }, 201);
  const change = await f.apply(owner, 'request.submit', { type: 'locationChange', outlet: 'cs', data: { address: '新营业地点', coords, photo, reason: '位置变更核验' } });
  const requestPath = '/collections/requests/' + change.id;
  assert.equal((await f.command(ops, 'review.request', { id: change.id, decision: 'approve' })).status, 409);
  assert.deepEqual((await f.data(outletPath, owner)).coords, before.coords);
  for (const token of [other, regional, visitor, ops, finance]) {
    assert.equal((await f.request('/files/' + photo.id, token)).status, 403);
  }
  assert.ok((await f.request('/files/' + photo.id, specialist)).bytes.length > 0);
  assert.deepEqual((await f.data(requestPath, specialist)).data.coords, coords);
  assert.equal((await f.data(requestPath, ops)).data.coords, undefined);
  assert.equal((await f.data(requestPath, ops)).data.photo, undefined);
  await f.apply(specialist, 'location.review', { id: change.id, decision: 'approve' });
  await f.apply(ops, 'review.request', { id: change.id, decision: 'approve' });
  assert.equal((await f.command(ops, 'review.request', { id: change.id, decision: 'approve' })).status, 409);
  const after = await f.data(outletPath, owner);
  assert.deepEqual(after.coords, coords);
  assert.equal(after.locationHistory.length, before.locationHistory.length + 1);
  assert.deepEqual(after.locationHistory.at(-1).before.coords, before.coords);
  const publicOutlet = await f.data(outletPath, visitor);
  assert.deepEqual(publicOutlet.publicCoords, publicCoords);
  for (const field of ['coords', 'locationHistory', 'confirmedLocation', 'phone']) assert.equal(publicOutlet[field], undefined, field);
}));

test('owner replacement revokes old login and sessions while retaining report, audit and outlet ownership', () => withServer(async f => {
  const manager = await f.login('manager');
  const before = await f.data('/auth/activation', manager, { actor: 'partnerA', username: 'acceptance.owner.before' });
  const owner = (await f.data('/auth/activate', null, { token: before.token, password: 'Test-old-mock-password!' })).token;
  const reportPath = '/collections/reports?outlet=cs&month=2026-09';
  const history = (await f.data(reportPath, owner)).items[0];
  const change = await f.apply(owner, 'request.submit', { type: 'accountChange', outlet: 'cs', data: { managerName: '新任负责人', mobile: '13900000001', reason: '总部核验离任及交接', evidenceReference: '独立验收交接编号' } });
  const auditBefore = (await f.data('/collections/audit', manager)).items.find(row => row.recordId === change.id && row.command === 'request.submit');
  assert.equal(auditBefore.owner, 'p1');
  await f.apply(manager, 'review.request', { id: change.id, decision: 'approve', note: '已核验交接' });
  assert.equal((await f.request('/context', owner)).status, 401);
  assert.equal((await f.request('/auth/password', null, { username: before.username, password: 'Test-old-mock-password!' })).status, 401);
  const after = await f.data('/auth/activation', manager, { actor: 'partnerA', username: 'acceptance.owner.after' });
  const nextOwner = (await f.data('/auth/activate', null, { token: after.token, password: 'Test-new-mock-password!' })).token;
  assert.deepEqual((await f.data(reportPath, nextOwner)).items[0], history);
  assert.equal((await f.data('/collections/outlets', nextOwner)).total, 3);
  const acct = (await f.data('/collections/accounts?owner=p1', manager)).items[0];
  assert.equal(acct.ownerHistory.at(-1).requestId, change.id);
  assert.equal((await f.data('/collections/audit/' + auditBefore.id, manager)).owner, 'p1');
}));

test('follow-up tickets require the original outlet even when both outlets belong to the same principal', () => withServer(async f => {
  const partner=await f.login('partnerA');
  const support=await f.login('support');
  const input={outlet:'zz',category:'aftersale',title:'原网点工单',description:'隔离样例'};
  const old=await f.apply(partner,'support.ticket',input);
  await f.apply(support,'support.claim',{id:old.id});
  await f.apply(support,'support.close',{id:old.id,note:'完结原工单'});
  const mismatch=await f.command(partner,'support.ticket',{...input,outlet:'cs',linkedTicketId:old.id});
  assert.equal(mismatch.status,400);
  assert.equal(mismatch.error.code,'INPUT');
  assert.equal((await f.data('/collections/supportTickets',partner)).total,1);
  const linked=await f.apply(partner,'support.ticket',{...input,linkedTicketId:old.id});
  assert.equal(linked.outlet,'zz');
  assert.equal(linked.linkedTicketId,old.id);
}));

test('telephone complaints alert the store only for consumer cases and exclude private caller details', () => withServer(async f => {
  const partner=await f.login('partnerA');
  const support=await f.login('support');
  const payload={outlet:'cs',category:'complaint',channel:'phone',title:'不可出现在通知的标题',description:'仅客服见的投诉原文',contact:'13900000000'};
  const own=await f.apply(support,'support.ticket',{...payload,customerType:'partner'});
  const initial=(await f.data('/collections/messages',partner)).items;
  assert.equal(initial.some(row=>row.ticketId===own.id&&row.title==='消费者投诉待协助核实'),false);
  const consumer=await f.apply(support,'support.ticket',{...payload,customerType:'consumer'});
  const notices=(await f.data('/collections/messages',partner)).items.filter(row=>row.ticketId===consumer.id);
  assert.equal(notices.length,1);
  assert.equal(notices[0].title,'消费者投诉待协助核实');
  assert.doesNotMatch(JSON.stringify(notices),/13900000000|仅客服见的投诉原文|不可出现在通知的标题/);
  assert.equal((await f.request('/collections/supportTickets/'+consumer.id,partner)).status,404);
  assert.equal((await f.request('/approval-history/supportTickets/'+consumer.id,partner)).status,404);
}));
