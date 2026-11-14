import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getProjectRoot, loadConfig } from '../../src/core/config.js';

const tsxLoader = pathToFileURL(path.join(getProjectRoot(), 'node_modules/tsx/dist/loader.mjs')).href;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function makeConfig(t: TestContext, overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-fix-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace');
  const output = path.join(dir, 'output');
  await mkdir(workspace, { recursive: true });
  await mkdir(output, { recursive: true });
  const { configPath: _, ...base } = await loadConfig();
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({
    ...base,
    workspaceRoot: workspace,
    outputDirectory: output,
    stateDirectory: path.join(dir, 'state'),
    ...overrides,
  }));
  return { dir, workspace, config };
}

interface Spawned {
  child: ChildProcess;
  code: Promise<number | null>;
  output: { stdout: string; stderr: string };
}

function spawnNode(args: string[]): Spawned {
  const child = spawn(process.execPath, ['--import', tsxLoader, ...args], { cwd: tmpdir(), stdio: 'pipe', env: { ...process.env } });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const code = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { child, code, output };
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function stop(child: ChildProcess, code: Promise<number | null>) {
  child.kill('SIGTERM');
  await Promise.race([code, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('8: --port overrides the configured port', { timeout: 30_000 }, async (t) => {
  const { config } = await makeConfig(t);
  const port = await freePort();
  const spawned = spawnNode([path.join(getProjectRoot(), 'src/adapters/http/server.ts'), '--config', config, '--port', String(port)]);
  const { child, code } = spawned;
  t.after(() => stop(child, code));
  assert.equal(await waitForHealth(port), true, spawned.output.stderr);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { status: string };
  assert.equal(health.status, 'ok');
});

test('8: without --port the server listens on the configured port', { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const { config } = await makeConfig(t, { http: { host: '127.0.0.1', port } });
  const spawned = spawnNode([path.join(getProjectRoot(), 'src/adapters/http/server.ts'), '--config', config]);
  const { child, code } = spawned;
  t.after(() => stop(child, code));
  assert.equal(await waitForHealth(port), true, spawned.output.stderr);
});

test('8: an invalid --port fails fast with a clear error', async (t) => {
  const { config } = await makeConfig(t);
  for (const bad of ['0', '65536', 'abc', '4318.5']) {
    const spawned = spawnNode([path.join(getProjectRoot(), 'src/adapters/http/server.ts'), '--config', config, '--port', bad]);
    const exit = await Promise.race([spawned.code, new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 15_000))]);
    assert.equal(exit, 1, `port ${bad} should exit 1, stderr: ${spawned.output.stderr}`);
    assert.match(spawned.output.stderr, /--port 必须是 1 到 65535 之间的整数/);
  }
});

test('10: MCP annotations follow each tool capabilities', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-fix-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { configPath: _, ...base } = await loadConfig();
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ ...base, stateDirectory: path.join(dir, 'state') }));
  const client = new Client({ name: 'workstation-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', tsxLoader, path.join(getProjectRoot(), 'src/adapters/mcp/main.ts'), '--config', config], cwd: tmpdir(), stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const textStats = byName.get('text_stats')!;
  assert.deepEqual(textStats.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  const docConvert = byName.get('doc_convert')!;
  assert.deepEqual(docConvert.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  const webExtract = byName.get('web_extract')!;
  assert.deepEqual(webExtract.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  const photoCompress = byName.get('photo_compress')!;
  assert.equal(photoCompress.annotations?.readOnlyHint, false);
  assert.equal(photoCompress.annotations?.destructiveHint, true);
});

function runCli(args: string[], configPath: string) {
  return spawnNode([path.join(getProjectRoot(), 'src/adapters/cli/main.ts'), ...args, '--config', configPath]);
}

test('12d: --input-file is capped by the configured file size limit', { timeout: 30_000 }, async (t) => {
  const { configPath: _, ...base } = await loadConfig();
  const { dir, config } = await makeConfig(t, { limits: { ...base.limits, fileBytes: 64 } });
  const small = path.join(dir, 'small.json');
  await writeFile(small, '{"text":"abc"}');
  const ok = runCli(['run', 'text_stats', '--input-file', small], config);
  assert.equal(await ok.code, 0, ok.output.stderr);
  assert.equal(JSON.parse(ok.output.stdout).data.characters, 3);

  const big = path.join(dir, 'big.json');
  const marker = 'x'.repeat(100);
  await writeFile(big, JSON.stringify({ text: marker }));
  const over = runCli(['run', 'text_stats', '--input-file', big], config);
  assert.equal(await over.code, 2, over.output.stdout);
  assert.match(over.output.stderr, /输入文件超过 64 字节上限/);
  assert.equal(over.output.stdout.includes(marker), false);
  assert.equal(over.output.stderr.includes(marker), false);
});
