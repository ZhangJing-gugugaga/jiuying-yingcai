'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {createServer} = require('../server/index.cjs');

async function runFixture(dbPath, run) {
  const app = createServer({dbPath, env: {NODE_ENV: 'test', ADAPTER_MODE: 'mock'}});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const password = 'Local-ApprovalExport-' + randomUUID();
  async function request(url, token, body, status = 200) {
    const response = await fetch(base + '/api' + url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? {Authorization: 'Bearer ' + token} : {}),
        ...(body ? {'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()} : {}),
      },
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const csv = response.headers.get('content-type')?.startsWith('text/csv');
    const parsed = csv ? await response.text() : await response.json();
    assert.equal(response.status, status, typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed));
    return csv ? {csv: parsed, requestId: response.headers.get('x-request-id')} : parsed;
  }
  const login = async actor => (await request('/auth/dev', null, {actor})).data.token;
  const command = (token, command, payload) => request('/commands', token, {command, payload});
  try {
    const legacyManager = await login('manager');
    async function personal(subject, role, grants) {
      await command(legacyManager, 'staff.create', {subject, name: subject, role, ...(grants ? {grants} : {}), reason: '隔离验收个人岗位'});
      const activation = (await request('/auth/activation', legacyManager, {actor: subject, username: subject})).data;
      return (await request('/auth/activate', null, {token: activation.token, password})).data.token;
    }
    const manager = await personal('export_hq_manager', 'manager');
    const ops = await personal('export_hq_ops', 'ops');
    const peer = await personal('export_hq_peer', 'ops');
    const partner = await login('partnerA');
    const outsider = await login('partnerB');
    await run({app, base, request, command, personal, manager, ops, peer, partner, outsider, password});
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

module.exports = {runFixture};
