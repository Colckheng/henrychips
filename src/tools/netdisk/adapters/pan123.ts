import { randomInt } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASE = 'https://yun.123pan.cn';
const DOWNLOAD_BASE = 'https://www.123865.com';
const USER_BASE = 'https://user.123pan.cn';
const SHARE_GET_URL = `${API_BASE}/b/api/share/get`;
const SHARE_DOWNLOAD_INFO_URL = `${DOWNLOAD_BASE}/b/api/share/download/info`;
const SIGN_IN_URL = `${USER_BASE}/user/sign_in`;
const APP_VERSION = '132';
const PLATFORM = 'android';
const SIGN_OS = 'web';
const SIGN_VER = '3';
/** How many entries one page of a listing holds. */
const PAGE_SIZE = 100;
/** How deep the folders of a share are walked, so a share that points into itself ends. */
const MAX_DEPTH = 8;
/** How many pages of one folder are read, so a broken cursor ends the walk. */
const MAX_PAGES = 500;
/** The signature counts from sixteen hours ahead, so a wrong clock is refused. */
const SIGN_OFFSET_SECONDS = 57_600;
/** The digits of the minute are replaced through this table before they are hashed. */
const SIGN_TABLE = 'adefghlmyijnopkqrstubcvwsz';

/**
 * The adapter of the 123 share link. The object holds the pure helpers next
 * to the protocol methods, so a helper can be tested without a network.
 */
export type Pan123Adapter = NetdiskAdapter & {
  /** The two headers every request of the platform has to carry. */
  makeSign(path: string, ts: number): { authKey: string; authValue: string };
  /** Reads the entries of a share. */
  parseEntries(data: unknown): NetdiskFile[];
  /** Splits the token of a member into the key and the tag of the object. */
  decodeFileToken(fidToken: string): { s3KeyFlag: string; etag: string };
  /** Signs in and puts the token into the jar of the host. */
  signIn(context: AdapterContext): Promise<string>;
  /** Unwraps the address of a file from the two shapes the platform uses. */
  decodeDownloadUrl(downloadUrl: string): string | null;
  /** Turns the codes of the platform into a message. */
  describeError(code: number, message: string): string;
  /** Reads the code of an answer, and refuses one the platform states as text. */
  checkCode(answer: Record<string, unknown> | undefined): number;
  /** Asks the platform for one page of a folder of the share. */
  requestPage(context: AdapterContext, parentFileId: string, page: number, next: string): Promise<{ title: string; entries: NetdiskFile[]; next: string | null }>;
  /** Reads a folder of the share and the folders in it. */
  walk(context: AdapterContext, parentFileId: string, prefix: string, files: NetdiskFile[], depth: number, visited: Set<string>, seen: Set<string>): Promise<string>;
};

/** The crc32 of the platform is the ordinary one, written in lower case hex. */
function crc32Hex(value: string): string {
  return (crc32(value) >>> 0).toString(16).padStart(8, '0');
}

/** The headers of a request, without the signature. */
function headersOf(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': WEB_UA,
    Origin: 'https://www.123pan.cn',
    Referer: 'https://www.123pan.cn/',
    'platform': PLATFORM,
    'app-version': APP_VERSION,
  };
}

