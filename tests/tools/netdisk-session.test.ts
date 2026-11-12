import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';

interface SeenCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  at: number;
}

/**
 * The timer that paces the requests can fire a few milliseconds early, and a
 * busy event loop can make it fire even earlier, so the measured gap is only
 * checked with that tolerance.
 */
const PACE_TOLERANCE_MS = 10;

/** The headers as the server sees them, with the names in lower case. */
function asSent(headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
}

function fakeHttp(seen: SeenCall[], failure?: Error): PublicHttp {
  const record = (method: string, url: string, headers?: Record<string, string>, maxBytes?: number) => {
    seen.push({ method, url, headers, maxBytes, at: performance.now() });
    if (failure) throw failure;
  };
  return {
    getHtml: async (url, _signal, options) => { record('GET', url, options?.headers); return { finalUrl: url, html: '<main>ok</main>', status: 200 }; },
    getJson: async (url, _signal, options) => { record('GET', url, options?.headers); return { finalUrl: url, data: { ok: true }, status: 200 }; },
    getBinary: async () => ({ finalUrl: '', bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async (url, _signal, options) => {
      record('GET', url, options?.headers, options?.maxBytes);
      return {
        finalUrl: 'https://cdn.test/file.bin',
        status: 206,
        contentType: 'application/octet-stream',
        bytes: new Uint8Array(),
        setCookie: ['cdn_sid=abc; Path=/'],
        headers: { location: 'https://cdn.test/file.bin', 'content-range': 'bytes 0-0/100', 'accept-ranges': 'bytes' },
      };
    },
    getHead: async (url, _signal, options) => {
      record('HEAD', url, options?.headers, options?.maxBytes);
      return {
        finalUrl: 'https://cdn.test/file.bin',
        status: 206,
        contentType: 'application/octet-stream',
        setCookie: ['cdn_sid=abc; Path=/'],
        headers: { location: 'https://cdn.test/file.bin', 'content-range': 'bytes 0-0/100', 'accept-ranges': 'bytes' },
      };
    },
    postForm: async (url, fields, _signal, options) => { record('POST', url, options?.headers); return { finalUrl: url, data: { fields }, status: 200 }; },
    postJson: async (url, body, _signal, options) => { record('POST', url, options?.headers); return { finalUrl: url, data: { body }, status: 200 }; },
    getStream: async (url) => ({ finalUrl: url, status: 200, contentType: '', contentLength: 0, body: (await import('node:stream')).Readable.from([]), headers: {} }),
  };
}

test('never sends a cookie to a different host', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  await session.postJson('https://pan.quark.cn/api/1', {}, { Cookie: session.cookieHeader('https://pan.quark.cn/s/abc') });
  await session.postJson('https://115.com/api/1', {}, { Cookie: session.cookieHeader('https://115.com/s/abc') });
  assert.equal(seen[0].headers?.Cookie, 'quark_session=secret');
  assert.equal(seen[1].headers?.Cookie, undefined);
});

test('keeps cookies of the same host together and replaces duplicates', () => {
  const session = new NetdiskSession({ http: fakeHttp([]), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'a', '1');
  session.setCookie('https://pan.quark.cn/s/other', 'a', '2');
  session.setCookie('https://pan.quark.cn/s/abc', 'b', '3');
  assert.equal(session.cookieHeader('https://pan.quark.cn/s/abc'), 'a=2; b=3');
});

test('attaches the cookie of the requested host only', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  await session.postJson('https://115.com/api/1', {});
  await session.postJson('https://pan.quark.cn/api/1', {});
  assert.equal(seen[0].headers?.Cookie, undefined);
  assert.equal(seen[1].headers?.Cookie, 'quark_session=secret');
});

test('ignores a cookie written for an unusable url', () => {
  const session = new NetdiskSession({ http: fakeHttp([]), signal: new AbortController().signal });
  session.setCookie('not a url', 'a', '1');
  assert.equal(session.cookieHeader('not a url'), '');
  assert.equal(session.cookieHeader('https://pan.quark.cn/s/abc'), '');
});

test('drops a cookie the caller supplies, whatever the host', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  await session.postJson('https://115.com/api/1', {}, { Cookie: 'leaked=1' });
  // The jar of the host holds no cookie, so nothing is sent at all.
  assert.equal(seen[0].headers?.Cookie, undefined);
  assert.equal(asSent(seen[0].headers).cookie, undefined);
});

test('the jar of the host wins over a cookie the caller supplies', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  await session.postJson('https://pan.quark.cn/api/1', {}, { Cookie: 'caller=1' });
  assert.equal(seen[0].headers?.Cookie, 'quark_session=secret');
});

