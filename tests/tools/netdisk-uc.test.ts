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

test('lists the root by zero without a first fid and walks into the folders', async () => {
  // The token of a share with several members at the top states no first
  // member at all, so the root has to be asked for by zero and every folder
  // in it walked into.
  const requested: string[] = [];
  const pages: Record<string, Record<string, unknown>[]> = {
    '0': [
      { fid: 'd1', file_name: 'EE', dir: true },
      { fid: 'f1', file_name: 'a.flac', size: 266, dir: false },
      { fid: 'f2', file_name: 'b.jpg', size: 250442, dir: false },
    ],
    d1: [
      { fid: 'd2', file_name: '视频', dir: true },
      { fid: 'f3', file_name: 'clip.mp4', size: 6649325793, dir: false },
    ],
    d2: [{ fid: 'f4', file_name: 'c.txt', size: 105, dir: false }],
  };
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url) => {
      requested.push(url);
      const query = new URL(url).searchParams;
      const parent = query.get('pdir_fid') ?? '';
      const page = Number(query.get('_page') ?? '1');
      const list = page === 1 ? pages[parent] ?? [] : [];
      return {
        finalUrl: url,
        status: 200,
        data: { status: 200, code: 0, data: { total: list.length, list } },
        setCookie: [],
      };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: 'application/octet-stream',
      bytes: new Uint8Array(),
      setCookie: [],
      headers: {},
    }),
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, _body, _signal, _options) => {
      if (url.includes('/share/sharepage/token')) {
        return {
          finalUrl: url,
          status: 200,
          // No first_fid: the platform does not state one for this share.
          data: { status: 200, data: { stoken: 's1', title: 'EE 等3个文件', file_num: 3 } },
          setCookie: [],
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const context: AdapterContext = {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'f64f183b70b84',
    shareUrl: 'https://drive.uc.cn/s/f64f183b70b84',
    code: null,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
  const share = await ucAdapter.list(context);
  assert.equal(share.title, 'EE 等3个文件');
  assert.deepEqual(share.files.map(file => file.path), [
    // The walk goes into a folder as soon as it meets it, so the members of
    // EE come before the files that sit next to EE at the root.
    'EE/', 'EE/视频/', 'EE/视频/c.txt', 'EE/clip.mp4', 'a.flac', 'b.jpg',
  ]);
  assert.equal(share.files.find(file => file.path === 'EE/clip.mp4')?.sizeBytes, 6649325793);
  const parents = requested.map(url => new URL(url).searchParams.get('pdir_fid'));
  assert.equal(parents[0], '0');
  assert.ok(parents.includes('d1'));
  assert.ok(parents.includes('d2'));
});

test('reads a folder across pages', async () => {
  const first = Array.from({ length: 50 }, (_, index) => ({ fid: `f${index}`, file_name: `file-${index}.bin`, size: 1, dir: false }));
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url) => {
      const query = new URL(url).searchParams;
      const page = Number(query.get('_page') ?? '1');
      const list = page === 1 ? first : [{ fid: 'f50', file_name: 'file-50.bin', size: 1, dir: false }, { fid: 'f51', file_name: 'file-51.bin', size: 1, dir: false }];
      return {
        finalUrl: url,
        status: 200,
        data: { status: 200, code: 0, data: { total: 52, list } },
        setCookie: [],
      };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: 'application/octet-stream',
      bytes: new Uint8Array(),
      setCookie: [],
      headers: {},
    }),
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, _body, _signal, _options) => ({
      finalUrl: url,
      status: 200,
      data: { status: 200, data: { stoken: 's1', title: '标题' } },
      setCookie: [],
    }),
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
  const share = await ucAdapter.list(context);
  assert.equal(share.files.length, 52);
  assert.equal(share.files[51].path, 'file-51.bin');
});

test('a refused folder is reported instead of read as empty', async () => {
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url) => ({
      finalUrl: url,
      status: 404,
      data: { status: 404, code: 41038, message: '文件没有被分享:[{0}]' },
      setCookie: [],
    }),
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url) => ({
      finalUrl: url,
      status: 200,
      contentType: 'application/octet-stream',
      bytes: new Uint8Array(),
      setCookie: [],
      headers: {},
    }),
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, _body, _signal, _options) => ({
      finalUrl: url,
      status: 200,
      data: { status: 200, data: { stoken: 's1', title: '标题' } },
      setCookie: [],
    }),
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
  await assert.rejects(() => ucAdapter.list(context), /文件没有被分享/);
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
