import { createHash } from 'node:crypto';
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const APP_UA = 'android-ok-http-client/xl-acc-sdk/version-5.1.3.513006';
/** The user agent of the captcha init, taken from the app capture in YunX. */
const CAPTCHA_UA = 'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)';
const PAN_BASE = 'https://api-pan.xunlei.com';
const AUTH_BASE = 'https://xluser-ssl.xunlei.com';
const SHARE_URL = `${PAN_BASE}/drive/v1/share`;
const SHARE_DETAIL_URL = `${PAN_BASE}/drive/v1/share/detail`;
const FILES_URL = `${PAN_BASE}/drive/v1/files`;
const CAPTCHA_INIT_URL = `${AUTH_BASE}/v1/shield/captcha/init`;
const DEVICE_ID = '78a70629a2b17d0b4302317ffa94807a';
const CLIENT_VERSION = '8.31.0.9726';
/**
 * The client id of the app channel. The share endpoint refuses a request
 * without this header, even when the request carries a captcha token.
 */
const APP_CLIENT_ID = 'Xp6vsxz_7IYVw2BB';
const APP_PACKAGE_NAME = 'com.xunlei.downloadprovider';
/**
 * The salts of the captcha signature, in order. The order matters: every
 * salt folds into the hash of the previous one. Taken from YunX, which
 * verified them against the alist source.
 */
const CAPTCHA_SALTS = [
  '9uJNVj/wLmdwKrJaVj/omlQ',
  'Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf',
  'Eb+L7Ce+Ej48u',
  'jKY0',
  'ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd',
  'wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK',
  'gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O',
  '5IiCoM9B1/788ntB',
  'P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf',
  '+oK0AN',
];
/** How many entries one page of a folder holds. */
const PAGE_SIZE = 100;
/** How deep the folders of a share are walked, so a share that points into itself ends. */
const MAX_DEPTH = 8;
/** How many pages one folder is read for, so a runaway listing ends. */
const MAX_PAGES = 500;
/**
 * The platform says a captcha token lives 300 seconds. Thirty seconds are
 * kept back, so a token that is about to die is never sent.
 */
const CAPTCHA_TTL_MS = 270_000;

/** An answer of the platform, read as a bag of fields. */
function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** A field of the platform, read as text. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The headers of a request to the platform. The guest mode does not carry an
 * authorization header at all: a stale one makes the platform answer
 * "unauthenticated" instead of serving the share. The token of the user
 * reaches the platform through the jar of the session instead.
 *
 * The share endpoints also need the captcha token and the client id of the
 * app channel: a request with a token but without the client id is refused
 * with `captcha_invalid`, and so is a request with a token of the web
 * channel. A call without a token keeps the old headers, so the link of a
 * file is untouched.
 */
function panHeaders(captchaToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': WEB_UA,
    'X-Device-Id': DEVICE_ID,
    'X-Client-Version': CLIENT_VERSION,
    'Content-Type': 'application/json',
    Origin: 'https://pan.xunlei.com',
    Referer: 'https://pan.xunlei.com/',
  };
  if (captchaToken) {
    headers['X-Client-Id'] = APP_CLIENT_ID;
    headers['X-Captcha-Token'] = captchaToken;
  }
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

/**
 * Puts the token of the user into the jar of the host.
 *
 * The session only hands out the credentials of the host a request is aimed
 * at, so a token that is passed as a plain header would be dropped on the way
 * out. The jar is the only way it reaches the platform.
 */
function signIn(context: AdapterContext): string {
  const token = accessTokenOf(context);
  context.session.setAuthorization(PAN_BASE, `Bearer ${token}`);
  return token;
}

/**
 * A captcha token, with the moment it stops being worth sending. The token
 * is bound to the device, not to the share, so it is kept per session: a
 * session serves one run, and a token must never leak into another run.
 */
interface CaptchaEntry {
  token: string;
  expiresAt: number;
}

const captchaBySession = new WeakMap<object, Map<string, CaptchaEntry>>();

