import { useCallback, useEffect } from 'react';
import type { ToolResult } from '../contracts/run.js';
import { adoptLatestRun, cancelRun, loadPreviousResult, startRun, useRunEntries } from './run-store.js';
import type { RunProgress } from './api.js';

export function useToolRun(name: string) {
  const entries = useRunEntries();
  const entry = entries.find(item => item.tool === name);
  const run = useCallback((input: Record<string, unknown>) => startRun(name, input), [name]);
  const cancel = useCallback(() => cancelRun(name), [name]);
  const restore = useCallback(() => loadPreviousResult(name), [name]);
  // Pick up a run that the server kept going after the page was closed.
  useEffect(() => { void adoptLatestRun(name); }, [name]);
  const result = entry?.result as ToolResult | undefined;
  const error = entry?.error;
  const status = (entry?.status ?? 'idle') as 'idle' | 'running' | 'done' | 'cancelled';
  const progress = entry?.progress as RunProgress | undefined;
  return { result, error, status, progress, restored: entry?.restored ?? false, run, cancel, restore };
}
