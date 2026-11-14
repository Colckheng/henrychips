import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DownloadManager, verifyFileSize } from '../../src/core/download/manager.js';
import type { PublicHttp } from '../../src/contracts/tool.js';
import type { NetdiskLink } from '../../src/tools/netdisk/types.js';

function fakeHttp(payload = Buffer.from('hello')): PublicHttp {
  return {
    getHtml: async () => ({ finalUrl: '', html: '', status: 200 }),
    getJson: async () => ({ finalUrl: '', data: {}, status: 200 }),
    getBinary: async () => ({ finalUrl: '', bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async () => ({ finalUrl: '', status: 200, contentType: '', bytes: new Uint8Array(), setCookie: [], headers: {} }),
    postForm: async () => ({ finalUrl: '', data: {}, status: 200 }),
    postJson: async () => ({ finalUrl: '', data: {}, status: 200 }),
    getStream: async (url: string) => ({
      finalUrl: url, status: 200, contentType: 'application/octet-stream', contentLength: payload.length,
      body: Readable.from([payload]), headers: {},
    }),
    getHead: async (url: string) => ({ finalUrl: url, status: 200, contentType: '', headers: {}, setCookie: [] }),
  } as unknown as PublicHttp;
}

function linkOf(overrides: Partial<NetdiskLink> = {}): NetdiskLink {
  return {
    path: 'a.bin', name: 'a.bin', sizeBytes: 5, url: 'https://example.com/a.bin',
    headers: {}, rangeSupported: false,
    source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
    ...overrides,
  };
}

function inputOf(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'lanzou' as const, title: 't', fileName: 'a.bin', filePath: 'a.bin', sizeBytes: 5,
    backend: 'builtin' as const, outputPath: 'a.bin',
    source: { platform: 'lanzou' as const, shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
    link: linkOf(),
    ...overrides,
  };
}

/** Waits until the task reaches one of the wanted states. */
async function until(manager: DownloadManager, id: string, statuses: string[]): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = manager.get(id)?.status;
    if (status && statuses.includes(status)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`the task ${id} did not reach ${statuses.join('|')}, it is ${manager.get(id)?.status}`);
}

test('creates a task and finishes it in the background', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  assert.equal(task.status, 'queued');
  let stop: (() => void) | undefined;
  const done = await new Promise<boolean>(resolve => {
    stop = manager.subscribe(tasks => {
      if (tasks.find(item => item.id === task.id)?.status === 'completed') { stop?.(); resolve(true); }
    });
  });
  assert.equal(done, true);
  assert.equal(manager.get(task.id)?.status, 'completed');
});

test('writes the file of a task under the output directory', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-file-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-file-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['completed', 'failed']);
  assert.equal((await readFile(path.join(output, 'a.bin'))).toString(), 'hello');
  assert.equal(manager.get(task.id)?.bytesWritten, 5);
});

test('keeps the tasks in the state directory so they survive a restart', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-state-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const first = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => first.shutdown());
  const task = first.create(inputOf());
  await until(first, task.id, ['completed']);
  // A second manager reads the same table, so the task is still there.
  const second = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => second.shutdown());
  assert.equal(second.get(task.id)?.status, 'completed');
  assert.equal(second.list().length, 1);
});

test('fetches a new link when the old one expired and continues the download', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-refresh-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-refresh-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const payload = Buffer.from('hello');
  let expired = true;
  const http = {
    ...fakeHttp(payload),
    getStream: async (url: string) => {
      if (expired) {
        expired = false;
        return { finalUrl: url, status: 403, contentType: '', contentLength: 0, body: Readable.from([]), headers: {} };
      }
      return {
        finalUrl: url, status: 200, contentType: 'application/octet-stream', contentLength: payload.length,
        body: Readable.from([payload]), headers: {},
      };
    },
  } as unknown as PublicHttp;
  let refreshed = 0;
  const manager = new DownloadManager({
    http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576,
    refreshLink: async () => { refreshed++; return linkOf({ url: 'https://example.com/fresh.bin' }); },
  });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['completed', 'failed']);
  assert.equal(manager.get(task.id)?.status, 'completed');
  assert.equal(refreshed, 1);
  assert.equal((await readFile(path.join(output, 'a.bin'))).toString(), 'hello');
});

test('reports a server that refuses the download as a failed task', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-fail-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-fail-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const http = {
    ...fakeHttp(),
    getStream: async (url: string) => ({
      finalUrl: url, status: 500, contentType: '', contentLength: 0, body: Readable.from([]), headers: {},
    }),
  } as unknown as PublicHttp;
  const manager = new DownloadManager({ http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['completed', 'failed']);
  const failed = manager.get(task.id);
  assert.equal(failed?.status, 'failed');
  assert.ok(failed?.error?.message);
});

test('refuses to continue a task whose link does not support resuming', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-norange-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-norange-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576, connections: 1 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['completed', 'failed']);
  assert.equal(manager.get(task.id)?.status, 'completed');
  // The table of the segments says that the file is there, so the task is
  // put back into the queue the way an interrupted download would be.
  const index = path.join(state, 'downloads', 'tasks.json');
  const tasks = JSON.parse(await readFile(index, 'utf8')) as Array<Record<string, unknown>>;
  for (const entry of tasks) if (entry.id === task.id) entry.status = 'paused';
  await writeFile(index, JSON.stringify(tasks), 'utf8');
  assert.equal(manager.resume(task.id), true);
  await until(manager, task.id, ['completed', 'failed']);
  const failed = manager.get(task.id);
  assert.equal(failed?.status, 'failed');
  // The reason is stated plainly, so the user knows that the bytes already
  // downloaded cannot be used.
  assert.match(failed?.error?.message ?? '', /不支持断点续传/);
});

