'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server/index.cjs');

async function run() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jiuying-browser-contacts-'));
  const screenshots = process.argv[2] && path.resolve(process.argv[2]);
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const app = createServer({ dbPath: path.join(folder, 'contacts.db'), env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    async function request(url, token, payload) {
      const response = await fetch(origin + '/api' + url, {
        method: payload ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(payload
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const json = await response.json();
      assert.equal(response.status, 200, JSON.stringify(json));
      return json;
    }
    const dev = async actor => (await request('/auth/dev', null, { actor })).data.token;
    const manager = await dev('manager');
    const command = (command, payload) => request('/commands', manager, { command, payload });
    const operator = 'test_contact_operator';
    const managerId = 'test_contact_manager';
    const password = 'Contact-' + randomUUID() + '!';
    for (const [subject, name, role] of [[operator, '隔离工作电话经办员', 'ops'], [managerId, '隔离发布管理层', 'manager']]) {
      await command('staff.create', { subject, name, role, reason: '隔离浏览器工作电话验收' });
    }
    for(const actor of [operator, managerId]) {
      const invitation = await request('/auth/activation', manager, { actor });
      await request('/auth/activate', null, { token: invitation.data.token, password });
    }
    const partner = await dev('partnerA');
    const number = '+441632960105';
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: '账号密码', exact: true }).click();
    const login = page.locator('form[data-command="password-login"]');
    await login.locator('[name=username]').fill(managerId);
    await login.locator('[name=password]').fill(password);
    await login.locator('button[type=submit]').click();
    await page.locator('.nav [data-page=team]').click();
    const staff = page.getByRole('row').filter({ hasText: operator });
    await staff.getByRole('button', { name: '工作电话', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const form = dialog.locator('[data-work-contact-editor] form');
    await form.locator('[name=outlet]').fill('cs');
    await form.locator('[name=phone]').fill(number);
    await form.locator('[name=isDefault]').check();
    await form.locator('[name=confirmed]').check();
    async function save() {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/api/work-contacts/manage') && r.request().method() === 'POST'),
        form.getByRole('button', { name: '保存工作电话设置' }).click(),
      ]);
      const json = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(json));
      return json.requestId;
    }
    const published = await save();
    await dialog.getByText('默认联系人 · 已公开', { exact: true }).waitFor();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, '01-已发布工作电话.png') });
    const projected = await request('/work-contacts?outlet=cs', partner);
    assert.deepEqual(projected.data.contact, { phone: number, source: 'default' });
    await form.locator('[name=action]').selectOption('withdraw');
    const withdrawn = await save();
    await dialog.getByText('已撤回', { exact: true }).first().waitFor();
    if (screenshots) await page.screenshot({ path: path.join(screenshots, '02-已撤回工作电话.png') });
    const after = await request('/work-contacts?outlet=cs', partner);
    assert.equal(after.data.contact, null);
    const persisted = app.store.db.prepare("SELECT published,phone FROM work_contacts WHERE staff_id=? AND outlet='cs'").get(operator);
    assert.deepEqual({ ...persisted }, { published: 0, phone: '' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ case: '真实总部Chrome发布与撤回，加盟商隔离HTTP回读', published, projected: projected.requestId,
      withdrawn, after: after.requestId, activatedActor: managerId }));
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(folder, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
