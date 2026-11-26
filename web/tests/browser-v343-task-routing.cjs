'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { createServer } = require('../server/index.cjs');

async function run() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jiuying-browser-routing-'));
  const screenshotPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (screenshotPath) await mkdir(screenshotPath, { recursive: true });
  const app = createServer({ dbPath: path.join(folder, 'routing.db'), env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    async function openPage() {
      const tab = await browser.newPage({ viewport: { width: 1390, height: 1000 } });
      tab.on('pageerror', error => errors.push(error.message));
      await tab.goto(base);
      return tab;
    }
    const screenshot = async (tab, name) => {
      if (screenshotPath) await tab.screenshot({ path: path.join(screenshotPath, name + '.png'), fullPage: true });
    };
    async function call(url, token, payload, status = 200) {
      const response = await fetch(base + '/api' + url, {
        method: payload ? 'POST' : 'GET',
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body));
      return body;
    }
    const token = (await call('/auth/dev', null, { actor: 'manager' })).data.token;
    const photoBytes = await require('sharp')({ create: { width: 16, height: 12, channels: 3, background: '#247bdd' } }).png().toBuffer();
    const { data: photo } = await call('/files', token, {
      name: 'routing-store.png', type: 'image/png', purpose: 'public-outlet-photo', base64: photoBytes.toString('base64'),
    }, 201);
    await call('/commands', token, { command: 'public.profile', payload: {
      outlet: 'cs', title: '长沙验收网点', address: '长沙验收地址', description: '审批卡本机验收',
      published: true, imageId: photo.id, services: ['咨询'], reason: '浏览器隔离验收',
    } });
    const password = 'Routing-Local-' + randomUUID() + '!';
    for (const [subject, role, name] of [['web_route_manager', 'manager', '验收管理层'], ['web_route_ops', 'ops', '长沙验收运营'], ['web_route_peer', 'ops', '同岗位验收人员']]) {
      await call('/commands', token, { command: 'staff.create', payload: { subject, name, role, reason: '浏览器隔离验收' } });
      const { data: issued } = await call('/auth/activation', token, { actor: subject, username: subject });
      await call('/auth/activate', null, { token: issued.token, password });
    }
    await call('/commands', token, { command: 'staff.create', payload: {
      subject: 'web_route_pending', name: '待激活运营', role: 'ops', reason: '浏览器隔离验收未激活权限'
    } });
    const manager = await openPage();
    const ops = await openPage();
    const peer = await openPage();
    async function login(tab, username) {
      await tab.getByRole('button', { name: '账号密码' }).click();
      const form = tab.locator('form[data-command="password-login"]');
      await form.locator('[name="username"]').fill(username);
      await form.locator('[name="password"]').fill(password);
      const [response] = await Promise.all([
        tab.waitForResponse(item => item.url().endsWith('/api/auth/password')),
        form.locator('button[type="submit"]').click(),
      ]);
      assert.equal(response.status(), 200);
      await tab.locator('.side').waitFor();
    }
    await login(manager, 'web_route_manager');
    await login(ops, 'web_route_ops');
    await login(peer, 'web_route_peer');
    await manager.locator('.nav [data-page="team"]').click();
    await manager.getByRole('button', { name: '自动分派', exact: true }).click();
    await manager.getByRole('button', { name: '配置自动分派', exact: true }).click();
    const rule = manager.locator('form[data-command="routing.set"]');
    assert.equal(await rule.locator('#list-assigneeUserId option[value="web_route_pending"]').count(), 0);
    assert.equal(await rule.locator('#list-assigneeUserId option[value="web_route_ops"]').count(), 1);
    await rule.locator('[name="outlet"]').fill('cs');
    await rule.locator('[name="routeStage"]').selectOption('report_review|ops');
    await rule.locator('[name="assigneeUserId"]').fill('web_route_ops');
    await rule.locator('[name="reason"]').fill('长沙月报指定运营办理');
    const [created] = await Promise.all([
      manager.waitForResponse(response => response.url().endsWith('/api/commands')
        && response.request().postDataJSON()?.command === 'routing.set'),
      rule.locator('button[type="submit"]').click(),
    ]);
    assert.equal(created.status(), 200);
    await manager.getByRole('cell', { name: '月报运营审核', exact: true }).waitFor();
    await screenshot(manager, '01-总部管理层规则');
    const partner = (await call('/auth/dev', null, { actor: 'partnerA' })).data.token;
    const submitted = await call('/commands', partner, { command: 'report.submit', payload: {
      outlet: 'cs', month: '2026-10', revenue: 1000, orders: 20, traffic: 80, enroll: 1, note: '业务回归验收',
    } });
    await peer.locator('.nav [data-page="reports"]').click();
    const assignedElsewhere = peer.locator('.record').filter({ hasText: '业务回归验收' });
    await assignedElsewhere.waitFor();
    await screenshot(peer, '04-同岗位通用列表');
    assert.equal(await assignedElsewhere.locator('form[data-command="review.report"]').count(), 0, 'Assigned report must not offer a review form to another operator');
    await assignedElsewhere.getByText('此事项已分派，当前账号可查看进度。', { exact: true }).waitFor();
    await ops.goto(base + '/#queue=ops&kind=report_review');
    await ops.getByText('由规则分派', { exact: true }).waitFor();
    await screenshot(ops, '02-本人指定月报队列');
    await ops.getByRole('link', { name: '查看业务', exact: true }).click();
    const approve = ops.locator('form[data-command="review.report"]');
    await ops.locator('.focused-business .report-record-icon img').waitFor();
    await ops.locator('.report-record-context .pair').filter({hasText:'提交人'}).getByText('示范负责人甲',{exact:true}).waitFor();
    await ops.getByText('营业收入较上月（2026-09）', {exact:true}).waitFor();
    await ops.getByText('-90%', {exact:true}).waitFor();
    const [approved] = await Promise.all([
      ops.waitForResponse(response => response.url().endsWith('/api/commands')
        && response.request().postDataJSON()?.command === 'review.report'),
      approve.getByRole('button',{name:'审核通过',exact:true}).click(),
    ]);
    assert.equal(approved.status(), 200);
    const finished = (await approved.json()).data.result;
    assert.equal(finished.id, submitted.data.result.id);
    assert.equal(finished.status, 'approved');
    assert.equal(app.store.db.prepare('SELECT status FROM reports WHERE id=?').get(finished.id).status, 'approved');
    await screenshot(ops, '03-运营正常网页审批');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      status: 'passed', test: 'Chrome manager configures a rule and personal operations reviews next report',
      ruleRequestId: created.headers()['x-request-id'], submitRequestId: submitted.requestId,
      approveRequestId: approved.headers()['x-request-id'], reportId: finished.id,
    }));
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(folder, { force: true, recursive: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
