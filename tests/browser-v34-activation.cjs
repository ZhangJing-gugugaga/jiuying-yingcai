'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../server/index.cjs');

async function run() {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const manager = await browser.newPage();
    await manager.goto(base);
    await manager.locator('select[name="actor"]').selectOption('manager');
    await manager.locator('form[data-command="login"] button[type="submit"]').click();
    await manager.locator('.nav [data-page="accounts"]').click();
    const creation = manager.locator('form[data-command="account.create"]');
    await creation.locator('[name="name"]').fill('V3.4 脱敏账号验收加盟商');
    await creation.locator('[name="managerName"]').fill('V3.4 测试负责人');
    await creation.locator('[name="mobile"]').fill('13900000341');
    const addResponse = manager.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().postDataJSON()?.command === 'account.create');
    await creation.locator('button[type="submit"]').click();
    const created = await addResponse;
    assert.equal(created.status(), 200);

    const account = manager.locator('.panel').filter({ has: manager.getByRole('heading', { name: 'V3.4 测试负责人', exact: true }) });
    await manager.waitForLoadState('networkidle');
    await account.waitFor({ timeout: 8000 });
    const [issued] = await Promise.all([
      manager.waitForResponse(response => response.url().endsWith('/api/auth/activation') && response.request().method() === 'POST', { timeout: 8000 }),
      account.getByRole('button', { name: '签发激活码' }).dispatchEvent('click'),
    ]);
    assert.equal(issued.status(), 200);
    const dialog = manager.getByRole('dialog');
    const code = await dialog.locator('[name="activationToken"]').inputValue();
    const loginName = dialog.locator('.pair').filter({ has: manager.getByText('登录账号', { exact: true }) });
    assert.equal(await loginName.count(), 1, 'activation dialog must provide the login account through the normal HQ interface');
    const username = await loginName.locator('b').innerText();
    assert.match(username, /^partner:p-[a-f0-9-]{36}$/);
    assert.match(await dialog.innerText(), /可信渠道.{0,26}登录账号和激活码/);
    assert.ok(code.length > 10);
    await dialog.getByRole('button', { name: '关闭' }).click();

    const password = 'Local-Identity-C34-12345!';
    const user = await browser.newPage();
    await user.goto(base);
    await user.getByRole('button', { name: '首次激活' }).click();
    const activation = user.locator('form[data-command="activate"]');
    await activation.locator('[name="token"]').fill(code);
    await activation.locator('[name="password"]').fill(password);
    await activation.locator('[name="confirmPassword"]').fill(password);
    const activateResponse = user.waitForResponse(response => response.url().endsWith('/api/auth/activate'));
    await activation.locator('button[type="submit"]').click();
    const activated = await activateResponse;
    assert.equal(activated.status(), 200);
    await user.locator('.side').waitFor();

    const secondDevice = await browser.newPage();
    await secondDevice.goto(base);
    await secondDevice.getByRole('button', { name: '账号密码' }).click();
    const login = secondDevice.locator('form[data-command="password-login"]');
    await login.locator('[name="username"]').fill(username);
    await login.locator('[name="password"]').fill(password);
    const loginResponse = secondDevice.waitForResponse(response => response.url().endsWith('/api/auth/password'));
    await login.locator('button[type="submit"]').click();
    const authorized = await loginResponse;
    assert.equal(authorized.status(), 200);
    await secondDevice.locator('.side').waitFor();
    for (const response of [created, issued, activated, authorized]) assert.ok(response.headers()['x-request-id']);
    console.log('PASS Chrome UI: HQ created account and showed published login details via its browser action; account holder activated and signed in through Web forms. Request IDs:', [created, issued, activated, authorized].map(response => response.headers()['x-request-id']).join(' '));
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
