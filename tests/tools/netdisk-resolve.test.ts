import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PublicHttp, ToolContext } from '../../src/contracts/tool.js';
import { ToolError } from '../../src/core/errors.js';
import { netdiskResolveTool } from '../../src/tools/netdisk-resolve.js';
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
  const parsed = netdiskResolveTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/abc', unknown: 1 });
  assert.equal(parsed.success, false);
});

test('reports an unsupported platform instead of guessing', async () => {
  await assert.rejects(
    () => netdiskResolveTool.invoke({ url: 'https://www.ilanzou.com/s/AbCdEfGh' }, contextOf(process.cwd())),
    /优享版/,
  );
});

test('exposes a documented example', () => {
  assert.ok(netdiskResolveTool.examples.length >= 1);
  const url = netdiskResolveTool.examples[0].input.url;
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
    const result = await netdiskResolveTool.invoke({ url: 'https://pan.quark.cn/s/abc123' }, contextOf(stateDirectory));
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
    const result = await netdiskResolveTool.invoke(
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
    const result = await netdiskResolveTool.invoke(
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
      () => netdiskResolveTool.invoke({ url: 'https://pan.baidu.com/s/1AbCdEfGh' }, contextOf(stateDirectory)),
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
    const result = await netdiskResolveTool.invoke({ url: 'https://pan.baidu.com/s/1AbCdEfGh' }, contextOf(stateDirectory));
    assert.equal(result.credentialUsed, true);
    assert.equal(JSON.stringify(result).includes('secret-bduss-value'), false);
  } finally {
    if (previous === undefined) delete process.env.HENRY_NETDISK_BAIDU_BDUSS;
    else process.env.HENRY_NETDISK_BAIDU_BDUSS = previous;
    restore();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
