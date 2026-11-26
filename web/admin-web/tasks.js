const QUEUES = {
  ops: { title: '待运营审核', desk: '运营审核', icon: 'report' },
  finance: { title: '待财务复核', desk: '财务复核', icon: 'wallet' },
  partner: { title: '待加盟商修改', desk: '退回及补充报送', icon: 'store' },
  hq: { title: '待总部补充处理', desk: '总部补充处理', icon: 'check' }
};
const BUSINESS = {
  reports: '经营月报', requests: '业务申请', verifications: '位置核验',
  bills: '服务费账单', adjustments: '费用调整', feeProposals: '费用调整提案',
  supportTickets: '客服工单', supportChats: '咨询会话', outlets: '网点档案',
  exemptions: '报送免报记录', settlements: '月报结算', offlinePayments: '线下收款',
  refundRequests: '退款申请', invoiceRequests: '发票申请', billCorrections: '账单纠错',
  summaryAdjustments: '汇总统计调整'
};
const STAGES = {
  report_review: '月报初审', report_finance_review: '月报财务复核', report_returned: '修改并重提月报',
  request_review: '业务申请审批', request_supplement: '补充申请材料',
  location_request_review: '申请位置核验', location_verification: '现场位置核验',
  location_review: '现场位置核验', location_exception: '核查位置异常',
  location_missing: '提交位置核验资料', report_missing: '补报经营月报',
  report_resettlement: '历史月报重新结算', report_revoke_review: '误审批撤销复核', fee_calculation: '核算停费金额',
  fee_proposal_review: '复核费用调整', fee_adjustment_review: '复核费用调整', fee_review: '复核费用调整',
  summary_review: '复核统计调整', summary_finance_review: '财务复核统计调整',
  bill_overdue: '核查逾期账单', exemption_review: '核查免报条件', headquarters_followup: '总部补充处理',
  support_queue: '受理客服工单', support_process: '跟进客服工单', support_reply: '跟进客服回复',
  support_sla: '核查客服响应超时', support_management: '总部处理升级工单',
  metric_anomaly: '复核经营指标', no_data: '核查连续缺数'
};
const STATUSES = { current: '当前待办', open: '待办理', in_progress: '办理中', resolved: '已关闭' };
const FILTERS = ['status', 'kind', 'businessType', 'outlet', 'month', 'assigneeRole'];
const CREATE_TYPES = ['outlets', 'reports', 'requests', 'verifications', 'bills', 'supportTickets'];
const LIMIT = 25;

export const taskDate = value => {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
};

export function readTaskRoute(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('queue')) return null;
  const criteria = Object.fromEntries(FILTERS.map(key => [key, (params.get(key) || '').slice(0, 120)]));
  criteria.status ||= 'current';
  const offset = Number(params.get('offset') || 0);
  return {
    queue: (params.get('queue') || '').slice(0, 40), criteria,
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    task: (params.get('task') || '').slice(0, 150)
  };
}

function href(route, updates = {}) {
  const { queue, criteria, offset, task } = { ...route, ...updates };
  const params = new URLSearchParams({ queue });
  for (const key of FILTERS) {
    if (criteria?.[key] && !(key === 'status' && criteria[key] === 'current')) params.set(key, criteria[key]);
  }
  if (offset) params.set('offset', offset);
  if (task) params.set('task', task);
  return '#' + params;
}

