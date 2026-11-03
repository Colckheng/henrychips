import { mkdir, writeFile, rename, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunSummary, RunList } from '../contracts/run.js';

const summarySchema = z.strictObject({
  runId: z.uuid(), tool: z.string(), source: z.enum(['web', 'cli', 'mcp']),
  status: z.enum(['succeeded', 'failed', 'cancelled']), startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  errorCode: z.enum(['TOOL_NOT_FOUND', 'INVALID_INPUT', 'ACCESS_DENIED', 'FILE_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'LIMIT_EXCEEDED', 'BUSY', 'NETWORK_ERROR', 'TIMEOUT', 'CANCELLED', 'TOOL_FAILED']).nullable(),
});

interface CachedSummary {
  summary: RunSummary;
  /** File size and modification time, used to detect changes without reading. */
  size: number;
  modifiedAt: number;
}

/** Modification times carry sub-millisecond noise on some file systems. */
function sameMoment(left: number, right: number): boolean {
  return Math.abs(left - right) < 1;
}

/**
 * Stores one summary per run. The listing keeps a cache keyed by file size and
 * modification time, so showing the history does not re-read every file that
 * was ever written.
 */
export class RunStore {
  private readonly directory: string;
  private readonly cache = new Map<string, CachedSummary>();

  constructor(stateDirectory: string) { this.directory = path.join(stateDirectory, 'runs'); }

  async append(summary: RunSummary): Promise<void> {
    const safe = summarySchema.parse(summary);
    await mkdir(this.directory, { recursive: true });
    const filename = `${safe.runId}.json`;
    const destination = path.join(this.directory, filename);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, JSON.stringify(safe), { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    const info = await stat(destination);
    this.cache.set(filename, { summary: safe, size: info.size, modifiedAt: info.mtimeMs });
  }

  async list(limit: number): Promise<RunList> {
    let filenames: string[];
    try { filenames = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], warnings: [] }; throw error; }
    const jsonFiles = filenames.filter(filename => filename.endsWith('.json'));
    // The sizes and timestamps are read together: one call per file would
    // dominate the response time once the history grows.
    const infos = await Promise.all(jsonFiles.map(filename => stat(path.join(this.directory, filename)).catch(() => undefined)));
    const runs: RunSummary[] = [];
    let corrupt = 0;
    const seen = new Set<string>();
    for (const [index, filename] of jsonFiles.entries()) {
      const info = infos[index];
      if (!info) { corrupt++; continue; }
      const cached = this.cache.get(filename);
      // Reuse the parsed summary while the file on disk is unchanged.
      if (cached && cached.size === info.size && sameMoment(cached.modifiedAt, info.mtimeMs)) {
        runs.push(cached.summary);
        seen.add(filename);
        continue;
      }
      try {
        const summary = summarySchema.parse(JSON.parse(await readFile(path.join(this.directory, filename), 'utf8')));
        this.cache.set(filename, { summary, size: info.size, modifiedAt: info.mtimeMs });
        seen.add(filename);
        runs.push(summary);
      } catch { corrupt++; }
    }
    for (const filename of this.cache.keys()) if (!seen.has(filename)) this.cache.delete(filename);
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId));
    return { runs: runs.slice(0, limit), warnings: corrupt ? [`已跳过 ${corrupt} 条无法读取的运行记录。`] : [] };
  }
}
