import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';
import * as credentials from '../../tools/netdisk/credentials.js';

const helpText = `个人工作站 CLI

list [--json]
inspect <tool> [--json]
run <tool> --input <json>
run <tool> --input-file <path>
credentials list
credentials set <platform> [--bduss-stdin] [--username-stdin] [--password-stdin]
credentials clear <platform>

--config <absolute-path> 指定配置文件

凭证值从标准输入读取，每个字段一行，顺序与该平台的字段顺序一致（百度：bduss；123 云盘与迅雷：username、password）。
  npm run cli -- credentials set baidu --bduss-stdin < credential.txt
不要把凭证值作为命令行参数传入：命令行会进入 shell 历史与 npm 的调试日志。
也可以改用环境变量 HENRY_NETDISK_<平台>_<字段>，该方式不写入任何文件。
`;

/**
 * The credential values are read from the standard input, so a value never
 * reaches the command line, the shell history or the log of npm.
 */
const stdinFlags = [
  { flag: 'bduss-stdin', field: 'bduss' },
  { flag: 'username-stdin', field: 'username' },
  { flag: 'password-stdin', field: 'password' },
] as const;

/** The flags that were removed, so a stale command line gets a clear hint. */
const removedFlags = ['--bduss', '--username', '--password'];

async function readCredentialValues(count: number): Promise<string[]> {
  if (process.stdin.isTTY) throw new Error('请通过标准输入提供凭证值，例如：npm run cli -- credentials set baidu --bduss-stdin < credential.txt');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < count) throw new Error(`标准输入中只有 ${lines.length} 行可用，需要 ${count} 行。`);
  return lines.slice(0, count);
}

/** The source of a credential is part of the state, but its value is not. */
function describeSource(info: credentials.CredentialPlatformInfo): string {
  if (info.fromFile && info.fromEnvironment) return '文件与环境变量';
  return info.fromFile ? '文件' : '环境变量';
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { config: { type: 'string' }, json: { type: 'boolean' }, input: { type: 'string' }, 'input-file': { type: 'string' }, 'bduss-stdin': { type: 'boolean' }, 'username-stdin': { type: 'boolean' }, 'password-stdin': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    // The message of the parser names the option, never its value.
    const message = error instanceof Error ? error.message : '';
    if (removedFlags.some(flag => message.includes(flag))) throw new Error('凭证值请通过标准输入提供，例如 --bduss-stdin；请使用 --help 查看用法。');
    throw new Error('命令格式错误，请使用 --help。');
  }
}

async function main() {
  const { values, positionals } = parseCliArgs();
  const [command, name, ...extra] = positionals;
  if (values.help || !command) {
    process.stdout.write(helpText);
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
  if (command !== 'credentials' && stdinFlags.some(entry => values[entry.flag])) throw new Error('凭证参数只适用于 credentials 命令。');
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
      // Only the platform names and their sources are printed: a credential
      // value must never reach an output.
      const infos = credentials.listCredentialPlatformInfos(stateDirectory);
      process.stdout.write(`${infos.length ? infos.map(info => `${info.platform}（${describeSource(info)}）`).join('\n') : '（尚未配置任何网盘凭证）'}\n`);
      return;
    }
    if (action === 'set' || action === 'clear') {
      // The platform ids are lower case, so a name in another case would be
      // stored under a key that no lookup ever reads.
      const platform = extra[0]?.toLowerCase();
      if (!platform) throw new Error(action === 'set' ? '请指定平台，例如：credentials set baidu --bduss-stdin' : '请指定要清除的平台。');
      if (extra.length > 1) throw new Error('命令格式错误，请使用 --help。');
      if (action === 'clear') {
        const removed = credentials.clearCredential(stateDirectory, platform);
        process.stdout.write(removed ? `已清除 ${platform} 的凭证。\n` : `${platform} 没有已保存的凭证。\n`);
        return;
      }
      const fields = credentials.credentialFieldsFor(platform);
      if (!fields) throw new Error(`未知平台 ${platform}，可用平台：${credentials.credentialPlatforms().join('、')}。`);
      const allowed = fields.map(field => stdinFlags.find(entry => entry.field === field)!);
      const wanted = stdinFlags.filter(entry => values[entry.flag]);
      const rejected = wanted.filter(entry => !fields.includes(entry.field));
      if (rejected.length) throw new Error(`${platform} 不接受 ${rejected.map(entry => `--${entry.flag}`).join('、')}，可用字段：${allowed.map(entry => `--${entry.flag}`).join('、')}。`);
      if (!wanted.length) throw new Error(`请至少提供 ${allowed.map(entry => `--${entry.flag}`).join('、')} 之一。`);
      // The lines are read in the order of the platform, so every field has
      // one fixed line.
      const requested = allowed.filter(entry => values[entry.flag]);
      const lines = await readCredentialValues(requested.length);
      const store = credentials.readCredentials(stateDirectory);
      const entry: credentials.PlatformCredential = { ...(Object.hasOwn(store, platform) ? store[platform] : {}) };
      for (const [index, requestedEntry] of requested.entries()) {
        if (!lines[index]) throw new Error('标准输入中的凭证值为空。');
        entry[requestedEntry.field] = lines[index];
      }
      store[platform] = entry;
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
