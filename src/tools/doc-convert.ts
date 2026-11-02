import { z } from 'zod';
import mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { writeUniqueFile } from '../core/file-access.js';
import { blocksToPlainText, htmlToBlocks, type Block } from '../core/html-blocks.js';
import { markdownToHtml } from '../core/markdown.js';
import { renderBlocksToDocx } from '../core/docx-build.js';
import { renderBlocksToPdf } from '../core/pdf-layout.js';
import { extractPdfText } from './doc-convert-helpers.js';

type MammothWithMarkdown = typeof mammoth & {
  convertToMarkdown?: (input: { buffer: Buffer }) => Promise<{ value: string }>;
};

const LT = String.fromCharCode(38) + 'lt;';

function sourceKindOf(path: string): 'pdf' | 'docx' | 'markdown' | 'txt' | 'html' | 'image' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.txt')) return 'txt';
  if (/\.(jpe?g|png|webp)$/.test(lower)) return 'image';
  throw new ToolError('UNSUPPORTED_FORMAT', '支持 PDF、DOCX、Markdown、HTML、TXT 与常见图片格式。');
}

async function imageToPdf(bytes: Uint8Array, fileName: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const isPng = /\.png$/i.test(fileName) || bytes[0] === 0x89;
  const image = isPng ? await document.embedPng(bytes) : await document.embedJpg(bytes);
  const size = image.scale(1);
  const page = document.addPage([size.width, size.height]);
  page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
  return new Uint8Array(await document.save());
}

