'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('../server/index.cjs');
const { verifyAudit } = require('../server/maintenance.cjs');

const opsPhone = '+441632960101';
const supportPhone = '+441632960102';
const defaultPhone = '+441632960103';
const headquartersPhone = '+441632960104';

async function withFixture(run) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jiuying-contacts-'));
  const app = createServer({ dbPath: path.join(folder, 'contacts.db'), env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
    async function api(url, token, body, expected = 200) {
      const response = await fetch(base + url, {
        method: body ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
        body: body && JSON.stringify(body),
      });
      const payload = await response.json();
      assert.equal(response.status, expected, JSON.stringify(payload));
      return payload;
    }
    const personalLogins = new Map();
    const login = async actor => personalLogins.has(actor)
      ? (await api('/auth/password', null, { username: actor, password: personalLogins.get(actor) })).data.token
      : (await api('/auth/dev', null, { actor })).data.token;
    const command = (token, command, payload, expected) => api('/commands', token, { command, payload }, expected);
    const manager = await login('manager');
    const partner = await login('partnerA');
    const other = await login('partnerB');
    const visitor = (await api('/auth/visitor', null, {})).data.token;
    const staff = async (subject, role, grants) => {
      await command(manager, 'staff.create', { subject, name: subject, role, grants, reason: '隔离工作电话测试' });
      const password = randomUUID() + '-ContactAcceptance!';
      const invitation = await api('/auth/activation', manager, { actor: subject, username: subject });
      await api('/auth/activate', null, { token: invitation.data.token, password });
      personalLogins.set(subject, password);
    };
    const publish = (actor, phone, options = {}) => api('/work-contacts/manage', manager, { actor, outlet: 'cs', phone, published: true, confirmed: true, ...options });
    const withdraw = actor => api('/work-contacts/manage', manager, { actor, outlet: 'cs', published: false });
    const lookup = (token, fields, expected) => api('/work-contacts?' + new URLSearchParams({ outlet: 'cs', ...fields }), token, null, expected);
    const routing = (kind, assigneeRole, assigneeUserId) => command(manager, 'routing.set', { outlet: 'cs', kind, assigneeRole, assigneeUserId, enabled: true, reason: '隔离测试按网点分派' });
    const setHotline = phone => command(manager, 'support.settings', { phone, hours: '09:00-17:00', sla: { complaint: null, aftersale: null, exception: null } });
    await run({ app, api, login, command, staff, manager, partner, other, visitor, publish, withdraw, lookup, routing, setHotline });
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(folder, { recursive: true, force: true });
  }
}

test('approved work numbers resolve actual business responsibility before outlet and support defaults', t => withFixture(async f => {
  await f.staff('contact_ops', 'ops');
  await f.staff('contact_support', 'support');
  await f.staff('contact_default', 'finance');
  const initial = await f.lookup(f.partner);
  assert.equal(initial.data.contact, null);
  await f.setHotline(headquartersPhone);
  assert.deepEqual((await f.lookup(f.partner)).data.contact, { phone: headquartersPhone, source: 'headquarters' });
  const approved = await f.publish('contact_ops', '+44 (1632) 960101');
  await f.publish('contact_support', supportPhone);
  await f.routing('support_queue', 'support', 'contact_support');
  assert.deepEqual((await f.lookup(f.partner)).data.contact, { phone: supportPhone, source: 'support' });
  await f.publish('contact_default', defaultPhone, { isDefault: true });
  assert.deepEqual((await f.lookup(f.partner)).data.contact, { phone: defaultPhone, source: 'default' });
  await f.routing('request_review', 'ops', 'contact_ops');
  const submitted = await f.command(f.partner, 'request.submit', { type: 'enrollment', outlet: 'cs', data: { applicable: false, reason: '隔离招生业务信息确认' } });
  const recordId = submitted.data.result.id;
  const specific = await f.lookup(f.partner, { recordType: 'requests', recordId });
  assert.deepEqual(specific.data.contact, { phone: opsPhone, source: 'assigned' });
  const approvedTicket = await f.command(f.partner, 'support.ticket', { outlet: 'cs', category: 'exception', title: '工作电话核实', description: '隔离核对对应经办人员' });
  const ticketId = approvedTicket.data.result.id;
  const ticketScope = { recordType: 'supportTickets', recordId: ticketId };
  assert.deepEqual((await f.lookup(f.partner, ticketScope)).data.contact, { phone: supportPhone, source: 'assigned' });
  await f.command(await f.login('contact_support'), 'support.claim', { id: ticketId });
  assert.deepEqual((await f.lookup(f.partner, ticketScope)).data.contact, { phone: supportPhone, source: 'assigned' });
  const otherOutlet = f.app.store.db.prepare("SELECT id FROM outlets WHERE owner='p2' LIMIT 1").get().id;
  await f.lookup(f.other, { recordType: 'requests', recordId }, 404);
  await f.lookup(f.other, { outlet: otherOutlet, recordType: 'requests', recordId }, 404);
  await f.lookup(f.visitor, {}, 403);
  await f.lookup(f.partner, { recordType: 'accounts', recordId }, 400);
  await f.lookup(f.partner, { recordType: 'requests' }, 400);
  await f.command(f.manager, 'public.profile', { outlet: 'cs', title: '隔离公开网点', description: '隔离公开验证',
    services: ['网点服务'], contact: '0123456789', address: '隔离验证地址', published: true, reason: '验证工作电话不进入公开目录' });
  const publicOutlet = await f.api('/collections/outlets/cs?scope=public', f.visitor);
  for (const number of [opsPhone, supportPhone, defaultPhone]) assert.equal(JSON.stringify(publicOutlet).includes(number), false);
  const auditRows = f.app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.command')='work_contact.publish'").all().map(row => JSON.parse(row.data));
  assert.ok(auditRows.some(row => row.subject === 'manager' && row.requestId === approved.requestId && row.staffId === 'contact_ops'));
  assert.ok(auditRows.every(row => !JSON.stringify(row).includes(opsPhone)));
  assert.equal(verifyAudit(f.app.store.db).valid, true);
  t.diagnostic(JSON.stringify({ publication: approved.requestId, application: submitted.requestId, projection: specific.requestId }));
}));

