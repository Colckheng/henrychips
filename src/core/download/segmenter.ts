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

/**
 * The size the server really has.
 *
 * The size the platform announces can differ from the number of bytes the
 * file has: a share of a rar archive announced 2,097,152 bytes served
 * 2,068,480. A segment that reaches past the end of the file is answered
 * with the whole file instead of the range, which would write the bytes to
 * the wrong offsets. So the real size is asked for before the file is split.
 */
async function probeRealSize(link: NetdiskLink, http: PublicHttp, signal: AbortSignal): Promise<number | null> {
  const response = await http.getRaw(link.url, signal, {
    headers: { ...link.headers, Range: 'bytes=0-0' },
    maxBytes: 1024,
    allowErrorStatus: true,
  });
  if (response.status !== 206) return null;
  const range = response.headers['content-range'];
  const total = range ? Number(/\/(\d+)\s*$/.exec(range)?.[1] ?? Number.NaN) : Number.NaN;
  return Number.isFinite(total) && total > 0 ? total : null;
}

export async function downloadSegmented(link: NetdiskLink, options: SegmenterOptions): Promise<SegmenterResult> {
  const announced = link.sizeBytes ?? 0;
  if (!announced) throw new ToolError('TOOL_FAILED', '无法确定文件大小，无法下载。');
  const useRange = link.rangeSupported !== false;
  // The announced size is only a guess, so the server is asked how many bytes
  // it really has before the file is split.
  const probed = useRange ? await probeRealSize(link, options.http, options.signal).catch(() => null) : null;
  // The announced size is only a guess until the file is actually read, so
  // the total may still shrink below this when the last segment ends early.
  let total = probed ?? announced;
  /** The length the file was preallocated to; anything past the real end is zero bytes. */
  const preallocated = total;
  // A server that cannot answer the question about its own size may still
  // serve ranges perfectly, so the download stays segmented with the
  // announced size and the last segment may end earlier than announced.
  const segmented = useRange;
  // Only a size that was asked for is exact. Without an answer the announced
  // size is a guess, and the file may end before it.
  const sizeIsExact = probed !== null;
  const connections = Math.max(1, options.connections ?? 8);
  // The table that is passed in is continued, so the segments that are already
  // done are never fetched again. The table is filled in place, so a caller
  // that never sees the result still knows which segments are done.
  const table: SegmentTable = options.segments && options.segments.size === total
    ? options.segments
    : { size: total, segments: splitSegments(total, segmented ? connections : 1) };
  // A link without resuming is fetched in one piece, so the table holds one
  // segment that covers the whole file. A table that already holds finished
  // bytes cannot be continued by such a link, so the download is refused
  // instead of producing a file with holes in it.
  if (!segmented) {
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
  /** The reason of the first segment that failed, before the others were stopped. */
  let firstFailure: unknown;
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
    //
    // The segment that failed first carries the real reason. The segments
    // that were stopped afterwards only report the cancellation, so they must
    // not be allowed to mask it.
    const outcomes = await Promise.allSettled(table.segments.map(segment => runSegment(segment)));
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) throw firstFailure ?? failure.reason;
    // The bytes that really arrived are the lengths of the segments, not the
    // size the platform announced. When the last segment ended early the
    // file was preallocated to the announced size, so the zero bytes past
    // the real end are cut off here — otherwise the file on disk would be
    // longer than the download that produced it.
    const actualTotal = bytesWritten();
    if (actualTotal < preallocated) await handle.truncate(actualTotal);
    report(true);
    return { bytesWritten: actualTotal, totalBytes: actualTotal, rangeSupported: segmented, table };
  } finally {
    await handle.close();
  }

  async function runSegment(segment: Segment): Promise<void> {
    if (segment.done) return;
    try {
      await fetchSegment(segment);
    } catch (error) {
      // The first failure is the real reason, the ones after it are only the
      // effect of the stop.
      if (!firstFailure) firstFailure = error;
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
        if (!segmented) throw error;
        if (attempt >= SEGMENT_ATTEMPTS) throw error;
      }
      if ((written.get(segment) ?? 0) >= segment.end - segment.start + 1) break;
    }
    segment.done = true;
    await options.onSegmentComplete?.(table);
  }

  async function readSegment(segment: Segment, from: number, to: number): Promise<void> {
    const headers = segmented ? { ...link.headers, Range: `bytes=${from}-${to}` } : { ...link.headers };
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
    if (segmented && response.status !== 206) {
      // A server that answers with the whole file instead of the requested
      // range would write the file to the wrong offsets, so the download stops
      // here rather than producing a damaged file.
      response.body.destroy();
      throw new SegmentProtocolError('该直链不支持分段下载（服务器未返回 206），已停止以免写出损坏的文件。');
    }
    if (!segmented && response.status !== 200) {
      response.body.destroy();
      throw new SegmentProtocolError(`下载失败（HTTP ${response.status}）。`);
    }
    // The range of the answer has to be the range that was asked for,
    // otherwise the bytes land on the wrong offsets.
    const contentRange = response.headers?.['content-range'];
    const rangeStart = contentRange ? Number(/bytes=(\d+)-/i.exec(contentRange)?.[1] ?? Number.NaN) : Number.NaN;
    if (segmented && Number.isFinite(rangeStart) && rangeStart !== from) {
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
      // A broken connection is a fault of the network, not of the segment,
      // so the segment is asked again from the byte it stopped at.
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '连接中断，将从断点继续。');
    }
    if (count < segment.end - segment.start + 1) {
      // The last segment may be shorter than the platform announced, when the
      // real size could not be asked for. Then the end of the file is where
      // the download ends, and the segment is complete.
      const isLast = segment === table.segments[table.segments.length - 1];
      if (isLast && !sizeIsExact && count > 0) {
        segment.end = segment.start + count - 1;
        segment.done = true;
        // The file really ends here, so the announced size is wrong from
        // this point on: the table, the progress total and the result all
        // use the real length, not the announced one.
        table.size = segment.end + 1;
        total = table.size;
        await options.onSegmentComplete?.(table);
        return;
      }
      // The connection ended before the segment was complete. The segment is
      // asked again from the byte it stopped at, so nothing is fetched twice.
      throw new ToolError('NETWORK_ERROR', '分段下载中断，将从断点继续。');
    }
  }
}
