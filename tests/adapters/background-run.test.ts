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
  const controller = new AbortController();
  const pending = app.inject({
    method: 'POST', url: '/api/tools/pdf_extract/run',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { input: { path: 'samples/guide.pdf' }, requestId },
  }).catch(() => undefined);
  // The browser tab goes away while the tool is still working.
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 3000));

  const result = await app.inject({ url: `/api/runs/${requestId}/result`, headers });
  assert.equal(result.statusCode, 200);
  const body = result.json();
  assert.equal(body.ok, true);
  assert.equal(body.meta.runId, requestId);
  assert.ok(body.data.textCharacters > 0);
  await pending;
});

test('a run can still be cancelled explicitly while it is in flight', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-cancel-run-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const requestId = randomUUID();
  const pending = app.inject({
    method: 'POST', url: '/api/tools/pdf_extract/run',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { input: { path: 'samples/guide.pdf' }, requestId },
  }).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 50));
  const cancelled = await app.inject({ method: 'POST', url: `/api/runs/${requestId}/cancel`, headers });
  assert.equal(cancelled.statusCode, 200);
  await pending;
  const result = await app.inject({ url: `/api/runs/${requestId}/result`, headers });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().error.code, 'CANCELLED');
});
