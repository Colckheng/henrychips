import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/core/config.js';
import { buildApp } from '../../src/adapters/http/app.js';

const headers = { host: '127.0.0.1:4318' };

test('a run keeps going on the server after the client disconnects and its result stays available', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-detach-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const requestId = randomUUID();
  const ownerToken = 'owner-token-for-tests';
  const pending = app.inject({
    method: 'POST', url: '/api/tools/pdf_extract/run',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { input: { path: 'samples/guide.pdf' }, requestId, ownerToken },
  }).catch(() => undefined);
  // The browser tab goes away while the tool is still working. The result is
  // waited for instead of a fixed delay, because a busy machine can need
  // longer than a guess.
  let body: { ok?: boolean; meta?: { runId?: string }; data?: { textCharacters?: number } } | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await app.inject({ url: `/api/runs/${requestId}/result`, headers: { ...headers, 'x-run-token': ownerToken } });
    if (result.statusCode === 200) {
      body = result.json();
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(body, 'the result of the detached run must become available');
  assert.equal(body!.ok, true);
  assert.equal(body!.meta!.runId, requestId);
  assert.ok(body!.data!.textCharacters! > 0);
  await pending;
});

test('only the owner of a run can read or cancel it', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-owner-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const requestId = randomUUID();
  await app.inject({
    method: 'POST', url: '/api/tools/pdf_extract/run',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { input: { path: 'samples/guide.pdf' }, requestId, ownerToken: 'owner-token-for-tests' },
  });
  const foreign = await app.inject({ url: `/api/runs/${requestId}/result`, headers: { ...headers, 'x-run-token': 'another-token' } });
  assert.equal(foreign.statusCode, 404);
  const foreignCancel = await app.inject({ method: 'POST', url: `/api/runs/${requestId}/cancel`, headers: { ...headers, 'x-run-token': 'another-token' } });
  assert.equal(foreignCancel.json().cancelled, false);
  const owner = await app.inject({ url: `/api/runs/${requestId}/result`, headers: { ...headers, 'x-run-token': 'owner-token-for-tests' } });
  assert.equal(owner.statusCode, 200);
});
