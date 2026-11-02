import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { PDFDocument, StandardFonts, PDFHexString } from 'pdf-lib';
import type { ToolContext, PublicHttp, EnvironmentReport } from '../../src/contracts/tool.js';
import { createFileAccess } from '../../src/core/file-access.js';
import { createProcessProbe } from '../../src/core/process-probe.js';
import { pdfExtractTool } from '../../src/tools/pdf-extract.js';
import { webExtractTool } from '../../src/tools/web-extract.js';
import { envInspectTool } from '../../src/tools/env-inspect.js';

const execFile = promisify(childProcess.execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const limits = { fileBytes: 8_000_000, csvRows: 10_000, directoryEntries: 500, pdfPages: 30, webBytes: 2_000_000, downloadBytes: 50_000_000, outputBytes: 50_000_000, toolTimeoutMs: 15_000 };
const context = (extra: Partial<ToolContext> = {}): ToolContext => ({ signal: new AbortController().signal, limits, stateDirectory: process.cwd(), ...extra });
async function temporary(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workstation-advanced-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function makePdf(texts: string[]) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = document.addPage([612, 792]);
    // Keep long fixtures on the page: PDF.js ignores out-of-bounds glyphs.
    const wrapped = text.length > 200 ? text.match(/.{1,80}/g)!.join('\n') : text;
    if (wrapped) page.drawText(wrapped, { x: 50, y: 720, size: text.length > 200 ? 8 : 12, lineHeight: 12, font });
  }
  return document.save();
}
async function pdfContext(t: TestContext, bytes: Uint8Array, extra: Partial<ToolContext> = {}) {
  const dir = await temporary(t);
  await writeFile(path.join(dir, 'test.pdf'), bytes);
  const ctx = context(extra);
  ctx.files = createFileAccess(dir, ctx.signal);
  return ctx;
}
async function extract(ctx: ToolContext, input: Record<string, unknown> = { path: 'test.pdf' }) {
  return pdfExtractTool.execute(pdfExtractTool.inputSchema.parse(input), ctx);
}

test('PDF worker extracts both real pages and a selected page with default startPage', async (t) => {
  const ctx = await pdfContext(t, await makePdf(['First page: hello workstation.', 'Second page: local tools.']));
  const result = await extract(ctx);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(result.pages, [
    { page: 1, text: 'First page: hello workstation.' },
    { page: 2, text: 'Second page: local tools.' },
  ]);
  assert.equal(result.textCharacters, 55);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  const page = await extract(ctx, { path: 'test.pdf', startPage: 2, endPage: 2 });
  assert.deepEqual(page.pages, [{ page: 2, text: 'Second page: local tools.' }]);
});

test('PDF has strict inputs and reports invalid ranges as sanitized structured errors', async (t) => {
  const ctx = await pdfContext(t, await makePdf(['One', 'Two']));
  for (const input of [
    { path: 'test.pdf', startPage: 0 }, { path: 'test.pdf', startPage: 1.5 },
    { path: 'test.pdf', endPage: '2' }, { path: 'test.pdf', extra: true },
  ]) await assert.rejects(pdfExtractTool.invoke(input, ctx), { code: 'INVALID_INPUT' });
  for (const input of [
    { path: 'test.pdf', startPage: 2, endPage: 1 },
    { path: 'test.pdf', startPage: 3 }, { path: 'test.pdf', endPage: 3 },
  ]) await assert.rejects(extract(ctx, input), { code: 'INVALID_INPUT' });
});

