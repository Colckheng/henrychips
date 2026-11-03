import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRelayClientConfig, writeRelayClientConfig, relayHeaders } from '../../src/relay/client-config.js';

test('the relay section round-trips through the workstation configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-relay-config-'));
  t_after(() => rm(directory, { recursive: true, force: true }));
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

function t_after(fn: () => unknown): void {
  void fn();
}
