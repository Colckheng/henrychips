import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { quarkAdapter } from '../../src/tools/netdisk/adapters/quark.js';
import { adaptersByPlatform } from '../../src/tools/netdisk/adapters/index.js';
import type { AdapterContext, NetdiskFile } from '../../src/tools/netdisk/types.js';

const SHARE_URL = 'https://pan.quark.cn/s/abc123';
const SHARE_ID = 'abc123';
const STOKEN = 'STOKEN_VALUE';
const GUEST_TOKEN = 'GUEST_PUGS_VALUE';
const CDN_URL = 'https://dl.quark.cn/file/demo.bin';

/** The answer of the token endpoint, as the platform really sends it. */
const tokenAnswer = {
  status: 200,
  code: 0,
  message: '',
  data: { stoken: STOKEN, title: '测试分享', first_fid: '987654321' },
};

/** The answer of the file list endpoint, as the platform really sends it. */
const detailAnswer = {
  status: 200,
  code: 0,
  message: '',
  data: {
    list: [
      { fid: '1001', file_name: 'demo.bin', size: 1048576, dir: false, share_fid_token: 'TOKEN_1001', updated_at: '2024-05-01 10:00:00' },
      { fid: '1002', file_name: '资料', size: 0, dir: true, share_fid_token: 'TOKEN_1002', updated_at: '2024-05-01 10:00:00' },
    ],
    total: 2,
  },
};

/** The answer of the download endpoint, with the guest token in both places. */
const downloadAnswer = {
  status: 200,
  code: 0,
  message: '',
  data: [
    { download_url: CDN_URL, file_name: 'demo.bin', size: 1048576, guest_pugs: GUEST_TOKEN },
  ],
  guest_pugs: GUEST_TOKEN,
};

interface Route {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
  /** The cookies the platform sets on the answer. */
  setCookie?: string[];
}

interface Recorded {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The routes of the fake server, keyed by the path of the url. */
function fakeHttp(routes: Record<string, Route>): { http: PublicHttp; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const pick = (url: string): Route => {
    const parsed = new URL(url);
    const route = routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (!route) throw new Error(`unexpected request: ${url}`);
    return route;
  };
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      recorded.push({ method: 'GET', url, headers: options?.headers });
      const route = pick(url);
      return { finalUrl: url, data: route.data, status: route.status ?? 200, setCookie: route.setCookie };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url, _signal, options) => {
      recorded.push({ method: 'GET', url, headers: options?.headers });
      const route = pick(url);
      return {
        finalUrl: url,
        status: route.status ?? 200,
        contentType: route.contentType ?? 'application/octet-stream',
        bytes: new Uint8Array(),
        setCookie: [],
        headers: route.headers ?? {},
      };
    },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, body, _signal, options) => {
      recorded.push({ method: 'POST', url, body, headers: options?.headers });
      const route = pick(url);
      return { finalUrl: url, data: route.data, status: route.status ?? 200, setCookie: route.setCookie };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  return { http, recorded };
}

function contextOf(http: PublicHttp, code: string | null = null): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: SHARE_ID,
    shareUrl: SHARE_URL,
    code,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

/** The file of the share, as the list endpoint hands it out. */
const file: NetdiskFile = {
  id: '1001',
  path: 'demo.bin',
  name: 'demo.bin',
  sizeBytes: 1048576,
  isDirectory: false,
  fidToken: 'TOKEN_1001',
};

test('reads the token of a share out of the answer', () => {
  const token = quarkAdapter.parseShareToken(tokenAnswer);
  assert.equal(token.stoken, STOKEN);
  assert.equal(token.title, '测试分享');
  assert.equal(token.firstFid, '987654321');
  // An answer without a token is empty instead of broken.
  assert.deepEqual(quarkAdapter.parseShareToken({}), { stoken: '', title: '', firstFid: '' });
});

test('reads the entries of a folder out of the answer', () => {
  const files = quarkAdapter.parseEntries(detailAnswer.data);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'demo.bin');
  assert.equal(files[0].sizeBytes, 1048576);
  assert.equal(files[0].isDirectory, false);
  // The token of the member is what the download request asks for.
  assert.equal(files[0].fidToken, 'TOKEN_1001');
  assert.equal(files[0].modifiedAt, '2024-05-01 10:00:00');
  // A folder is shown with a trailing slash so the path reads like a path.
  assert.equal(files[1].path, '资料/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].sizeBytes, null);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(quarkAdapter.parseEntries({}), []);
  assert.deepEqual(quarkAdapter.parseEntries(undefined), []);
});

test('reads the guest token out of the answer of the download', () => {
  const download = quarkAdapter.parseDownload(downloadAnswer);
  assert.equal(download.url, CDN_URL);
  assert.equal(download.fileName, 'demo.bin');
  assert.equal(download.sizeBytes, 1048576);
  assert.equal(download.guestToken, GUEST_TOKEN);
  // The platform repeats the token at the top level of the answer.
  const repeated = quarkAdapter.parseDownload({ data: [{ download_url: CDN_URL }], guest_pugs: GUEST_TOKEN });
  assert.equal(repeated.guestToken, GUEST_TOKEN);
  // An answer without the token is empty instead of broken.
  assert.equal(quarkAdapter.parseDownload({ data: [{ download_url: CDN_URL }] }).guestToken, '');
});

