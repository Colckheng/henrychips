import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearCredential, credentialFilePath, listCredentialPlatformInfos, listCredentialPlatforms, readCredentials, resolveCredential, writeCredentials } from '../../src/tools/netdisk/credentials.js';

/**
 * The environment overrides the stored credential, so the variables of the
 * machine would decide the outcome of the tests. They are cleared for every
 * test and put back at the end of the file.
 */
const ENV_NAMES = [
  'HENRY_NETDISK_BAIDU_BDUSS',
  'HENRY_NETDISK_PAN123_USERNAME',
  'HENRY_NETDISK_PAN123_PASSWORD',
  'HENRY_NETDISK_XUNLEI_USERNAME',
  'HENRY_NETDISK_XUNLEI_PASSWORD',
];
const savedEnv = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
beforeEach(() => { for (const name of ENV_NAMES) delete process.env[name]; });
after(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('stores credentials in the state directory, not in the config', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'token' } });
  assert.equal(credentialFilePath(directory), path.join(directory, 'netdisk-credentials.json'));
  assert.deepEqual(readCredentials(directory), { baidu: { bduss: 'token' } });
});

test('returns null when the platform has no credential', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(resolveCredential('baidu', directory), null);
});

test('lets an environment variable win over the stored credential', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'from-file' } });
  process.env.HENRY_NETDISK_BAIDU_BDUSS = 'from-env';
  t.after(() => { delete process.env.HENRY_NETDISK_BAIDU_BDUSS; });
  assert.equal(resolveCredential('baidu', directory)?.bduss, 'from-env');
});

test('clears one platform without touching the others', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'a' }, xunlei: { token: 't' } });
  assert.equal(clearCredential(directory, 'baidu'), true);
  assert.deepEqual(listCredentialPlatforms(directory), ['xunlei']);
});

test('reads a corrupted file as an empty store instead of crashing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), 'not json', 'utf8');
  assert.deepEqual(readCredentials(directory), {});
});

test('writes the credential file with the values it was given', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { xunlei: { token: 't' } });
  const file = credentialFilePath(directory);
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify({ xunlei: { token: 't' } }, null, 2)}\n`);
  const info = await stat(file);
  assert.ok(info.isFile());
  // The file holds a password, so only its owner may read it. Windows keeps
  // no POSIX mode, so the permission is only checked where it exists.
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
});

test('lets the environment override one field and leaves the other one alone', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { pan123: { username: 'file-user', password: 'file-pass' } });
  process.env.HENRY_NETDISK_PAN123_PASSWORD = 'env-pass';
  t.after(() => { delete process.env.HENRY_NETDISK_PAN123_PASSWORD; });
  const credential = resolveCredential('pan123', directory);
  assert.equal(credential?.username, 'file-user');
  assert.equal(credential?.password, 'env-pass');
});

test('drops the entries the file cannot describe', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), JSON.stringify(['baidu', 'xunlei']), 'utf8');
  assert.deepEqual(readCredentials(directory), {});
  await writeFile(credentialFilePath(directory), JSON.stringify({ baidu: 'token', xunlei: { token: 7 } }), 'utf8');
  // A field that is not a string cannot be used, so the entry is dropped.
  assert.deepEqual(readCredentials(directory), {});
});

test('says a platform has nothing to clear when it was never stored', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(clearCredential(directory, 'baidu'), false);
});

test('does not clear a name of the prototype chain', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(clearCredential(directory, 'constructor'), false);
  assert.equal(clearCredential(directory, 'toString'), false);
  // A name that was never stored must not create a file either.
  assert.equal(existsSync(credentialFilePath(directory)), false);
});

test('keeps a prototype name out of the store', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), '{"__proto__": {"bduss": "leaked-secret"}}', 'utf8');
  const store = readCredentials(directory);
  assert.deepEqual(store, {});
  assert.equal((store as Record<string, unknown>).bduss, undefined);
  assert.equal(resolveCredential('baidu', directory), null);
  // The prototype of the store must still be the one of an object.
  assert.equal(typeof store.toString, 'function');
  writeCredentials(directory, { '__proto__': { bduss: 'leaked-secret' } } as never);
  assert.equal(await readFile(credentialFilePath(directory), 'utf8'), '{}\n');
});

test('lists a platform that only the environment provides', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.HENRY_NETDISK_BAIDU_BDUSS = 'from-env';
  t.after(() => { delete process.env.HENRY_NETDISK_BAIDU_BDUSS; });
  assert.deepEqual(listCredentialPlatforms(directory), ['baidu']);
  assert.deepEqual(listCredentialPlatformInfos(directory), [{ platform: 'baidu', fromFile: false, fromEnvironment: true }]);
});

test('does not list a platform whose fields are all unusable', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), JSON.stringify({ baidu: { bduss: 7 } }), 'utf8');
  assert.deepEqual(listCredentialPlatforms(directory), []);
  assert.equal(resolveCredential('baidu', directory), null);
});

test('reads a file that starts with a byte order mark', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), `\uFEFF${JSON.stringify({ baidu: { bduss: 'token' } })}`, 'utf8');
  assert.deepEqual(readCredentials(directory), { baidu: { bduss: 'token' } });
});

test('leaves no temporary file behind after a write', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'token' } });
  const leftovers = (await readdir(directory)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('gives every write its own temporary file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A temporary file of an earlier attempt must not block the next write,
  // so the name of the temporary file is not a fixed one.
  const file = credentialFilePath(directory);
  await writeFile(`${file}.tmp`, 'stale', 'utf8');
  writeCredentials(directory, { baidu: { bduss: 'token' } });
  assert.deepEqual(readCredentials(directory), { baidu: { bduss: 'token' } });
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), ['netdisk-credentials.json.tmp']);
});
