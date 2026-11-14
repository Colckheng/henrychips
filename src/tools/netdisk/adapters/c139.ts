import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
const SHARE_BASE = 'https://share-kd-njs.yun.139.com';
const SHARE_LIST_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6`;
const SHARE_LINK_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3`;
/**
 * The share endpoints share one fixed key; the key of the code endpoint is a different one.
 *
 * The key below is the current one: YunX (`app/src/main/kotlin/com/yunx/app/data/network/C139Constants.kt`,
 * `SHARE_AES_KEY`) carries the same value, and it was verified live on 2026-11-14 against three real shares.
 * The previous key `wI6jsI1J8C5A2r6C` stopped working — the platform answers with ciphertext that key cannot open.
 */
const SHARE_AES_KEY = 'PVGDwmcvfs1uV3d1';
/** How deep the folders of a share are walked, so a share that points into itself ends. */
const MAX_DEPTH = 8;
/** How many members one window of a folder asks for. */
const PAGE_SIZE = 200;
const X_DEVICEINFO = '||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||';
const X_HUAWEI_CHANNELSRC = '10245500';
const X_MM_SOURCE = '0002';

/**
 * The adapter of the 139 share link. The object holds the pure helpers next
 * to the protocol methods, so a helper can be tested without a network.
 */
export type C139Adapter = NetdiskAdapter & {
  /** Encrypts a request body the way the share endpoints expect it. */
  encryptBody(plaintext: string): string;
  /** Decrypts an answer; the platform may also answer in plain text. */
  decryptBody(body: string): string;
  /** Reads the entries of a share, folders and files together. */
  parseEntries(data: unknown): NetdiskFile[];
  /** Signs a request the way the gateway of the platform expects it. */
  signHeader(body: string, timestamp?: string, random?: string): string;
  /** Turns the codes of the platform into a message. */
  describeError(code: string, message: string): string;
  /** Unwraps the answer of a share endpoint, encrypted or plain. */
  parseAnswer(data: unknown): Record<string, unknown>;
  /** Reads one window of a folder of the share. */
  requestFolder(context: AdapterContext, pCaID: string, begin: number, end: number): Promise<Record<string, unknown>>;
  /** Reads a folder of the share and the folders in it. */
  walk(context: AdapterContext, pCaID: string, prefix: string, files: NetdiskFile[], depth: number, visited: Set<string>, seen: Set<string>, title: { value: string }): Promise<void>;
};

/** The headers the share endpoints expect. The list endpoint is anonymous, so it carries no signature. */
function headersOf(sign?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=UTF-8',
    'User-Agent': MOBILE_UA,
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://yun.139.com',
    Referer: 'https://yun.139.com/',
    // The flag tells the gateway that the body is encrypted; without it
    // the business layer never sees the plain text.
    'hcy-cool-flag': '1',
    'x-deviceinfo': X_DEVICEINFO,
    'x-huawei-channelsrc': X_HUAWEI_CHANNELSRC,
    'x-mm-source': X_MM_SOURCE,
  };
  if (sign) headers['mcloud-sign'] = sign;
  return headers;
}

/**
 * The signature of the gateway: the body is percent-encoded, its characters
 * are sorted, the result is base64 of that, and three digests of it are
 * combined into one.
 */
function calSign(bodyJson: string, timestamp: string, random: string): string {
  const encoded = encodeURIComponent(bodyJson);
  const sorted = [...encoded].sort().join('');
  const base64 = Buffer.from(sorted, 'utf8').toString('base64');
  const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');
  return md5(md5(base64) + md5(`${timestamp}:${random}`)).toUpperCase();
}

/** Encrypts the body of a share request: AES-CBC with the iv in front. */
function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(SHARE_AES_KEY, 'utf8'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

/**
 * Decrypts an answer of the platform. The decrypted body is sometimes a
 * compressed one, so the compression has to be undone as well.
 */
function decrypt(body: string): string {
  const raw = Buffer.from(body, 'base64');
  if (raw.length <= 16) throw new ToolError('TOOL_FAILED', '139 网盘的应答无法解密。');
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(SHARE_AES_KEY, 'utf8'), raw.subarray(0, 16));
  let plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
  if (plain.length > 2 && plain[0] === 0x1f && plain[1] === 0x8b) plain = gunzipSync(plain);
  return plain.toString('utf8');
}

