'use strict';

const {randomUUID} = require('node:crypto');
const {check, METRICS} = require('../shared/core.cjs');
const {feeRequestTypes} = require('../shared/approval-events.cjs');
const {financeReport} = require('./approval-history.cjs');

const rowLimit = 1000;
const pageSize = 30;
const common = {
  id: ['记录编号', 'r.id'],
  outletName: ['网点', "(SELECT json_extract(o.data, '$.name') FROM outlets o WHERE o.id=r.outlet)"],
  status: ['处理状态', 'r.status'],
  submittedAt: ['提交时间（北京时间）', "strftime('%Y-%m-%d %H:%M:%S',r.created_at,'+8 hours')"],
};
const categories = {
  reports: {
    label: '经营月报', roles: ['ops','finance','regional'],
    statuses: ['pending','finance','returned','approved','revoked'],
    fields: {
      ...common, month: ['报告月份', 'r.month'], version: ['版本', 'r.version'],
      revenue: ['营业收入（元）', "json_extract(r.data, '$.revenue')"],
      orders: ['有效订单', "json_extract(r.data, '$.orders')"],
      traffic: ['到店客流', "json_extract(r.data, '$.traffic')"],
      enroll: ['实际招生', "json_extract(r.data, '$.enroll')"],
    },
  },
  requests: {
    label: '业务申请', roles: ['ops','finance','location'],
    statuses: ['pending','supplement','returned','approved'],
    fields: {...common, type: ['申请类型', "json_extract(r.data, '$.type')"]},
  },
  verifications: {
    label: '月度位置核验', roles: ['location'],
    statuses: ['pending','approved','exception'],
    fields: {...common, month: ['核验月份', 'r.month']},
  },
};
const statuses = {
  pending: '待审核', finance: '财务复核中', returned: '已退回', approved: '已通过',
  revoked: '已撤销', supplement: '待补充', exception: '异常',
};
const types = {
  newOutlet: '新增网点', locationChange: '位置变更', statusChange: '营业状态变更',
  pauseFee: '暂停收费', exemptException: '免报财务事项', reportRevoke: '月报撤销', enrollment: '招生适用性调整',
};
const exportRoles = new Set(Object.values(categories).flatMap(category => category.roles));
const businessMembership = '^[A-Za-z0-9_.:-]{1,120}$';
const codePattern = new RegExp(businessMembership);

function writeAudit(store, session, command, requestId, scope, at, rowCount) {
  const record = {
    id: 'audit-' + randomUUID(), subject: session.subject, actor: session.actor, command,
    status: 'completed', outlet: scope.outlet, owner: null, createdAt: at, executedAt: at, requestId, scope,
    ...(rowCount === undefined ? {} : {rowCount}),
  };
  store.db.prepare('INSERT INTO audit(id,owner,outlet,status,data,created_at) VALUES(?,?,?,?,?,?)')
    .run(record.id, null, record.outlet, record.status, JSON.stringify(record), at);
  store.sealAudit();
}

