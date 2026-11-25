'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const nativeRoot = path.join(__dirname, '../miniprogram');
const read = file => fs.readFileSync(path.join(nativeRoot, file), 'utf8');

function expandedStyles(file) {
  return read(file).replace(/@import "([^"]+)";/g, (_, local) =>
    expandedStyles(path.join(path.dirname(file), local)));
}

function rule(styles, selector) {
  const heading = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:^|\\n)' + heading + ' \\{([^}]+)\\}').exec(styles)?.[1] || '';
}

test('visitor profile login stays visibly solid against the dark account card', () => {
  const markup = read('pages/profile/index.wxml');
  const styles = read('pages/profile/index.wxss');
  assert.match(markup, /class="small profile-login" data-page="login" bindtap="nav">加盟商登录/);
  const login = rule(styles, '.profile-account .profile-login');
  assert.match(login, /background:\s*var\(--surface\)/);
  assert.match(login, /color:\s*var\(--brand-deep\)/);
  assert.match(login, /width:\s*auto/);
});

test('shared status badges fit their labels and default to a neutral appearance', () => {
  const styles = expandedStyles('app.wxss');
  const badge = rule(styles, '.badge');
  assert.match(badge, /display:\s*inline-block/);
  assert.match(badge, /background:\s*var\(--neutral-bg\)/);
  assert.doesNotMatch(badge, /nowrap|--success-/);
  assert.match(rule(styles, '.badge.ok'), /background:\s*var\(--success-bg\)/);
  assert.match(rule(styles, '.badge.wait'), /background:\s*var\(--warning-bg\)/);
});

test('shared style rules preserve touch, safe-area, and long-identifier affordances', () => {
  const styles = expandedStyles('app.wxss');
  assert.match(rule(styles, 'button.link'), /min-height:\s*88rpx/);
  assert.match(rule(styles, '.action-dock'), /position:\s*sticky/);
  assert.match(rule(styles, '.action-dock'), /env\(safe-area-inset-bottom/);
  assert.match(styles, /\.button-hover,\s*\.tap-feedback\s*\{/);
  assert.match(rule(styles, '.picker-control::after'), /rotate\(45deg\)/);
  assert.match(rule(styles, '.chat'), /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rule(styles, '.chat'), /word-break:\s*break-all/);
});

test('training and reporting surfaces use the shared color and status system', () => {
  const trainingStyle = read('pages/training/index.wxss');
  const dashboardStyle = read('pages/dashboard/index.wxss');
  assert.doesNotMatch(trainingStyle + dashboardStyle, /#[0-9a-f]{3,8}\b/i);
  const dashboard = read('pages/dashboard/index.wxml');
  const training = read('pages/training/index.wxml');
  assert.match(dashboard, /settlementPending\s*\?\s*'notice'\s*:\s*'hint'/);
  assert.match(dashboard, /class="amount-number"/);
  assert.match(training, /class="badge [^"]+">\{\{item\.label\}\}/);
  assert.doesNotMatch(dashboard + training, /　⌄/);
});

test('shared color values have a single source', () => {
  for (const filename of ['base.wxss', 'layout.wxss', 'components.wxss']) {
    assert.doesNotMatch(read('styles/' + filename), /#[0-9a-f]{3,8}\b/i);
  }
});

test('official WXSS compilation includes the imports after the registered page styles', () => {
  const { collectStyleImports } = require('../scripts/wechat-compile.cjs');
  const pageStyles = ['app.wxss', 'pages/training/index.wxss'];
  const imports = collectStyleImports(nativeRoot, pageStyles);
  assert.deepEqual(imports, [
    'styles/tokens.wxss', 'styles/base.wxss', 'styles/layout.wxss', 'styles/components.wxss'
  ]);
  assert.deepEqual(pageStyles, ['app.wxss', 'pages/training/index.wxss']);
});

test('billing and report filters use native controls and detail values align', () => {
  const fees = read('pages/fees/index.wxml');
  const finance = read('pages/finance/index.wxml');
  const reports = read('pages/reports/index.wxml');
  assert.match(fees, /section==='bills' && scopeReady && !loading && !exactBill[^>]*class="card fees-overview"/);
  assert.match(fees, /ledgerTotals && ledgerTotals\.unpaid[^>]*class="metric-value amount-number"/);
  assert.match(fees, /<button[^>]*data-status="unpaid"[^>]*bindtap="filterStatus"/);
  assert.match(finance, /<text class="amount-number">\{\{item.value\}\}/);
  assert.match(finance, /bindtap="openBillAgreement"/);
  assert.match(reports, /<button[^>]*bindtap="open"/);
  assert.doesNotMatch(fees + finance + reports, /　⌄/);
});

test('workbench overrides the native regular button width in compact areas', () => {
  const styles = read('pages/home/index.wxss');
  assert.match(rule(styles, 'button.home-tool:not([size="mini"])'), /width:\s*100%/);
  assert.match(rule(styles, 'button.home-tool:not([size="mini"])'), /min-width:\s*0/);
  assert.match(styles, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(read('pages/home/index.wxml'), /class="workbench-notices" data-page="tasks"[^>]*bindtap="nav"/);
});

test('the report scroll target retains the selected outlet, month and return reason', () => {
  const report = read('pages/report/index.wxml');
  const formHeader = report.slice(report.indexOf('id="report-edit"'), report.indexOf('id="report-field-revenue"'));
  assert.match(formHeader, /{{outletNames\[outletIndex \+ 1\]}}/);
  assert.match(formHeader, /{{monthDisplay \|\| month}}/);
  assert.match(formHeader, /wx:if="{{canEdit && returnedReason && !directReturnedEdit}}"[\s\S]*?class="report-return-reason"><text[^>]*>退回原因：<\/text>{{returnedReason}}/);
});

test('the native tab bar has an opaque background and keeps its height without inherited page tokens', () => {
  const styles = expandedStyles('custom-tab-bar/index.wxss');
  const tabs = rule(styles, '.activity-tabs');
  const scopedTokens = rule(styles, 'page, .activity-tabs');
  assert.match(tabs, /background-color:\s*var\(--surface\)/);
  assert.match(scopedTokens, /--surface:\s*#ffffff/);
  assert.match(tabs, /min-height:\s*var\(--tab-bar-height\)/);
  assert.equal(/--tab-bar-height:\s*(\d+rpx)/.exec(scopedTokens)?.[1],
    /--tab-bar-height:\s*(\d+rpx)/.exec(read('styles/tokens.wxss'))?.[1]);
  assert.match(scopedTokens, /--brand:\s*#1555c0/);
  assert.match(rule(styles, '.activity-tab-active'), /color:\s*var\(--brand\)/);
});

test('filter buttons fit the assigned grid column and the report CTA spans the form', () => {
  const pill = rule(expandedStyles('app.wxss'), 'button.pill:not([size="mini"])');
  assert.match(pill, /width:\s*auto/);
  assert.match(pill, /min-width:\s*0/);
  assert.match(pill, /margin:\s*0/);
  assert.match(rule(read('pages/reports/index.wxss'), 'button.report-new:not([size="mini"])'), /width:\s*100%/);
});
