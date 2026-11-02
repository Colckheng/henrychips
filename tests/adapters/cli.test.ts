import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot, loadConfig } from '../../src/core/config.js';

async function runCli(args: string[], configPath: string) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(projectRoot, 'node_modules/tsx/dist/loader.mjs')).href, path.join(projectRoot, 'src/adapters/cli/main.ts'), ...args, '--config', configPath], { cwd: tmpdir(), stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
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
