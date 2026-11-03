import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { RelayServer } from '../../src/relay/server.js';
import { createRuntime } from '../../src/core/runtime.js';
import { loadConfig } from '../../src/core/config.js';

const relayToken = 'relay-token-for-tests';

async function startRelay(t: { after: (fn: () => unknown) => void }): Promise<{ base: string; relay: RelayServer; server: Server; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-'));
  const relay = new RelayServer({ address: 'http://127.0.0.1:0', port: 0, pairCode: 'code123', dataDirectory: directory, deviceToken: relayToken });
  const server = createServer((request, response) => { void relay.handle(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  t.after(async () => { server.close(); await rm(directory, { recursive: true, force: true }).catch(() => undefined); });
  return { base: `http://127.0.0.1:${port}`, relay, server, directory };
}

test('the relay refuses an unknown pair code and a missing token', async t => {
  const { base } = await startRelay(t);
  const badCode = await fetch(`${base}/relay/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` }, body: JSON.stringify({ code: 'wrong', name: 'x' }) });
  assert.equal(badCode.status, 403);
  const noToken = await fetch(`${base}/relay/devices`);
  assert.equal(noToken.status, 401);
});

test('a paired node receives a task, runs it and the relay records the result', async t => {
  const { base } = await startRelay(t);
  const paired = await (await fetch(`${base}/relay/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ code: 'code123', name: '测试工作站' }),
  })).json() as { deviceId: string; deviceToken: string };
  assert.ok(paired.deviceId && paired.deviceToken);

  const runtime = createRuntime(await loadConfig());
  const nodeHeaders = { 'Content-Type': 'application/json', 'x-node-token': paired.deviceToken, 'x-device-id': paired.deviceId, Authorization: `Bearer ${relayToken}` };
  const registered = await fetch(`${base}/relay/node/register`, { method: 'POST', headers: nodeHeaders, body: JSON.stringify({ version: '0.1.0', platform: process.platform, tools: [{ name: 'csv_summary' }] }) });
  assert.equal(registered.status, 200);

  const poll = fetch(`${base}/relay/node/poll`, { headers: nodeHeaders });
  await new Promise(resolve => setTimeout(resolve, 200));
  const created = await (await fetch(`${base}/relay/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ deviceId: paired.deviceId, tool: 'csv_summary', input: { path: 'samples/sales.csv' } }),
  })).json() as { taskId: string };

  const polled = await (await poll).json() as { task: { id: string; tool: string; input: unknown } | null };
  assert.ok(polled.task);
  assert.equal(polled.task!.id, created.taskId);
  assert.equal(polled.task!.tool, 'csv_summary');

  const result = await runtime.executor.run(polled.task!.tool, polled.task!.input, { source: 'web' });
  await fetch(`${base}/relay/node/events`, {
    method: 'POST', headers: nodeHeaders,
    body: JSON.stringify({ type: 'result', id: polled.task!.id, tool: 'csv_summary', status: result.ok ? 'succeeded' : 'failed', runId: result.meta.runId, startedAt: result.meta.startedAt, durationMs: result.meta.durationMs, result: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error.message }),
  });

  const tasks = await (await fetch(`${base}/relay/tasks?deviceId=${paired.deviceId}`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { tasks: Array<{ status: string; result: string }> };
  assert.equal(tasks.tasks[0]?.status, 'succeeded');
  assert.match(tasks.tasks[0]?.result ?? '', /"sum":20/);

  const runs = await (await fetch(`${base}/relay/runs`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { runs: Array<{ tool: string; status: string }> };
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]?.tool, 'csv_summary');
  assert.equal(runs.runs[0]?.status, 'succeeded');

  const devices = await (await fetch(`${base}/relay/devices`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { devices: Array<{ name: string; online: boolean }> };
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0]?.online, true);
});

test('the relay refuses to queue a task for an offline device', async t => {
  const { base } = await startRelay(t);
  const response = await fetch(`${base}/relay/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ deviceId: 'missing-device', tool: 'csv_summary', input: {} }),
  });
  assert.equal(response.status, 409);
});
