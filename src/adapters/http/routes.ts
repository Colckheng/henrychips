import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRoot, type WorkstationConfig } from '../../core/config.js';
import type { Runtime } from '../../core/runtime.js';
import type { ErrorCode } from '../../contracts/run.js';
import type { IntegrationInfo } from '../../contracts/tool.js';
import { openDirectory } from '../../core/opener.js';

function ownerTokenOf(request: { headers: Record<string, unknown> }): string | undefined {
  const header = request.headers['x-run-token'];
  return typeof header === 'string' ? header : undefined;
}

const statuses: Record<ErrorCode, number> = { TOOL_NOT_FOUND: 404, INVALID_INPUT: 400, ACCESS_DENIED: 403, FILE_NOT_FOUND: 404, UNSUPPORTED_FORMAT: 422, LIMIT_EXCEEDED: 413, BUSY: 429, NETWORK_ERROR: 502, TIMEOUT: 504, CANCELLED: 408, TOOL_FAILED: 500 };
export function registerRoutes(app: FastifyInstance, config: WorkstationConfig, runtime: Runtime) {
  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));
  app.get('/api/tools', async () => runtime.registry.list());
  app.get<{ Params: { name: string } }>('/api/tools/:name', async (request, reply) => {
    const tool = runtime.registry.list().find(t => t.name === request.params.name);
    if (!tool) return reply.code(404).send({ error: { code: 'TOOL_NOT_FOUND', message: '找不到指定工具。' } });
    return tool;
  });
  app.post<{ Params: { name: string } }>('/api/tools/:name/run', async (request, reply) => {
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply.code(415).send({ error: { code: 'INVALID_INPUT', message: '请求必须使用 application/json。' } });
    const parsed = z.strictObject({ input: z.unknown().refine(v => v !== undefined), requestId: z.string().uuid().optional(), ownerToken: z.string().min(8).max(128).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请求需要且仅允许 input 字段，可选 requestId 与 ownerToken。' } });
    // A closed browser tab no longer cancels the run: the work continues on the
    // server and the result stays available for the caller to pick up later.
    const result = await runtime.executor.run(request.params.name, parsed.data.input, { source: 'web', runId: parsed.data.requestId, ownerToken: parsed.data.ownerToken });
    if (reply.raw.destroyed) return reply;
    return reply.code(result.ok ? 200 : statuses[result.error.code]).send(result);
  });
  app.post('/api/output/open', async (_request, reply) => {
    const result = openDirectory(config.outputDirectory);
    if (!result.opened) return reply.code(500).send({ error: { code: 'TOOL_FAILED', message: result.reason ?? '无法打开输出目录。' } });
    return { opened: true };
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async (request) => {
    const cancelled = runtime.executor.cancelRun(request.params.runId, ownerTokenOf(request));
    return { cancelled };
  });
  app.get<{ Querystring: { tool?: string } }>('/api/runs/latest', async (request, reply) => {
    const tool = request.query.tool;
    if (!tool) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '需要指定 tool 参数。' } });
    const latest = runtime.executor.latestRun(tool);
    if (!latest) return { runId: null, at: null, status: 'none', progress: null, result: null };
    const progress = runtime.executor.progress.get(latest.runId);
    const result = runtime.executor.getResult(latest.runId, ownerTokenOf(request));
    return { runId: latest.runId, at: latest.at, status: progress?.status ?? (result ? (result.ok ? 'succeeded' : 'failed') : 'unknown'), progress, result, owned: runtime.executor.owns(latest.runId, ownerTokenOf(request)) };
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/result', async (request, reply) => {
    const result = runtime.executor.getResult(request.params.runId, ownerTokenOf(request));
    if (!result) return reply.code(404).send({ error: { code: 'TOOL_NOT_FOUND', message: '没有找到该运行的结果，可能从未开始或已过期。' } });
    return result;
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/progress', async (request, reply) => {
    const progress = runtime.executor.progress.get(request.params.runId);
    if (!progress) return reply.code(404).send({ error: { code: 'TOOL_NOT_FOUND', message: '没有找到该运行的进度，可能已结束或从未开始。' } });
    return progress;
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', (request, reply) => {
    const progress = runtime.executor.progress.get(request.params.runId);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (value: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(value)}\n\n`); };
    // Always send a first frame so clients never wait for the run to start.
    if (progress && progress.status !== 'running') { send(progress); reply.raw.end(); return reply; }
    send(progress ?? {
      runId: request.params.runId,
      tool: '',
      source: 'web',
      status: 'running',
      phase: '等待任务开始',
      percent: null,
      steps: [],
      updatedAt: new Date().toISOString(),
    });
    const unsubscribe = runtime.executor.progress.subscribe(request.params.runId, value => {
      send(value);
      // Close the stream once the run is over so clients do not abort it.
      if (value.status !== 'running') close();
    });
    const heartbeat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n'); }, 15_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    reply.raw.once('close', close);
    return reply;
  });
  app.get('/api/runs', async (request, reply) => {
    const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'limit 应为 1 到 100 的整数。' } });
    return runtime.store.list(query.data.limit);
  });
  app.get('/api/integrations', async (): Promise<IntegrationInfo> => {
    const mcpEntry = path.join(projectRoot, 'dist/server/adapters/mcp/main.js');
    const cliEntry = path.join(projectRoot, 'dist/server/adapters/cli/main.js');
    const normalize = (value: string) => value.replaceAll('\\', '/');
    return {
      configPath: normalize(config.configPath), workspaceRoot: normalize(config.workspaceRoot), networkEnabled: config.network.enabled,
      mcp: { configured: false, buildReady: existsSync(mcpEntry), config: { mcpServers: { 'personal-workstation': { command: process.execPath, args: [normalize(mcpEntry), '--config', normalize(config.configPath)] } } } },
      cli: [`node "${normalize(cliEntry)}" list --json`, `node "${normalize(cliEntry)}" run text_stats --input-file "${normalize(path.join(config.workspaceRoot, 'samples/text-input.json'))}" --config "${normalize(config.configPath)}"`],
    };
  });
}
