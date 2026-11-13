import test from 'node:test';
import assert from 'node:assert/strict';
import { pan123Adapter } from '../../src/tools/netdisk/adapters/pan123.js';

test('the signature of the platform is built the way it expects it', () => {
  // The minute is counted from sixteen hours ahead, then every digit is
  // replaced through the table of the platform before it is hashed.
  const sign = pan123Adapter.makeSign('/b/api/share/download/info', 1760000000);
  assert.equal(sign.authKey, '07269615');
  assert.match(sign.authValue, /^1760000000-\d+-[0-9a-f]{8}$/);
});

test('the two headers of a request always travel together', () => {
  const first = pan123Adapter.makeSign('/b/api/share/get', 1760000000);
  const second = pan123Adapter.makeSign('/b/api/share/get', 1760000000);
  assert.equal(first.authKey, second.authKey);
  // The random part of the value is different every time.
  assert.notEqual(first.authValue, second.authValue);
});

test('reads the entries of a share', () => {
  const files = pan123Adapter.parseEntries({
    list: [
      { fid: 'f1', fileName: 'a.bin', size: 1024, isDir: false },
      { fid: 'd1', fileName: 'folder', isDir: true },
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
  assert.deepEqual(pan123Adapter.parseEntries({}), []);
  assert.deepEqual(pan123Adapter.parseEntries(undefined), []);
});

test('unwraps the address of a file from both shapes', () => {
  // A whole base64 of the address.
  assert.equal(pan123Adapter.decodeDownloadUrl(Buffer.from('https://cdn.example.com/a').toString('base64')), 'https://cdn.example.com/a');
  // A download-v2 wrapper around the address.
  const params = Buffer.from('https://cdn.example.com/b').toString('base64url');
  assert.equal(pan123Adapter.decodeDownloadUrl(`https://www.123865.com/download-v2?params=${params}&x=1`), 'https://cdn.example.com/b');
  assert.equal(pan123Adapter.decodeDownloadUrl(''), null);
});

test('turns the codes of the platform into a message', () => {
  assert.match(pan123Adapter.describeError(401, ''), /登录态/);
  assert.match(pan123Adapter.describeError(429, ''), /频繁/);
  assert.equal(pan123Adapter.describeError(0, '原文'), '原文');
});
