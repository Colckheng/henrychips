import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { FormField } from '../../src/web/components/FormField.js';
import { CsvResult } from '../../src/web/components/CsvResult.js';
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
