import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { FormField } from '../../src/web/components/FormField.js';
import { CsvResult } from '../../src/web/components/CsvResult.js';
import { NetdiskResult, buildNetdiskTree, childrenOf, curlCommand, directFilePaths, downloadableFiles, pickedPaths, searchNetdiskFiles } from '../../src/web/components/NetdiskResult.js';
import { ResultPanel } from '../../src/web/components/ResultPanel.js';
import { GenericResult } from '../../src/web/components/ResultData.js';

const meta = { runId: 'actual-run', tool: 'csv_summary', source: 'web' as const, startedAt: '2026-11-02T00:00:00Z', durationMs: 15, warnings: ['服务端警告原文'] };

test('a required boolean accepts false instead of requiring a checked checkbox', () => {
  const html = renderToStaticMarkup(createElement(FormField, {
    field: { name: 'enabled', label: '启用功能', type: 'checkbox' },
    required: true, value: false, onChange: () => undefined,
  }));
  const { document } = parseHTML(html);
  const input = document.querySelector('input');
  assert.ok(input);
  assert.equal(input.hasAttribute('required'), false);
  assert.equal(input.hasAttribute('checked'), false);
  assert.equal(document.querySelector('label')?.getAttribute('for'), input.id);
});

test('CSV preview uses actual nested numeric statistics and preserves raw values', () => {
  const html = renderToStaticMarkup(createElement(CsvResult, { data: {
    rowCount: 3, columnCount: 1,
    columns: [{ name: 'amount', emptyCount: 1, numeric: { count: 2, min: 7.5, max: 12.5, sum: 20, mean: 10 } }],
    preview: [{ amount: '12.5' }, { amount: '7.5' }, { amount: '' }],
  } }));
  const { document } = parseHTML(html);
  const cells = [...document.querySelectorAll('table[aria-label="数值摘要"] tbody td')].map(cell => cell.textContent);
  assert.deepEqual(cells, ['amount', '2', '1', '7.5', '12.5', '20', '10']);
  const preview = [...document.querySelectorAll('table[aria-label="数据预览"] tbody td')].map(cell => cell.textContent);
  assert.deepEqual(preview, ['12.5', '7.5', '']);
  const fields = [...document.querySelectorAll('table[aria-label="字段信息"] tbody td')].map(cell => cell.textContent);
  assert.deepEqual(fields, ['amount', '1', '2']);
});

test('failure rendering preserves server warnings, error code and validation details', () => {
  const html = renderToStaticMarkup(createElement(ResultPanel, {
    tool: 'csv_summary', status: 'done', retry: () => undefined,
    result: { ok: false, meta, error: { code: 'FILE_NOT_FOUND', message: '文件未找到', details: [{ path: 'path', message: '请检查路径' }] } },
  }));
  const { document } = parseHTML(html);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /FILE_NOT_FOUND/);
  assert.match(document.textContent ?? html, /服务端警告原文/);
  assert.match(html, /请检查路径/);
});

test('external extracted text is rendered as text without executable markup', () => {
  const html = renderToStaticMarkup(createElement(GenericResult, { data: { text: '<script>alert(1)</script>', untrustedContent: true } }));
  const { document } = parseHTML(html);
  assert.equal(document.querySelector('script'), null);
  assert.equal(document.querySelector('pre')?.textContent, '<script>alert(1)</script>');
});

test('media streams are rendered as a table instead of a raw JSON blob', () => {
  const html = renderToStaticMarkup(createElement(ResultPanel, {
    tool: 'bilibili_video', status: 'done', retry: () => undefined,
    result: {
      ok: true,
      meta: { ...meta, tool: 'bilibili_video' },
      data: {
        bvid: 'BV1ugxq6HEfH', title: '示例', durationSeconds: 126, owner: '作者', cover: '', pageCount: 1,
        streams: [{ kind: 'video', label: 'MP4 清晰度 64', codecs: 'avc1', url: 'https://cdn/video.mp4', sizeBytes: 5492083 }],
        savedFile: null, warnings: [],
      },
    },
  }));
  const { document } = parseHTML(html);
  const rows = [...document.querySelectorAll('table[aria-label="媒体流列表"] tbody td')].map(cell => cell.textContent);
  assert.deepEqual(rows, ['视频', 'MP4 清晰度 64', 'avc1', '5,492,083', 'https://cdn/video.mp4']);
  assert.equal(document.body.textContent?.includes('"kind":"video"'), false);
});

