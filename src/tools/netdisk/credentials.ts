import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetdiskPlatform } from './types.js';

export interface PlatformCredential {
  bduss?: string;
  username?: string;
  password?: string;
}

export type CredentialStore = Record<string, PlatformCredential>;

/**
 * The field of a platform that the environment variable of the platform
 * overrides. A platform without an account has no entry, so no environment
 * variable can reach it.
 */
const envKeys: Record<string, keyof PlatformCredential> = {
  baidu: 'bduss', pan123: 'username', xunlei: 'username',
};

export function credentialFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, 'netdisk-credentials.json');
}

/**
 * Reads the credential store. A file that was hand-edited into a bad state
 * reads as an empty store: a user must not get a stack trace for a typo in
 * the file, but "no credentials configured".
 */
export function readCredentials(stateDirectory: string): CredentialStore {
  const file = credentialFilePath(stateDirectory);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: CredentialStore = {};
    for (const [platform, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry: PlatformCredential = {};
      for (const key of ['bduss', 'username', 'password'] as const) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === 'string' && field) entry[key] = field;
      }
      store[platform] = entry;
    }
    return store;
  } catch { return {}; }
}

/**
 * Writes the credential store. The file lives in the state directory and
 * holds passwords, so it is kept readable by its owner only.
 */
export function writeCredentials(stateDirectory: string, store: CredentialStore): void {
  mkdirSync(stateDirectory, { recursive: true });
  const file = credentialFilePath(stateDirectory);
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // The mode of the write only applies to a file that is created, so an
  // existing file needs the change on its own.
  try { chmodSync(file, 0o600); } catch { /* Windows may not honour the POSIX mode. */ }
}

/**
 * The credential of a platform. The environment overrides the file field by
 * field, so a user can replace one value without writing anything to disk.
 */
export function resolveCredential(platform: NetdiskPlatform, stateDirectory: string): PlatformCredential | null {
  const stored = readCredentials(stateDirectory)[platform];
  const credential: PlatformCredential = { ...(stored ?? {}) };
  const key = envKeys[platform];
  if (key) {
    const envName = `HENRY_NETDISK_${platform.toUpperCase()}_${key.toUpperCase()}`;
    const fromEnv = process.env[envName];
    if (fromEnv) credential[key] = fromEnv;
  }
  if (platform === 'pan123' || platform === 'xunlei') {
    const passwordEnv = process.env[`HENRY_NETDISK_${platform.toUpperCase()}_PASSWORD`];
    if (passwordEnv) credential.password = passwordEnv;
  }
  return Object.keys(credential).length ? credential : null;
}

/**
 * The platforms that have a stored credential. Only the names are handed
 * out, the values must never reach an output.
 */
export function listCredentialPlatforms(stateDirectory: string): string[] {
  return Object.keys(readCredentials(stateDirectory)).sort();
}

export function clearCredential(stateDirectory: string, platform: string): boolean {
  const store = readCredentials(stateDirectory);
  if (!(platform in store)) return false;
  delete store[platform];
  writeCredentials(stateDirectory, store);
  return true;
}
