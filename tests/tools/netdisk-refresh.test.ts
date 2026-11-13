import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../../src/core/errors.js';
import { contextForRefresh, fileForRefresh } from '../../src/tools/netdisk/refresh.js';
import type { NetdiskSession } from '../../src/tools/netdisk/session.js';

const session = {} as NetdiskSession;

test('reads the share id back from the share link of the task', () => {
  const context = contextForRefresh(
    { platform: 'quark', shareUrl: 'https://pan.quark.cn/s/abc123', code: null, filePath: 'a.bin', fileId: 'f1' },
    { session, credential: null, signal: new AbortController().signal },
  );
  // The adapter asks for the id, not for the link, so the id has to be the
  // share code and not the whole address.
  assert.equal(context.shareId, 'abc123');
  assert.equal(context.shareUrl, 'https://pan.quark.cn/s/abc123');
});

test('keeps the code of the task when the link carries none', () => {
  const context = contextForRefresh(
    { platform: 'pan115', shareUrl: 'https://115.com/s/sw8lxs36jf', code: 'abcd', filePath: 'a.bin', fileId: 'f1' },
    { session, credential: null, signal: new AbortController().signal },
  );
  assert.equal(context.code, 'abcd');
  assert.equal(context.shareId, 'sw8lxs36jf');
});

test('refuses a source whose link cannot be read again', () => {
  assert.throws(
    () => contextForRefresh(
      { platform: 'quark', shareUrl: 'https://example.com/not-a-share', code: null, filePath: 'a.bin', fileId: 'f1' },
      { session, credential: null, signal: new AbortController().signal },
    ),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('refuses a source whose link belongs to another platform', () => {
  assert.throws(
    () => contextForRefresh(
      { platform: 'baidu', shareUrl: 'https://pan.quark.cn/s/abc123', code: null, filePath: 'a.bin', fileId: 'f1' },
      { session, credential: null, signal: new AbortController().signal },
    ),
    (error: unknown) => error instanceof ToolError && error.code === 'TOOL_FAILED',
  );
});

test('builds the file of the task as an adapter wants it', () => {
  const file = fileForRefresh(
    { platform: 'quark', shareUrl: 'https://pan.quark.cn/s/abc123', code: null, filePath: 'dir/a.bin', fileId: 'f1' },
    'a.bin',
    1024,
  );
  assert.equal(file.id, 'f1');
  assert.equal(file.path, 'dir/a.bin');
  assert.equal(file.name, 'a.bin');
  assert.equal(file.sizeBytes, 1024);
  assert.equal(file.isDirectory, false);
});
