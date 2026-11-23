'use strict';

const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const {createServer} = require('../server/index.cjs');

async function run() {
  const app = createServer({dbPath:':memory:',env:{NODE_ENV:'test',ADAPTER_MODE:'mock'}});
  let browser;
  try {
    const state = app.store.load();
    const outlet = state.outlets.find(row => row.id==='cs');
    const requestRow = (id,type,status='pending') => ({
      id:'req-queue-'+id,type,status,outlet:outlet.id,owner:outlet.owner,
      data:{address:'隔离队列验收地址',locationStatus:'pending',reason:'隔离队列验收'},
      createdAt:'2026-11-11T09:00:00Z',trail:[],
    });
    const locationRows = Array.from({length:27},(_,index) => requestRow('location-'+index,index%2?'locationChange':'newOutlet'));
    const unrelatedRows = Array.from({length:31},(_,index) => requestRow('fee-'+index,'pauseFee'));
    state.requests.push(...locationRows,...unrelatedRows,requestRow('returned','locationChange','returned'));
    app.store.transaction(() => app.store.save(state));
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
    browser = await chromium.launch({headless:true,channel:'chrome'});
    const page = await browser.newPage();
    const apiTraces = [];
    page.on('response', async response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/collections/')) {
        const payload = await response.json().catch(() => ({}));
        apiTraces.push({path:url.pathname,query:Object.fromEntries(url.searchParams),requestId:payload.requestId});
      }
    });
    await page.goto('http://127.0.0.1:' + app.server.address().port);
    await page.locator('select[name=actor]').selectOption('manager');
    await page.locator('form[data-command=login] button[type=submit]').click();

    await page.locator('.nav [data-page=billing]').click();
    const filter = page.locator('select[name=collectionStatus]');
    assert.deepEqual(await filter.locator('option').evaluateAll(rows => rows.map(row => row.value)),['','unpaid','paid','settled_zero','reversed']);
    await page.getByText('全部账期',{exact:true}).waitFor();
    await page.getByLabel('账单月份（留空显示全部）').waitFor();
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/collections/bills?') && response.url().includes('status=paid')),
      filter.selectOption('paid'),
    ]);
    const [selected] = await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/collections/payments?') && response.url().includes('limit=25')),
      page.locator('select[name=browseCollection]').selectOption('payments'),
    ]);
    await filter.locator('option[value=success]').waitFor({state:'attached'});
    assert.equal(new URL(selected.url()).searchParams.has('status'),false);
    assert.equal(await filter.inputValue(),'');
    assert.deepEqual(await filter.locator('option').evaluateAll(rows => rows.map(row => row.value)),['','pending','success','failed','cancelled','closed']);

    await page.locator('.nav [data-page=requests]').click();
    const heading = page.getByRole('heading',{name:'业务申请与审批'});
    const search = page.locator('input[name=collectionQ]');
    assert(await heading.evaluate((element, query) => Boolean(element.compareDocumentPosition(document.querySelector(query)) & Node.DOCUMENT_POSITION_FOLLOWING),'input[name=collectionQ]'));
    await search.fill('测试无匹配事项');
    await search.press('Tab');
    await page.getByText('暂无符合条件的业务申请。',{exact:true}).waitFor();

    const browse = page.locator('select[name=browseCollection]');
    await page.locator('.nav [data-page=locations]').click();
    const expectRequests = offset => response => {
      const url = new URL(response.url());
      return url.pathname==='/api/collections/requests' && url.searchParams.get('limit')==='25' && url.searchParams.get('offset')===String(offset);
    };
    const [locationFirst] = await Promise.all([
      page.waitForResponse(expectRequests(0)),
      browse.selectOption('requests'),
    ]);
    const first = (await locationFirst.json()).data;
    assert.equal(first.total,locationRows.length);
    assert.equal(first.items.length,25);
    assert(first.items.every(row => locationRows.some(expected => row.id===expected.id)));
    await page.locator('.pagination').first().getByText('共 27 条 · 1—25',{exact:true}).waitFor();
    const [locationNext] = await Promise.all([
      page.waitForResponse(expectRequests(25)),
      page.locator('[data-action=page-next]').first().click(),
    ]);
    const next = (await locationNext.json()).data;
    assert.equal(next.total,locationRows.length);
    assert.equal(next.items.length,2);
    assert.equal(next.hasMore,false);
    assert.deepEqual([...first.items,...next.items].map(row => row.id).sort(),locationRows.map(row => row.id).sort());
    await page.locator('.pagination').first().getByText('共 27 条 · 26—27',{exact:true}).waitFor();
    const unrestricted = await page.evaluate(async () => {
      const session = JSON.parse(sessionStorage.getItem('jy-session'));
      const response = await fetch('/api/collections/requests?status=pending&limit=200',{headers:{Authorization:'Bearer '+session.token}});
      return (await response.json()).data;
    });
    assert(unrestricted.items.some(row => row.id==='req-queue-fee-0'));
    console.log(JSON.stringify({locationRequestIds:[(await locationFirst.json()).requestId,(await locationNext.json()).requestId],count:first.total,pages:[first.items.length,next.items.length]}));

    await page.locator('.nav [data-page=audit]').click();
    await page.getByRole('heading',{name:'操作审计'}).waitFor();
    assert.equal(await filter.count(),0);
    console.log(JSON.stringify(apiTraces.filter(trace => ['paid','测试无匹配事项'].some(value => Object.values(trace.query).includes(value))||trace.path==='/api/collections/payments'&&trace.query.limit==='25')));
    console.log('PASS headquarters list filters, billing scope, heading order and empty state');
  } finally {
    await browser?.close();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
