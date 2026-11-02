import { z } from 'zod';
import type { ToolContext, ToolDescription } from '../contracts/tool.js';
import { ToolError } from './errors.js';

type Metadata = Omit<ToolDescription, 'inputSchema' | 'outputSchema'>;
export interface RegisteredTool extends Metadata {
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  invoke(input: unknown, context: ToolContext): Promise<Record<string, unknown>>;
}

export function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(definition: Metadata & {
  inputSchema: z.ZodObject<I>;
  outputSchema: z.ZodObject<O>;
  execute(input: z.output<z.ZodObject<I>>, context: ToolContext): Promise<z.output<z.ZodObject<O>>>;
}) {
  return {
    ...definition,
    async invoke(input: unknown, context: ToolContext): Promise<Record<string, unknown>> {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolError('INVALID_INPUT', '参数不符合要求，请检查输入。', parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })));
      }
      const output = await definition.execute(parsed.data, context);
      const validated = definition.outputSchema.safeParse(output);
      if (!validated.success) throw new ToolError('TOOL_FAILED', '工具返回了不符合约定的结果。');
      return validated.data;
    },
  };
}
