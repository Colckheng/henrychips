import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { FormField } from '../../src/web/components/FormField.js';
import { CsvResult } from '../../src/web/components/CsvResult.js';
import { NetdiskResult, curlCommand, downloadableFiles, pickedPaths } from '../../src/web/components/NetdiskResult.js';
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

test('only a page of the files is drawn, so a big share does not freeze the page', () => {
  const files = Array.from({ length: 600 }, (_, index) => ({
    path: `dir/file-${index}.bin`, name: `file-${index}.bin`, sizeBytes: 100, isDirectory: false,
  }));
  const html = renderToStaticMarkup(createElement(NetdiskResult, {
    data: {
      platform: 'quark', platformLabel: '夸克网盘', shareId: 'abc', title: '示例',
      fileCount: files.length, totalBytes: 60000,
      files, links: [], linkFailures: [], credentialUsed: false, warnings: [],
    },
    onDownload: () => {},
  }));
  // The count tells how many files the share holds, even though only a page
  // of them is drawn.
  assert.match(html, /已选 0 \/ 600/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 200);
  // The rest is found with the search box.
  assert.match(html, /还有 400 个文件没有显示/);
  assert.match(html, /按文件名或路径查找/);
});
