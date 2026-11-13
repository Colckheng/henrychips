import test from 'node:test';
import assert from 'node:assert/strict';
import { xunleiAdapter } from '../../src/tools/netdisk/adapters/xunlei.js';

test('reads the entries of a share', () => {
  const files = xunleiAdapter.parseEntries({
    files: [
      { id: 'f1', name: 'a.bin', size: 1024, kind: 'drive#file' },
      { id: 'd1', name: 'folder', kind: 'drive#folder' },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].sizeBytes, null);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(xunleiAdapter.parseEntries({}), []);
  assert.deepEqual(xunleiAdapter.parseEntries(undefined), []);
});

test('the state of the passcode becomes a message of its own', () => {
  assert.match(xunleiAdapter.describeShareStatus('PASS_CODE_NEED') ?? '', /提取码/);
  assert.match(xunleiAdapter.describeShareStatus('PASS_CODE_EMPTY') ?? '', /提取码/);
  assert.match(xunleiAdapter.describeShareStatus('PASS_CODE_ERROR') ?? '', /不正确/);
  assert.equal(xunleiAdapter.describeShareStatus(''), null);
});
