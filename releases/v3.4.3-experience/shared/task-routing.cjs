'use strict';

const routingOptions = Object.freeze([
  { kind: 'report_review', role: 'ops', label: '月报运营审核' },
  { kind: 'report_finance_review', role: 'finance', label: '月报财务复核' },
  { kind: 'request_review', role: 'ops', label: '运营业务申请审批' },
  { kind: 'request_review', role: 'finance', label: '财务业务申请复核' },
  { kind: 'location_request_review', role: 'location', label: '业务申请位置核验' },
  { kind: 'location_verification', role: 'location', label: '月度现场位置核验' },
  { kind: 'location_exception', role: 'location', label: '月度位置异常核查' },
  { kind: 'support_queue', role: 'support', label: '客服工单受理' },
  { kind: 'summary_review', role: 'ops', label: '经营统计调整运营审核' },
  { kind: 'summary_finance_review', role: 'finance', label: '经营统计调整财务复核' },
  { kind: 'fee_calculation', role: 'ops', label: '停费金额核算' },
  { kind: 'fee_proposal_review', role: 'finance', label: '费用调整财务复核' },
].map(Object.freeze));

function isRoutable(kind, role) {
  return routingOptions.some(option => option.kind === kind && option.role === role);
}

function resolveRule(state, outlet, kind, role) {
  if (!outlet || !isRoutable(kind, role)) return null;
  return state.taskRoutingRules?.find(rule =>
    rule.outlet === outlet && rule.kind === kind && rule.assigneeRole === role && rule.status === 'active'
  ) || null;
}

function isActivatedStaff(state, id) {
  // HTTP commands and scheduler runs supply current credential presence. The standalone domain
  // model has no credential store and is only allowed to omit the lookup in development.
  return state.activatedStaffIds?.includes(id) ?? state.mode !== 'production';
}

function resolveAssignee(state, outlet, kind, role) {
  const rule = resolveRule(state, outlet, kind, role);
  if (!rule || !isActivatedStaff(state, rule.assigneeUserId)) return null;
  return state.staffAccounts?.find(staff =>
    staff.id === rule.assigneeUserId && staff.status === 'active' && staff.role === role
  ) || null;
}

const businessActions = Object.freeze({
  'review.report': ['report_review', 'report_finance_review'],
  'review.request': ['request_review'],
  'review.revoke': ['request_review'],
  'location.review': ['location_request_review', 'location_verification', 'location_exception'],
  'support.claim': ['support_queue', 'support_sla'],
  'review.adjust': ['summary_review', 'summary_finance_review'],
  'fee.adjust.propose': ['fee_calculation'],
  'fee.adjust.review': ['fee_proposal_review'],
});

function assignedToAnother(state, id, kinds, subject) {
  return !!state.businessTasks?.some(task =>
    task.recordId === id && kinds.includes(task.kind) && task.assigneeUserId &&
    task.assigneeUserId !== subject && ['open', 'in_progress'].includes(task.status)
  );
}

function hasAssignedAction(state, command, payload, subject) {
  const kinds = businessActions[command];
  return Array.isArray(kinds) ? assignedToAnother(state, payload.id || payload.adjustmentId, kinds, subject) : false;
}

module.exports = { routingOptions, isRoutable, isActivatedStaff, resolveRule, resolveAssignee, assignedToAnother, hasAssignedAction };
