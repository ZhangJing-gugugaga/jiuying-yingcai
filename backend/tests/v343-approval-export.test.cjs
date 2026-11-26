'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {verifyAudit} = require('../server/maintenance.cjs');
const {runFixture} = require('./approval-export-fixture.cjs');

const report = {outlet: 'cs', month: '2026-10', revenue: 1000, orders: 20, traffic: 80, enroll: 1, note: '不得出现在表中的说明'};
const grant = {subject: 'export_hq_ops', outlet: 'cs', category: 'reports', fields: ['outletName', 'month', 'orders'], enabled: true};
const grants = '/approval-exports/grants';
const csv = '/approval-exports/csv?category=reports&outlet=cs';

test('authorized monthly export is confined to selected outlet, fields, named task and sealed audit', t => runFixture(':memory:', async f => {
  const {request, command, manager, ops, peer, partner, app} = f;
  await request(grants, ops, grant, 403);
  await request(grants, manager, {...grant, fields: ['note']}, 400);
  await request(csv, ops, null, 403);
  const saved = await request(grants, manager, grant);
  const noChange = await request(grants, manager, grant);
  assert.deepEqual(noChange.data, saved.data);
  await command(manager, 'routing.set', {outlet: 'cs', kind: 'report_review', assigneeRole: 'ops', assigneeUserId: 'export_hq_ops', enabled: true, reason: '验收同岗办理边界'});
  const record = await command(partner, 'report.submit', report);
  await command(partner, 'report.submit', {...report, outlet: 'zz', enroll: null, orders: 974});
  await request(csv + '&fields=orders,revenue', ops, null, 403);
  await request(csv.replace('outlet=cs','outlet=zz'), ops, null, 403);
  await request(csv, partner, null, 403);
  await request(grants, manager, {...grant, subject: 'export_hq_peer'});
  const hidden = await request(csv + '&status=pending&month=2026-10', peer);
  assert.equal(hidden.csv.trim().split(/\r?\n/).length, 1);
  const result = await request(csv + '&status=pending&month=2026-10&fields=orders,month', ops);
  assert.equal(result.csv.trim(), '"有效订单","报告月份"\r\n"20","2026-10"');
  assert.ok(!result.csv.includes('974'));
  assert.ok(!result.csv.includes('不得出现在'));
  const audit = app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.requestId')=?").get(result.requestId);
  const parsed = JSON.parse(audit.data);
  assert.equal(parsed.subject, 'export_hq_ops');
  assert.equal(parsed.command, 'approval.export.generated');
  assert.equal(parsed.rowCount, 1);
  assert.deepEqual(parsed.scope.fields, ['orders', 'month']);
  assert.equal(parsed.scope.outlet, 'cs');
  assert.equal(verifyAudit(app.store.db).valid, true);
  await request(grants, manager, {...grant, enabled: false, fields: []});
  await request(csv, ops, null, 403);
  t.diagnostic(JSON.stringify({grantRequestId: saved.requestId, reportId: record.data.result.id, exportRequestId: result.requestId, auditId: parsed.id}));
}));

test('regional grant respects approval outlet and metric grants and remains closed after role change', () => runFixture(':memory:', async f => {
  const {request, command, personal, manager, partner} = f;
  const regional = await personal('export_regional_ops', 'regional', {outlets: ['cs','zz'], reviewOutlets: ['cs'], metrics: ['orders']});
  const scope = {...grant, subject: 'export_regional_ops', fields: ['id', 'orders']};
  await request(grants, manager, {...scope, outlet: 'zz'}, 403);
  await request(grants, manager, {...scope, fields: ['revenue']}, 403);
  await request(grants, manager, scope);
  await command(partner, 'report.submit', report);
  assert.equal((await request(csv + '&status=pending&month=2026-10', regional)).csv.trim().split(/\r?\n/).length, 2);
  await command(manager, 'staff.update', {id: scope.subject, role: 'ops', status: 'active', reason: '岗位调整后个人重新授权'});
  await request(csv, regional, null, 401);
  const relogin = await request('/auth/password', null, {username: scope.subject, password: f.password});
  await request(csv, relogin.data.token, null, 403);
}));

test('requests omit private data and escape approved outlet labels that start like formulas', t => runFixture(':memory:', async f => {
  const {request, command, manager, partner, ops, app} = f;
  await command(partner, 'request.submit', {outlet: 'cs', type: 'statusChange', data: {status: 'paused', effectiveDate: '2026-11-18', reason: '仅审批人阅读的业务说明'}});
  await command(partner, 'request.submit', {outlet: 'cs', type: 'accountChange', data: {managerName: '个人敏感测试', mobile: '13900000987', reason: '不应导出的账号事项'}});
  app.store.db.prepare("UPDATE outlets SET data=json_set(data,'$.name',?) WHERE id=?").run("   =FORMULA-BOUNDARY", 'cs');
  await request(grants, manager, {...grant, category: 'requests', fields: ['outletName', 'type', 'status']});
  const result = await request(csv.replace('category=reports','category=requests') + '&status=pending', ops);
  assert.equal(result.csv.trim().split(/\r?\n/).length, 2);
  assert.match(result.csv, /"'   =FORMULA-BOUNDARY","营业状态变更","待审核"/);
  assert.doesNotMatch(result.csv, /13900000987|账号事项|业务说明/);
  t.diagnostic(JSON.stringify({requestExportId: result.requestId}));
}));


test('limit rejection is explicit and Beijing date filters respect the UTC date boundary', () => runFixture(':memory:', async f => {
  const {app, command, manager, partner, ops, request} = f;
  const record = await command(partner, 'report.submit', report);
  const id = record.data.result.id;
  const db = app.store.db;
  db.prepare('UPDATE reports SET created_at=? WHERE id=?').run('2026-11-18T17:00:00.000Z', id);
  await request(grants, manager, {...grant, fields: ['id','submittedAt']});
  const precise = await request(csv + '&status=pending&from=2026-11-19&to=2026-11-19', ops);
  assert.match(precise.csv, /2026-11-19 01:00:00/);
  assert.ok(precise.csv.includes(id));
  const previous = await request(csv + '&status=pending&from=2026-11-18&to=2026-11-18', ops);
  assert.ok(!previous.csv.includes(id));
  await request(csv + '&from=2026-02-30', ops, null, 400);
  const clone = db.prepare(
    "INSERT INTO reports(id,owner,outlet,status,month,version,current,amount_cents,data,created_at) "
    + "SELECT ?,owner,outlet,status,month,?,0,amount_cents,json_set(data,'$.id',?,'$.version',?),created_at FROM reports WHERE id=?",
  );
  app.store.transaction(() => {
    for (let index=0; index<1000; index++) {
      const copied = 'row-cutoff-' + index;
      const version = index + 100;
      clone.run(copied, version, copied, version, id);
    }
  });
  const limited = await request(csv + '&status=pending&from=2026-11-19&to=2026-11-19', ops, null, 413);
  assert.equal(limited.error.code, 'EXPORT_LIMIT');
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE json_extract(data,'$.requestId')=?").get(limited.requestId).n, 0);
}));

test('approved revenue uses the submitted monthly report amount in yuan, including cents', () => runFixture(':memory:', async f => {
  const {command, manager, partner, ops, request} = f;
  await command(partner, 'report.submit', {...report, revenue: 1000.45});
  await request(grants, manager, {...grant, fields: ['revenue','orders']});
  const finalized = await request(csv + '&status=pending&month=2026-10', ops);
  assert.equal(finalized.csv.trim(), '"营业收入（元）","有效订单"\r\n"1000.45","20"');
}));
