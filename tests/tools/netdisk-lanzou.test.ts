import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { lanzouAdapter } from '../../src/tools/netdisk/adapters/lanzou.js';
import { adaptersByPlatform } from '../../src/tools/netdisk/adapters/index.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

const SHARE_URL = 'https://wwx.lanzoui.com/iXnuF4c8sqmb';

const folderPage = `<html><head><title>文件夹</title></head><body>
  <script>var filemoreajax = 1;</script>
  <script>var ajaxm = "ajaxm.php?file=12345";</script>
  <script>var lx = "1"; var fid = "abc"; var t = "t1"; var k = "k1";</script>
  </body></html>`;

const filePage = `<html><head><title>demo.txt</title></head><body>
  <script>var ajaxm = "ajaxm.php?file=98765";</script>
  <script>var sign = "SIGN123";</script>
  <script>var websignkey = "KEY456";</script>
  <script>var websign = "WS789";</script>
  </body></html>`;

const memberPage = `<html><head><title>movie.mp4</title></head><body>
  <script>var ajaxm = "ajaxm.php?file=55555";</script>
  <script>var sign = "SIGNMEM";</script>
  <script>var websignkey = "KEYMEM";</script>
  </body></html>`;

interface Route {
  status?: number;
  html?: string;
  data?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

/** The routes of the fake server, keyed by the path and the query of the url. */
function fakeHttp(routes: Record<string, Route>): { http: PublicHttp; calls: string[] } {
  const calls: string[] = [];
  const pick = (url: string): Route => {
    const parsed = new URL(url);
    const route = routes[parsed.pathname + parsed.search] ?? routes[parsed.pathname];
    if (!route) throw new Error(`unexpected request: ${url}`);
    return route;
  };
  const http: PublicHttp = {
    getHtml: async (url) => { calls.push(`GET ${url}`); const route = pick(url); return { finalUrl: url, html: route.html ?? '', status: route.status ?? 200 }; },
    getJson: async (url) => { calls.push(`GET ${url}`); const route = pick(url); return { finalUrl: url, data: route.data, status: route.status ?? 200 }; },
    getBinary: async (url) => ({ finalUrl: url, bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async (url) => {
      calls.push(`GET ${url}`);
      const route = pick(url);
      return {
        finalUrl: route.headers?.location ? String(route.headers.location) : url,
        status: route.status ?? 200,
        contentType: route.contentType ?? 'application/octet-stream',
        bytes: new Uint8Array(),
        setCookie: [],
        headers: route.headers ?? {},
      };
    },
    getHead: async (url) => ({ finalUrl: url, status: 200, contentType: '', setCookie: [], headers: {} }),
    postForm: async (url, fields) => { calls.push(`POST ${url} ${JSON.stringify(fields)}`); const route = pick(url); return { finalUrl: url, data: route.data, status: route.status ?? 200 }; },
    postJson: async (url) => { calls.push(`POST ${url}`); const route = pick(url); return { finalUrl: url, data: route.data, status: route.status ?? 200 }; },
    getStream: async (url) => ({ finalUrl: url, status: 200, contentType: '', contentLength: 0, body: (await import('node:stream')).Readable.from([]), headers: {} }),
  };
  return { http, calls };
}

function contextOf(http: PublicHttp, code: string | null = null): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'share1',
    shareUrl: SHARE_URL,
    code,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('reads the passcode requirement and the file id out of a share page', () => {
  const html = `<html><head><title>蓝奏分享</title></head><body>
    <script>var filemoreajax = 1;</script>
    <script>var ajaxm = "ajaxm.php?file=12345";</script>
    <script>var lx = "1"; var fid = "abc"; var t = "t1"; var k = "k1";</script>
    </body></html>`;
  const parsed = lanzouAdapter.parseSharePage(html, 'https://wwx.lanzoui.com/iXnuF4c8sqmb');
  assert.equal(parsed.needsPwd, false);
  assert.equal(parsed.isFolder, true);
  assert.equal(parsed.fileId, '12345');
  assert.deepEqual(parsed.folderParams, { lx: '1', fid: 'abc', t: 't1', k: 'k1' });
});

test('detects a share that needs a passcode', () => {
  const html = `<html><body><div id="pwbox">请输入密码</div>
    <script>function down_p(){ }</script></body></html>`;
  assert.equal(lanzouAdapter.parseSharePage(html, 'https://wwx.lanzoui.com/iXnuF4c8sqmb').needsPwd, true);
});

test('parses a display size into bytes', () => {
  assert.equal(lanzouAdapter.parseDisplaySize('1.5 M'), 1572864);
  assert.equal(lanzouAdapter.parseDisplaySize('2G'), 2147483648);
  assert.equal(lanzouAdapter.parseDisplaySize('800'), 800);
});

test('registers the lanzou adapter under its platform', () => {
  assert.equal(adaptersByPlatform.get('lanzou'), lanzouAdapter);
  assert.equal(adaptersByPlatform.get('lanzou')?.label, '蓝奏云');
});

test('refuses a share with a passcode when no code was given', async () => {
  const { http } = fakeHttp({ '/iXnuF4c8sqmb': { html: '<html><div id="pwbox">请输入密码</div></html>' } });
  await assert.rejects(
    () => lanzouAdapter.list(contextOf(http)),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});

test('pages through a folder share and keeps the reference of every member', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: folderPage },
    '/filemoreajax.php': {
      data: {
        zt: 1,
        text: [
          { id: 'abc?file=999', name_all: 'movie.mp4', size: '1.5 M', isfolder: '0', time: '2024-01-01 10:00' },
          { id: 'def', name_all: 'notes.txt', size: '800', isfolder: '1' },
        ],
      },
    },
  });
  const share = await lanzouAdapter.list(contextOf(http));
  assert.equal(share.title, '文件夹');
  assert.equal(share.files.length, 2);
  assert.deepEqual(share.files[0], {
    id: 'abc', path: 'abc?file=999', name: 'movie.mp4', sizeBytes: 1572864, isDirectory: false, modifiedAt: '2024-01-01 10:00',
  });
  assert.equal(share.files[1].isDirectory, true);
  assert.equal(share.files[1].sizeBytes, 800);
});

