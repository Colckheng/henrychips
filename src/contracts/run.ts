export type RunSource = 'web' | 'cli' | 'mcp';
export type ErrorCode = 'TOOL_NOT_FOUND' | 'INVALID_INPUT' | 'ACCESS_DENIED' | 'FILE_NOT_FOUND' | 'UNSUPPORTED_FORMAT' | 'LIMIT_EXCEEDED' | 'BUSY' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'TOOL_FAILED';
export interface RunMeta {
  runId: string;
  tool: string;
  source: RunSource;
  startedAt: string;
  durationMs: number;
  warnings: string[];
}
export type ToolResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | { ok: true; data: T; meta: RunMeta }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Array<{ path: string; message: string }> }; meta: RunMeta };
export interface RunSummary {
  runId: string;
  tool: string;
  source: RunSource;
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  durationMs: number;
  errorCode: ErrorCode | null;
}
export interface RunList { runs: RunSummary[]; warnings: string[] }
