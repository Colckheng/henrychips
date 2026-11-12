import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net, { type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import { createPublicHttp, isPublicAddress, safeRequestHeaders, validatePublicUrl } from '../../src/core/public-http.js';

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

test('posts form bodies and returns parsed json', async t => {
  const { connected } = await transport(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ received: body, method: request.method }));
    });
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.postForm('http://public.test/api', { action: 'downprocess', sign: 'abc' }, new AbortController().signal);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { received: 'action=downprocess&sign=abc', method: 'POST' });
  assert.equal(connected.length, 1);
});

test('keeps the range header that a segmented download needs', async t => {
  const seen: string[] = [];
  await transport(t, (request, response) => {
    seen.push(request.headers.range ?? '');
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/100' });
    response.end('abcd');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('http://public.test/file.bin', new AbortController().signal, { headers: { Range: 'bytes=0-3' } });
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');
  assert.equal(seen[0], 'bytes=0-3');
});

test('streams a response body instead of buffering it', async t => {
  await transport(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '6' });
    response.end('abcdef');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('http://public.test/file.bin', new AbortController().signal);
  assert.equal(result.contentLength, 6);
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
});

test('exposes the response headers a segmented download needs', async t => {
  await transport(t, (_request, response) => {
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/100' });
    response.end('abcd');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('http://public.test/file.bin', new AbortController().signal, { headers: { Range: 'bytes=0-3' } });
  assert.equal(result.status, 206);
  assert.equal(result.headers['content-range'], 'bytes 0-3/100');
  for await (const _chunk of result.body) { /* drain */ }
});

test('enforces the size limit on a streamed body without a declared length', async t => {
  const state = await transport(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write('abcdef');
    response.end('ghijkl');
  });
  const http = createPublicHttp(8);
  const result = await http.getStream('http://public.test/file.bin', new AbortController().signal, { maxBytes: 8 });
  assert.equal(result.contentLength, null);
  const received: Buffer[] = [];
  await assert.rejects(async () => {
    for await (const chunk of result.body) received.push(Buffer.from(chunk));
  }, { code: 'LIMIT_EXCEEDED' });
  assert.ok(Buffer.concat(received).byteLength <= 8);
  // The violation must also release the socket instead of leaving it dangling.
  await Promise.all(state.closed);
  assert.ok(state.sockets.every(socket => socket.destroyed));
});

test('keeps a streamed body within the limit readable', async t => {
  await transport(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end('abcdef');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('http://public.test/file.bin', new AbortController().signal, { maxBytes: 8 });
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
});

test('keeps resume and destroy usable on a counted stream', async t => {
  const state = await transport(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.write('abcdef');
    response.end('ghijkl');
  });
  const http = createPublicHttp(8);
  // A resumed stream has no consumer awaiting the error, so the limit
  // violation must not escape as an uncaught exception.
  const resumed = await http.getStream('http://public.test/file.bin', new AbortController().signal, { maxBytes: 8 });
  resumed.body.resume();
  const destroyed = await http.getStream('http://public.test/file.bin', new AbortController().signal, { maxBytes: 8 });
  destroyed.body.destroy(new Error('caller gave up'));
  await Promise.all(state.closed);
  assert.ok(state.sockets.every(socket => socket.destroyed));
});

test('posts json bodies with a json content type', async t => {
  const seen: { body?: string; type?: string; method?: string } = {};
  await transport(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.body = body;
      seen.type = request.headers['content-type'];
      seen.method = request.method;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.postJson('http://public.test/api', { id: '42', tags: ['a'] }, new AbortController().signal);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.type, 'application/json');
  assert.equal(seen.body, JSON.stringify({ id: '42', tags: ['a'] }));
});

test('drops the credentials of the old host on a redirect to another host', async (t) => {
  const seen: Array<{ host: string; cookie?: string; authorization?: string }> = [];
  await transport(t, (req, res) => {
    seen.push({ host: req.headers.host ?? '', cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.headers.host === 'share.test') {
      res.writeHead(302, { location: 'http://cdn.test/file.bin' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main>ok</main>');
  });
  const result = await createPublicHttp(2_097_152).getHtml('http://share.test/', signal(), {
    headers: { Cookie: 'sid=secret', Authorization: 'Bearer token' },
  });
  assert.equal(result.finalUrl, 'http://cdn.test/file.bin');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].cookie, 'sid=secret');
  assert.equal(seen[0].authorization, 'Bearer token');
  // The session of the old host must not reach the new one.
  assert.equal(seen[1].cookie, undefined);
  assert.equal(seen[1].authorization, undefined);
});

test('keeps the credentials on a redirect inside the same host', async (t) => {
  const seen: Array<{ cookie?: string; authorization?: string }> = [];
  await transport(t, (req, res) => {
    seen.push({ cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.url === '/start') {
      res.writeHead(302, { location: '/next' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main>ok</main>');
  });
  await createPublicHttp(2_097_152).getHtml('http://share.test/start', signal(), {
    headers: { Cookie: 'sid=secret', Authorization: 'Bearer token' },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].cookie, 'sid=secret');
  assert.equal(seen[1].authorization, 'Bearer token');
});

test('drops the body and the method on a redirect to another host', async (t) => {
  const seen: Array<{ host: string; method?: string; body: string }> = [];
  await transport(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ host: req.headers.host ?? '', method: req.method, body });
      if (req.headers.host === 'share.test') {
        res.writeHead(302, { location: 'http://cdn.test/api' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await createPublicHttp(2_097_152).postJson('http://share.test/api', { token: 'secret' }, signal());
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body, JSON.stringify({ token: 'secret' }));
  // The body can carry a token, so the hop to the new host is a plain GET.
  assert.equal(seen[1].method, 'GET');
  assert.equal(seen[1].body, '');
});

test('keeps the method and the body on a redirect inside the same host', async (t) => {
  const seen: Array<{ method?: string; body: string }> = [];
  await transport(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, body });
      if (req.url === '/start') {
        res.writeHead(307, { location: '/next' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await createPublicHttp(2_097_152).postJson('http://share.test/start', { token: 'secret' }, signal());
  assert.equal(seen.length, 2);
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, JSON.stringify({ token: 'secret' }));
});

test('collects the set cookie of every hop of a redirect chain', async (t) => {
  await transport(t, (req, res) => {
    if (req.headers.host === 'share.test') {
      res.writeHead(302, { location: 'http://cdn.test/file.bin', 'set-cookie': 'cdn_sid=abc; Path=/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'final=1; Path=/' });
    res.end('x');
  });
  const response = await createPublicHttp(2_097_152).getRaw('http://share.test/', signal());
  // The cookie of the first hop is the one the caller is after.
  assert.deepEqual(response.setCookie, ['cdn_sid=abc; Path=/', 'final=1; Path=/']);
});

test('keeps its own content type over the one of the caller', async (t) => {
  const seen: { type?: string } = {};
  await transport(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      seen.type = req.headers['content-type'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await createPublicHttp(2_097_152).postJson('http://public.test/api', { id: '1' }, signal(), {
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(seen.type, 'application/json');
});

test('drops the content type with the body on a redirect to another host', async (t) => {
  const seen: Array<{ host: string; type?: string }> = [];
  await transport(t, (req, res) => {
    seen.push({ host: req.headers.host ?? '', type: req.headers['content-type'] });
    if (req.headers.host === 'share.test') {
      res.writeHead(302, { location: 'http://cdn.test/api' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await createPublicHttp(2_097_152).postJson('http://share.test/api', { token: 'secret' }, signal(), {
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, 'application/json');
  // The body is gone, so the content type that describes it is gone as well.
  assert.equal(seen[1].type, undefined);
});

test('keeps the content type on a redirect inside the same host', async (t) => {
  const seen: Array<{ type?: string }> = [];
  await transport(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      seen.push({ type: req.headers['content-type'] });
      if (req.url === '/start') {
        res.writeHead(307, { location: '/next' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await createPublicHttp(2_097_152).postJson('http://share.test/start', { token: 'secret' }, signal());
  assert.equal(seen.length, 2);
  assert.equal(seen[1].type, 'application/json');
});

test('reads the response head without the body of a large response', async (t) => {
  const state = await transport(t, (req, res) => {
    if (req.headers.host === 'share.test') {
      res.writeHead(302, { location: 'http://cdn.test/file.bin', 'set-cookie': 'cdn_sid=abc; Path=/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096', 'set-cookie': 'final=1; Path=/' });
    res.end('x'.repeat(4096));
  });
  const head = await createPublicHttp(1024).getHead('http://share.test/', signal());
  assert.equal(head.status, 200);
  assert.equal(head.finalUrl, 'http://cdn.test/file.bin');
  // The cookie of the first hop is the one the caller is after, and the large
  // body of the CDN response does not stop the head from being read.
  assert.deepEqual(head.setCookie, ['cdn_sid=abc; Path=/', 'final=1; Path=/']);
  assert.equal(head.headers['content-length'], '4096');
  // The unread body must not leave the socket dangling.
  await Promise.all(state.closed);
  assert.ok(state.sockets.every(socket => socket.destroyed));
});

test('keeps the cookies of a redirect chain readable when the body is too large', async (t) => {
  await transport(t, (req, res) => {
    if (req.headers.host === 'share.test') {
      res.writeHead(302, { location: 'http://cdn.test/file.bin', 'set-cookie': 'cdn_sid=abc; Path=/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' });
    res.end('x'.repeat(4096));
  });
  // Reading the body of the CDN response fails on the size limit.
  await assert.rejects(createPublicHttp(1024).getRaw('http://share.test/', signal()), { code: 'LIMIT_EXCEEDED' });
  // The head of the same chain is still readable, so the cookie of the first
  // hop does not get lost with the body.
  const head = await createPublicHttp(1024).getHead('http://share.test/', signal());
  assert.deepEqual(head.setCookie, ['cdn_sid=abc; Path=/']);
});

test('filters request headers against the allowlist', () => {
  const allowed = safeRequestHeaders({ Range: 'bytes=0-3', Authorization: 'Bearer token', 'X-Requested-With': 'XMLHttpRequest' });
  assert.deepEqual(allowed, { range: 'bytes=0-3', authorization: 'Bearer token', 'x-requested-with': 'XMLHttpRequest' });
  const forbidden = safeRequestHeaders({
    Host: 'evil.test',
    'Content-Length': '10',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
  });
  assert.deepEqual(forbidden, {});
  assert.deepEqual(safeRequestHeaders({ Range: 'bytes=0-3\r\nX-Injected: 1' }), {});
  assert.deepEqual(safeRequestHeaders({ Range: 'bytes=0-3\nX-Injected: 1' }), {});
});
