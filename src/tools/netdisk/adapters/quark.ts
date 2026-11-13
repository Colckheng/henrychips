import { ToolError } from '../../../core/errors.js';
import { cookieValue } from '../session.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASE = 'https://drive-pc.quark.cn';
/** The origin of the web page of the platform. The list of a share is refused without it. */
const WEB_ORIGIN = 'https://pan.quark.cn';
const PAGE_SIZE = 100;
/** The cookie of the guest. The CDN of the platform refuses a download without it. */
const GUEST_COOKIE = '__pugs';
/** The business code that says the limit of the guest was hit. */
const CODE_GUEST_LIMIT = 23018;
/** The business code that says the session of the platform is not valid anymore. */
const CODE_LOGIN_REQUIRED = 31001;

/** The token of a share, as the platform hands it out. */
export interface QuarkShareToken {
  stoken: string;
  title: string;
  firstFid: string;
}

/** The address of a file, as the platform hands it out. */
export interface QuarkDownload {
  url: string;
  fileName: string;
  sizeBytes: number | null;
  /** The token of the guest. The CDN refuses the download without it. */
  guestToken: string;
}

/**
 * The adapter of the quark share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type QuarkAdapter = NetdiskAdapter & {
  /** Reads the token of a share out of the answer of the platform. */
  parseShareToken(answer: unknown): QuarkShareToken;
  /** Reads the entries of a folder out of the answer of the platform. */
  parseEntries(data: unknown): NetdiskFile[];
  /** Reads the address of a file out of the answer of the platform. */
  parseDownload(answer: unknown): QuarkDownload;
  /** Turns the business code of the platform into a message. */
  describeError(code: number, message: string): string;
  /** Asks the platform one question and refuses an answer that carries a code. */
  request(context: AdapterContext, url: string, body?: unknown): Promise<Record<string, unknown>>;
  /** Asks the platform for the token of the share. */
  requestToken(context: AdapterContext): Promise<QuarkShareToken>;
  /** Asks the platform for one page of a folder. */
  requestPage(context: AdapterContext, stoken: string, parent: string, page: number): Promise<NetdiskFile[]>;
  /** Reads the root of the share, with the parent the platform accepted. */
  readRoot(context: AdapterContext, token: QuarkShareToken): Promise<{ parent: string; entries: NetdiskFile[] }>;
  /** Finds a member of the share again, for a link that is fetched twice. */
  findEntry(context: AdapterContext, token: QuarkShareToken, file: NetdiskFile): Promise<NetdiskFile | null>;
};

/** An answer of the platform, read as a bag of fields. */
function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** A field of the platform, read as text. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A field of the platform, read as a number of bytes. */
function sizeOf(value: unknown): number | null {
  const size = Number(value ?? 0);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/**
 * The id of the share, as the platform wants it in its requests. The context
 * of a refreshed link carries the whole link where the id was, so the id is
 * read from the link when the context does not hold a plain one.
 */
function shareIdOf(context: AdapterContext): string {
  if (/^[A-Za-z0-9]+$/.test(context.shareId)) return context.shareId;
  return /\/s\/([A-Za-z0-9]+)/i.exec(context.shareUrl)?.[1] ?? context.shareId;
}

/**
 * The headers the platform expects. The list of a share is refused without
 * the origin of the web page of the platform, so the origin is part of every
 * request.
 */
function headersOf(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': WEB_UA,
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
  };
}

/**
 * The platform answers with a business code instead of a status, so the codes
 * that mean something get a message of their own.
 */
function describeErrorOf(code: number, message: string): string {
  if (code === CODE_GUEST_LIMIT) {
    return '夸克网盘对游客下载有大小限制，该文件超出了限制，请登录夸克账号后下载。';
  }
  if (code === CODE_LOGIN_REQUIRED) {
    return '夸克网盘的会话已经失效，请登录夸克账号后重试。';
  }
  return message || `夸克网盘返回了未知的业务码 ${code}。`;
}

/**
 * The failure of a business code. The code decides what kind of failure it
 * is, because the caller asks the user for a different thing in each case.
 */
function failureOf(code: number, message: string): ToolError {
  const text = describeErrorOf(code, message);
  if (code === CODE_GUEST_LIMIT) return new ToolError('LIMIT_EXCEEDED', text);
  if (code === CODE_LOGIN_REQUIRED) return new ToolError('ACCESS_DENIED', text);
  // A passcode the platform refuses is a problem of the input, not of the service.
  if (/提取码|密码|passcode/i.test(text)) return new ToolError('INVALID_INPUT', text);
  return new ToolError('TOOL_FAILED', text);
}

