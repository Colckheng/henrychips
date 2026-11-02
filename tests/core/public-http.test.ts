import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net, { type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { createPublicHttp, isPublicAddress, validatePublicUrl } from '../../src/core/public-http.js';

const signal = () => new AbortController().signal;

// Only the OS resolver/socket boundary is replaced. Real undici agents, redirects,
// response streams and the production address checks still run.
async function transport(t: TestContext, handler: RequestListener, addresses = [{ address: '93.184.216.34', family: 4 }]) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  const originalConnect = net.connect;
  const connected: string[][] = [];
  const lookups: string[] = [];
  const sockets: net.Socket[] = [];
  const closed: Promise<unknown>[] = [];
  t.mock.method(dns.promises, 'lookup', async (hostname: string) => {
    lookups.push(hostname);
    return addresses;
  });
  t.mock.method(net, 'connect', (options: TcpNetConnectOpts) => {
    assert.equal(typeof options.lookup, 'function', 'the actual connector must use a pinned DNS lookup');
    const lookup = options.lookup as LookupFunction;
    lookup(options.host!, { all: true }, (error, result) => {
      assert.ifError(error);
      assert.ok(Array.isArray(result));
      connected.push(result.map(({ address }) => address));
    });
    const socket = originalConnect({ host: '127.0.0.1', port });
    sockets.push(socket);
    closed.push(new Promise(resolve => socket.once('close', resolve)));
    return socket;
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { connected, lookups, sockets, closed };
}

test('accepts only globally routable unicast addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1',
    '2001::1', '4000::1', 'fe80::1%eth0', '8.8.8.8%eth0', 'not-an-address',
  ]) assert.equal(isPublicAddress(address), false, address);
});

test('validates schemes, credentials, ports and canonical IP literals', async () => {
  assert.equal(validatePublicUrl('https://nodejs.org:443/en').href, 'https://nodejs.org/en');
  assert.equal(validatePublicUrl('http://example.org:80/').href, 'http://example.org/');
  for (const url of [
    'file:///etc/passwd', 'ftp://example.org/', 'https://user:secret@example.org/',
    'http://example.org:443/', 'https://example.org:80/', 'http://example.org:8080/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/',
    'http://[::ffff:8.8.8.8]/', 'http://localhost/', 'http://localhost./',
  ]) await assert.rejects(createPublicHttp(1024).getHtml(url, signal()), { code: 'ACCESS_DENIED' }, url);
  await assert.rejects(createPublicHttp(1024).getHtml('not a URL', signal()), { code: 'INVALID_INPUT' });
});

