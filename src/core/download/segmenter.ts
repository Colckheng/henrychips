import { ToolError } from '../errors.js';
import type { FileWriter, PublicHttp } from '../../contracts/tool.js';
import type { NetdiskLink } from '../../tools/netdisk/types.js';
import { splitSegments, type Segment, type SegmentTable } from './segment-table.js';

/**
 * A direct link that no longer works. A subclass of the tool error rather
 * than a new error code keeps the global code contract untouched while the
 * download manager can still tell "the link has to be fetched again" from
 * "the download failed".
 */
export class LinkExpiredError extends ToolError {
  constructor(message = '直链已失效。') {
    super('TOOL_FAILED', message);
    this.name = 'LinkExpiredError';
  }
}

/**
 * A fault of the protocol of the server, not of the network. Asking again
 * would answer the same way, so the segment is not tried again.
 */
class SegmentProtocolError extends ToolError {
  constructor(message: string) {
    super('TOOL_FAILED', message);
    this.name = 'SegmentProtocolError';
  }
}

export interface SegmenterOptions {
  http: PublicHttp;
  writer: FileWriter;
  signal: AbortSignal;
  /** The relative path inside the output directory. The kernel does not decide the file name itself. */
  outputPath: string;
  /** How many connections a file is split into. Defaults to 8. */
  connections?: number;
  /** For resuming: the segment table that already exists. The segments that are done are skipped. */
  segments?: SegmentTable;
  onProgress?: (update: { bytesWritten: number; totalBytes: number; speedBytesPerSecond: number }) => void;
  /** Called when a segment is done, so the caller can persist the breakpoint at once. */
  onSegmentComplete?: (table: SegmentTable) => void | Promise<void>;
}

export interface SegmenterResult {
  bytesWritten: number;
  totalBytes: number;
  rangeSupported: boolean;
  /** The updated segment table; the caller is the one that persists it. */
  table: SegmentTable;
}

/** How often a segment is tried again before the download gives up. */
const SEGMENT_ATTEMPTS = 3;
/** The ceiling of one segment request. A slow segment must not hang the whole download. */
const SEGMENT_TIMEOUT_MS = 60_000;

