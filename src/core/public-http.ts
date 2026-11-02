import dns, { type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import type { PublicHttp, PublicHttpRequest } from '../contracts/tool.js';
import { ToolError } from './errors.js';

/** Reject special-use ranges, including IPv4-mapped and transition IPv6. */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // ipaddr labels otherwise unassigned IPv6 space as unicast too. Only the
  // allocated global-unicast block is eligible; its special ranges stay denied.
  return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function validatePublicUrl(value: string, allowedPorts: number[] = []): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ToolError('INVALID_INPUT', '请输入有效的网页 URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ToolError('ACCESS_DENIED', '只允许不含凭据的 HTTP 或 HTTPS 网页。');
  }
  // Only default ports are allowed unless a caller explicitly trusts a media
  // CDN port. The private-address checks below remain in force either way.
  if (url.port && !allowedPorts.includes(Number(url.port))) {
    throw new ToolError('ACCESS_DENIED', '只允许使用默认端口或已授权的媒体端口。');
  }
  const host = hostname(url);
  const name = host.replace(/\.$/, '');
  if (!name || name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') ||
      (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new ToolError('ACCESS_DENIED', '只允许访问公共互联网地址。');
  }
  url.hash = '';
  return url;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('CANCELLED', '网页请求已取消。');
}

async function resolveAddresses(host: string, signal: AbortSignal): Promise<LookupAddress[]> {
  checkAbort(signal);
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  // dns.lookup has no signal option. Stop waiting on cancellation while retaining
  // both handlers on the DNS promise, so late failures are always observed.
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(new ToolError('CANCELLED', '网页请求已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    dns.promises.lookup(host, { all: true, verbatim: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
  checkAbort(signal);
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
    throw new ToolError('ACCESS_DENIED', '域名包含非公共互联网地址，已拒绝访问。');
  }
  return addresses;
}

function pinnedLookup(host: string, addresses: LookupAddress[]): LookupFunction {
  // Snapshot the verified answers. This is the actual net/tls connector lookup,
  // never a preliminary check followed by another unrestricted DNS resolution.
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return (requestedHost, options, callback) => {
    if (requestedHost.toLowerCase().replace(/^[|]$/g, '') !== host) {
      callback(new ToolError('ACCESS_DENIED', '连接目标与已验证域名不符。'), '', 0);
      return;
    }
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
    const candidates = family ? pinned.filter(item => item.family === family) : pinned;
    if (!candidates.length) {
      callback(new ToolError('NETWORK_ERROR', '没有可用的公共地址。'), '', 0);
      return;
    }
    if (options.all) callback(null, candidates.map(item => ({ ...item })));
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

const allowedHeaders = new Set(['user-agent', 'referer', 'origin', 'accept', 'accept-language', 'cookie', 'content-type']);

export function safeRequestHeaders(headers?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase();
    if (!allowedHeaders.has(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    result[name] = value;
  }
  return result;
}

export function createPublicHttp(maxBytes: number): PublicHttp {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');
  type Kind = 'html' | 'json' | 'binary';
  async function fetchPublic(value: string, signal: AbortSignal, kind: Kind, options?: PublicHttpRequest) {
    const limit = options?.maxBytes ?? maxBytes;
    checkAbort(signal);
    let url = validatePublicUrl(value, options?.allowedPorts ?? []);
    for (let redirects = 0; ; redirects++) {
      checkAbort(signal);
      const host = hostname(url);
      const addresses = await resolveAddresses(host, signal);
      const agent = new Agent({ connect: { lookup: pinnedLookup(host, addresses), timeout: 10_000 } });
      try {
        // undici.request does not follow redirects unless a redirect
        // interceptor is explicitly installed. This agent has none.
        const response = await request(url, {
          dispatcher: agent, method: 'GET', signal,
          headersTimeout: 10_000, bodyTimeout: 10_000,
          headers: {
            accept: kind === 'html' ? 'text/html, application/xhtml+xml' : kind === 'json' ? 'application/json' : '*/*',
            'accept-encoding': 'identity',
            ...safeRequestHeaders(options?.headers),
          },
        });
        const { statusCode, headers, body } = response;
        // Errors from an intentionally discarded redirect/oversized body must
        // not escape as unhandled stream events when the agent is disposed.
        body.on('error', () => {});
        try {
          checkAbort(signal);
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            if (redirects >= 3) throw new ToolError('NETWORK_ERROR', '网页重定向次数超过上限。');
            const location = headers.location;
            if (typeof location !== 'string') throw new ToolError('NETWORK_ERROR', '网页重定向缺少有效目标。');
            let target: URL;
            try { target = new URL(location, url); }
            catch { throw new ToolError('NETWORK_ERROR', '网页重定向目标无效。'); }
            url = validatePublicUrl(target.href, options?.allowedPorts ?? []);
            continue;
          }
          if (statusCode < 200 || statusCode >= 300) throw new ToolError('NETWORK_ERROR', '网页服务器未返回成功响应。');
          const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
          const mime = contentType.split(';')[0].trim().toLowerCase();
          if (kind === 'html' && !['text/html', 'application/xhtml+xml'].includes(mime)) {
            throw new ToolError('UNSUPPORTED_FORMAT', '该地址未返回 HTML 网页。');
          }
          if (kind === 'json' && mime !== 'application/json' && !mime.endsWith('+json')) {
            throw new ToolError('UNSUPPORTED_FORMAT', '该地址未返回 JSON 数据。');
          }
          const encoding = headers['content-encoding'];
          if (encoding && encoding !== 'identity') throw new ToolError('UNSUPPORTED_FORMAT', '网页未按请求返回未压缩的内容。');
          const declared = headers['content-length'];
          if (declared !== undefined && Number(declared) > limit) throw new ToolError('LIMIT_EXCEEDED', '网页超过读取大小限制。');
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of body) {
            checkAbort(signal);
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > limit) throw new ToolError('LIMIT_EXCEEDED', '网页超过读取大小限制。');
            chunks.push(bytes);
          }
          checkAbort(signal);
          const buffer = Buffer.concat(chunks, total);
          const setCookie = typeof headers['set-cookie'] === 'string' ? [headers['set-cookie']] : Array.isArray(headers['set-cookie']) ? headers['set-cookie'].map(String) : [] as string[];
          if (kind === 'html') {
            const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
            let decoder: TextDecoder;
            try { decoder = new TextDecoder(charset); }
            catch { throw new ToolError('UNSUPPORTED_FORMAT', '网页使用了不支持的字符编码。'); }
            return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie, text: decoder.decode(buffer) };
          }
          if (kind === 'json') {
            try { return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie, data: JSON.parse(buffer.toString('utf8')) as unknown }; }
            catch { throw new ToolError('UNSUPPORTED_FORMAT', '该地址返回的内容不是有效 JSON。'); }
          }
          return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie };
        } finally {
          if (!body.destroyed) body.destroy();
        }
      } finally {
        await agent.destroy();
      }
    }
  }
  return {
    async getHtml(value, signal) {
      try {
        const result = await fetchPublic(value, signal, 'html');
        return { finalUrl: result.finalUrl, html: result.text ?? '', status: result.status };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法读取公共网页，请检查地址或稍后重试。');
      }
    },
    async getJson(value, signal, options) {
      try {
        const result = await fetchPublic(value, signal, 'json', options);
        return { finalUrl: result.finalUrl, data: result.data, status: result.status };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法读取公共接口，请检查地址或稍后重试。');
      }
    },
    async getBinary(value, signal, options) {
      try {
        const result = await fetchPublic(value, signal, 'binary', options);
        return { finalUrl: result.finalUrl, bytes: new Uint8Array(result.bytes), contentType: result.contentType, status: result.status };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法下载远程文件，请检查地址或稍后重试。');
      }
    },
    async getRaw(value, signal, options) {
      try {
        const result = await fetchPublic(value, signal, 'binary', options);
        return { finalUrl: result.finalUrl, status: result.status, contentType: result.contentType, bytes: new Uint8Array(result.bytes), setCookie: result.setCookie };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法读取远程资源，请检查地址或稍后重试。');
      }
    },
  };
}
