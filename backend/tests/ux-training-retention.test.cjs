const { test } = require('node:test');
const assert = require('node:assert/strict');

test('an unsubmitted training image stays with the learner until the user confirms leaving', async t => {
  const path = require.resolve('../../miniprogram/pages/training/index.js');
  const original = { Page: global.Page, wx: global.wx };
  t.after(() => {
    Object.assign(global, original);
    delete require.cache[path];
  });

  const prompts = [];
  const leaveGuard = [];
  let confirm = false;
  let definition;
  global.Page = options => { definition = options; };
  global.wx = {
    showModal({ content, success }) { prompts.push(content); success({ confirm }); },
    enableAlertBeforeUnload({ message }) { leaveGuard.push(message); },
    disableAlertBeforeUnload() { leaveGuard.push(false); },
    chooseMedia({ success }) { success({ tempFiles: [{ tempFilePath: 'wxfile://attachment.jpg', size: 128 }] }); },
  };
  require(path);

  const page = {
    ...definition,
    data: {
      ...structuredClone(definition.data),
      tab: 'records', recordId: 'learner-a', selectedOutletId: 'outlet-a',
      outlets: [{ id: 'outlet-a' }, { id: 'outlet-b' }],
      records: [{ id: 'learner-a', mayUpload: true }, { id: 'learner-b', mayUpload: true }],
    },
    query: { id: 'learner-a', outlet: 'outlet-a' },
    setData(fields) { Object.assign(this.data, fields); },
    async fetchMaterials() {},
    async fetchHistory() {},
    async fetchRecords() {},
  };
  const target = dataset => ({ currentTarget: { dataset } });
  await page.chooseMaterial();
  assert.match(leaveGuard[0], /尚未提交/);

  await page.selectOutlet({ detail: { value: 1 } });
  await page.openMaterials(target({ id: 'learner-b' }));
  await page.selectTab(target({ tab: 'courses' }));
  assert.equal(prompts.length, 3);
  assert.deepEqual(page.query, { id: 'learner-a', outlet: 'outlet-a' });
  assert.equal(page.data.tab, 'records');
  assert.equal(page.data.uploadDraft.recordId, 'learner-a');

  confirm = true;
  await page.openMaterials(target({ id: 'learner-b' }));
  assert.equal(page.data.recordId, 'learner-b');
  assert.equal(page.data.uploadDraft, null);
  assert.equal(leaveGuard.at(-1), false);
});

test('headquarters keeps the saved review outcome beside the original record under an active filter', async t => {
  const { setImmediate: flush } = require('node:timers/promises');
  const { trainingDesk } = await import('../../web/training.js');
  const originalFormData = global.FormData;
  global.FormData = class {
    constructor(form) { return Object.entries(form.fields); }
  };
  t.after(() => { global.FormData = originalFormData; });

  const listeners = {};
  const banner = { textContent: '', setAttribute() {} };
  const container = {
    isConnected: true, innerHTML: '',
    querySelector() { return banner; },
    addEventListener(name, callback) { listeners[name] = callback; },
  };
  const record = {
    id: 'same-learner', learner: '学员甲', courseTitle: '培训课程', outletName: '授权网点',
    status: 'submitted', version: 1,
  };
  const page = items => ({ items, nextOffset: null });
  let saved;
  let refreshed = false;
  trainingDesk({
    esc: value => value ?? '', empty: value => value, panel: (title, body) => '<h2>' + title + '</h2>' + body,
    async api(path, options) {
      if (options?.method === 'POST') {
        assert.deepEqual(options.body, { action: 'return', note: '请补交清晰图片', version: 1 });
        saved = { ...record, status: 'returned', version: 2, note: options.body.note };
        return saved;
      }
      if (path.startsWith('/training/records?')) {
        if (saved) {
          refreshed = true;
          assert.match(path, /status=submitted/);
        }
        return page(saved ? [] : [record]);
      }
      if (path.endsWith('/history?offset=0') && saved) throw new Error('history unavailable');
      return page([]);
    },
  }).mount(container, { actor: 'regional', subject: 'reviewer' });
  await flush();

  const submit = (name, fields, attributes = {}) => listeners.submit({
    target: { closest: () => ({ dataset: { trainingForm: name, ...attributes }, fields }) },
    preventDefault() {},
  });
  submit('filter', { outlet: '', status: 'submitted' });
  await flush();
  listeners.click({ target: { closest: () => ({ dataset: { trainingAction: 'materials', id: record.id } }) } });
  await flush();
  submit('review', { action: 'return', note: '请补交清晰图片' }, { id: record.id, version: '1' });
  await flush();

  assert.equal(refreshed, true);
  assert.match(container.innerHTML, /data-training-record="same-learner"/);
  assert.match(container.innerHTML, /已保存处理结果/);
  assert.match(container.innerHTML, /请补交清晰图片/);
  assert.match(banner.textContent, /处理结果已保存/);
  assert.doesNotMatch(banner.textContent, /history unavailable/);
});
