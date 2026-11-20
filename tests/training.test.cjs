'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');

async function fixture(t) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const call = async (route, { token, body, key = randomUUID() } = {}) => {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
      },
      body: body && JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const json = type.includes('application/json') ? await response.json() : null;
    return { status: response.status, ...json, response };
  };
  const login = async actor => (await call('/api/auth/dev', { body: { actor } })).data.token;
  const manager = await login('manager');
  const partner = await login('partnerA');
  const other = await login('partnerB');
  const publicToken = await login('public');
  const create = (token, title) => call('/api/training/courses', { token, body: { title, content: '先核对受理记录，再记录培训情况。' } });
  const changeCourse = (id, status, token = manager) => call('/api/training/courses/' + id, { token, body: { status } });
  const begin = (courseId, token = partner, outletId = 'cs', learner = '培训编号-A23') =>
    call('/api/training/records', { token, body: { courseId, outletId, learner } });
  const submit = (id, material, token = partner, key) =>
    call('/api/training/records/' + id + '/materials', { token, body: material, key });
  const review = (id, action, version, token = manager) => call('/api/training/records/' + id + '/review', {
    token, body: { action, version, note: '隔离验证依据' },
  });
  const material = {
    name: '培训记录.jpg', type: 'image/jpeg', base64: (await sharp({
      create: { width: 18, height: 12, channels: 3, background: '#172a50' },
    }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'remove from evidence' } } }).toBuffer()).toString('base64'),
  };
  async function publish() {
    const drafted = await create(manager, '隔离验收课程');
    assert.equal(drafted.status, 201, drafted.error?.message);
    const published = await changeCourse(drafted.data.id, 'published');
    assert.equal(published.status, 200, published.error?.message);
    return published.data;
  }
  return { app, base, manager, partner, other, publicToken, login, call, create, changeCourse, begin, submit, review, material, publish };
}

test('training starts empty; only manager can create and publish and a partner can read published content', async t => {
  const f = await fixture(t);
  const empty = await f.call('/api/training/courses', { token: f.partner });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.items, []);
  assert.equal((await f.call('/api/training/courses', { token: f.publicToken })).status, 403);
  assert.equal((await f.create(f.partner, '越权课程')).status, 403);
  const draft = await f.create(f.manager, '网点规范操作');
  assert.equal(draft.status, 201);
  assert.equal(draft.data.status, 'draft');
  assert.deepEqual((await f.call('/api/training/courses', { token: f.partner })).data.items, []);
  assert.equal((await f.begin(draft.data.id)).status, 409);
  assert.equal((await f.changeCourse(draft.data.id, 'published', f.partner)).status, 403);
  assert.equal((await f.changeCourse(draft.data.id, 'published')).status, 200);
  const course = (await f.call('/api/training/courses', { token: f.partner })).data.items[0];
  assert.equal(course.title, '网点规范操作');
  assert.equal(course.content, '先核对受理记录，再记录培训情况。');
  assert.equal((await f.begin(course.id, f.other)).status, 403);
  const record = await f.begin(course.id);
  assert.equal(record.status, 201);
  assert.equal(record.data.status, 'in_progress');
  assert.equal((await f.begin(course.id)).status, 409);
  assert.equal((await f.changeCourse(course.id, 'archived')).status, 200);
  assert.deepEqual((await f.call('/api/training/courses', { token: f.partner })).data.items, []);
  assert.equal((await f.begin(course.id, f.partner, 'cs', '培训编号-B')).status, 409);
  const persisted = (await f.call('/api/training/records?outlet=cs', { token: f.partner })).data.items[0];
  assert.equal(persisted.id, record.data.id);
  assert.equal(persisted.courseTitle, course.title);
});

