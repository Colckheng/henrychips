import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import { z } from 'zod';
import type { PublicHttp, ToolContext } from '../../src/contracts/tool.js';
import { bilibiliVideoTool } from '../../src/tools/bilibili-video.js';
import { awemeIdFrom, isShortLink } from '../../src/tools/douyin-core.js';
import { douyinNoWatermarkTool } from '../../src/tools/douyin-nowatermark.js';
import { douyinVideoTool } from '../../src/tools/douyin-video.js';
import { docConvertTool } from '../../src/tools/doc-convert.js';
import { photoCompressTool } from '../../src/tools/photo-compress.js';
import { renderBlocksToPdf } from '../../src/core/pdf-layout.js';
import { renderBlocksToDocx } from '../../src/core/docx-build.js';
import { htmlToBlocks } from '../../src/core/html-blocks.js';
import { markdownToHtml } from '../../src/core/markdown.js';
import { extractPdfText } from '../../src/tools/doc-convert-helpers.js';
import { createFileWriter } from '../../src/core/file-access.js';
import { limits } from './helpers.js';

function fakeHttp(overrides: Partial<PublicHttp> = {}): PublicHttp {
  return {
    getHtml: async () => ({ finalUrl: 'https://example.com/', html: '', status: 200 }),
    getJson: async () => ({ finalUrl: 'https://example.com/', data: {}, status: 200 }),
    getBinary: async () => ({ finalUrl: 'https://example.com/', bytes: new Uint8Array(), contentType: 'application/octet-stream', status: 200 }),
    getRaw: async () => ({ finalUrl: 'https://example.com/', status: 200, contentType: 'text/html', bytes: new Uint8Array(), setCookie: [] }),
    ...overrides,
  };
}

function context(extra: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, limits, stateDirectory: process.cwd(), ...extra };
}

test('photo compression shrinks a real photo and reports the size difference', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-photo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(path.resolve('sandbox/samples/photo.jpg'));
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  const result = await photoCompressTool.execute(
    { path: 'samples/photo.jpg', format: 'jpeg', quality: 50, maxWidth: undefined, maxHeight: undefined, keepMetadata: false },
    context({ files: { readBytes: async () => source } as never, output: writer }),
  );
  assert.equal(result.originalBytes, source.byteLength);
  assert.ok(result.compressedBytes < result.originalBytes);
  assert.equal(result.savedBytes, result.originalBytes - result.compressedBytes);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 1200);
  const written = await readFile(path.join(directory, result.savedFile.relativePath));
  assert.equal(written.byteLength, result.compressedBytes);
});

test('photo compression rejects files that are not images', async () => {
  await assert.rejects(
    photoCompressTool.execute(
      { path: 'samples/sales.csv', format: 'jpeg', quality: 70, maxWidth: undefined, maxHeight: undefined, keepMetadata: false },
      context({ files: { readBytes: async () => new Uint8Array() } as never }),
    ),
    /图片/,
  );
});

test('PDF converts into a Word file whose text survives a round trip', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-docx-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(path.resolve('sandbox/samples/guide.pdf'));
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  const result = await docConvertTool.execute(
    { path: 'samples/guide.pdf', to: 'docx', outputName: undefined, overwrite: false },
    context({ files: { readBytes: async () => source } as never, output: writer }),
  );
  assert.equal(result.targetFormat, 'docx');
  const written = await readFile(path.join(directory, result.savedFile.relativePath));
  const text = await mammoth.extractRawText({ buffer: written });
  assert.match(text.value, /Personal Workstation Guide/);
});

test('image conversion produces a readable PDF file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-image-pdf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(path.resolve('sandbox/samples/photo.jpg'));
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  const result = await docConvertTool.execute(
    { path: 'samples/photo.jpg', to: 'pdf', outputName: undefined, overwrite: false },
    context({ files: { readBytes: async () => source } as never, output: writer }),
  );
  const written = await readFile(path.join(directory, result.savedFile.relativePath));
  assert.equal(written.subarray(0, 4).toString(), '%PDF');
});

test('document conversion refuses unsupported targets for images', async () => {
  await assert.rejects(
    docConvertTool.execute(
      { path: 'samples/photo.jpg', to: 'docx', outputName: undefined, overwrite: false },
      context({ files: { readBytes: async () => new Uint8Array() } as never }),
    ),
    /图片仅支持转换为 PDF/,
  );
});

test('Bilibili extraction reads the video metadata and stream from the API', async () => {
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'] }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例标题', desc: '简介', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [{ url: 'https://cdn/video.mp4', size: 1024 }] } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'https://www.bilibili.com/video/BV1ugxq6HEfH', download: false, parts: 'video' }, context({ http }));
  assert.equal(result.bvid, 'BV1ugxq6HEfH');
  assert.equal(result.title, '示例标题');
  assert.equal(result.owner, '作者');
  assert.equal(result.durationSeconds, 126);
  assert.equal(result.streams[0].url, 'https://cdn/video.mp4');
});

test('Bilibili extraction rejects identifiers that are not video numbers', async () => {
  await assert.rejects(
    bilibiliVideoTool.execute({ url: 'not-a-video', download: false, parts: 'video' }, context({ http: fakeHttp() })),
    /BV 号/,
  );
});

