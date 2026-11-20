'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../server/index.cjs');

async function run() {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  let browser;
  try {
    const state = app.store.load();
    for (let i = 0; i < 26; i++) state.supportTickets.push({
      id: 'test-ticket-' + i, owner: 'p1', outlet: 'cs', title: '隔离测试工单 ' + i,
      status: 'queued', severe: true, channel: 'miniprogram', messages: [],
    });
    app.store.transaction(() => app.store.save(state));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const nav = async (key, title) => {
      await page.locator(`.nav [data-page="${key}"]`).click();
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
    };
    const login = async actor => {
      await page.locator('select[name="actor"]').selectOption(actor);
      await page.locator('form[data-command="login"] button[type="submit"]').click();
      await page.locator('.nav').waitFor();
    };
    const status = page.locator('select[name="collectionStatus"]');
    const options = () => status.locator('option').evaluateAll(rows => rows.map(option => option.value));
    const select = page.locator('[name="browseCollection"]');
    const filterBy = async (locator, value, path, query) => {
      const fetchPage = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === '/api/collections/' + path && url.searchParams.has('includeStatusOptions') &&
          Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
      });
      await locator.selectOption(value);
      const response = await fetchPage;
      const body = await response.json();
      assert.ok(response.ok(), body.error?.message);
      assert.ok(body.requestId);
      return body.data;
    };
    const titleBeforeControls = () => page.locator('main').evaluate(main => !!(main.querySelector('h1')
      .compareDocumentPosition(main.querySelector('.list-controls')) & Node.DOCUMENT_POSITION_FOLLOWING));

    await page.goto(base);
    await login('manager');
    assert.equal(await page.locator('.nav-group').count(), 7);
    await nav('stores', '网点管理');
    assert.deepEqual(await options(), ['', 'open', 'paused', 'preparing', 'closed']);
    assert.equal(await titleBeforeControls(), true);
    const none = await filterBy(status, 'preparing', 'outlets', { status: 'preparing' });
    assert.equal(none.total, 0);
    await page.getByText('当前筛选无匹配记录。', { exact: true }).waitFor();

    await nav('requests', '业务申请与审批');
    assert.equal(await titleBeforeControls(), true);
    await page.getByText('暂无业务申请记录。', { exact: true }).waitFor();
    await nav('locations', '位置核验');
    assert.equal(await titleBeforeControls(), true);
    assert.deepEqual(await options(), ['', 'pending', 'approved', 'exception']);
    await filterBy(status, 'exception', 'verifications', { status: 'exception' });
    await page.getByText('当前筛选无匹配记录。', { exact: true }).waitFor();
    await filterBy(select, 'requests', 'requests', { scope: 'location', offset: '0', status: null });
    await page.getByText('暂无位置相关申请记录。', { exact: true }).waitFor();
    assert.deepEqual(await options(), ['', 'pending', 'supplement', 'returned', 'approved']);
    assert.equal(await status.inputValue(), '');

    await nav('support', '客服中心');
    assert.deepEqual(await options(), ['', 'queued', 'active', 'processing', 'waiting', 'closed']);
    await filterBy(status, 'queued', 'support.tickets', { status: 'queued' });
    const pageTwo = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/collections/support.tickets' && url.searchParams.get('offset') === '25';
    });
    await page.getByRole('button', { name: '下一页', exact: true }).first().click();
    assert.ok((await pageTwo).ok());
    await page.getByText('隔离测试工单 0', { exact: true }).waitFor();
    await filterBy(select, 'support.chats', 'support.chats', { offset: '0', status: null });
    await page.getByText('暂无咨询会话。', { exact: true }).waitFor();
    assert.deepEqual(await options(), ['', 'bot', 'queued', 'active', 'processing', 'waiting', 'closed']);
    assert.equal(await status.inputValue(), '');
    assert.equal(await page.getByText('隔离测试工单 0', { exact: true }).count(), 0);

    await nav('billing', '服务费管理');
    assert.ok((await page.locator('.filters').innerText()).includes('全部账期'));
    await page.locator('[data-filter="billingMonth"]').fill('2024-04');
    await page.locator('[data-filter="billingMonth"]').dispatchEvent('change');
    await page.getByText('当前筛选无匹配记录。', { exact: true }).waitFor();

    const more = page.getByText('更多管理', { exact: true });
    assert.equal(await page.locator('.nav [data-page="training"]').isVisible(), false);
    await more.click();
    await nav('audit', '操作审计');
    assert.equal(await status.count(), 0);
    await nav('training', '已有培训记录');
    assert.equal(await page.locator('.nav [data-page="training"]').innerText(), '已有培训记录');
    assert.deepEqual(errors, []);

    await page.getByRole('button', { name: '退出登录' }).click();
    await login('public');
    await page.getByRole('heading', { name: '服务网点', exact: true }).waitFor();
    assert.equal(await page.locator('.nav [data-page="training"]').count(), 0);
    assert.equal(await more.count(), 0);

    await page.getByRole('button', { name: '退出登录' }).click();
    await login('partnerA');
    await nav('reports', '经营月报');
    const reportOutlet = page.locator('select[name="shop"]');
    const reportForm = page.locator('form[data-command="report.submit"]');
    assert.equal(await reportOutlet.inputValue(), '');
    assert.equal(await reportForm.count(), 0);
    await reportOutlet.selectOption('zz');
    await reportForm.waitFor();
    assert.equal(await reportForm.locator('[name="outlet"]').inputValue(), 'zz');
    await reportForm.locator('[name="revenue"]').fill('35.50');
    let releaseReportContext;
    const waitForRelease = new Promise(resolve => { releaseReportContext = resolve; });
    let heldRequest;
    const holdReportContext = async route => {
      heldRequest = route.request();
      await waitForRelease;
      await route.continue();
    };
    await page.route('**/api/reports/context?*', holdReportContext, { times: 1 });
    try {
      const pendingContext = page.waitForRequest(request => {
        const url = new URL(request.url());
        return url.pathname === '/api/reports/context' && url.searchParams.get('outlet') === 'cs';
      });
      await reportOutlet.selectOption('cs');
      await pendingContext;
      const draftOutcome = Promise.race([
        page.waitForRequest(request => request.method() === 'POST' && request.postDataJSON()?.command === 'report.draft')
          .then(() => 'posted'),
        page.locator('#toast').getByText('网点或月份正在切换，请等待所选记录加载。').waitFor()
          .then(() => 'blocked'),
      ]);
      await reportForm.getByRole('button', { name: '保存草稿' }).click();
      assert.equal(await draftOutcome, 'blocked');
      assert.equal(app.store.load().drafts.length, 0);
    } finally {
      releaseReportContext();
      await heldRequest?.response();
    }
    await nav('locations', '位置核验');
    const verification = page.locator('form[data-command="location.submit"]');
    const locationOutlet = verification.locator('[name="outlet"]');
    assert.equal(await locationOutlet.inputValue(), '');
    await locationOutlet.selectOption('cs');
    await verification.getByRole('button', { name: '选择开发模拟坐标' }).click();
    await verification.locator('#photo').setInputFiles({
      name: 'scope-check.png', mimeType: 'image/png',
      buffer: await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer(),
    });
    await verification.locator('#photoLabel').getByText(/已上传/).waitFor();
    await locationOutlet.selectOption('zz');
    assert.equal(await verification.locator('[name="address"]').inputValue(), state.outlets.find(outlet => outlet.id === 'zz').address);
    assert.equal(await verification.locator('#coordsLabel').textContent(), '未选位置');
    assert.equal(await verification.locator('#photoLabel').textContent(), '尚未上传');
    await verification.getByRole('button', { name: '提交核验资料' }).click();
    await verification.getByRole('alert').waitFor();
    assert.equal(app.store.load().verifications.length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS 一期总部 Chrome 集合状态、权限导航、空态、账期、培训兼容入口和多网点写入隔离');
  } finally {
    await browser?.close();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
