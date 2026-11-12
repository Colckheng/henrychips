import { setTimeout as delay } from 'node:timers/promises';
import type { PublicHttp } from '../../contracts/tool.js';
import { ToolError } from '../../core/errors.js';

export interface NetdiskSessionOptions {
  http: PublicHttp;
  signal: AbortSignal;
  /** Minimum spacing between two requests to the same host, in milliseconds. Defaults to 250. */
  minIntervalMs?: number;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

/**
 * The session state of one netdisk platform: a cookie jar per host and a
 * request pace per host. Both are kept here so the platform adapters only
 * have to speak the platform protocol.
 */
export class NetdiskSession {
  /** Cookies are kept per host: a session of one platform must never reach another. */
  private readonly cookies = new Map<string, Map<string, string>>();
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

  private checkAbort(): void {
    if (this.options.signal.aborted) throw new ToolError('CANCELLED', '网盘请求已取消。');
  }

  /**
   * Reserves the next slot of the host. The slot is taken before the wait, so
   * requests that run at the same time still leave one interval between them.
   */
  private async waitForSlot(url: string): Promise<void> {
    const host = hostOf(url);
    const now = Date.now();
    const previous = this.nextRequestAt.get(host);
    const startAt = previous === undefined ? now : Math.max(now, previous + this.minIntervalMs);
    this.nextRequestAt.set(host, startAt);
    const wait = startAt - now;
    if (wait > 0) await delay(wait);
  }

  /**
   * Only the cookies of the requested host are attached. A Cookie header given
   * by the caller wins over the jar, an empty one carries no session and is
   * dropped instead of being sent as an empty header.
   */
  private mergeCookieHeader(url: string, headers?: Record<string, string>): Record<string, string> | undefined {
    const source: Record<string, string> = headers ?? {};
    // The header name is matched case insensitively, so a caller that writes
    // "cookie" does not end up sending two Cookie headers.
    const cookieKey = Object.keys(source).find((key) => key.toLowerCase() === 'cookie');
    const supplied = cookieKey === undefined ? '' : source[cookieKey];
    const rest: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key !== cookieKey) rest[key] = value;
    }
    const jar = this.cookies.get(hostOf(url));
    const fromJar = jar && jar.size
      ? [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      : '';
    const cookie = supplied || fromJar;
    if (!cookie) return Object.keys(rest).length ? rest : undefined;
    return { ...rest, Cookie: cookie };
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
      return await run(this.mergeCookieHeader(url, headers));
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

  /** Reads the headers of a one byte range request, to learn whether the direct link supports resuming. */
  async probe(url: string, headers?: Record<string, string>): Promise<{ status: number; location?: string; contentRange?: string; acceptRanges?: string }> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getRaw(url, this.options.signal, {
        headers: { Range: 'bytes=0-0', ...merged },
        maxBytes: 1024,
      });
      return {
        status: response.status,
        location: response.headers.location,
        contentRange: response.headers['content-range'],
        acceptRanges: response.headers['accept-ranges'],
      };
    });
  }
}
