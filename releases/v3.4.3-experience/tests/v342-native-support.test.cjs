'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createServer } = require('../server/index.cjs');
const api = require('../miniprogram/utils/api');
const config = require('../miniprogram/config');

const wxml = fs.readFileSync(require.resolve('../miniprogram/pages/support/index.wxml'), 'utf8');
const tap = dataset => ({ currentTarget: { dataset } });
const inputEvent = (value, field) => ({ ...tap({ field }), detail: { value } });

function page(query = {}) {
  let definition;
  global.Page = value => { definition = value; };
  const entry = require.resolve('../miniprogram/pages/support/index');
  delete require.cache[entry];
  require(entry);
  const result = {
    ...definition,
    data: structuredClone(definition.data),
    route: 'pages/support/index',
    setData(patch) {
      for (const [path, value] of Object.entries(patch)) {
        const keys = path.split('.');
        const target = keys.slice(0, -1).reduce((object, key) => object[key] ||= {}, this.data);
        target[keys.at(-1)] = value;
      }
    },
  };
  global.getCurrentPages = () => [result];
  result.onLoad(query);
  return result;
}

function applyNativeValue(screen, binding, eventName, value, field) {
  const fieldMarkup = wxml.match(new RegExp('<(?:input|textarea)\\b[^>]*value="' + binding + '"[^>]*>'))?.[0];
  assert.ok(fieldMarkup, 'the native input is declared');
  const handler = fieldMarkup.match(new RegExp('bind' + eventName + '="(\\w+)"'))?.[1];
  assert.ok(handler, 'native ' + eventName + ' also commits the displayed input value');
  screen[handler](inputEvent(value, field));
}

function press(screen, handler) {
  assert.match(wxml, new RegExp('<button\\b[^>]*bindtap="' + handler + '"'));
  return screen[handler](tap({}));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
}