test('removes every cookie header the caller writes, in any case', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  await session.postJson('https://115.com/api/1', {}, { Cookie: 'a=1', cookie: 'b=2', COOKIE: 'c=3', Referer: 'https://115.com/' });
  const sent = asSent(seen[0].headers);
  assert.equal(sent.cookie, undefined);
  assert.equal(seen[0].headers?.Cookie, undefined);
  assert.equal(seen[0].headers?.cookie, undefined);
  assert.equal(seen[0].headers?.COOKIE, undefined);
  // The other headers of the caller survive.
  assert.equal(sent.referer, 'https://115.com/');
});

test('posts a form with the cookie of the host', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  const result = await session.postForm('https://pan.quark.cn/api/1', { action: 'downprocess' }, { Referer: 'https://pan.quark.cn/' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { fields: { action: 'downprocess' } });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers?.Cookie, 'quark_session=secret');
  assert.equal(asSent(seen[0].headers).referer, 'https://pan.quark.cn/');
});

test('reads a page with the cookie of the host', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  const result = await session.getHtml('https://pan.quark.cn/s/abc');
  assert.equal(result.status, 200);
  assert.equal(result.html, '<main>ok</main>');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].headers?.Cookie, 'quark_session=secret');
});

test('probes the direct link and reports where it landed', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  const result = await session.probe('https://pan.quark.cn/direct', { range: 'bytes=5-5', Referer: 'https://pan.quark.cn/' });
  assert.equal(result.finalUrl, 'https://cdn.test/file.bin');
  assert.equal(result.status, 206);
  assert.equal(result.location, 'https://cdn.test/file.bin');
  assert.equal(result.contentRange, 'bytes 0-0/100');
  assert.equal(result.acceptRanges, 'bytes');
  const sent = asSent(seen[0].headers);
  // The probe asks for one byte, so its own range wins over the caller's.
  assert.equal(sent.range, 'bytes=0-0');
  assert.equal(sent.referer, 'https://pan.quark.cn/');
});

test('reports the status of an error answer to a probe', async () => {
  const seen: SeenCall[] = [];
  const http = fakeHttp(seen);
  // A probe of a direct link needs the status of the answer, so an error
  // status reaches the caller instead of becoming a failure.
  http.getRaw = async (url, _signal, options) => {
    seen.push({ method: 'GET', url, headers: options?.headers, maxBytes: options?.maxBytes, at: performance.now() });
    return {
      finalUrl: url, status: 403, contentType: 'application/octet-stream', bytes: new Uint8Array(),
      setCookie: [], headers: {},
    };
  };
  const session = new NetdiskSession({ http, signal: new AbortController().signal });
  const probe = await session.probe('https://cdn.test/file.bin');
  assert.equal(probe.status, 403);
  assert.equal(probe.contentType, 'application/octet-stream');
});

test('hands out the response headers and the set cookie of a request', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://115.com/s/abc', 'sid', 'secret');
  const response = await session.raw('https://115.com/api/1');
  assert.equal(response.finalUrl, 'https://cdn.test/file.bin');
  assert.equal(response.status, 206);
  assert.deepEqual(response.setCookie, ['cdn_sid=abc; Path=/']);
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.equal(seen[0].headers?.Cookie, 'sid=secret');
});

test('caps the body of a raw request', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  await session.raw('https://115.com/api/1');
  // A raw request only reads the headers, so a small body is enough.
  assert.equal(seen[0].maxBytes, 64 * 1024);
  await session.raw('https://115.com/api/2', undefined, 1024 * 1024);
  assert.equal(seen[1].maxBytes, 1024 * 1024);
});

test('reads the response head without a body of its own', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://115.com/s/abc', 'sid', 'secret');
  const response = await session.head('https://115.com/api/1');
  assert.equal(response.finalUrl, 'https://cdn.test/file.bin');
  assert.equal(response.status, 206);
  assert.deepEqual(response.setCookie, ['cdn_sid=abc; Path=/']);
  assert.equal(response.headers['accept-ranges'], 'bytes');
  // The head carries no body, so it asks for no size limit of its own.
  assert.equal(seen[0].maxBytes, undefined);
  assert.equal(seen[0].headers?.Cookie, 'sid=secret');
});

test('keeps its own range under both spellings of the caller', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  await session.probe('https://pan.quark.cn/direct', { Range: 'bytes=5-5', range: 'bytes=6-6' });
  // The header names are compared in lower case, so the probe's range must be
  // the only one that is left.
  assert.equal(asSent(seen[0].headers).range, 'bytes=0-0');
});

