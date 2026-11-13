import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const APP_ID = '250528';
/** The folder the transfers go to, so the leftovers are easy to spot and to remove. */
const TEMP_DIR = '/YunX临时转存';

/**
 * The adapter of the baidu share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type BaiduAdapter = NetdiskAdapter & {
  /** Reads the entries of a share. */
  parseEntries(data: unknown): NetdiskFile[];
  /** The code of the platform becomes a message of its own. */
  describeError(errno: number, message: string): string;
  /** Reads the name of a file out of the answer of the platform. */
  parseDlink(data: unknown): string;
};

/** The headers of a request, with the session of the user. */
function headersOf(surl: string): Record<string, string> {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': WEB_UA,
    Referer: `https://pan.baidu.com/s/${surl}`,
    Origin: 'https://pan.baidu.com',
  };
}

/**
 * The session of the user. The platform needs it for everything but the
 * listing, and the listing of a protected share needs it as well.
 */
function cookieOf(context: AdapterContext): string {
  const bduss = context.credential?.bduss;
  if (!bduss) throw new ToolError('ACCESS_DENIED', '百度网盘需要登录态，请先配置 BDUSS。');
  return `BDUSS=${bduss}`;
}

export const baiduAdapter: BaiduAdapter = {
  platform: 'baidu',
  label: '百度网盘',
  requiresCredential: true,

  parseEntries(data) {
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
      const id = isDirectory ? (typeof entry.path === 'string' ? entry.path : '') : typeof entry.fs_id === 'string' ? entry.fs_id : '';
      if (!id) continue;
      const size = Number(entry.size ?? 0);
      files.push({
        id,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.server_mtime === 'string' ? entry.server_mtime : undefined,
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

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const cookie = cookieOf(context);
    // The short url of the platform is the share code without its first
    // character, so the code of the link has to lose it as well.
    const surl = context.shareId.startsWith('1') ? context.shareId.slice(1) : context.shareId;
    let sekey = '';
    if (context.code) {
      const verify = await context.session.postJson(`https://pan.baidu.com/share/verify?surl=${surl}`, {
        pwd: context.code, vcode: '', channel: 'chunlei', web: 1, app_id: APP_ID, clienttype: 0,
      }, { ...headersOf(surl), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });
      const verifyData = verify.data as Record<string, unknown> | undefined;
      const errno = typeof verifyData?.errno === 'number' ? verifyData.errno : 0;
      if (errno !== 0) {
        throw new ToolError('INVALID_INPUT', this.describeError(errno, typeof verifyData?.errmsg === 'string' ? verifyData.errmsg : ''));
      }
      sekey = typeof verifyData?.randsk === 'string' ? verifyData.randsk : '';
    }
    const query = new URLSearchParams({
      method: 'list', shorturl: surl, page: '1', num: '100', root: '1', dir: '/',
    });
    if (sekey) query.set('sekey', sekey);
    // The listing of a folder needs the sign of the verification, and the
    // platform only accepts it as a cookie.
    const authCookie = sekey && !cookie.includes('BDCLND=') ? `${cookie}; BDCLND=${sekey}` : cookie;
    const response = await context.session.get(
      `https://pan.baidu.com/rest/2.0/xpan/share?${query.toString()}`,
      { ...headersOf(surl), Cookie: authCookie },
    );
    const answer = (response.data ?? {}) as Record<string, unknown>;
    const errno = typeof answer.errno === 'number' ? answer.errno : 0;
    if (errno !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(errno, typeof answer.errmsg === 'string' ? answer.errmsg : ''));
    }
    return { title: '百度网盘分享', files: this.parseEntries(answer) };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const cookie = cookieOf(context);
    const surl = context.shareId.startsWith('1') ? context.shareId.slice(1) : context.shareId;
    // The address of a shared file is encrypted, so the file has to be
    // transferred into the drive of the user first. The copy is put into a
    // folder of its own and removed again once the address is fetched.
    const transferQuery = new URLSearchParams({
      shareid: context.shareId, from: '', channel: 'chunlei', sekey: '', ondup: 'newcopy',
      web: '1', app_id: APP_ID, bdstoken: '', clienttype: '0',
    });
    const transfer = await context.session.postForm(
      `https://pan.baidu.com/share/transfer?${transferQuery.toString()}`,
      { fsidlist: `[${file.id}]`, path: TEMP_DIR },
      { ...headersOf(surl), Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    );
    const transferData = transfer.data as Record<string, unknown> | undefined;
    const errno = typeof transferData?.errno === 'number' ? transferData.errno : 0;
    if (errno !== 0) {
      throw new ToolError('TOOL_FAILED', this.describeError(errno, typeof transferData?.errmsg === 'string' ? transferData.errmsg : ''));
    }
    const extra = transferData && typeof transferData.extra === 'object' ? transferData.extra as Record<string, unknown> : {};
    const list = Array.isArray(extra.list) ? extra.list : [];
    const first = list[0] && typeof list[0] === 'object' ? list[0] as Record<string, unknown> : undefined;
    const fsId = first && typeof first.to_fs_id === 'string' ? first.to_fs_id : '';
    const path = first && typeof first.to === 'string' ? first.to : `${TEMP_DIR}/${file.name}`;
    if (!fsId) throw new ToolError('TOOL_FAILED', '百度网盘没有返回转存结果。');
    try {
      const metasQuery = new URLSearchParams({
        dlink: '1', fsids: `[${fsId}]`, bdstoken: '', clienttype: '0', app_id: APP_ID, web: '1',
      });
      const metas = await context.session.get(
        `https://pan.baidu.com/api/filemetas?${metasQuery.toString()}`,
        { ...headersOf(surl), Cookie: cookie },
      );
      const metasData = metas.data as Record<string, unknown> | undefined;
      const dlink = this.parseDlink(metasData);
      if (!dlink) throw new ToolError('TOOL_FAILED', '百度网盘没有返回下载地址。');
      const headers = { 'User-Agent': WEB_UA, Referer: 'https://pan.baidu.com/' };
      const probe = await context.session.probe(dlink, headers);
      if (probe.status !== 200 && probe.status !== 206) {
        throw new ToolError('TOOL_FAILED', `百度网盘下载地址探测失败（HTTP ${probe.status}）。`);
      }
      return {
        path: file.path,
        name: file.name,
        sizeBytes: file.sizeBytes,
        url: dlink,
        headers,
        rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
        source: { platform: 'baidu', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
        note: '这个直链来自一次临时转存，转存的文件已在取链后删除。',
      };
    } finally {
      // The copy is of no use once the address is known, so it goes away.
      await context.session.postForm(
        'https://pan.baidu.com/api/filemanager?opera=delete',
        { filelist: `[${JSON.stringify(path)}]` },
        { ...headersOf(surl), Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      ).catch(() => undefined);
    }
  },
};
