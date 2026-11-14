import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { pan123Adapter } from '../../src/tools/netdisk/adapters/pan123.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

interface Seen {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * The server of the platform, with the answers of its real protocol.
 * The listing of the platform names its list "InfoList" and its members
 * "FileId", so an answer with the names of the personal drive would not be
 * read by the platform.
 */
function fakeHttp(seen: Seen[]): PublicHttp {
  const record = (method: string, url: string, headers?: Record<string, string>, body?: unknown) => {
    seen.push({ method, url, headers, body });
  };
  return {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      record('GET', url, options?.headers);
      if (url.includes('/b/api/share/get')) {
        return {
          finalUrl: url,
          status: 200,
          data: {
            code: 0,
            data: {
              shareName: '测试分享',
              InfoList: [
                { FileId: 'f1', FileName: 'a.bin', Size: 1024, Type: 0, 'S3KeyFlag': 'KEY1', Etag: 'TAG1', StorageNode: 'NODE1' },
                { FileId: 'd1', FileName: 'folder', Type: 1 },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, body, _signal, options) => {
      record('POST', url, options?.headers, body);
      if (url.includes('/user/sign_in')) {
        return { finalUrl: url, status: 200, data: { token: 'JWT_VALUE' } };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
}

function contextOf(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: 'AbCdEfGh',
    shareUrl: 'https://123pan.com/s/AbCdEfGh',
    code: null,
    credential: { username: 'user', password: 'secret' },
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('reads the entries of a share out of the names the platform uses', () => {
  const files = pan123Adapter.parseEntries({
    InfoList: [
      { FileId: 'f1', FileName: 'a.bin', Size: 1024, Type: 0, 'S3KeyFlag': 'KEY1', Etag: 'TAG1', StorageNode: 'NODE1' },
      { FileId: 'd1', FileName: 'folder', Type: 1 },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].id, 'f1');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  // A folder is shown with a trailing slash so the path reads like a path.
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].sizeBytes, null);
  // The key of the object and the tag of it travel together in one field.
  assert.equal(files[0].fidToken, 'KEY1|TAG1|NODE1');
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(pan123Adapter.parseEntries({}), []);
  assert.deepEqual(pan123Adapter.parseEntries(undefined), []);
});

test('splits the key and the tag of the object out of the token', () => {
  const decoded = pan123Adapter.decodeFileToken('KEY1|TAG1|NODE1');
  assert.equal(decoded.s3KeyFlag, 'KEY1');
  assert.equal(decoded.etag, 'TAG1');
  // A token without a tag cannot be used for a download.
  assert.equal(pan123Adapter.decodeFileToken('KEY1').etag, '');
});

test('the token of the user reaches the platform', async () => {
  const seen: Seen[] = [];
  const http = fakeHttp(seen);
  const share = await pan123Adapter.list(contextOf(http));
  assert.equal(share.title, '测试分享');
  assert.equal(share.files.length, 2);

  // The listing of the platform is a GET, so the token of the user has to be
  // in the header of it.
  const listing = seen.find(call => call.url.includes('/b/api/share/get'));
  assert.ok(listing, 'the listing of the share must be asked');
  assert.equal(listing?.headers?.Authorization, 'Bearer JWT_VALUE');
  // The password is only used to get the token, so it does not travel with
  // any other request.
  assert.equal(listing?.body, undefined);
  const listingBody = JSON.stringify(listing?.body ?? '');
  assert.equal(listingBody.includes('secret'), false);
});

test('reads a numeric id of a member as text', () => {
  // The platform states the id as a number, so a member whose id is read
  // as text only would be dropped from the listing.
  const files = pan123Adapter.parseEntries({
    InfoList: [{ FileId: 1947332, FileName: 'QQ', Type: 1, Size: 912652611 }],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].id, '1947332');
  assert.equal(files[0].path, 'QQ/');
  assert.equal(files[0].isDirectory, true);
});

test('a business code stated as text is a failure, not an empty share', async () => {
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => ({ finalUrl: '', status: 200, data: { code: '5103', message: '此分享不存在' } }),
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async () => { throw new Error('unexpected request'); },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const context = contextOf(http);
  context.credential = null;
  await assert.rejects(() => pan123Adapter.list(context), /5103/);
});

/**
 * The server of the platform, with a share that holds a folder and more
 * than one page. A folder is listed with the id of its parent, and the
 * next page with the cursor the platform handed out.
 */
function fakeHttpWithFolders(seen: Seen[]): PublicHttp {
  const record = (method: string, url: string, headers?: Record<string, string>, body?: unknown) => {
    seen.push({ method, url, headers, body });
  };
  const listing = (shareName: string, next: string, infoList: unknown[]) => ({
    finalUrl: '', status: 200, data: { code: 0, data: { shareName, Next: next, InfoList: infoList } },
  });
  return {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async (url, _signal, options) => {
      record('GET', url, options?.headers);
      if (url.includes('/b/api/share/get')) {
        const params = new URL(url).searchParams;
        const parent = params.get('parentFileId');
        const next = params.get('next');
        if (parent === '0' && next === '0') {
          return listing('QQ 分享', 'cursor-1', [
            { FileId: 1947332, FileName: 'QQ', Type: 1, Size: 912652611 },
          ]);
        }
        if (parent === '0' && next === 'cursor-1') {
          return listing('QQ 分享', '-1', [
            { FileId: 'f0', FileName: 'root.txt', Size: 10, Type: 0, 'S3KeyFlag': 'K0', Etag: 'T0', StorageNode: 'N0' },
          ]);
        }
        if (parent === '1947332' && next === '0') {
          return listing('QQ 分享', '-1', [
            { FileId: 1001, FileName: 'a.apk', Size: 100, Type: 0, 'S3KeyFlag': 'K1', Etag: 'T1', StorageNode: 'N1' },
            { FileId: 1002, FileName: 'b.apk', Size: 200, Type: 0, 'S3KeyFlag': 'K2', Etag: 'T2', StorageNode: 'N2' },
          ]);
        }
        throw new Error(`unexpected listing: ${url}`);
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
}

test('a share is listed without a login, folders and further pages included', async () => {
  const seen: Seen[] = [];
  const context = contextOf(fakeHttpWithFolders(seen));
  context.credential = null;
  context.code = 'hhhh';
  const share = await pan123Adapter.list(context);
  assert.equal(share.title, 'QQ 分享');
  // The folder itself stays in the list, and the files inside it carry
  // the folder in their path. A folder is read right after it is listed,
  // so its children come before the siblings of the folder.
  assert.deepEqual(share.files.map(file => file.path), ['QQ/', 'QQ/a.apk', 'QQ/b.apk', 'root.txt']);

  // No sign-in was asked for, so the listing went out on its own.
  assert.equal(seen.some(call => call.url.includes('/user/sign_in')), false);
  const calls = seen.filter(call => call.url.includes('/b/api/share/get'));
  assert.equal(calls.length, 3);
  // The root is the folder with the id zero, and the signature still
  // travels with a listing that has no login.
  assert.equal(new URL(calls[0]!.url).searchParams.get('parentFileId'), '0');
  assert.equal(new URL(calls[0]!.url).searchParams.get('SharePwd'), 'hhhh');
  assert.ok(calls[0]!.headers?.['auth-key']);
  assert.ok(calls[0]!.headers?.['auth-value']);
  // The second page of the root is asked for with the cursor of the first.
  assert.equal(new URL(calls[1]!.url).searchParams.get('parentFileId'), '0');
  assert.equal(new URL(calls[1]!.url).searchParams.get('next'), 'cursor-1');
  // The folder is entered with the id the platform gave it.
  assert.equal(new URL(calls[2]!.url).searchParams.get('parentFileId'), '1947332');
});

test('the passcode is only sent when there is one', async () => {
  const seen: Seen[] = [];
  await pan123Adapter.list(contextOf(fakeHttp(seen)));
  const withoutCode = seen.find(call => call.url.includes('/b/api/share/get'));
  assert.equal(new URL(withoutCode!.url).searchParams.get('SharePwd'), null);

  const other: Seen[] = [];
  const context = contextOf(fakeHttp(other));
  context.code = 'a1b2';
  await pan123Adapter.list(context);
  const withCode = other.find(call => call.url.includes('/b/api/share/get'));
  assert.equal(new URL(withCode!.url).searchParams.get('SharePwd'), 'a1b2');
});
