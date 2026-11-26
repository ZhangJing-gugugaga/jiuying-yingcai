'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validate } = require('../scripts/wechat-validate.cjs');

const nativeRoot = path.resolve(__dirname, '../miniprogram');
const deployedPages = [
  'home', 'login', 'join', 'outlets', 'outlet', 'reports', 'report', 'fees', 'requests',
  'location', 'support', 'dashboard', 'messages', 'profile', 'finance',
  'agreements', 'tasks', 'discover', 'service-detail', 'security', 'training', 'agency-progress',
].map(page => `pages/${page}/index`);

test('native packaging preserves the launch page, main tabs and all 22 deployed paths', () => {
  const checks = validate(nativeRoot);
  assert.equal(checks.valid, true, checks.errors.join('\n'));
  assert.equal(checks.pages, deployedPages.length);
  assert.ok(checks.routeManifest, 'validation reports a complete native route manifest');
  const { routes, mainPages, subpackages } = checks.routeManifest;
  assert.deepEqual([...routes].sort(), [...deployedPages].sort());
  assert.equal(mainPages[0], 'pages/home/index');
  const app = require('../miniprogram/app.json');
  for (const item of app.tabBar.list) assert.ok(mainPages.includes(item.pagePath));
  assert.deepEqual(subpackages.map(item => item.root).sort(),
    ['agreements', 'dashboard', 'security', 'training'].map(page => `pages/${page}`));
  assert.equal(mainPages.length, 18);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-subpackages-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = {
    pages: ['pages/home/index'],
    subpackages: [{ root: 'pages/one', pages: ['index'] }, { root: 'pages/two', pages: ['index'] }],
  };
  function write(file, content) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  write('project.config.json', JSON.stringify({ compileType: 'miniprogram', miniprogramRoot: './' }));
  for (const page of ['home', 'one', 'two']) {
    const route = `pages/${page}/index`;
    write(route + '.js', 'Page({})');
    write(route + '.wxml', '<view />');
    write(route + '.wxss', '');
    write(route + '.json', '{}');
  }
  function check() {
    write('app.json', JSON.stringify(app));
    return validate(directory);
  }
  return { app, check, write };
}

test('validation rejects tabs and main pages assigned to a subpackage', t => {
  const { app, check } = fixture(t);
  app.tabBar = { list: [{ pagePath: 'pages/one/index' }] };
  assert.match(check().errors.join('\n'), /tab.*主包.*pages\/one\/index/);
  delete app.tabBar;
  app.pages.push('pages/one/index');
  assert.match(check().errors.join('\n'), /主包.*分包.*pages\/one\/index/);
});

test('validation rejects nested subpackage roots before scanning pages', t => {
  const { app, check } = fixture(t);
  app.subpackages.push({ root: 'pages/one/nested', pages: ['index'] });
  assert.match(check().errors.join('\n'), /分包根目录.*重叠/);
});

test('validation checks the native files of each registered subpackage page', t => {
  const { app, check } = fixture(t);
  app.subpackages[1].pages = ['missing'];
  assert.match(check().errors.join('\n'), /缺文件.*pages\/two\/missing\.wxml/);
});

test('ordinary subpackages can use shared code while main and peer dependencies are rejected', t => {
  const { check, write } = fixture(t);
  write('utils/shared.js', 'module.exports = {}');
  write('pages/one/index.js', "require('../../utils/shared'); Page({});");
  write('pages/two/shared.js', 'module.exports = {}');
  const allowed = check();
  assert.equal(allowed.valid, true, allowed.errors.join('\n'));
  write('pages/home/index.js', "require('../two/shared'); Page({});");
  write('pages/one/index.js', "require('../two/shared'); Page({});");
  const blocked = check();
  assert.equal(blocked.valid, false);
  assert.match(blocked.errors.join('\n'), /pages\/home\/index\.js.*pages\/two\/shared/);
  assert.match(blocked.errors.join('\n'), /pages\/one\/index\.js.*pages\/two\/shared/);
});

test('validation rejects peer template and stylesheet dependencies', t => {
  const { check, write } = fixture(t);
  write('pages/one/index.wxml', '<include src="../two/index.wxml" />');
  write('pages/one/index.wxss', '@import "../two/index.wxss";');
  const result = check();
  assert.match(result.errors.join('\n'), /pages\/one\/index\.wxml.*pages\/two\/index\.wxml/);
  assert.match(result.errors.join('\n'), /pages\/one\/index\.wxss.*pages\/two\/index\.wxss/);
});
