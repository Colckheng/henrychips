import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { loadConfig } from '../../core/config.js';
import { createRuntime } from '../../core/runtime.js';
import * as credentials from '../../tools/netdisk/credentials.js';

const helpText = `个人工作站 CLI

list [--json]
inspect <tool> [--json]
run <tool> --input <json>
run <tool> --input-file <path>
credentials list
credentials set <platform> [--bduss-stdin] [--username-stdin] [--password-stdin] [--token-stdin]
credentials clear <platform>

--config <absolute-path> 指定配置文件

凭证值从标准输入读取：每个取值 flag 独占一行，第 N 个取值 flag 取第 N 行。
  npm run cli -- credentials set baidu --bduss-stdin < credential.txt
  npm run cli -- credentials set pan123 --username-stdin --password-stdin < credentials.txt
第二条里第 1 行是 username、第 2 行是 password，因为这两个取值 flag 就是这个顺序写的。
标准输入的行数必须与取值 flag 的个数相同，多余的行会被拒绝。
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
  { flag: 'token-stdin', field: 'token' },
] as const;

type StdinFlag = (typeof stdinFlags)[number];

/** The flags that were removed, so a stale command line gets a clear hint. */
const removedFlags = ['--bduss', '--username', '--password', '--token'];
/** A removed flag is matched as a whole word, so "--username-stdin" is not one. */
const removedFlagPatterns = removedFlags.map(flag => new RegExp(`${flag}(?![-\\w])`));

async function readCredentialValues(count: number): Promise<string[]> {
  if (process.stdin.isTTY) throw new Error('请通过标准输入提供凭证值，例如：npm run cli -- credentials set baidu --bduss-stdin < credential.txt');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < count) throw new Error(`标准输入中只有 ${lines.length} 行可用，需要 ${count} 行。`);
  // A line that no flag asks for would look like a credential that was
  // stored, so the surplus is refused instead of dropped.
  if (lines.length > count) throw new Error(`标准输入有 ${lines.length} 行，但本次只需要 ${count} 行，请只提供所需的行。`);
  return lines;
}

/**
 * The value flags keep the order they were written in, so every flag owns the
 * line at its own position. A pair that was written in the other order can no
 * longer be swapped, because the line follows the flag and not the platform.
 */
function stdinFlagsInOrder(tokens: readonly { kind: string; name?: string }[]): StdinFlag[] {
  const seen = new Set<string>();
  const ordered: StdinFlag[] = [];
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const entry = stdinFlags.find(candidate => candidate.flag === token.name);
    if (!entry || seen.has(entry.flag)) continue;
    seen.add(entry.flag);
    ordered.push(entry);
  }
  return ordered;
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
      tokens: true,
      options: { config: { type: 'string' }, json: { type: 'boolean' }, input: { type: 'string' }, 'input-file': { type: 'string' }, 'bduss-stdin': { type: 'boolean' }, 'username-stdin': { type: 'boolean' }, 'password-stdin': { type: 'boolean' }, 'token-stdin': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    // The message of the parser names the option, never its value.
    const message = error instanceof Error ? error.message : '';
    if (removedFlagPatterns.some(pattern => pattern.test(message))) throw new Error('凭证值请通过标准输入提供，例如 --bduss-stdin；请使用 --help 查看用法。');
    // A parse error of another command keeps its own message, because it
    // names the option that was wrong.
    throw new Error(message || '命令格式错误，请使用 --help。');
  }
}

async function main() {
  const { values, positionals, tokens } = parseCliArgs();
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
    let raw: string;
    if (values.input !== undefined) raw = values.input;
    else {
      // --input-file shares the configured file-size limit instead of being
      // read into memory without a cap.
      const { limits } = await loadConfig(values.config);
      const inputFile = values['input-file']!;
      if ((await stat(inputFile)).size > limits.fileBytes) throw new Error(`输入文件超过 ${limits.fileBytes} 字节上限。`);
      raw = await readFile(inputFile, 'utf8');
      if (Buffer.byteLength(raw) > limits.fileBytes) throw new Error(`输入文件超过 ${limits.fileBytes} 字节上限。`);
    }
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
      // Every flag owns the line at its own position in the command line, so
      // two flags in the other order cannot swap their values.
      const requested = stdinFlagsInOrder(tokens).filter(entry => values[entry.flag]);
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
