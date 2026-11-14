import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';
import { NetdiskSession } from '../../src/tools/netdisk/session.js';
import { guangyaAdapter } from '../../src/tools/netdisk/adapters/guangya.js';
import type { AdapterContext } from '../../src/tools/netdisk/types.js';

const SHARE_URL = 'https://www.guangyapan.com/s/1928739842782765091_alzQ-sdmlFrewcK7';

/** The posts the adapter sends, in the order they are sent. */
interface Posted {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A fake transport that answers the three calls of a listing: the summary,
 * the token and the pages of a folder. The answer of a page is picked by
 * the parent it is asked for and the cursor it carries.
 */
function fakeHttp(pages: Record<string, unknown[]>): { http: PublicHttp; posts: Posted[] } {
  const posts: Posted[] = [];
  const http: PublicHttp = {
    getHtml: async () => { throw new Error('unexpected request'); },
    getJson: async () => { throw new Error('unexpected request'); },
    getBinary: async () => { throw new Error('unexpected request'); },
    getRaw: async () => { throw new Error('unexpected request'); },
    getHead: async () => { throw new Error('unexpected request'); },
    postForm: async () => { throw new Error('unexpected request'); },
    postJson: async (url, body) => {
      posts.push({ url, body: (body ?? {}) as Record<string, unknown> });
      const path = new URL(url).pathname;
      if (path === '/userres/v1/get_share_summary') {
        return { finalUrl: url, data: { msg: 'success', data: { title: '雨霖铃4K' } }, status: 200 };
      }
      if (path === '/userres/v1/get_share_access_token') {
        return { finalUrl: url, data: { msg: 'success', data: { accessToken: 'tok' } }, status: 200 };
      }
      if (path === '/userres/v1/get_share_page_files_list') {
        const request = (body ?? {}) as Record<string, unknown>;
        const key = `${String(request.parentId ?? '')}|${String(request.cursor ?? '')}`;
        const queue = pages[key];
        if (!queue || !queue.length) throw new Error(`unexpected request: ${url} ${JSON.stringify(body)}`);
        // The answer of the platform wraps the page in `data`, like every
        // other answer of the platform.
        return { finalUrl: url, data: { msg: 'success', data: queue.shift() }, status: 200 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    getStream: async () => { throw new Error('unexpected request'); },
  };
  return { http, posts };
}

function contextOf(http: PublicHttp): AdapterContext {
  return {
    session: new NetdiskSession({ http, signal: new AbortController().signal, minIntervalMs: 0 }),
    shareId: '1928739842782765091_alzQ-sdmlFrewcK7',
    shareUrl: SHARE_URL,
    code: null,
    credential: null,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
}

test('decides whether another page exists with the three level fallback', () => {
  // The platform states it directly.
  assert.equal(guangyaAdapter.hasMore({ hasMore: false, cursor: '100', total: 300 }, 100, 100), false);
  assert.equal(guangyaAdapter.hasMore({ hasMore: true, cursor: '', total: 0 }, 100, 100), true);
  // Without that flag the total decides, by the offset of the next cursor.
  assert.equal(guangyaAdapter.hasMore({ cursor: '100', total: 300 }, 100, 100), true);
  assert.equal(guangyaAdapter.hasMore({ cursor: '300', total: 300 }, 100, 100), false);
  // Without a total only a full page with a cursor counts.
  assert.equal(guangyaAdapter.hasMore({ cursor: '100' }, 100, 100), true);
  assert.equal(guangyaAdapter.hasMore({}, 100, 100), false);
});

test('reads a cursor the platform states as a number', () => {
  // The cursor of the platform is a number, so a numeric cursor has to
  // decide the same way a cursor of text does.
  assert.equal(guangyaAdapter.hasMore({ cursor: 100, total: 300 }, 100, 100), true);
  assert.equal(guangyaAdapter.hasMore({ cursor: 300, total: 300 }, 100, 100), false);
  assert.equal(guangyaAdapter.hasMore({ cursor: 100 }, 100, 100), true);
  // A cursor of zero is the start of the list, not a next page.
  assert.equal(guangyaAdapter.hasMore({ cursor: 0 }, 100, 100), false);
  assert.equal(guangyaAdapter.hasMore({ cursor: '' }, 100, 100), false);
});

test('reads the entries of a file list answer', () => {
  const files = guangyaAdapter.parseEntries({
    text: [
      { id: 'f1', name: 'a.bin', size: 1024, is_folder: 0 },
      { id: 'd1', name: 'folder', is_folder: 1 },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  // A folder is shown with a trailing slash so the path reads like a path.
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].sizeBytes, null);
});

test('reads the entries when the platform uses the other folder key', () => {
  const files = guangyaAdapter.parseEntries({ list: [{ id: 'd1', name: 'folder', isdir: 1 }] });
  assert.equal(files.length, 1);
  assert.equal(files[0].isDirectory, true);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(guangyaAdapter.parseEntries({}), []);
  assert.deepEqual(guangyaAdapter.parseEntries(undefined), []);
});

test('reads the title of a share', () => {
  assert.equal(guangyaAdapter.parseTitle({ title: '标题' }), '标题');
  assert.equal(guangyaAdapter.parseTitle({}), '');
});

test('turns the business codes of the platform into a message', () => {
  assert.match(guangyaAdapter.describeError(207, ''), /转存/);
  assert.match(guangyaAdapter.describeError(429, ''), /频繁/);
  assert.match(guangyaAdapter.describeError(404, ''), /不存在/);
  assert.equal(guangyaAdapter.describeError(0, '原文'), '原文');
});

test('reads the business code of an answer, which the platform states as text', () => {
  // The platform states the code as text, so a code that is read as a number
  // would be read as zero and an error would look like a good answer.
  assert.equal(guangyaAdapter.businessCode({ code: '0' }), 0);
  assert.equal(guangyaAdapter.businessCode({ code: 0 }), 0);
  assert.equal(guangyaAdapter.businessCode({ code: '209' }), 209);
  assert.equal(guangyaAdapter.businessCode({ code: '207' }), 207);
  // An answer without a code is a good one.
  assert.equal(guangyaAdapter.businessCode({}), 0);
  // Unless it says otherwise.
  assert.equal(guangyaAdapter.businessCode({ success: false }), 1);
  assert.equal(guangyaAdapter.businessCode({ error: '出错了' }), 1);
});

test('reads the entries out of the names the platform uses', () => {
  // The platform names the array of the members differently depending on the
  // endpoint, so every name it uses has to be read.
  const shapes = [
    { list: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' }] },
    { items: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' }] },
    { files: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' }] },
    { records: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' }] },
    { content: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' }] },
  ];
  for (const shape of shapes) {
    const files = guangyaAdapter.parseEntries(shape);
    assert.equal(files.length, 1, `the shape ${Object.keys(shape)[0]} must be read`);
    assert.equal(files[0].id, 'f1');
    assert.equal(files[0].name, 'a.bin');
    assert.equal(files[0].sizeBytes, 1024);
    assert.equal(files[0].isDirectory, false);
  }
});

test('tells a folder from a file by the kind the platform states', () => {
  // The platform states the kind of a member by its resource type.
  const files = guangyaAdapter.parseEntries({
    list: [
      { fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' },
      { fileId: 'd1', fileName: 'folder', resType: '2' },
      { fileId: 'd2', fileName: 'other', dirType: '1' },
    ],
  });
  assert.equal(files.length, 3);
  assert.equal(files[0].isDirectory, false);
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[2].isDirectory, true);
});

test('lists a folder with the request shape the platform expects', async () => {
  const { http, posts } = fakeHttp({
    '|': [
      {
        list: [
          { fileId: 'f1', fileName: 'a.bin', fileSize: 1024, resType: '1' },
          { fileId: 'd1', fileName: 'folder', resType: '2' },
        ],
        cursor: 100,
        total: 2,
      },
    ],
    'd1|': [
      {
        list: [{ fileId: 'f2', fileName: 'b.txt', fileSize: 200, resType: '1' }],
        cursor: 100,
        total: 1,
      },
    ],
  });
  const share = await guangyaAdapter.list(contextOf(http));
  assert.equal(share.title, '雨霖铃4K');
  assert.deepEqual(share.files.map(file => file.path), ['a.bin', 'folder/', 'folder/b.txt']);
  assert.deepEqual(share.files.map(file => file.id), ['f1', 'd1', 'f2']);
  // The list is asked for in the shape of the web client and of YunX: a
  // page size with an order and a sort, and the token of the share. The old
  // shape sent an offset and a limit instead, and the platform refused it
  // with a parameter error.
  const listed = posts.filter(post => post.url.endsWith('/get_share_page_files_list'));
  assert.equal(listed.length, 2);
  for (const post of listed) {
    assert.equal('offset' in post.body, false);
    assert.equal('limit' in post.body, false);
    assert.equal('shareId' in post.body, false);
    assert.equal(post.body.pageSize, 100);
    assert.equal(post.body.orderBy, 0);
    assert.equal(post.body.sortType, 0);
    assert.equal(post.body.accessToken, 'tok');
  }
  // The root is asked for without a cursor, the folder with its own id.
  assert.equal(listed[0].body.parentId, '');
  assert.equal('cursor' in listed[0].body, false);
  assert.equal(listed[1].body.parentId, 'd1');
  assert.equal('cursor' in listed[1].body, false);
});

test('follows a numeric cursor through the pages of a folder', async () => {
  const { http, posts } = fakeHttp({
    '|': [
      { list: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 100, resType: '1' }], cursor: 100, total: 300 },
    ],
    '|100': [
      { list: [{ fileId: 'f2', fileName: 'b.bin', fileSize: 200, resType: '1' }], cursor: 200, total: 300 },
    ],
    '|200': [
      { list: [{ fileId: 'f3', fileName: 'c.bin', fileSize: 300, resType: '1' }], cursor: 300, total: 300 },
    ],
  });
  const share = await guangyaAdapter.list(contextOf(http));
  assert.deepEqual(share.files.map(file => file.path), ['a.bin', 'b.bin', 'c.bin']);
  const listed = posts.filter(post => post.url.endsWith('/get_share_page_files_list'));
  assert.equal(listed.length, 3);
  // The cursor is sent back as the number the platform gave, never as text:
  // the platform refuses a cursor of text with a type error.
  assert.equal(listed[1].body.cursor, 100);
  assert.equal(typeof listed[1].body.cursor, 'number');
  assert.equal(listed[2].body.cursor, 200);
  assert.equal(typeof listed[2].body.cursor, 'number');
});

test('stops when the cursor of a folder does not move', async () => {
  const { http, posts } = fakeHttp({
    '|': [
      { list: [{ fileId: 'f1', fileName: 'a.bin', fileSize: 100, resType: '1' }], cursor: 100 },
    ],
    '|100': [
      { list: [{ fileId: 'f2', fileName: 'b.bin', fileSize: 200, resType: '1' }], cursor: 100 },
    ],
  });
  const share = await guangyaAdapter.list(contextOf(http));
  assert.deepEqual(share.files.map(file => file.path), ['a.bin', 'b.bin']);
  // A cursor that stays put must end the folder instead of asking for the
  // same page five hundred times.
  const listed = posts.filter(post => post.url.endsWith('/get_share_page_files_list'));
  assert.equal(listed.length, 2);
});

test('reads a share the platform cannot list as empty, like its own page', async () => {
  // The real share answers its list with nothing but a cursor, and the page
  // of the platform shows the same share as empty. The adapter must read
  // that answer as an empty share instead of looping on the cursor.
  const { http, posts } = fakeHttp({
    '|': [{ cursor: 100 }],
  });
  const share = await guangyaAdapter.list(contextOf(http));
  assert.equal(share.title, '雨霖铃4K');
  assert.deepEqual(share.files, []);
  const listed = posts.filter(post => post.url.endsWith('/get_share_page_files_list'));
  assert.equal(listed.length, 1);
});