test('pauses a running task and continues it later', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-pause-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-pause-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const http = {
    ...fakeHttp(),
    getStream: async (url: string) => {
      await gate;
      return {
        finalUrl: url, status: 200, contentType: 'application/octet-stream', contentLength: 5,
        body: Readable.from([Buffer.from('hello')]), headers: {},
      };
    },
  } as unknown as PublicHttp;
  const manager = new DownloadManager({ http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['preparing', 'downloading']);
  assert.equal(manager.pause(task.id), true);
  await until(manager, task.id, ['paused']);
  // The paused task can be continued.
  release?.();
  assert.equal(manager.resume(task.id), true);
  await until(manager, task.id, ['completed', 'failed']);
  assert.equal(manager.get(task.id)?.status, 'completed');
});

test('continues a task after the process was restarted', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-restart-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-restart-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const asked: string[] = [];
  let failures = 0;
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      const range = options?.headers?.Range ?? '';
      asked.push(range);
      // The second segment breaks the connection, so the task fails with one
      // segment already on the disk. The three tries of the segment are the
      // ones that break.
      if (range === 'bytes=5-9' && failures < 3) {
        failures++;
        throw new Error('the connection broke');
      }
      const matched = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
      return {
        finalUrl: url, status: 206, contentType: 'application/octet-stream',
        contentLength: end - start + 1, body: Readable.from([payload.subarray(start, end + 1)]),
        headers: { 'content-range': `bytes ${start}-${end}/${payload.length}` },
      };
    },
  } as unknown as PublicHttp;
  const link = linkOf({ sizeBytes: payload.length, rangeSupported: true });
  const first = new DownloadManager({ http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576, connections: 2 });
  t.after(() => first.shutdown());
  const task = first.create(inputOf({ sizeBytes: payload.length, link }));
  await until(first, task.id, ['failed', 'completed']);
  assert.equal(first.get(task.id)?.status, 'failed');
  const askedBefore = asked.length;
  // A new manager reads the table of the tasks and the breakpoint of the
  // download, so the segment that is already on the disk is not fetched
  // again.
  const second = new DownloadManager({ http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576, connections: 2 });
  t.after(() => second.shutdown());
  const restored = second.get(task.id);
  assert.equal(restored?.status, 'failed');
  assert.equal(second.resume(task.id), true);
  await until(second, task.id, ['completed', 'failed']);
  assert.equal(second.get(task.id)?.status, 'completed');
  const askedAgain = asked.slice(askedBefore);
  assert.equal(askedAgain.includes('bytes=5-9'), true);
  assert.equal(askedAgain.includes('bytes=0-4'), false);
  assert.equal((await readFile(path.join(output, 'a.bin'))).toString(), '0123456789');
});

test('removes a task and forgets it', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-remove-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-remove-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf());
  await until(manager, task.id, ['completed', 'failed']);
  assert.equal(manager.remove(task.id), true);
  assert.equal(manager.get(task.id), undefined);
  assert.equal(manager.remove(task.id), false);
});

test('gives a file of the same name a number of its own', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-unique-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-unique-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const first = manager.create(inputOf());
  const second = manager.create(inputOf());
  await until(manager, first.id, ['completed', 'failed']);
  await until(manager, second.id, ['completed', 'failed']);
  // The second download of the same file does not overwrite the first one.
  assert.notEqual(second.outputPath, first.outputPath);
  assert.equal(second.outputPath, 'a-1.bin');
});

test('completes a file that is shorter than announced with the real size', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-short-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-short-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  // The platform announces 20 bytes, the file really has 13, and the real
  // size cannot be asked for.
  const payload = Buffer.from('0123456789xyz');
  const http = {
    ...fakeHttp(payload),
    getRaw: async () => ({ finalUrl: '', status: 200, contentType: '', bytes: new Uint8Array(), setCookie: [], headers: {} }),
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      const range = options?.headers?.Range ?? '';
      const matched = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
      const slice = payload.subarray(start, Math.min(end + 1, payload.length));
      return {
        finalUrl: url, status: 206, contentType: 'application/octet-stream',
        contentLength: slice.length, body: Readable.from([slice]),
        headers: { 'content-range': `bytes ${start}-${start + slice.length - 1}/${payload.length}` },
      };
    },
  } as unknown as PublicHttp;
  const manager = new DownloadManager({ http, stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576, connections: 2 });
  t.after(() => manager.shutdown());
  const task = manager.create(inputOf({ sizeBytes: 20, link: linkOf({ sizeBytes: 20, rangeSupported: true }) }));
  await until(manager, task.id, ['completed', 'failed']);
  const done = manager.get(task.id);
  assert.equal(done?.status, 'completed');
  // The task carries the bytes that really arrived, not the announced size.
  assert.equal(done?.bytesWritten, payload.length);
  assert.equal(done?.totalBytes, payload.length);
  const onDisk = await readFile(path.join(output, 'a.bin'));
  assert.equal(onDisk.length, payload.length);
  assert.equal(onDisk.toString(), '0123456789xyz');
});

test('checks a downloaded file against the length it should have', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'a.bin');
  await writeFile(file, Buffer.from('hello'));
  assert.deepEqual(await verifyFileSize(file, 5), { ok: true, actual: 5 });
  assert.deepEqual(await verifyFileSize(file, 6), { ok: false, actual: 5 });
  assert.deepEqual(await verifyFileSize(path.join(directory, 'missing.bin'), 5), { ok: false, actual: null });
});
