import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import type { ToolContext, PublicHttp } from '../../src/contracts/tool.js';
import { createFileAccess, createFileWriter } from '../../src/core/file-access.js';
import { renderBlocksToDocx } from '../../src/core/docx-build.js';
import { docConvertTool } from '../../src/tools/doc-convert.js';
import { csvSummaryTool } from '../../src/tools/csv-summary.js';
import { xlsxSummaryTool } from '../../src/tools/xlsx-summary.js';
import { photoCompressTool } from '../../src/tools/photo-compress.js';
import { webExtractTool } from '../../src/tools/web-extract.js';
import { extractPdfText } from '../../src/tools/doc-convert-helpers.js';
import { limits } from './helpers.js';

async function fixture(t: TestContext, files: Record<string, Uint8Array | string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'workstation-fix-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const signal = new AbortController().signal;
  const ctx: ToolContext = { signal, limits, stateDirectory: root };
  ctx.files = createFileAccess(root, signal);
  ctx.output = createFileWriter(outDir, signal, limits.outputBytes);
  return { root, outDir, ctx };
}

async function convert(t: TestContext, files: Record<string, Uint8Array | string>, input: { path: string; to: 'docx' | 'pdf' | 'markdown' | 'txt' | 'html' }) {
  const { outDir, ctx } = await fixture(t, files);
  const result = await docConvertTool.execute(docConvertTool.inputSchema.parse(input), ctx);
  return { result, outDir };
}

async function makePdf(texts: string[]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = document.addPage([612, 792]);
    if (text) page.drawText(text, { x: 50, y: 720, size: 12, font });
  }
  return document.save();
}

async function makeDocx(text: string) {
  return renderBlocksToDocx([{ kind: 'paragraph', runs: [{ text }] }], 'test');
}

test('7a: WebP and JPEG images convert to PDF instead of failing as mislabelled JPEG', async (t) => {
  const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const { result, outDir } = await convert(t, { 'photo.webp': webp }, { path: 'photo.webp', to: 'pdf' });
  assert.equal(result.characters, 0);
  assert.equal(Buffer.from(await readFile(path.join(outDir, result.savedFile.relativePath))).subarray(0, 4).toString(), '%PDF');
  const { result: jpegResult } = await convert(t, { 'photo.jpg': jpeg }, { path: 'photo.jpg', to: 'pdf' });
  assert.equal(jpegResult.characters, 0);
  assert.ok(jpegResult.savedFile.bytes > 0);
});

