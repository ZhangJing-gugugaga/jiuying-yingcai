'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { collectComponentEntries } = require('../scripts/wechat-components.cjs');
const { validate } = require('../scripts/wechat-validate.cjs');

const root = path.join(__dirname, '../miniprogram');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the 21 registered pages resolve packaged TDesign components and their dependencies', () => {
  const result = validate(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pages, 21);
  const entries = collectComponentEntries(root, result.routeManifest.routes);
  for (const name of ['button', 'badge', 'icon', 'cell', 'cell-group', 'input', 'empty', 'loading', 'image']) {
    assert.ok(entries.includes('vendor/tdesign/' + name + '/' + name), name);
  }
  assert.ok(entries.includes('components/number-field/index'));
  assert.match(read('vendor/tdesign/icon/icon.wxss'), /url\(data:font\/woff;base64,/);
  assert.doesNotMatch(read('vendor/tdesign/icon/icon.wxss'), /https?:\/\//);
  assert.match(read('vendor/tdesign/LICENSE'), /MIT License/);
});

test('visitor and workbench surfaces use native TDesign while preserving the existing navigation contracts', () => {
  const home = read('pages/home/index.wxml');
  assert.match(home, /class="home-public-hero"[\s\S]*?src="\/assets\/home-network.webp"/);
  assert.match(home, /data-query="scope=public&mode=map" bindtap="nav"/);
  assert.match(home, /<t-badge wx:if="{{hasUnreadNotices}}"/);
  assert.match(home, /data-page="fees" bindtap="nav"/);
  assert.match(home, /data-page="outlets" data-query="scope=private" bindtap="openOutlets"/);
  assert.match(home, /data-page="tasks" bindtap="nav"/);
  assert.match(read('pages/profile/index.wxml'), /<t-cell[^>]+data-page="security" bind:click="nav"/);
  const login = read('pages/login/index.wxml');
  assert.match(login, /<t-input[^>]+data-field="password" bind:change="input"[^>]+type="password"/);
  assert.match(login, /<t-button[^>]+bind:tap="passwordLogin"[^>]+disabled="{{busy}}"/);
  for (const page of ['reports', 'fees', 'tasks']) assert.match(read('pages/' + page + '/index.wxml'), /<t-empty\b/);
});

test('the bundled TDesign controls register in a WeChat runtime and emit compatible events', () => {
  function component(name) {
    let definition;
    const runtimeInfo = () => ({ SDKVersion: '3.7.10' });
    const sandbox = {
      Component: value => { definition = value; },
      Behavior: value => value,
      module: { exports: {} },
      getApp: () => ({}),
      wx: { getAppBaseInfo: runtimeInfo, getSystemInfoSync: runtimeInfo }
    };
    assert.doesNotThrow(() => vm.runInNewContext(read('vendor/tdesign/' + name + '/' + name + '.js'), sandbox), name);
    assert.ok(definition, name);
    const events = [];
    return {
      ...definition.methods,
      data: { ...definition.data },
      properties: {},
      events,
      setData(value) { Object.assign(this.data, value); },
      triggerEvent(name, detail) { events.push({ name, detail }); }
    };
  }

  const input = component('input');
  input.onInput({ detail: { value: 'partner-test', cursor: 12 } });
  assert.equal(input.events[0].name, 'change');
  assert.equal(input.events[0].detail.value, 'partner-test');

  const button = component('button');
  button.handleTap({ detail: {} });
  button.setData({ loading: true });
  button.handleTap({ detail: {} });
  assert.deepEqual(button.events.map(event => event.name), ['tap']);

  for (const componentName of ['grid-item', 'cell']) {
    const link = component(componentName);
    link.onClick({ detail: {}, currentTarget: { dataset: {} } });
    assert.deepEqual(link.events.map(event => event.name), ['click']);
  }
});
