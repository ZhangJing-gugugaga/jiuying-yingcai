'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { check, fail, own } = require('../shared/core.cjs');
const { effectiveGrants } = require('../shared/operations.cjs');
const responsibility = require('../shared/responsibilities.cjs');
const { sanitizeImage } = require('./uploads.cjs');

const IMAGE_LIMIT = 5 * 1024 * 1024;
const MATERIAL_REQUEST_LIMIT = 7 * 1024 * 1024 + 1024;
const PREFIX = '/api/training/';
const MATERIAL_TASK = 'training_material_returned';
const TRAINING_RECORD = 'trainingRecords';
const STATUSES = ['in_progress', 'submitted', 'returned', 'materials_approved', 'completed'];
const REVIEW = {
  return: { from: 'submitted', to: 'returned' },
  accept: { from: 'submitted', to: 'materials_approved' },
  complete: { from: 'materials_approved', to: 'completed' },
};
const FILE_TYPES = {
  'image/jpeg': /\.jpe?g$/i,
  'image/png': /\.png$/i,
  'image/webp': /\.webp$/i,
};

const hash = value => createHash('sha256').update(value).digest('hex');
const courseView = row => ({
  id: row.id, title: row.title, content: row.content, status: row.status, version: row.version,
  publishedAt: row.published_at, updatedAt: row.updated_at,
});
const materialView = row => ({
  id: row.id, revision: row.revision, name: row.name, contentType: row.mime, size: row.size, createdAt: row.created_at,
});
const recordView = (row, showReviewer) => ({
  id: row.id, courseId: row.course_id, courseTitle: row.course_title, outletId: row.outlet_id,
  outletName: row.outlet_name, learner: row.learner, status: row.status, version: row.version,
  note: row.note, updatedAt: row.updated_at, completedAt: row.completed_at,
  ...(showReviewer ? { reviewedBy: row.reviewed_by } : {}),
});

function text(value, label, max) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  check(cleaned.length > 0 && cleaned.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned),
    'INPUT', label + '须填写且不超过' + max + '个字符');
  return cleaned;
}

function identifier(value, label) {
  check(typeof value === 'string' && /^[\w-]{1,100}$/.test(value), 'INPUT', label + '无效');
  return value;
}

function pagination(query) {
  const limit = Math.min(Number(query.get('limit') ?? 25), 50);
  const offset = Number(query.get('offset') ?? 0);
  check(Number.isSafeInteger(limit) && limit >= 1 && Number.isSafeInteger(offset) && offset >= 0, 'INPUT', '分页参数无效');
  return { limit, offset };
}

function page(rows, { limit, offset }, project) {
  return { items: rows.slice(0, limit).map(project), nextOffset: rows.length > limit ? offset + limit : null };
}

function imageInput(p) {
  const accepted = typeof p.type === 'string' && Object.hasOwn(FILE_TYPES, p.type) && FILE_TYPES[p.type];
  check(accepted && typeof p.name === 'string' && p.name.length <= 120 &&
    !/[/\\:\u0000-\u001f\u007f]/.test(p.name) && accepted.test(p.name),
  'INPUT', '请选择 PNG、JPEG 或 WebP 图片');
  check(typeof p.base64 === 'string' && p.base64.length <= 7 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(p.base64), 'INPUT', '图片内容无效');
  const bytes = Buffer.from(p.base64, 'base64');
  check(bytes.length > 0 && bytes.length <= IMAGE_LIMIT && bytes.toString('base64') === p.base64,
    'INPUT', '图片内容无效或超过5MB');
  return bytes;
}

