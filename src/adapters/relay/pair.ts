import { parseArgs } from 'node:util';
import { loadConfig } from '../../core/config.js';
import { writeRelayClientConfig } from '../../relay/client-config.js';

/**
 * Pairs this workstation with a relay server and stores the credentials in
 * the workstation configuration.
 *
 * Usage: npm run relay:pair -- <relay-address> <pair-code> [device-name]
 */
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' }, token: { type: 'string' } } });
  const [address, code, name] = positionals;
  if (!address || !code) {
    process.stderr.write('用法：npm run relay:pair -- <中继地址> <配对码> [设备名]\n');
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig(values.config);
  const base = address.replace(/\/$/, '');
  // The relay may require a shared device token; the pair code alone is used
  // when the relay does not enforce one.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const relayToken = values.token ?? process.env.HENRY_RELAY_TOKEN;
  if (relayToken) headers.Authorization = `Bearer ${relayToken}`;
  const response = await fetch(`${base}/relay/pair`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ code, name: name ?? '工作站' }),
  });
  if (!response.ok) {
    process.stderr.write(`配对失败：${response.status} ${await response.text()}\n`);
    process.exitCode = 1;
    return;
  }
  const paired = await response.json() as { deviceId: string; deviceToken: string; relay: string };
  await writeRelayClientConfig(config.configPath, {
    address: base,
    deviceToken: paired.deviceToken,
    deviceId: paired.deviceId,
    deviceName: name ?? '工作站',
    ...(relayToken ? { relayToken } : {}),
  });
  process.stdout.write(`配对成功：设备 ${paired.deviceId} 已绑定到 ${base}\n配置已写入 ${config.configPath}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : '配对失败。'}\n`);
  process.exitCode = 1;
});
