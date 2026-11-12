import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';

interface SeenCall {
  url: string;
  headers?: Record<string, string>;
  at: number;
}

function fakeHttp(seen: SeenCall[]): PublicHttp {
  const record = (url: string, headers?: Record<string, string>) => {
    seen.push({ url, headers, at: Date.now() });
  };
  return {
    getHtml: async () => ({ finalUrl: '', html: '', status: 200 }),
    getJson: async (url, _signal, options) => { record(url, options?.headers); return { finalUrl: url, data: {}, status: 200 }; },
    getBinary: async () => ({ finalUrl: '', bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async () => ({ finalUrl: '', status: 200, contentType: '', bytes: new Uint8Array(), setCookie: [], headers: {} }),
    postForm: async (url, fields, _signal, options) => { record(url, options?.headers); return { finalUrl: url, data: { fields }, status: 200 }; },
    postJson: async (url, body, _signal, options) => { record(url, options?.headers); return { finalUrl: url, data: { body }, status: 200 }; },
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

test('sends one cookie header even when the caller writes it in another case', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  await session.postJson('https://pan.quark.cn/api/1', {}, { cookie: 'caller=1' });
  assert.equal(seen[0].headers?.Cookie, 'caller=1');
  assert.equal(seen[0].headers?.cookie, undefined);
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
  assert.ok(seen[2].at - seen[0].at >= 100, 'the same host must be spaced out');
});

test('keeps concurrent requests to one host spaced out', async () => {
  const seen: SeenCall[] = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal, minIntervalMs: 100 });
  await Promise.all([
    session.get('https://pan.quark.cn/api/1'),
    session.get('https://pan.quark.cn/api/2'),
    session.get('https://pan.quark.cn/api/3'),
  ]);
  assert.ok(seen[1].at - seen[0].at >= 85, 'the second call must wait');
  assert.ok(seen[2].at - seen[1].at >= 85, 'the third call must wait as well');
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
