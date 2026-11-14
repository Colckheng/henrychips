import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import mammoth from 'mammoth';
import { z } from 'zod';
import type { PublicHttp, ToolContext } from '../../src/contracts/tool.js';
import { bilibiliVideoTool } from '../../src/tools/bilibili-video.js';
import { awemeIdFrom, fetchDouyinVideo, isShortLink, selectDouyinSource } from '../../src/tools/douyin-core.js';
import { requestDetail, writeSession } from '../../src/core/douyin-session.js';
import { douyinNoWatermarkTool } from '../../src/tools/douyin-nowatermark.js';
import { douyinVideoTool } from '../../src/tools/douyin-video.js';
import { docConvertTool } from '../../src/tools/doc-convert.js';
import { photoCompressTool } from '../../src/tools/photo-compress.js';
import { xlsxSummaryTool } from '../../src/tools/xlsx-summary.js';
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
    getRaw: async () => ({ finalUrl: 'https://example.com/', status: 200, contentType: 'text/html', bytes: new Uint8Array(), setCookie: [], headers: {} }),
    getHead: async () => ({ finalUrl: 'https://example.com/', status: 200, contentType: 'text/html', setCookie: [], headers: {} }),
    postForm: async () => ({ finalUrl: 'https://example.com/', data: {}, status: 200 }),
    postJson: async () => ({ finalUrl: 'https://example.com/', data: {}, status: 200 }),
    getStream: async () => ({ finalUrl: 'https://example.com/', status: 200, contentType: 'application/octet-stream', contentLength: 0, body: Readable.from([]), headers: {} }),
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
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例标题', desc: '简介', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [{ url: 'https://cdn/video.mp4', size: 1024 }] } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'https://www.bilibili.com/video/BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'keep', page: 1 }, context({ http }));
  assert.equal(result.bvid, 'BV1ugxq6HEfH');
  assert.equal(result.title, '示例标题');
  assert.equal(result.owner, '作者');
  assert.equal(result.durationSeconds, 126);
  assert.equal(result.streams[0].url, 'https://cdn/video.mp4');
});

test('Bilibili extraction rejects identifiers that are not video numbers', async () => {
  await assert.rejects(
    bilibiliVideoTool.execute({ url: 'not-a-video', download: false, parts: 'video', watermark: 'keep', page: 1 }, context({ http: fakeHttp() })),
    /BV 号/,
  );
});

test('Bilibili audio separation exposes the DASH audio stream and saves it beside the video', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-bili-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      if (url.includes('fnval=0')) return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [{ url: 'https://cdn/video.mp4', size: 1024 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { dash: { duration: 126, video: [{ id: 32, codecs: 'avc1', bandwidth: 1, baseUrl: 'https://cdn:8082/video.m4s' }], audio: [{ id: 30232, codecs: 'mp4a', bandwidth: 5, baseUrl: 'https://cdn:8082/audio.m4s' }] } } } };
    },
    getBinary: async (url) => ({ finalUrl: url, status: 200, contentType: 'video/mp4', bytes: new Uint8Array([1, 2, 3]) }),
  });
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: true, parts: 'both', watermark: 'keep', page: 1 }, context({ http, output: writer }));
  assert.equal(result.audioUrl, 'https://cdn:8082/audio.m4s');
  assert.equal(result.savedFile?.relativePath, 'BV1ugxq6HEfH.mp4');
  assert.equal(result.savedAudioFile?.relativePath, 'BV1ugxq6HEfH-audio.m4a');
  assert.ok(result.streams.some(stream => stream.kind === 'audio'));
});

