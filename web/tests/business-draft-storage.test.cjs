'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const drafts = require('../../miniprogram/utils/business-drafts');
const { stripDevelopment } = require('../scripts/wechat-build.cjs');

test('business recovery rejects expired, changed-account and unsupported scopes', t => {
  const storage = new Map();
  const previous = global.wx;
  global.wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) };
  t.after(() => { global.wx = previous; });
  const start = Date.parse('2026-11-20T02:00:00Z');
  let time = start;
  t.mock.method(Date, 'now', () => time);
  const session = { role: 'partner', subject: 'p1', token: 'credential-must-not-be-in-draft', expiresAt: '2026-11-20T10:00:00Z' };
  const original = { outlet: 'cs', explanation: '经营地址更新' };
  assert.equal(drafts.save('unrelated', session, original), false);
  assert.equal(drafts.save('location', session, original), true);
  assert.deepEqual(drafts.read('location', session), original);
  assert.doesNotMatch(JSON.stringify([...storage.values()]), /credential-must-not-be-in-draft/);
  time += 2 * 60 * 60 * 1000 + 1;
  assert.equal(drafts.read('location', session), null);
  assert.equal(storage.size, 0);
  assert.equal(drafts.save('location', session, original), true);
  assert.equal(drafts.read('location', { ...session, subject: 'p2' }), null);
  assert.equal(storage.size, 0);
  assert.equal(drafts.save('location', { ...session, role: 'public' }, original), false);
  assert.equal(drafts.save('support', { ...session, role: 'public' }, original), true);
  drafts.clearAll();
  assert.equal(storage.size, 0);
});

test('workflow diagnostics contain a fixed event and outcome and are stripped in a release build', t => {
  const log = t.mock.method(console, 'info', () => {});
  const track = require('../../miniprogram/utils/track');
  track.track('open_home', 'opened', { contact: 'private' });
  track.trackCommand('support.ticket', { result: { description: 'private' } });
  track.trackCommand('support.ticket', { result: {}, replayed: true });
  track.track('unapproved-event', 'started');
  assert.deepEqual(log.mock.calls.map(call => call.arguments[1]), [
    { event: 'open_home', outcome: 'opened' }, { event: 'ticket_submit', outcome: 'submitted' },
  ]);
  const released = stripDevelopment(fs.readFileSync(require.resolve('../../miniprogram/utils/track'), 'utf8'));
  assert.doesNotMatch(released, /console|ticket_submit|open_home/);
});
