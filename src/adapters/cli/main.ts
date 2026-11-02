import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, input: { type: 'string' }, 'input-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, name, ...extra] = positionals;
  if (values.help || !command) {
    process.stdout.write('个人工作站 CLI\n\nlist [--json]\ninspect <tool> [--json]\nrun <tool> --input <json>\nrun <tool> --input-file <path>\n\n--config <absolute-path> 指定配置文件\n');
    return;
  }
  if (extra.length || !['list', 'inspect', 'run'].includes(command) || (command === 'list' ? Boolean(name) : !name)) throw new Error('命令格式错误，请使用 --help。');
  if (values.input !== undefined && values['input-file'] !== undefined) throw new Error('--input 与 --input-file 不能同时使用。');
  if (command !== 'run' && (values.input !== undefined || values['input-file'] !== undefined)) throw new Error('输入参数只适用于 run 命令。');
  let input: unknown;
  if (command === 'run') {
    if (values.input === undefined && values['input-file'] === undefined) throw new Error('请指定 --input 或 --input-file。');
    const raw = values.input ?? await readFile(values['input-file']!, 'utf8');
    try { input = JSON.parse(raw); } catch { throw new Error('输入必须是有效 JSON。'); }
  }
  const { registry, executor } = createRuntime(await loadConfig(values.config));
  if (command === 'list') {
    process.stdout.write(values.json ? `${JSON.stringify(registry.list())}\n` : `${registry.list().map(t => `${t.name}\t${t.title}\t${t.description}`).join('\n')}\n`);
    return;
  }
  if (command === 'inspect') {
    const description = registry.list().find(t => t.name === name);
    if (!description) { process.stderr.write('找不到指定工具。\n'); process.exitCode = 1; return; }
    process.stdout.write(`${JSON.stringify(description, null, values.json ? undefined : 2)}\n`);
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    const result = await executor.run(name, input, { source: 'cli', signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : result.error.code === 'CANCELLED' ? 130 : 1;
  } finally { process.removeListener('SIGINT', interrupt); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : '无法启动 CLI。'}\n`); process.exitCode = 2; });