test('Douyin tools expose the work audio track for separated saving', () => {
  assert.equal(douyinVideoTool.inputSchema.safeParse({ url: '1', parts: 'audio' }).success, true);
  assert.equal(douyinVideoTool.outputSchema.safeParse({
    awemeId: '1', description: '', author: '', durationMs: 1, cover: '', createdAt: null,
    videoUrl: 'https://v/1.mp4', source: 'no-watermark', noWatermarkUrl: 'https://v/1.mp4', watermarkedUrl: null, audioUrl: 'https://m/1.mp3', audioTitle: '原声',
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

test('XLSX analysis lists sheets, headers and per-column statistics', async () => {
  const bytes = new Uint8Array(await readFile(path.resolve('sandbox/samples/sales.xlsx')));
  const result = await xlsxSummaryTool.execute({ path: 'samples/sales.xlsx', maxRows: 2000, sheet: undefined }, context({
    files: { readBytes: async () => bytes } as never,
  }));
  assert.equal(result.sheetCount, 2);
  const [sales] = result.sheets;
  assert.equal(sales.name, '销售');
  assert.deepEqual(sales.headers, ['item', 'amount', 'note']);
  assert.equal(sales.analyzedRows, 4);
  const amount = sales.columns[1];
  assert.equal(amount.filled, 3);
  assert.equal(amount.empty, 1);
  assert.equal(amount.numeric?.sum, 32.5);
  assert.equal(amount.numeric?.min, 7.5);
  assert.equal(amount.numeric?.max, 12.5);
});

test('XLSX analysis refuses files that are not workbooks', async () => {
  await assert.rejects(
    xlsxSummaryTool.execute({ path: 'samples/sales.csv', maxRows: 100, sheet: undefined }, context({ files: { readBytes: async () => new Uint8Array() } as never })),
    /\.xlsx/,
  );
});

test('the Douyin watermark switch picks the clean or the watermarked source', () => {
  const video = {
    awemeId: '1', description: '', author: '', authorId: '', durationMs: 1, cover: '',
    playUrls: ['https://cdn/clean.mp4'], watermarkUrls: ['https://cdn/marked.mp4'],
    imageUrls: [], audioUrls: [], audioTitle: '', audioDurationMs: 0, createdAt: null,
  };
  const clean = selectDouyinSource(video, 'remove');
  assert.equal(clean.source, 'no-watermark');
  assert.equal(clean.url, 'https://cdn/clean.mp4');
  const marked = selectDouyinSource(video, 'keep');
  assert.equal(marked.source, 'watermarked');
  assert.equal(marked.url, 'https://cdn/marked.mp4');
});

test('the Bilibili watermark switch prefers the original DASH stream', async () => {
  const requested: string[] = [];
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      requested.push(url);
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      if (url.includes('fnval=0')) return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [{ url: 'https://cdn/video.mp4', size: 10 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { dash: { duration: 126, video: [{ id: 80, codecs: 'avc1', bandwidth: 900, baseUrl: 'https://cdn/original.m4s' }], audio: [{ id: 30232, codecs: 'mp4a', bandwidth: 5, baseUrl: 'https://cdn/audio.m4s' }] } } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'remove', page: 1 }, context({ http }));
  assert.equal(result.source, 'original-dash');
  assert.ok(result.streams.some(stream => stream.url === 'https://cdn/original.m4s'));
  assert.ok(result.warnings.some(warning => warning.includes('接口不提供')));
});

test('the output writer refuses to follow a link out of the output directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-writer-link-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'workstation-writer-outside-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const link = path.join(directory, 'escape');
  try { await symlink(outside, link, 'junction'); }
  catch { t.skip('当前平台不支持创建联接点'); return; }
  const writer = createFileWriter(directory, new AbortController().signal, limits.outputBytes);
  await assert.rejects(writer.write('escape/pwned.txt', new Uint8Array([1])), /输出目录/);
  const escaped = path.join(outside, 'pwned.txt');
  assert.equal(existsSync(escaped), false);
});

function douyinSessionPath(directory: string): string {
  return path.join(directory, 'douyin-session.json');
}

async function seedDouyinSession(directory: string): Promise<void> {
  await writeFile(douyinSessionPath(directory), JSON.stringify({ capturedAt: Date.now(), cookies: {}, template: {}, verifyFp: '', uifid: '' }));
}

function douyinDetail(play: string[], marked: string[]): Record<string, unknown> {
  return {
    aweme_id: '7699524083810599545', desc: '测试作品',
    author: { nickname: '作者', sec_uid: 'sec' },
    video: { duration: 5000, play_addr: { url_list: play }, download_addr: { url_list: marked }, cover: { url_list: [] }, dynamic_cover: { url_list: [] } },
    music: { play_url: { url_list: [] }, title: '', duration: 0 },
    create_time: 1700000000,
  };
}

function douyinDetailHttp(detail: Record<string, unknown>): PublicHttp {
  return fakeHttp({ getJson: async () => ({ finalUrl: 'https://www.douyin.com/', status: 200, data: { status_code: 0, aweme_detail: detail } }) });
}

const douyinVideoBase = {
  awemeId: '1', description: '', author: '', authorId: '', durationMs: 1, cover: '',
  playUrls: ['https://cdn/clean.mp4'], watermarkUrls: ['https://cdn/marked.mp4'],
  imageUrls: [], audioUrls: [], audioTitle: '', audioDurationMs: 0, createdAt: null,
};

test('the Douyin source label follows the address actually returned on fallback', () => {
  const fallback = selectDouyinSource({ ...douyinVideoBase, playUrls: [], watermarkUrls: ['https://cdn/marked.mp4'] }, 'remove');
  assert.equal(fallback.source, 'watermarked');
  assert.equal(fallback.url, 'https://cdn/marked.mp4');
  const mirror = selectDouyinSource({ ...douyinVideoBase, playUrls: ['https://cdn/clean.mp4'], watermarkUrls: [] }, 'keep');
  assert.equal(mirror.source, 'no-watermark');
  assert.equal(mirror.url, 'https://cdn/clean.mp4');
});

test('douyin_nowatermark warns when only a watermarked address came back', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-douyin-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedDouyinSession(directory);
  const http = douyinDetailHttp(douyinDetail([], ['https://cdn/marked.mp4']));
  const result = await douyinNoWatermarkTool.execute(
    { url: '7699524083810599545', download: false, parts: 'video', watermark: 'remove' },
    context({ http, stateDirectory: directory }),
  );
  assert.equal(result.source, 'watermarked');
  assert.equal(result.noWatermarkUrl, 'https://cdn/marked.mp4');
  assert.ok(result.warnings.some(warning => warning.includes('只返回了带水印地址')));
  assert.ok(!result.warnings.some(warning => warning.includes('当前保留水印')));
});

test('douyin_video warns when a keep-watermark request only got a clean address', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-douyin-mirror-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedDouyinSession(directory);
  const http = douyinDetailHttp(douyinDetail(['https://cdn/clean.mp4'], []));
  const result = await douyinVideoTool.execute(
    { url: '7699524083810599545', download: false, parts: 'video', watermark: 'keep' },
    context({ http, stateDirectory: directory }),
  );
  assert.equal(result.source, 'no-watermark');
  assert.ok(result.warnings.some(warning => warning.includes('只返回了无水印地址')));
});

test('Bilibili extraction can select a later part by page', async () => {
  const requested: string[] = [];
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      requested.push(url);
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 300, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1, part: '上' }, { cid: 77, page: 2, part: '下' }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 150000, durl: [{ url: 'https://cdn/part2.mp4', size: 10 }] } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'keep', page: 2 }, context({ http }));
  assert.ok(requested.some(url => url.includes('cid=77')));
  assert.ok(!requested.some(url => url.includes('cid=42')));
  assert.equal(result.page, 2);
  assert.equal(result.part, '下');
  assert.equal(result.pageCount, 2);
  assert.equal(result.streams[0].url, 'https://cdn/part2.mp4');
});