test('turns the business codes of the platform into a message', () => {
  // The guest limit of the platform is a limit of the visitor, not a fault.
  assert.match(quarkAdapter.describeError(23018, ''), /游客/);
  assert.match(quarkAdapter.describeError(31001, ''), /登录/);
  // Every other code carries the words of the platform.
  assert.equal(quarkAdapter.describeError(41017, '提取码错误'), '提取码错误');
  assert.match(quarkAdapter.describeError(9999, ''), /业务码/);
});

test('registers the quark adapter under its platform', () => {
  assert.equal(adaptersByPlatform.get('quark'), quarkAdapter);
  assert.equal(adaptersByPlatform.get('quark')?.label, '夸克网盘');
});

test('lists the files of a share the way the web client of the platform does', async () => {
  const { http, recorded } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
  });
  const share = await quarkAdapter.list(contextOf(http));
  assert.equal(share.title, '测试分享');
  assert.equal(share.files.length, 2);
  assert.equal(share.files[0].path, 'demo.bin');
  assert.equal(share.files[1].path, '资料/');

  const token = recorded.find(call => call.url.includes('/sharepage/token'));
  assert.ok(token, 'the token of the share must be asked');
  assert.deepEqual(token.body, {
    pwd_id: SHARE_ID,
    passcode: '',
    support_visit_limit_private_share: true,
  });

  const detail = recorded.find(call => call.url.includes('/sharepage/detail'));
  assert.ok(detail, 'the list of the folder must be asked');
  const query = new URL(detail.url).searchParams;
  assert.equal(query.get('pwd_id'), SHARE_ID);
  assert.equal(query.get('stoken'), STOKEN);
  assert.equal(query.get('pdir_fid'), '987654321');
  assert.equal(query.get('_page'), '1');
  assert.equal(query.get('_size'), '100');
  assert.equal(query.get('_sort'), 'file_type:asc,file_name:asc');
  // The platform refuses the list of a request without the origin of its own
  // page, so both have to be part of it.
  assert.equal(detail.headers?.Origin, 'https://pan.quark.cn');
  assert.equal(detail.headers?.Referer, 'https://pan.quark.cn/');
});

test('takes the guest token into the jar of the host and into the link', async () => {
  const { http, recorded } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: downloadAnswer },
    '/file/demo.bin': {
      status: 206,
      headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/1048576' },
    },
  });
  const context = contextOf(http);
  const link = await quarkAdapter.link(context, file);
  assert.equal(link.url, CDN_URL);
  assert.equal(link.rangeSupported, true);
  assert.equal(link.sizeBytes, 1048576);
  assert.equal(link.name, 'demo.bin');
  // The CDN refuses the download without the guest token, and the jar of the
  // session does not travel with the link, so the token is in the headers.
  assert.equal(link.headers.Cookie, `__pugs=${GUEST_TOKEN}`);
  assert.equal(link.headers.Referer, 'https://pan.quark.cn/');
  assert.equal(link.headers.Origin, 'https://pan.quark.cn');
  // The probe of the link carries the token as well.
  const probe = recorded.find(call => call.url === CDN_URL);
  assert.equal(probe?.headers?.Cookie, `__pugs=${GUEST_TOKEN}`);

  // The download request asks for the file by its own id and its own token.
  const download = recorded.find(call => call.url.includes('/file/download'));
  assert.deepEqual(download?.body, {
    fids: ['1001'],
    fids_token: ['TOKEN_1001'],
    pwd_id: SHARE_ID,
    stoken: STOKEN,
    speedup_session: '',
    token: '',
  });
  assert.deepEqual(link.source, {
    platform: 'quark', shareUrl: SHARE_URL, code: null, filePath: 'demo.bin', fileId: '1001',
  });
  // The guest of the platform downloads small files only.
  assert.match(link.note ?? '', /游客/);
});

test('takes the guest token out of the cookies of the answer', async () => {
  // The platform hands out the token of the guest in the `Set-Cookie` of the
  // answer, not in the body of it. The body of the answer does not carry it
  // at all, so a token read from the body would always be empty.
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': {
      data: { status: 200, code: 0, data: [{ download_url: CDN_URL, file_name: 'demo.bin', size: 1048576 }] },
      setCookie: [`__pugs=${GUEST_TOKEN}; Path=/`],
    },
    '/file/demo.bin': {
      status: 206,
      headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/1048576' },
    },
  });
  const link = await quarkAdapter.link(contextOf(http), file);
  // The CDN refuses the download without the token of the guest.
  assert.equal(link.headers.Cookie, `__pugs=${GUEST_TOKEN}`);
});

test('takes the range conclusion from the probe instead of assuming it', async () => {  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: downloadAnswer },
    // A plain answer without a range header must not claim a resuming.
    '/file/demo.bin': { status: 200, headers: {} },
  });
  const link = await quarkAdapter.link(contextOf(http), file);
  assert.equal(link.rangeSupported, false);
});

