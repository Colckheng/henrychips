import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { xunleiAdapter } from '../../src/tools/netdisk/adapters/xunlei.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

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

test('the token of the user reaches the platform', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      seen.push({ url, headers: options?.headers });
      return {
        finalUrl: url,
        status: 200,
        data: { name: 'a.bin', size: 1024, links: { url: 'https://dl.xunlei.com/a.bin' } },
      };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url) => ({
      finalUrl: url,
      status: 206,
      contentType: 'application/octet-stream',
      bytes: new Uint8Array(),
      setCookie: [],
      headers: { 'accept-ranges': 'bytes' },
    }),
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async () => { throw new Error('unexpected request'); },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const context: AdapterContext = {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'abc123',
    shareUrl: 'https://pan.xunlei.com/s/abc123',
    code: null,
    credential: { token: 'ACCESS_TOKEN' },
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
  const file = { id: 'f1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false };
  const link = await xunleiAdapter.link(context, file);
  assert.equal(link.url, 'https://dl.xunlei.com/a.bin');
  // The platform refuses the request of a link without the token of the user.
  const request = seen.find(call => call.url.includes('/drive/v1/files/'));
  assert.ok(request, 'the link of the file must be asked');
  assert.equal(request?.headers?.Authorization, 'Bearer ACCESS_TOKEN');
});

test('a share without a token of the user is refused', async () => {
  const context: AdapterContext = {
    session: new NetdiskSession({
      http: {
        getHtml: async () => { throw new Error('unexpected request'); },
        getJson: async () => { throw new Error('unexpected request'); },
        getBinary: async () => { throw new Error('unexpected request'); },
        getRaw: async () => { throw new Error('unexpected request'); },
        getHead: async () => { throw new Error('unexpected request'); },
        postForm: async () => { throw new Error('unexpected request'); },
        postJson: async () => { throw new Error('unexpected request'); },
        getStream: async () => { throw new Error('unexpected request'); },
      },
      signal: new AbortController().signal,
    }),
    shareId: 'abc123',
    shareUrl: 'https://pan.xunlei.com/s/abc123',
    code: null,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
  const file = { id: 'f1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false };
  await assert.rejects(
    () => xunleiAdapter.link(context, file),
    (error: unknown) => error instanceof ToolError && error.code === 'ACCESS_DENIED',
  );
});
