'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { initializeAdmin } = require('../server/bootstrap.cjs');
const { createServer } = require('../server/index.cjs');
const { openStore } = require('../server/storage.cjs');

const production = { NODE_ENV: 'production', ADAPTER_MODE: 'disabled', PUBLIC_ORIGIN: 'https://example.test' };

async function preparedDatabase(t, configure = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-closeout-environment-'));
  const dbPath = path.join(dir, 'fixture.db');
  t.after(() => {
    for (const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, entry));
    fs.rmdirSync(dir);
  });
  const store = openStore(dbPath, { seed: false });
  try {
    await initializeAdmin(store, { username: 'isolated-fixture', password: 'Only-for-this-Isolated-Test42!', name: '隔离测试管理员' });
    const state = store.load();
    configure(state);
    store.transaction(() => store.save(state));
  } finally { store.close(); }
  return dbPath;
}

function checkStartup(dbPath, env) {
  const app = createServer({ dbPath, env });
  app.store.close();
}

function runDatabaseCommand(dbPath, mode, command, ...args) {
  const env = { ...process.env, DB_PATH: dbPath };
  if (mode === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = mode;
  return spawnSync(process.execPath, [command, ...args], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 15000,
  });
}

test('a production-marked database can only be opened by the production HTTP runtime', async t => {
  const dbPath = await preparedDatabase(t);
  assert.doesNotThrow(() => checkStartup(dbPath, production));
  assert.throws(() => checkStartup(dbPath, { NODE_ENV: 'test', ADAPTER_MODE: 'mock' }), { code: 'CONFIG' });
});

test('production refuses to expose a ledger with explicitly simulated cash records', async t => {
  const dbPath = await preparedDatabase(t, state => {
    state.bills.push({ id: 'isolated-test-bill', outlet: 'isolated-outlet', owner: 'isolated-owner', month: '2026-11', status: 'paid', amount: 20 });
    state.receipts.push({ id: 'isolated-test-receipt', billId: 'isolated-test-bill', outlet: 'isolated-outlet',
      owner: 'isolated-owner', month: '2026-11', status: 'success', amount: 20, adapterMode: 'mock' });
  });
  assert.throws(() => checkStartup(dbPath, production), { code: 'DATABASE_TEST_DATA' });
  const store = openStore(dbPath, { seed: false });
  try {
    assert.equal(store.load().receipts[0].amount, 20);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { store.close(); }
});

test('default migration and backup creation reject production databases before operations', async t => {
  const dbPath = await preparedDatabase(t);
  const backups = [];
  const attempts = [];
  for (const mode of [undefined, 'test']) {
    const backup = path.join(path.dirname(dbPath), `unexpected-${mode ?? 'default'}.db`);
    backups.push(backup);
    for (const args of [['database/migrate.cjs'], ['scripts/backup.cjs', 'create', backup]]) {
      const result = runDatabaseCommand(dbPath, mode, ...args);
      attempts.push({ command: args[0], mode: mode ?? 'default', status: result.status, stderr: result.stderr });
    }
  }
  assert.deepEqual(attempts.map(({ status }) => status), [1, 1, 1, 1], JSON.stringify(attempts));
  for (const { stderr } of attempts) assert.match(stderr, /开发与测试运行时须使用独立数据库/);
  assert.ok(backups.every(backup => !fs.existsSync(backup)));
});

test('explicit production migration and backup are compatible with initialization and recovery', async t => {
  const source = await preparedDatabase(t);
  const localDir = path.dirname(source);
  const empty = path.join(localDir, 'before-init.db'), backup = path.join(localDir, 'backup.db'), restored = path.join(localDir, 'restore.db');
  const migrate = 'database/migrate.cjs', backupScript = 'scripts/backup.cjs';
  const emptyResult = runDatabaseCommand(empty, 'production', migrate);
  assert.equal(emptyResult.status, 0, emptyResult.stderr);
  assert.equal(JSON.parse(emptyResult.stdout).developmentSeed, false);
  const emptyStore = openStore(empty, { seed: false });
  try {
    assert.equal(emptyStore.settings().mode, undefined);
    assert.equal(emptyStore.load().outlets.length, 0);
  } finally { emptyStore.close(); }
  for (const args of [[migrate], [migrate], [backupScript, 'create', backup]]) {
    const result = runDatabaseCommand(source, 'production', ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  for (const args of [[backupScript, 'verify', backup], [backupScript, 'restore', backup, restored]]) {
    const result = runDatabaseCommand(source, undefined, ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  const restoredStore = openStore(restored, { seed: false });
  try {
    assert.equal(restoredStore.settings().mode, 'production');
    assert.equal(restoredStore.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { restoredStore.close(); }
});
