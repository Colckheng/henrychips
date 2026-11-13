export type Category = 'files' | 'documents' | 'web' | 'data' | 'developer' | 'text' | 'media';
export type Capability = 'files:read' | 'files:write' | 'network:public' | 'process:probe' | 'browser:local' | 'downloader:local';
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
  /** 同时设定响应头超时与响应体超时，二者含义不同：前者是首字节的等待上限，后者是两段数据之间的间隔上限。默认 10000。 */
  timeoutMs?: number;
  /** Lets the caller read the status of an error answer instead of a failure. */
  allowErrorStatus?: boolean;
  /**
   * Accepts a compressed answer and decodes it. The server of some platforms
   * ignores the identity encoding the client asks for, so the caller has to
   * opt in explicitly. The decoded byte count is the one that counts against
   * the size limit.
   */
  acceptCompressed?: boolean;
}
export interface PublicHttpResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  setCookie: string[];
  headers: Record<string, string>;
}
/** The head of a response: the status, the headers and the cookies of the whole redirect chain, without the body. */
export interface PublicHttpHead {
  finalUrl: string;
  status: number;
  contentType: string;
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
  getHead(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<PublicHttpHead>;
  postForm(url: string, fields: Record<string, string>, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; data: unknown; status: number }>;
  postJson(url: string, body: unknown, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; data: unknown; status: number }>;
  getStream(url: string, signal: AbortSignal, options?: PublicHttpRequest): Promise<{ finalUrl: string; status: number; contentType: string; contentLength: number | null; body: PublicHttpBody; headers: Record<string, string> }>;
}
export interface FileHandle {
  readonly relativePath: string;
  /** 在文件的指定偏移写入，返回写入的字节数。 */
  writeAt(buffer: Uint8Array, position: number): Promise<number>;
  /** 已写入字节数。 */
  bytesWritten(): number;
  /** 预分配到指定长度，不写内容。 */
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}
export interface FileWriter {
  write(relativePath: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<{ relativePath: string; bytes: number }>;
  open(relativePath: string, options?: { overwrite?: boolean; truncateTo?: number }): Promise<FileHandle>;
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
