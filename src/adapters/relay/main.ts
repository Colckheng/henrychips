import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';
import { readRelayClientConfig, relayHeaders } from '../../relay/client-config.js';

/**
 * Connects this workstation to the relay so other devices can ask it to run
 * tools. The node always dials out; the relay never connects back.
 */
async function main() {
  const config = await loadConfig();
  const relay = await readRelayClientConfig(config.configPath);
  if (!relay) {
    process.stderr.write('尚未配置服务器连接：运行 npm run relay:pair -- <中继地址> <配对码>\n');
    return;
  }
  const runtime = createRuntime(config);
  const headers = relayHeaders(relay);
  const base = relay.address.replace(/\/$/, '');

  const identity = await fetch(`${base}/relay/node/register`, {
    method: 'POST', headers,
    body: JSON.stringify(await identityOf(runtime)),
  });
  if (!identity.ok) {
    process.stderr.write(`节点注册失败：${identity.status} ${await identity.text()}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`节点已注册到 ${base}（设备 ${relay.deviceName}）\n`);

  for (;;) {
    try {
      const poll = await fetch(`${base}/relay/node/poll`, { headers });
      if (!poll.ok) { await sleep(3000); continue; }
      const { task } = await poll.json() as { task: { id: string; tool: string; input: unknown } | null };
      if (!task) continue;
      void executeTask(runtime, task, headers, base);
    } catch {
      await sleep(3000);
    }
  }
}

async function identityOf(runtime: ReturnType<typeof createRuntime>) {
  const tools = runtime.registry.list();
  return {
    version: '0.1.0',
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    capabilities: { browser: true, writeFiles: true },
    tools: tools.map(tool => ({ name: tool.name, title: tool.title, category: tool.category, capabilities: tool.capabilities, fields: tool.fields.map(field => field.name) })),
  };
}

async function executeTask(
  runtime: ReturnType<typeof createRuntime>,
  task: { id: string; tool: string; input: unknown },
  headers: Record<string, string>,
  base: string,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const report = async (message: Record<string, unknown>): Promise<void> => {
    try {
      await fetch(`${base}/relay/node/events`, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch { /* the relay will retry on the next poll */ }
  };
  await report({ type: 'progress', id: task.id, tool: task.tool, status: 'running', startedAt });
  const result = await runtime.executor.run(task.tool, task.input, { source: 'web' });
  await report({
    type: 'result', id: task.id, tool: task.tool,
    status: result.ok ? 'succeeded' : result.error.code === 'CANCELLED' ? 'cancelled' : 'failed',
    runId: result.meta.runId, startedAt, durationMs: result.meta.durationMs,
    result: result.ok ? result.data : undefined,
    error: result.ok ? undefined : `${result.error.code}: ${result.error.message}`,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

void main();
