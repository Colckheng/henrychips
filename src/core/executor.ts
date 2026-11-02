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

interface StoredResult {
  result: ToolResult;
  at: number;
}

export class ToolExecutor {
  private active = 0;
  private readonly running = new Map<string, AbortController>();
  private readonly results = new Map<string, StoredResult>();
  private readonly latest = new Map<string, { runId: string; at: number }>();
  private readonly cancelledBeforeStart = new Set<string>();
  readonly progress = new ProgressStore();
  constructor(
    readonly registry: ToolRegistry,
    private readonly config: WorkstationConfig,
    readonly store: RunStore,
    private readonly services: { http?: PublicHttp; probes?: ProcessProbe } = {},
  ) {}

  /** Cancels a run that is still in flight. Used by the explicit cancel route. */
  cancelRun(runId: string): boolean {
    const controller = this.running.get(runId);
    if (!controller) {
      // The cancel may arrive before the run registers; remember it so the run
      // stops as soon as it starts.
      this.cancelledBeforeStart.add(runId);
      return false;
    }
    controller.abort();
    return true;
  }

  /** Returns a finished result so it can be shown again after the page closed. */
  getResult(runId: string): ToolResult | undefined {
    this.pruneResults();
    return this.results.get(runId)?.result;
  }

  /** The most recent run of a tool, so a reopened page can pick it up. */
  latestRun(tool: string): { runId: string; at: number } | undefined {
    this.pruneResults();
    return this.latest.get(tool);
  }

  private pruneResults(): void {
    const limit = Date.now() - 12 * 60 * 60 * 1000;
    for (const [runId, entry] of this.results) {
      if (entry.at < limit) this.results.delete(runId);
    }
    while (this.results.size > 50) {
      const oldest = [...this.results.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (!oldest) break;
      this.results.delete(oldest[0]);
    }
  }

  async run(name: string, input: unknown, options: RunOptions): Promise<ToolResult> {
    const start = performance.now();
    const runId = options.runId ?? randomUUID();
    const meta: RunMeta = { runId, tool: name, source: options.source, startedAt: new Date().toISOString(), durationMs: 0, warnings: [] };
    const timeout = new AbortController();
    const controller = new AbortController();
    // A caller signal (CLI interrupt, MCP cancel) still cancels the work. A
    // browser disconnect does not: the run keeps going and its result is kept.
    const signal = options.signal
      ? AbortSignal.any([timeout.signal, controller.signal, options.signal])
      : AbortSignal.any([timeout.signal, controller.signal]);
    this.running.set(runId, controller);
    this.latest.set(name, { runId, at: Date.now() });
    if (this.cancelledBeforeStart.delete(runId)) controller.abort();
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
        ? timeout.signal.aborted && !controller.signal.aborted && !options.signal?.aborted
          ? new ToolError('TIMEOUT', '执行超时，请缩小输入规模后重试。')
          : new ToolError('CANCELLED', '本次执行已取消。')
        : error instanceof ToolError ? error : new ToolError('TOOL_FAILED', '工具执行失败，请检查输入后重试。');
      result = { ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) }, meta };
    } finally {
      if (timer) clearTimeout(timer);
      if (occupied) this.active--;
      meta.durationMs = Math.round((performance.now() - start) * 100) / 100;
      this.running.delete(runId);
    }
    if (started) this.progress.finish(runId, result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed', result.ok ? '已完成' : '失败');
    // Keep a bounded copy of the result so a finished run can be shown again.
    const serialized = JSON.stringify(result).length;
    if (serialized <= 2_000_000) {
      this.results.set(runId, { result, at: Date.now() });
      this.pruneResults();
    }
    try {
      await this.store.append({ runId: meta.runId, tool: name, source: options.source, status: result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed', startedAt: meta.startedAt, durationMs: meta.durationMs, errorCode: result.ok ? null : result.error.code });
    } catch {
      meta.warnings.push('本次运行记录未保存。');
      process.stderr.write(`[workstation] run ${meta.runId}: summary write failed\n`);
    }
    return result;
  }
}
