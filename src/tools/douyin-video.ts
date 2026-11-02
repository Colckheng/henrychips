import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { writeUniqueFile } from '../core/file-access.js';
import { awemeIdFrom, downloadMedia, fetchDouyinVideo, isShortLink, resolveShortLink, selectDouyinSource } from './douyin-core.js';

export const douyinVideoTool = defineTool({
  name: 'douyin_video',
  title: '抖音视频提取',
  description: '解析抖音作品的标题、作者、封面、视频与音轨直链，可分别保存。通过本机 Chrome 读取官方页面数据，遇到登录墙或风控会明确报错。',
  category: 'media',
  capabilities: ['network:public', 'files:write', 'browser:local'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '作品链接或 ID', type: 'text', description: '例如 https://www.douyin.com/video/7699524083810599545' },
    { name: 'download', label: '保存到输出目录', type: 'checkbox', description: '不勾选时只返回直链，不写入文件。' },
    { name: 'watermark', label: '水印处理', type: 'select', description: '平台同时提供无水印与带水印两个源，去除即改用无水印源。', options: [
      { label: '去除水印（用无水印源）', value: 'remove' },
      { label: '保留水印（用平台下载源）', value: 'keep' },
    ] },
    { name: 'parts', label: '保存内容', type: 'select', description: '音轨来自作品音乐/原声的纯音频地址。', options: [
      { label: '仅视频', value: 'video' },
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
    description: z.string(),
    author: z.string(),
    durationMs: z.number(),
    cover: z.string(),
    createdAt: z.string().nullable(),
    source: z.enum(['no-watermark', 'watermarked']),
    noWatermarkUrl: z.string().nullable(),
    videoUrl: z.string(),
    watermarkedUrl: z.string().nullable(),
    audioUrl: z.string().nullable(),
    audioTitle: z.string(),
    audioDurationMs: z.number(),
    imageUrls: z.array(z.string()),
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
    const warnings: string[] = [];
    const noWatermarkUrl = video.playUrls[0] ?? null;
    const watermarkedUrl = video.watermarkUrls[0] ?? null;
    const { url: videoUrl, source } = selectDouyinSource(video, watermark);
    if (!videoUrl) throw new ToolError('FILE_NOT_FOUND', '该作品没有返回可用的视频地址，可能是图文作品或已受限。');
    if (!noWatermarkUrl && watermarkedUrl) warnings.push('该作品只返回了带水印地址，已按当前设置使用带水印源。');
    if (source === 'watermarked') warnings.push('当前保留水印：使用的是平台下载源，画面右下角带水印。');
    const audioUrl = video.audioUrls[0] ?? null;
    if (parts !== 'video' && !audioUrl) warnings.push('该作品没有返回独立音轨地址。');
    let savedFile: { relativePath: string; bytes: number } | null = null;
    let savedAudioFile: { relativePath: string; bytes: number } | null = null;
    if (download) {
      if (!ctx.output) throw new ToolError('ACCESS_DENIED', '当前环境未启用文件写入。');
      if (parts !== 'audio') {
        ctx.reportProgress?.({ phase: '下载视频文件', percent: 60 });
        const bytes = await downloadMedia(videoUrl, ctx);
        savedFile = await writeUniqueFile(ctx.output, `douyin-${awemeId}.mp4`, bytes);
      }
      if (parts !== 'video' && audioUrl) {
        const bytes = await downloadMedia(audioUrl, ctx);
        savedAudioFile = await writeUniqueFile(ctx.output, `douyin-${awemeId}-audio.mp3`, bytes);
      }
    }
    return {
      awemeId: video.awemeId || awemeId,
      description: video.description,
      author: video.author,
      durationMs: video.durationMs,
      cover: video.cover,
      createdAt: video.createdAt,
      videoUrl,
      source,
      noWatermarkUrl,
      watermarkedUrl,
      audioUrl,
      audioTitle: video.audioTitle,
      audioDurationMs: video.audioDurationMs,
      imageUrls: video.imageUrls,
      savedFile,
      savedAudioFile,
      warnings,
    };
  },
});
