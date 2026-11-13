import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetdiskLink, NetdiskPlatform, NetdiskSource } from '../../tools/netdisk/types.js';

export type TaskStatus = 'queued' | 'preparing' | 'downloading' | 'verifying' | 'completed' | 'paused' | 'failed' | 'cancelled' | 'handed_off';

export interface DownloadTask {
  id: string;
  platform: NetdiskPlatform;
  title: string;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  status: TaskStatus;
  backend: 'builtin' | 'ndm';
  bytesWritten: number;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  rangeSupported: boolean | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  source: NetdiskSource;
  outputPath: string;
  /** The direct link in use; a new one replaces it after it expired. */
  link: NetdiskLink;
}

/**
 * The table of the download tasks. The tasks survive a restart of the
 * workstation, because a download can take longer than one run of the
 * process.
 *
 * The index is written through a temporary file: a write that is cut in half
 * must not destroy the whole table.
 */
export class TaskStore {
  private readonly indexFile: string;
  constructor(private readonly stateDirectory: string) {
    const directory = path.join(stateDirectory, 'downloads');
    mkdirSync(directory, { recursive: true });
    this.indexFile = path.join(directory, 'tasks.json');
  }

  directory(id: string): string {
    return path.join(this.stateDirectory, 'downloads', id);
  }

  list(): DownloadTask[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as DownloadTask[];
    } catch { return []; }
  }

  get(id: string): DownloadTask | undefined {
    return this.list().find(task => task.id === id);
  }

  save(task: DownloadTask): void {
    const tasks = this.list().filter(item => item.id !== task.id);
    tasks.push(task);
    this.writeIndex(tasks);
    const directory = this.directory(task.id);
    mkdirSync(directory, { recursive: true });
    this.writeFile(path.join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  }

  remove(id: string): boolean {
    const tasks = this.list();
    const remaining = tasks.filter(task => task.id !== id);
    if (remaining.length === tasks.length) return false;
    this.writeIndex(remaining);
    rmSync(this.directory(id), { recursive: true, force: true });
    return true;
  }

  private writeIndex(tasks: DownloadTask[]): void {
    this.writeFile(this.indexFile, `${JSON.stringify(tasks, null, 2)}\n`);
  }

  /**
   * Writes a file of the store through a temporary file: a write that is cut
   * in half must not destroy the table of the tasks.
   */
  private writeFile(file: string, content: string): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