test('rejects a DNS answer containing any private address before connecting', async (t) => {
  const state = await transport(t, (_req, res) => res.end('should not connect'), [
    { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(createPublicHttp(1024).getHtml('http://public.test/', signal()), { code: 'ACCESS_DENIED' });
  assert.equal(state.connected.length, 0);
});

test('pins all validated DNS answers in the connector and disposes sockets', async (t) => {
  const state = await transport(t, (req, res) => {
    assert.equal(req.headers.host, 'public.test');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<main>Hello</main>');
  }, [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  const result = await createPublicHttp(1024).getHtml('http://public.test/', signal());
  assert.deepEqual(result, { finalUrl: 'http://public.test/', html: '<main>Hello</main>', status: 200 });
  assert.deepEqual(state.lookups, ['public.test']);
  assert.deepEqual(state.connected, [['93.184.216.34', '2606:4700:4700::1111']]);
  assert.ok(state.sockets.every(socket => socket.destroyed));
});

test('validates each redirect and follows at most three hops', async (t) => {
  let requests = 0;
  const state = await transport(t, (req, res) => {
    requests++;
    const n = Number(req.url!.slice(1));
    res.writeHead(302, { location: `http://hop${n + 1}.test/${n + 1}` });
    res.end();
  });
  await assert.rejects(createPublicHttp(1024).getHtml('http://hop0.test/0', signal()), { code: 'NETWORK_ERROR' });
  assert.equal(requests, 4);
  assert.deepEqual(state.lookups, ['hop0.test', 'hop1.test', 'hop2.test', 'hop3.test']);
});

test('supports relative redirects and XHTML', async (t) => {
  await transport(t, (req, res) => {
    if (req.url === '/start') { res.writeHead(303, { location: '/article' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/xhtml+xml' });
    res.end('<html><body>Article</body></html>');
  });
  const result = await createPublicHttp(1024).getHtml('http://public.test/start', signal());
  assert.equal(result.finalUrl, 'http://public.test/article');
  assert.equal(result.html, '<html><body>Article</body></html>');
});

test('blocks redirect targets with private addresses or credentials', async (t) => {
  let location = 'http://127.0.0.1/secret';
  const state = await transport(t, (_req, res) => { res.writeHead(302, { location }); res.end(); });
  for (const target of ['http://127.0.0.1/secret', 'https://user:secret@example.org/', 'http://public.test:1234/']) {
    location = target;
    await assert.rejects(createPublicHttp(1024).getHtml('http://public.test/', signal()), { code: 'ACCESS_DENIED' });
  }
  assert.equal(state.connected.length, 3);
});

test('rejects non-HTML, non-success statuses and oversized declared or streamed bodies', async (t) => {
  await transport(t, (req, res) => {
    if (req.url === '/type') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }
    else if (req.url === '/status') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('error'); }
    else if (req.url === '/declared') { res.writeHead(200, { 'content-type': 'text/html', 'content-length': '2000' }); res.flushHeaders(); }
    else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('a'.repeat(600)); res.end('b'.repeat(600));
    }
  });
  const http = createPublicHttp(1024);
  await assert.rejects(http.getHtml('http://public.test/type', signal()), { code: 'UNSUPPORTED_FORMAT' });
  await assert.rejects(http.getHtml('http://public.test/status', signal()), { code: 'NETWORK_ERROR' });
  await assert.rejects(http.getHtml('http://public.test/declared', signal()), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(http.getHtml('http://public.test/stream', signal()), { code: 'LIMIT_EXCEEDED' });
});

test('counts UTF-8 bytes rather than string characters', async (t) => {
  await transport(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('界界界'); });
  await assert.rejects(createPublicHttp(8).getHtml('http://public.test/', signal()), { code: 'LIMIT_EXCEEDED' });
  assert.equal((await createPublicHttp(9).getHtml('http://public.test/', signal())).html, '界界界');
});

test('propagates cancellation during a response body and before DNS', async (t) => {
  const controller = new AbortController();
  let received = false;
  const chunks = channel('undici:request:bodyChunkReceived');
  const abort = () => { received = true; controller.abort(); };
  chunks.subscribe(abort);
  t.after(() => chunks.unsubscribe(abort));
  const state = await transport(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }); res.write('partial');
  });
  await assert.rejects(createPublicHttp(1024).getHtml('http://public.test/', controller.signal), { code: 'CANCELLED' });
  assert.equal(received, true);
  assert.ok(state.sockets.every(socket => socket.destroyed));
  await Promise.all(state.closed);
  await assert.rejects(createPublicHttp(1024).getHtml('http://other.test/', controller.signal), { code: 'CANCELLED' });
  assert.deepEqual(state.lookups, ['public.test']);
});

test('revalidates DNS on redirects to the same hostname and blocks rebinding', async (t) => {
  const state = await transport(t, (_req, res) => { res.writeHead(302, { location: '/next' }); res.end(); });
  let calls = 0;
  t.mock.method(dns.promises, 'lookup', async () => [{ address: ++calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  await assert.rejects(createPublicHttp(1024).getHtml('http://public.test/', signal()), { code: 'ACCESS_DENIED' });
  assert.equal(state.connected.length, 1);
});

test('rejects empty, mapped IPv6 and malformed resolver answers', async (t) => {
  const state = await transport(t, (_req, res) => res.end('must not connect'));
  for (const addresses of [[], [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    t.mock.method(dns.promises, 'lookup', async () => addresses);
    await assert.rejects(createPublicHttp(1024).getHtml('http://public.test/', signal()), { code: 'ACCESS_DENIED' });
  }
  assert.equal(state.connected.length, 0);
});

test('cancellation does not wait for a stalled resolver', async (t) => {
  const controller = new AbortController();
  t.mock.method(dns.promises, 'lookup', () => new Promise(() => {}));
  const pending = createPublicHttp(1024).getHtml('https://public.test/', controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
