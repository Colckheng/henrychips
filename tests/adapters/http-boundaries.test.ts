import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { buildApp } from '../../src/adapters/http/app.js';

const headers = { host: '127.0.0.1:4318' };
test('HTTP caps request bodies and does not expose arbitrary local resources', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-http-boundary-'));
  const app = await buildApp({ ...await loadConfig(), stateDirectory: dir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const huge = await app.inject({ method: 'POST', url: '/api/tools/text_stats/run', headers, payload: { input: { text: 'a'.repeat(1048577) } } });
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.json().error.code, 'LIMIT_EXCEEDED');
  for (const url of ['/workstation.config.json', '/package.json', '/.workstation/runs', '/src/core/config.ts']) {
    const response = await app.inject({ url, headers });
    assert.ok(response.statusCode === 403 || response.statusCode === 404, `${url} must not be served`);
    assert.ok(response.json().error);
  }
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/tools', headers: { ...headers, origin: 'https://attacker.invalid' } });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  const allowed = await app.inject({ url: '/api/health', headers: { ...headers, origin: 'http://127.0.0.1:4318' } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['cache-control'], 'no-store');
});
