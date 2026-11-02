import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { loadConfig } from '../../src/core/config.js';
import { defineTool } from '../../src/core/define-tool.js';
import { ToolRegistry } from '../../src/core/registry.js';
import { ToolExecutor } from '../../src/core/executor.js';
import { RunStore } from '../../src/core/run-store.js';

test('invalid outputs cannot masquerade as successful results and disabled networking does not run', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-boundary-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const metadata = { title: '测试', description: '测试', category: 'text' as const, fields: [], examples: [], inputSchema: z.strictObject({}), outputSchema: z.strictObject({ count: z.number().nonnegative() }) };
  const invalid = defineTool({ ...metadata, name: 'invalid_result', capabilities: [], execute: async () => ({ count: -1 }) });
  let called = false;
  const network = defineTool({ ...metadata, name: 'disabled_network', capabilities: ['network:public'], execute: async () => { called = true; return { count: 1 }; } });
  const config = { ...await loadConfig(), stateDirectory: state, network: { enabled: false } };
  const executor = new ToolExecutor(new ToolRegistry([invalid, network]), config, new RunStore(state));
  const bad = await executor.run('invalid_result', {}, { source: 'cli' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'TOOL_FAILED');
  const denied = await executor.run('disabled_network', {}, { source: 'mcp' });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'ACCESS_DENIED');
  assert.equal(called, false);
});

test('cold history load skips corrupt records and reports warnings', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-corrupt-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const folder = path.join(state, 'runs');
  await mkdir(folder);
  await writeFile(path.join(folder, 'broken.json'), '{');
  const result = await new RunStore(state).list(50);
  assert.deepEqual(result.runs, []);
  assert.equal(result.warnings.length, 1);
});
