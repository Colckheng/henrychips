import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASE = 'https://api.guangyapan.com';
const WEB_SITE = 'https://www.guangyapan.com';
/** The web client of the platform is the only one that may list a share. */
const CLIENT_ID = '0982a450-3342-3c45-9d05-b1c2bf72e0f6';
const PAGE_SIZE = 100;

/** The business answer of the platform, before it is looked at closely. */
interface GuangYaAnswer {
  code?: number;
  msg?: string;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * The adapter of the guangya share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type GuangYaAdapter = NetdiskAdapter & {
  /** Decides whether another page of a folder share exists. */
  hasMore(answer: Record<string, unknown>, offset: number, pageSize: number): boolean;  /** Reads the entries of a file list answer. */
  parseEntries(data: unknown): NetdiskFile[];
  /** Reads the title of a share. */
  parseTitle(data: unknown): string;
  /** Turns the business code of the platform into a message. */
  describeError(code: number, message: string): string;
  request(context: AdapterContext, path: string, body: Record<string, unknown>): Promise<GuangYaAnswer>;
};

/** The platform answers with a business code instead of a status. */
function businessCode(answer: GuangYaAnswer): number {
  return typeof answer.code === 'number' ? answer.code : 0;
}

/**
 * The headers the platform expects. The `Referer` of the site is what a
 * download address is checked against, so it has to be part of them.
 */
function headersOf(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': WEB_UA,
    Origin: WEB_SITE,
    Referer: `${WEB_SITE}/`,
    dt: '4',
  };
}

/** The entries of a folder share, with the folder flag under either key. */
function entriesOf(data: unknown): NetdiskFile[] {
  const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const raw = Array.isArray(root.text) ? root.text : Array.isArray(root.list) ? root.list : [];
  const files: NetdiskFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!id) continue;
    const name = typeof entry.name === 'string' ? entry.name : id;
    const isDirectory = entry.is_folder === 1 || entry.is_folder === true
      || entry.isdir === 1 || entry.isdir === true || entry.is_dir === 1 || entry.is_dir === true;
    const size = Number(entry.size ?? 0);
    files.push({
      id,
      path: isDirectory ? `${name}/` : name,
      name,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
      isDirectory,
      modifiedAt: typeof entry.update_time === 'string' ? entry.update_time : undefined,
    });
  }
  return files;
}

export const guangyaAdapter: GuangYaAdapter = {
  platform: 'guangya',
  label: '光鸭云盘',
  requiresCredential: false,

  hasMore(answer, offset, pageSize) {
    if (typeof answer.hasMore === 'boolean') return answer.hasMore;
    if (answer.has_more === true || answer.has_more === 1) return true;
    if (answer.hasMore === false || answer.has_more === false || answer.has_more === 0) return false;
    const total = Number(answer.total ?? Number.NaN);
    if (Number.isFinite(total)) {
      // The cursor of the platform is the offset of the next page, so the
      // comparison is against the number of entries that were already sent.
      const cursor = Number(answer.cursor ?? answer.nextCursor ?? Number.NaN);
      const next = Number.isFinite(cursor) ? cursor : offset + pageSize;
      return next < total;
    }
    // Without a total the only sign left is a full page that came with a
    // cursor for the next one.
    const cursor = answer.cursor ?? answer.nextCursor;
    return offset + pageSize >= 0 && pageSize > 0 && Boolean(cursor);
  },

  parseEntries(data) {
    return entriesOf(data);
  },

  parseTitle(data) {
    if (!data || typeof data !== 'object') return '';
    const root = data as Record<string, unknown>;
    const title = root.title ?? root.shareTitle ?? root.name;
    return typeof title === 'string' ? title : '';
  },

  describeError(code, message) {
    if (code === 207) return '该文件需要先转存到账号才能下载，请先登录光鸭云盘。';
    if (code === 401 || code === 403) return '该分享需要登录或已失效。';
    if (code === 404) return '分享不存在或已经取消。';
    if (code === 429) return '光鸭云盘请求过于频繁，请稍后重试。';
    return message || `光鸭云盘返回了未知的业务码 ${code}。`;
  },

  async request(context: AdapterContext, path: string, body: Record<string, unknown>): Promise<GuangYaAnswer> {
    const response = await context.session.postJson(`${API_BASE}${path}`, { client_id: CLIENT_ID, ...body }, headersOf());
    const answer = (response.data ?? {}) as GuangYaAnswer;
    const code = businessCode(answer);
    if (code !== 0 && code !== 200) {
      const message = typeof answer.msg === 'string' ? answer.msg : typeof answer.message === 'string' ? answer.message : '';
      throw new ToolError('TOOL_FAILED', this.describeError(code, message));
    }
    return answer;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const summary = await this.request(context, '/userres/v1/get_share_summary', { shareId: context.shareId });
    const title = this.parseTitle(summary.data);
    const token = await this.request(context, '/userres/v1/get_share_access_token', {
      shareId: context.shareId,
      code: context.code ?? '',
    });
    const tokenValue = typeof (token.data as Record<string, unknown> | undefined)?.accessToken === 'string'
      ? String((token.data as Record<string, unknown>).accessToken) : '';
    if (!tokenValue) throw new ToolError('TOOL_FAILED', '光鸭云盘没有返回访问令牌，提取码可能不正确。');

    const files: NetdiskFile[] = [];
    let offset = 0;
    let cursor = '';
    for (let page = 0; page < 500; page++) {
      const answer = await this.request(context, '/userres/v1/get_share_page_files_list', {
        shareId: context.shareId,
        accessToken: tokenValue,
        parentId: '',
        offset,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      const entries = this.parseEntries(answer.data);
      files.push(...entries);
      const data = (answer.data ?? {}) as Record<string, unknown>;
      const next = typeof data.cursor === 'string' ? data.cursor : typeof data.nextCursor === 'string' ? data.nextCursor : '';
      if (!this.hasMore(answer, offset, PAGE_SIZE) || !next || next === cursor) break;
      cursor = next;
      offset += entries.length;
      if (!entries.length) break;
    }
    return { title: title || '光鸭分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const token = await this.request(context, '/userres/v1/get_share_access_token', {
      shareId: context.shareId,
      code: context.code ?? '',
    });
    const tokenValue = typeof (token.data as Record<string, unknown> | undefined)?.accessToken === 'string'
      ? String((token.data as Record<string, unknown>).accessToken) : '';
    const answer = await this.request(context, '/userres/v1/get_share_download_url', {
      shareId: context.shareId,
      accessToken: tokenValue,
      fileId: file.id,
    });
    const data = (answer.data ?? {}) as Record<string, unknown>;
    const url = typeof data.url === 'string' ? data.url : typeof data.downloadUrl === 'string' ? data.downloadUrl : '';
    if (!url) throw new ToolError('TOOL_FAILED', '光鸭云盘没有返回下载地址。');
    const headers = { ...headersOf(), Referer: `${WEB_SITE}/` };
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `光鸭云盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    const rangeSupported = probe.status === 206 || probe.acceptRanges === 'bytes';
    return {
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
      url,
      headers,
      rangeSupported,
      source: { platform: 'guangya', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
    };
  },
};