test('the netdisk result lists the files and the links with their actions', () => {
  const html = renderToStaticMarkup(createElement(ResultPanel, {
    tool: 'netdisk_share', status: 'done', retry: () => undefined,
    result: {
      ok: true,
      meta: { ...meta, tool: 'netdisk_share' },
      data: {
        platform: 'quark', platformLabel: '夸克网盘', shareId: 'abc123', title: '示例分享',
        fileCount: 2, totalBytes: 1024,
        files: [
          { id: '1', path: 'a.bin', name: 'a.bin', sizeBytes: 1024, isDirectory: false },
          { id: '2', path: 'folder', name: 'folder', sizeBytes: null, isDirectory: true },
        ],
        links: [{ path: 'a.bin', name: 'a.bin', sizeBytes: 1024, url: 'https://cdn/a.bin', headers: { Referer: 'https://pan.quark.cn/' }, rangeSupported: true }],
        linkFailures: [{ path: 'b.bin', reason: '取链超时' }],
        credentialUsed: false, warnings: ['直链通常在十几分钟内过期，请尽快下载。'],
      },
    },
  }));
  const { document } = parseHTML(html);
  const files = [...document.querySelectorAll('table[aria-label="分享文件列表"] tbody tr')].map(row => row.textContent);
  assert.equal(files.length, 2);
  assert.match(files[0] ?? '', /a\.bin/);
  const links = [...document.querySelectorAll('table[aria-label="下载直链列表"] tbody td')].map(cell => cell.textContent);
  assert.equal(links[0], 'a.bin');
  assert.equal(links[2], 'https://cdn/a.bin');
  assert.equal(links[3], '支持续传');
  const failures = [...document.querySelectorAll('table[aria-label="取链失败列表"] tbody td')].map(cell => cell.textContent);
  assert.deepEqual(failures, ['b.bin', '取链超时']);
  // The warning of the run is shown by the panel, so it is not repeated here.
  const notices = [...document.querySelectorAll('.notice-warning li')].map(item => item.textContent);
  assert.deepEqual(notices, ['服务端警告原文', '直链通常在十几分钟内过期，请尽快下载。']);
});

test('the copy curl command carries the headers the download needs', () => {
  const command = curlCommand({
    path: 'a.bin', name: 'a.bin', sizeBytes: 10,
    url: 'https://cdn/a.bin',
    headers: { Referer: 'https://pan.quark.cn/', Cookie: 'k=v', 'User-Agent': 'Mozilla/5.0' },
    rangeSupported: true,
  });
  assert.equal(command, 'curl -L -H "Referer: https://pan.quark.cn/" -H "Cookie: k=v" -H "User-Agent: Mozilla/5.0" -o "a.bin" "https://cdn/a.bin"');
});

test('a value with a double quote in the curl command is escaped', () => {
  const command = curlCommand({
    path: 'a.bin', name: 'say "hi".bin', sizeBytes: 10,
    url: 'https://cdn/a.bin?x="1"',
    headers: { Cookie: 'k="v"' },
    rangeSupported: true,
  });
  assert.equal(command, 'curl -L -H "Cookie: k=\\"v\\"" -o "say \\"hi\\".bin" "https://cdn/a.bin?x=\\"1\\""');
});

test('the netdisk result shows no credential of the account', () => {
  const html = renderToStaticMarkup(createElement(NetdiskResult, {
    data: {
      platform: 'quark', platformLabel: '夸克网盘', shareId: 'abc123', title: '示例分享',
      fileCount: 0, totalBytes: 0, files: [], links: [], linkFailures: [],
      credentialUsed: true, warnings: [],
    },
  }));
  assert.equal(html.includes('credentialUsed'), false);
  assert.equal(html.includes('使用了登录态'), false);
});

test('a folder is not offered for download', () => {
  const files = [
    { path: 'a.bin', name: 'a.bin', sizeBytes: 10, isDirectory: false },
    { path: 'folder/', name: 'folder', sizeBytes: null, isDirectory: true },
  ];
  const downloadable = downloadableFiles(files);
  assert.equal(downloadable.length, 1);
  assert.equal(downloadable[0]?.path, 'a.bin');
});

test('nothing is picked before the user chooses', () => {
  // A share may hold thousands of files, so picking all of them by accident
  // would start a download nobody asked for.
  assert.deepEqual(pickedPaths(null), []);
  // Once the user chooses, only the chosen ones are downloaded.
  assert.deepEqual(pickedPaths(['b.bin']), ['b.bin']);
  assert.deepEqual(pickedPaths([]), []);
});