test('PDF enforces the byte limit and both configured and hard selected-page limits', async (t) => {
  const bytes = await makePdf(Array.from({ length: 31 }, (_, i) => `Page ${i + 1}`));
  const ctx = await pdfContext(t, bytes);
  await assert.rejects(extract({ ...ctx, limits: { ...limits, fileBytes: bytes.length - 1 } }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(extract(ctx), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(extract({ ...ctx, limits: { ...limits, pdfPages: 99 } }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(extract({ ...ctx, limits: { ...limits, pdfPages: 1 } }, { path: 'test.pdf', startPage: 1, endPage: 2 }), { code: 'LIMIT_EXCEEDED' });
  const selected = await extract(ctx, { path: 'test.pdf', startPage: 30, endPage: 31 });
  assert.deepEqual(selected.pages.map(p => p.page), [30, 31]);
});

test('PDF warns explicitly about pages without extractable text', async (t) => {
  const result = await extract(await pdfContext(t, await makePdf([''])));
  assert.deepEqual(result.pages, [{ page: 1, text: '' }]);
  assert.equal(result.textCharacters, 0);
  assert.equal(result.truncated, false);
  assert.ok(result.warnings.some(w => /no extractable text|未提取到|没有可提取/i.test(w)));
});

test('PDF caps extracted text at 100000 characters', async (t) => {
  const result = await extract(await pdfContext(t, await makePdf(Array.from({ length: 30 }, () => 'A'.repeat(4000)))));
  assert.equal(result.textCharacters, 100_000);
  assert.equal(result.pages.reduce((sum, page) => sum + page.text.length, 0), 100_000);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.length > 0);
});

test('PDF errors for corrupt and encrypted documents do not include parser internals', async (t) => {
  const corrupt = await pdfContext(t, Buffer.from('%PDF-1.7\nprivate-filename-and-parser-detail\ninvalid'));
  await assert.rejects(extract(corrupt), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'UNSUPPORTED_FORMAT');
    assert.doesNotMatch((error as Error).message, /private-filename|parser-detail|pdfjs|node_modules/i);
    return true;
  });
  const document = await PDFDocument.create();
  document.addPage();
  document.context.trailerInfo.Encrypt = document.context.register(document.context.obj({
    Filter: 'Standard', V: 1, R: 2, Length: 40, P: -4,
    O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('11'.repeat(32)),
  }));
  const encrypted = await pdfContext(t, await document.save({ useObjectStreams: false }));
  await assert.rejects(extract(encrypted), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'UNSUPPORTED_FORMAT');
    assert.match((error as Error).message, /password|encrypt|密码|加密/i);
    return true;
  });
});

test('PDF cancellation terminates a real running worker before settling', async (t) => {
  const controller = new AbortController();
  const ctx = await pdfContext(t, await makePdf(['Cancellation']), { signal: controller.signal });
  let activeWorker: Worker | undefined;
  const emit = Worker.prototype.emit;
  t.mock.method(Worker.prototype, 'emit', function (this: Worker, event: string | symbol, ...args: unknown[]) {
    if (event === 'online') { activeWorker = this; controller.abort(); }
    return emit.call(this, event, ...args);
  });
  await assert.rejects(extract(ctx), { code: 'CANCELLED' });
  assert.ok(activeWorker, 'a real worker started');
  assert.equal(activeWorker.threadId, -1, 'the worker has exited before the tool rejects');
  await assert.rejects(extract(ctx), { code: 'CANCELLED' });
});

