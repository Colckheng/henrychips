import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { PublicHttp } from '../../contracts/tool.js';
import { ToolError } from '../../core/errors.js';

export interface NetdiskSessionOptions {
  http: PublicHttp;
  signal: AbortSignal;
  /** Minimum spacing between two requests to the same host, in milliseconds. Defaults to 250. */
  minIntervalMs?: number;
}

/** The response of a request that only reads headers, for a platform that hands out its session in them. */
export interface NetdiskRawResponse {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
}

/**
 * The response head of a request that only reads headers. A platform that
 * hands out its session in a Set-Cookie header is read through this.
 */
export interface NetdiskHeadResponse {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
}

/**
 * The body a raw request may read. A raw request only looks at the response
 * headers, so a small body is enough; without a cap a redirect to a CDN file
 * would pull the whole file into memory.
 */
const RAW_MAX_BYTES = 64 * 1024;

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

/** Drops every spelling of the range header, so a request keeps only the range it sets itself. */
function withoutRange(headers?: Record<string, string>): Record<string, string> {
  const rest: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (/^range$/i.test(key)) continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * The session state of one netdisk platform: a cookie jar and an account token
 * per host and a request pace per host. All of it is kept here so the platform
 * adapters only have to speak the platform protocol.
 */
export class NetdiskSession {
  /** Cookies are kept per host: a session of one platform must never reach another. */
  private readonly cookies = new Map<string, Map<string, string>>();
  /** The account token of a host, kept per host for the same reason as the cookies. */
  private readonly authorizations = new Map<string, string>();
  /** Reserved start time of the next request of a host, so concurrent calls stay spaced out. */
  private readonly nextRequestAt = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(private readonly options: NetdiskSessionOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  /** Writes a cookie by hand, for a value that came from somewhere else than a response. */
  setCookie(url: string, name: string, value: string): void {
    const host = hostOf(url);
    if (!host) return;
    const jar = this.cookies.get(host) ?? new Map<string, string>();
    jar.set(name, value);
    this.cookies.set(host, jar);
  }

  /** The cookie string of the host the url points at, for a request built by hand. */
  cookieHeader(url: string): string {
    const jar = this.cookies.get(hostOf(url));
    if (!jar || !jar.size) return '';
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Writes the account token of the host the url points at. */
  setAuthorization(url: string, token: string): void {
    const host = hostOf(url);
    if (!host) return;
    this.authorizations.set(host, token);
  }

  /** The account token of the host the url points at, for a request built by hand. */
  authorizationHeader(url: string): string {
    return this.authorizations.get(hostOf(url)) ?? '';
  }

  private checkAbort(): void {
    if (this.options.signal.aborted) throw new ToolError('CANCELLED', '网盘请求已取消。');
  }

  /**
   * Reserves the next slot of the host. The slot is taken before the wait, so
   * requests that run at the same time still leave one interval between them.
   * The clock is monotonic, so a jump of the wall clock cannot turn into a
   * wait far longer than the interval.
   */
  private async waitForSlot(url: string): Promise<void> {
    const host = hostOf(url);
    const now = performance.now();
    const previous = this.nextRequestAt.get(host);
    const startAt = previous === undefined ? now : Math.max(now, previous + this.minIntervalMs);
    this.nextRequestAt.set(host, startAt);
    const wait = startAt - now;
    if (wait <= 0) return;
    try {
      await delay(wait, undefined, { signal: this.options.signal });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('CANCELLED', '网盘请求已取消。');
    }
  }

  /**
   * Only the credentials of the requested host are attached. A credential
   * header of the caller is dropped: the session is the only way a cookie or
   * an account token enters a request, so neither can ever be carried over to
   * another host by mistake.
   */
  private mergeCredentialHeaders(url: string, headers?: Record<string, string>): Record<string, string> | undefined {
    const rest: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      // Every spelling of the header is dropped, so two credential headers can
      // never reach the server.
      if (/cookie/i.test(key) || /^authorization$/i.test(key)) continue;
      rest[key] = value;
    }
    const host = hostOf(url);
    const jar = this.cookies.get(host);
    const fromJar = jar && jar.size
      ? [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      : '';
    const token = this.authorizations.get(host) ?? '';
    if (!fromJar && !token) return Object.keys(rest).length ? rest : undefined;
    return {
      ...rest,
      ...(fromJar ? { Cookie: fromJar } : {}),
      ...(token ? { Authorization: token } : {}),
    };
  }

  private async send<T>(
    url: string,
    headers: Record<string, string> | undefined,
    run: (merged: Record<string, string> | undefined) => Promise<T>,
  ): Promise<T> {
    this.checkAbort();
    await this.waitForSlot(url);
    this.checkAbort();
    try {
      return await run(this.mergeCredentialHeaders(url, headers));
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }

  async get(url: string, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }> {
    return this.send(url, headers, (merged) => this.options.http.getJson(url, this.options.signal, { headers: merged }));
  }

  async postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }> {
    return this.send(url, headers, (merged) => this.options.http.postForm(url, fields, this.options.signal, { headers: merged }));
  }

  async postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }> {
    return this.send(url, headers, (merged) => this.options.http.postJson(url, body, this.options.signal, { headers: merged }));
  }

  async getHtml(url: string, headers?: Record<string, string>): Promise<{ finalUrl: string; html: string; status: number }> {
    return this.send(url, headers, (merged) => this.options.http.getHtml(url, this.options.signal, { headers: merged }));
  }

  /**
   * The response of a request that only reads headers. A platform that hands
   * out its session in a Set-Cookie header is read through this.
   */
  async raw(url: string, headers?: Record<string, string>, maxBytes: number = RAW_MAX_BYTES): Promise<NetdiskRawResponse> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getRaw(url, this.options.signal, { headers: merged, maxBytes });
      return {
        finalUrl: response.finalUrl,
        status: response.status,
        headers: response.headers,
        setCookie: response.setCookie,
      };
    });
  }

  /**
   * The response head of a request, without its body. A platform that sets a
   * cookie and then redirects to a CDN is read through this: the body of the
   * CDN response can be a whole file, and reading it would throw the cookies
   * of the chain away.
   */
  async head(url: string, headers?: Record<string, string>): Promise<NetdiskHeadResponse> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getHead(url, this.options.signal, { headers: merged });
      return {
        finalUrl: response.finalUrl,
        status: response.status,
        headers: response.headers,
        setCookie: response.setCookie,
      };
    });
  }

  /** Reads the headers of a one byte range request, to learn whether the direct link supports resuming. */
  async probe(url: string, headers?: Record<string, string>): Promise<{ finalUrl: string; status: number; location?: string; contentRange?: string; acceptRanges?: string }> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getRaw(url, this.options.signal, {
        // The probe asks for one byte, so its own range wins over the caller's.
        // The caller's range is dropped in every spelling, because the header
        // names are compared in lower case further down.
        headers: { ...withoutRange(merged), Range: 'bytes=0-0' },
        maxBytes: 1024,
      });
      return {
        finalUrl: response.finalUrl,
        status: response.status,
        location: response.headers.location,
        contentRange: response.headers['content-range'],
        acceptRanges: response.headers['accept-ranges'],
      };
    });
  }
}
