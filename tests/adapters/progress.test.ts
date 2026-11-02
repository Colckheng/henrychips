import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/core/config.js';
import { buildApp } from '../../src/adapters/http/app.js';

test('a running tool reports progress that can be polled while the run is in flight', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-progress-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  const requestId = randomUUID();
  const run = app.inject({ method: 'POST', url: '/api/tools/pdf_extract/run', headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' }, payload: { input: { path: 'samples/guide.pdf' }, requestId } });
  let polled: { status: number; body: Record<string, unknown> } | undefined;
  for (let attempt = 0; attempt < 50 && !polled; attempt++) {
    const response = await app.inject({ url: `/api/runs/${requestId}/progress`, headers: { host: '127.0.0.1:4318' } });
    if (response.statusCode === 200) polled = { status: 200, body: response.json() };
    else await new Promise(resolve => setTimeout(resolve, 40));
  }
  const result = await run;
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().meta.runId, requestId);
  assert.ok(polled, 'progress should be observable while the run is in flight');
  assert.equal(polled!.body.runId, requestId);
  assert.equal(polled!.body.tool, 'pdf_extract');
  assert.ok(['running', 'succeeded'].includes(String(polled!.body.status)));
  assert.ok(Array.isArray(polled!.body.steps));

  const missing = await app.inject({ url: `/api/runs/${randomUUID()}/progress`, headers: { host: '127.0.0.1:4318' } });
  assert.equal(missing.statusCode, 404);
});

test('progress events are delivered as server-sent events', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-progress-sse-'));
  const base = await loadConfig();
  const port = 4399;
  const app = await buildApp({ ...base, stateDirectory: directory, http: { ...base.http, port } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen({ host: '127.0.0.1', port });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${randomUUID()}/events`, {
    headers: { host: `127.0.0.1:${port}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
  const reader = response.body!.getReader();
  const chunk = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ value: new TextEncoder().encode('data: {}') }), 4000))]);
  const text = new TextDecoder().decode((chunk as { value?: Uint8Array }).value ?? new Uint8Array());
  assert.match(text, /^data: \{/);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});

test('the output folder can be opened without accepting arbitrary paths', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-open-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await app.inject({ method: 'POST', url: '/api/output/open', headers: { host: '127.0.0.1:4318' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().opened, true);
  assert.ok(String(response.json().directory).length > 0);
});

test('the node identity reports capabilities and the tool catalogue', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-identity-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await app.inject({ url: '/api/node/identity', headers: { host: '127.0.0.1:4318' } });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.version, '0.1.0');
  assert.equal(typeof body.platform, 'string');
  assert.equal(body.capabilities.browser, true);
  assert.ok(body.tools.length >= 12);
  assert.ok(body.tools.every((tool: { name: string }) => typeof tool.name === 'string'));
});
