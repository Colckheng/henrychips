import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const relayClientSchema = z.strictObject({
  /** Base address of the relay, for example http://203.0.113.10:4319 */
  address: z.string().min(1),
  /** Token handed out by the relay when the device was paired. */
  deviceToken: z.string().min(8).max(256),
  /** Identifier the relay assigned to this device. */
  deviceId: z.string().min(1),
  /** Name shown on other devices. */
  deviceName: z.string().min(1).max(60).default('工作站'),
  /** Optional shared secret required by the relay. */
  relayToken: z.string().min(8).max(256).optional(),
});

export type RelayClientConfig = z.infer<typeof relayClientSchema>;

/** Reads the relay section of the workstation configuration. */
export async function readRelayClientConfig(configPath: string): Promise<RelayClientConfig | null> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { return null; }
  const record = raw as { relay?: unknown };
  if (!record.relay) return null;
  const parsed = relayClientSchema.safeParse(record.relay);
  return parsed.success ? parsed.data : null;
}

/** Writes the relay section back into the workstation configuration. */
export async function writeRelayClientConfig(configPath: string, relay: RelayClientConfig): Promise<void> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  raw.relay = relay;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

export function relayHeaders(config: RelayClientConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-node-token': config.deviceToken,
    'x-device-id': config.deviceId,
  };
  if (config.relayToken) headers.Authorization = `Bearer ${config.relayToken}`;
  return headers;
}
