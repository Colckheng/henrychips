import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearCredential, credentialFilePath, listCredentialPlatforms, readCredentials, resolveCredential, writeCredentials } from '../../src/tools/netdisk/credentials.js';

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
  writeCredentials(directory, { baidu: { bduss: 'a' }, xunlei: { username: 'u', password: 'p' } });
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
  writeCredentials(directory, { xunlei: { username: 'u', password: 'p' } });
  const file = credentialFilePath(directory);
  assert.equal(await readFile(file, 'utf8'), `${JSON.stringify({ xunlei: { username: 'u', password: 'p' } }, null, 2)}\n`);
  const info = await stat(file);
  assert.ok(info.isFile());
  // The file holds a password, so only its owner may read it. Windows keeps
  // no POSIX mode, so the permission is only checked where it exists.
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
});

test('lets the environment override one field and leaves the other one alone', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { xunlei: { username: 'file-user', password: 'file-pass' } });
  process.env.HENRY_NETDISK_XUNLEI_PASSWORD = 'env-pass';
  t.after(() => { delete process.env.HENRY_NETDISK_XUNLEI_PASSWORD; });
  const credential = resolveCredential('xunlei', directory);
  assert.equal(credential?.username, 'file-user');
  assert.equal(credential?.password, 'env-pass');
});

test('drops the entries the file cannot describe', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), JSON.stringify(['baidu', 'xunlei']), 'utf8');
  assert.deepEqual(readCredentials(directory), {});
  await writeFile(credentialFilePath(directory), JSON.stringify({ baidu: 'token', xunlei: { username: 'u', password: 7 } }), 'utf8');
  assert.deepEqual(readCredentials(directory), { xunlei: { username: 'u' } });
});

test('says a platform has nothing to clear when it was never stored', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(clearCredential(directory, 'baidu'), false);
});
