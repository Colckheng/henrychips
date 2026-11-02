import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';
import { createMcpServer } from './server.js';

try {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  const server = createMcpServer(createRuntime(await loadConfig(values.config)));
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'MCP 服务启动失败。'}\n`);
  process.exitCode = 1;
}
