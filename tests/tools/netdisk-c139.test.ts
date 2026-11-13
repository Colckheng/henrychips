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

test('tells a folder from a file inside the file list', () => {
  // A member of the file list can be a folder too, and the platform states
  // that by its type.
  const files = c139Adapter.parseEntries({
    coLst: [
      { coID: 'f1', coName: 'a.bin', coSize: 1024, coType: 1 },
      { coID: 'd1', coName: 'folder', coType: 2 },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].sizeBytes, null);
});

test('signs a request the way the gateway of the platform expects it', () => {
  const body = '{"getOutLinkInfoReq":{"linkID":"x"}}';
  const sign = c139Adapter.signHeader(body, '2026-11-13 10:20:30', 'abcdefghij123456');
  // The header is the moment, the salt and the signature, separated by bars.
  const parts = sign.split(',');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '2026-11-13 10:20:30');
  assert.equal(parts[1], 'abcdefghij123456');
  // The signature is an upper case digest of a fixed length.
  assert.match(parts[2], /^[0-9A-F]{32}$/);
  // The same body with the same moment and salt signs the same way.
  assert.equal(c139Adapter.signHeader(body, '2026-11-13 10:20:30', 'abcdefghij123456'), sign);
  // Another body signs another way.
  assert.notEqual(c139Adapter.signHeader('{"a":1}', '2026-11-13 10:20:30', 'abcdefghij123456'), sign);
});

test('the signature of a request carries a moment and a salt of its own', () => {
  const sign = c139Adapter.signHeader('{"a":1}');
  const parts = sign.split(',');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(parts[1].length, 16);
  assert.match(parts[2], /^[0-9A-F]{32}$/);
});
