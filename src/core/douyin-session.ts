import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { signParams, signWebUrl } from 'abogus';
import { ToolError } from './errors.js';
import type { PublicHttp, ToolContext } from '../contracts/tool.js';

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const detailEndpoint = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';
const sessionTtlMs = 6 * 60 * 60 * 1000;

export interface DouyinSession {
  capturedAt: number;
  cookies: Record<string, string>;
  template: Record<string, string>;
  verifyFp: string;
  uifid: string;
}

function sessionFile(stateDirectory: string): string {
  return path.join(stateDirectory, 'douyin-session.json');
}

export async function readSession(stateDirectory: string): Promise<DouyinSession | null> {
  try {
    const raw = await readFile(sessionFile(stateDirectory), 'utf8');
    const parsed = JSON.parse(raw) as DouyinSession;
    if (!parsed?.template || !parsed?.cookies) return null;
    if (Date.now() - parsed.capturedAt > sessionTtlMs) return null;
    return parsed;
  } catch { return null; }
}

export async function writeSession(stateDirectory: string, session: DouyinSession): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(sessionFile(stateDirectory), JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Opens the official work page once and captures the signed request it makes
 * plus the payload it receives. The parameter template and cookies become a
 * reusable session, so later lookups are plain signed HTTP calls instead of
 * new browser runs.
 */
export async function bootstrapSession(awemeId: string, signal: AbortSignal): Promise<{ session: DouyinSession; detail?: Record<string, unknown> }> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    const context = await browser.newContext({ userAgent, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let captured = '';
    let detail: Record<string, unknown> | undefined;
    page.on('request', request => {
      if (!captured && request.url().includes('/aweme/v1/web/aweme/detail')) captured = request.url();
    });
    page.on('response', async response => {
      if (detail || !response.url().includes('/aweme/v1/web/aweme/detail')) return;
      try {
        const payload = JSON.parse(await response.text()) as { aweme_detail?: Record<string, unknown> };
        if (payload?.aweme_detail) detail = payload.aweme_detail;
      } catch { /* the page may answer with a non-JSON body */ }
    });
    await page.goto(`https://www.douyin.com/video/${awemeId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    for (let attempt = 0; attempt < 30 && !captured; attempt++) {
      if (signal.aborted) throw new ToolError('CANCELLED', '本次执行已取消。');
      await page.waitForTimeout(1000);
    }
    if (!captured) {
      // The page occasionally skips the detail call; one reload usually helps.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
      for (let attempt = 0; attempt < 20 && !captured; attempt++) {
        if (signal.aborted) throw new ToolError('CANCELLED', '本次执行已取消。');
        await page.waitForTimeout(1000);
      }
    }
    const cookies = Object.fromEntries((await context.cookies()).map(cookie => [cookie.name, cookie.value]));
    if (!captured) throw new ToolError('FILE_NOT_FOUND', '未能读取该作品：作品可能不存在或已下架，也可能是抖音当前对本机发起了风控限流，请稍后重试。');
    const url = new URL(captured);
    const template: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (['a_bogus', 'verifyFp', 'fp', 'timestamp', 'x-secsdk-web-signature', 'aweme_id'].includes(key)) continue;
      template[key] = value;
    }
    return {
      session: {
        capturedAt: Date.now(),
        cookies,
        template,
        verifyFp: url.searchParams.get('verifyFp') ?? '',
        uifid: url.searchParams.get('uifid') ?? '',
      },
      detail,
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError('TOOL_FAILED', '无法通过本机浏览器建立抖音会话，请确认 Chrome 已安装并可访问该页面。');
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function ensureSession(stateDirectory: string, awemeId: string, ctx: ToolContext): Promise<DouyinSession> {
  const cached = await readSession(stateDirectory);
  if (cached) return cached;
  const { session } = await bootstrapSession(awemeId, ctx.signal);
  await writeSession(stateDirectory, session);
  return session;
}

export interface DetailResult {
  ok: boolean;
  awemeDetail?: Record<string, unknown>;
  status: number;
}

/** Signs and sends the detail request with the workstation's own client. */
export async function requestDetail(session: DouyinSession, awemeId: string, http: PublicHttp, ctx: ToolContext): Promise<DetailResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams(session.template);
  params.set('aweme_id', awemeId);
  params.set('uifid', session.uifid);
  const signed = signParams(Object.fromEntries(params), {
    url: detailEndpoint,
    userAgent,
    env: {
      userAgent,
      platform: 'Win32',
      browser: 'Chrome',
      screen: { width: 1440, height: 900, availWidth: 1440, availHeight: 900 },
      viewport: { innerWidth: 1440, innerHeight: 900, outerWidth: 1440, outerHeight: 900 },
    },
  });
  let url = `${detailEndpoint}?${signed.searchParams.toString()}&a_bogus=${encodeURIComponent(signed.aBogus)}&verifyFp=${encodeURIComponent(session.verifyFp)}&fp=${encodeURIComponent(session.verifyFp)}`;
  if (session.uifid) url = signWebUrl(url, { uifid: session.uifid, timestamp });
  const cookie = Object.entries(session.cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  let response;
  try {
    response = await http.getJson(url, ctx.signal, {
      headers: { 'user-agent': userAgent, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*', cookie },
      maxBytes: ctx.limits.webBytes * 16,
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === 'UNSUPPORTED_FORMAT') {
      throw new ToolError('NETWORK_ERROR', '抖音接口未返回 JSON 数据，通常是平台对本机发起了风控限流，请稍后重试。');
    }
    throw error;
  }
  const data = response.data as { aweme_detail?: Record<string, unknown> } | null;
  return { ok: Boolean(data?.aweme_detail), awemeDetail: data?.aweme_detail, status: response.status };
}
