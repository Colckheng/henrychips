import test from 'node:test';
import assert from 'node:assert/strict';
import { guangyaAdapter } from '../../src/tools/netdisk/adapters/guangya.js';

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
