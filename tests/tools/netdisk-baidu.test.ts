import test from 'node:test';
import assert from 'node:assert/strict';
import { baiduAdapter } from '../../src/tools/netdisk/adapters/baidu.js';

test('reads the entries of a share', () => {
  const files = baiduAdapter.parseEntries({
    list: [
      { fs_id: 'f1', server_filename: 'a.bin', size: 1024, isdir: '0' },
      { path: '/folder', server_filename: 'folder', isdir: '1' },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[0].id, 'f1');
  // A folder is addressed by its path, because the navigation uses it.
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].id, '/folder');
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(baiduAdapter.parseEntries({}), []);
  assert.deepEqual(baiduAdapter.parseEntries(undefined), []);
});

test('turns the codes of the platform into a message', () => {
  assert.match(baiduAdapter.describeError(-6, ''), /登录态/);
  assert.match(baiduAdapter.describeError(112, ''), /提取码/);
  assert.equal(baiduAdapter.describeError(0, '原文'), '原文');
});

test('reads the address of a file out of the answer', () => {
  assert.equal(baiduAdapter.parseDlink({ info: [{ dlink: 'https://d.pcs.baidu.com/file' }] }), 'https://d.pcs.baidu.com/file');
  assert.equal(baiduAdapter.parseDlink({ info: [] }), '');
  assert.equal(baiduAdapter.parseDlink({}), '');
});