export async function downloadSegmented(link: NetdiskLink, options: SegmenterOptions): Promise<SegmenterResult> {
  const total = link.sizeBytes ?? 0;
  if (!total) throw new ToolError('TOOL_FAILED', '无法确定文件大小，无法下载。');
  const connections = Math.max(1, options.connections ?? 8);
  const useRange = link.rangeSupported !== false;
  // The table that is passed in is continued, so the segments that are already
  // done are never fetched again. The table is filled in place, so a caller
  // that never sees the result still knows which segments are done.
  const table: SegmentTable = options.segments && options.segments.size === total
    ? options.segments
    : { size: total, segments: splitSegments(total, useRange ? connections : 1) };
  // A link without resuming is fetched in one piece, so the table holds one
  // segment that covers the whole file. A table that already holds finished
  // bytes cannot be continued by such a link, so the download is refused
  // instead of producing a file with holes in it.
  if (!useRange) {
    if (options.segments && options.segments.segments.some(segment => segment.done)) {
      throw new ToolError('TOOL_FAILED', '该直链不支持断点续传，无法接着已下载的字节继续，请重新开始下载。');
    }
    table.segments = [{ start: 0, end: total - 1, done: false }];
  }

  // One segment that fails ends the whole download, so the other segments
  // have to stop before the file handle is closed under their feet.
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);

  const handle = await options.writer.open(options.outputPath, { overwrite: true, truncateTo: total });
  /** The bytes that are written for one segment, so a retry continues where it stopped. */
  const written = new Map<Segment, number>();
  const startedAt = Date.now();
  let lastTickAt = startedAt;
  let lastTickBytes = 0;

  const bytesWritten = () => table.segments.reduce((sum, segment) => (
    sum + (segment.done ? segment.end - segment.start + 1 : written.get(segment) ?? 0)
  ), 0);

  const report = (force = false) => {
    const now = Date.now();
    const elapsed = now - lastTickAt;
    if (!force && elapsed < 1000) return;
    options.onProgress?.({
      bytesWritten: bytesWritten(),
      totalBytes: total,
      speedBytesPerSecond: elapsed > 0 ? lastTickBytes / (elapsed / 1000) : 0,
    });
    lastTickAt = now;
    lastTickBytes = 0;
  };

  try {
    // A failing segment ends the whole download, so the other segments are
    // stopped right away. Every segment has to settle before the file handle
    // is closed, so none of them writes to a closed handle.
    const outcomes = await Promise.allSettled(table.segments.map(segment => runSegment(segment)));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw failure.reason;
    report(true);
    return { bytesWritten: total, totalBytes: total, rangeSupported: useRange, table };
  } finally {
    await handle.close();
  }

  async function runSegment(segment: Segment): Promise<void> {
    if (segment.done) return;
    try {
      await fetchSegment(segment);
    } catch (error) {
      stopped.abort();
      throw error;
    }
  }

  async function fetchSegment(segment: Segment): Promise<void> {
    if (segment.done) return;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new ToolError('CANCELLED', '下载已取消。');
      const from = segment.start + (written.get(segment) ?? 0);
      const to = segment.end;
      if (from > to) break;
      try {
        await readSegment(segment, from, to);
      } catch (error) {
        // An expired link is not a fault of the segment: the manager has to
        // fetch a new link and continue.
        if (error instanceof LinkExpiredError) throw error;
        if (error instanceof SegmentProtocolError) throw error;
        if (signal.aborted) throw new ToolError('CANCELLED', '下载已取消。');
        // Without resuming the server sends the file from its start again, so
        // a half written segment cannot be continued.
        if (!useRange) throw error;
        if (attempt >= SEGMENT_ATTEMPTS) throw error;
      }
      if ((written.get(segment) ?? 0) >= segment.end - segment.start + 1) break;
    }
    segment.done = true;
    await options.onSegmentComplete?.(table);
  }

  async function readSegment(segment: Segment, from: number, to: number): Promise<void> {
    const headers = useRange ? { ...link.headers, Range: `bytes=${from}-${to}` } : { ...link.headers };
    const response = await options.http.getStream(link.url, signal, {
      headers,
      timeoutMs: SEGMENT_TIMEOUT_MS,
      // The ceiling is the size of the whole file: an answer that ignores the
      // range is still read as far as its status, and a body that is too big
      // is refused instead of filling the disk.
      maxBytes: total,
    });
    if ([403, 404, 410].includes(response.status)) {
      response.body.destroy();
      throw new LinkExpiredError(`直链已失效（HTTP ${response.status}）。`);
    }
    if (useRange && response.status !== 206) {
      // A server that answers with the whole file instead of the requested
      // range would write the file to the wrong offsets, so the download stops
      // here rather than producing a damaged file.
      response.body.destroy();
      throw new SegmentProtocolError('该直链不支持分段下载（服务器未返回 206），已停止以免写出损坏的文件。');
    }
    if (!useRange && response.status !== 200) {
      response.body.destroy();
      throw new SegmentProtocolError(`下载失败（HTTP ${response.status}）。`);
    }
    // The range of the answer has to be the range that was asked for,
    // otherwise the bytes land on the wrong offsets.
    const contentRange = response.headers?.['content-range'];
    const rangeStart = contentRange ? Number(/bytes=(\d+)-/i.exec(contentRange)?.[1] ?? Number.NaN) : Number.NaN;
    if (useRange && Number.isFinite(rangeStart) && rangeStart !== from) {
      response.body.destroy();
      throw new SegmentProtocolError('服务器返回的字节范围与请求的不一致，已停止以免写出损坏的文件。');
    }
    let position = from;
    let count = written.get(segment) ?? 0;
    try {
      for await (const chunk of response.body) {
        if (signal.aborted) throw new ToolError('CANCELLED', '下载已取消。');
        const buffer = Buffer.from(chunk);
        // A server that sends more bytes than the segment covers would write
        // into the offsets of the next segment, so the download stops here.
        if (position + buffer.byteLength > to + 1) {
          throw new SegmentProtocolError('服务器返回的数据比请求的字节范围长，已停止以免写出损坏的文件。');
        }
        await handle.writeAt(buffer, position);
        position += buffer.byteLength;
        count += buffer.byteLength;
        written.set(segment, count);
        lastTickBytes += buffer.byteLength;
        report();
      }
    } catch (error) {
      // The socket has to be released, otherwise the answer of the server
      // keeps the connection open.
      response.body.destroy();
      throw error;
    }
    if (count < segment.end - segment.start + 1) {
      // The connection ended before the segment was complete. The segment is
      // asked again from the byte it stopped at, so nothing is fetched twice.
      throw new ToolError('NETWORK_ERROR', '分段下载中断，将从断点继续。');
    }
  }
}