test('training material bytes stay isolated, are sanitized and replay once with retrievable history', async t => {
  const f = await fixture(t);
  const course = await f.publish();
  const record = (await f.begin(course.id)).data;
  assert.equal((await f.submit(record.id, f.material, f.other)).status, 404);
  assert.equal((await f.submit(record.id, { ...f.material, name: '伪装.pdf' })).status, 400);
  assert.equal((await f.submit(record.id, { ...f.material, base64: 'bm90IGFuIGltYWdl' })).status, 400);
  const key = randomUUID();
  const submitted = await f.submit(record.id, f.material, f.partner, key);
  assert.equal(submitted.status, 200, submitted.error?.message);
  assert.equal(submitted.data.status, 'submitted');
  const replay = await f.submit(record.id, f.material, f.partner, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.version, submitted.data.version);
  assert.equal((await f.submit(record.id, { ...f.material, name: '不同记录.jpg' }, f.partner, key)).status, 409);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS count FROM training_materials').get().count, 1);
  const materials = (await f.call('/api/training/records/' + record.id + '/materials', { token: f.partner })).data.items;
  const attachment = '/api/training/materials/' + materials[0].id + '/content';
  assert.equal((await f.call(attachment, { token: f.other })).status, 404);
  assert.equal((await f.call(attachment, { token: f.publicToken })).status, 403);
  assert.equal((await f.call(attachment)).status, 401);
  assert.equal((await f.call('/api/files/' + materials[0].id, { token: f.manager })).status, 404);
  const response = await f.call(attachment, { token: f.manager });
  assert.equal(response.status, 200);
  const decoded = await sharp(Buffer.from(await response.response.arrayBuffer())).metadata();
  assert.equal(decoded.width, 18);
  assert.equal(decoded.exif, undefined);
  const returned = await f.review(record.id, 'return', submitted.data.version);
  assert.equal(returned.status, 200);
  assert.equal(returned.data.status, 'returned');
  assert.equal((await f.submit(record.id, f.material)).status, 200);
  const revised = (await f.call('/api/training/records/' + record.id + '/materials', { token: f.partner })).data.items;
  assert.equal(revised.length, 2);
  assert.equal(revised[1].id, materials[0].id);
  const historyRoute = '/api/training/records/' + record.id + '/history';
  const history = await f.call(historyRoute, { token: f.partner });
  assert.equal(history.status, 200);
  assert.equal(history.data.items[0].status, 'returned');
  assert.equal(history.data.items[0].note, '隔离验证依据');
  assert.equal(history.data.items[0].reviewedBy, undefined);
  const administrative = await f.call(historyRoute, { token: f.manager });
  assert.equal(administrative.data.items[0].reviewedBy, 'manager');
  assert.equal((await f.call(historyRoute, { token: f.other })).status, 404);
});

