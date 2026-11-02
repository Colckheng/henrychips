import { ToolError } from '../core/errors.js';
import { runPdfWorker } from './pdf-text.js';

export async function extractPdfText(bytes: Uint8Array, signal: AbortSignal, reportProgress?: (update: { phase: string; percent?: number }) => void) {
  if (!bytes.byteLength) throw new ToolError('UNSUPPORTED_FORMAT', '文件内容为空。');
  return runPdfWorker({ bytes, startPage: 1, endPage: undefined, pageLimit: 30 }, signal, reportProgress);
}
