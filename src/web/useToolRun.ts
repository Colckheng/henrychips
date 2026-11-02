import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolResult } from '../contracts/run.js';
import { friendlyError, runApi, subscribeProgress, type RunProgress } from './api.js';

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    const value = character === 'x' ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

export function useToolRun(name: string) {
  const controller = useRef<AbortController | null>(null);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);
  const sequence = useRef(0);
  const [result, setResult] = useState<ToolResult>();
  const [error, setError] = useState<ReturnType<typeof friendlyError>>();
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'cancelled'>('idle');
  const [progress, setProgress] = useState<RunProgress>();
  useEffect(() => () => { sequence.current += 1; controller.current?.abort(); unsubscribe.current?.(); }, [name]);
  const run = useCallback(async (input: Record<string, unknown>) => {
    controller.current?.abort();
    unsubscribe.current?.();
    const request = new AbortController();
    controller.current = request;
    const current = ++sequence.current;
    const requestId = newRequestId();
    setStatus('running'); setResult(undefined); setError(undefined); setProgress(undefined);
    unsubscribe.current = subscribeProgress(requestId, value => {
      if (current === sequence.current) setProgress(value);
    });
    try {
      const response = await runApi(name, input, request.signal, requestId);
      if (current !== sequence.current || request.signal.aborted) return;
      setResult(response); setStatus('done');
    } catch (caught: unknown) {
      if (current !== sequence.current || request.signal.aborted) return;
      setError(friendlyError(caught)); setStatus('done');
    } finally {
      if (current === sequence.current) { controller.current = null; unsubscribe.current?.(); unsubscribe.current = undefined; }
    }
  }, [name]);
  const cancel = useCallback(() => {
    sequence.current += 1; controller.current?.abort(); controller.current = null;
    unsubscribe.current?.(); unsubscribe.current = undefined;
    setStatus('cancelled');
  }, []);
  return { result, error, status, progress, run, cancel };
}
