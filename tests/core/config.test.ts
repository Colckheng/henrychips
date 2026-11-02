import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, projectRoot } from '../../src/core/config.js';

test('resolves configuration paths against the config location and rejects unknown fields', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'workspace'));
  const file = path.join(dir, 'config.json');
  const base = await loadConfig();
  const data = { workspaceRoot: './workspace', stateDirectory: './state', outputDirectory: './output', http: base.http, network: base.network, limits: base.limits };
  await writeFile(file, JSON.stringify(data));
  const config = await loadConfig(file);
  assert.equal(config.workspaceRoot, path.join(dir, 'workspace'));
  assert.equal(config.stateDirectory, path.join(dir, 'state'));
  assert.equal(config.outputDirectory, path.join(dir, 'output'));
  await writeFile(file, JSON.stringify({ ...data, extra: true }));
  await assert.rejects(loadConfig(file), /配置/);
});

test('loads default configuration relative to project and restricts host', async (t) => {
  const config = await loadConfig();
  assert.equal(config.workspaceRoot, path.join(projectRoot, 'sandbox'));
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ workspaceRoot: '.', stateDirectory: './state', outputDirectory: './output', http: { host: '0.0.0.0', port: 4318 }, network: config.network, limits: config.limits }));
  await assert.rejects(loadConfig(file), /配置/);
});
