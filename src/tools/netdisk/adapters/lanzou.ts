import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface FolderParams { lx: string; fid: string; t: string; k: string }

export interface LanzouSharePage {
  baseUrl: string;
  title: string;
  isFolder: boolean;
  needsPwd: boolean;
  fileId: string | null;
  folderParams: FolderParams | null;
  singleFile: NetdiskFile | null;
  html: string;
}

/**
 * The adapter of the lanzou share link. The object holds the pure helpers
 * next to the protocol methods, so a helper can be tested without a network.
 */
export type LanzouAdapter = NetdiskAdapter & {
  parseSharePage(html: string, shareUrl: string): LanzouSharePage;
  parseDisplaySize(text: string): number;
  fetchSharePage(context: AdapterContext): Promise<LanzouSharePage>;
  fetchPage(context: AdapterContext, url: string, referer: string): Promise<string>;
  listFolder(context: AdapterContext, page: LanzouSharePage, pwd: string | null): Promise<NetdiskFile[]>;
  verifyLink(context: AdapterContext, jump: string, shareOrigin: string): Promise<{ url: string; rangeSupported: boolean | null }>;
};

function jsVar(html: string, name: string): string | null {
  // The word boundary keeps a name from being found inside another one, so
  // "t" does not pick the value of "content" and "sign" does not pick the
  // value of "wp_sign".
  const matched = new RegExp(`(?:var\\s+)?\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(html);
  return matched?.[1] ?? null;
}

/**
 * The share id is the last segment of the path. The markers in front of it
 * ("i" for a file, "b" for a folder) are separate segments, so they are gone
 * with the segment they sit in.
 */
function shareIdOf(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

/** The file id a member address carries in its own query. */
function fileIdOfQuery(address: string): string | null {
  try { return new URL(address).searchParams.get('file'); }
  catch { return null; }
}

export const lanzouAdapter: LanzouAdapter = {
  platform: 'lanzou',
  label: '蓝奏云',
  requiresCredential: false,

  parseSharePage(html, shareUrl) {
    const url = new URL(shareUrl);
    const baseUrl = `${url.protocol}//${url.host}`;
    const needsPwd = html.includes('请输入密码') || html.includes('id="pwbox"')
      || html.includes('input_password') || html.includes('密码不正确') || html.includes('function down_p(');
    // The page marks a folder share itself; the prefix of the link only tells
    // what the link claims, so the page is the authority.
    const isFolder = html.includes('filemoreajax') || html.includes('class="filemore"') || html.includes('file_more');
    const fileId = /(?:ajaxm|ajaxfile)\.php\?file=(\d+)/.exec(html)?.[1]
      ?? /name=["']file["']\s+value=["'](\d+)["']/.exec(html)?.[1]
      ?? /file=(\d+)/.exec(html)?.[1] ?? null;
    const lx = jsVar(html, 'lx');
    const fid = jsVar(html, 'fid') ?? shareIdOf(url);
    const t = jsVar(html, 't');
    const k = jsVar(html, 'k');
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    const sizeText = /(?:文件大小|大小)\s*[:：]\s*([\d.]+)\s*([KMGT]?)(?:i?B)?/i.exec(html);
    const shareId = shareIdOf(url);
    const singleFile = isFolder ? null : {
      id: shareId,
      path: shareId,
      name: title,
      sizeBytes: sizeText ? this.parseDisplaySize(`${sizeText[1]} ${sizeText[2]}`) : null,
      isDirectory: false,
    };
    return {
      baseUrl, title: title || '蓝奏分享', isFolder, needsPwd, fileId,
      folderParams: isFolder && lx && t && k ? { lx, fid, t, k } : null,
      singleFile, html,
    };
  },

  parseDisplaySize(text: string): number {
    const matched = /([\d.]+)\s*([KMGT]?)i?B?/i.exec(text.trim());
    if (!matched) return 0;
    const value = Number(matched[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = matched[2].toUpperCase();
    const factor = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : unit === 'T' ? 1024 ** 4 : 1;
    return Math.round(value * factor);
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    context.reportProgress('读取分享内容');
    const page = await this.fetchSharePage(context);
    if (page.needsPwd && !context.code) {
      throw new ToolError('INVALID_INPUT', '该分享需要提取码，请在链接或输入框中提供。');
    }
    if (!page.isFolder) {
      if (!page.singleFile) throw new ToolError('TOOL_FAILED', '无法从分享页解析出文件。');
      return { title: page.title, files: [page.singleFile] };
    }
    if (!page.folderParams) throw new ToolError('TOOL_FAILED', '无法从分享页解析出目录参数。');
    const files = await this.listFolder(context, page, context.code);
    return { title: page.title, files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    context.reportProgress('解析下载地址');
    const page = await this.fetchSharePage(context);
    // A member of a folder share carries the download parameters in its own
    // address, so the member page has to be read before the parameters can be
    // found.
    const member = file.path.includes('?') ? `${page.baseUrl}/${file.path}` : null;
    let referer = member ?? context.shareUrl;
    let html = member ? await this.fetchPage(context, member, referer) : page.html;
    const iframe = /<iframe[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
    if (iframe) {
      const absolute = new URL(iframe, page.baseUrl).href;
      html = await this.fetchPage(context, absolute, referer);
      referer = absolute;
    }
    const htmlFileId = /(?:ajaxm|ajaxfile)\.php\?file=(\d+)/.exec(html)?.[1] ?? /file=(\d+)/.exec(html)?.[1];
    // The file id of a member comes from the member itself. The landing page
    // of a folder share knows the id of the folder, which is of no use here.
    const fileId = member ? htmlFileId ?? fileIdOfQuery(member) : page.fileId ?? htmlFileId;
    if (!fileId) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    const sign = /data\s*:\s*\{[^}]*['"]sign['"]\s*:\s*['"]([^'"]+)['"][^}]*\}/i.exec(html)?.[1]
      ?? jsVar(html, 'wp_sign') ?? jsVar(html, 'sign');
    if (!sign) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    const ajaxUrl = new URL('/ajaxm.php', page.baseUrl).href;
    const fields: Record<string, string> = { action: 'downprocess', sign };
    if (page.needsPwd && context.code) {
      fields.p = context.code;
      fields.kd = '1';
    } else {
      const key = jsVar(html, 'websignkey') ?? /websignkey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(html)?.[1];
      if (!key) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
      const ajaxData = jsVar(html, 'ajaxdata');
      if (ajaxData) fields.signs = ajaxData;
      fields.websignkey = key;
      fields.websign = jsVar(html, 'websign') ?? '';
      fields.kd = '1';
      fields.ves = '1';
    }
    const response = await context.session.postForm(ajaxUrl, fields, { Referer: referer, Origin: page.baseUrl, 'User-Agent': WEB_UA });
    const data = response.data as { zt?: number; dom?: string; url?: string; inf?: string };
    if (data.zt !== 1) {
      const reason = data.inf ?? '';
      if (reason.includes('密码') || reason.includes('提取码')) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (reason.includes('频繁')) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      throw new ToolError('TOOL_FAILED', `蓝奏云解析失败：${reason || '接口未返回下载参数。'}`);
    }
    if (!data.dom || !data.url) throw new ToolError('TOOL_FAILED', '蓝奏云解析失败：接口未返回下载地址。');
    const jump = `${new URL(data.dom).protocol}//${new URL(data.dom).host}/file/${data.url}`;
    const verified = await this.verifyLink(context, jump, page.baseUrl);
    return {
      path: file.path, name: file.name, sizeBytes: file.sizeBytes,
      url: verified.url,
      headers: { Referer: referer, Origin: page.baseUrl, 'User-Agent': WEB_UA, Cookie: 'down_ip=1' },
      rangeSupported: verified.rangeSupported,
      source: { platform: 'lanzou', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId },
    };
  },

  async fetchSharePage(context: AdapterContext): Promise<LanzouSharePage> {
    const html = await this.fetchPage(context, context.shareUrl, context.shareUrl);
    return this.parseSharePage(html, context.shareUrl);
  },

  async fetchPage(context: AdapterContext, url: string, referer: string): Promise<string> {
    // The share page is HTML, so the text of the page is read instead of a
    // JSON body.
    const response = await context.session.getHtml(url, { Referer: referer, 'User-Agent': WEB_UA });
    if (!response.html) throw new ToolError('TOOL_FAILED', '蓝奏云分享页为空，解析失败。');
    return response.html;
  },

  async listFolder(context: AdapterContext, page: LanzouSharePage, pwd: string | null): Promise<NetdiskFile[]> {
    const params = page.folderParams;
    if (!params) throw new ToolError('TOOL_FAILED', '无法从分享页解析出目录参数。');
    const files: NetdiskFile[] = [];
    const seen = new Set<string>();
    for (let pg = 1; pg <= 500; pg++) {
      context.reportProgress(`读取目录第 ${pg} 页`);
      const response = await context.session.postForm(`${page.baseUrl}/filemoreajax.php`, {
        lx: params.lx, fid: params.fid, t: params.t, k: params.k, pwd: pwd ?? '', pg: String(pg),
      }, { Referer: context.shareUrl, Origin: page.baseUrl, 'User-Agent': WEB_UA });
      const body = response.data as { zt?: number; text?: Array<Record<string, string>> };
      if (body.zt === 2) break;
      if (body.zt === 3) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (body.zt !== 1) throw new ToolError('TOOL_FAILED', '蓝奏云目录解析失败。');
      const entries = body.text ?? [];
      if (!entries.length) break;
      let added = 0;
      for (const item of entries) {
        // The reference of an entry carries its own download parameters, so it
        // has to be kept whole.
        const reference = item.id ?? '';
        if (!reference) continue;
        const id = reference.split('?')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name = item.name_all || item.name || id;
        files.push({
          id, path: reference, name,
          sizeBytes: this.parseDisplaySize(item.size ?? '0') || null,
          isDirectory: item.isfolder === '1' || item.is_dir === '1',
          modifiedAt: item.time ?? undefined,
        });
        added++;
      }
      if (!added) break;
    }
    return files;
  },

  async verifyLink(context: AdapterContext, jump: string, shareOrigin: string): Promise<{ url: string; rangeSupported: boolean | null }> {
    // The download node only serves the file when the cookie says so. The
    // session owns the cookie jar and drops a cookie the caller hands in, so
    // the cookie is written into the jar of the node instead.
    context.session.setCookie(jump, 'down_ip', '1');
    let url = jump;
    for (let attempt = 0; attempt < 5; attempt++) {
      const probe = await context.session.probe(url, { Referer: shareOrigin, 'User-Agent': WEB_UA });
      if (probe.location) { url = new URL(probe.location, url).href; continue; }
      if (probe.status === 206 || probe.status === 200) {
        // The node may answer with the "验证并下载" page or with the human
        // check instead of the file. Such a page is not a direct link, so it
        // is reported instead of handed out.
        if (probe.contentType && probe.contentType.includes('text/html')) {
          throw new ToolError('TOOL_FAILED', '蓝奏云下载节点返回了验证页面，未能取得直链。');
        }
        // The link that is handed out is the one the probe landed on, so the
        // downloader never sees a link that was not confirmed.
        return { url: probe.finalUrl || url, rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes' };
      }
      if (probe.status === 403 || probe.status === 404 || probe.status === 410) {
        throw new ToolError('TOOL_FAILED', '蓝奏云下载地址已失效。');
      }
      if (probe.status === 429) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      throw new ToolError('TOOL_FAILED', `蓝奏云下载地址探测失败（HTTP ${probe.status}）。`);
    }
    throw new ToolError('TOOL_FAILED', '蓝奏云下载地址探测重定向次数过多。');
  },
};
