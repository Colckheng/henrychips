import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createFileWriter } from '../../src/core/file-access.js';
import { completedBytes, parseSegmentTable, splitSegments } from '../../src/core/download/segment-table.js';
import { downloadSegmented, LinkExpiredError } from '../../src/core/download/segmenter.js';
import type { PublicHttp } from '../../src/contracts/tool.js';
import type { NetdiskLink } from '../../src/tools/netdisk/types.js';

function linkOf(overrides: Partial<NetdiskLink> = {}): NetdiskLink {
  return {
    path: 'a.bin', name: 'a.bin', sizeBytes: 10,
    url: 'https://example.com/a.bin', headers: {}, rangeSupported: true,
    source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
    ...overrides,
  };
}

/** A stream of the bytes of one segment, as the server of the range answers it. */
function rangeStream(payload: Buffer, headers?: Record<string, string>) {
  return async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
    const range = options?.headers?.Range ?? '';
    const matched = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(matched?.[1] ?? 0);
    const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
    return {
      finalUrl: url, status: 206, contentType: 'application/octet-stream',
      contentLength: end - start + 1,
      body: Readable.from([payload.subarray(start, end + 1)]),
      headers: headers ?? { 'content-range': `bytes ${start}-${end}/${payload.length}` },
    };
  };
}

test('splits a file into contiguous segments', () => {
  const segments = splitSegments(1000, 4);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0], { start: 0, end: 249, done: false });
  assert.deepEqual(segments[3], { start: 750, end: 999, done: false });
  assert.equal(segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0), 1000);
});

test('round-trips a segment table through text', () => {
  const table = { size: 100, segments: splitSegments(100, 2) };
  table.segments[0].done = true;
  const parsed = parseSegmentTable(JSON.stringify(table));
  assert.equal(parsed?.size, 100);
  assert.equal(parsed?.segments[0].done, true);
  assert.equal(completedBytes(parsed!), 50);
});

test('downloads a file in parallel segments into the right offsets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      const range = options?.headers?.Range ?? '';
      const matched = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
      return {
        finalUrl: url, status: 206, contentType: 'application/octet-stream',
        contentLength: end - start + 1,
        body: Readable.from([payload.subarray(start, end + 1)]),
        headers: { 'content-range': `bytes ${start}-${end}/${payload.length}` },
      };
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const result = await downloadSegmented({
    path: 'a.bin', name: 'a.bin', sizeBytes: payload.length,
    url: 'https://example.com/a.bin', headers: {}, rangeSupported: true,
    source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
  }, { http, writer, signal: new AbortController().signal, outputPath: 'a.bin' });
  assert.equal(result.bytesWritten, payload.length);
  assert.equal((await readFile(path.join(directory, 'a.bin'))).toString(), '0123456789');
});

test('sends the headers of the link with every segment request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-headers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const seen: Array<Record<string, string> | undefined> = [];
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      seen.push(options?.headers);
      return rangeStream(payload)(url, _signal, options);
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await downloadSegmented(linkOf({ headers: { Cookie: 'down_ip=1', Referer: 'https://example.com/' } }), {
    http, writer, signal: new AbortController().signal, outputPath: 'a.bin', connections: 2,
  });
  assert.ok(seen.length >= 2);
  for (const headers of seen) {
    assert.equal(headers?.Cookie, 'down_ip=1');
    assert.equal(headers?.Referer, 'https://example.com/');
  }
});

