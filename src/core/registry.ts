import { z } from 'zod';
import type { ToolDescription } from '../contracts/tool.js';
import type { RegisteredTool } from './define-tool.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  constructor(tools: RegisteredTool[]) {
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`工具名称无效：${tool.name}`);
      if (this.tools.has(tool.name)) throw new Error(`工具名称重复：${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }
  get(name: string) { return this.tools.get(name); }
  values() { return [...this.tools.values()]; }
  list(): ToolDescription[] {
    return this.values().map(tool => ({
      name: tool.name, title: tool.title, description: tool.description, category: tool.category,
      capabilities: tool.capabilities, fields: tool.fields, examples: tool.examples,
      timeoutMs: tool.timeoutMs,
      inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }),
      outputSchema: z.toJSONSchema(tool.outputSchema),
    }));
  }
}
