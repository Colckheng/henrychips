import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { ucAdapter } from '../../src/tools/netdisk/adapters/uc.js';
import type { AdapterContext, NetdiskFile } from '../../src/tools/netdisk/types.js';

const CDN_URL = 'https://dl.uc.cn/file/demo.bin';

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

test('takes the guest token out of the cookies of the answer', async () => {
  // The platform hands out the token of the guest in the `Set-Cookie` of the
  // answer, not in the body of it. The token has to travel with a request to
  // the CDN, which is a different host.
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
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
    postJson: async (url, _body, _signal, _options) => {
      if (url.includes('/share/sharepage/token')) {
        return {
          finalUrl: url,
          status: 200,
          data: { status: 200, data: { stoken: 's1', title: '标题', first_fid: 'f1' } },
          setCookie: [],
        };
      }
      return {
        finalUrl: url,
        status: 200,
        data: { status: 200, data: [{ download_url: CDN_URL, file_name: 'demo.bin', size: 1024 }] },
        setCookie: ['__pugs=GUEST_VALUE; Path=/'],
      };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const context: AdapterContext = {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'abc123',
    shareUrl: 'https://drive.uc.cn/s/abc123',
    code: null,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
  const file: NetdiskFile = {
    id: 'f1', path: 'demo.bin', name: 'demo.bin', sizeBytes: 1024, isDirectory: false, fidToken: 't1',
  };
  const link = await ucAdapter.link(context, file);
  // The CDN refuses the download without the token of the guest.
  assert.equal(link.headers.Cookie, '__pugs=GUEST_VALUE');
});
