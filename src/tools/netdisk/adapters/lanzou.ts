import { setTimeout as delay } from 'node:timers/promises';
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface FolderParams { lx: string; fid: string; t: string; k: string }

/**
 * The parameters of the download endpoint of the platform. The endpoint and
 * its sign are declared by the inner page of the share, and the sign is a
 * token that only lives as long as the page that declared it.
 */
interface DownloadParams {
  endpoint: string;
  sign: string;
  ajaxData: string;
  kdns: string;
}

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
  parseInnerPage(html: string): DownloadParams | null;
  fetchSharePage(context: AdapterContext): Promise<LanzouSharePage>;
  fetchPage(context: AdapterContext, url: string, referer: string): Promise<string>;
  listFolder(context: AdapterContext, page: LanzouSharePage, pwd: string | null): Promise<NetdiskFile[]>;
  requestPage(context: AdapterContext, page: LanzouSharePage, params: FolderParams, pwd: string | null, pg: number): Promise<unknown>;
  verifyLink(context: AdapterContext, jump: string, referer: string): Promise<{ url: string; rangeSupported: boolean | null }>;
  readNode(context: AdapterContext, url: string, referer: string): Promise<NodeAnswer>;
  submitVerification(context: AdapterContext, pageUrl: string, body: string): Promise<string | null>;
};

/**
 * The scripts of a page. A variable of the platform lives in a script, so
 * only the scripts are read for it. Markup outside a script can carry a
 * parameter of the same name, and that must not shadow the variable.
 */
function scriptsOf(html: string): string {
  const blocks: string[] = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let matched = pattern.exec(html);
  while (matched) {
    blocks.push(matched[1]);
    matched = pattern.exec(html);
  }
  return blocks.join('\n');
}

/**
 * Reads a value of a script of the page. The word boundary keeps a name from
 * being found inside another one, so "t" does not pick the value of
 * "content" and "sign" does not pick the value of "wp_sign". A page states a
 * number without quotes, so both spellings are read. A name in front of a
 * query parameter is not a variable either, so the parameter of an url does
 * not pass for one.
 */
function jsValue(source: string, name: string): string | null {
  const matched = new RegExp(`(?:var\\s+)?(?<![\\w?&=])${name}\\s*=\\s*(?:["']([^"']*)["']|([A-Za-z0-9_.:/?=&+-]+))`).exec(source);
  if (!matched) return null;
  return matched[1] ?? matched[2] ?? null;
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

/**
 * A url of the platform is read from a page, so it can be malformed. A url
 * that cannot be read is reported as a failure of the platform instead of
 * ending in a raw error.
 */
function safeUrl(value: string, base?: string): URL | null {
  try { return new URL(value, base); }
  catch { return null; }
}

/**
 * The order in which the challenge of the download node shuffles the bytes of
 * its token. The challenge is the well known one, so its permutation is
 * fixed.
 */
const ACW_POS = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36];
const ACW_MASK = '3000176000856006061501533003690027800375';

/**
 * The cookie value that answers the challenge of the download node. The
 * challenge hands out a token and expects the shuffled token back, so the
 * answer is the token with its bytes permuted and then masked.
 */
