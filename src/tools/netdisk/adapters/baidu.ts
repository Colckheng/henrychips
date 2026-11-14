import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** The client of the platform, which the old endpoints of it expect. */
const APP_UA = 'netdisk;12.24.6;piano;android-android;16;JSbridge4.4.0;jointBridge;1.1.0';
const APP_ID = '250528';
const SHARE_HOST = 'https://pan.baidu.com';
/** The host of the download addresses of the platform. */
const DOWNLOAD_HOST = 'https://d.pcs.baidu.com';
/** The folder the transfers go to, so the leftovers are easy to spot and to remove. */
const TEMP_DIR = '/YunX临时转存';
/**
 * The constants of the download endpoint. The platform only hands out a
 * direct link when the request looks like the one of its own client, so the
 * values of a caught request are reused here.
 */
const LOCATE_RAND = '5ed606e9da222cde0474cdf70eda884b';
const LOCATE_DEVICE_ID = '348642637967375013';
const LOCATE_PSIGN = '860a071f77c860e8cea06e4e54c518f3';
/** The identifier of the device, which the platform ties to the session. */
const LOCATE_DEVID = '0F1E9FC2E084472DA5A61C4CF4C759AF';
/** How many entries one page of a folder holds. */
const PAGE_SIZE = 100;
/** How deep the folders of a share are walked, so a share that points into itself ends. */
const MAX_DEPTH = 8;
/** How many pages of one folder are read at most, so a folder that never ends ends. */
const MAX_PAGES = 500;

/**
 * The adapter of the baidu share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type BaiduAdapter = NetdiskAdapter & {
  /** Reads the entries of a share. The prefix is the folders above them. */
  parseEntries(data: unknown, prefix?: string): NetdiskFile[];
  /** The code of the platform becomes a message of its own. */
  describeError(errno: number, message: string): string;
  /** Reads the name of a file out of the answer of the platform. */
  parseDlink(data: unknown): string;
  /** Picks the plain channel out of the candidates of the platform. */
  pickPlainUrl(urls: unknown): string;
  /** Reads the share id and the owner out of the answer of the listing. */
  parseShareInfo(data: unknown): { shareId: string; uk: string };
  /** Asks the platform for one page of a folder. */
  requestPage(context: AdapterContext, surl: string, sekey: string, dir: string, page: number): Promise<NetdiskFile[]>;
  /** Reads a folder of the share and the folders in it. */
  walk(context: AdapterContext, surl: string, sekey: string, dir: string, prefix: string, files: NetdiskFile[], depth: number, visited: Set<string>, seen: Set<string>): Promise<void>;
};

/** The headers of a request, with the session of the user. */
function headersOf(surl: string): Record<string, string> {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': WEB_UA,
    Referer: `${SHARE_HOST}/s/${surl}`,
    Origin: SHARE_HOST,
  };
}

/**
 * Puts the session of the user into the jar of the host.
 *
 * The session only hands out the credentials of the host a request is aimed
 * at, so a credential that is passed as a plain header would be dropped on
 * the way out. The jar is the only way a credential reaches the platform.
 */
function signIn(context: AdapterContext): void {
  const bduss = context.credential?.bduss;
  if (!bduss) throw new ToolError('ACCESS_DENIED', '百度网盘需要登录态，请先配置 BDUSS。');
  context.session.setCookie(SHARE_HOST, 'BDUSS', bduss);
}

/**
 * Puts the session of the user into the jar of the host when one is
 * configured, and does nothing when there is none. The listing of a share
 * works without a session, so the listing never refuses a visitor; only the
 * transfer that fetches a direct link needs the session.
 */
function maybeSignIn(context: AdapterContext): void {
  const bduss = context.credential?.bduss;
  if (bduss) context.session.setCookie(SHARE_HOST, 'BDUSS', bduss);
}

/**
 * The token of the platform, which the requests to the personal drive need.
 * It is asked for with the session of the user and lives only for this run.
 */
