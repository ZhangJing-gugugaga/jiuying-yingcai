'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');

test('private ticket images follow the ticket participants and bind atomically only once', async () => {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  const request = async (path, token, body, key = randomUUID()) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: response.headers.get('Content-Type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const login = async actor => (await request('/auth/dev', null, { actor })).body.data.token;
  const command = (token, command, payload, key) => request('/commands', token, { command, payload }, key);
  const file = (token, id) => request('/files/' + id, token);
  try {
    const manager = await login('manager');
    const platform = await login('ops');
    const franchisee = await login('partnerA');
    for (const subject of ['attachments_support_a', 'attachments_support_b']) {
      assert.equal((await command(manager, 'staff.create', { subject, role: 'support', name: subject, reason: '隔离权限测试' })).status, 200);
      const invite = await request('/auth/activation', manager, {actor:subject,username:subject});
      assert.equal((await request('/auth/activate', null, {token:invite.body.data.token,password:randomUUID()+'-Attachment-Test'})).status, 200);
    }
    const first = await login('attachments_support_a');
    const second = await login('attachments_support_b');
    const guest = async () => (await request('/auth/visitor', null, {})).body.data.token;
    const visitor = await guest();
    const unrelatedVisitor = await guest();
    const base64 = (await sharp({ create: { width: 12, height: 12, channels: 3, background: '#315791' } }).png().toBuffer()).toString('base64');
    const upload = async (token, purpose) => {
      const result = await request('/files', token, { name: 'private-evidence.png', type: 'image/png', base64, purpose });
      assert.equal(result.status, 201, JSON.stringify(result.body.error));
      return result.body.data.id;
    };
    const attachment = await upload(visitor, 'support-ticket');
    const privateDraft = await file(visitor, attachment);
    assert.equal(privateDraft.status, 200);
    assert.equal(privateDraft.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(privateDraft.headers.get('Content-Type'), 'image/png');
    for (const principal of [manager, platform, first, second, franchisee, unrelatedVisitor]) {
      assert.equal((await file(principal, attachment)).status, 403);
    }
    const body = { outlet: 'cs', category: 'complaint', channel: 'miniprogram', title: '隔离测试', description: '需要客服查阅提交的图片' };
    assert.equal((await command(unrelatedVisitor, 'support.ticket', { ...body, attachmentIds: [attachment] })).status, 403);
    assert.equal((await command(visitor, 'support.ticket', { ...body, attachmentIds: [await upload(visitor)] })).status, 403);
    assert.equal((await command(visitor, 'support.ticket', { ...body, attachmentIds: [attachment, attachment, attachment, attachment] })).status, 400);
    assert.equal((await command(visitor, 'support.ticket', { ...body, attachmentIds: [attachment, attachment] })).status, 400);
    const managerPhoto = await upload(manager, 'support-ticket');
    assert.equal((await command(manager, 'content.update', { key:'brand', imageId:managerPhoto })).status, 403);
    assert.equal((await command(visitor, 'location.submit', { photo:{id:attachment} })).status, 403);
    assert.equal((await command(manager, 'routing.set', {
      outlet:'cs', kind:'support_queue', assigneeRole:'support', assigneeUserId:'attachments_support_a', enabled:true, reason:'指定隔离验证责任人'
    })).status, 200);
    const key = randomUUID();
    const submitted = await command(visitor, 'support.ticket', { ...body, attachmentIds: [attachment] }, key);
    assert.equal(submitted.status, 200);
    const ticket = submitted.body.data.result;
    assert.deepEqual(ticket.attachmentIds, [attachment]);
    assert.doesNotMatch(JSON.stringify(ticket), /private-evidence|base64|\/api\/files/);
    const replay = await command(visitor, 'support.ticket', { ...body, attachmentIds: [attachment] }, key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.result.id, ticket.id);
    assert.equal((await command(visitor, 'support.ticket', { ...body, attachmentIds: [attachment] })).status, 409);
    assert.equal(app.store.load().supportTickets.length, 1);
    assert.equal(app.store.db.prepare('SELECT ticket_id FROM support_ticket_files WHERE file_id=?').get(attachment).ticket_id, ticket.id);
    assert.equal((await file(first, attachment)).status, 200);
    assert.equal((await file(second, attachment)).status, 403);
    assert.equal((await command(first, 'support.claim', { id: ticket.id })).status, 200);
    for (const principal of [manager, platform, second, franchisee, unrelatedVisitor]) {
      assert.equal((await file(principal, attachment)).status, 403);
    }
    assert.equal((await file(first, attachment)).status, 200);
    assert.equal((await file(visitor, attachment)).status, 200);
    assert.equal((await command(first, 'support.escalate', { id: ticket.id, reason: '隔离升级验证' })).status, 200);
    assert.equal((await file(manager, attachment)).status, 200);
    const customerNotices = (await request('/collections/messages', franchisee)).body.data.items;
    const redacted = customerNotices.find(item => item.title === '消费者投诉待协助核实');
    assert.ok(redacted);
    assert.doesNotMatch(JSON.stringify(redacted), new RegExp(attachment));
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
});
