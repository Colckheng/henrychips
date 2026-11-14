import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublicHttp, ToolContext } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { netdiskShareTool } from '../../src/tools/netdisk-share.js';
import { adaptersByPlatform } from '../../src/tools/netdisk/adapters/index.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink } from '../../src/tools/netdisk/types.js';
import { limits } from './helpers.js';

/** The tool must never reach the network in a test, so every call of the client fails loudly. */
const offlineHttp: PublicHttp = {
  getHtml: async () => { throw new Error('测试不应访问网络。'); },
  getJson: async () => { throw new Error('测试不应访问网络。'); },
  getBinary: async () => { throw new Error('测试不应访问网络。'); },
  getRaw: async () => { throw new Error('测试不应访问网络。'); },
  getHead: async () => { throw new Error('测试不应访问网络。'); },
  postForm: async () => { throw new Error('测试不应访问网络。'); },
  postJson: async () => { throw new Error('测试不应访问网络。'); },
  getStream: async () => { throw new Error('测试不应访问网络。'); },
};

function contextOf(stateDirectory: string): ToolContext {
  return {
    signal: new AbortController().signal,
    limits,
    stateDirectory,
    http: offlineHttp,
  };
}

async function stateDirectoryOf(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'netdisk-resolve-'));
}

function fileOf(index: number): NetdiskFile {
  return {
    id: `id-${index}`,
    path: `file-${index}.txt`,
    name: `file-${index}.txt`,
    sizeBytes: 100 * index,
    isDirectory: false,
  };
}

function linkOf(context: AdapterContext, file: NetdiskFile): NetdiskLink {
  return {
    path: file.path,
    name: file.name,
    sizeBytes: file.sizeBytes,
    url: `https://cdn.example.com/${file.id}`,
    headers: { Referer: 'https://pan.quark.cn/' },
    rangeSupported: true,
    source: {
      platform: 'quark',
      shareUrl: context.shareUrl,
      code: context.code,
      filePath: file.path,
      fileId: file.id,
    },
  };
}

/**
 * A stub adapter that stands in for a platform. It replaces the entry of the
 * registry for the duration of the test, so the tool is exercised without a
 * network and without the protocol of a real platform.
 */
function registerStub(adapter: NetdiskAdapter): () => void {
  const previous = adaptersByPlatform.get(adapter.platform);
  adaptersByPlatform.set(adapter.platform, adapter);
  return () => {
    if (previous) adaptersByPlatform.set(adapter.platform, previous);
    else adaptersByPlatform.delete(adapter.platform);
  };
}

test('declares a strict input schema and rejects unknown fields', () => {
  const parsed = netdiskShareTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/abc', unknown: 1 });
  assert.equal(parsed.success, false);
});

test('reports an unsupported platform instead of guessing', async () => {
  await assert.rejects(
    () => netdiskShareTool.invoke({ url: 'https://www.ilanzou.com/s/AbCdEfGh' }, contextOf(process.cwd())),
    /优享版/,
  );
});

test('exposes a documented example', () => {
  assert.ok(netdiskShareTool.examples.length >= 1);
  const url = netdiskShareTool.examples[0].input.url;
  assert.equal(typeof url === 'string' && url.length > 0, true);
});

