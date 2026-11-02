import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Limits, ToolContext } from '../../src/contracts/tool.js';
import { createFileAccess } from '../../src/core/file-access.js';
import { textStatsTool } from '../../src/tools/text-stats.js';
import { filesPlanTool } from '../../src/tools/files-plan.js';
import { csvSummaryTool } from '../../src/tools/csv-summary.js';

const limits: Limits = {
  fileBytes: 65_536,
  csvRows: 1_000,
  directoryEntries: 100,
  pdfPages: 30,
  webBytes: 65_536,
  downloadBytes: 1_048_576,
  outputBytes: 1_048_576,
  toolTimeoutMs: 5_000,
};

function context(overrides: Partial<Limits> = {}): ToolContext {
  return { signal: new AbortController().signal, limits: { ...limits, ...overrides }, stateDirectory: process.cwd() };
}

async function fixture(t: TestContext, overrides: Partial<Limits> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'workstation-basic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = context(overrides);
  ctx.files = createFileAccess(root, ctx.signal);
  return { root, ctx };
}

async function csvFixture(t: TestContext, text: string | Uint8Array, overrides: Partial<Limits> = {}) {
  const result = await fixture(t, overrides);
  await writeFile(path.join(result.root, 'data.CSV'), text);
  return result.ctx;
}

const csvInput = { path: 'data.CSV', delimiter: ',' as const };

test('text counts the approved mixed-language example without file capabilities', async () => {
  assert.deepEqual(await textStatsTool.execute({ text: 'Hello 世界\n第二行' }, context()), {
    characters: 12,
    charactersWithoutWhitespace: 10,
    lines: 2,
    hanCharacters: 5,
    latinWords: 1,
  });
});

test('text counts code points and normalizes CRLF only for line counts', async () => {
  assert.deepEqual(await textStatsTool.execute({ text: 'A😀\r\n中\rB\n' }, context()), {
    characters: 8,
    charactersWithoutWhitespace: 4,
    lines: 4,
    hanCharacters: 1,
    latinWords: 2,
  });
  assert.deepEqual(await textStatsTool.execute({ text: '\u{20000}\u3000😀\t' }, context()), {
    characters: 4,
    charactersWithoutWhitespace: 2,
    lines: 1,
    hanCharacters: 1,
    latinWords: 0,
  });
});

test('text counts contiguous Latin letters, excluding numbers and other scripts', async () => {
  const output = await textStatsTool.execute({ text: 'café déjà-vu foo123bar Ελληνικά русский' }, context());
  assert.equal(output.latinWords, 5);
});

test('text rejects empty and Unicode whitespace-only inputs', async () => {
  for (const text of ['', ' \t\r\n', '\u3000\u00a0\u0085\ufeff']) {
    await assert.rejects(textStatsTool.execute({ text }, context()), { code: 'INVALID_INPUT' });
  }
});

test('text accepts exactly 100000 code points and rejects the next code point', async () => {
  const text = '😀'.repeat(100_000);
  assert.equal((await textStatsTool.execute({ text }, context())).characters, 100_000);
  await assert.rejects(textStatsTool.execute({ text: `${text}a` }, context()), { code: 'LIMIT_EXCEEDED' });
});

test('CSV preserves BOM-decoded quoted fields, embedded newlines and original cell whitespace', async (t) => {
  const ctx = await csvFixture(t, '\ufeffname,amount,note\r\n"Doe, Jane",12.5,"said ""hi""\r\nnext"\r\nBob, 7.5 ,\r\n\r\nCara,," "\r\n');
  const output = await csvSummaryTool.execute(csvInput, ctx);
  assert.equal(output.rowCount, 3);
  assert.equal(output.columnCount, 3);
  assert.deepEqual(output.columns, [
    { name: 'name', emptyCount: 0, numeric: null },
    { name: 'amount', emptyCount: 1, numeric: { count: 2, min: 7.5, max: 12.5, sum: 20, mean: 10 } },
    { name: 'note', emptyCount: 2, numeric: null },
  ]);
  assert.deepEqual(output.preview, [
    { name: 'Doe, Jane', amount: '12.5', note: 'said "hi"\r\nnext' },
    { name: 'Bob', amount: ' 7.5 ', note: '' },
    { name: 'Cara', amount: '', note: ' ' },
  ]);
});