test('regional access follows review scope, decisions require current version and completion is explicit', async t => {
  const f = await fixture(t);
  const course = await f.publish();
  const started = (await f.begin(course.id)).data;
  const submission = (await f.submit(started.id, f.material)).data;
  const staff = await f.call('/api/commands', { token: f.manager, body: { command: 'staff.create', payload: {
    subject: 'training-regional-test', name: '隔离区域经办人', role: 'regional',
    grants: { outlets: ['cs', 'zz'], metrics: ['orders'], reviewOutlets: ['cs'] }, reason: '培训隔离验收',
  } } });
  assert.equal(staff.status, 200);
  const regional = await f.login('training-regional-test');
  const scope = '/api/training/review-grants';
  const grant = { staffId: 'training-regional-test', outletId: 'cs', enabled: true };
  assert.equal((await f.call('/api/training/records?outlet=cs', { token: regional })).status, 403);
  assert.equal((await f.call(scope, { token: regional, body: grant })).status, 403);
  assert.equal((await f.call(scope, { token: f.manager, body: { ...grant, outletId: 'zz' } })).status, 403);
  assert.equal((await f.call(scope, { token: f.manager, body: grant })).status, 200);
  const otherLocation = (await f.begin(course.id, f.partner, 'zz', '培训编号-Z')).data;
  assert.equal((await f.call('/api/training/records?outlet=zz', { token: regional })).status, 403);
  assert.equal((await f.review(otherLocation.id, 'accept', otherLocation.version, regional)).status, 404);
  const allowed = (await f.call('/api/training/records?outlet=cs', { token: regional })).data.items;
  assert.equal(allowed[0].id, started.id);
  assert.equal((await f.review(started.id, 'accept', submission.version, f.partner)).status, 403);
  assert.equal((await f.review(started.id, 'complete', submission.version, regional)).status, 409);
  assert.equal((await f.review(started.id, 'accept', started.version, regional)).status, 409);
  const accepted = await f.review(started.id, 'accept', submission.version, regional);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.status, 'materials_approved');
  assert.equal(accepted.data.completedAt, null);
  const completion = await f.review(started.id, 'complete', accepted.data.version, regional);
  assert.equal(completion.status, 200);
  assert.equal(completion.data.status, 'completed');
  assert.ok(completion.data.completedAt);
  const partnerRead = (await f.call('/api/training/records?outlet=cs', { token: f.partner })).data.items[0];
  assert.equal(partnerRead.status, 'completed');
  assert.equal(partnerRead.note, '隔离验证依据');
  assert.equal(partnerRead.reviewedBy, undefined);
  const audits = f.app.store.db.prepare("SELECT data FROM audit WHERE json_extract(data,'$.command') LIKE 'training.%'").all().map(row => JSON.parse(row.data));
  assert.ok(audits.some(row => row.command === 'training.complete' && row.subject === 'training-regional-test' && row.recordId === started.id && row.requestId));
  assert.ok(audits.every(row => !row.learner && !row.base64));
  assert.equal((await f.call(scope, { token: f.manager, body: { ...grant, enabled: false } })).status, 200);
  assert.equal((await f.call('/api/training/records?outlet=cs', { token: regional })).status, 403);
  assert.equal((await f.call(scope, { token: f.manager, body: grant })).status, 200);
  for (const reviewOutlets of [[], ['cs']]) {
    const changed = await f.call('/api/commands', { token: f.manager, body: { command: 'staff.update', payload: {
      id: grant.staffId, status: 'active', reason: '隔离验证区域授权变更',
      grants: { outlets: ['cs', 'zz'], metrics: ['orders'], reviewOutlets },
    } } });
    assert.equal(changed.status, 200);
  }
  const relogin = await f.login(grant.staffId);
  assert.equal((await f.call('/api/training/records?outlet=cs', { token: relogin })).status, 403);
  t.diagnostic(JSON.stringify({ courseId: course.id, recordId: started.id, submit: submission.status, complete: completion.requestId }));
});

