import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { c139Adapter } from '../../src/tools/netdisk/adapters/c139.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

test('the body of a share request survives the round trip', () => {
  const plain = JSON.stringify({ getOutLinkInfoReq: { linkID: 'x', passwd: '' } });
  const encrypted = c139Adapter.encryptBody(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(c139Adapter.decryptBody(encrypted), plain);
});

test('the encrypted body carries a fresh iv every time', () => {
  const plain = '{"a":1}';
  assert.notEqual(c139Adapter.encryptBody(plain), c139Adapter.encryptBody(plain));
});

test('a compressed answer is uncompressed as well', () => {
  const plain = '{"resultCode":"0","data":{"caLst":[]}}';
  const iv = randomBytes(16);
  const key = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8');
  // The answer of the platform is sometimes a compressed one, so the
  // decompression has to be part of the decryption.
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const compressed = gzipSync(Buffer.from(plain, 'utf8'));
  const encrypted = Buffer.concat([iv, cipher.update(compressed), cipher.final()]).toString('base64');
  assert.equal(c139Adapter.decryptBody(encrypted), plain);
});

test('reads the folders and the files of a share together', () => {
  const files = c139Adapter.parseEntries({
    caLst: [{ caID: 'd1', caName: 'folder' }],
    coLst: [{ coID: 'f1', coName: 'a.bin', coSize: 1024 }],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'folder/');
  assert.equal(files[0].isDirectory, true);
  assert.equal(files[1].path, 'a.bin');
  assert.equal(files[1].sizeBytes, 1024);
  assert.equal(files[1].isDirectory, false);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(c139Adapter.parseEntries({}), []);
  assert.deepEqual(c139Adapter.parseEntries(undefined), []);
});

test('tells a folder from a file inside the file list', () => {
  // A member of the file list can be a folder too, and the platform states
  // that by its type.
  const files = c139Adapter.parseEntries({
    coLst: [
      { coID: 'f1', coName: 'a.bin', coSize: 1024, coType: 1 },
      { coID: 'd1', coName: 'folder', coType: 2 },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].sizeBytes, null);
});

test('signs a request the way the gateway of the platform expects it', () => {
  const body = '{"getOutLinkInfoReq":{"linkID":"x"}}';
  const sign = c139Adapter.signHeader(body, '2026-11-13 10:20:30', 'abcdefghij123456');
  // The header is the moment, the salt and the signature, separated by bars.
  const parts = sign.split(',');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '2026-11-13 10:20:30');
  assert.equal(parts[1], 'abcdefghij123456');
  // The signature is an upper case digest of a fixed length.
  assert.match(parts[2], /^[0-9A-F]{32}$/);
  // The same body with the same moment and salt signs the same way.
  assert.equal(c139Adapter.signHeader(body, '2026-11-13 10:20:30', 'abcdefghij123456'), sign);
  // Another body signs another way.
  assert.notEqual(c139Adapter.signHeader('{"a":1}', '2026-11-13 10:20:30', 'abcdefghij123456'), sign);
});

test('the signature of a request carries a moment and a salt of its own', () => {
  const sign = c139Adapter.signHeader('{"a":1}');
  const parts = sign.split(',');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(parts[1].length, 16);
  assert.match(parts[2], /^[0-9A-F]{32}$/);
});

test('turns the business codes of the platform into a message', () => {
  assert.match(c139Adapter.describeError('200000401', 'IP鉴权失败、用户账号鉴权失败'), /登录账号/);
  assert.equal(c139Adapter.describeError('9188', '提取码错误'), '提取码错误');
  assert.equal(c139Adapter.describeError('9999', ''), '139 网盘返回了错误码 9999。');
});

test('reads a plain-text answer without decrypting it', () => {
  const answer = c139Adapter.parseAnswer(JSON.stringify({ resultCode: '0', data: {} }));
  assert.equal(answer.resultCode, '0');
});

/** The request body of a list call, decrypted with the real key. */
function requestedFolder(body: unknown): Record<string, unknown> {
  const plain = c139Adapter.decryptBody(typeof body === 'string' ? body : JSON.stringify(body));
  return (JSON.parse(plain) as Record<string, unknown>).getOutLinkInfoReq as Record<string, unknown>;
}

function encryptedAnswer(answer: unknown): string {
  return c139Adapter.encryptBody(JSON.stringify(answer));
}

function contextOf(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: '2xTrGM6yFun6u',
    shareUrl: 'https://yun.139.com/shareweb/#/w/i/2xTrGM6yFun6u',
    code: 'f6ro',
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

type FolderFixture = {
  ca: { caID: string; caName: string }[];
  co: { coID: string; coName: string; coSize: number; coType?: number }[];
};

function listHttp(folders: Record<string, FolderFixture>, seen: { headers: Record<string, string>[]; windows: [string, number, number][] }): PublicHttp {
  return {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, body, _signal, options) => {
      const req = requestedFolder(body);
      seen.headers.push((options?.headers ?? {}) as Record<string, string>);
      seen.windows.push([String(req.pCaID), Number(req.bNum), Number(req.eNum)]);
      const folder = folders[String(req.pCaID)] ?? { ca: [], co: [] };
      const all = [...folder.ca, ...folder.co];
      const slice = all.slice(Number(req.bNum) - 1, Number(req.eNum));
      const caLst = slice.filter((item): item is FolderFixture['ca'][number] => 'caID' in item);
      const coLst = slice.filter((item): item is FolderFixture['co'][number] => 'coID' in item);
      return {
        finalUrl: url,
        status: 200,
        data: encryptedAnswer({ resultCode: '0', desc: '', success: true, data: { lkName: '地址表', caLst, coLst } }),
        setCookie: [],
      };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
}

test('lists the folders of a share by walking into them and across windows', async () => {
  const seen: { headers: Record<string, string>[]; windows: [string, number, number][] } = { headers: [], windows: [] };
  const many = Array.from({ length: 201 }, (_, index) => ({ coID: `f${index}`, coName: `f${index}.xls`, coSize: 1024 }));
  const http = listHttp({
    root: { ca: [{ caID: 'dA', caName: '地址表' }], co: [{ coID: 'r1', coName: 'root.txt', coSize: 10 }] },
    dA: { ca: [{ caID: 'dB', caName: '金湾、斗门' }], co: many },
    dB: { ca: [], co: [{ coID: 'deep1', coName: 'deep.xls', coSize: 2048 }] },
  }, seen);
  const share = await c139Adapter.list(contextOf(http));
  assert.equal(share.title, '地址表');
  // The walk goes into a folder as soon as it meets it, so the members of
  // 地址表 come before the file that sits next to it at the root.
  assert.equal(share.files.length, 205);
  assert.equal(share.files[0].path, '地址表/');
  assert.equal(share.files[1].path, '地址表/金湾、斗门/');
  assert.equal(share.files[2].path, '地址表/金湾、斗门/deep.xls');
  assert.equal(share.files[3].path, '地址表/f0.xls');
  assert.equal(share.files[203].path, '地址表/f200.xls');
  assert.equal(share.files[204].path, 'root.txt');
  // The list endpoint is anonymous, so none of its requests carries a signature.
  assert.ok(seen.headers.every(headers => !('mcloud-sign' in headers)));
  // The folder with 202 members is read in two windows.
  assert.ok(seen.windows.some(([parent, begin, end]) => parent === 'dA' && begin === 1 && end === 200));
  assert.ok(seen.windows.some(([parent, begin, end]) => parent === 'dA' && begin === 201 && end === 400));
  assert.ok(seen.windows.some(([parent]) => parent === 'dB'));
});

test('a refused folder is reported instead of read as empty', async () => {
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url) => ({
      finalUrl: url,
      status: 200,
      data: encryptedAnswer({ resultCode: '9188', desc: '提取码错误', success: false }),
      setCookie: [],
    }),
    getStream: async () => { throw new Error('unexpected request'); },
  };
  await assert.rejects(() => c139Adapter.list(contextOf(http)), /提取码错误/);
});

test('the download endpoint names the login it needs', async () => {
  const seen: Record<string, string>[] = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, _body, _signal, options) => {
      seen.push((options?.headers ?? {}) as Record<string, string>);
      return {
        finalUrl: url,
        status: 200,
        data: encryptedAnswer({ resultCode: '200000401', desc: 'IP鉴权失败、用户账号鉴权失败', success: false }),
        setCookie: [],
      };
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const file = { id: 'f1', path: 'a.xls', name: 'a.xls', sizeBytes: 1024, isDirectory: false };
  await assert.rejects(() => c139Adapter.link(contextOf(http), file), /登录账号/);
  // The download endpoint is signed, unlike the list endpoint.
  assert.ok(seen.some(headers => 'mcloud-sign' in headers));
});

test('the download endpoint hands out a link once the platform answers', async () => {
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async (url) => ({
      finalUrl: url,
      status: 206,
      contentType: 'application/octet-stream',
      bytes: new Uint8Array([1]),
      setCookie: [],
      headers: { 'accept-ranges': 'bytes' },
    }),
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url) => ({
      finalUrl: url,
      status: 200,
      data: encryptedAnswer({
        resultCode: '0', desc: '', success: true,
        data: { redrUrl: 'https://obs.example.com/a.xls', coName: 'a.xls', coSize: 1024 },
      }),
      setCookie: [],
    }),
    getStream: async () => { throw new Error('unexpected request'); },
  };
  const file = { id: 'f1', path: 'a.xls', name: 'a.xls', sizeBytes: 1024, isDirectory: false };
  const link = await c139Adapter.link(contextOf(http), file);
  assert.equal(link.url, 'https://obs.example.com/a.xls');
  assert.equal(link.rangeSupported, true);
});
