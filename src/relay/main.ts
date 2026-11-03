import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelayConfig, RelayServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? path.resolve(here, 'relay.config.json');

try {
  const config = await loadRelayConfig(configPath);
  const relay = new RelayServer(config);
  const server = createServer((request, response) => { void relay.handle(request, response); });
  server.listen(config.port, '0.0.0.0', () => {
    // The address already carries the scheme, so it is used as is.
    process.stderr.write(`中继服务已启动：${config.address}\n`);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '中继服务启动失败。'}\n`);
  process.exit(1);
}
