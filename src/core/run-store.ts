import { mkdir, writeFile, rename, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunSummary, RunList } from '../contracts/run.js';

const summarySchema = z.strictObject({
  runId: z.uuid(), tool: z.string(), source: z.enum(['web', 'cli', 'mcp']),
  status: z.enum(['succeeded', 'failed', 'cancelled']), startedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  errorCode: z.enum(['TOOL_NOT_FOUND', 'INVALID_INPUT', 'ACCESS_DENIED', 'FILE_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'LIMIT_EXCEEDED', 'BUSY', 'NETWORK_ERROR', 'TIMEOUT', 'CANCELLED', 'TOOL_FAILED']).nullable(),
});
export class RunStore {
  private readonly directory: string;
  constructor(stateDirectory: string) { this.directory = path.join(stateDirectory, 'runs'); }
  async append(summary: RunSummary): Promise<void> {
    const safe = summarySchema.parse(summary);
    await mkdir(this.directory, { recursive: true });
    const destination = path.join(this.directory, `${safe.runId}.json`);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, JSON.stringify(safe), { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  }
  async list(limit: number): Promise<RunList> {
    let filenames: string[];
    try { filenames = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], warnings: [] }; throw error; }
    const runs: RunSummary[] = [];
    let corrupt = 0;
    for (const filename of filenames) {
      if (!filename.endsWith('.json')) continue;
      try { runs.push(summarySchema.parse(JSON.parse(await readFile(path.join(this.directory, filename), 'utf8')))); }
      catch { corrupt++; }
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId));
    return { runs: runs.slice(0, limit), warnings: corrupt ? [`已跳过 ${corrupt} 条无法读取的运行记录。`] : [] };
  }
}
