import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetdiskPlatform } from './types.js';

export interface PlatformCredential {
  bduss?: string;
  username?: string;
  password?: string;
}

export type CredentialStore = Record<string, PlatformCredential>;

/**
 * A credential that holds a field no adapter reads would look configured
 * while being useless, so the field set decides what a platform accepts. The
 * map also hides the prototype chain, so a name like "__proto__" is simply an
 * unknown platform.
 */
const credentialFields = new Map<string, readonly (keyof PlatformCredential)[]>([
  ['baidu', ['bduss']],
  ['pan123', ['username', 'password']],
  ['xunlei', ['username', 'password']],
]);

/** A usage error has to name the platforms that work, so they are listed. */
export function credentialPlatforms(): string[] {
  return [...credentialFields.keys()].sort();
}

/** A usage error has to name the fields that work, so they are handed out. */
export function credentialFieldsFor(platform: string): readonly (keyof PlatformCredential)[] | null {
  return credentialFields.get(platform) ?? null;
}

export function credentialFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, 'netdisk-credentials.json');
}

/**
 * A file that was hand-edited into a bad state reads as an empty store: a
 * typo in the file must not end in a stack trace, but in "no credentials
 * configured".
 */
export function readCredentials(stateDirectory: string): CredentialStore {
  const file = credentialFilePath(stateDirectory);
  if (!existsSync(file)) return {};
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch { return {}; }
  try {
    // A file that was edited on Windows starts with a byte order mark,
    // which would make the whole file unreadable for JSON.
    const withoutMark = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(withoutMark) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const store: CredentialStore = {};
    // Only the known platforms are read, so a key of the file can never
    // reach the store under a name that is not a platform.
    for (const [platform, fields] of credentialFields) {
      if (!Object.hasOwn(source, platform)) continue;
      const value = source[platform];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry: PlatformCredential = {};
      for (const field of fields) {
        const stored = (value as Record<string, unknown>)[field];
        if (typeof stored === 'string' && stored) entry[field] = stored;
      }
      // An entry without a usable field describes no credential, so it is
      // not a platform that could ever be resolved.
      if (Object.keys(entry).length) store[platform] = entry;
    }
    return store;
  } catch { return {}; }
}

/**
 * Only the known platforms and their own fields reach the file, so a caller
 * that passes a strange key cannot put it into the store.
 */
function cleanStore(store: CredentialStore): CredentialStore {
  const cleaned: CredentialStore = {};
  for (const [platform, fields] of credentialFields) {
    if (!Object.hasOwn(store, platform)) continue;
    const entry = store[platform];
    if (!entry || typeof entry !== 'object') continue;
    const values: PlatformCredential = {};
    for (const field of fields) {
      const value = entry[field];
      if (typeof value === 'string' && value) values[field] = value;
    }
    if (Object.keys(values).length) cleaned[platform] = values;
  }
  return cleaned;
}

/**
 * The file holds the only copy of the credentials, so it is written through a
 * temporary file: an interrupted write must not be able to destroy it.
 */
export function writeCredentials(stateDirectory: string, store: CredentialStore): void {
  mkdirSync(stateDirectory, { recursive: true });
  const file = credentialFilePath(stateDirectory);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(cleanStore(store), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    // A temporary file holds a credential, so it must not survive a failed write.
    try { rmSync(temporary, { force: true }); } catch { /* the file may not exist */ }
    throw error;
  }
  // The mode of the write only applies to a file that is created, so an
  // existing file needs the change on its own.
  try { chmodSync(file, 0o600); } catch { /* Windows may not honour the POSIX mode. */ }
}

/**
 * The environment overrides the file field by field, so a user can replace
 * one value without writing anything to disk.
 */
export function resolveCredential(platform: NetdiskPlatform, stateDirectory: string): PlatformCredential | null {
  const fields = credentialFields.get(platform);
  if (!fields) return null;
  const store = readCredentials(stateDirectory);
  const stored = Object.hasOwn(store, platform) ? store[platform] : undefined;
  const credential: PlatformCredential = {};
  for (const field of fields) {
    const fromFile = stored?.[field];
    if (typeof fromFile === 'string' && fromFile) credential[field] = fromFile;
    const fromEnvironment = process.env[`HENRY_NETDISK_${platform.toUpperCase()}_${field.toUpperCase()}`];
    if (fromEnvironment) credential[field] = fromEnvironment;
  }
  return Object.keys(credential).length ? credential : null;
}

export interface CredentialPlatformInfo {
  platform: string;
  /** The platform has a credential in the file. */
  fromFile: boolean;
  /** An environment variable provides a value for the platform. */
  fromEnvironment: boolean;
}

/**
 * The listing must agree with `resolveCredential`, otherwise the user
 * cannot tell what is configured.
 */
export function listCredentialPlatformInfos(stateDirectory: string): CredentialPlatformInfo[] {
  const store = readCredentials(stateDirectory);
  const infos: CredentialPlatformInfo[] = [];
  for (const [platform, fields] of credentialFields) {
    const fromFile = Object.hasOwn(store, platform);
    const fromEnvironment = fields.some(field => Boolean(process.env[`HENRY_NETDISK_${platform.toUpperCase()}_${field.toUpperCase()}`]));
    if (!fromFile && !fromEnvironment) continue;
    infos.push({ platform, fromFile, fromEnvironment });
  }
  return infos.sort((left, right) => left.platform.localeCompare(right.platform));
}

/**
 * The names are handed out, the values must never reach an output.
 */
export function listCredentialPlatforms(stateDirectory: string): string[] {
  return listCredentialPlatformInfos(stateDirectory).map(info => info.platform);
}

export function clearCredential(stateDirectory: string, platform: string): boolean {
  const store = readCredentials(stateDirectory);
  // The prototype chain is not part of the store, so only an own key counts.
  if (!Object.hasOwn(store, platform)) return false;
  delete store[platform];
  writeCredentials(stateDirectory, store);
  return true;
}
