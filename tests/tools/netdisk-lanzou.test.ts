import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net, { type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { createPublicHttp } from '../../src/core/public-http.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { acwScV2, lanzouAdapter } from '../../src/tools/netdisk/adapters/lanzou.js';
import { adaptersByPlatform } from '../../src/tools/netdisk/adapters/index.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

const SHARE_URL = 'https://wwx.lanzoui.com/iXnuF4c8sqmb';

/** The landing page of a single file share, as the platform really sends it. */
const landingPage = `<html><head><title>demo.txt</title></head><body>
  <script>var fid = 6513996;</script>
  <div class="ifr"><iframe class="ifr2" name="1" src="/fn?inner" frameborder="0" scrolling="no"></iframe></div>
  </body></html>`;

/** The inner page of the share, as the platform really sends it. */
const innerPage = `<html><head><title>demo</title></head><body>
  <script>
  var wsk_sign = 'c20230908';
  var aihidcms = '';
  var ciucjdsdc = '';
  var wp_sign = 'SIGN123';
  var v3v3 = '';
  var ajaxdata = 'SkEp';
  var kdns = 1;
  var domain1 = 'https://apifile.woozooo.com/ajaxfile.php?file=6513996';
  var domain2 = 'https://apifile.lanzouw.com/ajaxfile.php?file=6513996';
  data : { 'action':'downprocess', 'websignkey':ajaxdata, 'signs':ajaxdata, 'sign':wp_sign, 'websign':'', 'kd':kdns, 'ves':1 }
  </script>
  </body></html>`;

/** The landing page of a folder share. */
const folderPage = `<html><head><title>文件夹</title></head><body>
  <script>var filemoreajax = 1;</script>
  <script>var lx = "1"; var fid = "abc"; var t = "t1"; var k = "k1";</script>
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

/**
 * A local server behind the real public client. Only the resolver and the
 * socket are replaced, so the mime types, the encodings and the size limits
 * of the production client are the ones under test.
 */
async function transport(t: TestContext, handler: (origin: string, request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1]) => void): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  // The client only accepts the default port for an unknown host, so the url
  // carries none and the socket is steered to the local server by the mock.
  const origin = 'http://share.test';
  server.on('request', (request, response) => { handler(origin, request, response); });
  const originalConnect = net.connect;
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(net, 'connect', (options: TcpNetConnectOpts) => {
    const lookup = options.lookup as LookupFunction;
    // The connector has to hand the pinned addresses back, otherwise the
    // socket never learns where to connect.
    lookup(options.host!, { all: true }, (error, result) => {
      assert.ifError(error);
      assert.ok(Array.isArray(result));
    });
    return originalConnect({ host: '127.0.0.1', port });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return origin;
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

test('reads the file id of a landing page out of its own field', () => {
  // The landing page of the platform states the id as a plain number, not in
  // the shape of the url of an endpoint.
  const parsed = lanzouAdapter.parseSharePage(landingPage, SHARE_URL);
  assert.equal(parsed.fileId, '6513996');
  assert.equal(parsed.isFolder, false);
  assert.equal(parsed.singleFile?.name, 'demo.txt');
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

test('reads the variables of a page out of its scripts only', () => {
  // A parameter of an url in the markup around the scripts must not pass for
  // a variable of the page.
  const html = `<html><head><title>文件夹</title></head><body>
    <a href="?t=WRONG&amp;fid=999">back</a>
    <script>var filemoreajax = 1;</script>
    <script>var lx = "1"; var fid = "abc"; var t = "t1"; var k = "k1";</script>
    </body></html>`;
  const parsed = lanzouAdapter.parseSharePage(html, SHARE_URL);
  assert.deepEqual(parsed.folderParams, { lx: '1', fid: 'abc', t: 't1', k: 'k1' });
});

test('reads the endpoint and the tokens of the inner page', () => {
  const params = lanzouAdapter.parseInnerPage(innerPage);
  assert.equal(params?.endpoint, 'https://apifile.woozooo.com/ajaxfile.php?file=6513996');
  assert.equal(params?.sign, 'SIGN123');
  // The key of the request is the value of "ajaxdata", not a variable of its
  // own.
  assert.equal(params?.ajaxData, 'SkEp');
  assert.equal(params?.kdns, '1');
});

test('registers the lanzou adapter under its platform', () => {
  assert.equal(adaptersByPlatform.get('lanzou'), lanzouAdapter);
  assert.equal(adaptersByPlatform.get('lanzou')?.label, '蓝奏云');
});

test('reports a link that is no url instead of ending in a raw error', () => {
  assert.throws(
    () => lanzouAdapter.parseSharePage('<html></html>', 'not a url'),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});

test('refuses a share with a passcode when no code was given', async () => {
  const { http } = fakeHttp({ '/iXnuF4c8sqmb': { html: '<html><div id="pwbox">请输入密码</div></html>' } });
  await assert.rejects(
    () => lanzouAdapter.list(contextOf(http)),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});

test('pages through a folder share and keeps the address of every member', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: folderPage },
    '/filemoreajax.php': {
      data: {
        zt: 1,
        text: [
          { id: 'abc', fidToken: 'abc?file=999', name_all: 'movie.mp4', size: '1.5 M', isfolder: '0', time: '2024-01-01 10:00' },
          { id: 'def', name_all: 'notes.txt', size: '800', isfolder: '1' },
        ],
      },
    },
  });
  const share = await lanzouAdapter.list(contextOf(http));
  assert.equal(share.title, '文件夹');
  assert.equal(share.files.length, 2);
  // The path of a member is the name the user reads, and the signed address
  // travels in its own field.
  assert.deepEqual(share.files[0], {
    id: 'abc', path: 'movie.mp4', fidToken: 'abc?file=999', name: 'movie.mp4',
    sizeBytes: 1572864, isDirectory: false, modifiedAt: '2024-01-01 10:00',
  });
  assert.equal(share.files[1].isDirectory, true);
  assert.equal(share.files[1].sizeBytes, 800);
  // A member without an address of its own falls back to its identity.
  assert.equal(share.files[1].fidToken, 'def');
  assert.equal(share.files[1].path, 'notes.txt/');
  assert.equal(share.files[1].name, 'notes.txt');
});

test('reports a folder page whose shape the adapter cannot read', async () => {
  // A page without the list of the members must not be read as an empty
  // folder, or the share would silently look empty.
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: folderPage },
    '/filemoreajax.php': { data: { zt: 1 } },
  });
  await assert.rejects(
    () => lanzouAdapter.list(contextOf(http)),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('asks the page that failed again instead of skipping it', async () => {
  let calls = 0;
  const http: PublicHttp = {
    getHtml: async (url) => {
      if (url.endsWith('/iXnuF4c8sqmb')) return { finalUrl: url, html: folderPage, status: 200 };
      throw new Error('unexpected request');
    },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => {
      calls++;
      // The first two attempts are refused, the third one answers.
      if (calls < 3) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      return { finalUrl: '', data: { zt: 1, text: [] }, status: 200 };
    },
    postJson: async () => { throw new Error('unexpected request'); },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const share = await lanzouAdapter.list(contextOf(http));
  assert.deepEqual(share.files, []);
  assert.equal(calls, 3);
});

test('lists a single file share without a folder request', async () => {
  const { http, calls } = fakeHttp({ '/iXnuF4c8sqmb': { html: landingPage } });
  const share = await lanzouAdapter.list(contextOf(http));
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].name, 'demo.txt');
  assert.equal(share.files[0].isDirectory, false);
  assert.equal(calls.some(call => call.includes('filemoreajax')), false);
});

test('takes the download endpoint and the keys of the page of the platform', async () => {
  const { http, calls } = fakeHttp({
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'abc123' } },
    '/file/abc123': { status: 206, headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/100' } },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  const link = await lanzouAdapter.link(context, share.files[0]);
  // The link is the one the probe landed on, so it is never the raw answer
  // of the download endpoint.
  assert.equal(link.url, 'https://developer4.lanrar.com/file/abc123');
  assert.equal(link.rangeSupported, true);
  assert.deepEqual(link.source, {
    platform: 'lanzou', shareUrl: SHARE_URL, code: null, filePath: 'demo.txt', fileId: '6513996',
  });
  assert.equal(link.name, 'demo.txt');
  // The headers belong to the node that serves the file.
  assert.equal(link.headers.Referer, 'https://developer4.lanrar.com/');
  assert.equal(link.headers.Origin, 'https://developer4.lanrar.com');
  assert.equal(link.headers['User-Agent']?.includes('Chrome'), true);
  assert.equal(Object.keys(link.headers).includes('Authorization'), false);
  // The endpoint of the platform is the one the page declares, and the key of
  // the request is the value of "ajaxdata".
  const posted = calls.find(call => call.startsWith('POST https://apifile.woozooo.com/ajaxfile.php?file=6513996'));
  assert.ok(posted, 'the download endpoint of the page must be asked');
  assert.equal(posted?.includes('"sign":"SIGN123"'), true);
  assert.equal(posted?.includes('"websignkey":"SkEp"'), true);
  assert.equal(posted?.includes('"signs":"SkEp"'), true);
  // The endpoint of an older shape must not be asked at all.
  assert.equal(calls.some(call => call.includes('ajaxm.php')), false);
});

test('takes the range conclusion from the probe instead of assuming it', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'plain' } },
    // A plain answer without a range header must not claim a resuming.
    '/file/plain': { status: 200, headers: {} },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  const link = await lanzouAdapter.link(context, share.files[0]);
  assert.equal(link.rangeSupported, false);
});

test('reports a page of the node instead of handing it out as a link', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'page' } },
    '/file/page': { status: 200, contentType: 'text/html; charset=utf-8' },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  await assert.rejects(
    () => lanzouAdapter.link(context, share.files[0]),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('reports a link that no longer works instead of handing it out', async () => {
  for (const status of [403, 404, 410]) {
    const { http } = fakeHttp({
      '/iXnuF4c8sqmb': { html: landingPage },
      '/fn?inner': { html: innerPage },
      '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'gone' } },
      '/file/gone': { status },
    });
    const context = contextOf(http);
    const share = await lanzouAdapter.list(context);
    await assert.rejects(
      () => lanzouAdapter.link(context, share.files[0]),
      (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
    );
  }
});

test('reports a node that refuses the requests as a rate problem', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'busy' } },
    '/file/busy': { status: 429 },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  await assert.rejects(
    () => lanzouAdapter.link(context, share.files[0]),
    (error: unknown) => error instanceof ToolError && error.code === 'NETWORK_ERROR',
  );
});

test('gives up on a node that only answers with redirects', async () => {
  const { http } = fakeHttp({
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 1, dom: 'https://developer4.lanrar.com', url: 'loop' } },
    '/file/loop': { status: 302, headers: { location: 'https://developer4.lanrar.com/file/loop' } },
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
    '/iXnuF4c8sqmb': { html: landingPage },
    '/fn?inner': { html: innerPage },
    '/ajaxfile.php?file=6513996': { data: { zt: 0, inf: '密码不正确' } },
  });
  const context = contextOf(http);
  const share = await lanzouAdapter.list(context);
  await assert.rejects(
    () => lanzouAdapter.link(context, share.files[0]),
    (error: unknown) => error instanceof ToolError && error.code === 'INVALID_INPUT',
  );
});

test('answers the challenge of the node with the cookie it asks for', () => {
  const arg1 = '0874DAC8D7647554B5817FB63EDFFC3850A09917';
  // The answer is the token with its bytes permuted and then masked.
  assert.equal(/^[0-9a-f]{40}$/.test(acwScV2(arg1)), true);
  assert.notEqual(acwScV2(arg1), acwScV2('1E6E7ED365DE6F543CA2A836541FFC085BAF04A5'));
});

/** The token of the challenge the download node hands out. */
const CHALLENGE_TOKEN = '0874DAC8D7647554B5817FB63EDFFC3850A09917';

/**
 * The answer the node expects for its challenge. The table is a copy of the
 * one of the platform, so the test judges the adapter by an oracle that does
 * not come from the adapter itself.
 */
const CHALLENGE_POS = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36];
const CHALLENGE_MASK = '3000176000856006061501533003690027800375';

function expectedChallengeCookie(token: string): string {
  const shuffled = new Array<string>(CHALLENGE_POS.length);
  for (let x = 0; x < token.length; x++) {
    for (let z = 0; z < CHALLENGE_POS.length; z++) {
      if (CHALLENGE_POS[z] === x + 1) shuffled[z] = token[x];
    }
  }
  const joined = shuffled.join('');
  let out = '';
  for (let i = 0; i + 2 <= joined.length && i + 2 <= CHALLENGE_MASK.length; i += 2) {
    const value = parseInt(joined.slice(i, i + 2), 16);
    const mask = parseInt(CHALLENGE_MASK.slice(i, i + 2), 16);
    out += (value ^ mask).toString(16).padStart(2, '0');
  }
  return out;
}

test('runs the request of the adapter through the real public client', async (t) => {
  // The fake transport of the other cases cannot show a mismatch between the
  // mime type of an answer and the type the client accepts, so the request of
  // the adapter runs through the production client here.
  const challenge = `<html><script>var arg1='${CHALLENGE_TOKEN}';</script></html>`;
  const seen: string[] = [];
  const origin = await transport(t, (origin, request, response) => {
    seen.push(request.url ?? '');
    if (request.url === '/abc') {
      // The page names the endpoint of the download, so the endpoint has to
      // point at the local server for the request to reach it.
      const landing = landingPage.replace('/fn?inner', `${origin}/fn?inner`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(landing);
      return;
    }
    if (request.url === '/fn?inner') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(innerPage.replace('https://apifile.woozooo.com', origin));
      return;
    }
    if (request.url === '/ajaxfile.php?file=6513996') {
      // The platform answers with the type "text/json", which the client has
      // to accept.
      response.writeHead(200, { 'content-type': 'text/json;charset=utf-8' });
      response.end(JSON.stringify({ zt: 1, dom: origin, url: 'real' }));
      return;
    }
    if (request.url === '/file/real') {
      // The node only serves the file to a request that answers its
      // challenge, so the cookie of the answer decides what comes back.
      const cookie = request.headers.cookie ?? '';
      if (cookie.includes(`acw_sc__v2=${expectedChallengeCookie(CHALLENGE_TOKEN)}`)) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          'content-length': '4',
        });
        response.end('MZ\u0090\u0000');
        return;
      }
      // The node answers with a page that is compressed, and the client has to
      // decode it to be able to tell a page from a file.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.from(challenge, 'utf8')));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('nope');
  });
  const http = createPublicHttp(2_097_152);
  // The adapter has to talk to the local server, so the share url points at
  // the host the transport answers for.
  const context = { ...contextOf(http), shareUrl: `${origin}/abc` };
  const share = await lanzouAdapter.list(context);
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].name, 'demo.txt');
  // The whole chain of the platform is asked: the landing page, the inner
  // page, the download endpoint and the file itself.
  const link = await lanzouAdapter.link(context, share.files[0]);
  for (const path of ['/abc', '/fn?inner', '/ajaxfile.php?file=6513996', '/file/real']) {
    assert.ok(seen.includes(path), `${path} must be asked`);
  }
  // The node is asked twice, because the first answer is its challenge.
  assert.equal(seen.filter(path => path === '/file/real').length, 2);
  // The link is the one the node serves the file from, and the node says
  // that it supports resuming.
  assert.equal(link.url, `${origin}/file/real`);
  assert.equal(link.rangeSupported, true);
  assert.equal(link.source.fileId, '6513996');
});