test('CSV retains whitespace-only records while skipping empty physical lines', async (t) => {
  const ctx = await csvFixture(t, '\nvalue\n\n   \n""\n7\n\n');
  const output = await csvSummaryTool.execute(csvInput, ctx);
  assert.equal(output.rowCount, 3);
  assert.deepEqual(output.columns, [
    { name: 'value', emptyCount: 2, numeric: { count: 1, min: 7, max: 7, sum: 7, mean: 7 } },
  ]);
  assert.deepEqual(output.preview, [{ value: '   ' }, { value: '' }, { value: '7' }]);
});

test('CSV accepts semicolon and tab delimiters', async (t) => {
  for (const delimiter of [';', '\t'] as const) {
    const ctx = await csvFixture(t, `name${delimiter}amount\n"a${delimiter}b"${delimiter}+2.5\n`);
    const output = await csvSummaryTool.execute({ ...csvInput, delimiter }, ctx);
    assert.equal(output.columnCount, 2);
    assert.equal(output.preview[0].name, `a${delimiter}b`);
    assert.equal(output.columns[1].numeric?.sum, 2.5);
  }
});

test('CSV supports header-only files with no numeric summary', async (t) => {
  const ctx = await csvFixture(t, ' first ,second\n');
  assert.deepEqual(await csvSummaryTool.execute(csvInput, ctx), {
    rowCount: 0,
    columnCount: 2,
    columns: [
      { name: ' first ', emptyCount: 0, numeric: null },
      { name: 'second', emptyCount: 0, numeric: null },
    ],
    preview: [],
  });
});

test('CSV rejects missing, blank and duplicate headers after trimming', async (t) => {
  for (const text of ['', '\ufeff\r\n\r\n', 'a,\n1,2', 'a, \n1,2', 'a,a\n1,2', 'a, a \n1,2']) {
    const ctx = await csvFixture(t, text);
    await assert.rejects(csvSummaryTool.execute(csvInput, ctx), { code: 'INVALID_INPUT' });
  }
});

test('CSV rejects malformed quoting and inconsistent column counts without leaking cell data', async (t) => {
  for (const text of ['a,b\n1', 'a,b\n1,2,3', 'a\n"PRIVATE_CELL', 'a\nPRIVATE_CELL"oops']) {
    const ctx = await csvFixture(t, text);
    await assert.rejects(csvSummaryTool.execute(csvInput, ctx), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'INVALID_INPUT');
      assert.equal(String(error).includes('PRIVATE_CELL'), false);
      assert.equal(JSON.stringify(error).includes('PRIVATE_CELL'), false);
      return true;
    });
  }
});

test('CSV treats a column as numeric only when all nonempty cells are finite plain decimals', async (t) => {
  const ctx = await csvFixture(t, 'decimal,exponent,currency,percent,date,hex,thousands,empty\n-2,1e3,$1,10%,2026-11-02,0x10,"1,000",\n+.5,2,3,4,5,6,7, \n1.,,,,,,,\n');
  const output = await csvSummaryTool.execute(csvInput, ctx);
  assert.deepEqual(output.columns[0], {
    name: 'decimal', emptyCount: 0,
    numeric: { count: 3, min: -2, max: 1, sum: -0.5, mean: -0.5 / 3 },
  });
  assert.deepEqual(output.columns.slice(1).map((column) => column.numeric), [null, null, null, null, null, null, null]);
  assert.equal(output.columns[7].emptyCount, 3);
});

test('CSV rejects nonfinite decimal values as numeric candidates', async (t) => {
  const ctx = await csvFixture(t, `value\n${'9'.repeat(400)}\n2\n`);
  assert.equal((await csvSummaryTool.execute(csvInput, ctx)).columns[0].numeric, null);
});

test('CSV rejects numeric sum overflow', async (t) => {
  const number = `1${'0'.repeat(308)}`;
  const ctx = await csvFixture(t, `value\n${number}\n${number}\n`);
  await assert.rejects(csvSummaryTool.execute(csvInput, ctx), { code: 'LIMIT_EXCEEDED' });
});