test('compiled PDF tool runs with a JavaScript worker and clean stdout', { timeout: 30_000 }, async (t) => {
  const dir = await temporary(t);
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await execFile(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'), '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2023', '--esModuleInterop', '--skipLibCheck', '--strict', '--rootDir', path.join(root, 'src'),
    '--outDir', dir, path.join(root, 'src/tools/pdf-extract.ts'), path.join(root, 'src/tools/pdf-worker.ts'),
  ], { cwd: root, timeout: 20_000 });
  await writeFile(path.join(dir, 'test.pdf'), await makePdf(['Compiled worker first page', 'Compiled worker second page']));
  const code = `
    import { readFile } from 'node:fs/promises';
    import { pdfExtractTool } from './tools/pdf-extract.js';
    const result = await pdfExtractTool.invoke({ path: 'test.pdf' }, {
      signal: new AbortController().signal,
      limits: ${JSON.stringify(limits)},
      files: { readBytes: async () => new Uint8Array(await readFile('./test.pdf')) }
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout, stderr } = await execFile(process.execPath, ['--input-type=module', '--eval', code], { cwd: dir, timeout: 10_000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.pages, [
    { page: 1, text: 'Compiled worker first page' }, { page: 2, text: 'Compiled worker second page' },
  ]);
  assert.equal(stderr, '');
});

const htmlContext = (html: string, signal = new AbortController().signal): ToolContext => {
  const http = {
    async getHtml(url: string, receivedSignal: AbortSignal) {
      assert.equal(url, 'https://nodejs.org/en');
      assert.equal(receivedSignal, signal);
      return { finalUrl: 'https://nodejs.org/en/learn', html, status: 200 };
    },
  } as unknown as PublicHttp;
  return context({ http, signal });
};

test('web extracts article text and metadata while excluding navigation and executable content', async () => {
  const result = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext(`<!doctype html><html><head>
    <title> Node.js &amp; Tools </title><meta name="description" content=" Learn  JavaScript. "></head><body>
    <nav>Navigation</nav><main><article><h1>Hello &amp; welcome</h1><p>Read <strong>Node.js</strong> now.</p>
    <script>secret()</script><style>secret-style</style><aside>Advertisement</aside><form>Form text</form>
    <p hidden>Hidden</p><span aria-hidden="true">Decorative</span></article><p>Outside article</p></main><footer>Footer</footer>
    </body></html>`));
  assert.equal(result.requestedUrl, 'https://nodejs.org/en');
  assert.equal(result.finalUrl, 'https://nodejs.org/en/learn');
  assert.equal(result.title, 'Node.js & Tools');
  assert.equal(result.description, 'Learn JavaScript.');
  assert.equal(result.text, 'Hello & welcome\nRead Node.js now.');
  assert.equal(result.characters, 33);
  assert.equal(result.truncated, false);
  assert.equal(result.untrustedContent, true);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('web falls back to main/body and limits text to 30000 characters', async () => {
  const input = { url: 'https://nodejs.org/en' };
  const main = await webExtractTool.execute(input, htmlContext('<html><body>Outside<main><p>Main text</p></main></body></html>'));
  assert.equal(main.text, 'Main text');
  const body = await webExtractTool.execute(input, htmlContext('<html><body><p>Body text</p></body></html>'));
  assert.equal(body.text, 'Body text');
  assert.equal(body.title, '');
  const long = await webExtractTool.execute(input, htmlContext(`<html><body>${'a'.repeat(30_001)}</body></html>`));
  assert.equal(long.text, 'a'.repeat(30_000));
  assert.equal(long.characters, 30_000);
  assert.equal(long.truncated, true);
});

test('web detects text beyond the limit across trailing whitespace and block boundaries', async () => {
  for (const html of [
    `<html><body>${'a'.repeat(30_000)}   b</body></html>`,
    `<html><body><p>${'a'.repeat(30_000)}</p><p>b</p></body></html>`,
  ]) {
    const result = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext(html));
    assert.equal(result.text, 'a'.repeat(30_000));
    assert.equal(result.truncated, true);
  }
  const exact = await webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext(`<html><body><p>${'a'.repeat(30_000)}</p> </body></html>`));
  assert.equal(exact.truncated, false);
});

test('web validates inputs, fails on empty text and propagates aborts', async () => {
  const ctx = htmlContext('<html><body><script>only script</script></body></html>');
  await assert.rejects(webExtractTool.execute({ url: 'https://nodejs.org/en' }, ctx), { code: 'UNSUPPORTED_FORMAT' });
  await assert.rejects(webExtractTool.invoke({ url: 'invalid' }, ctx), { code: 'INVALID_INPUT' });
  await assert.rejects(webExtractTool.invoke({ url: 'https://nodejs.org/en', extra: true }, ctx), { code: 'INVALID_INPUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(webExtractTool.execute({ url: 'https://nodejs.org/en' }, htmlContext('<body>Text</body>', controller.signal)), { code: 'CANCELLED' });
});

test('environment returns only the fixed report and optionally reports real git', async () => {
  const report = await createProcessProbe().inspect(new AbortController().signal);
  assert.deepEqual(Object.keys(report).sort(), ['architecture', 'git', 'node', 'platform']);
  assert.equal(report.platform, process.platform);
  assert.equal(report.architecture, process.arch);
  assert.deepEqual(report.node, { available: true, version: process.version });
  if (report.git.available) assert.match(report.git.version!, /^git version \d/);
  else assert.equal(report.git.version, null);
  const output = await envInspectTool.execute({}, context({ probes: { inspect: async () => report } }));
  assert.deepEqual(output, report);
});

test('environment input is strictly empty and capability access is required', async () => {
  for (const tool of [envInspectTool, webExtractTool, pdfExtractTool]) {
    const input = tool.name === envInspectTool.name ? {} : tool.name === webExtractTool.name ? { url: 'https://nodejs.org/en' } : { path: 'test.pdf' };
    await assert.rejects(tool.invoke(input, context()), { code: 'ACCESS_DENIED' });
  }
  await assert.rejects(envInspectTool.invoke({ command: 'whoami' }, context()), { code: 'INVALID_INPUT' });
});

test('environment uses only a fixed shell-free git probe and handles missing git', async (t) => {
  t.mock.method(childProcess, 'execFile', (file: string, args: string[], options: childProcess.ExecFileOptions, callback: (error: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
    assert.equal(file, 'git');
    assert.deepEqual(args, ['--version']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 3000);
    assert.ok(options.signal instanceof AbortSignal);
    queueMicrotask(() => callback(Object.assign(new Error('private path should not leak'), { code: 'ENOENT' }), '', 'private stderr'));
  });
  const report: EnvironmentReport = await createProcessProbe().inspect(new AbortController().signal);
  assert.deepEqual(report.git, { available: false, version: null });
  assert.doesNotMatch(JSON.stringify(report), /private|stderr|PATH|env/);
});

test('environment propagates cancellation', async (t) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createProcessProbe().inspect(controller.signal), { code: 'CANCELLED' });
  const active = new AbortController();
  let child: childProcess.ChildProcess | undefined;
  const original = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (...args: Parameters<typeof childProcess.execFile>) => {
    child = Reflect.apply(original, childProcess, args) as childProcess.ChildProcess;
    child.once('spawn', () => active.abort());
    return child;
  });
  const pending = createProcessProbe().inspect(active.signal);
  // Git is optional. A missing executable is covered separately above.
  const result = await pending.then(value => value, error => error as { code: string });
  if (active.signal.aborted) assert.equal((result as { code: string }).code, 'CANCELLED');
  else assert.equal((result as EnvironmentReport).git.available, false);
  assert.ok(child);
});

test('sample generator creates a readable two-page guide without overwriting it', async (t) => {
  const dir = await temporary(t);
  await mkdir(path.join(dir, 'sandbox'));
  const script = path.join(root, 'scripts/create-samples.ts');
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  await execFile(process.execPath, [tsx, script], { cwd: dir, timeout: 10_000 });
  const filename = path.join(dir, 'sandbox/samples/guide.pdf');
  const bytes = await readFile(filename);
  const result = await extract(await pdfContext(t, bytes));
  assert.equal(result.totalPages, 2);
  assert.equal(result.pages.length, 2);
  assert.ok(result.pages.every(p => p.text.length > 20 && /^[\x00-\x7f]*$/.test(p.text)));
  const preserved = Buffer.from('existing user-owned file');
  await writeFile(filename, preserved);
  await execFile(process.execPath, [tsx, script], { cwd: dir, timeout: 10_000 });
  assert.deepEqual(await readFile(filename), preserved);
});