export const quarkAdapter: QuarkAdapter = {
  platform: 'quark',
  label: '夸克网盘',
  requiresCredential: false,

  parseShareToken(answer) {
    const data = objectOf(objectOf(answer).data);
    return {
      stoken: textOf(data.stoken),
      title: textOf(data.title),
      firstFid: textOf(data.first_fid),
    };
  },

  parseEntries(data) {
    const root = objectOf(data);
    const raw = Array.isArray(root.list) ? root.list : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      const entry = objectOf(item);
      const id = textOf(entry.fid);
      if (!id) continue;
      const name = textOf(entry.file_name) || id;
      const isDirectory = entry.dir === true || entry.dir === 1;
      files.push({
        id,
        // The path of a member is the name the user reads, so a folder
        // carries the separator of its children.
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: sizeOf(entry.size),
        isDirectory,
        modifiedAt: textOf(entry.updated_at) || undefined,
        // The token of the member is what the download request asks for, so
        // it travels apart from the path the user reads.
        fidToken: textOf(entry.share_fid_token) || undefined,
      });
    }
    return files;
  },

  parseDownload(answer) {
    const root = objectOf(answer);
    const list = Array.isArray(root.data) ? root.data : [];
    const first = objectOf(list[0]);
    return {
      url: textOf(first.download_url),
      fileName: textOf(first.file_name),
      sizeBytes: sizeOf(first.size),
      // The token of the guest comes with the answer. The platform repeats it
      // in the body of the answer and in the cookies of it, so both places
      // are read.
      guestToken: textOf(first.guest_pugs) || textOf(root.guest_pugs) || textOf(root.guestToken),
    };
  },
  describeError(code, message) {
    return describeErrorOf(code, message);
  },

  async request(context, url, body) {
    const response = body === undefined
      ? await context.session.get(url, headersOf())
      : await context.session.postJson(url, body, headersOf());
    const answer = objectOf(response.data);
    const code = typeof answer.code === 'number' ? answer.code : 0;
    if (code !== 0) {
      throw failureOf(code, textOf(answer.message) || textOf(answer.msg));
    }
    // The platform hands out the token of the guest in the cookies of the
    // answer. The token is bound to the very answer it came with, so it is
    // read here and travels with the link.
    const guestToken = cookieValue(response.setCookie, GUEST_COOKIE);
    if (guestToken) answer.guestToken = guestToken;
    return answer;
  },

  async requestToken(context) {
    const answer = await this.request(
      context,
      `${API_BASE}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc`,
      {
        pwd_id: shareIdOf(context),
        // A visitor without a passcode sends an empty one, and the platform
        // refuses the share itself when it needs one.
        passcode: context.code ?? '',
        support_visit_limit_private_share: true,
      },
    );
    const token = this.parseShareToken(answer);
    if (!token.stoken) throw new ToolError('TOOL_FAILED', '夸克网盘没有返回分享令牌。');
    return token;
  },

  async requestPage(context, stoken, parent, page) {
    const query = new URLSearchParams({
      pr: 'ucpro',
      fr: 'pc',
      pwd_id: shareIdOf(context),
      stoken,
      pdir_fid: parent,
      ver: '2',
      force: '0',
      _page: String(page),
      _size: String(PAGE_SIZE),
      _fetch_banner: '0',
      _fetch_share: '0',
      fetch_relate_conversation: '0',
      _fetch_total: '1',
      _sort: 'file_type:asc,file_name:asc',
    });
    const answer = await this.request(
      context,
      `${API_BASE}/1/clouddrive/share/sharepage/detail?${query.toString()}`,
    );
    // An answer without a list is a shape the adapter cannot read, so it is
    // reported instead of being read as an empty folder.
    if (!Array.isArray(objectOf(answer.data).list)) {
      throw new ToolError('TOOL_FAILED', '夸克网盘目录解析失败：接口未返回文件列表。');
    }
    return this.parseEntries(answer.data);
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    context.reportProgress('读取分享内容');
    const token = await this.requestToken(context);
    const root = await this.readRoot(context, token);
    const files: NetdiskFile[] = [...root.entries];
    let entries = root.entries;
    for (let page = 2; page <= 500; page++) {
      // A page that is not full is the last one of the folder.
      if (entries.length < PAGE_SIZE) break;
      context.reportProgress(`读取目录第 ${page} 页`);
      entries = await this.requestPage(context, token.stoken, root.parent, page);
      files.push(...entries);
    }
    return { title: token.title || '夸克分享', files };
  },

  /**
   * Reads the root of the share. The platform states the id of the root in
   * the answer of the token, and the list is asked for that root. A root the
   * platform refuses, or one that answers with nothing, is replaced by the
   * root of the platform, because a root that is wrong answers with an empty
   * list instead of with an error.
   */
  async readRoot(context, token) {
    const candidates = token.firstFid ? [token.firstFid, '0'] : ['0'];
    let first: { parent: string; entries: NetdiskFile[] } | null = null;
    for (const parent of candidates) {
      let entries: NetdiskFile[];
      try {
        entries = await this.requestPage(context, token.stoken, parent, 1);
      } catch (error) {
        // The root is wrong, so the next one is asked for instead. A failure
        // that has nothing to do with the root is the failure of the share.
        if (!(error instanceof ToolError) || parent === candidates[candidates.length - 1]) throw error;
        continue;
      }
      const found = { parent, entries };
      if (!first) first = found;
      // A share with members in it is the sign that the root is the right one.
      if (entries.length) return found;
    }
    if (!first) throw new ToolError('TOOL_FAILED', '夸克网盘目录解析失败：接口未返回文件列表。');
    return first;
  },

  /**
   * Finds a member of the share again, for a link that is fetched a second
   * time. The file is somewhere in the folder and the answer is paged, so
   * every page is read until the member shows up.
   */
  async findEntry(context: AdapterContext, token: QuarkShareToken, file: NetdiskFile): Promise<NetdiskFile | null> {
    const root = await this.readRoot(context, token);
    let entries = root.entries;
    for (let page = 1; page <= 500; page++) {
      const found = entries.find(entry => entry.id === file.id)
        ?? entries.find(entry => entry.name === file.name);
      if (found) return found;
      // A page that is not full is the last one of the folder.
      if (entries.length < PAGE_SIZE) break;
      entries = await this.requestPage(context, token.stoken, root.parent, page + 1);
    }
    return null;
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    context.reportProgress('解析下载地址');
    const token = await this.requestToken(context);
    // The download request asks for the token of the member. A file that came
    // from the listing carries it, while a link that is fetched again knows
    // only the id of the file, so the share is read again to find it.
    let fid = file.id;
    let fidToken = file.fidToken ?? '';
    if (!fidToken) {
      const found = await this.findEntry(context, token, file);
      if (!found) throw new ToolError('TOOL_FAILED', '夸克网盘分享里没有找到该文件，请重新解析分享。');
      fid = found.id;
      fidToken = found.fidToken ?? '';
    }
    if (!fidToken) throw new ToolError('TOOL_FAILED', '夸克网盘没有返回文件令牌，解析失败。');

    const answer = await this.request(
      context,
      `${API_BASE}/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.23.2`,
      {
        fids: [fid],
        fids_token: [fidToken],
        pwd_id: shareIdOf(context),
        stoken: token.stoken,
        // A visitor sends no session of its own, and the web client of the
        // platform sends the same two empty fields.
        speedup_session: '',
        token: '',
      },
    );
    const download = this.parseDownload(answer);
    if (!download.url) throw new ToolError('TOOL_FAILED', '夸克网盘没有返回下载地址。');

    const headers: Record<string, string> = {
      Referer: `${WEB_ORIGIN}/`,
      Origin: WEB_ORIGIN,
      'User-Agent': WEB_UA,
    };
    // The platform hands out the token of the guest in the `Set-Cookie` of
    // the answer, and the token is bound to the very answer it came with.
    // The token has to travel with a request to the CDN, which is a
    // different host, so it cannot stay in the jar of the host that
    // answered.
    const guestToken = download.guestToken
      || context.session.cookieHeader(download.url).match(/__pugs=([^;]+)/)?.[1]
      || '';
    if (guestToken) {
      // The CDN refuses the download without the token of the guest, so the
      // token goes into the jar of the host and into the headers of the
      // link: the jar of the session does not travel with the link.
      context.session.setCookie(download.url, GUEST_COOKIE, guestToken);
      headers.Cookie = `${GUEST_COOKIE}=${guestToken}`;
    }

    const probe = await context.session.probe(download.url, headers);
    if (probe.status === 412) {
      throw new ToolError('TOOL_FAILED', '夸克网盘拒绝了这次下载，游客令牌可能已经失效，请重新解析分享。');
    }
    if ([403, 404, 410].includes(probe.status)) {
      throw new ToolError('TOOL_FAILED', `夸克网盘下载地址已失效（HTTP ${probe.status}）。`);
    }
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `夸克网盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    // A page that explains itself is not a file, so such an answer is never
    // handed out as a link.
    if ((probe.contentType ?? '').includes('text/html')) {
      throw new ToolError('TOOL_FAILED', '夸克网盘返回了验证页面，未能取得直链。');
    }
    return {
      path: file.path,
      name: file.name,
      sizeBytes: file.sizeBytes ?? download.sizeBytes,
      // The link is the one the probe landed on, so it is never the raw
      // answer of the download endpoint.
      url: probe.finalUrl || download.url,
      headers,
      // The range support comes from the probe, never from an assumption.
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: {
        platform: 'quark',
        shareUrl: context.shareUrl,
        code: context.code,
        filePath: file.path,
        fileId: fid,
      },
      // The guest of the platform downloads small files only, so the limit is
      // told to the user with the link.
      note: '夸克网盘对游客下载有大小限制，超出限制的文件需要登录夸克账号后下载。',
    };
  },
};
