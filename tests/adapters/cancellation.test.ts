import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { buildApp } from '../../src/adapters/http/app.js';
import { defineTool } from '../../src/core/define-tool.js';
import { ToolRegistry } from '../../src/core/registry.js';
import { ToolExecutor } from '../../src/core/executor.js';
import { RunStore } from '../../src/core/run-store.js';
import { loadConfig } from '../../src/core/config.js';

test('a disconnected client no longer stops the work, but an explicit cancel does', { timeout: 8000 }, async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-cancel-'));
  const config = { ...await loadConfig(), stateDirectory: state };
  const entered = Promise.withResolvers<void>();
  const tool = defineTool({
    name: 'wait_for_cancel', title: '等待取消', description: '测试', category: 'text', capabilities: [], fields: [], examples: [],
    inputSchema: z.strictObject({}), outputSchema: z.strictObject({ done: z.boolean() }),
    execute: async (_, ctx) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => { ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }); });
      return { done: true };
    },
  });
  const registry = new ToolRegistry([tool]);
  const store = new RunStore(state);
  const recorded = Promise.withResolvers<void>();
  const originalAppend = store.append.bind(store);
  store.append = async summary => { await originalAppend(summary); recorded.resolve(); };
  const executor = new ToolExecutor(registry, config, store);
  const app = await buildApp(config, { runtime: { registry, store, executor } });
  t.after(async () => { await app.close(); await rm(state, { recursive: true, force: true }); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const req = httpRequest(`${address}/api/tools/wait_for_cancel/run`, { method: 'POST', headers: { host: '127.0.0.1:4318', 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end('{"input":{},"requestId":"11111111-2222-4333-8444-555555555555"}');
  await entered.promise;
  req.destroy();
  await new Promise(resolve => setTimeout(resolve, 300));
  // The client is gone but the work continues on the server.
  assert.equal((await store.list(10)).runs.length, 0);

  const cancel = await app.inject({ method: 'POST', url: '/api/runs/11111111-2222-4333-8444-555555555555/cancel', headers: { host: '127.0.0.1:4318' } });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json().cancelled, true);
  await recorded.promise;
  const { runs } = await store.list(10);
  assert.equal(runs[0].status, 'cancelled');
  assert.equal(runs[0].errorCode, 'CANCELLED');
});
