import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFileAccess, createFileWriter, writeUniqueFile } from '../../src/core/file-access.js';

test('bounds actual reads and rejects traversal and Windows path bypasses', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'workstation-files-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  await mkdir(path.join(base, 'root-sibling'));
  await writeFile(path.join(root, 'file.txt'), 'hello');
  await writeFile(path.join(base, 'outside.txt'), 'secret');
  await writeFile(path.join(base, 'root-sibling', 'secret.txt'), 'secret');
  const files = createFileAccess(root, new AbortController().signal);
  assert.equal(await files.readText('file.txt', 5), 'hello');
  await assert.rejects(files.readText('file.txt', 4), { code: 'LIMIT_EXCEEDED' });
  for (const value of ['../root-sibling/secret.txt', '../outside.txt', '..\\outside.txt', '/tmp/a', 'C:\\a', '\\\\server\\share', 'file.txt:stream', 'NUL', 'file\u0000.txt']) {
    await assert.rejects(files.readText(value, 100), { code: 'ACCESS_DENIED' });
  }
  assert.equal(await files.exists('missing.txt'), false);
  await assert.rejects(files.readText('missing.txt', 100), { code: 'FILE_NOT_FOUND' });
});

test('rejects junctions resolving outside root and skips their enumeration', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'workstation-link-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try { await symlink(outside, path.join(root, 'link'), 'junction'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('junction permission unavailable'); return; } throw error; }
  const files = createFileAccess(root, new AbortController().signal);
  await assert.rejects(files.readText('link/secret.txt', 100), { code: 'ACCESS_DENIED' });
  assert.equal((await files.list('.', 10))[0].kind, 'symlink');
});

test('keeps writing unique names after many collisions with the same file name', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'workstation-unique-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const writer = createFileWriter(base, new AbortController().signal, 1048576);
  const bytes = new Uint8Array([1, 2, 3]);
  // A long-running workstation writes the same output name over and over.
  for (let index = 0; index < 120; index++) {
    const saved = await writeUniqueFile(writer, 'report.txt', bytes);
    assert.match(saved.relativePath, /^report(-\d+)?\.txt$/);
  }
});