test('CSV caps the preview at five while including all rows in aggregates', async (t) => {
  const ctx = await csvFixture(t, 'n\n1\n2\n3\n4\n5\n6\n7\n');
  const output = await csvSummaryTool.execute(csvInput, ctx);
  assert.equal(output.rowCount, 7);
  assert.deepEqual(output.preview, [{ n: '1' }, { n: '2' }, { n: '3' }, { n: '4' }, { n: '5' }]);
  assert.deepEqual(output.columns[0].numeric, { count: 7, min: 1, max: 7, sum: 28, mean: 4 });
});

test('CSV allows the exact data-row cap and rejects additional rows without a partial result', async (t) => {
  const ctx = await csvFixture(t, 'n\n1\n\n2\n', { csvRows: 2 });
  assert.equal((await csvSummaryTool.execute(csvInput, ctx)).rowCount, 2);
  const over = await csvFixture(t, 'n\n1\n2\n3\n', { csvRows: 2 });
  await assert.rejects(csvSummaryTool.execute(csvInput, over), { code: 'LIMIT_EXCEEDED' });
});

test('CSV enforces byte limits and uses fatal UTF-8 decoding', async (t) => {
  const exact = await csvFixture(t, 'n\n1\n', { fileBytes: 4 });
  assert.equal((await csvSummaryTool.execute(csvInput, exact)).rowCount, 1);
  const over = await csvFixture(t, 'n\n1\n', { fileBytes: 3 });
  await assert.rejects(csvSummaryTool.execute(csvInput, over), { code: 'LIMIT_EXCEEDED' });
  const invalid = await csvFixture(t, new Uint8Array([0x6e, 0x0a, 0xc3, 0x28]));
  await assert.rejects(csvSummaryTool.execute(csvInput, invalid), { code: 'UNSUPPORTED_FORMAT' });
});

test('CSV rejects unsupported extensions before reading the file', async (t) => {
  const { ctx } = await fixture(t);
  for (const filename of ['missing.txt', 'missing.csv.exe']) {
    await assert.rejects(csvSummaryTool.execute({ ...csvInput, path: filename }, ctx), { code: 'UNSUPPORTED_FORMAT' });
  }
});

test('CSV preserves prototype-like headers as ordinary own record properties', async (t) => {
  const ctx = await csvFixture(t, '__proto__,constructor,toString\nvalue,2,3\n');
  const output = await csvSummaryTool.execute(csvInput, ctx);
  assert.deepEqual(Object.keys(output.preview[0]), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.hasOwn(output.preview[0], '__proto__'), true);
  assert.equal(output.preview[0].__proto__, 'value');
  assert.deepEqual(JSON.parse(JSON.stringify(output.preview)), [JSON.parse('{"__proto__":"value","constructor":"2","toString":"3"}')]);
});

test('file planning classifies only first-level files without changing files or directories', async (t) => {
  const { root, ctx } = await fixture(t);
  const inbox = path.join(root, 'inbox');
  await mkdir(path.join(inbox, 'nested'), { recursive: true });
  await writeFile(path.join(inbox, 'nested', 'child.txt'), 'nested');
  const entries = [
    ['report.PDF', '文档'], ['photo.JPG', '图片'], ['sales.CSV', '表格'], ['book.XLSX', '表格'],
    ['song.MP3', '音视频'], ['clip.MP4', '音视频'], ['backup.ZIP', '压缩包'], ['app.TS', '代码'],
    ['README', '其他'], ['unknown.xyz', '其他'],
  ];
  for (const [name] of entries) await writeFile(path.join(inbox, name), '中');
  const before = (await readdir(inbox)).sort();
  const output = await filesPlanTool.execute({ directory: 'inbox' }, ctx);
  assert.equal(output.directory, 'inbox');
  assert.equal(output.scannedFiles, 10);
  assert.equal(output.totalBytes, 30);
  assert.deepEqual(output.groups, [
    { category: '文档', count: 1, totalBytes: 3 },
    { category: '图片', count: 1, totalBytes: 3 },
    { category: '表格', count: 2, totalBytes: 6 },
    { category: '音视频', count: 2, totalBytes: 6 },
    { category: '压缩包', count: 1, totalBytes: 3 },
    { category: '代码', count: 1, totalBytes: 3 },
    { category: '其他', count: 2, totalBytes: 6 },
  ]);
  assert.equal(output.moves.length, 10);
  for (const [name, category] of entries) {
    assert.deepEqual(output.moves.find((move) => move.source === `inbox/${name}`), {
      source: `inbox/${name}`, suggestedDestination: `inbox/${category}/${name}`, category, conflict: false,
    });
    assert.equal(await readFile(path.join(inbox, name), 'utf8'), '中');
  }
  assert.equal(output.skipped.length, 1);
  assert.equal(output.skipped[0].path, 'inbox/nested');
  assert.ok(output.skipped[0].reason);
  assert.deepEqual((await readdir(inbox)).sort(), before);
  assert.equal(await readFile(path.join(inbox, 'nested', 'child.txt'), 'utf8'), 'nested');
});