export const c139Adapter: C139Adapter = {
  platform: 'c139',
  label: '139（和彩云）',
  requiresCredential: false,

  encryptBody(plaintext) {
    return encrypt(plaintext);
  },

  decryptBody(body) {
    return decrypt(body);
  },

  signHeader(body, timestamp, random) {
    // The gateway checks the moment of the request, so it has to be the
    // moment of the request and not the moment of the answer.
    const stamp = timestamp ?? new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const salt = random ?? Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[randomInt(0, 62)]).join('');
    return `${stamp},${salt},${calSign(body, stamp, salt)}`;
  },

  describeError(code, message) {
    // The download endpoint refuses an anonymous call: taking a direct link
    // needs a logged-in 139 account, while listing a share does not.
    if (code === '200000401') return '139 网盘取直链需要登录账号，匿名无法取到下载地址（列目录不需要登录）。';
    return message || `139 网盘返回了错误码 ${code}。`;
  },

  /**
   * Unwraps the answer of a share endpoint: the body is encrypted base64,
   * and the gateway may also pass plain text through.
   */
  parseAnswer(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(this.decryptBody(raw)) as Record<string, unknown>;
    } catch {
      try { answer = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new ToolError('TOOL_FAILED', '139 网盘的应答无法解析。'); }
    }
    return answer;
  },

  async requestFolder(context, pCaID, begin, end) {
    const request = {
      account: '',
      linkID: context.shareId,
      passwd: context.code ?? '',
      caSrt: 1,
      coSrt: 1,
      srtDr: 0,
      bNum: begin,
      pCaID,
      eNum: end,
    };
    const plain = JSON.stringify({ getOutLinkInfoReq: request });
    // The list endpoint is anonymous: no signature, no authorization, the
    // account stays an empty string — that is how the official client calls it.
    const response = await context.session.postJson(SHARE_LIST_URL, this.encryptBody(plain), headersOf());
    const answer = this.parseAnswer(response.data);
    const code = typeof answer.resultCode === 'string' ? answer.resultCode : '';
    if (code && code !== '0') {
      throw new ToolError('TOOL_FAILED', this.describeError(code, typeof answer.desc === 'string' ? answer.desc : ''));
    }
    return answer;
  },

  /**
   * Reads a folder of the share and the folders in it.
   *
   * The depth is limited, because a share that points into itself would
   * otherwise walk forever.
   */
  async walk(context, pCaID, prefix, files, depth, visited, seen, title) {
    if (depth > MAX_DEPTH) return;
    // A folder that was already read is not read again, so a folder that
    // points at itself ends the walk.
    if (visited.has(pCaID)) return;
    visited.add(pCaID);
    const entries: NetdiskFile[] = [];
    let begin = 1;
    for (let page = 0; page < 500; page++) {
      context.reportProgress(`读取目录第 ${page + 1} 页`);
      const answer = await this.requestFolder(context, pCaID, begin, begin + PAGE_SIZE - 1);
      const data = answer.data && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
      if (depth === 0 && typeof data.lkName === 'string' && data.lkName) title.value = data.lkName;
      const batch = this.parseEntries(data);
      entries.push(...batch);
      // A window that is not full is the last one of the folder.
      if (batch.length < PAGE_SIZE) break;
      begin += PAGE_SIZE;
    }
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      // The path of the entry carries the folders it is in.
      const path = `${prefix}${entry.name}${entry.isDirectory ? '/' : ''}`;
      files.push({ ...entry, path });
      if (entry.isDirectory) {
        await this.walk(context, entry.id, `${prefix}${entry.name}/`, files, depth + 1, visited, seen, title);
      }
    }
  },

  parseEntries(data) {
    if (!data || typeof data !== 'object') return [];
    const root = data as Record<string, unknown>;
    const files: NetdiskFile[] = [];
    const folders = Array.isArray(root.caLst) ? root.caLst : [];
    for (const item of folders) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.caID === 'string' ? entry.caID : '';
      if (!id) continue;
      const name = typeof entry.caName === 'string' ? entry.caName : id;
      files.push({ id, path: `${name}/`, name, sizeBytes: null, isDirectory: true });
    }
    const items = Array.isArray(root.coLst) ? root.coLst : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.coID === 'string' ? entry.coID : '';
      if (!id) continue;
      const name = typeof entry.coName === 'string' ? entry.coName : id;
      const size = Number(entry.coSize ?? 0);
      // A member of the file list can be a folder too, and the platform
      // states that by its type.
      const isDirectory = entry.isdir === true
        || Number(entry.coType ?? 1) === 2;
      files.push({
        id,
        path: isDirectory ? `${name}/` : name,
        name,
        sizeBytes: !isDirectory && Number.isFinite(size) && size > 0 ? size : null,
        isDirectory,
        modifiedAt: typeof entry.udTime === 'string' ? entry.udTime
          : typeof entry.ctTime === 'string' ? entry.ctTime
          : typeof entry.coCreateDate === 'string' ? entry.coCreateDate : undefined,
      });
    }
    return files;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const files: NetdiskFile[] = [];
    const title = { value: '139 分享' };
    // A folder that is already visited is not visited again, so a folder that
    // points at itself does not walk forever.
    const visited = new Set<string>();
    // An entry that is already listed is not listed again, so a folder that
    // points at itself does not fill the list with copies of itself.
    const seen = new Set<string>();
    await this.walk(context, 'root', '', files, 0, visited, seen, title);
    return { title: title.value, files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const request = {
      account: '',
      linkID: context.shareId,
      coIDLst: { item: [file.id] },
      commonAccountInfo: { account: '', accountType: 1 },
    };
    const plain = JSON.stringify({ dlFromOutLinkReqV3: request });
    // The download endpoint is signed, unlike the list endpoint — and it
    // refuses an anonymous call, so the error it returns names the login.
    const response = await context.session.postJson(
      SHARE_LINK_URL,
      this.encryptBody(plain),
      headersOf(this.signHeader(plain)),
    );
    const answer = this.parseAnswer(response.data);
    const code = typeof answer.resultCode === 'string' ? answer.resultCode : '';
    if (code && code !== '0') {
      throw new ToolError('TOOL_FAILED', this.describeError(code, typeof answer.desc === 'string' ? answer.desc : ''));
    }
    const data = answer.data && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
    const url = typeof data.redrUrl === 'string' ? data.redrUrl : '';
    if (!url) throw new ToolError('TOOL_FAILED', '139 网盘没有返回下载地址。');
    const headers = {
      'User-Agent': MOBILE_UA,
      Referer: 'https://yun.139.com/',
    };
    const probe = await context.session.probe(url, headers);
    if (probe.status !== 200 && probe.status !== 206) {
      throw new ToolError('TOOL_FAILED', `139 网盘下载地址探测失败（HTTP ${probe.status}）。`);
    }
    return {
      path: file.path,
      name: typeof data.coName === 'string' && data.coName ? data.coName : file.name,
      sizeBytes: typeof data.coSize === 'number' ? data.coSize : file.sizeBytes,
      url,
      headers,
      rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes',
      source: { platform: 'c139', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId: file.id },
    };
  },
};
