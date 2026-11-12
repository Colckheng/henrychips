import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProjectRoot, loadConfig } from '../../src/core/config.js';

/**
 * The environment provides credentials of the machine, so the child process
 * would list a platform that the test never configured. The variables are
 * cleared for every test and put back at the end of the file.
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

/** The child gets an environment without the credential variables. */
function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of ENV_NAMES) delete environment[name];
  return environment;
}

async function runCli(args: string[], configPath: string, stdin?: string) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(getProjectRoot(), 'node_modules/tsx/dist/loader.mjs')).href, path.join(getProjectRoot(), 'src/adapters/cli/main.ts'), ...args, '--config', configPath], { cwd: tmpdir(), stdio: 'pipe', env: childEnvironment() });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  if (stdin !== undefined) child.stdin.end(stdin);
  else child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

test('CLI discovers and executes tools from another cwd with correct exit codes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { configPath: _, ...base } = await loadConfig();
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...base, stateDirectory: path.join(dir, 'state') }));
  const list = await runCli(['list', '--json'], configPath);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(JSON.parse(list.stdout).some((tool: { name: string }) => tool.name === 'text_stats'));
  const run = await runCli(['run', 'text_stats', '--input', '{"text":"Hello 世界\\n第二行"}'], configPath);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).data.characters, 12);
  const invalid = await runCli(['run', 'text_stats', '--input', '{'], configPath);
  assert.equal(invalid.code, 2);
  const missing = await runCli(['run', 'missing', '--input', '{}'], configPath);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, 'TOOL_NOT_FOUND');
  const inputFile = path.join(dir, 'input.json');
  await writeFile(inputFile, '{"text":"abc"}');
  const fileRun = await runCli(['run', 'text_stats', '--input-file', inputFile], configPath);
  assert.equal(JSON.parse(fileRun.stdout).data.characters, 3);
  const conflict = await runCli(['run', 'text_stats', '--input', '{}', '--input-file', inputFile], configPath);
  assert.equal(conflict.code, 2);
});

test('CLI manages the credentials without a value in the command line', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-cli-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { configPath: _, ...base } = await loadConfig();
  const stateDirectory = path.join(dir, 'state');
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...base, stateDirectory }));
  const credentialFile = path.join(stateDirectory, 'netdisk-credentials.json');

  const empty = await runCli(['credentials', 'list'], configPath);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /尚未配置任何网盘凭证/);

  const unknown = await runCli(['credentials', 'clear', 'constructor'], configPath);
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stdout, /constructor 没有已保存的凭证/);
  // A platform that was never stored must not create a credentials file.
  assert.equal(existsSync(credentialFile), false);

  const set = await runCli(['credentials', 'set', 'baidu', '--bduss-stdin'], configPath, 'marker-value\n');
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /已保存 baidu 的凭证/);
  // The value must not reach an output of the command.
  assert.equal(set.stdout.includes('marker-value'), false);
  assert.equal(set.stderr.includes('marker-value'), false);

  const listed = await runCli(['credentials', 'list'], configPath);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /baidu/);
  assert.equal(listed.stdout.includes('marker-value'), false);

  const badPlatform = await runCli(['credentials', 'set', 'notaplatform', '--bduss-stdin'], configPath, 'marker-value\n');
  assert.equal(badPlatform.code, 2);
  assert.match(badPlatform.stderr, /未知平台/);

  const badField = await runCli(['credentials', 'set', 'baidu', '--username-stdin'], configPath, 'marker-value\n');
  assert.equal(badField.code, 2);
  assert.match(badField.stderr, /baidu 不接受/);

  // The value as an argument is refused, and the hint does not repeat it.
  const legacy = await runCli(['credentials', 'set', 'baidu', '--bduss'], configPath);
  assert.equal(legacy.code, 2);
  assert.match(legacy.stderr, /标准输入/);
  assert.equal(legacy.stderr.includes('marker-value'), false);

  const emptyInput = await runCli(['credentials', 'set', 'baidu', '--bduss-stdin'], configPath, '');
  assert.equal(emptyInput.code, 2);
  assert.match(emptyInput.stderr, /标准输入中只有 0 行可用/);

  const cleared = await runCli(['credentials', 'clear', 'baidu'], configPath);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.match(cleared.stdout, /已清除 baidu 的凭证/);

  const emptyAgain = await runCli(['credentials', 'list'], configPath);
  assert.equal(emptyAgain.code, 0, emptyAgain.stderr);
  assert.match(emptyAgain.stdout, /尚未配置任何网盘凭证/);
});

test('CLI binds every value flag to the line at its own position', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-cli-credentials-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { configPath: _, ...base } = await loadConfig();
  const stateDirectory = path.join(dir, 'state');
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...base, stateDirectory }));
  const credentialFile = path.join(stateDirectory, 'netdisk-credentials.json');

  // The password flag comes first, so the first line is the password and
  // the second one is the username.
  const set = await runCli(['credentials', 'set', 'pan123', '--password-stdin', '--username-stdin'], configPath, 'line-one\nline-two\n');
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout.includes('line-one'), false);
  assert.equal(set.stderr.includes('line-one'), false);
  const stored = JSON.parse(await readFile(credentialFile, 'utf8'));
  assert.deepEqual(stored, { pan123: { password: 'line-one', username: 'line-two' } });

  // The other order swaps the lines, so the values must not be swapped.
  const reversed = await runCli(['credentials', 'set', 'xunlei', '--username-stdin', '--password-stdin'], configPath, 'line-one\nline-two\n');
  assert.equal(reversed.code, 0, reversed.stderr);
  const reversedStored = JSON.parse(await readFile(credentialFile, 'utf8'));
  assert.deepEqual(reversedStored.xunlei, { username: 'line-one', password: 'line-two' });

  // One value flag takes one line, so a file with two lines has a surplus.
  const surplus = await runCli(['credentials', 'set', 'baidu', '--bduss-stdin'], configPath, 'first\nsecond\n');
  assert.equal(surplus.code, 2);
  assert.match(surplus.stderr, /2 行/);
  assert.match(surplus.stderr, /只需要 1 行/);
  assert.equal(surplus.stdout.includes('first'), false);
  assert.equal(surplus.stderr.includes('first'), false);
  // The refused write must not leave a credential behind.
  assert.equal(existsSync(credentialFile) ? JSON.parse(await readFile(credentialFile, 'utf8')).baidu : undefined, undefined);
});

test('CLI keeps the parser message of a command that is not the credentials one', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-cli-parse-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { configPath: _, ...base } = await loadConfig();
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ ...base, stateDirectory: path.join(dir, 'state') }));

  const missing = await runCli(['run', 'text_stats', '--input'], configPath);
  assert.equal(missing.code, 2);
  // The message of the parser names the option that was wrong, so it must
  // not be replaced by the generic text of the command.
  assert.match(missing.stderr, /--input/);
  assert.match(missing.stderr, /argument/);
  assert.equal(missing.stderr.includes('命令格式错误'), false);

  const notBoolean = await runCli(['list', '--json=x'], configPath);
  assert.equal(notBoolean.code, 2);
  assert.match(notBoolean.stderr, /--json/);
  assert.equal(notBoolean.stderr.includes('命令格式错误'), false);

  // The removed credential flags still get their own hint.
  const legacy = await runCli(['credentials', 'set', 'baidu', '--bduss'], configPath);
  assert.equal(legacy.code, 2);
  assert.match(legacy.stderr, /标准输入/);
});
