import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const CLIENT_UA_VERSION_URL = 'https://appversion.115.com/1/web/1.0/api/chrome';
const CLIENT_UA_VERSION_FALLBACK = '36.0.1';
const API_BASE = 'https://webapi.115.com';
const SHARE_HOST = 'https://115cdn.com';
const REFERER = 'https://115.com/';
const ROOT_CID = '0';
const PAGE_SIZE = 100;

/** The answer of the platform, before it is looked at closely. */
interface Pan115Answer {
  state?: boolean;
  code?: number;
  message?: string;
  error?: string;
  msg?: string;
  data?: unknown;
  [key: string]: unknown;
}

/**
 * The error codes of the platform, which say what went wrong without the
 * message of the platform having to be read.
 */
const ERRNO_MESSAGES = new Map<number, string>([
  [990001, '115 网盘的登录态已过期，请重新配置凭证。'],
  [4100012, '这个分享需要提取码，请提供后重试。'],
  [4100008, '提取码不正确。'],
  [4100026, '分享不存在或已经取消。'],
  [4100016, '这个分享是空的。'],
  [990009, '115 网盘正忙，请稍后重试。'],
  [50028, '浏览器端拿不到大文件的直链，请改用客户端方式。'],
  [50029, '客户端版本过低，平台拒绝发放直链。'],
]);

/**
 * The adapter of the 115 share link. The object holds the pure helpers next
 * to the protocol methods, so a helper can be tested without a network.
 */
export type Pan115Adapter = NetdiskAdapter & {
  /** Picks the address of the file out of the three shapes the answer uses. */
  pickDownloadUrl(data: unknown): string;
  /** Reads the entries of a folder share. */
  parseEntries(data: unknown): NetdiskFile[];
  /** Reads the id of the user who made the share. */
  parseSharerId(data: unknown): string;
  /** Turns the error code of the platform into a message. */
  describeError(answer: Pan115Answer): string;
  /** The referer the platform checks a share request against. */
  shareReferer(shareCode: string, receiveCode: string | null): string;
  /** The client user agent, which is the only one that is given a link. */
  clientUserAgent(version: string): string;
};

