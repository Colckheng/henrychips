# 网盘分享解析与下载：设计文档

- 日期：2026-11-12
- 状态：待评审
- 参考项目：[CYQawa/YunX](https://github.com/CYQawa/YunX)（AGPL-3.0，仅作协议流程参考，不复制代码）

## 1. 背景与目标

工作台目前有 12 个工具，能解析 B 站 / 抖音的视频直链，但无法处理网盘分享链接。用户希望在工作台里粘贴一个网盘分享链接，直接看到文件列表、拿到下载直链，并把文件下载到本机。

参考项目 YunX 是安卓端的网盘解析 + 下载应用。它的核心原理是：**各网盘都不开放官方 API，YunX 用逆向还原的私有 Web 接口把分享链接翻译成有时效的直链，再用通用下载器拉下来**。可复用的是"正则识别分享链接 → 每家平台一个适配器 → 通用下载内核"的组织方式；每家的私有协议必须逐家实测还原。

## 2. 范围

### 2.1 本轮交付

| 交付物 | 说明 |
| --- | --- |
| 网盘分享解析工具 | 粘贴分享文案 → 识别平台 → 列出文件 → 产出已验证的下载直链（含必需请求头） |
| 网盘凭证管理 | CLI 子命令管理网盘凭证（`credentials set` / `list` / `clear`），凭证存放在 git 忽略的状态目录内 |
| 内置下载任务子系统 | 创建下载任务 → 后台分片下载 → 断点续传 → 进度可见 → 落盘到输出目录 |
| NDM 可选后端 | 把直链推给本机 Neat Download Manager 接管下载；未安装 NDM 时该后端不可用，不影响默认后端 |

### 2.2 明确不做

- 不做 BT / 磁力 / HLS / ed2k 下载。
- 不做网盘账号的注册、验证码处理与图形化登录界面。
- 不做"转存到我的网盘"作为独立功能（仅百度的直链链路内部需要转存，取链后立即清理）。
- 不做"下载文件再上传回网盘"之类的组合工作流。
- 不做子目录批量下载的自动展开（文件树照常展示，下载按选择的具体路径）。

### 2.3 平台范围

目标 9 家：蓝奏云、光鸭云盘、夸克、UC、115、139（和彩云）、123 云盘、迅雷、百度。

- **蓝奏云优享版**（`ilanzou.com`）不在范围内：官方没有分享解析接口，识别到链接时返回明确提示。
- 每家平台的私有接口随时可能变更。某家实测不通时，该平台在工具内返回明确错误，并在本文档与活文档中标注"当前不可用"，**不返回猜测数据，不假装支持**。

## 3. 现状约束（代码事实）

以下是本仓库当前的硬约束，设计必须建立在它们之上。

| 约束 | 位置 | 影响 |
| --- | --- | --- |
| 工具超时硬上限 120 秒 | `src/core/executor.ts:124`，`Math.min(declared, 120_000)` | 单次工具调用装不下一个大文件 |
| 工具并发上限 4 | `src/core/executor.ts:118` | 长下载不能占住工具槽位 |
| 公网客户端只有 GET | `src/core/public-http.ts:116` | 网盘取链全是 POST，需要扩展契约 |
| 请求头白名单 7 项 | `src/core/public-http.ts:87` | 缺 `range`、`x-requested-with`、`authorization` 等网盘必需头 |
| 响应体超时 10 秒 | `src/core/public-http.ts:118`，`bodyTimeout: 10_000` | 慢速分片会在 10 秒无数据时被杀 |
| 只接受 `identity` 编码 | `src/core/public-http.ts:150` | 与 NDM 行为一致，gzip 响应一律拒绝 |
| 输出写入要求整个 buffer 在内存 | `src/core/file-access.ts:127`，`createFileWriter` | 大文件必须新增流式写入通道 |
| 下载与输出上限各 200 MB | `workstation.config.json`，`downloadBytes` / `outputBytes` | 现有 B 站 / 抖音工具的天花板 |
| 能力枚举 | `src/contracts/tool.ts:52` | 新增 NDM 后端需要新增一项 |
| `workstation.config.json` 被 git 跟踪 | `git ls-files` | 凭证不能放配置里，会随提交进入仓库历史 |
| 运行上下文按能力注入 | `src/core/executor.ts:135-138` | 新能力沿用同一注入模式 |
| 进度只覆盖单次运行、5 分钟过期 | `src/core/progress.ts` | 下载任务是长时状态，需要独立的状态通道 |

## 4. 架构总览

```
                       ┌─────────────────────────────┐
   分享文案  ──────────▶│  netdisk_resolve（工具）      │
                       │  · 识别平台 + 提取码          │
                       │  · 适配器 list() 列文件        │
                       │  · 适配器 link() 取直链        │
                       │  · 探测验证 → 可用直链         │
                       └──────────┬──────────────────┘
                                  │ NetdiskLink[]（url + headers）
                       ┌──────────▼──────────────────┐
                       │  netdisk_download（工具）     │
                       │  backend = builtin | ndm      │
                       └──────────┬──────────────────┘
                                  │ 创建任务，立即返回 taskId
        ┌─────────────────────────┼─────────────────────────┐
        │ builtin                                      ndm    │
┌───────▼────────┐                              ┌────────────▼──────────┐
│ DownloadManager │                              │ NdmClient            │
│  · 任务表(持久化) │                              │  ws://127.0.0.1:10007 │
│  · 调度器(并发)   │                              │  /download           │
│  · 分片下载内核   │                              │  子协议 neatextension │
│  · 直链过期重取链 │                              │  .v1                │
└───────┬────────┘                              └───────────────────────┘
        │
┌───────▼────────┐
│ 流式写入器       │  FileWriter.open() → 可写句柄
│ 预分配 + 分段写  │  .part 文件 + segments.json
└────────────────┘
```

三条边界：

1. **适配器只负责平台协议**（怎么换 token、怎么列目录、怎么取直链），不管 HTTP 细节、不管错误文案、不管进度。
2. **下载器只负责通用下载机制**（分片、续传、过期重取链、落盘），不认识任何具体平台。
3. **平台与下载器的唯一接口是 `NetdiskLink`**（URL + 必需请求头 + 文件元信息 + 取链参数）。

## 5. 模块一：网盘分享解析

### 5.1 目录结构

```
src/tools/netdisk/
  types.ts            平台无关类型 + NetdiskAdapter 接口
  share-link.ts       分享文案 → { platform, shareId, code }
  credentials.ts      凭证读取与换取
  session.ts          NetdiskSession：POST/GET + 按 host 隔离的 cookie jar + 退避
  adapters/
    lanzou.ts  quark.ts  uc.ts  pan115.ts  c139.ts
    pan123.ts  xunlei.ts guangya.ts  baidu.ts
    index.ts           适配器注册表
src/tools/netdisk-resolve.ts    工具定义
```

### 5.2 分享链接识别

`share-link.ts` 从任意分享文案中提取平台、`shareId` 与提取码。

- 每家平台一条规则，规则由**域名**与**路径形态**两部分组成：域名必须锚定解析后的 hostname，不能拿整串 URL 做子串匹配，否则镜像站/跳转站会被误判成平台链接。
- 提取码有四个来源，按优先级：URL 参数（各平台参数名不同，如 `?pwd=` `?pass=` `?passcode=` `?password=`）→ 平台特有的口令形式（115 的 `code-提取码`）→ 文案中的「提取码：xxxx」「访问码：xxxx」→ 用户在表单里显式填写。115 命令式内嵌码优先于文案，因为内嵌码才是与该分享绑定的那一个，文案只作最后兜底。
- 蓝奏云域名族必须覆盖 `lanzou*` / `lan[zs]o[ux]` / `lanzn`（2026-10 起在用的新族），且**判平台**与**抠 shareId** 两处必须用同一份域名族定义，避免"认得出却判不是蓝奏"。
- 优享版域名 `ilanzou.*` 优先于蓝奏云判断，避免混淆。
- 蓝奏云的分享路径有前缀形态：`/{id}`、`/i/{id}`（文件）、`/b/{id}`（文件夹）、`/s/{id}`。识别器必须跳过前缀取到真正的 shareId，并把"文件还是文件夹"带给适配器。
- 跳过前缀只认**已知保留前缀集**（`i` / `b` / `s`）：单字母段不在保留集里时，它是合法的分享码而不是前缀。这样单字符分享码不会被整条链接丢掉；代价是遇到未知的单字母前缀路径时会退化成取到那个字母——适配器应以分享页自身的目录标记为准。

### 5.3 适配器契约

```ts
export type NetdiskPlatform =
  | 'lanzou' | 'ilanzou' | 'guangya' | 'quark' | 'uc' | 'pan115'
  | 'c139' | 'pan123' | 'xunlei' | 'baidu';

export interface NetdiskFile {
  id: string;              // 平台内部标识
  path: string;            // 分享内相对路径，用户可读、可粘贴、用于定位
  name: string;
  sizeBytes: number | null;
  isDirectory: boolean;
  modifiedAt?: string;
}

export interface NetdiskLink {
  path: string;
  name: string;
  sizeBytes: number | null;
  url: string;                          // 已验证可下载的 CDN 直链
  headers: Record<string, string>;      // 下载时必须携带的请求头（Referer / Cookie / UA / Origin）
  rangeSupported: boolean | null;       // null = 尚未探测
  expiresAt?: string;                   // 能推算失效时间时给出
  source: NetdiskSource;                // 重新取链所需的全部信息
  note?: string;                        // 例："游客通道有大小限制"
}

/** 重新取链所需的全部信息，直链过期后据此重建。 */
export interface NetdiskSource {
  platform: NetdiskPlatform;
  shareUrl: string;
  code: string | null;
  filePath: string;
  fileId: string;
}

export interface NetdiskAdapter {
  platform: NetdiskPlatform;
  label: string;
  requiresCredential: boolean;
  list(ctx: AdapterContext): Promise<NetdiskShare>;
  link(ctx: AdapterContext, file: NetdiskFile): Promise<NetdiskLink>;
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
```

`NetdiskShare` = `{ title, files: NetdiskFile[], token?: unknown }`。`token` 是平台自己的会话态（如夸克的 `stoken`），只在单次工具调用内透传，不跨调用持久化。

### 5.4 直链的定义

**工具产出的「直链」= 已探测验证过、可直接下载的最终链接**，不是接口返回的原始 URL。理由：各平台的下载地址往往还要再走一步才能变成真链。

- 蓝奏云：分享页 → 下载参数（sign）→ 下载节点 URL → 可能返回「验证并下载」的 HTML 页（解析 `data:{file, el, sign}` 再提交一次）→ 可能撞上 `acw_sc__v2` 人机校验（算出 Cookie 重放）→ 最终 CDN 链接。下载节点还要求注入 `down_ip=1` Cookie。
- 百度：`locatedownload` 返回多个候选，`rank1` 的 `d2-ant` 是 AES-CTR 加密通道（内容需解密、部分网络 TLS 握手失败），`rank2+` 的 `appall.baidupcs.com` 是明文通道。**统一选明文通道**，并在 `note` 里说明。
- 115：直链响应头会下发约 900 秒有效的 CDN Cookie，必须连同该 Cookie 一起交付。
- 123：`download-v2` 是 Base64 包装 URL，解开才是 CDN 链；下载需带 `Referer: https://yun.123pan.cn/`。
- 夸克 / UC：游客取链走同一端点，`speedup_session` 与 `token` 留空；接口需带 `Origin: https://pan.quark.cn` 与 `Referer`。

探测与验证都放在适配器内部，因为各家方式不同。**Range 能力探测同样放在适配器里**：探测请求必须带该平台自己的 Cookie、User-Agent 与 Referer，只有适配器握有这些上下文。下载器只消费结论（`NetdiskLink.rangeSupported`），不关心它是怎么探出来的。

### 5.5 凭证体系

三家的直链必须登录态：迅雷（取直链需 accessToken）、百度（需 BDUSS，且必须先转存）、123（需 Bearer JWT + 签名）。

**存放位置**：`<stateDirectory>/netdisk-credentials.json`，即 `.workstation/netdisk-credentials.json`。

不放在 `workstation.config.json` 里，因为**该配置文件是被 git 跟踪的**（`git ls-files` 可见），凭证写进去会在下一次提交时进入仓库历史。`.workstation/` 已在 `.gitignore` 中，不会外泄。

**结构**：

```json
{
  "baidu":  { "bduss": "..." },
  "pan123": { "username": "...", "password": "..." },
  "xunlei": { "username": "...", "password": "..." }
}
```

**写入方式**：提供 CLI 子命令，不让用户手改 JSON（手改容易写错字段名，且难以保证权限）。

```
npm run cli -- credentials list
npm run cli -- credentials set baidu --bduss "..."
npm run cli -- credentials set pan123 --username "..." --password "..."
npm run cli -- credentials clear xunlei
```

写入时文件权限设为 `0600`（Windows 上通过 `chmod` 尽力而为；NTFS 权限由用户自行用文件属性或 BitLocker 兜底）。文件内容不进运行摘要、不进日志。

**优先级**：环境变量 `HENRY_NETDISK_BAIDU_BDUSS` / `HENRY_NETDISK_PAN123_USERNAME` / `HENRY_NETDISK_PAN123_PASSWORD` / `HENRY_NETDISK_XUNLEI_USERNAME` / `HENRY_NETDISK_XUNLEI_PASSWORD` 优先于文件，便于不落盘的场景。

**账号密码不落盘到运行产物**：123 与迅雷的账号密码在运行时换取 token（JWT / accessToken），换完即丢，只把 token 与过期时间保留在内存供本次调用使用。

**百度的 BDUSS** 是会话串，无法换取，只能存文件。

**不做口令加密**。理由：这是单人单机工作站，凭证文件已在 git 忽略目录内并限制为 0600；YunX 那种"用户口令派生密钥"的方案面向的是移动端多用户场景，在这里需要一个额外的口令输入界面与口令管理流程，成本高于收益，且口令本身仍需在某处保存。文档中明确提示该文件的敏感性，并建议在共享机器上用 NTFS 权限或 BitLocker 兜底。

**账号级凭证不进工具输出**。`NetdiskLink.headers` 里放的是**下载时必需的请求头**（`Referer` / `User-Agent` / `Origin` / 该 CDN 自己的短期签名 Cookie），这些是直链能用的前提，必须交付给用户。适配器在产出 `NetdiskLink` 时必须剥离账号级凭证（百度的 BDUSS、123 的 Bearer JWT、迅雷的 accessToken）——它们只用于换取直链，不能随输出泄漏。工具输出只报告 `credentialUsed: boolean`。

### 5.6 网络层契约改动

`PublicHttp` 增加两个方法，**完全复用现有 SSRF 防护**（DNS pinning、每次重定向重新校验、私网 / 回环 / 保留地址拦截、端口白名单、响应体上限、取消传播）：

```ts
postForm(url, fields, signal, options)   // application/x-www-form-urlencoded
postJson(url, body, signal, options)    // application/json
```

**请求头白名单**（`safeRequestHeaders`）从 7 项扩到 17 项，新增网盘实际需要的：`range`、`authorization`、`x-requested-with`、`x-api-version`、`x-device-id`、`x-client-type`、`x-app-version`、`x-os-version`、`x-source`、`x-source-version`。仍然禁止 `host` / `content-length` / `connection` / `transfer-encoding`，仍然过滤 CR/LF。

其中 `authorization` 是 123 云盘 Bearer JWT 的载体。这会让"任何工具都能发任意授权头"成为可能，因此配套约束：只有网盘适配器会设置它，`web_extract` 等网页工具从不设置；凭证值由适配器从配置读取，不经过用户输入。

`range` 必须在白名单里，否则请求头会被静默丢弃（[public-http.ts:89](file:///D:/HenryChips/src/core/public-http.ts#L89) 只保留白名单内的头），分片请求会全部退化成整文件下载。

**Cookie 隔离**：`NetdiskSession` 维护 `Map<host, Map<name, value>>`，Cookie 只发回原 host。夸克的 Cookie 绝不会发给 115。这一点由 `NetdiskSession` 内部强制，不依赖调用方自觉——**调用方传入的 `Cookie` 请求头一律被剥离**，Cookie 只能通过 `setCookie()` 进入本域的 jar。`Authorization` 同理：按 host 存储，调用方传入的 `authorization` 头一律剥离，账号级令牌通过 `setAuthorization(url, token)` 进入本域。

**跨 host 重定向不得携带凭证**：`PublicHttp` 跟随重定向时，若目标 host 与当前 host 不同，剥掉 `cookie` 与 `authorization` 两个凭证类请求头，并把请求降级为 GET、丢弃请求体（请求体里也可能带令牌）。网盘的「分享页 → CDN」是常态的跨 host 重定向，不剥就会把登录态发到 CDN。同 host 重定向保留凭证与请求体。

**响应 Cookie 的捕获**：部分平台（115 的 CDN Cookie 约 900 秒有效）把会话凭证放在响应 `Set-Cookie` 里，适配器必须能读到并交给下游。因此会话层要提供能拿到原始响应头与 `Set-Cookie` 的方法，且**重定向链上每一跳的 `Set-Cookie` 都要收集**——「先下发 cookie、再重定向到 CDN」是常见模式，只报最终响应的 cookie 会漏掉它。

**限速退避**：`NetdiskSession` 只负责**最小请求间隔**（默认 250ms，按 host 计，不同平台之间互不影响）。失败重试与退避策略（蓝奏云分页间隔、连续失败按 `600ms × (失败次数 + 1)` 退避、最多 3 次重试、命中"请求过于频繁"时只退避重试同一页不跳页）由**适配器**按平台实现，因为各平台的风控形态不同，会话层不该知道。

**响应体超时**：通用工具仍保持 10 秒。下载场景由新增的流式接口单独指定更长超时（见 6.2），不改通用路径。

### 5.7 平台清单与实现顺序

按"匿名程度高、接口简单"排序，前面的跑通用框架，后面的复用。

| 顺序 | 平台 | 接口形态 | 凭证 | 主要难点 |
| --- | --- | --- | --- | --- |
| 1 | 蓝奏云 | HTML + POST form | — | 域名族多、人机校验 Cookie、文件夹成员需二次落地、分页退避、下载节点二次验证 |
| 2 | 光鸭 | JSON POST | — | 翻页三级回落判定（`hasMore` → `total` → 满页） |
| 3 | 夸克 | JSON POST | — | 游客取链、`Origin`/`Referer` 必带、`stoken` 透传 |
| 4 | UC | JSON POST | — | 与夸克同构但参数名有差异 |
| 5 | 115 | JSON GET | — | 直链必须用客户端 UA（浏览器 UA 被判版本过低）、需要分享者 `user_id` |
| 6 | 139 | JSON + AES-CBC | — | 分享接口 AES-192-CBC 加解密、`mcloud-sign` 签名 |
| 7 | 123 | JSON GET + 签名 POST | ✅ | 列表匿名无签名，直链需 JWT + 逆向签名 |
| 8 | 迅雷 | JSON GET | ✅ | 游客列目录 + 登录取直链、`captchaToken` 流程 |
| 9 | 百度 | GET + 转存 + POST | ✅ | 必须先转存到个人盘再 `locatedownload`；有副作用，取链后清理 |

**验证顺序即实现顺序**：每家平台先写一个能独立跑的验收命令，跑通真实分享链接后再并入工具。

```bash
npm run cli -- run netdisk_resolve --input '{"url":"<真实分享链接>","code":"xxxx"}'
```

## 6. 模块二：内置下载任务子系统

### 6.1 任务模型与持久化

工具契约是"一次调用 → 一个结果"，下载是分钟到小时级的长任务。**下载不占用工具运行模型**。

- 工具 `netdisk_download` 创建任务后**立即返回** `taskId`，不等下载完成。
- 下载在独立的 `DownloadManager` 里跑，**不占 `ToolExecutor` 的 4 个并发槽位**，也不受 120 秒工具超时约束。
- 任务状态持久化在 `.workstation/downloads/`（`stateDirectory` 下，已在 `.gitignore`）：
  - `tasks.json`：任务索引与元信息
  - `<taskId>/`：数据文件 `.part` + `segments.json`（分段表）

任务状态机：

```
queued ──▶ preparing ──▶ downloading ──▶ verifying ──▶ completed
              │               │  ▲             │
              │               ▼  │             ▼
              │            paused ─┘          failed
              │               │               │
              └───────────────┴───────────────┘
                          (cancelled)

ndm 后端不走上面的状态机，直接落到：
queued ──▶ handed_off        （已推送给 NDM，工作站不再跟踪其进度）
```

任务记录字段：

```ts
interface DownloadTask {
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
  /** 重新取链所需的全部信息 */
  source: NetdiskSource;
  /** 目标输出文件相对路径 */
  outputPath: string;
}
```

### 6.2 流式落盘（地基）

现有 `FileWriter.write(relativePath, bytes)` 要求整个文件在内存里。新增流式通道：

```ts
// contracts/tool.ts
export interface FileWriter {
  write(relativePath: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<{ relativePath: string; bytes: number }>;
  /** 新增：打开一个可写句柄，调用方负责 close。 */
  open(relativePath: string, options?: { overwrite?: boolean; truncateTo?: number }): Promise<FileHandle>;
}

export interface FileHandle {
  readonly relativePath: string;
  /** 在指定偏移写入，返回写入字节数。 */
  writeAt(buffer: Uint8Array, position: number): Promise<number>;
  bytesWritten(): number;
  close(): Promise<void>;
}
```

- `open` 沿用现有路径安全检查（相对路径、拒绝 `..`、拒绝符号链接、拒绝设备名与 Windows 保留名），`realpath` 校验目录边界。
- `truncateTo` 用于预分配：分片下载前先把文件扩到总大小，各段用 `writeAt(buffer, position)` 写入自己那一段，互不覆盖。
- 单文件字节上限沿用 `outputBytes` 配置项，但不再受内存限制。

`PublicHttp` 相应增加流式 GET：

```ts
getStream(url, signal, options): Promise<{ finalUrl, status, contentType, contentLength: number | null, body: Readable }>
```

- 复用现有 SSRF 防护与重定向校验。
- `bodyTimeout` 由 `options.timeoutMs` 指定（下载场景默认 60 秒无数据容忍），通用路径不变。
- 响应仍要求 `identity` 编码，与 NDM 行为一致。

### 6.3 分片下载内核

**Range 能力探测**（在适配器的 `link()` 收尾时做一次，结论写进 `NetdiskLink.rangeSupported`）：

1. 发 `HEAD`，读 `Content-Length` 与 `Accept-Ranges`。
2. HEAD 不可靠时发 `Range: bytes=0-0`，看是否返回 `206` 与 `Content-Range`。
3. 两者都不可用 → `rangeSupported = false`。

**分片策略**：

- 支持 Range：把文件按总大小切成 N 段（默认 8，可配置），每段一个独立 HTTP 请求，用 `writeAt(buffer, position)` 写入自己的区间。段表持久化到 `segments.json`，每段记录 `{ start, end, done }`，进程重启后可续传。
- 不支持 Range：退化为单流直下，不分片、不可续传。**直链过期后无法续传，只能重头下并明确告知用户。**

**动态分段**（可选增强，非必需）：每 5 秒统计各段实测速度，把慢段的未完成份额按比例匀给快段，重新分配区间边界。分段边界重划时，已写入的字节不移动（每段记录自己的区间，只改未完成部分）。

**下载内核不认识任何平台**：它只吃 `NetdiskLink`，平台差异全部止步于适配器。

### 6.4 直链过期与重新取链

网盘直链 15 分钟内可能失效（115 的 CDN Cookie 约 900 秒，百度的 `locatedownload` 返回带 `expires` 的 URL）。**这不是例外而是常态**，因此：

- 任务记录保存 `source`（平台 + 分享链接 + 提取码 + 文件路径 + 文件 id）。
- 下载过程中检测到直链失效（403 / 404 / 410，或响应体是 HTML 而不是文件内容）：调用该平台的适配器 `link()` **重新取链**，拿到新 URL 与新请求头。
- 若 `rangeSupported === true`：从已下载位置续传（`Range: bytes=<已写字节>-`）。
- 若 `rangeSupported === false`：无法续传，任务转为 `failed`，错误信息明确写"该平台直链不支持断点续传，直链过期后需要重新开始"。

重新取链最多尝试 3 次，每次间隔 2 秒；仍失败则任务失败并保留已下载的 `.part` 文件（不自动删除）。

### 6.5 调度与并发

- `DownloadManager` 维护一个就绪队列，最多同时运行 3 个下载任务（可配置），每个任务最多 8 个并发连接（可配置）。
- 任务不占用 `ToolExecutor` 的并发槽位，也不受 `toolTimeoutMs` 约束。单个任务内部有自己的停滞检测（默认 60 秒无字节写入即判定失败）。
- 暂停通过 `AbortController` 中止当前 HTTP 请求，已下载的分段数据保留在 `.part` 文件里；继续时重取直链并按 `segments.json` 续传。

### 6.6 HTTP API

新增端点（沿用现有 `src/adapters/http/routes.ts` 的结构与错误映射）：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/downloads` | 任务列表（按创建时间倒序） |
| `GET /api/downloads/:id` | 单任务详情 |
| `POST /api/downloads/:id/pause` | 暂停 |
| `POST /api/downloads/:id/resume` | 继续 |
| `DELETE /api/downloads/:id` | 删除任务（连带删除 `.part` 与分段表） |
| `GET /api/downloads/events` | SSE：任务状态与进度推送 |

SSE 不可用时前端降级为轮询 `GET /api/downloads`（与现有运行进度的降级策略一致）。

## 7. 模块三：NDM 可选后端

### 7.1 依据

NDM（Neat Download Manager）是闭源软件，本机已安装于 `C:\Program Files (x86)\Neat Download Manager\NeatDM.exe`，**不能内置**（闭源二进制再分发有授权问题，且无嵌入接口）。但 NDM 内置了一个本地 WebSocket 服务端，官方浏览器扩展正是靠它把下载链接推给 NDM。

- 地址：`ws://127.0.0.1:10007/download`
- 子协议：`neatextension.v1`
- 消息格式：**裸 HTTP 请求文本**，用编号键，不是 JSON

```
1: GET
2: <url>
4: <文件名>
7: <Content-Length>
8: <Content-Type>
9: <User-Agent>
Origin: <origin>
Referer: <referer>
Cookie: <cookie>
Content-Disposition: <disposition>
x-xxx: <自定义头>
```

NDM 只回复三种：`waiting`（忙）、`nowaiting`（空闲）、版本串。

服务端行为（读 NDM 自己的任务日志确认）：默认 8 个连接；使用 `Range: bytes=0-` 请求，支持分段与断点续传；主动要求 `Accept-Encoding: identity`；**不支持 gzip 编码的响应**。

### 7.2 实现

- `Capability` 新增 `'downloader:local'`（`src/contracts/tool.ts:52`），文案"调用本机下载器"。
- 新增 `src/core/ndm/client.ts`：用 Node 内置的 `globalThis.WebSocket` 连接并发送协议消息（本机实测 Node 22.23.4 提供该全局对象；本仓库 `package.json` 要求 Node >= 22.13.0，该全局对象自 22.4.0 起随 Node 内置）。约 80 行。
- 沿用现有能力注入模式，在 `src/core/executor.ts:135-138` 附近按 capability 注入客户端。
- 连接失败（NDM 未运行）→ `ToolError('ACCESS_DENIED', '未检测到本机 Neat Download Manager，请先启动它再使用该后端。')`。

### 7.3 行为与限制

- 任务状态为 `handed_off`：工作站只知道"已推送"，**拿不到进度、任务 ID 与完成状态**——NDM 协议不提供这些。
- 下载文件落在 NDM 自己配置的下载目录，不在工作站的 `outputDirectory`。
- NDM 不支持 gzip 响应，与工作站的策略一致；网盘 CDN 对文本类文件返回 gzip 时该后端会失败。
- 协议只覆盖 HTTP/HTTPS/FTP。

### 7.4 与默认后端的关系

`netdisk_download` 的 `backend` 参数取 `builtin`（默认）或 `ndm`。两个后端并列，**默认 builtin**，不因为本机装了 NDM 就改变默认行为。选了 `ndm` 而 NDM 未运行时，任务不创建，返回明确错误。

## 8. 工具契约

### 8.1 `netdisk_resolve`

**输入**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 分享链接或整段分享文案 |
| `code` | string? | 提取码，不填则从文案自动提取 |
| `platform` | enum | `auto`（默认）或指定平台 |
| `mode` | enum | `list` 只列文件 / `link`（默认）列文件并取直链 |
| `paths` | string[]? | 只给这些路径取直链 |
| `maxLinks` | number | 默认 10，上限 50（受 120 秒工具超时约束） |

**输出**

```ts
{
  platform, platformLabel, shareId, title,
  fileCount, totalBytes,
  files: NetdiskFile[],
  links: NetdiskLink[],
  linkFailures: { path: string; reason: string }[],
  credentialUsed: boolean,
  warnings: string[]
}
```

两个关键行为：

- **逐个失败不中断整体**：10 个文件里 3 个取链失败，仍返回 7 条成功直链与 3 条失败原因。
- **直链与必需请求头一起给**：网盘直链普遍要带 `Referer` / `Cookie` / `User-Agent` / `Origin`，只给 URL 会 403。

### 8.2 `netdisk_download`

**输入**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 分享链接或整段分享文案 |
| `code` | string? | 提取码 |
| `paths` | string[] | 要下载的文件路径（相对分享根） |
| `backend` | enum | `builtin`（默认）/ `ndm` |
| `platform` | enum | `auto`（默认）或指定平台 |

**输出**

```ts
{
  taskIds: string[],
  backend: 'builtin' | 'ndm',
  platform: NetdiskPlatform,
  warnings: string[]
}
```

**立即返回**，不等下载完成。`builtin` 后端返回 `taskIds`；`ndm` 后端返回 `taskIds`（任务状态为 `handed_off`）。

## 9. 界面

### 9.1 结果面板

新增 `NetdiskResult` 组件，注册进 `ResultPanel` 的 `ResultView` 分派：

- **文件表格**：名称 / 大小 / 路径 / 修改时间
- **直链表格**：名称 / 大小 / 直链 / 是否支持续传，每行两个按钮：「复制直链」（只复制 URL）与「复制 curl」（复制带完整请求头的可执行命令）

```
curl -L -H "Referer: https://..." -H "Cookie: ..." -H "User-Agent: ..." -o "文件名" "url"
```

### 9.2 下载任务页面

新增 `#/downloads` 页面（`src/web/router.ts` 增加一条 Route，`src/web/pages/Downloads.tsx`）：

- 任务列表：名称 / 平台 / 状态 / 进度条 / 速度 / 大小
- 操作：暂停 / 继续 / 删除 / 打开文件夹
- 顶栏加一个"下载中任务"指示，点击回到该页面（与现有"运行中任务"指示同构）

### 9.3 标签

`src/web/presentation.ts` 的 `resultLabels` 补充新字段的中文标签。

## 10. 错误与边界

| 情况 | 处理 |
| --- | --- |
| 分享链接无法识别 | `INVALID_INPUT`，明确提示"无法识别该链接的网盘平台" |
| 平台接口已变更 | `TOOL_FAILED`，提示"XX 网盘接口已变更，解析失败"，不返回猜测数据 |
| 需要提取码但未提供 | `INVALID_INPUT`，提示"该分享需要提取码" |
| 需要登录但未配置凭证 | `ACCESS_DENIED`，提示"该平台需要登录态，请先执行 `npm run cli -- credentials set <平台>` 配置凭证" |
| 直链探测失败 | 该条进 `linkFailures`，整体仍返回其他直链 |
| 不支持 Range 的平台直链过期 | 任务 `failed`，错误说明"该平台直链不支持断点续传，需重新开始" |
| NDM 未运行 | `ACCESS_DENIED`，提示先启动 NDM |
| 单次取直链数超限 | `LIMIT_EXCEEDED`，提示调高 `maxLinks` 或改用 `paths` 精确指定 |
| 工具超时（120 秒） | 沿用现有 `TIMEOUT` 映射 |

## 11. 测试策略

**单元测试（不联网）**

- 分享文案解析：各平台正则、提取码四个来源、蓝奏云域名族（含 `lanzn`）、优享版优先判定
- 直链与路径规范化
- 凭证优先级（环境变量 > 凭证文件）
- 凭证文件读写：`credentials set` / `list` / `clear` 的行为与文件权限
- Cookie 按 host 隔离（夸克的 Cookie 不会发给 115）
- 分页退避与翻页三级回落判定
- Range 探测的三种结果分支
- 分段表序列化与续传恢复
- NDM 协议消息拼装（逐字段断言）

**契约测试（注入假 transport）**：每个适配器喂固定响应，断言解析结果与直链字段。

**端到端**：结果面板渲染、下载任务页面的操作与状态显示。

**真实验收（需真实分享链接，手动执行）**：每家平台一条链接跑通 `netdisk_resolve`；至少挑 2 家跑通完整的下载 → 落盘 → 校验文件大小。

## 12. 实施顺序

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| 0 | 分片可行性验证：用本地 HTTP 服务器验证 `Range` 请求、`206` 响应、预分配文件按偏移写入、杀进程后从断点恢复 | 下完并校验出一个字节完全一致的文件 |
| 1 | 网络层扩展 + 流式写入器：`PublicHttp` 加 POST / 流式 GET / 白名单扩容 / 超时可配；`FileWriter.open` + `writeAt` + 预分配 | 单测覆盖 SSRF 防护在 POST 路径同样生效；路径安全与越界写入有覆盖 |
| 2 | 分享识别 + 适配器骨架（含 Range 探测钩子）+ 凭证 CLI（`credentials set/list/clear`）+ 蓝奏云 | 蓝奏云真实链接跑通 `netdisk_resolve`，并产出它的 Range 支持结论；凭证 CLI 能写入并列出凭证 |
| 3 | 剩余 8 家适配器（按 5.7 顺序） | 每家一条真实链接跑通；不通的标注状态；汇总各家 Range 结论 |
| 4 | 下载内核：分片 + 续传 + 直链过期重取链（按阶段 2–3 的 Range 结论决定分片或降级） | 2GB 文件下载中途杀进程，重启后从断点继续；直链过期能自动重取 |
| 5 | 任务管理 + HTTP API + SSE | 任务列表、暂停、继续、删除可用 |
| 6 | 前端：结果面板 + 下载任务页面 | 浏览器里完整走一遍 |
| 7 | NDM 后端 | 推送后 NDM 窗口出现任务并开始下载 |
| 8 | 文档回填 | 活文档与代码一致 |

## 13. 文档回填

- 新建本文档（`docs/superpowers/specs/2026-11-12-netdisk-resolve-and-download-design.md`）。
- 更新 `docs/superpowers/plans/2026-11-02-personal-workstation-plan.md`：
  - §8 新增 **8.9 网盘分享解析 `netdisk_resolve`** 与 **8.10 网盘下载 `netdisk_download`**
  - §7.3 修订"不使用登录态、不携带浏览器 Cookie"的适用范围：区分网页抓取工具（不带登录态）与网盘解析工具（使用用户在状态目录内显式提供的网盘凭证）
  - §9.2 补充 CLI 的 `credentials` 子命令
  - 工具清单 12 → 14
  - §13 追加任务 13：网盘分享解析与下载
  - §15 测试矩阵补充网盘用例
- `README.md` 补充网盘能力说明（当前仅 2 行标题）。

## 14. 风险与已知不确定

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 平台私有接口随时可能变更 | 某家平台突然不可用 | 明确报错 + 文档标注状态；不假装支持 |
| **Range 支持因平台而异（未实测）** | 决定分片与续传能否成立 | 探测内建在适配器里，阶段 2–3 逐家产出结论；不支持的平台显式降级为单流 |
| 直链 15 分钟过期 | 大文件下载中断 | 任务保存取链参数，自动重新取链；不支持 Range 时明确告知无法续传 |
| 百度必须转存 | 会写入用户网盘 | 取链后立即清理；工具输出中显式说明该副作用 |
| 115 / 123 / 百度有账号风控 | 账号被限制 | 文档提示；YunX 自身也警告百度风控 |
| 动态分段实现复杂度 | 段边界重划出错导致文件损坏 | 阶段 5 单独验收：下载后校验文件大小与摘要 |
| 前端新增页面 | 工作量增加 | 与现有"运行中任务"指示同构，复用样式 |
| NDM 协议非官方用法 | NDM 升级后协议变化 | 该后端是可选的，默认 builtin；协议变化只影响可选路径 |

## 15. 许可说明

YunX 采用 AGPL-3.0，NDM 为闭源。本设计**只参考 YunX 的协议流程与组织方式，不复制其 Kotlin 代码**；NDM 部分只通过其本地 WebSocket 协议交互，不链接其二进制、不分发其代码。
