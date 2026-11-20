'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');
const { openWorkspacePage } = require('./workspace-nav-helper.cjs');

async function run() {
  const evidence = process.env.JY_TRAINING_EVIDENCE || path.resolve(__dirname, '../execution/browser-training');
  fs.mkdirSync(evidence, { recursive: true });
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const requestIds = [];
  const post = async (route, data, token) => {
    const response = await fetch(base + route, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(data),
    });
    const value = await response.json();
    requestIds.push({ route, requestId: value.requestId, status: response.status, via: 'isolated HTTP fixture' });
    assert.ok(response.ok, value.error?.message);
    return value.data;
  };
  const get = async (route, token) => {
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer ' + token } });
    const value = await response.json();
    assert.ok(response.ok, value.error?.message);
    return value.data;
  };
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const manager = await browser.newPage({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    const responseFor = (route, method = 'POST') => manager.waitForResponse(response =>
      new URL(response.url()).pathname === route && response.request().method() === method, { timeout: 12000 });
    const capture = async (route, action) => {
      const pending = responseFor(route);
      await action();
      const response = await pending;
      const value = await response.json();
      requestIds.push({ route, requestId: value.requestId, status: response.status(), via: 'HQ Chrome UI' });
      assert.ok(response.ok(), value.error?.message);
      return value.data;
    };
    await manager.goto(base);
    await manager.locator('select[name="actor"]').selectOption('manager');
    await manager.locator('form[data-command="login"] button[type="submit"]').click();
    await openWorkspacePage(manager, 'training');
    await manager.getByRole('heading', { name: '已有培训记录', exact: true }).waitFor();
    const desk = manager.locator('#training-desk');
    await desk.getByText('新建课程', { exact: true }).click();
    const editor = desk.locator('[data-training-form="course"]');
    await editor.getByRole('textbox', { name: '课程名称' }).fill('培训流程验收 · 隔离课程');
    await editor.getByRole('textbox', { name: '课程内容' }).fill('核对网点业务资料，提交一张遮挡无关信息的图片。');
    const draft = await capture('/api/training/courses', () => editor.getByRole('button', { name: '新建草稿' }).click());
    assert.equal(draft.status, 'draft');
    const course = desk.locator('.record').filter({ has: manager.getByRole('heading', { name: draft.title, exact: true }) });
    const published = await capture('/api/training/courses/' + draft.id, () => course.getByRole('button', { name: '发布课程' }).click());
    assert.equal(published.status, 'published');
    await course.getByText('已发布', { exact: true }).waitFor();
    await manager.screenshot({ path: path.join(evidence, '01-总部发布课程.png'), fullPage: true });

    const partner = (await post('/api/auth/dev', { actor: 'partnerA' })).token;
    const other = (await post('/api/auth/dev', { actor: 'partnerB' })).token;
    assert.equal((await get('/api/training/courses', partner)).items[0].id, published.id);
    const record = await post('/api/training/records', { courseId: published.id, outletId: 'cs', learner: '隔离培训编号-JY01' }, partner);
    const submittedBytes = await sharp({ create: { width: 80, height: 50, channels: 3, background: '#174975' } }).png().toBuffer();
    const material = { name: '隔离培训材料.png', type: 'image/png', base64: submittedBytes.toString('base64') };
    const materialRoute = '/api/training/records/' + record.id + '/materials';
    await post(materialRoute, material, partner);
    const staffId = 'training-review-demo';
    const managerToken = (await post('/api/auth/dev', { actor: 'manager' })).token;
    await post('/api/commands', { command: 'staff.create', payload: {
      subject: staffId, name: '隔离培训审核员', role: 'regional', reason: '培训授权界面验收',
      grants: { outlets: ['cs'], metrics: ['orders'], reviewOutlets: ['cs'] },
    } }, managerToken);
    const regional = (await post('/api/auth/dev', { actor: staffId })).token;
    assert.deepEqual((await get('/api/training/records', regional)).items, []);
    await desk.getByText('配置区域运营的培训审核范围', { exact: true }).click();
    const grantForm = desk.locator('[data-training-form="grant"]');
    await grantForm.locator('[name="staffId"]').fill(staffId);
    await grantForm.locator('[name="outletId"]').selectOption('cs');
    const granted = await capture('/api/training/review-grants', () =>
      grantForm.getByRole('button', { name: '保存培训审核授权' }).click());
    assert.equal(granted.enabled, true);
    assert.equal((await get('/api/training/records', regional)).items[0].id, record.id);

    const filter = desk.locator('[data-training-form="filter"]');
    await filter.locator('[name="outlet"]').selectOption('cs');
    await filter.getByRole('button', { name: '筛选' }).click();
    const learner = desk.locator('[data-training-record="' + record.id + '"]');
    await learner.getByText('资料待审核', { exact: true }).waitFor();
    await learner.getByRole('button', { name: '查看学员资料' }).click();
    await learner.getByText(/第 1 次/).waitFor();
    const downloadPending = manager.waitForEvent('download', { timeout: 12000 });
    await learner.getByRole('button', { name: '下载资料' }).click();
    const downloaded = await downloadPending;
    const stream = await downloaded.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal((await sharp(Buffer.concat(chunks)).metadata()).width, 80);
    await manager.screenshot({ path: path.join(evidence, '02-总部查阅待审材料.png'), fullPage: true });

    const review = learner.locator('[data-training-form="review"]');
    await review.locator('[name="action"]').selectOption('return');
    await review.locator('[name="note"]').fill('请补一张较清晰的培训资料图。');
    const returned = await capture('/api/training/records/' + record.id + '/review', () =>
      review.getByRole('button', { name: '保存处理结果' }).click());
    assert.equal(returned.status, 'returned');
    assert.equal((await get('/api/training/records?outlet=cs', partner)).items[0].note, '请补一张较清晰的培训资料图。');
    await post(materialRoute, material, partner);
    await filter.getByRole('button', { name: '筛选' }).click();
    await learner.getByText('资料待审核', { exact: true }).waitFor();
    await learner.getByRole('button', { name: '查看学员资料' }).click();
    await learner.getByText(/第 2 次/).waitFor();
    await review.locator('[name="note"]').fill('两次资料已核对，资料符合本课程要求。');
    const approved = await capture('/api/training/records/' + record.id + '/review', () =>
      review.getByRole('button', { name: '保存处理结果' }).click());
    assert.equal(approved.status, 'materials_approved');
    await learner.getByText('资料已通过', { exact: true }).waitFor();
    await review.locator('[name="note"]').fill('总部按培训记录确认该学员已经完成本课程。');
    const completed = await capture('/api/training/records/' + record.id + '/review', () =>
      review.getByRole('button', { name: '保存处理结果' }).click());
    assert.equal(completed.status, 'completed');
    const final = (await get('/api/training/records?outlet=cs', partner)).items[0];
    assert.equal(final.status, 'completed');
    assert.equal(final.reviewedBy, undefined);
    assert.deepEqual((await get('/api/training/records', other)).items, []);
    assert.equal(app.store.db.prepare('SELECT count(*) AS count FROM training_materials WHERE record_id=?').get(record.id).count, 2);
    await learner.getByText('培训已完成', { exact: true }).waitFor();
    await manager.screenshot({ path: path.join(evidence, '03-总部确认培训结果.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, '请求与状态.json'), JSON.stringify({
      courseId: draft.id, trainingId: record.id, requestIds,
      observed: ['draft', 'published', 'in_progress', 'submitted', 'returned', 'submitted', 'materials_approved', 'completed'],
    }, null, 2));
    console.log(JSON.stringify({ status: 'passed', headquartersChrome: true, miniSimulator: false, trainingId: record.id, evidence }));
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