test('7a: an image wider than 2000px is downscaled and warned about', async (t) => {
  const big = await sharp({ create: { width: 3000, height: 100, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
  const { result, outDir } = await convert(t, { 'big.png': big }, { path: 'big.png', to: 'pdf' });
  assert.ok(result.warnings.some(warning => /2000/.test(warning)), `expected a 2000px warning, got ${JSON.stringify(result.warnings)}`);
  const pdf = await PDFDocument.load(await readFile(path.join(outDir, result.savedFile.relativePath)));
  assert.equal(pdf.getPage(0).getWidth(), 2000);
});

test('7b: docx tables stay in place between the surrounding paragraphs', async () => {
  const bytes = await renderBlocksToDocx([
    { kind: 'paragraph', runs: [{ text: 'BEFORE-PARA' }] },
    { kind: 'table', header: true, rows: [['CELL-A1', 'CELL-B1'], ['CELL-A2', 'CELL-B2']] },
    { kind: 'paragraph', runs: [{ text: 'AFTER-PARA' }] },
  ], 'test');
  const text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
  assert.ok(text.indexOf('BEFORE-PARA') < text.indexOf('CELL-A1'), text);
  assert.ok(text.indexOf('CELL-A2') < text.indexOf('AFTER-PARA'), text);
});

test('7c: docx conversion counts characters, not produced bytes', async (t) => {
  const docx = await makeDocx('中文内容测试');
  const { result } = await convert(t, { 'doc.docx': docx }, { path: 'doc.docx', to: 'txt' });
  const raw = (await mammoth.extractRawText({ buffer: Buffer.from(docx) })).value;
  assert.equal(result.characters, raw.length);
  assert.ok(result.characters < result.savedFile.bytes, 'multibyte text must have more bytes than characters');
  assert.ok(result.characters > 0);
});

test('7c: image to PDF reports zero characters and says so', async (t) => {
  const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
  const { result } = await convert(t, { 'photo.png': png }, { path: 'photo.png', to: 'pdf' });
  assert.equal(result.characters, 0);
  assert.ok(result.warnings.some(warning => /characters 记为 0/.test(warning)));
});

test('7d: the layout warning appears only for PDF to Word', async (t) => {
  const pdf = await makePdf(['Hello world']);
  const { result: txt } = await convert(t, { 'guide.pdf': pdf }, { path: 'guide.pdf', to: 'txt' });
  assert.equal(txt.warnings.some(warning => /仅保留文本/.test(warning)), false);
  const { result: docx } = await convert(t, { 'guide.pdf': pdf }, { path: 'guide.pdf', to: 'docx' });
  assert.ok(docx.warnings.some(warning => /仅保留文本/.test(warning)));
});

test('7e: TXT to HTML escapes & before <', async (t) => {
  const { result, outDir } = await convert(t, { 'note.txt': 'a &copy; b <tag>' }, { path: 'note.txt', to: 'html' });
  const html = await readFile(path.join(outDir, result.savedFile.relativePath), 'utf8');
  assert.ok(html.includes('&amp;copy;'), html);
  assert.ok(html.includes('&lt;tag>'), html);
  assert.equal(html.includes('&copy;'), false);
});

test('7e: PDF to HTML escapes & before <', async (t) => {
  const pdf = await makePdf(['Fish & Chips <del>']);
  const { result, outDir } = await convert(t, { 'guide.pdf': pdf }, { path: 'guide.pdf', to: 'html' });
  const html = await readFile(path.join(outDir, result.savedFile.relativePath), 'utf8');
  assert.ok(html.includes('&amp;'), html);
  assert.ok(html.includes('&lt;del>'), html);
});

test('7f: a dropped image in HTML conversion is warned about', async (t) => {
  const { result } = await convert(t, { 'doc.html': '<h1>标题</h1><p><img src="pic.png" alt="图" /></p><p>正文内容。</p>' }, { path: 'doc.html', to: 'docx' });
  assert.ok(result.warnings.some(warning => /图片/.test(warning)), JSON.stringify(result.warnings));
  const { result: plain } = await convert(t, { 'doc.html': '<h1>标题</h1><p>正文内容。</p>' }, { path: 'doc.html', to: 'docx' });
  assert.equal(plain.warnings.some(warning => /图片/.test(warning)), false);
});

test('12a: CSV statistics use only the numeric cells and count the rest', async (t) => {
  const { ctx } = await fixture(t, { 'data.csv': 'value\n1\nabc\n2.5\n""\n' });
  const output = await csvSummaryTool.execute({ path: 'data.csv', delimiter: ',' }, ctx);
  assert.equal(output.rowCount, 4);
  assert.deepEqual(output.columns, [
    { name: 'value', emptyCount: 1, nonNumericCount: 1, numeric: { count: 2, min: 1, max: 2.5, sum: 3.5, mean: 1.75 } },
  ]);
});

test('12b: XLSX blanks do not make a numeric column mixed, and rowCount excludes the header', async () => {
  const bytes = new Uint8Array(await readFile(path.resolve('sandbox/samples/sales.xlsx')));
  const ctx: ToolContext = {
    signal: new AbortController().signal, limits, stateDirectory: process.cwd(),
    files: { readBytes: async () => bytes } as never,
  };
  const result = await xlsxSummaryTool.execute({ path: 'samples/sales.xlsx', maxRows: 2000, sheet: undefined }, ctx);
  const [sales, summary] = result.sheets;
  assert.equal(sales.rowCount, 4);
  assert.equal(sales.analyzedRows, 4);
  assert.equal(sales.columns[1].kind, 'number');
  assert.equal(sales.columns[1].empty, 1);
  assert.equal(sales.columns[1].numeric?.sum, 32.5);
  assert.equal(sales.columns[2].kind, 'text');
  assert.equal(summary.rowCount, 1);
});

test('12c: AVIF quality is passed to the encoder as given', async (t) => {
  const source = await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
  const { root, outDir, ctx } = await fixture(t, { 'photo.png': source });
  void root;
  const result = await photoCompressTool.execute({ path: 'photo.png', format: 'avif', quality: 80, keepMetadata: false }, ctx);
  const produced = await readFile(path.join(outDir, result.savedFile.relativePath));
  const direct80 = await sharp(source, { failOn: 'none' }).withMetadata({}).avif({ quality: 80 }).toBuffer();
  const direct60 = await sharp(source, { failOn: 'none' }).withMetadata({}).avif({ quality: 60 }).toBuffer();
  assert.deepEqual(produced, direct80);
  assert.notDeepEqual(produced, direct60);
});

test('12e: one bad page is skipped with a warning while the other pages still extract', { timeout: 60_000 }, async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of ['Page one hello', 'Page two hello', 'Page three hello']) {
    const page = document.addPage([612, 792]);
    page.drawText(text, { x: 50, y: 720, size: 12, font });
  }
  const raw = Buffer.from(await document.save({ useObjectStreams: false }));
  const text = raw.toString('latin1');
  const streams = [...text.matchAll(/(\d+) 0 obj\s*<<[^>]*\/Length \d+[^>]*>>\s*stream/g)];
  assert.equal(streams.length, 3);
  const second = streams[1];
  const at = text.indexOf(`${second[1]} 0 obj`, second.index!);
  const broken = Buffer.from(raw);
  broken.write('obx', at + `${second[1]} 0 `.length, 'latin1');
  const extraction = await extractPdfText(new Uint8Array(broken), new AbortController().signal);
  assert.deepEqual(extraction.pages, [
    { page: 1, text: 'Page one hello' },
    { page: 3, text: 'Page three hello' },
  ]);
  assert.ok(extraction.warnings.some(warning => /第 2 页提取失败/.test(warning)), JSON.stringify(extraction.warnings));
});

const htmlContext = (html: string): ToolContext => {
  const http = {
    async getHtml() {
      return { finalUrl: 'https://nodejs.org/en', html, status: 200 };
    },
  } as unknown as PublicHttp;
  return { signal: new AbortController().signal, limits, stateDirectory: process.cwd(), http };
};

test('12f: an empty article falls back to main, then to body', async () => {
  const main = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext('<html><body><article></article><main><p>Main text</p></main><p>Body text</p></body></html>'));
  assert.equal(main.text, 'Main text');
  const body = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext('<html><body><article>   </article><p>Body text</p></body></html>'));
  assert.equal(body.text, 'Body text');
  const article = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext('<html><body><article><p>Article text</p></article><main><p>Main text</p></main></body></html>'));
  assert.equal(article.text, 'Article text');
});
