'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { api, define } = require('../miniprogram/utils/page');

const read = relative => readFileSync(path.join(__dirname, '../miniprogram', relative), 'utf8');
const today = '2026-11-20';
const entries = items => ({ items, total: items.length, offset: 0, limit: 50, hasMore: false });

function instance(definition, name, query = {}) {
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    route: 'pages/' + name + '/index',
    setData(updates) {
      for (const [key, value] of Object.entries(updates)) {
        const [root, nested] = key.split('.');
        if (nested) this.data[root][nested] = value;
        else this.data[root] = value;
      }
    },
  };
  page.onLoad(query);
  return page;
}

function patchRuntime(t) {
  const original = { request: api.request, collection: api.collection, session: api.session };
  const globals = { Page: global.Page, wx: global.wx };
  global.wx = { getStorageSync() {} };
  t.after(() => {
    Object.assign(api, original);
    Object.assign(global, globals);
  });
}

test('first load stays pending through collections and an empty successful refresh counts as loaded', async t => {
  patchRuntime(t);
  api.session = () => ({ role: 'partner', token: 'member-one' });
  api.request = async () => ({ actor: 'member-a', today });
  const pending = Promise.withResolvers();
  api.collection = () => pending.promise;
  const page = instance(define({ collections: ['outlets'] }), 'outlets');

  const first = page.refresh();
  await Promise.resolve();
  assert.equal(page.data.state.today, today);
  assert.equal(page.data.loading, true);
  assert.equal(page.data.hasLoaded, false);
  pending.resolve(entries([]));
  await first;
  assert.equal(page.data.hasLoaded, true);
  assert.equal(page.data.loading, false);

  const refresh = page.refresh();
  assert.equal(page.data.hasLoaded, true);
  await refresh;
  assert.equal(page.data.hasLoaded, true);
});

test('a failed first load remains eligible for a skeleton on retry', async t => {
  patchRuntime(t);
  api.session = () => ({ role: 'partner', token: 'member-one' });
  api.request = async () => {
    throw new Error('网络连接失败');
  };
  const page = instance(define({}), 'home');
  await page.refresh();
  assert.equal(page.data.error, '网络连接失败');
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.loading, false);
});

test('workbench keeps the current task count during refresh and clears it when the account changes', async t => {
  patchRuntime(t);
  let definition;
  global.Page = page => { definition = page; };
  const homePath = require.resolve('../miniprogram/pages/home/index.js');
  delete require.cache[homePath];
  require(homePath);
  let token = 'member-one';
  api.session = () => ({ role: 'partner', token });
  api.request = async resource => resource === '/api/context' ? { actor: token, today } : {};
  api.collection = async (collection, filters) => entries(collection === 'businessTasks' && filters.status === 'open'
    ? Array.from({length:token==='member-one'?1:2},(_,index)=>({id:token+'-task-'+index}))
    : []);
  const page = instance(definition, 'home');
  await page.refresh();
  assert.equal(page.data.openTotal, 1);

  const sameAccount = page.refresh();
  assert.equal(page.data.hasLoaded, true);
  assert.equal(page.data.openTotal, 1);
  await sameAccount;

  token = 'member-two';
  const otherAccount = page.refresh();
  assert.equal(page.data.hasLoaded, false);
  assert.equal(page.data.state, null);
  assert.equal(page.data.openTotal, null);
  await otherAccount;
  assert.equal(page.data.openTotal, 2);
});

test('core surfaces present an accessible initial skeleton and keep visible refresh feedback separate', () => {
  for (const page of ['home', 'reports', 'tasks', 'fees', 'finance', 'outlets']) {
    const file = read('pages/' + page + '/index.wxml');
    assert.match(file, /wx:if="\{\{loading && !hasLoaded[^"]*\}\}" class="card content-skeleton"/, page);
    assert.match(file, /class="content-skeleton-body" aria-hidden="true"/, page);
    assert.match(file, /class="loading">正在更新/, page);
  }
  assert.match(read('styles/components.wxss'), /\.content-skeleton-body::before,[\s\S]*?\.content-skeleton-body::after/);
});

test('layout wraps full detail text, separates tab inset from its target, and leaves keyboard room', () => {
  assert.match(read('styles/layout.wxss'), /\.detail-row > text\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(read('pages/reports/index.wxss'), /-webkit-line-clamp/);
  assert.match(read('pages/outlets/index.wxss'), /\.outlet-search input\s*\{[^}]*min-height:\s*44px/);
  assert.match(read('pages/finance/index.wxml'), /<textarea[^>]+cursor-spacing="24"[^>]+adjust-position="\{\{true\}\}"/);
  assert.match(read('custom-tab-bar/index.wxss'), /min-height:\s*calc\(var\(--tab-bar-height\) \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
