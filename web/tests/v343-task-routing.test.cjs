'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');
const { runScheduledBatch } = require('../server/scheduler.cjs');

const report = { outlet: 'cs', month: '2026-10', revenue: 1000, orders: 20, traffic: 80, enroll: 1 };
const route = (outlet, kind, assigneeRole, assigneeUserId, enabled = true) =>
  ({ outlet, kind, assigneeRole, assigneeUserId, enabled, reason: '按已确认网点与岗位安排办理' });

async function withServer(run) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jiuying-routing-'));
  const app = createServer({ dbPath: path.join(folder, 'routing.db'), env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api';
  async function request(url, token, body, expected = 200, key = randomUUID()) {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotency-Key': key });
    const response = await fetch(base + url, {
      method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify(payload));
    return payload;
  }
  const command = (token, name, payload, expected, key) => request('/commands', token, { command: name, payload }, expected, key);
  const login = async actor => (await request('/auth/dev', null, { actor })).data.token;
  const manager = await login('manager');
  async function staff(subject, role) {
    await command(manager, 'staff.create', { subject, name: subject, role, reason: '隔离验收个人岗位' });
    const {data: invite} = await request('/auth/activation', manager, { actor: subject, username: subject });
    return (await request('/auth/activate', null, { token: invite.token, password: randomUUID() + '-Routing-Test' })).data.token;
  }
  try {
    await run({ manager, staff, command, login, request, store: app.store, db: app.store.db });
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    await rm(folder, { recursive: true, force: true });
  }
}

test('one outlet and stage routes a new monthly report to its configured personal queue without changing prior assignments', t => withServer(async ({manager,staff,command,login,request,db}) => {
  const first = await staff('route_ops_first', 'ops');
  const second = await staff('route_ops_second', 'ops');
  const finance = await staff('route_fin_only', 'finance');
  const partner = await login('partnerA');
  await command(first, 'routing.set', route('cs', 'report_review', 'ops', 'route_ops_first'), 403);
  await command(manager, 'routing.set', route('cs', 'report_review', 'finance', 'route_fin_only'), 400);
  const saved = await command(manager, 'routing.set', route('cs', 'report_review', 'ops', 'route_ops_first'));
  await request('/collections/taskRoutingRules', partner, null, 403);
  const key = randomUUID();
  const submitted = await command(partner, 'report.submit', report, 200, key);
  const reportId = submitted.data.result.id;
  const repeated = await command(partner, 'report.submit', report, 200, key);
  assert.equal(repeated.data.replayed, true);
  assert.equal(repeated.data.result.id, reportId);
  const query = '/tasks?queue=ops&kind=report_review';
  const queue = await request(query, first);
  assert.equal(queue.data.total, 1);
  const task = queue.data.items[0];
  assert.equal(task.businessId, reportId);
  assert.equal(task.assigneeUserId, 'route_ops_first');
  assert.equal(task.routingRuleId, saved.data.result.id);
  assert.equal(task.transferHistory[0].to.userId, 'route_ops_first');
  assert.equal(task.transferHistory[0].requestId, submitted.requestId);
  assert.equal((await request(query, second)).data.total, 0);
  await request('/tasks/' + task.id, second, null, 404);
  await command(second, 'review.report', { id: reportId, decision: 'approve' }, 403);
  await command(finance, 'review.report', { id: reportId, decision: 'approve' }, 403);
  const replacement = await command(manager, 'routing.set', route('cs', 'report_review', 'ops', 'route_ops_second'));
  assert.equal(replacement.data.result.id, saved.data.result.id);
  assert.equal((await request('/tasks/' + task.id, first)).data.assigneeUserId, 'route_ops_first');
  const fallback = await command(partner, 'report.submit', { ...report, outlet: 'zz', enroll: null });
  const unassigned = (await request(query, second)).data.items.find(row => row.businessId === fallback.data.result.id);
  assert.equal(unassigned.assigneeUserId, null);
  await command(manager, 'task.assign', { id: task.id, assigneeRole: 'ops', assigneeUserId: 'route_ops_second', note: '处理在途业务交接' });
  await command(first, 'review.report', { id: reportId, decision: 'approve' }, 403);
  const approved = await command(second, 'review.report', { id: reportId, decision: 'approve' });
  assert.equal(approved.data.result.status, 'approved');
  assert.equal((await request('/tasks/' + task.id, manager)).data.status, 'resolved');
  assert.equal(db.prepare("SELECT count(*) n FROM businessTasks WHERE json_extract(data,'$.recordId')=? AND json_extract(data,'$.kind')='report_review'").get(reportId).n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM taskRoutingRules').get().n, 1);
  t.diagnostic(JSON.stringify({ ruleId: saved.data.result.id, ruleRequestId: saved.requestId, reportId, taskId: task.id, submitRequestId: submitted.requestId, approveRequestId: approved.requestId }));
}));

test('an unsettled revenue correction uses separate operations and finance recipients', t => withServer(async ({manager,staff,command,login,request}) => {
  const ops = await staff('routing_stage_ops', 'ops');
  const finance = await staff('routing_stage_finance', 'finance');
  const financePeer = await staff('routing_finance_peer', 'finance');
  const partner = await login('partnerA');
  await command(manager, 'routing.set', route('cs', 'report_review', 'ops', 'routing_stage_ops'));
  await command(manager, 'routing.set', route('cs', 'report_finance_review', 'finance', 'routing_stage_finance'));
  const initial = (await request('/reports/context?outlet=cs&month=2026-08', partner)).data.currentApprovedVersion;
  await command(partner, 'report.correct', { id: initial.id, reason: '更正历史已审批经营收入' });
  const v2 = (await command(partner, 'report.submit', { ...report, month: '2026-08' })).data.result;
  const review = await command(ops, 'review.report', { id: v2.id, decision: 'approve' });
  assert.equal(review.data.result.status, 'finance');
  const { items } = (await request('/tasks?queue=finance&kind=report_finance_review', finance)).data;
  assert.equal(items.length, 1);
  assert.equal(items[0].businessId, v2.id);
  await command(financePeer, 'review.report', { id: v2.id, decision: 'approve' }, 403);
  const approved = await command(finance, 'review.report', { id: v2.id, decision: 'approve' });
  assert.equal(approved.data.result.status, 'approved');
  t.diagnostic(JSON.stringify({ reportId: v2.id, financeTaskId: items[0].id, opsRequestId: review.requestId, financeRequestId: approved.requestId }));
}));

test('routed support queue enforces access before claiming and handover moves open work', t => withServer(async ({manager,staff,command,login,request,store}) => {
  const agent = await staff('routing_support', 'support');
  const peer = await staff('routing_support_peer', 'support');
  const partner = await login('partnerA');
  await command(manager, 'routing.set', route('cs', 'support_queue', 'support', 'routing_support'));
  const filing = { outlet: 'cs', category: 'exception', title: '操作支持', description: '核对提交操作' };
  const submitted = await command(partner, 'support.ticket', filing);
  const ticket = submitted.data.result;
  const queue = '/tasks?queue=hq&kind=support_queue';
  const task = (await request(queue, agent)).data.items.find(row => row.businessId === ticket.id);
  assert.ok(task?.canViewBusiness);
  assert.equal((await request(queue, peer)).data.items.some(row => row.id === task.id), false);
  await request('/collections/supportTickets/' + ticket.id, peer, null, 404);
  await command(peer, 'support.claim', { id: ticket.id }, 403);
  await command(manager, 'staff.handover', { fromSubject: 'routing_support', toSubject: 'routing_support_peer', reason: '离岗交接未接单工单' });
  await request('/tasks/' + task.id, agent, null, 401);
  assert.equal((await request('/tasks/' + task.id, peer)).data.assigneeUserId, 'routing_support_peer');
  const claimed = await command(peer, 'support.claim', { id: ticket.id });
  assert.equal(claimed.data.result.status, 'active');
  assert.equal((await request('/tasks/' + task.id, manager)).data.status, 'resolved');
  const fallbackFromDisabled = (await command(partner, 'support.ticket', filing)).data.result;
  assert.equal((await request(queue, peer)).data.items.find(row => row.businessId === fallbackFromDisabled.id).assigneeUserId, null);
  await command(manager, 'routing.set', route('cs', 'support_queue', 'support', 'routing_support_peer'));
  await command(manager, 'support.settings', { hours: '测试服务时间', sla: { complaint: null, aftersale: null, exception: 1 } });
  const toEscalate = (await command(partner, 'support.ticket', filing)).data.result;
  await runScheduledBatch(store, { now: new Date(Date.now() + 120000).toISOString() });
  const escalated = (await request('/tasks?queue=hq&kind=support_sla', peer)).data.items.find(row => row.businessId === toEscalate.id);
  assert.equal(escalated.assigneeUserId, 'routing_support_peer');
  await request('/collections/supportTickets/' + toEscalate.id, await login('support'), null, 404);
  await command(await login('support'), 'support.claim', { id: toEscalate.id }, 403);
  await command(manager, 'routing.set', route('cs', 'support_queue', 'support', '', false));
  const next = (await command(partner, 'support.ticket', filing)).data.result;
  assert.equal((await request(queue, peer)).data.items.find(row => row.businessId === next.id).assigneeUserId, null);
  t.diagnostic(JSON.stringify({ ticketId: ticket.id, taskId: task.id, submitRequestId: submitted.requestId, claimRequestId: claimed.requestId, disabledTargetFallback: next.id }));
}));

test('business application and location review reach distinct assigned roles, disable and missing outlet fall back', () => withServer(async ({manager,staff,command,login,request}) => {
  const ops = await staff('routing_application_ops', 'ops');
  const location = await staff('routing_location', 'location');
  const otherLocation = await staff('routing_location_peer', 'location');
  const partner = await login('partnerA');
  await command(manager, 'routing.set', route('cs', 'request_review', 'ops', 'routing_application_ops'));
  await command(manager, 'routing.set', route('cs', 'location_request_review', 'location', 'routing_location'));
  const photo = await request('/files', partner, {
    name: 'routing.png', type: 'image/png',
    base64: (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f0f0f0' } }).png().toBuffer()).toString('base64'),
  }, 201);
  const moved = await command(partner, 'request.submit', {
    outlet: 'cs', type: 'locationChange', data: { address: '核验点地址', coords: { lat: 28, lng: 113, source: 'manual', coordinateSystem: 'GCJ-02' }, photo: { id: photo.data.id }, reason: '地址变更' },
  });
  const id = moved.data.result.id;
  await command(otherLocation, 'location.review', { id, decision: 'approve' }, 403);
  await command(location, 'location.review', { id, decision: 'approve' });
  const next = (await request('/tasks?queue=hq&kind=request_review', ops)).data.items.find(row => row.businessId === id);
  assert.equal(next.assigneeUserId, 'routing_application_ops');
  const newOutlet = (await command(partner, 'request.submit', {
    type: 'newOutlet', data: {
      name: '隔离新增网点', province: '湖南', city: '长沙', district: '开福区', address: '部署验收地址',
      phone: '0731-00000000', opening: '2026-11-01',
      coords: { lat: 28, lng: 113, source: 'manual', coordinateSystem: 'GCJ-02' }, photo: { id: photo.data.id },
    }
  })).data.result;
  const noOutlet = (await request('/tasks?queue=hq&kind=location_request_review', otherLocation)).data.items.find(row => row.businessId === newOutlet.id);
  assert.equal(noOutlet.assigneeUserId, null);
  await command(manager, 'routing.set', route('cs', 'request_review', 'ops', '', false));
  await command(ops, 'review.request', { id, decision: 'approve' });
  const paused = (await command(partner, 'request.submit', { outlet: 'cs', type: 'statusChange', data: { status: 'paused', effectiveDate: '2026-11-18', reason: '停业测试' } })).data.result;
  assert.equal((await request('/tasks?queue=hq&kind=request_review', ops)).data.items.find(row => row.businessId === paused.id).assigneeUserId, null);
}));

test('an unactivated personal account cannot receive a routing rule, assigned task, or staff handover', t => withServer(async ({manager,staff,command,login,request,db}) => {
  const operator = await staff('activation_ready_ops', 'ops');
  await command(manager, 'staff.create', { subject: 'activation_pending_ops', name: '待激活运营', role: 'ops', reason: '隔离验收未激活个人岗位' });
  await request('/auth/password', null, { username: 'activation_pending_ops', password: randomUUID() }, 401);
  await command(manager, 'routing.set', route('cs', 'report_review', 'ops', 'activation_pending_ops'), 409);

  const approvedRule = await command(manager, 'routing.set', route('cs', 'report_review', 'ops', 'activation_ready_ops'));
  const partner = await login('partnerA');
  const submitted = await command(partner, 'report.submit', report);
  const {items} = (await request('/tasks?queue=ops&kind=report_review', operator)).data;
  const task = items.find(row => row.businessId === submitted.data.result.id);
  assert.equal(task.assigneeUserId, 'activation_ready_ops');

  const manual = await command(manager, 'task.assign', {
    id: task.id, assigneeRole: 'ops', assigneeUserId: 'activation_pending_ops', note: '交由运营跟进'
  }, 409);
  const handover = await command(manager, 'staff.handover', {
    fromSubject: 'activation_ready_ops', toSubject: 'activation_pending_ops', reason: '核对接替人激活情况'
  }, 409);
  assert.equal((await request('/tasks/' + task.id, operator)).data.assigneeUserId, 'activation_ready_ops');
  const active = (await request('/collections/staffAccounts/activation_ready_ops', manager)).data;
  const pending = (await request('/collections/staffAccounts/activation_pending_ops', manager)).data;
  assert.equal(active.activated, true);
  assert.equal(pending.activated, false);
  assert.equal(db.prepare('SELECT count(*) n FROM credentials WHERE actor=?').get(pending.id).n, 0);
  const reviewed = await command(operator, 'review.report', { id: submitted.data.result.id, decision: 'approve' });
  assert.equal(reviewed.data.result.status, 'approved');
  t.diagnostic(JSON.stringify({ rule: approvedRule.requestId, task: task.id, manual: manual.requestId, handover: handover.requestId, review: reviewed.requestId }));
}));

test('an old rule naming an unactivated account leaves new work in its normal role queue', t => withServer(async ({manager,staff,command,login,request,store}) => {
  const operator = await staff('legacy_rule_eligible_peer', 'ops');
  await command(manager, 'staff.create', { subject: 'legacy_rule_pending_ops', name: '历史未激活运营', role: 'ops', reason: '隔离验收旧规则' });
  const state = store.load();
  state.taskRoutingRules.push({
    id: 'legacy-unactivated-rule', owner: 'p1', outlet: 'cs', kind: 'report_review', assigneeRole: 'ops',
    assigneeUserId: 'legacy_rule_pending_ops', status: 'active', createdAt: new Date().toISOString()
  });
  store.save(state);
  const partner = await login('partnerA');
  const submitted = await command(partner, 'report.submit', report);
  const queue = await request('/tasks?queue=ops&kind=report_review', operator);
  const task = queue.data.items.find(row => row.businessId === submitted.data.result.id);
  assert.ok(task);
  assert.equal(task.assigneeUserId, null);
  const reviewed = await command(operator, 'review.report', { id: submitted.data.result.id, decision: 'approve' });
  assert.equal(reviewed.data.result.status, 'approved');
  t.diagnostic(JSON.stringify({ submit: submitted.requestId, queue: queue.requestId, task: task.id, review: reviewed.requestId }));
}));
