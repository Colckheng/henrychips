import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { NetdiskSession } from './netdisk/session.js';
import { adaptersByPlatform } from './netdisk/adapters/index.js';
import { NETDISK_PLATFORM_LABELS, parseShareLink } from './netdisk/share-link.js';
import { resolveCredential } from './netdisk/credentials.js';

/** The platforms a link can be resolved for; the premium edition has no parsing interface. */
const platformEnum = z.enum(['lanzou', 'guangya', 'quark', 'uc', 'pan115', 'c139', 'pan123', 'xunlei', 'baidu']);

export const netdiskResolveTool = defineTool({
  name: 'netdisk_resolve',
  title: '网盘分享解析',
  description: '解析夸克 / UC / 迅雷 / 百度 / 139 / 123 / 115 / 光鸭 / 蓝奏云的分享链接，列出分享内的文件并给出已验证的下载直链与所需请求头。直链通常十几分钟内有效，请尽快使用。',
  category: 'web',
  capabilities: ['network:public'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '分享链接或文案', type: 'textarea', description: '可以整段粘贴分享文案，工具会自动找出链接与提取码。' },
    { name: 'code', label: '提取码', type: 'text', description: '不填则自动从文案中识别。' },
    { name: 'platform', label: '网盘平台', type: 'select', description: '默认自动识别。', options: [
      { label: '自动识别', value: 'auto' },
      ...Object.entries(NETDISK_PLATFORM_LABELS)
        .filter(([key]) => key !== 'ilanzou')
        .map(([key, label]) => ({ label, value: key })),
    ] },
    { name: 'mode', label: '解析深度', type: 'select', description: '只列文件更快；取直链会对每个文件额外发请求。', options: [
      { label: '列出文件并取直链', value: 'link' },
      { label: '只列出文件', value: 'list' },
    ] },
    { name: 'paths', label: '指定文件路径', type: 'textarea', description: '每行一个分享内的相对路径，只给这些文件取直链。留空表示全部文件。' },
    { name: 'maxLinks', label: '最多取几条直链', type: 'number', description: '默认 10，上限 50。受单次执行 120 秒限制。' },
  ],
  examples: [
    { label: '解析一个分享链接', input: { url: 'https://pan.quark.cn/s/替换为你的分享码' } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    code: z.string().optional(),
    platform: z.union([z.literal('auto'), platformEnum]).default('auto'),
    mode: z.enum(['list', 'link']).default('link'),
    paths: z.array(z.string()).optional(),
    maxLinks: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.strictObject({
    platform: platformEnum,
    platformLabel: z.string(),
    shareId: z.string(),
    title: z.string(),
    fileCount: z.number(),
    totalBytes: z.number().nullable(),
    files: z.array(z.strictObject({
      id: z.string(), path: z.string(), name: z.string(),
      sizeBytes: z.number().nullable(), isDirectory: z.boolean(), modifiedAt: z.string().optional(),
      // A member of a folder share carries the signed address of the platform
      // in this field, so it has to survive the round trip through the output.
      fidToken: z.string().optional(),
    })),
    // The link of a platform carries fields of its own, so the shape is not
    // closed here; a field a platform adds must reach the caller.
    links: z.array(z.object({}).passthrough()),
    linkFailures: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
    credentialUsed: z.boolean(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, code, platform, mode, paths, maxLinks }, ctx) {
    const parsed = parseShareLink(url);
    if (!parsed) throw new ToolError('INVALID_INPUT', '无法识别该链接的网盘平台，请确认是完整的分享链接或分享文案。');
    // The premium edition has no public parsing interface, so the link is
    // refused by name instead of being handed to another platform.
    if (parsed.platform === 'ilanzou') {
      throw new ToolError('UNSUPPORTED_FORMAT', '蓝奏云优享版（ilanzou）官方没有分享解析接口，暂不支持。');
    }
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    if (platform !== 'auto' && platform !== parsed.platform) {
      throw new ToolError('INVALID_INPUT', `链接识别为${NETDISK_PLATFORM_LABELS[parsed.platform]}，与指定的平台不一致。`);
    }
    const adapter = adaptersByPlatform.get(parsed.platform);
    if (!adapter) throw new ToolError('UNSUPPORTED_FORMAT', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 暂未接入解析。`);
    const credential = resolveCredential(parsed.platform, ctx.stateDirectory);
    if (adapter.requiresCredential && !credential) {
      throw new ToolError('ACCESS_DENIED', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 需要登录态，请先执行 npm run cli -- credentials set ${parsed.platform} 配置凭证。`);
    }
    const session = new NetdiskSession({ http: ctx.http, signal: ctx.signal });
    const context = {
      session,
      shareId: parsed.shareId,
      shareUrl: parsed.shareUrl,
      code: code?.trim() || parsed.code,
      credential,
      signal: ctx.signal,
      reportProgress: (phase: string, percent?: number) => ctx.reportProgress?.({ phase, percent }),
    };
    ctx.reportProgress?.({ phase: '读取分享内容' });
    const share = await adapter.list(context);
    const files = share.files;
    const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) || null;
    const warnings: string[] = [];
    if (files.length > 500) warnings.push(`分享内有 ${files.length} 个条目，仅列出前 500 个。`);
    if (mode === 'list') {
      return {
        platform: parsed.platform, platformLabel: adapter.label, shareId: parsed.shareId,
        title: share.title, fileCount: files.length, totalBytes, files, links: [],
        linkFailures: [], credentialUsed: Boolean(credential), warnings,
      };
    }
    const wanted = paths?.length
      ? files.filter(file => paths.includes(file.path))
      : files.filter(file => !file.isDirectory);
    // A path that is not in the share would look like a file that was skipped
    // on purpose, so it is named in the warnings.
    if (paths?.length) {
      const missing = paths.filter(path => !files.some(file => file.path === path));
      if (missing.length) warnings.push(`以下路径不在该分享中：${missing.join('、')}。`);
    }
    const targets = wanted.slice(0, maxLinks);
    if (wanted.length > targets.length) {
      warnings.push(`共 ${wanted.length} 个可取链文件，本次只处理前 ${targets.length} 个。`);
    }
    const links: Array<Record<string, unknown>> = [];
    const linkFailures: Array<{ path: string; reason: string }> = [];
    for (const [index, file] of targets.entries()) {
      ctx.reportProgress?.({ phase: `取直链 ${index + 1}/${targets.length}` });
      try {
        links.push({ ...(await adapter.link(context, file)) });
      } catch (error) {
        // A file that cannot be resolved is an outcome of that file alone, so
        // the links of the other files are still handed out.
        linkFailures.push({ path: file.path, reason: error instanceof Error ? error.message : '取链失败' });
      }
    }
    if (links.length) warnings.push('直链通常在十几分钟内过期，请尽快下载。');
    return {
      platform: parsed.platform, platformLabel: adapter.label, shareId: parsed.shareId,
      title: share.title, fileCount: files.length, totalBytes, files, links, linkFailures,
      credentialUsed: Boolean(credential), warnings,
    };
  },
});
