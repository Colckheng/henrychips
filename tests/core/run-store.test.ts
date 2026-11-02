import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
