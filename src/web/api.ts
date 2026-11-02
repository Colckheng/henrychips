import { useCallback, useEffect, useState } from 'react';
import type { ToolResult } from '../contracts/run.js';

export class ApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isToolResult(value: unknown): value is ToolResult {
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.meta.warnings)) return false;
  return value.ok === true ? isRecord(value.data)
    : value.ok === false && isRecord(value.error) && typeof value.error.message === 'string';
}

async function jsonResponse(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new ApiError('服务返回了无法读取的内容，请稍后重试。', `HTTP_${response.status}`); }
}

function responseError(data: unknown, status: number): ApiError {
  const error = isRecord(data) && isRecord(data.error) ? data.error : data;
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : '请求未完成，请重试。';
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : `HTTP_${status}`;
  return new ApiError(message, code);
}

export async function getApi<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal, headers: { Accept: 'application/json' } });
  const data = await jsonResponse(response);
  if (!response.ok) throw responseError(data, response.status);
  return data as T;
}

export interface RunProgress {
  runId: string;
  tool: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  percent: number | null;
  steps: Array<{ phase: string; percent: number | null; at: string }>;
  updatedAt: string;
}

export async function runApi(name: string, input: Record<string, unknown>, signal: AbortSignal, requestId: string): Promise<ToolResult> {
  const response = await fetch(`/api/tools/${encodeURIComponent(name)}/run`, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ input, requestId }),
  });
  const data = await jsonResponse(response);
  if (isToolResult(data) && (!data.ok || response.ok)) return data;
  if (!response.ok) throw responseError(data, response.status);
  throw new ApiError('返回结果格式不正确，请重试或检查本地服务。', 'INVALID_RESPONSE');
}

/** Subscribes to live progress of a run. Falls back to polling when events are unavailable. */
export function subscribeProgress(runId: string, onProgress: (progress: RunProgress) => void): () => void {
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    closed = true;
    source?.close();
    if (timer) clearInterval(timer);
  };
  const poll = async () => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/progress`, { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      onProgress(await response.json() as RunProgress);
    } catch { /* the run may already be finished */ }
  };
  if (typeof EventSource === 'undefined') {
    timer = setInterval(() => { if (!closed) void poll(); }, 500);
    void poll();
    return stop;
  }
  source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  source.onmessage = event => {
    if (closed) return;
    try { onProgress(JSON.parse(event.data) as RunProgress); }
    catch { /* ignore malformed frames */ }
  };
  source.onerror = () => {
    if (closed) return;
    source?.close();
    timer = setInterval(() => { if (!closed) void poll(); }, 700);
  };
  return stop;
}

export async function cancelRunApi(runId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', keepalive: true, headers: { Accept: 'application/json' } });
    if (!response.ok) return false;
    const data = await jsonResponse(response) as { cancelled?: boolean };
    return Boolean(data.cancelled);
  } catch { return false; }
}

export async function fetchRunResult(runId: string): Promise<ToolResult | undefined> {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/result`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return undefined;
    const data = await jsonResponse(response);
    return isToolResult(data) ? data : undefined;
  } catch { return undefined; }
}

export async function openOutputFolder(): Promise<{ opened: boolean; message?: string }> {
  try {
    const response = await fetch('/api/output/open', { method: 'POST', headers: { Accept: 'application/json' } });
    const data = await jsonResponse(response) as { opened?: boolean; error?: { message?: string } };
    if (!response.ok) return { opened: false, message: data.error?.message ?? '无法打开输出目录。' };
    return { opened: Boolean(data.opened) };
  } catch {
    return { opened: false, message: '无法连接本地服务，请确认服务已启动。' };
  }
}

export function friendlyError(error: unknown): { message: string; code?: string } {
  if (error instanceof ApiError) return { message: error.message, code: error.code };
  return { message: '无法连接本地服务，请确认服务已启动，然后重试。' };
}

type Resource<T> = { data?: T; error?: ReturnType<typeof friendlyError>; loading: boolean };

export function useApi<T>(path: string) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<Resource<T>>({ loading: true });
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setResource({ loading: true });
    getApi<T>(path, controller.signal).then(data => {
      if (!controller.signal.aborted) setResource({ data, loading: false });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResource({ error: friendlyError(error), loading: false });
    });
    return () => controller.abort();
  }, [path, attempt]);
  return { ...resource, reload };
}
