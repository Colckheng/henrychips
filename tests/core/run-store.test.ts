import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RunStore } from '../../src/core/run-store.js';

test('independent storage instances preserve concurrent records and return newest first after reopening', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const older = { runId: randomUUID(), tool: 'text_stats', source: 'cli' as const, status: 'succeeded' as const, startedAt: '2026-11-02T00:00:00.000Z', durationMs: 1, errorCode: null };
  const newer = { ...older, runId: randomUUID(), source: 'mcp' as const, startedAt: '2026-11-02T00:00:01.000Z' };
  await Promise.all([new RunStore(dir).append(older), new RunStore(dir).append(newer)]);
  assert.deepEqual((await new RunStore(dir).list(1)).runs, [newer]);
  assert.equal((await new RunStore(dir).list(10)).runs.length, 2);
});

test('a second listing reuses the cached summary instead of re-reading the file', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunStore(dir);
  const summary = { runId: randomUUID(), tool: 'text_stats', source: 'web' as const, status: 'succeeded' as const, startedAt: '2026-11-02T00:00:00.000Z', durationMs: 1, errorCode: null };
  await store.append(summary);
  assert.deepEqual((await store.list(10)).runs, [summary]);
  // Corrupt the file on disk without touching its size or timestamp. A cached
  // summary is still reported; a fresh read would fail to parse it.
  const file = path.join(dir, 'runs', `${summary.runId}.json`);
  const info = await stat(file);
  const original = await readFile(file, 'utf8');
  const altered = original.replace('"durationMs":1', '"durationMs":9');
  assert.equal(altered.length, original.length);
  await writeFile(file, altered);
  await utimes(file, info.atime, info.mtime);
  const listed = (await store.list(10)).runs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].durationMs, 1);
});

test('a changed file on disk is read again instead of served from the cache', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RunStore(dir);
  const summary = { runId: randomUUID(), tool: 'text_stats', source: 'web' as const, status: 'succeeded' as const, startedAt: '2026-11-02T00:00:00.000Z', durationMs: 1, errorCode: null };
  await store.append(summary);
  assert.deepEqual((await store.list(10)).runs, [summary]);
  const changed = { ...summary, durationMs: 42 };
  await writeFile(path.join(dir, 'runs', `${summary.runId}.json`), JSON.stringify(changed));
  const listed = (await store.list(10)).runs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].durationMs, 42);
});
