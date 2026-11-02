import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { writeUniqueFile } from '../core/file-access.js';
import { awemeIdFrom, downloadMedia, fetchDouyinVideo, isShortLink, resolveShortLink, selectDouyinSource } from './douyin-core.js';

export const douyinNoWatermarkTool = defineTool({
  name: 'douyin_nowatermark',
  title: '抖音去水印',
  description: '解析抖音作品并返回无水印视频直链（平台播放地址），对比带水印下载地址，可单独保存无水印视频或音轨到输出目录。',
  category: 'media',
  capabilities: ['network:public', 'files:write', 'browser:local'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '作品链接或 ID', type: 'text', description: '例如作品链接 https://www.douyin.com/video/... 或作品 ID。' },
    { name: 'download', label: '保存到输出目录', type: 'checkbox', description: '不勾选时只返回直链，不写入文件。' },
    { name: 'watermark', label: '水印处理', type: 'select', description: '默认改用平台的无水印源；保留则使用带水印的下载源。', options: [
      { label: '去除水印（用无水印源）', value: 'remove' },
      { label: '保留水印（用平台下载源）', value: 'keep' },
    ] },
    { name: 'parts', label: '保存内容', type: 'select', description: '音轨来自作品音乐/原声的纯音频地址。', options: [
      { label: '仅无水印视频', value: 'video' },
      { label: '仅音频（音轨分离）', value: 'audio' },
      { label: '视频 + 音频', value: 'both' },
    ] },
  ],
  examples: [
    { label: '解析示例作品', input: { url: '7699524083810599545' } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    download: z.boolean().default(false),
    parts: z.enum(['video', 'audio', 'both']).default('video'),
    watermark: z.enum(['remove', 'keep']).default('remove'),
  }),
  outputSchema: z.strictObject({
    awemeId: z.string(),
    author: z.string(),
    description: z.string(),
    noWatermarkUrl: z.string(),
    watermarkedUrl: z.string().nullable(),
    source: z.enum(['no-watermark', 'watermarked']),
    candidates: z.array(z.string()),
    audioUrl: z.string().nullable(),
    audioTitle: z.string(),
    savedFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }).nullable(),
    savedAudioFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }).nullable(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, download, parts, watermark }, ctx) {
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    let target = url.trim();
    if (isShortLink(target)) target = await resolveShortLink(ctx.http, target, ctx);
    const awemeId = awemeIdFrom(target);
    ctx.reportProgress?.({ phase: '解析作品信息' });
    const video = await fetchDouyinVideo(awemeId, ctx);
    const cleanUrl = video.playUrls[0] ?? null;
    const markedUrl = video.watermarkUrls[0] ?? null;
    const { url: noWatermark, source } = selectDouyinSource(video, watermark);
    if (!noWatermark) throw new ToolError('FILE_NOT_FOUND', '该作品没有返回可用地址，可能是图文作品或已受限。');
    const warnings: string[] = [];
    if (markedUrl && cleanUrl) warnings.push('该作品同时提供带水印地址，可对比确认差异。');
    if (source === 'watermarked') warnings.push('当前保留水印：使用的是平台下载源，画面右下角带水印。');
    const audioUrl = video.audioUrls[0] ?? null;
    if (parts !== 'video' && !audioUrl) warnings.push('该作品没有返回独立音轨地址。');
    let savedFile: { relativePath: string; bytes: number } | null = null;
    let savedAudioFile: { relativePath: string; bytes: number } | null = null;
    if (download) {
      if (!ctx.output) throw new ToolError('ACCESS_DENIED', '未启用文件写入。');
      if (parts !== 'audio') {
        ctx.reportProgress?.({ phase: '下载无水印文件', percent: 60 });
        const bytes = await downloadMedia(noWatermark, ctx);
        savedFile = await writeUniqueFile(ctx.output, `douyin-nowatermark-${awemeId}.mp4`, bytes);
      }
      if (parts !== 'video' && audioUrl) {
        const bytes = await downloadMedia(audioUrl, ctx);
        savedAudioFile = await writeUniqueFile(ctx.output, `douyin-nowatermark-${awemeId}-audio.mp3`, bytes);
      }
    }
    return {
      awemeId: video.awemeId || awemeId,
      author: video.author,
      description: video.description,
      noWatermarkUrl: noWatermark,
      watermarkedUrl: markedUrl,
      source,
      candidates: video.playUrls,
      audioUrl,
      audioTitle: video.audioTitle,
      savedFile,
      savedAudioFile,
      warnings,
    };
  },
});
