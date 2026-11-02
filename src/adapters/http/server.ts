import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import { loadConfig } from '../../core/config.js';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, dev: { type: 'boolean' } } });
  const config = await loadConfig(values.config);
  const app = await buildApp(config, { dev: values.dev });
  await app.listen(config.http);
  process.stderr.write(`个人工作站已启动：http://${config.http.host}:${config.http.port}\n`);
  const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '服务启动失败。'}\n`);
  process.exitCode = 1;
}
