'use strict';

const { randomUUID } = require('node:crypto');
const core = require('../shared/core.cjs');
const { effectiveGrants } = require('../shared/operations.cjs');
const { assignee } = require('../shared/responsibilities.cjs');
const { resolveAssignee } = require('../shared/task-routing.cjs');

const staffRoles = new Set(['ops', 'finance', 'location', 'support', 'regional']);
const records = new Set(['requests', 'reports', 'verifications', 'supportTickets']);

function normalizedPhone(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\+?[\d ()-]+$/.test(value.trim())) return null;
  const phone = value.trim().replace(/[ ()-]/g, '');
  return /^\+?\d{5,15}$/.test(phone) ? phone : null;
}

function identifier(value, label) {
  core.check(typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,120}$/.test(value), 'INPUT', label + '无效');
  return value;
}

function workContacts(store) {
  const { db } = store;
  const staffRow = db.prepare('SELECT s.data,u.role,u.status,c.actor AS activated FROM staffAccounts s JOIN users u ON u.actor=s.id LEFT JOIN credentials c ON c.actor=s.id WHERE s.id=?');
  const outletExists = db.prepare('SELECT 1 FROM outlets WHERE id=?');
  const contactRow = db.prepare('SELECT * FROM work_contacts WHERE staff_id=? AND outlet=?');
  const defaultRow = db.prepare('SELECT * FROM work_contacts WHERE outlet=? AND published=1 AND is_default=1');
  const taskRows = db.prepare("SELECT data FROM businessTasks WHERE outlet=? AND owner=? AND status IN ('open','in_progress') "
    + "AND json_extract(data,'$.businessType')=? AND json_extract(data,'$.businessId')=? "
    + "AND json_extract(data,'$.queue')<>'partner' ORDER BY created_at DESC,id DESC LIMIT 20");

  function staff(id) {
    const row = staffRow.get(id);
    if (!row) return null;
    const person = JSON.parse(row.data);
    return { ...person, status: row.status === 'active' ? person.status : row.status, role: row.role, activated: Boolean(row.activated) };
  }

  function eligible(person, outlet, ctx) {
    return person?.status === 'active' && person.activated && staffRoles.has(person.role)
      && (person.role !== 'regional' || effectiveGrants(person.grants, ctx).outlets.includes(outlet));
  }

  function contactFor(row, source, ctx, requiredRole) {
    if (!row?.published) return null;
    const person = staff(row.staff_id);
    if (!eligible(person, row.outlet, ctx) || person.role !== row.role || (requiredRole && person.role !== requiredRole)) return null;
    return { phone: row.phone, source };
  }

  function findAssigned(outlet, owner, type, id, ctx) {
    const source = db.prepare('SELECT data FROM ' + type + ' WHERE id=? AND owner=? AND outlet=?').get(id, owner, outlet);
    core.check(source, 'NOT_FOUND', '业务记录不存在或无权查看', 404);
    const current = JSON.parse(source.data);
    if (type === 'supportTickets' && current.status !== 'closed' && current.assignee) {
      const contact = contactFor(contactRow.get(current.assignee, outlet), 'assigned', ctx, 'support');
      if (contact) return contact;
    }
    for (const row of taskRows.all(outlet, owner, type, id)) {
      const { userId, role } = assignee(JSON.parse(row.data));
      const contact = userId && contactFor(contactRow.get(userId, outlet), 'assigned', ctx, role);
      if (contact) return contact;
    }
    return null;
  }

  function lookup(session, filters) {
    const owner = core.own(session.actor);
    core.check(owner, 'FORBIDDEN', '仅加盟商可查看本网点的工作电话', 403);
    const outlet = identifier(filters.outlet, '网点编号');
    core.check(db.prepare('SELECT 1 FROM outlets WHERE id=? AND owner=?').get(outlet, owner), 'NOT_FOUND', '网点不存在或无权查看', 404);
    const { recordType, recordId } = filters;
    let assigned;
    if (recordType !== undefined || recordId !== undefined) {
      core.check(records.has(recordType), 'INPUT', '业务类型无效');
      assigned = findAssigned(outlet, owner, recordType, identifier(recordId, '业务编号'), session);
    }
    if (assigned) return { contact: assigned };
    const standard = contactFor(defaultRow.get(outlet), 'default', session);
    if (standard) return { contact: standard };

    const rule = db.prepare("SELECT data FROM taskRoutingRules WHERE outlet=? AND status='active' "
      + "AND json_extract(data,'$.kind')='support_queue' AND json_extract(data,'$.assigneeRole')='support'").get(outlet);
    if (rule) {
      const definition = JSON.parse(rule.data), person = staff(definition.assigneeUserId);
      const selected = resolveAssignee({ taskRoutingRules: [definition], staffAccounts: person ? [person] : [], activatedStaffIds: person?.activated ? [person.id] : [] }, outlet, 'support_queue', 'support');
      const routed = selected && contactFor(contactRow.get(selected.id, outlet), 'support', session, 'support');
      if (routed) return { contact: routed };
    }

    const settings = db.prepare("SELECT value FROM settings WHERE key='supportSettings'").get();
    const phone = normalizedPhone(settings && JSON.parse(settings.value).phone);
    return { contact: phone ? { phone, source: 'headquarters' } : null };
  }

  function manage(session, filters) {
    core.check(session.actor === 'manager', 'FORBIDDEN', '仅总管理员可查看工作电话配置', 403);
    const actor = identifier(filters.actor, '员工账号');
    core.check(staff(actor), 'NOT_FOUND', '员工不存在', 404);
    const limit = Number(filters.limit ?? 50), offset = Number(filters.offset ?? 0);
    core.check(Number.isInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0,
      'INPUT', '分页范围无效');
    const rows = db.prepare("SELECT w.*,json_extract(o.data,'$.name') AS outlet_name FROM work_contacts w "
      + 'JOIN outlets o ON o.id=w.outlet WHERE w.staff_id=? ORDER BY outlet LIMIT ? OFFSET ?').all(actor, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map(row => ({
        actor: row.staff_id, outlet: row.outlet, outletName: row.outlet_name || row.outlet,
        phone: row.published ? row.phone : '', published: Boolean(row.published),
        isDefault: Boolean(row.is_default), effective: Boolean(contactFor(row, 'default', session)), updatedAt: row.updated_at,
      })),
      hasMore: rows.length > limit, offset, limit,
    };
  }

  function audit(command, session, { actor, outlet, at, requestId, isDefault }) {
    const id = 'audit-' + randomUUID();
    const record = { id, command, actor: session.actor, subject: session.subject, staffId: actor,
      outlet, requestId, isDefault, status: 'completed', createdAt: at, executedAt: at };
    db.prepare('INSERT INTO audit(id,outlet,status,data,created_at) VALUES(?,?,?,?,?)')
      .run(id, outlet, record.status, JSON.stringify(record), at);
  }

  function save(session, input, requestId) {
    core.check(session.actor === 'manager', 'FORBIDDEN', '仅总管理员可变更工作电话', 403);
    const actor = identifier(input.actor, '员工账号'), outlet = identifier(input.outlet, '网点编号');
    const { published } = input;
    core.check(typeof published === 'boolean', 'INPUT', '请选择发布或撤回');
    core.check(input.isDefault === undefined || typeof input.isDefault === 'boolean', 'INPUT', '默认联系人选择无效');
    const phone = published ? normalizedPhone(input.phone) : '';
    if (published) {
      core.check(input.confirmed === true, 'INPUT', '请确认该工作号码已获网点公开授权');
      core.check(phone, 'INPUT', '请输入有效工作号码，只可包含数字、加号、括号、空格或连字符');
    }
    const isDefault = published && input.isDefault === true;
    return store.transaction(() => {
      const person = staff(actor);
      core.check(person && outletExists.get(outlet), 'NOT_FOUND', '员工或网点不存在', 404);
      if (published) core.check(eligible(person, outlet, session), 'FORBIDDEN', '请确认员工已激活个人账号并获此网点工作电话公开授权', 403);
      const prior = contactRow.get(actor, outlet);
      if ((!prior && !published) || (prior?.published === Number(published) && prior.phone === phone
        && prior.is_default === Number(isDefault) && (!published || prior.role === person.role))) {
        return { actor, outlet, published, isDefault, changed: false };
      }
      const at = new Date().toISOString();
      const previousDefault = isDefault && defaultRow.get(outlet);
      if (previousDefault && previousDefault.staff_id !== actor) {
        db.prepare('UPDATE work_contacts SET is_default=0,updated_at=? WHERE staff_id=? AND outlet=?')
          .run(at, previousDefault.staff_id, outlet);
        audit('work_contact.default_removed', session, { actor: previousDefault.staff_id, outlet, at, requestId, isDefault: false });
      }
      db.prepare('INSERT INTO work_contacts(staff_id,outlet,role,phone,published,is_default,updated_at) VALUES(?,?,?,?,?,?,?) '
        + 'ON CONFLICT(staff_id,outlet) DO UPDATE SET role=excluded.role,phone=excluded.phone,published=excluded.published,'
        + 'is_default=excluded.is_default,updated_at=excluded.updated_at')
        .run(actor, outlet, published ? person.role : prior.role, phone, Number(published), Number(isDefault), at);
      audit(published ? 'work_contact.publish' : 'work_contact.withdraw', session, { actor, outlet, at, requestId, isDefault });
      store.sealAudit();
      return { actor, outlet, published, isDefault, changed: true };
    });
  }

  return { lookup, manage, save };
}

module.exports = { workContacts };
