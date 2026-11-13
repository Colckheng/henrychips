import test from 'node:test';
import assert from 'node:assert/strict';
import { netdiskDownloadTool } from '../../src/tools/netdisk-download.js';
import { safeOutputPath } from '../../src/tools/netdisk/paths.js';
import type { ToolContext } from '../../src/contracts/tool.js';

test('rejects an unknown field in the input', () => {
  assert.equal(netdiskDownloadTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', oops: 1 }).success, false);
});

test('requires at least one path to download', () => {
  assert.equal(netdiskDownloadTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', paths: [] }).success, false);
});

test('exposes a documented example', () => {
  assert.ok(netdiskDownloadTool.examples.length >= 1);
});

test('turns the path of a file into a name that is safe in the output directory', () => {
  assert.equal(safeOutputPath('a/b.txt', 'b.txt'), 'b.txt');
  // A name of a platform may carry characters that a file name cannot hold.
  assert.equal(safeOutputPath('iXXXX?sign=abc', 'iXXXX?sign=abc'), 'iXXXX_sign=abc');
  assert.equal(safeOutputPath('', ''), 'download');
});

test('hands the link to the local downloader instead of creating a task', async t => {
  const sent: Array<{ url: string; fileName: string; headers?: Record<string, string> }> = [];
  const created: string[] = [];
  const context = {
    ndm: { send: async (target: { url: string; fileName: string; headers?: Record<string, string> }) => { sent.push(target); } },
    downloads: { create: () => { created.push('created'); return { id: 'task-1' }; } },
    http: {},
    limits: {},
    stateDirectory: '',
    signal: new AbortController().signal,
  } as unknown as ToolContext;
  // The tool needs an adapter of the platform, so the Lanzou one is used with
  // a fake transport that answers with a share of one file.
  const { lanzouAdapter } = await import('../../src/tools/netdisk/adapters/lanzou.js');
  const original = lanzouAdapter.list;
  lanzouAdapter.list = async () => ({ title: '分享', files: [{ id: '1', path: 'a.bin', name: 'a.bin', sizeBytes: 5, isDirectory: false }] });
  const originalLink = lanzouAdapter.link;
  lanzouAdapter.link = async () => ({
    path: 'a.bin', name: 'a.bin', sizeBytes: 5, url: 'https://cdn.example.com/a.bin',
    headers: { Cookie: 'down_ip=1' }, rangeSupported: true,
    source: { platform: 'lanzou' as const, shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
  });
  t.after(() => { lanzouAdapter.list = original; lanzouAdapter.link = originalLink; });
  const result = await netdiskDownloadTool.execute(
    { url: 'https://wwx.lanzoui.com/abc', paths: ['a.bin'], backend: 'ndm' } as never,
    context,
  );
  assert.equal(result.backend, 'ndm');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://cdn.example.com/a.bin');
  assert.equal(sent[0].fileName, 'a.bin');
  assert.equal(sent[0].headers?.Cookie, 'down_ip=1');
  // The protocol of the downloader hands out no task, so the manager is not
  // asked for one.
  assert.deepEqual(created, []);
});
