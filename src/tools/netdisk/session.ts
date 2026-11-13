import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { PublicHttp } from '../../contracts/tool.js';
import { ToolError } from '../../core/errors.js';

export interface NetdiskSessionOptions {
  http: PublicHttp;
  signal: AbortSignal;
  /** Minimum spacing between two requests to the same host, in milliseconds. Defaults to 250. */
  minIntervalMs?: number;
  /** Reports the moment a request reserves its slot, for a caller that watches the pacing. */
  onSlotReserved?: (host: string, startAt: number) => void;
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

/**
 * The ceiling of a probe. A probe reads the head of a link, but a platform can
 * answer with a page that explains itself, and such a page is bigger than the
 * byte the probe asked for.
 */
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * The answer of a probe of a direct link: the status and the headers of the
 * answer, plus its body, which tells a file apart from a page that explains
 * itself.
 */
export interface NetdiskProbeResponse {
  finalUrl: string;
  status: number;
  location?: string;
  contentRange?: string;
  acceptRanges?: string;
  contentType?: string;
  body: Uint8Array;
}

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
 * Reads the value of one cookie out of the `Set-Cookie` lines of a response.
 *
 * A platform hands out the token of a guest in the headers of an answer, and
 * the token has to travel with a request to a *different* host, so it cannot
 * stay in the jar of the host that answered.
 */
export function cookieValue(setCookie: string[] | undefined, name: string): string {
  for (const line of setCookie ?? []) {
    const pair = line.split(';')[0]?.trim();
    if (!pair?.startsWith(`${name}=`)) continue;
    const value = pair.slice(name.length + 1).trim();
    if (value) return value;
  }
  return '';
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
   *
   * The reservation is what the pacing guarantees, not the moment the request
   * actually leaves: a timer may wake a little early, so the arrival of two
   * requests can be closer than the interval even though their slots are
   * exactly one interval apart.
   */
  private async waitForSlot(url: string): Promise<void> {
    const host = hostOf(url);
    const now = performance.now();
    const previous = this.nextRequestAt.get(host);
    const startAt = previous === undefined ? now : Math.max(now, previous + this.minIntervalMs);
    this.nextRequestAt.set(host, startAt);
    this.options.onSlotReserved?.(host, startAt);
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

  /**
   * Writes the cookies of a response into the jar of its host.
   *
   * A platform hands out the token of a guest in the `Set-Cookie` of the
   * answer, so the cookies of every response have to reach the jar. A cookie
   * of a redirect hop belongs to the host of that hop, so only the cookies
   * of the host the request was aimed at are written.
   */
  private storeCookies(url: string, setCookie: string[] | undefined): void {
    const host = hostOf(url);
    if (!host) return;
    for (const line of setCookie ?? []) {
      const pair = line.split(';')[0]?.trim();
      if (!pair) continue;
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name || !value) continue;
      this.setCookie(url, name, value);
    }
  }

  async get(url: string, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number; setCookie: string[] }> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getJson(url, this.options.signal, { headers: merged });
      this.storeCookies(url, response.setCookie);
      return { finalUrl: response.finalUrl, data: response.data, status: response.status, setCookie: response.setCookie ?? [] };
    });
  }

  async postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.postForm(url, fields, this.options.signal, { headers: merged });
      this.storeCookies(url, response.setCookie);
      return { finalUrl: response.finalUrl, data: response.data, status: response.status };
    });
  }

  async postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number; setCookie: string[] }> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.postJson(url, body, this.options.signal, { headers: merged });
      this.storeCookies(url, response.setCookie);
      return { finalUrl: response.finalUrl, data: response.data, status: response.status, setCookie: response.setCookie ?? [] };
    });
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

  /**
   * Reads the headers of a one byte range request, to learn whether the direct link supports resuming.
   *
   * The body of the answer is read as well, because a platform can answer with
   * a page that explains itself instead of with the file. The limit of the
   * probe is its own, so a big error page does not fail the probe as a size
   * violation.
   */
  async probe(url: string, headers?: Record<string, string>, options?: { acceptCompressed?: boolean }): Promise<NetdiskProbeResponse> {
    return this.send(url, headers, async (merged) => {
      const response = await this.options.http.getRaw(url, this.options.signal, {
        // The probe asks for one byte, so its own range wins over the caller's.
        // The caller's range is dropped in every spelling, because the header
        // names are compared in lower case further down.
        headers: { ...withoutRange(merged), Range: 'bytes=0-0' },
        maxBytes: PROBE_MAX_BYTES,
        // The status of an error answer is the answer of a probe, so it is
        // read instead of turned into a failure.
        allowErrorStatus: true,
        // A server that ignores the identity encoding still answers with a
        // compressed body, and a page that explains itself is compressed.
        acceptCompressed: options?.acceptCompressed ?? false,
      });
      return {
        finalUrl: response.finalUrl,
        status: response.status,
        location: response.headers.location,
        contentRange: response.headers['content-range'],
        acceptRanges: response.headers['accept-ranges'],
        // The type tells a file apart from an interstitial page, which is the
        // difference between a usable link and a verification step.
        contentType: response.contentType,
        // The body tells an interstitial page apart from a file, so the probe
        // keeps it.
        body: response.bytes,
      };
    });
  }
}
