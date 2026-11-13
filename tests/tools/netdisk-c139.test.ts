import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { c139Adapter } from '../../src/tools/netdisk/adapters/c139.js';

test('the body of a share request survives the round trip', () => {
  const plain = JSON.stringify({ getOutLinkInfoReq: { linkID: 'x', passwd: '' } });
  const encrypted = c139Adapter.encryptBody(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(c139Adapter.decryptBody(encrypted), plain);
});

test('the encrypted body carries a fresh iv every time', () => {
  const plain = '{"a":1}';
  assert.notEqual(c139Adapter.encryptBody(plain), c139Adapter.encryptBody(plain));
});

test('a compressed answer is uncompressed as well', () => {
  const plain = '{"resultCode":"0","data":{"caLst":[]}}';
  const iv = randomBytes(16);
  const key = Buffer.from('wI6jsI1J8C5A2r6C', 'utf8');
  // The answer of the platform is sometimes a compressed one, so the
  // decompression has to be part of the decryption.
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const compressed = gzipSync(Buffer.from(plain, 'utf8'));
  const encrypted = Buffer.concat([iv, cipher.update(compressed), cipher.final()]).toString('base64');
  assert.equal(c139Adapter.decryptBody(encrypted), plain);
});

test('reads the folders and the files of a share together', () => {
  const files = c139Adapter.parseEntries({
    caLst: [{ caID: 'd1', caName: 'folder' }],
    coLst: [{ coID: 'f1', coName: 'a.bin', coSize: 1024 }],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'folder/');
  assert.equal(files[0].isDirectory, true);
  assert.equal(files[1].path, 'a.bin');
  assert.equal(files[1].sizeBytes, 1024);
  assert.equal(files[1].isDirectory, false);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(c139Adapter.parseEntries({}), []);
  assert.deepEqual(c139Adapter.parseEntries(undefined), []);
});
