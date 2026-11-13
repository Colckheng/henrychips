import { ToolError } from '../../../core/errors.js';
import { cookieValue } from '../session.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** The download endpoint only answers the client that asks for it. */
const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 uc-cloud-drive';
const API_BASE = 'https://pc-api.uc.cn';
const WEB_SITE = 'https://fast.uc.cn';
const PAGE_SIZE = 50;

/** The business answer of the platform, before it is looked at closely. */
interface UcAnswer {
  status?: number;
  code?: number;
  message?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * The adapter of the uc share link. The object holds the pure helpers next
 * to the protocol methods, so a helper can be tested without a network.
 */
export type UcAdapter = NetdiskAdapter & {
  parseShareToken(data: unknown): { stoken: string; title: string; firstFid: string };
  parseEntries(data: unknown): NetdiskFile[];
  describeError(code: number, message: string): string;
  /** The guest token of the platform, which the CDN demands back. */
  readGuestToken(answer: UcAnswer): string;
};

/** The headers the platform expects on a share request. */
function headersOf(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': CLIENT_UA,
    Origin: WEB_SITE,
    Referer: `${WEB_SITE}/`,
  };
}

export const ucAdapter: UcAdapter = {
  platform: 'uc',
  label: 'UC 网盘',
  requiresCredential: false,

  parseShareToken(data) {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const stoken = typeof root.stoken === 'string' ? root.stoken : '';
    const title = typeof root.title === 'string' ? root.title : '';
    const firstFid = typeof root.first_fid === 'string' ? root.first_fid : '';
    return { stoken, title, firstFid };
  },

  parseEntries(data) {
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const detail = root.detail_info && typeof root.detail_info === 'object' ? root.detail_info as Record<string, unknown> : {};
    const raw = Array.isArray(root.list) ? root.list : Array.isArray(detail.list) ? detail.list : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const fid = typeof entry.fid === 'string' ? entry.fid : '';
      if (!fid) continue;
      const name = typeof entry.file_name === 'string' ? entry.file_name : fid;
      const isDirectory = entry.dir === true || entry.dir === 1;
      const size = Number(entry.size ?? 0);
      const token = typeof entry.share_fid_token === 'string' ? entry.share_fid_token : undefined;
      files.push({
        id: fid,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.updated_at === 'string' ? entry.updated_at : undefined,
        fidToken: token,
      });
    }
    return files;
  },

  describeError(code, message) {
    if (code === 23018) return '超出了夸克游客下载的大小上限，请登录后重试。';
    if (code === 31001) return 'UC 网盘需要登录才能取到下载地址，请先配置凭证。';
    if (code === 14001 || code === 41020) return '分享令牌已失效，请重新获取分享链接。';
    if (code === 404) return '分享不存在或已经取消。';
    if (code === 429) return 'UC 网盘请求过于频繁，请稍后重试。';
    return message || `UC 网盘返回了未知的业务码 ${code}。`;
  },

  readGuestToken(answer) {
    const item = Array.isArray(answer.data) ? answer.data[0] : undefined;
    const fromItem = item && typeof item === 'object' ? (item as Record<string, unknown>).__pugs : undefined;
    if (typeof fromItem === 'string' && fromItem) return fromItem;
    const top = answer.__pugs;
    return typeof top === 'string' ? top : '';
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const tokenResponse = await context.session.postJson(
      `${API_BASE}/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc`,
      { pwd_id: context.shareId, passcode: context.code ?? '', share_for_transfer: true },
      headersOf(),
    );
    const tokenAnswer = (tokenResponse.data ?? {}) as UcAnswer;
    const token = this.parseShareToken(tokenAnswer.data);
    if (!token.stoken) throw new ToolError('TOOL_FAILED', 'UC 网盘没有返回分享令牌，提取码可能不正确。');

    const files: NetdiskFile[] = [];
    let page = 1;
    for (; page <= 500; page++) {
      const query = new URLSearchParams({
        entry: 'ft', fr: 'pc', pr: 'UCBrowser',
        pwd_id: context.shareId,
        pdir_fid: token.firstFid,
        fetch_file_list: '1',
        passcode: context.code ?? '',
        _page: String(page),
        _size: String(PAGE_SIZE),
        _fetch_total: '1',
        _fetch_task: '1',
        _fetch_share: '1',
        _sort: '',
        stoken: token.stoken,
      });
      const listResponse = await context.session.get(
        `${API_BASE}/1/clouddrive/transfer_share/detail?${query.toString()}`,
        headersOf(),
      );
      const listAnswer = (listResponse.data ?? {}) as UcAnswer;
      const entries = this.parseEntries(listAnswer.data);
      files.push(...entries);
      const total = Number((listAnswer.data as Record<string, unknown> | undefined)?.total ?? Number.NaN);
      if (!entries.length) break;
      if (Number.isFinite(total) && files.length >= total) break;
    }
    return { title: token.title || 'UC 分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const tokenResponse = await context.session.postJson(
      `${API_BASE}/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc`,
      { pwd_id: context.shareId, passcode: context.code ?? '', share_for_transfer: true },
      headersOf(),
    );
    const tokenAnswer = (tokenResponse.data ?? {}) as UcAnswer;
    const token = this.parseShareToken(tokenAnswer.data);
    if (!token.stoken) throw new ToolError('TOOL_FAILED', 'UC 网盘没有返回分享令牌。');
    const fidToken = file.fidToken;
    if (!fidToken) {
      throw new ToolError('TOOL_FAILED', '这个文件没有分享令牌，无法取到下载地址，请重新读取分享内容。');
    }
    const response = await context.session.postJson(
      `${API_BASE}/1/clouddrive/file/download?entry=ft&fr=pc&pr=UCBrowser`,
      { fids: [file.id], pwd_id: context.shareId, stoken: token.stoken, fids_token: [fidToken] },
      headersOf(),
    );
    const answer = (response.data ?? {}) as UcAnswer;
    const status = typeof answer.status === 'number' ? answer.status : 0;
    if (status !== 200) {
      const code = typeof answer.code === 'number' ? answer.code : status;
      throw new ToolError('TOOL_FAILED', this.describeError(code, typeof answer.message === 'string' ? answer.message : ''));
    }
    const item = Array.isArray(answer.data) ? answer.data[0] : undefined;
    const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const url = typeof entry.download_url === 'string' ? entry.download_url : '';
    if (!url) throw new ToolError('TOOL_FAILED', 'UC 网盘没有返回下载地址。');
    // The platform hands out the token of the guest in the `Set-Cookie` of
    // the answer, and the token is bound to the very answer it came with.
    // The token has to travel with a request to the CDN, which is a
    // different host, so it cannot stay in the jar of the host that
    // answered.
    const guestToken = this.readGuestToken(answer)
      || cookieValue(response.setCookie, '__pugs')
      || '';
    const headers: Record<string, string> = { ...headersOf(), 'User-Agent': WEB_UA };
    if (guestToken) {
      // The CDN refuses the download without the guest token, so it has to
      // travel with the link.
      headers.Cookie = `__pugs=${guestToken}`;
      context.session.setCookie(url, '__pugs', guestToken);
    }
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `UC 网盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    return {
      path: file.path,
      name: typeof entry.file_name === 'string' && entry.file_name ? entry.file_name : file.name,
      sizeBytes: typeof entry.size === 'number' ? entry.size : file.sizeBytes,
      url,
      headers,
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: { platform: 'uc', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
      note: guestToken ? undefined : '这个下载地址没有游客令牌，可能需要登录后才能下载。',
    };
  },
};
