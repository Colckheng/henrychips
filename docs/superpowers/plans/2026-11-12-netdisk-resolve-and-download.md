# 网盘分享解析与下载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在个人工作站里加入网盘分享链接解析与下载能力：9 家网盘的分享链接可解析出文件列表与已验证的下载直链，直链可交给内置的分片下载任务系统落盘，也可推给本机 Neat Download Manager 接管。

**Architecture:** 适配器只负责平台私有协议（怎么换 token、怎么列目录、怎么取直链），全部止步于 `src/tools/netdisk/adapters/`；下载内核只吃 `NetdiskLink`（URL + 必需请求头 + 取链参数），不认识任何平台。下载任务脱离工具运行模型，由独立的 `DownloadManager` 调度，不占 `ToolExecutor` 的 4 个并发槽位，也不受 120 秒工具超时约束。

**Tech Stack:** TypeScript 5.9（ESM，`"type": "module"`）、Node 22+（`node:test`、`node:fs/promises`、`globalThis.WebSocket`）、undici 7（公网 HTTP 客户端与流式 GET）、zod 4（工具契约校验）、React 19 + Vite 7（网页工作台）、Fastify 5（本地 HTTP API）。

**Spec:** `docs/superpowers/specs/2026-11-12-netdisk-resolve-and-download-design.md`

## Global Constraints

以下约束来自 spec，全文所有任务默认适用，不再逐条重复：

- 工具名必须匹配 `^[a-z][a-z0-9_]*$`（`src/core/registry.ts:9`）。
- 工具输入输出必须用 `z.strictObject` 严格校验，拒绝未知字段。
- 工具错误只能通过 `ToolError`（`src/core/errors.ts`）抛出，错误码取自 `ErrorCode` 联合类型（`src/contracts/run.ts`）。
- 所有公网请求必须走 `src/core/public-http.ts` 的 `createPublicHttp`，不得另起 `fetch`；该模块自带 DNS pinning、重定向复验、私网拦截、端口白名单、响应体上限、取消传播。
- 请求头一律经 `safeRequestHeaders` 过滤（`src/core/public-http.ts:89`）；`host` / `content-length` / `connection` / `transfer-encoding` 永不允许；含 CR/LF 的值一律丢弃。
- 响应必须是 `identity` 编码；非 identity 一律 `UNSUPPORTED_FORMAT`（与 NDM 行为一致）。
- 输出路径只允许输出目录内的相对路径；拒绝绝对路径、`..`、设备名与 Windows 保留名；写入前用 `realpath` 复验目录边界；拒绝符号链接目标。
- 账号级凭证（百度 BDUSS、123 Bearer JWT、迅雷 accessToken）不得出现在任何工具输出、运行摘要、日志或错误信息中；只有 `credentialUsed: boolean` 可以外露。
- 网盘直链的 `headers` 必须随 `NetdiskLink` 一起交付，因为它们是直链可用的前提。
- 每个新工具必须注册进 `src/tools/index.ts` 的 `createRegistry()`。
- 每个新能力必须加入 `src/contracts/tool.ts` 的 `Capability` 联合类型，并在 `src/core/executor.ts:135-138` 按能力注入上下文对象。
- 注释只写"为什么"，不写"做了什么"；禁止多段文档字符串。
- 测试用 `node:test`，断言用 `node:assert/strict`；跑测试统一用 `npm test`。
- 提交信息用中文祈使句，格式 `feat: ...` / `fix: ...` / `docs: ...` / `test: ...`。
- 平台私有接口随时可能变更：解析失败时返回明确错误，禁止返回猜测数据。
- 本轮**不做**：BT / 磁力 / HLS / ed2k 下载；网盘账号注册与图形化登录；「转存到我的网盘」作为独立功能；下载后回传网盘等组合工作流；动态分段（按速度重划段边界，spec §6.3 标注为可选增强）。
- 动态分段本轮不实现，分段边界固定；断点续传不受影响。

---

## File Structure

**新建**

| 路径 | 职责 |
| --- | --- |
| `src/tools/netdisk/types.ts` | 平台无关类型：`NetdiskPlatform`、`NetdiskFile`、`NetdiskLink`、`NetdiskSource`、`NetdiskAdapter`、`AdapterContext` |
| `src/tools/netdisk/share-link.ts` | 分享文案 → `{ platform, shareId, code }`；各平台域名族与提取码正则 |
| `src/tools/netdisk/session.ts` | `NetdiskSession`：POST/GET 封装、按 host 隔离的 cookie jar、限速退避 |
| `src/tools/netdisk/credentials.ts` | 凭证文件读写、环境变量优先、`0600` 权限 |
| `src/tools/netdisk/adapters/index.ts` | 适配器注册表 `adaptersByPlatform` |
| `src/tools/netdisk/adapters/lanzou.ts` | 蓝奏云适配器（首个，定义适配器写法） |
| `src/tools/netdisk/adapters/guangya.ts` | 光鸭云盘适配器 |
| `src/tools/netdisk/adapters/quark.ts` | 夸克适配器 |
| `src/tools/netdisk/adapters/uc.ts` | UC 适配器 |
| `src/tools/netdisk/adapters/pan115.ts` | 115 适配器 |
| `src/tools/netdisk/adapters/c139.ts` | 139（和彩云）适配器 |
| `src/tools/netdisk/adapters/pan123.ts` | 123 云盘适配器（需凭证） |
| `src/tools/netdisk/adapters/xunlei.ts` | 迅雷适配器（取直链需凭证） |
| `src/tools/netdisk/adapters/baidu.ts` | 百度适配器（需凭证，有转存副作用） |
| `src/tools/netdisk-resolve.ts` | `netdisk_resolve` 工具定义 |
| `src/tools/netdisk-download.ts` | `netdisk_download` 工具定义 |
| `src/core/download/segment-table.ts` | 分段表的序列化、持久化与恢复 |
| `src/core/download/segmenter.ts` | 分片下载内核：Range 请求、预分配写入、动态分段 |
| `src/core/download/task-store.ts` | 下载任务的持久化（索引 + 每任务目录） |
| `src/core/download/manager.ts` | `DownloadManager`：任务状态机、调度队列、暂停 / 继续 / 删除 |
| `src/core/ndm/client.ts` | `NdmClient`：连本机 NDM 的 WebSocket，推送下载链接 |
| `src/web/components/NetdiskResult.tsx` | 网盘解析结果面板：文件表 + 直链表 + 复制 curl |
| `src/web/pages/Downloads.tsx` | 下载任务页面 |
| `tests/tools/netdisk-share-link.test.ts` | 分享链接识别测试 |
| `tests/tools/netdisk-session.test.ts` | 会话与 cookie 隔离测试 |
| `tests/tools/netdisk-credentials.test.ts` | 凭证读写测试 |
| `tests/tools/netdisk-resolve.test.ts` | 解析工具契约测试 |
| `tests/tools/netdisk-download.test.ts` | 下载工具契约测试 |
| `tests/core/download-segmenter.test.ts` | 分片内核测试 |
| `tests/core/download-manager.test.ts` | 下载任务管理测试 |
| `tests/core/ndm-client.test.ts` | NDM 协议消息拼装测试 |

**修改**

| 路径 | 改动 |
| --- | --- |
| `src/contracts/tool.ts` | `PublicHttp` 加 `postForm` / `postJson` / `getStream`；`FileWriter` 加 `open`；新增 `FileHandle`；`Capability` 加 `downloader:local` |
| `src/core/public-http.ts` | 实现 POST 与流式 GET；白名单扩容到 17 项；超时可配 |
| `src/core/file-access.ts` | `createFileWriter` 实现 `open` / `writeAt` / 预分配 |
| `src/core/executor.ts` | 按 `downloader:local` 能力注入 `NdmClient` |
| `src/core/runtime.ts` | 组装 `DownloadManager` 与 `NdmClient` |
| `src/adapters/http/routes.ts` | 新增 `/api/downloads` 系列端点 |
| `src/adapters/cli/main.ts` | 新增 `credentials` 子命令 |
| `src/tools/index.ts` | 注册两个新工具 |
| `src/web/router.ts` | 新增 `#/downloads` 路由 |
| `src/web/App.tsx` | 挂载下载任务页面 |
| `src/web/api.ts` | 下载任务 API 客户端 |
| `src/web/components/Shell.tsx` | 顶栏加下载任务指示 |
| `src/web/components/ResultPanel.tsx` | 注册 `NetdiskResult` |
| `src/web/presentation.ts` | 新字段中文标签 |
| `docs/superpowers/plans/2026-11-02-personal-workstation-plan.md` | 活文档回填 |

---

## Task 1: 公网客户端扩展（POST / 流式 GET / 白名单）

**Files:**
- Modify: `src/contracts/tool.ts:45-63`（`PublicHttp` 接口）
- Modify: `src/core/public-http.ts`
- Test: `tests/core/public-http.test.ts`

**Interfaces:**
- Consumes: 现有 `createPublicHttp(maxBytes)`、`safeRequestHeaders`、`validatePublicUrl`。
- Produces:
  ```ts
  export interface PublicHttpRequest {
    headers?: Record<string, string>;
    maxBytes?: number;
    allowedPorts?: number[];
    /** 流式读取时「多久没有数据算超时」的容忍毫秒数。默认 10000。 */
    timeoutMs?: number;
  }
  export interface PublicHttp {
    getHtml(url, signal, options?): Promise<{ finalUrl: string; html: string; status: number }>;
    getJson(url, signal, options?): Promise<{ finalUrl: string; data: unknown; status: number }>;
    getBinary(url, signal, options?): Promise<{ finalUrl: string; bytes: Uint8Array; contentType: string; status: number }>;
    getRaw(url, signal, options?): Promise<PublicHttpResponse>;
    /** 新增：表单 POST */
    postForm(url, fields: Record<string, string>, signal, options?): Promise<{ finalUrl: string; data: unknown; status: number }>;
    /** 新增：JSON POST */
    postJson(url, body: unknown, signal, options?): Promise<{ finalUrl: string; data: unknown; status: number }>;
    /** 新增：流式 GET，body 由调用方消费 */
    getStream(url, signal, options?): Promise<{ finalUrl: string; status: number; contentType: string; contentLength: number | null; body: NodeJS.ReadableStream }>;
  }
  // PublicHttpResponse 补一个响应头字典（读 Content-Range / Accept-Ranges 要用）
  export interface PublicHttpResponse {
    finalUrl: string;
    status: number;
    contentType: string;
    bytes: Uint8Array;
    setCookie: string[];
    headers: Record<string, string>;
  }
  ```

- [ ] **Step 1: 写失败测试**

追加到 `tests/core/public-http.test.ts` 末尾：

```ts
test('posts form bodies and returns parsed json', async t => {
  const { connected } = await transport(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ received: body, method: request.method }));
    });
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.postForm('https://example.com/api', { action: 'downprocess', sign: 'abc' }, new AbortController().signal);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { received: 'action=downprocess&sign=abc', method: 'POST' });
  assert.equal(connected.length, 1);
});

test('keeps the range header that a segmented download needs', async t => {
  const seen: string[] = [];
  await transport(t, (request, response) => {
    seen.push(request.headers.range ?? '');
    response.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/100' });
    response.end('abcd');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('https://example.com/file.bin', new AbortController().signal, { headers: { Range: 'bytes=0-3' } });
  result.body.resume();
  assert.equal(seen[0], 'bytes=0-3');
});

test('streams a response body instead of buffering it', async t => {
  await transport(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '6' });
    response.end('abcdef');
  });
  const http = createPublicHttp(2_097_152);
  const result = await http.getStream('https://example.com/file.bin', new AbortController().signal);
  assert.equal(result.contentLength, 6);
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/core/public-http.test.ts`
Expected: FAIL，提示 `postForm is not a function` / `getStream is not a function`。

- [ ] **Step 3: 扩展接口与白名单**

改 `src/contracts/tool.ts` 的 `PublicHttpRequest`，加 `timeoutMs?: number;`；在 `PublicHttp` 接口末尾加 `postForm`、`postJson`、`getStream` 三个方法声明。

改 `src/core/public-http.ts`：

```ts
const allowedHeaders = new Set([
  'user-agent', 'referer', 'origin', 'accept', 'accept-language', 'cookie', 'content-type',
  'range', 'authorization', 'x-requested-with', 'x-api-version', 'x-device-id',
  'x-client-type', 'x-app-version', 'x-os-version', 'x-source', 'x-source-version',
]);
```

（把原来的 `allowedHeaders` 整行替换掉，共 17 项。）

- [ ] **Step 4: 实现 POST 与流式 GET**

在 `src/core/public-http.ts` 的 `createPublicHttp` 内部，把 `fetchPublic` 改造成接受 `method` 与 `body`：

```ts
type Kind = 'html' | 'json' | 'binary';
type FetchOptions = PublicHttpRequest & { method?: 'GET' | 'POST'; body?: string; contentType?: string };

async function fetchPublic(value: string, signal: AbortSignal, kind: Kind, options?: FetchOptions) {
  const limit = options?.maxBytes ?? maxBytes;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  checkAbort(signal);
  let url = validatePublicUrl(value, options?.allowedPorts ?? []);
  for (let redirects = 0; ; redirects++) {
    checkAbort(signal);
    const host = hostname(url);
    const addresses = await resolveAddresses(host, signal);
    const agent = new Agent({ connect: { lookup: pinnedLookup(host, addresses), timeout: 10_000 } });
    let handedOff = false;
    try {
      const response = await request(url, {
        dispatcher: agent, method: options?.method ?? 'GET', signal,
        headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
        headers: {
          accept: kind === 'html' ? 'text/html, application/xhtml+xml' : kind === 'json' ? 'application/json' : '*/*',
          'accept-encoding': 'identity',
          ...(options?.contentType ? { 'content-type': options.contentType } : {}),
          ...safeRequestHeaders(options?.headers),
        },
        ...(options?.body !== undefined ? { body: options.body } : {}),
      });
      const { statusCode, headers, body } = response;
      body.on('error', () => {});
      try {
        checkAbort(signal);
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          if (redirects >= 3) throw new ToolError('NETWORK_ERROR', '网页重定向次数超过上限。');
          const location = headers.location;
          if (typeof location !== 'string') throw new ToolError('NETWORK_ERROR', '网页重定向缺少有效目标。');
          let target: URL;
          try { target = new URL(location, url); }
          catch { throw new ToolError('NETWORK_ERROR', '网页重定向目标无效。'); }
          url = validatePublicUrl(target.href, options?.allowedPorts ?? []);
          continue;
        }
        if (statusCode < 200 || statusCode >= 300) throw new ToolError('NETWORK_ERROR', '网页服务器未返回成功响应。');
        const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
        const mime = contentType.split(';')[0].trim().toLowerCase();
        if (kind === 'html' && !['text/html', 'application/xhtml+xml'].includes(mime)) {
          throw new ToolError('UNSUPPORTED_FORMAT', '该地址未返回 HTML 网页。');
        }
        if (kind === 'json' && mime !== 'application/json' && !mime.endsWith('+json')) {
          throw new ToolError('UNSUPPORTED_FORMAT', '该地址未返回 JSON 数据。');
        }
        const encoding = headers['content-encoding'];
        if (encoding && encoding !== 'identity') throw new ToolError('UNSUPPORTED_FORMAT', '网页未按请求返回未压缩的内容。');
        const declared = headers['content-length'];
        if (declared !== undefined && Number(declared) > limit) throw new ToolError('LIMIT_EXCEEDED', '网页超过读取大小限制。');
        if (kind === 'stream') {
          const contentLength = declared === undefined ? null : Number(declared);
          // The caller owns the stream now, so the agent must stay alive until it ends.
          body.once('close', () => { void agent.destroy(); });
          handedOff = true;
          return { finalUrl: url.href, status: statusCode, contentType, contentLength, body };
        }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of body) {
          checkAbort(signal);
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > limit) throw new ToolError('LIMIT_EXCEEDED', '网页超过读取大小限制。');
          chunks.push(bytes);
        }
        checkAbort(signal);
        const buffer = Buffer.concat(chunks, total);
        const setCookie = typeof headers['set-cookie'] === 'string' ? [headers['set-cookie']] : Array.isArray(headers['set-cookie']) ? headers['set-cookie'].map(String) : [] as string[];
        if (kind === 'html') {
          const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
          let decoder: TextDecoder;
          try { decoder = new TextDecoder(charset); }
          catch { throw new ToolError('UNSUPPORTED_FORMAT', '网页使用了不支持的字符编码。'); }
          return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie, text: decoder.decode(buffer) };
        }
        if (kind === 'json') {
          try { return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie, data: JSON.parse(buffer.toString('utf8')) as unknown }; }
          catch { throw new ToolError('UNSUPPORTED_FORMAT', '该地址返回的内容不是有效 JSON。'); }
        }
        return { finalUrl: url.href, status: statusCode, contentType, bytes: buffer, setCookie };
      } finally {
        if (!handedOff) {
          if (!body.destroyed) body.destroy();
          await agent.destroy();
        }
      }
    } catch (error) {
      if (!handedOff) await agent.destroy();
      throw error;
    }
  }
}
```

把原来的 `type Kind = 'html' | 'json' | 'binary';` 改成 `type Kind = 'html' | 'json' | 'binary' | 'stream';`。

在返回对象上补三个方法：

```ts
    async postForm(url, fields, signal, options) {
      try {
        const body = new URLSearchParams(fields).toString();
        const result = await fetchPublic(url, signal, 'json', { ...options, method: 'POST', body, contentType: 'application/x-www-form-urlencoded' });
        return { finalUrl: result.finalUrl, data: result.data, status: result.status };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法提交表单请求，请检查地址或稍后重试。');
      }
    },
    async postJson(url, body, signal, options) {
      try {
        const result = await fetchPublic(url, signal, 'json', {
          ...options, method: 'POST', body: JSON.stringify(body), contentType: 'application/json',
        });
        return { finalUrl: result.finalUrl, data: result.data, status: result.status };
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法提交接口请求，请检查地址或稍后重试。');
      }
    },
    async getStream(url, signal, options) {
      try {
        return await fetchPublic(url, signal, 'stream', options);
      } catch (error) {
        checkAbort(signal);
        if (error instanceof ToolError) throw error;
        throw new ToolError('NETWORK_ERROR', '无法读取远程资源，请检查地址或稍后重试。');
      }
    },
```