test('the picker offers the files of the share', () => {
  const html = renderToStaticMarkup(createElement(NetdiskResult, {
    data: {
      platform: 'lanzou', platformLabel: '蓝奏云', shareId: 'abc', title: '示例',
      fileCount: 2, totalBytes: 30,
      files: [
        { path: 'a.bin', name: 'a.bin', sizeBytes: 10, isDirectory: false },
        { path: 'b.bin', name: 'b.bin', sizeBytes: 20, isDirectory: false },
      ],
      links: [], linkFailures: [], credentialUsed: false, warnings: [],
    },
    onDownload: () => {},
  }));
  // Both files are offered, and the count says how many of them are picked.
  assert.match(html, /选择要下载的文件/);
  assert.match(html, /a\.bin/);
  assert.match(html, /b\.bin/);
  // Nothing is picked before the user chooses, so the button waits for them.
  assert.match(html, /已选 0 \/ 2/);
  assert.match(html, /下载选中的 0 个文件/);
});

test('no picker is shown when the share holds no file', () => {
  const html = renderToStaticMarkup(createElement(NetdiskResult, {
    data: {
      platform: 'lanzou', platformLabel: '蓝奏云', shareId: 'abc', title: '示例',
      fileCount: 1, totalBytes: 0,
      files: [{ path: 'folder/', name: 'folder', sizeBytes: null, isDirectory: true }],
      links: [], linkFailures: [], credentialUsed: false, warnings: [],
    },
    onDownload: () => {},
  }));
  // A folder has no file of its own, so there is nothing to pick.
  assert.equal(html.includes('选择要下载的文件'), false);
});

test('only a page of the files in one folder is drawn, so a big share does not freeze the page', () => {
  const files = Array.from({ length: 600 }, (_, index) => ({
    path: `dir/file-${index}.bin`, name: `file-${index}.bin`, sizeBytes: 100, isDirectory: false,
  }));
  const data = {
    platform: 'quark', platformLabel: '夸克网盘', shareId: 'abc', title: '示例',
    fileCount: files.length, totalBytes: 60000,
    files, links: [], linkFailures: [], credentialUsed: false, warnings: [],
  };
  // The root only holds the folder, so nothing to tick is drawn there.
  const rootHtml = renderToStaticMarkup(createElement(NetdiskResult, { data, onDownload: () => {} }));
  assert.equal((rootHtml.match(/type="checkbox"/g) ?? []).length, 0);
  assert.match(rootHtml, /进入文件夹 dir/);
  // Inside the folder the first page is drawn, and the count still tells
  // how many files the share holds in total.
  const html = renderToStaticMarkup(createElement(NetdiskResult, { data, initialPath: 'dir/', onDownload: () => {} }));
  const { document } = parseHTML(html);
  assert.match(html, /已选 0 \/ 600/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 200);
  // The rest is found with the search box.
  assert.match(html, /还有 400 个文件没有显示/);
  assert.match(html, /按文件名或路径查找/);
  assert.match(document.querySelector('.netdisk-picker-breadcrumb')?.textContent ?? '', /根目录/);
});

test('the picker builds a folder tree out of the flat list the backend returns', () => {
  const tree = buildNetdiskTree([
    { path: 'b.bin', name: 'b.bin', sizeBytes: 20, isDirectory: false },
    { path: 'sub/', name: 'sub', sizeBytes: null, isDirectory: true },
    { path: 'sub/a.bin', name: 'a.bin', sizeBytes: 10, isDirectory: false },
    { path: 'sub/deep/c.bin', name: 'c.bin', sizeBytes: 30, isDirectory: false },
    { path: 'loose/d.bin', name: 'd.bin', sizeBytes: 40, isDirectory: false },
  ]);
  // Folders come first, then files, in the order the platform listed them.
  assert.deepEqual(tree.map(node => node.path), ['sub/', 'loose/', 'b.bin']);
  // A folder the platform did not list still becomes a parent of its files.
  const loose = tree.find(node => node.path === 'loose/');
  assert.equal(loose?.children.length, 1);
  const sub = tree.find(node => node.path === 'sub/');
  assert.deepEqual(sub?.children.map(node => node.path), ['sub/deep/', 'sub/a.bin']);
  assert.equal(sub?.fileCount, 2);
  assert.equal(tree.find(node => node.path === 'b.bin')?.fileCount, 1);
  // Only the files that sit directly in a folder belong to that layer.
  assert.deepEqual(directFilePaths(childrenOf(tree, 'sub/')), ['sub/a.bin']);
  assert.deepEqual(directFilePaths(childrenOf(tree, '')), ['b.bin']);
  assert.deepEqual(childrenOf(tree, 'sub/deep/').map(node => node.path), ['sub/deep/c.bin']);
  assert.deepEqual(childrenOf(tree, 'missing/'), []);
});