function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && (/^[\t\r\n]/.test(text) ||
      /^[\s\u0000-\u001f\u007f]*[=+\-@＝＋－＠]/.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function approvalExport(store, repo) {
  const {db} = store;

  function personalStaff(subject) {
    return db.prepare(
      "SELECT u.role,u.status,s.status AS staff_status FROM users u JOIN staffAccounts s ON s.id=u.actor "
      + 'WHERE u.actor=?',
    ).get(subject);
  }

  function isActive(staff) {
    return staff?.status === 'active' && staff.staff_status === 'active';
  }

  function checkActor(session) {
    const staff = personalStaff(session.subject);
    check(
      isActive(staff) && staff.role === session.actor && (session.actor === 'manager' || exportRoles.has(session.actor)),
      'FORBIDDEN', '仅已激活的总部个人账号可使用表单导出', 403,
    );
    check(db.prepare('SELECT 1 FROM credentials WHERE actor=?').get(session.subject),
      'FORBIDDEN', '请先完成个人账号激活', 403);
  }

  function managerOnly(session) {
    checkActor(session);
    check(session.actor === 'manager', 'FORBIDDEN', '仅总管理员可管理表单导出授权', 403);
  }

  function categoryOf(key) {
    check(typeof key === 'string' && Object.hasOwn(categories, key), 'INPUT', '请选择有效的表单类型');
    return categories[key];
  }

  function checkFields(fields, category) {
    check(Array.isArray(fields) && fields.length > 0 && fields.length <= Object.keys(category.fields).length
      && new Set(fields).size === fields.length && fields.every(field => typeof field === 'string' && Object.hasOwn(category.fields, field)),
    'INPUT', '请选择有效且不重复的导出字段');
  }

  function readGrant(subject, outlet, category) {
    return db.prepare('SELECT * FROM approval_export_grants WHERE staff_id=? AND outlet=? AND category=?')
      .get(subject, outlet, category);
  }

  function view(row) {
    return {
      subject: row.staff_id, outlet: row.outlet, category: row.category, fields: JSON.parse(row.fields),
      role: row.staff_role, enabled: !!row.enabled, updatedAt: row.updated_at,
      staffName: row.staffName, outletName: row.outletName,
    };
  }

  function regionalFields(session, outlet, fields) {
    if (session.actor !== 'regional') return fields;
    const grants = repo.context(session).grants;
    if (!grants.outlets.includes(outlet) || !grants.reviewOutlets.includes(outlet)) return [];
    return fields.filter(field => !METRICS.includes(field) || grants.metrics.includes(field));
  }

  function save(session, input, requestId) {
    managerOnly(session);
    const {subject, outlet, category: key, enabled, fields} = input;
    check(typeof subject === 'string' && codePattern.test(subject) && typeof outlet === 'string' && codePattern.test(outlet),
      'INPUT', '请选择有效的个人账号与网点');
    check(typeof enabled === 'boolean', 'INPUT', '请选择授权状态');
    const category = categoryOf(key);
    if (enabled) checkFields(fields, category);
    return store.transaction(() => {
      const previous = readGrant(subject, outlet, key);
      if (!enabled) check(previous, 'NOT_FOUND', '导出授权不存在', 404);
      const staff = personalStaff(subject);
      const role = enabled ? staff?.role : previous.staff_role;
      const nextFields = enabled ? fields : JSON.parse(previous.fields);
      if (enabled) {
        check(isActive(staff) && category.roles.includes(role), 'FORBIDDEN', '该个人岗位无此类表单访问权限', 403);
        check(db.prepare('SELECT 1 FROM outlets WHERE id=?').get(outlet), 'NOT_FOUND', '网点不存在', 404);
        const staffContext = {actor: role, role, subject, now: session.now};
        check(regionalFields(staffContext, outlet, fields).length === fields.length,
          'FORBIDDEN', '区域人员的网点审核或指标授权不足', 403);
      }
      const serialized = JSON.stringify(nextFields);
      if (previous && previous.staff_role === role && previous.fields === serialized && previous.enabled === Number(enabled)) return view(previous);
      const at = session.now;
      db.prepare(
        'INSERT INTO approval_export_grants(staff_id,outlet,category,staff_role,fields,enabled,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?) '
        + 'ON CONFLICT(staff_id,outlet,category) DO UPDATE SET staff_role=excluded.staff_role, fields=excluded.fields, '
        + 'enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      ).run(subject, outlet, key, role, serialized, Number(enabled), session.subject, at);
      writeAudit(store, session, enabled ? 'approval.export.grant.configure' : 'approval.export.grant.revoke',
        requestId, {subject, outlet, category: key, role, fields: nextFields}, at);
      return view(readGrant(subject, outlet, key));
    });
  }

  function details(session, params) {
    checkActor(session);
    const {group='grants', q='', offset: rawOffset='0'} = params;
    const offset = Number(rawOffset);
    check(['grants','staff','outlets'].includes(group) && typeof q === 'string' && q.length <= 100
      && /^\d{1,9}$/.test(rawOffset) && Number.isSafeInteger(offset), 'INPUT', '查询参数无效');
    if (group !== 'grants') managerOnly(session);
    const size = pageSize + 1;
    const term = q.trim().toLowerCase();
    if (group === 'staff' || group === 'outlets') {
      const rows = group === 'staff'
        ? db.prepare(
          "SELECT s.id,u.role,json_extract(s.data,'$.name') name FROM staffAccounts s JOIN users u ON u.actor=s.id "
          + "WHERE s.status='active' AND u.status='active' AND u.role IN ('ops','finance','regional','location') "
          + "AND (instr(lower(s.id),?)>0 OR instr(lower(json_extract(s.data,'$.name')),?)>0) ORDER BY s.id LIMIT ? OFFSET ?",
        ).all(term, term, size, offset)
        : db.prepare(
          "SELECT id,json_extract(data,'$.name') name FROM outlets "
          + "WHERE instr(lower(id),?)>0 OR instr(lower(json_extract(data,'$.name')),?)>0 ORDER BY id LIMIT ? OFFSET ?",
        ).all(term, term, size, offset);
      return {items: rows.slice(0, pageSize), hasMore: rows.length > pageSize, offset, limit: pageSize};
    }
    const manager = session.actor === 'manager';
    const where = manager ? '1' : 'p.staff_id=? AND p.staff_role=? AND p.enabled=1';
    const args = manager ? [] : [session.subject, session.actor];
    if (session.actor === 'regional') {
      const grants = repo.context(session).grants;
      args.push(JSON.stringify(grants.reviewOutlets.filter(id => grants.outlets.includes(id))));
    }
    const regionalScope = session.actor === 'regional' ? ' AND p.outlet IN (SELECT value FROM json_each(?))' : '';
    const rows = db.prepare(
      "SELECT p.*,json_extract(s.data,'$.name') staffName,json_extract(o.data,'$.name') outletName FROM approval_export_grants p "
      + 'LEFT JOIN staffAccounts s ON s.id=p.staff_id JOIN outlets o ON o.id=p.outlet '
      + 'WHERE ' + where + regionalScope
      + " AND (instr(lower(p.staff_id),?)>0 OR instr(lower(p.outlet),?)>0 OR instr(lower(json_extract(o.data,'$.name')),?)>0"
      + " OR instr(lower(json_extract(s.data,'$.name')),?)>0) ORDER BY p.updated_at DESC,p.staff_id,p.outlet,p.category LIMIT ? OFFSET ?",
    ).all(...args, term, term, term, term, size, offset);
    const items = rows.slice(0, pageSize).map(view);
    if (!manager) for (const row of items) row.fields = regionalFields(session, row.outlet, row.fields);
    return {
      items: items.filter(row => manager || row.fields.length > 0), hasMore: rows.length > pageSize, offset, limit: pageSize, canManage: manager,
      categories: Object.fromEntries(Object.entries(categories)
        .filter(([, category]) => manager || category.roles.includes(session.actor))
        .map(([key, category]) => [key, {
          label: category.label, roles: category.roles,
          statuses: category.statuses.map(status => [status, statuses[status]]),
          fields: Object.entries(category.fields).map(([field, [label]]) => [field, label]),
        }])),
    };
  }

  function file(session, query, requestId) {
    checkActor(session);
    const {category: key, outlet, month, status, from, to, fields} = query;
    check(Object.keys(query).every(key => ['category','outlet','month','status','from','to','fields'].includes(key)),
      'INPUT', '导出筛选参数无效');
    const category = categoryOf(key);
    check(typeof outlet === 'string' && codePattern.test(outlet), 'INPUT', '请选择一个已授权的网点');
    check(!month || (key !== 'requests' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)), 'INPUT', '月份筛选无效');
    check(!status || category.statuses.includes(status), 'INPUT', '状态筛选无效');
    check((!from || validDay(from)) && (!to || validDay(to)) && (!from || !to || from <= to), 'INPUT', '日期筛选无效');
    return store.transaction(() => {
      const grant = readGrant(session.subject, outlet, key);
      check(category.roles.includes(session.actor) && grant?.enabled && grant.staff_role === session.actor,
        'FORBIDDEN', '当前账号没有此网点和表单类型的导出授权', 403);
      const scope = repo.access(key, session, repo.contextState(session));
      check(scope, 'FORBIDDEN', '当前岗位无此类业务表单权限', 403);
      const authorized = regionalFields(session, outlet, JSON.parse(grant.fields));
      const selected = fields === undefined ? authorized : fields.split(',');
      check(authorized.length > 0 && selected.every(field => authorized.includes(field)),
        'FORBIDDEN', '导出字段超出当前账号授权范围', 403);
      checkFields(selected, category);
      const constraints = [
        'r.outlet=?', '(' + scope.where + ')',
        "NOT EXISTS (SELECT 1 FROM businessTasks t WHERE t.outlet=r.outlet AND t.status IN ('open','in_progress') "
          + "AND json_extract(t.data,'$.businessType')=? AND COALESCE(json_extract(t.data,'$.recordId'),json_extract(t.data,'$.businessId'))=r.id "
          + "AND COALESCE(json_extract(t.data,'$.assigneeRole'),json_extract(t.data,'$.role'))=? "
          + "AND COALESCE(json_extract(t.data,'$.assigneeUserId'),json_extract(t.data,'$.assignee'),?)<>?)",
      ];
      const args = [outlet, ...scope.params, key, session.actor, session.subject, session.subject];
      if (key === 'reports' && session.actor === 'finance') constraints.push(financeReport);
      if (key === 'requests' && session.actor === 'ops') {
        constraints.push("json_extract(r.data,'$.type') NOT IN (SELECT value FROM json_each(?))");
        args.push(JSON.stringify([...feeRequestTypes]));
      }
      if (month) { constraints.push('r.month=?'); args.push(month); }
      if (status) { constraints.push('r.status=?'); args.push(status); }
      if (from) { constraints.push("date(r.created_at,'+8 hours')>=?"); args.push(from); }
      if (to) { constraints.push("date(r.created_at,'+8 hours')<=?"); args.push(to); }
      const columns = selected.map(field => category.fields[field][1] + ' AS "' + field + '"').join(',');
      const rows = db.prepare('SELECT ' + columns + ' FROM ' + key + ' r WHERE ' + constraints.join(' AND ')
        + ' ORDER BY r.created_at DESC,r.id DESC LIMIT ?').all(...args, rowLimit + 1);
      check(rows.length <= rowLimit, 'EXPORT_LIMIT', '单份审批表单最多1000行，请缩小筛选范围', 413);
      const csv = '\uFEFF' + [selected.map(field => category.fields[field][0]), ...rows.map(row =>
        selected.map(field => field === 'status' ? statuses[row[field]] : field === 'type' ? types[row[field]] : row[field]),
      )].map(columns => columns.map(csvCell).join(',')).join('\r\n');
      writeAudit(store, session, 'approval.export.generated', requestId, {outlet, category: key, fields: selected,
        month: month || null, status: status || null, from: from || null, to: to || null}, session.now, rows.length);
      return csv;
    });
  }

  return {save, details, file};
}

module.exports = {approvalExport};