test('Bilibili extraction rejects a page beyond the part count', async () => {
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: {} } };
    },
  });
  await assert.rejects(
    bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'keep', page: 2 }, context({ http })),
    /第 2 分 P 超出范围，该稿件共 1 分 P/,
  );
});

test('Bilibili audio-only with the watermark kept skips the MP4 request', async () => {
  const requested: string[] = [];
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      requested.push(url);
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      // Would throw if the MP4 branch ran: no durl is returned here.
      if (url.includes('fnval=0')) return { finalUrl: url, status: 200, data: { code: 0, data: { quality: 64, timelength: 126000, durl: [] } } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { dash: { duration: 126, video: [{ id: 32, codecs: 'avc1', bandwidth: 1, baseUrl: 'https://cdn/video.m4s' }], audio: [{ id: 30232, codecs: 'mp4a', bandwidth: 5, baseUrl: 'https://cdn/audio.m4s' }] } } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'audio', watermark: 'keep', page: 1 }, context({ http }));
  assert.ok(!requested.some(url => url.includes('fnval=0')));
  assert.equal(result.audioUrl, 'https://cdn/audio.m4s');
});

test('Bilibili watermark removal skips the MP4 request for video and audio', async () => {
  const requested: string[] = [];
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      requested.push(url);
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      if (url.includes('fnval=0')) return { finalUrl: url, status: 200, data: { code: -412, message: '请求过于频繁' } };
      return { finalUrl: url, status: 200, data: { code: 0, data: { dash: { duration: 126, video: [{ id: 80, codecs: 'avc1', bandwidth: 900, baseUrl: 'https://cdn/original.m4s' }], audio: [{ id: 30232, codecs: 'mp4a', bandwidth: 5, baseUrl: 'https://cdn/audio.m4s' }] } } } };
    },
  });
  const result = await bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'both', watermark: 'remove', page: 1 }, context({ http }));
  assert.ok(!requested.some(url => url.includes('fnval=0')));
  assert.equal(result.source, 'original-dash');
});

