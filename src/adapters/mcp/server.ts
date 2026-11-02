import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Runtime } from '../../core/runtime.js';

export function createMcpServer(runtime: Runtime) {
  const server = new McpServer({ name: 'personal-workstation', version: '0.1.0' });
  const meta = z.strictObject({ runId: z.string(), tool: z.string(), source: z.enum(['web', 'cli', 'mcp']), startedAt: z.string(), durationMs: z.number(), warnings: z.array(z.string()) });
  const error = z.strictObject({ code: z.string(), message: z.string(), details: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional() });
  for (const tool of runtime.registry.values()) {
    const outputSchema = z.strictObject({ ok: z.boolean(), data: tool.outputSchema.optional(), error: error.optional(), meta }).refine(
      value => value.ok ? value.data !== undefined && value.error === undefined : value.error !== undefined && value.data === undefined,
      '成功结果必须包含 data，失败结果必须包含 error。',
    );
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: tool.capabilities.includes('network:public') },
    }, async (args, extra) => {
      const result = await runtime.executor.run(tool.name, args, { source: 'mcp', signal: extra.signal });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: !result.ok };
    });
  }
  return server;
}
