'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../miniprogram/app.json');
const { getNativeRoutes } = require('../scripts/wechat-routes.cjs');
const navigation = require('../miniprogram/utils/navigation');
const { define, api } = require('../miniprogram/utils/page');

test('app registers a custom tab bar and keeps contact as a detail route', () => {
  assert.equal(app.tabBar.custom, true);
  assert.deepEqual(app.tabBar.list.map(item => item.pagePath), ['home', 'outlets', 'reports', 'profile'].map(page => `pages/${page}/index`));
  const { routes } = getNativeRoutes(app);
  assert.ok(routes.includes('pages/support/index'));
  assert.ok(routes.includes('pages/messages/index'));
  assert.ok(routes.includes('pages/training/index'));
});

test('each tab page gets the correct available entries and selection across session changes', () => {
  let view;
  const page = { route: 'pages/profile/index', getTabBar: () => ({ setData: data => { view = data; } }) };
  navigation.syncTabBar(page, { role: 'public' });
  assert.deepEqual(view.items.map(tab => tab.key), ['home', 'outlets', 'profile']);
  assert.equal(view.items[0].label, '首页');
  assert.equal(view.selected, 'profile');
  navigation.syncTabBar(page, { role: 'partner' });
  assert.deepEqual(view.items.map(tab => tab.key), ['home', 'outlets', 'reports', 'profile']);
  assert.equal(view.items[0].label, '工作台');
  assert.equal(view.selected, 'profile');
  navigation.syncTabBar(page, null);
  assert.deepEqual(view.items.map(tab => tab.key), ['home', 'outlets', 'profile']);
});

test('a visitor opening a cached reports tab returns to public home before any data request', async t => {
  const oldRuntime = global.wx;
  const calls = [];
  let view;
  global.wx = {
    getStorageSync: key => key === 'jyyc.session' ? { role: 'public' } : null,
    reLaunch: ({ url, success }) => { calls.push(url); success(); },
    request: () => assert.fail('Visitor must not load a private report list'),
  };
  t.after(() => { global.wx = oldRuntime; });
  const page = { ...define({}), route: 'pages/reports/index', getTabBar: () => ({ setData: data => { view = data; } }) };
  page.onLoad({ outlet: 'cs', month: '2026-10' });
  await page.onShow();
  assert.deepEqual(calls, ['/pages/home/index']);
  assert.equal(view.selected, '');
});

test('a command finishing after page unload does not update or refresh a departed form', async t => {
  const original = api.command;
  const oldRuntime = global.wx;
  let complete;
  api.command = () => new Promise(resolve => { complete = resolve; });
  global.wx = { getStorageSync: () => ({ token: 'page-session' }), showToast: () => assert.fail('Departed form displayed an update') };
  t.after(() => { api.command = original; global.wx = oldRuntime; });
  let unloads = 0;
  const page = { ...define({ onUnload() { unloads++; } }), setData() {}, refresh: () => assert.fail('Departed form fetched new results') };
  const action = page.mutate('location.submit', { outlet: 'cs' });
  page.onUnload();
  page.setData = () => assert.fail('Departed form wrote data');
  complete({ result: { status: 'pending' } });
  assert.equal(await action, null);
  assert.equal(unloads, 1);
});

test('an expired member credential can continue an explicit public visit and still guards private reads', async t => {
  const previousWx=global.wx, previousPages=global.getCurrentPages;
  const redirected=[];
  const seen=[];
  let page={route:'pages/outlet/index',query:{scope:'public',id:'example'}};
  let session={role:'partner',token:'expired-member'};
  global.getCurrentPages=()=>[page];
  global.wx={
    getStorageSync: key=>key==='jyyc.session'?session:null,
    removeStorageSync(key){if(key==='jyyc.session')session=null;},
    setStorageSync(key,value){if(key==='jyyc.session')session=value;},
    reLaunch({url,success}){redirected.push(url);success();},
    request({url,header,success}){
      const path=new URL(url).pathname;
      const principal=header.Authorization;
      seen.push([path,principal]);
      if(path==='/api/auth/visitor')success({statusCode:200,data:{data:{role:'public',token:'visitor-session'}}});
      else if(principal==='Bearer visitor-session')success({statusCode:200,data:{data:{id:'example'}}});
      else success({statusCode:401,data:{error:{code:'UNAUTHENTICATED'},requestId:'expired-request'}});
    },
  };
  t.after(()=>{global.wx=previousWx;global.getCurrentPages=previousPages;});
  const publicOutlet=await api.request('/api/collections/outlets/example?scope=public');
  assert.deepEqual(publicOutlet,{id:'example'});
  assert.equal(redirected.length,0);
  assert.deepEqual(seen.map(([path])=>path),['/api/collections/outlets/example','/api/auth/visitor','/api/collections/outlets/example']);

  page={route:'pages/report/index',query:{outlet:'cs',month:'2026-10'}};
  session={role:'partner',token:'expired-member'};
  await assert.rejects(api.request('/api/reports/context?outlet=cs&month=2026-10'),error=>error.status===401&&error.requestId==='expired-request');
  const login=new URL(redirected[0],'https://example.test');
  assert.equal(login.pathname,'/pages/login/index');
  assert.equal(login.searchParams.get('next'),'report?outlet=cs&month=2026-10');
});

test('a delayed private read cannot inherit the public fallback of the screen opened after it', async t => {
  const previousWx=global.wx, previousPages=global.getCurrentPages;
  const delayed=[], redirects=[];
  let page={route:'pages/home/index',query:{}};
  let session={role:'partner',token:'expired-workbench'};
  global.getCurrentPages=()=>[page];
  global.wx={
    getStorageSync:key=>key==='jyyc.session'?session:null,
    removeStorageSync(key){if(key==='jyyc.session')session=null;},
    setStorageSync(key,value){if(key==='jyyc.session')session=value;},
    reLaunch({url}){redirects.push(url);},
    request(options){
      if(new URL(options.url).pathname==='/api/auth/visitor') {
        options.success({statusCode:200,data:{data:{role:'public',token:'public-reader'}}});
      } else if(options.header.Authorization==='Bearer public-reader') {
        options.success({statusCode:200,data:{data:{actor:'public'}}});
      } else delayed.push(options);
    },
  };
  t.after(()=>{global.wx=previousWx;global.getCurrentPages=previousPages;});
  const privateContext=api.request('/api/context');
  const guarded=assert.rejects(privateContext,{code:'UNAUTHENTICATED'});
  page={route:'pages/outlets/index',query:{scope:'public'}};
  const publicContext=api.request('/api/context');
  assert.equal(delayed.length,2);
  const expired={statusCode:401,data:{error:{code:'UNAUTHENTICATED'}}};
  delayed[0].success(expired);
  await guarded;
  assert.equal(session.role,'partner');
  delayed[1].success(expired);
  assert.deepEqual(await publicContext,{actor:'public'});
  assert.deepEqual(redirects,[]);
});