async function bdstokenOf(context: AdapterContext): Promise<string> {
  signIn(context);
  const response = await context.session.get(
    `${SHARE_HOST}/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}&web=1&fields=%5B%22bdstoken%22%5D`,
    { 'User-Agent': WEB_UA },
  );
  const answer = (response.data ?? {}) as Record<string, unknown>;
  const errno = typeof answer.errno === 'number' ? answer.errno : 0;
  if (errno !== 0) throw new ToolError('TOOL_FAILED', '百度网盘没有返回访问令牌，请重新配置凭证。');
  const result = answer.result && typeof answer.result === 'object' ? answer.result as Record<string, unknown> : {};
  const token = typeof result.bdstoken === 'string' ? result.bdstoken : '';
  if (!token) throw new ToolError('TOOL_FAILED', '百度网盘没有返回访问令牌，请重新配置凭证。');
  return token;
}

export const baiduAdapter: BaiduAdapter = {
  platform: 'baidu',
  label: '百度网盘',
  // The listing of a share works without a session, so the listing never
  // asks for one. Only the transfer that fetches a direct link needs the
  // session, and link() still refuses a visitor on its own.
  requiresCredential: false,

  parseEntries(data, prefix = '') {
    if (!data || typeof data !== 'object') return [];
    const root = data as Record<string, unknown>;
    const raw = Array.isArray(root.list) ? root.list : [];
    const files: NetdiskFile[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const name = typeof entry.server_filename === 'string' ? entry.server_filename : '';
      if (!name) continue;
      const isDirectory = entry.isdir === '1' || entry.isdir === 1;
      // A folder is addressed by its path, a file by its id, because the
      // transfer of a file needs the id and the navigation of a folder the path.
      // The root answers its numbers as strings and a folder below it as
      // real numbers, so both shapes are accepted; a file whose id is a
      // number was dropped outright before this.
      const id = isDirectory
        ? (typeof entry.path === 'string' ? entry.path : '')
        : typeof entry.fs_id === 'string' ? entry.fs_id
        : typeof entry.fs_id === 'number' ? String(entry.fs_id) : '';
      if (!id) continue;
      const size = Number(entry.size ?? 0);
      files.push({
        id,
        // The path of the entry carries the folders it is in, so a file deep
        // down still has the name the user knows it by.
        path: `${prefix}${name}${isDirectory ? '/' : ''}`,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.server_mtime === 'string' ? entry.server_mtime
          : typeof entry.server_mtime === 'number' ? String(entry.server_mtime) : undefined,
      });
    }
    return files;
  },

  describeError(errno, message) {
    if (errno === -6) return '百度网盘需要登录态，请先配置 BDUSS。';
    if (errno === 2) return '提取码不正确，或分享已失效。';
    if (errno === 112) return '这个分享需要提取码，请提供后重试。';
    if (errno === -21) return '分享不存在或已经取消。';
    return message || `百度网盘返回了错误码 ${errno}。`;
  },

  parseDlink(data) {
    if (!data || typeof data !== 'object') return '';
    const root = data as Record<string, unknown>;
    const info = Array.isArray(root.info) ? root.info : [];
    const first = info[0] && typeof info[0] === 'object' ? info[0] as Record<string, unknown> : undefined;
    const link = first && typeof first.dlink === 'string' ? first.dlink : '';
    return link;
  },

  parseShareInfo(data) {
    if (!data || typeof data !== 'object') return { shareId: '', uk: '' };
    const root = data as Record<string, unknown>;
    const shareId = typeof root.share_id === 'string' ? root.share_id : typeof root.shareid === 'string' ? root.shareid : '';
    const uk = typeof root.uk === 'string' ? root.uk : typeof root.uid === 'string' ? root.uid : '';
    return { shareId, uk };
  },

  pickPlainUrl(urls) {
    if (!Array.isArray(urls)) return '';
    const candidates = urls
      .map(item => (item && typeof item === 'object' ? item as Record<string, unknown> : undefined))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .filter(item => typeof item.url === 'string' && item.url);
    // The first candidate is the encrypted channel, whose content has to be
    // decrypted before it is a file. The plain channel is the one that can be
    // downloaded as it is.
    const plain = candidates.find(item => Number(item.encrypt ?? 1) === 0);
    const chosen = plain
      ?? candidates.find(item => typeof item.url === 'string' && item.url.startsWith('https'))
      ?? candidates[0];
    return chosen && typeof chosen.url === 'string' ? chosen.url : '';
  },

  async requestPage(context, surl, sekey, dir, page) {
    const query = new URLSearchParams({
      method: 'list', shorturl: surl, page: String(page), num: String(PAGE_SIZE),
      // The root of the share is asked for as the root; a folder below it is
      // asked for by its path.
      root: dir === '/' ? '1' : '0', dir,
    });
    if (sekey) query.set('sekey', sekey);
    const response = await context.session.get(
      `${SHARE_HOST}/rest/2.0/xpan/share?${query.toString()}`,
      headersOf(surl),
    );
    const answer = (response.data ?? {}) as Record<string, unknown>;
    const errno = typeof answer.errno === 'number' ? answer.errno : 0;
    if (errno !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(errno, typeof answer.errmsg === 'string' ? answer.errmsg : ''));
    }
    return this.parseEntries(answer);
  },

  /**
   * Reads a folder of the share and the folders in it.
   *
   * The depth is limited, because a share that points into itself would
   * otherwise walk forever.
   */
  async walk(context, surl, sekey, dir, prefix, files, depth, visited, seen) {
    if (depth > MAX_DEPTH) return;
    // A folder that was already read is not read again, so a folder that
    // points at itself ends the walk.
    if (visited.has(dir)) return;
    visited.add(dir);
    const entries: NetdiskFile[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      context.reportProgress(`读取目录第 ${page} 页`);
      const batch = await this.requestPage(context, surl, sekey, dir, page);
      entries.push(...batch);
      // A page that is not full is the last one of the folder.
      if (batch.length < PAGE_SIZE) break;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      // The path of the entry carries the folders it is in.
      const path = `${prefix}${entry.name}${entry.isDirectory ? '/' : ''}`;
      files.push({ ...entry, path });
      if (entry.isDirectory) {
        // A folder is addressed by its path, which is what the entry
        // carries as its id.
        await this.walk(context, surl, sekey, entry.id, `${prefix}${entry.name}/`, files, depth + 1, visited, seen);
      }
    }
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    // The listing works without a session, so a session is only put into the
    // jar when one is configured. The transfer that fetches a direct link
    // still asks for it in link().
    maybeSignIn(context);
    // The short url of the platform is the share code without its first
    // character, so the code of the link has to lose it as well.
    const surl = context.shareId.startsWith('1') ? context.shareId.slice(1) : context.shareId;
    let sekey = '';
    if (context.code) {
      // The verification is a form post: the platform refuses the same
      // fields sent as JSON (errno -12), so postForm is used on purpose.
      const verify = await context.session.postForm(`https://pan.baidu.com/share/verify?surl=${surl}`, {
        pwd: context.code, vcode: '', channel: 'chunlei', web: '1', app_id: APP_ID, clienttype: '0',
      }, { ...headersOf(surl), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
      const verifyData = verify.data as Record<string, unknown> | undefined;
      const errno = typeof verifyData?.errno === 'number' ? verifyData.errno : 0;
      if (errno !== 0) {
        throw new ToolError('INVALID_INPUT', this.describeError(errno, typeof verifyData?.errmsg === 'string' ? verifyData.errmsg : ''));
      }
      // The token is used exactly as returned: it is URL-encoded, and the
      // platform wants that form in both the query string and the cookie.
      // Decoding it once first makes every listing fail with errno -9.
      sekey = typeof verifyData?.randsk === 'string' ? verifyData.randsk : '';
      // The listing of a folder needs the sign of the verification, and the
      // platform only accepts it as a cookie.
      if (sekey) context.session.setCookie(SHARE_HOST, 'BDCLND', sekey);
    }
    // A share holds folders, and a folder holds more of them, so the walk
    // goes into every folder. A folder that is already visited is not
    // visited again, and an entry that is already listed is not listed
    // again, so a folder that points at itself does not walk forever or
    // fill the list with copies of itself.
    const files: NetdiskFile[] = [];
    const visited = new Set<string>();
    const seen = new Set<string>();
    await this.walk(context, surl, sekey, '/', '', files, 0, visited, seen);
    return { title: '百度网盘分享', files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    signIn(context);
    const surl = context.shareId.startsWith('1') ? context.shareId.slice(1) : context.shareId;
    const bdstoken = await bdstokenOf(context);
    // The address of a shared file is encrypted, so the file has to be
    // transferred into the drive of the user first. The copy is put into a
    // folder of its own and removed again once the address is fetched.
    //
    // The transfer needs the id of the share and the owner of it, and both
    // are only stated by the listing of the share.
    const listQuery = new URLSearchParams({
      method: 'list', shorturl: surl, page: '1', num: '100', root: '1', dir: '/',
    });
    const listing = await context.session.get(`${SHARE_HOST}/rest/2.0/xpan/share?${listQuery.toString()}`, headersOf(surl));
    const listingAnswer = (listing.data ?? {}) as Record<string, unknown>;
    const { shareId, uk } = this.parseShareInfo(listingAnswer);
    if (!shareId) throw new ToolError('TOOL_FAILED', '百度网盘没有返回分享标识，无法转存该文件。');
    const transferQuery = new URLSearchParams({
      shareid: shareId, from: uk, channel: 'chunlei', sekey: '', ondup: 'newcopy',
      web: '1', app_id: APP_ID, bdstoken, clienttype: '0',
    });
    const transfer = await context.session.postForm(
      `${SHARE_HOST}/share/transfer?${transferQuery.toString()}`,
      { fsidlist: `[${file.id}]`, path: TEMP_DIR },
      { ...headersOf(surl), 'User-Agent': APP_UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    );
    const transferData = transfer.data as Record<string, unknown> | undefined;
    const errno = typeof transferData?.errno === 'number' ? transferData.errno : 0;
    if (errno !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(errno, typeof transferData?.errmsg === 'string' ? transferData.errmsg : ''));
    }
    const extra = transferData && typeof transferData.extra === 'object' ? transferData.extra as Record<string, unknown> : {};
    const list = Array.isArray(extra.list) ? extra.list : [];
    const first = list[0] && typeof list[0] === 'object' ? list[0] as Record<string, unknown> : undefined;
    const path = first && typeof first.to === 'string' ? first.to : `${TEMP_DIR}/${file.name}`;
    if (!path) throw new ToolError('TOOL_FAILED', '百度网盘没有返回转存结果。');
    try {
      // The address of the platform is asked for by the path of the copy, and
      // the platform hands out several candidates. The plain one is the only
      // one that is a file as it is.
      const time = Math.floor(Date.now() / 1000);
      const locateQuery = new URLSearchParams({
        method: 'locatedownload',
        app_id: APP_ID,
        clienttype: '17',
        ver: '4.0',
        ant: '1',
        check_blue: '1',
        es: '1',
        esl: '1',
        apn_id: '1_-1',
        freeisp: '0',
        queryfree: '0',
        use: '1',
        dtype: '1',
        eck: '1',
        ehps: '1',
        err_ver: '1.0',
        network_type: 'WIFI',
        channel: '0',
        path,
        time: String(time),
        rand: LOCATE_RAND,
        devuid: LOCATE_DEVID,
        cuid: LOCATE_DEVID,
        deviceid: LOCATE_DEVICE_ID,
        psign: LOCATE_PSIGN,
        version: '2.2.111.34',
        version_app: '12.24.6',
        vip: '0',
      });
      const located = await context.session.postJson(
        `${DOWNLOAD_HOST}/rest/2.0/pcs/file?${locateQuery.toString()}`,
        '0',
        { 'User-Agent': APP_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      );
      const locatedData = located.data as Record<string, unknown> | undefined;
      const url = this.pickPlainUrl(locatedData?.urls);
      if (!url) throw new ToolError('TOOL_FAILED', '百度网盘没有返回下载地址。');
      const headers = { 'User-Agent': APP_UA, Referer: `${SHARE_HOST}/` };
      const probe = await context.session.probe(url, headers);
      if (probe.status !== 200 && probe.status !== 206) {
        throw new ToolError('TOOL_FAILED', `百度网盘下载地址探测失败（HTTP ${probe.status}）。`);
      }
      return {
        path: file.path,
        name: file.name,
        sizeBytes: file.sizeBytes,
        url,
        headers,
        rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
        source: { platform: 'baidu', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
        note: '这个直链通过转存到你的百度网盘后取得，已在取链后清理。',
      };
    } finally {
      // The copy is of no use once the address is known, so it goes away.
      const deleteQuery = new URLSearchParams({
        opera: 'delete', async: '2', onnest: 'fail', bdstoken, newVerify: '1',
        clienttype: '0', app_id: APP_ID, web: '1',
      });
      await context.session.postForm(
        `${SHARE_HOST}/api/filemanager?${deleteQuery.toString()}`,
        { filelist: `[${JSON.stringify(path)}]` },
        { 'User-Agent': APP_UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      ).catch(() => undefined);
    }
  },
};
