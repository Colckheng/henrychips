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
      if (url.includes('/share/verify')) {
        return { finalUrl: url, status: 200, data: { errno: 0, randsk: 'RAND_SK' } };
      }
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

test('the listing of a share works without a session of the user', async () => {
  const seen: Seen[] = [];
  const context = contextOf(fakeHttp(seen));
  context.credential = null;
  const share = await baiduAdapter.list(context);
  assert.equal(share.files.length, 1);
  assert.equal(share.files[0].path, 'a.bin');

  // The listing works without a session, so no session is sent with it.
  // The sign of the verification still is, as a cookie.
  const listing = seen.find(call => call.url.includes('/xpan/share'));
  assert.ok(listing, 'the listing of the share must be asked');
  assert.doesNotMatch(listing?.headers?.Cookie ?? '', /BDUSS=/);
  assert.match(listing?.headers?.Cookie ?? '', /BDCLND=RAND_SK/);
});

test('a URL-encoded randsk is used exactly as returned', async () => {
  const seen: Seen[] = [];
  const http: PublicHttp = {
    ...fakeHttp(seen),
    postForm: async (url, _fields, _signal, options) => {
      seen.push({ method: 'POST', url, headers: options?.headers, body: _fields });
      if (url.includes('/share/verify')) {
        return { finalUrl: url, status: 200, data: { errno: 0, randsk: 'A%2BB%3D' } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
  const context = contextOf(http);
  context.credential = null;
  const share = await baiduAdapter.list(context);
  assert.equal(share.files.length, 1);
  // The token is URL-encoded as returned, and the platform wants that
  // form in the cookie: decoding it first makes every listing fail
  // with errno -9, even though the query string re-encodes it either way.
  const listing = seen.find(call => call.url.includes('/xpan/share'));
  assert.ok(listing, 'the listing of the share must be asked');
  assert.match(listing?.headers?.Cookie ?? '', /BDCLND=A%2BB%3D/);
});

test('a direct link without a session of the user is refused', async () => {
  const context = contextOf(fakeHttp([]));
  context.credential = null;
  const file = { id: 'f1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false };
  await assert.rejects(
    () => baiduAdapter.link(context, file),
    (error: unknown) => error instanceof ToolError && error.code === 'ACCESS_DENIED',
  );
});

/**
 * A share shaped like the real one: the root holds one folder and fills its
 * first page, and the folder holds the files themselves.
 */
function fakeHttpForWalk(seen: Seen[]): PublicHttp {
  const folderPath = '/MUGEN相关资源整理/整合包/Mugen Academy x Stardust V11 (IKEMEN)';
  const rootPage1 = [
    { fs_id: 'd1', server_filename: 'Mugen Academy x Stardust V11 (IKEMEN)', size: '0', isdir: '1', path: folderPath },
    ...Array.from({ length: 99 }, (_, index) => ({
      fs_id: `r${index}`, server_filename: `root-${index}.bin`, size: '1024', isdir: '0',
    })),
  ];
  // The real platform answers the root with strings and a folder below it
  // with real numbers, so the mock keeps both shapes on purpose.
  const subdir = [
    { fs_id: 806146728781580, server_filename: 'Mugen Academy x Stardust V11 (IKEMEN).part01.rar', size: 2147483648, isdir: 0 },
    { fs_id: 822615433120047, server_filename: 'Mugen Academy x Stardust V11 (IKEMEN).part02.rar', size: 2147483648, isdir: 0 },
    { fs_id: 935095065858368, server_filename: 'Mugen Academy x Stardust V11 (IKEMEN).part03.rar', size: 2147483648, isdir: 0 },
    { fs_id: 669949203339188, server_filename: 'Mugen Academy x Stardust V11 (IKEMEN).part04.rar', size: 1296902121, isdir: 0 },
    { fs_id: 1092174259988105, server_filename: '先转存后下载更稳定.txt', size: 105, isdir: 0 },
  ];
  return {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      seen.push({ method: 'GET', url, headers: options?.headers });
      if (!url.includes('/rest/2.0/xpan/share')) throw new Error(`unexpected request: ${url}`);
      const query = new URL(url).searchParams;
      const dir = query.get('dir') ?? '';
      const page = query.get('page') ?? '1';
      let list: unknown[] = [];
      if (dir === '/') list = page === '1' ? rootPage1 : [{ fs_id: 'r99', server_filename: 'root-99.bin', size: '1024', isdir: '0' }];
      if (dir === folderPath) list = page === '1' ? subdir : [];
      return { finalUrl: url, status: 200, data: { errno: 0, list } };
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async (url, _fields, _signal, options) => {
      seen.push({ method: 'POST', url, headers: options?.headers, body: _fields });
      if (url.includes('/share/verify')) {
        return { finalUrl: url, status: 200, data: { errno: 0, randsk: 'RAND_SK' } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    postJson: async () => { throw new Error('unexpected request'); },
    getStream: async () => { throw new Error('unexpected request'); },
  };
}

test('the walk reads subfolders and turns the pages of a folder', async () => {
  const seen: Seen[] = [];
  const context = contextOf(fakeHttpForWalk(seen));
  context.credential = null;
  const share = await baiduAdapter.list(context);

  // The root holds one folder and 100 files, and the folder holds 5 files.
  assert.equal(share.files.length, 106);
  const folder = share.files.find(file => file.isDirectory);
  assert.ok(folder);
  assert.equal(folder.path, 'Mugen Academy x Stardust V11 (IKEMEN)/');
  // The files of the folder carry the folder in their path.
  const parts = share.files.filter(file => file.name.endsWith('.part01.rar'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].path, 'Mugen Academy x Stardust V11 (IKEMEN)/Mugen Academy x Stardust V11 (IKEMEN).part01.rar');
  assert.equal(parts[0].sizeBytes, 2147483648);
  const note = share.files.find(file => file.name === '先转存后下载更稳定.txt');
  assert.ok(note);
  assert.equal(note?.path, 'Mugen Academy x Stardust V11 (IKEMEN)/先转存后下载更稳定.txt');

  // The first page of the root was full, so a second one was asked for, and
  // the folder was entered on its own.
  const listings = seen.filter(call => call.url.includes('/xpan/share'));
  const dirs = listings.map(call => new URL(call.url).searchParams.get('dir'));
  const pages = listings.map(call => new URL(call.url).searchParams.get('page'));
  assert.ok(dirs.includes('/MUGEN相关资源整理/整合包/Mugen Academy x Stardust V11 (IKEMEN)'));
  assert.ok(pages.includes('2'));
  // Every listing carries the sign of the verification.
  assert.ok(listings.every(call => (call.url).includes('sekey=RAND_SK')));
});
