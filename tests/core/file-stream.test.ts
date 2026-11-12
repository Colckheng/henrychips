import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileWriter } from '../../src/core/file-access.js';

test('writes bytes at an offset into a preallocated file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('segments.bin', { truncateTo: 10 });
  await handle.writeAt(new TextEncoder().encode('ABCDE'), 0);
  await handle.writeAt(new TextEncoder().encode('FGHIJ'), 5);
  await handle.close();
  assert.equal(await readFile(path.join(directory, 'segments.bin'), 'utf8'), 'ABCDEFGHIJ');
});

test('refuses to open a path outside the output directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(() => writer.open('../escape.bin'), /输出路径/);
  await assert.rejects(() => writer.open('/absolute.bin'), /输出路径/);
});

test('refuses to open an existing file unless overwrite is set', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'exists.bin'), 'old');
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(() => writer.open('exists.bin'), /已存在/);
  const handle = await writer.open('exists.bin', { overwrite: true });
  await handle.close();
});

test('keeps the bytes already on disk when a download resumes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'resume.bin'), 'ABCDE');
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('resume.bin', { overwrite: true });
  await handle.writeAt(new TextEncoder().encode('XY'), 0);
  await handle.close();
  assert.equal(await readFile(path.join(directory, 'resume.bin'), 'utf8'), 'XYCDE');
});

test('preallocates the file to the requested size', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('preallocated.bin', { truncateTo: 4096 });
  await handle.close();
  assert.equal((await stat(path.join(directory, 'preallocated.bin'))).size, 4096);
});

test('refuses to write past the output size limit', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 4);
  const handle = await writer.open('small.bin');
  await handle.writeAt(new TextEncoder().encode('abc'), 0);
  await assert.rejects(() => handle.writeAt(new TextEncoder().encode('def'), 3), { code: 'LIMIT_EXCEEDED' });
  await handle.close();
  assert.equal(await readFile(path.join(directory, 'small.bin'), 'utf8'), 'abc');
});

test('counts the bytes already on disk against the limit when a download resumes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'resume-limit.bin'), 'abc');
  const writer = createFileWriter(directory, new AbortController().signal, 4);
  const handle = await writer.open('resume-limit.bin', { overwrite: true });
  await handle.writeAt(new TextEncoder().encode('d'), 3);
  await assert.rejects(() => handle.writeAt(new TextEncoder().encode('e'), 4), { code: 'LIMIT_EXCEEDED' });
  await handle.close();
  assert.equal(await readFile(path.join(directory, 'resume-limit.bin'), 'utf8'), 'abcd');
});

test('fills the gap when a segment lands past the current end of the file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('sparse.bin');
  await handle.writeAt(new TextEncoder().encode('TAIL'), 4);
  await handle.close();
  const bytes = await readFile(path.join(directory, 'sparse.bin'));
  assert.equal(bytes.byteLength, 8);
  assert.equal(bytes.subarray(0, 4).toString(), '\0\0\0\0');
  assert.equal(bytes.subarray(4).toString(), 'TAIL');
});

test('rejects a negative write position', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('negative.bin');
  await assert.rejects(() => handle.writeAt(new TextEncoder().encode('x'), -1), { code: 'INVALID_INPUT' });
  await handle.close();
});

test('refuses to use a handle after it is closed and tolerates a second close', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('closed.bin');
  await handle.writeAt(new TextEncoder().encode('abc'), 0);
  assert.equal(handle.bytesWritten(), 3);
  await handle.close();
  await handle.close();
  await assert.rejects(() => handle.writeAt(new TextEncoder().encode('x'), 0), { code: 'ACCESS_DENIED' });
  await assert.rejects(() => handle.truncate(10), { code: 'ACCESS_DENIED' });
});
