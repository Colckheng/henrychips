import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
const SHARE_BASE = 'https://share-kd-njs.yun.139.com';
const SHARE_LIST_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6`;
const SHARE_LINK_URL = `${SHARE_BASE}/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3`;
/** The share endpoints share one fixed key; the key of the code endpoint is a different one. */
const SHARE_AES_KEY = 'wI6jsI1J8C5A2r6C';
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
};

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
      files.push({
        id,
        path: name,
        name,
        sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
        isDirectory: false,
        modifiedAt: typeof entry.coCreateDate === 'string' ? entry.coCreateDate : undefined,
      });
    }
    return files;
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const request = {
      account: '',
      linkID: context.shareId,
      passwd: context.code ?? '',
      caSrt: 1,
      coSrt: 1,
      srtDr: 0,
      bNum: 1,
      pCaID: 'root',
      eNum: 200,
    };
    const response = await context.session.postJson(
      SHARE_LIST_URL,
      this.encryptBody(JSON.stringify({ getOutLinkInfoReq: request })),
      {
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
      },
    );
    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? {});
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(this.decryptBody(raw)) as Record<string, unknown>;
    } catch {
      try { answer = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new ToolError('TOOL_FAILED', '139 网盘的应答无法解析。'); }
    }
    const code = typeof answer.resultCode === 'string' ? answer.resultCode : '';
    if (code && code !== '0') {
      throw new ToolError('TOOL_FAILED', typeof answer.desc === 'string' ? answer.desc : `139 网盘返回了错误码 ${code}。`);
    }
    const data = answer.data && typeof answer.data === 'object' ? answer.data as Record<string, unknown> : {};
    return { title: '139 分享', files: this.parseEntries(data) };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const request = {
      account: '',
      linkID: context.shareId,
      coIDLst: { item: [file.id] },
      commonAccountInfo: { account: '', accountType: 1 },
    };
    const response = await context.session.postJson(
      SHARE_LINK_URL,
      this.encryptBody(JSON.stringify({ dlFromOutLinkReqV3: request })),
      {
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': MOBILE_UA,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://yun.139.com',
        Referer: 'https://yun.139.com/',
        'hcy-cool-flag': '1',
        'x-deviceinfo': X_DEVICEINFO,
        'x-huawei-channelsrc': X_HUAWEI_CHANNELSRC,
        'x-mm-source': X_MM_SOURCE,
      },
    );
    const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? {});
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(this.decryptBody(raw)) as Record<string, unknown>;
    } catch {
      try { answer = JSON.parse(raw) as Record<string, unknown>; }
      catch { throw new ToolError('TOOL_FAILED', '139 网盘的应答无法解析。'); }
    }
    const code = typeof answer.resultCode === 'string' ? answer.resultCode : '';
    if (code && code !== '0') {
      throw new ToolError('TOOL_FAILED', typeof answer.desc === 'string' ? answer.desc : `139 网盘返回了错误码 ${code}。`);
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