export const pan123Adapter: Pan123Adapter = {
  platform: 'pan123',
  label: '123 云盘',
  // The listing of a share is open to a visitor, so only the download of a
  // file asks for a login. The link still signs in, so a guest that asks
  // for a direct link is refused there instead of at the listing.
  requiresCredential: false,

  makeSign(path, ts) {
    const shifted = new Date((ts + SIGN_OFFSET_SECONDS) * 1000);
    const minute = [
      String(shifted.getUTCFullYear()).padStart(4, '0'),
      String(shifted.getUTCMonth() + 1).padStart(2, '0'),
      String(shifted.getUTCDate()).padStart(2, '0'),
      String(shifted.getUTCHours()).padStart(2, '0'),
      String(shifted.getUTCMinutes()).padStart(2, '0'),
    ].join('');
    const substituted = [...minute].map(digit => SIGN_TABLE[Number(digit)]).join('');
    const authKey = crc32Hex(substituted);
    const random = randomInt(0, 10_000_000);
    const data = `${ts}|${random}|${path}|${SIGN_OS}|${SIGN_VER}|${authKey}`;
    return { authKey, authValue: `${ts}-${random}-${crc32Hex(data)}` };
  },

  parseEntries(data) {
    if (!data || typeof data !== 'object') return [];
    const root = data as Record<string, unknown>;
    // The platform names the list of the share "InfoList" and the id of a
    // member "FileId", so the shape of the answer is not the one of the
    // personal drive.
    const raw = Array.isArray(root.InfoList) ? root.InfoList : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      // The platform states the id as a number, so a member whose id is
      // read as text only would be dropped from the listing.
      const id = typeof entry.FileId === 'string' ? entry.FileId : typeof entry.FileId === 'number' ? String(entry.FileId) : '';
      if (!id) continue;
      const name = typeof entry.FileName === 'string' ? entry.FileName : id;
      // The kind of a member is stated by its type: one is a folder.
      const isDirectory = Number(entry.Type ?? 0) === 1;
      const size = Number(entry.Size ?? 0);
      files.push({
        id,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.UpdateAt === 'string' ? entry.UpdateAt : undefined,
        // The download needs the key of the object and the tag of it, and
        // the platform states both in one field, separated by a bar.
        fidToken: `${typeof entry['S3KeyFlag'] === 'string' ? entry['S3KeyFlag'] : ''}|${typeof entry.Etag === 'string' ? entry.Etag : ''}|${typeof entry.StorageNode === 'string' ? entry.StorageNode : ''}`,
      });
    }
    return files;
  },

  /**
   * Splits the token of a member into the key of the object and the tag of
   * it. The platform states both in one field, separated by a bar.
   */
  decodeFileToken(fidToken: string): { s3KeyFlag: string; etag: string } {
    const parts = fidToken.split('|');
    return { s3KeyFlag: parts[0] ?? '', etag: parts[1] ?? '' };
  },

  decodeDownloadUrl(downloadUrl) {
    const trimmed = downloadUrl.trim();
    if (!trimmed.includes('://')) {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
        return decoded.toLowerCase().startsWith('http') ? decoded : null;
      } catch {
        return null;
      }
    }
    const index = trimmed.indexOf('params=');
    if (index < 0) return null;
    const params = trimmed.slice(index + 'params='.length).split('&')[0];
    try {
      const normalized = params.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64').toString('utf8');
    } catch {
      return null;
    }
  },

  describeError(code, message) {
    if (code === 401) return '123 云盘的登录态已失效，请重新配置凭证。';
    if (code === 403) return '123 云盘拒绝了这次请求，提取码可能不正确。';
    if (code === 404) return '分享不存在或已经取消。';
    if (code === 429) return '123 云盘请求过于频繁，请稍后重试。';
    if (code === 5103) return '分享不存在或已经取消。';
    return message || `123 云盘返回了错误码 ${code}。`;
  },

  /**
   * Signs in and hands the token to the jar of the host.
   *
   * The session only hands out the credentials of the host a request is
   * aimed at, so a token that is passed as a plain header would be dropped on
   * the way out. The jar is the only way it reaches the platform.
   */
  async signIn(context: AdapterContext): Promise<string> {
    const credential = context.credential;
    if (!credential?.username || !credential.password) {
      throw new ToolError('ACCESS_DENIED', '123 云盘需要登录态，请先配置账号与密码。');
    }
    // The token lives only for this call; the password is exchanged for it
    // and never travels any further.
    const signIn = await context.session.postJson(SIGN_IN_URL, {
      account: credential.username.trim(),
      password: credential.password,
      app_version: APP_VERSION,
      platform: PLATFORM,
    }, headersOf());
    const signInData = signIn.data as Record<string, unknown> | undefined;
    const token = signInData && typeof signInData.token === 'string' ? signInData.token : '';
    if (!token) throw new ToolError('TOOL_FAILED', '123 云盘没有返回登录令牌，请检查账号与密码。');
    for (const host of [API_BASE, DOWNLOAD_BASE, USER_BASE]) {
      context.session.setAuthorization(host, `Bearer ${token}`);
    }
    return token;
  },

  /**
   * Reads the business code of an answer.
   *
   * A code the platform states as text is a failure of the request, so it
   * is reported with the very code instead of being read as a success,
   * which would hand out an empty share.
   */
  checkCode(answer) {
    const code = answer?.code;
    if (typeof code === 'number') return code;
    if (typeof code === 'string') {
      throw new ToolError('TOOL_FAILED', this.describeError(-1, `123 云盘返回了业务码 ${code}。`));
    }
    return 0;
  },

  async requestPage(context, parentFileId, page, next) {
    const path = '/b/api/share/get';
    const sign = this.makeSign(path, Math.floor(Date.now() / 1000));
    const query = new URLSearchParams({
      shareKey: context.shareId,
      limit: String(PAGE_SIZE),
      next,
      orderBy: 'file_name',
      orderDirection: 'asc',
      page: String(page),
      // The listing of a folder is refused without the id of its parent,
      // and the root of the share is the folder with the id zero.
      parentFileId,
      ...(context.code ? { SharePwd: context.code } : {}),
    });
    const response = await context.session.get(`${SHARE_GET_URL}?${query.toString()}`, {
      ...headersOf(),
      'auth-key': sign.authKey,
      'auth-value': sign.authValue,
    });
    const answer = response.data as Record<string, unknown> | undefined;
    const code = this.checkCode(answer);
    if (code !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(code, typeof answer?.message === 'string' ? answer.message : ''));
    }
    const data = answer && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
    // The cursor of the next page is a string, and '-1' says there is no
    // next page, so the cursor is read as text.
    const cursor = typeof data.Next === 'string' ? data.Next : typeof data.Next === 'number' ? String(data.Next) : '';
    return {
      title: typeof data.shareName === 'string' ? data.shareName : '',
      entries: this.parseEntries(data),
      next: cursor === '-1' || cursor === '' ? null : cursor,
    };
  },

  /**
   * Reads a folder of the share and the folders in it.
   *
   * The depth is limited, because a share that points into itself would
   * otherwise walk forever. The title of the folder is handed back, so the
   * listing of the share keeps the name the platform gave it.
   */
  async walk(context, parentFileId, prefix, files, depth, visited, seen) {
    if (depth > MAX_DEPTH) return '';
    // A folder that was already read is not read again, so a folder that
    // points at itself ends the walk.
    if (visited.has(parentFileId)) return '';
    visited.add(parentFileId);
    let title = '';
    let page = 1;
    let next = '0';
    const entries: NetdiskFile[] = [];
    for (; page <= MAX_PAGES; page++) {
      context.reportProgress(`读取目录第 ${page} 页`);
      const batch = await this.requestPage(context, parentFileId, page, next);
      if (!title) title = batch.title;
      entries.push(...batch.entries);
      if (batch.next === null) break;
      next = batch.next;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      // The path of the entry carries the folders it is in.
      const path = `${prefix}${entry.name}${entry.isDirectory ? '/' : ''}`;
      files.push({ ...entry, path });
      if (entry.isDirectory) {
        await this.walk(context, entry.id, `${prefix}${entry.name}/`, files, depth + 1, visited, seen);
      }
    }
    return title;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    // The listing of a share is open to a visitor, so the login is only
    // asked for when the caller configured one. The token travels with the
    // listing then, and a share that needs a member still reads.
    if (context.credential?.username && context.credential.password) {
      await this.signIn(context);
    }
    const files: NetdiskFile[] = [];
    const title = await this.walk(context, '0', '', files, 0, new Set(), new Set());
    return { title: title || '123 分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    await this.signIn(context);
    const path = '/b/api/share/download/info';
    const sign = this.makeSign(path, Math.floor(Date.now() / 1000));
    // The download asks for the key of the object and the tag of it, and the
    // listing states both in one field.
    const token = this.decodeFileToken(file.fidToken ?? '');
    if (!token.s3KeyFlag || !token.etag) {
      throw new ToolError('TOOL_FAILED', '123 云盘没有返回文件密钥，请重新解析分享。');
    }
    const response = await context.session.postJson(SHARE_DOWNLOAD_INFO_URL, {
      ShareKey: context.shareId,
      FileID: file.id,
      S3KeyFlag: token.s3KeyFlag,
      Size: file.sizeBytes ?? 0,
      Etag: token.etag,
    }, {
      ...headersOf(),
      'auth-key': sign.authKey,
      'auth-value': sign.authValue,
    });
    const answer = response.data as Record<string, unknown> | undefined;
    const code = this.checkCode(answer);
    if (code !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(code, typeof answer?.message === 'string' ? answer.message : ''));
    }
    const data = answer && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
    const raw = typeof data.DownloadURL === 'string' ? data.DownloadURL : '';
    if (!raw) throw new ToolError('TOOL_FAILED', '123 云盘没有返回下载地址。');
    const url = this.decodeDownloadUrl(raw) ?? raw;
    const headers = { 'User-Agent': WEB_UA, Referer: 'https://yun.123pan.cn/' };
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `123 云盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    return {
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes,
      url,
      headers,
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: { platform: 'pan123', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
    };
  },
};
