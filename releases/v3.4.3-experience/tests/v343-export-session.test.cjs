'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/api');

test('an export that finishes after switching accounts cannot open the previous account file', async () => {
  let token = 'old-session';
  let download;
  let opens = 0;
  global.wx = {
    getStorageSync: () => ({token}),
    downloadFile: options => { download = options; },
    openDocument: options => { opens++; options.success(); }
  };
  try {
    const oldDocument = api.openDocument('/api/export?format=pdf', 'pdf');
    assert.equal(download.header.Authorization, 'Bearer old-session');
    token = 'new-session';
    download.success({statusCode: 200, tempFilePath: '/tmp/old.pdf'});
    await assert.rejects(oldDocument, /账号已切换/);
    assert.equal(opens, 0);

    const newDocument = api.openDocument('/api/export?format=pdf', 'pdf');
    assert.equal(download.header.Authorization, 'Bearer new-session');
    download.success({statusCode: 200, tempFilePath: '/tmp/new.pdf'});
    assert.equal(await newDocument, '/tmp/new.pdf');
    assert.equal(opens, 1);
  } finally {
    delete global.wx;
  }
});
