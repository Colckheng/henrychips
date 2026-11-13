import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../src/adapters/http/app.js';
import { loadConfig } from '../../src/core/config.js';
import { DownloadManager } from '../../src/core/download/manager.js';
import { ToolExecutor } from '../../src/core/executor.js';
import { RunStore } from '../../src/core/run-store.js';
import { NdmClient } from '../../src/core/ndm/client.js';
import { createRegistry } from '../../src/tools/index.js';
import { createPublicHttp } from '../../src/core/public-http.js';

async function appFor(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-http-'));
  const config = { ...await loadConfig(), stateDirectory: dir };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}
const headers = { host: '127.0.0.1:4318' };

test('HTTP routes discover and run actual tools and retain summaries only', async t => {
  const app = await appFor(t);
  const list = await app.inject({ url: '/api/tools', headers });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().some((tool: { name: string }) => tool.name === 'csv_summary'));
  const run = await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: 'Hello 世界\n第二行' } } });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().data.characters, 12);
  const invalid = await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: '   ' } } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_INPUT');
  const history = await app.inject({ url: '/api/runs', headers });
  assert.equal(history.json().runs.length, 2);
  assert.equal(history.json().runs[0].input, undefined);
  const integrations = await app.inject({ url: '/api/integrations', headers });
  assert.equal(integrations.json().mcp.configured, false);
  assert.ok(integrations.json().mcp.config.mcpServers['personal-workstation'].args.includes('--config'));
});

