import test from 'node:test';
import assert from 'node:assert/strict';
import { ucAdapter } from '../../src/tools/netdisk/adapters/uc.js';

test('reads the share token of the platform', () => {
  assert.deepEqual(ucAdapter.parseShareToken({ stoken: 's1', title: '标题', first_fid: 'f1' }), {
    stoken: 's1', title: '标题', firstFid: 'f1',
  });
  assert.deepEqual(ucAdapter.parseShareToken({}), { stoken: '', title: '', firstFid: '' });
});

test('reads the entries of a share and marks the folders', () => {
  const files = ucAdapter.parseEntries({
    list: [
      { fid: 'f1', file_name: 'a.bin', size: 1024, dir: false, share_fid_token: 't1' },
      { fid: 'd1', file_name: 'folder', dir: true },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[0].fidToken, 't1');
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].fidToken, undefined);
});

test('reads the entries when the platform nests them under the detail', () => {
  const files = ucAdapter.parseEntries({ detail_info: { list: [{ fid: 'f1', file_name: 'a.bin' }] } });
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.bin');
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(ucAdapter.parseEntries({}), []);
  assert.deepEqual(ucAdapter.parseEntries(undefined), []);
});

test('turns the business codes of the platform into a message', () => {
  assert.match(ucAdapter.describeError(23018, ''), /游客/);
  assert.match(ucAdapter.describeError(31001, ''), /登录/);
  assert.match(ucAdapter.describeError(429, ''), /频繁/);
  assert.equal(ucAdapter.describeError(0, '原文'), '原文');
});

test('reads the guest token that the CDN demands back', () => {
  assert.equal(ucAdapter.readGuestToken({ data: [{ __pugs: 'p1' }] }), 'p1');
  assert.equal(ucAdapter.readGuestToken({ __pugs: 'p2' }), 'p2');
  assert.equal(ucAdapter.readGuestToken({ data: [] }), '');
});