/**
 * The adapter of the xunlei share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type XunleiAdapter = NetdiskAdapter & {
  /** Reads the entries of a share. */
  parseEntries(data: unknown): NetdiskFile[];
  /** The state of the passcode, which the platform reports instead of an error. */
  describeShareStatus(status: string): string | null;
  /** Signs a captcha init. A pure function of the device and the time, so a fixed time signs the same. */
  buildCaptchaSign(deviceId: string, timestampMs: string): string;
  /** Asks the platform for a captcha token for one action of the share. */
  initCaptcha(context: AdapterContext, action: string): Promise<string>;
  /** Asks for a captcha token of the action that is still worth sending. */
  ensureCaptcha(context: AdapterContext, action: string, force: boolean): Promise<string>;
  /** Asks for one page of the share, refreshing the captcha once when the platform refuses it. */
  requestPage(context: AdapterContext, url: string, action: string): Promise<Record<string, unknown>>;
  /** Reads one page of the root of the share. */
  requestShare(context: AdapterContext, pageToken: string): Promise<Record<string, unknown>>;
  /** Reads one page of a folder of the share. */
  requestDetail(context: AdapterContext, parentId: string, passCodeToken: string, pageToken: string): Promise<Record<string, unknown>>;
  /** Reads a folder of the share and the folders in it. */
  walk(context: AdapterContext, passCodeToken: string, parent: string, prefix: string, files: NetdiskFile[], depth: number, visited: Set<string>, seen: Set<string>): Promise<void>;
  /** Reads every file of the share. */
  readShare(context: AdapterContext): Promise<NetdiskShare>;
};

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

  buildCaptchaSign(deviceId, timestampMs) {
    const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');
    let signed = APP_CLIENT_ID + CLIENT_VERSION + APP_PACKAGE_NAME + deviceId + timestampMs;
    for (const salt of CAPTCHA_SALTS) {
      signed = md5(signed + salt);
    }
    return `1.${signed}`;
  },

  async initCaptcha(context, action) {
    const timestamp = String(Date.now());
    const body = {
      client_id: APP_CLIENT_ID,
      action,
      device_id: DEVICE_ID,
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
      // The meta carries no username: this is the pan init of YunX, not the
      // login init, and a username here would ask for a different token.
      meta: {
        client_version: CLIENT_VERSION,
        package_name: APP_PACKAGE_NAME,
        timestamp,
        captcha_sign: this.buildCaptchaSign(DEVICE_ID, timestamp),
        user_id: '',
      },
      captcha_token: '',
    };
    const response = await context.session.postJson(CAPTCHA_INIT_URL, body, {
      'User-Agent': CAPTCHA_UA,
      Accept: 'application/json;charset=UTF-8',
      'Content-Type': 'application/json',
      'X-Client-Id': APP_CLIENT_ID,
      'X-Device-Id': DEVICE_ID,
      'X-Client-Version': CLIENT_VERSION,
    });
    const answer = objectOf(response.data);
    const token = textOf(answer.captcha_token);
    if (!token) {
      throw new ToolError('TOOL_FAILED', '迅雷网盘验证码初始化失败，请稍后重试。');
    }
    const expiresIn = typeof answer.expires_in === 'number'
      ? Math.max(60_000, answer.expires_in * 1000 - 30_000)
      : CAPTCHA_TTL_MS;
    const byAction = captchaBySession.get(context.session) ?? new Map<string, CaptchaEntry>();
    byAction.set(action, {
      token,
      expiresAt: Date.now() + expiresIn,
    });
    captchaBySession.set(context.session, byAction);
    return token;
  },

  /**
   * Asks for a captcha token of the action that is still worth sending, and
   * asks for a new one when there is none or it is about to die.
   */
  async ensureCaptcha(context: AdapterContext, action: string, force: boolean): Promise<string> {
    const byAction = captchaBySession.get(context.session);
    const cached = byAction?.get(action);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    return this.initCaptcha(context, action);
  },

  async requestPage(context, url, action) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await this.ensureCaptcha(context, action, attempt > 1);
      const response = await context.session.get(url, panHeaders(token));
      const answer = objectOf(response.data);
      if (textOf(answer.error) === 'captcha_invalid') {
        // The token died between the init and the request, or the platform
        // refused it for another reason. One fresh token is worth one retry;
        // a second refusal is reported instead of being read as an empty list.
        if (attempt === 1) continue;
        throw new ToolError('TOOL_FAILED', '迅雷网盘验证码校验失败，请稍后重试。');
      }
      return answer;
    }
    throw new ToolError('TOOL_FAILED', '迅雷网盘验证码校验失败，请稍后重试。');
  },

  async requestShare(context, pageToken) {
    const query = new URLSearchParams({
      share_id: context.shareId,
      pass_code: context.code ?? '',
      limit: String(PAGE_SIZE),
      page_token: pageToken,
      thumbnail_size: 'SIZE_SMALL',
    });
    return this.requestPage(context, `${SHARE_URL}?${query.toString()}`, 'GET:/drive/v1/share');
  },

  async requestDetail(context, parentId, passCodeToken, pageToken) {
    const query = new URLSearchParams({
      share_id: context.shareId,
      parent_id: parentId,
      pass_code_token: passCodeToken,
      limit: String(PAGE_SIZE),
      page_token: pageToken,
      thumbnail_size: 'SIZE_SMALL',
    });
    return this.requestPage(context, `${SHARE_DETAIL_URL}?${query.toString()}`, 'GET:/drive/v1/share/detail');
  },

  /**
   * Reads a folder of the share and the folders in it.
   *
   * The depth is limited, because a share that points into itself would
   * otherwise walk forever. Every folder pages on its own token, so the
   * pages of one folder never steer the listing of another.
   */
  async walk(context, passCodeToken, parent, prefix, files, depth, visited, seen) {
    if (depth > MAX_DEPTH) return;
    // A folder that was already read is not read again, so a folder that
    // points at itself ends the walk.
    if (visited.has(parent)) return;
    visited.add(parent);
    const entries: NetdiskFile[] = [];
    let pageToken = '';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await this.requestDetail(context, parent, passCodeToken, pageToken);
      const batch = this.parseEntries(answer);
      entries.push(...batch);
      const next = textOf(answer.next_page_token);
      // A page without a next token is the last one of the folder.
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      // The path of the entry carries the folders it is in.
      const path = `${prefix}${entry.name}${entry.isDirectory ? '/' : ''}`;
      files.push({ ...entry, path });
      if (entry.isDirectory) {
        await this.walk(context, passCodeToken, entry.id, `${prefix}${entry.name}/`, files, depth + 1, visited, seen);
      }
    }
  },

  /**
   * Reads every file of the share.
   *
   * The root is paged on its own token first, and then every folder of it
   * is walked in turn. A folder that is already listed is not listed again,
   * so a folder that points at itself does not fill the list with copies.
   */
  async readShare(context) {
    const first = await this.requestShare(context, '');
    const status = textOf(first.share_status);
    const problem = this.describeShareStatus(status);
    if (problem) throw new ToolError('INVALID_INPUT', problem);
    const title = textOf(first.title) || '迅雷分享';
    const passCodeToken = textOf(first.pass_code_token);
    const files: NetdiskFile[] = [];
    const seen = new Set<string>();
    const push = (entries: NetdiskFile[]) => {
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        files.push(entry);
      }
    };
    push(this.parseEntries(first));
    let pageToken = textOf(first.next_page_token);
    for (let page = 2; page <= MAX_PAGES && pageToken; page++) {
      const answer = await this.requestShare(context, pageToken);
      push(this.parseEntries(answer));
      const next = textOf(answer.next_page_token);
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    if (passCodeToken) {
      const visited = new Set<string>();
      for (const entry of [...files]) {
        if (!entry.isDirectory) continue;
        await this.walk(context, passCodeToken, entry.id, `${entry.name}/`, files, 1, visited, seen);
      }
    }
    return { title, files };
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    context.reportProgress('读取分享内容');
    return this.readShare(context);
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    signIn(context);
    const response = await context.session.get(`${FILES_URL}/${encodeURIComponent(file.id)}`, panHeaders());
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
