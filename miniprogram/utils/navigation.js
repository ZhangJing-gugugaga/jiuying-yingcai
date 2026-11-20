const tabs = new Set(['home', 'outlets', 'reports', 'profile']);
const tabEntries = [
  { key: 'home', label: '首页', memberLabel: '工作台', icon: 'home' },
  { key: 'outlets', label: '网点', icon: 'outlets' },
  { key: 'reports', label: '月报', icon: 'report', memberOnly: true },
  { key: 'profile', label: '我的', icon: 'profile' },
];
const pages = new Set([
  ...tabs, 'login', 'outlet', 'support', 'report', 'fees', 'requests', 'location', 'dashboard',
  'messages', 'finance', 'agreements', 'tasks', 'discover', 'service-detail', 'security', 'training'
].map(page => 'pages/' + page + '/index'));
const memberPages = new Set(['reports', 'report', 'fees', 'requests', 'location', 'dashboard', 'finance', 'agreements', 'tasks', 'security', 'training']);
const resumeFields = new Set(['outlet', 'month', 'id', 'reportId', 'billId', 'receiptId', 'ledgerBillId', 'ledgerRecordId', 'feeProposalId', 'section', 'status', 'period', 'type', 'change', 'scope', 'filterOutlet']);
const pendingByRuntime = new WeakMap();
const retryMessage = '暂时无法打开该页面，请重试。';
const inputMessage = '页面信息有误，请从原入口重新打开。';
const forbiddenMessage = '当前账号暂无权限查看此内容。';
const networkMessage = '网络连接失败，请检查网络后重试。';

function notify(title) {
  wx.showToast?.({ title, icon: 'none' });
}

function failureMessage(error) {
  const reason = String(error?.errMsg || error?.message || '');
  if (/permission|unauthori[sz]ed|forbidden|权限/i.test(reason)) return forbiddenMessage;
  if (/network|offline|timeout|timed out|网络/i.test(reason)) return networkMessage;
  if (/invalid (?:parameter|argument)|parameter error|参数/i.test(reason)) return inputMessage;
  return retryMessage;
}

function queryFields(query) {
  return Object.fromEntries(query.split('&').map(pair => {
    const equals = pair.indexOf('=');
    if (equals < 1 || !/^[a-z][a-z0-9_-]*$/i.test(pair.slice(0, equals))) throw new Error(inputMessage);
    return [pair.slice(0, equals), decodeURIComponent(pair.slice(equals + 1))];
  }));
}

function transition(action, route, url, fields, onSuccess, onSettled) {
  const runtime = wx;
  if (!pendingByRuntime.has(runtime)) pendingByRuntime.set(runtime, new Map());
  const pending = pendingByRuntime.get(runtime);
  const now = Date.now();
  const key = action + ':' + route;
  const attempt = { started: now };
  if (pending.has(key) && now - pending.get(key).started < 1000) return false;
  pending.set(key, attempt);

  const storageKey = fields ? 'jyyc.route.' + route.split('/')[1] : null;
  let previous;
  let saved = false;
  function finish() {
    if (pending.get(key) !== attempt) return false;
    pending.delete(key);
    return true;
  }
  function fail(error) {
    if (!finish()) return;
    if (saved) {
      try {
        if (previous) runtime.setStorageSync(storageKey, previous);
        else runtime.removeStorageSync(storageKey);
      } catch {}
    }
    notify(failureMessage(error));
    onSettled?.();
  }

  try {
    if (storageKey) {
      previous = runtime.getStorageSync(storageKey);
      runtime.setStorageSync(storageKey, fields);
      saved = true;
    }
    runtime[action]({ url, success() {
      if (!finish()) return;
      try { onSuccess?.(); } finally { onSettled?.(); }
    }, fail });
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

function go(page, query = '', onSuccess, onSettled) {
  const route = 'pages/' + page + '/index';
  if (!pages.has(route)) {
    notify(retryMessage);
    return false;
  }
  const isTab = tabs.has(page);
  if (page === 'support' && !query) query = 'section=home';
  let fields;
  try {
    if (query) fields = queryFields(query);
  } catch {
    notify(inputMessage);
    return false;
  }
  const url = '/' + route + (!isTab && query ? '?' + query : '');
  return transition(isTab ? 'switchTab' : 'navigateTo', route, url, isTab ? fields : null, onSuccess, onSettled);
}

function isTabPage(name) {
  return tabs.has(name);
}

function tabBarView(name, session) {
  const member = Boolean(session && session.role !== 'public');
  const items = tabEntries.filter(item => member || !item.memberOnly).map(item => ({
    key: item.key,
    label: member ? item.memberLabel || item.label : item.label,
    icon: '/assets/nav-' + item.icon + (name === item.key ? '-active' : '') + '.png',
  }));
  return { items, selected: items.some(item => item.key === name) ? name : '' };
}

function syncTabBar(page, session) {
  const name = /^pages\/([^/]+)\/index$/.exec(page.route || '')?.[1];
  if (!isTabPage(name) || typeof page.getTabBar !== 'function') return;
  page.getTabBar()?.setData(tabBarView(name, session));
}

function reLaunch(url, onSuccess) {
  const route = url.split('?')[0].slice(1);
  if (!pages.has(route)) {
    notify(retryMessage);
    return false;
  }
  return transition('reLaunch', route, url, null, onSuccess);
}

function requiresMember(page, query) {
  return memberPages.has(page) || (page === 'outlets' && query.scope === 'private');
}

function resumeDestination(page, query) {
  if (!requiresMember(page, query)) return null;
  const fields = Object.entries(query);
  if (fields.some(([name, value]) => !resumeFields.has(name) || typeof value !== 'string' || !/^[a-z0-9_:-]{1,128}$/i.test(value))) return null;
  const queryString = fields.map(([name, value]) => name + '=' + encodeURIComponent(value)).join('&');
  return { page, queryString };
}

function memberLoginUrl(page, query) {
  const destination = resumeDestination(page, query);
  const login = '/pages/login/index';
  if (!destination) return login;
  const next = destination.page + (destination.queryString ? '?' + destination.queryString : '');
  return login + '?next=' + encodeURIComponent(next);
}

function resumeAfterLogin(next) {
  const home = '/pages/home/index';
  let destination;
  if (typeof next === 'string' && next.length <= 2048) {
    try {
      const decoded = /^[a-z-]+(?:\?|$)/.test(next) ? next : decodeURIComponent(next);
      const separator = decoded.indexOf('?');
      const page = separator < 0 ? decoded : decoded.slice(0, separator);
      const query = separator < 0 ? {} : queryFields(decoded.slice(separator + 1));
      destination = resumeDestination(page, query);
    } catch {}
  }
  return reLaunch(home, destination ? () => go(destination.page, destination.queryString) : undefined);
}

function recordErrorText(error) {
  if (error.status === 404 || error.status === 410) return '该记录已更新或暂不可查看，请返回列表查看最新信息。';
  if (error.status === 403) return forbiddenMessage;
  if (error.code === 'NETWORK') return networkMessage;
  return error.message || retryMessage;
}

module.exports = { go, reLaunch, recordErrorText, requiresMember, memberLoginUrl, resumeAfterLogin, isTabPage, tabBarView, syncTabBar };