test('search looks across every folder of the share', () => {
  const files = [
    { path: 'a.bin', name: 'a.bin', sizeBytes: 10, isDirectory: false },
    { path: 'sub/a.bin', name: 'a.bin', sizeBytes: 20, isDirectory: false },
    { path: 'sub/b.txt', name: 'b.txt', sizeBytes: 30, isDirectory: false },
  ];
  assert.deepEqual(searchNetdiskFiles(files, 'sub').map(file => file.path), ['sub/a.bin', 'sub/b.txt']);
  assert.deepEqual(searchNetdiskFiles(files, 'A.BIN').map(file => file.path), ['a.bin', 'sub/a.bin']);
  assert.deepEqual(searchNetdiskFiles(files, '  ').map(file => file.path), ['a.bin', 'sub/a.bin', 'sub/b.txt']);
});

test('the picker opens a folder and the breadcrumb walks back up', () => {
  const data = {
    platform: 'baidu', platformLabel: '百度网盘', shareId: 'abc', title: '示例',
    fileCount: 2, totalBytes: 30,
    files: [
      { path: 'pack/', name: 'pack', sizeBytes: null, isDirectory: true },
      { path: 'pack/part01.rar', name: 'part01.rar', sizeBytes: 10, isDirectory: false },
      { path: 'pack/part02.rar', name: 'part02.rar', sizeBytes: 20, isDirectory: false },
    ],
    links: [], linkFailures: [], credentialUsed: false, warnings: [],
  };
  const rootHtml = renderToStaticMarkup(createElement(NetdiskResult, { data, onDownload: () => {} }));
  const root = parseHTML(rootHtml).document;
  assert.match(root.querySelector('.netdisk-picker-breadcrumb')?.textContent ?? '', /根目录/);
  assert.equal(root.querySelector('.netdisk-picker-breadcrumb button')?.hasAttribute('disabled'), true);
  assert.equal(root.querySelector('.netdisk-picker-up'), null);
  assert.match(rootHtml, /pack/);
  // The picker at the root only shows the folder; the files inside it wait
  // until the folder is opened. (The flat "分享文件" table above still lists
  // every file, so this is scoped to the picker list.)
  assert.equal(root.querySelector('.netdisk-picker')?.textContent?.includes('part01.rar'), false);
  const html = renderToStaticMarkup(createElement(NetdiskResult, { data, initialPath: 'pack/', onDownload: () => {} }));
  const { document } = parseHTML(html);
  assert.match(document.querySelector('.netdisk-picker-breadcrumb')?.textContent ?? '', /根目录/);
  assert.match(document.querySelector('.netdisk-picker-breadcrumb')?.textContent ?? '', /pack/);
  assert.match(html, /返回上一级/);
  assert.match(html, /part01\.rar/);
  assert.match(html, /part02\.rar/);
  assert.match(html, /全选本层/);
});

test('a pick made in one folder stays picked in another folder', () => {
  const data = {
    platform: 'baidu', platformLabel: '百度网盘', shareId: 'abc', title: '示例',
    fileCount: 2, totalBytes: 30,
    files: [
      { path: 'pack/', name: 'pack', sizeBytes: null, isDirectory: true },
      { path: 'pack/part01.rar', name: 'part01.rar', sizeBytes: 10, isDirectory: false },
      { path: 'top.bin', name: 'top.bin', sizeBytes: 20, isDirectory: false },
    ],
    links: [], linkFailures: [], credentialUsed: false, warnings: [],
  };
  // Back at the root the pick is still counted, even though its file is
  // one folder down and not drawn here.
  const rootHtml = renderToStaticMarkup(createElement(NetdiskResult, {
    data, initialSelected: ['pack/part01.rar'], onDownload: () => {},
  }));
  assert.match(rootHtml, /已选 1 \/ 2/);
  assert.match(rootHtml, /下载选中的 1 个文件/);
  // Inside the folder the same file shows its box as checked.
  const html = renderToStaticMarkup(createElement(NetdiskResult, {
    data, initialPath: 'pack/', initialSelected: ['pack/part01.rar'], onDownload: () => {},
  }));
  const { document } = parseHTML(html);
  const boxes = [...document.querySelectorAll('.netdisk-picker input[type="checkbox"]')];
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0]?.hasAttribute('checked'), true);
});
