'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const {verifyAudit} = require('../server/maintenance.cjs');
const {runFixture} = require('./approval-export-fixture.cjs');

async function run() {
  const output = path.resolve(process.argv[2] || process.env.LIVE_BROWSER_EVIDENCE || 'execution/approval-export-evidence');
  await fs.mkdir(output, {recursive: true});
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jiuying-approval-export-'));
  async function evidenceFile(name) {
    return path.join(output, name);
  }

  try {
    await runFixture(path.join(tempDir, 'approval-export.db'), async fixture => {
      const {app, base, command, partner, password} = fixture;
      const submitted = await command(partner, 'report.submit', {
        outlet: 'cs', month: '2026-10', revenue: 1000, orders: 20, traffic: 80, enroll: 1, note: '隔离验收，仅业务系统使用',
      });
      await command(partner, 'report.submit', {outlet: 'zz', month: '2026-10', revenue: 2010, orders: 149, traffic: 314, enroll: null});
      const browser = await chromium.launch({channel: 'chrome', headless: true});
      const errors = [];
      try {
        async function enter(username) {
          const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
          page.on('pageerror', error => errors.push(error.message));
          await page.goto(base);
          await page.getByRole('button', {name: '账号密码'}).click();
          const form = page.locator('form[data-command="password-login"]');
          await form.locator('[name=username]').fill(username);
          await form.locator('[name=password]').fill(password);
          await form.getByRole('button', {name: '登录工作空间'}).click();
          await page.locator('.side').waitFor();
          await page.locator('.nav [data-page=approvalExports]').click();
          await page.getByRole('heading', {name: '审批表单导出', exact: true}).waitFor();
          return page;
        }

        const manager = await enter('export_hq_manager');
        await manager.getByRole('button', {name: '新增导出授权', exact: true}).click();
        const editor = manager.getByRole('dialog').locator('form[data-command=approval-export-save]');
        await editor.locator('[name=subject]').fill('export_hq_ops');
        await editor.locator('[name=outlet]').fill('cs');
        await editor.locator('[name=category]').selectOption('reports');
        await editor.locator('[name=fields][value=month]').check();
        await editor.locator('[name=fields][value=orders]').check();
        const [grantResponse] = await Promise.all([
          manager.waitForResponse(r => new URL(r.url()).pathname === '/api/approval-exports/grants' && r.request().method() === 'POST'),
          editor.getByRole('button', {name: '保存导出授权'}).click(),
        ]);
        assert.equal(grantResponse.status(), 200);
        await manager.getByRole('cell', {name: '已授权', exact: true}).waitFor();
        await manager.screenshot({path: await evidenceFile('01-总管理员授权.png'), fullPage: true});

        const ops = await enter('export_hq_ops');
        await ops.getByRole('button', {name: '下载审批表单'}).click();
        const filters = ops.getByRole('dialog').locator('form[data-command=approval-export-file]');
        await filters.locator('[name=month]').fill('2026-10');
        await filters.locator('[name=status]').selectOption('pending');
        assert.equal(await filters.locator('[name=fields]').count(), 2);
        await ops.screenshot({path: await evidenceFile('02-一级管理员限定字段.png'), fullPage: true});
        const [response, download] = await Promise.all([
          ops.waitForResponse(r => new URL(r.url()).pathname === '/api/approval-exports/csv'),
          ops.waitForEvent('download'),
          filters.getByRole('button', {name: '下载 CSV'}).click(),
        ]);
        assert.equal(response.status(), 200);
        const filename = await evidenceFile('03-隔离审批表单.csv');
        await download.saveAs(filename);
        const csv = await fs.readFile(filename);
        assert.equal(csv.toString('utf8').trim(), '"报告月份","有效订单"\r\n"2026-10","20"');
        const exportRequestId = response.headers()['x-request-id'];
        const audit = {grant: grantResponse.headers()['x-request-id'], report: submitted.data.result.id, export: exportRequestId,
          csvSha256: crypto.createHash('sha256').update(csv).digest('hex')};
        const stored = app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.requestId')=?").get(exportRequestId);
        assert.equal(JSON.parse(stored.data).rowCount, 1);

        await manager.getByRole('button', {name: '撤销授权', exact: true}).click();
        const [revokeResponse] = await Promise.all([
          manager.waitForResponse(r => new URL(r.url()).pathname === '/api/approval-exports/grants' && r.request().method() === 'POST'),
          manager.getByRole('dialog').getByRole('button', {name: '确认撤销授权'}).click(),
        ]);
        assert.equal(revokeResponse.status(), 200);
        audit.revoke = revokeResponse.headers()['x-request-id'];
        await ops.getByRole('button', {name: '下载审批表单'}).click();
        await filters.getByRole('button', {name: '下载 CSV'}).click();
        await filters.getByRole('alert').filter({hasText: '没有此网点和表单类型的导出授权'}).waitFor();
        await ops.screenshot({path: await evidenceFile('04-撤销后旧页面下载被拒绝.png'), fullPage: true});
        assert.deepEqual(errors, []);
        assert.equal(verifyAudit(app.store.db).valid, true);
        await fs.writeFile(await evidenceFile('results.json'), JSON.stringify(audit, null, 2));
        console.log('PASS 实际 Chrome 使用个人密码登录，保存授权、下载受限字段、核对审计和撤销后复验', JSON.stringify(audit));
      } finally {
        await browser.close();
      }
    });
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
