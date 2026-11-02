import { Worker } from 'node:worker_threads';
import { ToolError } from '../core/errors.js';
import type { PdfExtraction, PdfWorkerInput, PdfWorkerMessage } from './pdf-worker.js';

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('CANCELLED', 'PDF 提取已取消。');
}

export function runPdfWorker(input: PdfWorkerInput, signal: AbortSignal, reportProgress?: (update: { phase: string; percent?: number }) => void): Promise<PdfExtraction> {
  checkAbort(signal);
  const source = import.meta.url.endsWith('.ts');
  const workerUrl = new URL(source ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url);
  // Register tsx inside the source worker before Node loads its .ts entry point.
  // Compiled workers need neither tsx nor inherited CLI/debug/test arguments.
  const loader = source ? `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register();` : '';
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: input,
        transferList: [input.bytes.buffer as ArrayBuffer],
        execArgv: source ? ['--import', `data:text/javascript,${encodeURIComponent(loader)}`] : [],
        stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch {
      reject(new ToolError('TOOL_FAILED', '无法启动 PDF 提取进程。'));
      return;
    }
    // Library logging must never reach the MCP protocol's stdout. Errors are
    // returned only through the sanitized worker message channel.
    worker.stdout.resume();
    worker.stderr.resume();
    let message: PdfWorkerMessage | undefined;
    let failed = false;
    const abort = () => { void worker.terminate().catch(() => { failed = true; }); };
    worker.on('message', (value: PdfWorkerMessage) => {
      if ('progress' in value) {
        reportProgress?.({ phase: `解析第 ${value.progress.page}/${value.progress.total} 页`, percent: Math.round((value.progress.page / value.progress.total) * 95) });
        return;
      }
      message = value;
    });
    worker.once('error', () => { failed = true; });
    worker.once('exit', (code) => {
      signal.removeEventListener('abort', abort);
      // Settle only on exit: the executor must not release its concurrency slot
      // while an aborted parser is still consuming CPU or memory.
      if (signal.aborted) reject(new ToolError('CANCELLED', 'PDF 提取已取消。'));
      else if (failed || code !== 0 || !message) reject(new ToolError('TOOL_FAILED', 'PDF 提取进程未正常完成。'));
      else if (!('ok' in message)) reject(new ToolError('TOOL_FAILED', 'PDF 提取进程未返回结果。'));
      else if (!message.ok) reject(new ToolError(message.code, message.message));
      else resolve(message.result);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
