'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const sharp = require('sharp');
const { createServer } = require('../server/index.cjs');
const config = require('../miniprogram/config');
const api = require('../miniprogram/utils/api');
const { go, fmt } = require('../miniprogram/utils/page');

const tap = dataset => ({ currentTarget: { dataset } });
const change = value => ({ detail: { value } });
const pageFile = name => require.resolve('../miniprogram/pages/' + name + '/index');
const markup = name => readFileSync(pageFile(name).replace(/\.js$/, '.wxml'), 'utf8');
const command = async (name, input) => (await api.command(name, input)).result;

async function run(work) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const originalBase = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map(), routes = [], dialed = [], reads = [];
  const route = ({ url, success }) => { routes.push(url); success?.(); };
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), showToast() {}, pageScrollTo() {},
    navigateTo: route, switchTab: route, reLaunch: route,
    makePhoneCall: ({ phoneNumber }) => dialed.push(phoneNumber),
    async request({ url, method, header, data, success, fail }) {
      try {
        if (method === 'GET') reads.push(new URL(url));
        const res = await fetch(url, { method, headers: header, body: method === 'GET' ? undefined : JSON.stringify(data) });
        success({ statusCode: res.status, data: await res.json() });
      } catch (error) { fail(error); }
    },
  };

  async function show(name, query = {}) {
    let definition;
    global.Page = page => { definition = page; };
    const file = pageFile(name);
    delete require.cache[file];
    require(file);
    const page = {
      ...definition, route: 'pages/' + name + '/index', data: structuredClone(definition.data),
      setData(values, callback) {
        for (const [key, value] of Object.entries(values)) {
          const fields = key.split('.');
          let target = this.data;
          for (const field of fields.slice(0, -1)) target = target[field] ||= {};
          target[fields.at(-1)] = value;
        }
        callback?.();
      },
    };
    page.onLoad(query);
    await page.onShow();
    return page;
  }

  const destination = () => {
    const url = new URL(routes.at(-1), 'https://native.invalid');
    return show(url.pathname.split('/')[2], Object.fromEntries(url.searchParams));
  };

  try {
    await api.login('partnerA');
    await work({ app, show, destination, routes, dialed, reads });
  } finally {
    config.apiBase = originalBase;
    delete global.wx;
    delete global.Page;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('a newly activated partner applies, corrects the original request and returns to the operating workbench', () => run(async ({ show, destination, reads }) => {
  await api.login('manager');
  const account = await command('account.create', { name: '首店流程测试主体', managerName: '首店负责人', mobile: '13900211087' });
  const activation = await api.request('/api/auth/activation', 'POST', { actor: account.actor, username: 'isolated-first-outlet' });
  const partner = await api.activate(activation.token, randomUUID() + '-Isolation!');
  const switchBack = () => wx.setStorageSync('jyyc.session', partner);
  const home = await show('home');
  assert.equal(home.data.outletCount, 0);
  assert.equal(home.data.firstOutlet.status, 'empty');
  home.openOutlets();
  const form = await destination();
  assert.equal(form.data.viewMode, 'form');
  assert.equal(form.data.type, 'newOutlet');
  const evidence = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#163858' } }).png().toBuffer();
  const photo = await api.request('/api/files', 'POST', { name: '位置验收.png', type: 'image/png', base64: evidence.toString('base64') });
  form.setData({ form: { ...form.data.form, countryCode: 'CN', province: '湖南省', city: '长沙市', district: '岳麓区',
    name: '首店流程测试网点', address: '隔离验收地址', phone: '073112345678', opening: '2026-11-01' },
  coords: { lat: 28.2, lng: 112.9, source: 'manual', coordinateSystem: 'GCJ-02' }, photo });
  await form.submit();
  assert.equal(form.data.error, '');
  const id = form.data.historyId;
  assert.ok(id);
  await home.onShow();
  assert.equal(home.data.firstOutlet.status, 'pending');
  assert.equal(home.data.firstOutlet.id, id);
  await api.login('partnerA');
  assert.equal((await api.collection('requests', { type: 'newOutlet', limit: 1 })).total, 0);
  await api.login('ops');
  await command('review.request', { id, decision: 'return', note: '请确认地点信息', publicNote: '请核对地址并补充说明' });
  switchBack();
  await home.onShow();
  assert.equal(home.data.firstOutlet.status, 'returned');
  home.openOutlets();
  const returned = await destination();
  assert.equal(returned.data.historyId, id);
  await returned.supplement(tap({ id }));
  returned.setData({ 'form.reason': '地址已核对' });
  await returned.submit();
  assert.equal(returned.data.error, '');
  assert.equal(returned.data.historyId, id);
  await api.login('location');
  await command('location.review', { id, decision: 'approve' });
  await api.login('ops');
  const approved = await command('review.request', { id, decision: 'approve' });
  assert.equal(approved.id, id);
  assert.ok(approved.data.createdOutletId);
  switchBack();
  const start = reads.length;
  await home.onShow();
  assert.equal(home.data.outletCount, 1);
  assert.equal(home.data.firstOutlet, null);
  assert.ok(!reads.slice(start).some(url => url.pathname === '/api/dashboard'));
  assert.ok(!reads.slice(start).some(url => url.pathname === '/api/collections/requests'));
  home.openOutlets();
  const myOutlets=await destination();
  assert.equal(myOutlets.data.directory,false);
  assert.ok(myOutlets.data.rows.some(outlet=>outlet.id===approved.data.createdOutletId));
}));

test('my outlets keeps address and secondary shortcuts in detail and opens only the prioritized row action', () => run(async ({ show, routes, reads }) => {
  const page = await show('outlets');
  assert.equal(page.data.error, '');
  assert.equal(page.data.directory, false);
  assert.ok(reads.some(url => url.pathname === '/api/collections/outlets' && url.searchParams.get('includeSummary') === 'true'));
  const template = markup('outlets');
  assert.match(template, /wx:if="{{state && !directory && !isPublic && rows.length}}"[^>]*data-query="type=newOutlet"[^>]*>申请新增网点/);
  assert.match(template, /data-id="{{item.id}}" bindtap="open"[^>]*aria-label="查看{{item.name}}详情"/);
  assert.match(template, /wx:if="{{item.nextAction}}"[\s\S]*?data-id="{{item.id}}" bindtap="outletAction"/);
  assert.doesNotMatch(template, /wx:for="{{(?:item.summaryRows|outletActions)}}"/);

  const priority = [['report', 'returned', 'report'], ['location', 'exception', 'location'], ['report', 'missing', 'report'],
    ['location', 'missing', 'location'], ['fee', 'unpaid', 'fees'], ['fee', 'partially_paid', 'fees']];
  for (const outlet of page.data.rows) {
    assert.deepEqual(outlet.summaryRows.map(row => row.key), ['report', 'location', 'fee']);
    assert.deepEqual(outlet.businessChips.map(row => row.key), ['report', 'fee']);
    assert.ok(outlet.summaryRows.every(row => row.monthText && row.statusText));
    const selected = priority.find(([key, status]) => outlet.summary[key].status === status);
    const count = routes.length;
    page.outletAction(tap({ id: outlet.id }));
    if (!selected) {
      assert.equal(outlet.nextAction, null);
      assert.equal(routes.length, count);
      page.open(tap({ id: outlet.id }));
      assert.equal(routes.at(-1), '/pages/outlet/index?id=' + outlet.id);
      continue;
    }
    const [key, , name] = selected;
    const url = new URL(routes.at(-1), 'https://native.invalid');
    assert.equal(routes.length, count + 1);
    assert.equal(url.pathname, '/pages/' + name + '/index');
    assert.equal(url.searchParams.get('outlet'), outlet.id);
    assert.equal(url.searchParams.get('month'), outlet.summary[key].month);
  }
  const count = routes.length;
  page.outletAction(tap({ id: 'outside-my-outlets' }));
  assert.equal(routes.length, count);
}));

test('outlet details display scoped monthly tools, verification and operating requests in separate sections', () => run(async ({ show, routes, reads }) => {
  const page = await show('outlet', { id: 'zz' });
  assert.equal(page.data.error, '');
  const month = page.data.state.today.slice(0, 7);
  const priorMonth = fmt.addMonth(month, -1);
  const list = await show('outlets');
  const ownRow = list.data.rows.find(row => row.id === 'zz');
  assert.ok(ownRow);
  assert.deepEqual(Object.values(page.data.businessSections), ownRow.summaryRows);
  assert.ok(reads.some(url => url.pathname === '/api/collections/outlets/zz' && url.searchParams.get('includeSummary') === 'true'));
  const template = markup('outlet');
  assert.match(template, />月报与账单<\/view>[\s\S]*?data-page="report"[\s\S]*?data-page="fees"[\s\S]*?>本月经营情况<\/view>[\s\S]*?{{summary.revenueText}}[\s\S]*?>位置核验<\/view>/);
  assert.match(template, />位置核验<\/view>[\s\S]*?{{businessSections.location.statusText}}[\s\S]*?data-page="location" data-month="{{businessScope.location.month}}" bindtap="action">[\s\S]*?月度位置核验[\s\S]*?data-page="location" data-history="true" bindtap="action">位置核验记录[\s\S]*?>营业状态与申请<\/view>/);
  assert.match(template, />营业状态与申请<\/view>[\s\S]*?{{outlet.statusNote}}[\s\S]*?data-type="statusChange" data-status="paused"[\s\S]*?data-type="statusChange" data-status="open"[\s\S]*?bindtap="toggleMatters"[\s\S]*?wx:if="{{mattersExpanded}}"[\s\S]*?data-type="pauseFee"[\s\S]*?data-history="true" bindtap="action">其他申请及进度<\/button>/);
  assert.match(template, /data-page="requests" bindtap="action">办理网点事项/);
  assert.match(template, /网点资料[\s\S]*?data-page="agreements" bindtap="action">查看服务协议/);
  assert.equal(page.data.mattersExpanded, false);
  page.toggleMatters();
  assert.equal(page.data.mattersExpanded, true);
  for (const [name, expectedMonth] of [['report', priorMonth], ['fees', null], ['location', month], ['requests', null], ['support', null], ['agreements', null]]) {
    page.action(tap({ page: name }));
    const url = new URL(routes.at(-1), 'https://native.invalid');
    assert.equal(url.pathname, '/pages/' + name + '/index');
    assert.equal(url.searchParams.get('outlet'), 'zz');
    assert.equal(url.searchParams.get('month'), expectedMonth);
    assert.equal(url.searchParams.get('filterOutlet'), name === 'requests' ? 'zz' : null);
  }
  page.action(tap({ page: 'fees', month: '2026-10' }));
  assert.equal(routes.at(-1), '/pages/fees/index?outlet=zz&month=2026-10');
  page.action(tap({ page: 'location', history: true }));
  const verificationHistory = new URL(routes.at(-1), 'https://native.invalid');
  assert.equal(verificationHistory.pathname, '/pages/location/index');
  assert.equal(verificationHistory.searchParams.get('outlet'), 'zz');
  assert.equal(verificationHistory.searchParams.get('section'), 'history');

  await api.login('manager');
  await command('public.profile', { outlet: 'zz', title: '公开验收网点', description: '公开摘要', services: ['网点服务'], address: '公开验收地址', published: true, reason: '隔离验证' });
  await api.login('partnerA');
  const start = reads.length;
  const publicPage = await show('outlet', { id: 'zz', scope: 'public' });
  assert.equal(publicPage.data.error, '');
  assert.equal(publicPage.data.internal, false);
  publicPage.toggleMatters();
  const routeCount = routes.length;
  for (const name of ['report', 'fees', 'location', 'requests', 'support', 'agreements']) publicPage.action(tap({ page: name }));
  assert.equal(publicPage.data.mattersExpanded, false);
  assert.equal(routes.length, routeCount);
  assert.ok(reads.slice(start).some(url => url.pathname === '/api/collections/outlets/zz' && url.searchParams.get('scope') === 'public'));
  assert.ok(!reads.slice(start).some(url => url.pathname === '/api/dashboard' || url.pathname === '/api/work-contacts'));
}));

test('public outlet details use only published phone, hours and map coordinates', () => run(async ({ show }) => {
  await api.login('manager');
  const publication = { outlet: 'zz', title: '公开资料隔离校验', description: '公开摘要', services: ['网点服务'],
    address: '公开验收地址', contact: '0731-10080000', businessHours: '工作日 09:00–17:00', published: true, reason: '隔离验证',
    publicCoords: { lat: 27.85, lng: 113.15, coordinateSystem: 'GCJ-02' } };
  await command('public.profile', publication);
  assert.equal((await api.detail('outlets', 'zz', { scope: 'public' })).contact, undefined);
  await command('public.profile', { ...publication, contactPublished: true });
  await api.visitor();
  const detail = await show('outlet', { id: 'zz', scope: 'public' });
  assert.equal(detail.data.outlet.publicPhone, '073110080000');
  assert.equal(detail.data.outlet.businessHours, publication.businessHours);
  assert.equal(detail.data.outlet.navigationPoint.latitude, publication.publicCoords.lat);
  assert.equal(detail.data.outlet.phone, '');
  await api.login('manager');
  await command('public.profile', { ...publication, contactPublished: true, published: false });
  await api.visitor();
  await assert.rejects(api.detail('outlets', 'zz', { scope: 'public' }), { status: 404 });
}));

test('outlet applications retain their exact type and separate business suspension from fee suspension', () => run(async ({ app, show, destination }) => {
  const outlet = await show('outlet', { id: 'zz' });
  outlet.action(tap({ page: 'requests', type: 'statusChange', status: 'open' }));
  const resume = await destination();
  assert.equal(resume.data.error, '');
  assert.equal(resume.data.form.status, 'open');
  assert.equal(resume.data.outlets[resume.data.outletIndex].id, 'zz');

  outlet.action(tap({ page: 'requests', type: 'statusChange', status: 'paused' }));
  const pause = await destination();
  pause.setData({ 'form.reason': '隔离验收暂停营业' });
  await pause.submit();
  assert.equal(pause.data.error, '');
  assert.equal(app.store.load().requests.length, 1);
  assert.equal(app.store.load().requests[0].type, 'statusChange');
  const pauseId = app.store.load().requests[0].id;
  pause.applyPauseFee(tap({ id: pauseId }));
  const linkedFee = await destination();
  assert.equal(linkedFee.data.boundOutlet, 'zz');
  linkedFee.chooseOutlet(change(linkedFee.data.outlets.findIndex(row => row.id === 'cs')));
  assert.equal(linkedFee.data.outlets[linkedFee.data.outletIndex].id, 'zz');

  outlet.action(tap({ page: 'requests', type: 'pauseFee' }));
  const fee = await destination();
  fee.setData({ 'form.from': '2026-11-21', 'form.to': '2026-11-25', 'form.reason': '隔离验收暂停收费' });
  await fee.submit();
  assert.equal(fee.data.error, '');
  assert.deepEqual(app.store.load().requests.map(({ type, outlet, status }) => ({ type, outlet, status })), [
    { type: 'statusChange', outlet: 'zz', status: 'pending' }, { type: 'pauseFee', outlet: 'zz', status: 'pending' },
  ]);
  const foreign = await command('request.submit', { type: 'enrollment', outlet: 'cs', data: { applicable: false, reason: '另一网点记录' } });
  outlet.action(tap({ page: 'requests', history: true }));
  const history = await destination();
  assert.equal(history.data.requestRows.length, 2);
  assert.ok(!history.data.requestRows.some(row => row.id === foreign.id));
  history.beginRequest();
  assert.ok(!history.data.types.some(type => type.id === 'newOutlet'));
  history.chooseOutlet(change(history.data.outlets.findIndex(row => row.id === 'cs')));
  assert.equal(history.data.outlets[history.data.outletIndex].id, 'zz');
  await history.chooseType(change(history.data.types.findIndex(row => row.id === 'enrollment')));
  history.setData({ 'form.reason': '隔离验收网点招生适用性' });
  await history.submit();
  const newRequest = app.store.load().requests.find(row => row.id === history.data.historyId);
  assert.equal(newRequest?.outlet, 'zz');
  assert.equal(newRequest.type, 'enrollment');
}));

test('new applications choose a type and reset unsubmitted fields when the user changes scope', () => run(async ({ app, show }) => {
  const requests = await show('requests');
  requests.beginRequest();
  assert.equal(requests.data.viewMode, 'chooseType');
  const pause = requests.data.types.findIndex(row => row.id === 'pauseFee');
  await requests.chooseType(change(pause));
  assert.equal(requests.data.viewMode, 'form');
  assert.equal(requests.data.outletIndex, 0);
  await requests.chooseOutlet(change(requests.data.outlets.findIndex(row => row.id === 'cs')));
  requests.input({ ...tap({ field: 'reason' }), detail: { value: '仅属于长沙网点的原因' } });
  requests.input({ ...tap({ field: 'from' }), detail: { value: '2026-12-01' } });
  const oldModal = wx.showModal;
  const target = change(requests.data.outlets.findIndex(row => row.id === 'zz'));
  try {
    wx.showModal = options => options.success({ confirm: false });
    await requests.chooseOutlet(target);
    assert.equal(requests.data.form.reason, '仅属于长沙网点的原因');
    assert.equal(requests.data.outlets[requests.data.outletIndex].id, 'cs');
    wx.showModal = options => options.success({ confirm: true });
    await requests.chooseOutlet(target);
    assert.equal(requests.data.outlets[requests.data.outletIndex].id, 'zz');
    assert.equal(requests.data.form.reason, '');
    assert.equal(requests.data.form.from, '');
    await requests.submit();
    assert.equal(app.store.load().requests.length, 0);
  } finally {
    wx.showModal = oldModal;
  }
}));

test('support entry separates consultation, explicit ticket submission and exact history', () => run(async ({ app, show, routes }) => {
  const support = await show('support');
  const template = markup('support');
  assert.match(template, /data-tab="chat"[^>]*>在线咨询</);
  assert.match(template, /bindtap="prepareTicket"[^>]*>提交问题</);
  assert.equal(support.data.tab, 'home');
  support.tab(tap({ tab: 'chat' }));
  support.text(change('隔离咨询，不自动创建工单'));
  await support.send();
  const [chat] = app.store.load().supportChats;
  assert.equal(chat.messages[0].text, '隔离咨询，不自动创建工单');
  assert.equal(app.store.load().supportTickets.length, 0);
  support.tab(tap({ tab: 'home' }));
  await support.prepareTicket();
  assert.equal(support.data.form.description, '');
  assert.equal(app.store.load().supportTickets.length, 0);
  await support.outlet(change(support.data.outlets.findIndex(row => row.id === 'zz')));
  support.setData({ 'form.title': '正式工单', 'form.description': '明确提交总部跟进' });
  await support.create();
  const [ticket] = app.store.load().supportTickets;
  assert.equal(ticket.id, support.data.ticket.id);
  assert.equal(ticket.outlet, 'zz');

  go('support', api.query({ id: chat.id, returnStatus: 'read', returnNoticeId: 'msg-original' }));
  const openLink = () => show('support', Object.fromEntries(new URL(routes.at(-1), 'https://example.test').searchParams));
  const linkedChat = await openLink();
  assert.equal(linkedChat.data.chat.id, chat.id);
  assert.equal(linkedChat.data.ticket, null);
  linkedChat.backToMessages();
  assert.equal(routes.at(-1), '/pages/messages/index?status=read&id=msg-original');

  go('support', api.query({ id: ticket.id, outlet: 'cs' }));
  const mismatch = await openLink();
  assert.equal(mismatch.data.ticket, null);
  assert.match(mismatch.data.error, /网点/);
}));

test('starting a ticket from consultation does not reuse a different draft or outlet', () => run(async ({ app, show }) => {
  const support = await show('support');
  await support.prepareTicket();
  await support.outlet(change(support.data.outlets.findIndex(row => row.id === 'cs')));
  support.setData({ 'form.title': '另一个网点的问题', 'form.description': '仅属于旧业务', 'form.contact': '旧联系人' });
  support.closeTicketForm();
  support.tab(tap({ tab: 'chat' }));
  support.text(change('这次咨询涉及另一网点'));
  await support.send();
  await support.prepareTicket();
  assert.equal(support.data.showTicketForm, false);
  assert.equal(support.data.draftPrompt, true);
  assert.equal(support.data.draftAvailable, true);
  support.discardTicketDraft();
  await support.prepareTicket();
  assert.equal(support.data.form.title, '');
  assert.equal(support.data.form.description, '这次咨询涉及另一网点');
  assert.equal(support.data.form.contact, '');
  assert.equal(support.data.outletIndex, 0);
  assert.equal(app.store.load().supportTickets.length, 0);
  await support.outlet(change(support.data.outlets.findIndex(row => row.id === 'zz')));
  support.setData({ 'form.title': '本次需要正式跟进' });
  await support.create();
  const [ticket] = app.store.load().supportTickets;
  assert.equal(ticket.outlet, 'zz');
  assert.equal(ticket.description, '这次咨询涉及另一网点');
  assert.equal(support.data.ticket.id, ticket.id);
}));

test('only an authorized outlet contact displays the published administrator number', () => run(async ({ show, dialed }) => {
  const actor = 'phase_one_contact';
  const phone = '+441632960101';
  await api.login('manager');
  await command('staff.create', { subject: actor, name: '隔离测试管理员', role: 'ops', reason: '验证公开与私有电话号码' });
  const invitation = await api.request('/api/auth/activation', 'POST', { actor, username: actor });
  await api.request('/api/auth/activate', 'POST', { token: invitation.token, password: randomUUID() + '-Contact!' });
  await api.login('manager');
  await api.request('/api/work-contacts/manage', 'POST', { actor, outlet: 'zz', phone, isDefault: true, published: true, confirmed: true });
  await api.login('partnerA');
  const support = await show('support', { outlet: 'zz' });
  await support.tab(tap({ tab: 'chat' }));
  assert.equal(support.data.workContact?.phone, phone);
  await support.dialWorkContact();
  assert.deepEqual(dialed, [phone]);
  await api.login('public');
  const publicSupport = await show('support');
  assert.equal(publicSupport.data.error, '');
  assert.equal(publicSupport.data.workContact, null);
  assert.ok(!JSON.stringify(publicSupport.data).includes(phone));
}));

test('location shows the server month before an outlet is chosen and then binds the chosen outlet', () => run(async ({ show, destination }) => {
  const tasks = await show('tasks');
  tasks.openLocation();
  const location = await destination();
  assert.equal(location.data.error, '');
  const month = tasks.data.state.today.slice(0, 7);
  assert.equal(location.data.month, month);
  assert.equal(location.data.outletId, '');
  const template = markup('location');
  assert.ok(template.indexOf('核验月份') < template.indexOf('<block wx:if="{{outletId}}">'));
  await location.chooseOutletFromPicker(change(location.data.outlets.findIndex(row => row.id === 'zz') + 1));
  assert.equal(location.data.outletId, 'zz');
  assert.equal(location.data.month, month);
  assert.equal(location.data.canSubmitEvidence, true);
}));
