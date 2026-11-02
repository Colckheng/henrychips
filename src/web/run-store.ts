import { useSyncExternalStore } from 'react';
import type { ToolResult } from '../contracts/run.js';
import { cancelRunApi, fetchRunResult, friendlyError, runApi, subscribeProgress, type RunProgress } from './api.js';

export type RunStatus = 'running' | 'done' | 'cancelled';

export interface RunEntry {
  tool: string;
  restored?: boolean;
  requestId: string;
  status: RunStatus;
  result?: ToolResult;
  error?: { message: string; code?: string };
  progress?: RunProgress;
  startedAt: number;
}

interface InternalEntry extends RunEntry {
  restored?: boolean;
  controller: AbortController;
  unsubscribe?: () => void;
}

const runs = new Map<string, InternalEntry>();
const previous = new Map<string, { runId: string; at: number }>();
const listeners = new Set<() => void>();
const recoveryKey = 'henry.active-runs';
const ownerTokenKey = 'henry.owner-token';
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

export function ownerToken(): string {
  try {
    let token = sessionStorage.getItem(ownerTokenKey);
    if (!token) { token = newRequestId(); sessionStorage.setItem(ownerTokenKey, token); }
    return token;
  } catch { return newRequestId(); }
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
/** Subscribes to progress and fetches the finished result when the run ends. */
function attach(entry: InternalEntry): void {
  entry.unsubscribe?.();
  entry.unsubscribe = subscribeProgress(entry.requestId, progress => {
    entry.progress = progress;
    if (progress.status !== 'running') {
      // The server finished the run: free the button even if the HTTP
      // response is still in flight (or was never delivered).
      if (entry.status === 'running') entry.status = 'done';
      if (!entry.result) {
        void fetchRunResult(entry.requestId, ownerToken()).then(result => {
          if (!result) return;
          entry.result = result;
          emit();
        });
      }
    }
    emit();
  });
}

export function startRun(tool: string, input: Record<string, unknown>): void {
  const earlier = entryOf(tool);
  if (earlier) {
    // Supersede the earlier run on the server; its result stays available.
    if (earlier.status === 'running') void cancelRunApi(earlier.requestId, ownerToken());
    earlier.unsubscribe?.();
    earlier.unsubscribe = undefined;
  }
  const controller = new AbortController();
  const entry: InternalEntry = { tool, requestId: newRequestId(), status: 'running', controller, startedAt: Date.now() };
  runs.set(tool, entry);
  previous.set(tool, { runId: entry.requestId, at: entry.startedAt });
  persistRecovery();
  emit();
  attach(entry);
  void runApi(tool, input, controller.signal, entry.requestId, ownerToken())
    .then(result => {
      if (entry.status !== 'cancelled') entry.status = 'done';
      entry.result = result;
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || entry.status === 'cancelled') { entry.status = 'cancelled'; return; }
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
  // Cancelling goes through the server: the run lives there, not in this tab.
  void cancelRunApi(entry.requestId, ownerToken());
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

/** Adopts a run that the server kept going after the page was closed. */
export async function adoptLatestRun(tool: string): Promise<void> {
  if (runs.has(tool)) return;
  try {
    const response = await fetch(`/api/runs/latest?tool=${encodeURIComponent(tool)}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    const payload = await response.json() as { runId: string | null; at: number | null; status: string; progress?: RunProgress; result?: ToolResult };
    if (!payload?.runId || runs.has(tool)) return;
    previous.set(tool, { runId: payload.runId, at: payload.at ?? Date.now() });
    // Only a run the server still reports as running can be adopted; anything
    // else is offered as a previous result instead.
    if (payload.status !== 'running' || !payload.progress) { emit(); return; }
    const controller = new AbortController();
    const entry: InternalEntry = {
      tool,
      requestId: payload.runId,
      status: 'running',
      controller,
      startedAt: payload.at ?? Date.now(),
      progress: payload.progress,
    };
    if (runs.has(tool)) return;
    runs.set(tool, entry);
    attach(entry);
    emit();
  } catch { /* nothing to adopt */ }
}

/** Loads the result of the previous run so it can be shown again. */
export async function loadPreviousResult(tool: string): Promise<void> {
  const known = previous.get(tool);
  const runId = known?.runId;
  if (!runId) return;
  const current = entryOf(tool);
  if (current && current.status === 'running') return;
  const result = await fetchRunResult(runId, ownerToken());
  if (!result) return;
  // A newer run may have started while the result was loading.
  const active = entryOf(tool);
  if (active && active.status === 'running') return;
  const controller = new AbortController();
  runs.set(tool, { tool, requestId: runId, status: 'done', controller, startedAt: known?.at ?? Date.now(), result, restored: true });
  emit();
}

export function hasPreviousRun(tool: string): boolean {
  return previous.has(tool);
}

/** Reactive flag: true when the server holds an earlier run for this tool. */
export function useHasPreviousRun(tool: string): boolean {
  return useSyncExternalStore(subscribe, () => previous.has(tool), () => previous.has(tool));
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
      if (response.ok) {
        const progress = await response.json() as RunProgress;
        if (progress.status === 'running' && !runs.has(item.tool)) {
          const controller = new AbortController();
          const entry: InternalEntry = { tool: item.tool, requestId: item.requestId, status: 'running', controller, startedAt: Date.now(), progress };
          runs.set(item.tool, entry);
          attach(entry);
          emit();
          continue;
        }
      }
      // The run finished while the page was closed: pick its result back up.
      const result = await fetchRunResult(item.requestId, ownerToken());
      if (result && !runs.has(item.tool)) {
        const controller = new AbortController();
        runs.set(item.tool, { tool: item.tool, requestId: item.requestId, status: 'done', controller, startedAt: Date.now(), result, restored: true });
        emit();
      }
    } catch { /* the run is gone */ }
  }
}
