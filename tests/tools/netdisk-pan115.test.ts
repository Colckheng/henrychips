import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import type { AdapterContext, NetdiskFile } from '../../src/tools/netdisk/types.js';
import { pan115Adapter } from '../../src/tools/netdisk/adapters/pan115.js';

const SHARE_URL = 'https://115cdn.com/s/sw1';
const SHARE_ID = 'sw1';

/** The answers of the list endpoint, keyed by the folder they describe. */
const snapAnswers: Record<string, unknown> = {
  '0': {
    state: true,
    data: {
      shareinfo: { share_title: '测试分享' },
      userinfo: { user_id: 'u1' },
      count: 2,
      list: [
        { fid: 'd1', n: '资料', fc: 0, cid: 'c9' },
        { fid: 'f1', n: '根文件.bin', s: 100, fc: 1 },
      ],
    },
  },
  c9: {
    state: true,
    data: {
      count: 2,
      list: [
        { fid: 'f2', n: '子文件.txt', s: 200, fc: 1 },
        { fid: 'd2', n: '更深', fc: 0, cid: 'c10' },
      ],
    },
  },
  c10: {
    state: true,
    data: {
      count: 1,
      list: [{ fid: 'f3', n: '深文件.md', s: 300, fc: 1 }],
    },
  },
};

function fakeHttp(downurlAnswer?: unknown): { http: PublicHttp; cids: string[] } {
  const cids: string[] = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, _options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/share/snap') {
        const cid = parsed.searchParams.get('cid') ?? '';
        cids.push(cid);
        return { finalUrl: url, status: 200, data: snapAnswers[cid] ?? { state: true, data: { count: 0, list: [] } }, setCookie: [] };
      }
      if (parsed.pathname === '/1/web/1.0/api/chrome') {
        return { finalUrl: url, status: 200, data: { data: { win: { version_code: '36.0.1' } } }, setCookie: [] };
      }
      if (parsed.pathname === '/share/downurl') {
        return { finalUrl: url, status: 200, data: downurlAnswer, setCookie: [] };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async () => { throw new Error('unexpected request'); },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  return { http, cids };
}

function contextOf(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: SHARE_ID,
    shareUrl: SHARE_URL,
    code: 'u5a9',
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('picks the address out of the three shapes the platform uses', () => {
  assert.equal(pan115Adapter.pickDownloadUrl({ file_url_302: 'https://a' }), 'https://a');
  assert.equal(pan115Adapter.pickDownloadUrl({ file_url: 'https://b' }), 'https://b');
  assert.equal(pan115Adapter.pickDownloadUrl({ url: { url: 'https://c' } }), 'https://c');
  assert.equal(pan115Adapter.pickDownloadUrl({}), '');
  assert.equal(pan115Adapter.pickDownloadUrl(undefined), '');
});

test('reads the entries of a share with the field names of the platform', () => {
  const files = pan115Adapter.parseEntries({
    list: [
      { fid: 'f1', n: 'a.bin', s: 1024, fc: 1 },
      { fid: 'd1', n: 'folder', fc: 0, cid: 'c9' },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  // A folder is marked by a zero and is addressed by its cid.
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].id, 'c9');
  assert.equal(files[1].sizeBytes, null);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(pan115Adapter.parseEntries({}), []);
  assert.deepEqual(pan115Adapter.parseEntries(undefined), []);
});

test('reads the id of the user who made the share', () => {
  assert.equal(pan115Adapter.parseSharerId({ userinfo: { user_id: 'u1' } }), 'u1');
  assert.equal(pan115Adapter.parseSharerId({ userinfo: { user_id: 42 } }), '42');
  assert.equal(pan115Adapter.parseSharerId({}), '');
});

test('builds the referer the platform checks a share against', () => {
  assert.equal(pan115Adapter.shareReferer('sw1', null), 'https://115cdn.com/s/sw1');
  assert.equal(pan115Adapter.shareReferer('sw1', 'abcd'), 'https://115cdn.com/s/sw1?password=abcd&');
});

test('the client user agent carries the version the platform asks for', () => {
  assert.equal(pan115Adapter.clientUserAgent('36.0.1'), 'Mozilla/5.0 115Browser/36.0.1');
});

test('turns the error code of the platform into a message', () => {
  // The codes say what went wrong, so the user does not have to read the
  // message of the platform to know whether a passcode is missing or wrong.
  assert.match(pan115Adapter.describeError({ state: false, code: 4100012 }), /提取码/);
  assert.match(pan115Adapter.describeError({ state: false, code: 4100008 }), /不正确/);
  assert.match(pan115Adapter.describeError({ state: false, code: 4100026 }), /不存在/);
  assert.match(pan115Adapter.describeError({ state: false, code: 50029 }), /版本/);
  // A message of the platform is used when the code says nothing.
  assert.equal(pan115Adapter.describeError({ state: false, error: '平台自己的话' }), '平台自己的话');
  assert.match(pan115Adapter.describeError({ state: false, code: 12345 }), /12345/);
});

test('walks into the folders of a share instead of stopping at the root', async () => {
  const { http, cids } = fakeHttp();
  const share = await pan115Adapter.list(contextOf(http));
  assert.equal(share.title, '测试分享');
  // Every folder stays in the list, and a file deep down carries the
  // folders it is in, so the picker can show it in its place. The walk
  // goes into a folder right after it is listed, so the files of the
  // folder come before the later members of the root.
  assert.deepEqual(share.files.map(file => file.path), [
    '资料/',
    '资料/子文件.txt',
    '资料/更深/',
    '资料/更深/深文件.md',
    '根文件.bin',
  ]);
  assert.equal(share.files[0].id, 'c9');
  assert.equal(share.files[1].sizeBytes, 200);
  assert.equal(share.files[3].sizeBytes, 300);
  // The root is read first, then each folder by its own cid.
  assert.deepEqual(cids, ['0', 'c9', 'c10']);
});

test('says that a login is needed when the link endpoint refuses a guest', () => {
  // The platform answers a timed-out login without a code, so the words
  // of the answer have to be read as well.
  assert.equal(pan115Adapter.isLoginError({ state: false, code: 990001 }), true);
  assert.equal(pan115Adapter.isLoginError({ state: false, error: '登录超时，请重新登录。' }), true);
  assert.equal(pan115Adapter.isLoginError({ state: false, msg: '登录已过期' }), true);
  assert.equal(pan115Adapter.isLoginError({ state: false, error: '平台自己的话' }), false);
  assert.equal(pan115Adapter.isLoginError({ state: false, code: 4100008 }), false);
});

test('a timed-out login while taking a link says plainly that a login is needed', async () => {
  const { http } = fakeHttp({ state: false, error: '登录超时，请重新登录。' });
  const file: NetdiskFile = {
    id: 'f1',
    path: '根文件.bin',
    name: '根文件.bin',
    sizeBytes: 100,
    isDirectory: false,
  };
  await assert.rejects(
    () => pan115Adapter.link(contextOf(http), file),
    (error: unknown) => error instanceof ToolError
      && error.code === 'ACCESS_DENIED'
      && /取直链需要登录 115 账号/.test(error.message)
      && /列目录不需要登录/.test(error.message)
      && /登录超时，请重新登录。/.test(error.message),
  );
});