test('Bilibili view errors carry the platform code and its own message', async () => {
  const cases: Array<{ code: number; message: string; pattern: RegExp }> = [
    { code: -412, message: '请求过于频繁', pattern: /-412.*请求过于频繁|请求过于频繁.*-412/s },
    { code: -404, message: '啥都木有', pattern: /-404.*啥都木有/s },
    { code: 62002, message: '稿件不可见', pattern: /62002.*稿件不可见/s },
    { code: 12345, message: '未知错误', pattern: /12345.*未知错误/s },
  ];
  for (const { code, message, pattern } of cases) {
    const http = fakeHttp({
      getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: [], headers: {} }),
      getJson: async (url) => ({ finalUrl: url, status: 200, data: { code, message } }),
    });
    await assert.rejects(
      bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'keep', page: 1 }, context({ http })),
      pattern,
    );
  }
});

test('Bilibili playurl errors carry the platform code and its own message', async () => {
  const http = fakeHttp({
    getRaw: async () => ({ finalUrl: 'https://api.bilibili.com/x/frontend/finger/spi', status: 200, contentType: 'application/json', bytes: new Uint8Array(), setCookie: ['buvid3=abc; Path=/'], headers: {} }),
    getJson: async (url) => {
      if (url.includes('/view')) return { finalUrl: url, status: 200, data: { code: 0, data: { bvid: 'BV1ugxq6HEfH', title: '示例', duration: 126, owner: { name: '作者' }, pic: 'https://cover', pages: [{ cid: 42, page: 1 }] } } };
      return { finalUrl: url, status: 200, data: { code: -412, message: '请求过于频繁' } };
    },
  });
  await assert.rejects(
    bilibiliVideoTool.execute({ url: 'BV1ugxq6HEfH', download: false, parts: 'video', watermark: 'keep', page: 1 }, context({ http })),
    /-412.*请求过于频繁/s,
  );
});

test('requestDetail surfaces an explicit platform error and no error for an empty result', async () => {
  const session = { capturedAt: Date.now(), cookies: {}, template: {}, verifyFp: '', uifid: '' };
  const errorHttp = fakeHttp({ getJson: async () => ({ finalUrl: 'https://www.douyin.com/', status: 200, data: { status_code: 1002, status_msg: '作品不存在' } }) });
  const refused = await requestDetail(session, '7699524083810599545', errorHttp, context({ http: errorHttp }));
  assert.equal(refused.ok, false);
  assert.equal(refused.platformError?.code, 1002);
  assert.equal(refused.platformError?.message, '作品不存在');
  const emptyHttp = fakeHttp({ getJson: async () => ({ finalUrl: 'https://www.douyin.com/', status: 200, data: {} }) });
  const empty = await requestDetail(session, '7699524083810599545', emptyHttp, context({ http: emptyHttp }));
  assert.equal(empty.ok, false);
  assert.equal(empty.platformError, undefined);
});

test('fetchDouyinVideo reports an explicit platform error without a browser retry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-douyin-platform-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await seedDouyinSession(directory);
  const http = fakeHttp({ getJson: async () => ({ finalUrl: 'https://www.douyin.com/', status: 200, data: { status_code: 1002, status_msg: '作品不存在' } }) });
  // If this retried through the browser, the failure would be the generic
  // "cannot establish a browser session" error instead of the platform words.
  await assert.rejects(
    fetchDouyinVideo('7699524083810599545', context({ http, stateDirectory: directory })),
    /1002.*作品不存在/s,
  );
});

test('the Douyin session file is written atomically and keeps its permissions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-douyin-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { capturedAt: Date.now(), cookies: { sid: 'abc' }, template: {}, verifyFp: '', uifid: '' };
  await writeSession(directory, session);
  assert.deepEqual(JSON.parse(await readFile(douyinSessionPath(directory), 'utf8')), session);
  assert.equal((await stat(douyinSessionPath(directory))).mode & 0o777, 0o600);
  await Promise.all(Array.from({ length: 10 }, (_, index) => writeSession(directory, { ...session, capturedAt: Date.now() + index })));
  const parsed = JSON.parse(await readFile(douyinSessionPath(directory), 'utf8')) as { capturedAt: number };
  assert.equal(typeof parsed.capturedAt, 'number');
  assert.deepEqual(await readdir(directory), ['douyin-session.json']);
});
