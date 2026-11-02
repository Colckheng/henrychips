import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';

export const envInspectTool = defineTool({
  name: 'env_inspect', title: '开发环境检查', description: '查看系统平台、架构及 Node.js、Git 版本。',
  category: 'developer', capabilities: ['process:probe'], fields: [],
  examples: [{ label: '检查本机环境', input: {} }],
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({
    platform: z.string(), architecture: z.string(),
    node: z.strictObject({ available: z.literal(true), version: z.string() }),
    git: z.strictObject({ available: z.boolean(), version: z.string().nullable() }),
  }),
  async execute(_input, ctx) {
    if (ctx.signal.aborted) throw new ToolError('CANCELLED', '环境检查已取消。');
    if (!ctx.probes) throw new ToolError('ACCESS_DENIED', '未启用环境检查。');
    return ctx.probes.inspect(ctx.signal);
  },
});
