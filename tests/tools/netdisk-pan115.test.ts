import test from 'node:test';
import assert from 'node:assert/strict';
import { pan115Adapter } from '../../src/tools/netdisk/adapters/pan115.js';

test('picks the address out of the three shapes the platform uses', () => {
  assert.equal(pan115Adapter.pickDownloadUrl({ file_url_302: 'https://a' }), 'https://a');
  assert.equal(pan115Adapter.pickDownloadUrl({ file_url: 'https://b' }), 'https://b');
  assert.equal(pan115Adapter.pickDownloadUrl({ url: { url: 'https://c' } }), 'https://c');
  assert.equal(pan115Adapter.pickDownloadUrl({}), '');
  assert.equal(pan115Adapter.pickDownloadUrl(undefined), '');
});

test('reads the entries of a share with the field names of the platform', () => {
  const files = pan115Adapter.parseEntries({
    list: [
      { fid: 'f1', n: 'a.bin', s: 1024, fc: 1 },
      { fid: 'd1', n: 'folder', fc: 0, cid: 'c9' },
    ],
  });
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'a.bin');
  assert.equal(files[0].sizeBytes, 1024);
  assert.equal(files[0].isDirectory, false);
  // A folder is marked by a zero and is addressed by its cid.
  assert.equal(files[1].path, 'folder/');
  assert.equal(files[1].isDirectory, true);
  assert.equal(files[1].id, 'c9');
  assert.equal(files[1].sizeBytes, null);
});

test('an answer without entries is empty instead of broken', () => {
  assert.deepEqual(pan115Adapter.parseEntries({}), []);
  assert.deepEqual(pan115Adapter.parseEntries(undefined), []);
});

test('reads the id of the user who made the share', () => {
  assert.equal(pan115Adapter.parseSharerId({ userinfo: { user_id: 'u1' } }), 'u1');
  assert.equal(pan115Adapter.parseSharerId({ userinfo: { user_id: 42 } }), '42');
  assert.equal(pan115Adapter.parseSharerId({}), '');
});

test('builds the referer the platform checks a share against', () => {
  assert.equal(pan115Adapter.shareReferer('sw1', null), 'https://115cdn.com/s/sw1');
  assert.equal(pan115Adapter.shareReferer('sw1', 'abcd'), 'https://115cdn.com/s/sw1?password=abcd&');
});

test('the client user agent carries the version the platform asks for', () => {
  assert.equal(pan115Adapter.clientUserAgent('36.0.1'), 'Mozilla/5.0 115Browser/36.0.1');
});