/** The headers of a share request. */
function shareHeaders(referer: string): Record<string, string> {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': WEB_UA,
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

/**
 * The platform checks the version of the client that asks for a link, and a
 * browser user agent is refused with "当前版本过低". The version is read from
 * the version endpoint so the adapter does not carry an outdated one.
 */
async function clientVersion(context: AdapterContext): Promise<string> {
  try {
    const response = await context.session.get(CLIENT_UA_VERSION_URL, {
      Accept: 'application/json',
      'User-Agent': WEB_UA,
    });
    const data = response.data as Record<string, unknown> | undefined;
    const inner = data && typeof data.data === 'object' ? data.data as Record<string, unknown> : undefined;
    const win = inner && typeof inner.win === 'object' ? inner.win as Record<string, unknown> : undefined;
    const code = win && typeof win.version_code === 'string' ? win.version_code : '';
    return code || CLIENT_UA_VERSION_FALLBACK;
  } catch {
    return CLIENT_UA_VERSION_FALLBACK;
  }
}

export const pan115Adapter: Pan115Adapter = {
  platform: 'pan115',
  label: '115 网盘',
  requiresCredential: false,

  pickDownloadUrl(data) {
    if (!data || typeof data !== 'object') return '';
    const root = data as Record<string, unknown>;
    const direct = typeof root.file_url_302 === 'string' ? root.file_url_302 : '';
    if (direct) return direct;
    const plain = typeof root.file_url === 'string' ? root.file_url : '';
    if (plain) return plain;
    const nested = root.url && typeof root.url === 'object' ? root.url as Record<string, unknown> : undefined;
    return nested && typeof nested.url === 'string' ? nested.url : '';
  },

  parseEntries(data) {
    if (!data || typeof data !== 'object') return [];
    const root = data as Record<string, unknown>;
    const raw = Array.isArray(root.list) ? root.list : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const fid = typeof entry.fid === 'string' ? entry.fid : '';
      if (!fid) continue;
      // The folder flag of the platform is the other way round: zero marks a
      // folder, and a folder is addressed by its cid instead of its fid.
      const isDirectory = Number(entry.fc ?? 1) === 0;
      const id = isDirectory ? (typeof entry.cid === 'string' ? entry.cid : '') : fid;
      if (!id) continue;
      const name = typeof entry.n === 'string' ? entry.n : id;
      const size = Number(entry.s ?? 0);
      files.push({
        id,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.t === 'string' ? entry.t : undefined,
      });
    }
    return files;
  },

  parseSharerId(data) {
    if (!data || typeof data !== 'object') return '';
    const root = data as Record<string, unknown>;
    const user = root.userinfo && typeof root.userinfo === 'object' ? root.userinfo as Record<string, unknown> : undefined;
    const id = user?.user_id;
    return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
  },

  describeError(answer) {
    const code = typeof answer.code === 'number' ? answer.code : Number.NaN;
    const known = Number.isFinite(code) ? ERRNO_MESSAGES.get(code) : undefined;
    if (known) return known;
    const raw = typeof answer.error === 'string' && answer.error
      ? answer.error
      : typeof answer.msg === 'string' && answer.msg ? answer.msg : '';
    return raw || (Number.isFinite(code) ? `115 网盘返回了错误码 ${code}。` : '115 网盘拒绝了这次请求。');
  },

  shareReferer(shareCode, receiveCode) {
    return receiveCode
      ? `${SHARE_HOST}/s/${shareCode}?password=${receiveCode}&`
      : `${SHARE_HOST}/s/${shareCode}`;
  },

  clientUserAgent(version) {
    return `Mozilla/5.0 115Browser/${version}`;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const referer = this.shareReferer(context.shareId, context.code);
    const files: NetdiskFile[] = [];
    let sharerId = '';
    let shareTitle = '';
    let offset = 0;
    for (let page = 0; page < 500; page++) {
      const query = new URLSearchParams({
        share_code: context.shareId,
        receive_code: context.code ?? '',
        cid: ROOT_CID,
        offset: String(offset),
        limit: String(PAGE_SIZE),
        format: 'json',
        asc: '0',
      });
      const response = await context.session.get(`${API_BASE}/share/snap?${query.toString()}`, shareHeaders(referer));
      const answer = (response.data ?? {}) as Pan115Answer;
      if (answer.state === false) {
        throw new ToolError('TOOL_FAILED', this.describeError(answer));
      }
      const data = answer.data && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
      sharerId = this.parseSharerId(data) || sharerId;
      const shareInfo = data.shareinfo && typeof data.shareinfo === 'object' ? data.shareinfo as Record<string, unknown> : {};
      const title = typeof shareInfo.share_title === 'string' ? shareInfo.share_title : '';
      if (title) shareTitle = title;
      const entries = this.parseEntries(data);
      files.push(...entries);
      const total = Number(data.count ?? Number.NaN);
      if (!entries.length) break;
      if (Number.isFinite(total) && files.length >= total) break;
      offset += entries.length;
    }
    return { title: shareTitle || '115 分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const referer = this.shareReferer(context.shareId, context.code);
    const version = await clientVersion(context);
    // The share has to be read again for the id of the user who made it,
    // because a link is only given out for a known sharer.
    const query = new URLSearchParams({
      share_code: context.shareId,
      receive_code: context.code ?? '',
      cid: ROOT_CID,
      offset: '0',
      limit: String(PAGE_SIZE),
      format: 'json',
      asc: '0',
    });
    const snap = await context.session.get(`${API_BASE}/share/snap?${query.toString()}`, shareHeaders(referer));
    const snapData = (snap.data as Record<string, unknown> | undefined)?.data;
    const sharerId = this.parseSharerId(snapData);
    if (!sharerId) throw new ToolError('TOOL_FAILED', '115 网盘没有返回分享者的标识，无法取到下载地址。');

    const downloadQuery = new URLSearchParams({
      dl: '1',
      user_id: sharerId,
      share_code: context.shareId,
      file_id: file.id,
    });
    if (context.code) downloadQuery.set('receive_code', context.code);
    const response = await context.session.get(
      `${API_BASE}/share/downurl?${downloadQuery.toString()}`,
      { ...shareHeaders(referer), 'User-Agent': this.clientUserAgent(version) },
    );
    const answer = (response.data ?? {}) as Pan115Answer;
    if (answer.state === false) {
      throw new ToolError('TOOL_FAILED', this.describeError(answer));
    }
    const url = this.pickDownloadUrl(answer.data);
    if (!url) throw new ToolError('TOOL_FAILED', '115 网盘没有返回下载地址。');
    const headers: Record<string, string> = {
      'User-Agent': this.clientUserAgent(version),
      Referer: REFERER,
    };
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `115 网盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    return {
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
      url,
      headers,
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: { platform: 'pan115', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
    };
  },
};
