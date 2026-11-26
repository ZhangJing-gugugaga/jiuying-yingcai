'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {test} = require('node:test');
const {createServer} = require('../server/index.cjs');

const managerId = 'live-test-manager';
const staffId = 'live-test-operator';
const testPassword = 'local-acceptance-only-127';
const mobile = '13910000121';
const nextMobile = '13910000122';
const endpoint = '/api/auth/staff';
const configuredWechat = {
  WECHAT_WEB_AUTH_ENABLED: '1',
  WECHAT_WEB_APP_ID: 'wx0000000000000001',
  WECHAT_WEB_APP_SECRET: 'isolated-test-website',
  PUBLIC_ORIGIN: 'https://acceptance.example.invalid',
};

async function fixture(t, options = {}) {
  const app = createServer({
    dbPath: ':memory:',
    env: {NODE_ENV: 'test', ADAPTER_MODE: 'mock', ...options.env},
    integrationFetch: options.fetch,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function request(path, body, token, expected = 200) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}),
        ...(token ? {Authorization: 'Bearer ' + token} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, path + ' ' + JSON.stringify(result.error));
    assert.match(result.requestId, /^[a-f0-9-]{36}$/);
    return result;
  }
  async function ticket(actor, inviter) {
    return (await request('/api/auth/activation', {actor}, inviter)).data.token;
  }
  async function activate(actor, inviter) {
    return (await request('/api/auth/activate', {token: await ticket(actor, inviter), password: testPassword})).data.token;
  }
  async function createStaff(subject, role, inviter) {
    await request('/api/commands', {command: 'staff.create', payload: {
      subject, name: subject, role, reason: '隔离登录验收',
    }}, inviter);
  }
  const developer = (await request('/api/auth/dev', {actor: 'manager'})).data.token;
  await createStaff(managerId, 'manager', developer);
  const manager = await activate(managerId, developer);
  await createStaff(staffId, 'ops', manager);
  return {app, request, manager, activate, createStaff, ticket};
}

test('HQ SMS authenticates only an explicitly registered and activated staff principal', async t => {
  const {app, request, manager, activate} = await fixture(t);
  const config = (await request('/api/config')).data;
  assert.equal(config.staffLogin.sms, true);
  assert.equal(config.staffLogin.wechat, false);
  await request(endpoint + '/mobile', {actor: staffId, mobile, password: 'wrong'}, manager, 403);
  const registration = await request(endpoint + '/mobile', {actor: staffId, mobile, password: testPassword}, manager);
  assert.equal(registration.data.smsMobileMasked, '139****0121');
  assert.doesNotMatch(JSON.stringify(registration), new RegExp(mobile));
  const inactive = await request(endpoint + '/sms/send', {mobile});
  assert.equal(inactive.data.devCode, undefined);
  await request(endpoint + '/sms/verify', {challengeId: inactive.data.challengeId, mobile, code: '000000'}, null, 401);
  const original = await activate(staffId, manager);
  app.store.db.prepare("UPDATE sms_challenges SET created_at=created_at-61000 WHERE id=?").run(inactive.data.challengeId);
  const sent = await request(endpoint + '/sms/send', {mobile, role: 'manager'});
  assert.match(sent.data.devCode, /^\d{6}$/);
  const verification = {challengeId: sent.data.challengeId, mobile, code: sent.data.devCode, actor: managerId};
  await request('/api/auth/sms/verify', verification, null, 401);
  const login = await request(endpoint + '/sms/verify', verification);
  assert.equal(login.data.role, 'ops');
  assert.equal(login.data.subject, staffId);
  await request(endpoint + '/sms/verify', verification, null, 401);
  await request(endpoint + '/mobile', {actor: managerId, mobile: nextMobile, password: testPassword}, login.data.token, 403);
  const profile = await request(endpoint + '/profile', undefined, original);
  assert.equal(profile.data.smsMobileMasked, '139****0121');
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT * FROM staff_login_mobiles').all()).includes(mobile));
  const mobileAudit = app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.requestId')=?").get(registration.requestId);
  const smsAudit = app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.requestId')=?").get(login.requestId);
  assert.equal(JSON.parse(mobileAudit.data).targetActor, staffId);
  assert.equal(JSON.parse(smsAudit.data).subject, staffId);
  assert.doesNotMatch(JSON.stringify([mobileAudit,smsAudit]), new RegExp(mobile));
  t.diagnostic(JSON.stringify({registration: registration.requestId, send: sent.requestId, verification: login.requestId, staffId}));
});

