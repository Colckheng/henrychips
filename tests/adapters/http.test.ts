import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../src/adapters/http/app.js';
import { loadConfig } from '../../src/core/config.js';

async function appFor(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-http-'));
  const config = { ...await loadConfig(), stateDirectory: dir };
  const app = await buildApp(config);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return app;
}
const headers = { host: '127.0.0.1:4318' };

test('HTTP routes discover and run actual tools and retain summaries only', async t => {
  const app = await appFor(t);
  const list = await app.inject({ url: '/api/tools', headers });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().some((tool: { name: string }) => tool.name === 'csv_summary'));
  const run = await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: 'Hello 世界\n第二行' } } });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().data.characters, 12);
  const invalid = await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: '   ' } } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, 'INVALID_INPUT');
  const history = await app.inject({ url: '/api/runs', headers });
  assert.equal(history.json().runs.length, 2);
  assert.equal(history.json().runs[0].input, undefined);
  const integrations = await app.inject({ url: '/api/integrations', headers });
  assert.equal(integrations.json().mcp.configured, false);
  assert.ok(integrations.json().mcp.config.mcpServers['personal-workstation'].args.includes('--config'));
});

test('HTTP rejects remote hosts origins and malformed requests', async t => {
  const app = await appFor(t);
  assert.equal((await app.inject({ url: '/api/tools', headers: { host: 'attacker.invalid:4318' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/tools', headers: { ...headers, origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: 'a' }, extra: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415);
  assert.equal((await app.inject({ url: '/api/runs?limit=-1', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/tools/missing', headers })).statusCode, 404);
});

test('development API accepts the explicit Vite origin but production does not', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-dev-origin-'));
  const config = { ...await loadConfig(), stateDirectory: dir };
  const dev = await buildApp(config, { dev: true });
  const production = await buildApp(config);
  t.after(async () => { await dev.close(); await production.close(); await rm(dir, { recursive: true, force: true }); });
  const request = { url: '/api/tools', headers: { ...headers, origin: 'http://127.0.0.1:5173' } };
  assert.equal((await dev.inject(request)).statusCode, 200);
  assert.equal((await production.inject(request)).statusCode, 403);
});
