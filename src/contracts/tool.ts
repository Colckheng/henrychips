export type Category = 'files' | 'documents' | 'web' | 'data' | 'developer' | 'text' | 'media';
export type Capability = 'files:read' | 'files:write' | 'network:public' | 'process:probe' | 'browser:local';
export interface FieldDefinition {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'relative-path';
  description?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string }>;
}
export interface ToolDescription {
  name: string;
  title: string;
  description: string;
  category: Category;
  capabilities: Capability[];
  fields: FieldDefinition[];
  examples: Array<{ label: string; input: Record<string, unknown> }>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  timeoutMs?: number;
}
export interface Limits {
  fileBytes: number;
  csvRows: number;
  directoryEntries: number;
  pdfPages: number;
  webBytes: number;
  downloadBytes: number;
  outputBytes: number;
  toolTimeoutMs: number;
}
export interface FileEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink';
  sizeBytes: number | null;
}
export interface FileAccess {
  readBytes(relativePath: string, maxBytes: number): Promise<Uint8Array>;
  readText(relativePath: string, maxBytes: number): Promise<string>;
  list(relativeDirectory: string, maxEntries: number): Promise<FileEntry[]>;
  exists(relativePath: string): Promise<boolean>;
}
export interface PublicHttpRequest {
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Extra ports a trusted media CDN may use. Private addresses stay blocked. */
  allowedPorts?: number[];
  /** 流式读取时「多久没有数据算超时」的容忍毫秒数。默认 10000。 */
  timeoutMs?: number;
}
export interface PublicHttpResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  setCookie: string[];
  headers: Record<string, string>;
}
/** 契约同时被浏览器端编译，因此用结构化类型描述流式响应体，不依赖 Node 类型。 */
export interface PublicHttpBody extends AsyncIterable<Uint8Array> {
  resume(): void;
  destroy(error?: Error): void;
}
export interface PublicHttp {
  getHtml(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; html: string; status: number }>;
  getJson(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; data: unknown; status: number }>;
  getBinary(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; bytes: Uint8Array; contentType: string; status: number }>;
  getRaw(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<PublicHttpResponse>;
  postForm(url: string, fields: Record<string, string>, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; data: unknown; status: number }>;
  postJson(url: string, body: unknown, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; data: unknown; status: number }>;
  getStream(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; status: number; contentType: string; contentLength: number | null; body: PublicHttpBody }>;
}
export interface FileWriter {
  write(relativePath: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<{ relativePath: string; bytes: number }>;
}
export interface EnvironmentReport {
  platform: string;
  architecture: string;
  node: { available: true; version: string };
  git: { available: boolean; version: string | null };
}
export interface ProcessProbe { inspect(signal: AbortSignal): Promise<EnvironmentReport> }
export interface ProgressUpdate {
  phase: string;
  percent?: number;
}

export interface ToolContext {
  signal: AbortSignal;
  limits: Readonly<Limits>;
  stateDirectory: string;
  reportProgress?: (update: ProgressUpdate) => void;
  files?: FileAccess;
  output?: FileWriter;
  http?: PublicHttp;
  probes?: ProcessProbe;
}
export interface IntegrationInfo {
  configPath: string;
  workspaceRoot: string;
  networkEnabled: boolean;
  mcp: { configured: false; buildReady: boolean; config: Record<string, unknown> };
  cli: string[];
}
