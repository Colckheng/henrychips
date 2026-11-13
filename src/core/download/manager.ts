import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../errors.js';
import { createFileWriter } from '../file-access.js';
import type { FileWriter, PublicHttp } from '../../contracts/tool.js';
import type { NetdiskLink, NetdiskPlatform, NetdiskSource } from '../../tools/netdisk/types.js';
import { downloadSegmented, LinkExpiredError } from './segmenter.js';
import { readSegmentTable, splitSegments, writeSegmentTable, type SegmentTable } from './segment-table.js';
import { TaskStore, type DownloadTask, type TaskStatus } from './task-store.js';

export interface DownloadManagerOptions {
  http: PublicHttp;
  stateDirectory: string;
  outputDirectory: string;
  outputBytesLimit: number;
  /** How many download tasks run at the same time. Defaults to 3. */
  concurrency?: number;
  /** How many connections a task uses. Defaults to 8. */
  connections?: number;
  /** Fetches a new direct link when the old one expired. The runtime injects it. */
  refreshLink?: (task: DownloadTask) => Promise<NetdiskLink>;
}

export interface CreateTaskInput {
  platform: NetdiskPlatform;
  title: string;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  backend: 'builtin' | 'ndm';
  source: NetdiskSource;
  outputPath: string;
  link: NetdiskLink;
}

/** How often a new link is fetched when the old one expired. */
const REFRESH_ATTEMPTS = 3;

/**
 * The queue of the download tasks. The queue lives outside the tool
 * executor, because a download takes far longer than one run of a tool and
 * must not be bound by the concurrency of the tools.
 */
export class DownloadManager {
  private readonly store: TaskStore;
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<(tasks: DownloadTask[]) => void>();
  private readonly queue: DownloadTask[] = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly connections: number;
  /**
   * The number of the run of every task. A run that was replaced by a newer
   * one may not write the state of the task, because the newer run owns it.
   */
  private readonly generations = new Map<string, number>();

  constructor(private readonly options: DownloadManagerOptions) {
    this.store = new TaskStore(options.stateDirectory);
    this.concurrency = options.concurrency ?? 3;
    this.connections = options.connections ?? 8;
    // A task that was running when the process ended cannot be running
    // anymore, so it waits for the user to continue it.
    for (const task of this.store.list()) {
      if (task.status === 'downloading' || task.status === 'preparing' || task.status === 'verifying') {
        this.update(task.id, { status: 'paused', error: { code: 'TOOL_FAILED', message: '上次运行结束时任务仍在下载，已暂停，等待继续。' } });
      }
    }
  }

  list(): DownloadTask[] { return this.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): DownloadTask | undefined { return this.store.get(id); }

