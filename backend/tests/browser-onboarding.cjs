'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');

async function run() {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const login = async actor => {
      await page.locator('select[name="actor"]').selectOption(actor);
      await page.locator('form[data-command="login"] button[type="submit"]').click();
      await page.locator('.nav').waitFor();
    };
    const entry = page.locator('.nav [data-page="onboarding"]');
    await page.goto(base);
    await login('ops');
    assert.equal(await entry.count(), 0);
    await page.getByRole('button', { name: '退出登录' }).click();
    await login('manager');
    assert.equal(await entry.count(), 1, '总部管理层应在业务审批下看到加盟申请入口');
    await entry.click();
    await page.getByRole('heading', { name: '加盟申请', exact: true }).waitFor();
    await page.getByText('收款码未启用', { exact: true }).waitFor();

    const image = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#221144' } }).png().toBuffer();
    await page.getByRole('button', { name: '设置企业收款码', exact: true }).click();
    const modal = page.locator('#modal');
    await modal.getByLabel('企业收款方', {exact: true}).fill('隔离验收收款企业');
    await modal.getByLabel('企业收款码图片').setInputFiles({ name: 'isolated-qr.png', mimeType: 'image/png', buffer: image });
    await page.waitForFunction(() => document.querySelector('#modal img')?.naturalWidth === 80);
    await modal.getByRole('checkbox', { name: '我已核对企业收款方和收款码' }).check();
    const configured = page.waitForResponse(response => response.url().endsWith('/api/onboarding/config') && response.request().method() === 'POST');
    await modal.getByRole('button', { name: '保存并启用', exact: true }).click();
    const savedConfig = await configured;
    assert.ok(savedConfig.ok(), JSON.stringify(await savedConfig.json()));
    await page.getByText('隔离验收收款企业', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看企业收款码', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#modal img')?.naturalWidth === 80);
    await modal.getByRole('button', { name: '关闭', exact: true }).click();

    async function send(path, token, payload) {
      const response = await fetch(base + '/api' + path, {
        method: payload ? 'POST' : 'GET',
        headers: {...(token ? {Authorization: 'Bearer ' + token} : {}),
          ...(payload ? {'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()} : {})},
        ...(payload ? {body: JSON.stringify(payload)} : {}),
      });
      const body = await response.json();
      assert.ok(response.ok, JSON.stringify(body));
      return body.data;
    }
    async function apply(name, mobile, color) {
      const visitor = await send('/auth/visitor', null, {});
      const config = await send('/onboarding/config', visitor.token);
      const proof = await sharp({ create: { width: 96, height: 64, channels: 3, background: color } }).png().toBuffer();
      const file = await send('/files', visitor.token, {name: 'isolated-proof.png', type: 'image/png', purpose: 'onboarding-proof', base64: proof.toString('base64')});
      const result = await send('/onboarding/applications', visitor.token, {
        name, mobile, organization: '隔离验收加盟主体', note: '隔离验收申请说明', fileId: file.id, qrFileId: config.qrFileId,
      });
      return {...result, token: visitor.token};
    }
    const application = await apply('隔离验收申请人甲', '13900001234', '#AACCDD');
    const second = await apply('隔离验收申请人乙', '13900005678', '#AADDCC');
    await entry.click();
    const primary = page.getByRole('row').filter({hasText: application.name});
    await primary.getByRole('button', { name: '审核申请' }).click();
    await page.waitForFunction(() => document.querySelector('#modal img')?.naturalWidth === 96);
    await modal.getByText('隔离验收申请说明', { exact: true }).waitFor();
    await modal.getByRole('button', { name: '通过审核' }).click();
    await modal.getByRole('alert').getByText('请确认实际到账，并填写 4 至 100 个字符的到账凭证号。').waitFor();
    await modal.getByLabel('企业到账凭证号').fill('LOCAL-BOOKED-20261121');
    await modal.getByRole('checkbox', { name: '我已核实企业账户实际到账' }).check();
    let firstReviewKey;
    await page.route('**/api/onboarding/applications/' + application.id + '/review', async route => {
      firstReviewKey = route.request().headers()['idempotency-key'];
      const response = await route.fetch();
      if (response.ok()) await route.abort('failed');
      else await route.fulfill({response});
    }, {times: 1});
    await modal.getByRole('button', { name: '通过审核' }).click();
    await modal.getByRole('alert').getByText('网络连接中断。请保留表单并重试。').waitFor();
    const reviewed = page.waitForResponse(response => response.url().includes(application.id + '/review'));
    await modal.getByRole('button', { name: '通过审核' }).click();
    const savedReview = await reviewed;
    assert.ok(savedReview.ok(), JSON.stringify(await savedReview.json()));
    assert.ok(firstReviewKey);
    assert.equal(savedReview.request().headers()['idempotency-key'], firstReviewKey);
    assert.equal(savedReview.request().postDataJSON().version, application.version);
    await modal.getByRole('heading', { name: '加盟申请已通过' }).waitFor();
    await modal.getByRole('button', {name: '签发激活码'}).click();
    await modal.getByRole('heading', { name: '一次性账号激活码' }).waitFor();
    assert.ok(await modal.getByLabel('激活码', {exact: true}).inputValue());
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    const notified = await send('/collections/messages?status=unread', application.token);
    assert.equal(notified.items.filter(item => item.recordId === application.id && item.title === '加盟申请已通过').length, 1);

    await page.getByRole('row').filter({hasText: second.name}).getByRole('button', {name: '审核申请'}).click();
    await modal.getByRole('button', {name: '退回补充'}).click();
    await modal.getByRole('alert').getByText('请填写退回原因。').waitFor();
    await modal.getByLabel('给申请人的审核说明（退回时必填）').fill('请补充包含付款时间的截图。');
    await modal.getByRole('button', {name: '退回补充'}).click();
    await modal.waitFor({state: 'hidden'});
    await page.getByLabel('申请状态').selectOption('returned');
    const returned = page.getByRole('row').filter({hasText: second.name});
    await returned.getByText('已退回', {exact: true}).waitFor();
    await returned.getByRole('button', {name: '查看申请'}).click();
    await modal.getByText('请补充包含付款时间的截图。', {exact:true}).waitFor();
    await modal.getByRole('button', {name: '关闭', exact: true}).click();
    await page.getByRole('button', {name: '停用收款码', exact: true}).click();
    await modal.getByRole('button', {name: '确认停用', exact: true}).click();
    await page.getByText('收款码未启用', {exact:true}).waitFor();
    assert.equal((await send('/onboarding/config', second.token)).enabled, false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
