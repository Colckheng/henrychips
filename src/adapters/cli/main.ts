import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';
import * as credentials from '../../tools/netdisk/credentials.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, json: { type: 'boolean' }, input: { type: 'string' }, 'input-file': { type: 'string' }, bduss: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, name, ...extra] = positionals;
  if (values.help || !command) {
    process.stdout.write('个人工作站 CLI\n\nlist [--json]\ninspect <tool> [--json]\nrun <tool> --input <json>\nrun <tool> --input-file <path>\ncredentials list\ncredentials set <platform> [--bduss <value>] [--username <value>] [--password <value>]\ncredentials clear <platform>\n\n--config <absolute-path> 指定配置文件\n');
    return;
  }
  if (!['list', 'inspect', 'run', 'credentials'].includes(command)) throw new Error('命令格式错误，请使用 --help。');
  if (command === 'credentials') {
    // The action and the platform are the positionals of this command, so
    // the check of the other commands does not apply to it.
    if (!name) throw new Error('命令格式错误，请使用 --help。');
  } else if (extra.length || (command === 'list' ? Boolean(name) : !name)) throw new Error('命令格式错误，请使用 --help。');
  if (values.input !== undefined && values['input-file'] !== undefined) throw new Error('--input 与 --input-file 不能同时使用。');
  if (command !== 'run' && (values.input !== undefined || values['input-file'] !== undefined)) throw new Error('输入参数只适用于 run 命令。');
  if (command !== 'credentials' && (values.bduss !== undefined || values.username !== undefined || values.password !== undefined)) throw new Error('凭证参数只适用于 credentials 命令。');
  let input: unknown;
  if (command === 'run') {
    if (values.input === undefined && values['input-file'] === undefined) throw new Error('请指定 --input 或 --input-file。');
    const raw = values.input ?? await readFile(values['input-file']!, 'utf8');
    try { input = JSON.parse(raw); } catch { throw new Error('输入必须是有效 JSON。'); }
  }
  if (command === 'credentials') {
    const action = name;
    const { stateDirectory } = await loadConfig(values.config);
    if (action === 'list') {
      if (extra.length) throw new Error('命令格式错误，请使用 --help。');
      // Only the platform names are printed: a credential value must never
      // reach an output.
      const platforms = credentials.listCredentialPlatforms(stateDirectory);
      process.stdout.write(`${platforms.length ? platforms.join('\n') : '（尚未配置任何网盘凭证）'}\n`);
      return;
    }
    if (action === 'set' || action === 'clear') {
      // The platform ids are lower case, so a name in another case would be
      // stored under a key that no lookup ever reads.
      const platform = extra[0]?.toLowerCase();
      if (!platform) throw new Error(action === 'set' ? '请指定平台，例如：credentials set baidu --bduss "..."' : '请指定要清除的平台。');
      if (extra.length > 1) throw new Error('命令格式错误，请使用 --help。');
      if (action === 'clear') {
        const removed = credentials.clearCredential(stateDirectory, platform);
        process.stdout.write(removed ? `已清除 ${platform} 的凭证。\n` : `${platform} 没有已保存的凭证。\n`);
        return;
      }
      const entry = { bduss: values.bduss, username: values.username, password: values.password };
      if (!entry.bduss && !entry.username && !entry.password) throw new Error('请至少提供 --bduss、--username 或 --password 之一。');
      const store = credentials.readCredentials(stateDirectory);
      store[platform] = { ...(store[platform] ?? {}), ...Object.fromEntries(Object.entries(entry).filter(([, value]) => value)) };
      credentials.writeCredentials(stateDirectory, store);
      process.stdout.write(`已保存 ${platform} 的凭证。\n`);
      return;
    }
    throw new Error('命令格式错误，请使用 --help。');
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
