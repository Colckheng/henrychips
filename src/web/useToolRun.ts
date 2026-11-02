import { useCallback } from 'react';
import type { ToolResult } from '../contracts/run.js';
import { cancelRun, startRun, useRunEntries } from './run-store.js';
import type { RunProgress } from './api.js';

export function useToolRun(name: string) {
  const entries = useRunEntries();
  const entry = entries.find(item => item.tool === name);
  const run = useCallback((input: Record<string, unknown>) => startRun(name, input), [name]);
  const cancel = useCallback(() => cancelRun(name), [name]);
  const result = entry?.result as ToolResult | undefined;
  const error = entry?.error;
  const status = (entry?.status ?? 'idle') as 'idle' | 'running' | 'done' | 'cancelled';
  const progress = entry?.progress as RunProgress | undefined;
  return { result, error, status, progress, run, cancel };
}