同时给 `PublicHttpResponse` 补上响应头字典（`getRaw` 需要它来读 `Content-Range` / `Accept-Ranges`）：

在 `src/contracts/tool.ts` 的 `PublicHttpResponse` 里加 `headers: Record<string, string>;`，并在 `src/core/public-http.ts` 的 `getRaw` 与 `fetchPublic` 的 binary 分支返回 `headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]))`。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/core/public-http.test.ts`
Expected: PASS，全部用例通过（含原有的 SSRF 用例）。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add src/contracts/tool.ts src/core/public-http.ts tests/core/public-http.test.ts
git commit -m "feat: 公网客户端支持表单与 JSON 提交，并新增流式读取"
```

---

## Task 2: 流式写入器（预分配 + 按偏移写入）

**Files:**
- Modify: `src/contracts/tool.ts:64-67`（`FileWriter`）
- Modify: `src/core/file-access.ts:109-150`（`createFileWriter`）
- Test: `tests/core/file-stream.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `createFileWriter(root, signal, maxBytes)`。
- Produces:
  ```ts
  export interface FileHandle {
    readonly relativePath: string;
    /** 在文件的指定偏移写入，返回写入的字节数。 */
    writeAt(buffer: Uint8Array, position: number): Promise<number>;
    /** 已写入字节数。 */
    bytesWritten(): number;
    /** 预分配到指定长度，不写内容。 */
    truncate(length: number): Promise<void>;
    close(): Promise<void>;
  }
  export interface FileWriter {
    write(relativePath, bytes, options?): Promise<{ relativePath: string; bytes: number }>;
    /** 新增 */
    open(relativePath: string, options?: { overwrite?: boolean; truncateTo?: number }): Promise<FileHandle>;
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/core/file-stream.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileWriter } from '../../src/core/file-access.js';

test('writes bytes at an offset into a preallocated file', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const handle = await writer.open('segments.bin', { truncateTo: 10 });
  await handle.writeAt(new TextEncoder().encode('ABCDE'), 0);
  await handle.writeAt(new TextEncoder().encode('FGHIJ'), 5);
  await handle.close();
  assert.equal(await readFile(path.join(directory, 'segments.bin'), 'utf8'), 'ABCDEFGHIJ');
});

test('refuses to open a path outside the output directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(() => writer.open('../escape.bin'), /输出路径/);
  await assert.rejects(() => writer.open('/absolute.bin'), /输出路径/);
});

test('refuses to open an existing file unless overwrite is set', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-stream-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'exists.bin'), 'old');
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  await assert.rejects(() => writer.open('exists.bin'), /已存在/);
  const handle = await writer.open('exists.bin', { overwrite: true });
  await handle.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/core/file-stream.test.ts`
Expected: FAIL，`writer.open is not a function`。

- [ ] **Step 3: 扩展接口**

在 `src/contracts/tool.ts` 的 `FileWriter` 之后加入：

```ts
export interface FileHandle {
  readonly relativePath: string;
  writeAt(buffer: Uint8Array, position: number): Promise<number>;
  bytesWritten(): number;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}
```

并把 `FileWriter` 改成：

```ts
export interface FileWriter {
  write(relativePath: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<{ relativePath: string; bytes: number }>;
  open(relativePath: string, options?: { overwrite?: boolean; truncateTo?: number }): Promise<FileHandle>;
}
```

- [ ] **Step 4: 实现 open**

在 `src/core/file-access.ts` 的 `createFileWriter` 返回对象里加 `open`。先用 `open` 打开文件句柄（`fs/promises` 的 `open`），再实现 `writeAt`：

```ts
    async open(relativePath, options) {
      const { absolute, relativePath: safePath } = target(relativePath);
      const directory = path.dirname(absolute);
      await mkdir(directory, { recursive: true });
      const realDirectory = await realpath(directory).catch(() => { throw new ToolError('ACCESS_DENIED', '输出目录不可用。'); });
      const realRelative = path.relative(root, realDirectory);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new ToolError('ACCESS_DENIED', '输出路径必须位于输出目录内。');
      const existing = await lstat(absolute).catch(() => null);
      if (existing?.isSymbolicLink()) throw new ToolError('ACCESS_DENIED', '输出目标不能是符号链接或联接点。');
      if (existing && !options?.overwrite) throw new ToolError('ACCESS_DENIED', '输出目录中已存在同名文件，请更换名称或勾选覆盖。');
      let handle;
      try {
        // 已有文件用 r+ 保留内容（断点续传要靠它），不存在才用 w+ 新建。
        handle = await fsOpen(absolute, existing ? 'r+' : 'w+', 0o600);
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') throw new ToolError('ACCESS_DENIED', '输出目录中已存在同名文件，请更换名称或勾选覆盖。');
        return fileError(error);
      }
      let written = 0;
      let closed = false;
      return {
        relativePath: safePath,
        async writeAt(buffer, position) {
          if (closed) throw new ToolError('ACCESS_DENIED', '文件句柄已关闭。');
          if (!Number.isSafeInteger(position) || position < 0) throw new ToolError('INVALID_INPUT', '写入位置无效。');
          const { bytesWritten } = await handle.write(buffer, 0, buffer.byteLength, position);
          written += bytesWritten;
          if (written > maxBytes) throw new ToolError('LIMIT_EXCEEDED', '输出文件超过写入大小限制。');
          return bytesWritten;
        },
        bytesWritten() { return written; },
        async truncate(length) {
          if (closed) throw new ToolError('ACCESS_DENIED', '文件句柄已关闭。');
          if (!Number.isSafeInteger(length) || length < 0) throw new ToolError('INVALID_INPUT', '预分配长度无效。');
          if (length > maxBytes) throw new ToolError('LIMIT_EXCEEDED', '输出文件超过写入大小限制。');
          await handle.truncate(length);
        },
        async close() {
          if (closed) return;
          closed = true;
          await handle.close();
        },
      };
    },
```

在 `src/core/file-access.ts` 顶部把 `open` 加入 `node:fs/promises` 的导入（注意与局部变量名 `open` 冲突，改名为 `fsOpen`）：

```ts
import { lstat, mkdir, open as fsOpen, realpath, writeFile } from 'node:fs/promises';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/core/file-stream.test.ts`
Expected: PASS。

- [ ] **Step 6: 跑全量测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部通过。`tests/tools/media.test.ts` 里构造 `PublicHttp` 与 `ToolContext` 的假对象需要补上新增方法（见下一步）。

- [ ] **Step 7: 补齐测试里的假对象**

`tests/tools/media.test.ts` 的 `fakeHttp` 补上：

```ts
    postForm: async () => ({ finalUrl: 'https://example.com/', data: {}, status: 200 }),
    postJson: async () => ({ finalUrl: 'https://example.com/', data: {}, status: 200 }),
    getStream: async () => ({ finalUrl: 'https://example.com/', status: 200, contentType: 'application/octet-stream', contentLength: 0, body: Readable.from([]) }),
```

并在文件顶部加 `import { Readable } from 'node:stream';`。同样检查 `tests/` 下其他构造 `PublicHttp` 假对象的地方并补齐。

- [ ] **Step 8: 提交**

```bash
git add src/contracts/tool.ts src/core/file-access.ts tests/core/file-stream.test.ts tests/tools/media.test.ts
git commit -m "feat: 输出写入器支持按偏移写入与预分配，为分片下载铺路"
```

---

## Task 3: 分享链接识别

**Files:**
- Create: `src/tools/netdisk/types.ts`
- Create: `src/tools/netdisk/share-link.ts`
- Test: `tests/tools/netdisk-share-link.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/tools/netdisk/types.ts
  export type NetdiskPlatform =
    | 'lanzou' | 'guangya' | 'quark' | 'uc' | 'pan115'
    | 'c139' | 'pan123' | 'xunlei' | 'baidu';

  export interface ParsedShare {
    platform: NetdiskPlatform;
    shareId: string;
    code: string | null;
    /** 完整分享链接，供适配器使用 */
    shareUrl: string;
  }

  // src/tools/netdisk/share-link.ts
  export function parseShareLink(text: string): ParsedShare | null;
  export function isLanzouHost(host: string): boolean;
  export const NETDISK_PLATFORM_LABELS: Record<NetdiskPlatform, string>;
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/tools/netdisk-share-link.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanzouHost, parseShareLink } from '../../src/tools/netdisk/share-link.js';

test('recognises each supported platform from a bare link', () => {
  const cases: Array<[string, string]> = [
    ['https://pan.quark.cn/s/2aB3cD4e5f', 'quark'],
    ['https://drive.uc.cn/s/2aB3cD4e5f', 'uc'],
    ['https://pan.xunlei.com/s/2aB3cD4e5f', 'xunlei'],
    ['https://pan.baidu.com/s/1AbCdEfGh', 'baidu'],
    ['https://yun.139.com/shareweb/#/w/i/AbCdEfGh', 'c139'],
    ['https://www.123pan.com/s/2785Vv-T4Ded', 'pan123'],
    ['https://www.123pan.cn/api/srr?sk=2785Vv-T4Ded&st=s', 'pan123'],
    ['https://115.com/s/swA1b2c3d4e', 'pan115'],
    ['https://115.com/sws8lxs36jf-n307/', 'pan115'],
    ['https://www.guangyapan.com/s/AbCdEfGh', 'guangya'],
    ['https://wwx.lanzoui.com/iXnuF4c8sqmb', 'lanzou'],
    ['https://user.lanzn.com/iXnuF4c8sqmb', 'lanzou'],
  ];
  for (const [url, platform] of cases) {
    const parsed = parseShareLink(url);
    assert.ok(parsed, url);
    assert.equal(parsed.platform, platform, url);
  }
});

test('extracts the passcode from the query and from the share text', () => {
  const fromQuery = parseShareLink('https://pan.quark.cn/s/2aB3cD4e5f?pwd=abcd');
  assert.equal(fromQuery?.code, 'abcd');
  const fromText = parseShareLink('【分享】https://pan.quark.cn/s/2aB3cD4e5f，提取码：wxyz');
  assert.equal(fromText?.code, 'wxyz');
  const fromPass = parseShareLink('https://lanzoui.com/iXnuF4c8sqmb?pass=QQQQ');
  assert.equal(fromPass?.code, 'QQQQ');
});

test('splits the baidu surl into its short form', () => {
  const parsed = parseShareLink('https://pan.baidu.com/s/1AbCdEfGh');
  assert.equal(parsed?.platform, 'baidu');
  assert.equal(parsed?.shareId, 'AbCdEfGh');
});

test('reads the 115 command form with an inline passcode', () => {
  const parsed = parseShareLink('https://115.com/sws8lxs36jf-n307/');
  assert.equal(parsed?.platform, 'pan115');
  assert.equal(parsed?.shareId, 'sws8lxs36jf');
  assert.equal(parsed?.code, 'n307');
});

test('separates the ilanzou host from the lanzou host family', () => {
  assert.equal(parseShareLink('https://www.ilanzou.com/s/AbCdEfGh')?.platform, 'ilanzou' as never);
  assert.equal(isLanzouHost('www.lanzoui.com'), true);
  assert.equal(isLanzouHost('www.ilanzou.com'), false);
});

test('returns null for text without a supported share link', () => {
  assert.equal(parseShareLink('今天天气不错'), null);
  assert.equal(parseShareLink('https://example.com/file.zip'), null);
});
```

**注意**：实现里 `ilanzou` 不是受支持的平台（官方无分享接口），但必须被识别出来好给出明确提示。把它作为独立的 `NetdiskPlatform` 成员加入类型，工具层据此返回"该平台暂不支持解析"。把上面测试里的 `'ilanzou' as never` 改为 `'ilanzou'`，并在类型里加上 `'ilanzou'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-share-link.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现类型**

`src/tools/netdisk/types.ts`：

```ts
export type NetdiskPlatform =
  | 'lanzou' | 'ilanzou' | 'guangya' | 'quark' | 'uc' | 'pan115'
  | 'c139' | 'pan123' | 'xunlei' | 'baidu';

export interface ParsedShare {
  platform: NetdiskPlatform;
  shareId: string;
  code: string | null;
  shareUrl: string;
}
```

- [ ] **Step 4: 实现识别**

`src/tools/netdisk/share-link.ts`：

```ts
import type { NetdiskPlatform, ParsedShare } from './types.js';

export const NETDISK_PLATFORM_LABELS: Record<NetdiskPlatform, string> = {
  lanzou: '蓝奏云', ilanzou: '蓝奏云优享版', guangya: '光鸭云盘', quark: '夸克网盘',
  uc: 'UC 网盘', pan115: '115 网盘', c139: '139（和彩云）', pan123: '123 云盘',
  xunlei: '迅雷网盘', baidu: '百度网盘',
};

/** 蓝奏云域名族：lanzou* / lan[zs]o[ux] / lanzn，后缀 com/net/org/cn。 */
const lanzouHostRegex = /^(?:[a-z0-9-]+\.)*(?:lanzou[a-z]?|lan[zs]o[ux]|lanzn)\.(?:com|net|org|cn)$/;

export function isLanzouHost(host: string): boolean {
  return lanzouHostRegex.test(host.toLowerCase());
}

interface Rule { platform: NetdiskPlatform; pattern: RegExp; codeFromUrl?: RegExp }

const rules: Rule[] = [
  { platform: 'quark', pattern: /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/i },
  { platform: 'uc', pattern: /drive\.uc\.cn\/s\/([A-Za-z0-9]+)/i },
  { platform: 'xunlei', pattern: /pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/i },
  { platform: 'baidu', pattern: /pan\.baidu\.com\/s\/(1[A-Za-z0-9_-]+)/i },
  { platform: 'c139', pattern: /yun\.139\.com\/shareweb\/.*?\/w\/i\/([A-Za-z0-9_-]+)/i },
  { platform: 'pan123', pattern: /123(?:865|pan)\.(?:com|cn)\/s\/([A-Za-z0-9]+-[A-Za-z0-9]+)/i },
  { platform: 'pan123', pattern: /share\.123pan\.cn\/123pan\/([A-Za-z0-9-]+)/i },
  { platform: 'pan123', pattern: /api\/srr\?sk=([A-Za-z0-9-]+)/i },
  { platform: 'pan115', pattern: /115(?:cdn|rc)?\.com\/s\/(sw[A-Za-z0-9]+)/i },
  { platform: 'guangya', pattern: /guangyapan\.com\/s\/([A-Za-z0-9_-]+)/i },
  { platform: 'ilanzou', pattern: /(?:^|[/.])ilanzou\.(?:com|net|org|cn)\/s\/([A-Za-z0-9_-]+)/i },
];

const lanzouPattern = /(?:^|[/.])(?:lanzou[a-z0-9-]*|lan[zs]o[ux]|lanzn)\.(?:com|net|org|cn)\/([A-Za-z0-9]+)/i;
const urlRegex = /https?:\/\/[^\s]+/;
const codeInUrl = /[?&]pwd=([A-Za-z0-9]+)/i;
const codeInUrlWide = /[?&](?:pwd|pass|passcode|password)=([A-Za-z0-9]+)/i;
const codeInText = /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/;
const pan115Command = /115(?:cdn|rc)?\.com\/(sw[A-Za-z0-9]{8,})-([A-Za-z0-9]{4,8})/i;
const pan115Password = /[?&]password=([A-Za-z0-9]+)/i;

export function parseShareLink(text: string): ParsedShare | null {
  const trimmed = text.trim();
  const raw = urlRegex.exec(trimmed)?.[0]?.replace(/[^\x21-\x7e]+$/, '');
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); }
  catch { return null; }
  const codeFromText = codeInText.exec(trimmed)?.[1] ?? null;

  const command = pan115Command.exec(raw);
  if (command) {
    return { platform: 'pan115', shareId: command[1], code: command[2], shareUrl: raw };
  }

  for (const rule of rules) {
    const matched = rule.pattern.exec(raw);
    if (!matched) continue;
    const code = (rule.codeFromUrl ?? codeInUrl).exec(raw)?.[1]
      ?? codeInUrlWide.exec(raw)?.[1]
      ?? codeFromText;
    const shareId = rule.platform === 'baidu' ? matched[1].replace(/^1/, '') : matched[1];
    return { platform: rule.platform, shareId, code: code ?? null, shareUrl: raw };
  }

  const lanzou = lanzouPattern.exec(raw);
  if (lanzou) {
    const code = codeInUrlWide.exec(raw)?.[1] ?? codeFromText;
    return { platform: 'lanzou', shareId: lanzou[1], code: code ?? null, shareUrl: raw };
  }
  return null;
}
```