export const docConvertTool = defineTool({
  name: 'doc_convert',
  title: '文档格式转换',
  description: '在 PDF、Word、Markdown、HTML、TXT 与图片之间转换，产物保存到输出目录。全部转换在本进程内完成，不调用外部程序。',
  category: 'documents',
  capabilities: ['files:read', 'files:write'],
  timeoutMs: 120_000,
  fields: [
    { name: 'path', label: '源文件路径', type: 'relative-path', description: '工作区内的文件，例如 samples/guide.pdf。' },
    { name: 'to', label: '目标格式', type: 'select', description: '转换后的文件格式。', options: [
      { label: 'Word 文档 (.docx)', value: 'docx' },
      { label: 'PDF (.pdf)', value: 'pdf' },
      { label: 'Markdown (.md)', value: 'markdown' },
      { label: '纯文本 (.txt)', value: 'txt' },
      { label: '网页 (.html)', value: 'html' },
    ] },
    { name: 'outputName', label: '输出文件名', type: 'text', description: '可选，默认按源文件名与目标格式生成。' },
    { name: 'overwrite', label: '覆盖同名文件', type: 'checkbox', description: '默认不覆盖已存在的输出文件。' },
  ],
  examples: [
    { label: 'PDF 转 Word', input: { path: 'samples/guide.pdf', to: 'docx' } },
  ],
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096),
    to: z.enum(['docx', 'pdf', 'markdown', 'txt', 'html']),
    outputName: z.string().min(1).max(120).optional(),
    overwrite: z.boolean().default(false),
  }),
  outputSchema: z.strictObject({
    sourcePath: z.string(),
    sourceFormat: z.string(),
    targetFormat: z.string(),
    converter: z.string(),
    characters: z.number().int().nonnegative(),
    text: z.string(),
    savedFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }),
    warnings: z.array(z.string()),
  }),
  async execute({ path, to, outputName, overwrite }, ctx) {
    const kind = sourceKindOf(path);
    if (kind === 'image' && to !== 'pdf') throw new ToolError('UNSUPPORTED_FORMAT', '图片仅支持转换为 PDF。');
    if (!ctx.files) throw new ToolError('ACCESS_DENIED', '未启用工作区文件读取。');
    if (!ctx.output) throw new ToolError('ACCESS_DENIED', '未启用文件写入。');
    const warnings: string[] = [];
    ctx.reportProgress?.({ phase: '读取源文件' });
    const bytes = await ctx.files.readBytes(path, ctx.limits.fileBytes);
    let produced: Uint8Array;
    let converterName: string;
    let characters = 0;
    let preview = '';

    if (kind === 'pdf') {
      if (to === 'pdf') throw new ToolError('INVALID_INPUT', '源文件已经是 PDF。');
      ctx.reportProgress?.({ phase: '提取 PDF 文本' });
      const extraction = await extractPdfText(new Uint8Array(bytes), ctx.signal, ctx.reportProgress);
      const text = extraction.pages.map(page => page.text).join('\n\n');
      characters = text.length;
      preview = text;
      if (extraction.warnings.length) warnings.push(...extraction.warnings);
      warnings.push('PDF 转 Word 仅保留文本内容，不还原原始排版。');
      const blocks: Block[] = text.split(/\n{2,}/).filter(Boolean).map(paragraph => ({ kind: 'paragraph', runs: [{ text: paragraph }] }));
      if (to === 'docx') { produced = await renderBlocksToDocx(blocks, path); converterName = 'builtin-docx'; }
      else if (to === 'markdown') { produced = new TextEncoder().encode(`# ${path}\n\n${text}\n`); converterName = 'pdf-text'; }
      else if (to === 'txt') { produced = new TextEncoder().encode(text); converterName = 'pdf-text'; }
      else { produced = new TextEncoder().encode(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${path}</title></head><body><p>${text.replace(/</g, LT)}</p></body></html>`); converterName = 'pdf-text'; }
    } else if (kind === 'docx') {
      if (to === 'docx') throw new ToolError('INVALID_INPUT', '源文件已经是 Word 文档。');
      const buffer = Buffer.from(bytes);
      if (to === 'markdown') {
        const markdown = (mammoth as MammothWithMarkdown).convertToMarkdown;
        if (!markdown) throw new ToolError('UNSUPPORTED_FORMAT', '当前 mammoth 版本不支持 Markdown 输出，请改用 HTML 或 TXT。');
        const result = await markdown({ buffer });
        produced = new TextEncoder().encode(result.value);
        converterName = 'mammoth';
        preview = result.value;
      } else if (to === 'txt') {
        const result = await mammoth.extractRawText({ buffer });
        produced = new TextEncoder().encode(result.value);
        converterName = 'mammoth';
        preview = result.value;
      } else if (to === 'html') {
        const result = await mammoth.convertToHtml({ buffer });
        produced = new TextEncoder().encode(result.value);
        converterName = 'mammoth';
        const raw = await mammoth.extractRawText({ buffer });
        preview = raw.value;
      } else {
        const html = await mammoth.convertToHtml({ buffer });
        const blocks = htmlToBlocks(html.value);
        ctx.reportProgress?.({ phase: '排版生成 PDF', percent: 70 });
        produced = await renderBlocksToPdf(blocks, { title: path });
        converterName = 'builtin-layout';
        preview = blocksToPlainText(blocks);
      }
      characters = produced.byteLength;
    } else if (kind === 'image') {
      produced = await imageToPdf(new Uint8Array(bytes), path);
      converterName = 'pdf-lib';
      characters = produced.byteLength;
    } else {
      const text = new TextDecoder('utf-8').decode(bytes);
      characters = text.length;
      preview = text;
      const html = kind === 'markdown' ? markdownToHtml(text) : kind === 'html' ? text : `<p>${text.replace(/</g, LT).replace(/\n/g, '<br />')}</p>`;
      const blocks = htmlToBlocks(html);
      if (to === 'txt') { produced = new Uint8Array(bytes); converterName = 'copy'; }
      else if (to === 'markdown') {
        if (kind === 'html') {
          produced = new TextEncoder().encode(`# ${path}\n\n${blocksToPlainText(blocks)}\n`);
          converterName = 'builtin-markdown';
        } else { produced = new Uint8Array(bytes); converterName = 'copy'; }
      } else if (to === 'html') {
        produced = new TextEncoder().encode(kind === 'markdown' ? html : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /></head><body>${html}</body></html>`);
        converterName = 'builtin';
      } else if (to === 'docx') {
        ctx.reportProgress?.({ phase: '生成 Word 文档', percent: 70 });
        produced = await renderBlocksToDocx(blocks, path);
        converterName = 'builtin-docx';
      } else {
        produced = await renderBlocksToPdf(blocks, { title: path });
        converterName = 'builtin-layout';
      }
    }

    const baseName = (outputName ?? path.split('/').pop() ?? 'converted').replace(/\.[^.]+$/, '');
    const extension = to === 'markdown' ? 'md' : to;
    const targetName = outputName ? `${baseName}.${extension}` : `${baseName}-${to}.${extension}`;
    const saved = await writeUniqueFile(ctx.output, targetName, produced, { overwrite });
    return { sourcePath: path, sourceFormat: kind, targetFormat: to, converter: converterName, characters, text: preview.slice(0, 2000), savedFile: saved, warnings };
  },
});
