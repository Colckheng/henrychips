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

test('the captcha signature signs the same for a fixed time', () => {
  // The value was computed with the reference implementation in
  // ~/workspace/.tmp/xunlei-live4.mjs, so the test locks the algorithm
  // instead of re-running it against itself.
  assert.equal(
    xunleiAdapter.buildCaptchaSign('78a70629a2b17d0b4302317ffa94807a', '1700000000000'),
    '1.b02d16436177c87305e160e972760c6d',
  );
});

function mockContext(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'VOy7Z0Vpgsi5VKNkz28dt2TTA1',
    shareUrl: 'https://pan.xunlei.com/s/VOy7Z0Vpgsi5VKNkz28dt2TTA1',
    code: 'xn73',
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('lists every folder of a share, each paged on its own token', async () => {
  const initCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      seen.push({ url, headers: options?.headers });
      const parsed = new URL(url);
      const page = parsed.searchParams.get('page_token') ?? '';
      if (url.includes('/drive/v1/share/detail')) {
        const parent = parsed.searchParams.get('parent_id');
        if (parent === 'd1' && page === '') {
          return { finalUrl: url, status: 200, data: { files: [
            { id: 'f2', name: 'b.bin', size: 2, kind: 'drive#file' },
            { id: 'd3', name: 'inner', kind: 'drive#folder' },
          ], next_page_token: 'dp2' } };
        }
        if (parent === 'd1' && page === 'dp2') {
          return { finalUrl: url, status: 200, data: { files: [
            { id: 'f3', name: 'c.bin', size: 3, kind: 'drive#file' },
          ], next_page_token: '' } };
        }
        if (parent === 'd2') {
          return { finalUrl: url, status: 200, data: { files: [
            { id: 'f4', name: 'd.bin', size: 4, kind: 'drive#file' },
          ], next_page_token: '' } };
        }
        if (parent === 'd3') {
          return { finalUrl: url, status: 200, data: { files: [
            { id: 'f5', name: 'e.bin', size: 5, kind: 'drive#file' },
          ], next_page_token: '' } };
        }
        throw new Error(`unexpected detail page: ${url}`);
      }
      if (page === '') {
        return { finalUrl: url, status: 200, data: { title: 'Share', pass_code_token: 'PCT', files: [
          { id: 'd1', name: 'one', kind: 'drive#folder' },
          { id: 'd2', name: 'two', kind: 'drive#folder' },
          { id: 'r1', name: 'root.bin', size: 1, kind: 'drive#file' },
        ], next_page_token: 'rp2' } };
      }
      return { finalUrl: url, status: 200, data: { files: [
        { id: 'r2', name: 'root2.bin', size: 1, kind: 'drive#file' },
      ], next_page_token: '' } };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, body) => {
      initCalls.push({ url, body: body as Record<string, unknown> });
      return { finalUrl: url, status: 200, data: { captcha_token: 'CAPTCHA_TOKEN', expires_in: 300 } };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const share = await xunleiAdapter.list(mockContext(http));
  assert.equal(share.title, 'Share');
  assert.deepEqual(share.files.map(entry => entry.path), [
    'one/', 'two/', 'root.bin', 'root2.bin',
    'one/b.bin', 'one/inner/', 'one/inner/e.bin', 'one/c.bin',
    'two/d.bin',
  ]);
  // Every folder was entered, not just the first one, and the nested folder
  // inside the first one was entered as well.
  assert.equal(share.files.filter(entry => entry.isDirectory).length, 3);
  // Every pan request carried the captcha token and the client id of the
  // app channel: a token without the client id is refused.
  for (const call of seen) {
    assert.equal(call.headers?.['X-Captcha-Token'], 'CAPTCHA_TOKEN');
    assert.equal(call.headers?.['X-Client-Id'], 'Xp6vsxz_7IYVw2BB');
  }
  // One init per action, each signed for its own action.
  assert.equal(initCalls.length, 2);
  assert.deepEqual(initCalls.map(call => (call.body as Record<string, unknown>).action), [
    'GET:/drive/v1/share', 'GET:/drive/v1/share/detail',
  ]);
  for (const call of initCalls) {
    assert.equal(call.url, 'https://xluser-ssl.xunlei.com/v1/shield/captcha/init');
    assert.equal(call.body.client_id, 'Xp6vsxz_7IYVw2BB');
    assert.equal(call.body.captcha_token, '');
    const meta = call.body.meta as Record<string, unknown>;
    assert.equal('username' in meta, false);
    assert.equal(
      meta.captcha_sign,
      xunleiAdapter.buildCaptchaSign('78a70629a2b17d0b4302317ffa94807a', String(meta.timestamp)),
    );
  }
});

test('a refused captcha token is replaced once and the listing retried', async () => {
  let shareCalls = 0;
  let initCalls = 0;
  const tokens: string[] = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      tokens.push(options?.headers?.['X-Captcha-Token'] ?? '');
      shareCalls += 1;
      if (shareCalls === 1) {
        return { finalUrl: url, status: 400, data: { error: 'captcha_invalid', error_code: 9, error_description: '验证码无效' } };
      }
      return { finalUrl: url, status: 200, data: { title: 'Share', pass_code_token: '', files: [
        { id: 'r1', name: 'root.bin', size: 1, kind: 'drive#file' },
      ], next_page_token: '' } };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url) => {
      initCalls += 1;
      return { finalUrl: url, status: 200, data: { captcha_token: `TOKEN_${initCalls}`, expires_in: 300 } };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const share = await xunleiAdapter.list(mockContext(http));
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0]?.path, 'root.bin');
  // The first init, then a fresh one for the retry.
  assert.equal(initCalls, 2);
  assert.deepEqual(tokens, ['TOKEN_1', 'TOKEN_2']);
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