test('lists a single file share without a folder request', async () => {
  const { http, calls } = fakeHttp({ '/iXnuF4c8sqmb': { html: filePage } });
  const share = await lanzouAdapter.list(contextOf(http));
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].name, 'demo.txt');
  assert.equal(share.files[0].isDirectory, false);
  assert.equal(calls.some(call => call.includes('filemoreajax')), false);
});

test('hands out the probed link of a file and records where it came from', async () => {
  const { http, calls } = fakeHttp({
    '/iXnuF4c8sqmb': { html: filePage },
    '/ajaxm.php': { data: { zt: 1, dom: 'https://wwx.lanzoui.com', url: 'abc123' } },
    '/file/abc123': { status: 206, headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/100' } },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  const link = await lanzouAdapter.link(context, share.files[0]);
  // The link is the one the probe landed on, so it is never the raw answer
  // of the download endpoint.
  assert.equal(link.url, 'https://wwx.lanzoui.com/file/abc123');
  assert.equal(link.rangeSupported, true);
  assert.deepEqual(link.source, {
    platform: 'lanzou', shareUrl: SHARE_URL, code: null, filePath: 'iXnuF4c8sqmb', fileId: '98765',
  });
  assert.equal(link.name, 'demo.txt');
  // The download needs the cookie of the node, but no account credential.
  assert.equal(link.headers.Cookie, 'down_ip=1');
  assert.equal(link.headers.Referer, SHARE_URL);
  assert.equal(link.headers['User-Agent']?.includes('Chrome'), true);
  assert.equal(Object.keys(link.headers).includes('Authorization'), false);
  // The download endpoint is asked with the sign of the page.
  const posted = calls.find(call => call.startsWith('POST https://wwx.lanzoui.com/ajaxm.php'));
  assert.ok(posted, 'the download endpoint must be asked');
  assert.equal(posted?.includes('"sign":"SIGN123"'), true);
  assert.equal(posted?.includes('"websignkey":"KEY456"'), true);
});

test('takes the range conclusion from the probe instead of assuming it', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: filePage },
    '/ajaxm.php': { data: { zt: 1, dom: 'https://wwx.lanzoui.com', url: 'plain' } },
    // A plain answer without a range header must not claim a resuming.
    '/file/plain': { status: 200, headers: {} },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  const link = await lanzouAdapter.link(context, share.files[0]);
  assert.equal(link.rangeSupported, false);
});

test('reads the member page of a folder share before it takes the link', async () => {
  const { http, calls } = fakeHttp({
    '/iXnuF4c8sqmb': { html: folderPage },
    '/filemoreajax.php': { data: { zt: 1, text: [{ id: 'abc?file=999', name_all: 'movie.mp4', size: '1.5 M', isfolder: '0' }] } },
    '/abc?file=999': { html: memberPage },
    '/ajaxm.php': { data: { zt: 1, dom: 'https://wwx.lanzoui.com', url: 'member1' } },
    '/file/member1': { status: 206, headers: { 'accept-ranges': 'bytes' } },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  const link = await lanzouAdapter.link(context, share.files[0]);
  // The member carries the download parameters, so its own page is read.
  assert.equal(calls.some(call => call.includes('/abc?file=999')), true);
  assert.equal(link.source.fileId, '55555');
  assert.equal(link.source.filePath, 'abc?file=999');
  assert.equal(link.headers.Referer, 'https://wwx.lanzoui.com/abc?file=999');
  const posted = calls.find(call => call.startsWith('POST https://wwx.lanzoui.com/ajaxm.php'));
  assert.equal(posted?.includes('"sign":"SIGNMEM"'), true);
});

test('reports a link that no longer works instead of handing it out', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: filePage },
    '/ajaxm.php': { data: { zt: 1, dom: 'https://wwx.lanzoui.com', url: 'gone' } },
    '/file/gone': { status: 403 },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  await assert.rejects(
    () => lanzouAdapter.link(context, share.files[0]),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('reports a wrong passcode the download endpoint answers with', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: filePage },
    '/ajaxm.php': { data: { zt: 0, inf: '密码不正确' } },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  await assert.rejects(
    () => lanzouAdapter.link(context, share.files[0]),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});
