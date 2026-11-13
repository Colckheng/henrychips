import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { baiduAdapter } from '../../src/tools/netdisk/adapters/baidu.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

interface Seen {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function fakeHttp(seen: Seen[]): PublicHttp {
  const record = (method: string, url: string, headers?: Record<string, string>, body?: unknown) => {
    seen.push({ method, url, headers, body });
  };
  return {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      record('GET', url, options?.headers);
      if (url.includes('/gettemplatevariable')) {
        return { finalUrl: url, status: 200, data: { errno: 0, result: { bdstoken: 'BDSTOKEN' } } };
      }
      if (url.includes('/rest/2.0/xpan/share')) {
        return {
          finalUrl: url,
          status: 200,
          data: {
            errno: 0,
            share_id: '1234567890',
            uk: '987654321',
            list: [{ fs_id: 'f1', server_filename: 'a.bin', size: 1024, isdir: '0' }],
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url, _signal, options) => {
      record('GET', url, options?.headers);
      // The probe of a direct link only reads the head of it.
      return {
        finalUrl: url,
        status: 206,
        contentType: 'application/octet-stream',
        bytes: new Uint8Array(),
        setCookie: [],
        headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-0/1024' },
      };
    },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async (url, _fields, _signal, options) => {
      record('POST', url, options?.headers);
      if (url.includes('/share/transfer')) {
        return { finalUrl: url, status: 200, data: { errno: 0, extra: { list: [{ to_fs_id: 'new1', to: '/YunX临时转存/a.bin' }] } } };
      }
      if (url.includes('/filemanager')) {
        return { finalUrl: url, status: 200, data: { errno: 0 } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    postJson: async (url, _body, _signal, options) => {
      record('POST', url, options?.headers, _body);
      if (url.includes('/share/verify')) {
        return { finalUrl: url, status: 200, data: { errno: 0, randsk: 'RAND_SK' } };
      }
      if (url.includes('/rest/2.0/pcs/file')) {
        return {
          finalUrl: url,
          status: 200,
          data: {
            urls: [
              { url: 'https://d2-ant.baidu.com/encrypted', encrypt: 1, rank: 1 },
              { url: 'https://appall00.baidupcs.com/plain', encrypt: 0, rank: 2 },
            ],
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
}

function contextOf(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: '1AbCdEfGh',
    shareUrl: 'https://pan.baidu.com/s/1AbCdEfGh',
    code: 'a1b2',
    credential: { bduss: 'BDUSS_VALUE' },
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('the session of the user reaches the platform', async () => {
  const seen: Seen[] = [];
  const share = await baiduAdapter.list(contextOf(fakeHttp(seen)));
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].path, 'a.bin');

  // The platform refuses the listing of a share without the session of the
  // user, so the session has to be in the request.
  const listing = seen.find(call => call.url.includes('/xpan/share'));
  assert.ok(listing, 'the listing of the share must be asked');
  assert.match(listing?.headers?.Cookie ?? '', /BDUSS=BDUSS_VALUE/);
  // The sign of the verification is only accepted as a cookie.
  assert.match(listing?.headers?.Cookie ?? '', /BDCLND=RAND_SK/);
});

test('the transfer uses the id of the share and its owner', async () => {
  const seen: Seen[] = [];
  const file = { id: 'f1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false };
  const link = await baiduAdapter.link(contextOf(fakeHttp(seen)), file);
  assert.equal(link.url, 'https://appall00.baidupcs.com/plain');

  const transfer = seen.find(call => call.url.includes('/share/transfer'));
  assert.ok(transfer, 'the file must be transferred before a link can be had');
  const query = new URL(transfer!.url).searchParams;
  // The share id of the listing is not the short url of the link.
  assert.equal(query.get('shareid'), '1234567890');
  assert.equal(query.get('from'), '987654321');
  // The token of the platform is needed for the personal drive.
  assert.equal(query.get('bdstoken'), 'BDSTOKEN');
});

test('the copy of the file is removed again', async () => {
  const seen: Seen[] = [];
  const file = { id: 'f1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false };
  await baiduAdapter.link(contextOf(fakeHttp(seen)), file);
  const removal = seen.find(call => call.url.includes('/filemanager'));
  assert.ok(removal, 'the copy has to be removed');
  assert.match(new URL(removal!.url).searchParams.get('opera') ?? '', /delete/);
});

test('the plain channel of the platform is the one that is used', () => {
  // The first candidate is the encrypted channel, whose content has to be
  // decrypted before it is a file.
  const urls = [
    { url: 'https://d2-ant.baidu.com/x', encrypt: 1, rank: 1 },
    { url: 'https://appall00.baidupcs.com/x', encrypt: 0, rank: 2 },
  ];
  assert.equal(baiduAdapter.pickPlainUrl(urls), 'https://appall00.baidupcs.com/x');
  // Without a plain channel, a link that can be reached is used.
  assert.equal(baiduAdapter.pickPlainUrl([{ url: 'https://d2-ant.baidu.com/x', encrypt: 1 }]), 'https://d2-ant.baidu.com/x');
  assert.equal(baiduAdapter.pickPlainUrl([]), '');
});

test('the id of the share and its owner are read out of the answer', () => {
  const info = baiduAdapter.parseShareInfo({ share_id: '1234567890', uk: '987654321' });
  assert.equal(info.shareId, '1234567890');
  assert.equal(info.uk, '987654321');
  // An answer without them states that the transfer cannot happen.
  assert.deepEqual(baiduAdapter.parseShareInfo({}), { shareId: '', uk: '' });
});

test('a share without a session of the user is refused', async () => {
  const context = contextOf(fakeHttp([]));
  context.credential = null;
  await assert.rejects(
    () => baiduAdapter.list(context),
    (error: unknown) => error instanceof ToolError && error.code === 'ACCESS_DENIED',
  );
});
