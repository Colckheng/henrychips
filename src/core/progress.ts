import type { RunSource } from '../contracts/run.js';

export interface ProgressStep {
  phase: string;
  percent: number | null;
  at: string;
}

export interface RunProgress {
  runId: string;
  tool: string;
  source: RunSource;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  percent: number | null;
  steps: ProgressStep[];
  updatedAt: string;
}

export interface ProgressUpdate {
  phase: string;
  percent?: number;
}

type Listener = (progress: RunProgress) => void;

/**
 * Keeps the live progress of running tools. Progress is transient: it exists
 * while a run is in flight and is dropped shortly after the run finishes.
 */
export class ProgressStore {
  private readonly states = new Map<string, RunProgress>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly ttlMs = 5 * 60 * 1000;

  start(runId: string, tool: string, source: RunSource): RunProgress {
    const progress: RunProgress = {
      runId,
      tool,
      source,
      status: 'running',
      phase: '准备中',
      percent: null,
      steps: [{ phase: '准备中', percent: null, at: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    };
    this.states.set(runId, progress);
    this.sweep();
    return progress;
  }

  update(runId: string, update: ProgressUpdate): RunProgress | undefined {
    const current = this.states.get(runId);
    if (!current || current.status !== 'running') return current;
    const percent = typeof update.percent === 'number' ? Math.max(0, Math.min(100, Math.round(update.percent))) : null;
    current.phase = update.phase;
    current.percent = percent;
    current.updatedAt = new Date().toISOString();
    current.steps.push({ phase: update.phase, percent, at: current.updatedAt });
    if (current.steps.length > 60) current.steps.splice(0, current.steps.length - 60);
    this.emit(runId, current);
    return current;
  }

  finish(runId: string, status: RunProgress['status'], phase?: string): RunProgress | undefined {
    this.sweep();
    const current = this.states.get(runId);
    if (!current) return undefined;
    current.status = status;
    if (phase) current.phase = phase;
    current.updatedAt = new Date().toISOString();
    this.emit(runId, current);
    return current;
  }

  get(runId: string): RunProgress | undefined {
    this.sweep();
    return this.states.get(runId);
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  private emit(runId: string, progress: RunProgress): void {
    for (const listener of this.listeners.get(runId) ?? []) {
      try { listener(progress); }
      catch { /* a broken listener must not break the run */ }
    }
  }

  private sweep(): void {
    const limit = Date.now() - this.ttlMs;
    for (const [runId, progress] of this.states) {
      if (Date.now() - new Date(progress.updatedAt).getTime() > limit) {
        this.states.delete(runId);
        this.listeners.delete(runId);
      }
    }
  }
}