test('keeps the authorization of the host and drops the one of the caller', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setAuthorization('https://api.139.com.cn/', 'Bearer account-token');
  await session.postJson('https://api.139.com.cn/api/1', {}, { Authorization: 'Bearer caller-token' });
  await session.postJson('https://other.test/api/1', {});
  assert.equal(seen[0].headers?.Authorization, 'Bearer account-token');
  assert.equal(asSent(seen[0].headers).authorization, 'Bearer account-token');
  // The token of the host must not reach another one.
  assert.equal(seen[1].headers?.Authorization, undefined);
  assert.equal(asSent(seen[1].headers).authorization, undefined);
});

test('removes every authorization header the caller writes, in any case', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  await session.postJson('https://115.com/api/1', {}, { Authorization: 'a=1', authorization: 'b=2', AUTHORIZATION: 'c=3', Referer: 'https://115.com/' });
  const sent = asSent(seen[0].headers);
  assert.equal(sent.authorization, undefined);
  assert.equal(seen[0].headers?.Authorization, undefined);
  assert.equal(seen[0].headers?.authorization, undefined);
  assert.equal(seen[0].headers?.AUTHORIZATION, undefined);
  // The other headers of the caller survive.
  assert.equal(sent.referer, 'https://115.com/');
});

test('hands out the authorization of the host only', () => {
  const session = new NetdiskSession({ http: fakeHttp([]), signal: new AbortController().signal });
  session.setAuthorization('https://api.139.com.cn/', 'Bearer account-token');
  assert.equal(session.authorizationHeader('https://api.139.com.cn/'), 'Bearer account-token');
  assert.equal(session.authorizationHeader('https://other.test/'), '');
  session.setAuthorization('not a url', 'Bearer token');
  assert.equal(session.authorizationHeader('not a url'), '');
});

test('maps a network failure to a network error', async () => {
  const session = new NetdiskSession({ http: fakeHttp([], new Error('socket hang up')), signal: new AbortController().signal });
  await assert.rejects(
    () => session.get('https://pan.quark.cn/api/1'),
    (error: unknown) => error instanceof ToolError && error.code === 'NETWORK_ERROR',
  );
});

test('keeps the error code the platform reported', async () => {
  const session = new NetdiskSession({ http: fakeHttp([], new ToolError('ACCESS_DENIED', '需要登录。')), signal: new AbortController().signal });
  await assert.rejects(
    () => session.get('https://pan.quark.cn/api/1'),
    (error: unknown) => error instanceof ToolError && error.code === 'ACCESS_DENIED',
  );
});

test('stops waiting for the pace when the session is cancelled', async () => {
  const controller = new AbortController();
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: controller.signal, minIntervalMs: 5_000 });
  await session.get('https://pan.quark.cn/api/1');
  const second = session.get('https://pan.quark.cn/api/2');
  const started = performance.now();
  controller.abort();
  await assert.rejects(
    () => second,
    (error: unknown) => error instanceof ToolError && error.code === 'CANCELLED',
  );
  // The wait ends with the cancellation, not after the whole interval.
  assert.ok(performance.now() - started < 1_000, 'the wait must end with the cancellation');
  assert.equal(seen.length, 1);
});

test('paces the requests of one host and leaves the other hosts alone', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal, minIntervalMs: 120 });
  await session.get('https://pan.quark.cn/api/1');
  await session.get('https://115.com/api/1');
  await session.get('https://pan.quark.cn/api/2');
  // A request to another host does not wait for the interval of the previous one.
  assert.ok(seen[1].at - seen[0].at < 120, 'another host must not be throttled');
  // The same host is spaced out by the interval.
  assert.ok(seen[2].at - seen[0].at >= 120 - PACE_TOLERANCE_MS, 'the same host must be spaced out');
});

test('keeps concurrent requests to one host spaced out', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal, minIntervalMs: 100 });
  await Promise.all([
    session.get('https://pan.quark.cn/api/1'),
    session.get('https://pan.quark.cn/api/2'),
    session.get('https://pan.quark.cn/api/3'),
  ]);
  assert.ok(seen[1].at - seen[0].at >= 100 - PACE_TOLERANCE_MS, 'the second call must wait');
  assert.ok(seen[2].at - seen[1].at >= 100 - PACE_TOLERANCE_MS, 'the third call must wait as well');
});

test('refuses to send after the session signal is aborted', async () => {
  const controller = new AbortController();
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => session.get('https://pan.quark.cn/api/1'),
    (error: unknown) => error instanceof ToolError && error.code === 'CANCELLED',
  );
  assert.equal(seen.length, 0);
});
