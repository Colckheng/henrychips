import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import type { ToolContext } from '../contracts/tool.js';
import { writeUniqueFile } from '../core/file-access.js';

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** Bilibili media CDNs serve streams on the default ports and on 8080/8082. */
const mediaPorts = [80, 443, 8080, 8082];

function bvidOf(value: string): string {
  const trimmed = value.trim();
  const direct = /^BV[0-9A-Za-z]{10}$/.exec(trimmed);
  if (direct) return direct[0];
  const fromUrl = /(BV[0-9A-Za-z]{10})/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  throw new ToolError('INVALID_INPUT', '请提供有效的 BV 号或 B 站视频链接。');
}

function cookiesFrom(setCookie: string[]): string {
  const values = setCookie
    .map(line => line.split(';')[0]?.trim() ?? '')
    .filter(pair => pair && pair.includes('='));
  return values.join('; ');
}

interface ViewResponse {
  code: number;
  message?: string;
  data?: {
    bvid?: string; aid?: number; title?: string; desc?: string; pic?: string;
    duration?: number; owner?: { name?: string; mid?: number };
    pages?: Array<{ cid: number; page: number; part?: string; duration?: number }>;
  };
}

interface PlayUrlResponse {
  code: number;
  message?: string;
  data?: {
    quality?: number; format?: string; timelength?: number;
    durl?: Array<{ url: string; size: number; backup_url?: string[] }>;
    dash?: {
      duration?: number;
      video?: Array<{ id: number; codecs: string; bandwidth: number; baseUrl: string; backupUrl?: string[] }>;
      audio?: Array<{ id: number; codecs: string; bandwidth: number; baseUrl: string; backupUrl?: string[] }>;
    };
  };
}

async function downloadWithFallback(ctx: ToolContext, url: string, backups: string[], bvid: string): Promise<Uint8Array> {
  const candidates = [url, ...backups];
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      const response = await ctx.http!.getBinary(candidate, ctx.signal, {
        headers: { 'user-agent': userAgent, referer: `https://www.bilibili.com/video/${bvid}` },
        maxBytes: ctx.limits.downloadBytes,
        allowedPorts: mediaPorts,
      });
      return response.bytes;
    } catch (error) { failure = error; }
  }
  throw failure instanceof ToolError ? failure : new ToolError('NETWORK_ERROR', '媒体文件下载失败，已尝试备用镜像。');
}

