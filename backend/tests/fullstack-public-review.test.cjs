const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const api = require('../../miniprogram/utils/api');

function runtime(t) {
  const previous = global.wx;
  const storage = new Map();
  const menus = [];
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    getAccountInfoSync: () => ({ miniProgram: { version: '3.4.4' } }),
    hideShareMenu: options => menus.push(['hide', options.menus]),
    showShareMenu: options => menus.push(['show', options.menus]),
    showToast() {},
  };
  t.after(() => { global.wx = previous; });
  return { storage, menus };
}

function page(name, query = {}) {
  const previous = global.Page;
  const filename = require.resolve('../../miniprogram/pages/' + name + '/index.js');
  let definition;
  global.Page = value => { definition = value; };
  try {
    delete require.cache[filename];
    require(filename);
  } finally {
    global.Page = previous;
  }
  const instance = { ...definition, route: 'pages/' + name + '/index',
    data: structuredClone(definition.data), setData: null };
  instance.setData = function (values, done) {
    for (const [key, value] of Object.entries(values)) {
      const fields = key.split('.');
      let target = this.data;
      for (const field of fields.slice(0, -1)) target = target[field] ||= {};
      target[fields.at(-1)] = value;
    }
    done?.();
  };
  instance.onLoad(query);
  return instance;
}

test('sharing a private home, outlet or cooperation screen only produces public paths and cover', t => {
  runtime(t);
  const home = page('home');
  const outlet = page('outlet', { id: 'private-outlet' });
  const discover = page('discover', { section: 'cooperation', id: 'private-record' });
  outlet.data.outlet = { id: 'private-outlet', name: '经营资料' };
  for (const [screen, path, query] of [
    [home, '/pages/home/index?scope=public', 'scope=public'],
    [outlet, '/pages/outlets/index?scope=public', 'scope=public'],
    [discover, '/pages/discover/index?section=brand', 'section=brand'],
  ]) {
    assert.equal(screen.onShareAppMessage().path, path);
    assert.equal(screen.onShareTimeline().query, query);
    assert.match(screen.onShareAppMessage().imageUrl, /^\/assets\/.+\.png$/);
    assert.equal(screen.onShareTimeline().imageUrl, screen.onShareAppMessage().imageUrl);
    assert.equal(existsSync(join(__dirname, '../../miniprogram', screen.onShareAppMessage().imageUrl)), true);
    assert.doesNotMatch(screen.onShareAppMessage().title, /经营资料/);
  }
});

test('an indexed business detail only renders a published service and revokes its direct share', async t => {
  const { storage, menus } = runtime(t);
  storage.set('jyyc.session', { role: 'public', token: 'sample' });
  t.mock.method(api, 'request', async () => ({ actor: 'public', today: '2026-10-28' }));
  let status = 'published';
  t.mock.method(api, 'detail', async () => ({ id: 'service-001', key: 'service-1', title: '公开服务', status }));
  const service = page('service-detail', { id: 'service-001' });
  await service.onShow();
  assert.equal(service.data.service.title, '公开服务');
  assert.deepEqual(menus.at(-1), ['show', ['shareAppMessage', 'shareTimeline']]);
  assert.equal(service.onShareAppMessage().path, '/pages/service-detail/index?id=service-001');
  status = 'draft';
  await service.refresh();
  assert.equal(service.data.service, null);
  assert.deepEqual(menus.at(-1), ['hide', ['shareAppMessage', 'shareTimeline']]);
  assert.equal(service.onShareAppMessage().path, '/pages/discover/index?section=services');
});

test('signed-in recipients of a public home share load no private workbench collections', async t => {
  const { storage } = runtime(t);
  storage.set('jyyc.session', { role: 'partner', token: 'sample' });
  t.mock.method(api, 'request', async path => {
    assert.equal(path, '/api/context');
    return { actor: 'alpha', today: '2026-10-28' };
  });
  const seen = [];
  t.mock.method(api, 'collection', async name => {
    seen.push(name);
    return { items: [], total: 0, offset: 0, limit: 50, hasMore: false };
  });
  const home = page('home', { scope: 'public', outlet: 'private-outlet' });
  await home.onShow();
  assert.equal(home.data.publicView, true);
  assert.deepEqual(seen, ['publicContents']);
});

test('public favorites recheck publication and omit unpublished records from the display', async t => {
  const { storage } = runtime(t);
  const profile = page('profile');
  const outlet = page('outlet', { id: 'out-001', scope: 'public' });
  storage.set('jyyc.session', { role: 'partner', token: 'sample' });
  t.mock.method(api, 'request', async () => ({ actor: 'alpha', today: '2026-10-28' }));
  let published = true;
  t.mock.method(api, 'detail', async (name, id, params) => {
    assert.equal(name, 'outlets');
    assert.deepEqual(params, { scope: 'public' });
    if (!published) throw Object.assign(new Error('不可查看'), { status: 404 });
    return { id, name: '公开地址', address: '隔离验证', owner: 'private', phone: '13000000000' };
  });
  await outlet.onShow();
  outlet.toggleFavorite();
  assert.equal(outlet.data.favorite, true);
  assert.match(outlet.onShareAppMessage().path, /id=out-001/);
  await profile.toggleFavorites();
  assert.deepEqual(profile.data.favoriteRows, [{ id: 'out-001', name: '公开地址', address: '隔离验证' }]);
  published = false;
  await profile.loadFavorites();
  assert.deepEqual(profile.data.favoriteRows, []);
  assert.equal(profile.data.unavailableFavorites, 1);
  await outlet.refresh();
  assert.equal(outlet.onShareAppMessage().path, '/pages/outlets/index?scope=public');
  assert.equal(profile.data.version, '3.4.4');
});

test('recent outlet searches persist only public location terms and can be cleared', async t => {
  runtime(t);
  const outlets = page('outlets', { scope: 'public', outlet: 'unsolicited-outlet' });
  outlets.refresh = async () => {};
  assert.equal(outlets.query.outlet, undefined);
  await outlets.search({ detail: { value: '香港' } });
  await outlets.search({ detail: { value: '13000000000' } });
  outlets.resetScope(false);
  await outlets.search({ detail: { value: '本人的私有网点' } });
  outlets.resetScope(true);
  assert.deepEqual(outlets.data.recentSearches, ['香港']);
  outlets.clearRecent();
  assert.deepEqual(outlets.data.recentSearches, []);
});

test('public index policy leaves mixed public and private screens excluded', () => {
  const { rules } = require('../../miniprogram/sitemap.json');
  assert.deepEqual(rules.filter(rule => rule.action === 'allow').map(rule => rule.page), ['pages/service-detail/index']);
  assert.deepEqual(rules.at(-1), { action: 'disallow', page: '*' });
});
