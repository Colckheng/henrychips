import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { NetdiskSession } from './netdisk/session.js';
import { adaptersByPlatform } from './netdisk/adapters/index.js';
import { NETDISK_PLATFORM_LABELS, parseShareLink } from './netdisk/share-link.js';
import { resolveCredential } from './netdisk/credentials.js';
import { safeOutputPath } from './netdisk/paths.js';
import type { NetdiskLink } from './netdisk/types.js';

export const netdiskDownloadTool = defineTool({
  name: 'netdisk_download',
  title: '网盘文件下载',
  description: '解析网盘分享链接并把选中的文件加入下载队列。默认由工作站自己分片下载并断点续传；也可以把链接推给本机 Neat Download Manager 接管。任务在后台运行。',
  category: 'web',
  capabilities: ['network:public', 'files:write', 'downloader:local'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '分享链接或文案', type: 'textarea', description: '可以整段粘贴分享文案。' },
    { name: 'code', label: '提取码', type: 'text' },
    { name: 'paths', label: '要下载的文件路径', type: 'textarea', description: '每行一个分享内的相对路径。' },
    { name: 'backend', label: '下载方式', type: 'select', description: '默认由工作站自己下载。', options: [
      { label: '工作站内置下载（默认）', value: 'builtin' },
      { label: '交给 Neat Download Manager', value: 'ndm' },
    ] },
  ],
  examples: [
    { label: '下载一个分享里的文件', input: { url: 'https://pan.quark.cn/s/替换为你的分享码', paths: ['文件名'] } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    code: z.string().optional(),
    paths: z.array(z.string().min(1)).min(1),
    backend: z.enum(['builtin', 'ndm']).default('builtin'),
  }),
  outputSchema: z.strictObject({
    taskIds: z.array(z.string()),
    backend: z.enum(['builtin', 'ndm']),
    platform: z.string(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, code, paths, backend }, ctx) {
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    if (backend === 'builtin' && !ctx.downloads) throw new ToolError('ACCESS_DENIED', '当前环境未启用下载任务。');
    const parsed = parseShareLink(url);
    if (!parsed) throw new ToolError('INVALID_INPUT', '无法识别该链接的网盘平台，请确认是完整的分享链接或分享文案。');
    if (parsed.platform === 'ilanzou') {
      throw new ToolError('UNSUPPORTED_FORMAT', '蓝奏云优享版（ilanzou）官方没有分享解析接口，暂不支持。');
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
    const wanted = share.files.filter(file => paths.includes(file.path));
    if (!wanted.length) throw new ToolError('FILE_NOT_FOUND', '分享里没有找到指定的文件路径。');
    const taskIds: string[] = [];
    const warnings: string[] = [];
    for (const [index, file] of wanted.entries()) {
      ctx.reportProgress?.({ phase: `取直链 ${index + 1}/${wanted.length}` });
      let link: NetdiskLink;
      try { link = await adapter.link(context, file); }
      catch (error) {
        warnings.push(`${file.path}：${error instanceof Error ? error.message : '取链失败'}`);
        continue;
      }
      if (backend === 'ndm') {
        // The protocol of the local downloader hands out no task id and no
        // progress, so the file is pushed and the work station stops
        // watching it.
        if (!ctx.ndm) throw new ToolError('ACCESS_DENIED', '当前环境未启用本机下载器对接。');
        await ctx.ndm.send({ url: link.url, fileName: file.name, headers: link.headers });
        taskIds.push(`ndm-${Date.now()}-${index}`);
        continue;
      }
      const task = ctx.downloads!.create({
        platform: parsed.platform, title: share.title, fileName: file.name, filePath: file.path,
        sizeBytes: file.sizeBytes, backend, source: link.source,
        outputPath: safeOutputPath(file.path, file.name), link,
      });
      taskIds.push(task.id);
    }
    if (!taskIds.length) throw new ToolError('TOOL_FAILED', '所有文件都没能取到直链。');
    return { taskIds, backend, platform: parsed.platform, warnings };
  },
});