test('Bilibili audio separation exposes the DASH audio stream and saves it beside the video', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-bili-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'] }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      if (url.includes('fnval=0')) return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [{ url: 'https://cdn/video.mp4', size: 1024 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { dash: { duration: 126, video: [{ id: 32, codecs: 'avc1', bandwidth: 1, baseUrl: 'https://cdn:8082/video.m4s' }], audio: [{ id: 30232, codecs: 'mp4a', bandwidth: 5, baseUrl: 'https://cdn:8082/audio.m4s' }] } } } };
    },
    getBinary: async (url) => ({ finalUrl: url, status: 200, contentType: 'video/mp4', bytes: new Uint8Array([1, 2, 3]) }),
  });
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: true, parts: 'both' }, context({ http, output: writer }));
  assert.equal(result.audioUrl, 'https://cdn:8082/audio.m4s');
  assert.equal(result.savedFile?.relativePath, 'BV1ugxq6HEfH.mp4');
  assert.equal(result.savedAudioFile?.relativePath, 'BV1ugxq6HEfH-audio.m4a');
  assert.ok(result.streams.some(stream => stream.kind === 'audio'));
});

test('Douyin tools expose the work audio track for separated saving', () => {
  assert.equal(douyinVideoTool.inputSchema.safeParse({ url: '1', parts: 'audio' }).success, true);
  assert.equal(douyinVideoTool.outputSchema.safeParse({
    awemeId: '1', description: '', author: '', durationMs: 1, cover: '', createdAt: null,
    videoUrl: 'https://v/1.mp4', watermarkedUrl: null, audioUrl: 'https://m/1.mp3', audioTitle: '原声',
    audioDurationMs: 1000, imageUrls: [], savedFile: null, savedAudioFile: null, warnings: [],
  }).success, true);
  assert.equal(douyinNoWatermarkTool.inputSchema.safeParse({ url: '1', parts: 'both' }).success, true);
});

test('Douyin links are reduced to a work identifier', () => {
  assert.equal(awemeIdFrom('7699524083810599545'), '7699524083810599545');
  assert.equal(awemeIdFrom('https://www.douyin.com/video/7699524083810599545'), '7699524083810599545');
  assert.equal(awemeIdFrom('https://www.iesdouyin.com/share/video/7699524083810599545/'), '7699524083810599545');
  assert.equal(isShortLink('https://v.douyin.com/iRNBho6/'), true);
  assert.equal(isShortLink('https://www.douyin.com/video/1'), false);
  assert.throws(() => awemeIdFrom('https://www.douyin.com/user/abc'), /作品/);
});

test('Douyin tools declare the browser and output capabilities they rely on', () => {
  for (const tool of [douyinVideoTool, douyinNoWatermarkTool]) {
    assert.ok(tool.capabilities.includes('browser:local'));
    assert.ok(tool.capabilities.includes('files:write'));
    assert.ok(tool.capabilities.includes('network:public'));
    assert.equal(tool.inputSchema.safeParse({ url: '1' }).success, true);
    assert.equal(tool.inputSchema.safeParse({}).success, false);
  }
});

test('the output writer keeps files inside the output directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-writer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  await assert.rejects(writer.write('../escape.txt', new Uint8Array([1])), /输出目录/);
  await assert.rejects(writer.write('/absolute.txt', new Uint8Array([1])), /相对路径/);
  await writer.write('nested/file.txt', new Uint8Array([1, 2, 3]));
  await assert.rejects(writer.write('nested/file.txt', new Uint8Array([1])), /已存在/);
  const overwritten = await writer.write('nested/file.txt', new Uint8Array([1]), { overwrite: true });
  assert.equal(overwritten.bytes, 1);
});

test('the file writer refuses content above the configured output limit', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-writer-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 4);
  await assert.rejects(writer.write('big.bin', new Uint8Array(5)), /大小限制/);
});

test('new tools stay serializable for the catalog', () => {
  const schema = z.toJSONSchema(bilibiliVideoTool.inputSchema, { io: 'input' });
  assert.equal(typeof schema, 'object');
  assert.equal(bilibiliVideoTool.timeoutMs, 120_000);
});

test('the built-in layout engine writes a PDF whose Chinese text can be read back', async () => {
  const blocks = htmlToBlocks(markdownToHtml('# 标题\n\n正文内容 with 中文。\n\n- 项目一\n\n| 名称 | 数值 |\n| --- | --- |\n| 合计 | 20 |\n'));
  const bytes = await renderBlocksToPdf(blocks, { title: '测试' });
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-pdf-roundtrip-'));
  try {
    const file = path.join(directory, 'out.pdf');
    await writeFile(file, bytes);
    const extraction = await extractPdfText(new Uint8Array(bytes), new AbortController().signal);
    const text = extraction.pages.map(page => page.text).join('\n');
    assert.match(text, /标题/);
    assert.match(text, /正文内容/);
    assert.match(text, /合计/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the built-in Word writer produces a document that mammoth can read', async () => {
  const blocks = htmlToBlocks('<h1>章节</h1><p>第一段内容。</p>');
  const bytes = await renderBlocksToDocx(blocks, '测试');
  const text = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  assert.match(text.value, /章节/);
  assert.match(text.value, /第一段内容/);
});