async function fixture(run) {
  const app = createServer({ dbPath: ':memory:', env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const previous = config.apiBase;
  config.apiBase = 'http://127.0.0.1:' + app.server.address().port;
  const storage = new Map();
  const navigations = [];
  const requests = [];
  const contactLookups = [];
  let intercept;
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    showToast() {},
    navigateTo: ({url, success}) => { navigations.push(url); success?.(); },
    switchTab: ({url, success}) => { navigations.push(url); success?.(); },
    async request(options) {
      const command = options.data?.command;
      const requestUrl = new URL(options.url);
      if (requestUrl.pathname === '/api/work-contacts') contactLookups.push(Object.fromEntries(requestUrl.searchParams));
      if (intercept?.fail && intercept.command === command) {
        intercept = null;
        return options.fail(new Error('isolated network disconnected'));
      }
      let response;
      let body;
      try {
        response = await fetch(options.url, {
          method: options.method,
          headers: options.header,
          ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.data) }),
        });
        body = await response.json();
      } catch (error) {
        return options.fail(error);
      }
      if (command) {
        const result = body.data?.result;
        requests.push({ command, requestId: body.requestId, status: response.status, objectId: result?.id, objectStatus: result?.status });
      }
      if (intercept?.hold && intercept.command === command) {
        const {hold} = intercept;
        intercept = null;
        hold.entered.resolve();
        await hold.release.promise;
      }
      options.success({ statusCode: response.status, data: body });
    },
  };
  try {
    await api.login('partnerA');
    await run({ app, requests, navigations, contactLookups, interceptNext: value => { intercept = value; } });
  } finally {
    config.apiBase = previous;
    delete global.Page;
    delete global.getCurrentPages;
    delete global.wx;
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

test('consultation and ticket take the displayed native value at blur and preserve the distinct records through resolution', context => fixture(async ({app, requests, navigations}) => {
  const screen = page();
  await screen.onShow();
  const chatText = '测试网点经营月报提交问题，请协助查看。';
  applyNativeValue(screen, '{{text}}', 'blur', chatText);
  await press(screen, 'send');

  const [chat] = app.store.load().supportChats;
  assert.ok(chat?.id);
  assert.equal(chat.messages[0].text, chatText);
  assert.ok(Number.isFinite(Date.parse(chat.messages[0].at)));
  assert.equal(screen.data.chat.id, chat.id);
  assert.equal(screen.data.actionNotice, '消息已发送。');
  assert.equal(app.store.load().supportTickets.length, 0);

  await press(screen, 'human');
  assert.equal(screen.data.chat.status, 'queued');
  assert.equal(app.store.load().supportChats.length, 1);
  assert.equal(app.store.load().supportTickets.length, 0);

  await screen.tab(tap({tab:'ticket'}));
  assert.equal(screen.data.showTicketForm,false);
  await press(screen,'prepareTicket');
  screen.category(inputEvent('2'));
  screen.outlet(inputEvent(String(screen.data.outlets.findIndex(outlet => outlet.id === 'cs'))));
  applyNativeValue(screen, '{{form.title}}', 'blur', '经营月报提交异常', 'title');
  applyNativeValue(screen, '{{form.description}}', 'blur', '请总部协助核对本月报送状态。', 'description');
  await press(screen, 'create');
  const [ticket] = app.store.load().supportTickets;
  assert.ok(ticket?.id);
  assert.equal(ticket.outlet, 'cs');
  assert.equal(ticket.status, 'queued');
  assert.equal(ticket.category, 'exception');
  assert.equal(screen.data.ticket.id, ticket.id);
  assert.equal(screen.data.actionNotice, '工单已提交。');

  await api.login('support');
  assert.equal((await api.detail('supportChats', chat.id)).status, 'queued');
  await api.command('support.claim', {id:ticket.id});
  await api.command('support.collaborate', {id:ticket.id, department:'运营', note:'不对外议事记录'});
  await api.command('support.reply', {id:ticket.id, text:'请补充实际经营情况。', requestSupplement:true});
  await api.login('partnerA');
  const notice = (await api.collection('messages')).items.find(entry => entry.recordId === ticket.id);
  assert.ok(notice);
  const reopened = page({id:ticket.id, returnStatus:'unread', returnNoticeId:notice.id});
  await reopened.onShow();
  assert.equal(reopened.data.ticket.id, ticket.id);
  assert.equal(reopened.data.ticket.status, 'waiting');
  assert.equal(reopened.data.ticket.messages[0].text, '请补充实际经营情况。');
  assert.ok(!JSON.stringify(reopened.data.ticket).includes('不对外议事记录'));
  reopened.backToMessages();
  assert.match(navigations.at(-1), new RegExp('/pages/messages/index\\?status=unread&id=' + notice.id));
  await api.command('message.read', {id:notice.id});
  const storedTicket = () => app.store.load().supportTickets.find(entry => entry.id === ticket.id);
  assert.equal(storedTicket().status, 'waiting');
  assert.equal((await api.collection('messages')).items.find(entry => entry.id === notice.id).read, true);

  applyNativeValue(reopened, '{{form.supplement}}', 'blur', 'This test outlet added the supporting details.', 'supplement');
  await press(reopened, 'supplement');
  assert.equal(storedTicket().status, 'active');
  assert.equal(reopened.data.ticket.status, 'active');
  await api.login('support');
  await api.command('support.close', {id:ticket.id, note:'The test ticket has been resolved.'});
  await api.login('partnerA');
  await reopened.onShow();
  assert.equal(reopened.data.ticket.status, 'closed');
  assert.ok(reopened.data.ticket.canRate);
  await press(reopened, 'rate');
  assert.equal(storedTicket().rating.score, 5);
  assert.ok(!reopened.data.ticket.canRate);

  await press(reopened, 'link');
  assert.equal(reopened.data.linkedTicket.id, ticket.id);
  applyNativeValue(reopened, '{{form.description}}', 'blur', 'The original issue needs another test review.', 'description');
  await press(reopened, 'create');
  assert.equal(storedTicket().status, 'closed');
  assert.equal(reopened.data.ticket.linkedTicketId, ticket.id);
  assert.equal(reopened.data.ticket.status, 'queued');
  assert.equal(app.store.load().supportTickets.length, 2);
  assert.ok(requests.every(entry => /^[\da-f-]{36}$/i.test(entry.requestId) && entry.status === 200));
  context.diagnostic(JSON.stringify({
    mode:'Page handler and isolated HTTP/SQLite',
    chatId:chat.id, ticketId:ticket.id, noticeId:notice.id, followUpId:reopened.data.ticket.id, requests,
  }));
}));

test('empty text and a failed request leave the draft beside the same visible action', () => fixture(async ({app, requests, interceptNext}) => {
  const screen = page();
  await screen.onShow();
  await press(screen, 'send');
  assert.equal(screen.data.actionArea, 'chat');
  assert.equal(screen.data.error, '请输入您想咨询的内容。');
  assert.match(wxml, /bindtap="send"[\s\S]*?error && actionArea==='chat'/);
  assert.equal(requests.length, 0);
  assert.equal(app.store.load().supportChats.length, 0);

  await screen.text(inputEvent('需保留的隔离咨询'));
  interceptNext({command:'support.chat', fail:true});
  await press(screen, 'send');
  assert.equal(screen.data.text, '需保留的隔离咨询');
  assert.match(screen.data.error, /网络连接失败/);
  assert.equal(screen.data.actionNotice, '');
  await press(screen, 'send');
  assert.equal(app.store.load().supportChats.length, 1);
  assert.equal(screen.data.actionNotice, '消息已发送。');
}));

test('a late native input after send does not disappear when the earlier response completes', () => fixture(async ({app, requests, interceptNext}) => {
  const screen = page();
  await screen.onShow();
  screen.text(inputEvent('先发送的隔离咨询'));
  const hold = {entered:deferred(), release:deferred()};
  interceptNext({command:'support.chat', hold});
  const sending = press(screen, 'send');
  await hold.entered.promise;
  screen.text(inputEvent('输入组件随后提交的新草稿'));
  try {
    await press(screen, 'send');
  } finally {
    hold.release.resolve();
    await sending;
  }
  const [chat] = app.store.load().supportChats;
  assert.equal(chat.messages[0].text, '先发送的隔离咨询');
  assert.equal(requests.filter(entry => entry.command === 'support.chat').length, 1);
  assert.equal(screen.data.text, '输入组件随后提交的新草稿');
}));

test('a generic support visit uses headquarters contact and waits for an explicit outlet before creating a ticket', () => fixture(async ({app, requests, contactLookups}) => {
  await api.login('manager');
  await api.command('support.settings',{hours:'09:00-17:00',phone:'+441632960104',sla:{complaint:null,aftersale:null,exception:null}});
  await api.login('partnerA');
  const screen=page();
  await screen.onShow();
  assert.equal(screen.data.phoneNumber,'+441632960104');
  assert.deepEqual(contactLookups,[]);

  await screen.tab(tap({tab:'ticket'}));
  assert.equal(screen.data.showTicketForm,false);
  await press(screen,'prepareTicket');
  applyNativeValue(screen,'{{form.title}}','blur','待办异常','title');
  applyNativeValue(screen,'{{form.description}}','blur','需要总部协助','description');
  await press(screen,'create');
  assert.equal(screen.data.error,'请选择涉及网点。');
  assert.equal(requests.filter(row=>row.command==='support.ticket').length,0);
  assert.deepEqual(app.store.load().supportTickets,[]);

  const outletIndex=screen.data.outlets.findIndex(outlet=>outlet.id==='zz');
  await screen.outlet(inputEvent(String(outletIndex)));
  assert.deepEqual(contactLookups.at(-1),{outlet:'zz'});
  await press(screen,'create');
  const [ticket]=app.store.load().supportTickets;
  assert.equal(ticket.outlet,'zz');
  assert.deepEqual(contactLookups.at(-1),{outlet:'zz',recordType:'supportTickets',recordId:ticket.id});
}));

test('the chat-to-ticket action prepares only the latest customer description and never submits by itself', () => fixture(async ({app, requests}) => {
  const screen=page({outlet:'zz'});
  await screen.onShow();
  screen.text(inputEvent('前一次与本问题无关的咨询'));
  await press(screen,'send');
  screen.text(inputEvent('本次需核实账单上的金额'));
  await press(screen,'send');
  await press(screen,'prepareTicket');
  assert.equal(screen.data.tab,'ticket');
  assert.equal(screen.data.showTicketForm,true);
  assert.equal(screen.data.form.description,'本次需核实账单上的金额');
  assert.equal(screen.data.outlets[screen.data.outletIndex].id,'zz');
  assert.equal(requests.filter(row=>row.command==='support.ticket').length,0);
  await screen.tab(tap({tab:'chat'}));
  assert.deepEqual(app.store.load().supportTickets,[]);
  await press(screen,'prepareTicket');
  applyNativeValue(screen,'{{form.title}}','blur','账单确认','title');
  await press(screen,'create');
  const [ticket]=app.store.load().supportTickets;
  assert.equal(ticket.description,'本次需核实账单上的金额');
  assert.equal(ticket.outlet,'zz');
}));