test('publication is manager-only, explicit, bounded to eligible scope, and revocable', t => withFixture(async f => {
  await f.staff('contact_revoke_ops', 'ops');
  await f.staff('contact_region', 'regional', { outlets: ['zz'], metrics: [], reviewOutlets: [] });
  await f.command(f.manager, 'staff.create', { subject: 'contact_unactivated', name: '待激活联系人', role: 'ops', reason: '隔离未激活验证' });
  await f.api('/work-contacts/manage', f.manager, { actor: 'contact_unactivated', outlet: 'cs', phone: opsPhone, published: true, confirmed: true }, 403);
  await f.api('/work-contacts/manage', f.partner, null, 403);
  await f.api('/work-contacts/manage', f.partner, { actor: 'contact_revoke_ops', outlet: 'cs', phone: opsPhone, published: true, confirmed: true }, 403);
  await f.api('/work-contacts/manage', f.manager, { actor: 'contact_revoke_ops', outlet: 'cs', phone: opsPhone, published: true }, 400);
  await f.api('/work-contacts/manage', f.manager, { actor: 'contact_revoke_ops', outlet: 'cs', phone: '12345#999', published: true, confirmed: true }, 400);
  await f.api('/work-contacts/manage', f.manager, { actor: 'contact_region', outlet: 'cs', phone: opsPhone, published: true, confirmed: true }, 403);
  const before = await f.publish('contact_revoke_ops', opsPhone, { isDefault: true });
  const repeated = await f.publish('contact_revoke_ops', opsPhone, { isDefault: true });
  assert.equal(repeated.data.changed, false);
  assert.deepEqual((await f.lookup(f.partner)).data.contact, { phone: opsPhone, source: 'default' });
  const directory = await f.api('/work-contacts/manage?actor=contact_revoke_ops&limit=25', f.manager);
  assert.equal(directory.data.items.length, 1);
  assert.equal(directory.data.items[0].phone, opsPhone);
  const withdrawal = await f.withdraw('contact_revoke_ops');
  assert.equal(withdrawal.data.changed, true);
  assert.equal((await f.lookup(f.partner)).data.contact, null);
  await f.publish('contact_revoke_ops', opsPhone, { isDefault: true });
  await f.command(f.manager, 'staff.update', { id: 'contact_revoke_ops', status: 'disabled', reason: '隔离人员已关闭' });
  assert.equal((await f.lookup(f.partner)).data.contact, null);
  const disabled = await f.api('/work-contacts/manage?actor=contact_revoke_ops', f.manager);
  assert.equal(disabled.data.items[0].effective, false);
  t.diagnostic(JSON.stringify({ publication: before.requestId, withdrawal: withdrawal.requestId, disabledRead: disabled.requestId }));
}));

test('native dial rechecks the displayed number and discards late responses from another selected outlet', () => withFixture(async f => {
  await f.staff('contact_native_ops', 'ops');
  await f.publish('contact_native_ops', opsPhone, { isDefault: true });
  await f.publish('contact_native_ops', defaultPhone, { outlet: 'zz', isDefault: true });
  const api = require('../miniprogram/utils/api');
  const { workContactBehavior } = require('../miniprogram/utils/work-contacts');
  const originalRequest = api.request, originalWx = global.wx;
  const calls = [], messages = [];
  global.wx = { makePhoneCall: ({ phoneNumber }) => calls.push(phoneNumber), showToast: ({ title }) => messages.push(title) };
  const page = {
    _serial: 1, data: { outlet: 'cs' },
    ...workContactBehavior(function () { return { outlet: this.data.outlet }; }),
    setData(values) { Object.assign(this.data, values); },
  };
  const request = async route => (await f.api(route.slice(4), f.partner)).data;
  api.request = request;
  try {
    await page.refreshWorkContact();
    assert.equal(page.data.workContact.phone, opsPhone);
    await f.withdraw('contact_native_ops');
    await page.dialWorkContact();
    assert.deepEqual(calls, []);
    assert.match(messages.at(-1), /已撤回/);
    await f.publish('contact_native_ops', opsPhone, { isDefault: true });
    let release;
    api.request = route => route.endsWith('=cs') ? new Promise(resolve => { release = () => resolve(request(route)); }) : request(route);
    const pending = page.refreshWorkContact();
    page.data.outlet = 'zz';
    await page.refreshWorkContact();
    assert.equal(page.data.workContact.phone, defaultPhone);
    assert.equal(typeof release, 'function');
    release();
    await pending;
    assert.equal(page.data.workContact.phone, defaultPhone);
    await page.dialWorkContact();
    assert.deepEqual(calls, [defaultPhone]);
    page.data.isPublic = true;
    await page.refreshWorkContact();
    assert.equal(page.data.workContact, null);
  } finally {
    api.request = originalRequest;
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  }
}));
