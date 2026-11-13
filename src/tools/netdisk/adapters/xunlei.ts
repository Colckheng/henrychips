import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const APP_UA = 'android-ok-http-client/xl-acc-sdk/version-5.1.3.513006';
const PAN_BASE = 'https://api-pan.xunlei.com';
const SHARE_URL = `${PAN_BASE}/drive/v1/share`;
const SHARE_DETAIL_URL = `${PAN_BASE}/drive/v1/share/detail`;
const FILES_URL = `${PAN_BASE}/drive/v1/files`;
const DEVICE_ID = '78a70629a2b17d0b4302317ffa94807a';
const CLIENT_VERSION = '8.31.0.9726';

/**
 * The adapter of the xunlei share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type XunleiAdapter = NetdiskAdapter & {
  /** Reads the entries of a share. */
  parseEntries(data: unknown): NetdiskFile[];
  /** The state of the passcode, which the platform reports instead of an error. */
  describeShareStatus(status: string): string | null;
};

/**
 * The headers of a request to the platform. The guest mode does not carry an
 * authorization header at all: a stale one makes the platform answer
 * "unauthenticated" instead of serving the share.
 */
function panHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': WEB_UA,
    'X-Device-Id': DEVICE_ID,
    'X-Client-Version': CLIENT_VERSION,
    'Content-Type': 'application/json',
    Origin: 'https://pan.xunlei.com',
    Referer: 'https://pan.xunlei.com/',
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

/**
 * The access token of the platform cannot be won with an account and a
 * password alone: the first sign in always asks for a text message code.
 * The token is therefore taken from the credential, and the adapter says so
 * plainly when it is missing.
 */
function accessTokenOf(context: AdapterContext): string {
  const token = context.credential?.token;
  if (!token) {
    throw new ToolError(
      'ACCESS_DENIED',
      '迅雷取直链需要登录态，而账号密码登录会要求短信验证码，无法自动完成。请在配置里提供迅雷的访问令牌。',
    );
  }
  return token;
}

export const xunleiAdapter: XunleiAdapter = {
  platform: 'xunlei',
  label: '迅雷网盘',
  requiresCredential: true,

  parseEntries(data) {
    if (!data || typeof data !== 'object') return [];
    const root = data as Record<string, unknown>;
    const raw = Array.isArray(root.files) ? root.files : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id) continue;
      const name = typeof entry.name === 'string' ? entry.name : id;
      // The platform marks a folder with its own kind.
      const isDirectory = entry.kind === 'drive#folder';
      const size = Number(entry.size ?? 0);
      files.push({
        id,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.modified_time === 'string' ? entry.modified_time : undefined,
      });
    }
    return files;
  },

  describeShareStatus(status) {
    if (status === 'PASS_CODE_NEED') return '这个分享需要提取码，请在链接或输入框中提供。';
    if (status === 'PASS_CODE_EMPTY') return '这个分享需要提取码，请在链接或输入框中提供。';
    if (status === 'PASS_CODE_ERROR') return '提取码不正确。';
    return null;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const query = new URLSearchParams({
      share_id: context.shareId,
      pass_code: context.code ?? '',
      limit: '100',
      page_token: '',
      thumbnail_size: 'SIZE_SMALL',
    });
    const response = await context.session.get(`${SHARE_URL}?${query.toString()}`, panHeaders());
    const answer = (response.data ?? {}) as Record<string, unknown>;
    const status = typeof answer.share_status === 'string' ? answer.share_status : '';
    const problem = this.describeShareStatus(status);
    if (problem) throw new ToolError('INVALID_INPUT', problem);
    const files = this.parseEntries(answer);
    let title = typeof answer.title === 'string' ? answer.title : '';
    let pageToken = typeof answer.next_page_token === 'string' ? answer.next_page_token : '';
    const passCodeToken = typeof answer.pass_code_token === 'string' ? answer.pass_code_token : '';
    // A folder share is read through the detail endpoint, which needs the
    // token of the passcode and the parent of the entries.
    let parentId = '';
    for (const file of files) {
      if (file.isDirectory) { parentId = file.id; break; }
    }
    if (parentId && passCodeToken) {
      const detailQuery = new URLSearchParams({
        share_id: context.shareId,
        parent_id: parentId,
        pass_code_token: passCodeToken,
        limit: '100',
        page_token: '',
        thumbnail_size: 'SIZE_SMALL',
      });
      const detail = await context.session.get(`${SHARE_DETAIL_URL}?${detailQuery.toString()}`, panHeaders());
      const detailAnswer = (detail.data ?? {}) as Record<string, unknown>;
      const inner = this.parseEntries(detailAnswer);
      if (inner.length) files.push(...inner);
      pageToken = typeof detailAnswer.next_page_token === 'string' ? detailAnswer.next_page_token : pageToken;
    }
    while (pageToken) {
      const pageQuery = new URLSearchParams({
        share_id: context.shareId,
        pass_code: context.code ?? '',
        limit: '100',
        page_token: pageToken,
        thumbnail_size: 'SIZE_SMALL',
      });
      const page = await context.session.get(`${SHARE_URL}?${pageQuery.toString()}`, panHeaders());
      const pageAnswer = (page.data ?? {}) as Record<string, unknown>;
      const entries = this.parseEntries(pageAnswer);
      if (!entries.length) break;
      files.push(...entries);
      const next = typeof pageAnswer.next_page_token === 'string' ? pageAnswer.next_page_token : '';
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    return { title: title || '迅雷分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const accessToken = accessTokenOf(context);
    const response = await context.session.get(`${FILES_URL}/${encodeURIComponent(file.id)}`, panHeaders(accessToken));
    const answer = (response.data ?? {}) as Record<string, unknown>;
    const links = answer.links && typeof answer.links === 'object' ? answer.links as Record<string, unknown> : {};
    const url = typeof links.url === 'string' ? links.url : typeof links.web_content_link === 'string' ? links.web_content_link : '';
    if (!url) throw new ToolError('TOOL_FAILED', '迅雷网盘没有返回下载地址。');
    const headers = {
      'User-Agent': APP_UA,
      Referer: 'https://pan.xunlei.com/',
    };
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `迅雷网盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    return {
      path: file.path,
      name: typeof answer.name === 'string' && answer.name ? answer.name : file.name,
      sizeBytes: typeof answer.size === 'number' ? answer.size : file.sizeBytes,
      url,
      headers,
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: { platform: 'xunlei', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
    };
  },
};
