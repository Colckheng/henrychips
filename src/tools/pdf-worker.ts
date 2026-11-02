import { parentPort, workerData } from 'node:worker_threads';
import type { ErrorCode } from '../contracts/run.js';

export interface PdfWorkerInput {
  bytes: Uint8Array;
  startPage: number;
  endPage?: number;
  pageLimit: number;
}
export interface PdfExtraction {
  totalPages: number;
  pages: Array<{ page: number; text: string }>;
  textCharacters: number;
  truncated: boolean;
  warnings: string[];
}
export type PdfWorkerMessage =
  | { ok: true; result: PdfExtraction }
  | { ok: false; code: ErrorCode; message: string }
  | { progress: { page: number; total: number } };

// PDF.js may ask for bundled fonts/CMaps/wasm. Text extraction has no authority
// to read those assets or fetch URLs, even when a document references them.
class NoExternalAssets {
  async fetch(): Promise<never> { throw new Error('External PDF assets are disabled.'); }
}

async function extract(input: PdfWorkerInput, report?: (page: number, total: number) => void): Promise<PdfWorkerMessage> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({
    data: input.bytes, verbosity: 0, disableFontFace: true, useSystemFonts: false,
    useWorkerFetch: false, useWasm: false, enableXfa: false,
    disableAutoFetch: true, disableRange: true, disableStream: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    BinaryDataFactory: NoExternalAssets, stopAtErrors: true,
  });
  try {
    const document = await loading.promise;
    const endPage = input.endPage ?? document.numPages;
    if (input.startPage > document.numPages || endPage > document.numPages || endPage < input.startPage) {
      return { ok: false, code: 'INVALID_INPUT', message: '页码范围超出 PDF 的有效页数。' };
    }
    if (endPage - input.startPage + 1 > Math.min(30, input.pageLimit)) {
      return { ok: false, code: 'LIMIT_EXCEEDED', message: '所选 PDF 页数超过本次处理上限，请缩小页码范围。' };
    }
    const result: PdfExtraction = { totalPages: document.numPages, pages: [], textCharacters: 0, truncated: false, warnings: [] };
    const characterLimit = 100_000;
    for (let pageNumber = input.startPage; pageNumber <= endPage; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      let text = '';
      let separator = '';
      const remaining = characterLimit - result.textCharacters;
      try {
        while (!result.truncated) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (!('str' in item)) continue;
            const value = item.str.replace(/\s+/g, ' ').trim();
            if (value) {
              const addition = (text ? separator : '') + value;
              const available = remaining - text.length;
              text += addition.slice(0, available);
              if (addition.length > available) { result.truncated = true; break; }
              separator = ' ';
            }
            if (item.hasEOL) separator = '\n';
          }
        }
      } finally {
        await reader.cancel(new Error('Text extraction complete.'));
        reader.releaseLock();
        page.cleanup();
      }
      text = text.trim();
      result.pages.push({ page: pageNumber, text });
      result.textCharacters += text.length;
      report?.(pageNumber - input.startPage + 1, endPage - input.startPage + 1);
      if (!text && !result.truncated) result.warnings.push(`第 ${pageNumber} 页没有可提取的文本；扫描件可能需要 OCR。`);
      if (result.truncated) break;
    }
    if (result.truncated) result.warnings.push('提取文本已达到 100000 字符上限，后续内容已截断。');
    return { ok: true, result };
  } catch (error) {
    if ((error as Error)?.name === 'PasswordException') {
      return { ok: false, code: 'UNSUPPORTED_FORMAT', message: '不支持需要密码的加密 PDF。' };
    }
    return { ok: false, code: 'UNSUPPORTED_FORMAT', message: '无法解析 PDF；文件可能已损坏或采用不支持的格式。' };
  } finally {
    await loading.destroy();
  }
}

if (parentPort) {
  const port = parentPort;
  try {
    const result = await extract(workerData as PdfWorkerInput, (page, total) => port.postMessage({ progress: { page, total } }));
    port.postMessage(result);
  }
  catch { port.postMessage({ ok: false, code: 'TOOL_FAILED', message: 'PDF 文本提取失败。' } satisfies PdfWorkerMessage); }
  finally { port.close(); }
}
