import { ToolError } from '../core/errors.js';
import { bootstrapSession, ensureSession, requestDetail, writeSession } from '../core/douyin-session.js';
import type { PublicHttp, ToolContext } from '../contracts/tool.js';

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface DouyinVideo {
  awemeId: string;
  description: string;
  author: string;
  authorId: string;
  durationMs: number;
  cover: string;
  playUrls: string[];
  watermarkUrls: string[];
  imageUrls: string[];
  audioUrls: string[];
  audioTitle: string;
  audioDurationMs: number;
  createdAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function urlsOf(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const list = value.url_list;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

export function awemeIdFrom(value: string): string {
  const trimmed = value.trim();
  const direct = /^(\d{15,25})$/.exec(trimmed);
  if (direct) return direct[1];
  const match = /\/video\/(\d{15,25})/.exec(trimmed) || /\/share\/video\/(\d{15,25})/.exec(trimmed) || /[?&]aweme_id=(\d{15,25})/.exec(trimmed);
  if (match) return match[1];
  throw new ToolError('INVALID_INPUT', '请提供抖音视频链接或作品 ID。');
}

export function isShortLink(value: string): boolean {
  try { return new URL(value.trim()).hostname.toLowerCase() === 'v.douyin.com'; }
  catch { return false; }
}

export async function resolveShortLink(http: PublicHttp, value: string, ctx: ToolContext): Promise<string> {
  const response = await http.getRaw(value.trim(), ctx.signal, { headers: { 'user-agent': userAgent }, maxBytes: 512 * 1024 });
  return response.finalUrl;
}

function normalize(detail: Record<string, unknown>): DouyinVideo {
  const video = isRecord(detail.video) ? detail.video : {};
  const author = isRecord(detail.author) ? detail.author : {};
  const music = isRecord(detail.music) ? detail.music : {};
  const playAddr = isRecord(video.play_addr) ? video.play_addr : {};
  const downloadAddr = isRecord(video.download_addr) ? video.download_addr : {};
  const cover = isRecord(video.cover) ? video.cover : {};
  const dynamicCover = isRecord(video.dynamic_cover) ? video.dynamic_cover : {};
  const images = Array.isArray(detail.images) ? detail.images : [];
  return {
    awemeId: String(detail.aweme_id ?? ''),
    description: typeof detail.desc === 'string' ? detail.desc : '',
    author: typeof author.nickname === 'string' ? author.nickname : '',
    authorId: typeof author.sec_uid === 'string' ? author.sec_uid : '',
    durationMs: typeof video.duration === 'number' ? video.duration : 0,
    cover: urlsOf(cover)[0] ?? urlsOf(dynamicCover)[0] ?? '',
    playUrls: urlsOf(playAddr),
    watermarkUrls: urlsOf(downloadAddr),
    imageUrls: images.flatMap(item => {
      if (!isRecord(item)) return [];
      const list = item.url_list;
      return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
    }),
    audioUrls: urlsOf(music.play_url),
    audioTitle: typeof music.title === 'string' ? music.title : '',
    audioDurationMs: typeof music.duration === 'number' ? music.duration : 0,
    createdAt: typeof detail.create_time === 'number' ? new Date(detail.create_time * 1000).toISOString() : null,
  };
}

/** Chooses between the platform's clean source and its watermarked download source. */
export function selectDouyinSource(video: DouyinVideo, watermark: 'remove' | 'keep'): { url: string; source: 'no-watermark' | 'watermarked' } {
  const clean = video.playUrls[0] ?? null;
  const marked = video.watermarkUrls[0] ?? null;
  const useMarked = watermark === 'keep' && Boolean(marked);
  return { url: (useMarked ? marked : clean) ?? marked ?? clean ?? '', source: useMarked ? 'watermarked' : 'no-watermark' };
}

export async function fetchDouyinVideo(awemeId: string, ctx: ToolContext): Promise<DouyinVideo> {
  if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
  // Reuse a cached signed session; bootstrap one in the browser only when the
  // cache is missing or the platform refuses the signed request.
  const cached = await ensureSession(ctx.stateDirectory, awemeId, ctx);
  const direct = await requestDetail(cached, awemeId, ctx.http, ctx);
  if (direct.awemeDetail) return normalize(direct.awemeDetail);
  const refreshed = await bootstrapSession(awemeId, ctx.signal);
  await writeSession(ctx.stateDirectory, refreshed.session);
  const retried = await requestDetail(refreshed.session, awemeId, ctx.http, ctx);
  if (retried.awemeDetail) return normalize(retried.awemeDetail);
  // The platform rejected our signature; use the payload the page received.
  if (refreshed.detail) return normalize(refreshed.detail);
  throw new ToolError('FILE_NOT_FOUND', '未能读取该作品：作品可能不存在或已下架，也可能是抖音当前对本机发起了风控限流，请稍后重试。');
}

export async function downloadMedia(url: string, ctx: ToolContext): Promise<Uint8Array> {
  if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
  const response = await ctx.http.getBinary(url, ctx.signal, {
    headers: { 'user-agent': userAgent, referer: 'https://www.douyin.com/' },
    maxBytes: ctx.limits.downloadBytes,
  });
  return response.bytes;
}

export { userAgent as douyinUserAgent };
