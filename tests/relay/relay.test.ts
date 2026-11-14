import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readRelayClientConfig, writeRelayClientConfig, relayHeaders } from '../../src/relay/client-config.js';
import { RelayStore, TASK_TTL_MS } from '../../src/relay/store.js';

test('the relay section round-trips through the workstation configuration', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'workstation.config.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoot: './sandbox', http: { port: 4318 } }));
  await writeRelayClientConfig(configPath, {
    address: 'http://203.0.113.10:4319', deviceToken: 'device-token-value',
    deviceId: 'device-1', deviceName: '工作站', relayToken: 'shared-secret',
  });
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as { relay: Record<string, string> };
  assert.equal(raw.relay.address, 'http://203.0.113.10:4319');
  assert.equal(raw.relay.deviceName, '工作站');
  const loaded = await readRelayClientConfig(configPath);
  assert.equal(loaded?.deviceId, 'device-1');
  assert.equal(loaded?.relayToken, 'shared-secret');
  const headers = relayHeaders(loaded!);
  assert.equal(headers['x-node-token'], 'device-token-value');
  assert.equal(headers['x-device-id'], 'device-1');
  assert.equal(headers.Authorization, 'Bearer shared-secret');
});

function taskOf(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'task-1', deviceId: 'dev-1', tool: 'csv_summary', input: '{}',
    status: 'queued' as const, result: null, error: null, runId: null,
    requestId: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

test('an existing relay database gains the requestId column without losing tasks', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A database from before requestId existed: the tasks table has no such column.
  const legacy = new DatabaseSync(path.join(directory, 'relay.sqlite'));
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, error TEXT, runId TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  )`);
  legacy.prepare('INSERT INTO tasks (id, deviceId, tool, input, status, result, error, runId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old-1', 'dev-1', 'csv_summary', '{}', 'queued', null, null, null, Date.now(), Date.now());
  legacy.close();
  const store = new RelayStore(directory);
  const rows = store.tasks('dev-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 'old-1');
  assert.equal(rows[0]?.requestId, null);
  store.addTask(taskOf({ id: 'new-1', requestId: 'req-1' }));
  assert.equal(store.taskByRequestId('dev-1', 'req-1')?.id, 'new-1');
});

test('polling claims the oldest queued task first and only once', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-claim-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RelayStore(directory);
  const now = Date.now();
  store.addTask(taskOf({ id: 'a', createdAt: now - 2000, updatedAt: now - 2000 }));
  store.addTask(taskOf({ id: 'b', createdAt: now - 1000, updatedAt: now - 1000 }));
  const first = store.claimQueuedTask('dev-1');
  assert.equal(first?.id, 'a');
  assert.equal(first?.status, 'running');
  assert.equal(store.task('a')?.status, 'running');
  assert.equal(store.claimQueuedTask('dev-1')?.id, 'b');
  assert.equal(store.claimQueuedTask('dev-1'), undefined);
});

test('queued tasks expire after 24 hours and fresh ones do not', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-expire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RelayStore(directory);
  const now = Date.now();
  store.addTask(taskOf({ id: 'old', requestId: 'req-old', createdAt: now - TASK_TTL_MS - 1000, updatedAt: now - TASK_TTL_MS - 1000 }));
  store.addTask(taskOf({ id: 'fresh', createdAt: now, updatedAt: now }));
  assert.equal(store.expireQueuedTasks(undefined, now), 1);
  assert.equal(store.task('old')?.status, 'failed');
  assert.match(store.task('old')?.error ?? '', /过期/);
  assert.equal(store.task('fresh')?.status, 'queued');
  // An expired task no longer blocks its idempotency key.
  assert.equal(store.taskByRequestId('dev-1', 'req-old'), undefined);
  store.addTask(taskOf({ id: 'retry', requestId: 'req-old', createdAt: now, updatedAt: now }));
  assert.equal(store.taskByRequestId('dev-1', 'req-old')?.id, 'retry');
});