export function acwScV2(arg1: string): string {
  const shuffled = new Array<string>(ACW_POS.length);
  for (let x = 0; x < arg1.length; x++) {
    for (let z = 0; z < ACW_POS.length; z++) {
      if (ACW_POS[z] === x + 1) shuffled[z] = arg1[x];
    }
  }
  const joined = shuffled.join('');
  let out = '';
  for (let i = 0; i + 2 <= joined.length && i + 2 <= ACW_MASK.length; i += 2) {
    const value = parseInt(joined.slice(i, i + 2), 16);
    const mask = parseInt(ACW_MASK.slice(i, i + 2), 16);
    out += (value ^ mask).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * The backoff of the platform. The platform refuses a burst of requests, so a
 * failure waits longer the more often it failed.
 */
const BACKOFF_BASE_MS = 600;
const MAX_RETRIES = 3;
/** The spacing between two pages of a folder. */
const PAGE_INTERVAL_MS = 800;
/**
 * The node answers the submission of the verification page only after it has
 * settled. A submission that comes at once is refused with a sign error, so
 * the submission waits.
 */
const VERIFY_SETTLE_MS = 2000;
/** How many times the challenge of the node is solved before it is given up on. */
const MAX_REDIRECTS = 5;

/** The answer of the download endpoint, as far as the adapter cares about it. */
interface DownloadAnswer { zt?: number; dom?: string; url?: string; inf?: string | number }

/** The answer of the verification endpoint of the download node. */
interface VerifyAnswer { zt?: number; dom?: string | null; url?: string }

/** The answer of the node, as far as the adapter cares about it. */
interface NodeAnswer {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  acceptRanges?: string;
}

export const lanzouAdapter: LanzouAdapter = {
  platform: 'lanzou',
  label: '蓝奏云',
  requiresCredential: false,

  parseSharePage(html, shareUrl) {
    const url = safeUrl(shareUrl);
    if (!url) throw new ToolError('INVALID_INPUT', '请输入有效的蓝奏云分享链接。');
    const baseUrl = `${url.protocol}//${url.host}`;
    // The variables of the page live in its scripts, so only the scripts are
    // read for them. A parameter of an url in the markup around them must
    // not pass for a variable.
    const script = scriptsOf(html);
    const needsPwd = html.includes('请输入密码') || html.includes('id="pwbox"')
      || html.includes('input_password') || html.includes('密码不正确') || html.includes('function down_p(');
    // The page marks a folder share itself; the prefix of the link only tells
    // what the link claims, so the page is the authority.
    const isFolder = html.includes('filemoreajax') || html.includes('class="filemore"') || html.includes('file_more');
    // The landing page of a single file share states the id of the file in a
    // field of its own, as "var fid = 6513996;". The id of a folder share is
    // the id of the folder, so it is not an id of a file.
    const statedId = jsValue(script, 'fid');
    // The id in the address of an endpoint is a url, not a variable of the
    // page, so it is looked for in the whole document.
    const endpointId = /(?:ajaxm|ajaxfile)\.php\?file=(\d+)/.exec(html)?.[1]
      ?? /name=["']file["']\s+value=["'](\d+)["']/.exec(html)?.[1] ?? null;
    const fileId = isFolder
      ? endpointId
      : (statedId && /^\d+$/.test(statedId) ? statedId : endpointId);
    const lx = jsValue(script, 'lx');
    const fid = statedId ?? shareIdOf(url);
    const t = jsValue(script, 't');
    const k = jsValue(script, 'k');
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    const sizeText = /(?:文件大小|大小)\s*[:：]\s*([\d.]+)\s*([KMGT]?)(?:i?B)?/i.exec(html);
    const shareId = shareIdOf(url);
    const singleFile = isFolder ? null : {
      id: shareId,
      // The path of a member is the name the user reads, so the signed
      // address of the platform stays out of it.
      path: title || shareId,
      name: title || shareId,
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

  /**
   * The inner page declares the endpoint of the download and the tokens of
   * the request. The token of the sign is fresh on every page, so it can only
   * be used with the request of that very page.
   */
  parseInnerPage(html: string): DownloadParams | null {
    const script = scriptsOf(html);
    const endpoint = jsValue(script, 'domain1') ?? jsValue(script, 'domain2');
    const sign = jsValue(script, 'wp_sign');
    // The key of the request is not a variable of the page: the script of the
    // page sends the value of "ajaxdata" under both names.
    const ajaxData = jsValue(script, 'ajaxdata');
    if (!endpoint || !sign || !ajaxData) return null;
    return { endpoint, sign, ajaxData, kdns: jsValue(script, 'kdns') ?? '1' };
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
    // found. The address is the signed one the platform hands out, and it
    // travels in its own field, because the path of the member is the name
    // the user reads.
    const address = file.fidToken ?? file.id;
    const member = page.isFolder ? `${page.baseUrl}/${address}` : null;
    let referer = member ?? context.shareUrl;
    let html = member ? await this.fetchPage(context, member, referer) : page.html;
    const iframe = /<iframe[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
    if (iframe) {
      const absolute = safeUrl(iframe, page.baseUrl)?.href;
      if (!absolute) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
      html = await this.fetchPage(context, absolute, referer);
      referer = absolute;
    }
    const params = this.parseInnerPage(html);
    if (!params) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    // The id of the file is the id of the share itself for a single file
    // share, and the id the member carries for a member of a folder share.
    const fileId = member ? file.id : page.fileId;
    if (!fileId) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    const fields: Record<string, string> = {
      action: 'downprocess',
      // The page sends the value of "ajaxdata" under both names, so the key
      // and the second signature are the same value.
      websignkey: params.ajaxData,
      signs: params.ajaxData,
      sign: params.sign,
      websign: '',
      kd: params.kdns,
      ves: '1',
    };
    if (page.needsPwd && context.code) fields.p = context.code;
    // The endpoint lives on a host of its own, but the request is the one of
    // the page that declared it, so the page is the origin of the request.
    const response = await context.session.postForm(params.endpoint, fields, {
      Referer: referer, Origin: page.baseUrl, 'User-Agent': WEB_UA,
    });
    const data = response.data as DownloadAnswer | null;
    if (!data || typeof data !== 'object') throw new ToolError('TOOL_FAILED', '蓝奏云解析失败：接口未返回下载参数。');
    if (data.zt !== 1) {
      const reason = typeof data.inf === 'string' ? data.inf : '';
      if (reason.includes('密码') || reason.includes('提取码')) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (reason.includes('频繁')) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      throw new ToolError('TOOL_FAILED', `蓝奏云解析失败：${reason || '接口未返回下载参数。'}`);
    }
    if (!data.dom || !data.url) throw new ToolError('TOOL_FAILED', '蓝奏云解析失败：接口未返回下载地址。');
    const node = safeUrl(data.dom);
    if (!node) throw new ToolError('TOOL_FAILED', '蓝奏云解析失败：接口未返回下载地址。');
    const jump = `${node.protocol}//${node.host}/file/${data.url}`;
    const verified = await this.verifyLink(context, jump, referer);
    return {
      path: file.path, name: file.name, sizeBytes: file.sizeBytes,
      url: verified.url,
      // The headers belong to the node that handed out the link, because the
      // node is the page the download starts from.
      headers: { Referer: `${node.protocol}//${node.host}/`, Origin: `${node.protocol}//${node.host}`, 'User-Agent': WEB_UA },
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
      // The pages of a folder are spaced, so the platform does not treat the
      // burst of requests as abuse.
      if (pg > 1) await delay(PAGE_INTERVAL_MS);
      const body = await this.requestPage(context, page, params, pwd, pg);
      if (!body || typeof body !== 'object') throw new ToolError('TOOL_FAILED', '蓝奏云目录解析失败：接口未返回目录内容。');
      const answer = body as { zt?: number; text?: unknown };
      if (answer.zt === 2) break;
      if (answer.zt === 3) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (answer.zt !== 1) throw new ToolError('TOOL_FAILED', '蓝奏云目录解析失败。');
      // A page that does not carry the list of the members is a shape the
      // adapter cannot read, so it is reported instead of being read as an
      // empty page.
      if (!Array.isArray(answer.text)) throw new ToolError('TOOL_FAILED', '蓝奏云目录解析失败：接口未返回文件列表。');
      const entries = answer.text as Array<Record<string, string>>;
      if (!entries.length) break;
      let added = 0;
      for (const item of entries) {
        // The signed address of a member is a field of its own. The field
        // "id" of the entry is the identity of the member, and only carries
        // the address when the platform states no address of its own.
        const address = item.fidToken || item.id || '';
        if (!address) continue;
        const id = (item.id || address).split('?')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name = item.name_all || item.name || id;
        const isDirectory = item.isfolder === '1' || item.is_dir === '1';
        files.push({
          id,
          // The path is the name the user reads, so it can be pasted into the
          // tool again; a folder carries the separator of its children.
          path: isDirectory ? `${name}/` : name,
          // The address the download is started from is kept apart from the
          // path, because the path is read by the user and the address is not.
          fidToken: address,
          name,
          sizeBytes: this.parseDisplaySize(item.size ?? '0') || null,
          isDirectory,
          modifiedAt: item.time ?? undefined,
        });
        added++;
      }
      if (!added) break;
    }
    return files;
  },

  /**
   * One page of a folder. A failure is retried with a backoff, and the page
   * that failed is asked again, so no member of the folder is skipped.
   */
  async requestPage(
    context: AdapterContext,
    page: LanzouSharePage,
    params: FolderParams,
    pwd: string | null,
    pg: number,
  ): Promise<unknown> {
    let failure: ToolError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await delay(BACKOFF_BASE_MS * attempt);
      try {
        const response = await context.session.postForm(`${page.baseUrl}/filemoreajax.php`, {
          lx: params.lx, fid: params.fid, t: params.t, k: params.k, pwd: pwd ?? '', pg: String(pg),
        }, { Referer: context.shareUrl, Origin: page.baseUrl, 'User-Agent': WEB_UA });
        const body = response.data as { zt?: number; inf?: string } | null;
        // The platform answers a burst with a complaint, and the complaint is
        // a reason to wait rather than a reason to skip the page.
        const reason = typeof body?.inf === 'string' ? body.inf : '';
        if (body?.zt !== 1 && reason.includes('频繁')) {
          failure = new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
          continue;
        }
        return body;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        failure = error;
      }
    }
    throw failure ?? new ToolError('TOOL_FAILED', '蓝奏云目录解析失败。');
  },

  /**
   * Turns the answer of the download node into a link that serves the file.
   *
   * The node answers with a page that asks for a human check, and then with a
   * page that asks for a confirmation. Both are answered here, so the link
   * that comes out is the one the file is really served from.
   */
  async verifyLink(context: AdapterContext, jump: string, referer: string): Promise<{ url: string; rangeSupported: boolean | null }> {
    // The download node only serves the file when the cookie says so. The
    // session owns the cookie jar and drops a cookie the caller hands in, so
    // the cookie is written into the jar of the node instead.
    context.session.setCookie(jump, 'down_ip', '1');
    let url = jump;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const answer = await this.readNode(context, url, referer);
      // The node answers with a compressed page, so the probe has to accept
      // one to be able to tell a page from a file.
      if (answer.status === 403 || answer.status === 404 || answer.status === 410) {
        throw new ToolError('TOOL_FAILED', '蓝奏云下载地址已失效。');
      }
      if (answer.status === 429) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      if (answer.status !== 200 && answer.status !== 206) {
        throw new ToolError('TOOL_FAILED', `蓝奏云下载地址探测失败（HTTP ${answer.status}）。`);
      }
      const isPage = (answer.contentType ?? '').includes('text/html');
      if (!isPage) {
        // The answer is the file itself, so the link is ready.
        return { url: answer.finalUrl || url, rangeSupported: answer.status === 206 || answer.acceptRanges === 'bytes' };
      }
      const challenge = /var\s+arg1\s*=\s*'([0-9A-Fa-f]+)'/.exec(answer.body)?.[1];
      if (challenge) {
        // The node asks for the answer of its challenge. The answer is a
        // cookie of the node, so it stays in the jar of the node.
        context.session.setCookie(url, 'acw_sc__v2', acwScV2(challenge));
        continue;
      }
      const direct = await this.submitVerification(context, answer.finalUrl || url, answer.body);
      if (!direct) throw new ToolError('TOOL_FAILED', '蓝奏云下载节点返回了验证页面，未能取得直链。');
      // The link is confirmed by a probe of its own, so the downloader never
      // sees a link that was not confirmed.
      const file = await this.readNode(context, direct, referer);
      if (file.status !== 200 && file.status !== 206) {
        throw new ToolError('TOOL_FAILED', `蓝奏云下载地址探测失败（HTTP ${file.status}）。`);
      }
      return { url: file.finalUrl || direct, rangeSupported: file.status === 206 || file.acceptRanges === 'bytes' };
    }
    throw new ToolError('TOOL_FAILED', '蓝奏云下载地址探测重定向次数过多。');
  },

  /**
   * Reads the answer of the download node. The answer of the node is a page
   * that is compressed, so the probe has to accept a compressed body. A
   * redirect of the node is followed here, up to the limit of the hops.
   */
  async readNode(context: AdapterContext, url: string, referer: string): Promise<NodeAnswer> {
    let current = url;
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const probe = await context.session.probe(current, { Referer: referer, 'User-Agent': WEB_UA }, { acceptCompressed: true });
      if (!probe.location) {
        return {
          status: probe.status,
          finalUrl: probe.finalUrl || current,
          contentType: probe.contentType ?? '',
          body: new TextDecoder('utf-8').decode(probe.body),
          acceptRanges: probe.acceptRanges,
        };
      }
      const next = safeUrl(probe.location, current);
      if (!next) throw new ToolError('TOOL_FAILED', '蓝奏云下载地址探测失败（重定向目标无效）。');
      current = next.href;
    }
    throw new ToolError('TOOL_FAILED', '蓝奏云下载地址探测重定向次数过多。');
  },

  /**
   * Answers the confirmation page of the download node. The page states the
   * parameters of the request and the page asks for one of three kinds of
   * confirmation; only the second one carries a file.
   */
  async submitVerification(context: AdapterContext, pageUrl: string, body: string): Promise<string | null> {
    const params = /data\s*:\s*\{[^}]*'file'\s*:\s*'([^']*)'[^}]*'sign'\s*:\s*'([^']*)'/i.exec(body);
    if (!params) return null;
    const endpoint = safeUrl('ajax.php', pageUrl)?.href;
    if (!endpoint) return null;
    // The node refuses a submission that comes before it has settled, so the
    // submission waits. A refusal is answered by another try of the same
    // submission, so no member of the folder is skipped.
    await delay(VERIFY_SETTLE_MS);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await delay(BACKOFF_BASE_MS * attempt);
      const response = await context.session.postForm(endpoint, {
        file: params[1], el: '2', sign: params[2],
      }, { Referer: pageUrl, 'User-Agent': WEB_UA });
      const answer = response.data as VerifyAnswer | null;
      if (!answer || typeof answer !== 'object') throw new ToolError('TOOL_FAILED', '蓝奏云验证失败：接口未返回下载地址。');
      if (answer.zt !== 1) {
        const reason = typeof answer.url === 'string' ? answer.url : '';
        if (reason.includes('频繁')) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
        // A sign error means the node was not settled yet, so the submission
        // is tried again.
        if (reason.includes('SignError')) continue;
        throw new ToolError('TOOL_FAILED', `蓝奏云验证失败：${reason || '接口未返回下载地址。'}`);
      }
      if (!answer.url) throw new ToolError('TOOL_FAILED', '蓝奏云验证失败：接口未返回下载地址。');
      return answer.url;
    }
    throw new ToolError('TOOL_FAILED', '蓝奏云验证失败：节点未接受验证，请稍后重试。');
  },
};