test('skips the segments that are already done when it continues', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const asked: string[] = [];
  const http = {
    getStream: async (url: string, signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      asked.push(options?.headers?.Range ?? '');
      return rangeStream(payload)(url, signal, options);
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  // The bytes of the first segment are already on the disk, as they would be
  // after a run that was interrupted.
  const first = await writer.open('a.bin', { overwrite: true, truncateTo: payload.length });
  await first.writeAt(payload.subarray(0, 5), 0);
  await first.close();
  const table = { size: payload.length, segments: splitSegments(payload.length, 2) };
  table.segments[0].done = true;
  const result = await downloadSegmented(linkOf(), {
    http, writer, signal: new AbortController().signal, outputPath: 'a.bin', connections: 2, segments: table,
  });
  // The finished segment is never asked again.
  assert.deepEqual(asked, ['bytes=5-9']);
  assert.equal(result.bytesWritten, payload.length);
  assert.equal((await readFile(path.join(directory, 'a.bin'))).toString(), '0123456789');
});

test('reports the segments that are done as soon as they are done', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-callback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const http = { getStream: async (url: string, signal: AbortSignal, options?: { headers?: Record<string, string> }) => rangeStream(payload)(url, signal, options) } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const done: number[] = [];
  await downloadSegmented(linkOf(), {
    http, writer, signal: new AbortController().signal, outputPath: 'a.bin', connections: 2,
    onSegmentComplete: table => { done.push(table.segments.filter(segment => segment.done).length); },
  });
  // The callback is called once per finished segment, and the table it gets
  // already carries the finished mark.
  assert.equal(done.length, 2);
  assert.equal(done[done.length - 1], 2);
});

test('reports a link that no longer works instead of writing a broken file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-expired-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const http = {
    getStream: async (url: string) => ({
      finalUrl: url, status: 403, contentType: '', contentLength: 0,
      body: Readable.from([]), headers: {},
    }),
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(
    () => downloadSegmented(linkOf(), { http, writer, signal: new AbortController().signal, outputPath: 'a.bin' }),
    (error: unknown) => error instanceof LinkExpiredError,
  );
});

test('stops when the server does not answer a range with a partial answer', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-norange-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const http = {
    // The server ignores the range and answers with the whole file, so the
    // bytes would land on the wrong offsets.
    getStream: async (url: string) => ({
      finalUrl: url, status: 200, contentType: 'application/octet-stream',
      contentLength: payload.length, body: Readable.from([payload]), headers: {},
    }),
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(
    () => downloadSegmented(linkOf(), { http, writer, signal: new AbortController().signal, outputPath: 'a.bin' }),
    (error: unknown) => error instanceof Error && /不支持分段下载/.test(error.message),
  );
});

test('downloads a link without resuming in one piece', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-plain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const seen: Array<Record<string, string> | undefined> = [];
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      seen.push(options?.headers);
      return {
        finalUrl: url, status: 200, contentType: 'application/octet-stream',
        contentLength: payload.length, body: Readable.from([payload]), headers: {},
      };
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const result = await downloadSegmented(linkOf({ rangeSupported: false }), {
    http, writer, signal: new AbortController().signal, outputPath: 'a.bin',
  });
  assert.equal(result.rangeSupported, false);
  assert.equal(result.bytesWritten, payload.length);
  // No range is asked for, because the link does not support resuming.
  assert.equal(seen[0]?.Range, undefined);
  assert.equal((await readFile(path.join(directory, 'a.bin'))).toString(), '0123456789');
});

test('refuses to continue a link without resuming', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-plain-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const http = { getStream: async () => { throw new Error('the link must not be asked'); } } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const table = { size: 10, segments: splitSegments(10, 2) };
  table.segments[0].done = true;
  await assert.rejects(
    () => downloadSegmented(linkOf({ rangeSupported: false }), {
      http, writer, signal: new AbortController().signal, outputPath: 'a.bin', segments: table,
    }),
    (error: unknown) => error instanceof Error && /不支持断点续传/.test(error.message),
  );
});

test('tries a segment again when the connection breaks halfway', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  let calls = 0;
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      calls++;
      const range = options?.headers?.Range ?? '';
      const matched = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
      // The first answer breaks in the middle of the segment.
      const body = calls === 1
        ? Readable.from([payload.subarray(start, start + 2)])
        : Readable.from([payload.subarray(start, end + 1)]);
      return {
        finalUrl: url, status: 206, contentType: 'application/octet-stream',
        contentLength: end - start + 1, body,
        headers: { 'content-range': `bytes ${start}-${end}/${payload.length}` },
      };
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const result = await downloadSegmented(linkOf(), {
    http, writer, signal: new AbortController().signal, outputPath: 'a.bin', connections: 1,
  });
  assert.equal(calls, 2);
  assert.equal(result.bytesWritten, payload.length);
  assert.equal((await readFile(path.join(directory, 'a.bin'))).toString(), '0123456789');
});
