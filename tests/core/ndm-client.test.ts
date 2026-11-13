import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNdmMessage } from '../../src/core/ndm/client.js';

test('builds the extension protocol message', () => {
  const message = buildNdmMessage({
    url: 'https://cdn.example.com/a.bin',
    fileName: 'a.bin',
    headers: { Referer: 'https://pan.quark.cn/', 'User-Agent': 'UA/1.0', Cookie: 'k=v' },
  });
  assert.ok(message.startsWith('1: GET\r\n'));
  assert.ok(message.includes('2: https://cdn.example.com/a.bin\r\n'));
  assert.ok(message.includes('4: a.bin\r\n'));
  assert.ok(message.includes('Referer: https://pan.quark.cn/\r\n'));
  assert.ok(message.includes('9: UA/1.0\r\n'));
  assert.ok(message.includes('Cookie: k=v\r\n'));
});

test('rejects a header value that would inject another field', () => {
  assert.throws(() => buildNdmMessage({
    url: 'https://cdn.example.com/a.bin', fileName: 'a.bin',
    headers: { Referer: 'https://x/\r\n2: https://evil/' },
  }), /请求头/);
});

test('rejects a header name that would inject another field', () => {
  assert.throws(() => buildNdmMessage({
    url: 'https://cdn.example.com/a.bin', fileName: 'a.bin',
    headers: { 'X-Bad\r\n2': 'https://evil/' },
  }), /请求头/);
});

test('keeps a name of a header that the protocol does not name', () => {
  const message = buildNdmMessage({
    url: 'https://cdn.example.com/a.bin', fileName: 'a.bin',
    headers: { 'X-Custom': 'value' },
  });
  assert.ok(message.includes('X-Custom: value\r\n'));
});

test('escapes a quote in the file name of the disposition', () => {
  const message = buildNdmMessage({ url: 'https://cdn.example.com/a.bin', fileName: 'a"b.bin' });
  assert.ok(message.includes('Content-Disposition: attachment; filename="a_b.bin"\r\n'));
});
