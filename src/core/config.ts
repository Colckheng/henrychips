import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Locates the directory that holds the built assets and the config file. The
 * lookup stays lazy: a packaged build keeps the code inside an archive, where
 * no config file exists, so the search must not run at import time.
 */
export function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'workstation.config.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('无法定位工作站配置，请确认项目文件完整。');
    dir = parent;
  }
  return dir;
}
let cachedProjectRoot: string | undefined;
export function getProjectRoot(): string {
  cachedProjectRoot ??= findProjectRoot();
  return cachedProjectRoot;
}

const positive = z.number().int().positive();
const relaySchema = z.strictObject({
  address: z.string().min(1),
  deviceToken: z.string().min(8).max(256),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1).max(60),
  relayToken: z.string().min(8).max(256).optional(),
});
export const configSchema = z.strictObject({
  workspaceRoot: z.string().min(1),
  stateDirectory: z.string().min(1),
  outputDirectory: z.string().min(1),
  http: z.strictObject({ host: z.literal('127.0.0.1'), port: positive.max(65535) }),
  network: z.strictObject({ enabled: z.boolean() }),
  limits: z.strictObject({ fileBytes: positive, csvRows: positive, directoryEntries: positive, pdfPages: positive, webBytes: positive, downloadBytes: positive, outputBytes: positive, toolTimeoutMs: positive.max(120000) }),
  relay: relaySchema.optional(),
});
export type WorkstationConfig = z.infer<typeof configSchema> & { configPath: string };

export async function loadConfig(configPath = path.join(getProjectRoot(), 'workstation.config.json')): Promise<WorkstationConfig> {
  if (!path.isAbsolute(configPath)) throw new Error('配置文件必须使用绝对路径。');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('无法读取配置文件或 JSON 格式错误。'); }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`配置无效：${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`);
  const base = path.dirname(configPath);
  const workspaceRoot = path.resolve(base, parsed.data.workspaceRoot);
  try { if (!(await stat(workspaceRoot)).isDirectory()) throw new Error(); }
  catch { throw new Error('配置中的 workspaceRoot 必须是已存在的目录。'); }
  const outputDirectory = path.resolve(base, parsed.data.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const stateDirectory = path.resolve(base, parsed.data.stateDirectory);
  return {
    ...parsed.data,
    workspaceRoot: await realpath(workspaceRoot),
    outputDirectory: await realpath(outputDirectory),
    stateDirectory,
    configPath,
  };
}
