import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool } from '../../src/core/define-tool.js';
import { ToolRegistry } from '../../src/core/registry.js';
import { ToolExecutor } from '../../src/core/executor.js';
import { RunStore } from '../../src/core/run-store.js';
import { loadConfig } from '../../src/core/config.js';

const echo = defineTool({
  name: 'test_echo', title: '回显', description: '测试', category: 'text', capabilities: [], fields: [], examples: [],
  inputSchema: z.strictObject({ text: z.string() }), outputSchema: z.strictObject({ text: z.string() }),
  execute: async ({ text }) => ({ text }),
});
const slow = defineTool({
  name: 'test_wait', title: '等待', description: '测试', category: 'text', capabilities: [], fields: [], examples: [],
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({ done: z.boolean() }),
  execute: async (_, ctx) => { await delay(1000, undefined, { signal: ctx.signal }); return { done: true }; },
});
async function setup(t: { after(fn: () => Promise<void>): void }, timeout = 1000) {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-runs-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const config = await loadConfig();
  const store = new RunStore(state);
  const executor = new ToolExecutor(new ToolRegistry([echo, slow]), { ...config, stateDirectory: state, limits: { ...config.limits, toolTimeoutMs: timeout } }, store);
  return { state, store, executor };
}

test('validates input, preserves result and stores summaries without content', async t => {
  const { state, store, executor } = await setup(t);
  const result = await executor.run('test_echo', { text: 'private text' }, { source: 'cli' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.text, 'private text');
  const invalid = await executor.run('test_echo', { text: 'a', extra: true }, { source: 'mcp' });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_INPUT');
  const missing = await executor.run('missing', {}, { source: 'web' });
  if (!missing.ok) assert.equal(missing.error.code, 'TOOL_NOT_FOUND'); else assert.fail();
  assert.equal((await store.list(50)).runs.length, 3);
  for (const file of await readdir(path.join(state, 'runs'))) assert.doesNotMatch(await readFile(path.join(state, 'runs', file), 'utf8'), /private text/);
});

test('cooperatively cancels and times out actual tool work', async t => {
  const { executor } = await setup(t, 30);
  const result = await executor.run('test_wait', {}, { source: 'cli' });
  if (!result.ok) assert.equal(result.error.code, 'TIMEOUT'); else assert.fail();
  const controller = new AbortController();
  const pending = executor.run('test_wait', {}, { source: 'web', signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  if (!cancelled.ok) assert.equal(cancelled.error.code, 'CANCELLED'); else assert.fail();
});

test('rejects the fifth concurrent run and saves simultaneous summaries', async t => {
  const { executor, store } = await setup(t);
  const controller = new AbortController();
  const pending = Array.from({ length: 4 }, () => executor.run('test_wait', {}, { source: 'mcp', signal: controller.signal }));
  const busy = await executor.run('test_echo', { text: 'hello' }, { source: 'mcp' });
  if (!busy.ok) assert.equal(busy.error.code, 'BUSY'); else assert.fail();
  controller.abort();
  await Promise.all(pending);
  assert.equal((await store.list(50)).runs.length, 5);
});

test('a recording failure warns without reversing a successful tool', async t => {
  const { state } = await setup(t);
  const config = await loadConfig();
  const file = path.join(state, 'not-directory');
  await writeFile(file, 'occupied');
  const executor = new ToolExecutor(new ToolRegistry([echo]), config, new RunStore(file));
  const result = await executor.run('test_echo', { text: 'hi' }, { source: 'cli' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.meta.warnings, ['本次运行记录未保存。']);
});

test('the run summary is stored before the terminal progress frame is delivered', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-runs-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const config = await loadConfig();
  const runId = '11111111-2222-4333-8444-555555555555';
  const order: string[] = [];
  const store = new RunStore(state);
  const originalAppend = store.append.bind(store);
  store.append = async summary => { order.push('append'); return originalAppend(summary); };
  const executor = new ToolExecutor(new ToolRegistry([echo]), { ...config, stateDirectory: state }, store);
  executor.progress.subscribe(runId, progress => {
    if (progress.status === 'succeeded') order.push('finish');
  });
  await executor.run('test_echo', { text: 'ordered' }, { source: 'web', runId });
  assert.deepEqual(order, ['append', 'finish']);
});
