'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../../miniprogram');
const read = file => readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = new Set([...read('styles/tokens.wxss').matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
const sharedFiles = ['styles/base.wxss', 'styles/components.wxss', 'styles/layout.wxss', 'custom-tab-bar/index.wxss'];
const errors = [];
for (const file of sharedFiles) {
  const css = read(file);
  if (/#[\da-f]{3,8}\b|\brgba?\(/i.test(css)) errors.push(`${file} 直接使用色值，请引用主题令牌`);
  for (const [, token] of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (!tokens.has(token)) errors.push(`${file} 引用了未定义的主题令牌 ${token}`);
  }
}

const app = JSON.parse(read('app.json'));
for (const tab of app.tabBar.list) {
  if (!/class="[^"\n]*\btab-page\b/.test(read(tab.pagePath + '.wxml'))) errors.push(`${tab.pagePath} 缺少底栏安全区`);
}

const audit = { valid: errors.length === 0, scope: '公共样式与四个 Tab 安全区', checkedFiles: sharedFiles.length + app.tabBar.list.length, errors };
console.log(JSON.stringify(audit, null, 2));
if (!audit.valid) process.exitCode = 1;