**注意**：`rules` 数组里优享版的规则必须排在蓝奏云之前（蓝奏云规则单独放在 `lanzouPattern` 里，且优享版域名 `ilanzou.com` 不匹配 `lanzou[a-z0-9-]*` 之外的模式——实际上 `ilanzou` 会被 `lanzou[a-z0-9-]*` 匹配到 `ilanzou` 吗？`(?:lanzou[a-z0-9-]*)` 要求以 `lanzou` 开头，`ilanzou` 不满足，所以不会误判。但 `ilanzou` 域名族本身要显式匹配到 `ilanzou` 前缀。上面 `ilanzou` 规则的正则用了显式的 `ilanzou\.(?:com|net|org|cn)`，正确。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-share-link.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/tools/netdisk/types.ts src/tools/netdisk/share-link.ts tests/tools/netdisk-share-link.test.ts
git commit -m "feat: 新增网盘分享链接识别，覆盖 10 类平台与四种提取码来源"
```

---

## Task 4: 会话层（按 host 隔离的 Cookie 与退避）

**Files:**
- Create: `src/tools/netdisk/session.ts`
- Test: `tests/tools/netdisk-session.test.ts`

**Interfaces:**
- Consumes: `PublicHttp`（Task 1）、`ToolError`。
- Produces:
  ```ts
  // src/tools/netdisk/session.ts
  export interface NetdiskSessionOptions {
    http: PublicHttp;
    signal: AbortSignal;
    /** 同一 host 的最小请求间隔毫秒数。默认 250。 */
    minIntervalMs?: number;
  }
  export class NetdiskSession {
    constructor(options: NetdiskSessionOptions);
    get(url: string, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }>;
    postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }>;
    postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ finalUrl: string; data: unknown; status: number }>;
    /** 当前 host 的 Cookie 串，用于下游请求。 */
    cookieHeader(url: string): string;
    /** 手动写入一个 Cookie（用于人机校验结果）。 */
    setCookie(url: string, name: string, value: string): void;
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/tools/netdisk-session.test.ts`。

**注意：下面的测试片段是初版，已被 Task 4 的三轮评审修订取代，照抄会得到错误的行为。** 最终形态以仓库里的 `tests/tools/netdisk-session.test.ts` 为准（评审确定的行为是：调用方传入的 `Cookie` / `authorization` 头一律剥离，凭证只能经 `setCookie` / `setAuthorization` 进入本域 jar；`probe` 返回 `finalUrl`；`raw` 有 64 KiB 默认上限；另有 `head` 方法用于只取响应头与整链 `Set-Cookie`）。初版片段仅保留作对照：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublicHttp } from '../../src/contracts/tool.js';

function fakeHttp(seen: Array<{ url: string; headers?: Record<string, string> }>): PublicHttp {
  return {
    getHtml: async () => ({ finalUrl: '', html: '', status: 200 }),
    getJson: async () => ({ finalUrl: '', data: {}, status: 200 }),
    getBinary: async () => ({ finalUrl: '', bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async () => ({ finalUrl: '', status: 200, contentType: '', bytes: new Uint8Array(), setCookie: [] }),
    postForm: async (url, fields, _signal, options) => { seen.push({ url, headers: options?.headers }); return { finalUrl: url, data: { fields }, status: 200 }; },
    postJson: async (url, body, _signal, options) => { seen.push({ url, headers: options?.headers }); return { finalUrl: url, data: { body }, status: 200 }; },
    getStream: async (url) => ({ finalUrl: url, status: 200, contentType: '', contentLength: 0, body: (await import('node:stream')).Readable.from([]) }),
  };
}

test('never sends a cookie to a different host', async () => {
  const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
  const session = new NetdiskSession({ http: fakeHttp(seen), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'quark_session', 'secret');
  await session.postJson('https://pan.quark.cn/api/1', {}, { Cookie: session.cookieHeader('https://pan.quark.cn/s/abc') });
  await session.postJson('https://115.com/api/1', {}, { Cookie: session.cookieHeader('https://115.com/s/abc') });
  assert.equal(seen[0].headers?.Cookie, 'quark_session=secret');
  assert.equal(seen[1].headers?.Cookie, undefined);
});

test('keeps cookies of the same host together and replaces duplicates', () => {
  const session = new NetdiskSession({ http: fakeHttp([]), signal: new AbortController().signal });
  session.setCookie('https://pan.quark.cn/s/abc', 'a', '1');
  session.setCookie('https://pan.quark.cn/s/other', 'a', '2');
  session.setCookie('https://pan.quark.cn/s/abc', 'b', '3');
  assert.equal(session.cookieHeader('https://pan.quark.cn/s/abc'), 'a=2; b=3');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-session.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`src/tools/netdisk/session.ts`：

```ts
import { setTimeout as delay } from 'node:timers/promises';
import type { PublicHttp } from '../../contracts/tool.js';
import { ToolError } from '../../core/errors.js';

export interface NetdiskSessionOptions {
  http: PublicHttp;
  signal: AbortSignal;
  minIntervalMs?: number;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

export class NetdiskSession {
  private readonly cookies = new Map<string, Map<string, string>>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(private readonly options: NetdiskSessionOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 250;
  }

  setCookie(url: string, name: string, value: string): void {
    const host = hostOf(url);
    if (!host) return;
    const jar = this.cookies.get(host) ?? new Map<string, string>();
    jar.set(name, value);
    this.cookies.set(host, jar);
  }

