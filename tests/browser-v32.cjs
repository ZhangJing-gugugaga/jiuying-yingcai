'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { createServer } = require('../server/index.cjs');

const output = path.resolve(__dirname, '../execution/browser-v32');
const report = { outlet: 'cs', month: '2026-10', revenue: '3210.50', orders: '8', traffic: '16', enroll: '2', note: 'V3.2 浏览器月报' };

async function verify() {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  const evidence = [];
  const errors = [];
  const startedAt = new Date().toISOString();
  let failure;
  const pass = (id, detail) => {
    evidence.push({ id, detail });
    console.log('PASS', id, detail);
  };
  let browser;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + app.server.address().port;
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    const screenshot = name => page.screenshot({ path: path.join(output, name), fullPage: true });
    const login = async (actor, location = '') => {
      await page.goto(url);
      await page.locator('.side, form[data-command="login"]').first().waitFor();
      if (await page.locator('[data-action="logout"]').count()) await page.locator('[data-action="logout"]').click();
      if (location) await page.goto(url + location);
      await page.locator('select[name="actor"]').selectOption(actor);
      await page.locator('form[data-command="login"] button[type="submit"]').click();
      await page.locator('.side').waitFor();
    };
    const token = async actor => {
      const reply = await page.request.post(url + '/api/auth/dev', { data: { actor } });
      assert.equal(reply.status(), 200);
      return (await reply.json()).data.token;
    };
    const command = async (auth, name, payload) => {
      const reply = await page.request.post(url + '/api/commands', {
        headers: { Authorization: 'Bearer ' + auth, 'Idempotency-Key': randomUUID() },
        data: { command: name, payload }
      });
      assert.equal(reply.status(), 200, await reply.text());
      return (await reply.json()).data.result;
    };
    const jump = queue => page.locator('.task-card[data-queue="' + queue + '"]').click();
    const queuePage = queue => page.locator('.task-queue[data-queue="' + queue + '"]');
    const cardTotal = queue => page.locator('.task-card[data-queue="' + queue + '"] .task-count');
    const submit = async (name, fields, selects = {}) => {
      const form = page.locator('form[data-command="' + name + '"]');
      for (const [field, value] of Object.entries(selects)) await form.locator('[name="' + field + '"]').selectOption(value);
      for (const [field, value] of Object.entries(fields)) await form.locator('[name="' + field + '"]').fill(value);
      await form.locator('button[type="submit"]').click();
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    };

    const dashboards = [];
    page.on('request', r => {
      const uri = new URL(r.url());
      if (uri.pathname === '/api/dashboard') dashboards.push(uri.search);
    });
    const overviewStarted = performance.now();
    await login('manager');
    const overviewMs = Math.round(performance.now() - overviewStarted);
    assert.equal(await page.locator('.task-card').count(), 4, 'management overview must expose four server-backed queue cards');
    for (const queue of ['ops', 'finance', 'partner', 'hq']) assert.equal(await cardTotal(queue).textContent(), '0');
    assert.equal(dashboards.length, 6, 'monthly overview requests only the six distinct chart periods');
    assert.equal(new Set(dashboards.map(query => new URLSearchParams(query).get('period'))).size, 6);
    await screenshot('01-overview.png');
    for (const queue of ['ops', 'finance', 'partner', 'hq']) {
      await jump(queue);
      await queuePage(queue).waitFor();
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('queue'), queue);
      assert.match(await queuePage(queue).innerText(), /暂无符合条件的待办/);
      await page.goBack();
      await cardTotal(queue).waitFor();
    }
    pass('HQ32-01/03/11', '四个零待办和各自深链可返回，月度主页发送六个互不重复的经营查询。隔离示范数据登录至页面渲染 ' + overviewMs + ' ms');

    const partner = await token('partnerA');
    const ops = await token('ops');
    const v1 = await command(partner, 'report.submit', report);
    await page.reload();
    assert.equal(await cardTotal('ops').textContent(), '1');
    await jump('ops');
    await queuePage('ops').waitFor();
    await queuePage('ops').getByRole('link', { name: '查看业务' }).click();
    const exact = page.locator('.focused-business');
    await exact.waitFor();
    const opsDetail = new URL(page.url()).hash;
    assert.match(await exact.innerText(), /V1/);
    const timeline = exact.locator('.approval-history');
    await timeline.getByText('提交月报', { exact: true }).first().waitFor();
    await timeline.locator('summary').first().click();
    const raw = timeline.locator('details[open] pre').first();
    assert.equal(JSON.parse(await raw.textContent()).action, 'report.submit');
    await screenshot('02-approval-history.png');
    await page.goBack();
    await queuePage('ops').waitFor();
    await page.reload();
    await queuePage('ops').waitFor();
    assert.equal(await queuePage('ops').getByText('待配置', { exact: true }).count(), 1);
    await screenshot('03-operations-queue.png');
    pass('HQ32-05/06/07', '当前月报任务打开精确记录，时间轴展开只读源审计，无截止配置显示待配置');

    await command(ops, 'review.report', { id: v1.id, decision: 'return', note: '请补齐订单核对资料' });
    await page.goto(url);
    assert.equal(await cardTotal('ops').textContent(), '0');
    assert.equal(await cardTotal('partner').textContent(), '1');
    await login('partnerA', '#queue=partner');
    await queuePage('partner').waitFor();
    assert.match(await queuePage('partner').innerText(), /长沙/);
    await queuePage('partner').getByRole('link', { name: '查看业务' }).click();
    await exact.locator('.approval-history').getByText('审核月报', { exact: true }).waitFor();
    assert.equal(await exact.getByRole('button', { name: '修改并重新报送' }).count(), 1);
    await exact.getByText('查看原始审计', { exact: true }).first().click();
    const ownerAudit = JSON.parse(await exact.locator('details[open] pre').first().textContent());
    assert.equal(ownerAudit.actorId, null);
    assert.equal(ownerAudit.requestId, null);
    assert.equal(ownerAudit.note, '请补齐订单核对资料');
    await login('partnerB', '#queue=partner');
    assert.match(await queuePage('partner').innerText(), /暂无符合条件的待办/);
    for (const actor of ['partnerA', 'finance', 'support', 'location', 'regional']) {
      await login(actor, '#queue=ops');
      assert.match(await queuePage('ops').innerText(), /当前账号无权查看此待办队列/);
      assert.equal(await queuePage('ops').locator('tbody tr').count(), 0);
    }
    await login('support', opsDetail);
    assert.match(await exact.innerText(), /当前账号没有访问权限/);
    assert.equal(await exact.locator('.approval-history').count(), 0);
    pass('HQ32-03/08/09', '退回后转入加盟商队列，另一主体为空，五种未授权账号直接访问运营队列被拒绝');

    const v2 = await command(partner, 'report.submit', { ...report, orders: '9' });
    await command(ops, 'review.report', { id: v2.id, decision: 'approve', note: '总部内部订单核对结论' });
    const manager = await token('manager');
    await login('manager', '#queue=ops&status=resolved');
    const reviewed = queuePage('ops').getByRole('link', { name: '查看业务' }).first();
    await reviewed.click();
    const versionEvents = exact.locator('.approval-history .timeline > li');
    await versionEvents.nth(3).waitFor();
    const recorded = [];
    for (const event of await versionEvents.all()) {
      await event.getByText('查看原始审计', { exact: true }).click();
      const data = JSON.parse(await event.locator('pre').textContent());
      recorded.push([data.version, data.action, data.after.status]);
    }
    assert.deepEqual(recorded, [[2, 'review.report', 'approved'], [2, 'report.submit', 'pending'], [1, 'review.report', 'returned'], [1, 'report.submit', 'pending']]);
    await screenshot('05-version-lineage.png');
    pass('HQ32-06/08', '同月版本在时间轴中展示真实提交、退回、重提、通过顺序，加盟商的原始审计不含内部账号和请求编号');

    await login('manager', '#queue=hq');
    await page.getByRole('button', { name: '创建补充待办' }).click();
    await submit('task.create', { businessId: 'cs', title: '核查已登记经营资料', note: '存在需要落实的总部核查事项', dueAt: '2026-10-12T16:30' }, { businessType: 'outlets' });
    const item = queuePage('hq').getByRole('row').filter({ hasText: '核查已登记经营资料' });
    await item.waitFor();
    assert.match(await item.innerText(), /2026\/10\/12 16:30:00/);
    assert.match(await item.innerText(), /已超期/);
    await item.getByRole('button', { name: '分派 / 转派' }).click();
    await submit('task.assign', { note: '交由总部运营跟进' }, { assigneeRole: 'ops' });
    await item.getByRole('button', { name: '分派 / 转派' }).click();
    await submit('task.assign', { note: '改由总部财务核对经营资料' }, { assigneeRole: 'finance' });
    await login('ops', '#queue=hq');
    assert.equal(await item.count(), 0);
    await login('finance', '#queue=hq');
    await item.waitFor();
    await item.getByRole('button', { name: '完成待办' }).click();
    await submit('task.complete', { note: '核查已完成并登记结论' });
    await item.waitFor({ state: 'hidden' });
    await login('manager', '#queue=hq&status=resolved');
    await item.waitFor();
    await item.getByRole('button', { name: '待办详情' }).click();
    await page.locator('dialog[open]').waitFor();
    assert.match(await page.locator('dialog').innerText(), /交由总部运营跟进/);
    assert.match(await page.locator('dialog').innerText(), /改由总部财务核对经营资料/);
    await screenshot('04-task-assignment-history.png');
    pass('HQ32-04/05', '管理层创建已有截止时刻的任务并转派，原岗位无法继续，财务完成后保留分派历史');

    const outlets = Array.from({ length: 26 }, (_, index) => ({
      owner: 'p1', name: 'V3.2分页网点' + (index + 1), province: '湖南', city: '长沙', district: '芙蓉',
      address: '隔离浏览器分页测试地址', phone: '0731-00000000', opening: '2026-10-10',
      enrollmentApplicable: false, status: 'open'
    }));
    const preview = await command(manager, 'import.preview', { kind: 'outlets', rows: outlets, reason: '隔离浏览器分页验证数据' });
    assert.equal(preview.errorCount, 0);
    const imported = await command(manager, 'import.commit', { id: preview.id });
    for (const [index, businessId] of imported.createdIds.entries()) {
      await command(manager, 'task.create', { businessType: 'outlets', businessId, title: '分页验证事项' + (index + 1), note: '隔离浏览器分页验证' });
    }
    await login('manager', '#queue=hq&businessType=outlets');
    const rows = queuePage('hq').locator('tbody tr');
    await rows.nth(24).waitFor();
    const firstPage = await rows.allTextContents();
    await queuePage('hq').getByRole('link', { name: '下一页' }).click();
    await queuePage('hq').getByText('共 26 项 · 26–26', { exact: true }).waitFor();
    assert.equal(await rows.count(), 1);
    assert.equal(new Set(firstPage).size, 25);
    assert.equal(firstPage.includes(await rows.first().textContent()), false);
    await rows.first().getByRole('link', { name: '查看业务' }).click();
    await exact.waitFor();
    await page.goBack();
    await queuePage('hq').getByText('共 26 项 · 26–26', { exact: true }).waitFor();
    await page.reload();
    assert.equal(await page.locator('select[name="taskBusiness"]').inputValue(), 'outlets');
    assert.match(new URL(page.url()).hash, /offset=25/);
    await screenshot('06-filtered-pagination.png');
    const abortOnce = async route => route.abort('failed');
    await page.route(url + '/api/tasks?**', abortOnce, { times: 1 });
    await queuePage('hq').getByRole('link', { name: '上一页' }).click();
    await queuePage('hq').getByRole('alert').waitFor();
    await queuePage('hq').getByRole('button', { name: '重试' }).click();
    await rows.nth(24).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await screenshot('08-mobile-queue.png');
    await page.setViewportSize({ width: 1440, height: 1024 });
    pass('HQ32-03/12', '26 条持久待办跨页无重复，查看业务后返回和刷新保留筛选与页码，网络失败支持重试');

    const finance = await token('finance');
    const pauseFee = await command(partner, 'request.submit', { type: 'pauseFee', outlet: 'cs',
      data: { from: '2026-11-23', to: '2026-11-27', reason: '浏览器核算流程测试申请' } });
    await command(finance, 'review.request', { id: pauseFee.id, decision: 'approve', note: '确认停费申请进入人工核算' });
    await login('ops', '#queue=hq&kind=fee_calculation');
    await queuePage('hq').getByRole('link', { name: '查看业务' }).click();
    await exact.getByRole('button', { name: '提出费用调整' }).click();
    const proposal = page.locator('form[data-command="fee.adjust.propose"]');
    assert.match(await proposal.locator('[name="adjustmentId"]').inputValue(), /^adj-/);
    await submit('fee.adjust.propose', { amount: '70.50', offsetMonth: '2026-12', reason: '核实后采用明确抵扣金额' });

    await login('finance', '#queue=finance&kind=fee_proposal_review');
    await queuePage('finance').getByRole('link', { name: '查看业务' }).click();
    await exact.getByRole('button', { name: '复核处理' }).click();
    await submit('fee.adjust.review', { note: '已独立核对抵扣金额和抵扣月份' });
    await exact.locator('.approval-history').getByText('复核服务费核算', { exact: true }).waitFor();
    await page.goBack();
    await queuePage('finance').getByText('暂无符合条件的待办。', { exact: true }).waitFor();
    await screenshot('07-finance-queue-complete.png');
    assert.deepEqual(errors, []);
    pass('HQ32-02/03/06', '停费批准后从总部分派队列办理人工核算，再从财务队列打开同一提案独立复核，审批历史同步更新');

    const support = await token('support');
    const ticket = await command(partner, 'support.ticket', {
      outlet: 'cs', category: 'complaint', title: '浏览器升级联动工单', description: '需要总部登记处理结论'
    });
    await command(support, 'support.claim', { id: ticket.id });
    await command(support, 'support.escalate', { id: ticket.id, reason: '浏览器升级处理测试' });
    await login('manager', '#queue=hq&kind=support_management');
    await queuePage('hq').getByRole('link', { name: '查看业务' }).click();
    await exact.getByText('浏览器升级联动工单', { exact: true }).waitFor();
    await submit('support.management', { note: '管理层已登记实际调查结论' });
    await exact.locator('.approval-history').getByText('管理层处理', { exact: true }).waitFor();
    await page.goBack();
    await queuePage('hq').getByText('暂无符合条件的待办。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    pass('HQ32-04/06', '客服升级工单进入管理层补充队列，点击进入原工单登记结论，待办结束并保留处理时间轴');
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      status: failure ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), evidence, pageErrors: errors,
      ...(failure ? { failure } : {})
    }, null, 2));
    if (browser) await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

fs.mkdirSync(output, { recursive: true });
verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