export function tasks(c) {
  const { esc, I, field, select, area, form, submit, button, pair, empty, notice, api, modal, roles } = c;
  const all = (values, placeholder, selection) => [['', placeholder], ...values, ...(selection && !values.some(([key]) => key === selection) ? [[selection, selection]] : [])];
  const label = row => row.title || STAGES[row.kind] || BUSINESS[row.businessType] || '业务待办';
  const assignee = row => {
    if (row.assigneeType === 'franchisee') return '加盟商负责人';
    const role = roles[row.assigneeRole] || row.assigneeRole || '总部管理层';
    return row.assigneeUserId ? `${role} · ${row.assigneeUserId}` : role;
  };
  const errorMessage = (error, denied) => error.status === 403 ? denied :
    error.status === 404 ? '该记录已不存在，或当前账号没有访问权限。' :
      `${error.message}${error.requestId ? ' · 请求编号 ' + error.requestId : ''}`;
  const summary = () => api('/tasks/overview');
  const detail = id => api('/tasks/' + encodeURIComponent(id));
  const list = route => {
    if (!Object.hasOwn(QUEUES, route.queue)) throw Object.assign(Error('未知的待办队列。'), { status: 404 });
    return api('/tasks?' + new URLSearchParams({
      queue: route.queue, limit: LIMIT, offset: route.offset,
      ...Object.fromEntries(Object.entries(route.criteria).filter(([,value]) => value))
    }));
  };

  function cards(overview, error, showTitle = true) {
    if (error) return `<section class="panel task-summary"><div class="panel-head"><h3>业务待办</h3></div><div class="panel-body" role="alert">${notice(errorMessage(error, '当前账号无权查看业务待办。'))}${error.status !== 403 ? button('重新加载','refresh') : ''}</div></section>`;
    if (!overview?.items?.length) return '';
    return `<section class="task-summary" aria-label="业务待办">${showTitle?'<h2>业务待办</h2>':''}<div class="task-cards">${overview.items.filter(row => Object.hasOwn(QUEUES, row.queue)).map(row => {
      const meta = QUEUES[row.queue];
      const metrics = [];
      if (row.earliestDueAt) metrics.push('最早截止 ' + taskDate(row.earliestDueAt));
      if (row.earliestDueAt || row.overdue > 0) metrics.push('超期 ' + row.overdue + ' 项');
      return `<a class="task-card" data-queue="${row.queue}" href="${esc(href({ queue: row.queue }))}"><span class="task-card-label">${meta.title}${I(meta.icon)}</span><strong class="task-count">${esc(row.total)}</strong>${metrics.length ? `<span class="task-card-deadline">${esc(metrics.join(' · '))}</span>` : ''}<span class="task-card-link">查看队列 ${I('arrow')}</span></a>`;
    }).join('')}</div></section>`;
  }

  function rowMarkup(row, route) {
    const stage = STAGES[row.currentStage] || STAGES[row.kind] || QUEUES[row.queue]?.desk || '待人工核查';
    const time = row.dueAt ? esc(taskDate(row.dueAt)) + (row.overdue ? ' <span class="pill bad">已超期</span>' : '') : '<span class="muted">'+(row.kind==='report_resettlement'?'—':'待配置')+'</span>';
    const sourceLink = row.canViewBusiness ? `<a class="button soft" data-task-link href="${esc(href(route, { task: row.id }))}">查看业务</a>` : '';
    return `<tr><td class="task-title-cell"><strong>${esc(label(row))}</strong><small>${esc(row.outletName || row.outlet || (row.affectedOutletIds?.length?row.affectedOutletIds.length+' 个网点':'—'))}${row.month ? ' · ' + esc(row.month) : ''}</small></td><td>${esc(row.applicant || '—')}</td><td>${esc(stage)}<small>${esc(STATUSES[row.status] || row.status)}</small></td><td>${esc(assignee(row))}${row.routingRuleId?'<small>由规则分派</small>':''}</td><td>${time}</td><td><div class="row-actions">${sourceLink}${button('待办详情', 'task-detail', { id: row.id })}${row.canAssign ? button('分派 / 转派', 'task-assign', { id: row.id }) : ''}${row.canComplete ? button('完成待办', 'task-complete', { id: row.id }, 'primary') : ''}</div></td></tr>`;
  }

  function queue(route, data, error) {
    const meta = QUEUES[route.queue];
    const title = meta?.title || '待办队列';
    const publicSession = c.session()?.actor === 'public';
    const back = button(publicSession ? '返回网点' : '返回待办总览', 'nav', { page: publicSession ? 'stores' : 'tasks' });
    const create = route.queue === 'hq' && c.session()?.actor === 'manager' && !error ? button('创建补充待办', 'task-create', {}, 'primary', 'plus') : '';
    const entry = c.heading(title, meta ? `${meta.desk}队列 · 按账号授权范围展示` : '', `<div class="actions">${back}${create}</div>`);
    const body = error ? `<div role="alert">${notice(errorMessage(error, '当前账号无权查看此待办队列。'))}</div>${error.status === 403 || error.status === 404 ? '' : button('重试','refresh')}` :
      data ? queueResults(route, data) : '<p class="empty" role="status">正在加载待办…</p>';
    return `<section class="task-queue" data-queue="${esc(route.queue)}">${entry}${body}</section>`;
  }

  function queueResults(route, data) {
    const f = route.criteria;
    const filter = `<div class="task-filters filters">${select('taskStatus', '待办状态', Object.entries(STATUSES), f.status, 'data-task-filter="status"')}${select('taskBusiness', '业务类型', all(Object.entries(BUSINESS), '全部业务', f.businessType), f.businessType, 'data-task-filter="businessType"')}${select('taskKind', '处理事项', all(Object.entries(STAGES), '全部事项', f.kind), f.kind, 'data-task-filter="kind"')}${field('taskOutlet', '网点编号', f.outlet, 'search', 'data-task-filter="outlet" maxlength="120"')}${field('taskMonth', '业务期间', f.month, 'month', 'data-task-filter="month"')}${select('taskAssignee', '责任岗位', all(Object.entries(roles).filter(([key]) => !['public', 'partnerA', 'partnerB'].includes(key)), '全部岗位', f.assigneeRole), f.assigneeRole, 'data-task-filter="assigneeRole"')}</div>`;
    const page = `<div class="pagination task-pagination"><span>共 <b>${esc(data.total)}</b> 项 · ${data.items.length ? data.offset + 1 : 0}–${data.items.length ? data.offset + data.items.length : 0}</span>${data.offset > 0 ? `<a class="button" href="${esc(href(route, { offset: Math.max(0, data.offset - data.limit) }))}" aria-label="上一页">←</a>` : '<button class="button" disabled aria-label="上一页">←</button>'}${data.hasMore ? `<a class="button" href="${esc(href(route, { offset: data.offset + data.limit }))}" aria-label="下一页">→</a>` : '<button class="button" disabled aria-label="下一页">→</button>'}</div>`;
    const results = data.items.length ? `<div class="table-wrap"><table><thead><tr><th>事项 / 网点及期间</th><th>申请人</th><th>当前阶段</th><th>责任岗位 / 人员</th><th>截止时间（北京时间）</th><th>操作</th></tr></thead><tbody>${data.items.map(row => rowMarkup(row, route)).join('')}</tbody></table></div>` : empty('暂无符合条件的待办。');
    return filter + `<section class="panel">${results}</section>` + page;
  }

  function filter(route, key, val) {
    location.hash = href(route, { criteria: { ...route.criteria, [key]: val.trim() }, offset: 0 });
  }

  function focused(route, row, recordMarkup, error) {
    const back = `<a class="button" href="${esc(href(route, { task: '' }))}">返回队列</a>`;
    const entry = c.heading(row ? BUSINESS[row.businessType] || '关联业务' : '关联业务', row ? esc(label(row)) : '', back);
    return `<section class="focused-business">${entry}${error ? `<div role="alert">${notice(errorMessage(error, '当前账号无权查看此业务记录。'))}</div>${error.status >= 500 || !error.status ? button('重试','refresh') : ''}` : recordMarkup}</section>`;
  }

  function resettlement(task,previous,next) {
    const kinds={report_corrected:'月报更正通过',report_revoked:'月报审批撤销',report_approved:'补报月报通过',summary_adjusted:'汇总调整通过',legacy_report_change:'历史月报版本变更',legacy_scope_unconfirmed:'历史影响待核对'};
    const names=new Map((task.affectedOutlets||[]).map(outlet=>[outlet.id,outlet.name]));
    const impact=(task.impacts||[]).map(item=>`<li><b>${esc(names.get(item.outlet)||item.outlet)} · ${esc(kinds[item.kind]||item.kind)}</b><small>${esc(taskDate(item.at))}${item.subject?' · '+esc(item.subject):''}</small>${item.previousReportId?pair('原月报',item.previousReportId):''}${item.reportId?pair('关联月报',item.reportId):''}${item.requestId?pair('请求编号',item.requestId):''}${item.reportId||item.previousReportId?button('查看月报审批历史','approval-open',{collection:'reports',id:item.reportId||item.previousReportId}):''}${item.kind==='report_revoked'&&item.eventId?.startsWith('req-')?button('查看撤销复核','approval-open',{collection:'requests',id:item.eventId}):''}${item.kind==='summary_adjusted'?button('查看汇总调整复核','approval-open',{collection:'summaryAdjustments',id:item.eventId}):''}</li>`).join('');
    const snapshot=row=>row?pair('结算版本','V'+(row.version??1)+' · '+row.id)+pair('涵盖有效月报',row.reportIds.length+' 份'):'';
    const comparisons=task.affectedOutletIds?.map(id=>{
      const old=Object.values(previous.reportValues||{}).find(row=>row.outlet===id);
      const current=Object.values(next?.reportValues||{}).find(row=>row.outlet===id);
      if(!next||!old&&!current)return '';
      const value=(row,key)=>row?.values?.[key]??'—';
      return `<tr><th>${esc(names.get(id)||id)}</th>${['revenue','orders','traffic','enroll'].map(key=>`<td>${esc(value(old,key))} → ${esc(value(current,key))}</td>`).join('')}</tr>`;
    }).join('');
    return `<section class="panel"><div class="panel-body"><h3>原结算快照</h3>${snapshot(previous)}<h3>影响记录</h3>${impact?`<ol class="timeline">${impact}</ol>`:empty('该历史快照缺少可核对的影响记录')}${next?'<h3>新结算快照</h3>'+snapshot(next)+pair('确认人',task.completedBy):''}${comparisons?`<div class="table-wrap"><table><thead><tr><th>网点</th><th>收入（元）</th><th>订单</th><th>客流</th><th>招生</th></tr></thead><tbody>${comparisons}</tbody></table></div>`:''}${task.canResettle?form('settle',field('month','',task.month,'hidden')+field('taskId','',task.id,'hidden')+notice('确认后根据当前有效月报和已批准汇总调整生成新快照。原快照保留。',true)+submit('确认重新结算')):''}</div></section>`;
  }

  async function openDetails(id) {
    const row = await detail(id);
    const history = row.transferHistory || [];
    modal('待办详情', pair('事项', label(row)) + pair('记录编号', row.id) + pair('网点', row.outletName || row.outlet) +
      pair('业务月份', row.month) + pair('状态', STATUSES[row.status] || row.status) + pair('当前责任', assignee(row)) +
      pair('创建时间（北京时间）', taskDate(row.createdAt)) + pair('截止时间', row.dueAt ? taskDate(row.dueAt) : row.kind==='report_resettlement'?'—':'待配置') +
      (row.completedAt ? pair('关闭时间（北京时间）', taskDate(row.completedAt)) : '') + (row.closeReason ? pair('关闭原因', row.closeReason) : '') +
      (row.note ? pair('处理依据', row.note) : '') +
      (history.length ? `<h3 class="section-title">分派记录</h3><ol class="timeline">${history.map(event => `<li><b>${esc(assignee({ assigneeRole: event.from?.role, assigneeUserId: event.from?.userId }))} → ${esc(assignee({ assigneeRole: event.to?.role, assigneeUserId: event.to?.userId }))}</b><small>${esc(taskDate(event.at))} · ${esc(event.subject || roles[event.actor] || event.actor || '')}</small><p>${esc(event.note)}</p></li>`).join('')}</ol>` : ''));
  }

  function create() {
    modal('创建总部补充待办', notice('请关联已有业务记录。待办先进入总部管理层分派队列。', true) + form('task.create',
      select('businessType', '业务类型', CREATE_TYPES.map(key => [key, BUSINESS[key]])) +
      field('businessId', '关联业务编号', '', 'text', 'required maxlength="150"') +
      field('title', '待办事项', '', 'text', 'required minlength="3" maxlength="120"') +
      area('note', '处理依据') + field('dueAt', '已明确的截止时间（北京时间，选填）', '', 'datetime-local') +
      submit('创建待办')));
  }

  async function assign(id) {
    const row = await detail(id);
    if (!row.canAssign || !row.allowedAssigneeRoles?.length) throw Error('当前待办无法分派。');
    const allowed = row.allowedAssigneeRoles.map(role => [role, roles[role] || role]);
    const role = row.allowedAssigneeRoles.includes(row.assigneeRole) ? row.assigneeRole : allowed[0][0];
    const staff = await api('/collections/staffAccounts?' + new URLSearchParams({ status: 'active', limit: 200, offset: 0 }));
    const options = staff.items.filter(person => person.activated === true && row.allowedAssigneeRoles.includes(person.role)).map(person =>
      `<option value="${esc(person.subject || person.id)}" data-role="${esc(person.role)}" ${person.role === role ? '' : 'disabled'}>${esc(person.name || person.subject || person.id)}</option>`
    ).join('');
    modal('分派 / 转派待办', pair('事项', label(row)) + form('task.assign', field('id', '', id, 'hidden') +
      select('assigneeRole', '责任岗位', allowed, role, 'data-task-assignee') +
      field('assigneeUserId', '已激活的个人账号（选填，留空分派给岗位）', row.assigneeUserId || '', 'text', 'list="task-staff-list" maxlength="120"') +
      `<datalist id="task-staff-list">${options}</datalist>` + area('note', '分派依据') + submit('确认分派')));
  }

  async function complete(id) {
    const row = await detail(id);
    if (!row.canComplete) throw Error('当前账号无权完成此待办。');
    modal('完成待办', pair('事项', label(row)) + form('task.complete', field('id', '', id, 'hidden') +
      area('note', '完成依据与结论') + submit('确认完成')));
  }

  function normalize(command, payload) {
    if (command === 'task.create') {
      if (payload.dueAt) payload.dueAt = new Date(payload.dueAt + '+08:00').toISOString();
      else delete payload.dueAt;
    }
    if (command === 'task.assign') payload.assigneeUserId = payload.assigneeUserId.trim() || null;
    return payload;
  }

  return { summary, detail, list, cards, queue, focused, resettlement, filter, openDetails, create, assign, complete, normalize };
}
