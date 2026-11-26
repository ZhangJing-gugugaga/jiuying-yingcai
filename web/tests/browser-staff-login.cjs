'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require('playwright');
const {createServer} = require('../server/index.cjs');

async function run() {
  const webAppId = 'wx0000000000000001';
  const origin = 'https://hq-acceptance.example.invalid';
  const managerId = 'hq-web-qa-manager';
  const staffId = 'hq-web-qa-operator';
  const mobile = '13910000125';
  const password = 'qa-isolated-password-125!';
  const evidence = {accounts: [], requests: [], provider: {smsAccepted:0, wechatExchanges:0}};
  const used = new Set();
  let receivedCode;
  const app = createServer({
    dbPath: ':memory:',
    env: {
      NODE_ENV:'test', ADAPTER_MODE:'mock', PUBLIC_ORIGIN:origin,
      WECHAT_WEB_AUTH_ENABLED:'1', WECHAT_WEB_APP_ID:webAppId, WECHAT_WEB_APP_SECRET:'fixture-only-website',
      SMS_PROVIDER:'tencent', SMS_SECRET_ID:'fixture', SMS_SECRET_KEY:'fixture-key',
      SMS_SDK_APP_ID:'fixture-app', SMS_TEMPLATE_ID:'fixture-template', SMS_SIGN_NAME:'fixture-sign',
    },
    integrationFetch: async (input, options) => {
      const url = new URL(input);
      if (url.origin === 'https://sms.tencentcloudapi.com') {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.PhoneNumberSet, ['+86' + mobile]);
        assert.match(options.headers.Authorization, /^TC3-HMAC-SHA256 /);
        receivedCode = body.TemplateParamSet[0];
        assert.match(receivedCode, /^\d{6}$/);
        evidence.provider.smsAccepted++;
        return Response.json({Response:{SendStatusSet:[{Code:'Ok'}]}});
      }
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(url.pathname, '/sns/oauth2/access_token');
      assert.equal(url.searchParams.get('appid'), webAppId);
      const code = url.searchParams.get('code');
      assert.ok(['local-bind-result', 'local-login-result'].includes(code));
      assert.ok(!used.has(code));
      used.add(code);
      evidence.provider.wechatExchanges++;
      return Response.json({openid:'local-hq-qa-website-openid', access_token:'fixture-external-boundary'});
    },
  });
  const assertRequest = (response, step, status = 200) => {
    assert.equal(response.status(), status, step);
    const requestId = response.headers()['x-request-id'];
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    evidence.requests.push({step, status, requestId});
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let browser;
  async function setupRequest(path, body, token) {
    const response = await fetch(base + '/api' + path, {
      method:'POST', headers:{'Content-Type':'application/json', 'Idempotency-Key':randomUUID(), ...(token?{Authorization:'Bearer '+token}:{})},
      body:JSON.stringify(body),
    });
    const reply = await response.json();
    assert.equal(response.status, 200, reply.error?.message);
    return reply.data;
  }
  try {
    const dev = (await setupRequest('/auth/dev', {actor:'manager'})).token;
    for (const [subject, role] of [[managerId,'manager'], [staffId,'ops']]) {
      await setupRequest('/commands', {command:'staff.create', payload:{subject, name:subject, role, reason:'总部登录浏览器验收'}}, dev);
      const invitation = await setupRequest('/auth/activation', {actor:subject}, dev);
      const activated = await setupRequest('/auth/activate', {token:invitation.token, password}, null);
      assert.equal(activated.subject, subject);
      evidence.accounts.push({subject, role});
    }
    browser = await chromium.launch({channel:'chrome', headless:true});
    const manager = await browser.newPage();
    await manager.goto(base);
    await manager.getByRole('button', {name:'账号密码', exact:true}).click();
    let form = manager.locator('form[data-command="password-login"]');
    await form.locator('[name=username]').fill(managerId);
    await form.locator('[name=password]').fill(password);
    const managerLogin = manager.waitForResponse(r => r.url().endsWith('/api/auth/password'));
    await form.getByRole('button', {name:'登录工作空间'}).click();
    assertRequest(await managerLogin, 'manager-password-login');
    await manager.locator('.nav [data-page=team]').click();
    const staff = manager.locator('tr', {hasText:staffId});
    await staff.getByRole('button', {name:'登记登录手机号'}).click();
    const registration = manager.getByRole('dialog').locator('form[data-command="staff-mobile-configure"]');
    await registration.locator('[name=mobile]').fill(mobile);
    await registration.locator('[name=password]').fill(password);
    const registrationResponse = manager.waitForResponse(r => r.url().endsWith('/api/auth/staff/mobile'));
    await registration.getByRole('button', {name:'确认更新'}).click();
    assertRequest(await registrationResponse, 'register-staff-mobile');
    await manager.getByRole('heading', {name:'已核对登录手机号'}).waitFor();
    assert.match(await manager.getByRole('dialog').innerText(), /139\*{4}0125/);

    const user = await browser.newPage();
    const errors = [];
    user.on('pageerror', err => errors.push(err.message));
    await user.goto(base);
    await user.getByRole('button', {name:'总部手机验证码', exact:true}).click();
    form = user.locator('form[data-command=staff-sms-login]');
    await form.locator('[name=mobile]').fill(mobile);
    const requested = user.waitForResponse(r => r.url().endsWith('/api/auth/staff/sms/send'));
    await form.getByRole('button', {name:'获取短信验证码'}).click();
    const smsResponse = await requested;
    assertRequest(smsResponse, 'request-staff-sms');
    const smsData = (await smsResponse.json()).data;
    assert.equal(smsData.devCode, undefined);
    assert.match(receivedCode, /^\d{6}$/);
    await form.locator('[name=code]').fill(receivedCode);
    const verified = user.waitForResponse(r => r.url().endsWith('/api/auth/staff/sms/verify'));
    await form.getByRole('button', {name:'验证并登录'}).click();
    const result = await verified;
    assertRequest(result, 'verify-staff-sms');
    assert.equal((await result.json()).data.subject, staffId);
    await user.locator('.nav').waitFor();
    assert.equal(await user.locator('.nav [data-page=team]').count(), 0);
    await user.getByRole('button', {name:'登录安全'}).click();
    await user.getByRole('heading', {name:'个人登录安全'}).waitFor();

    let nextCode = 'local-bind-result';
    await user.route('https://open.weixin.qq.com/connect/qrconnect?**', route => {
      const providerUrl = new URL(route.request().url());
      assert.equal(providerUrl.searchParams.get('redirect_uri'), origin + '/');
      const callback = new URL(base);
      callback.search = new URLSearchParams({state: providerUrl.searchParams.get('state'), code: nextCode}).toString();
      return route.fulfill({status:302, headers:{location:callback.href}});
    });
    let wxForm = user.locator('form[data-command=staff-wechat-bind]');
    await wxForm.locator('[name=password]').fill(password);
    const bound = user.waitForResponse(r => r.url().endsWith('/api/auth/staff/wechat/finish'));
    await wxForm.getByRole('button', {name:'绑定扫码登录微信'}).click();
    assertRequest(await bound, 'bind-wechat-callback');
    await user.getByText('微信绑定成功。下次可扫码登录。', {exact:true}).waitFor();
    assert.ok(!new URL(user.url()).searchParams.has('code'));
    await user.getByRole('button', {name:'退出登录'}).click();

    nextCode = 'local-login-result';
    await user.getByRole('button', {name:'总部微信扫码', exact:true}).click();
    wxForm = user.locator('form[data-command=staff-wechat-start]');
    const logged = user.waitForResponse(r => r.url().endsWith('/api/auth/staff/wechat/finish'));
    await wxForm.getByRole('button', {name:'打开微信扫码登录'}).click();
    const login = await logged;
    assertRequest(login, 'sign-in-wechat-callback');
    assert.equal((await login.json()).data.role, 'ops');
    await user.locator('.nav').waitFor();
    assert.deepEqual(evidence.provider, {smsAccepted:1, wechatExchanges:2});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(evidence));
    console.log('PASS Chrome Web UI and real isolated SQLite/API. WeChat and Tencent SMS provider responses were isolated.');
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});