test('returned training notifies its owner and only a successful resubmission completes that record task', async t => {
  const f = await fixture(t);
  const course = await f.publish();
  const first = (await f.begin(course.id, f.partner, 'cs', '学员资料隐私样例-A')).data;
  const second = (await f.begin(course.id, f.partner, 'zz', '学员资料隐私样例-B')).data;
  const returned = [];
  for (const record of [first, second]) {
    const submission = await f.submit(record.id, f.material);
    const key = randomUUID();
    const reviewBody = { action: 'return', version: submission.data.version, note: '请更换这一页照片' };
    const route = '/api/training/records/' + record.id + '/review';
    const review = await f.call(route, { token: f.manager, body: reviewBody, key });
    assert.equal(review.status, 200);
    assert.deepEqual((await f.call(route, { token: f.manager, body: reviewBody, key })).data, review.data);
    returned.push(review.data);
  }

  const taskRoute = '/api/tasks?queue=partner&kind=training_material_returned';
  const messages = (await f.call('/api/collections/messages', { token: f.partner })).data.items
    .filter(message => message.target === 'training');
  const tasks = (await f.call(taskRoute, { token: f.partner })).data.items;
  assert.equal(messages.length, 2);
  assert.equal(tasks.length, 2);
  assert.deepEqual((await f.call(taskRoute, { token: f.other })).data.items, []);
  assert.equal((await f.call('/api/collections/messages', { token: f.other })).data.items
    .filter(message => message.target === 'training').length, 0);

  for (const record of returned) {
    const message = messages.find(row => row.recordId === record.id);
    const task = tasks.find(row => row.recordId === record.id);
    assert.equal(message.taskId, task.id);
    assert.equal(message.outlet, record.outletId);
    assert.equal(task.outlet, record.outletId);
    assert.equal(task.status, 'open');
    assert.doesNotMatch(JSON.stringify([message, task]), /学员资料隐私样例|请更换这一页照片/);
    const route = '/api/training/records/' + record.id + '?outlet=';
    const detail = await f.call(route + record.outletId, { token: f.partner });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.id, record.id);
    assert.equal(detail.data.outletId, record.outletId);
    assert.equal(detail.data.note, '请更换这一页照片');
    assert.equal(detail.data.reviewedBy, undefined);
    assert.equal((await f.call(route + record.outletId, { token: f.other })).status, 404);
    assert.equal((await f.call(route + (record.outletId === 'cs' ? 'zz' : 'cs'), { token: f.partner })).status, 404);
  }

  const firstMessage = messages.find(row => row.recordId === first.id);
  assert.equal((await f.call('/api/commands', { token: f.partner, body: { command: 'message.read', payload: { id: firstMessage.id } } })).status, 200);
  assert.equal((await f.submit(first.id, { ...f.material, name: '错误文件.pdf' })).status, 400);
  assert.equal((await f.call(taskRoute, { token: f.partner })).data.items.length, 2);

  const submitted = await f.submit(first.id, f.material);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.status, 'submitted');
  const current = (await f.call(taskRoute, { token: f.partner })).data.items;
  const completed = (await f.call(taskRoute + '&status=resolved', { token: f.partner })).data.items;
  assert.deepEqual(current.map(task => task.recordId), [second.id]);
  assert.deepEqual(completed.map(task => task.recordId), [first.id]);
  assert.ok(completed[0].completedAt);
});