test('phone changes and role or status changes retire pending HQ SMS and old sessions', async t => {
  const {app, request, manager, activate} = await fixture(t);
  const activated = await activate(staffId, manager);
  await request(endpoint + '/mobile', {actor: staffId, mobile, password: testPassword}, manager);
  await request(endpoint + '/profile', undefined, activated, 401);
  const previous = await request(endpoint + '/sms/send', {mobile});
  await request(endpoint + '/mobile', {actor: staffId, mobile: nextMobile, password: testPassword}, manager);
  await request(endpoint + '/sms/verify', {challengeId: previous.data.challengeId, mobile, code: previous.data.devCode}, null, 401);
  const next = await request(endpoint + '/sms/send', {mobile: nextMobile});
  await request('/api/commands', {command: 'staff.update', payload: {
    id: staffId, status: 'disabled', reason: '隔离离岗',
  }}, manager);
  await request(endpoint + '/sms/verify', {challengeId: next.data.challengeId, mobile: nextMobile, code: next.data.devCode}, null, 401);
  const saved = app.store.db.prepare('SELECT status FROM users WHERE actor=?').get(staffId);
  assert.equal(saved.status, 'disabled');
});

test('HQ website OAuth binding and sign-in use a personal activated account and a one-use browser claim', async t => {
  const codes = new Map([['bind-code', 'website-specific-user'], ['login-code', 'website-specific-user'],
    ['duplicate-code', 'website-specific-user'], ['no-bound-code','website-new-user']]);
  let providerCalls = 0;
  const f = await fixture(t, {
    env: configuredWechat,
    fetch: async input => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(url.pathname, '/sns/oauth2/access_token');
      assert.equal(url.searchParams.get('appid'), configuredWechat.WECHAT_WEB_APP_ID);
      const code = url.searchParams.get('code'), openid = codes.get(code);
      codes.delete(code);
      providerCalls++;
      return Response.json(openid ? {openid, access_token:'verified-adapter-boundary-only'} : {errcode:40029});
    },
  });
  const {app,request,manager,activate} = f;
  const staffToken = await activate(staffId, manager);
  const config = (await request('/api/config')).data;
  assert.equal(config.staffLogin.wechat, true);
  await request(endpoint + '/wechat/bind', {password: 'wrong'}, staffToken, 403);
  const started = (await request(endpoint + '/wechat/bind', {password: testPassword}, staffToken)).data;
  const redirect = new URL(started.authorizationUrl);
  assert.equal(redirect.origin, 'https://open.weixin.qq.com');
  assert.equal(redirect.pathname, '/connect/qrconnect');
  assert.equal(redirect.searchParams.get('redirect_uri'), 'https://acceptance.example.invalid/');
  assert.equal(redirect.searchParams.get('scope'), 'snsapi_login');
  assert.ok(!started.authorizationUrl.includes(started.claim));
  const bind = {state: redirect.searchParams.get('state'), claim: started.claim, code: 'bind-code'};
  await request(endpoint + '/wechat/finish', {...bind, claim: 'different-browser'}, staffToken, 401);
  await request(endpoint + '/wechat/finish', bind, manager, 403);
  assert.equal(providerCalls, 0);
  const bound = await request(endpoint + '/wechat/finish', bind, staffToken);
  assert.deepEqual(bound.data, {wechatBound: true});
  await request(endpoint + '/wechat/finish', bind, staffToken, 401);

  const signed = (await request(endpoint + '/wechat/start', {})).data;
  const finish = {state: new URL(signed.authorizationUrl).searchParams.get('state'), claim: signed.claim, code: 'login-code', role: 'manager'};
  const login = await request(endpoint + '/wechat/finish', finish);
  assert.equal(login.data.role, 'ops');
  assert.equal(login.data.subject, staffId);
  await request(endpoint + '/wechat/finish', finish, null, 401);

  const duplicate = (await request(endpoint + '/wechat/bind', {password:testPassword}, manager)).data;
  await request(endpoint + '/wechat/finish', {state:new URL(duplicate.authorizationUrl).searchParams.get('state'),claim:duplicate.claim,code:'duplicate-code'}, manager, 409);
  const bindingAudit = app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.requestId')=?").get(bound.requestId);
  assert.equal(JSON.parse(bindingAudit.data).subject, staffId);
  assert.ok(!JSON.stringify(login).includes('website-specific-user'));
  assert.ok(!JSON.stringify(app.store.db.prepare("SELECT * FROM identity_bindings WHERE provider='wechat-web'").all()).includes('website-specific-user'));
  t.diagnostic(JSON.stringify({binding: bound.requestId, login: login.requestId, providerCalls, staffId}));
});

test('disabled website OAuth stays hidden and unavailable', async t => {
  const {request} = await fixture(t);
  const config = (await request('/api/config')).data;
  assert.equal(config.staffLogin.wechat, false);
  await request(endpoint + '/wechat/start', {}, null, 503);
});