test('file planning marks existing targets as conflicts and leaves both files intact', async (t) => {
  const { root, ctx } = await fixture(t);
  await mkdir(path.join(root, 'inbox', '文档'), { recursive: true });
  await writeFile(path.join(root, 'inbox', 'report.txt'), 'source');
  await writeFile(path.join(root, 'inbox', '文档', 'report.txt'), 'existing');
  const output = await filesPlanTool.execute({ directory: 'inbox' }, ctx);
  assert.deepEqual(output.moves, [{
    source: 'inbox/report.txt', suggestedDestination: 'inbox/文档/report.txt', category: '文档', conflict: true,
  }]);
  assert.equal(await readFile(path.join(root, 'inbox', 'report.txt'), 'utf8'), 'source');
  assert.equal(await readFile(path.join(root, 'inbox', '文档', 'report.txt'), 'utf8'), 'existing');
});

test('file planning marks both targets that collide after lowercasing', async (t) => {
  const { root, ctx } = await fixture(t);
  await mkdir(path.join(root, 'inbox'));
  await writeFile(path.join(root, 'inbox', 'Report.txt'), 'first');
  try {
    await writeFile(path.join(root, 'inbox', 'report.TXT'), 'second', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      t.skip('filesystem does not support names differing only by case');
      return;
    }
    throw error;
  }
  const output = await filesPlanTool.execute({ directory: 'inbox' }, ctx);
  assert.equal(output.moves.length, 2);
  assert.ok(output.moves.every((move) => move.conflict));
});

test('file planning normalizes relative paths and returns empty lists for an empty directory', async (t) => {
  const { root, ctx } = await fixture(t);
  await mkdir(path.join(root, 'inbox'));
  assert.deepEqual(await filesPlanTool.execute({ directory: './inbox/' }, ctx), {
    directory: 'inbox', scannedFiles: 0, totalBytes: 0, groups: [], moves: [], skipped: [],
  });
  await mkdir(path.join(root, 'inbox', 'nested'));
  await writeFile(path.join(root, 'inbox', 'nested', 'a.txt'), 'a');
  const output = await filesPlanTool.execute({ directory: 'inbox\\nested' }, ctx);
  assert.equal(output.directory, 'inbox/nested');
  assert.equal(output.moves[0].suggestedDestination, 'inbox/nested/文档/a.txt');
});

test('file planning skips symlinks without traversing their targets', async (t) => {
  const { root, ctx } = await fixture(t);
  await mkdir(path.join(root, 'inbox'));
  await mkdir(path.join(root, 'target'));
  await writeFile(path.join(root, 'target', 'secret.txt'), 'secret');
  try {
    await symlink(path.join(root, 'target'), path.join(root, 'inbox', 'link'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('junction permission unavailable');
      return;
    }
    throw error;
  }
  const output = await filesPlanTool.execute({ directory: 'inbox' }, ctx);
  assert.equal(output.scannedFiles, 0);
  assert.deepEqual(output.moves, []);
  assert.equal(output.skipped[0].path, 'inbox/link');
  assert.ok(output.skipped[0].reason);
});

test('file planning honors directory entry limits and the core path boundary', async (t) => {
  const { root, ctx } = await fixture(t, { directoryEntries: 1 });
  await mkdir(path.join(root, 'inbox'));
  await writeFile(path.join(root, 'inbox', 'a.txt'), 'a');
  await writeFile(path.join(root, 'inbox', 'b.txt'), 'b');
  await assert.rejects(filesPlanTool.execute({ directory: 'inbox' }, ctx), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(filesPlanTool.execute({ directory: '../outside' }, ctx), { code: 'ACCESS_DENIED' });
});