test('reports a download that the CDN refuses instead of handing it out', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: downloadAnswer },
    // The CDN answers 412 when the guest token does not reach it.
    '/file/demo.bin': { status: 412 },
  });
  await assert.rejects(
    () => quarkAdapter.link(contextOf(http), file),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('reports a download answer without a guest token instead of handing it out', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    // The answer holds no guest token, so the CDN refuses the file.
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: { status: 200, code: 0, data: [{ download_url: CDN_URL, file_name: 'demo.bin', size: 1048576 }] } },
    '/file/demo.bin': { status: 412 },
  });
  await assert.rejects(
    () => quarkAdapter.link(contextOf(http), file),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('reports a page of the platform instead of handing it out as a link', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: downloadAnswer },
    '/file/demo.bin': { status: 200, contentType: 'text/html; charset=utf-8' },
  });
  await assert.rejects(
    () => quarkAdapter.link(contextOf(http), file),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('reports the guest limit when the platform refuses the download', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: { status: 200, code: 23018, message: '文件大小超过限制' } },
  });
  await assert.rejects(
    () => quarkAdapter.link(contextOf(http), file),
    (error: unknown) => error instanceof ToolError
      && error.code === 'LIMIT_EXCEEDED'
      && /游客/.test(error.message),
  );
});

test('says that a login is needed when the session of the platform is not valid', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: { status: 200, code: 31001, message: '会话已失效' } },
  });
  await assert.rejects(
    () => quarkAdapter.list(contextOf(http)),
    (error: unknown) => error instanceof ToolError
      && error.code === 'ACCESS_DENIED'
      && /登录/.test(error.message),
  );
});

test('reports a wrong passcode as a problem of the input', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: { status: 200, code: 41017, message: '提取码错误' } },
  });
  await assert.rejects(
    () => quarkAdapter.list(contextOf(http, '1234')),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});

test('states an empty share instead of failing', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: { status: 200, code: 0, data: { list: [], total: 0 } } },
  });
  const share = await quarkAdapter.list(contextOf(http));
  assert.deepEqual(share.files, []);
});

test('sends the passcode of the share to the platform', async () => {
  const { http, recorded } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
  });
  await quarkAdapter.list(contextOf(http, 'a1b2'));
  const token = recorded.find(call => call.url.includes('/sharepage/token'));
  assert.deepEqual(token?.body, {
    pwd_id: SHARE_ID,
    passcode: 'a1b2',
    support_visit_limit_private_share: true,
  });
});

test('finds the file again when a link is fetched a second time', async () => {
  const { http, recorded } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
    '/1/clouddrive/file/download': { data: downloadAnswer },
    '/file/demo.bin': { status: 206, headers: { 'accept-ranges': 'bytes' } },
  });
  // A link that is fetched again knows only the id of the file, so the share
  // is read again to find the token of the member.
  const refreshed: NetdiskFile = {
    id: '1001', path: 'demo.bin', name: 'demo.bin', sizeBytes: 1048576, isDirectory: false,
  };
  const link = await quarkAdapter.link(contextOf(http), refreshed);
  assert.equal(link.url, CDN_URL);
  const download = recorded.find(call => call.url.includes('/file/download'));
  assert.deepEqual(download?.body, {
    fids: ['1001'],
    fids_token: ['TOKEN_1001'],
    pwd_id: SHARE_ID,
    stoken: STOKEN,
    speedup_session: '',
    token: '',
  });
});

test('reports a file that is not in the share instead of guessing one', async () => {
  const { http } = fakeHttp({
    '/1/clouddrive/share/sharepage/token': { data: tokenAnswer },
    '/1/clouddrive/share/sharepage/detail': { data: detailAnswer },
  });
  const missing: NetdiskFile = {
    id: '9999', path: 'other.bin', name: 'other.bin', sizeBytes: 1, isDirectory: false,
  };
  await assert.rejects(
    () => quarkAdapter.link(contextOf(http), missing),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('lists the share from the root of the platform when the stated root is refused', async () => {
  // The platform states the root of the share, and the list is asked for it.
  // When that root is refused, the root of the platform is asked for instead.
  const parents: string[] = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, _options) => {
      const query = new URL(url).searchParams;
      parents.push(query.get('pdir_fid') ?? '');
      // The stated root of the share is refused, and only the root of the
      // platform answers with the list of the members.
      if (query.get('pdir_fid') === '987654321') throw new ToolError('TOOL_FAILED', '根目录不存在');
      if (query.get('pdir_fid') !== '0') {
        return { finalUrl: url, status: 200, data: { status: 200, code: 0, data: { list: [], total: 0 } } };
      }
      return {
        finalUrl: url,
        status: 200,
        data: { status: 200, code: 0, data: detailAnswer.data },
      };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, _body) => {
      return { finalUrl: url, status: 200, data: tokenAnswer };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const share = await quarkAdapter.list(contextOf(http));
  assert.equal(share.files.length, 2);
  // The stated root is asked for first, and the root of the platform after it.
  assert.deepEqual(parents.slice(0, 2), ['987654321', '0']);
});

