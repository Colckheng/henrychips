import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRoot, type WorkstationConfig } from '../../core/config.js';
import type { Runtime } from '../../core/runtime.js';
import type { ErrorCode } from '../../contracts/run.js';
import type { IntegrationInfo } from '../../contracts/tool.js';
import { openDirectory } from '../../core/opener.js';

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
    const parsed = z.strictObject({ input: z.unknown().refine(v => v !== undefined), requestId: z.string().uuid().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请求需要且仅允许 input 字段，可选 requestId。' } });
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', onClose);
    try {
      const result = await runtime.executor.run(request.params.name, parsed.data.input, { source: 'web', signal: controller.signal, runId: parsed.data.requestId });
      if (reply.raw.destroyed) return reply;
      return reply.code(result.ok ? 200 : statuses[result.error.code]).send(result);
    } finally { reply.raw.removeListener('close', onClose); }
  });
  app.post('/api/output/open', async (_request, reply) => {
    const result = openDirectory(config.outputDirectory);
    if (!result.opened) return reply.code(500).send({ error: { code: 'TOOL_FAILED', message: result.reason ?? '无法打开输出目录。' } });
    return { opened: true, directory: config.outputDirectory };
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
