import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { RelayServer } from '../../src/relay/server.js';
import { RelayStore } from '../../src/relay/store.js';
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

async function pairAndRegister(base: string): Promise<{ deviceId: string; deviceToken: string; headers: Record<string, string> }> {
  const paired = await (await fetch(`${base}/relay/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ code: 'code123', name: '测试工作站' }),
  })).json() as { deviceId: string; deviceToken: string };
  const headers = { 'Content-Type': 'application/json', 'x-node-token': paired.deviceToken, 'x-device-id': paired.deviceId, Authorization: `Bearer ${relayToken}` };
  const registered = await fetch(`${base}/relay/node/register`, { method: 'POST', headers, body: JSON.stringify({ version: '0.1.0', platform: process.platform, tools: [{ name: 'csv_summary' }] }) });
  assert.equal(registered.status, 200);
  return { deviceId: paired.deviceId, deviceToken: paired.deviceToken, headers };
}

async function postTask(base: string, deviceId: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/relay/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ deviceId, tool: 'csv_summary', input: {}, ...body }),
  });
  return { status: response.status, body: await response.json() as { taskId: string; status: string; duplicate?: boolean } };
}

test('a task queued while the node is away is delivered on its next poll, once', async t => {
  const { base } = await startRelay(t);
  const { deviceId, headers } = await pairAndRegister(base);
  // No poll is in flight when the task is queued.
  const created = await postTask(base, deviceId, {});
  assert.equal(created.status, 202);
  // The node restarts and registers again before its first poll.
  const registered = await fetch(`${base}/relay/node/register`, { method: 'POST', headers, body: JSON.stringify({ version: '0.1.0', platform: process.platform, tools: [{ name: 'csv_summary' }] }) });
  assert.equal(registered.status, 200);
  const startedAt = Date.now();
  const polled = await Promise.race([
    (await fetch(`${base}/relay/node/poll`, { headers })).json() as Promise<{ task: { id: string; tool: string; input: unknown } | null }>,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('poll did not return the queued task within 10s')), 10_000)),
  ]);
  // The queued task arrives at once instead of waiting out the long poll.
  assert.ok(Date.now() - startedAt < 10_000);
  assert.ok(polled.task);
  assert.equal(polled.task!.id, created.body.taskId);
  // The task was claimed when it was handed out, so it cannot be delivered twice.
  const tasks = await (await fetch(`${base}/relay/tasks?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { tasks: Array<{ id: string; status: string }> };
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0]?.status, 'running');
});

test('resending the same requestId returns the original task instead of a new one', async t => {
  const { base } = await startRelay(t);
  const { deviceId } = await pairAndRegister(base);
  const first = await postTask(base, deviceId, { requestId: 'req-1' });
  assert.equal(first.status, 202);
  const second = await postTask(base, deviceId, { requestId: 'req-1' });
  assert.equal(second.status, 202);
  assert.equal(second.body.taskId, first.body.taskId);
  assert.equal(second.body.duplicate, true);
  const third = await postTask(base, deviceId, { requestId: 'req-2' });
  assert.equal(third.status, 202);
  assert.notEqual(third.body.taskId, first.body.taskId);
  const tasks = await (await fetch(`${base}/relay/tasks?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { tasks: Array<{ id: string }> };
  assert.equal(tasks.tasks.length, 2);
});

test('an expired queued task is failed on read and never delivered', async t => {
  const { base, directory } = await startRelay(t);
  const { deviceId, headers } = await pairAndRegister(base);
  // A task that has waited more than 24 hours, written straight to the store.
  const store = new RelayStore(directory);
  const now = Date.now();
  store.addTask({
    id: 'stale-task', deviceId, tool: 'csv_summary', input: '{}',
    status: 'queued', result: null, error: null, runId: null, requestId: null,
    createdAt: now - 25 * 60 * 60 * 1000, updatedAt: now - 25 * 60 * 60 * 1000,
  });
  const fresh = await postTask(base, deviceId, {});
  assert.equal(fresh.status, 202);
  // The next poll hands out the fresh task, not the stale one.
  const polled = await (await fetch(`${base}/relay/node/poll`, { headers })).json() as { task: { id: string } | null };
  assert.ok(polled.task);
  assert.equal(polled.task!.id, fresh.body.taskId);
  const tasks = await (await fetch(`${base}/relay/tasks?deviceId=${deviceId}`, { headers: { Authorization: `Bearer ${relayToken}` } })).json() as { tasks: Array<{ id: string; status: string; error: string | null }> };
  const stale = tasks.tasks.find(task => task.id === 'stale-task');
  assert.equal(stale?.status, 'failed');
  assert.match(stale?.error ?? '', /过期/);
});
