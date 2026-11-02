import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defineTool } from '../../src/core/define-tool.js';
import { ToolRegistry } from '../../src/core/registry.js';
import { ToolExecutor } from '../../src/core/executor.js';
import { RunStore } from '../../src/core/run-store.js';
import { loadConfig } from '../../src/core/config.js';
import { buildApp } from '../../src/adapters/http/app.js';
import { createMcpServer } from '../../src/adapters/mcp/server.js';

test('one registration exposes a new tool to HTTP and MCP and forwards MCP cancellation', { timeout: 5000 }, async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-discovery-'));
  const config = { ...await loadConfig(), stateDirectory: state };
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const tool = defineTool({ name: 'temporary_probe', title: '测试扩展', description: '用于验证注册', category: 'text', capabilities: [], fields: [], examples: [], inputSchema: z.strictObject({ wait: z.boolean().default(false) }), outputSchema: z.strictObject({ value: z.number() }),
    execute: async ({ wait }, ctx) => {
      if (wait) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener('abort', () => { stopped.resolve(); reject(ctx.signal.reason); }, { once: true }));
      }
      return { value: 42 };
    },
  });
  const registry = new ToolRegistry([tool]);
  const store = new RunStore(state);
  const cancellationSaved = Promise.withResolvers<void>();
  const append = store.append.bind(store);
  store.append = async summary => { await append(summary); if (summary.status === 'cancelled') cancellationSaved.resolve(); };
  const runtime = { registry, store, executor: new ToolExecutor(registry, config, store) };
  const app = await buildApp(config, { runtime });
  const server = createMcpServer(runtime);
  const client = new Client({ name: 'extension-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await app.close(); await rm(state, { recursive: true, force: true }); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const discovered = await app.inject({ url: '/api/tools', headers: { host: '127.0.0.1:4318' } });
  assert.equal(discovered.json()[0].name, 'temporary_probe');
  assert.equal((await client.listTools()).tools[0].name, 'temporary_probe');
  const success = await client.callTool({ name: 'temporary_probe', arguments: {} });
  assert.equal((success.structuredContent as { data: { value: number } }).data.value, 42);
  const controller = new AbortController();
  const pending = client.callTool({ name: 'temporary_probe', arguments: { wait: true } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await entered.promise;
  controller.abort();
  await rejected;
  await stopped.promise;
  await cancellationSaved.promise;
});