  subscribe(listener: (tasks: DownloadTask[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    const tasks = this.list();
    for (const listener of this.listeners) {
      try { listener(tasks); } catch { /* a broken listener must not break a download */ }
    }
  }

  private update(id: string, patch: Partial<DownloadTask>): DownloadTask | undefined {
    const current = this.store.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.store.save(next);
    this.emit();
    return next;
  }

  create(input: CreateTaskInput): DownloadTask {
    const task: DownloadTask = {
      id: randomUUID(),
      platform: input.platform,
      title: input.title,
      fileName: input.fileName,
      filePath: input.filePath,
      sizeBytes: input.sizeBytes,
      status: 'queued',
      backend: input.backend,
      bytesWritten: 0,
      totalBytes: input.sizeBytes,
      speedBytesPerSecond: null,
      rangeSupported: input.link.rangeSupported ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: input.source,
      outputPath: this.uniqueOutputPath(input.outputPath),
      // The link is kept in the task, because a link that expired has to be
      // replaced by a new one later on.
      link: input.link,
    };
    this.store.save(task);
    this.queue.push(task);
    this.emit();
    this.pump();
    return task;
  }

  /** The same file name is downloaded again, so a number is added to avoid overwriting the last result silently. */
  private uniqueOutputPath(base: string): string {
    const taken = new Set(this.store.list().map(task => task.outputPath));
    if (!taken.has(base)) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    for (let index = 1; index < 1000; index++) {
      const candidate = `${stem}-${index}${extension}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  pause(id: string): boolean {
    const task = this.store.get(id);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false;
    // The run that is in flight loses the ownership of the task, so its own
    // end cannot overwrite the state that the pause writes.
    this.generations.set(id, this.generationOf(id) + 1);
    this.controllers.get(id)?.abort();
    this.update(id, { status: 'paused' });
    return true;
  }

  resume(id: string): boolean {
    const task = this.store.get(id);
    if (!task) return false;
    if (task.status !== 'paused' && task.status !== 'failed') return false;
    this.update(id, { status: 'queued', error: undefined });
    this.queue.push(task);
    this.pump();
    return true;
  }

  remove(id: string): boolean {
    this.generations.set(id, this.generationOf(id) + 1);
    this.controllers.get(id)?.abort();
    const removed = this.store.remove(id);
    this.emit();
    return removed;
  }

  private generationOf(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const index = this.queue.findIndex(task => this.store.get(task.id)?.status === 'queued' && !this.controllers.has(task.id));
      // A task whose run is still in flight stays in the queue. The run that
      // is in flight pumps the queue again when it ends.
      if (index < 0) return;
      const [task] = this.queue.splice(index, 1);
      if (!task) return;
      this.running++;
      void this.run(task).finally(() => { this.running--; this.pump(); });
    }
  }

  private async run(task: DownloadTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const generation = this.generationOf(task.id) + 1;
    this.generations.set(task.id, generation);
    // The state of the task is only written while this run owns it, so a run
    // that was replaced cannot overwrite the state of the newer one.
    const apply = (patch: Partial<DownloadTask>) => {
      if (this.generationOf(task.id) !== generation) return undefined;
      return this.update(task.id, patch);
    };
    apply({ status: 'preparing', startedAt: new Date().toISOString() });
    try {
      await mkdir(this.options.outputDirectory, { recursive: true });
      const writer: FileWriter = createFileWriter(this.options.outputDirectory, controller.signal, this.options.outputBytesLimit);
      let link = this.storedLink(task);
      const { table, continued } = await this.loadSegments(task, link.sizeBytes ?? task.sizeBytes ?? 0);
      // A link without resuming cannot continue the bytes that are already
      // on the disk, so the task is failed with that reason instead of
      // starting again from zero without saying so.
      if (continued && link.rangeSupported === false) {
        throw new ToolError('TOOL_FAILED', '该直链不支持断点续传，无法接着已下载的字节继续，请重新开始下载。');
      }
      let result: Awaited<ReturnType<typeof downloadSegmented>> | undefined;
      for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
        try {
          result = await downloadSegmented(link, {
            http: this.options.http,
            writer,
            signal: controller.signal,
            connections: this.connections,
            outputPath: task.outputPath,
            segments: table,
            onProgress: update => {
              apply({
                status: 'downloading',
                bytesWritten: update.bytesWritten,
                totalBytes: update.totalBytes,
                speedBytesPerSecond: Math.round(update.speedBytesPerSecond),
              });
            },
            onSegmentComplete: async updated => { await writeSegmentTable(this.segmentFile(task.id), updated); },
          });
          break;
        } catch (error) {
          if (!(error instanceof LinkExpiredError) || attempt === REFRESH_ATTEMPTS) throw error;
          // The link expired: a new one is fetched and the download continues
          // from the bytes that are already on the disk.
          const refreshed = await this.options.refreshLink?.(this.store.get(task.id) ?? task);
          if (!refreshed) throw error;
          link = refreshed;
          apply({ link: refreshed, rangeSupported: refreshed.rangeSupported ?? null });
        }
      }
      if (!result) throw new ToolError('TOOL_FAILED', '下载未产生结果。');
      apply({
        status: 'completed',
        bytesWritten: result.bytesWritten,
        totalBytes: result.totalBytes,
        rangeSupported: result.rangeSupported,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      // A run that was replaced by a newer one must not write the state of the
      // task, because the newer run owns it now.
      if (this.generationOf(task.id) !== generation) return;
      if (controller.signal.aborted) {
        this.update(task.id, { status: 'paused' });
      } else {
        const failure = error instanceof ToolError ? error : new ToolError('TOOL_FAILED', '下载失败。');
        this.update(task.id, { status: 'failed', error: { code: failure.code, message: failure.message }, finishedAt: new Date().toISOString() });
      }
    } finally {
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id);
    }
  }

  private segmentFile(id: string): string {
    return path.join(this.store.directory(id), 'segments.json');
  }

  private storedLink(task: DownloadTask): NetdiskLink {
    return this.store.get(task.id)?.link ?? task.link;
  }

  /**
   * The table of the segments of the task. The table on the disk is the
   * breakpoint of the download, so a run that starts after a restart of the
   * process continues where the last one stopped.
   */
  private async loadSegments(task: DownloadTask, size: number): Promise<{ table: SegmentTable; continued: boolean }> {
    const existing = await readSegmentTable(this.segmentFile(task.id));
    if (existing && existing.size === size) {
      return { table: existing, continued: existing.segments.some(segment => segment.done) };
    }
    const table: SegmentTable = { size, segments: splitSegments(size, this.connections) };
    await writeSegmentTable(this.segmentFile(task.id), table);
    return { table, continued: false };
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

export type { DownloadTask, TaskStatus };