  cookieHeader(url: string): string {
    const jar = this.cookies.get(hostOf(url));
    if (!jar || !jar.size) return '';
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private async waitForSlot(url: string): Promise<void> {
    const host = hostOf(url);
    const previous = this.lastRequestAt.get(host);
    if (previous !== undefined) {
      const elapsed = Date.now() - previous;
      if (elapsed < this.minIntervalMs) await delay(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt.set(host, Date.now());
  }

  private mergeCookieHeader(url: string, headers?: Record<string, string>): Record<string, string> | undefined {
    const jar = this.cookies.get(hostOf(url));
    const fromJar = jar && jar.size
      ? [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      : '';
    if (!fromJar && !headers?.Cookie) return headers;
    return { ...headers, Cookie: headers?.Cookie ?? fromJar };
  }

  async get(url: string, headers?: Record<string, string>) {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    try {
      return await this.options.http.getJson(url, this.options.signal, { headers: this.mergeCookieHeader(url, headers) });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }

  async postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>) {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    try {
      return await this.options.http.postForm(url, fields, this.options.signal, { headers: this.mergeCookieHeader(url, headers) });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }

  async postJson(url: string, body: unknown, headers?: Record<string, string>) {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    try {
      return await this.options.http.postJson(url, body, this.options.signal, { headers: this.mergeCookieHeader(url, headers) });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }

  async getHtml(url: string, headers?: Record<string, string>) {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    try {
      return await this.options.http.getHtml(url, this.options.signal, { headers: this.mergeCookieHeader(url, headers) });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }

  /** 发一个 Range: bytes=0-0 的探测请求，只读响应头，用来判断直链是否支持断点续传。 */
  async probe(url: string, headers?: Record<string, string>): Promise<{ status: number; location?: string; contentRange?: string; acceptRanges?: string }> {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    const response = await this.options.http.getRaw(url, this.options.signal, {
      headers: { Range: 'bytes=0-0', ...this.mergeCookieHeader(url, headers) },
      maxBytes: 1024,
    });
    return {
      status: response.status,
      location: response.headers.location,
      contentRange: response.headers['content-range'],
      acceptRanges: response.headers['accept-ranges'],
    };
  }
}
```

**注意**：`probe` 依赖 Task 1 里给 `PublicHttpResponse` 补的 `headers` 字段；`getHtml` 依赖 `PublicHttp.getHtml` 接受 `options` 参数——Task 1 的 `getHtml` 签名是 `(url, signal)`，**必须**改成 `(url, signal, options?)` 并把 `options` 透传给 `fetchPublic`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-session.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/tools/netdisk/session.ts tests/tools/netdisk-session.test.ts
git commit -m "feat: 新增网盘会话层，Cookie 按 host 隔离并带请求间隔"
```

---

## Task 5: 凭证存储与 CLI 子命令

**Files:**
- Create: `src/tools/netdisk/credentials.ts`
- Modify: `src/adapters/cli/main.ts`
- Test: `tests/tools/netdisk-credentials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/tools/netdisk/credentials.ts
  export interface PlatformCredential {
    bduss?: string;
    username?: string;
    password?: string;
  }
  export type CredentialStore = Record<string, PlatformCredential>;
  export function credentialFilePath(stateDirectory: string): string;
  export function readCredentials(stateDirectory: string): CredentialStore;
  export function writeCredentials(stateDirectory: string, store: CredentialStore): void;
  export function resolveCredential(platform: NetdiskPlatform, stateDirectory: string): PlatformCredential | null;
  export function listCredentialPlatforms(stateDirectory: string): string[];
  export function clearCredential(stateDirectory: string, platform: string): boolean;
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/tools/netdisk-credentials.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearCredential, credentialFilePath, listCredentialPlatforms, readCredentials, resolveCredential, writeCredentials } from '../../src/tools/netdisk/credentials.js';

test('stores credentials in the state directory, not in the config', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'token' } });
  assert.equal(credentialFilePath(directory), path.join(directory, 'netdisk-credentials.json'));
  assert.deepEqual(readCredentials(directory), { baidu: { bduss: 'token' } });
});

test('returns null when the platform has no credential', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(resolveCredential('baidu', directory), null);
});

test('lets an environment variable win over the stored credential', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'from-file' } });
  process.env.HENRY_NETDISK_BAIDU_BDUSS = 'from-env';
  t.after(() => { delete process.env.HENRY_NETDISK_BAIDU_BDUSS; });
  assert.equal(resolveCredential('baidu', directory)?.bduss, 'from-env');
});

test('clears one platform without touching the others', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeCredentials(directory, { baidu: { bduss: 'a' }, xunlei: { username: 'u', password: 'p' } });
  assert.equal(clearCredential(directory, 'baidu'), true);
  assert.deepEqual(listCredentialPlatforms(directory), ['xunlei']);
});

test('reads a corrupted file as an empty store instead of crashing', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(credentialFilePath(directory), 'not json', 'utf8');
  assert.deepEqual(readCredentials(directory), {});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-credentials.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

`src/tools/netdisk/credentials.ts`：

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetdiskPlatform } from './types.js';

export interface PlatformCredential {
  bduss?: string;
  username?: string;
  password?: string;
}

export type CredentialStore = Record<string, PlatformCredential>;

const envKeys: Record<string, keyof PlatformCredential> = {
  baidu: 'bduss', pan123: 'username', xunlei: 'username',
};

export function credentialFilePath(stateDirectory: string): string {
  return path.join(stateDirectory, 'netdisk-credentials.json');
}

export function readCredentials(stateDirectory: string): CredentialStore {
  const file = credentialFilePath(stateDirectory);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: CredentialStore = {};
    for (const [platform, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry: PlatformCredential = {};
      for (const key of ['bduss', 'username', 'password'] as const) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === 'string' && field) entry[key] = field;
      }
      store[platform] = entry;
    }
    return store;
  } catch { return {}; }
}

export function writeCredentials(stateDirectory: string, store: CredentialStore): void {
  mkdirSync(stateDirectory, { recursive: true });
  const file = credentialFilePath(stateDirectory);
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows may not honour the POSIX mode. */ }
}

export function resolveCredential(platform: NetdiskPlatform, stateDirectory: string): PlatformCredential | null {
  const stored = readCredentials(stateDirectory)[platform];
  const credential: PlatformCredential = { ...(stored ?? {}) };
  const key = envKeys[platform];
  if (key) {
    const envName = `HENRY_NETDISK_${platform.toUpperCase()}_${key.toUpperCase()}`;
    const fromEnv = process.env[envName];
    if (fromEnv) credential[key] = fromEnv;
  }
  if (platform === 'pan123' || platform === 'xunlei') {
    const passwordEnv = process.env[`HENRY_NETDISK_${platform.toUpperCase()}_PASSWORD`];
    if (passwordEnv) credential.password = passwordEnv;
  }
  return Object.keys(credential).length ? credential : null;
}

export function listCredentialPlatforms(stateDirectory: string): string[] {
  return Object.keys(readCredentials(stateDirectory)).sort();
}

export function clearCredential(stateDirectory: string, platform: string): boolean {
  const store = readCredentials(stateDirectory);
  if (!(platform in store)) return false;
  delete store[platform];
  writeCredentials(stateDirectory, store);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-credentials.test.ts`
Expected: PASS。

- [ ] **Step 5: 加 CLI 子命令**

改 `src/adapters/cli/main.ts`：

1. 在 `parseArgs` 的 `options` 里加 `'bduss': { type: 'string' }, 'username': { type: 'string' }, 'password': { type: 'string' }`。
2. 把命令白名单改成 `['list', 'inspect', 'run', 'credentials']`。
3. 在 `if (command !== 'run' && ...)` 之后插入 `credentials` 分支（注意它需要在 `createRuntime` 之前处理，因为凭证命令不需要运行时）：

```ts
  if (command === 'credentials') {
    const action = name;
    const { credentials } = await import('../../tools/netdisk/credentials.js');
    const { stateDirectory } = await loadConfig(values.config);
    if (action === 'list') {
      const platforms = credentials.listCredentialPlatforms(stateDirectory);
      process.stdout.write(`${platforms.length ? platforms.join('\n') : '（尚未配置任何网盘凭证）'}\n`);
      return;
    }
    if (action === 'set') {
      const platform = extra[0];
      if (!platform) throw new Error('请指定平台，例如：credentials set baidu --bduss "..."');
      const entry = { bduss: values.bduss, username: values.username, password: values.password };
      if (!entry.bduss && !entry.username && !entry.password) throw new Error('请至少提供 --bduss、--username 或 --password 之一。');
      const store = credentials.readCredentials(stateDirectory);
      store[platform] = { ...(store[platform] ?? {}), ...Object.fromEntries(Object.entries(entry).filter(([, value]) => value)) };
      credentials.writeCredentials(stateDirectory, store);
      process.stdout.write(`已保存 ${platform} 的凭证。\n`);
      return;
    }
    if (action === 'clear') {
      const platform = extra[0];
      if (!platform) throw new Error('请指定要清除的平台。');
      const removed = credentials.clearCredential(stateDirectory, platform);
      process.stdout.write(removed ? `已清除 ${platform} 的凭证。\n` : `${platform} 没有已保存的凭证。\n`);
      return;
    }
    throw new Error('命令格式错误，请使用 --help。');
  }
```

4. 更新 `--help` 文本，加入：

```
credentials list
credentials set <platform> [--bduss <value>] [--username <value>] [--password <value>]
credentials clear <platform>
```

5. 把 `import { loadConfig }` 之后补 `import * as credentials from '../../tools/netdisk/credentials.js';`，并把上面 `await import(...)` 改成直接用 `credentials.` 前缀。

- [ ] **Step 6: 手动验证 CLI**

Run: `npm run cli -- credentials list`
Expected: 输出 `（尚未配置任何网盘凭证）`。

Run: `npm run cli -- credentials set baidu --bduss "test-token"`
Expected: 输出 `已保存 baidu 的凭证。`

Run: `npm run cli -- credentials list`
Expected: 输出 `baidu`。

Run: `npm run cli -- credentials clear baidu`
Expected: 输出 `已清除 baidu 的凭证。`

- [ ] **Step 7: 提交**

```bash
git add src/tools/netdisk/credentials.ts src/adapters/cli/main.ts tests/tools/netdisk-credentials.test.ts
git commit -m "feat: 新增网盘凭证存储与 CLI 管理命令"
```

---

## Task 6: 适配器契约与蓝奏云适配器

**Files:**
- Modify: `src/tools/netdisk/types.ts`
- Create: `src/tools/netdisk/adapters/lanzou.ts`
- Create: `src/tools/netdisk/adapters/index.ts`
- Test: `tests/tools/netdisk-lanzou.test.ts`

**Interfaces:**
- Consumes: `NetdiskSession`（Task 4）、`ToolError`。
- Produces（补进 `src/tools/netdisk/types.ts`）:
  ```ts
  export interface NetdiskFile {
    id: string;
    path: string;
    name: string;
    sizeBytes: number | null;
    isDirectory: boolean;
    modifiedAt?: string;
  }
  export interface NetdiskSource {
    platform: NetdiskPlatform;
    shareUrl: string;
    code: string | null;
    filePath: string;
    fileId: string;
  }
  export interface NetdiskLink {
    path: string;
    name: string;
    sizeBytes: number | null;
    url: string;
    headers: Record<string, string>;
    rangeSupported: boolean | null;
    expiresAt?: string;
    source: NetdiskSource;
    note?: string;
  }
  export interface NetdiskShare {
    title: string;
    files: NetdiskFile[];
    token?: unknown;
  }
  export interface PlatformCredential {
    bduss?: string;
    username?: string;
    password?: string;
  }
  export interface AdapterContext {
    session: NetdiskSession;
    shareId: string;
    shareUrl: string;
    code: string | null;
    credential: PlatformCredential | null;
    signal: AbortSignal;
    reportProgress: (phase: string, percent?: number) => void;
  }
  export interface NetdiskAdapter {
    platform: NetdiskPlatform;
    label: string;
    requiresCredential: boolean;
    list(context: AdapterContext): Promise<NetdiskShare>;
    link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink>;
  }
  ```
  `src/tools/netdisk/adapters/index.ts`：
  ```ts
  import type { NetdiskAdapter, NetdiskPlatform } from '../types.js';
  import { lanzouAdapter } from './lanzou.js';
  // 其余适配器在各自任务里注册进来。
  const adapters: NetdiskAdapter[] = [lanzouAdapter];
  export const adaptersByPlatform = new Map<NetdiskPlatform, NetdiskAdapter>(adapters.map(a => [a.platform, a]));
  ```

- [ ] **Step 1: 写蓝奏云解析的失败测试**

新建 `tests/tools/netdisk-lanzou.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanzouAdapter } from '../../src/tools/netdisk/adapters/lanzou.js';

test('reads the passcode requirement and the file id out of a share page', () => {
  const html = `<html><head><title>蓝奏分享</title></head><body>
    <script>var filemoreajax = 1;</script>
    <script>var ajaxm = "ajaxm.php?file=12345";</script>
    <script>var lx = "1"; var fid = "abc"; var t = "t1"; var k = "k1";</script>
    </body></html>`;
  const parsed = lanzouAdapter.parseSharePage(html, 'https://wwx.lanzoui.com/iXnuF4c8sqmb');
  assert.equal(parsed.needsPwd, false);
  assert.equal(parsed.isFolder, true);
  assert.equal(parsed.fileId, '12345');
  assert.deepEqual(parsed.folderParams, { lx: '1', fid: 'abc', t: 't1', k: 'k1' });
});

test('detects a share that needs a passcode', () => {
  const html = `<html><body><div id="pwbox">请输入密码</div>
    <script>function down_p(){ }</script></body></html>`;
  assert.equal(lanzouAdapter.parseSharePage(html, 'https://wwx.lanzoui.com/iXnuF4c8sqmb').needsPwd, true);
});

test('parses a display size into bytes', () => {
  assert.equal(lanzouAdapter.parseDisplaySize('1.5 M'), 1572864);
  assert.equal(lanzouAdapter.parseDisplaySize('2G'), 2147483648);
  assert.equal(lanzouAdapter.parseDisplaySize('800'), 800);
});
```

**注意**：`parseSharePage` 与 `parseDisplaySize` 是适配器导出的纯函数，供测试直接调用；它们不是 spec 里的接口契约，但作为适配器内部的可测单元导出是合理的。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-lanzou.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现蓝奏云适配器**

`src/tools/netdisk/adapters/lanzou.ts` 的结构（完整实现按下面写）：

```ts
import { ToolError } from '../../../core/errors.js';
import type { AdapterContext, NetdiskAdapter, NetdiskFile, NetdiskLink, NetdiskShare } from '../types.js';

const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface FolderParams { lx: string; fid: string; t: string; k: string }

export interface LanzouSharePage {
  baseUrl: string;
  title: string;
  isFolder: boolean;
  needsPwd: boolean;
  fileId: string | null;
  folderParams: FolderParams | null;
  singleFile: NetdiskFile | null;
  html: string;
}

function jsVar(html: string, name: string): string | null {
  const matched = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*["']([^"']+)["']`).exec(html);
  return matched?.[1] ?? null;
}

export const lanzouAdapter: NetdiskAdapter & {
  parseSharePage(html: string, shareUrl: string): LanzouSharePage;
  parseDisplaySize(text: string): number;
} = {
  platform: 'lanzou',
  label: '蓝奏云',
  requiresCredential: false,

  parseSharePage(html, shareUrl) {
    const url = new URL(shareUrl);
    const baseUrl = `${url.protocol}//${url.host}`;
    const needsPwd = html.includes('请输入密码') || html.includes('id="pwbox"')
      || html.includes('input_password') || html.includes('密码不正确') || html.includes('function down_p(');
    const isFolder = html.includes('filemoreajax') || html.includes('class="filemore"') || html.includes('file_more');
    const fileId = /(?:ajaxm|ajaxfile)\.php\?file=(\d+)/.exec(html)?.[1]
      ?? /name=["']file["']\s+value=["'](\d+)["']/.exec(html)?.[1]
      ?? /file=(\d+)/.exec(html)?.[1] ?? null;
    const lx = jsVar(html, 'lx');
    const fid = jsVar(html, 'fid') ?? url.pathname.trim('/').split('/').pop() ?? '';
    const t = jsVar(html, 't');
    const k = jsVar(html, 'k');
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    const sizeText = /(?:文件大小|大小)\s*[:：]\s*([\d.]+)\s*([KMGT]?)(?:i?B)?/i.exec(html);
    const singleFile = isFolder ? null : {
      id: url.pathname.trim('/').split('/').pop() ?? '',
      path: url.pathname.trim('/').split('/').pop() ?? '',
      name: title,
      sizeBytes: sizeText ? this.parseDisplaySize(`${sizeText[1]} ${sizeText[2]}`) : null,
      isDirectory: false,
    };
    return {
      baseUrl, title: title || '蓝奏分享', isFolder, needsPwd, fileId,
      folderParams: isFolder && lx && t && k ? { lx, fid, t, k } : null,
      singleFile, html,
    };
  },

  parseDisplaySize(text: string): number {
    const matched = /([\d.]+)\s*([KMGT]?)i?B?/i.exec(text.trim());
    if (!matched) return 0;
    const value = Number(matched[1]);
    if (!Number.isFinite(value)) return 0;
    const unit = matched[2].toUpperCase();
    const factor = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : unit === 'T' ? 1024 ** 4 : 1;
    return Math.round(value * factor);
  },

  async list(context: AdapterContext): Promise<NetdiskShare> {
    const page = await this.fetchSharePage(context);
    if (page.needsPwd && !context.code) {
      throw new ToolError('INVALID_INPUT', '该分享需要提取码，请在链接或输入框中提供。');
    }
    if (!page.isFolder) {
      if (!page.singleFile) throw new ToolError('TOOL_FAILED', '无法从分享页解析出文件。');
      return { title: page.title, files: [page.singleFile] };
    }
    if (!page.folderParams) throw new ToolError('TOOL_FAILED', '无法从分享页解析出目录参数。');
    const files = await this.listFolder(context, page, context.code, page.folderParams.fid);
    return { title: page.title, files };
  },

  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> {
    const page = await this.fetchSharePage(context);
    const member = file.path.includes('?') ? `${page.baseUrl}/${file.path}` : null;
    let referer = member ?? context.shareUrl;
    let html = member ? await this.fetchPage(context, member, referer) : page.html;
    const iframe = /<iframe[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
    if (iframe) {
      const absolute = new URL(iframe, page.baseUrl).href;
      html = await this.fetchPage(context, absolute, referer);
      referer = absolute;
    }
    const fileId = page.fileId ?? /(?:ajaxm|ajaxfile)\.php\?file=(\d+)/.exec(html)?.[1] ?? /file=(\d+)/.exec(html)?.[1];
    if (!fileId) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    const sign = /data\s*:\s*\{[^}]*['"]sign['"]\s*:\s*['"]([^'"]+)['"][^}]*\}/i.exec(html)?.[1]
      ?? jsVar(html, 'wp_sign') ?? jsVar(html, 'sign');
    if (!sign) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
    const ajaxUrl = new URL('/ajaxm.php', page.baseUrl).href;
    const fields: Record<string, string> = { action: 'downprocess', sign };
    if (page.needsPwd && context.code) {
      fields.p = context.code;
      fields.kd = '1';
    } else {
      const key = jsVar(html, 'websignkey') ?? /websignkey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(html)?.[1];
      if (!key) throw new ToolError('TOOL_FAILED', '蓝奏云下载参数缺失，解析失败。');
      const ajaxData = jsVar(html, 'ajaxdata');
      if (ajaxData) fields.signs = ajaxData;
      fields.websignkey = key;
      fields.websign = jsVar(html, 'websign') ?? '';
      fields.kd = '1';
      fields.ves = '1';
    }
    const response = await context.session.postForm(ajaxUrl, fields, { Referer: referer, Origin: page.baseUrl, 'User-Agent': WEB_UA });
    const data = response.data as { zt?: number; dom?: string; url?: string; inf?: string };
    if (data.zt !== 1) {
      const reason = data.inf ?? '';
      if (reason.includes('密码') || reason.includes('提取码')) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (reason.includes('频繁')) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      throw new ToolError('TOOL_FAILED', `蓝奏云解析失败：${reason || '接口未返回下载参数。'}`);
    }
    if (!data.dom || !data.url) throw new ToolError('TOOL_FAILED', '蓝奏云解析失败：接口未返回下载地址。');
    const jump = `${new URL(data.dom).protocol}//${new URL(data.dom).host}/file/${data.url}`;
    const verified = await this.verifyLink(context, jump, page.baseUrl);
    return {
      path: file.path, name: file.name, sizeBytes: file.sizeBytes,
      url: verified.url,
      headers: { Referer: referer, Origin: page.baseUrl, 'User-Agent': WEB_UA, Cookie: 'down_ip=1' },
      rangeSupported: verified.rangeSupported,
      source: { platform: 'lanzou', shareUrl: context.shareUrl, code: context.code, filePath: file.path, fileId },
    };
  },

  async fetchSharePage(context: AdapterContext): Promise<LanzouSharePage> {
    const html = await this.fetchPage(context, context.shareUrl, context.shareUrl);
    return this.parseSharePage(html, context.shareUrl);
  },

  async fetchPage(context: AdapterContext, url: string, referer: string): Promise<string> {
    const response = await context.session.get(url, { Referer: referer, 'User-Agent': WEB_UA });
    const html = typeof response.data === 'string' ? response.data : '';
    if (!html) throw new ToolError('TOOL_FAILED', '蓝奏云分享页为空，解析失败。');
    return html;
  },
};
```

**实现注意**：上面的 `fetchPage` 用 `session.get` 取 JSON，蓝奏云返回的是 HTML。实现时改用 `session` 上的一个 `getHtml` 能力：在 Task 4 的 `NetdiskSession` 里补一个方法：

```ts
  async getHtml(url: string, headers?: Record<string, string>) {
    this.options.signal.throwIfAborted();
    await this.waitForSlot(url);
    try {
      return await this.options.http.getHtml(url, this.options.signal, { headers: this.mergeCookieHeader(url, headers) });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('NETWORK_ERROR', '无法访问网盘接口，请检查地址或稍后重试。');
    }
  }
```

并把 `lanzouAdapter.fetchPage` 改成调用 `context.session.getHtml(url, headers)`，取 `response.html`。

`listFolder` 与 `verifyLink` 两个方法同样要在同一个对象里实现：

```ts
  async listFolder(context: AdapterContext, page: LanzouSharePage, pwd: string | null, dirFid: string): Promise<NetdiskFile[]> {
    const params = page.folderParams;
    if (!params) throw new ToolError('TOOL_FAILED', '无法从分享页解析出目录参数。');
    const files: NetdiskFile[] = [];
    const seen = new Set<string>();
    for (let pg = 1; pg <= 500; pg++) {
      const response = await context.session.postForm(`${page.baseUrl}/filemoreajax.php`, {
        lx: params.lx, fid: params.fid, t: params.t, k: params.k, pwd: pwd ?? '', pg: String(pg),
      }, { Referer: context.shareUrl, Origin: page.baseUrl, 'User-Agent': WEB_UA });
      const body = response.data as { zt?: number; text?: Array<Record<string, string>> };
      if (body.zt === 2) break;
      if (body.zt === 3) throw new ToolError('INVALID_INPUT', '提取码不正确。');
      if (body.zt !== 1) throw new ToolError('TOOL_FAILED', '蓝奏云目录解析失败。');
      const entries = body.text ?? [];
      if (!entries.length) break;
      let added = 0;
      for (const item of entries) {
        const reference = item.id ?? '';
        if (!reference) continue;
        const id = reference.split('?')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const name = item.name_all || item.name || id;
        files.push({
          id, path: reference, name,
          sizeBytes: this.parseDisplaySize(item.size ?? '0') || null,
          isDirectory: item.isfolder === '1' || item.is_dir === '1',
          modifiedAt: item.time ?? undefined,
        });
        added++;
      }
      if (!added) break;
    }
    return files;
  },

  async verifyLink(context: AdapterContext, jump: string, shareOrigin: string): Promise<{ url: string; rangeSupported: boolean | null }> {
    let url = jump;
    for (let attempt = 0; attempt < 5; attempt++) {
      const probe = await context.session.probe(url, { Referer: shareOrigin, 'User-Agent': WEB_UA, Cookie: 'down_ip=1' });
      if (probe.location) { url = new URL(probe.location, url).href; continue; }
      if (probe.status === 206 || probe.status === 200) {
        return { url, rangeSupported: probe.status === 206 || probe.acceptRanges === 'bytes' };
      }
      if (probe.status === 403 || probe.status === 404 || probe.status === 410) {
        throw new ToolError('TOOL_FAILED', '蓝奏云下载地址已失效。');
      }
      if (probe.status === 429) throw new ToolError('NETWORK_ERROR', '蓝奏云请求过于频繁，请稍后重试。');
      throw new ToolError('TOOL_FAILED', `蓝奏云下载地址探测失败（HTTP ${probe.status}）。`);
    }
    throw new ToolError('TOOL_FAILED', '蓝奏云下载地址探测重定向次数过多。');
  },
```

`verifyLink` 发一个 `Range: bytes=0-0` 的探测请求，跟随重定向直到拿到真正的 CDN 链接，并顺便判定该直链**是否支持断点续传**——这个结论会写进 `NetdiskLink.rangeSupported`，下载器据此决定分片还是单流。`session.probe` 与 `session.getHtml` 已在 Task 4 实现。

**注意**：`fetchPage` 要用 `context.session.getHtml(url, headers)` 取 `response.html`（蓝奏云返回 HTML，不是 JSON）。`getHtml` 的签名在 Task 1 已改为 `(url, signal, options?)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-lanzou.test.ts`
Expected: PASS。

- [ ] **Step 5: 真实验收**

用一条真实的蓝奏云分享链接跑：

```bash
npm run cli -- run netdisk_resolve --input '{"url":"<真实蓝奏云分享链接>"}'
```

此时 `netdisk_resolve` 工具还没建（Task 7），所以先用一条一次性脚本验证适配器：

```bash
npx tsx -e "
import { lanzouAdapter } from './src/tools/netdisk/adapters/lanzou.ts';
import { NetdiskSession } from './src/tools/netdisk/session.ts';
import { createPublicHttp } from './src/core/public-http.ts';
const url = '<真实蓝奏云分享链接>';
const session = new NetdiskSession({ http: createPublicHttp(2_097_152), signal: new AbortController().signal });
const context = { session, shareId: url.split('/').pop()!, shareUrl: url, code: null, credential: null, signal: new AbortController().signal, reportProgress: () => {} };
const share = await lanzouAdapter.list(context);
console.log(JSON.stringify(share.files, null, 2));
const link = await lanzouAdapter.link(context, share.files[0]);
console.log(JSON.stringify({ url: link.url, headers: link.headers, rangeSupported: link.rangeSupported }, null, 2));
"
```

Expected: 打印文件列表与一条带 headers 的直链。若接口已变更，按错误信息调整端点并在任务里记录实际变更。

- [ ] **Step 6: 提交**

```bash
git add src/tools/netdisk/types.ts src/tools/netdisk/adapters/lanzou.ts src/tools/netdisk/adapters/index.ts src/tools/netdisk/session.ts tests/tools/netdisk-lanzou.test.ts
git commit -m "feat: 新增蓝奏云适配器，打通分享列表与直链取链链路"
```

---

## Task 7: `netdisk_resolve` 工具

**Files:**
- Create: `src/tools/netdisk-resolve.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/tools/netdisk-resolve.test.ts`

**Interfaces:**
- Consumes: `parseShareLink`、`adaptersByPlatform`、`NetdiskSession`、`resolveCredential`。
- Produces: 工具 `netdisk_resolve`，名称小写下划线，分类 `web`，能力 `['network:public']`。

- [ ] **Step 1: 写失败测试**

新建 `tests/tools/netdisk-resolve.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { netdiskResolveTool } from '../../src/tools/netdisk-resolve.js';

test('declares a strict input schema and rejects unknown fields', () => {
  const parsed = netdiskResolveTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/abc', unknown: 1 });
  assert.equal(parsed.success, false);
});

test('reports an unsupported platform instead of guessing', async () => {
  const result = await netdiskResolveTool.invoke({ url: 'https://www.ilanzou.com/s/AbCdEfGh' }, {
    signal: new AbortController().signal,
    limits: { fileBytes: 1, csvRows: 1, directoryEntries: 1, pdfPages: 1, webBytes: 1, downloadBytes: 1, outputBytes: 1, toolTimeoutMs: 1 },
    stateDirectory: process.cwd(),
  });
  assert.equal(result.ok, false);
});

test('exposes a documented example', () => {
  assert.ok(netdiskResolveTool.examples.length >= 1);
  assert.equal(netdiskResolveTool.examples[0].input.url.length > 0, true);
});
```

**注意**：`invoke` 在失败时抛 `ToolError`（见 `src/core/define-tool.ts`），不会返回 `{ ok: false }`。所以上面第二个用例改成：

```ts
test('reports an unsupported platform instead of guessing', async () => {
  await assert.rejects(
    () => netdiskResolveTool.invoke({ url: 'https://www.ilanzou.com/s/AbCdEfGh' }, {
      signal: new AbortController().signal,
      limits: { fileBytes: 1, csvRows: 1, directoryEntries: 1, pdfPages: 1, webBytes: 1, downloadBytes: 1, outputBytes: 1, toolTimeoutMs: 1 },
      stateDirectory: process.cwd(),
    }),
    /优享版/,
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-resolve.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现工具**

`src/tools/netdisk-resolve.ts`：

```ts
import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { NetdiskSession } from './netdisk/session.js';
import { adaptersByPlatform } from './netdisk/adapters/index.js';
import { parseShareLink } from './netdisk/share-link.js';
import { NETDISK_PLATFORM_LABELS } from './netdisk/share-link.js';
import { resolveCredential } from './netdisk/credentials.js';
import type { NetdiskLink } from './netdisk/types.js';

const platformEnum = z.enum(['lanzou', 'guangya', 'quark', 'uc', 'pan115', 'c139', 'pan123', 'xunlei', 'baidu']);

export const netdiskResolveTool = defineTool({
  name: 'netdisk_resolve',
  title: '网盘分享解析',
  description: '解析夸克 / UC / 迅雷 / 百度 / 139 / 123 / 115 / 光鸭 / 蓝奏云的分享链接，列出分享内的文件并给出已验证的下载直链与所需请求头。直链通常十几分钟内有效，请尽快使用。',
  category: 'web',
  capabilities: ['network:public'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '分享链接或文案', type: 'textarea', description: '可以整段粘贴分享文案，工具会自动找出链接与提取码。' },
    { name: 'code', label: '提取码', type: 'text', description: '不填则自动从文案中识别。' },
    { name: 'platform', label: '网盘平台', type: 'select', description: '默认自动识别。', options: [
      { label: '自动识别', value: 'auto' },
      ...Object.entries(NETDISK_PLATFORM_LABELS)
        .filter(([key]) => key !== 'ilanzou')
        .map(([key, label]) => ({ label, value: key })),
    ] },
    { name: 'mode', label: '解析深度', type: 'select', description: '只列文件更快；取直链会对每个文件额外发请求。', options: [
      { label: '列出文件并取直链', value: 'link' },
      { label: '只列出文件', value: 'list' },
    ] },
    { name: 'paths', label: '指定文件路径', type: 'textarea', description: '每行一个分享内的相对路径，只给这些文件取直链。留空表示全部文件。' },
    { name: 'maxLinks', label: '最多取几条直链', type: 'number', description: '默认 10，上限 50。受单次执行 120 秒限制。' },
  ],
  examples: [
    { label: '解析一个分享链接', input: { url: 'https://pan.quark.cn/s/替换为你的分享码' } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    code: z.string().optional(),
    platform: z.union([z.literal('auto'), platformEnum]).default('auto'),
    mode: z.enum(['list', 'link']).default('link'),
    paths: z.array(z.string()).optional(),
    maxLinks: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.strictObject({
    platform: platformEnum,
    platformLabel: z.string(),
    shareId: z.string(),
    title: z.string(),
    fileCount: z.number(),
    totalBytes: z.number().nullable(),
    files: z.array(z.strictObject({
      id: z.string(), path: z.string(), name: z.string(),
      sizeBytes: z.number().nullable(), isDirectory: z.boolean(), modifiedAt: z.string().optional(),
    })),
    links: z.array(z.object({}).passthrough()),
    linkFailures: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
    credentialUsed: z.boolean(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, code, platform, mode, paths, maxLinks }, ctx) {
    const parsed = parseShareLink(url);
    if (!parsed) throw new ToolError('INVALID_INPUT', '无法识别该链接的网盘平台，请确认是完整的分享链接或分享文案。');
    if (parsed.platform === 'ilanzou') {
      throw new ToolError('UNSUPPORTED_FORMAT', '蓝奏云优享版（ilanzou）官方没有分享解析接口，暂不支持。');
    }
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    if (platform !== 'auto' && platform !== parsed.platform) {
      throw new ToolError('INVALID_INPUT', `链接识别为${NETDISK_PLATFORM_LABELS[parsed.platform]}，与指定的平台不一致。`);
    }
    const adapter = adaptersByPlatform.get(parsed.platform);
    if (!adapter) throw new ToolError('UNSUPPORTED_FORMAT', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 暂未接入解析。`);
    const credential = resolveCredential(parsed.platform, ctx.stateDirectory);
    if (adapter.requiresCredential && !credential) {
      throw new ToolError('ACCESS_DENIED', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 需要登录态，请先执行 npm run cli -- credentials set ${parsed.platform} 配置凭证。`);
    }
    const session = new NetdiskSession({ http: ctx.http, signal: ctx.signal });
    const context = {
      session, shareId: parsed.shareId, shareUrl: parsed.shareUrl,
      code: code?.trim() || parsed.code, credential, signal: ctx.signal,
      reportProgress: (phase: string, percent?: number) => ctx.reportProgress?.({ phase, percent }),
    };
    ctx.reportProgress?.({ phase: '读取分享内容' });
    const share = await adapter.list(context);
    const files = share.files;
    const totalBytes = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) || null;
    const warnings: string[] = [];
    if (files.length > 500) warnings.push(`分享内有 ${files.length} 个条目，仅列出前 500 个。`);
    if (mode === 'list') {
      return {
        platform: parsed.platform, platformLabel: adapter.label, shareId: parsed.shareId,
        title: share.title, fileCount: files.length, totalBytes, files, links: [],
        linkFailures: [], credentialUsed: Boolean(credential), warnings,
      };
    }
    const wanted = paths?.length
      ? files.filter(file => paths.includes(file.path))
      : files.filter(file => !file.isDirectory);
    const targets = wanted.slice(0, maxLinks);
    if (wanted.length > targets.length) {
      warnings.push(`共 ${wanted.length} 个可取链文件，本次只处理前 ${targets.length} 个。`);
    }
    const links: NetdiskLink[] = [];
    const linkFailures: Array<{ path: string; reason: string }> = [];
    for (const [index, file] of targets.entries()) {
      ctx.reportProgress?.({ phase: `取直链 ${index + 1}/${targets.length}` });
      try {
        links.push(await adapter.link(context, file));
      } catch (error) {
        linkFailures.push({ path: file.path, reason: error instanceof Error ? error.message : '取链失败' });
      }
    }
    if (links.length) warnings.push('直链通常在十几分钟内过期，请尽快下载。');
    return {
      platform: parsed.platform, platformLabel: adapter.label, shareId: parsed.shareId,
      title: share.title, fileCount: files.length, totalBytes, files, links, linkFailures,
      credentialUsed: Boolean(credential), warnings,
    };
  },
});
```

- [ ] **Step 4: 注册工具**

改 `src/tools/index.ts`：

```ts
import { netdiskResolveTool } from './netdisk-resolve.js';
...
    filesPlanTool, textStatsTool, csvSummaryTool, pdfExtractTool, webExtractTool, envInspectTool,
    bilibiliVideoTool, douyinVideoTool, douyinNoWatermarkTool, docConvertTool, photoCompressTool, xlsxSummaryTool,
    netdiskResolveTool,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-resolve.test.ts`
Expected: PASS。

- [ ] **Step 6: 端到端验证**

Run: `npm run cli -- run netdisk_resolve --input '{"url":"<真实蓝奏云分享链接>"}'`
Expected: 返回 `ok: true`，`data.files` 非空，`data.links` 里每条带 `url` 与 `headers`。

Run: `npm run cli -- list`
Expected: 工具数从 12 变成 13。

- [ ] **Step 7: 更新硬编码的工具数量**

仓库里有两处把工具数量写死了，加载具后会红：

- `tests/e2e/workbench.spec.ts:18`：`expect(tools).toHaveLength(12);` → 改成 `13`
- `tests/production.test.ts:28`：`assert.equal((await client.listTools()).tools.length, 12);` → 改成 `13`

（`tests/adapters/progress.test.ts:78` 用的是 `>= 12`，不用改。Task 11 加完第二个工具后，这两处再改成 14。）

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/tools/netdisk-resolve.ts src/tools/index.ts tests/tools/netdisk-resolve.test.ts tests/e2e/workbench.spec.ts tests/production.test.ts
git commit -m "feat: 新增网盘分享解析工具，输出文件列表与已验证直链"
```

---

## Task 8: 分片下载内核

**Files:**
- Create: `src/core/download/segment-table.ts`
- Create: `src/core/download/segmenter.ts`
- Test: `tests/core/download-segmenter.test.ts`

**Interfaces:**
- Consumes: `PublicHttp.getStream`（Task 1）、`FileWriter.open`（Task 2）、`NetdiskLink`（Task 6）。
- Produces:
  ```ts
  // src/core/download/segment-table.ts
  export interface Segment { start: number; end: number; done: boolean }
  export interface SegmentTable { size: number; segments: Segment[] }
  export function splitSegments(size: number, count: number): Segment[];
  export function serializeSegmentTable(table: SegmentTable): string;
  export function parseSegmentTable(text: string): SegmentTable | null;
  export function completedBytes(table: SegmentTable): number;

  // src/core/download/segmenter.ts
  export interface SegmenterOptions {
    http: PublicHttp;
    writer: FileWriter;
    signal: AbortSignal;
    /** 每个分段的并发连接数。默认 8。 */
    connections?: number;
    /** 断点续传用：已有的分段表。给了就从断点继续，已完成的段直接跳过。 */
    segments?: SegmentTable;
    onProgress?: (update: { bytesWritten: number; totalBytes: number; speedBytesPerSecond: number }) => void;
    /** 某一段下载完成时回调，用于立刻持久化断点。 */
    onSegmentComplete?: (table: SegmentTable) => void | Promise<void>;
  }
  export interface SegmenterResult {
    bytesWritten: number;
    totalBytes: number;
    rangeSupported: boolean;
    /** 更新后的分段表，调用方负责持久化。 */
    table: SegmentTable;
  }
  export async function downloadSegmented(
    link: NetdiskLink,
    options: SegmenterOptions,
  ): Promise<SegmenterResult>;
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/core/download-segmenter.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createFileWriter } from '../../src/core/file-access.js';
import { completedBytes, parseSegmentTable, splitSegments } from '../../src/core/download/segment-table.js';
import { downloadSegmented } from '../../src/core/download/segmenter.js';
import type { PublicHttp } from '../../src/contracts/tool.js';

test('splits a file into contiguous segments', () => {
  const segments = splitSegments(1000, 4);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0], { start: 0, end: 249, done: false });
  assert.deepEqual(segments[3], { start: 750, end: 999, done: false });
  assert.equal(segments.reduce((sum, s) => sum + (s.end - s.start + 1), 0), 1000);
});

test('round-trips a segment table through text', () => {
  const table = { size: 100, segments: splitSegments(100, 2) };
  table.segments[0].done = true;
  const parsed = parseSegmentTable(JSON.stringify(table));
  assert.equal(parsed?.size, 100);
  assert.equal(parsed?.segments[0].done, true);
  assert.equal(completedBytes(parsed!), 50);
});

test('downloads a file in parallel segments into the right offsets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstation-segment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from('0123456789');
  const http = {
    getStream: async (url: string, _signal: AbortSignal, options?: { headers?: Record<string, string> }) => {
      const range = options?.headers?.Range ?? '';
      const matched = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(matched?.[1] ?? 0);
      const end = matched?.[2] ? Number(matched[2]) : payload.length - 1;
      return {
        finalUrl: url, status: 206, contentType: 'application/octet-stream',
        contentLength: end - start + 1,
        body: Readable.from([payload.subarray(start, end + 1)]),
      };
    },
  } as unknown as PublicHttp;
  const writer = createFileWriter(directory, new AbortController().signal, 1_048_576);
  const result = await downloadSegmented({
    path: 'a.bin', name: 'a.bin', sizeBytes: payload.length,
    url: 'https://example.com/a.bin', headers: {}, rangeSupported: true,
    source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
  }, { http, writer, signal: new AbortController().signal, outputPath: 'a.bin' });
  assert.equal(result.bytesWritten, payload.length);
  assert.equal((await readFile(path.join(directory, 'a.bin'))).toString(), '0123456789');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/core/download-segmenter.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现分段表**

`src/core/download/segment-table.ts`：

```ts
import { readFile, writeFile } from 'node:fs/promises';

export interface Segment { start: number; end: number; done: boolean }
export interface SegmentTable { size: number; segments: Segment[] }

export function splitSegments(size: number, count: number): Segment[] {
  if (size <= 0 || count <= 0) return [];
  const total = Math.min(count, size);
  const base = Math.floor(size / total);
  const remainder = size % total;
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 0; index < total; index++) {
    const length = base + (index < remainder ? 1 : 0);
    segments.push({ start, end: start + length - 1, done: false });
    start += length;
  }
  return segments;
}

export function serializeSegmentTable(table: SegmentTable): string {
  return JSON.stringify(table);
}

export function parseSegmentTable(text: string): SegmentTable | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const table = parsed as SegmentTable;
    if (!Number.isSafeInteger(table.size) || !Array.isArray(table.segments)) return null;
    if (!table.segments.every(segment => Number.isSafeInteger(segment.start) && Number.isSafeInteger(segment.end) && segment.end >= segment.start)) return null;
    return table;
  } catch { return null; }
}

export function completedBytes(table: SegmentTable): number {
  return table.segments.reduce((sum, segment) => sum + (segment.done ? segment.end - segment.start + 1 : 0), 0);
}

export async function readSegmentTable(file: string): Promise<SegmentTable | null> {
  try { return parseSegmentTable(await readFile(file, 'utf8')); }
  catch { return null; }
}

export async function writeSegmentTable(file: string, table: SegmentTable): Promise<void> {
  await writeFile(file, serializeSegmentTable(table), 'utf8');
}
```

- [ ] **Step 4: 实现分片内核**

`src/core/download/segmenter.ts`：

```ts
import { ToolError } from '../errors.js';
import type { FileWriter, PublicHttp } from '../../contracts/tool.js';
import type { NetdiskLink } from '../../tools/netdisk/types.js';
import { splitSegments, type Segment, type SegmentTable } from './segment-table.js';

/**
 * 直链失效。用子类而不是新增 ErrorCode，是为了不改动全局错误码契约，
 * 同时让下载管理器能精确区分"要重新取链"和"下载失败"。
 */
export class LinkExpiredError extends ToolError {
  constructor(message = '直链已失效。') {
    super('TOOL_FAILED', message);
    this.name = 'LinkExpiredError';
  }
}

export interface SegmenterOptions {
  http: PublicHttp;
  writer: FileWriter;
  signal: AbortSignal;
  /** 输出目录内的相对路径。分段内核不自己决定文件名。 */
  outputPath: string;
  /** 每个分段的并发连接数。默认 8。 */
  connections?: number;
  /** 断点续传用：已有的分段表。给了就从断点继续，已完成的段直接跳过。 */
  segments?: SegmentTable;
  onProgress?: (update: { bytesWritten: number; totalBytes: number; speedBytesPerSecond: number }) => void;
  /** 某一段下载完成时回调，用于立刻持久化断点。 */
  onSegmentComplete?: (table: SegmentTable) => void | Promise<void>;
}

export interface SegmenterResult {
  bytesWritten: number;
  totalBytes: number;
  rangeSupported: boolean;
  /** 更新后的分段表，调用方负责持久化。 */
  table: SegmentTable;
}

export async function downloadSegmented(link: NetdiskLink, options: SegmenterOptions): Promise<SegmenterResult> {
  const total = link.sizeBytes ?? 0;
  if (!total) throw new ToolError('TOOL_FAILED', '无法确定文件大小，无法下载。');
  const connections = Math.max(1, options.connections ?? 8);
  const useRange = link.rangeSupported !== false;
  const table: SegmentTable = options.segments && options.segments.size === total
    ? options.segments
    : { size: total, segments: splitSegments(total, useRange ? connections : 1) };
  if (!useRange) table.segments = [{ start: 0, end: total - 1, done: false }];

  const handle = await options.writer.open(options.outputPath, { overwrite: true, truncateTo: total });
  let bytesWritten = table.segments.reduce((sum, segment) => sum + (segment.done ? segment.end - segment.start + 1 : 0), 0);
  const startedAt = Date.now();
  try {
    await Promise.all(table.segments.map(segment => runSegment(segment)));
    bytesWritten = total;
    options.onProgress?.({ bytesWritten, totalBytes: total, speedBytesPerSecond: total / Math.max(1, (Date.now() - startedAt) / 1000) });
    return { bytesWritten, totalBytes: total, rangeSupported: useRange, table };
  } finally {
    await handle.close();
  }

  async function runSegment(segment: Segment): Promise<void> {
    if (segment.done) return;
    let downloaded = 0;
    while (!segment.done) {
      options.signal.throwIfAborted();
      const from = segment.start + downloaded;
      const to = segment.end;
      if (from > to) break;
      const headers = useRange ? { ...link.headers, Range: `bytes=${from}-${to}` } : { ...link.headers };
      const response = await options.http.getStream(link.url, options.signal, { headers, timeoutMs: 60_000, maxBytes: to - from + 1 });
      if ([403, 404, 410].includes(response.status)) {
        throw new LinkExpiredError(`直链已失效（HTTP ${response.status}）。`);
      }
      if (useRange && response.status !== 206) {
        throw new ToolError('TOOL_FAILED', '该直链不支持分段下载（服务器未返回 206），已停止以免写出损坏的文件。');
      }
      let position = from;
      let lastTickAt = Date.now();
      let lastTickBytes = 0;
      for await (const chunk of response.body) {
        options.signal.throwIfAborted();
        const buffer = Buffer.from(chunk);
        await handle.writeAt(buffer, position);
        position += buffer.byteLength;
        downloaded += buffer.byteLength;
        bytesWritten += buffer.byteLength;
        lastTickBytes += buffer.byteLength;
        const now = Date.now();
        const elapsed = now - lastTickAt;
        if (elapsed >= 1000) {
          options.onProgress?.({ bytesWritten, totalBytes: total, speedBytesPerSecond: lastTickBytes / (elapsed / 1000) });
          lastTickAt = now;
          lastTickBytes = 0;
        }
      }
      segment.done = true;
      await options.onSegmentComplete?.(table);
    }
  }
}
```

**要点**：
- 已有分段表且 `size` 一致时才复用，否则重建。
- 每段完成立刻把 `done` 置真并回调 `onSegmentComplete`，调用方据此落盘——这是断点续传能生效的关键。
- `useRange` 为假时**不发 Range 头**并接受 200 响应（单流直下）；为真时必须拿到 206，否则宁可失败也不写出损坏文件。
- 动态分段（按速度重划边界）本轮**不实现**——spec §6.3 把它标为可选增强。分段边界固定，断点续传不受影响。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/core/download-segmenter.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/download/segment-table.ts src/core/download/segmenter.ts tests/core/download-segmenter.test.ts
git commit -m "feat: 新增分片下载内核与分段表持久化"
```

---

## Task 9: 下载任务管理器

**Files:**
- Create: `src/core/download/task-store.ts`
- Create: `src/core/download/manager.ts`
- Test: `tests/core/download-manager.test.ts`

**Interfaces:**
- Consumes: `downloadSegmented`（Task 8）、`createFileWriter`（Task 2）、`createPublicHttp`（Task 1）、适配器（Task 6）。
- Produces:
  ```ts
  // src/core/download/task-store.ts
  export type TaskStatus = 'queued' | 'preparing' | 'downloading' | 'verifying' | 'completed' | 'paused' | 'failed' | 'cancelled' | 'handed_off';
  export interface DownloadTask {
    id: string;
    platform: NetdiskPlatform;
    title: string;
    fileName: string;
    filePath: string;
    sizeBytes: number | null;
    status: TaskStatus;
    backend: 'builtin' | 'ndm';
    bytesWritten: number;
    totalBytes: number | null;
    speedBytesPerSecond: number | null;
    rangeSupported: boolean | null;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    finishedAt?: string;
    error?: { code: string; message: string };
    source: NetdiskSource;
    outputPath: string;
    /** 当前使用的直链；失效后由 refreshLink 替换。 */
    link: NetdiskLink;
  }
  export class TaskStore {
    constructor(stateDirectory: string);
    list(): DownloadTask[];
    get(id: string): DownloadTask | undefined;
    save(task: DownloadTask): void;
    remove(id: string): boolean;
    directory(id: string): string;
  }

  // src/core/download/manager.ts
  export interface DownloadManagerOptions {
    http: PublicHttp;
    stateDirectory: string;
    outputDirectory: string;
    outputBytesLimit: number;
    /** 同时运行的下载任务上限。默认 3。 */
    concurrency?: number;
    /** 每个任务的并发连接数。默认 8。 */
    connections?: number;
    /** 直链失效时重新取链的回调，由运行时注入。 */
    refreshLink?: (task: DownloadTask) => Promise<NetdiskLink>;
  }
  export class DownloadManager {
    constructor(options: DownloadManagerOptions);
    list(): DownloadTask[];
    get(id: string): DownloadTask | undefined;
    create(input: { platform, title, fileName, filePath, sizeBytes, backend, source, outputPath, link }): DownloadTask;
    pause(id: string): boolean;
    resume(id: string): boolean;
    remove(id: string): boolean;
    subscribe(listener: (tasks: DownloadTask[]) => void): () => void;
    shutdown(): Promise<void>;
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/core/download-manager.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DownloadManager } from '../../src/core/download/manager.js';
import type { PublicHttp } from '../../src/contracts/tool.js';

function fakeHttp(payload = Buffer.from('hello')): PublicHttp {
  return {
    getHtml: async () => ({ finalUrl: '', html: '', status: 200 }),
    getJson: async () => ({ finalUrl: '', data: {}, status: 200 }),
    getBinary: async () => ({ finalUrl: '', bytes: new Uint8Array(), contentType: '', status: 200 }),
    getRaw: async () => ({ finalUrl: '', status: 200, contentType: '', bytes: new Uint8Array(), setCookie: [] }),
    postForm: async () => ({ finalUrl: '', data: {}, status: 200 }),
    postJson: async () => ({ finalUrl: '', data: {}, status: 200 }),
    getStream: async (url) => ({
      finalUrl: url, status: 200, contentType: 'application/octet-stream', contentLength: payload.length,
      body: Readable.from([payload]),
    }),
    getHead: async (url) => ({ finalUrl: url, status: 200, contentType: '', headers: {}, setCookie: [] }),
  } as unknown as PublicHttp;
}

test('creates a task and finishes it in the background', async t => {
  const state = await mkdtemp(path.join(tmpdir(), 'workstation-tasks-'));
  const output = await mkdtemp(path.join(tmpdir(), 'workstation-out-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => rm(output, { recursive: true, force: true }));
  const manager = new DownloadManager({ http: fakeHttp(), stateDirectory: state, outputDirectory: output, outputBytesLimit: 1_048_576 });
  t.after(() => manager.shutdown());
  const task = manager.create({
    platform: 'lanzou', title: 't', fileName: 'a.bin', filePath: 'a.bin', sizeBytes: 5,
    backend: 'builtin', outputPath: 'a.bin',
    source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
    link: {
      path: 'a.bin', name: 'a.bin', sizeBytes: 5, url: 'https://example.com/a.bin',
      headers: {}, rangeSupported: false,
      source: { platform: 'lanzou', shareUrl: 'https://example.com/s/1', code: null, filePath: 'a.bin', fileId: '1' },
    },
  });
  assert.equal(task.status, 'queued');
  let stop: (() => void) | undefined;
  const done = await new Promise<boolean>(resolve => {
    stop = manager.subscribe(tasks => {
      if (tasks.find(item => item.id === task.id)?.status === 'completed') { stop?.(); resolve(true); }
    });
  });
  assert.equal(done, true);
  assert.equal(manager.get(task.id)?.status, 'completed');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/core/download-manager.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现任务存储**

`src/core/download/task-store.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NetdiskPlatform, NetdiskSource } from '../../tools/netdisk/types.js';

export type TaskStatus = 'queued' | 'preparing' | 'downloading' | 'verifying' | 'completed' | 'paused' | 'failed' | 'cancelled' | 'handed_off';

export interface DownloadTask {
  id: string;
  platform: NetdiskPlatform;
  title: string;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  status: TaskStatus;
  backend: 'builtin' | 'ndm';
  bytesWritten: number;
  totalBytes: number | null;
  speedBytesPerSecond: number | null;
  rangeSupported: boolean | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  source: NetdiskSource;
  outputPath: string;
}

export class TaskStore {
  private readonly indexFile: string;
  constructor(private readonly stateDirectory: string) {
    const directory = path.join(stateDirectory, 'downloads');
    mkdirSync(directory, { recursive: true });
    this.indexFile = path.join(directory, 'tasks.json');
  }

  directory(id: string): string {
    return path.join(this.stateDirectory, 'downloads', id);
  }

  list(): DownloadTask[] {
    if (!existsSync(this.indexFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed as DownloadTask[];
    } catch { return []; }
  }

  get(id: string): DownloadTask | undefined {
    return this.list().find(task => task.id === id);
  }

  save(task: DownloadTask): void {
    const tasks = this.list().filter(item => item.id !== task.id);
    tasks.push(task);
    writeFileSync(this.indexFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
    const directory = this.directory(task.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  }

  remove(id: string): boolean {
    const tasks = this.list();
    const remaining = tasks.filter(task => task.id !== id);
    if (remaining.length === tasks.length) return false;
    writeFileSync(this.indexFile, `${JSON.stringify(remaining, null, 2)}\n`, 'utf8');
    rmSync(this.directory(id), { recursive: true, force: true });
    return true;
  }
}
```

- [ ] **Step 4: 实现管理器**

`src/core/download/manager.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../errors.js';
import { createFileWriter } from '../file-access.js';
import type { FileWriter, PublicHttp } from '../../contracts/tool.js';
import type { NetdiskLink, NetdiskPlatform, NetdiskSource } from '../../tools/netdisk/types.js';
import { downloadSegmented, LinkExpiredError } from './segmenter.js';
import { readSegmentTable, splitSegments, writeSegmentTable, type SegmentTable } from './segment-table.js';
import { TaskStore, type DownloadTask, type TaskStatus } from './task-store.js';

export interface DownloadManagerOptions {
  http: PublicHttp;
  stateDirectory: string;
  outputDirectory: string;
  outputBytesLimit: number;
  concurrency?: number;
  connections?: number;
  refreshLink?: (task: DownloadTask) => Promise<NetdiskLink>;
}

export interface CreateTaskInput {
  platform: NetdiskPlatform;
  title: string;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  backend: 'builtin' | 'ndm';
  source: NetdiskSource;
  outputPath: string;
  link: NetdiskLink;
}

export class DownloadManager {
  private readonly store: TaskStore;
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<(tasks: DownloadTask[]) => void>();
  private readonly queue: DownloadTask[] = [];
  private running = 0;
  private readonly concurrency: number;
  private readonly connections: number;

  constructor(private readonly options: DownloadManagerOptions) {
    this.store = new TaskStore(options.stateDirectory);
    this.concurrency = options.concurrency ?? 3;
    this.connections = options.connections ?? 8;
    for (const task of this.store.list()) {
      if (task.status === 'downloading' || task.status === 'preparing' || task.status === 'verifying') {
        this.update(task.id, { status: 'paused', error: { code: 'TOOL_FAILED', message: '上次运行结束时任务仍在下载，已暂停，等待继续。' } });
      }
    }
  }

  list(): DownloadTask[] { return this.store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): DownloadTask | undefined { return this.store.get(id); }

  subscribe(listener: (tasks: DownloadTask[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    const tasks = this.list();
    for (const listener of this.listeners) {
      try { listener(tasks); } catch { /* a broken listener must not break a download */ }
    }
  }

  private update(id: string, patch: Partial<DownloadTask>): DownloadTask | undefined {
    const current = this.store.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.store.save(next);
    this.emit();
    return next;
  }

  create(input: CreateTaskInput): DownloadTask {
    const task: DownloadTask = {
      id: randomUUID(),
      platform: input.platform,
      title: input.title,
      fileName: input.fileName,
      filePath: input.filePath,
      sizeBytes: input.sizeBytes,
      status: 'queued',
      backend: input.backend,
      bytesWritten: 0,
      totalBytes: input.sizeBytes,
      speedBytesPerSecond: null,
      rangeSupported: input.link.rangeSupported ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: input.source,
      outputPath: this.uniqueOutputPath(input.outputPath),
      link: input.link,
    };
    this.store.save(task);
    this.queue.push(task);
    this.emit();
    this.pump();
    return task;
  }

  /** 同一个文件名再次下载时追加序号，避免静默覆盖上一次的产物。 */
  private uniqueOutputPath(base: string): string {
    const taken = new Set(this.store.list().map(task => task.outputPath));
    if (!taken.has(base)) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    for (let index = 1; index < 1000; index++) {
      const candidate = `${stem}-${index}${extension}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  pause(id: string): boolean {
    const task = this.store.get(id);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false;
    this.controllers.get(id)?.abort();
    this.update(id, { status: 'paused' });
    return true;
  }

  resume(id: string): boolean {
    const task = this.store.get(id);
    if (!task) return false;
    if (task.status !== 'paused' && task.status !== 'failed') return false;
    this.update(id, { status: 'queued', error: undefined });
    this.queue.push(task);
    this.pump();
    return true;
  }

  remove(id: string): boolean {
    this.controllers.get(id)?.abort();
    const removed = this.store.remove(id);
    this.emit();
    return removed;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      if (!task) break;
      if (this.store.get(task.id)?.status !== 'queued') continue;
      this.running++;
      void this.run(task).finally(() => { this.running--; this.pump(); });
    }
  }

  private async run(task: DownloadTask): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.update(task.id, { status: 'preparing', startedAt: new Date().toISOString() });
    try {
      await mkdir(this.options.outputDirectory, { recursive: true });
      const writer: FileWriter = createFileWriter(this.options.outputDirectory, controller.signal, this.options.outputBytesLimit);
      const table = await this.loadSegments(task);
      let link = this.storedLink(task);
      let result: Awaited<ReturnType<typeof downloadSegmented>> | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await downloadSegmented(link, {
            http: this.options.http,
            writer,
            signal: controller.signal,
            connections: this.connections,
            outputPath: task.outputPath,
            segments: table,
            onProgress: update => {
              this.update(task.id, {
                status: 'downloading',
                bytesWritten: update.bytesWritten,
                totalBytes: update.totalBytes,
                speedBytesPerSecond: Math.round(update.speedBytesPerSecond),
              });
            },
            onSegmentComplete: async updated => { await writeSegmentTable(this.segmentFile(task.id), updated); },
          });
          break;
        } catch (error) {
          if (!(error instanceof LinkExpiredError) || attempt === 2) throw error;
          // 直链失效：重新取链后从断点继续，分段表里已完成的段不会重下。
          const refreshed = await this.options.refreshLink?.(this.store.get(task.id) ?? task);
          if (!refreshed) throw error;
          link = refreshed;
          this.update(task.id, { link: refreshed, rangeSupported: refreshed.rangeSupported ?? null });
        }
      }
      if (!result) throw new ToolError('TOOL_FAILED', '下载未产生结果。');
      this.update(task.id, {
        status: 'completed',
        bytesWritten: result.bytesWritten,
        totalBytes: result.totalBytes,
        rangeSupported: result.rangeSupported,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.update(task.id, { status: 'paused' });
      } else {
        const failure = error instanceof ToolError ? error : new ToolError('TOOL_FAILED', '下载失败。');
        this.update(task.id, { status: 'failed', error: { code: failure.code, message: failure.message }, finishedAt: new Date().toISOString() });
      }
    } finally {
      this.controllers.delete(task.id);
    }
  }

  private segmentFile(id: string): string {
    return path.join(this.store.directory(id), 'segments.json');
  }

  private storedLink(task: DownloadTask): NetdiskLink {
    return this.store.get(task.id)?.link ?? task.link;
  }

  private async loadSegments(task: DownloadTask): Promise<SegmentTable> {
    const size = task.sizeBytes ?? 0;
    const existing = await readSegmentTable(this.segmentFile(task.id));
    if (existing && existing.size === size) return existing;
    const table: SegmentTable = { size, segments: splitSegments(size, this.connections) };
    await writeSegmentTable(this.segmentFile(task.id), table);
    return table;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
```

**注意**：`create` 里必须把 `link: input.link` 一起存进任务（`DownloadTask` 多了 `link` 字段），否则 `storedLink` 无处可取。

**`refreshLink` 的接线**：它由运行时注入，负责在直链失效时用任务的 `source` 重新调用对应适配器的 `link()`。接线代码放在 Task 11 的 Step 5 之后：

```ts
// src/core/runtime.ts
const downloads = new DownloadManager({
  http, stateDirectory: config.stateDirectory, outputDirectory: config.outputDirectory,
  outputBytesLimit: config.limits.outputBytes,
  refreshLink: async task => {
    const adapter = adaptersByPlatform.get(task.platform);
    if (!adapter) throw new ToolError('TOOL_FAILED', '该平台没有可用的适配器，无法重新取链。');
    const session = new NetdiskSession({ http, signal: new AbortController().signal });
    const context = {
      session, shareId: task.source.shareUrl, shareUrl: task.source.shareUrl,
      code: task.source.code, credential: resolveCredential(task.platform, config.stateDirectory),
      signal: new AbortController().signal, reportProgress: () => {},
    };
    const file: NetdiskFile = { id: task.source.fileId, path: task.source.filePath, name: task.fileName, sizeBytes: task.sizeBytes, isDirectory: false };
    return adapter.link(context, file);
  },
});
```

（`runtime.ts` 需要额外 import `adaptersByPlatform`、`NetdiskSession`、`resolveCredential`、`ToolError` 与 `NetdiskFile` 类型。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/core/download-manager.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/core/download/task-store.ts src/core/download/manager.ts tests/core/download-manager.test.ts
git commit -m "feat: 新增下载任务管理器，支持排队、暂停、继续与删除"
```

---

## Task 10: 下载任务 HTTP API

**Files:**
- Modify: `src/adapters/http/routes.ts`
- Modify: `src/core/runtime.ts`
- Test: `tests/adapters/http.test.ts`

**Interfaces:**
- Consumes: `DownloadManager`（Task 9）。
- Produces: HTTP 端点
  - `GET /api/downloads` → `{ tasks: DownloadTask[] }`
  - `GET /api/downloads/:id` → `DownloadTask`（404 当不存在）
  - `POST /api/downloads/:id/pause` → `{ paused: boolean }`
  - `POST /api/downloads/:id/resume` → `{ resumed: boolean }`
  - `DELETE /api/downloads/:id` → `{ removed: boolean }`
  - `GET /api/downloads/events` → SSE，推送 `{ tasks: DownloadTask[] }`

- [ ] **Step 1: 写失败测试**

追加到 `tests/adapters/http.test.ts`：

```ts
test('lists download tasks over http', async t => {
  const app = await appFor(t);
  const response = await app.inject({ method: 'GET', url: '/api/downloads' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().tasks, []);
});
```

**注意**：复用该文件里已有的 `appFor(t)` 辅助函数（`tests/adapters/http.test.ts:9`），不要自造。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/adapters/http.test.ts`
Expected: FAIL，404。

- [ ] **Step 3: 暴露管理器给路由**

改 `src/core/runtime.ts`：

```ts
import { DownloadManager } from './download/manager.js';

export function createRuntime(config: WorkstationConfig) {
  const registry = createRegistry();
  const store = new RunStore(config.stateDirectory);
  const http = createPublicHttp(config.limits.webBytes);
  const executor = new ToolExecutor(registry, config, store, { http, probes: createProcessProbe() });
  const downloads = new DownloadManager({
    http, stateDirectory: config.stateDirectory, outputDirectory: config.outputDirectory,
    outputBytesLimit: config.limits.outputBytes,
  });
  return { registry, store, executor, downloads };
}
```

- [ ] **Step 4: 加路由**

在 `src/adapters/http/routes.ts` 的 `registerRoutes` 里追加：

```ts
  app.get('/api/downloads', async () => ({ tasks: runtime.downloads.list() }));
  app.get<{ Params: { id: string } }>('/api/downloads/:id', async (request, reply) => {
    const task = runtime.downloads.get(request.params.id);
    if (!task) return reply.code(404).send({ error: { code: 'TOOL_NOT_FOUND', message: '没有找到该下载任务。' } });
    return task;
  });
  app.post<{ Params: { id: string } }>('/api/downloads/:id/pause', async (request) => ({ paused: runtime.downloads.pause(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/downloads/:id/resume', async (request) => ({ resumed: runtime.downloads.resume(request.params.id) }));
  app.delete<{ Params: { id: string } }>('/api/downloads/:id', async (request) => ({ removed: runtime.downloads.remove(request.params.id) }));
  app.get('/api/downloads/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (value: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(value)}\n\n`); };
    send({ tasks: runtime.downloads.list() });
    const unsubscribe = runtime.downloads.subscribe(tasks => send({ tasks }));
    const heartbeat = setInterval(() => { if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n'); }, 15_000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); if (!reply.raw.writableEnded) reply.raw.end(); };
    reply.raw.once('close', close);
    return reply;
  });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx tsx --test tests/adapters/http.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/adapters/http/routes.ts src/core/runtime.ts tests/adapters/http.test.ts
git commit -m "feat: 新增下载任务的查询、暂停、继续与删除接口"
```

---

## Task 11: `netdisk_download` 工具

**Files:**
- Create: `src/tools/netdisk-download.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/core/runtime.ts`（把 `DownloadManager` 注入工具上下文）
- Test: `tests/tools/netdisk-download.test.ts`

**Interfaces:**
- Consumes: `parseShareLink`、适配器、`DownloadManager`。
- Produces: 工具 `netdisk_download`。

- [ ] **Step 1: 写失败测试**

新建 `tests/tools/netdisk-download.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { netdiskDownloadTool } from '../../src/tools/netdisk-download.js';

test('rejects an unknown field in the input', () => {
  assert.equal(netdiskDownloadTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', oops: 1 }).success, false);
});

test('requires at least one path to download', () => {
  assert.equal(netdiskDownloadTool.inputSchema.safeParse({ url: 'https://pan.quark.cn/s/a', paths: [] }).success, false);
});

test('exposes a documented example', () => {
  assert.ok(netdiskDownloadTool.examples.length >= 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/tools/netdisk-download.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 给工具上下文加下载管理器**

`src/contracts/tool.ts` 的 `ToolContext` 增加：

```ts
export interface ToolContext {
  signal: AbortSignal;
  limits: Readonly<Limits>;
  stateDirectory: string;
  reportProgress?: (update: ProgressUpdate) => void;
  files?: FileAccess;
  output?: FileWriter;
  http?: PublicHttp;
  probes?: ProcessProbe;
  /** 新增：下载任务管理器。 */
  downloads?: DownloadManager;
}
```

`src/contracts/tool.ts` 顶部加 `import type { DownloadManager } from '../core/download/manager.js';`。

在 `src/core/executor.ts` 的 `ToolContext` 构造处加 `downloads: this.services.downloads,`，并把 `ToolExecutor` 构造函数的 `services` 类型改为 `{ http?: PublicHttp; probes?: ProcessProbe; downloads?: DownloadManager }`。

`src/core/runtime.ts` 里把 `downloads` 同时传给 executor：

```ts
  const executor = new ToolExecutor(registry, config, store, { http, probes: createProcessProbe(), downloads });
```

**注意**：`DownloadManager` 在 `runtime.ts` 里必须在 `executor` 之前创建。

- [ ] **Step 4: 实现工具**

新建 `src/tools/netdisk/paths.ts`：

```ts
/**
 * 把分享内的文件路径变成输出目录内安全的相对路径。
 * 平台给的路径可能带 id 与签名参数（例如蓝奏云的 iXXXX?sign=...），
 * 直接当文件名会含非法字符，必须换成展示用的文件名。
 */
export function safeOutputPath(filePath: string, fileName: string): string {
  const base = (fileName.trim() || filePath.split('/').pop() || 'download').split(/[\\/]/).pop() ?? 'download';
  const cleaned = base.replace(/[<>:"/\\|?*]/g, '_').replace(/[\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').slice(0, 120);
  return cleaned || 'download';
}
```

`src/tools/netdisk-download.ts`：

```ts
import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { NetdiskSession } from './netdisk/session.js';
import { adaptersByPlatform } from './netdisk/adapters/index.js';
import { parseShareLink, NETDISK_PLATFORM_LABELS } from './netdisk/share-link.js';
import { resolveCredential } from './netdisk/credentials.js';
import type { NetdiskLink } from './netdisk/types.js';

export const netdiskDownloadTool = defineTool({
  name: 'netdisk_download',
  title: '网盘文件下载',
  description: '解析网盘分享链接并把选中的文件加入下载队列。默认由工作站自己分片下载并断点续传；也可以把链接推给本机 Neat Download Manager 接管。任务在后台运行，可在「下载」页面查看进度。',
  category: 'web',
  capabilities: ['network:public', 'files:write'],
  timeoutMs: 120_000,
  fields: [
    { name: 'url', label: '分享链接或文案', type: 'textarea', description: '可以整段粘贴分享文案。' },
    { name: 'code', label: '提取码', type: 'text' },
    { name: 'paths', label: '要下载的文件路径', type: 'textarea', description: '每行一个分享内的相对路径。' },
    { name: 'backend', label: '下载方式', type: 'select', description: '默认由工作站自己下载。', options: [
      { label: '工作站内置下载（默认）', value: 'builtin' },
      { label: '交给 Neat Download Manager', value: 'ndm' },
    ] },
  ],
  examples: [
    { label: '下载一个分享里的文件', input: { url: 'https://pan.quark.cn/s/替换为你的分享码', paths: ['文件名'] } },
  ],
  inputSchema: z.strictObject({
    url: z.string().min(1),
    code: z.string().optional(),
    paths: z.array(z.string().min(1)).min(1),
    backend: z.enum(['builtin', 'ndm']).default('builtin'),
  }),
  outputSchema: z.strictObject({
    taskIds: z.array(z.string()),
    backend: z.enum(['builtin', 'ndm']),
    platform: z.string(),
    warnings: z.array(z.string()),
  }),
  async execute({ url, code, paths, backend }, ctx) {
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '当前环境未启用网络访问。');
    if (!ctx.downloads) throw new ToolError('ACCESS_DENIED', '当前环境未启用下载任务。');
    const parsed = parseShareLink(url);
    if (!parsed) throw new ToolError('INVALID_INPUT', '无法识别该链接的网盘平台。');
    if (parsed.platform === 'ilanzou') throw new ToolError('UNSUPPORTED_FORMAT', '蓝奏云优享版（ilanzou）官方没有分享解析接口，暂不支持。');
    const adapter = adaptersByPlatform.get(parsed.platform);
    if (!adapter) throw new ToolError('UNSUPPORTED_FORMAT', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 暂未接入解析。`);
    const credential = resolveCredential(parsed.platform, ctx.stateDirectory);
    if (adapter.requiresCredential && !credential) {
      throw new ToolError('ACCESS_DENIED', `${NETDISK_PLATFORM_LABELS[parsed.platform]} 需要登录态，请先配置凭证。`);
    }
    const session = new NetdiskSession({ http: ctx.http, signal: ctx.signal });
    const context = {
      session, shareId: parsed.shareId, shareUrl: parsed.shareUrl,
      code: code?.trim() || parsed.code, credential, signal: ctx.signal,
      reportProgress: (phase: string, percent?: number) => ctx.reportProgress?.({ phase, percent }),
    };
    ctx.reportProgress?.({ phase: '读取分享内容' });
    const share = await adapter.list(context);
    const wanted = share.files.filter(file => paths.includes(file.path));
    if (!wanted.length) throw new ToolError('FILE_NOT_FOUND', '分享里没有找到指定的文件路径。');
    const taskIds: string[] = [];
    const warnings: string[] = [];
    for (const [index, file] of wanted.entries()) {
      ctx.reportProgress?.({ phase: `取直链 ${index + 1}/${wanted.length}` });
      let link: NetdiskLink;
      try { link = await adapter.link(context, file); }
      catch (error) {
        warnings.push(`${file.path}：${error instanceof Error ? error.message : '取链失败'}`);
        continue;
      }
      const task = ctx.downloads.create({
        platform: parsed.platform, title: share.title, fileName: file.name, filePath: file.path,
        sizeBytes: file.sizeBytes, backend, source: link.source,
        outputPath: safeOutputPath(file.path, file.name), link,
      });
      taskIds.push(task.id);
    }
    if (!taskIds.length) throw new ToolError('TOOL_FAILED', '所有文件都没能取到直链。');
    return { taskIds, backend, platform: parsed.platform, warnings };
  },
});
```

- [ ] **Step 5: 注册工具**

在 `src/tools/index.ts` 加 `import { netdiskDownloadTool } from './netdisk-download.js';` 并加入 `createRegistry()` 的数组。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx tsx --test tests/tools/netdisk-download.test.ts`
Expected: PASS。

- [ ] **Step 7: 更新硬编码的工具数量**

把 Task 7 改过的两处再改回最终数量：

- `tests/e2e/workbench.spec.ts:18`：`toHaveLength(13)` → `14`
- `tests/production.test.ts:28`：`tools.length, 13` → `14`

Run: `npm test && npm run typecheck`
Expected: 全部通过，无类型错误。

- [ ] **Step 8: 提交**

```bash
git add src/tools/netdisk-download.ts src/tools/index.ts src/contracts/tool.ts src/core/executor.ts src/core/runtime.ts tests/tools/netdisk-download.test.ts tests/e2e/workbench.spec.ts tests/production.test.ts
git commit -m "feat: 新增网盘下载工具，把文件加入后台下载队列"
```

---

## Task 12: 前端——解析结果面板与下载任务页面

**Files:**
- Create: `src/web/components/NetdiskResult.tsx`
- Create: `src/web/pages/Downloads.tsx`
- Modify: `src/web/components/ResultPanel.tsx:27-33`
- Modify: `src/web/router.ts`
- Modify: `src/web/App.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/web/components/Shell.tsx`
- Modify: `src/web/presentation.ts`
- Test: `tests/e2e/workbench.spec.ts`

**Interfaces:**
- Consumes: `GET /api/downloads` 等（Task 10）、`netdisk_resolve` 的输出结构（Task 7）。
- Produces: `#/downloads` 路由；`NetdiskResult` 组件。

- [ ] **Step 1: 写失败测试**

在 `tests/e2e/workbench.spec.ts` 追加：

```ts
test('shows the netdisk resolve result with copyable links', async ({ page }) => {
  await openTool(page, 'netdisk_resolve');
  await expect(page.getByRole('heading', { name: '运行结果' })).toBeVisible();
});
```

**注意**：复用该文件里已有的 `openTool(page, name)` 辅助函数（`tests/e2e/workbench.spec.ts:4`），不要自造。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/e2e/workbench.spec.ts`
Expected: FAIL，找不到该工具页。

- [ ] **Step 3: 加前端 API 客户端**

在 `src/web/api.ts` 追加：

```ts
export interface DownloadTaskView {
  id: string; title: string; fileName: string; platform: string;
  status: string; bytesWritten: number; totalBytes: number | null;
  speedBytesPerSecond: number | null; createdAt: string; updatedAt: string;
  error?: { code: string; message: string };
}

export async function fetchDownloads(): Promise<DownloadTaskView[]> {
  const response = await fetch('/api/downloads');
  if (!response.ok) throw new Error('无法读取下载任务列表。');
  const data = await response.json() as { tasks?: DownloadTaskView[] };
  return data.tasks ?? [];
}

export async function pauseDownload(id: string): Promise<void> {
  await fetch(`/api/downloads/${encodeURIComponent(id)}/pause`, { method: 'POST' });
}

export async function resumeDownload(id: string): Promise<void> {
  await fetch(`/api/downloads/${encodeURIComponent(id)}/resume`, { method: 'POST' });
}

export async function removeDownload(id: string): Promise<void> {
  await fetch(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
```

- [ ] **Step 4: 加结果面板组件**

新建 `src/web/components/NetdiskResult.tsx`：

```tsx
import { useState } from 'react';
import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton.js';
import { DataTable, valueText } from './ResultData.js';
import { formatNumber } from '../presentation.js';
import { isRecord } from '../api.js';

interface NetdiskFile { path: string; name: string; sizeBytes: number | null; isDirectory: boolean; modifiedAt?: string }
interface NetdiskLink { path: string; name: string; sizeBytes: number | null; url: string; headers?: Record<string, string>; rangeSupported?: boolean | null; note?: string }

function curlCommand(link: NetdiskLink): string {
  const headers = Object.entries(link.headers ?? {}).map(([key, value]) => `-H "${key}: ${value}"`).join(' ');
  return `curl -L ${headers} -o "${link.name}" "${link.url}"`;
}

export function NetdiskResult({ data }: { data: Record<string, unknown> }) {
  const files = Array.isArray(data.files) ? data.files.filter(isRecord) as unknown as NetdiskFile[] : [];
  const links = Array.isArray(data.links) ? data.links.filter(isRecord) as unknown as NetdiskLink[] : [];
  const failures = Array.isArray(data.linkFailures) ? data.linkFailures.filter(isRecord) : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === 'string') : [];
  const [notice, setNotice] = useState('');
  const rows: ReactNode[][] = links.map(link => [
    valueText(link.name),
    formatNumber(link.sizeBytes),
    <code className="stream-url">{link.url}</code>,
    link.rangeSupported === false ? '不支持续传' : '支持续传',
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <CopyButton text={link.url} label="复制直链" />
      <CopyButton text={curlCommand(link)} label="复制 curl" />
    </span>,
  ]);
  return <div className="result-sections">
    <section><div className="result-section-heading"><h3>分享文件</h3><span>{files.length} 项</span></div>
      <DataTable label="分享文件列表" headers={['名称', '大小（字节）', '路径', '修改时间']} rows={files.map(file => [
        valueText(file.name), formatNumber(file.sizeBytes), valueText(file.path), valueText(file.modifiedAt),
      ])} />
    </section>
    {rows.length > 0 && <section><div className="result-section-heading"><h3>下载直链</h3><span>{rows.length} 条</span></div>
      <DataTable label="下载直链列表" headers={['名称', '大小（字节）', '直链', '续传', '操作']} rows={rows} />
      <p className="inline-note">直链通常在十几分钟内过期；「复制 curl」会带上 Referer、Cookie 等必须一起发送的请求头。</p>
    </section>}
    {failures.length > 0 && <section><div className="result-section-heading"><h3>取链失败</h3><span>{failures.length} 项</span></div>
      <DataTable label="取链失败列表" headers={['路径', '原因']} rows={failures.map(item => [valueText(item.path), valueText(item.reason)])} />
    </section>}
    {warnings.length > 0 && <ul className="inline-note">{warnings.map(item => <li key={item}>{item}</li>)}</ul>}
    {notice && <p className="inline-note">{notice}</p>}
  </div>;
}
```

- [ ] **Step 5: 注册结果视图**

`src/web/components/ResultPanel.tsx` 的 `ResultView` 里加一行：

```tsx
  if (tool === 'netdisk_resolve') return <NetdiskResult data={data} />;
```

并加 `import { NetdiskResult } from './NetdiskResult.js';`。

- [ ] **Step 6: 加下载任务页面**

新建 `src/web/pages/Downloads.tsx`：

```tsx
import { Pause, Play, Trash2, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchDownloads, pauseDownload, removeDownload, resumeDownload, type DownloadTaskView } from '../api.js';
import { EmptyState, ErrorNotice, Loading } from '../components/Feedback.js';
import { DataTable } from '../components/ResultData.js';
import { formatNumber } from '../presentation.js';

const statusLabels: Record<string, string> = {
  queued: '排队中', preparing: '准备中', downloading: '下载中', verifying: '校验中',
  completed: '已完成', paused: '已暂停', failed: '失败', cancelled: '已取消', handed_off: '已交给下载器',
};

export function Downloads() {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const next = await fetchDownloads(); if (active) { setTasks(next); setError(undefined); } }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '无法读取下载任务。'); }
      finally { if (active) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (loading) return <Loading label="正在读取下载任务" />;
  return <div className="page downloads-page">
    <section className="panel">
      <div className="panel-heading"><div className="panel-title"><h2>下载任务</h2></div>
        <button type="button" className="button button-secondary button-small" onClick={() => void openOutputFolder()}>
          <FolderOpen size={15} aria-hidden="true" />打开输出文件夹
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {!error && !tasks.length && <EmptyState title="还没有下载任务">在网盘解析结果里选择文件后即可开始下载。</EmptyState>}
      {tasks.length > 0 && <DataTable label="下载任务列表" headers={['文件', '平台', '状态', '进度', '速度', '操作']} rows={tasks.map(task => [
        task.fileName, task.platform, statusLabels[task.status] ?? task.status,
        task.totalBytes ? `${Math.round((task.bytesWritten / task.totalBytes) * 100)}%` : '—',
        task.speedBytesPerSecond ? `${formatNumber(task.speedBytesPerSecond)} B/s` : '—',
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {task.status === 'downloading' || task.status === 'preparing'
            ? <button type="button" className="button button-secondary button-small" onClick={() => void pauseDownload(task.id)}><Pause size={14} aria-hidden="true" />暂停</button>
            : <button type="button" className="button button-secondary button-small" onClick={() => void resumeDownload(task.id)}><Play size={14} aria-hidden="true" />继续</button>}
          <button type="button" className="button button-secondary button-small" onClick={() => void removeDownload(task.id)}><Trash2 size={14} aria-hidden="true" />删除</button>
        </span>,
      ])} />}
    </section>
  </div>;
}
```

`openOutputFolder` 从 `src/web/api.ts` 导入（该文件已导出 `openOutputFolder`）。

- [ ] **Step 7: 加路由与页面挂载**

`src/web/router.ts`：在 `Route` 联合类型里加 `'downloads'`，并加：

```ts
  if (path === '/downloads') return { page: 'downloads' };
```

`src/web/App.tsx`：渲染 `Downloads`。先读现有 `App.tsx` 的页面分派写法，按同样结构加：

```tsx
  if (route.page === 'downloads') return <Downloads />;
```

并加 `import { Downloads } from './pages/Downloads.js';`。

- [ ] **Step 8: 加顶栏指示与标签**

`src/web/components/Shell.tsx`：在 `topbar-actions` 里加一个 `<DownloadTasks />` 指示组件（与现有 `RunningTasks` 同构：订阅 `fetchDownloads`，有任务时显示数量，点击跳 `#/downloads`）。

`src/web/presentation.ts` 的 `resultLabels` 补：

```ts
  platformLabel: '网盘平台', shareId: '分享码', fileCount: '文件数', totalBytes: '总大小（字节）',
  links: '下载直链', linkFailures: '取链失败', credentialUsed: '使用了登录态', filePath: '文件路径',
  fileName: '文件名', isDirectory: '是文件夹', modifiedAt: '修改时间', rangeSupported: '支持续传',
```

- [ ] **Step 9: 跑测试确认通过**

Run: `npx playwright test tests/e2e/workbench.spec.ts`
Expected: PASS。

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 10: 提交**

```bash
git add src/web tests/e2e/workbench.spec.ts
git commit -m "feat: 新增网盘解析结果面板与下载任务页面"
```

---

## Task 13: NDM 可选后端

**Files:**
- Create: `src/core/ndm/client.ts`
- Modify: `src/contracts/tool.ts`（`Capability`）
- Modify: `src/core/executor.ts`（能力注入）
- Modify: `src/core/runtime.ts`
- Modify: `src/tools/netdisk-download.ts`（`backend: 'ndm'` 分支）
- Test: `tests/core/ndm-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/core/ndm/client.ts
  export interface NdmTarget {
    url: string;
    fileName: string;
    headers?: Record<string, string>;
  }
  export function buildNdmMessage(target: NdmTarget): string;
  export class NdmClient {
    constructor(options?: { port?: number; host?: string; timeoutMs?: number });
    /** NDM 没在运行时抛出 ToolError('ACCESS_DENIED')。 */
    async send(target: NdmTarget): Promise<void>;
  }
  ```

- [ ] **Step 1: 写失败测试**

新建 `tests/core/ndm-client.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNdmMessage } from '../../src/core/ndm/client.js';

test('builds the extension protocol message', () => {
  const message = buildNdmMessage({
    url: 'https://cdn.example.com/a.bin',
    fileName: 'a.bin',
    headers: { Referer: 'https://pan.quark.cn/', 'User-Agent': 'UA/1.0', Cookie: 'k=v' },
  });
  assert.ok(message.startsWith('1: GET\r\n'));
  assert.ok(message.includes('2: https://cdn.example.com/a.bin\r\n'));
  assert.ok(message.includes('4: a.bin\r\n'));
  assert.ok(message.includes('Referer: https://pan.quark.cn/\r\n'));
  assert.ok(message.includes('9: UA/1.0\r\n'));
  assert.ok(message.includes('Cookie: k=v\r\n'));
});

test('rejects a header value that would inject another field', () => {
  assert.throws(() => buildNdmMessage({
    url: 'https://cdn.example.com/a.bin', fileName: 'a.bin',
    headers: { Referer: 'https://x/\r\n2: https://evil/' },
  }), /请求头/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/core/ndm-client.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现客户端**

`src/core/ndm/client.ts`：

```ts
import { ToolError } from '../errors.js';

export interface NdmTarget {
  url: string;
  fileName: string;
  headers?: Record<string, string>;
}

const NDM_SUBPROTOCOL = 'neatextension.v1';

export function buildNdmMessage(target: NdmTarget): string {
  const headers = target.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new ToolError('INVALID_INPUT', `请求头 ${key} 含有非法字符。`);
    }
  }
  let message = '1: GET\r\n';
  message += `2: ${target.url}\r\n`;
  message += `4: ${target.fileName}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'referer') message += `Referer: ${value}\r\n`;
    else if (key.toLowerCase() === 'cookie') message += `Cookie: ${value}\r\n`;
    else if (key.toLowerCase() === 'origin') message += `Origin: ${value}\r\n`;
    else if (key.toLowerCase() === 'user-agent') message += `9: ${value}\r\n`;
    else message += `${key}: ${value}\r\n`;
  }
  message += 'Content-Disposition: attachment; filename="' + target.fileName.replace(/["\\]/g, '_') + '"\r\n';
  message += '\r\n';
  return message;
}

export class NdmClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options?: { port?: number; host?: string; timeoutMs?: number }) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 10007;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  async send(target: NdmTarget): Promise<void> {
    const message = buildNdmMessage(target);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${this.port}/download`, NDM_SUBPROTOCOL);
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new ToolError('ACCESS_DENIED', '连接本机 Neat Download Manager 超时，请确认它已启动。'));
      }, this.timeoutMs);
      socket.addEventListener('open', () => { socket.send(message); });
      socket.addEventListener('message', () => { clearTimeout(timer); socket.close(); resolve(); });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new ToolError('ACCESS_DENIED', '未检测到本机 Neat Download Manager，请先启动它再使用该后端。'));
      });
      socket.addEventListener('close', () => { clearTimeout(timer); });
    });
  }
}
```

- [ ] **Step 4: 加能力与注入**

`src/contracts/tool.ts` 的 `Capability` 改为：

```ts
export type Capability = 'files:read' | 'files:write' | 'network:public' | 'process:probe' | 'browser:local' | 'downloader:local';
```

`src/contracts/tool.ts` 的 `ToolContext` 增加 `ndm?: NdmClient;`（并加 `import type { NdmClient } from '../core/ndm/client.js';`）。

`src/core/executor.ts`：在 `ToolContext` 构造处加 `ndm: this.services.ndm,`，并把 services 类型加上 `ndm?: NdmClient`。

`src/core/runtime.ts`：

```ts
  const ndm = new NdmClient();
  const executor = new ToolExecutor(registry, config, store, { http, probes: createProcessProbe(), downloads, ndm });
```

- [ ] **Step 5: 接进下载工具**

`src/tools/netdisk-download.ts` 的 `execute` 里，在取到 `link` 之后、创建任务之前插入：

```ts
      if (backend === 'ndm') {
        if (!ctx.ndm) throw new ToolError('ACCESS_DENIED', '当前环境未启用本机下载器对接。');
        await ctx.ndm.send({ url: link.url, fileName: file.name, headers: link.headers });
        taskIds.push(`ndm-${Date.now()}-${index}`);
        continue;
      }
```

`backend === 'ndm'` 时不创建 `DownloadManager` 任务（协议不提供任务 ID 与进度）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx tsx --test tests/core/ndm-client.test.ts`
Expected: PASS。

Run: `npm run typecheck && npm test`
Expected: 全部通过。

- [ ] **Step 7: 真实验收**

先启动 NDM：

```bash
"/c/Program Files (x86)/Neat Download Manager/NeatDM.exe" &
```

确认端口：

```bash
netstat -ano | grep 10007
```

Expected: 出现 `127.0.0.1:10007 ... LISTENING`。

然后用一条真实直链推送：

```bash
npx tsx -e "
import { NdmClient } from './src/core/ndm/client.ts';
const client = new NdmClient();
await client.send({ url: '<真实直链>', fileName: 'test.bin', headers: { Referer: '<真实 Referer>', 'User-Agent': 'Mozilla/5.0' } });
console.log('已推送');
"
```

Expected: 输出 `已推送`，且 NDM 窗口出现该下载任务并开始下载。若 NDM 没启动，Expected: 抛出 `未检测到本机 Neat Download Manager`。

- [ ] **Step 8: 提交**

```bash
git add src/core/ndm/client.ts src/contracts/tool.ts src/core/executor.ts src/core/runtime.ts src/tools/netdisk-download.ts tests/core/ndm-client.test.ts
git commit -m "feat: 支持把网盘直链推给本机 Neat Download Manager 接管下载"
```

---

## Task 14–21: 其余八家网盘适配器

每个任务的结构相同，但协议细节不同。**每个任务都必须先写解析单元测试，再实现适配器，最后用真实链接实测**。下面给出每家的协议要点与测试要点。

### 所有适配器共用的骨架

每个适配器文件都导出**一个对象字面量**，形状与 Task 6 的蓝奏云完全一致，实现 `NetdiskAdapter` 的四个成员（`platform` / `label` / `requiresCredential` / `list` / `link`），并**额外导出可单测的纯函数**：

```ts
// src/tools/netdisk/adapters/<platform>.ts 的形状
export const <platform>Adapter: NetdiskAdapter & {
  /** 纯函数：从接口响应里抽出需要的字段，便于单测。 */
  parse<X>(raw: unknown): X;
} = {
  platform: '<platform>',
  label: '<中文名>',
  requiresCredential: <true | false>,
  async list(context: AdapterContext): Promise<NetdiskShare> { /* 见各家的协议要点 */ },
  async link(context: AdapterContext, file: NetdiskFile): Promise<NetdiskLink> { /* 见各家的协议要点 */ },
  parse<X>(raw: unknown): X { /* 见各家的测试要点 */ },
};
```

`link()` 的返回值必须满足这几条硬要求（所有适配器一致）：

- `url` 是**探测验证过**的最终可下载链接，不是接口返回的原始 URL
- `headers` 里带齐下载必需的请求头（`Referer` / `Cookie` / `User-Agent` / `Origin`）
- **不含账号级凭证**（BDUSS / Bearer JWT / accessToken 一律剥离）
- `rangeSupported` 由 `session.probe()` 的探测结果填（`206` 或 `Accept-Ranges: bytes` → `true`）
- `source` 填全重新取链所需信息（平台、分享链接、提取码、文件路径、文件 id）
- `note` 在有副作用或限制时写明（例如百度的转存、夸克的游客大小限制）

每个适配器写完后，在 `src/tools/netdisk/adapters/index.ts` 的 `adapters` 数组里注册。

### Task 14: 光鸭云盘

**Files:** Create `src/tools/netdisk/adapters/guangya.ts`；Modify `src/tools/netdisk/adapters/index.ts`；Test `tests/tools/netdisk-guangya.test.ts`

**协议要点**（全部 JSON POST，`token` 与 `device` 传 null 表示匿名）：

1. 分享摘要 → 标题
2. 用提取码换 `accessToken`
3. `listShareFiles(accessToken, parentId, cursor)` → 文件列表 + 下一页游标
4. `getShareDownloadUrl(file, accessToken)` → 下载地址；业务码 `207` 表示需登录转存

**翻页三级回落**（这是最容易写错的地方）：有 `hasMore` 就听它的；没有 `hasMore` 但有 `total`，用「下一页游标的数值偏移 < total」判断；两者都没有才用「本页满 100 条且给了游标」。

**测试要点**：

```ts
test('decides whether another page exists with the three level fallback', () => {
  assert.equal(guangyaAdapter.hasMore({ hasMore: false, cursor: '100', total: 300 }, 100, 100), true);
  assert.equal(guangyaAdapter.hasMore({ hasMore: true, cursor: '', total: 0 }, 100, 100), true);
  assert.equal(guangyaAdapter.hasMore({ cursor: '100', total: 100 }, 100, 100), false);
  assert.equal(guangyaAdapter.hasMore({ cursor: '100' }, 100, 100), false);
});
```

**出口条件**：一条真实光鸭分享链接能列出文件并取到直链。

### Task 15: 夸克

**协议要点**：全部 JSON POST。

1. `getShareToken`：body `{ pwd_id, passcode, support_visit_limit_private_share: true }` → `{ stoken, title, first_fid }`
2. `getShareFiles`：`GET` 分享详情，参数 `pwd_id` / `stoken` / `pdir_fid` / `ver=2` / `_page` / `_size`；**必须带 `Origin: https://pan.quark.cn` 与 `Referer: https://pan.quark.cn/`**，否则返回 400
3. `getShareDownloadLinkWithoutSave`：body `{ fids: [fid], fids_token: [share_fid_token], pwd_id, stoken, speedup_session: '', token: '' }` → `{ download_url, file_name, size }`

**游客限制**：服务端错误码 `23018` 表示"游客大小限制"，要转成明确提示。`31001` 表示登录态失效。

**测试要点**：

```ts
test('parses the share token payload', () => {
  assert.deepEqual(quarkAdapter.parseShareToken({ status: 200, data: { stoken: 's1', title: '标题', first_fid: 'f1' } }), { stoken: 's1', title: '标题', firstFid: 'f1' });
});

test('maps the guest size limit to a clear message', () => {
  assert.match(quarkAdapter.describeError(23018), /游客/);
  assert.match(quarkAdapter.describeError(31001), /登录/);
});
```

**出口条件**：真实夸克分享链接能列出文件并取到直链。

### Task 16: UC

**协议要点**：与夸克同构但端点与参数名不同（`drive.uc.cn`，分享详情路径、stoken 参数名都不同）。**独立写一份实现，不要复用夸克的函数**——两家的参数名漂移节奏不同，共用代码会在其中一家改版时连带弄坏另一家。

**测试要点**：至少覆盖链接识别（Task 3 已覆盖）与 token 解析，字段名与夸克不同。

**出口条件**：真实 UC 分享链接能列出文件并取到直链。

### Task 17: 115

**协议要点**：JSON GET。

1. `GET /share/snap?share_code=&receive_code=&offset=&limit=&asc=0&cid=0&format=json` → 文件列表 + 分享者 `user_id`
2. `GET /share/downurl?dl=1&user_id=&share_code=&file_id=&receive_code=` → `file_url_302`（另有 `url.url` 与 `url` 三种形态，都要兜住）
3. **直链请求必须用客户端 UA**——浏览器 UA 会被判"版本过低"直接拒发直链（错误码 50029）
4. 响应头会下发约 900 秒有效的 CDN Cookie，必须放进 `NetdiskLink.headers`

**测试要点**：

```ts
test('picks the first available url shape', () => {
  assert.equal(pan115Adapter.pickDownloadUrl({ file_url_302: 'https://a' }), 'https://a');
  assert.equal(pan115Adapter.pickDownloadUrl({ url: { url: 'https://b' } }), 'https://b');
  assert.equal(pan115Adapter.pickDownloadUrl({ url: 'https://c' }), 'https://c');
  assert.equal(pan115Adapter.pickDownloadUrl({}), null);
});
```

**出口条件**：真实 115 分享链接能列出文件并取到直链，且直链带 CDN Cookie。

### Task 18: 139（和彩云）

**协议要点**：JSON + AES-192-CBC 加解密。

1. 分享列表 `sharePostAnonymous`：body 是 `{ getOutLinkInfoReq: {...} }`，`account` 传空串且**不带鉴权头**
2. 请求与响应都按 AES-192-CBC 处理（24 字节密钥），密文前带 IV
3. 口令 XML 接口用另一把 24 字节密钥，**与列表接口的 16 字节密钥混用会得到 `01000019` 解密错误**
4. `mcloud-sign` 自定义签名
5. 取直链 `getShareDownloadLink`：`dlFromOutLinkReqV3` 结构，授权头可为空（游客）

**测试要点**：

```ts
test('decrypts a share list response', () => {
  const plain = JSON.stringify({ resultCode: '0' });
  const encrypted = c139Encrypt(plain, C139_KEY, C139_IV);
  assert.deepEqual(c139Decrypt(encrypted, C139_KEY, C139_IV), plain);
});
```

**出口条件**：真实 139 分享链接能列出文件并取到直链。

### Task 19: 123 云盘（需凭证）

**协议要点**：

1. `getShareFiles`：匿名 GET，参数 `shareKey` / `ParentFileId` / `Page` / `limit=100` / `next`；**有提取码时才带 `SharePwd`**，传空值会 400
2. `getShareDownloadLink`：**需登录 + Bearer JWT + 逆向签名**，`POST /b/api/share/download/info`，body `{ ShareKey, FileID, S3KeyFlag, Size, Etag }`
3. 返回的 `DownloadURL` 是 `download-v2` 包装 URL，Base64 解出 params 才得到真实 CDN 链
4. 下载需带 `Referer: https://yun.123pan.cn/`
5. 凭证：账号密码换 JWT，**换完即丢**，只留 token 在内存

**测试要点**：

```ts
test('decodes the download-v2 wrapper url', () => {
  const wrapped = pan123Adapter.wrapDownloadUrl('https://cdn.example.com/x?params=BASE64');
  assert.ok(pan123Adapter.decodeDownloadUrl(wrapped.url).startsWith('https://cdn.example.com/'));
});
```

**出口条件**：配置 123 凭证后，真实分享链接能列出文件并取到直链。

### Task 20: 迅雷（取直链需凭证）

**协议要点**：

1. 列目录：游客模式（`accessToken` 为空）时走 `panCallAnonymous`，不带验证码也不刷新 token；分享状态 `share_status` 为 `PASS_CODE_EMPTY` / `PASS_CODE_ERROR` / `PASS_CODE_NEED` 时必须单独识别，不能当成"目录为空"
2. 取直链：走需要 accessToken 的接口
3. 凭证：账号密码换 accessToken，**换完即丢**

**测试要点**：

```ts
test('recognises the passcode states instead of an empty folder', () => {
  assert.equal(xunleiAdapter.shareStatusError('PASS_CODE_NEED')?.includes('提取码'), true);
  assert.equal(xunleiAdapter.shareStatusError('PASS_CODE_ERROR')?.includes('不正确'), true);
  assert.equal(xunleiAdapter.shareStatusError('PASS_CODE_EMPTY')?.includes('提取码'), true);
  assert.equal(xunleiAdapter.shareStatusError('OK'), undefined);
});
```

**出口条件**：配置迅雷凭证后，真实分享链接能列出文件并取到直链。

### Task 21: 百度（需凭证，有转存副作用）

**协议要点**：

1. `verifyShare`：`POST /share/verify?surl=`（surl 不含开头的 "1"）→ `randsk`
2. `listShare`：`GET /rest/2.0/xpan/share?method=list&shorturl=&root=&dir=&sekey=`；**子目录必须带 `BDCLND` cookie**（= randsk），否则 errno=2；errno=-6 表示需要登录
3. **取直链必须先转存**到个人盘，再 `POST d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload&path=<转存后完整路径>`
4. 返回 `urls[]` 多个候选：**必须选 `encrypt=0` 的明文通道**（`appallNN.baidupcs.com`），`rank1` 的 `d2-ant` 是 AES-CTR 加密通道（内容需解密，且部分网络 TLS 握手失败）
5. **取链后清理临时转存**

**副作用告知**：`NetdiskLink.note` 里必须写明"该直链通过转存到你的百度网盘后取得，已在取链后清理"。

**测试要点**：

```ts
test('prefers the plain channel over the encrypted one', () => {
  const urls = [
    { url: 'https://d2-ant.baidu.com/x', encrypt: 1, rank: 1 },
    { url: 'https://appall00.baidupcs.com/x', encrypt: 0, rank: 2 },
  ];
  assert.equal(baiduAdapter.pickPlainUrl(urls), 'https://appall00.baidupcs.com/x');
});
```

**出口条件**：配置百度凭证后，真实分享链接能取到直链，且网盘里的临时转存被清理。

---

## Task 22: 文档回填

**Files:**
- Modify: `docs/superpowers/plans/2026-11-02-personal-workstation-plan.md`
- Modify: `README.md`

- [ ] **Step 1: 更新活文档 §8**

在 `docs/superpowers/plans/2026-11-02-personal-workstation-plan.md` 的 §8.7 之后追加 **8.9 网盘分享解析 `netdisk_resolve`** 与 **8.10 网盘下载 `netdisk_download`**，内容与 spec 的 §5、§8 一致：用途、输入、行为、输出、限制、验收。同时把 §8 开头那句"当前共 12 个注册工具"改成实际数量。

- [ ] **Step 2: 修订 §7.3 的登录态口径**

把 §7.3 第 8 条"只接受 HTML 文本响应，不执行 JavaScript、不使用登录态、不携带浏览器 Cookie"改成明确区分两类工具：网页抓取工具（`web_extract` 等）不携带登录态；网盘解析工具使用用户在状态目录内显式提供的网盘凭证，且凭证不进入输出、日志与运行摘要。

- [ ] **Step 3: 补 §9.2 的 CLI 命令**

在 §9.2 的命令清单里加入：

```bash
npm run cli -- credentials list
npm run cli -- credentials set baidu --bduss "..."
npm run cli -- credentials clear baidu
```

并说明凭证文件位置是 `<stateDirectory>/netdisk-credentials.json`。

- [ ] **Step 4: 补 §13 任务与 §15 测试矩阵**

§13 追加"任务 13：网盘分享解析与下载"；§15 的测试矩阵补三行：分享文案识别（各平台）、直链解析（各平台）、下载任务生命周期（创建 / 暂停 / 继续 / 删除 / 续传）。

- [ ] **Step 5: 更新 README**

`README.md` 当前只有 `# henrychips` 一行。补一段能力概览，把网盘分享解析与下载写进去，并说明凭证如何配置。

- [ ] **Step 6: 逐节核对文档与代码**

逐节核对 §8.9、§8.10、§7.3、§9.2、§13、§15 的每一句描述都能在代码里找到出处，对不上的地方改文档（不要改代码去迁就文档，除非是代码写错了）。

- [ ] **Step 7: 提交**

```bash
git add docs/superpowers/plans/2026-11-02-personal-workstation-plan.md README.md
git commit -m "docs: 回填网盘分享解析与下载到活文档"
```

---

## 实施顺序与依赖

```
Task 1  网络层扩展 ──┬──▶ Task 4  会话层 ──┬──▶ Task 6  蓝奏云 ──┐
                      │                     │                      ├──▶ Task 7  解析工具
                      └──▶ Task 2  流式写入 ─┴──▶ Task 8  分片内核 ─┤
                                              │                      │
                                              └──▶ Task 9  任务管理 ─┴──▶ Task 10  API ──▶ Task 11  下载工具 ──▶ Task 12  前端
Task 5  凭证 CLI ────────────────────────────────────────────────────────────────┘
Task 13 NDM 后端 ── 依赖 Task 11
Task 14–21 其余适配器 ── 依赖 Task 4 与 Task 6 的适配器写法，各自可并行
Task 22 文档回填 ── 依赖全部功能任务完成
```

**先做顺序**：1 → 2 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14…21 → 22。

**并行机会**：Task 14–21 这八个适配器互不依赖，可以分给不同的 agent 同时做，各自按 Task 6 的适配器写法。

## 验收清单

全部任务完成后，以下每一条都要能当场演示：

- [ ] `npm run typecheck` 无错误
- [ ] `npm test` 全部通过
- [ ] `npm run test:e2e` 全部通过
- [ ] `npm run cli -- list` 显示 15 个工具
- [ ] 9 家平台各有一条真实分享链接能解析出文件列表与直链（不通的平台在文档中标注状态）
- [ ] 一条直链的「复制 curl」命令在终端里能真的下到文件
- [ ] 一个 2GB 文件下载中途杀进程，重启后从断点继续且文件校验一致
- [ ] 直链过期后下载任务自动重新取链并续传
- [ ] 任务在下载任务页面能看到进度、能暂停能继续能删除
- [ ] 选中 `ndm` 后端时，NDM 窗口出现对应任务并开始下载
- [ ] 活文档 §7.3、§8.9、§8.10、§9.2、§13、§15 与代码逐句一致