test('HTTP rejects remote hosts origins and malformed requests', async t => {
  const app = await appFor(t);
  assert.equal((await app.inject({ url: '/api/tools', headers: { host: 'attacker.invalid:4318' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/tools', headers: { ...headers, origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: 'a' }, extra: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
  assert.equal((await app.inject({ url: '/api/runs?limit=-1', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/tools/missing', headers })).statusCode, 404);
});

test('development API accepts the explicit Vite origin but production does not', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-dev-origin-'));
  const config = { ...await loadConfig(), stateDirectory: dir };
  const dev = await buildApp(config, { dev: true });
  const production = await buildApp(config);
  t.after(async () => { await dev.close(); await production.close(); await rm(dir, { recursive: true, force: true }); });
  const request = { url: '/api/tools', headers: { ...headers, origin: 'http://127.0.0.1:5173' } };
  assert.equal((await dev.inject(request)).statusCode, 200);
  assert.equal((await production.inject(request)).statusCode, 403);
});

/**
 * An app whose download manager is driven by the test instead of by the
 * network. The queue never starts a download, so the state of a task is
 * decided by the test alone and no file is written while the test runs.
 */
async function downloadsAppFor(t: { after(fn: () => Promise<void>): void }) {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-downloads-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-downloads-out-'));
  const config = { ...await loadConfig(), stateDirectory: state, outputDirectory: output };
  const registry = createRegistry();
  const store = new RunStore(state);
  const downloads = new DownloadManager({ http: createPublicHttp(config.limits.webBytes), stateDirectory: state, outputDirectory: output, outputBytesLimit: config.limits.outputBytes, concurrency: 0 });
  const executor = new ToolExecutor(registry, config, store);
  const app = await buildApp(config, { runtime: { registry, store, executor, downloads, ndm: new NdmClient() } });
  t.after(async () => {
    await app.close();
    await downloads.shutdown();
    await rm(state, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  });
  return { app, downloads };
}

function taskInput() {
  const source = { platform: 'lanzou' as const, shareUrl: 'https://lanzou.com/s/abc', code: 'p4ss', filePath: 'folder/a.bin', fileId: '1' };
  return {
    platform: 'lanzou' as const, title: '示例分享', fileName: 'a.bin', filePath: 'folder/a.bin', sizeBytes: 5,
    backend: 'builtin' as const, outputPath: 'a.bin', source,
    link: { path: 'a.bin', name: 'a.bin', sizeBytes: 5, url: 'https://lanzou.com/d/secret', headers: { Cookie: 'session=secret' }, rangeSupported: false, source },
  };
}

test('lists download tasks over http', async t => {
  const app = await appFor(t);
  const response = await app.inject({ method: 'GET', url: '/api/downloads', headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tasks, []);
});

test('a download task is read and steered over http', async t => {
  const { app, downloads } = await downloadsAppFor(t);
  const task = downloads.create(taskInput());
  const list = await app.inject({ method: 'GET', url: '/api/downloads', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().tasks.length, 1);
  assert.equal(list.json().tasks[0].id, task.id);
  assert.equal(list.json().tasks[0].fileName, 'a.bin');
  const detail = await app.inject({ method: 'GET', url: `/api/downloads/${task.id}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().id, task.id);
  const missing = await app.inject({ method: 'GET', url: '/api/downloads/missing', headers });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'TOOL_NOT_FOUND');
  const pause = await app.inject({ method: 'POST', url: `/api/downloads/${task.id}/pause`, headers });
  assert.deepEqual(pause.json(), { paused: true });
  const resume = await app.inject({ method: 'POST', url: `/api/downloads/${task.id}/resume`, headers });
  assert.deepEqual(resume.json(), { resumed: true });
  const remove = await app.inject({ method: 'DELETE', url: `/api/downloads/${task.id}`, headers });
  assert.deepEqual(remove.json(), { removed: true });
  const gone = await app.inject({ method: 'GET', url: `/api/downloads/${task.id}`, headers });
  assert.equal(gone.statusCode, 404);
});

test('a download task that is not there cannot be paused, continued or removed', async t => {
  const { app } = await downloadsAppFor(t);
  const pause = await app.inject({ method: 'POST', url: '/api/downloads/missing/pause', headers });
  assert.equal(pause.statusCode, 200);
  assert.deepEqual(pause.json(), { paused: false });
  const resume = await app.inject({ method: 'POST', url: '/api/downloads/missing/resume', headers });
  assert.deepEqual(resume.json(), { resumed: false });
  const remove = await app.inject({ method: 'DELETE', url: '/api/downloads/missing', headers });
  assert.deepEqual(remove.json(), { removed: false });
});

test('the answer about a download task carries neither the passcode nor the session of the platform', async t => {
  const { app, downloads } = await downloadsAppFor(t);
  downloads.create(taskInput());
  const list = await app.inject({ method: 'GET', url: '/api/downloads', headers });
  const body = JSON.stringify(list.json());
  assert.equal(body.includes('p4ss'), false, 'the passcode of the share must not leave the workstation');
  assert.equal(body.includes('session=secret'), false, 'the session of the platform must not leave the workstation');
  assert.equal(list.json().tasks[0].source, undefined);
  assert.equal(list.json().tasks[0].link, undefined);
});

test('the download events are delivered as server-sent events', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-downloads-sse-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-downloads-sse-out-'));
  const base = await loadConfig();
  const port = 4407;
  const config = { ...base, stateDirectory: state, outputDirectory: output, http: { ...base.http, port } };
  const registry = createRegistry();
  const store = new RunStore(state);
  const downloads = new DownloadManager({ http: createPublicHttp(config.limits.webBytes), stateDirectory: state, outputDirectory: output, outputBytesLimit: config.limits.outputBytes, concurrency: 0 });
  const executor = new ToolExecutor(registry, config, store);
  const app = await buildApp(config, { runtime: { registry, store, executor, downloads, ndm: new NdmClient() } });
  t.after(async () => {
    await app.close();
    await downloads.shutdown();
    await rm(state, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  });
  await app.listen({ host: '127.0.0.1', port });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/downloads/events`, {
    headers: { host: `127.0.0.1:${port}` },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
  const frames = new EventFrames(response.body!.getReader());
  const first = await frames.next();
  assert.match(first, /^data: \{"tasks":\[/);
  // A task that appears is pushed to the client without asking for it.
  const task = downloads.create(taskInput());
  const second = await frames.next();
  assert.match(second, new RegExp(`"id":"${task.id}"`));
  controller.abort();
  await frames.cancel();
});

/**
 * Reads the frames of an event stream. Only one read is pending at a time,
 * so a chunk that arrives while the test waits for a frame is not lost.
 */
class EventFrames {
  private readonly decoder = new TextDecoder();
  private buffered = '';
  private pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<string> {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const end = this.buffered.indexOf('\n\n');
      if (end >= 0) {
        const frame = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end + 2);
        return frame;
      }
      this.pending ??= this.reader.read();
      const chunk = await Promise.race([
        this.pending,
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 500)),
      ]);
      if (chunk === undefined) continue;
      this.pending = undefined;
      if (chunk.value) this.buffered += this.decoder.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    throw new Error(`no frame arrived, the stream held: ${this.buffered}`);
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}