test('keeps the links of the files that worked when one file fails', async () => {
  const failing = new Set(['file-2.txt', 'file-5.txt', 'file-7.txt']);
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: Array.from({ length: 10 }, (_, index) => fileOf(index)) }),
    link: async (context, file) => {
      if (failing.has(file.path)) throw new ToolError('TOOL_FAILED', '下载地址已失效。');
      return linkOf(context, file);
    },
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory));
    const links = result.links as NetdiskLink[];
    const failures = result.linkFailures as Array<{ path: string; reason: string }>;
    assert.equal(links.length, 7);
    assert.equal(failures.length, 3);
    assert.deepEqual(failures.map(failure => failure.path).sort(), ['file-2.txt', 'file-5.txt', 'file-7.txt']);
    assert.equal(result.fileCount, 10);
    assert.equal(result.credentialUsed, false);
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('lists the files without asking for a link in list mode', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [fileOf(1), fileOf(2)] }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke(
      { url: 'https://pan.quark.cn/s/abc123', mode: 'list' },
      contextOf(stateDirectory),
    );
    assert.equal((result.links as NetdiskLink[]).length, 0);
    assert.equal((result.linkFailures as unknown[]).length, 0);
    assert.equal(result.fileCount, 2);
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('takes the links of the named paths only and reports a path that is not in the share', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [fileOf(1), fileOf(2), fileOf(3)] }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke(
      { url: 'https://pan.quark.cn/s/abc123', paths: ['file-2.txt', 'missing.txt'] },
      contextOf(stateDirectory),
    );
    const links = result.links as NetdiskLink[];
    assert.equal(links.length, 1);
    assert.equal(links[0].path, 'file-2.txt');
    assert.ok((result.warnings as string[]).some(warning => warning.includes('missing.txt')));
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('names a path of a folder instead of asking the platform for a link of it', async () => {
  const folder: NetdiskFile = {
    id: 'folder-1', path: 'tools/', name: 'tools', sizeBytes: null, isDirectory: true,
  };
  let asked = 0;
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [folder, fileOf(1)] }),
    link: async (context, file) => { asked++; return linkOf(context, file); },
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke(
      { url: 'https://pan.quark.cn/s/abc123', paths: ['tools/'] },
      contextOf(stateDirectory),
    );
    assert.equal(asked, 0);
    assert.equal((result.links as NetdiskLink[]).length, 0);
    assert.equal((result.linkFailures as unknown[]).length, 0);
    const warnings = result.warnings as string[];
    assert.ok(warnings.some(warning => warning.includes('tools/') && warning.includes('目录')));
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('refuses the request instead of dropping the files that are over the limit', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: Array.from({ length: 12 }, (_, index) => fileOf(index)) }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    await assert.rejects(
      () => netdiskShareTool.invoke(
        { url: 'https://pan.quark.cn/s/abc123', maxLinks: 10 },
        contextOf(stateDirectory),
      ),
      { code: 'LIMIT_EXCEEDED' },
    );
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('takes a token out of the reason of a failure', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [fileOf(1)] }),
    link: async () => {
      throw new ToolError('TOOL_FAILED', '平台拒绝了这个请求：BDUSS=aVeryLongCredentialValue0123456789');
    },
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory));
    const failures = result.linkFailures as Array<{ path: string; reason: string }>;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.includes('aVeryLongCredentialValue0123456789'), false);
    // The words that say what went wrong stay.
    assert.ok(failures[0].reason.includes('平台拒绝了这个请求'));
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('rejects a link that does not fit the contract of the adapters', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [fileOf(1)] }),
    link: async (context, file) => ({ ...linkOf(context, file), extra: 'field' }) as unknown as NetdiskLink,
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    await assert.rejects(
      () => netdiskShareTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory)),
      { code: 'TOOL_FAILED' },
    );
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('ends the run when it is cancelled instead of failing the file', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '测试分享', files: [fileOf(1)] }),
    link: async () => { throw new ToolError('CANCELLED', '本次执行已取消。'); },
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    await assert.rejects(
      () => netdiskShareTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory)),
      { code: 'CANCELLED' },
    );
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('states a total of zero for an empty share', async () => {
  const restore = registerStub({
    platform: 'quark',
    label: '夸克网盘',
    requiresCredential: false,
    list: async () => ({ title: '空分享', files: [] }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    const result = await netdiskShareTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory));
    assert.equal(result.totalBytes, 0);
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('refuses a platform that needs a credential that is not configured', async () => {
  const restore = registerStub({
    platform: 'baidu',
    label: '百度网盘',
    requiresCredential: true,
    list: async () => ({ title: '测试分享', files: [fileOf(1)] }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  try {
    await assert.rejects(
      () => netdiskShareTool.invoke({ url: 'https://pan.baidu.com/s/1AbCdEfGh' }, contextOf(stateDirectory)),
      /凭证/,
    );
  } finally {
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test('keeps the credential out of the output and only reports that one was used', async () => {
  const restore = registerStub({
    platform: 'baidu',
    label: '百度网盘',
    requiresCredential: true,
    list: async () => ({ title: '测试分享', files: [fileOf(1)] }),
    link: async (context, file) => linkOf(context, file),
  });
  const stateDirectory = await stateDirectoryOf();
  const previous = process.env.HENRY_NETDISK_BAIDU_BDUSS;
  process.env.HENRY_NETDISK_BAIDU_BDUSS = 'secret-bduss-value';
  try {
    const result = await netdiskShareTool.invoke({ url: 'https://pan.baidu.com/s/1AbCdEfGh' }, contextOf(stateDirectory));
    assert.equal(result.credentialUsed, true);
    assert.equal(JSON.stringify(result).includes('secret-bduss-value'), false);
  } finally {
    if (previous === undefined) delete process.env.HENRY_NETDISK_BAIDU_BDUSS;
    else process.env.HENRY_NETDISK_BAIDU_BDUSS = previous;
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

import { safeOutputPath } from '../../src/tools/netdisk/paths.js';

test('rejects an unknown field in the input', () => {
  assert.equal(netdiskShareTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', oops: 1 }).success, false);
});

test('the paths are optional, because a share can be listed without them', () => {
  assert.equal(netdiskShareTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a' }).success, true);
  // An unknown field is still refused.
  assert.equal(netdiskShareTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', oops: 1 }).success, false);
});

test('exposes a documented example', () => {
  assert.ok(netdiskShareTool.examples.length >= 1);
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
  const result = await netdiskShareTool.execute(
    { url: 'https://wwx.lanzoui.com/abc', paths: ['a.bin'], download: true, backend: 'ndm' } as never,
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
