import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAccess } from '../../src/core/file-access.js';

test('file reads reject directories before reading bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'workstation-regular-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'folder'));
  const files = createFileAccess(root, new AbortController().signal);
  await assert.rejects(files.readBytes('folder', 100), { code: 'INVALID_INPUT' });
});
