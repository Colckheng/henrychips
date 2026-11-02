import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool } from '../../src/core/define-tool.js';
import { ToolRegistry } from '../../src/core/registry.js';

const tool = defineTool({
  name: 'test_echo', title: '回显', description: '测试工具', category: 'text', capabilities: [], fields: [], examples: [],
  inputSchema: z.strictObject({ text: z.string() }), outputSchema: z.strictObject({ length: z.number() }),
  execute: async ({ text }) => ({ length: text.length }),
});

test('rejects duplicate names and exposes serializable schemas', () => {
  assert.throws(() => new ToolRegistry([tool, tool]), /重复/);
  const registry = new ToolRegistry([tool]);
  const description = JSON.parse(JSON.stringify(registry.list()))[0];
  assert.equal(description.inputSchema.additionalProperties, false);
  assert.equal(description.inputSchema.properties.text.type, 'string');
  assert.equal(description.execute, undefined);
  assert.equal(registry.get('missing'), undefined);
});
