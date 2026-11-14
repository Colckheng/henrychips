import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { loadConfig } from '../../core/config.js';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, dev: { type: 'boolean' }, assets: { type: 'string' }, port: { type: 'string' } } });
  const config = await loadConfig(values.config);
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须是 1 到 65535 之间的整数。');
    config.http = { ...config.http, port };
  }
  const app = await buildApp(config, { dev: values.dev, assetRoot: values.assets });
  await app.listen(config.http);
  process.stderr.write(`个人工作站已启动：http://${config.http.host}:${config.http.port}\n`);
  const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '服务启动失败。'}\n`);
  process.exitCode = 1;
}
