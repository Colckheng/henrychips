import { randomUUID } from 'node:crypto';
import type { RunSource, ToolResult, RunMeta } from '../contracts/run.js';
import type { ToolContext, PublicHttp, ProcessProbe } from '../contracts/tool.js';
import type { WorkstationConfig } from './config.js';
import { ToolRegistry } from './registry.js';
import { RunStore } from './run-store.js';
import { ToolError } from './errors.js';
import { createFileAccess, createFileWriter } from './file-access.js';
import { ProgressStore } from './progress.js';

export interface RunOptions {
  source: RunSource;
  signal?: AbortSignal;
  /** Lets a caller know the run identifier before the result is ready. */
  runId?: string;
}

export class ToolExecutor {
  private active = 0;
  readonly progress = new ProgressStore();
  constructor(
    readonly registry: ToolRegistry,
    private readonly config: WorkstationConfig,
    readonly store: RunStore,
    private readonly services: { http?: PublicHttp; probes?: ProcessProbe } = {},
  ) {}

  async run(name: string, input: unknown, options: RunOptions): Promise<ToolResult> {
    const start = performance.now();
    const runId = options.runId ?? randomUUID();
    const meta: RunMeta = { runId, tool: name, source: options.source, startedAt: new Date().toISOString(), durationMs: 0, warnings: [] };
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let occupied = false;
    let result: ToolResult;
    let started = false;
    try {
      if (this.active >= 4) throw new ToolError('BUSY', '当前有 4 个工具正在运行，请稍后重试。');
      this.active++; occupied = true;
      signal.throwIfAborted();
      const tool = this.registry.get(name);
      if (!tool) throw new ToolError('TOOL_NOT_FOUND', '找不到指定工具。');
      const declared = tool.timeoutMs;
      const timeoutMs = declared && declared > 0 ? Math.min(declared, 120_000) : this.config.limits.toolTimeoutMs;
      timer = setTimeout(() => timeout.abort(new ToolError('TIMEOUT', '执行超时，请缩小输入规模后重试。')), timeoutMs);
      if (tool.capabilities.includes('network:public') && !this.config.network.enabled) throw new ToolError('ACCESS_DENIED', '配置已关闭网络工具，请在配置文件中启用。');
      this.progress.start(runId, name, options.source);
      started = true;
      const context: ToolContext = {
        signal,
        limits: this.config.limits,
        stateDirectory: this.config.stateDirectory,
        reportProgress: update => { this.progress.update(runId, update); },
      };
      if (tool.capabilities.includes('files:read')) context.files = createFileAccess(this.config.workspaceRoot, signal);
      if (tool.capabilities.includes('files:write')) context.output = createFileWriter(this.config.outputDirectory, signal, this.config.limits.outputBytes);
      if (tool.capabilities.includes('network:public')) context.http = this.services.http;
      if (tool.capabilities.includes('process:probe')) context.probes = this.services.probes;
      const data = await tool.invoke(input, context);
      signal.throwIfAborted();
      result = { ok: true, data, meta };
    } catch (error) {
      const failure = signal.aborted
        ? timeout.signal.aborted && !options.signal?.aborted
          ? new ToolError('TIMEOUT', '执行超时，请缩小输入规模后重试。')
          : new ToolError('CANCELLED', '本次执行已取消。')
        : error instanceof ToolError ? error : new ToolError('TOOL_FAILED', '工具执行失败，请检查输入后重试。');
      result = { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) }, meta };
    } finally {
      if (timer) clearTimeout(timer);
      if (occupied) this.active--;
      meta.durationMs = Math.round((performance.now() - start) * 100) / 100;
    }
    if (started) this.progress.finish(runId, result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed', result.ok ? '已完成' : '失败');
    try {
      await this.store.append({ runId: meta.runId, tool: name, source: options.source, status: result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed', startedAt: meta.startedAt, durationMs: meta.durationMs, errorCode: result.ok ? null : result.error.code });
    } catch {
      meta.warnings.push('本次运行记录未保存。');
      process.stderr.write(`[workstation] run ${meta.runId}: summary write failed\n`);
    }
    return result;
  }
}