function trainingService(store) {
  const db = store.db;
  const recordSelect = `SELECT r.*, c.title AS course_title, json_extract(o.data,'$.name') AS outlet_name
    FROM training_records r JOIN training_courses c ON c.id=r.course_id JOIN outlets o ON o.id=r.outlet_id`;
  const now = () => new Date().toISOString();

  function regionalOutlets(subject) {
    const staff = db.prepare('SELECT data FROM staffAccounts WHERE id=? AND status=?').get(subject, 'active');
    const account = staff && JSON.parse(staff.data);
    if (account?.role !== 'regional') return [];
    const grants = effectiveGrants(account.grants);
    return grants.reviewOutlets.filter(outlet => grants.outlets.includes(outlet));
  }

  function access(who) {
    const owner = own(who.actor);
    if (owner) return { owner };
    if (who.actor === 'manager') return { manager: true };
    check(who.actor === 'regional', 'FORBIDDEN', '当前账号无权查看培训资料', 403);
    const authorized = new Set(db.prepare('SELECT outlet_id FROM training_review_grants WHERE subject=? AND enabled=1')
      .all(who.subject).map(row => row.outlet_id));
    return { outlets: regionalOutlets(who.subject).filter(outlet => authorized.has(outlet)) };
  }

  function requireManager(who) {
    check(who.actor === 'manager', 'FORBIDDEN', '仅总部管理人员可维护培训课程', 403);
  }

  function scope(who) {
    const allowed = access(who);
    if (allowed.manager) return { where: '1', params: [] };
    if (allowed.owner) return { where: 'r.owner=? AND o.owner=?', params: [allowed.owner, allowed.owner] };
    const outlets = allowed.outlets;
    return outlets.length
      ? { where: `r.outlet_id IN (${outlets.map(() => '?').join(',')})`, params: outlets }
      : { where: '0', params: [] };
  }

  function course(id) {
    const row = db.prepare('SELECT * FROM training_courses WHERE id=?').get(id);
    check(row, 'NOT_FOUND', '课程不存在', 404);
    return row;
  }

  function scopedRecord(who, id) {
    const { where, params } = scope(who);
    const row = db.prepare(`${recordSelect} WHERE r.id=? AND (${where})`).get(id, ...params);
    check(row, 'NOT_FOUND', '学员培训记录不存在或无权查看', 404);
    return row;
  }

  function recordDetail(who, id, query) {
    const record = scopedRecord(who, id);
    const outlet = query.get('outlet');
    check(outlet === null || outlet === record.outlet_id, 'NOT_FOUND', '学员培训记录不存在或无权查看', 404);
    return recordView(record, !own(who.actor));
  }

  function requestMaterialUpdate(record, requestId, at) {
    const { id: recordId, owner, outlet_id: outlet } = record;
    const taskKey = [MATERIAL_TASK, recordId, record.version + 1].join('|');
    const responsibilityKey = responsibility.partnerKey(MATERIAL_TASK, record);
    const id = 'task-' + randomUUID();
    const title = '学员资料需补充';
    const task = {
      id, owner, outlet, role: 'partner', month: null, target: 'training', recordId, taskKey,
      kind: MATERIAL_TASK, title, status: 'open', internal: false, createdAt: at, updatedAt: at,
      ...responsibility.metadata({ kind: MATERIAL_TASK, role: 'partner', queue: 'partner',
        businessType: TRAINING_RECORD, businessId: recordId, owner, key: taskKey,
        scopeKey: responsibilityKey, ctx: { requestId } }),
    };
    const message = {
      id: 'msg-' + randomUUID(), owner, outlet, target: 'training', recordId, taskId: id, title,
      body: '请查看总部意见并补交资料。', status: 'unread', read: false, createdAt: at,
    };
    store.save({ businessTasks: [task], messages: [message] });
  }

  function completeMaterialUpdate(record, at) {
    const key = responsibility.partnerKey(MATERIAL_TASK, record);
    const row = db.prepare(`SELECT data FROM businessTasks WHERE owner=? AND outlet=? AND status IN ('open','in_progress')
      AND json_extract(data,'$.responsibilityKey')=?`).get(record.owner, record.outlet_id, key);
    if (!row) return;
    const task = JSON.parse(row.data);
    responsibility.close(task, at, 'business_fact');
    store.save({ businessTasks: [task] });
  }

  function outletAllowed(who, id, { write = false } = {}) {
    const allowed = access(who);
    const outlet = db.prepare('SELECT owner,status FROM outlets WHERE id=?').get(id);
    check(outlet && (allowed.manager || allowed.owner === outlet.owner ||
      allowed.outlets?.includes(id)), 'FORBIDDEN', '当前账号无权查看此网点培训记录', 403);
    if (write) check(outlet.status !== 'closed', 'TRANSITION', '该网点已关闭，无法新建学员记录', 409);
    return outlet;
  }

  function audit(who, requestId, command, details) {
    const createdAt = now();
    const record = {
      id: 'audit-' + randomUUID(), actor: who.actor, subject: who.subject, command,
      status: 'completed', requestId, createdAt, executedAt: createdAt, ...details,
    };
    db.prepare('INSERT INTO audit(id,owner,outlet,status,data,created_at) VALUES(?,?,?,?,?,?)')
      .run(record.id, record.owner || null, record.outlet || null, record.status, JSON.stringify(record), createdAt);
    store.sealAudit();
  }

  function replay(who, key, fingerprint) {
    check(typeof key === 'string' && key.length >= 8 && key.length <= 128,
      'IDEMPOTENCY_KEY', '处理标识无效，请刷新后重试');
    const prior = db.prepare('SELECT request_hash,result FROM idempotency WHERE subject=? AND key=?').get(who.subject, key);
    if (!prior) return null;
    check(prior.request_hash === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一处理标识只能提交同一项内容', 409);
    return JSON.parse(prior.result);
  }

  function transaction(who, key, fingerprint, authorize, apply) {
    return store.transaction(() => {
      const target = authorize();
      const cached = replay(who, key, fingerprint);
      if (cached) return cached;
      const result = apply(target);
      db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)')
        .run(who.subject, key, fingerprint, JSON.stringify(result), now());
      return result;
    });
  }

  function courses(who, query) {
    const allowed = access(who);
    const { limit, offset } = pagination(query);
    const rows = db.prepare(`SELECT * FROM training_courses ${allowed.manager ? '' : "WHERE status='published'"}
      ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    return page(rows, { limit, offset }, courseView);
  }

  function records(who, query) {
    const { where, params } = scope(who);
    const filters = [where];
    const outlet = query.get('outlet');
    if (outlet) {
      outletAllowed(who, identifier(outlet, '网点'));
      filters.push('r.outlet_id=?');
      params.push(outlet);
    }
    const courseId = query.get('course');
    if (courseId) {
      filters.push('r.course_id=?');
      params.push(identifier(courseId, '课程'));
    }
    const status = query.get('status');
    if (status) {
      check(STATUSES.includes(status), 'INPUT', '进度状态无效');
      filters.push('r.status=?');
      params.push(status);
    }
    const { limit, offset } = pagination(query);
    const rows = db.prepare(`${recordSelect} WHERE ${filters.map(filter => '(' + filter + ')').join(' AND ')}
      ORDER BY r.updated_at DESC,r.id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    return page(rows, { limit, offset }, row => recordView(row, !own(who.actor)));
  }

  function outlets(who, query) {
    const allowed = access(who);
    const { limit, offset } = pagination(query);
    const filters = [];
    const params = [];
    if (allowed.owner) {
      filters.push('owner=?');
      params.push(allowed.owner);
    } else if (!allowed.manager) {
      if (!allowed.outlets.length) return { items: [], nextOffset: null };
      filters.push(`id IN (${allowed.outlets.map(() => '?').join(',')})`);
      params.push(...allowed.outlets);
    }
    const search = query.get('q')?.trim();
    if (search) {
      filters.push("INSTR(COALESCE(json_extract(data,'$.name'),''),?)>0");
      params.push(text(search, '网点名称', 80));
    }
    const rows = db.prepare(`SELECT id, json_extract(data,'$.name') AS name FROM outlets
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY name,id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    return page(rows, { limit, offset }, row => ({ id: row.id, name: row.name }));
  }

  function writeCourse(who, id, body, key, fingerprint, requestId) {
    const authorize = () => {
      requireManager(who);
      return id ? course(id) : null;
    };
    return transaction(who, key, fingerprint, authorize, current => {
      const at = now();
      if (!current) {
        const nextId = 'course-' + randomUUID();
        db.prepare(`INSERT INTO training_courses(id,title,content,status,created_at,updated_at)
          VALUES(?,?,?,'draft',?,?)`).run(nextId, text(body.title, '课程名称', 100), text(body.content, '课程内容', 8000), at, at);
        audit(who, requestId, 'training.course.create', { recordId: nextId, nextStatus: 'draft' });
        return courseView(course(nextId));
      }
      const status = body.status;
      const transitions = { draft: ['draft', 'published'], published: ['archived'], archived: [] };
      if (status === 'draft' || body.version !== undefined) {
        check(body.version === current.version, 'STALE_RECORD', '课程已更新，请刷新后处理', 409);
      }
      check(transitions[current.status].includes(status), 'TRANSITION', '该课程已更新，请刷新后查看', 409);
      if (status === 'draft') {
        db.prepare('UPDATE training_courses SET title=?,content=?,version=version+1,updated_at=? WHERE id=?')
          .run(text(body.title, '课程名称', 100), text(body.content, '课程内容', 8000), at, id);
      } else {
        db.prepare('UPDATE training_courses SET status=?,published_at=?,version=version+1,updated_at=? WHERE id=?')
          .run(status, status === 'published' ? at : current.published_at, at, id);
      }
      audit(who, requestId, 'training.course.' + status, { recordId: id, previousStatus: current.status, nextStatus: status });
      return courseView(course(id));
    });
  }

  function reviewGrants(who, query) {
    requireManager(who);
    const { limit, offset } = pagination(query);
    const rows = db.prepare(`SELECT g.subject,g.outlet_id,g.enabled,g.updated_at,
      json_extract(s.data,'$.name') AS staff_name,json_extract(o.data,'$.name') AS outlet_name
      FROM training_review_grants g JOIN staffAccounts s ON s.id=g.subject JOIN outlets o ON o.id=g.outlet_id
      ORDER BY g.updated_at DESC,g.subject,g.outlet_id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    return page(rows, { limit, offset }, row => ({
      staffId: row.subject, staffName: row.staff_name, outletId: row.outlet_id, outletName: row.outlet_name,
      enabled: Boolean(row.enabled), updatedAt: row.updated_at,
    }));
  }

  function writeReviewGrant(who, body, key, fingerprint, requestId) {
    const staffId = identifier(body.staffId, '员工账号');
    const outletId = identifier(body.outletId, '网点');
    const enabled = body.enabled;
    check(typeof enabled === 'boolean', 'INPUT', '请选择授权或撤销');
    return transaction(who, key, fingerprint, () => requireManager(who), () => {
      if (enabled) {
        check(regionalOutlets(staffId).includes(outletId), 'FORBIDDEN', '该区域运营人员未获此网点审核授权', 403);
      } else {
        check(db.prepare('SELECT 1 FROM training_review_grants WHERE subject=? AND outlet_id=?').get(staffId, outletId),
          'NOT_FOUND', '该人员在此网点尚无培训审核授权', 404);
      }
      db.prepare(`INSERT INTO training_review_grants(subject,outlet_id,enabled,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(subject,outlet_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(staffId, outletId, enabled ? 1 : 0, now());
      audit(who, requestId, enabled ? 'training.review.grant' : 'training.review.revoke',
        { outlet: outletId, targetStaff: staffId });
      return { staffId, outletId, enabled };
    });
  }

  function begin(who, body, key, fingerprint, requestId) {
    const owner = own(who.actor);
    check(owner, 'FORBIDDEN', '请由网点负责人登记学员', 403);
    const outlet = identifier(body.outletId, '网点');
    const courseId = identifier(body.courseId, '课程');
    const learner = text(body.learner, '学员姓名或培训编号', 40);
    check(!/[\r\n\t]/.test(learner), 'INPUT', '请填写单行学员姓名或培训编号');
    const learnerKey = learner.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
    return transaction(who, key, fingerprint, () => outletAllowed(who, outlet, { write: true }), () => {
      check(course(courseId).status === 'published', 'TRANSITION', '该课程暂未开放登记', 409);
      check(!db.prepare('SELECT 1 FROM training_records WHERE course_id=? AND outlet_id=? AND owner=? AND learner_key=?')
        .get(courseId, outlet, owner, learnerKey), 'DUPLICATE', '该学员已登记，请打开现有记录', 409);
      const id = 'training-' + randomUUID();
      const at = now();
      db.prepare(`INSERT INTO training_records(id,course_id,outlet_id,owner,learner,learner_key,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'in_progress',?,?)`).run(id, courseId, outlet, owner, learner, learnerKey, at, at);
      audit(who, requestId, 'training.begin', { owner, outlet, recordId: id, nextStatus: 'in_progress' });
      return recordView(scopedRecord(who, id), false);
    });
  }

  async function submit(who, id, body, key, fingerprint, requestId, reauthorize) {
    check(own(who.actor), 'FORBIDDEN', '请由网点负责人上传学员资料', 403);
    const record = scopedRecord(who, id);
    const cached = replay(who, key, fingerprint);
    if (cached) return cached;
    check(['in_progress', 'returned'].includes(record.status), 'TRANSITION', '当前进度暂不能上传资料', 409);
    const image = await sanitizeImage(imageInput(body), body.type, body.name);
    return transaction(who, key, fingerprint, () => scopedRecord(reauthorize(), id), current => {
      check(['in_progress', 'returned'].includes(current.status), 'TRANSITION', '当前进度暂不能上传资料', 409);
      check(record.version === current.version, 'STALE_RECORD', '记录已更新，请刷新后提交', 409);
      const previous = db.prepare('SELECT max(revision) AS revision FROM training_materials WHERE record_id=?').get(id).revision || 0;
      const at = now();
      db.prepare(`INSERT INTO training_materials(id,record_id,revision,name,mime,size,digest,original_digest,transform_version,bytes,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('training-file-' + randomUUID(), id, previous + 1, image.name,
        image.type, image.bytes.length, hash(image.bytes), image.originalDigest, image.transformVersion, image.bytes, at);
      db.prepare("UPDATE training_records SET status='submitted',version=version+1,note='',reviewed_by=NULL,updated_at=? WHERE id=?").run(at, id);
      if (current.status === 'returned') completeMaterialUpdate(current, at);
      audit(who, requestId, 'training.submit', { owner: record.owner, outlet: record.outlet_id, recordId: id,
        previousStatus: current.status, nextStatus: 'submitted', materialRevision: previous + 1 });
      return recordView(scopedRecord(who, id), false);
    });
  }

  function review(who, id, body, key, fingerprint, requestId) {
    check(['manager', 'regional'].includes(who.actor), 'FORBIDDEN', '当前账号无权审核培训资料', 403);
    const action = body.action;
    check(typeof action === 'string' && Object.hasOwn(REVIEW, action), 'INPUT', '进度处理方式无效');
    const note = text(body.note, '处理说明', 500);
    return transaction(who, key, fingerprint, () => scopedRecord(who, id), record => {
      check(body.version === record.version, 'STALE_RECORD', '记录已更新，请刷新后处理', 409);
      const { from, to } = REVIEW[action];
      check(record.status === from, 'TRANSITION', '当前进度不能执行此操作', 409);
      const at = now();
      db.prepare('UPDATE training_records SET status=?,version=version+1,note=?,reviewed_by=?,updated_at=?,completed_at=? WHERE id=?')
        .run(to, note, who.subject, at, to === 'completed' ? at : null, id);
      db.prepare('INSERT INTO training_reviews(record_id,version,status,note,reviewer,request_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, record.version + 1, to, note, who.subject, requestId, at);
      if (to === 'returned') requestMaterialUpdate(record, requestId, at);
      audit(who, requestId, 'training.' + action, { owner: record.owner, outlet: record.outlet_id,
        recordId: id, previousStatus: from, nextStatus: to });
      return recordView(scopedRecord(who, id), true);
    });
  }

  function materials(who, id, query) {
    scopedRecord(who, id);
    const { limit, offset } = pagination(query);
    const rows = db.prepare(`SELECT id,revision,name,mime,size,created_at FROM training_materials WHERE record_id=?
      ORDER BY revision DESC LIMIT ? OFFSET ?`).all(id, limit + 1, offset);
    return page(rows, { limit, offset }, materialView);
  }

  function history(who, id, query) {
    scopedRecord(who, id);
    const { limit, offset } = pagination(query);
    const rows = db.prepare('SELECT * FROM training_reviews WHERE record_id=? ORDER BY version DESC LIMIT ? OFFSET ?')
      .all(id, limit + 1, offset);
    const administrative = !own(who.actor);
    return page(rows, { limit, offset }, row => ({
      version: row.version, status: row.status, note: row.note, createdAt: row.created_at,
      ...(administrative ? { reviewedBy: row.reviewer, requestId: row.request_id } : {}),
    }));
  }

  function download(who, id, response) {
    access(who);
    const link = db.prepare('SELECT record_id FROM training_materials WHERE id=?').get(id);
    check(link, 'NOT_FOUND', '培训资料不存在', 404);
    scopedRecord(who, link.record_id);
    const file = db.prepare('SELECT bytes,mime,name,size FROM training_materials WHERE id=?').get(id);
    response.writeHead(200, {
      'Content-Type': file.mime, 'Content-Length': file.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)),
    });
    return response.end(Buffer.from(file.bytes));
  }

  return async function handle({ route, req, res, query, session, requestId, readJson, reauthorize, respond }) {
    const relative = route.slice(PREFIX.length);
    const isRead = req.method === 'GET';
    const courseRoute = /^courses\/([\w-]{1,100})$/.exec(relative);
    const recordRoute = /^records\/([\w-]{1,100})$/.exec(relative);
    const recordsRoute = /^records\/([\w-]{1,100})\/(materials|review|history)$/.exec(relative);
    const downloadRoute = /^materials\/([\w-]{1,100})\/content$/.exec(relative);
    if (isRead) {
      if (relative === 'courses') return respond(200, { data: courses(session, query), requestId });
      if (relative === 'records') return respond(200, { data: records(session, query), requestId });
      if (recordRoute) return respond(200, { data: recordDetail(session, recordRoute[1], query), requestId });
      if (relative === 'outlets') return respond(200, { data: outlets(session, query), requestId });
      if (relative === 'review-grants') return respond(200, { data: reviewGrants(session, query), requestId });
      if (recordsRoute?.[2] === 'materials') return respond(200, { data: materials(session, recordsRoute[1], query), requestId });
      if (recordsRoute?.[2] === 'history') return respond(200, { data: history(session, recordsRoute[1], query), requestId });
      if (downloadRoute) return download(session, downloadRoute[1], res);
    } else if (req.method === 'POST') {
      const fileUpload = recordsRoute?.[2] === 'materials';
      if (fileUpload) {
        check(own(session.actor), 'FORBIDDEN', '请由网点负责人上传学员资料', 403);
        scopedRecord(session, recordsRoute[1]);
      }
      if (relative === 'courses' || courseRoute || relative === 'review-grants') requireManager(session);
      if (relative === 'courses' || courseRoute || relative === 'records' ||
        recordsRoute && recordsRoute[2] !== 'history' || relative === 'review-grants') {
        const body = await readJson(fileUpload ? MATERIAL_REQUEST_LIMIT : 32 * 1024);
        const key = req.headers['idempotency-key'];
        const fingerprint = hash(JSON.stringify({ route, body }));
        const current = reauthorize();
        if (relative === 'review-grants') return respond(200, {
          data: writeReviewGrant(current, body, key, fingerprint, requestId), requestId,
        });
        if (relative === 'courses' || courseRoute) {
          const data = writeCourse(current, courseRoute?.[1], body, key, fingerprint, requestId);
          return respond(courseRoute ? 200 : 201, { data, requestId });
        }
        if (relative === 'records') return respond(201, { data: begin(current, body, key, fingerprint, requestId), requestId });
        const [ , id, action] = recordsRoute;
        const data = action === 'materials'
          ? await submit(current, id, body, key, fingerprint, requestId, reauthorize)
          : review(current, id, body, key, fingerprint, requestId);
        return respond(200, { data, requestId });
      }
    }
    fail('NOT_FOUND', '培训接口不存在', 404);
  };
}

module.exports = { trainingService, PREFIX };