test('training native page connects selected course, outlet, local image and live server result', async t => {
  const f = await fixture(t);
  const course = await f.publish();
  const config = require('../miniprogram/config');
  const original = config.apiBase;
  config.apiBase = f.base;
  const originalWx = global.wx;
  const originalPage = global.Page;
  const originalPages = global.getCurrentPages;
  const source = require.resolve('../miniprogram/pages/training/index.js');
  t.after(() => {
    config.apiBase = original;
    global.wx = originalWx;
    global.Page = originalPage;
    global.getCurrentPages = originalPages;
    delete require.cache[source];
  });
  const filePath = 'wxfile://training-local.jpg';
  global.wx = {
    getStorageSync(key) {
      if (key === 'jyyc.session') return { token: f.partner, actor: 'partnerA', role: 'partner', subject: 'partnerA' };
    },
    request(options) {
      fetch(options.url, {
        method: options.method, headers: options.header,
        body: options.method === 'GET' ? undefined : JSON.stringify(options.data),
      }).then(async response => options.success({ statusCode: response.status, data: await response.json() }))
        .catch(error => options.fail({ errMsg: error.message }));
    },
    chooseMedia({ success }) {
      success({ tempFiles: [{ tempFilePath: filePath, size: Buffer.from(f.material.base64, 'base64').length }] });
    },
    getFileSystemManager() {
      return { readFile({ filePath: candidate, success }) {
        assert.equal(candidate, filePath);
        success({ data: f.material.base64 });
      } };
    },
  };
  let definition;
  global.Page = value => { definition = value; };
  global.getCurrentPages = () => [{ route: 'pages/training/index' }];
  require(source);
  const makePage = () => ({ ...definition, data: structuredClone(definition.data), setData(fields, callback) {
    for (const [key, value] of Object.entries(fields)) {
      const parts = key.split('.');
      const target = parts.slice(0, -1).reduce((item, name) => item[name] ||= {}, this.data);
      target[parts.at(-1)] = value;
    }
    callback?.();
  } });
  const page = makePage();
  const tap = id => ({ currentTarget: { dataset: { id } } });
  const catalogue = makePage();
  catalogue.onLoad({});
  await catalogue.onShow();
  assert.equal(catalogue.data.selectedOutletId, '');
  assert.equal(catalogue.data.canEnroll, false);
  assert.equal(catalogue.data.courses[0].id, course.id);

  page.onLoad({ outlet: 'cs' });
  await page.onShow();
  assert.equal(page.data.isPartner, true);
  assert.equal(page.data.selectedOutletId, 'cs');
  assert.equal(page.data.courses[0].id, course.id);
  page.openCourse(tap(course.id));
  page.learnerInput({ detail: { value: '隔离培训编号-界面-A' } });
  const zzIndex = page.data.outlets.findIndex(outlet => outlet.id === 'zz');
  await page.selectOutlet({ detail: { value: zzIndex } });
  assert.equal(page.data.learner, '');
  const csIndex = page.data.outlets.findIndex(outlet => outlet.id === 'cs');
  await page.selectOutlet({ detail: { value: csIndex } });
  assert.equal(page.data.learner, '隔离培训编号-界面-A');
  await page.begin(tap(course.id));
  assert.equal(page.data.tab, 'records');
  const record = page.data.records[0];
  assert.equal(record.status, 'in_progress');
  assert.equal(page.data.recordId, record.id);
  assert.equal(page.data.records[0].mayUpload, true);
  await page.chooseMaterial();
  assert.equal(page.data.uploadDraft.filePath, filePath);
  await page.submitMaterial();
  assert.equal(page.data.trainingError, '');
  assert.equal(page.data.records[0].status, 'submitted');
  assert.equal(page.data.materials[0].revision, 1);
  assert.equal(page.data.uploadDraft, null);
  const data = (await f.call('/api/training/records?outlet=cs', { token: f.partner })).data.items[0];
  const returned = (await f.review(data.id, 'return', data.version)).data;
  for (let index = 1; index <= 25; index++) {
    assert.equal((await f.begin(course.id, f.partner, 'cs', '分页验证编号-' + index)).status, 201);
  }
  const firstPage = (await f.call('/api/training/records?outlet=cs', { token: f.partner })).data;
  assert.equal(firstPage.items.length, 25);
  assert.equal(firstPage.items.some(row => row.id === record.id), false);
  const fromNotice = makePage();
  fromNotice.onLoad({ outlet: 'cs', id: record.id });
  await fromNotice.onShow();
  assert.equal(fromNotice.data.tab, 'records');
  assert.equal(fromNotice.data.recordId, record.id);
  assert.equal(fromNotice.data.records[0].note, returned.note);
  assert.equal(fromNotice.data.records[0].mayUpload, true);
  assert.equal(fromNotice.data.materials[0].revision, 1);
  assert.equal(fromNotice.data.history[0].status, 'returned');
  await fromNotice.moreRecords();
  assert.equal(fromNotice.data.records.filter(row => row.id === record.id).length, 1);
  const fromMismatchedNotice = makePage();
  fromMismatchedNotice.onLoad({ outlet: 'zz', id: record.id });
  await fromMismatchedNotice.onShow();
  assert.equal(fromMismatchedNotice.data.recordId, '');
  assert.ok(fromMismatchedNotice.data.trainingError);
  await fromNotice.chooseMaterial();
  await fromNotice.submitMaterial();
  assert.equal(fromNotice.data.recordId, record.id);
  assert.equal(fromNotice.data.materials[0].revision, 2);
  const accepted = (await f.review(data.id, 'accept', fromNotice.data.records[0].version)).data;
  await fromNotice.refresh();
  assert.equal(fromNotice.data.recordId, record.id);
  assert.equal(fromNotice.data.records[0].label, '资料已通过');
  assert.match(fromNotice.data.records[0].nextStep, /等待总部确认培训完成/);
  await f.review(data.id, 'complete', accepted.version);
  await page.refresh();
  assert.equal(page.data.records[0].label, '培训已完成');
  assert.equal(page.data.history[0].label, '培训已完成');
  assert.equal(page.data.history[1].label, '资料已通过');
});