export const bilibiliVideoTool = defineTool({
  name: 'bilibili_video',
  title: 'B站视频提取',
  description: '解析 B 站视频信息与可下载的媒体直链，可分别保存视频与独立音轨（DASH 音频流）。需要网络访问，链接与视频需公开可见。',
  category: 'media',
  capabilities: ['network:public', 'files:write'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '视频链接或 BV 号', type: 'text', description: '例如 BV1ugxq6HEfH 或 https://www.bilibili.com/video/BV1ugxq6HEfH' },
    { name: 'download', label: '保存到输出目录', type: 'checkbox', description: '不勾选时只返回直链，不写入文件。' },
    { name: 'watermark', label: '水印处理', type: 'select', description: '去除即改用 DASH 原始视频流（社区“无水印下载”的做法）；保留则用单文件转码 MP4。', options: [
      { label: '去除水印（用原始流）', value: 'remove' },
      { label: '保留（用单文件 MP4）', value: 'keep' },
    ] },
    { name: 'parts', label: '保存内容', type: 'select', description: '视频为 MP4 单文件；音轨来自 DASH 独立音频流。', options: [
      { label: '仅视频', value: 'video' },
      { label: '仅音频（音轨分离）', value: 'audio' },
      { label: '视频 + 音频', value: 'both' },
    ] },
  ],
  examples: [
    { label: '解析示例视频', input: { url: 'BV1ugxq6HEfH' } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    download: z.boolean().default(false),
    parts: z.enum(['video', 'audio', 'both']).default('video'),
    watermark: z.enum(['remove', 'keep']).default('remove'),
  }),
  outputSchema: z.strictObject({
    bvid: z.string(),
    title: z.string(),
    description: z.string(),
    durationSeconds: z.number(),
    owner: z.string(),
    cover: z.string(),
    pageCount: z.number(),
    source: z.enum(['original-dash', 'transcoded-mp4']),
    streams: z.array(z.strictObject({
      kind: z.enum(['video', 'audio']),
      label: z.string(),
      codecs: z.string(),
      url: z.string(),
      sizeBytes: z.number().nullable(),
    })),
    audioUrl: z.string().nullable(),
    savedFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }).nullable(),
    savedAudioFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }).nullable(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, download, parts, watermark }, ctx) {
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    const bvid = bvidOf(url);
    // The public finger endpoint hands out the buvid3 cookie that the video
    // APIs expect, without downloading a full page.
    ctx.reportProgress?.({ phase: '获取 B 站会话' });
    const session = await ctx.http.getRaw('https://api.bilibili.com/x/frontend/finger/spi', ctx.signal, {
      headers: { 'user-agent': userAgent, 'accept-language': 'zh-CN,zh;q=0.9' },
      maxBytes: 64 * 1024,
    });
    const cookie = cookiesFrom(session.setCookie);
    const headers = { 'user-agent': userAgent, referer: `https://www.bilibili.com/video/${bvid}`, 'accept-language': 'zh-CN,zh;q=0.9', ...(cookie ? { cookie } : {}) };
    ctx.reportProgress?.({ phase: '读取稿件信息' });
    const viewResponse = await ctx.http.getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, ctx.signal, { headers });
    const view = viewResponse.data as ViewResponse;
    if (!view || view.code !== 0 || !view.data?.pages?.length) {
      throw new ToolError('FILE_NOT_FOUND', '未能读取该视频，可能是稿件不存在、已失效或需要登录。');
    }
    const info = view.data;
    const cid = info.pages![0].cid;
    const warnings: string[] = [];
    const streams: Array<{ kind: 'video' | 'audio'; label: string; codecs: string; url: string; sizeBytes: number | null }> = [];
    let savedFile: { relativePath: string; bytes: number } | null = null;
    let savedAudioFile: { relativePath: string; bytes: number } | null = null;
    let durationMs = typeof info.duration === 'number' ? info.duration * 1000 : 0;
    let audioUrl: string | null = null;
    let combinedUrl: string | null = null;
    let originalUrl: string | null = null;
    let originalBackups: string[] = [];
    let audioBackups: string[] = [];
    const source = watermark === 'keep' ? 'transcoded-mp4' as const : 'original-dash' as const;

    if (parts === 'video' || parts === 'both' || watermark === 'keep') {
      const playResponse = await ctx.http.getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=0&platform=html5&high_quality=1`, ctx.signal, { headers });
      const play = playResponse.data as PlayUrlResponse;
      const durl = play?.data?.durl?.[0];
      if (!durl) throw new ToolError('UNSUPPORTED_FORMAT', '该视频没有返回可下载的 MP4 直链，可能需要登录或已限制下载。');
      if (play.data?.timelength) durationMs = play.data.timelength;
      combinedUrl = durl.url;
      streams.push({ kind: 'video', label: `MP4 清晰度 ${play.data?.quality ?? 64}`, codecs: 'avc1', url: durl.url, sizeBytes: durl.size ?? null });
    }
    if (parts !== 'video' || watermark === 'remove') {
      const playResponse = await ctx.http.getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=16&fourk=1`, ctx.signal, { headers });
      const play = playResponse.data as PlayUrlResponse;
      const dash = play?.data?.dash;
      if (!dash) throw new ToolError('UNSUPPORTED_FORMAT', '该视频没有返回 DASH 流信息，无法分离音轨或取原始流。');
      if (!durationMs && typeof dash.duration === 'number') durationMs = dash.duration * 1000;
      for (const item of dash.video ?? []) streams.push({ kind: 'video', label: `视频 ${item.id}`, codecs: item.codecs, url: item.baseUrl, sizeBytes: null });
      for (const item of dash.audio ?? []) streams.push({ kind: 'audio', label: `音频 ${item.id}`, codecs: item.codecs, url: item.baseUrl, sizeBytes: null });
      const bestVideo = (dash.video ?? []).sort((left, right) => right.bandwidth - left.bandwidth)[0];
      originalUrl = bestVideo?.baseUrl ?? null;
      originalBackups = bestVideo?.backupUrl ?? [];
      const bestAudio = (dash.audio ?? []).sort((left, right) => right.bandwidth - left.bandwidth)[0];
      audioUrl = bestAudio?.baseUrl ?? null;
      audioBackups = bestAudio?.backupUrl ?? [];
      if (!audioUrl) warnings.push('该视频没有返回独立音频流。');
      if (watermark === 'remove') {
        warnings.push('已选择原始 DASH 视频流：B 站接口不提供“水印版/无水印版”两套源，平台不会在文件里烧制水印；若水印已烧录在源片中，需要重编码裁剪才能去除。');
      }
    }

    if (download) {
      if (!ctx.output) throw new ToolError('ACCESS_DENIED', '当前环境未启用文件写入。');
      const videoUrl = watermark === 'remove' ? originalUrl : combinedUrl;
      if (parts !== 'audio') {
        if (!videoUrl) throw new ToolError('UNSUPPORTED_FORMAT', '没有可保存的视频流。');
        ctx.reportProgress?.({ phase: '下载视频文件', percent: 40 });
        const media = await downloadWithFallback(ctx, videoUrl, watermark === 'remove' ? originalBackups : [], bvid);
        const name = watermark === 'remove' ? `${bvid}-video.m4s` : `${bvid}.mp4`;
        savedFile = await writeUniqueFile(ctx.output, name, media);
      }
      if (parts !== 'video' && audioUrl) {
        ctx.reportProgress?.({ phase: '下载音轨文件', percent: 70 });
        const audio = await downloadWithFallback(ctx, audioUrl, audioBackups, bvid);
        savedAudioFile = await writeUniqueFile(ctx.output, `${bvid}-audio.m4a`, audio);
      }
    }

    return {
      bvid,
      title: info.title ?? '',
      description: info.desc ?? '',
      durationSeconds: Math.round(durationMs / 1000),
      owner: info.owner?.name ?? '',
      cover: info.pic ?? '',
      pageCount: info.pages!.length,
      source,
      streams,
      audioUrl,
      savedFile,
      savedAudioFile,
      warnings,
    };
  },
});
