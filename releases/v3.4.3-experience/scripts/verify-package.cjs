'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server/index.cjs');

(async () => {
  const dbPath = path.resolve(__dirname, '../var/package-verification.db');
  const app = createServer({ dbPath, env: { NODE_ENV: 'test', ADAPTER_MODE: 'mock' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const health = await fetch(base + '/health').then(r => r.json());
    assert.equal(health.data.status, 'ok');
    assert.equal(health.data.productionReady, false);
    const html = await fetch(base).then(r => r.text());
    assert.ok(html.includes('九盈英才'));
    for (const resource of ['/app.js', '/styles.css', '/export.js']) {
      assert.equal((await fetch(base + resource)).status, 200);
    }
    const login = await fetch(base + '/api/auth/dev', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'partnerA' })
    }).then(r => r.json());
    assert.ok(login.data.token);
    const state = await fetch(base + '/api/state', {
      headers: { Authorization: 'Bearer ' + login.data.token }
    }).then(r => r.json());
    assert.equal(state.data.outlets.length, 3);
    assert.ok(state.data.outlets.every(row => row.owner === 'p1'));
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.json'), 'utf8'));
    for (const route of config.pages) {
      for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
        assert.ok(fs.existsSync(path.resolve(__dirname, '../miniprogram', route + extension)));
      }
    }
    console.log(JSON.stringify({ status: 'passed', health: health.data, authorizedOutlets: state.data.outlets.length, nativePages: config.pages.length, staticFiles: 4, database: 'fresh persisted SQLite', wechatCompilation: 'not-executed' }));
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
