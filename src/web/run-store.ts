import { useSyncExternalStore } from 'react';
import type { ToolResult } from '../contracts/run.js';
import { friendlyError, runApi, subscribeProgress, type RunProgress } from './api.js';

export type RunStatus = 'running' | 'done' | 'cancelled';

export interface RunEntry {
  tool: string;
  requestId: string;
  status: RunStatus;
  result?: ToolResult;
  error?: { message: string; code?: string };
  progress?: RunProgress;
  startedAt: number;
}

interface InternalEntry extends RunEntry {
  controller: AbortController;
  unsubscribe?: () => void;
}

const runs = new Map<string, InternalEntry>();
const listeners = new Set<() => void>();
const recoveryKey = 'henry.active-runs';
let cache: RunEntry[] = [];

function rebuild(): void {
  cache = [...runs.values()].map(({ controller, unsubscribe, ...entry }) => entry);
}

function emit(): void {
  rebuild();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function persistRecovery(): void {
  try {
    const active = [...runs.values()]
      .filter(entry => entry.status === 'running')
      .map(entry => ({ tool: entry.tool, requestId: entry.requestId }));
    sessionStorage.setItem(recoveryKey, JSON.stringify(active));
  } catch { /* storage is unavailable in private mode */ }
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

function entryOf(tool: string): InternalEntry | undefined {
  return runs.get(tool);
}

/**
 * Runs live outside the page that started them. Navigating away keeps the
 * request and its progress alive; the state is restored when the user comes
 * back to the tool.
 */
export function startRun(tool: string, input: Record<string, unknown>): void {
  const previous = entryOf(tool);
  previous?.unsubscribe?.();
  previous?.controller.abort();
  const controller = new AbortController();
  const entry: InternalEntry = { tool, requestId: newRequestId(), status: 'running', controller, startedAt: Date.now() };
  runs.set(tool, entry);
  persistRecovery();
  emit();
  entry.unsubscribe = subscribeProgress(entry.requestId, progress => {
    entry.progress = progress;
    if (progress.status !== 'running') entry.progress = progress;
    emit();
  });
  void runApi(tool, input, controller.signal, entry.requestId)
    .then(result => { entry.status = 'done'; entry.result = result; })
    .catch((error: unknown) => {
      if (controller.signal.aborted) { entry.status = 'cancelled'; return; }
      entry.status = 'done';
      entry.error = friendlyError(error);
    })
    .finally(() => {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      persistRecovery();
      emit();
    });
}

export function cancelRun(tool: string): void {
  const entry = entryOf(tool);
  if (!entry) return;
  entry.controller.abort();
  entry.status = 'cancelled';
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
  persistRecovery();
  emit();
}

export function clearRun(tool: string): void {
  const entry = entryOf(tool);
  if (!entry) return;
  entry.unsubscribe?.();
  entry.controller.abort();
  runs.delete(tool);
  persistRecovery();
  emit();
}

export function useRunEntries(): RunEntry[] {
  return useSyncExternalStore(subscribe, () => cache, () => cache);
}

/** Re-attaches to runs that were still going when the page was reloaded. */
export async function recoverRuns(): Promise<void> {
  let stored: Array<{ tool: string; requestId: string }> = [];
  try { stored = JSON.parse(sessionStorage.getItem(recoveryKey) ?? '[]') as Array<{ tool: string; requestId: string }>; }
  catch { return; }
  for (const item of stored) {
    if (!item?.tool || !item.requestId || runs.has(item.tool)) continue;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(item.requestId)}/progress`, { headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      const progress = await response.json() as RunProgress;
      if (progress.status !== 'running') continue;
      const controller = new AbortController();
      const entry: InternalEntry = { tool: item.tool, requestId: item.requestId, status: 'running', controller, startedAt: Date.now(), progress };
      runs.set(item.tool, entry);
      entry.unsubscribe = subscribeProgress(item.requestId, update => { entry.progress = update; emit(); });
      emit();
    } catch { /* the run is gone */ }
  }
}
