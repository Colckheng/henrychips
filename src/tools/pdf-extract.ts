import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { checkAbort, runPdfWorker } from './pdf-text.js';

export const pdfExtractTool = defineTool({
  name: 'pdf_extract', title: 'PDF 文本提取', description: '提取工作区 PDF 的指定页文本；扫描件需要另行进行 OCR。',
  category: 'documents', capabilities: ['files:read'],
  fields: [
    { name: 'path', label: 'PDF 路径', type: 'relative-path', placeholder: 'samples/guide.pdf' },
    { name: 'startPage', label: '起始页', type: 'number', description: '从 1 开始，默认第 1 页。' },
    { name: 'endPage', label: '结束页', type: 'number', description: '可选；默认最后一页，单次最多提取 30 页。' },
  ],
  examples: [{ label: '提取示例 PDF', input: { path: 'samples/guide.pdf', startPage: 1, endPage: 2 } }],
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096), startPage: z.number().int().positive().default(1), endPage: z.number().int().positive().optional(),
  }),
  outputSchema: z.strictObject({
    totalPages: z.number().int().nonnegative(),
    pages: z.array(z.strictObject({ page: z.number().int().positive(), text: z.string() })),
    textCharacters: z.number().int().min(0).max(100_000), truncated: z.boolean(), warnings: z.array(z.string()),
  }),
  async execute(input, ctx) {
    checkAbort(ctx.signal);
    ctx.reportProgress?.({ phase: '检查文件与页范围' });
    if (!ctx.files) throw new ToolError('ACCESS_DENIED', '未启用工作区文件读取。');
    if (!/\.pdf$/i.test(input.path)) throw new ToolError('UNSUPPORTED_FORMAT', '请选择 PDF 文件。');
    if (input.endPage !== undefined && input.endPage < input.startPage) throw new ToolError('INVALID_INPUT', '结束页不能早于起始页。');
    const pageLimit = Math.min(30, ctx.limits.pdfPages);
    if (input.endPage !== undefined && input.endPage - input.startPage + 1 > pageLimit) {
      throw new ToolError('LIMIT_EXCEEDED', '所选 PDF 页数超过本次处理上限。');
    }
    ctx.reportProgress?.({ phase: '读取 PDF 文件' });
    let bytes: Uint8Array;
    try { bytes = await ctx.files.readBytes(input.path, ctx.limits.fileBytes); }
    catch (error) { checkAbort(ctx.signal); throw error; }
    checkAbort(ctx.signal);
    if (bytes.byteLength > ctx.limits.fileBytes) throw new ToolError('LIMIT_EXCEEDED', 'PDF 超过读取大小限制。');
    ctx.reportProgress?.({ phase: '解析 PDF 文本' });
    return runPdfWorker({ bytes: new Uint8Array(bytes), startPage: input.startPage, endPage: input.endPage, pageLimit }, ctx.signal, ctx.reportProgress);
  },
});
